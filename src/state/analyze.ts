import { apiJson, apiProgressJson, type ApiProgress } from '../app/api'
import { bundleFeedId } from '../app/projectState'
import { createScenarioRoadGeometryRequest } from '../app/scenarioRoadGeometryRequest'
import { createStore, memoizeLast } from '../app/store'
import { caseFeedSelection, type CityDataGroups } from '../app/cityDataGroups'
import { baselineGroupId, maximumScenarios, newScenario } from '../app/scenarioLibrary'
import { compareStats, type CompareVariant, type CompareEntry, type ComparisonRun } from '../app/comparison'
import { reachTransitStops } from '../app/resultSummary'
import type { useReachInspection } from '../app/useReachInspection'
import type { AnalyzeMode, ComparisonFeedOption } from '../components/AnalyzePanel'
import { quietMapLabel } from '../components/studio/presentation'
import { formatNumber, type RouteMetric, type VigoProject } from '../domain'
import { entityFeedScope } from '../networkTruth'
import {
  joinScenarioSegmentGeometry,
  inflateReachResult,
  reachTimeBands,
  scenarioReachedAreaKm2,
  routeHasPublishedShape,
  scenarioEdgeEditError,
  scenarioEdgeGeometryForBranch,
  scenarioEdgeIndexes,
  scenarioInsertedStopsForEdge,
  scenarioInsertionAnchors,
  scenarioPublishedShapeSegmentIndexes,
  scenarioSegmentRuntimeMinutes,
  scenarioSourceRouteId,
  scenarioStopFromRoutingPoint,
  scenarioStopsForEdgeBranch,
  scenarioStopsForRoute,
  type ReachResult,
  type ScenarioChangeDraft,
  type ScenarioChangeKind,
  type ScenarioDraft,
  type ScenarioGeometryMode,
  type ScenarioRenderMode,
  type ScenarioRouteScope,
  type ScenarioServiceDraft,
  type ScenarioStopDraft,
  type ScenarioStopPlacement,
  type ScenarioTimeModel,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from '../reach'
import { scopedRouteServiceKey } from '../routeServices'
import type { RoutingPoint } from '../routingModel'
import { buildRoutingPointFromMap } from '../routingUi'
import { city, setActiveFeedId } from './city'
import { changeServiceDate, clock, serviceDay } from './clock'
import { openAnalyzeView } from './navigation'
import { route } from './route'
import { scenarioLibrary, scenarioValues } from './scenarios'
import { preview, routingScope, selectedProject } from './scope'
import { shell } from './shell'

const desktopReachRasterSize = 128
const desktopStreetReachRasterSize = 384

export type ReachInspection = ReturnType<typeof useReachInspection>

/** Analyze workspace: the Reach origin, run settings, cases and their results. */
export type AnalyzeState = {
  analysisOrigin: RoutingPoint | null
  analyzeMode: AnalyzeMode
  reachResult: ReachResult | null
  comparisonRun: ComparisonRun | null
  compareReferenceId: string
  compareScenarioSelection: string[] | null
  serviceDecomposition: ServiceEdgeDecomposition | null
  serviceDecompositionLoading: boolean
  serviceDecompositionError: string
  scenarioLoading: boolean
  scenarioProgress: ApiProgress | null
  scenarioError: string
  scenarioCutoffMinutes: number
  reachMaxWalkKm: number
  reachMaxTransfers: number | undefined
  scenarioWalkSpeedKph: number
  reachSurfaceSampling: 'street' | 'cell-center'
  scenarioView: ScenarioView
  scenarioRenderMode: ScenarioRenderMode
  comparisonFeedIds: string[]
  scenarioStopPlacement: ScenarioStopPlacement | null
  /** The clicked point's journey (see AnalyzeRuntime). */
  inspection: ReachInspection | null
}

const initialAnalyzeState = (): AnalyzeState => ({
  analysisOrigin: null,
  analyzeMode: 'single',
  reachResult: null,
  comparisonRun: null,
  compareReferenceId: 'group:baseline',
  compareScenarioSelection: null,
  serviceDecomposition: null,
  serviceDecompositionLoading: false,
  serviceDecompositionError: '',
  scenarioLoading: false,
  scenarioProgress: null,
  scenarioError: '',
  scenarioCutoffMinutes: 45,
  reachMaxWalkKm: 1.2,
  reachMaxTransfers: undefined,
  scenarioWalkSpeedKph: 4.8,
  reachSurfaceSampling: 'street',
  scenarioView: 'comparison',
  scenarioRenderMode: 'area',
  comparisonFeedIds: [],
  scenarioStopPlacement: null,
  inspection: null,
})

export const analyze = createStore<AnalyzeState>(initialAnalyzeState())

function newScenarioChange(kind: ScenarioChangeKind): ScenarioChangeDraft {
  const changesGeometry = kind === 'add-line' || kind === 'change-line'
  return {
    id: `intervention-${crypto.randomUUID()}`,
    kind,
    scheduleMode: kind === 'change-line' ? 'preserve-trips' : 'frequency',
    name: kind.replaceAll('-', ' '),
    stops: [],
    headwayMinutes: 10,
    averageSpeedKph: 25,
    startMinutes: 5 * 60,
    endMinutes: 25 * 60,
    bidirectional: kind === 'add-line',
    routeScope: kind === 'add-line' ? undefined : 'pattern',
    timeModel: changesGeometry ? 'infer-road' : 'preserve-scheduled',
    geometryMode: changesGeometry ? 'auto-road' : 'published-shape',
    geometryStatus: 'idle',
  }
}

export const emptyScenarioStops: ScenarioStopDraft[] = []
const emptyCoordinates: [number, number][] = []

const drafts = scenarioValues
const setters = scenarioLibrary
export const cityGrouping = () => scenarioLibrary().grouping

const activeScenarioOf = memoizeLast((cases: ScenarioDraft[], activeCaseId: string) => cases.find((entry) => entry.id === activeCaseId) ?? cases[0])
export const activeScenario = () => activeScenarioOf(drafts().cases, drafts().activeCaseId)

const activeScenarioChangeOf = memoizeLast((scenario: ScenarioDraft | undefined, activeChangeId: string) => (
  scenario?.interventions.find((entry) => entry.id === activeChangeId) ?? scenario?.interventions[0]
))
export const activeScenarioChange = () => activeScenarioChangeOf(activeScenario(), drafts().activeChangeId)

const findScenarioRoute = (routes: RouteMetric[], routeId: string | undefined) => routeId
  ? routes.find((candidate) => candidate.id === routeId || candidate.patternId === routeId)
  : undefined

const activeCaseFeedsOf = memoizeLast(caseFeedSelection)
export const activeCaseFeeds = () => activeCaseFeedsOf(cityGroupsValue(), drafts().activeCaseId, selectedProject())

/** Feed groups for the selected City; stable while its stored copy is unchanged. */
export const cityGroupsValue = (): CityDataGroups => cityGrouping().value

const analysisRoutesOf = memoizeLast((mode: AnalyzeMode, routes: RouteMetric[], feedIds: string[]) => (
  mode === 'single' ? routes.filter((entry) => feedIds.includes(entityFeedScope(entry.id))) : routes
))
/** Routes an edit can target: the active case's feed group, or every route when comparing feeds. */
export const analysisRoutes = () => analysisRoutesOf(analyze.get().analyzeMode, preview().routes, activeCaseFeeds().feedIds)

export const scenarioSketchStops = () => {
  const change = activeScenarioChange()
  return change && ['add-line', 'change-line'].includes(change.kind) ? change.stops : emptyScenarioStops
}

const scenarioSketchGeometryOf = memoizeLast((
  change: ScenarioChangeDraft | undefined,
  scenarioRoute: RouteMetric | undefined,
  sketchStops: ScenarioStopDraft[],
): [number, number][] => {
  if (!change || sketchStops.length < 2) return emptyCoordinates
  const geometryMode = change.geometryMode
    ?? (change.timeModel === 'infer-road'
      ? 'auto-road'
      : change.timeModel === 'estimate-distance'
        ? 'straight-line'
        : 'published-shape')
  if (geometryMode === 'auto-road' && change.geometryStatus === 'ready') {
    return change.inferredGeometry ?? sketchStops.map((stop) => stop.coordinate)
  }
  const publishedGeometry = routeHasPublishedShape(scenarioRoute)
    ? scenarioRoute.coordinates
    : undefined
  if (geometryMode === 'published-shape' && publishedGeometry && publishedGeometry.length >= 2) {
    return publishedGeometry
  }
  // Do not draw an invented chord while the hybrid OSM/shape path is still
  // being prepared. Existing route shape remains useful context; a new
  // line stays point-only until its road geometry is certified.
  if (geometryMode === 'auto-road') return publishedGeometry ?? emptyCoordinates
  return sketchStops.map((stop) => stop.coordinate)
})

export function scenarioSketchGeometry() {
  const change = activeScenarioChange()
  return scenarioSketchGeometryOf(change, findScenarioRoute(preview().routes, change?.routeId), scenarioSketchStops())
}

export function activeScenarioStopPlacement() {
  const placement = analyze.get().scenarioStopPlacement
  return placement?.interventionId === activeScenarioChange()?.id ? placement : null
}

/** Whether a map click places the origin or a scenario stop. */
export function scenarioPointPicking() {
  const { analysisOrigin, analyzeMode } = analyze.get()
  return shell.get().activeRouteTool === 'analyze' && Boolean(
    !analysisOrigin
    || analyzeMode === 'single' && activeScenarioStopPlacement(),
  )
}

const comparisonFeedOptionsOf = memoizeLast((feeds: VigoProject['feeds']): ComparisonFeedOption[] => feeds
  .filter((feed) => feed.routingStore?.status === 'ready')
  .map((feed) => ({
    id: feed.id,
    name: quietMapLabel(feed.name || feed.fileName || feed.id),
    routeCount: Number(feed.routeCount ?? 0),
    stopCount: Number(feed.stopCount ?? 0),
    tripCount: Number(feed.tripCount ?? 0),
  })))
export const comparisonFeedOptions = () => comparisonFeedOptionsOf(selectedProject().feeds)

export function comparisonStoreIdentity() {
  const { feeds } = selectedProject()
  return analyze.get().comparisonFeedIds.map((feedId) => {
    const feed = feeds.find((candidate) => candidate.id === feedId)
    return `${feedId}:${feed?.routingStore?.builtAt ?? ''}`
  }).join('|')
}

/** Inputs whose change makes a shown Reach result stale. */
export function reachInputIdentity() {
  const { scheduleTimeMinutes, serviceDate } = clock.get()
  return [
    routingScope().nationalRoutingStoreKey,
    comparisonStoreIdentity(),
    selectedProject().osmStreetIndex?.builtAt ?? '',
    serviceDate,
    scheduleTimeMinutes,
    route.get().routingMaxWalkKm,
  ].join(':')
}

let analysisAbort: AbortController | null = null
let scenarioRoadGeometryAbort: AbortController | null = null
let scenarioRoadGeometryRequestId = 0
let serviceDecompositionAbort: AbortController | null = null
let comparisonFeedsInitialized = false

export function invalidateAnalyzeResult() {
  analysisAbort?.abort()
  analysisAbort = null
  scenarioRoadGeometryAbort?.abort()
  scenarioRoadGeometryAbort = null
  scenarioRoadGeometryRequestId += 1
  serviceDecompositionAbort?.abort()
  serviceDecompositionAbort = null
  analyze.set({
    reachResult: null,
    comparisonRun: null,
    serviceDecomposition: null,
    serviceDecompositionLoading: false,
    serviceDecompositionError: '',
    scenarioError: '',
    scenarioLoading: false,
    scenarioProgress: null,
  })
}

export function resetAnalyze() {
  analysisAbort?.abort()
  scenarioRoadGeometryAbort?.abort()
  serviceDecompositionAbort?.abort()
  analysisAbort = scenarioRoadGeometryAbort = serviceDecompositionAbort = null
  scenarioRoadGeometryRequestId += 1
  comparisonFeedsInitialized = false
  analyze.set(initialAnalyzeState())
}

export function clearAnalysisState() {
  invalidateAnalyzeResult()
  comparisonFeedsInitialized = false
  analyze.set({ comparisonFeedIds: [], compareReferenceId: 'group:baseline', compareScenarioSelection: null, analysisOrigin: null, scenarioStopPlacement: null })
}

/** Keep comparison feeds to ready ones; the first ready list selects every feed. */
export function retainComparisonFeeds(options: ComparisonFeedOption[]) {
  const validIds = options.map((feed) => feed.id)
  analyze.set(({ comparisonFeedIds: current }) => {
    if (!comparisonFeedsInitialized && validIds.length > 0) {
      comparisonFeedsInitialized = true
      return { comparisonFeedIds: validIds }
    }
    const retained = current.filter((feedId) => validIds.includes(feedId))
    if (retained.length === current.length && retained.every((feedId, index) => feedId === current[index])) return {}
    return { comparisonFeedIds: retained }
  })
}

export function analysisPointFromMap(point: RoutingPoint) {
  const mapPoint = point.source === 'map' && !point.named
    ? buildRoutingPointFromMap(
      point.coordinate,
      `${point.coordinate[1].toFixed(4)}, ${point.coordinate[0].toFixed(4)}`,
    )
    : point
  if (shell.get().activeRouteTool !== 'analyze') return
  if (!analyze.get().analysisOrigin) {
    invalidateAnalyzeResult()
    analyze.set({ analysisOrigin: mapPoint })
    return
  }
  const change = activeScenarioChange()
  if (!change) return
  const placement = activeScenarioStopPlacement()
  if (!placement) return
  if (change.stops.length >= 256 && placement.mode !== 'replace') return

  const nextStops = [...change.stops]
  if (placement.mode === 'replace') {
    if (!nextStops[placement.index]) return
    const replacement = scenarioStopFromRoutingPoint(change.id, mapPoint, 'replaced')
    const existing = nextStops[placement.index]
    const addedHere = ['inserted', 'added'].includes(existing.editStatus ?? '')
    nextStops[placement.index] = {
      ...replacement,
      id: existing.id,
      baselineStopId: addedHere ? undefined : existing.baselineStopId ?? existing.stopId,
      baselineStopIndex: existing.baselineStopIndex,
      anchorBeforeStopId: existing.anchorBeforeStopId,
      anchorAfterStopId: existing.anchorAfterStopId,
      anchorBeforeStopIndex: existing.anchorBeforeStopIndex,
      anchorAfterStopIndex: existing.anchorAfterStopIndex,
      editStatus: addedHere ? existing.editStatus : 'replaced',
    }
  } else if (placement.mode === 'insert') {
    if (placement.index < 1 || placement.index >= nextStops.length) return
    const before = nextStops[placement.index - 1]
    const after = nextStops[placement.index]
    const { beforeStopId, afterStopId, beforeStopIndex, afterStopIndex } = scenarioInsertionAnchors(before, after)
    nextStops.splice(placement.index, 0, {
      ...scenarioStopFromRoutingPoint(change.id, mapPoint, 'inserted'),
      anchorBeforeStopId: beforeStopId,
      anchorAfterStopId: afterStopId,
      anchorBeforeStopIndex: beforeStopIndex,
      anchorAfterStopIndex: afterStopIndex,
    })
  } else {
    nextStops.push(scenarioStopFromRoutingPoint(change.id, mapPoint, 'added'))
  }
  updateScenarioChange(change.id, { stops: nextStops })
  analyze.set({ scenarioStopPlacement: null })
}

export function moveScenarioStopFromMap(index: number, coordinate: [number, number]) {
  const intervention = activeScenarioChange()
  const stop = intervention?.stops[index]
  if (!intervention || !stop) return
  updateScenarioChange(intervention.id, {
    stops: intervention.stops.map((candidateStop, candidateIndex) => {
      if (candidateIndex !== index) return candidateStop
      const addedHere = candidateStop.editStatus === 'inserted' || candidateStop.editStatus === 'added'
      return {
        ...candidateStop,
        stopId: undefined,
        baselineStopId: addedHere ? undefined : candidateStop.baselineStopId ?? candidateStop.stopId,
        coordinate,
        source: 'map',
        editStatus: addedHere ? candidateStop.editStatus : 'replaced',
      }
    }),
  })
}

export function selectScenario(caseId: string) {
  invalidateAnalyzeResult()
  analyze.set({ scenarioStopPlacement: null })
  const { setActiveScenarioId, setActiveScenarioChangeId } = setters()
  setActiveScenarioId(caseId)
  const selected = drafts().cases.find((entry) => entry.id === caseId)
  setActiveScenarioChangeId(selected?.interventions[0]?.id ?? '')
}

export function addScenario(groupId?: string) {
  const { cases, activeCaseId } = drafts()
  const grouping = cityGrouping()
  const targetGroupId = groupId ?? grouping.value.cases[activeCaseId] ?? grouping.value.groups[0]?.id ?? ''
  if (cases.length >= maximumScenarios) return
  invalidateAnalyzeResult()
  const next = newScenario(cases.length, targetGroupId)
  analyze.set({ scenarioStopPlacement: null })
  const { setScenarioDrafts, setActiveScenarioId, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => [...current, next])
  setActiveScenarioId(next.id)
  setActiveScenarioChangeId('')
}

export function removeScenario(caseId: string) {
  const { cases } = drafts()
  if (cases.length <= 1) return
  invalidateAnalyzeResult()
  const next = cases.filter((entry) => entry.id !== caseId)
  analyze.set({ scenarioStopPlacement: null })
  const { setScenarioDrafts, setActiveScenarioId, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => current.filter((entry) => entry.id !== caseId))
  setActiveScenarioId(next[0].id)
  setActiveScenarioChangeId(next[0].interventions[0]?.id ?? '')
}

export function renameScenario(caseId: string, name: string) {
  setters().setScenarioDrafts((current) => current.map((entry) => entry.id === caseId ? { ...entry, name: name.slice(0, 80) } : entry))
}

export function addScenarioChange(kind: ScenarioChangeKind) {
  const scenario = activeScenario()
  if (!scenario || scenario.interventions.length >= 8) return
  invalidateAnalyzeResult()
  const intervention = newScenarioChange(kind)
  analyze.set({ scenarioStopPlacement: null })
  const { setScenarioDrafts, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => current.map((entry) => (
    entry.id === scenario.id
      ? { ...entry, interventions: [...entry.interventions, intervention] }
      : entry
  )))
  setActiveScenarioChangeId(intervention.id)
}

export function updateScenarioChange(interventionId: string, patch: Partial<ScenarioChangeDraft>) {
  invalidateAnalyzeResult()
  const { routes } = preview()
  const currentPreview = preview()
  setters().setScenarioDrafts((current) => current.map((entry) => ({
    ...entry,
    interventions: entry.interventions.map((intervention) => {
      if (intervention.id !== interventionId) return intervention
      const geometryInvalidated = (
        patch.stops !== undefined
        || patch.routeId !== undefined
        || patch.geometryMode !== undefined
        || patch.kind !== undefined
      ) && patch.inferredGeometry === undefined
      const nextIntervention = {
        ...intervention,
        ...patch,
        ...(geometryInvalidated
          ? {
              inferredGeometry: undefined,
              inferredGeometrySource: undefined,
              inferredFallbackSegmentCount: undefined,
              inferredPublishedShapeSegmentCount: undefined,
              inferredOsmSegmentCount: undefined,
              inferredSegmentGeometry: undefined,
              inferredSegmentDistanceKm: undefined,
              inferredSegmentRuntimeMinutes: undefined,
              geometryStatus: 'idle' as const,
              geometryError: undefined,
            }
          : {}),
      }
      if (patch.kind && patch.kind !== intervention.kind) {
        const scenarioRoute = findScenarioRoute(routes, intervention.routeId)
        return {
          ...nextIntervention,
          scheduleMode: patch.kind === 'change-line' ? 'preserve-trips' : 'frequency',
          routeScope: patch.kind === 'add-line' ? undefined : 'pattern' as const,
          bidirectional: patch.kind === 'add-line',
          ...(['add-line', 'change-line'].includes(patch.kind)
            ? { geometryMode: 'auto-road' as const, timeModel: 'infer-road' as const }
            : {}),
          stops: ['change-line', 'enhance-line', 'remove-line'].includes(patch.kind)
            ? scenarioStopsForRoute(scenarioRoute, currentPreview)
            : [],
        }
      }
      return nextIntervention
    }),
  })))
}

export function updateScenarioChangeRoute(interventionId: string, routeId: string) {
  const currentPreview = preview()
  analyze.set({ scenarioStopPlacement: null })
  updateScenarioChange(interventionId, {
    routeId,
    stops: scenarioStopsForRoute(findScenarioRoute(currentPreview.routes, routeId), currentPreview),
  })
}

export async function inferScenarioRoadGeometry(interventionId: string) {
  const intervention = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  if (!intervention || !['add-line', 'change-line', 'enhance-line'].includes(intervention.kind)) return
  const currentPreview = preview()
  const project = selectedProject()
  const { activeFeedId } = city.get()
  const { nationalRoutingFeed } = routingScope()
  const scenarioRoute = findScenarioRoute(currentPreview.routes, intervention.routeId)
  const stops = intervention.stops.length >= 2
    ? intervention.stops
    : scenarioRoute
      ? scenarioStopsForRoute(scenarioRoute, currentPreview)
      : []
  if (stops.length < 2) {
    updateScenarioChange(interventionId, {
      geometryStatus: 'error',
      geometryError: 'Place at least two ordered stops before tracing a road-following path.',
    })
    return
  }
  if (project.osmStreetIndex?.status !== 'ready') {
    updateScenarioChange(interventionId, {
      geometryStatus: 'error',
      geometryError: 'Build the local OSM street index before tracing a road-following path.',
    })
    return
  }
  const feedId = activeFeedId === bundleFeedId
    ? scenarioRoute ? entityFeedScope(scenarioRoute.id) || nationalRoutingFeed?.id : nationalRoutingFeed?.id
    : activeFeedId
  if (!feedId) {
    updateScenarioChange(interventionId, {
      geometryStatus: 'error',
      geometryError: 'Choose a ready GTFS feed before tracing a route.',
    })
    return
  }
  invalidateAnalyzeResult()
  // Bind to this City's drafts: a late answer must not edit another City.
  const { setScenarioDrafts } = setters()
  const controller = createScenarioRoadGeometryRequest(interventionId, setScenarioDrafts)
  scenarioRoadGeometryAbort = controller
  const requestId = scenarioRoadGeometryRequestId + 1
  scenarioRoadGeometryRequestId = requestId
  const fallbackGeometry = routeHasPublishedShape(scenarioRoute) ? scenarioRoute.coordinates : undefined
  const fallbackSegmentRuntimeMinutes = scenarioRoute
    ? scenarioSegmentRuntimeMinutes(scenarioRoute, stops, currentPreview)
    : undefined
  const publishedShapeSegmentIndexes = scenarioPublishedShapeSegmentIndexes(scenarioRoute, stops)
  setScenarioDrafts((current) => current.map((entry) => ({
    ...entry,
    interventions: entry.interventions.map((candidate) => candidate.id === interventionId
      ? { ...candidate, geometryStatus: 'loading', geometryError: '' }
      : candidate),
  })))
  try {
    const result = await apiJson<{
      geometry: {
        status: 'ready' | 'blocked'
        segments?: Array<{
          coordinates?: [number, number][]
          distanceKm?: number
          durationMinutes?: number
          source?: 'osm_drive' | 'published_shape' | 'published_shape_fallback'
        }>
        snappedCoordinates?: [number, number][]
        detail?: string
        fallbackUsed?: boolean
        fallbackSegmentCount?: number
        publishedShapeSegmentCount?: number
        osmSegmentCount?: number
      }
    }>(
      `/api/projects/${encodeURIComponent(project.id)}/scenario-road-geometry`,
      {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          feedId,
          maxStreetKm: 100,
          points: stops.map((stop) => ({ coordinate: stop.coordinate, label: stop.label })),
          ...(fallbackGeometry ? { fallbackGeometry } : {}),
          ...(fallbackSegmentRuntimeMinutes ? { fallbackSegmentRuntimeMinutes } : {}),
          ...(publishedShapeSegmentIndexes.length ? { publishedShapeSegmentIndexes } : {}),
        }),
      },
    )
    if (controller.signal.aborted || scenarioRoadGeometryRequestId !== requestId) return
    const geometry = result.geometry
    const segments = Array.isArray(geometry?.segments) ? geometry.segments : []
    if (geometry?.status !== 'ready' || segments.length !== stops.length - 1) {
      throw new Error(geometry?.detail ?? 'The OSM street network could not connect every ordered stop.')
    }
    const inferredGeometry = joinScenarioSegmentGeometry(segments.map((segment) => segment.coordinates ?? []))
    const hasOsmSegments = segments.some((segment) => segment.source === 'osm_drive')
    const hasShapeSegments = segments.some((segment) => (
      segment.source === 'published_shape' || segment.source === 'published_shape_fallback'
    ))
    const snappedCoordinates = Array.isArray(geometry.snappedCoordinates)
      ? geometry.snappedCoordinates
      : []
    setScenarioDrafts((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((candidate) => candidate.id === interventionId
        ? {
            ...candidate,
            stops: candidate.stops.length >= 2
              ? candidate.stops.map((stop, index) => snappedCoordinates[index]?.length === 2
                ? { ...stop, coordinate: snappedCoordinates[index] }
                : stop)
              : candidate.stops,
            inferredGeometry,
            inferredSegmentGeometry: segments.map((segment) => segment.coordinates ?? []),
            inferredGeometrySource: hasOsmSegments && hasShapeSegments
              ? 'hybrid'
              : hasShapeSegments
                ? 'published_shape_fallback'
                : 'osm_drive',
            inferredFallbackSegmentCount: Number(
              geometry.fallbackSegmentCount
                ?? segments.filter((segment) => segment.source === 'published_shape_fallback').length,
            ),
            inferredPublishedShapeSegmentCount: Number(
              geometry.publishedShapeSegmentCount
                ?? segments.filter((segment) => segment.source === 'published_shape').length,
            ),
            inferredOsmSegmentCount: Number(
              geometry.osmSegmentCount
                ?? segments.filter((segment) => segment.source === 'osm_drive').length,
            ),
            inferredSegmentDistanceKm: segments.map((segment) => Number(segment.distanceKm ?? 0)),
            inferredSegmentRuntimeMinutes: segments.map((segment) => Number(segment.durationMinutes ?? 0)),
            geometryStatus: 'ready',
            geometryError: '',
          }
        : candidate),
    })))
  } catch (error) {
    if (controller.signal.aborted || scenarioRoadGeometryRequestId !== requestId) return
    const message = error instanceof Error ? error.message : 'OSM road inference failed.'
    setScenarioDrafts((current) => current.map((entry) => ({
      ...entry,
      interventions: entry.interventions.map((candidate) => candidate.id === interventionId
        ? { ...candidate, geometryStatus: 'error', geometryError: message }
        : candidate),
    })))
  } finally {
    if (scenarioRoadGeometryAbort === controller) scenarioRoadGeometryAbort = null
  }
}

