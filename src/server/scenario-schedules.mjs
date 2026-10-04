import { DatabaseSync } from 'node:sqlite'
import { activeServiceIds } from './gtfs/service-calendar.mjs'
import { resolveServiceDay } from './service-day.mjs'
import { scenarioEntityMatches } from './scenario-entity-ids.mjs'
import { normalizeRoutingPointIdentities } from './routing-point-identity.mjs'

function invalid(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'invalid_reach_request'
  return error
}

function nonnegative(value, fallback, label) {
  const result = value === undefined ? fallback : Number(value)
  if (value === null || typeof value === 'boolean' || !Number.isFinite(result) || result < 0) {
    throw invalid(`${label} must be a finite non-negative number.`)
  }
  return result
}

// Resolve visits in order: A -> B -> A contains two different A events.
function baselineIndexes(stops, original) {
  let minimum = 0
  return stops.map((stop) => {
    if (['inserted', 'added'].includes(stop.editStatus)) return undefined
    const id = stop.baselineStopId ?? stop.stopId
    if (!id) return undefined
    const suffix = /:stop:(\d+)$/.exec(String(stop.id ?? ''))
    const explicit = stop.baselineStopIndex ?? (suffix ? Number(suffix[1]) - 1 : undefined)
    const matches = (index) => index >= minimum && index < original.length
      && scenarioEntityMatches(original[index], id)
    const index = explicit === undefined
      ? original.findIndex((_, index) => matches(index))
      : Number.isInteger(explicit) && matches(explicit) ? explicit : -1
    if (index < 0) throw invalid('The edited stops must retain their original GTFS occurrence order. Reset the branch stops and reapply the edit.')
    minimum = index + 1
    return index
  })
}

function distanceKm(left, right) {
  const latitude = (left[1] + right[1]) / 2 * Math.PI / 180
  return Math.hypot((right[0] - left[0]) * 111.32 * Math.cos(latitude), (right[1] - left[1]) * 111.32)
}

function retimeTrip(service, rows, coordinates) {
  const original = [rows[0].from_stop_id, ...rows.map((row) => row.to_stop_id)]
  if (rows.some((row, index) => index > 0 && row.from_stop_id !== original[index])) {
    throw invalid(`Cannot preserve the disconnected stop sequence of trip ${rows[0].trip_id}.`)
  }
  const indexes = baselineIndexes(service.stops, original)
  const anchors = indexes.flatMap((index, position) => index === undefined ? [] : [{ index, position }])
  if (!anchors.length) throw invalid('Keeping scheduled departures requires at least one original GTFS stop as a timing anchor.')
  const departures = [...rows.map((row) => row.departure), rows.at(-1).arrival]
  const arrivals = [rows[0].departure, ...rows.map((row) => row.arrival)]
  const running = rows.map((row) => row.arrival - row.departure)
  if (running.some((seconds) => seconds < 0) || departures.some((time, index) => time < arrivals[index])) {
    throw invalid(`Cannot preserve inconsistent times for trip ${rows[0].trip_id}.`)
  }
  const speed = nonnegative(service.averageSpeedKph, 22, 'averageSpeedKph')
  if (!speed) throw invalid('averageSpeedKph must be positive.')
  const distances = service.stops.slice(1).map((stop, index) => nonnegative(
    service.segmentDistancesKm?.[index], distanceKm(service.stops[index].coordinate, stop.coordinate), 'segmentDistancesKm',
  ))
  const runtimes = distances.map((distance, index) => nonnegative(
    service.segmentRuntimeMinutes?.[index], distance / speed * 60, 'segmentRuntimeMinutes',
  ) * 60)
  for (let anchor = 1; anchor < anchors.length; anchor += 1) {
    const left = anchors[anchor - 1], right = anchors[anchor]
    const untouched = right.position === left.position + 1 && right.index === left.index + 1
      && [left, right].every(({ index, position }) => {
        const stop = service.stops[position], coordinate = coordinates.get(original[index])
        return stop.editStatus !== 'replaced' && coordinate
          && stop.coordinate.every((value, axis) => Math.abs(value - coordinate[axis]) < 1e-7)
      })
    if (!untouched && service.timeModel === 'estimate-distance') continue
    const seconds = running.slice(left.index, right.index).reduce((sum, value) => sum + value, 0)
    const weights = distances.slice(left.position, right.position)
    const total = weights.reduce((sum, value) => sum + value, 0)
    for (let position = left.position; position < right.position; position += 1) {
      runtimes[position] = seconds * (total > 0 ? weights[position - left.position] / total : 1 / weights.length)
    }
  }
  const addedDwell = nonnegative(service.addedStopDwellMinutes, 0.35, 'addedStopDwellMinutes') * 60
  const arrivalOffsetsSeconds = [0], departureOffsetsSeconds = [0]
  for (let position = 1; position < service.stops.length; position += 1) {
    const index = indexes[position]
    const arrival = departureOffsetsSeconds[position - 1] + runtimes[position - 1]
    const dwell = index === undefined ? addedDwell : departures[index] - arrivals[index]
    arrivalOffsetsSeconds.push(arrival)
    departureOffsetsSeconds.push(arrival + dwell)
  }
  const first = anchors[0]
  const departureSeconds = departures[first.index] - departureOffsetsSeconds[first.position]
  if (departureSeconds < 0) throw invalid('This extension would depart before the start of the service date. Adjust its timing or use an explicit frequency schedule.')
  return {
    tripId: rows[0].trip_id,
    departureSeconds,
    departureOffsetsSeconds,
    arrivalOffsetsSeconds,
    canBoard: indexes.map((index, position) => position === indexes.length - 1 ? 0 : index === undefined ? 1 : rows[index]?.can_board ?? 0),
    canAlight: indexes.map((index, position) => position === 0 ? 0 : index === undefined ? 1 : rows[index - 1]?.can_alight ?? 0),
  }
}

