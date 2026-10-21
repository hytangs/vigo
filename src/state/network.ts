import type { OperationalEvent } from '../agency/types'
import { apiJson } from '../app/api'
import { mergeGtfsRouteAnalysis, routeHasCompleteGtfsAnalysis, type GtfsRouteAnalysis } from '../app/gtfsAnalysis'
import { previewForSelectedRoute } from '../app/mapPresentation'
import { rememberRoute } from '../app/navigationMemory'
import { findNetworkRoute, findNetworkStop, networkRouteId } from '../app/networkSelection'
import { bundleFeedId } from '../app/projectState'
import type { RealtimeInspectRequest } from '../app/realtime'
import { createStore, memoizeLast } from '../app/store'
import type { TripTarget } from '../components/StopArrivalBoard'
import type { MapScope } from '../components/studio/presentation'
import { initialLayers, type LayerState, type MapPreview, type NetworkLens, type RealtimeSnapshot, type RouteMetric } from '../domain'
import { entityFeedScope } from '../networkTruth'
import { type RouteRenderMode } from '../routeServices'
import type { ServiceVehicleMode } from '../serviceVehicles'
import { city, updateProjects } from './city'
import { clock } from './clock'
import { openDataView } from './navigation'
import { route } from './route'
import { preview, selectedProject, visiblePreview } from './scope'
import { navigation, setActiveRouteTool, shell } from './shell'

export type AgencyLocation = { id: string; label: string; coordinate: [number, number]; stopId?: string }
type LocationInput = { id: string; label: string; coordinate: [number, number] }

export type ScheduleLoadRequest = {
  key: string
  projectId: string
  label: string
  serviceDate: string
  requests: Array<{ feedId: string; routeId: string }>
}

/** Network workspace: map layers and scope, selection, agency browsing and live vehicles. */
export type ServiceDateRange = { first: string | null; last: string | null }

export type NetworkState = {
  displayMode: number | null
  layers: LayerState
  mapScope: MapScope
  networkLens: NetworkLens
  routeRenderMode: RouteRenderMode
  selectedRouteId: string
  selectedStopId: string
  routeAnalysisRouteId: string
  routeAnalysisError: string
  operationalEvents: OperationalEvent[]
  vehicleMode: ServiceVehicleMode
  agencyLocation: AgencyLocation | undefined
  agencyMapOpen: boolean
  agencyTripTarget: { routeId: string; tripId: string; serviceDate: string } | undefined
  agencyBrowseRequest: number
  realtimeSnapshot: RealtimeSnapshot | null
  realtimeMessage: string
  isRealtimeLoading: boolean
  realtimeRequest: RealtimeInspectRequest | null
  scheduleLoadStatus: string
  scheduleLoadRequest: ScheduleLoadRequest | null
  scheduleLoadRetry: number
  /** The first and last dates the City's published timetable runs, when known. */
  serviceDates: ServiceDateRange | null
}

const initialNetworkState = (): NetworkState => ({
  layers: initialLayers,
  displayMode: null,
  mapScope: 'network',
  networkLens: 'network',
  routeRenderMode: 'service',
  selectedRouteId: '',
  selectedStopId: '',
  routeAnalysisRouteId: '',
  routeAnalysisError: '',
  operationalEvents: [],
  vehicleMode: 'schedule',
  agencyLocation: undefined,
  agencyMapOpen: false,
  agencyTripTarget: undefined,
  agencyBrowseRequest: 0,
  realtimeSnapshot: null,
  realtimeMessage: '',
  isRealtimeLoading: false,
  realtimeRequest: null,
  scheduleLoadStatus: '',
  scheduleLoadRequest: null,
  scheduleLoadRetry: 0,
  serviceDates: null,
})

export const network = createStore<NetworkState>(initialNetworkState())

export const setMapScope = (mapScope: MapScope) => network.set({ mapScope })
export const setRouteRenderMode = (routeRenderMode: RouteRenderMode) => network.set({ routeRenderMode })
export const setOperationalEvents = (operationalEvents: OperationalEvent[]) => network.set({ operationalEvents })
export const setServiceDates = (serviceDates: ServiceDateRange | null) => network.set({ serviceDates })
export const toggleAgencyMap = () => network.set(({ agencyMapOpen }) => ({ agencyMapOpen: !agencyMapOpen }))

