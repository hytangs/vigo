import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson'
import type { GeometrySource, LngLat, MapPreview, RouteMetric } from './domain'
import { coordinateDistanceKm, orderedPolylineAnchors, polylineDistanceKm, splicePolylineIntervals } from './app/geometry'
import { entityFeedScope } from './networkTruth'
import type { RoutingPoint } from './routingModel'

export function joinScenarioSegmentGeometry(segments: LngLat[][]): LngLat[] {
  const geometry: LngLat[] = []
  for (const segment of segments) {
    const previous = geometry.at(-1)
    const first = segment[0]
    const start = previous && first && previous[0] === first[0] && previous[1] === first[1] ? 1 : 0
    for (let index = start; index < segment.length; index += 1) {
      geometry.push(segment[index])
    }
  }
  return geometry
}

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
      baselineStopIndex: index,
      editStatus: 'baseline',
    }]
  })
  return exactStops.length >= 2 && exactStops.length === route.stopIds.length ? exactStops : []
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
  if (stop.editStatus === 'inserted') {
    return side === 'before' ? stop.anchorBeforeStopId : stop.anchorAfterStopId
  }
  return side === 'before'
    ? stop.baselineStopId ?? stop.stopId ?? stop.anchorBeforeStopId ?? stop.anchorAfterStopId
    : stop.baselineStopId ?? stop.stopId ?? stop.anchorAfterStopId ?? stop.anchorBeforeStopId
}

export function scenarioInsertionAnchors(before: ScenarioStopDraft, after: ScenarioStopDraft) {
  return {
    beforeStopId: scenarioStopBoundaryId(before, 'before'),
    afterStopId: scenarioStopBoundaryId(after, 'after'),
    beforeStopIndex: before.baselineStopIndex ?? before.anchorBeforeStopIndex,
    afterStopIndex: after.baselineStopIndex ?? after.anchorAfterStopIndex,
  }
}

export function scenarioInsertedStopsForEdge(stops: ScenarioStopDraft[]) {
  const fromIndex = stops.findIndex((stop) => stop.editStatus === 'inserted') - 1
  if (fromIndex < 0) return undefined
  let toIndex = fromIndex + 1
  while (stops[toIndex]?.editStatus === 'inserted') toIndex += 1
  if (toIndex >= stops.length || stops.slice(toIndex).some((stop) => stop.editStatus === 'inserted')) return undefined
  if (stops.some((stop) => stop.editStatus === 'added' || stop.editStatus === 'replaced')) return undefined
  const beforeStopId = stops[fromIndex].baselineStopId ?? stops[fromIndex].stopId
  const afterStopId = stops[toIndex].baselineStopId ?? stops[toIndex].stopId
  const inserted = stops.slice(fromIndex + 1, toIndex)
  if (!beforeStopId || !afterStopId || inserted.some((stop) => (
    stop.anchorBeforeStopId !== beforeStopId || stop.anchorAfterStopId !== afterStopId
  ))) return undefined
  return { beforeStopId, afterStopId, fromIndex, toIndex, stops: inserted }
}

/** Resolve occurrences, rather than collapsing every visit to a stop ID. */
export function scenarioBaselineStopIndexes(route: RouteMetric, stops: ScenarioStopDraft[]) {
  let minimum = 0
  return stops.map((stop) => {
    if (stop.editStatus === 'inserted' || stop.editStatus === 'added') return undefined
    const id = stop.baselineStopId ?? stop.stopId
    if (!id) return undefined
    const originalIndex = stop.id.startsWith(`${route.id}:stop:`)
      ? Number(stop.id.slice(`${route.id}:stop:`.length)) - 1
      : undefined
    const explicit = stop.baselineStopIndex ?? originalIndex
    const index = explicit !== undefined && Number.isInteger(explicit) && route.stopIds[explicit] === id
      ? explicit
      : route.stopIds.findIndex((candidate, index) => index >= minimum && candidate === id)
    if (index < 0) return undefined
    minimum = index + 1
    return index
  })
}

