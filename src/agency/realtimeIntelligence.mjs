import { rawId } from './agencyContext.mjs'

export const defaultPolicy = Object.freeze({ freshnessSeconds: 180, windowMinutes: 30, historyMinutes: 30 })
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const eventId = (...parts) => parts.map((part) => encodeURIComponent(String(part ?? ''))).join('/')
const severityOrder = { critical: 0, warning: 1, info: 2 }

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
  const warnings = []
  const groups = new Map()
  const routes = new Map(context.routes.map((route) => [route.route_id, {
    id: route.route_id, name: route.short_name || route.long_name || rawId(route.route_id), longName: route.long_name || '',
    color: /^[0-9a-f]{6}$/i.test(route.color) ? `#${route.color}` : 'var(--text-muted)', mode: route.route_type,
    trips: 0, reportingTrips: 0, maxDelaySeconds: null, events: 0, alerts: 0, headway: 'unknown',
  }]))
  if (coverage.serviceDate) for (const trip of context.trips) if (context.activeServices(coverage.serviceDate).has(trip.service_id)) routes.get(trip.route_id).trips++
  const add = (type, identity, fields) => events.push({ id: eventId(type, ...identity), type, severity: 'info', observedAt: generatedAt, ...fields })
  const sourceFresh = (record) => feedByUrl.get(record.sourceUrl)?.status === 'fresh'
  const recordFresh = (record) => sourceFresh(record) && (!finite(record.timestamp) || nowSeconds - record.timestamp <= policy.freshnessSeconds && record.timestamp - nowSeconds <= policy.freshnessSeconds)

  for (const feed of feeds) if (feed.status !== 'fresh') add('stale-data', [feed.sourceUrl], {
    title: feed.status === 'unknown' ? 'Feed time is unknown' : feed.status === 'error' ? 'Feed refresh failed' : 'Feed is stale', severity: 'warning',
    evidence: { ...(feed.ageSeconds === null ? {} : { feedAgeSeconds: feed.ageSeconds }), reason: feed.error || `Freshness window: ${policy.freshnessSeconds} seconds.` }, sourceRefs: [feed.sourceUrl],
  })
  if (snapshot && !feeds.length) warnings.push('Individual feed timestamps are absent. Reconnect the source before using observations.')
  if (!coverage.valid) warnings.push(coverage.message)

  for (const update of snapshot?.tripUpdates ?? []) {
    const match = coverage.valid ? context.matchTrip(update, coverage.serviceDate) : { reason: coverage.message }
    const ref = `${update.sourceUrl ?? 'unknown source'}#entity=${encodeURIComponent(update.id)}`
    if (!match.trip || !recordFresh(update)) {
      trips.push({ id: update.id, sourceUrl: update.sourceUrl, status: 'unresolved', reason: match.reason || 'The TripUpdate is stale or its source time is unknown.' })
      continue
    }
    const { trip, serviceDate, departures, epoch } = match
    const route = routes.get(trip.route_id)
    route.reportingTrips++
    const base = { routeId: trip.route_id, directionId: trip.direction_id ?? undefined, tripId: trip.trip_id, vehicleId: update.vehicleId, serviceDate, sourceRefs: [ref, `gtfs:trips/${encodeURIComponent(trip.trip_id)}?date=${serviceDate}`] }
    const identity = [trip.trip_id, serviceDate]
    if (['CANCELED', 'DELETED'].includes(update.scheduleRelationship)) {
      add('cancellation', identity, { ...base, title: 'Scheduled trip cancelled', severity: 'warning', evidence: { reason: `TripDescriptor: ${update.scheduleRelationship}` } })
      trips.push({ ...base, status: 'cancelled' })
      continue
    }
    if (update.scheduleRelationship && update.scheduleRelationship !== 'SCHEDULED') {
      trips.push({ ...base, status: 'unresolved', reason: `Unsupported trip relationship: ${update.scheduleRelationship}` })
      continue
    }
    const predictions = []
    const duplicateSequences = new Set()
    for (const stopUpdate of update.stopTimeUpdates ?? []) {
      const candidates = departures.filter((row) => (stopUpdate.stopSequence === undefined || row.stop_sequence === stopUpdate.stopSequence)
        && (!stopUpdate.stopId || rawId(row.from_stop_id) === rawId(stopUpdate.stopId)))
      if (candidates.length !== 1 || stopUpdate.stopSequence === undefined && !stopUpdate.stopId) continue
      const row = candidates[0]
      if (duplicateSequences.has(row.stop_sequence)) continue
      duplicateSequences.add(row.stop_sequence)
      if (stopUpdate.scheduleRelationship === 'SKIPPED') {
        add('skipped-stop', [...identity, row.stop_sequence], { ...base, stopId: row.from_stop_id, title: 'Scheduled stop skipped', severity: 'warning', evidence: { scheduledTime: epoch + row.departure, reason: 'StopTimeUpdate: SKIPPED' } })
        continue
      }
      if (stopUpdate.scheduleRelationship && stopUpdate.scheduleRelationship !== 'SCHEDULED') continue
      const departure = stopUpdate.departure
      const predictedTime = finite(departure?.time) ? departure.time : finite(departure?.delay) ? epoch + row.departure + departure.delay : null
      if (predictedTime === null) continue // Arrival predictions never stand in for departures.
      const prediction = { tripId: trip.trip_id, sequence: row.stop_sequence, stopId: row.from_stop_id, scheduledTime: epoch + row.departure, predictedTime, delaySeconds: predictedTime - epoch - row.departure, sourceRef: ref }
      predictions.push(prediction)
      if (prediction.scheduledTime < nowSeconds || prediction.scheduledTime > nowSeconds + policy.windowMinutes * 60) continue
      const key = eventId(trip.route_id, trip.direction_id, row.from_stop_id, serviceDate)
      if (!groups.has(key)) groups.set(key, { trip, stopId: row.from_stop_id, serviceDate, epoch, predictions: [] })
      groups.get(key).predictions.push(prediction)
    }
    const next = predictions.filter((prediction) => prediction.predictedTime >= nowSeconds).sort((a, b) => a.predictedTime - b.predictedTime)[0]
    if (next) {
      route.maxDelaySeconds = Math.max(route.maxDelaySeconds ?? -Infinity, next.delaySeconds)
      if (next.delaySeconds > 0) add('delay', [...identity, next.sequence], { ...base, stopId: next.stopId, title: 'Departure later than scheduled', evidence: { scheduledTime: next.scheduledTime, predictedTime: next.predictedTime, delaySeconds: next.delaySeconds } })
    }
    trips.push({ ...base, status: 'matched', ...(next ? { nextStopId: next.stopId, scheduledTime: next.scheduledTime, predictedTime: next.predictedTime, delaySeconds: next.delaySeconds } : {}), departurePredictions: predictions.length })
  }

  let incompleteIntervals = 0
  let measuredIntervals = 0
  for (const [key, group] of groups) {
    const { trip, stopId, serviceDate, epoch } = group
    const ordered = group.predictions.sort((a, b) => a.predictedTime - b.predictedTime || a.tripId.localeCompare(b.tripId))
    const allExpected = context.expectedDepartures(trip, stopId, serviceDate, nowSeconds - epoch, nowSeconds + policy.windowMinutes * 60 - epoch)
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
      const route = routes.get(trip.route_id)
      if (observedHeadwaySeconds === scheduledHeadwaySeconds) {
        if (completeWindow && route.headway === 'unknown') route.headway = 'matches-schedule'
        continue
      }
      route.headway = 'changed'
      const compressed = observedHeadwaySeconds < scheduledHeadwaySeconds
      add(compressed ? 'bunching' : 'service-gap', [key, before.tripId, after.tripId], {
        title: compressed ? 'Compressed departure interval' : 'Wider departure interval', routeId: trip.route_id, directionId: trip.direction_id ?? undefined,
        tripId: after.tripId, stopId, serviceDate,
        evidence: { scheduledHeadwaySeconds, observedHeadwaySeconds, headwayRatio: observedHeadwaySeconds / scheduledHeadwaySeconds,
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
    const routeIds = context.routes.filter((route) => (alert.routeIds ?? []).some((id) => rawId(id) === rawId(route.route_id))).map((route) => route.route_id)
    const stopIds = context.stops.filter((stop) => (alert.stopIds ?? []).some((id) => rawId(id) === rawId(stop.stop_id))).map((stop) => stop.stop_id)
    for (const routeId of routeIds) routes.get(routeId).alerts++
    add('service-alert', [alert.sourceUrl, alert.id], { title: alert.header || 'Service alert', routeId: routeIds.length === 1 ? routeIds[0] : undefined, routeIds, stopIds,
      severity: alert.severity === 'SEVERE' ? 'critical' : alert.severity === 'WARNING' ? 'warning' : 'info',
      evidence: { alertHeader: alert.header, alertDescription: alert.description, reason: [alert.effect, alert.cause].filter(Boolean).join(' · ') }, sourceRefs: [`${alert.sourceUrl}#entity=${encodeURIComponent(alert.id)}`] })
  }
  for (const vehicle of snapshot?.vehicles ?? []) if (sourceFresh(vehicle) && (!finite(vehicle.timestamp) || nowSeconds - vehicle.timestamp > policy.freshnessSeconds)) add('stale-data', [vehicle.sourceUrl, vehicle.id], {
    title: finite(vehicle.timestamp) ? 'Vehicle observation is stale' : 'Vehicle observation time is unknown', vehicleId: vehicle.id,
    evidence: { ...(finite(vehicle.timestamp) ? { feedAgeSeconds: nowSeconds - vehicle.timestamp } : {}), reason: 'VehiclePosition timestamp is evaluated independently of the feed header.' }, sourceRefs: [`${vehicle.sourceUrl}#vehicle=${encodeURIComponent(vehicle.id)}`],
  })
  for (const event of events) for (const routeId of event.routeIds ?? (event.routeId ? [event.routeId] : [])) if (routes.has(routeId)) routes.get(routeId).events++
  events.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || (b.evidence.delaySeconds ?? 0) - (a.evidence.delaySeconds ?? 0) || a.id.localeCompare(b.id))
  return { generatedAt, observedAt: snapshot?.fetchedAt ?? null, cityName: context.cityName, connected: Boolean(snapshot), coverage,
    counts: { routes: routes.size, stops: context.stops.length, vehicles: (snapshot?.vehicles ?? []).filter((vehicle) => recordFresh(vehicle) && finite(vehicle.timestamp)).length, trips: trips.length, matchedTrips: trips.filter((trip) => trip.status !== 'unresolved').length, unresolvedTrips: trips.filter((trip) => trip.status === 'unresolved').length, alerts: activeAlerts },
    feeds, routes: [...routes.values()], events, trips, warnings, policy }
}

export function createObservationHistory(policy = defaultPolicy) {
  const events = new Map()
  const trips = new Map()
  let lastObservation = null
  return {
    update(state) {
      const cutoff = Date.parse(state.generatedAt) - policy.historyMinutes * 60_000
      if (state.observedAt && state.observedAt !== lastObservation) {
        for (const event of state.events) events.set(event.id, event)
        for (const trip of state.trips) if (finite(trip.delaySeconds)) {
          const series = trips.get(trip.tripId) ?? []
          series.push({ at: state.observedAt, delaySeconds: trip.delaySeconds })
          trips.set(trip.tripId, series)
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
