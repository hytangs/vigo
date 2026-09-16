import { delayAlert, spacingAlert } from './alertPolicy.mjs'
import { rawId } from './agencyContext.mjs'

import { alertSelectors, describeAlertScope } from './alertApplicability.mjs'

export const defaultPolicy = Object.freeze({ freshnessSeconds: 180, windowMinutes: 30, historyMinutes: 30 })
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const eventId = (...parts) => parts.map((part) => encodeURIComponent(String(part ?? ''))).join('/')
const severityOrder = { critical: 0, warning: 1, info: 2 }
const departureIndexes = new WeakMap()

function groupRows(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const id = key(row)
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(row)
  }
  return groups
}

function reportedDeparture(rows, { stopSequence, stopId }) {
  if (stopSequence === undefined && !stopId) return null
  let index = departureIndexes.get(rows)
  if (!index) {
    index = { sequences: groupRows(rows, row => row.stop_sequence), stops: groupRows(rows, row => rawId(row.from_stop_id)) }
    departureIndexes.set(rows, index)
  }
  const candidates = stopSequence !== undefined ? index.sequences.get(stopSequence) : index.stops.get(rawId(stopId))
  let match = null
  for (const row of candidates ?? []) {
    if (stopId && (String(stopId).includes('\u001f') ? row.from_stop_id !== stopId : rawId(row.from_stop_id) !== rawId(stopId))) continue
    if (match) return null
    match = row
  }
  return match
}

export function feedStates(snapshot, nowSeconds, policy = defaultPolicy) {
  return (snapshot?.feeds ?? []).map((feed) => {
    const ageSeconds = finite(feed.feedTimestamp) ? nowSeconds - feed.feedTimestamp : null
    return { ...feed, ageSeconds, status: feed.error ? 'error' : ageSeconds === null || ageSeconds < -policy.freshnessSeconds ? 'unknown' : ageSeconds > policy.freshnessSeconds ? 'stale' : 'fresh' }
  })
}

