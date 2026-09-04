import { DatabaseSync } from 'node:sqlite'
import { haversineKm } from './geometry-utils.mjs'
import { readGtfsRouteAnalysis } from './gtfs-analysis-store.mjs'
import { readNationalOsmDriveGeometry } from './national-osm-store.mjs'
import { numeric } from './number-utils.mjs'

const schemaVersion = 'vigo.service-edge-decomposition.v1'
const defaultMatchDistanceM = 65
const defaultSampleSpacingM = 35
const defaultMaxPatterns = 2_000
const defaultMaxFeatures = 100_000

function coordinate(value) {
  if (!Array.isArray(value) || value.length !== 2) return null
  const longitude = numeric(value[0], NaN)
  const latitude = numeric(value[1], NaN)
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= -180 && longitude <= 180
    && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null
}

function pointSegmentDistanceM(point, start, end) {
  const latitudeScale = 111_320
  const longitudeScale = 111_320 * Math.cos((point[1] * Math.PI) / 180)
  const px = point[0] * longitudeScale
  const py = point[1] * latitudeScale
  const ax = start[0] * longitudeScale
  const ay = start[1] * latitudeScale
  const bx = end[0] * longitudeScale
  const by = end[1] * latitudeScale
  const dx = bx - ax
  const dy = by - ay
  const denominator = dx * dx + dy * dy
  const progress = denominator > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator))
    : 0
  const closest = [
    start[0] + (end[0] - start[0]) * progress,
    start[1] + (end[1] - start[1]) * progress,
  ]
  return {
    distanceM: haversineKm(point, closest) * 1_000,
    progress,
  }
}

function bearingDegrees(start, end) {
  const longitude = (end[0] - start[0]) * Math.cos((start[1] * Math.PI) / 180)
  const latitude = end[1] - start[1]
  return Math.atan2(longitude, latitude) * 180 / Math.PI
}

function directionAlignment(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0
  const difference = Math.abs(((left - right + 540) % 360) - 180)
  return Math.cos((difference * Math.PI) / 180)
}

function edgeKey(row) {
  if (row.edgeIndex !== undefined && row.edgeIndex !== null) return `snapshot:${row.edgeIndex}`
  return `${row.wayId}/${row.fromNode}/${row.toNode}`
}

function edgeGeometry(row) {
  return [[row.fromLon, row.fromLat], [row.toLon, row.toLat]]
}

function sampleShape(points, spacingM) {
  const samples = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    const distanceM = haversineKm(start, end) * 1_000
    if (!Number.isFinite(distanceM) || distanceM <= 0) continue
    const steps = Math.max(1, Math.ceil(distanceM / spacingM))
    const heading = bearingDegrees(start, end)
    for (let step = 0; step < steps; step += 1) {
      const progress = step / steps
      samples.push({
        coordinate: [
          start[0] + (end[0] - start[0]) * progress,
          start[1] + (end[1] - start[1]) * progress,
        ],
        heading,
      })
    }
  }
  const last = points.at(-1)
  if (last) samples.push({ coordinate: last, heading: samples.at(-1)?.heading ?? NaN })
  return samples
}

function bboxForPatterns(patterns, marginM) {
  const coordinates = patterns.flatMap((pattern) => pattern.geometry)
  if (!coordinates.length) return null
  const centerLat = coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length
  const latMargin = marginM / 111_320
  const lonMargin = marginM / Math.max(1, 111_320 * Math.cos((centerLat * Math.PI) / 180))
  return {
    west: Math.max(-180, Math.min(...coordinates.map((point) => point[0])) - lonMargin),
    south: Math.max(-90, Math.min(...coordinates.map((point) => point[1])) - latMargin),
    east: Math.min(180, Math.max(...coordinates.map((point) => point[0])) + lonMargin),
    north: Math.min(90, Math.max(...coordinates.map((point) => point[1])) + latMargin),
  }
}

