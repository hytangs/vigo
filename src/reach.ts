import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson'
import type { GeometrySource, LngLat, MapPreview, RouteMetric } from './domain'
import { coordinateDistanceKm, polylineDistanceKm } from './app/geometry'
import { entityFeedScope } from './networkTruth'
import type { RoutingPoint } from './routingModel'

export function scenarioStopsForRoute(route: RouteMetric | undefined, preview: MapPreview) {
  if (!route) return []
  const stopById = new Map(preview.stops.map((stop) => [stop.id, stop]))
  const exactStops = route.stopIds.flatMap<ScenarioStopDraft>((stopId, index) => {
    const stop = stopById.get(stopId)
    if (!stop || !Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) return []
    return [{
      id: `${route.id}:stop:${index + 1}`,
      label: stop.name || `Stop ${index + 1}`,
      coordinate: [Number(stop.lon), Number(stop.lat)],
      source: 'route',
      stopId: stop.id,
      baselineStopId: stop.id,
      editStatus: 'baseline',
    }]
  })
  return exactStops.length >= 2 ? exactStops : []
}

export function scenarioSourceRouteId(route: RouteMetric) {
  const localRouteId = route.routeId ?? route.id
  const feedScope = entityFeedScope(route.id)
  return feedScope && !String(localRouteId).includes('::')
    ? `${feedScope}::${localRouteId}`
    : localRouteId
}

export function scenarioStopFromRoutingPoint(
  interventionId: string,
  point: RoutingPoint,
  editStatus: NonNullable<ScenarioStopDraft['editStatus']>,
): ScenarioStopDraft {
  return {
    id: `${interventionId}:${editStatus}:${crypto.randomUUID()}`,
    label: point.label,
    coordinate: point.coordinate,
    source: point.stopId ? 'route' : 'map',
    ...(point.stopId ? { stopId: point.stopId } : {}),
    editStatus,
  }
}

function scenarioStopBoundaryId(stop: ScenarioStopDraft | undefined, side: 'before' | 'after') {
  if (!stop) return undefined
  return side === 'before'
    ? stop.baselineStopId ?? stop.stopId ?? stop.anchorBeforeStopId ?? stop.anchorAfterStopId
    : stop.baselineStopId ?? stop.stopId ?? stop.anchorAfterStopId ?? stop.anchorBeforeStopId
}

export function scenarioInsertionAnchors(before: ScenarioStopDraft, after: ScenarioStopDraft) {
  return {
    beforeStopId: scenarioStopBoundaryId(before, 'before'),
    afterStopId: scenarioStopBoundaryId(after, 'after'),
  }
}

export function scenarioInsertedStopsForEdge(stops: ScenarioStopDraft[]) {
  const grouped = new Map<string, ScenarioStopDraft[]>()
  for (const stop of stops) {
    if (stop.editStatus !== 'inserted' || !stop.anchorBeforeStopId || !stop.anchorAfterStopId) continue
    const key = `${stop.anchorBeforeStopId}\u0000${stop.anchorAfterStopId}`
    const entries = grouped.get(key)
    if (entries) entries.push(stop)
    else grouped.set(key, [stop])
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, entries]) => {
      const [beforeStopId, afterStopId] = key.split('\u0000')
      return { beforeStopId, afterStopId, stops: entries }
    })
    .at(0)
}

export function routeHasPublishedShape(
  route: RouteMetric | undefined,
): route is RouteMetric & { coordinates: [number, number][] } {
  return Boolean(
    route?.coordinates
    && route.coordinates.length >= 2
    && (route.geometrySource === 'shape' || route.geometrySource === undefined),
  )
}

export function scenarioPublishedShapeSegmentIndexes(
  route: RouteMetric | undefined,
  stops: ScenarioStopDraft[],
) {
  if (!routeHasPublishedShape(route) || stops.length < 2) return []
  const baselineIndexes = new Map(route.stopIds.map((stopId, index) => [stopId, index]))
  const baselineId = (stop: ScenarioStopDraft) => stop.baselineStopId ?? stop.stopId
  return stops.slice(0, -1).flatMap((left, index) => {
    const right = stops[index + 1]
    // Preserve only an untouched published edge. A replacement keeps the
    // baseline ID for scope matching, but its coordinate is intentionally
    // edited and must be traced by OSM instead.
    if (left.editStatus !== 'baseline' || right.editStatus !== 'baseline') return []
    const leftIndex = baselineIndexes.get(String(baselineId(left) ?? ''))
    const rightIndex = baselineIndexes.get(String(baselineId(right) ?? ''))
    return leftIndex !== undefined && rightIndex === leftIndex + 1 ? [index] : []
  })
}

