import { feedIdentity, liveVehicleDiagnostics, quietMapLabel, type MapScope } from './presentation'

import { Clock3, Database, MapPin, Radio, Server, TableProperties } from 'lucide-react'
import { memo, useMemo } from 'react'
import { buildCityPreviewLod } from '../../app/cityPreview'
import { previewForSelectedRoute } from '../../app/mapPresentation'
import { formatBytes } from '../../app/presentation'
import { bundleFeedId, hasOperationsData, orderedProjects } from '../../app/projectState'
import { countRender } from '../../app/renderCounts'
import { shallowEqual, useStore } from '../../app/store'
import { basemapOptions, networkLensOptions, schedulePresets } from '../../app/uiOptions'
import {
  basemapLabels,
  basemapShortLabels,
  classNames,
  formatNumber,
  networkLensLabels,
  type Basemap,
  type FeedSummary,
  type MapPreview,
  type NetworkLens,
  type RealtimeSnapshot,
  type RouteMetric,
  type VigoProject,
} from '../../domain'
import { buildNetworkPerformanceProfile } from '../../networkPerformance'
import {
  formatServiceTime,
  scheduledServiceEndMinutes,
  scheduledVehicleDiagnostics,
  scheduledVehiclesAtTime,
} from '../../scheduledVehicles'
import { city } from '../../state/city'
import { changeServiceDate, clock, setScheduleTime } from '../../state/clock'
import { useStudio, useStudioRecord } from '../../state/hooks'
import {
  openAnalyzeView,
  openDataView,
  openNetworkView,
  openPathfinderView,
  openProject,
  openSettingsView,
  selectFeed,
} from '../../state/navigation'
import { network, openLiveVehicles, selectedRoute, selectNetworkLens, setMapScope } from '../../state/network'
import {
  changeRoutingDataMode,
  changeRoutingDepartureWindow,
  changeRoutingMaxWalkKm,
  changeRoutingMode,
  changeRoutingTimePreference,
  clearRouting,
  pickRoutingPoint,
  reorderRoutingPoints,
  rerunRouting,
  route,
  routingActivity,
  routingPlan,
  routingNetwork,
  selectRoutingPlan,
  setRoutingAllowLongWalk,
  setRoutingAllowStreetTransfers,
  setRoutingMaxTransfers,
  setRoutingMinimumTransferBuffer,
  toggleRouting,
} from '../../state/route'
import { activeFeed, hasActiveOperationsData, routingScope, selectedProject, visiblePreview } from '../../state/scope'
import { changeBasemap, shell } from '../../state/shell'
import { AnalyzePanel } from '../AnalyzePanel'
import { SidebarPathfinderBox } from '../PathfinderPanel'
import { PrimaryNav } from '../PrimaryNav'

/** The workspace rail; `hasActiveData` enables Network, Route and Analyze. */
export const StudioRail = memo(function StudioRail({ hasActiveData }: { hasActiveData: boolean }) {
  const page = useStore(shell, (state) => state.page)
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  return (
    <PrimaryNav
      page={page}
      activeRouteTool={activeRouteTool}
      hasActiveData={hasActiveData}
      onOpenNetwork={openNetworkView}
      onOpenRouting={openPathfinderView}
      onOpenAnalyze={openAnalyzeView}
      onOpenSettings={openSettingsView}
    />
  )
})