/** Full-day schedule loads by task id, kept so a paused task can be retried. */
export const scheduleLoadRequests = new Map<string, ScheduleLoadRequest>()

export function retryScheduleLoad(taskId: string) {
  const request = scheduleLoadRequests.get(taskId)
  if (request) network.set(({ scheduleLoadRetry }) => ({ scheduleLoadRequest: request, scheduleLoadRetry: scheduleLoadRetry + 1 }))
}

const selectedRouteOf = memoizeLast((routes: RouteMetric[], routeId: string) => routeId ? findNetworkRoute(routes, routeId) : undefined)
export const selectedRoute = () => selectedRouteOf(preview().routes, network.get().selectedRouteId)

const selectedStopOf = memoizeLast((stops: MapPreview['stops'], stopId: string) => stopId ? findNetworkStop(stops, stopId) : undefined)
export const selectedStop = () => selectedStopOf(preview().stops, network.get().selectedStopId)

const focusedMapPreviewOf = memoizeLast(previewForSelectedRoute)
export const focusedMapPreview = () => focusedMapPreviewOf(preview(), selectedRoute(), network.get().routeRenderMode)

/** Network shows the full scheduled day; other workspaces honor the status filter. */
export const workbenchMapPreview = () => shell.get().activeRouteTool === 'agency' && network.get().vehicleMode === 'schedule' ? preview() : visiblePreview()

const scheduleRequestsKeyOf = memoizeLast((routes: RouteMetric[], activeFeedId: string) => JSON.stringify([...new Map(routes.map((entry) => {
  const feedId = activeFeedId === bundleFeedId ? entityFeedScope(entry.id) : activeFeedId
  const routeId = entry.routeId || entry.id
  return [`${feedId}/${routeId}`, { feedId, routeId }] as const
})).values()].sort((a, b) => `${a.feedId}/${a.routeId}`.localeCompare(`${b.feedId}/${b.routeId}`))))

/** Every route's feed and id in the scoped preview, as a stable key for full-day schedule loads. */
export const scheduleRequestsKey = () => scheduleRequestsKeyOf(preview().routes, city.get().activeFeedId)

let routeAnalysisAbort: AbortController | null = null
let routeAnalysisKey = ''
let routeAnalysisRequestId = 0

export function cancelRouteAnalysis() {
  routeAnalysisAbort?.abort()
  routeAnalysisAbort = null
  routeAnalysisRequestId += 1
  network.set({ routeAnalysisRouteId: '', routeAnalysisError: '' })
}

export async function loadGtfsRouteAnalysis(routeMetric: RouteMetric, selectedId: string) {
  const serviceDate = clock.get().serviceDate
  if (routeHasCompleteGtfsAnalysis(routeMetric, preview(), serviceDate)) return

  const { activeFeedId } = city.get()
  const projectId = selectedProject().id
  const feedId = activeFeedId === bundleFeedId ? entityFeedScope(routeMetric.id) : activeFeedId
  const routeId = routeMetric.routeId || routeMetric.id
  if (!feedId || !routeId) return

  const requestKey = JSON.stringify([projectId, feedId, routeId, serviceDate])
  if (routeAnalysisAbort && routeAnalysisKey === requestKey) return
  routeAnalysisAbort?.abort()
  const controller = new AbortController()
  routeAnalysisAbort = controller
  routeAnalysisKey = requestKey
  const requestId = routeAnalysisRequestId + 1
  routeAnalysisRequestId = requestId
  network.set({ routeAnalysisRouteId: selectedId, routeAnalysisError: '' })
  try {
    const result = await apiJson<{ feedId: string; analysis: GtfsRouteAnalysis }>(
      `/api/projects/${encodeURIComponent(projectId)}/gtfs-route-analysis`,
      {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ feedId, routeId, serviceDate }),
      },
    )
    if (controller.signal.aborted || routeAnalysisRequestId !== requestId) return
    updateProjects((current) => current.map((project) => (
      project.id === projectId
        ? mergeGtfsRouteAnalysis(project, result.feedId, result.analysis)
        : project
    )))
    network.set({ routeAnalysisRouteId: '', routeAnalysisError: '' })
  } catch (error) {
    if (controller.signal.aborted || routeAnalysisRequestId !== requestId) return
    network.set({
      routeAnalysisRouteId: '',
      routeAnalysisError: error instanceof Error ? error.message : 'SQLite route analysis could not be loaded.',
    })
  } finally {
    if (routeAnalysisAbort === controller) routeAnalysisAbort = null
  }
}