type ScenarioSegmentRuntimeOptions = {
  segmentDistancesKm?: number[]
}

export function scenarioSegmentRuntimeMinutes(
  route: RouteMetric,
  stops: ScenarioStopDraft[],
  preview: MapPreview,
  options: ScenarioSegmentRuntimeOptions = {},
) {
  const routePatternIds = new Set([route.id, route.patternId ?? route.id])
  const pairRuntimes = new Map<string, number>()
  for (const pair of (preview.stopPairs ?? [])
    .filter((candidate) => routePatternIds.has(candidate.patternId))
    .sort((left, right) => left.sequence - right.sequence)) {
    if (!Number.isFinite(pair.medianRuntimeMinutes) || pair.medianRuntimeMinutes <= 0) continue
    const key = `${pair.fromStopId}\u0000${pair.toStopId}`
    if (!pairRuntimes.has(key)) pairRuntimes.set(key, pair.medianRuntimeMinutes)
  }

  const baselineIndexes = new Map(route.stopIds.map((stopId, index) => [stopId, index]))
  const spanRuntime = (leftIndex: number, rightIndex: number) => {
    const direction = Math.sign(rightIndex - leftIndex)
    if (!direction) return 0
    const start = Math.min(leftIndex, rightIndex)
    const end = Math.max(leftIndex, rightIndex)
    let total = 0
    for (let index = start; index < end; index += 1) {
      const fromStopId = route.stopIds[index]
      const toStopId = route.stopIds[index + 1]
      const runtime = pairRuntimes.get(
        direction > 0
          ? `${fromStopId}\u0000${toStopId}`
          : `${toStopId}\u0000${fromStopId}`,
      )
      if (runtime === undefined || !Number.isFinite(runtime)) return null
      total += runtime
    }
    return total
  }
  const baselineCoordinates = new Map(preview.stops.map((stop) => [stop.id, [Number(stop.lon), Number(stop.lat)] as [number, number]]))
  const publishedCoordinate = (stop: ScenarioStopDraft) => {
    const id = stop.baselineStopId ?? stop.stopId
    const coordinate = id ? baselineCoordinates.get(id) : undefined
    return coordinate ?? stop.coordinate
  }
  const routeDistance = (left: ScenarioStopDraft, right: ScenarioStopDraft) => (
    routeHasPublishedShape(route)
      && Array.isArray(route.coordinates)
      && route.coordinates.length >= 2
      ? polylineDistanceKm(route.coordinates, publishedCoordinate(left), publishedCoordinate(right))
      : coordinateDistanceKm(publishedCoordinate(left), publishedCoordinate(right))
  )
  const fallbackRuntime = (left: ScenarioStopDraft, right: ScenarioStopDraft) => {
    const speedKph = Number(route.scheduledSpeedKph)
    const distanceKm = routeDistance(left, right)
    return speedKph > 0
      ? Math.max(0.05, distanceKm / speedKph * 60)
      : Math.max(0.05, coordinateDistanceKm(left.coordinate, right.coordinate) / 25 * 60)
  }
  const stopBaselineIndex = (stop: ScenarioStopDraft) => {
    const id = stop.baselineStopId ?? stop.stopId
    return id ? baselineIndexes.get(id) : undefined
  }

  const runtimes: number[] = []
  let index = 0
  while (index < stops.length - 1) {
    const left = stops[index]
    const leftIndex = stopBaselineIndex(left)
    if (leftIndex !== undefined) {
      let rightPosition = index + 1
      while (rightPosition < stops.length && stopBaselineIndex(stops[rightPosition]) === undefined) {
        rightPosition += 1
      }
      const rightIndex = rightPosition < stops.length ? stopBaselineIndex(stops[rightPosition]) : undefined
      const preservedRuntime = rightIndex === undefined ? null : spanRuntime(leftIndex, rightIndex)
      if (rightIndex !== undefined) {
        const block = stops.slice(index, rightPosition + 1)
        const originalRuntime = preservedRuntime ?? fallbackRuntime(left, block.at(-1)!)
        const requestedDistances = options.segmentDistancesKm?.slice(index, rightPosition)
        const shapeDistances = block.slice(1).map((stop, blockIndex) => (
          routeDistance(block[blockIndex], stop)
        ))
        const distances = requestedDistances?.length === block.length - 1
          && requestedDistances.every((distance) => Number.isFinite(distance) && distance >= 0)
          ? requestedDistances
          : shapeDistances
        const totalDistance = distances.reduce((sum, distance) => sum + distance, 0)
        // Geometry distributes the published A → B runtime; it does not
        // change its total. The server adds inserted-stop dwell per direction.
        runtimes.push(...distances.map((distance) => totalDistance > 0
          ? originalRuntime * distance / totalDistance
          : originalRuntime / distances.length))
        index = rightPosition
        continue
      }
    }
    runtimes.push(fallbackRuntime(left, stops[index + 1]))
    index += 1
  }
  return runtimes
}


