import { rawId } from './agencyContext.mjs'
import { defaultPolicy, feedStates } from './realtimeIntelligence.mjs'

const finite = value => typeof value === 'number' && Number.isFinite(value)
const sameId = (indexed, reported) => String(reported).includes('\u001f') ? indexed === reported : rawId(indexed) === rawId(reported)
const patternCache = new WeakMap()

// A connection's arrival belongs to its to_stop. The terminal arrival is known,
// but the original terminal sequence and departure are not stored by VIGO.
export function tripCalls(context, tripId) {
  const rows = context.tripDepartures(tripId)
  const calls = rows.map((row, index) => ({
    stopId: row.from_stop_id, sequence: row.stop_sequence,
    arrival: rows[index - 1]?.to_stop_id === row.from_stop_id ? rows[index - 1].arrival : null,
    departure: row.departure,
  }))
  if (rows.length) calls.push({ stopId: rows.at(-1).to_stop_id, sequence: null, arrival: rows.at(-1).arrival, departure: null })
  return { calls, continuous: rows.every((row, index) => !index || rows[index - 1].to_stop_id === row.from_stop_id) }
}

function station(context, id) {
  const stop = context.stopIndex.get(id)
  const parent = context.stopIndex.get(stop?.parent_station)
  const place = Number(parent?.location_type) === 1 ? parent : stop
  return { id: place?.stop_id ?? id, name: place?.name || rawId(id) }
}

function routePatterns(context, routeId, serviceDate) {
  let cache = patternCache.get(context)
  if (!cache) { cache = new Map(); patternCache.set(context, cache) }
  const key = JSON.stringify([routeId, serviceDate])
  if (cache.has(key)) return cache.get(key)
  const patterns = new Map(), byTrip = new Map()
  const active = context.activeServices(serviceDate)
  for (const trip of context.trips) {
    if (trip.route_id !== routeId || !active.has(trip.service_id)) continue
    const { calls, continuous } = tripCalls(context, trip.trip_id)
    if (!continuous || calls.length < 2) continue
    const stops = calls.map(call => station(context, call.stopId))
    const signature = JSON.stringify([trip.direction_id, stops.map(stop => stop.id)])
    let pattern = patterns.get(signature)
    if (!pattern) {
      pattern = { id: String(patterns.size), directionId: trip.direction_id ?? null, stops, trips: 0 }
      patterns.set(signature, pattern)
    }
    pattern.trips++
    byTrip.set(trip.trip_id, pattern.id)
  }
  const result = { patterns: [...patterns.values()], byTrip }
  cache.set(key, result)
  if (cache.size > 48) cache.delete(cache.keys().next().value)
  return result
}

function fresh(record, feeds, now, policy, requireTimestamp = false) {
  if (feeds.get(record.sourceUrl)?.status !== 'fresh') return false
  if (!finite(record.timestamp)) return !requireTimestamp
  return Math.abs(now - record.timestamp) <= policy.freshnessSeconds
}

function matchCall(calls, stopId, sequence) {
  if (!stopId && !finite(sequence)) return null
  const indexed = calls.map((call, index) => ({ ...call, index }))
  if (finite(sequence)) {
    const exact = indexed.filter(call => call.sequence === sequence)
    if (exact.length) return exact.length === 1 && (!stopId || sameId(exact[0].stopId, stopId)) ? exact[0] : null
  }
  const candidates = indexed.filter(call => stopId && sameId(call.stopId, stopId))
  // A unique terminal ID can match, but its unretained sequence cannot resolve
  // a loop or contradict the order of the known calls.
  if (finite(sequence) && (candidates[0]?.sequence !== null || sequence <= Math.max(...calls.map(call => call.sequence ?? -1)))) return null
  return candidates.length === 1 ? candidates[0] : null
}

function prediction(event, scheduled) {
  if (finite(event?.time)) return event.time
  return finite(event?.delay) && finite(scheduled) ? scheduled + event.delay : null
}

