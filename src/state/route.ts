import { caseFeedSelection } from '../app/cityDataGroups'
import type { RouteScenarioRequest } from '../app/useNationalRouting'
import type { ScenarioDraft } from '../reach'
import type { VigoProject, MapPreview } from '../domain'
import type { CityDataGroups } from '../app/cityDataGroups'
import { scenarioRequestFor } from './analyze'
import { scenarioLibrary } from './scenarios'
import type { ApiRoutingStatus } from '../app/api'
import { readRoutingDataModePreference } from '../app/routingDataMode'
import { lookupPlaceNames } from '../app/usePlaceNames'
import {
  buildRoutingActivity,
  type RoutingServiceCoverage,
  type RoutingServiceDateAvailability,
  type RoutingServiceDateOption,
} from '../app/routingPlan'
import { createStore, memoizeLast } from '../app/store'
import type { RoutingDepartureWindowMinutes } from '../app/uiOptions'
import type { RoutingDataMode, RoutingPlan, RoutingPoint, RoutingTimePreference, RoutingTravelMode } from '../routingModel'
import {
  appendRoutingPointSequence,
  insertRoutingPointBeforeDestination,
  maxRoutingPointCount,
  normalizeOrderedRoutingPoints,
  parseRoutingCoordinate,
} from '../routingPointSequence'
import { parseRoutingCommand } from '../routingUi'
import { city } from './city'
import { clock } from './clock'
import { network } from './network'
import { routingScope, selectedProject, preview } from './scope'
import { setActiveRouteTool, setQuery, shell } from './shell'

/** What the routing engine last reported for the current request (see RouteRuntime). */
export type RouteEngineState = {
  choices: RoutingPlan[]
  loading: boolean
  alternativesLoading: boolean
  error: string
  errorStatus?: ApiRoutingStatus
  ready: boolean
  serviceCoverage: RoutingServiceCoverage | null
  serviceDateAvailability: RoutingServiceDateAvailability
  serviceDateOptions: RoutingServiceDateOption[]
}

/** Route workspace: journey points, routing options and the selected journey. */
export type RouteState = {
  routeScenarioId: string
  routingResidencyCoverage: RoutingServiceCoverage | null
  routingTimePreference: RoutingTimePreference
  routingMode: RoutingTravelMode
  routingDataMode: RoutingDataMode
  routingDepartureWindowMinutes: RoutingDepartureWindowMinutes
  routingMaxWalkKm: number
  routingMaxTransfers: number | undefined
  routingAllowLongWalk: boolean
  routingAllowStreetTransfers: boolean
  routingWheelchair: boolean
  routingMinimumTransferBufferMinutes: number
  selectedRoutingPlanId: string
  routingDetailsVisible: boolean
  routingEnabled: boolean
  routingPickIndex: number | null
  routingFocusRequest: number
  routingOrigin: RoutingPoint | null
  routingWaypoints: RoutingPoint[]
  routingDestination: RoutingPoint | null
  routingPointError: string
  /** Display metadata is separate from query inputs, so naming never reruns routing. */
  routingPointNames: Record<string, string>
  engine: RouteEngineState
}

const noRoutingPoints: RoutingPoint[] = []

const initialRouteState = (): RouteState => ({
  routeScenarioId: '',
  routingResidencyCoverage: null,
  routingTimePreference: 'depart',
  routingMode: 'transit',
  routingDataMode: readRoutingDataModePreference(),
  routingDepartureWindowMinutes: 20,
  routingMaxWalkKm: 1.2,
  routingMaxTransfers: undefined,
  routingAllowLongWalk: true,
  routingAllowStreetTransfers: true,
  routingWheelchair: false,
  routingMinimumTransferBufferMinutes: 1,
  selectedRoutingPlanId: '',
  routingDetailsVisible: false,
  routingEnabled: false,
  routingPickIndex: null,
  routingFocusRequest: 0,
  routingOrigin: null,
  routingWaypoints: noRoutingPoints,
  routingDestination: null,
  routingPointError: '',
  routingPointNames: {},
  engine: {
    choices: [],
    loading: false,
    alternativesLoading: false,
    error: '',
    ready: false,
    serviceCoverage: null,
    serviceDateAvailability: 'unknown',
    serviceDateOptions: [],
  },
})

export const route = createStore<RouteState>(initialRouteState())
let pointNamesRequest: AbortController | null = null

function cancelPointNames() {
  pointNamesRequest?.abort()
  pointNamesRequest = null
}

export function resetRoute() {
  cancelPointNames()
  routeDateAlignment.storeKey = ''
  route.set(initialRouteState())
}

/** The routing store whose service date was last moved into its timetable coverage. */
export const routeDateAlignment = { storeKey: '' }

