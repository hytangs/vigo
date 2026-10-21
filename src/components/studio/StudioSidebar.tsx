import { memo } from 'react'
import { countRender } from '../../app/renderCounts'
import { shallowEqual, useStore } from '../../app/store'
import { classNames } from '../../domain'
import { clock, changeServiceDate, setScheduleTime } from '../../state/clock'
import { useStudio, useStudioRecord } from '../../state/hooks'
import {
  openAnalyzeView,
  openDataView,
  openNetworkView,
  openPathfinderView,
  openSettingsView,
} from '../../state/navigation'
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
  routingDisplayPoints,
  routingNetwork,
  selectRoutingPlan,
  setRoutingAllowLongWalk,
  setRoutingAllowStreetTransfers,
  setRoutingMaxTransfers,
  setRoutingWheelchair,
  setRoutingMinimumTransferBuffer,
  toggleRouting,
  wheelchairAvailable,
} from '../../state/route'
import { hasActiveOperationsData, routingScope } from '../../state/scope'
import { shell } from '../../state/shell'
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

/** The workspace sidebar: the rail and the Route or Analyze panel. */
export const VigoSidebar = memo(function VigoSidebar() {
  countRender('VigoSidebar')
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const hasActiveData = useStudio(hasActiveOperationsData)
  return (
    <aside className="app-sidebar" aria-label="City navigation">
      <StudioRail hasActiveData={hasActiveData} />
      <section className={classNames('sidebar-panel', `is-${activeRouteTool}`)} aria-label="City panel" data-map-occluder>
        {!hasActiveData ? (
          <div className="sidebar-empty-note">
            <strong>No routes indexed</strong>
            <span>Load a GTFS ZIP to create route patterns, stops, schedules, and the network map.</span>
          </div>
        ) : activeRouteTool === 'analyze' ? <AnalyzePanel /> : <SidebarRouteBox />}
      </section>
    </aside>
  )
})

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
    routingWheelchair: state.routingWheelchair,
    routingMinimumTransferBufferMinutes: state.routingMinimumTransferBufferMinutes,
    routingPointError: state.routingPointError,
    routingPickIndex: state.routingPickIndex,
  }), shallowEqual)
  const showWheelchair = useStudio(wheelchairAvailable)
  const routingNetworkState = useStudio(routingNetwork)
  const points = useStudio(routingDisplayPoints)
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
      routingOrigin={points.routingOrigin}
      routingWaypoints={points.routingWaypoints}
      routingDestination={points.routingDestination}
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
      routingWheelchair={showWheelchair && settings.routingWheelchair}
      onRoutingWheelchairChange={showWheelchair ? setRoutingWheelchair : undefined}
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