export function beginScenarioStopPlacement(interventionId: string, mode: ScenarioStopPlacement['mode'], index: number) {
  if (!analyze.get().analysisOrigin) return
  analyze.set({ scenarioStopPlacement: { interventionId, mode, index } })
}

export const cancelScenarioStopPlacement = () => analyze.set({ scenarioStopPlacement: null })

export function selectScenarioChange(interventionId: string) {
  analyze.set({ scenarioStopPlacement: null })
  setters().setActiveScenarioChangeId(interventionId)
}

export function removeScenarioStop(interventionId: string, index: number) {
  const intervention = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  if (!intervention || intervention.stops.length <= 2 || !intervention.stops[index]) return
  analyze.set({ scenarioStopPlacement: null })
  updateScenarioChange(interventionId, {
    stops: intervention.stops.filter((_, stopIndex) => stopIndex !== index),
  })
}

export function resetScenarioRouteStops(interventionId: string) {
  const intervention = activeScenario()?.interventions.find((entry) => entry.id === interventionId)
  if (!intervention?.routeId) return
  const currentPreview = preview()
  analyze.set({ scenarioStopPlacement: null })
  updateScenarioChange(interventionId, {
    stops: scenarioStopsForRoute(findScenarioRoute(currentPreview.routes, intervention.routeId), currentPreview),
  })
}