export type ScenarioView = 'baseline' | 'scenario' | 'comparison'
export type ScenarioSurface = 'baseline' | 'scenario'
export type ScenarioRenderMode = 'area' | 'streets'

export type ScenarioRouteScope = 'pattern' | 'edge' | 'route'
export type ScenarioTimeModel = 'preserve-scheduled' | 'infer-road' | 'estimate-distance'
export type ScenarioGeometryMode = 'published-shape' | 'auto-road' | 'straight-line'

type Rgb = readonly [number, number, number]

export const reachDifferenceCapMinutes = 15
export const reachTimeGradient = 'linear-gradient(90deg, #3550ff 0%, #00c2ff 20%, #35d0a1 40%, #ffd166 60%, #ff9645 80%, #ff6757 100%)'
export const reachDifferenceGradient = 'linear-gradient(90deg, #ff6757 0%, #94a3b8 50%, #35d0a1 100%)'

const reachTimeRamp: ReadonlyArray<readonly [number, Rgb]> = [
  [0, [53, 80, 255]],
  [0.2, [0, 194, 255]],
  [0.4, [53, 208, 161]],
  [0.6, [255, 209, 102]],
  [0.8, [255, 150, 69]],
  [1, [255, 103, 87]],
]
const reachDifferenceSlow: Rgb = [255, 103, 87]
const reachDifferenceSame: Rgb = [148, 163, 184]
const reachDifferenceFast: Rgb = [53, 208, 161]

function blendRgb(left: Rgb, right: Rgb, progress: number): [number, number, number] {
  const bounded = Math.max(0, Math.min(1, progress))
  return [0, 1, 2].map((channel) => Math.round(
    left[channel] + (right[channel] - left[channel]) * bounded,
  )) as [number, number, number]
}

export function reachTimeColor(progress: number): [number, number, number] {
  const bounded = Math.max(0, Math.min(1, progress))
  for (let index = 1; index < reachTimeRamp.length; index += 1) {
    const [rightStop, rightColor] = reachTimeRamp[index]
    if (bounded <= rightStop) {
      const [leftStop, leftColor] = reachTimeRamp[index - 1]
      return blendRgb(leftColor, rightColor, (bounded - leftStop) / (rightStop - leftStop))
    }
  }
  return [...reachTimeRamp.at(-1)?.[1] ?? [255, 103, 87]] as [number, number, number]
}

export function reachDifferenceColor(deltaMinutes: number): [number, number, number] {
  const normalized = Number.isFinite(deltaMinutes)
    ? Math.max(-1, Math.min(1, deltaMinutes / reachDifferenceCapMinutes))
    : 0
  if (normalized < 0) return blendRgb(reachDifferenceSlow, reachDifferenceSame, normalized + 1)
  return blendRgb(reachDifferenceSame, reachDifferenceFast, normalized)
}

export type ScenarioStopDraft = {
  id: string
  label: string
  coordinate: LngLat
  source: 'map' | 'route'
  stopId?: string
  /** The published stop this draft edits, even when the draft is moved off it. */
  baselineStopId?: string
  anchorBeforeStopId?: string
  anchorAfterStopId?: string
  editStatus?: 'baseline' | 'added' | 'inserted' | 'replaced'
}

