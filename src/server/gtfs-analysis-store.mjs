import { nativeNetworkOverview } from './native-routing-kernel.mjs'
import { DatabaseSync } from 'node:sqlite'
import { haversineKm, lineDistanceKm } from './geometry-utils.mjs'
import { numeric } from './number-utils.mjs'
import { routeDisplayLongName, routePreviewColor } from './route-presentation.mjs'
import { serviceDayForDate } from './service-day.mjs'

function validCoordinate(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length === 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1])
    && coordinate[0] >= -180
    && coordinate[0] <= 180
    && coordinate[1] >= -90
    && coordinate[1] <= 90
}

function median(values) {
  if (!values.length) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function medianServiceHeadwayMinutes(departuresByServiceId) {
  const withinServiceGaps = [...departuresByServiceId.values()].flatMap((departures) => {
    const ordered = [...new Set(departures.map((value) => Math.round(value)))]
      .sort((left, right) => left - right)
    return ordered.slice(1)
      .map((value, index) => value - ordered[index])
      .filter((gap) => gap > 0 && gap <= 6 * 60 * 60)
  })
  return withinServiceGaps.length
    ? Math.max(1, Math.round(median(withinServiceGaps) / 60))
    : 0
}

function frequencyClass(headwayMinutes) {
  if (headwayMinutes > 0 && headwayMinutes <= 15) return 'high'
  if (headwayMinutes > 0 && headwayMinutes <= 30) return 'medium'
  return 'low'
}

function patternToken(value) {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function tripPathStatements(db) {
  return {
    connections: db.prepare(`
      SELECT connection.departure, connection.arrival, connection.stop_sequence,
        source.stop_id AS from_stop_id, source.name AS from_name,
        source.lat AS from_lat, source.lon AS from_lon,
        source.parent_station AS from_parent_station,
        source.location_type AS from_location_type,
        source.platform_code AS from_platform_code,
        target.stop_id AS to_stop_id, target.name AS to_name,
        target.lat AS to_lat, target.lon AS to_lon,
        target.parent_station AS to_parent_station,
        target.location_type AS to_location_type,
        target.platform_code AS to_platform_code
      FROM connections AS connection
      JOIN stops AS source ON source.stop_id=connection.from_stop_id
      JOIN stops AS target ON target.stop_id=connection.to_stop_id
      WHERE connection.trip_id=?
      ORDER BY connection.stop_sequence, connection.from_stop_id, connection.to_stop_id
    `),
    shapePoints: db.prepare(`
      SELECT lon, lat
      FROM shape_points
      WHERE shape_id=?
      ORDER BY sequence
    `),
  }
}

function stopRecord(row, prefix) {
  const longitude = numeric(row[`${prefix}_lon`], NaN)
  const latitude = numeric(row[`${prefix}_lat`], NaN)
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  return {
    id: String(row[`${prefix}_stop_id`]),
    name: String(row[`${prefix}_name`] || row[`${prefix}_stop_id`]),
    lon: longitude,
    lat: latitude,
    x: 0,
    y: 0,
    parentStationId: row[`${prefix}_parent_station`] || undefined,
    locationType: row[`${prefix}_location_type`] ?? 0,
    platformCode: row[`${prefix}_platform_code`] || undefined,
    routes: [],
    tripCount: 0,
    transferScore: 0,
  }
}

function tripPath(connectionRows) {
  const stops = []
  for (const [index, row] of connectionRows.entries()) {
    // Connections repeat the shared stop between edges, but two consecutive
    // calls at the same stop are separate timetable occurrences.
    if (index === 0 || connectionRows[index - 1].to_stop_id !== row.from_stop_id) {
      const from = stopRecord(row, 'from')
      if (from) stops.push(from)
    }
    const to = stopRecord(row, 'to')
    if (to) stops.push(to)
  }
  return stops
}

function mergeStop(stopMap, source, routeId, tripCount) {
  const stop = stopMap.get(source.id) ?? { ...source, routes: [], tripCount: 0, transferScore: 0 }
  if (!stop.routes.includes(routeId)) {
    stop.routes.push(routeId)
    stop.tripCount += tripCount
  }
  stopMap.set(stop.id, stop)
}

function finalizedStops(stopMap) {
  return [...stopMap.values()]
    .map((stop) => ({
      ...stop,
      transferScore: Math.min(100, stop.routes.length * 24 + Math.log10(Math.max(1, stop.tripCount)) * 18),
    }))
    .sort((left, right) => right.transferScore - left.transferScore || right.tripCount - left.tripCount || left.id.localeCompare(right.id))
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function activeServiceIdsForDate(db, serviceDate) {
  if (!serviceDate) return null
  const normalized = String(serviceDate).trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized)
  if (!match) throw new Error('GTFS route analysis serviceDate must use YYYY-MM-DD.')
  const serviceDay = serviceDayForDate(normalized)
  const date = Number(`${match[1]}${match[2]}${match[3]}`)
  const parsed = new Date(`${normalized}T12:00:00Z`)
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][parsed.getUTCDay()]
  const services = new Set()
  if (tableExists(db, 'calendar')) {
    for (const row of db.prepare(`
      SELECT service_id
      FROM calendar
      WHERE start_date<=? AND end_date>=? AND ${weekday}=1
    `).all(date, date)) services.add(String(row.service_id))
  }
  if (tableExists(db, 'calendar_dates')) {
    for (const row of db.prepare('SELECT service_id, exception_type FROM calendar_dates WHERE date=?').all(date)) {
      if (Number(row.exception_type) === 1) services.add(String(row.service_id))
      else if (Number(row.exception_type) === 2) services.delete(String(row.service_id))
    }
  }
  return { services, serviceDay, serviceDate: normalized }
}

function cumulativeShapeDistances(coordinates) {
  const distances = [0]
  for (let index = 1; index < coordinates.length; index += 1) {
    distances.push(distances.at(-1) + haversineKm(coordinates[index - 1], coordinates[index]))
  }
  return distances
}

function stopProgressAlongShape(coordinates, stops) {
  if (coordinates.length < 2 || stops.length < 2) {
    return stops.map((_stop, index) => stops.length > 1 ? index / (stops.length - 1) : 0)
  }
  const distances = cumulativeShapeDistances(coordinates)
  const totalDistance = distances.at(-1)
  if (!(totalDistance > 0)) return stops.map((_stop, index) => index / (stops.length - 1))
  const segmentCount = coordinates.length - 1
  const project = (stop, segment, minimumDistance = distances[segment]) => {
    const from = coordinates[segment]
    const to = coordinates[segment + 1]
    const scale = Math.cos(stop.lat * Math.PI / 180)
    const dx = (to[0] - from[0]) * scale
    const dy = to[1] - from[1]
    const lengthSquared = dx * dx + dy * dy
    const length = distances[segment + 1] - distances[segment]
    const minimumRatio = length > 0 ? Math.max(0, (minimumDistance - distances[segment]) / length) : 0
    const ratio = Math.max(minimumRatio, Math.min(1, lengthSquared > 0
      ? ((stop.lon - from[0]) * scale * dx + (stop.lat - from[1]) * dy) / lengthSquared
      : 0))
    const coordinate = [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio]
    const offset = haversineKm(coordinate, [stop.lon, stop.lat])
    return { distance: distances[segment] + length * ratio, cost: offset * offset }
  }

  // Align the whole ordered stop sequence. A greedy nearest point can put an
  // early stop onto a later loop occurrence because of a tiny coordinate
  // offset, leaving every following stop stuck beyond its real position.
  // Prefix minima keep this pass O(stops * segments). A same-segment clamp
  // retains slight backwards stop offsets without moving the vehicle backwards.
  let previousCosts
  let previousDistances
  const predecessors = []
  for (const stop of stops) {
    const costs = new Float64Array(segmentCount).fill(Number.POSITIVE_INFINITY)
    const along = new Float64Array(segmentCount)
    const parents = new Int32Array(segmentCount).fill(-1)
    let prefixIndex = -1
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const candidate = project(stop, segment)
      along[segment] = candidate.distance
      if (!previousCosts) {
        costs[segment] = candidate.cost
        continue
      }
      if (segment > 0 && (prefixIndex < 0 || previousCosts[segment - 1] < previousCosts[prefixIndex])) {
        prefixIndex = segment - 1
      }
      if (prefixIndex >= 0) {
        costs[segment] = previousCosts[prefixIndex] + candidate.cost
        parents[segment] = prefixIndex
      }
      const continued = candidate.distance >= previousDistances[segment]
        ? candidate
        : project(stop, segment, previousDistances[segment])
      const continuedCost = previousCosts[segment] + continued.cost
      if (continuedCost < costs[segment]) {
        costs[segment] = continuedCost
        along[segment] = continued.distance
        parents[segment] = segment
      }
    }
    predecessors.push(parents)
    previousCosts = costs
    previousDistances = along
  }
  let segment = 0
  for (let index = 1; index < segmentCount; index += 1) {
    if (previousCosts[index] < previousCosts[segment]) segment = index
  }
  const selectedSegments = new Int32Array(stops.length)
  for (let index = stops.length - 1; index >= 0; index -= 1) {
    selectedSegments[index] = segment
    segment = predecessors[index][segment]
  }
  let previousDistance = 0
  return stops.map((stop, index) => {
    previousDistance = Math.max(previousDistance, project(stop, selectedSegments[index]).distance)
    // Shapes can extend beyond passenger terminals; neither terminal is
    // forced to a shape endpoint, including with sparse published vertices.
    return previousDistance / totalDistance
  })
}

