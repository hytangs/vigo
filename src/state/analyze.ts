import { apiProgressJson, type ApiProgress } from '../app/api'
import { createStore } from '../app/store'
import { caseFeedSelection } from '../app/cityDataGroups'
import { baselineGroupId, scenarioNetworkDiffers } from '../app/scenarioLibrary'
import type { useReachInspection } from '../app/useReachInspection'
import {
  inflateReachResult,
  reachTimeBands,
  type ReachResult,
  type ScenarioRenderMode,
  type ScenarioView,
} from '../reach'
import type { RoutingBikeOptions, RoutingPoint, RoutingTimePreference } from '../routingModel'
import { buildRoutingPointFromMap } from '../routingUi'
import { changeServiceDate, clock, serviceDay } from './clock'
import { route } from './route'
import { scenarioRequestFor } from './scenarioRequest'
import { activeScenario, cityGrouping, scenarioValues } from './scenarios'
import { routingScope, selectedProject } from './scope'
import { shell } from './shell'

const desktopReachRasterSize = 128
const desktopStreetReachRasterSize = 384
// Bike cells require verified endpoint walks and occasional exact searches.
// Keep the interactive preview bounded; callers can request finer API grids.
const desktopBikeReachRasterSize = 48

export type ReachInspection = ReturnType<typeof useReachInspection>

/** Analyze workspace: the Reach origin, run settings, cases and their results. */
export type AnalyzeState = {
  /** The Reach place: the origin, or the destination of an arrive-by Reach. */
  analysisOrigin: RoutingPoint | null
  /** Leave at the clock time, or arrive at the place by it. */
  reachTimePreference: RoutingTimePreference
  reachResult: ReachResult | null
  scenarioLoading: boolean
  scenarioProgress: ApiProgress | null
  scenarioError: string
  scenarioCutoffMinutes: number
  reachMaxWalkKm: number
  reachMaxTransfers: number | undefined
  scenarioWalkSpeedKph: number
  reachTravelMode: 'transit' | 'drive' | 'bike'
  reachBike: RoutingBikeOptions
  reachSurfaceSampling: 'street' | 'cell-center'
  reachMonteCarlo: boolean
  reachWindowMinutes: number
  reachDraws: number
  reachPercentile: number
  reachSeed: number
  scenarioView: ScenarioView
  scenarioRenderMode: ScenarioRenderMode
  /** The clicked point's journey (see AnalyzeRuntime). */
  inspection: ReachInspection | null
}

const initialAnalyzeState = (): AnalyzeState => ({
  analysisOrigin: null,
  reachTimePreference: 'depart',
  reachResult: null,
  scenarioLoading: false,
  scenarioProgress: null,
  scenarioError: '',
  scenarioCutoffMinutes: 45,
  reachMaxWalkKm: 1.2,
  reachMaxTransfers: undefined,
  scenarioWalkSpeedKph: 4.8,
  reachTravelMode: 'transit',
  reachBike: {profile:'balanced',speedKph:18},
  reachSurfaceSampling: 'street',
  reachMonteCarlo: false,
  reachWindowMinutes: 60,
  reachDraws: 200,
  reachPercentile: 50,
  reachSeed: 0,
  scenarioView: 'comparison',
  scenarioRenderMode: 'area',
  inspection: null,
})

export const analyze = createStore<AnalyzeState>(initialAnalyzeState())

/** Whether a map click in Reach places its origin (or arrive-by destination). */
export function scenarioPointPicking() {
  return shell.get().activeRouteTool === 'analyze' && !analyze.get().analysisOrigin
}

/** Inputs whose change makes a shown Reach result stale, including a rebuilt timetable. */
export function reachInputIdentity() {
  const { scheduleTimeMinutes, serviceDate } = clock.get()
  const { feeds, osmStreetIndex } = selectedProject()
  return [
    routingScope().nationalRoutingStoreKey,
    feeds.filter((feed) => feed.routingStore?.status === 'ready')
      .map((feed) => `${feed.id}:${feed.routingStore?.builtAt ?? ''}`).join('|'),
    osmStreetIndex?.builtAt ?? '',
    serviceDate,
    scheduleTimeMinutes,
    route.get().routingMaxWalkKm,
  ].join(':')
}

let analysisAbort: AbortController | null = null

export function invalidateAnalyzeResult() {
  analysisAbort?.abort()
  analysisAbort = null
  analyze.set({
    reachResult: null,
    scenarioError: '',
    scenarioLoading: false,
    scenarioProgress: null,
  })
}

export function resetAnalyze() {
  analysisAbort?.abort()
  analysisAbort = null
  analyze.set(initialAnalyzeState())
}