// The engine's reset clears its in-flight request and its last answer.
const engineControl = { reset: () => {} }
export function registerRouteEngineReset(reset: () => void) {
  engineControl.reset = reset
}
const resetEngine = () => engineControl.reset()

/** Street graph state for the current mode and journey points. */
export function routingStreetState(): 'ready' | 'loading' | 'missing' {
  const { routingMode, routingOrigin, routingWaypoints, routingDestination } = route.get()
  const { isOsmImporting, streetPreparation } = city.get()
  const street = selectedProject().osmStreetIndex
  const mapPointRoutingNeedsStreetGraph = routingMode !== 'transit' || Boolean(
    routingOrigin && routingDestination
    && [routingOrigin, ...routingWaypoints, routingDestination].some((point) => point.source === 'map'),
  )
  return routingMode !== 'transit'
    ? street?.status === 'ready'
      ? (routingMode === 'walk' ? streetPreparation.walkReady : streetPreparation.ready) ? 'ready' : 'loading'
      : street?.status === 'building' || isOsmImporting ? 'loading' : 'missing'
    : !mapPointRoutingNeedsStreetGraph
      || Boolean(routingScope().nationalRoutingFeed && street?.status === 'ready')
      ? 'ready'
      : street?.status === 'building'
        ? 'loading'
        : 'missing'
}

const routingPlanOf = memoizeLast((choices: RoutingPlan[], selectedId: string) => (
  choices.find((plan) => plan.id === selectedId)
    ?? choices.flatMap(plan => plan.sharedLegAlternatives?.options ?? []).find(option => option.plan.id === selectedId)?.plan
    ?? choices.find((plan) => plan.recommended)
    ?? choices[0]
    ?? null
))

/** The selected journey, or the engine's recommendation. */
export const routingPlan = () => routingPlanOf(route.get().engine.choices, route.get().selectedRoutingPlanId)

const routingActivityOf = memoizeLast((
  routingError: string,
  routingErrorStatus: ApiRoutingStatus | undefined,
  plan: RoutingPlan | null,
  storeBackedRouting: boolean,
  routingStoreReady: boolean,
  hasOrigin: boolean,
  hasDestination: boolean,
  streetState: 'ready' | 'loading' | 'missing',
  routingLoading: boolean,
  routingInputReady: boolean,
  routingServiceDate: string,
  routingMode: RoutingTravelMode,
  serviceDateAvailability: RoutingServiceDateAvailability,
  serviceCoverage: RoutingServiceCoverage | null,
) => buildRoutingActivity({
  routingError,
  routingErrorStatus,
  routingPlan: plan,
  storeBackedRouting,
  routingStoreReady,
  hasOrigin,
  hasDestination,
  routingStreetState: streetState,
  routingLoading,
  routingInputReady,
  routingServiceDate,
  routingMode,
  routingServiceDateAvailability: serviceDateAvailability,
  routingServiceCoverage: serviceCoverage,
}))

export function routingActivity() {
  const { engine, routingMode, routingOrigin, routingDestination } = route.get()
  const { streetPreparation } = city.get()
  const { nationalRoutingFeed } = routingScope()
  const streetError = routingMode === 'drive' || (routingMode === 'walk' && !streetPreparation.walkReady) ? streetPreparation.error : ''
  return routingActivityOf(
    engine.error || streetError,
    engine.errorStatus,
    routingPlan(),
    Boolean(nationalRoutingFeed),
    engine.ready,
    Boolean(routingOrigin),
    Boolean(routingDestination),
    routingStreetState(),
    engine.loading,
    engine.ready && Boolean(nationalRoutingFeed && selectedProject().osmStreetIndex?.status === 'ready'),
    clock.get().serviceDate,
    routingMode,
    engine.serviceDateAvailability,
    engine.serviceCoverage,
  )
}

/** The selected journey's detail panel is open over the map. */
export function routingDetailOpen() {
  const { page, activeRouteTool } = shell.get()
  const { routingDetailsVisible, selectedRoutingPlanId } = route.get()
  return page === 'project'
    && activeRouteTool === 'pathfinder'
    && routingDetailsVisible
    && Boolean(selectedRoutingPlanId)
    && routingPlan()?.status === 'ready'
}

export function clearRouting() {
  cancelPointNames()
  route.set({
    routingPickIndex: null,
    routingPointError: '',
    routingOrigin: null,
    routingPointNames: {},
    routingWaypoints: noRoutingPoints,
    routingDestination: null,
    selectedRoutingPlanId: '',
    routingEnabled: false,
  })
  resetEngine()
}

export function toggleRouting() {
  route.set(({ routingEnabled }) => ({ routingPickIndex: null, routingEnabled: !routingEnabled }))
  setActiveRouteTool('pathfinder')
  network.set({ mapScope: 'route' })
}

export function changeRoutingTimePreference(routingTimePreference: RoutingTimePreference) {
  route.set({ routingTimePreference, selectedRoutingPlanId: '' })
}

