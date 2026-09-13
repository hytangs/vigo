import { gtfsRealtimeEnums as gtfsRealtime } from './gtfs-realtime-decoder.mjs'

const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function enumLabel(enumObject, value) {
  if (value === null || value === undefined) return undefined
  return Object.entries(enumObject).find(([, enumValue]) => enumValue === value)?.[0]
}

function translatedText(value) {
  const translations = value?.translation ?? []
  return translations.find((translation) => translation.language === 'en')?.text
    ?? translations[0]?.text
    ?? ''
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''))
}

function tripFields(trip) {
  return compactObject({
    routeId: trip?.routeId,
    directionId: trip?.directionId,
    tripId: trip?.tripId,
    startDate: trip?.startDate,
    startTime: trip?.startTime,
    scheduleRelationship: enumLabel(gtfsRealtime.TripDescriptor.ScheduleRelationship, trip?.scheduleRelationship),
  })
}

function vehiclePositionToRecord(entity) {
  const vehicle = entity.vehicle
  const position = vehicle?.position
  return compactObject({
    id: vehicle?.vehicle?.id || entity.id,
    entityId: entity.id,
    currentStopSequence: vehicle?.currentStopSequence,
    label: vehicle?.vehicle?.label,
    licensePlate: vehicle?.vehicle?.licensePlate,
    ...tripFields(vehicle?.trip),
    stopId: vehicle?.stopId,
    currentStatus: enumLabel(gtfsRealtime.VehiclePosition.VehicleStopStatus, vehicle?.currentStatus),
    congestionLevel: enumLabel(gtfsRealtime.VehiclePosition.CongestionLevel, vehicle?.congestionLevel),
    occupancyStatus: enumLabel(gtfsRealtime.VehiclePosition.OccupancyStatus, vehicle?.occupancyStatus),
    occupancyPercentage: vehicle?.occupancyPercentage,
    timestamp: numeric(vehicle?.timestamp),
    lat: position?.latitude,
    lon: position?.longitude,
    bearing: position?.bearing,
    speed: position?.speed,
  })
}

function stopEventDelay(update) {
  return update?.arrival?.delay ?? update?.departure?.delay
}

function stopTimeEventToRecord(event) {
  if (!event) return undefined
  return compactObject({
    delay: numeric(event.delay),
    time: numeric(event.time),
    uncertainty: numeric(event.uncertainty),
    scheduledTime: numeric(event.scheduledTime),
  })
}

function stopTimeUpdateToRecord(update) {
  return compactObject({
    stopSequence: numeric(update?.stopSequence),
    stopId: update?.stopId,
    scheduleRelationship: enumLabel(
      gtfsRealtime.StopTimeUpdate.ScheduleRelationship,
      update?.scheduleRelationship,
    ),
    arrival: stopTimeEventToRecord(update?.arrival),
    departure: stopTimeEventToRecord(update?.departure),
  })
}

function tripUpdateToRecord(entity) {
  const tripUpdate = entity.tripUpdate
  const firstUpcoming = tripUpdate?.stopTimeUpdate?.find((update) => update.stopId || update.stopSequence)
  return compactObject({
    id: entity.id,
    ...tripFields(tripUpdate?.trip),
    vehicleId: tripUpdate?.vehicle?.id,
    vehicleLabel: tripUpdate?.vehicle?.label,
    tripDelaySeconds: numeric(tripUpdate?.delay),
    timestamp: numeric(tripUpdate?.timestamp),
    delaySeconds: tripUpdate?.delay ?? stopEventDelay(firstUpcoming),
    stopUpdateCount: tripUpdate?.stopTimeUpdate?.length ?? 0,
    nextStopId: firstUpcoming?.stopId,
    nextStopSequence: firstUpcoming?.stopSequence,
    stopTimeUpdates: (tripUpdate?.stopTimeUpdate ?? []).map(stopTimeUpdateToRecord),
  })
}

function alertToRecord(entity) {
  const alert = entity.alert
  const informedEntity = alert?.informedEntity ?? []
  return compactObject({
    id: entity.id,
    cause: enumLabel(gtfsRealtime.Alert.Cause, alert?.cause),
    effect: enumLabel(gtfsRealtime.Alert.Effect, alert?.effect),
    severity: enumLabel(gtfsRealtime.Alert.SeverityLevel, alert?.severityLevel),
    header: translatedText(alert?.headerText),
    description: translatedText(alert?.descriptionText),
    url: translatedText(alert?.url),
    informedEntities: informedEntity.map((entity) => ({ ...entity, trip: entity.trip ? tripFields(entity.trip) : undefined })),
    routeIds: Array.from(new Set(informedEntity.map((entitySelector) => entitySelector.routeId).filter(Boolean))),
    stopIds: Array.from(new Set(informedEntity.map((entitySelector) => entitySelector.stopId).filter(Boolean))),
    activePeriods: (alert?.activePeriod ?? []).map((period) => compactObject({
      start: numeric(period.start),
      end: numeric(period.end),
    })),
  })
}

