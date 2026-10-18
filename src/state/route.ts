import type { ApiRoutingStatus } from '../app/api'
import { readRoutingDataModePreference } from '../app/routingDataMode'
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
import { routingScope, selectedProject } from './scope'
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
  routingResidencyCoverage: RoutingServiceCoverage | null
  routingTimePreference: RoutingTimePreference
  routingMode: RoutingTravelMode
  routingDataMode: RoutingDataMode
  routingDepartureWindowMinutes: RoutingDepartureWindowMinutes
  routingMaxWalkKm: number
  routingMaxTransfers: number | undefined
  routingAllowLongWalk: boolean
  routingAllowStreetTransfers: boolean
  routingMinimumTransferBufferMinutes: number
  selectedRoutingPlanId: string
  routingDetailsVisible: boolean
  routingEnabled: boolean
  routingPickIndex: number | null
  routingOrigin: RoutingPoint | null
  routingWaypoints: RoutingPoint[]
  routingDestination: RoutingPoint | null
  routingPointError: string
  engine: RouteEngineState
}

const noRoutingPoints: RoutingPoint[] = []

const initialRouteState = (): RouteState => ({
  routingResidencyCoverage: null,
  routingTimePreference: 'depart',
  routingMode: 'transit',
  routingDataMode: readRoutingDataModePreference(),
  routingDepartureWindowMinutes: 20,
  routingMaxWalkKm: 1.2,
  routingMaxTransfers: undefined,
  routingAllowLongWalk: true,
  routingAllowStreetTransfers: true,
  routingMinimumTransferBufferMinutes: 0,
  selectedRoutingPlanId: '',
  routingDetailsVisible: false,
  routingEnabled: false,
  routingPickIndex: null,
  routingOrigin: null,
  routingWaypoints: noRoutingPoints,
  routingDestination: null,
  routingPointError: '',
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

export function resetRoute() {
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
  route.set({
    routingPickIndex: null,
    routingPointError: '',
    routingOrigin: null,
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
  if (applied) setQuery('')
  return applied
}