/** The workspace sidebar: the rail and the active workspace's panel. */
export const VigoSidebar = memo(function VigoSidebar() {
  countRender('VigoSidebar')
  const page = useStore(shell, (state) => state.page)
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const hasActiveData = useStudio(hasActiveOperationsData)
  const projectCount = useStore(city, (state) => state.projects.length)
  const isDataPanel = page === 'project' && activeRouteTool === 'data'
  const isPathfinderPanel = page === 'project' && activeRouteTool === 'pathfinder'
  const isAnalyzePanel = page === 'project' && activeRouteTool === 'analyze'
  const scopeLabel = useStudio(() => city.get().activeFeedId === bundleFeedId
    ? quietMapLabel(selectedProject().name)
    : quietMapLabel(activeFeed().name))
  const projectName = useStudio(() => selectedProject().name)
  const networkIndexState = useStudio(() => {
    const scope = routingScope()
    return route.get().engine.ready
      ? 'SQLite service model open'
      : scope.routingStoreStored
        ? `${scope.routingStoreStoredFeedCount}/${Math.max(1, scope.routingStoreFeedCount)} local service stores ready`
        : `${scope.routingStoreStoredFeedCount}/${Math.max(1, scope.routingStoreFeedCount)} local service stores indexed`
  })
  const queryWorkspace = isPathfinderPanel || isAnalyzePanel
  const panelTitle = page === 'projects'
    ? 'Cities'
    : isDataPanel
      ? 'City'
      : isAnalyzePanel
        ? 'Analyze'
        : isPathfinderPanel
          ? 'Route'
          : 'Network'
  const panelSubtitle = page === 'projects'
    ? `${projectCount} Cities`
    : isPathfinderPanel
      ? ''
    : isAnalyzePanel
      ? ''
    : hasActiveData
      ? scopeLabel
      : `${projectName} needs an indexed GTFS feed`
  const panelContextLine = isDataPanel ? networkIndexState : ''

  return (
    <aside className="app-sidebar" aria-label="City navigation">
      <StudioRail hasActiveData={hasActiveData} />
      <section className={classNames('sidebar-panel', page === 'project' && `is-${activeRouteTool}`)} aria-label="City panel" data-map-occluder>
        {!queryWorkspace && <div className="sidebar-panel-head">
          <div className="sidebar-panel-title">
            <h1 className="studio-page-title">{panelTitle}</h1>
            {panelSubtitle ? <p>{panelSubtitle}</p> : null}
            {panelContextLine ? <span className="sidebar-context-line">{panelContextLine}</span> : null}
          </div>
        </div>}

        {page === 'projects' ? <SidebarCityList /> : (
          <>
            {!hasActiveData ? (
              <div className="sidebar-section">
                <div className="sidebar-empty-note">
                  <strong>No routes indexed</strong>
                  <span>Load a GTFS ZIP to create route patterns, stops, schedules, and the network map.</span>
                </div>
              </div>
            ) : null}
            {hasActiveData && isDataPanel ? <SidebarFeedScope /> : null}
            {hasActiveData && isDataPanel ? <SidebarNetworkStatus /> : null}
            {hasActiveData && isDataPanel ? <SidebarNetworkControls /> : null}
            {hasActiveData && isPathfinderPanel ? <SidebarRouteBox /> : null}
            {hasActiveData && isAnalyzePanel ? <AnalyzePanel /> : null}
          </>
        )}
      </section>
    </aside>
  )
})