export function clearScenarioSketch(interventionId: string) {
  analyze.set({ scenarioStopPlacement: null })
  updateScenarioChange(interventionId, { stops: [] })
}

export function removeScenarioChange(interventionId: string) {
  invalidateAnalyzeResult()
  analyze.set({ scenarioStopPlacement: null })
  const scenario = activeScenario()
  const remaining = scenario?.interventions.filter((entry) => entry.id !== interventionId) ?? []
  const { setScenarioDrafts, setActiveScenarioChangeId } = setters()
  setScenarioDrafts((current) => current.map((entry) => (
    entry.id === scenario?.id
      ? { ...entry, interventions: entry.interventions.filter((change) => change.id !== interventionId) }
      : entry
  )))
  setActiveScenarioChangeId(remaining[0]?.id ?? '')
}

/** The active case as engine services, or the first edit that cannot run yet. */
export function activeScenarioDraft() { return scenarioRequestFor(activeScenario()) }

export function scenarioRequestFor(scenario: ScenarioDraft | undefined) {
  const currentPreview = preview()
  const serviceDate = clock.get().serviceDate
  const services: ScenarioServiceDraft[] = []
  const excludedRouteIds: string[] = []
  const excludedPatternIds: Array<{ routeId: string; patternId: string }> = []
  const serviceFor = (
    intervention: ScenarioChangeDraft,
    scenarioRoute: RouteMetric | undefined,
    stops: ScenarioStopDraft[],
    serviceId: string,
    serviceName: string,
  ): ScenarioServiceDraft => {
    const geometryMode: ScenarioGeometryMode = intervention.geometryMode
      ?? (intervention.timeModel === 'infer-road'
        ? 'auto-road'
        : intervention.timeModel === 'estimate-distance'
          ? 'straight-line'
          : scenarioRoute ? 'published-shape' : 'straight-line')
    const timeModel: ScenarioTimeModel = geometryMode === 'auto-road'
      ? 'infer-road'
      : geometryMode === 'straight-line'
        ? 'estimate-distance'
        : 'preserve-scheduled'
    const inferredReady = intervention.geometryStatus === 'ready'
      && Array.isArray(intervention.inferredGeometry)
      && intervention.inferredGeometry.length >= 2
    const geometry = geometryMode === 'auto-road'
      ? inferredReady
        ? intervention.inferredGeometry
        : undefined
      : geometryMode === 'straight-line'
        ? stops.map((stop) => stop.coordinate)
        : routeHasPublishedShape(scenarioRoute)
          ? scenarioRoute.coordinates
          : undefined
    const segmentDistancesKm = inferredReady
      ? intervention.inferredSegmentDistanceKm
      : undefined
    return {
      id: serviceId,
      name: serviceName,
      operation: intervention.kind === 'add-line'
        ? 'add'
        : intervention.kind === 'change-line'
          ? 'replace'
          : 'augment',
      scheduleMode: intervention.kind === 'change-line' ? intervention.scheduleMode ?? 'preserve-trips' : 'frequency',
      sourceRouteId: scenarioRoute ? scenarioSourceRouteId(scenarioRoute) : undefined,
      sourcePatternId: scenarioRoute?.patternId ?? scenarioRoute?.id,
      // Each exact-edge branch replacement is hydrated and excluded by its
      // own GTFS pattern. The UI-level edge scope is expanded below.
      routeScope: intervention.routeScope === 'edge' ? 'pattern' : intervention.routeScope,
      timeModel,
      bidirectional: intervention.routeScope === 'edge'
        || (intervention.kind === 'change-line' && intervention.scheduleMode !== 'frequency')
        ? false : intervention.bidirectional,
      headwayMinutes: intervention.headwayMinutes,
      startMinutes: intervention.startMinutes,
      endMinutes: intervention.endMinutes,
      averageSpeedKph: intervention.averageSpeedKph,
      dwellMinutes: 0.35,
      ...(segmentDistancesKm ? { segmentDistancesKm } : {}),
      ...(scenarioRoute && (timeModel === 'preserve-scheduled' || timeModel === 'infer-road')
        ? {
            segmentRuntimeMinutes: scenarioSegmentRuntimeMinutes(scenarioRoute, stops, currentPreview, {
              segmentDistancesKm,
            }),
            addedStopDwellMinutes: timeModel === 'infer-road' ? 0.35 : 0,
          }
        : {}),
      ...(geometry && geometry.length >= 2
        ? {
            geometry,
            geometrySource: geometryMode === 'auto-road'
              ? intervention.inferredGeometrySource === 'published_shape_fallback'
                ? 'shape' as const
                : 'osm_drive' as const
              : geometryMode === 'straight-line'
                ? 'stop_sequence' as const
                : scenarioRoute?.geometrySource ?? 'shape' as const,
          }
        : {}),
      stops,
    }
  }
  for (const intervention of scenario?.interventions ?? []) {
    const scenarioRoute = findScenarioRoute(currentPreview.routes, intervention.routeId)
    if (intervention.kind !== 'add-line' && !scenarioRoute) {
      return { error: `Choose a route for ${intervention.name}.` }
    }
    const sourceRouteId = scenarioRoute ? scenarioSourceRouteId(scenarioRoute) : undefined
    const routeScope: ScenarioRouteScope = intervention.routeScope ?? 'pattern'
    if (['remove-line', 'change-line'].includes(intervention.kind) && sourceRouteId) {
      if (routeScope === 'route') {
        excludedRouteIds.push(sourceRouteId)
      } else if (scenarioRoute?.patternId ?? scenarioRoute?.id) {
        if (intervention.kind === 'remove-line') {
          excludedPatternIds.push({
            routeId: sourceRouteId,
            patternId: scenarioRoute.patternId ?? scenarioRoute.id,
          })
        }
      }
    }
    if (intervention.kind === 'remove-line') continue
    if (intervention.geometryMode === 'auto-road' && intervention.geometryStatus !== 'ready') {
      return { error: `Build the road-following path for ${intervention.name} before running Reach, or choose Straight-line estimate.` }
    }
    const stops = ['add-line', 'change-line'].includes(intervention.kind)
      ? intervention.stops
      : scenarioStopsForRoute(scenarioRoute, currentPreview)
    if (stops.length < 2) {
      return { error: `${intervention.name} needs at least two ordered GTFS or placed stops.` }
    }
    if (routeScope === 'edge' && intervention.kind === 'change-line') {
      if (!scenarioRoute) return { error: `${intervention.name} needs a selected GTFS branch before applying an exact edge edit.` }
      const edgeRoute = scenarioRoute
      const edgeError = scenarioEdgeEditError(edgeRoute, stops)
      if (edgeError) return { error: `${intervention.name}: ${edgeError}` }
      const edgeEdit = scenarioInsertedStopsForEdge(stops)
      if (!edgeEdit) {
        return { error: `${intervention.name} needs one or more inserted stops anchored between an exact ordered A → B GTFS edge.` }
      }
      const serviceBranches = currentPreview.routes
        .filter((candidate) => scopedRouteServiceKey(candidate) === scopedRouteServiceKey(edgeRoute))
      if (serviceBranches.length !== edgeRoute.serviceVariantCount
        || serviceBranches.some((candidate) => candidate.analysisSource !== 'focused'
          || candidate.analysisServiceDate !== serviceDate)) {
        return { error: `Load every GTFS branch of ${edgeRoute.shortName} for ${serviceDate} before applying an exact-edge edit.` }
      }
      const matchingBranches = serviceBranches.filter((candidate) => (
        scenarioEdgeIndexes(candidate, edgeEdit.beforeStopId, edgeEdit.afterStopId).length > 0
      ))
      if (!matchingBranches.length) {
        return { error: `No GTFS branch in ${edgeRoute.shortName} serves the exact ordered ${edgeEdit.beforeStopId} → ${edgeEdit.afterStopId} edge.` }
      }
      for (const branch of matchingBranches) {
        const branchStops = scenarioStopsForEdgeBranch(intervention, branch, currentPreview)
        if (branchStops.length < 2) {
          return { error: `Load the complete ordered stops for ${branch.shortName} · Pattern ${branch.patternRank ?? branch.id} before applying this edge edit.` }
        }
        const branchGeometry = intervention.geometryMode === 'auto-road'
          ? scenarioEdgeGeometryForBranch(intervention, branch, currentPreview)
          : undefined
        if (intervention.geometryMode === 'auto-road' && !branchGeometry) {
          return { error: `The edited road gap cannot be applied to ${branch.shortName} · ${branch.patternRank ?? branch.id}. Load its complete published shape and rebuild the road path.` }
        }
        services.push(serviceFor(
          branchGeometry ? { ...intervention, inferredGeometry: branchGeometry.geometry,
            inferredSegmentDistanceKm: branchGeometry.segmentDistancesKm, inferredGeometrySource: 'hybrid' } : intervention,
          branch,
          branchStops,
          `${intervention.id}:${branch.id}`,
          `${intervention.name} · ${branch.directionId || 'branch'} · ${branch.patternRank ?? branch.id}`,
        ))
      }
      continue
    }
    services.push(serviceFor(
      intervention,
      scenarioRoute,
      stops,
      intervention.id,
      intervention.name,
    ))
  }
  return {
    scenario: {
      id: scenario?.id ?? 'baseline-only',
      name: scenario?.name ?? 'Baseline',
      services,
      excludedRouteIds: [...new Set(excludedRouteIds)],
      excludedPatternIds,
    },
  }
}