export function scenarioEdgeIndexes(route: RouteMetric, beforeStopId: string, afterStopId: string) {
  return route.stopIds.flatMap((id, index) => id === beforeStopId && route.stopIds[index + 1] === afterStopId ? [index] : [])
}

export function scenarioEdgeEditError(route: RouteMetric, stops: ScenarioStopDraft[]) {
  const edit = scenarioInsertedStopsForEdge(stops)
  if (!edit) return 'Exact-edge scope requires inserted stops in one A → B gap, with no other stop edits. Use Selected branch only for multiple gaps, moved stops, or extensions.'
  const baseline = stops.filter((stop) => stop.editStatus !== 'inserted')
  const indexes = scenarioBaselineStopIndexes(route, baseline)
  if (baseline.length !== route.stopIds.length || indexes.some((index, position) => index !== position)) {
    return 'Exact-edge scope requires the complete original branch around the inserted gap. Reset its GTFS stops or use Selected branch only.'
  }
  return undefined
}

/** Apply the inserted gap at every matching directed occurrence in a branch. */
export function scenarioStopsForEdgeBranch(intervention: ScenarioChangeDraft, branch: RouteMetric, preview: MapPreview) {
  const edit = scenarioInsertedStopsForEdge(intervention.stops)
  const baseline = scenarioStopsForRoute(branch, preview)
  if (!edit || baseline.length !== branch.stopIds.length) return []
  const indexes = new Set(scenarioEdgeIndexes(branch, edit.beforeStopId, edit.afterStopId))
  return baseline.flatMap((stop, index) => indexes.has(index)
    ? [stop, ...edit.stops.map((inserted, insertionIndex) => ({
        ...inserted,
        id: `${intervention.id}:${branch.id}:edge:${index}:inserted:${insertionIndex}`,
        baselineStopId: undefined,
        baselineStopIndex: undefined,
        anchorBeforeStopIndex: index,
        anchorAfterStopIndex: index + 1,
      }))]
    : [stop])
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

/** Apply an edited A → B gap to another branch of the same GTFS service. */
export function scenarioEdgeGeometryForBranch(
  intervention: ScenarioChangeDraft, branch: RouteMetric, preview: MapPreview,
) {
  const edit = scenarioInsertedStopsForEdge(intervention.stops)
  if (!edit || !routeHasPublishedShape(branch)) return undefined
  const from = edit.fromIndex, to = edit.toIndex
  const segments = intervention.inferredSegmentGeometry?.slice(from, to)
  const distances = intervention.inferredSegmentDistanceKm?.slice(from, to)
  if (from < 0 || to <= from || !segments || segments.length !== to - from
    || segments.some((segment) => segment.length < 2) || !distances || distances.length !== segments.length
    || distances.some((distance) => !Number.isFinite(distance) || distance < 0)) return undefined
  const replacement = joinScenarioSegmentGeometry(segments)
  const stops = scenarioStopsForRoute(branch, preview)
  if (stops.length !== branch.stopIds.length) return undefined
  const indexes = scenarioEdgeIndexes(branch, edit.beforeStopId, edit.afterStopId)
  if (!indexes.length) return undefined
  const points = stops.map((stop) => stop.coordinate)
  const anchors = orderedPolylineAnchors(branch.coordinates, points)
  if (!anchors) return undefined
  const geometry = splicePolylineIntervals(branch.coordinates, anchors,
    indexes.map((index) => ({ fromIndex: index, toIndex: index + 1, coordinates: replacement })))
  if (!geometry) return undefined
  const baselineDistances = anchors.slice(1).map((anchor, i) => anchor.measureKm - anchors[i].measureKm)
  return {
    geometry,
    segmentDistancesKm: baselineDistances.flatMap((distance, index) => indexes.includes(index) ? distances : [distance]),
  }
}

export function scenarioPublishedShapeSegmentIndexes(
  route: RouteMetric | undefined,
  stops: ScenarioStopDraft[],
) {
  if (!routeHasPublishedShape(route) || stops.length < 2) return []
  const baselineIndexes = scenarioBaselineStopIndexes(route, stops)
  return stops.slice(0, -1).flatMap((left, index) => {
    const right = stops[index + 1]
    // Preserve only an untouched published edge. A replacement keeps the
    // baseline ID for scope matching, but its coordinate is intentionally
    // edited and must be traced by OSM instead.
    if (left.editStatus !== 'baseline' || right.editStatus !== 'baseline') return []
    const leftIndex = baselineIndexes[index]
    const rightIndex = baselineIndexes[index + 1]
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
  const pairRuntimes = new Map<number, number>()
  for (const pair of (preview.stopPairs ?? [])
    .filter((candidate) => routePatternIds.has(candidate.patternId))
    .sort((left, right) => left.sequence - right.sequence)) {
    if (!Number.isFinite(pair.medianRuntimeMinutes) || pair.medianRuntimeMinutes < 0) continue
    const index = pair.sequence - 1
    if (route.stopIds[index] !== pair.fromStopId || route.stopIds[index + 1] !== pair.toStopId) continue
    if (!pairRuntimes.has(index)) pairRuntimes.set(index, pair.medianRuntimeMinutes)
  }

  const baselineIndexes = scenarioBaselineStopIndexes(route, stops)
  const spanRuntime = (leftIndex: number, rightIndex: number) => {
    if (rightIndex < leftIndex) return null
    let total = 0
    for (let index = leftIndex; index < rightIndex; index += 1) {
      const runtime = pairRuntimes.get(index)
      if (runtime === undefined || !Number.isFinite(runtime)) return null
      total += runtime
    }
    return total
  }
  const baselineCoordinates = new Map(preview.stops.map((stop) => [stop.id, [Number(stop.lon), Number(stop.lat)] as [number, number]]))
  const sourceStops = scenarioStopsForRoute(route, preview)
  const shapeAnchors = routeHasPublishedShape(route) && sourceStops.length === route.stopIds.length
    ? orderedPolylineAnchors(route.coordinates, sourceStops.map((stop) => stop.coordinate))
    : undefined
  const publishedCoordinate = (stop: ScenarioStopDraft) => {
    const id = stop.baselineStopId ?? stop.stopId
    const coordinate = id ? baselineCoordinates.get(id) : undefined
    return coordinate ?? stop.coordinate
  }
  const indexByStop = new Map(stops.map((stop, index) => [stop, baselineIndexes[index]]))
  const routeDistance = (left: ScenarioStopDraft, right: ScenarioStopDraft) => {
    const leftIndex = indexByStop.get(left), rightIndex = indexByStop.get(right)
    if (shapeAnchors && leftIndex !== undefined && rightIndex !== undefined) {
      return Math.abs(shapeAnchors[rightIndex].measureKm - shapeAnchors[leftIndex].measureKm)
    }
    return routeHasPublishedShape(route)
      && Array.isArray(route.coordinates)
      && route.coordinates.length >= 2
      ? polylineDistanceKm(route.coordinates, publishedCoordinate(left), publishedCoordinate(right))
      : coordinateDistanceKm(publishedCoordinate(left), publishedCoordinate(right))
  }
  const fallbackRuntime = (left: ScenarioStopDraft, right: ScenarioStopDraft) => {
    const speedKph = Number(route.scheduledSpeedKph)
    const distanceKm = routeDistance(left, right)
    return speedKph > 0
      ? Math.max(0.05, distanceKm / speedKph * 60)
      : Math.max(0.05, coordinateDistanceKm(left.coordinate, right.coordinate) / 25 * 60)
  }
  const runtimes: number[] = []
  let index = 0
  while (index < stops.length - 1) {
    const left = stops[index]
    const leftIndex = baselineIndexes[index]
    if (leftIndex !== undefined) {
      let rightPosition = index + 1
      while (rightPosition < stops.length && baselineIndexes[rightPosition] === undefined) {
        rightPosition += 1
      }
      const rightIndex = baselineIndexes[rightPosition]
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
  /** Zero-based occurrence in the published stop sequence, including loops. */
  baselineStopIndex?: number
  anchorBeforeStopId?: string
  anchorAfterStopId?: string
  anchorBeforeStopIndex?: number
  anchorAfterStopIndex?: number
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
  inferredSegmentGeometry?: LngLat[][]
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
