import { storeSchemaVersion } from './store-metadata.mjs'

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { haversineKm } from '../geometry-utils.mjs'
import { routeDisplayLongName, routePreviewColor } from '../route-presentation.mjs'

const nationalPreviewRouteLimit = 500

const nationalRouteCatalogLimit = 10_000

const nationalPreviewStopLimit = 12_000

const nationalPreviewConnectionsPerRoute = 96

function emptyNationalPreview(routeCount, stopCount) {
  return {
    routes: [],
    stops: [],
    stopPairs: [],
    coverage: {
      rawRouteRows: routeCount,
      publicRouteIdentities: routeCount,
      tripsIndexed: 0,
      stopTimesScanned: 0,
      stopsIndexed: 0,
      stopPairsIndexed: 0,
      capped: routeCount > 0 || stopCount > 0,
      timetableDeferred: false,
      previewStrategy: 'sqlite-spatial-stop-sequence-v1',
      tripCountStrategy: 'none',
    },
  }
}

function routeCatalogRows(db, { sourceScope = '', routeLimit, orderByTrips = false }) {
  const catalogLabelOrder = `route_type,
    LOWER(COALESCE(NULLIF(TRIM(short_name), ''), NULLIF(TRIM(long_name), ''), route_id)),
    route_id`
  return db.prepare(`
    SELECT representative_route_id AS route_id, short_name, long_name,
      route_type, color, variant_count, trip_count
    FROM route_services
    ${sourceScope ? 'WHERE source_scope=?' : ''}
    ORDER BY ${orderByTrips ? `trip_count DESC, ${catalogLabelOrder}` : catalogLabelOrder}
    LIMIT ?
  `).all(...(sourceScope ? [sourceScope, routeLimit] : [routeLimit]))
}

export function readNationalGtfsRouteCatalog(storePath, options = {}) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const routeLimit = Math.max(1, Math.min(nationalRouteCatalogLimit, Number(options.routeLimit) || nationalRouteCatalogLimit))
    const sourceScope = String(options.sourceScope || '').trim()
    const catalogRows = routeCatalogRows(db, { sourceScope, routeLimit })
    return catalogRows.map((route, index) => ({
      id: route.route_id,
      routeId: route.route_id,
      patternId: route.route_id,
      routeType: Number(route.route_type ?? 3),
      shortName: route.short_name || route.long_name || route.route_id,
      longName: route.long_name || route.route_id,
      color: routePreviewColor(route.color, route.route_id),
      tripCount: Number(route.trip_count) || 0,
      serviceVariantCount: Number(route.variant_count) || 1,
      stopCount: 0,
      headwayMinutes: 0,
      spanHours: 0,
      serviceHours: 0,
      serviceShare: 0,
      frequencyClass: 'low',
      patternRank: index + 1,
      geometrySource: 'stop_sequence',
      status: 'baseline',
      coordinates: [],
      points: [],
      stopIds: [],
    }))
  } finally {
    db.close()
  }
}