export function realtimeSnapshotFromFeed(feed, sourceUrl, fetchedAt, contentType) {
  const entities = (feed.entity ?? []).filter((entity) => !entity.isDeleted)
  const identity = (record) => ({ ...record, sourceUrl, sourceFeedTimestamp: numeric(feed.header?.timestamp) })
  const vehicles = entities.filter((entity) => entity.vehicle).map(vehiclePositionToRecord).map(identity)
  const tripUpdates = entities.filter((entity) => entity.tripUpdate).map(tripUpdateToRecord).map(identity)
  const alerts = entities.filter((entity) => entity.alert).map(alertToRecord).map(identity)
  const classified = vehicles.length + tripUpdates.length + alerts.length
  const feedTimestamp = numeric(feed.header?.timestamp)
  const ageSeconds = Number.isFinite(feedTimestamp)
    ? Math.max(0, Date.parse(fetchedAt) / 1000 - feedTimestamp)
    : undefined

  return {
    sourceUrl,
    fetchedAt,
    feedTimestamp,
    freshness: {
      status: ageSeconds === undefined ? 'unknown' : ageSeconds > 180 ? 'stale' : 'fresh',
      ...(ageSeconds === undefined ? {} : { ageSeconds: Number(ageSeconds.toFixed(1)) }),
      thresholdSeconds: 180,
    },
    feedVersion: feed.header?.feedVersion || undefined,
    gtfsRealtimeVersion: feed.header?.gtfsRealtimeVersion || undefined,
    incrementality: enumLabel(gtfsRealtime.FeedHeader.Incrementality, feed.header?.incrementality),
    contentType,
    entityCount: entities.length,
    counts: {
      vehicles: vehicles.length,
      tripUpdates: tripUpdates.length,
      alerts: alerts.length,
      other: Math.max(0, entities.length - classified),
    },
    vehicles,
    tripUpdates,
    alerts,
  }
}


export function realtimeSnapshotFromFeeds(records) {
  const successful = records.filter((record) => record.feed)
  const snapshots = successful.map((record) => realtimeSnapshotFromFeed(
    record.feed,
    record.sourceUrl,
    record.fetchedAt,
    record.contentType,
  ))
  const first = snapshots[0] ?? { fetchedAt: new Date().toISOString() }
  const sourceUrls = snapshots.map((snapshot) => snapshot.sourceUrl).filter(Boolean)
  const vehicles = snapshots.flatMap((snapshot) => snapshot.vehicles)
  const tripUpdates = snapshots.flatMap((snapshot) => snapshot.tripUpdates)
  const alerts = snapshots.flatMap((snapshot) => snapshot.alerts)
  const other = snapshots.reduce((total, snapshot) => total + snapshot.counts.other, 0)
  return {
    sourceUrl: sourceUrls.length === 1 ? sourceUrls[0] : undefined,
    sourceUrls,
    feeds: records.map((record) => ({ sourceUrl: record.sourceUrl, kind: record.kind, fetchedAt: record.fetchedAt, feedTimestamp: numeric(record.feed?.header?.timestamp), ...(record.error ? { error: record.error } : {}) })),
    fetchedAt: records.reduce((latest, record) => record.fetchedAt > latest ? record.fetchedAt : latest, first.fetchedAt),
    feedTimestamp: snapshots.length && snapshots.every((snapshot) => Number.isFinite(snapshot.feedTimestamp)) ? Math.min(...snapshots.map((snapshot) => snapshot.feedTimestamp)) : undefined,
    freshness: {
      status: snapshots.some((snapshot) => snapshot.freshness?.status === 'stale')
        ? 'stale'
        : snapshots.length === records.length && snapshots.length > 0 && snapshots.every((snapshot) => snapshot.freshness?.status === 'fresh') ? 'fresh' : 'unknown',
      ...(snapshots.some((snapshot) => Number.isFinite(snapshot.freshness?.ageSeconds))
        ? { ageSeconds: Math.max(...snapshots.map((snapshot) => Number(snapshot.freshness?.ageSeconds ?? 0))) }
        : {}),
      thresholdSeconds: 180,
    },
    feedVersion: first.feedVersion,
    gtfsRealtimeVersion: first.gtfsRealtimeVersion,
    incrementality: first.incrementality,
    contentType: snapshots.length === 1 ? first.contentType : 'multiple',
    entityCount: snapshots.reduce((total, snapshot) => total + snapshot.entityCount, 0),
    counts: {
      vehicles: vehicles.length,
      tripUpdates: tripUpdates.length,
      alerts: alerts.length,
      other,
    },
    vehicles,
    tripUpdates,
    alerts,
  }
}

