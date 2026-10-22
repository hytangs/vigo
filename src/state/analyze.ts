import { apiJson, apiProgressJson, type ApiProgress } from '../app/api'
import { createStore, memoizeLast } from '../app/store'
import { caseFeedSelection, type CityDataGroups } from '../app/cityDataGroups'
import { baselineGroupId, scenarioNetworkDiffers } from '../app/scenarioLibrary'
import { compareStats, type CompareVariant, type CompareEntry, type ComparisonRun } from '../app/comparison'
import { reachTransitStops } from '../app/resultSummary'
import type { useReachInspection } from '../app/useReachInspection'
import type { AnalyzeMode, ComparisonFeedOption } from '../components/AnalyzePanel'
import { quietMapLabel } from '../components/studio/presentation'
import { formatNumber, type VigoProject } from '../domain'
import {
  inflateReachResult,
  reachTimeBands,
  scenarioReachedAreaKm2,
  type ReachResult,
  type ScenarioDraft,
  type ScenarioRenderMode,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from '../reach'
import type { RoutingPoint, RoutingTimePreference } from '../routingModel'
import { buildRoutingPointFromMap } from '../routingUi'
import { changeServiceDate, clock, serviceDay } from './clock'
import { route } from './route'
import { scenarioRequestFor } from './scenarioRequest'
import { activeScenario, cityGrouping, cityGroupsValue, scenarioLibrary, scenarioValues } from './scenarios'
import { routingScope, selectedProject } from './scope'
import { shell } from './shell'

const desktopReachRasterSize = 128
const desktopStreetReachRasterSize = 384

export type ReachInspection = ReturnType<typeof useReachInspection>

/** Analyze workspace: the Reach origin, run settings, cases and their results. */
export type AnalyzeState = {
  /** The Reach place: the origin, or the destination of an arrive-by Reach. */
  analysisOrigin: RoutingPoint | null
  /** Leave at the clock time, or arrive at the place by it. */
  reachTimePreference: RoutingTimePreference
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
  reachTravelMode: 'transit' | 'drive'
  reachSurfaceSampling: 'street' | 'cell-center'
  scenarioView: ScenarioView
  scenarioRenderMode: ScenarioRenderMode
  comparisonFeedIds: string[]
  /** The clicked point's journey (see AnalyzeRuntime). */
  inspection: ReachInspection | null
}

const initialAnalyzeState = (): AnalyzeState => ({
  analysisOrigin: null,
  reachTimePreference: 'depart',
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
  reachTravelMode: 'transit',
  reachSurfaceSampling: 'street',
  scenarioView: 'comparison',
  scenarioRenderMode: 'area',
  comparisonFeedIds: [],
  inspection: null,
})

export const analyze = createStore<AnalyzeState>(initialAnalyzeState())

/** Whether a map click in Reach places its origin (or arrive-by destination). */
export function scenarioPointPicking() {
  return shell.get().activeRouteTool === 'analyze' && !analyze.get().analysisOrigin
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
let serviceDecompositionAbort: AbortController | null = null
let comparisonFeedsInitialized = false

export function invalidateAnalyzeResult() {
  analysisAbort?.abort()
  analysisAbort = null
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
  serviceDecompositionAbort?.abort()
  analysisAbort = serviceDecompositionAbort = null
  comparisonFeedsInitialized = false
  analyze.set(initialAnalyzeState())
}

export function clearAnalysisState() {
  invalidateAnalyzeResult()
  comparisonFeedsInitialized = false
  analyze.set({ comparisonFeedIds: [], compareReferenceId: 'group:baseline', compareScenarioSelection: null, analysisOrigin: null })
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
  if (shell.get().activeRouteTool !== 'analyze' || analyze.get().analysisOrigin) return
  const mapPoint = point.source === 'map' && !point.named
    ? buildRoutingPointFromMap(point.coordinate, `${point.coordinate[1].toFixed(4)}, ${point.coordinate[0].toFixed(4)}`)
    : point
  invalidateAnalyzeResult()
  analyze.set({ analysisOrigin: mapPoint })
}

/** The active scenario as engine services, or the first change that cannot run yet. */
export function activeScenarioDraft() { return scenarioRequestFor(activeScenario()) }

/** The Reach place as request fields; an arrive-by Reach reads the clock as its deadline. */
function reachPlaceFields({ analysisOrigin, reachTimePreference }: AnalyzeState) {
  return reachTimePreference === 'arrive'
    ? { timePreference: reachTimePreference, destination: analysisOrigin }
    : { origin: analysisOrigin }
}

export function comparisonRequestBody(variant: CompareVariant, reference: CompareVariant, includeStreetEdges: boolean) {
  const { reachMaxWalkKm, reachMaxTransfers, reachSurfaceSampling, scenarioWalkSpeedKph, scenarioCutoffMinutes } = analyze.get()
  const { scheduleTimeMinutes } = clock.get()
  const routingServiceDate = clock.get().serviceDate
  const routingServiceDay = serviceDay()
  return {
    feedIds: variant.feedIds,
    ...(reference.feedIds.join() !== variant.feedIds.join() ? { baselineFeedIds: reference.feedIds } : {}),
    ...reachPlaceFields(analyze.get()),
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
  const { analysisOrigin, scenarioCutoffMinutes, compareReferenceId, reachTimePreference } = analyze.get()
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
      timePreference: reachTimePreference,
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
  const selection = caseFeedSelection(grouping.value, scenarioValues().activeCaseId, project)
  if (grouping.readFailed || selection.error) {
    analyze.set({ scenarioError: grouping.error || selection.error })
    return
  }
  const draft = settings.reachTravelMode === 'drive'
    ? { scenario: { id: 'driving', name: 'Driving', services: [], excludedRouteIds: [] } }
    : activeScenarioDraft()
  if ('error' in draft) {
    analyze.set({ scenarioError: draft.error ?? 'Configure the active case before running it.' })
    return
  }
  const baselineGroup = grouping.value.groups.find(group => group.id === baselineGroupId)
  const baselineFeeds = baselineGroup && !caseFeedSelection({ ...grouping.value, cases: { baseline: baselineGroupId } }, 'baseline', project).error
    ? [...new Set(baselineGroup.feedIds)].sort() : null
  const { scheduleTimeMinutes, serviceDate } = clock.get()
  const hasScenarioChanges = settings.reachTravelMode !== 'drive' && (Boolean(activeScenario()?.interventions.length) || scenarioNetworkDiffers(grouping.value.groups, selection.group?.id))
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
          ...(settings.reachTravelMode !== 'drive' && baselineFeeds && baselineFeeds.join() !== [...selection.feedIds].sort().join() ? { baselineFeedIds: baselineFeeds } : {}),
          ...reachPlaceFields(settings),
          departMinutes: scheduleTimeMinutes,
          serviceDate,
          serviceDay: serviceDay(),
          maxWalkKm: settings.reachMaxWalkKm,
          maxTransfers: settings.reachMaxTransfers,
          walkSpeedKph: settings.reachSurfaceSampling === 'cell-center' ? 4.8 : settings.scenarioWalkSpeedKph,
          mode: settings.reachTravelMode,
          surfaceSampling: settings.reachTravelMode === 'drive' ? 'cell-center' : settings.reachSurfaceSampling,
          radiusKm: settings.reachTravelMode === 'drive' ? 40 : 8,
          rasterSize: settings.reachTravelMode !== 'drive' && settings.reachSurfaceSampling === 'street' ? desktopStreetReachRasterSize : desktopReachRasterSize,
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
    analyze.set({ reachResult: inflateReachResult(response.result), scenarioView: hasScenarioChanges ? 'comparison' : 'baseline' })
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
export function changeReachTravelMode(reachTravelMode: AnalyzeState['reachTravelMode']) {
  analyze.set({ reachTravelMode, scenarioRenderMode: 'area' })
  invalidateAnalyzeResult()
}

export function changeReachTimePreference(reachTimePreference: AnalyzeState['reachTimePreference']) {
  analyze.set({ reachTimePreference })
  invalidateAnalyzeResult()
}

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
  analyze.set({ analysisOrigin: point })
}


const referenceOptionsOf = memoizeLast((groups: CityDataGroups['groups'], feeds: ComparisonFeedOption[]): CompareVariant[] => [
  ...groups.map(group => ({ id: `group:${group.id}`, label: group.name, kind: 'group' as const, feedIds: [...new Set(group.feedIds)].sort(), detail: `${group.feedIds.length} timetables` })),
  ...(feeds.length > 1 ? feeds.map(feed => ({ id: `timetable:${feed.id}`, label: feed.name, kind: 'timetable' as const, feedIds: [feed.id], detail: 'One timetable' })) : []),
])
export const compareReferenceOptions = () => referenceOptionsOf(cityGroupsValue().groups, comparisonFeedOptions())
const scenarioIdsOf = memoizeLast((selection: string[] | null, cases: ScenarioDraft[]) => selection ?? cases.filter(s => s.interventions.length || (s.groupId && s.groupId !== baselineGroupId)).map(s => s.id))
export const compareScenarioIds = () => scenarioIdsOf(analyze.get().compareScenarioSelection, scenarioValues().cases)
export function changeCompareReference(compareReferenceId: string) { invalidateAnalyzeResult(); analyze.set({ compareReferenceId }) }
export function toggleCompareScenario(id: string, selected: boolean) {
  const ids = compareScenarioIds()
  invalidateAnalyzeResult()
  analyze.set({ compareScenarioSelection: selected ? [...new Set([...ids, id])] : ids.filter(candidate => candidate !== id) })
}