export function comparisonRequestBody(variant: CompareVariant, reference: CompareVariant, includeStreetEdges: boolean) {
  const { analysisOrigin, reachMaxWalkKm, reachMaxTransfers, reachSurfaceSampling, scenarioWalkSpeedKph, scenarioCutoffMinutes } = analyze.get()
  const { scheduleTimeMinutes } = clock.get()
  const routingServiceDate = clock.get().serviceDate
  const routingServiceDay = serviceDay()
  return {
    feedIds: variant.feedIds,
    ...(reference.feedIds.join() !== variant.feedIds.join() ? { baselineFeedIds: reference.feedIds } : {}),
    origin: analysisOrigin,
    departMinutes: scheduleTimeMinutes,
    serviceDate: routingServiceDate,
    serviceDay: routingServiceDay,
    maxWalkKm: reachMaxWalkKm,
    maxTransfers: reachMaxTransfers,
    walkSpeedKph: reachSurfaceSampling === 'cell-center' ? 4.8 : scenarioWalkSpeedKph,
    surfaceSampling: reachSurfaceSampling,
    rasterSize: reachSurfaceSampling === 'street' ? desktopStreetReachRasterSize : desktopReachRasterSize,
    cutoffsMinutes: [scenarioCutoffMinutes],
    includePreliminary: false,
    includeStreetEdges,
    payload: 'compact',
    scenario: variant.scenario ?? { id: variant.id, name: variant.label, services: [], excludedRouteIds: [] },
  }
}