function scheduledTripRecord(trip, rows, stops, progresses, patternId, serviceDay) {
  const stopTimes = []
  const first = rows[0]
  if (!first) return null
  stopTimes.push({
    stopId: String(first.from_stop_id),
    sequence: numeric(first.stop_sequence),
    arrivalMinutes: numeric(first.departure) / 60,
    departureMinutes: numeric(first.departure) / 60,
    progress: progresses[0] ?? 0,
  })
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const next = rows[index + 1]
    stopTimes.push({
      stopId: String(row.to_stop_id),
      sequence: numeric(next?.stop_sequence, numeric(row.stop_sequence) + 1),
      arrivalMinutes: numeric(row.arrival) / 60,
      departureMinutes: numeric(next?.departure, row.arrival) / 60,
      progress: progresses[index + 1] ?? Math.min(1, (index + 1) / rows.length),
    })
  }
  const firstDepartureMinutes = numeric(rows[0]?.departure, NaN) / 60
  const lastArrivalMinutes = numeric(rows.at(-1)?.arrival, NaN) / 60
  if (!Number.isFinite(firstDepartureMinutes) || !Number.isFinite(lastArrivalMinutes)) return null
  return {
    tripId: String(trip.trip_id),
    serviceId: String(trip.service_id),
    serviceDays: [serviceDay],
    routeId: String(trip.route_id),
    patternId,
    directionId: trip.direction_id ?? undefined,
    firstDepartureMinutes,
    lastArrivalMinutes,
    // Keep the active trip visible to diagnostics even if its indexed edges
    // are disconnected; never interpolate a manufactured timetable across it.
    stopTimes: stops.length === rows.length + 1
      && rows.every((row, index) => index === 0 || rows[index - 1].to_stop_id === row.from_stop_id)
      ? stopTimes
      : [],
  }
}