/** Expand only actual active GTFS trips. Equal start/end times emit one native run. */
export function hydrateScheduledScenarioService(storePath, service, tripIds, request) {
  const serviceDay = resolveServiceDay(request.serviceDate, request.serviceDay)
  if (tripIds.length > 50_000) throw invalid('A scheduled replacement is limited to 50000 trips.')
  const sourceScope = String(service.sourceRouteId ?? '').split(/::|\u001f/)
  const localFeedId = sourceScope.length > 1 ? sourceScope[0] : request.feedId ?? ''
  service = { ...service, stops: normalizeRoutingPointIdentities(storePath, { waypoints: service.stops }, localFeedId).waypoints }
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name))
    const metadata = tables.has('metadata') ? db.prepare("SELECT value FROM metadata WHERE key='serviceModel'").get() : undefined
    const services = activeServiceIds(db, request.serviceDate, metadata ? JSON.parse(metadata.value) : 'exact-date', serviceDay)
    const permissions = tables.has('connection_permissions')
    const lookup = db.prepare(`SELECT connection.*,
      ${permissions ? 'COALESCE(permission.can_board, 1)' : '1'} AS can_board,
      ${permissions ? 'COALESCE(permission.can_alight, 1)' : '1'} AS can_alight
      FROM connections AS connection
      ${permissions ? `LEFT JOIN connection_permissions AS permission
        ON permission.trip_id=connection.trip_id AND permission.stop_sequence=connection.stop_sequence` : ''}
      WHERE connection.trip_id=? ORDER BY connection.stop_sequence`)
    const stopLookup = db.prepare('SELECT lon, lat FROM stops WHERE stop_id=?')
    const coordinates = new Map()
    const scheduledTrips = []
    for (const tripId of tripIds) {
      const rows = lookup.all(tripId)
      if (!rows.length || !services.has(rows[0].service_id)) continue
      for (const stopId of [rows[0].from_stop_id, ...rows.map((row) => row.to_stop_id)]) {
        if (coordinates.has(stopId)) continue
        const stop = stopLookup.get(stopId)
        if (stop) coordinates.set(stopId, [stop.lon, stop.lat])
      }
      scheduledTrips.push(retimeTrip(service, rows, coordinates))
      if (scheduledTrips.length * service.stops.length > 1_000_000) {
        throw invalid('The scheduled replacement exceeds one million stop events. Select fewer branches.')
      }
    }
    return { ...service, scheduleMode: 'preserve-trips', bidirectional: false,
      timeModel: service.timeModel ?? 'preserve-scheduled',
      addedStopDwellMinutes: service.addedStopDwellMinutes ?? 0.35, scheduledTrips }
  } finally {
    db.close()
  }
}