function SidebarCityList() {
  const projects = useStore(city, (state) => state.projects)
  const selectedProjectId = useStudio(() => selectedProject().id)
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        <strong>Cities</strong>
        <span>{projects.length}</span>
      </div>
      <div className="sidebar-list">
        {orderedProjects(projects).slice(0, 8).map((project) => (
          <button
            key={project.id}
            type="button"
            className={classNames('sidebar-list-row', project.id === selectedProjectId && 'is-selected', !hasOperationsData(project) && 'is-empty')}
            onClick={() => openProject(project.id)}
          >
            <strong>{project.name}</strong>
            <span>{formatNumber(project.summary.feeds)} feeds / {formatNumber(project.summary.routes)} routes</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SidebarFeedScope() {
  const project = useStudio(selectedProject)
  const feed = useStudio(activeFeed)
  const activeFeedId = useStore(city, (state) => state.activeFeedId)
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        <strong>Feeds</strong>
        <span>{feed.source === 'bundle' ? `${project.feeds.length} feeds` : 'Scoped'}</span>
      </div>
      <div className="sidebar-list">
        <button
          type="button"
          className={classNames('sidebar-list-row', activeFeedId === bundleFeedId && 'is-selected')}
          onClick={() => selectFeed(bundleFeedId)}
        >
          <strong>All feeds</strong>
          <span>{project.feeds.length} feed{project.feeds.length === 1 ? '' : 's'} in {quietMapLabel(project.name)}</span>
        </button>
        {project.feeds.slice(0, 7).map((entry) => {
          const identity = feedIdentity(project.feeds, entry)
          return (
            <button
              key={entry.id}
              type="button"
              className={classNames('sidebar-list-row feed-scope-row', activeFeedId === entry.id && 'is-selected')}
              onClick={() => selectFeed(entry.id)}
            >
              <strong>{entry.name}</strong>
              <span>{identity.detail}</span>
              <small>{identity.chip}</small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SidebarNetworkStatus() {
  const project = useStudio(selectedProject)
  const feed = useStudio(activeFeed)
  const preview = useStudio(visiblePreview)
  const scope = useStudio(routingScope)
  const routingStoreReady = useStore(route, (state) => state.engine.ready)
  const osmStreetMessage = useStore(city, (state) => state.osmStreetMessage)
  return (
    <SidebarNetworkStatusBox
      project={project}
      feed={feed}
      preview={preview}
      routingStoreReady={routingStoreReady}
      routingStoreFeedCount={scope.routingStoreFeedCount}
      routingStoreStored={scope.routingStoreStored}
      routingStoreStoredFeedCount={scope.routingStoreStoredFeedCount}
      routingStoreTripCount={scope.routingStoreTripCount}
      routingStoreConnectionCount={scope.routingStoreConnectionCount}
      osmStreetMessage={osmStreetMessage}
    />
  )
}

function SidebarNetworkControls() {
  const feed = useStudio(activeFeed)
  const preview = useStudio(visiblePreview)
  const focusRoute = useStudio(selectedRoute)
  const { mapScope, networkLens, vehicleMode, realtimeSnapshot } = useStore(network, (state) => ({
    mapScope: state.mapScope,
    networkLens: state.networkLens,
    vehicleMode: state.vehicleMode,
    realtimeSnapshot: state.realtimeSnapshot,
  }), shallowEqual)
  const basemap = useStore(shell, (state) => state.basemap)
  const { scheduleTimeMinutes, serviceDate } = useStore(clock, (state) => state, shallowEqual)
  const routeFocusActive = mapScope === 'route' && Boolean(focusRoute)
  const networkPreview = useMemo(() => buildCityPreviewLod(preview), [preview])
  const scopedMapPreview = routeFocusActive ? previewForSelectedRoute(preview, focusRoute) : networkPreview
  const performanceProfile = useMemo(
    () => buildNetworkPerformanceProfile(scopedMapPreview, { precise: routeFocusActive }),
    [routeFocusActive, scopedMapPreview],
  )
  const liveVehicleCount = realtimePositionCount(realtimeSnapshot)
  const renderingLive = vehicleMode === 'live'
  const scheduleProjectionEnabled = vehicleMode === 'schedule'
  const scheduledVehicles = useMemo(
    () => scheduleProjectionEnabled
      ? scheduledVehiclesAtTime(scopedMapPreview, scheduleTimeMinutes, serviceDate)
      : [],
    [scheduleProjectionEnabled, scopedMapPreview, serviceDate, scheduleTimeMinutes],
  )
  const scheduleDiagnostics = useMemo(
    () => renderingLive
      ? liveVehicleDiagnostics(liveVehicleCount, realtimeSnapshot !== null)
      : scheduleProjectionEnabled
        ? scheduledVehicleDiagnostics(scopedMapPreview, scheduledVehicles, scheduleTimeMinutes, serviceDate)
        : liveVehicleDiagnostics(0),
    [liveVehicleCount, realtimeSnapshot, renderingLive, scheduleProjectionEnabled, scopedMapPreview, serviceDate, scheduleTimeMinutes, scheduledVehicles],
  )
  return (
    <SidebarNetworkBox
      mapScope={mapScope}
      networkLens={networkLens}
      basemap={basemap}
      scheduleTimeMinutes={scheduleTimeMinutes}
      scheduleServiceDate={serviceDate}
      scheduleDiagnostics={scheduleDiagnostics}
      scheduleEndMinutes={scheduledServiceEndMinutes(scopedMapPreview, serviceDate)}
      lensInsight={buildNetworkLensInsight(feed, preview, networkLens)}
      performanceProfile={performanceProfile}
      livePositionCount={liveVehicleCount}
      realtimeSnapshot={realtimeSnapshot}
      onMapScopeChange={setMapScope}
      onNetworkLensChange={selectNetworkLens}
      onBasemapChange={changeBasemap}
      onScheduleTimeChange={setScheduleTime}
      onScheduleServiceDateChange={changeServiceDate}
      onOpenLive={openLiveVehicles}
    />
  )
}

function SidebarRouteBox() {
  const settings = useStore(route, (state) => ({
    routingEnabled: state.routingEnabled,
    routingOrigin: state.routingOrigin,
    routingWaypoints: state.routingWaypoints,
    routingDestination: state.routingDestination,
    routingTimePreference: state.routingTimePreference,
    routingMode: state.routingMode,
    routingDataMode: state.routingDataMode,
    routingDepartureWindowMinutes: state.routingDepartureWindowMinutes,
    routingMaxWalkKm: state.routingMaxWalkKm,
    routingMaxTransfers: state.routingMaxTransfers,
    routingAllowLongWalk: state.routingAllowLongWalk,
    routingAllowStreetTransfers: state.routingAllowStreetTransfers,
    routingMinimumTransferBufferMinutes: state.routingMinimumTransferBufferMinutes,
    routingPointError: state.routingPointError,
    routingPickIndex: state.routingPickIndex,
  }), shallowEqual)
  const routingNetworkState = useStudio(routingNetwork)
  const engine = useStore(route, (state) => state.engine)
  const plan = useStudio(routingPlan)
  const activity = useStudio(routingActivity)
  const scope = useStudioRecord(() => {
    const { nationalRoutingFeed, routingScopeStatus } = routingScope()
    return { storeBackedRouting: Boolean(nationalRoutingFeed), routingScopeStatus }
  })
  const { scheduleTimeMinutes, serviceDate } = useStore(clock, (state) => state, shallowEqual)
  return (
    <SidebarPathfinderBox
      routingEnabled={settings.routingEnabled}
      routingOrigin={settings.routingOrigin}
      routingWaypoints={settings.routingWaypoints}
      routingDestination={settings.routingDestination}
      routingPlan={plan}
      routingChoices={engine.choices}
      routingScopeStatus={scope.routingScopeStatus}
      routingStoreReady={engine.ready}
      routingTimePreference={settings.routingTimePreference}
      routingMode={settings.routingMode}
      routingDataMode={settings.routingMode === 'transit' && routingNetworkState.selectedId ? 'scheduled' : settings.routingDataMode}
      routingNetwork={routingNetworkState}
      routingDepartureWindowMinutes={settings.routingDepartureWindowMinutes}
      routingMaxWalkKm={settings.routingMaxWalkKm}
      routingMaxTransfers={settings.routingMaxTransfers}
      routingAllowLongWalk={settings.routingAllowLongWalk}
      routingAllowStreetTransfers={settings.routingAllowStreetTransfers}
      routingMinimumTransferBufferMinutes={settings.routingMinimumTransferBufferMinutes}
      routingActivity={activity}
      routingAlternativesLoading={engine.alternativesLoading}
      routingServiceDate={serviceDate}
      routingServiceCoverage={engine.serviceCoverage}
      routingServiceDateAvailability={engine.serviceDateAvailability}
      routingServiceDateOptions={engine.serviceDateOptions}
      routingPointError={settings.routingPointError}
      storeBackedRouting={scope.storeBackedRouting}
      scheduleTimeMinutes={scheduleTimeMinutes}
      onRunRouting={rerunRouting}
      onPickRoutingPoint={pickRoutingPoint}
      routingPickIndex={settings.routingPickIndex}
      onReorderRoutingPoints={reorderRoutingPoints}
      onOpenFeed={openDataView}
      onScheduleTimeChange={setScheduleTime}
      onRoutingTimePreferenceChange={changeRoutingTimePreference}
      onRoutingModeChange={changeRoutingMode}
      onRoutingDataModeChange={changeRoutingDataMode}
      onRoutingDepartureWindowChange={changeRoutingDepartureWindow}
      onRoutingMaxWalkKmChange={changeRoutingMaxWalkKm}
      onRoutingMaxTransfersChange={setRoutingMaxTransfers}
      onRoutingAllowLongWalkChange={setRoutingAllowLongWalk}
      onRoutingAllowStreetTransfersChange={setRoutingAllowStreetTransfers}
      onRoutingMinimumTransferBufferChange={setRoutingMinimumTransferBuffer}
      onRoutingServiceDateChange={changeServiceDate}
      onSelectRoutingPlan={selectRoutingPlan}
      onToggleRouting={toggleRouting}
      onClearRouting={clearRouting}
    />
  )
}

function SidebarNetworkStatusBox({
  project,
  feed,
  preview,
  routingStoreReady,
  routingStoreFeedCount,
  routingStoreStored,
  routingStoreStoredFeedCount,
  routingStoreTripCount,
  routingStoreConnectionCount,
  osmStreetMessage,
}: {
  project: VigoProject
  feed: FeedSummary
  preview: MapPreview
  routingStoreReady: boolean
  routingStoreFeedCount: number
  routingStoreStored: boolean
  routingStoreStoredFeedCount: number
  routingStoreTripCount: number
  routingStoreConnectionCount: number
  osmStreetMessage: string
}) {
  const missingRequiredTables = Object.entries(feed.requiredTables)
    .filter(([, present]) => !present)
    .map(([table]) => table)
  const severeWarnings = feed.warnings
    .filter((warning) => warning.severity === 'error' || warning.severity === 'warning')
    .slice(0, 3)
  const statusTone = missingRequiredTables.length || severeWarnings.some((warning) => warning.severity === 'error')
    ? 'risk'
    : routingStoreReady || routingStoreStored
      ? 'good'
      : 'watch'
  const scheduleText = routingStoreReady
    ? `${formatNumber(routingStoreTripCount)} trips / ${formatNumber(routingStoreConnectionCount)} connections`
    : routingStoreStored
      ? `${formatNumber(routingStoreTripCount)} trips / ${formatNumber(routingStoreConnectionCount)} connections in SQLite`
      : `${routingStoreStoredFeedCount}/${Math.max(1, routingStoreFeedCount)} SQLite stores ready`
  const osmStreetIndex = project.osmStreetIndex?.status === 'ready' ? project.osmStreetIndex : null
  const osmText = osmStreetIndex
    ? `${formatNumber(osmStreetIndex.nodeCount)} nodes / ${formatNumber(osmStreetIndex.edgeCount)} directed edges`
    : 'No local street index'

  return (
    <section className="sidebar-section sidebox sidebox-input" aria-label="Network status">
      <div className="sidebar-section-title">
        <strong>Input status</strong>
        <span>{project.feeds.length} feed{project.feeds.length === 1 ? '' : 's'}</span>
      </div>

      <div className={classNames('sidebox-input-hero', `tone-${statusTone}`)}>
        <span />
        <div>
          <strong>{routingStoreReady ? 'Local service model ready' : routingStoreStored ? 'GTFS indexed in SQLite' : 'GTFS index needed'}</strong>
          <small>{scheduleText}</small>
        </div>
      </div>

      <div className="sidebox-health-grid">
        <div>
          <Database size={13} />
          <span>{formatNumber(preview.routes.length)}</span>
          <small>routes</small>
        </div>
        <div>
          <MapPin size={13} />
          <span>{formatNumber(preview.stops.length)}</span>
          <small>stops</small>
        </div>
        <div>
          <TableProperties size={13} />
          <span>{formatNumber(feed.tripCount)}</span>
          <small>trips</small>
        </div>
        <div>
          <Server size={13} />
          <span>{formatBytes(feed.fileSize)}</span>
          <small>{feed.fileName || 'GTFS ZIP'}</small>
        </div>
      </div>

      <div className="sidebox-finding-list">
        <div className={classNames('sidebox-finding', osmStreetIndex ? 'tone-good' : 'tone-watch')}>
          <strong>{osmStreetIndex ? 'OSM indexed locally' : 'OSM required for full functionality'}</strong>
          <span>{osmStreetMessage || osmText}</span>
        </div>
        {missingRequiredTables.length ? (
          <div className="sidebox-finding tone-risk">
            <strong>Missing required tables</strong>
            <span>{missingRequiredTables.join(', ')}</span>
          </div>
        ) : null}
        {severeWarnings.map((warning) => (
          <div key={warning.id} className={classNames('sidebox-finding', warning.severity === 'error' ? 'tone-risk' : 'tone-watch')}>
            <strong>{warning.table || 'GTFS warning'}</strong>
            <span>{warning.message}</span>
          </div>
        ))}
        {!missingRequiredTables.length && !severeWarnings.length ? (
          <div className="sidebox-finding tone-good">
            <strong>Validation clear</strong>
            <span>Required GTFS tables and indexed map artifacts are present.</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function SidebarNetworkBox({
  mapScope,
  networkLens,
  basemap,
  scheduleTimeMinutes,
  scheduleServiceDate,
  scheduleDiagnostics,
  scheduleEndMinutes,
  lensInsight,
  performanceProfile,
  livePositionCount,
  realtimeSnapshot,
  onMapScopeChange,
  onNetworkLensChange,
  onBasemapChange,
  onScheduleTimeChange,
  onScheduleServiceDateChange,
  onOpenLive,
}: {
  mapScope: MapScope
  networkLens: NetworkLens
  basemap: Basemap
  scheduleTimeMinutes: number
  scheduleServiceDate: string
  scheduleDiagnostics: ReturnType<typeof scheduledVehicleDiagnostics>
  scheduleEndMinutes: number
  lensInsight: ReturnType<typeof buildNetworkLensInsight>
  performanceProfile: ReturnType<typeof buildNetworkPerformanceProfile>
  livePositionCount: number
  realtimeSnapshot: RealtimeSnapshot | null
  onMapScopeChange: (scope: MapScope) => void
  onNetworkLensChange: (lens: NetworkLens) => void
  onBasemapChange: (basemap: Basemap) => void
  onScheduleTimeChange: (minutes: number) => void
  onScheduleServiceDateChange: (serviceDate: string) => void
  onOpenLive: () => void
}) {
  const clock = formatServiceTime(scheduleTimeMinutes)

  return (
    <section className="sidebar-section sidebox sidebox-network" aria-label="Network controls">
      <div className="sidebar-section-title">
        <strong>Network</strong>
        <span>{performanceProfile.title}</span>
      </div>

      <div className="sidebox-row sidebox-scope" role="group" aria-label="Map scope">
        <button type="button" className={classNames(mapScope === 'network' && 'is-active')} onClick={() => onMapScopeChange('network')}>
          Network
        </button>
        <button type="button" className={classNames(mapScope === 'route' && 'is-active')} onClick={() => onMapScopeChange('route')}>
          Route
        </button>
      </div>

      <div className="sidebox-lens-grid" role="group" aria-label="Network lens">
        {networkLensOptions.map((lens) => (
          <button
            key={lens}
            type="button"
            className={classNames(networkLens === lens && 'is-active')}
            onClick={() => onNetworkLensChange(lens)}
          >
            {networkLensLabels[lens]}
          </button>
        ))}
      </div>

      <div className={classNames('sidebox-insight', `tone-${lensInsight.tone}`)} title={lensInsight.detail}>
        <span />
        <strong>{lensInsight.title}</strong>
        <small>{lensInsight.detail}</small>
      </div>

      <div className="sidebox-time">
        <div className={classNames('sidebox-time-readout', `tone-${scheduleDiagnostics.tone}`)} title={scheduleDiagnostics.detail}>
          <Clock3 size={14} />
          <span>
            <strong>{clock}</strong>
            <small>{scheduleDiagnostics.title}</small>
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={scheduleEndMinutes}
          step={1}
          value={scheduleTimeMinutes}
          onChange={(event) => onScheduleTimeChange(Number(event.currentTarget.value))}
          aria-label="Scrub scheduled vehicle positions"
        />
      </div>

      <div className="sidebox-row sidebox-presets" role="group" aria-label="Time presets">
        {schedulePresets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={classNames(Math.abs(scheduleTimeMinutes - preset.minutes) <= 2 && 'is-active')}
            onClick={() => onScheduleTimeChange(preset.minutes)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <label className="sidebox-row sidebox-days">
        Service date
        <input
          type="date"
          value={scheduleServiceDate}
          onChange={(event) => onScheduleServiceDateChange(event.currentTarget.value)}
          aria-label="Network service date"
        />
      </label>

      <div className="sidebox-row sidebox-basemap" role="group" aria-label="Basemap">
        {basemapOptions.map((option) => (
          <button
            key={option}
            type="button"
            className={classNames(basemap === option && 'is-active')}
            onClick={() => onBasemapChange(option)}
            title={basemapLabels[option]}
          >
            {basemapShortLabels[option]}
          </button>
        ))}
      </div>

      <button type="button" className={classNames('sidebox-live', livePositionCount > 0 && 'has-live')} onClick={onOpenLive}>
        <Radio size={14} />
        <span>{livePositionCount > 0 ? `${formatNumber(livePositionCount)} live vehicles` : realtimeSnapshot ? 'Live · 0 positions' : 'Connect live'}</span>
      </button>
    </section>
  )
}

function realtimePositionCount(snapshot: RealtimeSnapshot | null, route?: RouteMetric) {
  const routeId = route?.routeId || route?.shortName
  return snapshot?.vehicles.filter((vehicle) => (
    typeof vehicle.lon === 'number'
    && Number.isFinite(vehicle.lon)
    && Math.abs(vehicle.lon) <= 180
    && typeof vehicle.lat === 'number'
    && Number.isFinite(vehicle.lat)
    && Math.abs(vehicle.lat) <= 90
    && (!routeId || vehicle.routeId === routeId)
  )).length ?? 0
}

type NetworkLensInsight = {
  tone: 'good' | 'watch' | 'risk'
  title: string
  detail: string
}

function buildNetworkLensInsight(feed: FeedSummary, preview: MapPreview, networkLens: NetworkLens): NetworkLensInsight {
  const routeCount = preview.routes.length
  const stopCount = preview.stops.length
  const tripCount = preview.routes.reduce((sum, route) => sum + route.tripCount, 0)
  const inferredRoutes = preview.routes.filter((route) => route.geometrySource !== 'shape')
  const shapeBackedRoutes = routeCount - inferredRoutes.length
  const serviceWeakRoutes = preview.routes.filter((route) => route.headwayMinutes > 30 || route.spanHours < 14)
  const transferStops = preview.stops.filter((stop) => stop.routes.length >= 2)
  const blockingWarnings = feed.warnings.filter((warning) => warning.severity === 'error')
  const scenarioRoutes = preview.routes.filter((route) => route.status === 'added' || route.status === 'changed' || route.status === 'removed')
  const totalRiskItems = blockingWarnings.length + inferredRoutes.length + serviceWeakRoutes.length + scenarioRoutes.length

  if (networkLens === 'shape') {
    return inferredRoutes.length
      ? {
          tone: 'watch',
          title: `${formatNumber(inferredRoutes.length)} inferred pattern${inferredRoutes.length === 1 ? '' : 's'}`,
          detail: 'Amber lines use inferred geometry because their GTFS data has no shapes.',
        }
      : {
          tone: 'good',
          title: 'Shape coverage looks strong',
          detail: `${formatNumber(routeCount)} patterns are using GTFS shape geometry.`,
        }
  }

  if (networkLens === 'service') {
    return serviceWeakRoutes.length
      ? {
          tone: 'risk',
          title: `${formatNumber(serviceWeakRoutes.length)} weak service pattern${serviceWeakRoutes.length === 1 ? '' : 's'}`,
          detail: 'Red/amber marks headway above 30m or span below 14h.',
        }
      : {
          tone: 'good',
          title: 'Service lens is clean',
          detail: 'Every route in this scope stays within the basic headway and span limits.',
        }
  }

  if (networkLens === 'transfer') {
    return transferStops.length
      ? {
          tone: 'good',
          title: `${formatNumber(transferStops.length)} transfer stop${transferStops.length === 1 ? '' : 's'}`,
          detail: 'Large halos show the most connected places in the bundle.',
        }
      : {
          tone: 'watch',
          title: 'No transfer pressure detected',
          detail: 'This scope has no stops shared by multiple route patterns.',
        }
  }

  if (networkLens === 'risk') {
    return totalRiskItems
      ? {
          tone: blockingWarnings.length ? 'risk' : 'watch',
          title: `${formatNumber(totalRiskItems)} deterministic risk signal${totalRiskItems === 1 ? '' : 's'}`,
          detail: 'Risk combines blocking rows, inferred shapes, weak service, and scenario deltas.',
        }
      : {
          tone: 'good',
          title: 'No major risk signal',
          detail: 'Validation, shape, service, and scenario checks are quiet in this scope.',
        }
  }

  return {
    tone: inferredRoutes.length ? 'watch' : 'good',
    title: inferredRoutes.length
      ? `${formatNumber(shapeBackedRoutes)}/${formatNumber(routeCount)} shape-backed`
      : `${formatNumber(routeCount)} patterns / ${formatNumber(stopCount)} stops`,
    detail: inferredRoutes.length
      ? `${formatNumber(inferredRoutes.length)} inferred pattern${inferredRoutes.length === 1 ? '' : 's'} are capped to avoid fake route chords.`
      : `${formatNumber(tripCount)} scheduled trips are indexed for network review.`,
  }
}
