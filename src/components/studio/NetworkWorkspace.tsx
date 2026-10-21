import { routeModeLabel } from '../../app/routePresentation'
import { NetworkLayers } from '../NetworkLayers'
import { memo, useMemo } from 'react'
import { networkRouteId } from '../../app/networkSelection'
import { countRender } from '../../app/renderCounts'
import { shallowEqual, useStore } from '../../app/store'
import { city, setActiveFeedId } from '../../state/city'
import { changeServiceDate, clock } from '../../state/clock'
import { useStudio } from '../../state/hooks'
import { openDataView } from '../../state/navigation'
import {
  browseAgencyEntities,
  browseRoute,
  clearAgencySelection,
  disconnectRealtime,
  locateAgencyEntities,
  network,
  openAgencyTrip,
  reconnectRealtime,
  returnToNetworkOverview,
  selectedRoute,
  selectedStop,
  selectRoute,
  setOperationalEvents,
  setRouteRenderMode,
  toggleAgencyMap,
} from '../../state/network'
import { activeFeed, selectedProject, visiblePreview } from '../../state/scope'
import { AgencyPanel } from '../AgencyPanel'
import { NetworkTimetable } from '../NetworkTimetable'

const selectPattern = (routeId: string) => selectRoute(routeId, 'pattern')
const browseStop = (stopId: string) => browseAgencyEntities([], [stopId])

/** The selected route's or stop's timetable inside the Network panel. */
const NetworkTimetablePanel = memo(function NetworkTimetablePanel() {
  const feed = useStudio(activeFeed)
  const preview = useStudio(visiblePreview)
  const focusRoute = useStudio(selectedRoute)
  const focusStop = useStudio(selectedStop)
  const { mapScope, routeRenderMode, routeAnalysisRouteId, routeAnalysisError } = useStore(network, (state) => ({
    mapScope: state.mapScope,
    routeRenderMode: state.routeRenderMode,
    routeAnalysisRouteId: state.routeAnalysisRouteId,
    routeAnalysisError: state.routeAnalysisError,
  }), shallowEqual)
  const serviceDate = useStore(clock, (state) => state.serviceDate)
  return (
    <NetworkTimetable
      feed={feed}
      preview={preview}
      selectedRoute={mapScope === 'route' ? focusRoute : undefined}
      selectedStop={focusStop}
      analysisLoading={Boolean(focusRoute && routeAnalysisRouteId === focusRoute.id)}
      analysisError={routeAnalysisError}
      serviceDate={serviceDate}
      onServiceDateChange={changeServiceDate}
      routeRenderMode={routeRenderMode}
      onRouteRenderModeChange={setRouteRenderMode}
      onSelectPattern={selectPattern}
      onSelectStop={browseStop}
      onOpenSources={openDataView}
      onClearSelection={returnToNetworkOverview}
    />
  )
})

/** The Network workspace panel: agency briefing, live feeds and timetables. */
export const NetworkWorkspace = memo(function NetworkWorkspace() {
  countRender('NetworkWorkspace')
  const layers = useStore(network, state => state.layers)
  const mode = useStore(network, state => state.displayMode)
  const mapPreview = useStudio(visiblePreview)
  const modes = useMemo(() => [...new Set(mapPreview.routes.map(route => route.routeType).filter((type): type is number => type !== undefined))].sort((a, b) => a - b).map(id => ({ id, name: routeModeLabel(id) })), [mapPreview])
  const selectedFeed = useStore(city, state => state.activeFeedId)
  const projectId = useStore(city, (state) => state.selectedProjectId)
  const staticFeeds = useStudio(() => selectedProject().feeds)
  const selection = useStudio(() => {
    const focusRoute = selectedRoute()
    const { mapScope, selectedStopId } = network.get()
    return { routeId: mapScope === 'route' && focusRoute ? networkRouteId(focusRoute) : undefined, stopId: selectedStopId || undefined }
  }, shallowEqual)
  const agency = useStore(network, (state) => ({
    realtimeSnapshot: state.realtimeSnapshot,
    realtimeRequest: state.realtimeRequest,
    realtimeMessage: state.realtimeMessage,
    isRealtimeLoading: state.isRealtimeLoading,
    agencyMapOpen: state.agencyMapOpen,
    agencyTripTarget: state.agencyTripTarget,
    agencyBrowseRequest: state.agencyBrowseRequest,
  }), shallowEqual)
  const timetable = useMemo(() => <NetworkTimetablePanel />, [])
  return (
    <AgencyPanel
      mapLayers={<NetworkLayers modes={modes} mode={mode} onModeChange={displayMode => { clearAgencySelection(); network.set({ displayMode }) }} layers={layers} feeds={staticFeeds} selectedFeed={selectedFeed} onSelectFeed={id => { clearAgencySelection(); network.set({ displayMode: null }); setActiveFeedId(id) }} onChange={(key, enabled) => network.set(state => ({ layers: { ...state.layers, vehicles: state.layers.vehicles ?? state.layers.routes, [key]: enabled } }))} />}
      staticFeeds={staticFeeds}
      onOperationalEvents={setOperationalEvents}
      key={projectId}
      projectId={projectId}
      selection={selection}
      onClearSelection={clearAgencySelection}
      onBrowseRoute={browseRoute}
      timetable={timetable}
      snapshot={agency.realtimeSnapshot}
      realtimeRequest={agency.realtimeRequest}
      realtimeMessage={agency.realtimeMessage}
      realtimeLoading={agency.isRealtimeLoading}
      onConnect={reconnectRealtime}
      onDisconnect={disconnectRealtime}
      onLocate={locateAgencyEntities}
      onOpenData={openDataView}
      mapOpen={agency.agencyMapOpen}
      tripTarget={agency.agencyTripTarget}
      onOpenTrip={openAgencyTrip}
      browseRequest={agency.agencyBrowseRequest}
      onToggleMap={toggleAgencyMap}
    />
  )
})