export type ScenarioStopPlacement = {
  interventionId: string
  mode: 'append' | 'insert' | 'replace'
  index: number
}

export type ScenarioServiceDraft = {
  id: string
  name: string
  operation: 'add' | 'augment' | 'replace'
  sourceRouteId?: string
  bidirectional: boolean
  headwayMinutes: number
  startMinutes: number
  endMinutes: number
  averageSpeedKph: number
  dwellMinutes: number
  sourcePatternId?: string
  routeScope?: ScenarioRouteScope
  timeModel?: ScenarioTimeModel
  segmentRuntimeMinutes?: number[]
  segmentDistancesKm?: number[]
  addedStopDwellMinutes?: number
  /** Published GTFS shape geometry when the service is based on an existing pattern. */
  geometry?: LngLat[]
  geometrySource?: GeometrySource
  stops: ScenarioStopDraft[]
}

export type ScenarioChangeKind =
  | 'add-line'
  | 'enhance-line'
  | 'change-line'
  | 'remove-line'

export type ScenarioChangeDraft = {
  id: string
  kind: ScenarioChangeKind
  name: string
  routeId?: string
  routeScope?: ScenarioRouteScope
  timeModel?: ScenarioTimeModel
  geometryMode?: ScenarioGeometryMode
  inferredGeometry?: LngLat[]
  inferredGeometrySource?: 'osm_drive' | 'published_shape_fallback' | 'hybrid'
  inferredFallbackSegmentCount?: number
  inferredPublishedShapeSegmentCount?: number
  inferredOsmSegmentCount?: number
  inferredSegmentDistanceKm?: number[]
  inferredSegmentRuntimeMinutes?: number[]
  geometryStatus?: 'idle' | 'loading' | 'ready' | 'error'
  geometryError?: string
  stops: ScenarioStopDraft[]
  headwayMinutes: number
  averageSpeedKph: number
  startMinutes: number
  endMinutes: number
  bidirectional: boolean
}

export type ScenarioDraft = {
  id: string
  name: string
  interventions: ScenarioChangeDraft[]
}

export type ScenarioRaster = {
  width: number
  height: number
  bounds: [number, number, number, number]
  encoding: 'uint16-tenths-minutes-le-base64'
  scale: number
  nodata: number
  baseline: string
  scenario: string
}

export type ScenarioAreaMetric = {
  cutoffMinutes: number
  reachablePixels: number
  areaKm2: number
}

export type ScenarioAreaMetrics = {
  bounds: [number, number, number, number]
  width: number
  height: number
  pixelAreaKm2: number
  byCutoff: ScenarioAreaMetric[]
}

/**
 * Exact full street-edge geometry packed for transport. The node table is
 * indexed by the endpoint pairs; all numeric buffers are little-endian.
 * `transitArrivalMinutes=-1` represents an origin-only edge.
 */
export type ScenarioStreetEdgeBundle = {
  schemaVersion: 'vigo.street.edge-bundle.v1'
  encoding: 'indexed-f64-le'
  count: number
  nodeCount: number
  nodes: string
  endpoints: string
  /** Directed OSM edge indexes, stable within one persisted street snapshot. */
  edgeIds: string
  durationMinutes: string
  walkDistanceM: string
  transitArrivalMinutes: string
}

export type ScenarioStreetEdgeReference = {
  schemaVersion: 'vigo.street.edge-ref.v1'
  source: 'baseline' | 'scenario'
}

export type ScenarioStreetEdgeSource =
  | ScenarioStreetEdgeBundle
  | ScenarioStreetEdgeReference

export type ScenarioReachMethod = {
  mode: 'total-elapsed-walk-transit-walk'
  cutoffMinutes: number
  baselineTerminalWalkKm: number
  scenarioTerminalWalkKm: number
  baselineTerminalWalkMinutes: number
  scenarioTerminalWalkMinutes: number
}

export type ReachTransitStatus = {
  status: 'reached' | 'no_service' | 'no_service_window' | 'no_target_stops' | 'outside_window' | 'no_reachable_stops' | 'preliminary'
  detail: string
  requestedDepartureMinutes?: number
  windowEndMinutes?: number
  earliestScheduledDepartureMinutes?: number | null
  waitMinutes?: number | null
  targetStops?: number
  reachedStops?: number
}

