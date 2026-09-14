import { rawId } from './agencyContext.mjs'
import { defaultPolicy, feedStates } from './realtimeIntelligence.mjs'

const finite = value => typeof value === 'number' && Number.isFinite(value)
const sameId = (indexed, reported) => String(reported).includes('\u001f') ? indexed === reported : rawId(indexed) === rawId(reported)
const patternCache = new WeakMap()
const callsByDepartures = new WeakMap()
const callIndexes = new WeakMap()

// A connection's arrival belongs to its to_stop. The terminal arrival is known,
// but the original terminal sequence and departure are not stored by VIGO.
export function tripCalls(context, tripId) {
  const rows = context.tripDepartures(tripId)
  const cached = callsByDepartures.get(rows)
  if (cached) return cached
  const calls = rows.map((row, index) => ({
    stopId: row.from_stop_id, sequence: row.stop_sequence,
    arrival: rows[index - 1]?.to_stop_id === row.from_stop_id ? rows[index - 1].arrival : null,
    departure: row.departure,
  }))
  if (rows.length) calls.push({ stopId: rows.at(-1).to_stop_id, sequence: null, arrival: rows.at(-1).arrival, departure: null })
  const result = { calls, continuous: rows.every((row, index) => !index || rows[index - 1].to_stop_id === row.from_stop_id) }
  callsByDepartures.set(rows, result)
  return result
}

export function station(context, id) {
  const stop = context.stopIndex.get(id)
  const parent = context.stopIndex.get(stop?.parent_station)
  const place = Number(parent?.location_type) === 1 ? parent : stop
  return { id: place?.stop_id ?? id, name: place?.name || rawId(id) }
}

function routePatterns(context, routeId, serviceDates) {
  let cache = patternCache.get(context)
  if (!cache) { cache = new Map(); patternCache.set(context, cache) }
  const key = JSON.stringify([routeId, serviceDates])
  if (cache.has(key)) return cache.get(key)
  const patterns = new Map(), byTrip = new Map()
  const active = new Set(serviceDates.flatMap(date => [...context.activeServices(date)]))
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

export function fresh(record, feeds, now, policy, requireTimestamp = false) {
  if (feeds.get(record.sourceUrl)?.status !== 'fresh') return false
  if (!finite(record.timestamp)) return !requireTimestamp
  return Math.abs(now - record.timestamp) <= policy.freshnessSeconds
}

export function matchCall(calls, stopId, sequence) {
  if (!stopId && !finite(sequence)) return null
  let indexed = callIndexes.get(calls)
  if (!indexed) {
    indexed = { sequences: new Map(), stops: new Map(), lastSequence: -Infinity }
    for (const [index, call] of calls.entries()) {
      const entry = { ...call, index }, id = rawId(call.stopId)
      if (!indexed.sequences.has(call.sequence)) indexed.sequences.set(call.sequence, [])
      if (!indexed.stops.has(id)) indexed.stops.set(id, [])
      indexed.sequences.get(call.sequence).push(entry)
      indexed.stops.get(id).push(entry)
      indexed.lastSequence = Math.max(indexed.lastSequence, call.sequence ?? -1)
    }
    callIndexes.set(calls, indexed)
  }
  if (finite(sequence)) {
    const exact = indexed.sequences.get(sequence) ?? []
    if (exact.length) return exact.length === 1 && (!stopId || sameId(exact[0].stopId, stopId)) ? exact[0] : null
  }
  const candidates = stopId ? (indexed.stops.get(rawId(stopId)) ?? []).filter(call => sameId(call.stopId, stopId)) : []
  // A unique terminal ID can match, but its unretained sequence cannot resolve
  // a loop or contradict the order of the known calls.
  if (finite(sequence) && (candidates[0]?.sequence !== null || sequence <= indexed.lastSequence)) return null
  return candidates.length === 1 ? candidates[0] : null
}

export function prediction(event, scheduled) {
  if (finite(event?.time)) return event.time
  return finite(event?.delay) && finite(scheduled) ? scheduled + event.delay : null
}

// Negative deviations are valid. Only a contradiction between two reported
// events at the same stop prevents presenting them as usable predictions.
export function stopPrediction(report, scheduledArrival, scheduledDeparture) {
  const arrival = prediction(report.arrival, scheduledArrival)
  const departure = prediction(report.departure, scheduledDeparture)
  const issue = finite(arrival) && finite(departure) && arrival > departure
    ? 'The source places arrival after departure at this stop.' : null
  return { arrival: issue ? null : arrival, departure: issue ? null : departure, issue }
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
  const timing = stopPrediction(stopUpdate, detail.arrival.scheduled, detail.departure.scheduled)
  if (timing.issue) { detail.warnings.push(timing.issue); return detail }
  for (const kind of ['arrival', 'departure']) detail[kind].current = timing[kind]
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
  const vehicles = []
  for (const vehicle of snapshot?.vehicles ?? []) {
    if (vehicle.routeId && !sameId(routeId, vehicle.routeId)) continue
    const detail = describe(context, vehicle, now, policy, feeds, coverage, updates)
    if (detail.routeId !== routeId) continue
    vehicles.push(detail)
  }
  // A fresh vehicle may still be serving yesterday's >24:00 trip. Keep that
  // exact service day's patterns alongside today's, grouped by stop sequence.
  const serviceDates = [...new Set([coverage.serviceDate, ...vehicles.filter(vehicle => vehicle.fresh && vehicle.callIndex !== null).map(vehicle => vehicle.serviceDate)].filter(Boolean))].sort()
  const topology = serviceDates.length ? routePatterns(context, routeId, serviceDates) : { patterns: [], byTrip: new Map() }
  for (const vehicle of vehicles) vehicle.patternId = topology.byTrip.get(vehicle.tripId) ?? null
  return { routeId, name: resolved.short_name || resolved.long_name || rawId(routeId), color: /^[0-9a-f]{6}$/i.test(resolved.color) ? `#${resolved.color}` : 'var(--vigo-lime-strong)',
    serviceDate: coverage.serviceDate, serviceDates, timezone: context.timezone, generatedAt: new Date(now * 1000).toISOString(), observedAt: snapshot?.fetchedAt ?? null,
    patterns: topology.patterns, vehicles, warnings: coverage.valid ? [] : [coverage.message] }
}
