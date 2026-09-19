import { localDate, rawId } from './agencyContext.mjs'
import { fresh } from './routeOperations.mjs'
import { agencyClock } from './agencyClock.mjs'

// Resolve the public fleet label before looking at the destination, so an
// advance assignment cannot win just because it serves the requested station.
export function vehicleTrip(context, snapshot, { vehicleId, routeId }, feeds, now, policy) {
  if (typeof vehicleId !== 'string' || !vehicleId.trim() || vehicleId.length > 500) throw new Error('Supply a reported vehicle number or ID.')
  const query = vehicleId.trim()
  const result = { id: null, label: query, tripId: null, serviceDate: null, routeId: null, routeName: null, observedAt: null, issue: null }
  const fail = issue => ({ ...result, issue })
  const date = localDate(now, context.timezone)
  const positions = (snapshot?.vehicles ?? []).filter(item => item.id === query || item.label === query)
  const ids = new Set([query, ...positions.map(item => item.id)])
  const updates = (snapshot?.tripUpdates ?? []).filter(item => ids.has(item.vehicleId) || item.vehicleLabel === query)
  const current = positions.filter(item => fresh(item, feeds, now, policy, true))
  // Positions identify the current trip. Without one, require a single fresh
  // TripUpdate assignment instead of choosing among this vehicle's next trips.
  const candidates = current.length ? current : updates.filter(item => fresh(item, feeds, now, policy))
  if (!candidates.length) return fail(positions.length || updates.length
    ? `Reports for vehicle ${query} are out of date; its current trip cannot be verified.`
    : `Vehicle ${query} is not identified in the latest feed. Check its displayed vehicle number.`)
  const matched = candidates.map(record => ({ record, match: context.matchTripIdentity(record, date) }))
  if (matched.some(item => !item.match.trip)) return fail(`The reported trip for vehicle ${query} cannot be matched reliably to the timetable.`)
  const scoped = matched.filter(item => !routeId || item.match.trip.route_id === routeId)
  if (!scoped.length) return fail(`Vehicle ${query} is not currently reported on the requested route.`)
  if (scoped.length !== 1) return fail(`More than one trip or feed matches vehicle ${query}. Its arrival cannot be assigned to a single vehicle report.`)
  const { record, match } = scoped[0]
  const route = context.routeIndex.get(match.trip.route_id)
  return { ...result, id: current.length ? record.id : record.vehicleId,
    label: (current.length ? record.label : record.vehicleLabel) || query,
    tripId: match.trip.trip_id, serviceDate: match.serviceDate,
    routeId: match.trip.route_id, routeName: route?.short_name || route?.long_name || rawId(match.trip.route_id),
    observedAt: record.timestamp ?? feeds.get(record.sourceUrl)?.feedTimestamp ?? null }
}

export function describeVehicleArrival(board) {
  const vehicle = board.vehicle
  if (vehicle.issue) return vehicle.issue
  const subject = `Vehicle ${vehicle.label}${vehicle.routeName ? ` on ${vehicle.routeName}` : ''}`
  const row = board.rows[0]
  if (!row) return `No upcoming time at ${board.stop.name} is available for vehicle ${vehicle.label}’s reported trip. The feed does not establish when it will arrive there.`
  if (row.status === 'cancelled') return `${subject}’s reported trip is cancelled. Do not expect its scheduled arrival at ${board.stop.name}.`
  if (row.status === 'skipped') return `${subject} is reported to skip ${board.stop.name} on this trip.`
  if (row.atStop) return `${subject} is reported at ${board.stop.name} now.`
  const now = Date.parse(board.generatedAt) / 1000
  const today = agencyClock(board.generatedAt, board.timezone)?.date
  const clock = seconds => {
    const value = agencyClock(new Date(seconds * 1000).toISOString(), board.timezone)
    return `${value.date !== today ? `${value.date} ` : ''}${value.time} ${value.zoneLabel}`
  }
  const timing = row[row.kind]
  const scheduled = timing.scheduled == null ? '' : ` Scheduled ${row.kind}: ${clock(timing.scheduled)}.`
  if (timing.current == null) return `${subject} has no ${row.status === 'stale' ? 'fresh' : row.status === 'unresolved' ? 'unambiguous' : 'reported'} ${row.kind} prediction at ${board.stop.name}.${scheduled}`
  const minutes = Math.ceil((timing.current - now) / 60)
  return `${subject} is expected to ${row.kind === 'departure' ? 'depart from' : 'arrive at'} ${board.stop.name} at ${clock(timing.current)} (${minutes > 0 ? `in about ${minutes} min` : 'due now'}).${scheduled}`
}