function describe(context, vehicle, now, policy, feeds, coverage, updates) {
  const match = coverage.valid ? context.matchTrip(vehicle, coverage.serviceDate) : { reason: coverage.message }
  const vehicleFresh = fresh(vehicle, feeds, now, policy, true)
  const detail = {
    key: JSON.stringify([vehicle.sourceUrl, vehicle.id]), id: vehicle.id, label: vehicle.label || vehicle.id,
    routeId: match.trip?.route_id ?? vehicle.routeId ?? null, routeName: null, tripId: match.trip?.trip_id ?? vehicle.tripId ?? null,
    directionId: match.trip?.direction_id ?? null, serviceDate: match.serviceDate ?? null, timezone: context.timezone,
    observedAt: vehicle.timestamp ?? null, predictionAt: null, fresh: vehicleFresh,
    destination: null, stop: null, callIndex: null, patternId: null,
    status: null, arrival: { scheduled: null, current: null }, departure: { scheduled: null, current: null },
    delaySeconds: null, delayKind: null, occupancy: vehicle.occupancyStatus ?? null, warnings: [],
  }
  const route = context.routeIndex.get(detail.routeId)
  detail.routeName = route?.short_name || route?.long_name || rawId(detail.routeId)
  if (!vehicleFresh) detail.warnings.push('Vehicle position is stale or its observation time is unknown.')
  if (!match.trip) { detail.warnings.push(match.reason); return detail }
  if (vehicle.scheduleRelationship && vehicle.scheduleRelationship !== 'SCHEDULED') {
    detail.warnings.push(`Vehicle trip is ${vehicle.scheduleRelationship.toLowerCase().replaceAll('_', ' ')}.`)
    return detail
  }
  const { calls, continuous } = tripCalls(context, match.trip.trip_id)
  detail.destination = station(context, calls.at(-1)?.stopId).name
  const call = matchCall(calls, vehicle.stopId, vehicle.currentStopSequence)
  if (!call || !continuous) {
    detail.warnings.push('The reported stop cannot be placed unambiguously on this trip’s indexed stop sequence.')
    return detail
  }
  detail.stop = { ...station(context, call.stopId), stopId: call.stopId }
  detail.callIndex = vehicleFresh ? call.index : null
  detail.status = finite(vehicle.currentStopSequence) ? vehicle.currentStatus || 'IN_TRANSIT_TO' : 'STOP_REPORTED'
  for (const kind of ['arrival', 'departure']) detail[kind].scheduled = finite(call[kind]) ? match.epoch + call[kind] : null
  const candidates = (updates.get(rawId(vehicle.tripId)) ?? []).filter(update => {
    if (update.vehicleId && update.vehicleId !== vehicle.id) return false
    const identity = context.matchTrip(update, coverage.serviceDate)
    return identity.trip?.trip_id === match.trip.trip_id && identity.serviceDate === match.serviceDate
  })
  if (candidates.length !== 1) {
    detail.warnings.push(candidates.length ? 'Multiple prediction reports claim this trip; timing is unresolved.' : 'No prediction report matches this vehicle and trip.')
    return detail
  }
  const update = candidates[0]
  detail.predictionAt = update.timestamp ?? feeds.get(update.sourceUrl)?.feedTimestamp ?? null
  if (!fresh(update, feeds, now, policy)) { detail.warnings.push('The prediction report is stale or its source time is unknown.'); return detail }
  if (update.scheduleRelationship && update.scheduleRelationship !== 'SCHEDULED') {
    detail.warnings.push(`Trip is ${update.scheduleRelationship.toLowerCase().replaceAll('_', ' ')}; current timing is unavailable.`)
    detail.callIndex = null
    return detail
  }
  const stopUpdates = (update.stopTimeUpdates ?? []).filter(item => matchCall(calls, item.stopId, item.stopSequence)?.index === call.index)
  if (stopUpdates.length !== 1) { detail.warnings.push('No single prediction is available for this reported stop.'); return detail }
  const stopUpdate = stopUpdates[0]
  if (stopUpdate.scheduleRelationship && stopUpdate.scheduleRelationship !== 'SCHEDULED') {
    detail.warnings.push(stopUpdate.scheduleRelationship === 'SKIPPED' ? 'This stop is reported skipped.' : 'No current timing is reported at this stop.')
    return detail
  }
  for (const kind of ['arrival', 'departure']) detail[kind].current = prediction(stopUpdate[kind], detail[kind].scheduled)
  detail.delayKind = ['arrival', 'departure'].find(kind => finite(detail[kind].scheduled) && finite(detail[kind].current)) ?? null
  const comparison = detail[detail.delayKind]
  detail.delaySeconds = comparison ? comparison.current - comparison.scheduled : null
  return detail
}

function inputs(context, snapshot, now, policy) {
  const feeds = new Map(feedStates(snapshot, now, policy).map(feed => [feed.sourceUrl, feed]))
  const updates = new Map()
  for (const update of snapshot?.tripUpdates ?? []) {
    const id = rawId(update.tripId)
    if (!updates.has(id)) updates.set(id, [])
    updates.get(id).push(update)
  }
  return { feeds, updates, coverage: context.coverage(now) }
}

export function vehicleDetails(context, snapshot, { vehicleId, sourceUrl }, now = Date.now() / 1000, policy = defaultPolicy) {
  if (typeof vehicleId !== 'string' || !vehicleId || vehicleId.length > 500 || sourceUrl !== undefined && typeof sourceUrl !== 'string') throw new Error('Choose a reported vehicle.')
  const vehicles = (snapshot?.vehicles ?? []).filter(vehicle => vehicle.id === vehicleId && (!sourceUrl || vehicle.sourceUrl === sourceUrl))
  if (vehicles.length !== 1) throw new Error(vehicles.length ? 'Vehicle identity is ambiguous across feeds.' : 'This vehicle is no longer in the current feed.')
  const { feeds, updates, coverage } = inputs(context, snapshot, now, policy)
  return describe(context, vehicles[0], now, policy, feeds, coverage, updates)
}

export function routeOperations(context, snapshot, { routeId }, now = Date.now() / 1000, policy = defaultPolicy) {
  if (typeof routeId !== 'string' || !routeId || routeId.length > 500) throw new Error('Choose a route.')
  const resolved = context.routeIndex.has(routeId) ? context.routeIndex.get(routeId) : null
  if (!resolved) throw new Error('Choose an exact route from this City’s timetable.')
  const { feeds, updates, coverage } = inputs(context, snapshot, now, policy)
  const topology = coverage.serviceDate ? routePatterns(context, routeId, coverage.serviceDate) : { patterns: [], byTrip: new Map() }
  const vehicles = []
  for (const vehicle of snapshot?.vehicles ?? []) {
    if (vehicle.routeId && !sameId(routeId, vehicle.routeId)) continue
    const detail = describe(context, vehicle, now, policy, feeds, coverage, updates)
    if (detail.routeId !== routeId) continue
    detail.patternId = topology.byTrip.get(detail.tripId) ?? null
    vehicles.push(detail)
  }
  return { routeId, name: resolved.short_name || resolved.long_name || rawId(routeId), color: /^[0-9a-f]{6}$/i.test(resolved.color) ? `#${resolved.color}` : 'var(--vigo-lime-strong)',
    serviceDate: coverage.serviceDate, timezone: context.timezone, generatedAt: new Date(now * 1000).toISOString(), observedAt: snapshot?.fetchedAt ?? null,
    patterns: topology.patterns, vehicles, warnings: coverage.valid ? [] : [coverage.message] }
}
