import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson'
import type { GeometrySource, LngLat } from './domain'

export type ScenarioView = 'baseline' | 'scenario' | 'comparison'
export type ScenarioSurface = 'baseline' | 'scenario'
export type ScenarioRenderMode = 'area' | 'streets'

export type ScenarioRouteScope = 'pattern' | 'edge' | 'route'
export type ScenarioTimeModel = 'preserve-scheduled' | 'infer-road' | 'estimate-distance'
export type ScenarioGeometryMode = 'published-shape' | 'auto-road' | 'straight-line'

type Rgb = readonly [number, number, number]

export const accessibilityDifferenceCapMinutes = 15
export const accessibilityTimeGradient = 'linear-gradient(90deg, #3550ff 0%, #00c2ff 20%, #35d0a1 40%, #ffd166 60%, #ff9645 80%, #ff6757 100%)'
export const accessibilityDifferenceGradient = 'linear-gradient(90deg, #ff6757 0%, #94a3b8 50%, #35d0a1 100%)'

const accessibilityTimeRamp: ReadonlyArray<readonly [number, Rgb]> = [
  [0, [53, 80, 255]],
  [0.2, [0, 194, 255]],
  [0.4, [53, 208, 161]],
  [0.6, [255, 209, 102]],
  [0.8, [255, 150, 69]],
  [1, [255, 103, 87]],
]
const accessibilityDifferenceSlow: Rgb = [255, 103, 87]
const accessibilityDifferenceSame: Rgb = [148, 163, 184]
const accessibilityDifferenceFast: Rgb = [53, 208, 161]

function blendRgb(left: Rgb, right: Rgb, progress: number): [number, number, number] {
  const bounded = Math.max(0, Math.min(1, progress))
  return [0, 1, 2].map((channel) => Math.round(
    left[channel] + (right[channel] - left[channel]) * bounded,
  )) as [number, number, number]
}

export function accessibilityTimeColor(progress: number): [number, number, number] {
  const bounded = Math.max(0, Math.min(1, progress))
  for (let index = 1; index < accessibilityTimeRamp.length; index += 1) {
    const [rightStop, rightColor] = accessibilityTimeRamp[index]
    if (bounded <= rightStop) {
      const [leftStop, leftColor] = accessibilityTimeRamp[index - 1]
      return blendRgb(leftColor, rightColor, (bounded - leftStop) / (rightStop - leftStop))
    }
  }
  return [...accessibilityTimeRamp.at(-1)?.[1] ?? [255, 103, 87]] as [number, number, number]
}

export function accessibilityDifferenceColor(deltaMinutes: number): [number, number, number] {
  const normalized = Number.isFinite(deltaMinutes)
    ? Math.max(-1, Math.min(1, deltaMinutes / accessibilityDifferenceCapMinutes))
    : 0
  if (normalized < 0) return blendRgb(accessibilityDifferenceSlow, accessibilityDifferenceSame, normalized + 1)
  return blendRgb(accessibilityDifferenceSame, accessibilityDifferenceFast, normalized)
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
  /** Published GTFS shape geometry when the service is based on an existing pattern. */
  geometry?: LngLat[]
  geometrySource?: GeometrySource
  stops: ScenarioStopDraft[]
}

export type AccessibilityInterventionKind =
  | 'add-line'
  | 'enhance-line'
  | 'change-line'
  | 'remove-line'
  | 'policy'

export type AccessibilityInterventionDraft = {
  id: string
  kind: AccessibilityInterventionKind
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
  maxWalkKm?: number
  walkSpeedKph?: number
}

export type AccessibilityCaseDraft = {
  id: string
  name: string
  interventions: AccessibilityInterventionDraft[]
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
export type ScenarioStreetEdgeEvidenceBundle = {
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

export type ScenarioStreetEdgeEvidenceReference = {
  schemaVersion: 'vigo.street.edge-ref.v1'
  source: 'baseline' | 'scenario'
}

export type ScenarioStreetEdgeEvidenceSource =
  | ScenarioStreetEdgeEvidenceBundle
  | ScenarioStreetEdgeEvidenceReference

export type ScenarioSurfaceReachability = {
  mode: 'total-elapsed-walk-transit-walk'
  cutoffMinutes: number
  baselineTerminalWalkKm: number
  scenarioTerminalWalkKm: number
  baselineTerminalWalkMinutes: number
  scenarioTerminalWalkMinutes: number
}

export type AccessibilityTransitStatus = {
  status: 'reached' | 'no_service' | 'no_service_window' | 'no_target_stops' | 'outside_window' | 'no_reachable_stops' | 'preliminary'
  detail: string
  requestedDepartureMinutes?: number
  windowEndMinutes?: number
  earliestScheduledDepartureMinutes?: number | null
  waitMinutes?: number | null
  targetStops?: number
  reachedStops?: number
}

export type ScenarioAnalysisResult = {
  schemaVersion: 'vigo.scenario-analysis.v1'
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
      policy?: {
        maxWalkKm: number
        walkSpeedKph: number
      }
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
    transitStatus?: AccessibilityTransitStatus | null
    scenarioTransitStatus?: AccessibilityTransitStatus | null
  }
  surface: {
    raster: ScenarioRaster
    displayBounds?: [number, number, number, number]
    areaMetrics?: {
      baseline: ScenarioAreaMetrics
      scenario: ScenarioAreaMetrics
    }
    reachability?: ScenarioSurfaceReachability
    edges?: {
      baseline: ScenarioStreetEdgeEvidenceSource
      scenario: ScenarioStreetEdgeEvidenceSource
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
    accessibilityDispatches: number
    analysisEngine?: 'walk_preliminary' | 'unified_native_one_to_many'
    preliminary?: boolean
    accessibility?: {
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
      transit?: AccessibilityTransitStatus | null
    } | null
    scenarioAccessibility?: {
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
      transit?: AccessibilityTransitStatus | null
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
      accessibilityTargets: number
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
    cache: {
      status: 'hit' | 'miss'
      key?: string
      baselineSurface?: 'hit' | 'miss' | 'disabled'
    }
  }
}

export type ScenarioComparisonResult = {
  feedId: string
  feedName: string
  analysis: ScenarioAnalysisResult
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

export const scenarioComparisonColors = [
  '#6da8ff',
  '#ffb86b',
  '#35d0a1',
  '#c084fc',
  '#ffd166',
  '#7ddfe8',
  '#ff735c',
  '#a6e3a1',
] as const

export function scenarioComparisonColor(index: number) {
  return scenarioComparisonColors[index % scenarioComparisonColors.length]
}

function decodeScenarioRaster(base64: string) {
  const binary = window.atob(base64)
  const values = new Uint16Array(binary.length / 2)
  for (let index = 0; index < values.length; index += 1) {
    values[index] = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8)
  }
  return values
}

export function scenarioRasterValues(
  analysis: ScenarioAnalysisResult,
  surface: ScenarioSurface,
) {
  return decodeScenarioRaster(analysis.surface.raster[surface])
}

export function scenarioReachablePixels(
  analysis: ScenarioAnalysisResult | null,
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
  analysis: ScenarioAnalysisResult | null,
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

export function scenarioAccessibleAreaKm2(
  analysis: ScenarioAnalysisResult | null,
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
  analysis: ScenarioAnalysisResult | null,
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