export function changeRoutingMode(routingMode: RoutingTravelMode) {
  route.set({
    routingMode,
    ...(routingMode !== 'transit' ? { routingTimePreference: 'depart' as const } : {}),
    selectedRoutingPlanId: '',
  })
  resetEngine()
}

export function changeRoutingDataMode(routingDataMode: RoutingDataMode) {
  if (routingDataMode === route.get().routingDataMode) return
  route.set({ routingDataMode, selectedRoutingPlanId: '' })
  resetEngine()
}

export function changeRoutingDepartureWindow(routingDepartureWindowMinutes: RoutingDepartureWindowMinutes) {
  route.set({ routingDepartureWindowMinutes, selectedRoutingPlanId: '' })
}

export function changeRoutingMaxWalkKm(km: number) {
  route.set({ routingMaxWalkKm: Math.max(0.2, Math.min(5, km)), selectedRoutingPlanId: '' })
}

export const setRoutingMaxTransfers = (routingMaxTransfers: number | undefined) => route.set({ routingMaxTransfers })
export const setRoutingAllowLongWalk = (routingAllowLongWalk: boolean) => route.set({ routingAllowLongWalk })
export const setRoutingAllowStreetTransfers = (routingAllowStreetTransfers: boolean) => route.set({ routingAllowStreetTransfers })
export const setRoutingMinimumTransferBuffer = (routingMinimumTransferBufferMinutes: number) => route.set({ routingMinimumTransferBufferMinutes })

export function selectRoutingPlan(selectedRoutingPlanId: string) {
  route.set({ selectedRoutingPlanId, routingDetailsVisible: true })
}

export const closeRoutingDetails = () => route.set({ routingDetailsVisible: false })

function routingPoints() {
  const { routingOrigin, routingWaypoints, routingDestination } = route.get()
  return [...(routingOrigin ? [routingOrigin] : []), ...routingWaypoints, ...(routingDestination ? [routingDestination] : [])]
}

const displayedPoints = memoizeLast((origin: RoutingPoint | null, waypoints: RoutingPoint[], destination: RoutingPoint | null, names: Record<string, string>) => {
  const display = (point: RoutingPoint | null) => {
    const label = point?.source === 'map' && !point.named ? names[point.coordinate.join(',')] : undefined
    return point && label ? { ...point, label, named: true } : point
  }
  return { routingOrigin: display(origin), routingWaypoints: waypoints.map(point => display(point)!), routingDestination: display(destination) }
})

export function routingDisplayPoints() {
  const state = route.get()
  return displayedPoints(state.routingOrigin, state.routingWaypoints, state.routingDestination, state.routingPointNames)
}

function refreshPointNames() {
  cancelPointNames()
  const projectId = selectedProject().id
  const points = routingPoints().filter(point => point.source === 'map' && !point.named && !route.get().routingPointNames[point.coordinate.join(',')])
  if (!projectId || !points.length) return
  const controller = new AbortController()
  pointNamesRequest = controller
  // Unlike click admission, this lookup never delays placing points or routing.
  // Allow a cold City index to load, while bounding unavailable local services.
  const timer = setTimeout(() => controller.abort(), 5000)
  void lookupPlaceNames(projectId, points, controller.signal).then(names => {
    if (controller.signal.aborted || pointNamesRequest !== controller || city.get().selectedProjectId !== projectId) return
    const entries = points.flatMap((point, index) => names[index] ? [[point.coordinate.join(','), names[index]!]] : [])
    if (entries.length) route.set(state => ({ routingPointNames: { ...state.routingPointNames, ...Object.fromEntries(entries) } }))
  }).catch(() => { /* Coordinates remain usable when no local label is available. */ }).finally(() => {
    clearTimeout(timer)
    if (pointNamesRequest === controller) pointNamesRequest = null
  })
}

export function pickRoutingPoint(index: number | null) {
  if (index === null && routingPoints().length >= maxRoutingPointCount) return
  route.set({ routingPickIndex: index, routingPointError: '', routingEnabled: true })
  setActiveRouteTool('pathfinder')
  network.set({ mapScope: 'route' })
}

export function routingPointFromMap(point: RoutingPoint) {
  const current = routingPoints()
  const { routingPickIndex } = route.get()
  const replacing = routingPickIndex !== null && routingPickIndex < current.length
  if (!replacing && current.length >= maxRoutingPointCount) {
    route.set({ routingEnabled: false })
    return
  }
  const next = replacing
    ? current.map((entry, index) => index === routingPickIndex ? point : entry)
    : current.length >= 2 ? insertRoutingPointBeforeDestination(current, point) : appendRoutingPointSequence(current, point)
  if (!reorderRoutingPoints(next)) return
  if (next.length === 1) route.set({ routingEnabled: true })
}

