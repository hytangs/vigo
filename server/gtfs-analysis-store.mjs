import { DatabaseSync } from 'node:sqlite'
import { haversineKm, lineDistanceKm } from './geometry-utils.mjs'
import { numeric } from './number-utils.mjs'
import { routePreviewColor } from './route-color.mjs'
import { routeDisplayLongName } from './route-display.mjs'

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

function sourceScopeBounds(sourceScope) {
  return sourceScope
    ? { lower: `${sourceScope}\u001f`, upper: `${sourceScope}\u001f\uffff` }
    : null
}

function hasRouteIdentityCatalog(db) {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key='routeServiceCatalogVersion'").get()
    return row ? JSON.parse(row.value) === 'vigo.routing.route-services.v2' : false
  } catch {
    return false
  }
}

function serviceRows(db, sourceScope) {
  if (!hasRouteIdentityCatalog(db)) {
    const bounds = sourceScopeBounds(sourceScope)
    return db.prepare(`
      WITH route_trip_counts AS (
        SELECT route_id, COUNT(*) AS trip_count
        FROM trips INDEXED BY trips_route
        GROUP BY route_id
      )
      SELECT
        CASE
          WHEN INSTR(route.route_id, CHAR(31)) > 0
            THEN SUBSTR(route.route_id, 1, INSTR(route.route_id, CHAR(31)) - 1)
          ELSE ''
        END AS source_scope,
        COALESCE(route.route_type, 3) AS route_type,
        CASE
          WHEN INSTR(route.route_id, CHAR(31)) > 0
            THEN SUBSTR(route.route_id, INSTR(route.route_id, CHAR(31)) + 1)
          ELSE route.route_id
        END AS service_key,
        route.route_id AS representative_route_id,
        route.short_name, route.long_name, route.color,
        1 AS variant_count,
        COALESCE(route_trip_counts.trip_count, 0) AS trip_count
      FROM routes AS route
      LEFT JOIN route_trip_counts ON route_trip_counts.route_id=route.route_id
      ${bounds ? 'WHERE route.route_id>=? AND route.route_id<?' : ''}
      ORDER BY route.route_type,
        LOWER(COALESCE(NULLIF(TRIM(route.short_name), ''), NULLIF(TRIM(route.long_name), ''), route.route_id)),
        route.route_id
    `).all(...(bounds ? [bounds.lower, bounds.upper] : []))
  }
  return db.prepare(`
    SELECT source_scope, route_type, service_key, representative_route_id,
      short_name, long_name, color, variant_count, trip_count
    FROM route_services
    ${sourceScope ? 'WHERE source_scope=?' : ''}
    ORDER BY route_type,
      LOWER(COALESCE(NULLIF(TRIM(short_name), ''), NULLIF(TRIM(long_name), ''), representative_route_id)),
      representative_route_id
  `).all(...(sourceScope ? [sourceScope] : []))
}