function routeIdsForStore(storePath, requestedRouteIds, sourceScope = '') {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const requested = new Set((Array.isArray(requestedRouteIds) ? requestedRouteIds : [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean))
    if (requested.size) {
      return [...db.prepare(`
        SELECT route_id
        FROM routes
        WHERE route_id IN (${[...requested].map(() => '?').join(',')})
          AND CAST(COALESCE(route_type, 3) AS INTEGER)=3
        ORDER BY route_id
      `).iterate(...requested)]
        .map((row) => String(row.route_id))
        .filter((routeId) => !sourceScope || routeId.startsWith(`${sourceScope}\u001f`))
    }
    return [...db.prepare(`
      SELECT route_id
      FROM routes
      WHERE CAST(COALESCE(route_type, 3) AS INTEGER)=3
      ORDER BY route_id
    `).iterate()]
      .map((row) => String(row.route_id))
      .filter((routeId) => !sourceScope || routeId.startsWith(`${sourceScope}\u001f`))
  } finally {
    db.close()
  }
}

function readPatterns(storePath, requestedRouteIds, sourceScope, maxPatterns) {
  const routeIds = routeIdsForStore(storePath, requestedRouteIds, sourceScope)
  const patterns = []
  const skipped = { noShape: 0, invalidShape: 0 }
  for (const routeId of routeIds) {
    if (patterns.length >= maxPatterns) break
    const analysis = readGtfsRouteAnalysis(storePath, routeId, {
      includeTripIds: true,
      sourceScope,
    })
    const pairsByPattern = new Map()
    for (const pair of analysis?.stopPairs ?? []) {
      const list = pairsByPattern.get(pair.patternId) ?? []
      list.push(pair)
      pairsByPattern.set(pair.patternId, list)
    }
    for (const route of analysis?.routes ?? []) {
      if (patterns.length >= maxPatterns) break
      const geometry = (route.coordinates ?? []).map(coordinate).filter(Boolean)
      if (route.geometrySource !== 'shape') {
        skipped.noShape += 1
        continue
      }
      if (geometry.length < 2) {
        skipped.invalidShape += 1
        continue
      }
      patterns.push({
        patternId: String(route.patternId ?? route.id),
        routeId: String(route.routeId ?? routeId),
        shortName: String(route.shortName ?? route.routeId ?? routeId),
        directionId: route.directionId === undefined ? '' : String(route.directionId),
        tripCount: Math.max(0, Math.round(numeric(route.tripCount))),
        headwayMinutes: Math.max(0, numeric(route.headwayMinutes)),
        geometry,
        stopPairs: pairsByPattern.get(route.patternId ?? route.id) ?? [],
      })
    }
  }
  return { patterns, routesConsidered: routeIds.length, skipped }
}

function makeEdgeIndex(rows, cellDegrees = 0.001) {
  const cells = new Map()
  const add = (cell, edge) => cells.set(cell, [...(cells.get(cell) ?? []), edge])
  for (const edge of rows) {
    const minLon = Math.floor(Math.min(edge.fromLon, edge.toLon) / cellDegrees)
    const maxLon = Math.floor(Math.max(edge.fromLon, edge.toLon) / cellDegrees)
    const minLat = Math.floor(Math.min(edge.fromLat, edge.toLat) / cellDegrees)
    const maxLat = Math.floor(Math.max(edge.fromLat, edge.toLat) / cellDegrees)
    for (let lon = minLon; lon <= maxLon; lon += 1) {
      for (let lat = minLat; lat <= maxLat; lat += 1) add(`${lon}:${lat}`, edge)
    }
  }
  return {
    cellDegrees,
    candidates(point) {
      const lon = Math.floor(point[0] / cellDegrees)
      const lat = Math.floor(point[1] / cellDegrees)
      const result = []
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          result.push(...(cells.get(`${lon + dx}:${lat + dy}`) ?? []))
        }
      }
      return result
    },
  }
}