export type ReachResult = {
  schemaVersion: 'vigo.result.reach.v1'
  request: {
    baselineIdentity: string
    origin: {
      id?: string
      label: string
      coordinate: LngLat
      source: string
      stopId?: string
    }
    departMinutes: number
    serviceDate: string
    serviceDay: string
    maxWalkKm: number
    radiusKm: number
    walkSpeedKph?: number
    rasterSize: number
    cutoffsMinutes: number[]
    scenario: {
      id: string
      name: string
      serviceCount: number
      excludedRouteCount?: number
      excludedTripCount?: number
      excludedPatternCount?: number
    }
  }
  summary: {
    pixels: number
    baselineReachablePixels: number
    scenarioReachablePixels: number
    improvedPixels: number
    maximumCutoffMinutes: number
    transitStopSeeds: number
    transitStopsByCutoff?: Array<{ cutoffMinutes: number; stops: number }>
    scenarioTransitStopsByCutoff?: Array<{ cutoffMinutes: number; stops: number }>
    transitStatus?: ReachTransitStatus | null
    scenarioTransitStatus?: ReachTransitStatus | null
  }
  surface: {
    raster: ScenarioRaster
    displayBounds?: [number, number, number, number]
    areaMetrics?: {
      baseline: ScenarioAreaMetrics
      scenario: ScenarioAreaMetrics
    }
    reachability?: ScenarioReachMethod
    edges?: {
      baseline: ScenarioStreetEdgeSource
      scenario: ScenarioStreetEdgeSource
    }
    areas?: {
      baseline: FeatureCollection<Geometry, GeoJsonProperties>
      scenario: FeatureCollection<Geometry, GeoJsonProperties>
    }
    contours: {
      baseline: FeatureCollection<Geometry, GeoJsonProperties>
      scenario: FeatureCollection<Geometry, GeoJsonProperties>
    }
  }
  scenario: {
    id: string
    name: string
    routes: FeatureCollection<Geometry, GeoJsonProperties>
  }
  limitations: Array<{ code: string; detail: string }>
  diagnostics: {
    reachDispatches: number
    engine?: 'walk_preliminary' | 'unified_native_one_to_many'
    preliminary?: boolean
    reach?: {
      owner?: 'rust_resident_timetable_kernel'
      algorithm?: string
      timetable?: {
        residentConnections?: number
        residentPrepareMs?: number
      }
      search?: {
        reachedStops?: number
        nativeQueryMs?: number
      }
      transit?: ReachTransitStatus | null
    } | null
    scenarioReach?: {
      owner?: 'rust_resident_timetable_kernel'
      algorithm?: string
      timetable?: {
        residentConnections?: number
        residentPrepareMs?: number
      }
      search?: {
        reachedStops?: number
        nativeQueryMs?: number
      }
      transit?: ReachTransitStatus | null
    } | null
    stopSelection: {
      candidates: number
      selected: number
      sampled: boolean
      strategy: string
    }
    raster: {
      size: number
      pixels: number
      directWalkSeed: boolean
      transitSeeds: number
      scenarioSeeds: number
      reachTargets: number
      method?: 'osm-pedestrian-network'
      surfaceModel?: 'directed_osm_edge_interpolation' | 'directed_osm_edge_independent_terminal_walk'
      baselineNetwork?: {
        seeds?: number
        snappedSeeds?: number
        settledLabels?: number
        relaxedEdges?: number
        reachedPixels?: number
        reachedEdgeCount?: number
        reachedEdgeLengthKm?: number
        surfaceModel?: 'directed_osm_edge_interpolation' | 'directed_osm_edge_independent_terminal_walk'
        queryMs?: number
      } | null
      scenarioNetwork?: {
        reachedEdgeCount?: number
        reachedEdgeLengthKm?: number
        reachedPixels?: number
        queryMs?: number
      } | null
    }
    totalMs: number
  }
}

export type ReachComparisonResult = {
  feedId: string
  feedName: string
  result: ReachResult
}