export function deriveOperationalState(context, snapshot, nowSeconds = Date.now() / 1000, policy = defaultPolicy) {
  const generatedAt = new Date(nowSeconds * 1000).toISOString()
  const coverage = context.coverage(nowSeconds)
  const feeds = feedStates(snapshot, nowSeconds, policy)
  const feedByUrl = new Map(feeds.map((feed) => [feed.sourceUrl, feed]))
  const events = []
  const trips = []
  // Keep complete comparisons, including exact matches, for network diagnosis.
  // These measurements remain server-side; the live API still returns a compact view.
  const measurements = { departures: [], intervals: [] }
  const warnings = []
  const groups = new Map()
  const routes = new Map(context.routes.map((route) => [route.route_id, {
    id: route.route_id, name: route.short_name || route.long_name || rawId(route.route_id), longName: route.long_name || '',
    color: /^[0-9a-f]{6}$/i.test(route.color) ? `#${route.color}` : 'var(--text-muted)', mode: route.route_type,
    trips: 0, reportingTrips: 0, maxDelaySeconds: null, events: 0, alerts: 0, serviceChanges: 0, headway: 'unknown', comparedPairs: 0, widestInterval: null,
  }]))
  const active = coverage.serviceDate ? context.activeServices(coverage.serviceDate) : new Set()
  for (const trip of context.trips) if (active.has(trip.service_id)) routes.get(trip.route_id).trips++
  const add = (type, identity, fields) => events.push({ id: eventId(type, ...identity), type, severity: 'info', observedAt: generatedAt, ...fields })
  const sourceFresh = (record) => feedByUrl.get(record.sourceUrl)?.status === 'fresh'
  const recordFresh = (record) => sourceFresh(record) && (!finite(record.timestamp) || nowSeconds - record.timestamp <= policy.freshnessSeconds && record.timestamp - nowSeconds <= policy.freshnessSeconds)

  for (const feed of feeds) if (feed.status !== 'fresh') add('stale-data', [feed.sourceUrl], {
    title: feed.status === 'unknown' ? 'Feed time is unknown' : feed.status === 'error' ? 'Feed refresh failed' : 'Feed is stale', severity: 'warning',
    evidence: { ...(feed.ageSeconds === null ? {} : { feedAgeSeconds: feed.ageSeconds }), reason: feed.error || `Freshness window: ${policy.freshnessSeconds} seconds.` }, sourceRefs: [feed.sourceUrl],
  })
  if (snapshot && !feeds.length) warnings.push('Individual feed timestamps are absent. Reconnect the source before using observations.')
  if (!coverage.valid) warnings.push(coverage.message)

  const matchedUpdates = (snapshot?.tripUpdates ?? []).map((update) => ({ update, match: coverage.valid ? context.matchTrip(update, coverage.serviceDate) : { reason: coverage.message } }))
  const instanceCounts = new Map()
  for (const { match } of matchedUpdates) if (match.trip) { const key = eventId(match.trip.trip_id, match.serviceDate); instanceCounts.set(key, (instanceCounts.get(key) ?? 0) + 1) }
  for (const { update, match } of matchedUpdates) {
    if (match.trip && instanceCounts.get(eventId(match.trip.trip_id, match.serviceDate)) > 1) { match.reason = 'Multiple TripUpdates claim the same scheduled trip instance.'; delete match.trip }
    const ref = `${update.sourceUrl ?? 'unknown source'}#entity=${encodeURIComponent(update.id)}`
    if (!match.trip || !recordFresh(update)) {
      trips.push({ id: update.id, sourceUrl: update.sourceUrl, status: 'unresolved', reason: match.reason || 'The TripUpdate is stale or its source time is unknown.' })
      continue
    }
    const { trip, serviceDate, departures, epoch } = match
    const route = routes.get(trip.route_id)
    route.reportingTrips++
    const sourceTime = update.timestamp ?? feedByUrl.get(update.sourceUrl)?.feedTimestamp
    const base = { observedAt: new Date(sourceTime * 1000).toISOString(), routeId: trip.route_id, directionId: trip.direction_id ?? undefined, tripId: trip.trip_id, vehicleId: update.vehicleId, serviceDate, sourceRefs: [ref, `gtfs:trips/${encodeURIComponent(trip.trip_id)}?date=${serviceDate}`] }
    const identity = [trip.trip_id, serviceDate]
    if (update.scheduleRelationship === 'DELETED') {
      trips.push({ ...base, status: 'deleted' })
      continue
    }
    if (update.scheduleRelationship === 'CANCELED') {
      add('cancellation', identity, { ...base, title: 'Scheduled trip cancelled', severity: 'warning', evidence: { reason: `TripDescriptor: ${update.scheduleRelationship}` } })
      trips.push({ ...base, status: 'cancelled' })
      continue
    }
    if (update.scheduleRelationship && update.scheduleRelationship !== 'SCHEDULED') {
      trips.push({ ...base, status: 'unresolved', reason: `Unsupported trip relationship: ${update.scheduleRelationship}` })
      continue
    }
    const predictions = []
    const sequenceCounts = new Map()
    const resolvedStops = (update.stopTimeUpdates ?? []).map((stopUpdate) => {
      const row = reportedDeparture(departures, stopUpdate)
      if (row) sequenceCounts.set(row.stop_sequence, (sequenceCounts.get(row.stop_sequence) ?? 0) + 1)
      return { stopUpdate, row }
    })
    for (const { stopUpdate, row } of resolvedStops) {
      if (!row || sequenceCounts.get(row.stop_sequence) !== 1) continue
      if (stopUpdate.scheduleRelationship === 'SKIPPED') {
        if (epoch + row.departure < nowSeconds - policy.freshnessSeconds || epoch + row.departure > nowSeconds + policy.windowMinutes * 60) continue
        add('skipped-stop', [...identity, row.stop_sequence], { ...base, stopId: row.from_stop_id, title: 'Scheduled stop skipped', severity: 'warning', evidence: { scheduledTime: epoch + row.departure, reason: 'StopTimeUpdate: SKIPPED' } })
        continue
      }
      if (stopUpdate.scheduleRelationship && stopUpdate.scheduleRelationship !== 'SCHEDULED') continue
      const departure = stopUpdate.departure
      const predictedTime = finite(departure?.time) ? departure.time : finite(departure?.delay) ? epoch + row.departure + departure.delay : null
      if (predictedTime === null) continue // Arrival predictions never stand in for departures.
      const prediction = { ...(update.vehicleId ? { vehicleId: update.vehicleId } : {}), ...(update.startTime ? { tripStartTime: update.startTime } : {}), tripId: trip.trip_id, sequence: row.stop_sequence, stopId: row.from_stop_id, scheduledTime: epoch + row.departure, predictedTime, delaySeconds: predictedTime - epoch - row.departure, sourceRef: ref, observedAt: base.observedAt }
      predictions.push(prediction)
      if ((predictedTime >= nowSeconds && predictedTime <= nowSeconds + policy.windowMinutes * 60)
        || (prediction.scheduledTime >= nowSeconds && prediction.scheduledTime <= nowSeconds + policy.windowMinutes * 60)) {
        measurements.departures.push({ ...prediction, routeId: trip.route_id, directionId: trip.direction_id, serviceDate, toStopId: row.to_stop_id, vehicleId: update.vehicleId })
      }
      if (prediction.predictedTime < nowSeconds || prediction.predictedTime > nowSeconds + policy.windowMinutes * 60) continue
      const key = eventId(trip.route_id, trip.direction_id, row.from_stop_id, serviceDate)
      if (!groups.has(key)) groups.set(key, { trip, stopId: row.from_stop_id, serviceDate, epoch, predictions: [] })
      groups.get(key).predictions.push(prediction)
    }
    let next
    for (const prediction of predictions) if (prediction.predictedTime >= nowSeconds && prediction.predictedTime <= nowSeconds + policy.windowMinutes * 60
      && (!next || prediction.predictedTime < next.predictedTime)) next = prediction
    if (next) {
      route.maxDelaySeconds = Math.max(route.maxDelaySeconds ?? -Infinity, next.delaySeconds)
      if (next.delaySeconds > 0) add('delay', [...identity, next.sequence], { ...base, severity: delayAlert(next.delaySeconds).severity, stopId: next.stopId, title: 'Departure later than scheduled', evidence: { alertReason: delayAlert(next.delaySeconds).alertReason, ...(update.startTime ? { tripStartTime: update.startTime } : {}), scheduledTime: next.scheduledTime, predictedTime: next.predictedTime, delaySeconds: next.delaySeconds } })
    }
    trips.push({ ...base, status: 'matched', ...(next ? { nextStopId: next.stopId, scheduledTime: next.scheduledTime, predictedTime: next.predictedTime, delaySeconds: next.delaySeconds } : {}), departurePredictions: predictions.length })
  }

  let incompleteIntervals = 0
  let measuredIntervals = 0
  for (const [key, group] of groups) {
    const { trip, stopId, serviceDate, epoch } = group
    const ordered = group.predictions.sort((a, b) => a.predictedTime - b.predictedTime || a.tripId.localeCompare(b.tripId))
    const firstScheduled = ordered.reduce((time, row) => Math.min(time, row.scheduledTime), nowSeconds)
    const lastScheduled = ordered.reduce((time, row) => Math.max(time, row.scheduledTime), nowSeconds + policy.windowMinutes * 60)
    const allExpected = context.expectedDepartures(trip, stopId, serviceDate, firstScheduled - epoch, lastScheduled - epoch)
    const reporting = new Set(ordered.map((row) => `${row.tripId}/${row.sequence}`))
    const completeWindow = allExpected.length >= 2 && allExpected.every((row) => reporting.has(`${row.trip_id}/${row.stop_sequence}`))
    for (let index = 1; index < ordered.length; index++) {
      const before = ordered[index - 1]
      const after = ordered[index]
      const scheduledHeadwaySeconds = after.scheduledTime - before.scheduledTime
      if (scheduledHeadwaySeconds <= 0) { incompleteIntervals++; continue }
      const expected = allExpected.filter((row) => row.departure + epoch >= before.scheduledTime && row.departure + epoch <= after.scheduledTime)
      if (expected.length !== 2 || !expected.every((row) => reporting.has(`${row.trip_id}/${row.stop_sequence}`))) { incompleteIntervals++; continue }
      measuredIntervals++
      const observedHeadwaySeconds = after.predictedTime - before.predictedTime
      measurements.intervals.push({ routeId: trip.route_id, directionId: trip.direction_id, serviceDate, stopId,
        tripIds: [before.tripId, after.tripId], scheduledSeconds: scheduledHeadwaySeconds, predictedSeconds: observedHeadwaySeconds,
        fromTime: before.predictedTime, toTime: after.predictedTime,
        observedAt: before.observedAt < after.observedAt ? before.observedAt : after.observedAt, sourceRefs: [before.sourceRef, after.sourceRef] })
      const route = routes.get(trip.route_id)
      route.comparedPairs++
      if (!route.widestInterval || observedHeadwaySeconds > route.widestInterval.predictedSeconds) route.widestInterval = {
        predictedSeconds: observedHeadwaySeconds, scheduledSeconds: scheduledHeadwaySeconds,
        directionId: trip.direction_id, stopId, stopName: context.stopIndex.get(stopId)?.name || stopId,
      }
      if (observedHeadwaySeconds === scheduledHeadwaySeconds) {
        if (completeWindow && route.headway === 'unknown') route.headway = 'matches-schedule'
        continue
      }
      route.headway = 'changed'
      const compressed = observedHeadwaySeconds < scheduledHeadwaySeconds
      add(compressed ? 'bunching' : 'service-gap', [key, before.tripId, after.tripId], {
        severity: spacingAlert(scheduledHeadwaySeconds, observedHeadwaySeconds).severity,
        vehicleId: after.vehicleId,
        title: compressed ? 'Compressed departure interval' : 'Wider departure interval', routeId: trip.route_id, directionId: trip.direction_id ?? undefined,
        tripId: after.tripId, stopId, serviceDate, observedAt: before.observedAt < after.observedAt ? before.observedAt : after.observedAt,
        evidence: { alertReason: spacingAlert(scheduledHeadwaySeconds, observedHeadwaySeconds).alertReason, ...(after.tripStartTime ? { tripStartTime: after.tripStartTime } : {}), scheduledHeadwaySeconds, observedHeadwaySeconds, headwayRatio: observedHeadwaySeconds / scheduledHeadwaySeconds,
          referenceStopId: stopId, comparisonWindow: [before.scheduledTime, after.scheduledTime], expectedDepartures: expected.length, reportingTrips: expected.filter((row) => reporting.has(`${row.trip_id}/${row.stop_sequence}`)).length,
          tripIds: [before.tripId, after.tripId], reason: 'Two consecutive scheduled departures, both reporting at this stop. This is a predicted interval, not an observed passage or route-wide regularity claim.' },
        sourceRefs: [before.sourceRef, after.sourceRef, `gtfs:connections/${encodeURIComponent(stopId)}?date=${serviceDate}`],
      })
    }
  }
  if (incompleteIntervals) warnings.push(`${incompleteIntervals} intervals cannot be compared because reporting is incomplete or predicted trip order differs from the timetable.`)
  if (!measuredIntervals && snapshot) warnings.push('No fully reporting departure pair is available in the comparison window. Headway health is unknown.')

  let activeAlerts = 0
  for (const alert of snapshot?.alerts ?? []) {
    if (!sourceFresh(alert)) continue
    if (alert.activePeriods?.length && !alert.activePeriods.some((period) => (!period.start || period.start <= nowSeconds) && (!period.end || period.end > nowSeconds))) continue
    activeAlerts++
    const selectors = alertSelectors(context, alert)
    const assigned = selectors.filter(selector => !selector.unresolved.length)
    const routeIds = [...new Set(assigned.flatMap(selector => selector.routeIds))]
    const stopIds = [...new Set(assigned.map(selector => selector.stopId).filter(Boolean))]
    if (selectors.some(selector => selector.unresolved.length)) warnings.push(`Alert ${alert.id}: some selector constraints could not be resolved and are not assigned.`)
    for (const routeId of routeIds) routes.get(routeId).alerts++
    add('service-alert', [alert.sourceUrl, alert.id], { observedAt: new Date(feedByUrl.get(alert.sourceUrl).feedTimestamp * 1000).toISOString(), title: alert.header || 'Service alert', routeId: routeIds.length === 1 ? routeIds[0] : undefined, routeIds, stopIds, selectors, scopeDescription: describeAlertScope(selectors, context),
      severity: alert.severity === 'SEVERE' ? 'critical' : alert.severity === 'WARNING' ? 'warning' : 'info',
      evidence: { alertHeader: alert.header, alertDescription: alert.description, alertCause: alert.cause, alertEffect: alert.effect, alertUrl: alert.url, activePeriods: alert.activePeriods ?? [], informedEntities: alert.informedEntities ?? [], reason: [alert.effect, alert.cause].filter(Boolean).join(' · ') }, sourceRefs: [`${alert.sourceUrl}#entity=${encodeURIComponent(alert.id)}`] })
  }
  for (const vehicle of snapshot?.vehicles ?? []) if (sourceFresh(vehicle) && (!finite(vehicle.timestamp) || nowSeconds - vehicle.timestamp > policy.freshnessSeconds)) add('stale-data', [vehicle.sourceUrl, vehicle.id], {
    title: finite(vehicle.timestamp) ? 'Vehicle observation is stale' : 'Vehicle observation time is unknown', vehicleId: vehicle.id,
    evidence: { ...(finite(vehicle.timestamp) ? { feedAgeSeconds: nowSeconds - vehicle.timestamp } : {}), reason: 'VehiclePosition timestamp is evaluated independently of the feed header.' }, sourceRefs: [`${vehicle.sourceUrl}#vehicle=${encodeURIComponent(vehicle.id)}`],
  })
  for (const event of events) for (const routeId of event.routeIds ?? (event.routeId ? [event.routeId] : [])) if (routes.has(routeId)) {
    const route = routes.get(routeId)
    route.events++
    // Keep route-wide review counts independent of API event filtering/paging.
    if (['cancellation', 'skipped-stop', 'headway-review'].includes(event.type)) route.serviceChanges++
  }
  for (const event of events) { const stop = context.stopIndex.get(event.stopId); event.routeName = routes.get(event.routeId)?.name; event.stopName = stop?.name; if (stop) event.stopCoordinate = [stop.lon, stop.lat] }
  events.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || Math.abs((b.evidence.observedHeadwaySeconds ?? 0) - (b.evidence.scheduledHeadwaySeconds ?? 0) || b.evidence.delaySeconds || 0) - Math.abs((a.evidence.observedHeadwaySeconds ?? 0) - (a.evidence.scheduledHeadwaySeconds ?? 0) || a.evidence.delaySeconds || 0) || a.id.localeCompare(b.id))
  return { generatedAt, observedAt: snapshot?.fetchedAt ?? null, cityName: context.cityName, connected: Boolean(snapshot), coverage,
    counts: { routes: routes.size, stops: context.stops.length, vehicles: (snapshot?.vehicles ?? []).filter((vehicle) => recordFresh(vehicle) && finite(vehicle.timestamp)).length, trips: trips.length, matchedTrips: trips.filter((trip) => trip.status !== 'unresolved').length, unresolvedTrips: trips.filter((trip) => trip.status === 'unresolved').length, alerts: activeAlerts },
    feeds, routes: [...routes.values()], events, trips, measurements, warnings, policy }
}