// Locale-sensitive names/colors and UI ordering remain presentation concerns.
// SQLite traversal, geometry and service statistics are owned by Rust.
function presentNetworkOverview(serialized) {
  const overview = JSON.parse(serialized)
  for (const route of overview.routes) {
    const [short, long, first, last] = route._display
    delete route._display
    route.longName = routeDisplayLongName(short, long, [{ name: first }, { name: last }], route.id)
    route.color = routePreviewColor(route.color, route.id)
  }
  overview.stops.sort((a, b) => b.transferScore - a.transferScore || b.tripCount - a.tripCount || a.id.localeCompare(b.id))
  return overview
}

export function readGtfsNetworkOverview(storePath, options = {}) {
  return presentNetworkOverview(nativeNetworkOverview(storePath, String(options.sourceScope || '').trim()))
}

export async function readGtfsNetworkOverviewAsync(storePath, options = {}) {
  return presentNetworkOverview(await nativeNetworkOverview(storePath, String(options.sourceScope || '').trim(), true))
}

function resolveRouteService(db, routeId, sourceScope) {
  const route = db.prepare('SELECT route_id, short_name, long_name, route_type, color FROM routes WHERE route_id=?').get(routeId)
  if (!route) return null
  const scopeDelimiter = routeId.indexOf('\u001f')
  const routeSourceScope = scopeDelimiter > 0 ? routeId.slice(0, scopeDelimiter) : ''
  const effectiveSourceScope = routeSourceScope || sourceScope
  const serviceKey = scopeDelimiter > 0 ? routeId.slice(scopeDelimiter + 1) : routeId
  const tripCount = Number(db.prepare(
    'SELECT COUNT(*) AS count FROM trips INDEXED BY trips_route WHERE route_id=?',
  ).get(routeId)?.count ?? 0)
  return {
    source_scope: effectiveSourceScope,
    route_type: numeric(route.route_type, 3),
    service_key: serviceKey,
    representative_route_id: route.route_id,
    short_name: route.short_name,
    long_name: route.long_name,
    color: route.color,
    variant_count: 1,
    trip_count: tripCount,
  }
}