export function rememberSelectedRoute(routeId: string) {
  navigation.memory = rememberRoute(selectedProject().id, routeId)
}

const networkLayerDefaults = {
  routes: true,
  segments: false,
  stops: true,
  transfers: false,
  coverage: false,
  scenario: false,
  access: false,
}

function applyRouteMapDefaults() {
  network.set(({ layers }) => ({ mapScope: 'route', layers: { ...layers, ...networkLayerDefaults } }))
  route.set({ routingEnabled: false })
}

export function applyNetworkMapDefaults() {
  network.set(({ layers }) => ({ mapScope: 'network', layers: { ...layers, ...networkLayerDefaults } }))
  route.set({ routingEnabled: false })
}

export function returnToNetworkOverview() {
  cancelRouteAnalysis()
  network.set({ selectedRouteId: '', routeRenderMode: 'service', selectedStopId: '' })
  shell.set({ query: '' })
  city.set({ statusFilter: 'all' })
  rememberSelectedRoute('')
  applyNetworkMapDefaults()
}

export function selectRoute(routeId: string, renderMode: RouteRenderMode = 'service') {
  const matches = (item: RouteMetric) => item.id === routeId || item.patternId === routeId
  const routeMetric = preview().routes.find(matches) ?? visiblePreview().routes.find(matches)
  const nextRouteId = routeMetric?.id ?? routeId
  network.set({ selectedRouteId: nextRouteId, routeRenderMode: renderMode, selectedStopId: '' })
  rememberSelectedRoute(nextRouteId)
  clearAgencyMap()
  setActiveRouteTool('agency')
  applyRouteMapDefaults()
  if (routeMetric) void loadGtfsRouteAnalysis(routeMetric, nextRouteId)
}

export function selectStop(stopId: string) {
  network.set({ selectedStopId: stopId })
  setActiveRouteTool('agency')
}

export const clearAgencyMap = () => network.set({ agencyLocation: undefined })

export function locateAgencyEntities(routeIds: string[], stopIds: string[], location?: LocationInput, revealMap = true) {
  const { stops, routes } = preview()
  if (!location && stopIds.length === 1) {
    const stop = findNetworkStop(stops, stopIds[0])
    if (stop && typeof stop.lon === 'number' && typeof stop.lat === 'number' && Number.isFinite(stop.lon) && Number.isFinite(stop.lat)) location = { id: stop.id, label: stop.name, coordinate: [stop.lon, stop.lat] }
  }
  network.set({ agencyLocation: location ? { ...location, stopId: stopIds.length === 1 ? stopIds[0] : undefined } : undefined })
  if (!routeIds.length && !stopIds.length) network.set({ selectedRouteId: '', mapScope: 'network' })
  const routeMetric = routeIds.length === 1 ? findNetworkRoute(routes, routeIds[0]) : undefined
  if (routeMetric || routeIds[0]) network.set({ selectedRouteId: routeMetric?.id ?? routeIds[0], mapScope: 'route', routeRenderMode: 'service' })
  network.set({ selectedStopId: stopIds[0] || '' })
  if (revealMap && window.innerWidth <= 760) network.set({ agencyMapOpen: true })
}

export function browseAgencyEntities(routeIds: string[], stopIds: string[], location?: LocationInput) {
  network.set({ agencyTripTarget: undefined })
  locateAgencyEntities(routeIds, stopIds, location, false)
  if (!routeIds.some(Boolean) && !stopIds.some(Boolean)) return
  network.set(({ agencyBrowseRequest }) => ({ agencyBrowseRequest: agencyBrowseRequest + 1, agencyMapOpen: false }))
}

export function openAgencyTrip(trip: TripTarget) {
  if (!trip.routeId || !trip.tripId || !trip.serviceDate) return
  browseAgencyEntities([trip.routeId], [])
  const routeMetric = findNetworkRoute(preview().routes, trip.routeId)
  network.set({ agencyTripTarget: { routeId: routeMetric ? networkRouteId(routeMetric) : trip.routeId, tripId: trip.tripId, serviceDate: trip.serviceDate } })
}

export function clearAgencySelection() {
  returnToNetworkOverview()
  clearAgencyMap()
}

