import { haversineKm } from '../server/geometry-utils.mjs'
import { localDate, validDate } from './agencyClock.mjs'

// A geographic join, not a name guess or proof of pedestrian access. Read the
// timetable only when requested; this adds no work to routing or feed refresh.
export function nearbyStops(context, { point, radiusMeters, limit = 12, serviceDate }, now) {
  if (!point || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180
    || !Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 5000 || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('Supply verified coordinates, a radius of up to 5,000 metres and a limit of 1–30 stops.')
  if (!context.timezone) throw new Error('A single agency timezone is required to identify scheduled services.')
  const date = serviceDate ?? localDate(now, context.timezone)
  if (!validDate(date)) throw new Error('Choose a valid service date.')
  const located = context.stops.filter(stop => Number(stop.location_type ?? 0) === 0 && Number.isFinite(stop.lat) && Math.abs(stop.lat) <= 90 && Number.isFinite(stop.lon) && Math.abs(stop.lon) <= 180)
    .map(stop => ({ stop, distance: haversineKm([point.lon, point.lat], [stop.lon, stop.lat]) * 1000 }))
    .sort((a, b) => a.distance - b.distance || a.stop.stop_id.localeCompare(b.stop.stop_id))
  const candidates = located.filter(item => item.distance <= radiusMeters)
  const describe = ({ stop, distance }) => ({ kind: 'stop', id: stop.stop_id, name: stop.name,
    lat: stop.lat, lon: stop.lon, parentStationId: stop.parent_station || null, distanceMeters: Math.round(distance) })
  if (!candidates.length) return { status: 'no_stops_in_radius', point, radiusMeters, serviceDate: date, timezone: context.timezone,
    total: 0, matches: [], routeCount: null, nearestStops: located.slice(0, limit).map(describe),
    meaning: 'No stop was found inside this radius. Service count at the requested place is unknown, not zero. A large site’s centre may be far from its passenger terminals. The nearest stops below are OUTSIDE the search radius; they do not prove site access.',
    nextStep: 'Review nearestStops for the named terminal or entrance and use stop_arrivals with its actual ID. Otherwise search around a verified entrance. Do not infer suspended or absent service from this empty radius.' }
  const matches = candidates.slice(0, limit).map(item => ({ ...describe(item), routes: [] }))
  const stops = new Map(matches.map(stop => [stop.id, stop])), routes = new Map()
  const active = [...context.activeServices(date)]
  if (matches.length && active.length) {
    const ids = matches.map(stop => stop.id), slots = ids.map(() => '?').join(',')
    const records = context.db.prepare(`SELECT DISTINCT route_id, from_stop_id, to_stop_id FROM connections
      WHERE service_id IN (SELECT value FROM json_each(?)) AND (from_stop_id IN (${slots}) OR to_stop_id IN (${slots}))`)
      .all(JSON.stringify(active), ...ids, ...ids)
    const byStop = new Map(matches.map(stop => [stop.id, new Set()]))
    for (const record of records) for (const id of [record.from_stop_id, record.to_stop_id]) {
      const route = context.routeIndex.get(record.route_id)
      if (!stops.has(id) || !route || byStop.get(id).has(route.route_id)) continue
      const value = { id: route.route_id, name: route.short_name || route.long_name || route.route_id, description: route.long_name }
      byStop.get(id).add(route.route_id); stops.get(id).routes.push(value); routes.set(route.route_id, value)
    }
  }
  return { status: 'ready', point, radiusMeters, serviceDate: date, timezone: context.timezone, total: candidates.length, truncated: candidates.length > matches.length,
    matches, routes: [...routes.values()], routeCount: routes.size,
    meaning: 'Routes with indexed connections at the returned stops on this service date. Proximity does not establish site service, terminal access, a walking path or current operation. Stops outside the radius or result limit are not counted.',
    nextStep: 'Use stop_arrivals with a returned stop ID for next services. Use route_plan for a journey. For a large site, verify the intended terminal or entrance before calling a nearby stop its serving stop.' }
}