export async function runComparison(includeStreetEdges = analyze.get().scenarioRenderMode === 'streets') {
  const { analysisOrigin, scenarioCutoffMinutes, compareReferenceId } = analyze.get()
  const { scheduleTimeMinutes } = clock.get()
  const routingServiceDate = clock.get().serviceDate
  const selectedProjectValue = selectedProject()
  const compareReferenceOptionsValue = compareReferenceOptions()
  const reference = compareReferenceOptionsValue.find((option) => option.id === compareReferenceId) ?? compareReferenceOptionsValue[0]
  if (!analysisOrigin || !reference) return
  const selection = compareVariantSelection()
  if (!selection.variants.length) {
    analyze.set({ scenarioError: selection.errors[0] ?? 'Choose at least one scenario or timetable to compare.' })
    return
  }
  analysisAbort?.abort()
  const controller = new AbortController()
  analysisAbort = controller
  const progress = new Array(selection.variants.length + 1).fill(0)
  const post = (variant: CompareVariant, index: number) => apiProgressJson<{ result: ReachResult }>(
    `/api/projects/${encodeURIComponent(selectedProjectValue.id)}/reach`,
    { method: 'POST', signal: controller.signal, body: JSON.stringify(comparisonRequestBody(variant, reference, includeStreetEdges)) },
    (update) => {
      progress[index] = Math.max(progress[index], Math.min(1, Number(update.progress ?? progress[index])))
      analyze.set({ scenarioProgress: {
        phase: index ? `${variant.label} · ${update.phase}` : `Reference · ${update.phase}`,
        progress: progress.reduce((total, value) => total + value, 0) / progress.length,
        detail: update.detail,
      } })
    },
  )
  analyze.set({ scenarioLoading: true })
  analyze.set({ scenarioProgress: { phase: 'comparison', progress: 0, detail: `Measuring ${reference.label}` } })
  analyze.set({ scenarioError: '' })
  analyze.set({ reachResult: null })
  analyze.set({ comparisonRun: null })
  try {
    // Sent together: the Studio Engine computes the shared reference surface once.
    const [referenceOutcome, ...settled] = await Promise.allSettled([
      post(reference, 0),
      ...selection.variants.map((variant, index) => post(variant, index + 1)),
    ])
    if (controller.signal.aborted) return
    if (referenceOutcome.status === 'rejected') throw referenceOutcome.reason
    const referenceResult = inflateReachResult(referenceOutcome.value.result)
    let best: { id: string; result: ReachResult; gain: number } | null = null
    const entries: CompareEntry[] = selection.variants.map((variant, index) => {
      const outcome = settled[index]
      if (outcome.status === 'rejected') {
        return { variant, stats: null, error: outcome.reason instanceof Error ? outcome.reason.message : 'This variant could not be measured.' }
      }
      const result = inflateReachResult(outcome.value.result)
      const stats = compareStats(result, scenarioCutoffMinutes)
      if (!best || stats.areaDeltaKm2 > best.gain) best = { id: variant.id, result, gain: stats.areaDeltaKm2 }
      return { variant, stats }
    })
    const shown = best as { id: string; result: ReachResult; gain: number } | null
    analyze.set({ comparisonRun: {
      reference: {
        ...reference,
        areaKm2: scenarioReachedAreaKm2(referenceResult, 'baseline', scenarioCutoffMinutes),
        stops: reachTransitStops(referenceResult, 'baseline', scenarioCutoffMinutes),
      },
      cutoffMinutes: scenarioCutoffMinutes,
      serviceDate: routingServiceDate,
      departMinutes: scheduleTimeMinutes,
      entries: [
        ...entries,
        ...selection.errors.map((error, index) => ({ variant: { id: `invalid-${index}`, label: error.split(':')[0], kind: 'scenario' as const, detail: '', feedIds: [] }, stats: null, error })),
      ],
      selectedId: shown?.id ?? '',
    } })
    analyze.set({ reachResult: shown?.result ?? referenceResult })
    analyze.set({ scenarioView: shown ? 'comparison' : 'baseline' })
  } catch (error) {
    if (controller.signal.aborted) return
    analyze.set({ scenarioError: error instanceof Error ? error.message : 'Comparison failed.' })
  } finally {
    if (analysisAbort === controller) {
      analysisAbort = null
      analyze.set({ scenarioLoading: false })
      analyze.set({ scenarioProgress: null })
    }
  }
}