/** Open a route from a timetable or route list in the Network workspace. */
export function browseRoute(routeId: string) {
  selectRoute(findNetworkRoute(preview().routes, routeId)?.id ?? routeId)
}

// Map interactions. Each handler is stable, so the map does not rebind its
// events when unrelated Studio state changes.
export function selectRouteFromMap(routeId: string, options?: { inspect?: boolean }) {
  if (shell.get().activeRouteTool !== 'agency') selectRoute(routeId)
  else if (options?.inspect === false) locateAgencyEntities([routeId], [])
  else browseAgencyEntities([routeId], [])
}

export function selectStopFromMap(stopId: string, options?: { inspect?: boolean }) {
  if (shell.get().activeRouteTool !== 'agency') selectStop(stopId)
  else if (options?.inspect === false) locateAgencyEntities([], [stopId])
  else browseAgencyEntities([], [stopId])
}

export function changeMapScopeFromMap(scope: MapScope) {
  if (shell.get().activeRouteTool === 'agency' && scope === 'network') {
    clearAgencyMap()
    returnToNetworkOverview()
  }
  setMapScope(scope)
}

let realtimeInFlight = false
let realtimeAbort: AbortController | null = null
let realtimeRequestId = 0

export function clearRealtimeConnection() {
  realtimeAbort?.abort()
  realtimeAbort = null
  realtimeRequestId += 1
  realtimeInFlight = false
  network.set({
    realtimeRequest: null,
    realtimeSnapshot: null,
    realtimeMessage: '',
    isRealtimeLoading: false,
    vehicleMode: 'schedule',
  })
}

export function resetNetwork() {
  routeAnalysisAbort?.abort()
  routeAnalysisAbort = null
  routeAnalysisRequestId += 1
  realtimeAbort?.abort()
  realtimeAbort = null
  realtimeRequestId += 1
  realtimeInFlight = false
  scheduleLoadRequests.clear()
  network.set(initialNetworkState())
}

export async function refreshRealtimeRequest(
  request: RealtimeInspectRequest,
  options: { background?: boolean; openPanel?: boolean; signal?: AbortSignal } = {},
) {
  if (realtimeInFlight && options.background) return
  const projectId = city.get().selectedProjectId
  realtimeAbort?.abort()
  const controller = new AbortController()
  realtimeAbort = controller
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal

  const requestId = realtimeRequestId + 1
  realtimeRequestId = requestId
  realtimeInFlight = true
  if (!options.background) network.set({ isRealtimeLoading: true, realtimeMessage: '' })

  try {
    const result = await apiJson<{ snapshot: RealtimeSnapshot }>('/api/realtime/inspect', {
      method: 'POST',
      signal,
      body: JSON.stringify({ ...request, projectId }),
    })
    if (requestId !== realtimeRequestId || signal.aborted) return
    network.set({
      realtimeSnapshot: result.snapshot,
      realtimeRequest: request,
      realtimeMessage: '',
      ...(!options.background ? { vehicleMode: 'live' as const } : {}),
    })
    if (options.openPanel) {
      network.set({ selectedRouteId: '', selectedStopId: '', mapScope: 'network' })
      setActiveRouteTool('agency')
    }
  } catch (error) {
    if (requestId !== realtimeRequestId || signal.aborted) return
    network.set({ realtimeMessage: error instanceof Error ? error.message : 'GTFS-RT decode failed.' })
  } finally {
    if (requestId === realtimeRequestId) {
      realtimeInFlight = false
      realtimeAbort = null
      if (!options.background) network.set({ isRealtimeLoading: false })
    }
  }
}

export function connectRealtime(request: RealtimeInspectRequest) {
  void refreshRealtimeRequest(request, { openPanel: true })
}

export function reconnectRealtime(request: RealtimeInspectRequest) {
  void refreshRealtimeRequest(request)
}

export function disconnectRealtime() {
  void apiJson(`/api/projects/${encodeURIComponent(city.get().selectedProjectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) }).catch(() => {})
  clearRealtimeConnection()
  network.set({ vehicleMode: 'schedule' })
}

export function changeVehicleMode(vehicleMode: ServiceVehicleMode) {
  if (vehicleMode === 'live' && !network.get().realtimeSnapshot) {
    openDataView()
    return
  }
  network.set({ vehicleMode })
}