function memberRoutes(db, service) {
  return db.prepare(`
    SELECT route_id, short_name, long_name, route_type, color
    FROM routes
    WHERE route_id=?
  `).all(service.representative_route_id)
}

function routeTripsStatement(db) {
  return db.prepare(`
    SELECT trip.trip_id, trip.route_id, trip.service_id, trip.direction_id, shape.shape_id
    FROM trips AS trip INDEXED BY trips_route
    LEFT JOIN trip_shapes AS shape ON shape.trip_id=trip.trip_id
    WHERE trip.route_id=?
    ORDER BY trip.trip_id
  `)
}

function patternStopPairs(patternId, routeId, directionId, representativeRows, stops, runtimesByPair, headwayMinutes, tripCount) {
  const stopById = new Map(stops.map((stop) => [stop.id, stop]))
  return representativeRows.map((row, index) => {
    const fromStop = stopById.get(String(row.from_stop_id))
    const toStop = stopById.get(String(row.to_stop_id))
    const fromCoordinate = fromStop ? [fromStop.lon, fromStop.lat] : null
    const toCoordinate = toStop ? [toStop.lon, toStop.lat] : null
    const distanceKm = fromCoordinate && toCoordinate ? haversineKm(fromCoordinate, toCoordinate) : 0
    const runtimeMinutes = Math.max(0, median(runtimesByPair[index] ?? []) / 60)
    return {
      id: `${patternId}--segment-${index + 1}`,
      routeId,
      patternId,
      directionId: directionId ?? undefined,
      fromStopId: String(row.from_stop_id),
      toStopId: String(row.to_stop_id),
      fromStopName: String(row.from_name || row.from_stop_id),
      toStopName: String(row.to_name || row.to_stop_id),
      sequence: index + 1,
      tripCount,
      headwayMinutes,
      medianRuntimeMinutes: Number(runtimeMinutes.toFixed(2)),
      distanceKm: Number(distanceKm.toFixed(3)),
      speedKph: runtimeMinutes > 0 ? Number((distanceKm / (runtimeMinutes / 60)).toFixed(1)) : 0,
      coordinates: fromCoordinate && toCoordinate ? [fromCoordinate, toCoordinate] : undefined,
    }
  })
}