function matchPattern(pattern, edgeIndex, options) {
  const samples = sampleShape(pattern.geometry, options.sampleSpacingM)
  const matchedEdges = new Map()
  let previous = null
  let matchedSamples = 0
  let unmatchedSamples = 0
  let maxDistanceM = 0
  let gapCount = 0
  for (const sample of samples) {
    const candidates = edgeIndex.candidates(sample.coordinate)
    let best = null
    for (const edge of candidates) {
      const projection = pointSegmentDistanceM(
        sample.coordinate,
        [edge.fromLon, edge.fromLat],
        [edge.toLon, edge.toLat],
      )
      if (projection.distanceM > options.matchDistanceM) continue
      const alignment = directionAlignment(
        sample.heading,
        bearingDegrees([edge.fromLon, edge.fromLat], [edge.toLon, edge.toLat]),
      )
      const edgeId = edgeKey(edge)
      const continuityBonus = previous && (
        edgeId === previous.edgeId
        || edge.fromNode === previous.toNode
      ) ? -18 : 0
      const score = projection.distanceM + (1 - alignment) * 8 + continuityBonus
      if (!best || score < best.score) best = { edge, edgeId, score, distanceM: projection.distanceM }
    }
    if (!best) {
      unmatchedSamples += 1
      if (previous) gapCount += 1
      previous = null
      continue
    }
    matchedSamples += 1
    maxDistanceM = Math.max(maxDistanceM, best.distanceM)
    matchedEdges.set(best.edgeId, best.edge)
    previous = best
  }
  const coverage = samples.length ? matchedSamples / samples.length : 0
  const status = coverage >= 0.85 && maxDistanceM <= options.matchDistanceM
    ? 'matched'
    : coverage >= 0.5
      ? 'partial'
      : 'unmatched'
  return {
    ...pattern,
    edgeIds: [...matchedEdges.keys()],
    edges: [...matchedEdges.values()],
    sampleCount: samples.length,
    matchedSamples,
    unmatchedSamples,
    coverage,
    maxDistanceM,
    gapCount,
    status,
  }
}

function emptySide() {
  return { tripCount: 0, patternCount: 0, routeNames: new Set(), routeIds: new Set() }
}

function addToSide(side, pattern) {
  side.tripCount += pattern.tripCount
  side.patternCount += 1
  side.routeNames.add(pattern.shortName)
  side.routeIds.add(pattern.routeId)
}

function sideProperties(side) {
  if (!side) return {
    tripCount: 0,
    patternCount: 0,
    routeNames: [],
    routeIds: [],
  }
  return {
    tripCount: side.tripCount,
    patternCount: side.patternCount,
    routeNames: [...side.routeNames].slice(0, 16),
    routeIds: [...side.routeIds].slice(0, 16),
  }
}

function aggregatePatterns(patterns, edgeMap, side) {
  const diagnostics = { matched: 0, partial: 0, unmatched: 0, noEdges: 0 }
  for (const pattern of patterns) {
    if (pattern.status === 'matched') diagnostics.matched += 1
    else if (pattern.status === 'partial') diagnostics.partial += 1
    else diagnostics.unmatched += 1
    if (!pattern.edgeIds.length || pattern.status !== 'matched') {
      diagnostics.noEdges += 1
      continue
    }
    for (const edgeId of pattern.edgeIds) {
      const edge = pattern.edges.find((candidate) => edgeKey(candidate) === edgeId)
      if (!edge) continue
      const entry = edgeMap.get(edgeId) ?? {
        ...edge,
        edgeId,
        baseline: null,
        comparison: null,
      }
      entry[side] ??= emptySide()
      addToSide(entry[side], pattern)
      edgeMap.set(edgeId, entry)
    }
  }
  return diagnostics
}

