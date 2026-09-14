import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, recordIdentity } from './operations.mjs'
import { procedureMetadata } from './procedures.mjs'

const sourceDirectory = fileURLToPath(new URL('../../artifacts/replay/holding-v1/', import.meta.url))
export const replayDirectory = existsSync(sourceDirectory) ? sourceDirectory : fileURLToPath(new URL('./replay/holding-v1/', import.meta.url))
export function loadReplay(directory = replayDirectory) {
  const read = name => {
    if (typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.json')) fail('Replay files must be JSON files inside the package.')
    const text = readFileSync(path.join(directory, name), 'utf8')
    if (Buffer.byteLength(text) > 256_000) fail('Replay file exceeds 256 KB.')
    return JSON.parse(text)
  }
  const manifest = read('manifest.json')
  if (manifest.schemaVersion !== 1 || manifest.synthetic !== true || manifest.cases.length > 20) fail('Unsupported replay package.')
  if (![manifest.freshnessSeconds, manifest.decisionLifetimeSeconds].every(value => Number.isFinite(value) && value > 0 && value <= 3600)) fail('Replay freshness and expiry must be explicit bounded seconds.')
  const timetable = read(manifest.timetable), procedures = read(manifest.procedures)
  procedures.forEach(record => procedureMetadata(record.procedure))
  if (timetable.feed_info[0].feed_version !== manifest.timetableVersion) fail('Replay timetable version does not match its manifest.')
  const observations = Object.fromEntries(manifest.cases.map(item => [item.id, read(item.observations)]))
  return { manifest, timetable, procedures, observations, identity: recordIdentity([manifest, timetable, procedures, observations]) }
}

function one(rows, predicate, name) {
  const values = rows.filter(predicate)
  if (values.length !== 1) fail(`Replay requires exactly one ${name}; found ${values.length}.`)
  return values[0]
}

export function replayEvidence(bundle, caseId, frame = 'initial', at) {
  const scenario = one(bundle.manifest.cases, row => row.id === caseId, 'case')
  const feeds = bundle.observations[caseId][frame]
  if (!feeds) fail('Unknown replay observation.')
  const clock = at || scenario.clock, now = Date.parse(clock) / 1000, table = bundle.timetable
  if (!Number.isFinite(now)) fail('Invalid replay clock.')
  const problems = [], refs = [`${bundle.manifest.id}/${scenario.observations}#${frame}`, `${bundle.manifest.id}/${bundle.manifest.timetable}@${bundle.manifest.timetableVersion}`]
  const isFresh = timestamp => Number.isFinite(timestamp) && now >= timestamp && now - timestamp <= bundle.manifest.freshnessSeconds
  const fresh = (timestamp, label) => { if (!isFresh(timestamp)) problems.push(`${label} is missing, future-dated or stale.`) }
  const tripReports = feeds.trip_updates.entity.map(row => row.trip_update)
  for (const [kind, feed] of Object.entries(feeds)) fresh(feed.header.timestamp, kind)
  const route = one(table.routes, row => row.route_id === scenario.routeId, 'route')
  const stop = one(table.stops, row => row.stop_id === scenario.controlStopId, 'control point')
  const positions = feeds.vehicle_positions.entity.map(row => row.vehicle)
  const vehicle = one(positions, row => row.trip.trip_id === scenario.tripIds[1], 'selected vehicle report')
  fresh(vehicle.timestamp, 'Vehicle position')
  if (vehicle.current_status !== 'STOPPED_AT' || vehicle.stop_id !== stop.stop_id) problems.push('The selected vehicle is not confirmed stationary at the approved control point.')
  const trips = scenario.tripIds.map(id => {
    const scheduled = one(table.trips, row => row.trip_id === id, 'scheduled trip')
    const report = one(tripReports, row => row.trip.trip_id === id, 'trip report')
    fresh(report.timestamp, `Trip ${id}`)
    if (scheduled.route_id !== route.route_id || report.trip.route_id !== route.route_id || report.trip.direction_id !== scheduled.direction_id || report.trip.start_date !== scenario.clock.slice(0, 10).replaceAll('-', '') || report.trip.schedule_relationship && report.trip.schedule_relationship !== 'SCHEDULED') fail('Replay trip identity or schedule relationship is inconsistent.')
    const active = one(table.calendar_dates, row => row.service_id === scheduled.service_id && row.date === report.trip.start_date, 'service exception')
    if (active.exception_type !== 1) fail('Replay trip does not operate on the observation service date.')
    return { scheduled, report }
  })
  if (vehicle.trip.route_id !== route.route_id || vehicle.trip.direction_id !== trips[1].scheduled.direction_id || vehicle.trip.start_date !== trips[1].report.trip.start_date) problems.push('Vehicle and trip reports disagree on service identity.')
  // This deliberately narrow replay adapter accepts an explicit UTC synthetic timetable only.
  if (table.agency[0].agency_timezone !== 'UTC') fail('The synthetic replay adapter requires its UTC timetable. It is not a general GTFS importer.')
  const midnight = Date.parse(`${scenario.clock.slice(0, 10)}T00:00:00Z`) / 1000
  const times = stopId => trips.map(({ scheduled, report }) => {
    const row = one(table.stop_times, row => row.trip_id === scheduled.trip_id && row.stop_id === stopId, 'scheduled stop call')
    const update = one(report.stop_time_update, item => item.stop_id === stopId && item.stop_sequence === row.stop_sequence, 'matching stop prediction')
    if (update.schedule_relationship && update.schedule_relationship !== 'SCHEDULED' || !Number.isFinite(update.departure?.time)) fail('Replay requires an explicit departure prediction at every comparison stop.')
    const parts = row.departure_time.split(':').map(Number)
    if (parts.length !== 3 || parts.some(n => !Number.isInteger(n)) || parts[1] < 0 || parts[1] > 59 || parts[2] < 0 || parts[2] > 59) fail('Invalid GTFS departure clock.')
    return { scheduled: midnight + parts[0] * 3600 + parts[1] * 60 + parts[2], predicted: update.departure.time, sequence: row.stop_sequence }
  })
  const control = times(stop.stop_id)
  if (trips.some(t => t.scheduled.direction_id !== trips[1].scheduled.direction_id)) fail('Replay comparisons must use one direction.')
  const downstream = scenario.downstreamArrivalRates.map(rate => {
    const calls = times(rate.stopId)
    if (calls.some((call, i) => call.sequence <= control[i].sequence)) fail('A modeled stop must be downstream of the control point.')
    return { stopId: rate.stopId, stopName: one(table.stops, row => row.stop_id === rate.stopId, 'downstream stop').stop_name,
      frontSeconds: calls[1].predicted - calls[0].predicted, backSeconds: calls[2].predicted - calls[1].predicted,
      currentDelaySeconds: calls[1].predicted - calls[1].scheduled, arrivalsPerSecond: rate.passengersPerMinute / 60 }
  })
  const sourceSeconds = Math.min(...Object.values(feeds).map(feed => feed.header.timestamp), vehicle.timestamp, ...trips.map(t => t.report.timestamp))
  const sourceAt = Number.isFinite(sourceSeconds) ? new Date(sourceSeconds * 1000).toISOString() : null
  const frontSeconds = control[1].predicted - control[0].predicted, backSeconds = control[2].predicted - control[1].predicted
  if (frontSeconds <= 0 || backSeconds <= 0) problems.push('The three predictions do not establish ordered adjacent departures.')
  return { caseId, clock, sourceAt, routeId: route.route_id, routeName: route.route_short_name, stopId: stop.stop_id, stopName: stop.stop_name,
    spacingEstablished: isFresh(feeds.trip_updates.header.timestamp) && trips.every(t => isFresh(t.report.timestamp)) && frontSeconds > 0 && backSeconds > 0,
    destination: table.stops.at(-1).stop_name, vehicleId: vehicle.vehicle.id, tripId: scenario.tripIds[1], problems, refs, frontSeconds, backSeconds,
    scheduledHeadwaySeconds: control[1].scheduled - control[0].scheduled, downstream, onboardPassengers: scenario.onboardPassengers,
    prerequisites: scenario.prerequisites, assumptions: [`${scenario.onboardPassengers} passengers on board (synthetic input).`, ...scenario.downstreamArrivalRates.map(r => `${r.passengersPerMinute} arriving passengers/minute at ${r.stopId} (synthetic input).`)],
    evidenceVersion: recordIdentity([bundle.identity, caseId, frame, feeds]),
    expiresAt: new Date(sourceAt ? Math.min(Date.parse(sourceAt) + bundle.manifest.freshnessSeconds * 1000, Date.parse(clock) + bundle.manifest.decisionLifetimeSeconds * 1000) : Date.parse(clock)).toISOString() }
}
