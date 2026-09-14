import { rawId, localDate, serviceEpoch } from './agencyContext.mjs'
import { defaultPolicy, feedStates } from './realtimeIntelligence.mjs'
import { tripCalls, station, fresh, matchCall, stopPrediction } from './routeOperations.mjs'

const finite = value => typeof value === 'number' && Number.isFinite(value)
const schedules = new WeakMap()
const instanceKey = (tripId, date) => JSON.stringify([tripId, date])
const shiftDate = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

export function indexedBoardStop(context, stopId, feedIds = []) {
  if (typeof stopId !== 'string' || !stopId || stopId.length > 500) throw new Error('Choose an exact stop from this City’s timetable.')
  if (context.stopIndex.has(stopId)) return stopId
  const delimiter = stopId.indexOf('::')
  const feedId = stopId.slice(0, delimiter), localId = stopId.slice(delimiter + 2)
  if (delimiter > 0 && feedIds.includes(feedId)) {
    const scopedId = `${feedId}\u001f${localId}`
    if (context.stopIndex.has(scopedId)) return scopedId
    // Studio scopes even a single-feed preview; its unmerged SQLite keeps raw
    // GTFS IDs. Only the known single source may cross this boundary.
    if (feedIds.length === 1 && context.scopes.length === 1 && context.scopes[0] === '' && context.stopIndex.has(localId)) return localId
  }
  throw new Error('Choose an exact stop from this City’s timetable.')
}

function stationSchedule(context, stopId) {
  let cache = schedules.get(context)
  if (!cache) { cache = new Map(); schedules.set(context, cache) }
  if (cache.has(stopId)) return cache.get(stopId)
  const ids = context.stops.filter(stop => stop.stop_id === stopId || stop.parent_station === stopId && Number(stop.location_type || 0) === 0).map(stop => stop.stop_id)
  const placeholders = ids.map(() => '?').join(',')
  // Cache this read-only station lookup. Terminal arrivals are included through
  // to_stop_id; outgoing connections alone would lose the end of every trip.
  const trips = context.db.prepare(`SELECT trip_id, MIN(MIN(departure, arrival)) AS first_seconds, MAX(MAX(departure, arrival)) AS last_seconds FROM connections WHERE from_stop_id IN (${placeholders}) OR to_stop_id IN (${placeholders}) GROUP BY trip_id`).all(...ids, ...ids)
  const result = { trips, members: new Set(ids), maxSeconds: trips.reduce((max, trip) => Math.max(max, trip.last_seconds), 0) }
  cache.set(stopId, result)
  if (cache.size > 32) cache.delete(cache.keys().next().value)
  return result
}

function reportsByTrip(context, records, date) {
  const reports = new Map()
  for (const record of records ?? []) {
    const match = context.matchTrip(record, date)
    if (!match.trip) continue
    const key = instanceKey(match.trip.trip_id, match.serviceDate)
    if (!reports.has(key)) reports.set(key, [])
    reports.get(key).push(record)
  }
  return reports
}