function tripPathStatements(db) {
  return {
    representativeTrip: db.prepare(`
      SELECT trip.trip_id, trip.direction_id, shape.shape_id
      FROM trips AS trip INDEXED BY trips_route
      LEFT JOIN trip_shapes AS shape ON shape.trip_id=trip.trip_id
      WHERE trip.route_id=?
      ORDER BY CASE WHEN shape.shape_id IS NULL OR shape.shape_id='' THEN 1 ELSE 0 END, trip.trip_id
      LIMIT 1
    `),
    candidateTrips: db.prepare(`
      SELECT trip.trip_id, trip.direction_id, shape.shape_id
      FROM trips AS trip INDEXED BY trips_route
      LEFT JOIN trip_shapes AS shape ON shape.trip_id=trip.trip_id
      WHERE trip.route_id=?
      ORDER BY CASE WHEN shape.shape_id IS NULL OR shape.shape_id='' THEN 1 ELSE 0 END, trip.trip_id
      LIMIT 12
    `),
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
    serviceStats: db.prepare(`
      WITH trip_bounds AS (
        SELECT trip.service_id,
          (
            SELECT connection.departure
            FROM connections AS connection
            WHERE connection.trip_id=trip.trip_id
            ORDER BY connection.stop_sequence
            LIMIT 1
          ) AS first_departure,
          (
            SELECT connection.arrival
            FROM connections AS connection
            WHERE connection.trip_id=trip.trip_id
            ORDER BY connection.stop_sequence DESC
            LIMIT 1
          ) AS last_arrival
        FROM trips AS trip INDEXED BY trips_route
        WHERE trip.route_id=?
      ),
      service_bounds AS (
        SELECT service_id,
          MIN(first_departure) AS first_departure,
          MAX(first_departure) AS last_departure,
          MAX(last_arrival) AS last_arrival,
          SUM(CASE WHEN last_arrival>=first_departure THEN last_arrival-first_departure ELSE 0 END) AS runtime_seconds,
          COUNT(*) AS trip_count
        FROM trip_bounds
        WHERE first_departure IS NOT NULL AND last_arrival IS NOT NULL
        GROUP BY service_id
      )
      SELECT MIN(first_departure) AS first_departure,
        MAX(last_arrival) AS last_arrival,
        SUM(runtime_seconds) AS runtime_seconds,
        SUM(trip_count) AS trip_count,
        SUM(CASE WHEN trip_count>1 THEN last_departure-first_departure ELSE 0 END) AS headway_span_seconds,
        SUM(CASE WHEN trip_count>1 THEN trip_count-1 ELSE 0 END) AS headway_gap_count
      FROM service_bounds
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
  const appendStop = (stop) => {
    if (!stop || stops.at(-1)?.id === stop.id) return
    stops.push(stop)
  }
  for (const row of connectionRows) {
    appendStop(stopRecord(row, 'from'))
    appendStop(stopRecord(row, 'to'))
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

export function readGtfsNetworkOverview(storePath, options = {}) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const sourceScope = String(options.sourceScope || '').trim()
    const services = serviceRows(db, sourceScope)
    const statements = tripPathStatements(db)
    const shapeCache = new Map()
    const stopMap = new Map()
    const routes = []
    const totalTripCount = services.reduce((sum, service) => sum + numeric(service.trip_count), 0)
    let geometryCount = 0
    let shapeGeometryCount = 0
    let stopTimesScanned = 0

    for (const service of services) {
      let trip = statements.representativeTrip.get(service.representative_route_id)
      if (!trip) {
        for (const member of memberRoutes(db, service, sourceScope)) {
          trip = statements.representativeTrip.get(member.route_id)
          if (trip) break
        }
      }
      if (!trip) continue
      let connectionRows = statements.connections.all(trip.trip_id)
      let pathStops = tripPath(connectionRows)
      if (pathStops.length < 2) {
        const candidateRouteIds = [service.representative_route_id, ...memberRoutes(db, service, sourceScope).map((member) => member.route_id)]
        let recovered = false
        for (const candidateRouteId of new Set(candidateRouteIds)) {
          for (const candidate of statements.candidateTrips.all(candidateRouteId)) {
            if (candidate.trip_id === trip.trip_id) continue
            const candidateRows = statements.connections.all(candidate.trip_id)
            const candidateStops = tripPath(candidateRows)
            if (candidateStops.length < 2) continue
            trip = candidate
            connectionRows = candidateRows
            pathStops = candidateStops
            recovered = true
            break
          }
          if (recovered) break
        }
      }
      stopTimesScanned += connectionRows.length
      const stopCoordinates = pathStops.map((stop) => [stop.lon, stop.lat])
      let coordinates = stopCoordinates
      let geometrySource = 'stop_sequence'
      let shapeId
      if (trip.shape_id) {
        if (!shapeCache.has(trip.shape_id)) {
          shapeCache.set(trip.shape_id, statements.shapePoints.all(trip.shape_id)
            .map((point) => [numeric(point.lon, NaN), numeric(point.lat, NaN)])
            .filter(validCoordinate))
        }
        const shapeCoordinates = shapeCache.get(trip.shape_id)
        if (shapeCoordinates?.length >= 2) {
          coordinates = shapeCoordinates
          geometrySource = 'shape'
          shapeId = trip.shape_id
          shapeGeometryCount += 1
        }
      }
      // Published shapes are source evidence, not a visualization hint. Keep
      // every valid GTFS point in its original sequence. A stop sequence has
      // no source polyline and remains explicitly marked as inferred.
      coordinates = coordinates.filter(validCoordinate)
      if (coordinates.length >= 2) geometryCount += 1
      const serviceStats = statements.serviceStats.get(service.representative_route_id)
      const representativeFirstDepartureSeconds = numeric(connectionRows[0]?.departure, NaN)
      const representativeLastArrivalSeconds = numeric(connectionRows.at(-1)?.arrival, NaN)
      const firstDepartureSeconds = numeric(serviceStats?.first_departure, representativeFirstDepartureSeconds)
      const lastArrivalSeconds = numeric(serviceStats?.last_arrival, representativeLastArrivalSeconds)
      const scheduledTripCount = Math.max(1, numeric(serviceStats?.trip_count, service.trip_count))
      const serviceRuntimeSeconds = Math.max(0, numeric(serviceStats?.runtime_seconds))
      const averageRuntimeSeconds = serviceRuntimeSeconds > 0
        ? serviceRuntimeSeconds / scheduledTripCount
        : Math.max(0, representativeLastArrivalSeconds - representativeFirstDepartureSeconds)
      const headwayGapCount = Math.max(0, numeric(serviceStats?.headway_gap_count))
      const headwayMinutes = headwayGapCount > 0
        ? Math.max(1, Math.round(numeric(serviceStats?.headway_span_seconds) / headwayGapCount / 60))
        : 0
      const spanHours = Number.isFinite(firstDepartureSeconds) && Number.isFinite(lastArrivalSeconds)
        ? Math.max(0, lastArrivalSeconds - firstDepartureSeconds) / 3600
        : 0
      const distanceKm = lineDistanceKm(coordinates)
      const route = {
        id: service.representative_route_id,
        routeId: service.representative_route_id,
        patternId: service.representative_route_id,
        directionId: trip.direction_id ?? undefined,
        shapeId,
        routeType: numeric(service.route_type, 3),
        shortName: service.short_name || service.long_name || service.representative_route_id,
        longName: routeDisplayLongName(
          service.short_name,
          service.long_name,
          pathStops,
          service.representative_route_id,
        ),
        color: routePreviewColor(service.color, service.representative_route_id),
        tripCount: numeric(service.trip_count),
        stopCount: pathStops.length,
        headwayMinutes,
        spanHours: Number(spanHours.toFixed(2)),
        serviceHours: Number((serviceRuntimeSeconds / 3600).toFixed(2)),
        serviceShare: totalTripCount > 0 ? numeric(service.trip_count) / totalTripCount : 0,
        frequencyClass: frequencyClass(headwayMinutes),
        patternRank: routes.length + 1,
        serviceVariantCount: Math.max(1, numeric(service.variant_count, 1)),
        geometrySource,
        distanceKm: Number(distanceKm.toFixed(2)),
        scheduledSpeedKph: averageRuntimeSeconds > 0 ? Number((distanceKm / (averageRuntimeSeconds / 3600)).toFixed(1)) : 0,
        firstDepartureMinutes: Number.isFinite(firstDepartureSeconds) ? Number((firstDepartureSeconds / 60).toFixed(3)) : undefined,
        lastArrivalMinutes: Number.isFinite(lastArrivalSeconds) ? Number((lastArrivalSeconds / 60).toFixed(3)) : undefined,
        stopPairCount: Math.max(0, pathStops.length - 1),
        segmentCount: Math.max(0, pathStops.length - 1),
        status: 'baseline',
        coordinates,
        points: [],
        stopIds: pathStops.map((stop) => stop.id),
      }
      routes.push(route)
      for (const stop of pathStops) mergeStop(stopMap, stop, route.id, route.tripCount)
    }

    const stops = finalizedStops(stopMap)
    return {
      routes,
      stops,
      stopPairs: [],
      coverage: {
        rawRouteRows: services.length,
        publicRouteIdentities: routes.length,
        tripsIndexed: routes.reduce((sum, route) => sum + route.tripCount, 0),
        stopTimesScanned,
        stopsIndexed: stops.length,
        stopPairsIndexed: 0,
        capped: false,
        timetableDeferred: false,
        previewStrategy: 'sqlite-complete-service-atlas-v1',
        tripCountStrategy: 'route-identity-catalog',
        sourceScope: sourceScope || undefined,
        routeGeometryIndexed: geometryCount,
        routeGeometryComplete: geometryCount === routes.length,
        shapeGeometryIndexed: shapeGeometryCount,
      },
    }
  } finally {
    db.close()
  }
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
        const signature = `${trip.direction_id ?? ''}\u001e${stopIds.join('\u001f')}`
        const group = groups.get(signature) ?? {
          signature,
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
        : `${service.representative_route_id}--pattern-${index + 1}-${patternToken(group.signature)}`
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