export async function selectComparisonVariant(variantId: string, includeStreetEdges = analyze.get().scenarioRenderMode === 'streets') {
  const { analysisOrigin, comparisonRun } = analyze.get()
  const selectedProjectValue = selectedProject()
  const run = comparisonRun
  const entry = run?.entries.find((candidate) => candidate.variant.id === variantId)
  if (!run || !entry?.stats || !analysisOrigin) return
  analysisAbort?.abort()
  const controller = new AbortController()
  analysisAbort = controller
  analyze.set({ comparisonRun: { ...run, selectedId: variantId } })
  analyze.set({ scenarioLoading: true })
  analyze.set({ scenarioError: '' })
  try {
    const response = await apiProgressJson<{ result: ReachResult }>(
      `/api/projects/${encodeURIComponent(selectedProjectValue.id)}/reach`,
      { method: 'POST', signal: controller.signal, body: JSON.stringify(comparisonRequestBody(entry.variant, run.reference, includeStreetEdges)) },
      (scenarioProgress) => analyze.set({ scenarioProgress }),
    )
    if (controller.signal.aborted) return
    analyze.set({ reachResult: inflateReachResult(response.result) })
    analyze.set({ scenarioView: 'comparison' })
  } catch (error) {
    if (controller.signal.aborted) return
    analyze.set({ scenarioError: error instanceof Error ? error.message : 'This variant could not be shown.' })
  } finally {
    if (analysisAbort === controller) {
      analysisAbort = null
      analyze.set({ scenarioLoading: false })
      analyze.set({ scenarioProgress: null })
    }
  }
}