export function createObservationHistory(policy = defaultPolicy, retained = {}) {
  const events = new Map((retained.history ?? []).map((event) => [event.id, event]))
  const trips = new Map(Object.entries(retained.tripHistory ?? {}))
  let lastObservation = null
  return {
    update(state) {
      const cutoff = Date.parse(state.generatedAt) - policy.historyMinutes * 60_000
      if (state.observedAt && state.observedAt !== lastObservation) {
        for (const event of state.events) events.set(event.id, event)
        for (const trip of state.trips) if (finite(trip.delaySeconds)) {
          const key = `${trip.tripId}/${trip.serviceDate}`
          const series = trips.get(key) ?? []
          const point = { at: trip.observedAt || state.observedAt, delaySeconds: trip.delaySeconds, stopId: trip.nextStopId }
          if (series.at(-1)?.at === point.at) series[series.length - 1] = point
          else series.push(point)
          trips.set(key, series)
        }
        lastObservation = state.observedAt
      }
      for (const [id, event] of events) if (Date.parse(event.observedAt) < cutoff) events.delete(id)
      for (const [id, series] of trips) {
        const recent = series.filter((point) => Date.parse(point.at) >= cutoff)
        if (recent.length) trips.set(id, recent.slice(-180))
        else trips.delete(id)
      }
      return { history: [...events.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 200), tripHistory: Object.fromEntries(trips) }
    },
  }
}