export function clearAnalysisState() {
  invalidateAnalyzeResult()
  analyze.set({ analysisOrigin: null })
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

function simulationEnabled(settings = analyze.get()) {
  return settings.reachMonteCarlo && settings.reachTravelMode === 'transit' && settings.reachTimePreference === 'depart'
}

function simulationOptions(settings = analyze.get()) {
  if (!simulationEnabled(settings)) return {}
  const startMinutes = clock.get().scheduleTimeMinutes
  return { monteCarlo: { startMinutes, endMinutes: Math.min(1440, startMinutes + settings.reachWindowMinutes),
    draws: settings.reachDraws, seed: settings.reachSeed, percentiles: [settings.reachPercentile] } }
}

export function changeMonteCarlo(settings: Partial<Pick<AnalyzeState, 'reachMonteCarlo' | 'reachWindowMinutes' | 'reachDraws' | 'reachPercentile' | 'reachSeed'>>) {
  analyze.set({ ...settings, scenarioRenderMode: 'area' })
  invalidateAnalyzeResult()
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
  const draft = settings.reachTravelMode !== 'transit'
    ? { scenario: { id: settings.reachTravelMode, name: settings.reachTravelMode === 'bike' ? 'Bicycle' : 'Driving', services: [], excludedRouteIds: [] } }
    : activeScenarioDraft()
  if ('error' in draft) {
    analyze.set({ scenarioError: draft.error ?? 'Configure the active case before running it.' })
    return
  }
  const baselineGroup = grouping.value.groups.find(group => group.id === baselineGroupId)
  const baselineFeeds = baselineGroup && !caseFeedSelection({ ...grouping.value, cases: { baseline: baselineGroupId } }, 'baseline', project).error
    ? [...new Set(baselineGroup.feedIds)].sort() : null
  const { scheduleTimeMinutes, serviceDate } = clock.get()
  const hasScenarioChanges = settings.reachTravelMode === 'transit' && (Boolean(activeScenario()?.interventions.length) || scenarioNetworkDiffers(grouping.value.groups, selection.group?.id))
  analysisAbort?.abort()
  const controller = new AbortController()
  analysisAbort = controller
  analyze.set({
    scenarioLoading: true,
    scenarioProgress: { phase: 'preparation', progress: 0, detail: 'Starting network Reach' },
    scenarioError: '',
  })
  try {
    const response = await apiProgressJson<{ result: ReachResult }>(
      `/api/projects/${encodeURIComponent(project.id)}/reach`,
      {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          feedIds: selection.feedIds,
          ...(settings.reachTravelMode === 'transit' && baselineFeeds && baselineFeeds.join() !== [...selection.feedIds].sort().join() ? { baselineFeedIds: baselineFeeds } : {}),
          ...reachPlaceFields(settings),
          departMinutes: scheduleTimeMinutes,
          ...simulationOptions(settings),
          serviceDate,
          serviceDay: serviceDay(),
          maxWalkKm: settings.reachMaxWalkKm,
          maxTransfers: settings.reachMaxTransfers,
          walkSpeedKph: settings.reachTravelMode !== 'bike' && settings.reachSurfaceSampling === 'cell-center' ? 4.8 : settings.scenarioWalkSpeedKph,
          mode: settings.reachTravelMode,
          ...(settings.reachTravelMode === 'bike' ? {bike:settings.reachBike} : {}),
          surfaceSampling: settings.reachTravelMode !== 'transit' ? 'cell-center' : settings.reachSurfaceSampling,
          radiusKm: settings.reachTravelMode === 'drive' ? 40 : 8,
          rasterSize: settings.reachTravelMode === 'bike' ? desktopBikeReachRasterSize : simulationEnabled(settings) ? 96 : settings.reachTravelMode === 'transit' && settings.reachSurfaceSampling === 'street' ? desktopStreetReachRasterSize : desktopReachRasterSize,
          cutoffsMinutes: reachTimeBands(settings.scenarioCutoffMinutes),
          // The final baseline surface is rendered after transit/routing
          // seeds are known. Avoid spending a second full OSM traversal on
          // a provisional walk-only surface for every scenario run.
          includePreliminary: false,
          includeStreetEdges: settings.reachTravelMode !== 'transit' || simulationEnabled(settings) ? false : includeStreetEdges,
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

export function changeReachBike(reachBike: RoutingBikeOptions) {
  if (!['balanced','fast','quiet'].includes(reachBike.profile) || !Number.isFinite(reachBike.speedKph)
    || reachBike.speedKph < 5 || reachBike.speedKph > 40
    || (reachBike.maxLts !== undefined && ![1,2,3,4].includes(reachBike.maxLts))) return
  analyze.set({reachBike})
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
  const { reachResult } = analyze.get()
  // A result already banded at this budget can be redrawn without a new run.
  if (!reachResult?.request.cutoffsMinutes.includes(scenarioCutoffMinutes)) {
    invalidateAnalyzeResult()
  }
}

export function changeRenderMode(mode: ScenarioRenderMode) {
  const { scenarioRenderMode, scenarioLoading, reachResult } = analyze.get()
  if (mode === scenarioRenderMode) return
  analyze.set({ scenarioRenderMode: mode })
  if (mode !== 'streets') return
  // Street rendering needs edge geometry; rerun a result computed without it.
  if (scenarioLoading || (reachResult && !reachResult.surface.edges)) {
    void runSurfaceAnalysis(true)
  }
}

export const setScenarioView = (scenarioView: ScenarioView) => analyze.set({ scenarioView })

export function setAnalysisOrigin(point: RoutingPoint | null) {
  invalidateAnalyzeResult()
  analyze.set({ analysisOrigin: point })
}