export function compareVariantSelection() {
  const { compareReferenceId, comparisonFeedIds } = analyze.get()
  const selectedProjectValue = selectedProject()
  const scenarioDrafts = scenarioLibrary().scenarioDrafts
  const cityDataGroups = cityGrouping()
  const comparisonFeedOptionsValue = comparisonFeedOptions()
  const compareScenarioIdsValue = compareScenarioIds()
  const variants: CompareVariant[] = []
  const errors: string[] = []
  for (const entry of scenarioDrafts.filter((candidate) => compareScenarioIdsValue.includes(candidate.id))) {
    const selection = caseFeedSelection(cityDataGroups.value, entry.id, selectedProjectValue)
    const draft = scenarioRequestFor(entry)
    const error = selection.error || ('error' in draft ? draft.error ?? 'Finish its changes first.' : '')
    if (error || !('scenario' in draft)) {
      errors.push(`${entry.name}: ${error}`)
      continue
    }
    variants.push({
      id: `scenario:${entry.id}`, label: entry.name, kind: 'scenario', feedIds: [...selection.feedIds].sort(),
      detail: `${selection.group?.name ?? 'Timetables'} · ${entry.interventions.length ? `${entry.interventions.length} change${entry.interventions.length === 1 ? '' : 's'}` : 'no changes'}`,
      scenario: draft.scenario,
    })
  }
  if (comparisonFeedOptionsValue.length > 1) {
    for (const feed of comparisonFeedOptionsValue.filter((candidate) => comparisonFeedIds.includes(candidate.id))) {
      if (`timetable:${feed.id}` === compareReferenceId) continue
      variants.push({ id: `timetable:${feed.id}`, label: feed.name, kind: 'timetable', detail: `${formatNumber(feed.routeCount)} routes · ${formatNumber(feed.stopCount)} stops`, feedIds: [feed.id] })
    }
  }
  return { variants, errors }
}

export async function runServiceDecomposition() {
  const { comparisonFeedIds } = analyze.get()
  if (comparisonFeedIds.length !== 2) {
    analyze.set({ serviceDecompositionError: 'Select exactly two GTFS feeds for street-service comparison.' })
    return
  }
  const [baselineFeedId, comparisonFeedId] = comparisonFeedIds
  const project = selectedProject()
  const selectedFeeds = comparisonFeedIds.map((feedId) => project.feeds.find((feed) => feed.id === feedId))
  if (selectedFeeds.some((feed) => !feed || feed.routingStore?.status !== 'ready')) {
    analyze.set({ serviceDecompositionError: 'Both selected GTFS feeds need ready SQLite routing stores.' })
    return
  }
  if (project.osmStreetIndex?.status !== 'ready') {
    analyze.set({ serviceDecompositionError: 'Build the local OSM street index before comparing service edges.' })
    return
  }

  serviceDecompositionAbort?.abort()
  const controller = new AbortController()
  serviceDecompositionAbort = controller
  analyze.set({ serviceDecompositionLoading: true, serviceDecompositionError: '' })
  try {
    const result = await apiJson<{ decomposition: ServiceEdgeDecomposition }>(
      `/api/projects/${encodeURIComponent(project.id)}/service-edge-decomposition`,
      {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ baselineFeedId, comparisonFeedId }),
      },
    )
    if (controller.signal.aborted) return
    analyze.set({ serviceDecomposition: result.decomposition })
  } catch (error) {
    if (controller.signal.aborted) return
    analyze.set({
      serviceDecomposition: null,
      serviceDecompositionError: error instanceof Error ? error.message : 'Street-service comparison failed.',
    })
  } finally {
    if (serviceDecompositionAbort === controller) {
      serviceDecompositionAbort = null
      analyze.set({ serviceDecompositionLoading: false })
    }
  }
}