export function readGtfsRouteAnalysis(storePath, routeId, options = {}) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const sourceScope = String(options.sourceScope || '').trim()
    const service = resolveRouteService(db, String(routeId || '').trim(), sourceScope)
    if (!service) return null
    const resolvedSourceScope = String(service.source_scope || sourceScope).trim()
    const members = memberRoutes(db, service, resolvedSourceScope)
    if (!members.length) return null
    const activeCalendar = activeServiceIdsForDate(db, options.serviceDate)

    const tripLookup = routeTripsStatement(db)
    const statements = tripPathStatements(db)
    const groups = new Map()
    let stopTimesScanned = 0

    for (const member of members) {
      for (const trip of tripLookup.all(member.route_id)) {
        const rows = statements.connections.all(trip.trip_id)
        if (!rows.length) continue
        stopTimesScanned += rows.length
        const stops = tripPath(rows)
        if (stops.length < 2) continue
        const stopIds = stops.map((stop) => stop.id)
        // Equal stops and direction do not imply equal geometry: detours and
        // express variants can publish different shapes between those stops.
        const signature = `${trip.direction_id ?? ''}\u001e${trip.shape_id ?? ''}\u001e${stopIds.join('\u001f')}`
        const scopePrefix = resolvedSourceScope ? `${resolvedSourceScope}\u001f` : ''
        const localId = (id = '') => scopePrefix && id.startsWith(scopePrefix) ? id.slice(scopePrefix.length) : id
        // The same pattern is analyzed in both a feed store and a merged
        // project store. Namespacing changes its IDs, not its branch identity.
        const tokenSignature = `${trip.direction_id ?? ''}\u001e${localId(trip.shape_id ?? '')}\u001e${stopIds.map(localId).join('\u001f')}`
        const group = groups.get(signature) ?? {
          signature,
          tokenSignature,
          directionId: trip.direction_id ?? undefined,
          tripCount: 0,
          departuresByServiceId: new Map(),
          firstDepartureSeconds: Number.POSITIVE_INFINITY,
          lastArrivalSeconds: Number.NEGATIVE_INFINITY,
          serviceSeconds: 0,
          tripIds: [],
          representativeRows: rows,
          representativeStops: stops,
          representativeShapeId: trip.shape_id || undefined,
          runtimesByPair: Array.from({ length: rows.length }, () => []),
          activeTrips: [],
        }
        const firstDepartureSeconds = numeric(rows[0].departure, NaN)
        const lastArrivalSeconds = numeric(rows.at(-1).arrival, NaN)
        if (Number.isFinite(firstDepartureSeconds)) {
          const serviceId = String(trip.service_id)
          const serviceDepartures = group.departuresByServiceId.get(serviceId) ?? []
          serviceDepartures.push(firstDepartureSeconds)
          if (!group.departuresByServiceId.has(serviceId)) {
            group.departuresByServiceId.set(serviceId, serviceDepartures)
          }
          group.firstDepartureSeconds = Math.min(group.firstDepartureSeconds, firstDepartureSeconds)
        }
        if (Number.isFinite(lastArrivalSeconds)) group.lastArrivalSeconds = Math.max(group.lastArrivalSeconds, lastArrivalSeconds)
        if (Number.isFinite(firstDepartureSeconds) && Number.isFinite(lastArrivalSeconds)) {
          group.serviceSeconds += Math.max(0, lastArrivalSeconds - firstDepartureSeconds)
        }
        group.tripCount += 1
        group.tripIds.push(trip.trip_id)
        if (activeCalendar?.services.has(String(trip.service_id))) {
          group.activeTrips.push({ trip, rows })
        }
        for (let index = 0; index < rows.length; index += 1) {
          group.runtimesByPair[index] ??= []
          group.runtimesByPair[index].push(Math.max(0, numeric(rows[index].arrival) - numeric(rows[index].departure)))
        }
        if (!group.representativeShapeId && trip.shape_id) {
          group.representativeShapeId = trip.shape_id
          group.representativeRows = rows
          group.representativeStops = stops
        }
        groups.set(signature, group)
      }
    }

    const orderedGroups = [...groups.values()].sort((left, right) => (
      right.tripCount - left.tripCount
      || String(left.directionId ?? '').localeCompare(String(right.directionId ?? ''))
      || left.signature.localeCompare(right.signature)
    ))
    const totalTrips = orderedGroups.reduce((sum, group) => sum + group.tripCount, 0)
    const stopMap = new Map()
    const stopPairs = []
    const routes = orderedGroups.map((group, index) => {
      const patternId = index === 0
        ? service.representative_route_id
        : `${service.representative_route_id}--pattern-${index + 1}-${patternToken(group.tokenSignature)}`
      const stopCoordinates = group.representativeStops.map((stop) => [stop.lon, stop.lat])
      let coordinates = stopCoordinates
      let geometrySource = 'stop_sequence'
      let shapeId
      if (group.representativeShapeId) {
        const shapeCoordinates = statements.shapePoints.all(group.representativeShapeId)
          .map((point) => [numeric(point.lon, NaN), numeric(point.lat, NaN)])
          .filter(validCoordinate)
        if (shapeCoordinates.length >= 2) {
          coordinates = shapeCoordinates
          geometrySource = 'shape'
          shapeId = group.representativeShapeId
        }
      }
      coordinates = coordinates.filter(validCoordinate)
      const progresses = stopProgressAlongShape(coordinates, group.representativeStops)
      const scheduledTrips = activeCalendar
        ? group.activeTrips
          .map(({ trip, rows }) => scheduledTripRecord(
            trip,
            rows,
            group.representativeStops,
            progresses,
            patternId,
            activeCalendar.serviceDay,
          ))
          .filter(Boolean)
          .sort((left, right) => left.firstDepartureMinutes - right.firstDepartureMinutes || left.tripId.localeCompare(right.tripId))
        : undefined
      const distanceKm = lineDistanceKm(coordinates)
      // A service_id defines one mutually compatible GTFS calendar. Pooling
      // departures across weekday, Saturday, Sunday, or seasonal calendars
      // creates artificial gaps that never occur on any service day. Pool
      // only the observed within-calendar gaps before taking the median.
      const headwayMinutes = medianServiceHeadwayMinutes(group.departuresByServiceId)
      const firstDepartureSeconds = Number.isFinite(group.firstDepartureSeconds) ? group.firstDepartureSeconds : 0
      const lastArrivalSeconds = Number.isFinite(group.lastArrivalSeconds) ? group.lastArrivalSeconds : firstDepartureSeconds
      const spanHours = Math.max(0, lastArrivalSeconds - firstDepartureSeconds) / 3600
      const averageRuntimeSeconds = group.tripCount ? group.serviceSeconds / group.tripCount : 0
      const route = {
        id: patternId,
        routeId: service.representative_route_id,
        patternId,
        directionId: group.directionId,
        shapeId,
        routeType: numeric(service.route_type, 3),
        shortName: service.short_name || service.long_name || service.representative_route_id,
        longName: routeDisplayLongName(
          service.short_name,
          service.long_name,
          group.representativeStops,
          service.representative_route_id,
        ),
        color: routePreviewColor(service.color, service.representative_route_id),
        tripCount: group.tripCount,
        stopCount: group.representativeStops.length,
        headwayMinutes,
        spanHours: Number(spanHours.toFixed(2)),
        serviceHours: Number((group.serviceSeconds / 3600).toFixed(2)),
        serviceShare: totalTrips > 0 ? group.tripCount / totalTrips : 0,
        frequencyClass: frequencyClass(headwayMinutes),
        patternRank: index + 1,
        serviceVariantCount: orderedGroups.length,
        analysisServiceDate: activeCalendar?.serviceDate,
        geometrySource,
        distanceKm: Number(distanceKm.toFixed(2)),
        scheduledSpeedKph: averageRuntimeSeconds > 0 ? Number((distanceKm / (averageRuntimeSeconds / 3600)).toFixed(1)) : 0,
        firstDepartureMinutes: Number((firstDepartureSeconds / 60).toFixed(3)),
        lastArrivalMinutes: Number((lastArrivalSeconds / 60).toFixed(3)),
        stopPairCount: Math.max(0, group.representativeStops.length - 1),
        segmentCount: Math.max(0, group.representativeStops.length - 1),
        ...(options.includeTripIds ? { tripIds: group.tripIds } : {}),
        status: 'baseline',
        coordinates,
        points: [],
        stopIds: group.representativeStops.map((stop) => stop.id),
        scheduledTrips,
      }
      for (const stop of group.representativeStops) mergeStop(stopMap, stop, patternId, group.tripCount)
      stopPairs.push(...patternStopPairs(
        patternId,
        service.representative_route_id,
        group.directionId,
        group.representativeRows,
        group.representativeStops,
        group.runtimesByPair,
        headwayMinutes,
        group.tripCount,
      ))
      return route
    })
    const stops = finalizedStops(stopMap)

    return {
      schemaVersion: 'vigo.gtfs.route-analysis.v1',
      source: 'sqlite',
      representativeRouteId: service.representative_route_id,
      memberRouteIds: members.map((member) => member.route_id),
      serviceKey: `${numeric(service.route_type, 3)}:${service.service_key}`,
      routes,
      stops,
      stopPairs,
      coverage: {
        rawRouteRows: members.length,
        publicRouteIdentities: 1,
        tripsIndexed: totalTrips,
        stopTimesScanned,
        stopsIndexed: stops.length,
        stopPairsIndexed: stopPairs.length,
        capped: false,
        timetableDeferred: false,
        previewStrategy: 'sqlite-complete-route-analysis-v1',
        tripCountStrategy: 'exact-indexed',
        sourceScope: resolvedSourceScope || undefined,
        routeGeometryIndexed: routes.filter((route) => route.coordinates.length >= 2).length,
        routeGeometryComplete: routes.every((route) => route.coordinates.length >= 2),
        shapeGeometryIndexed: routes.filter((route) => route.geometrySource === 'shape').length,
      },
    }
  } finally {
    db.close()
  }
}