export function readNationalGtfsPreview(storePath, options = {}) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const metadata = Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map((row) => [row.key, JSON.parse(row.value)]))
    const routeCount = Number(options.routeCount ?? metadata.routeCount ?? 0)
    const stopCount = Number(options.stopCount ?? metadata.stopCount ?? 0)
    const tripCount = Number(options.tripCount ?? metadata.tripCount ?? 0)
    const routeLimit = Math.max(1, Math.min(nationalPreviewRouteLimit, Number(options.routeLimit) || nationalPreviewRouteLimit))
    const sourceScope = String(options.sourceScope || '').trim()
    const representativeTrips = new Map()
    const requestedRepresentativeRouteIds = Array.isArray(options.representativeRouteIds)
      ? [...new Set(options.representativeRouteIds.map((routeId) => String(routeId ?? '')).filter(Boolean))].slice(0, routeLimit)
      : []
    const serviceRoutes = requestedRepresentativeRouteIds.length
      ? requestedRepresentativeRouteIds.map((routeId) => ({ route_id: routeId }))
      : routeCatalogRows(db, { sourceScope, routeLimit, orderByTrips: true })
    if (serviceRoutes.length) {
      const serviceRouteIds = serviceRoutes.map((route) => route.route_id)
      const serviceRoutePlaceholders = serviceRouteIds.map(() => '?').join(',')
      const serviceTripRows = db.prepare(`
        SELECT route_id, MIN(trip_id) AS trip_id, COUNT(*) AS sampled_trip_count
        FROM trips INDEXED BY trips_route
        WHERE route_id IN (${serviceRoutePlaceholders})
        GROUP BY route_id
      `).all(...serviceRouteIds)
      for (const candidate of serviceTripRows) {
        representativeTrips.set(candidate.route_id, {
          tripId: candidate.trip_id,
          sampledTripCount: Math.max(1, Number(candidate.sampled_trip_count) || 1),
        })
      }
    }
    if (!representativeTrips.size) return emptyNationalPreview(routeCount, stopCount)

    const routeIds = [...representativeTrips.keys()]
    const placeholders = routeIds.map(() => '?').join(',')
    const routeMetadata = new Map(db.prepare(`
      SELECT route_id, short_name, long_name, route_type, color
      FROM routes
      WHERE route_id IN (${placeholders})
    `).all(...routeIds).map((route) => [route.route_id, route]))
    const tripCountStrategy = 'exact-indexed'
    const routeTripCounts = new Map(db.prepare(`
      SELECT route_id, COUNT(*) AS trip_count
      FROM trips INDEXED BY trips_route
      WHERE route_id IN (${placeholders})
      GROUP BY route_id
    `).all(...routeIds).map((route) => [route.route_id, Number(route.trip_count)]))
    const representativeConnections = db.prepare(`
      SELECT c.departure, c.arrival, c.direction_id, c.stop_sequence,
        source.stop_id AS from_stop_id, source.name AS from_name, source.lat AS from_lat, source.lon AS from_lon,
        source.parent_station AS from_parent_station, source.location_type AS from_location_type, source.platform_code AS from_platform_code,
        target.stop_id AS to_stop_id, target.name AS to_name, target.lat AS to_lat, target.lon AS to_lon,
        target.parent_station AS to_parent_station, target.location_type AS to_location_type, target.platform_code AS to_platform_code
      FROM connections c
      JOIN stops source ON source.stop_id=c.from_stop_id
      JOIN stops target ON target.stop_id=c.to_stop_id
      WHERE c.trip_id=?
        AND source.lat BETWEEN -90 AND 90 AND source.lon BETWEEN -180 AND 180
        AND target.lat BETWEEN -90 AND 90 AND target.lon BETWEEN -180 AND 180
      ORDER BY c.stop_sequence, c.from_stop_id, c.to_stop_id
      LIMIT ?
    `)

    const routeSeeds = []
    let stopTimesScanned = 0
    let truncatedTrips = 0
    for (const [routeId, representative] of representativeTrips) {
      const rows = representativeConnections.all(representative.tripId, nationalPreviewConnectionsPerRoute)
      stopTimesScanned += rows.length
      if (rows.length === nationalPreviewConnectionsPerRoute) truncatedTrips += 1
      const pathStops = []
      const appendStop = (record) => {
        const longitude = Number(record.lon)
        const latitude = Number(record.lat)
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return
        if (pathStops.at(-1)?.id === record.id) return
        pathStops.push({ ...record, lon: longitude, lat: latitude })
      }
      for (const row of rows) {
        appendStop({
          id: row.from_stop_id, name: row.from_name || row.from_stop_id, lat: row.from_lat, lon: row.from_lon,
          parentStationId: row.from_parent_station || undefined, locationType: row.from_location_type ?? 0, platformCode: row.from_platform_code || undefined,
        })
        appendStop({
          id: row.to_stop_id, name: row.to_name || row.to_stop_id, lat: row.to_lat, lon: row.to_lon,
          parentStationId: row.to_parent_station || undefined, locationType: row.to_location_type ?? 0, platformCode: row.to_platform_code || undefined,
        })
      }
      const coordinates = pathStops.map((stop) => [stop.lon, stop.lat])
      const hasDistinctCoordinate = coordinates.slice(1).some((coordinate) => coordinate[0] !== coordinates[0]?.[0] || coordinate[1] !== coordinates[0]?.[1])
      const exactTripCount = routeTripCounts.get(routeId) ?? 0
      if (coordinates.length < 2 || !hasDistinctCoordinate || exactTripCount < 1) continue
      const metadataRow = routeMetadata.get(routeId) ?? {}
      const firstDepartureSeconds = Number(rows[0]?.departure)
      const lastArrivalSeconds = Number(rows.at(-1)?.arrival)
      const runtimeSeconds = Number.isFinite(firstDepartureSeconds) && Number.isFinite(lastArrivalSeconds)
        ? Math.max(0, lastArrivalSeconds - firstDepartureSeconds)
        : 0
      let distanceKm = 0
      for (let index = 1; index < coordinates.length; index += 1) distanceKm += haversineKm(coordinates[index - 1], coordinates[index])
      routeSeeds.push({
        id: routeId,
        routeId,
        patternId: routeId,
        directionId: rows[0]?.direction_id ?? undefined,
        routeType: Number(metadataRow.route_type ?? 3),
        shortName: metadataRow.short_name || metadataRow.long_name || routeId,
        longName: routeDisplayLongName(
          metadataRow.short_name,
          metadataRow.long_name,
          pathStops,
          routeId,
        ),
        color: routePreviewColor(metadataRow.color, routeId),
        tripCount: exactTripCount,
        stopCount: pathStops.length,
        headwayMinutes: 0,
        spanHours: 0,
        serviceHours: 0,
        serviceShare: tripCount > 0 ? exactTripCount / tripCount : 0,
        frequencyClass: 'low',
        geometrySource: 'stop_sequence',
        distanceKm: Number(distanceKm.toFixed(2)),
        scheduledSpeedKph: runtimeSeconds > 0 ? Number((distanceKm / (runtimeSeconds / 3600)).toFixed(1)) : 0,
        firstDepartureMinutes: Number.isFinite(firstDepartureSeconds) ? Number((firstDepartureSeconds / 60).toFixed(3)) : undefined,
        lastArrivalMinutes: Number.isFinite(lastArrivalSeconds) ? Number((lastArrivalSeconds / 60).toFixed(3)) : undefined,
        stopPairCount: Math.max(0, pathStops.length - 1),
        segmentCount: Math.max(0, pathStops.length - 1),
        status: 'baseline',
        coordinates,
        points: [],
        stopIds: pathStops.map((stop) => stop.id),
        pathStops,
      })
    }

    routeSeeds.sort((left, right) => right.tripCount - left.tripCount || left.routeId.localeCompare(right.routeId))
    const highestTripCount = routeSeeds[0]?.tripCount ?? 0
    const stopMap = new Map()
    const routes = []
    for (const seed of routeSeeds) {
      const newStopCount = new Set(seed.pathStops.filter((stop) => !stopMap.has(stop.id)).map((stop) => stop.id)).size
      if (stopMap.size + newStopCount > nationalPreviewStopLimit) continue
      const { pathStops, ...route } = seed
      route.patternRank = routes.length + 1
      route.frequencyClass = highestTripCount > 0 && route.tripCount / highestTripCount >= 0.5
        ? 'high'
        : highestTripCount > 0 && route.tripCount / highestTripCount >= 0.2 ? 'medium' : 'low'
      routes.push(route)
      for (const pathStop of pathStops) {
        const stop = stopMap.get(pathStop.id) ?? {
          ...pathStop,
          x: 0,
          y: 0,
          routes: [],
          tripCount: 0,
          transferScore: 0,
        }
        if (!stop.routes.includes(route.id)) {
          stop.routes.push(route.id)
          stop.tripCount += route.tripCount
        }
        stopMap.set(stop.id, stop)
      }
    }
    const stops = [...stopMap.values()]
      .map((stop) => ({
        ...stop,
        transferScore: Math.min(100, stop.routes.length * 24 + Math.log10(Math.max(1, stop.tripCount)) * 18),
      }))
      .sort((left, right) => right.transferScore - left.transferScore || right.tripCount - left.tripCount || left.id.localeCompare(right.id))
    const indexedTrips = routes.reduce((sum, route) => sum + route.tripCount, 0)

    return {
      routes,
      stops,
      stopPairs: [],
      coverage: {
        rawRouteRows: routeCount,
        publicRouteIdentities: routeCount,
        tripsIndexed: indexedTrips,
        stopTimesScanned,
        stopsIndexed: stops.length,
        stopPairsIndexed: 0,
        capped: routes.length < routeCount || stops.length < stopCount || truncatedTrips > 0,
        timetableDeferred: false,
        previewStrategy: 'sqlite-spatial-stop-sequence-v1',
        tripCountStrategy,
        sourceScope: sourceScope || undefined,
        routeLimit,
        connectionsPerRouteLimit: nationalPreviewConnectionsPerRoute,
      },
    }
  } finally {
    db.close()
  }
}