export type ServiceEdgeDecomposition = {
  schemaVersion: 'vigo.service-edge-decomposition.v1'
  baselineFeedId: string
  comparisonFeedId: string
  representation: 'directed_osm_drive_edge'
  featureCollection: FeatureCollection<Geometry, GeoJsonProperties>
  diagnostics: {
    patterns?: {
      baseline: number
      comparison: number
    }
    matching?: {
      baseline?: { matched?: number; partial?: number; unmatched?: number; noEdges?: number }
      comparison?: { matched?: number; partial?: number; unmatched?: number; noEdges?: number }
    }
    edgesRepresented?: number
    edgeFeaturesTruncated?: boolean
    matchedOnly?: boolean
    routeIdentifierIndependent?: boolean
    geometrySource?: string
    stopSplit?: boolean
    [key: string]: unknown
  }
}

const reachComparisonColors = [
  '#6da8ff',
  '#ffb86b',
  '#35d0a1',
  '#c084fc',
  '#ffd166',
  '#7ddfe8',
  '#ff735c',
  '#a6e3a1',
] as const

export function reachComparisonColor(index: number) {
  return reachComparisonColors[index % reachComparisonColors.length]
}

function decodeScenarioRaster(base64: string) {
  const binary = window.atob(base64)
  const values = new Uint16Array(binary.length / 2)
  for (let index = 0; index < values.length; index += 1) {
    values[index] = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8)
  }
  return values
}

function scenarioRasterValues(
  analysis: ReachResult,
  surface: ScenarioSurface,
) {
  return decodeScenarioRaster(analysis.surface.raster[surface])
}

export function scenarioReachablePixels(
  analysis: ReachResult | null,
  surface: ScenarioSurface,
  cutoffMinutes: number,
) {
  if (!analysis) return 0
  const metric = analysis.surface.areaMetrics?.[surface].byCutoff.find((entry) => entry.cutoffMinutes === cutoffMinutes)
  if (metric) return metric.reachablePixels
  const raster = analysis.surface.raster
  const threshold = cutoffMinutes * raster.scale
  let count = 0
  for (const value of scenarioRasterValues(analysis, surface)) {
    if (value !== raster.nodata && value <= threshold) count += 1
  }
  return count
}

export function scenarioImprovedPixels(
  analysis: ReachResult | null,
  cutoffMinutes: number,
) {
  if (!analysis) return 0
  if (Number.isFinite(analysis.summary.improvedPixels)) return analysis.summary.improvedPixels
  const raster = analysis.surface.raster
  const threshold = cutoffMinutes * raster.scale
  const baseline = scenarioRasterValues(analysis, 'baseline')
  const scenario = scenarioRasterValues(analysis, 'scenario')
  let count = 0
  for (let index = 0; index < scenario.length; index += 1) {
    if (
      scenario[index] !== raster.nodata
      && scenario[index] <= threshold
      && (baseline[index] === raster.nodata || scenario[index] < baseline[index])
    ) count += 1
  }
  return count
}

export function scenarioReachedAreaKm2(
  analysis: ReachResult | null,
  surface: ScenarioSurface,
  cutoffMinutes: number,
) {
  if (!analysis) return 0
  const metric = analysis.surface.areaMetrics?.[surface].byCutoff.find((entry) => entry.cutoffMinutes === cutoffMinutes)
  if (metric) return metric.areaKm2
  const [west, south, east, north] = analysis.surface.raster.bounds
  const latitudeKm = 111.32
  const longitudeKm = Math.max(12, 111.32 * Math.cos(((south + north) / 2) * Math.PI / 180))
  const pixelAreaKm2 = Math.max(0, (east - west) * longitudeKm * (north - south) * latitudeKm)
    / (analysis.surface.raster.width * analysis.surface.raster.height)
  return scenarioReachablePixels(analysis, surface, cutoffMinutes) * pixelAreaKm2
}

export function scenarioTransitStopsAtCutoff(
  analysis: ReachResult | null,
  surface: ScenarioSurface,
  cutoffMinutes: number,
) {
  if (!analysis) return 0
  const entries = surface === 'scenario'
    ? analysis.summary.scenarioTransitStopsByCutoff ?? analysis.summary.transitStopsByCutoff
    : analysis.summary.transitStopsByCutoff
  const exact = entries?.find((entry) => entry.cutoffMinutes === cutoffMinutes)
  if (exact) return exact.stops
  const nearest = entries
    ?.filter((entry) => entry.cutoffMinutes <= cutoffMinutes)
    .at(-1)
  return nearest?.stops ?? analysis.summary.transitStopSeeds
}