export async function runSurfaceAnalysis(includeStreetEdges = analyze.get().scenarioRenderMode === 'streets') {
  const settings = analyze.get()
  const { analysisOrigin } = settings
  if (!analysisOrigin || !routingScope().nationalRoutingFeed) return
  const project = selectedProject()
  const grouping = cityGrouping()
  const selection = caseFeedSelection(grouping.value, drafts().activeCaseId, project)
  if (grouping.readFailed || selection.error) {
    analyze.set({ scenarioError: grouping.error || selection.error })
    return
  }
  const draft = activeScenarioDraft()
  if ('error' in draft) {
    analyze.set({ scenarioError: draft.error ?? 'Configure the active case before running it.' })
    return
  }
  const baselineGroup = grouping.value.groups.find(group => group.id === baselineGroupId)
  const baselineFeeds = baselineGroup && !caseFeedSelection({ ...grouping.value, cases: { baseline: baselineGroupId } }, 'baseline', project).error
    ? [...new Set(baselineGroup.feedIds)].sort() : null
  const { scheduleTimeMinutes, serviceDate } = clock.get()
  const interventionCount = activeScenario()?.interventions.length ?? 0
  analysisAbort?.abort()
  const controller = new AbortController()
  analysisAbort = controller
  analyze.set({
    scenarioLoading: true,
    scenarioProgress: { phase: 'preparation', progress: 0, detail: 'Starting network Reach' },
    scenarioError: '',
    comparisonRun: null,
  })
  try {
    const response = await apiProgressJson<{ result: ReachResult }>(
      `/api/projects/${encodeURIComponent(project.id)}/reach`,
      {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          feedIds: selection.feedIds,
          ...(baselineFeeds && baselineFeeds.join() !== [...selection.feedIds].sort().join() ? { baselineFeedIds: baselineFeeds } : {}),
          origin: analysisOrigin,
          departMinutes: scheduleTimeMinutes,
          serviceDate,
          serviceDay: serviceDay(),
          maxWalkKm: settings.reachMaxWalkKm,
          maxTransfers: settings.reachMaxTransfers,
          walkSpeedKph: settings.reachSurfaceSampling === 'cell-center' ? 4.8 : settings.scenarioWalkSpeedKph,
          surfaceSampling: settings.reachSurfaceSampling,
          rasterSize: settings.reachSurfaceSampling === 'street' ? desktopStreetReachRasterSize : desktopReachRasterSize,
          cutoffsMinutes: reachTimeBands(settings.scenarioCutoffMinutes),
          // The final baseline surface is rendered after transit/routing
          // seeds are known. Avoid spending a second full OSM traversal on
          // a provisional walk-only surface for every scenario run.
          includePreliminary: false,
          includeStreetEdges,
          payload: 'compact',
          scenario: draft.scenario,
        }),
      },
      (scenarioProgress) => analyze.set({ scenarioProgress }),
      (preliminary) => analyze.set({ reachResult: preliminary.result }),
    )
    if (controller.signal.aborted) return
    analyze.set({ reachResult: inflateReachResult(response.result), scenarioView: interventionCount ? 'comparison' : 'baseline' })
  } catch (error) {
    if (controller.signal.aborted) return
    analyze.set({ scenarioError: error instanceof Error ? error.message : 'Analysis failed.' })
  } finally {
    if (analysisAbort === controller) {
      analysisAbort = null
      analyze.set({ scenarioLoading: false, scenarioProgress: null })
    }
  }
}

export function cancelSurfaceAnalysis() {
  analysisAbort?.abort()
  analysisAbort = null
  analyze.set({ scenarioLoading: false, scenarioProgress: null })
}

// Analyze panel settings. A changed question clears the shown result.
export function changeSurfaceSampling(reachSurfaceSampling: AnalyzeState['reachSurfaceSampling']) {
  analyze.set({ reachSurfaceSampling })
  invalidateAnalyzeResult()
}

export function changeAnalysisServiceDate(serviceDate: string) {
  changeServiceDate(serviceDate)
  invalidateAnalyzeResult()
}

export function changeAnalysisDepartMinutes(scheduleTimeMinutes: number) {
  clock.set({ scheduleTimeMinutes })
  invalidateAnalyzeResult()
}

export function changeReachMaxWalkKm(reachMaxWalkKm: number) {
  analyze.set({ reachMaxWalkKm })
  invalidateAnalyzeResult()
}

export function changeReachMaxTransfers(reachMaxTransfers: number | undefined) {
  analyze.set({ reachMaxTransfers })
  invalidateAnalyzeResult()
}

export function changeWalkSpeed(scenarioWalkSpeedKph: number) {
  analyze.set({ scenarioWalkSpeedKph })
  invalidateAnalyzeResult()
}

export function changeCutoff(scenarioCutoffMinutes: number) {
  analyze.set({ scenarioCutoffMinutes })
  const { comparisonRun, reachResult } = analyze.get()
  const results = reachResult ? [reachResult] : []
  // A result already banded at this budget can be redrawn without a new run.
  if (!results.length || results.some((result) => !result.request.cutoffsMinutes.includes(scenarioCutoffMinutes)) || (comparisonRun && comparisonRun.cutoffMinutes !== scenarioCutoffMinutes)) {
    invalidateAnalyzeResult()
  }
}

export function changeRenderMode(mode: ScenarioRenderMode) {
  const { scenarioRenderMode, analyzeMode, scenarioLoading, comparisonRun, reachResult } = analyze.get()
  if (mode === scenarioRenderMode) return
  analyze.set({ scenarioRenderMode: mode })
  if (mode !== 'streets') return
  // Street rendering needs edge geometry; rerun a result computed without it.
  if (analyzeMode !== 'single') {
    if (comparisonRun?.selectedId && reachResult && !reachResult.surface.edges) {
      void selectComparisonVariant(comparisonRun.selectedId, true)
    }
  } else if (scenarioLoading || (reachResult && !reachResult.surface.edges)) {
    void runSurfaceAnalysis(true)
  }
}

export function changeAnalyzeMode(analyzeMode: AnalyzeMode) {
  invalidateAnalyzeResult()
  analyze.set({ analyzeMode })
}

export function toggleComparisonFeed(feedId: string, selected: boolean) {
  invalidateAnalyzeResult()
  analyze.set(({ comparisonFeedIds: current }) => ({
    comparisonFeedIds: selected
      ? current.includes(feedId) ? current : [...current, feedId]
      : current.filter((candidate) => candidate !== feedId),
  }))
}

export const setScenarioView = (scenarioView: ScenarioView) => analyze.set({ scenarioView })

export function setAnalysisOrigin(point: RoutingPoint | null) {
  invalidateAnalyzeResult()
  analyze.set({ scenarioStopPlacement: null, analysisOrigin: point })
}

/** Open a case from City data in the Analyze workspace. */
export function openScenarioCase(caseId: string) {
  selectScenario(caseId)
  setActiveFeedId(bundleFeedId)
  analyze.set({ analyzeMode: 'single' })
  openAnalyzeView()
}

const referenceOptionsOf = memoizeLast((groups: CityDataGroups['groups'], feeds: ComparisonFeedOption[]): CompareVariant[] => [
  ...groups.map(group => ({ id: `group:${group.id}`, label: group.name, kind: 'group' as const, feedIds: [...new Set(group.feedIds)].sort(), detail: `${group.feedIds.length} timetables` })),
  ...(feeds.length > 1 ? feeds.map(feed => ({ id: `timetable:${feed.id}`, label: feed.name, kind: 'timetable' as const, feedIds: [feed.id], detail: 'One timetable' })) : []),
])
export const compareReferenceOptions = () => referenceOptionsOf(cityGroupsValue().groups, comparisonFeedOptions())
const scenarioIdsOf = memoizeLast((selection: string[] | null, cases: ScenarioDraft[]) => selection ?? cases.filter(s => s.interventions.length || (s.groupId && s.groupId !== baselineGroupId)).map(s => s.id))
export const compareScenarioIds = () => scenarioIdsOf(analyze.get().compareScenarioSelection, drafts().cases)
export function changeCompareReference(compareReferenceId: string) { invalidateAnalyzeResult(); analyze.set({ compareReferenceId }) }
export function toggleCompareScenario(id: string, selected: boolean) {
  const ids = compareScenarioIds()
  invalidateAnalyzeResult()
  analyze.set({ compareScenarioSelection: selected ? [...new Set([...ids, id])] : ids.filter(candidate => candidate !== id) })
}
export function assignScenarioGroup(id: string, groupId: string) { invalidateAnalyzeResult(); cityGrouping().assignCase(id, groupId) }