export function nationalFeedSummary(storePath, importResult, feedId) {
  const mapPreview = readNationalGtfsPreview(storePath, importResult)
  const previewByRoute = new Map(mapPreview.routes.map((route) => [route.routeId || route.id, route]))
  const routes = readNationalGtfsRouteCatalog(storePath, importResult).map((route) => {
    const previewRoute = previewByRoute.get(route.routeId)
    return previewRoute
      ? { ...route, ...previewRoute, tripCount: route.tripCount, serviceVariantCount: route.serviceVariantCount }
      : route
  })
  const stops = mapPreview.stops
  const blockingRoutingFeatures = importResult.blockingRoutingFeatures ?? []
  const routingLimitations = importResult.routingLimitations ?? []
  return {
    id: feedId,
    name: path.basename(importResult.sourceFile).replace(/\.zip$/i, '') || 'National GTFS',
    provider: 'Local GTFS', versionLabel: importResult.builtAt.slice(0, 10), importedAt: importResult.builtAt,
    source: 'local-file', fileName: importResult.sourceFile, fileSize: importResult.sourceBytes, hash: importResult.storeId,
    qualityScore: 100, routeCount: importResult.routeCount, stopCount: importResult.stopCount, tripCount: importResult.tripCount,
    transferCandidates: importResult.transferCount, requiredTables: { 'agency.txt': true, 'stops.txt': true, 'routes.txt': true, 'trips.txt': true, 'stop_times.txt': true },
    optionalTables: { 'calendar.txt': true, 'calendar_dates.txt': importResult.calendarDateCount > 0, 'transfers.txt': importResult.transferCount > 0, 'frequencies.txt': importResult.frequencyCount > 0, 'pathways.txt': Number(importResult.featureInventory?.pathwayCount ?? 0) > 0 },
    tableProfiles: (importResult.tableProfiles ?? []).map((profile) => ({ ...profile, role: ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'].includes(profile.name) ? 'required' : 'optional', fieldCount: profile.fields.length, issueCount: 0 })),
    warnings: [
      ...blockingRoutingFeatures.map((feature) => ({
        id: `routing-${feature.code}`,
        severity: 'error',
        table: 'routing',
        message: feature.detail,
        rows: [],
      })),
      ...routingLimitations.map((feature) => ({
        id: `routing-${feature.code}`,
        severity: 'warning',
        table: 'routing',
        message: feature.detail,
        rows: [],
      })),
    ], routeMetrics: routes, stopMetrics: stops, mapPreview,
    routingStore: {
      schemaVersion: storeSchemaVersion,
      status: 'ready',
      routingEligibility: blockingRoutingFeatures.length ? 'unsupported' : routingLimitations.length ? 'qualified' : 'exact',
      fileName: path.basename(storePath),
      bytes: importResult.bytes,
      connectionCount: importResult.connectionCount,
      builtAt: importResult.builtAt,
      sourceFingerprint: importResult.sourceFingerprint,
      blockingRoutingFeatures,
      routingLimitations,
    },
  }
}