export function buildServiceEdgeDecomposition({
  baselineStorePath,
  comparisonStorePath,
  streetStorePath,
  baselineSourceScope,
  comparisonSourceScope,
  baselineRouteIds,
  comparisonRouteIds,
  matchDistanceM = defaultMatchDistanceM,
  sampleSpacingM = defaultSampleSpacingM,
  maxPatterns = defaultMaxPatterns,
  maxFeatures = defaultMaxFeatures,
} = {}) {
  if (!baselineStorePath || !comparisonStorePath || !streetStorePath) {
    throw new Error('Service edge decomposition requires two GTFS stores and one OSM street store.')
  }
  const options = {
    matchDistanceM: Math.max(10, Math.min(150, numeric(matchDistanceM, defaultMatchDistanceM))),
    sampleSpacingM: Math.max(10, Math.min(100, numeric(sampleSpacingM, defaultSampleSpacingM))),
    maxPatterns: Math.max(1, Math.min(10_000, Math.floor(numeric(maxPatterns, defaultMaxPatterns)))),
    maxFeatures: Math.max(1, Math.min(250_000, Math.floor(numeric(maxFeatures, defaultMaxFeatures)))),
  }
  const baselineRead = readPatterns(
    baselineStorePath,
    baselineRouteIds,
    baselineSourceScope,
    options.maxPatterns,
  )
  const comparisonRead = readPatterns(
    comparisonStorePath,
    comparisonRouteIds,
    comparisonSourceScope,
    options.maxPatterns,
  )
  const shapedPatterns = [...baselineRead.patterns, ...comparisonRead.patterns]
  const bounds = bboxForPatterns(shapedPatterns, options.matchDistanceM)
  if (!bounds) {
    return {
      schemaVersion,
      representation: 'directed_osm_drive_edge',
      featureCollection: { type: 'FeatureCollection', features: [] },
      diagnostics: {
        ...options,
        patterns: { baseline: 0, comparison: 0 },
        skipped: { baseline: baselineRead.skipped, comparison: comparisonRead.skipped },
        reason: 'no_gtfs_shape_geometry',
      },
    }
  }
  const drive = readNationalOsmDriveGeometry(streetStorePath, bounds)
  const edgeIndex = makeEdgeIndex(drive.rows)
  const baselineMatched = baselineRead.patterns.map((pattern) => matchPattern(pattern, edgeIndex, options))
  const comparisonMatched = comparisonRead.patterns.map((pattern) => matchPattern(pattern, edgeIndex, options))
  const edgeMap = new Map()
  const baselineDiagnostics = aggregatePatterns(baselineMatched, edgeMap, 'baseline')
  const comparisonDiagnostics = aggregatePatterns(comparisonMatched, edgeMap, 'comparison')
  let entries = [...edgeMap.values()].map((entry) => {
    const base = sideProperties(entry.baseline)
    const comparison = sideProperties(entry.comparison)
    const serviceIndicator = entry.baseline && entry.comparison ? 2 : entry.baseline ? 0 : 1
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: edgeGeometry(entry) },
      properties: {
        edgeId: entry.edgeId,
        wayId: entry.wayId,
        fromNode: entry.fromNode,
        toNode: entry.toNode,
        roadClass: entry.roadClass,
        serviceIndicator,
        baseTripCount: base.tripCount,
        comparisonTripCount: comparison.tripCount,
        tripDelta: comparison.tripCount - base.tripCount,
        basePatternCount: base.patternCount,
        comparisonPatternCount: comparison.patternCount,
        baseRouteNames: base.routeNames.join(', '),
        comparisonRouteNames: comparison.routeNames.join(', '),
      },
    }
  })
  const truncated = entries.length > options.maxFeatures
  if (truncated) {
    entries = entries
      .sort((left, right) => (
        Math.abs(right.properties.tripDelta) - Math.abs(left.properties.tripDelta)
        || right.properties.serviceIndicator - left.properties.serviceIndicator
        || left.properties.edgeId.localeCompare(right.properties.edgeId)
      ))
      .slice(0, options.maxFeatures)
  }
  return {
    schemaVersion,
    representation: 'directed_osm_drive_edge',
    featureCollection: { type: 'FeatureCollection', features: entries },
    diagnostics: {
      ...options,
      bounds,
      streetSourceFingerprint: drive.metadata.sourceFingerprint ?? null,
      driveEdgesIndexed: drive.rows.length,
      edgesRepresented: entries.length,
      edgeFeaturesTruncated: truncated,
      patterns: {
        baseline: baselineRead.patterns.length,
        comparison: comparisonRead.patterns.length,
      },
      routesConsidered: {
        baseline: baselineRead.routesConsidered,
        comparison: comparisonRead.routesConsidered,
      },
      skipped: {
        baseline: baselineRead.skipped,
        comparison: comparisonRead.skipped,
      },
      matching: {
        baseline: baselineDiagnostics,
        comparison: comparisonDiagnostics,
      },
      matchedOnly: true,
      routeIdentifierIndependent: true,
      geometrySource: 'gtfs_shape_to_local_osm_drive_edge',
      stopSplit: false,
    },
  }
}
