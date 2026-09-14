import { localDate, serviceEpoch, agencyClock } from './agencyClock.mjs'

const spansByContext = new WeakMap()
const key = (tripId, serviceDate) => JSON.stringify([tripId, serviceDate])
export const tripInstance = (trip) => key(trip.tripId, trip.serviceDate)

// Build once per read-only timetable. A service opportunity is the part of a
// scheduled trip intersecting the assessment window, not its entire day's work.
export function scheduledServiceWindow(context, from, to) {
  if (!context.timezone) return { trips: [], excludedFrequencyTemplates: 0 }
  if (!spansByContext.has(context)) {
    const spans = context.db.prepare('SELECT trip_id, MIN(departure) AS first, MAX(arrival) AS last FROM connections GROUP BY trip_id').all()
    const byService = new Map()
    for (const [order, row] of spans.entries()) {
      const trip = context.tripById.get(row.trip_id)
      if (!trip) continue
      if (!byService.has(trip.service_id)) byService.set(trip.service_id, [])
      byService.get(trip.service_id).push({ first: row.first, last: row.last, trip, order })
    }
    spansByContext.set(context, { byService, maxServiceSeconds: spans.reduce((max, row) => Math.max(max, row.last), 0) })
  }
  const { byService, maxServiceSeconds } = spansByContext.get(context)
  const date = localDate(from, context.timezone)
  const noon = Date.parse(`${date}T12:00:00Z`)
  const trips = [], excluded = new Set()
  // Include prior service days with 24:00+ trips, and tomorrow when the window
  // crosses midnight. Each date uses the GTFS noon-minus-12-hours clock (DST).
  const daysBack = Math.ceil(maxServiceSeconds / 86400)
  const lastDate = localDate(to, context.timezone)
  for (let offset = -daysBack; ; offset++) {
    const serviceDate = new Date(noon + offset * 86400000).toISOString().slice(0, 10)
    if (serviceDate > lastDate) break
    const epoch = serviceEpoch(serviceDate, context.timezone), active = context.activeServices(serviceDate)
    const selected = []
    for (const service of active) for (const row of byService.get(service) ?? []) {
      const trip = row.trip
      const seconds = Math.max(0, Math.min(to, epoch + row.last) - Math.max(from, epoch + row.first))
      if (!seconds) continue
      if (context.frequencyTrips.has(trip.trip_id)) { excluded.add(trip.trip_id); continue }
      selected.push({ row, seconds })
    }
    // Preserve the timetable's trip order across multiple active calendars.
    // Only intersecting trips need sorting, not every trip in the source feed.
    selected.sort((a, b) => a.row.order - b.row.order)
    for (const { row, seconds } of selected) trips.push({ key: key(row.trip.trip_id, serviceDate), tripId: row.trip.trip_id, routeId: row.trip.route_id, directionId: row.trip.direction_id, serviceDate, seconds,
      startsAt: epoch + row.first, endsAt: epoch + row.last })
  }
  return { trips, excludedFrequencyTemplates: excluded.size }
}

// Compare this window with scheduled work ahead, not every route in the feed
// or a city-specific definition of night. These are supply facts, not health.
export function scheduledServiceContext(context, from, window) {
  const referenceHours = 24
  const reference = scheduledServiceWindow(context, from, from + referenceHours * 3600)
  const active = window.trips.filter(trip => trip.startsAt <= from && trip.endsAt > from)
  const windowRoutes = new Set(window.trips.map(trip => trip.routeId)).size
  const referenceRoutes = new Set(reference.trips.map(trip => trip.routeId)).size
  const nextStart = reference.trips.reduce((next, trip) => trip.startsAt > from ? Math.min(next, trip.startsAt) : next, Infinity)
  // Frequency instances are not reconstructed by this index. Do not call the
  // network inactive when any of its supply is outside the timed-trip model.
  const complete = context.frequencyTrips.size === 0
  return { clock: agencyClock(new Date(from * 1000).toISOString(), context.timezone), referenceHours, windowRoutes, referenceRoutes,
    referenceComplete: context.coverage(from + referenceHours * 3600 - 1).valid,
    activeTrips: active.length, complete,
    phase: !complete ? 'incomplete' : !active.length ? 'between_runs' : 'scheduled_service',
    nextScheduledTripAt: Number.isFinite(nextStart) ? new Date(nextStart * 1000).toISOString() : null,
    nextScheduledTrip: Number.isFinite(nextStart) ? agencyClock(new Date(nextStart * 1000).toISOString(), context.timezone) : null }
}