export function stopBoard(context, snapshot, { stopId, feedIds }, now = Date.now() / 1000, policy = defaultPolicy) {
  stopId = indexedBoardStop(context, stopId, feedIds)
  const place = station(context, stopId)
  const generatedAt = new Date(now * 1000).toISOString()
  const result = { stop: place, timezone: context.timezone, generatedAt, until: now + 3600, feeds: feedStates(snapshot, now, policy), rows: [], total: 0, warnings: [] }
  if (!context.timezone) { result.warnings.push('A single agency timezone is required to show stop times.'); return result }
  const today = localDate(now, context.timezone)
  const schedule = stationSchedule(context, place.id)
  const feeds = new Map(result.feeds.map(feed => [feed.sourceUrl, feed]))
  const updates = reportsByTrip(context, snapshot?.tripUpdates, today)
  const vehicles = reportsByTrip(context, snapshot?.vehicles, today)
  // Include every service-day offset represented here, including >24:00 and
  // the next day's early service. Epoch conversion also handles DST changes.
  for (let offset = -Math.ceil(schedule.maxSeconds / 86400) - 1; offset <= 1; offset++) {
    const date = shiftDate(today, offset), epoch = serviceEpoch(date, context.timezone)
    const active = context.activeServices(date)
    for (const record of schedule.trips) {
      const trip = context.tripById.get(record.trip_id)
      if (!trip || !active.has(trip.service_id) || context.frequencyTrips.has(trip.trip_id)) continue
      const key = instanceKey(trip.trip_id, date)
      if (!updates.has(key) && !vehicles.has(key) && (epoch + record.first_seconds > result.until || epoch + record.last_seconds < now)) continue
      const { calls: pattern, continuous } = tripCalls(context, trip.trip_id)
      if (!continuous) continue
      const destination = station(context, pattern.at(-1)?.stopId).name
      for (const [index, call] of pattern.entries()) {
        if (!schedule.members.has(call.stopId)) continue
        const candidates = updates.get(key) ?? []
        const update = candidates.length === 1 ? candidates[0] : null
        const updateFresh = update && fresh(update, feeds, now, policy)
        let status = candidates.length > 1 ? 'unresolved' : update && !updateFresh ? 'stale' : 'scheduled'
        let timingIssue = null, source = null
        const arrival = { scheduled: finite(call.arrival) ? epoch + call.arrival : null, current: null }
        const departure = { scheduled: finite(call.departure) ? epoch + call.departure : null, current: null }
        if (updateFresh) {
          if (['CANCELED', 'DELETED'].includes(update.scheduleRelationship)) status = 'cancelled'
          else if (!update.scheduleRelationship || update.scheduleRelationship === 'SCHEDULED') {
            const atCall = (update.stopTimeUpdates ?? []).filter(item => matchCall(pattern, item.stopId, item.stopSequence)?.index === index)
            if (atCall.length > 1) status = 'unresolved'
            else if (atCall.length === 1) {
              const report = atCall[0]
              source = { url: update.sourceUrl, entityId: update.id, stopSequence: report.stopSequence ?? null,
                arrival: report.arrival ?? null, departure: report.departure ?? null }
              if (report.scheduleRelationship === 'SKIPPED') status = 'skipped'
              else if (!report.scheduleRelationship || report.scheduleRelationship === 'SCHEDULED') {
                const timing = stopPrediction(report, arrival.scheduled, departure.scheduled)
                arrival.current = timing.arrival; departure.current = timing.departure; timingIssue = timing.issue
                if (timingIssue) status = 'unresolved'
                else if (finite(arrival.current) || finite(departure.current)) status = 'live'
              }
            }
          } else status = 'unresolved'
        }
        const vehicleReports = (vehicles.get(key) ?? []).filter(vehicle => fresh(vehicle, feeds, now, policy, true))
        const vehicle = vehicleReports.length === 1 && (!updateFresh || !update.vehicleId || update.vehicleId === vehicleReports[0].id) ? vehicleReports[0] : null
        const vehicleCall = vehicle ? matchCall(pattern, vehicle.stopId, vehicle.currentStopSequence) : null
        // A fresh exact position beyond this call establishes that it has passed.
        if (vehicleCall && vehicleCall.index > index) continue
        const atStop = vehicleCall?.index === index && vehicle?.currentStatus === 'STOPPED_AT' && !['cancelled', 'skipped'].includes(status)
        const kind = finite(arrival.current) ? 'arrival' : finite(departure.current) ? 'departure' : finite(arrival.scheduled) ? 'arrival' : 'departure'
        const time = (kind === 'arrival' ? arrival : departure)
        const expected = time.current ?? time.scheduled
        const leaves = departure.current ?? arrival.current ?? departure.scheduled ?? arrival.scheduled
        if (!finite(expected) || expected > result.until || !atStop && leaves < now) continue
        const route = context.routeIndex.get(trip.route_id)
        const stop = context.stopIndex.get(call.stopId)
        result.rows.push({ key: JSON.stringify([trip.trip_id, date, index]), tripId: trip.trip_id, serviceDate: date,
          routeId: trip.route_id, routeName: route?.short_name || route?.long_name || rawId(trip.route_id),
          color: /^[0-9a-f]{6}$/i.test(route?.color) ? `#${route.color}` : 'var(--text-muted)',
          directionId: trip.direction_id ?? null, destination, stopId: call.stopId, stopName: stop?.name || rawId(call.stopId), platform: stop?.platform_code || null,
          vehicleId: vehicle?.id || (updateFresh ? update.vehicleId : null) || null, vehicleLabel: vehicle?.label || vehicle?.id || (updateFresh ? update.vehicleLabel || update.vehicleId : null) || null,
          vehicleSourceUrl: vehicle?.sourceUrl || null, atStop, kind, expected, arrival, departure, status,
          stopSequence: call.sequence, source, timingIssue,
          predictionAt: updateFresh ? update.timestamp ?? feeds.get(update.sourceUrl)?.feedTimestamp ?? null : null })
      }
    }
  }
  result.rows.sort((a, b) => Number(b.atStop) - Number(a.atStop) || a.expected - b.expected || a.key.localeCompare(b.key))
  result.total = result.rows.length
  result.rows = result.rows.slice(0, 100)
  if (!snapshot) result.warnings.push('Timetable only · connect live feeds for arrival predictions.')
  else if (![...feeds.values()].some(feed => feed.kind === 'tripUpdates' && feed.status === 'fresh')) result.warnings.push('Live predictions are unavailable or out of date. Scheduled times are shown.')
  if (!result.rows.length && !context.coverage(now).valid) result.warnings.push(context.coverage(now).message)
  return result
}