export function reorderRoutingPoints(points: RoutingPoint[]) {
  if (points.length > maxRoutingPointCount) return false
  const ordered = normalizeOrderedRoutingPoints(points)
  const duplicateIndex = ordered.findIndex((point, index) => index > 0
    && point.coordinate[0] === ordered[index - 1].coordinate[0]
    && point.coordinate[1] === ordered[index - 1].coordinate[1])
  if (duplicateIndex >= 0) {
    route.set({ routingPointError: `Points ${duplicateIndex} and ${duplicateIndex + 1} have the same coordinates.` })
    return false
  }
  route.set({
    routingPointError: '',
    routingPointNames: Object.fromEntries(ordered.flatMap(point => {
      const key = point.coordinate.join(',')
      const label = route.get().routingPointNames[key]
      return label ? [[key, label]] : []
    })),
    routingOrigin: ordered[0] ?? null,
    routingWaypoints: ordered.slice(1, -1),
    routingDestination: ordered.length >= 2 ? ordered.at(-1)! : null,
    selectedRoutingPlanId: '',
    routingPickIndex: null,
    routingEnabled: false,
  })
  resetEngine()
  setActiveRouteTool('pathfinder')
  network.set({ mapScope: 'route' })
  refreshPointNames()
  return true
}

export function rerunRouting() {
  const points = routingPoints()
  if (points.length < 2) return
  reorderRoutingPoints(points.map((point) => ({ ...point, coordinate: [...point.coordinate] })))
}

/** Run a typed journey such as "from 42.36,-71.05 to 42.35,-71.06 at 8:30". */
export function runRoutingSearch(commandText: string) {
  const command = parseRoutingCommand(commandText.trim())
  if (!command) return false
  setActiveRouteTool('pathfinder')
  const points = command.locationTexts.map(parseRoutingCoordinate)
  if (points.some((point) => !point)) {
    route.set({ routingPointError: 'Use latitude, longitude coordinates or pick points on the map.' })
    return false
  }
  if (command.departMinutes !== undefined) clock.set({ scheduleTimeMinutes: command.departMinutes })
  const mode = command.mode ?? route.get().routingMode
  route.set(({ routingTimePreference }) => ({
    routingMode: mode,
    ...(mode === 'transit' && command.departMinutes !== undefined ? { routingDataMode: 'scheduled' as const } : {}),
    routingTimePreference: mode === 'transit' ? command.timePreference ?? routingTimePreference : 'depart',
  }))
  const applied = reorderRoutingPoints(points as RoutingPoint[])
  if (applied) {
    route.set(state => ({ routingFocusRequest: state.routingFocusRequest + 1 }))
    setQuery('')
  }
  return applied
}

const scenarioRequestOf = memoizeLast((id: string, cases: ScenarioDraft[], groups: CityDataGroups, project: VigoProject, _preview: MapPreview, _serviceDate: string): { request: RouteScenarioRequest | null; error: string } => {
  if (!id) return { request: null, error: '' }
  const scenario = cases.find(entry => entry.id === id)
  if (!scenario) return { request: null, error: 'This scenario is no longer available.' }
  const selection = caseFeedSelection(groups, scenario.id, project)
  const draft = scenarioRequestFor(scenario)
  const error = selection.error || ('error' in draft ? draft.error ?? 'Finish this scenario’s changes before routing on it.' : '')
  if (error || !('scenario' in draft)) return { request: null, error }
  const feedIds = [...selection.feedIds].sort()
  return { request: { key: JSON.stringify([feedIds, draft.scenario]), feedIds, scenario: draft.scenario }, error: '' }
})
export function routeScenario() {
  const library = scenarioLibrary()
  return scenarioRequestOf(route.get().routeScenarioId, library.scenarioDrafts, library.grouping.value, selectedProject(), preview(), clock.get().serviceDate)
}
function selectRoutingScenario(id: string) {
  const library = scenarioLibrary()
  if (id) {
    library.setActiveScenarioId(id)
    library.setActiveScenarioChangeId(library.scenarioDrafts.find(s => s.id === id)?.interventions[0]?.id ?? '')
  }
  route.set({ routeScenarioId: id })
}
const networkOptionsOf = memoizeLast((cases: ScenarioDraft[], selectedId: string, error: string) => ({
  scenarios: cases.map(entry => ({ id: entry.id, name: entry.name, detail: entry.interventions.length ? `${entry.interventions.length} changes` : 'Timetable group only' })),
  selectedId, error, onChange: selectRoutingScenario,
}))
export const routingNetwork = () => networkOptionsOf(scenarioLibrary().scenarioDrafts, route.get().routeScenarioId, routeScenario().error)

export const setRoutingWheelchair = (routingWheelchair: boolean) => route.set({ routingWheelchair, ...(routingWheelchair ? { routingDataMode: 'scheduled' as const, routeScenarioId: '' } : {}) })
