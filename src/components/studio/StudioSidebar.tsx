import { lazy, memo, Suspense, useLayoutEffect, useRef } from 'react'
import { publicRouting } from '../../app/publicRouting'
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
  openScenariosView,
  openSettingsView,
} from '../../state/navigation'
import {
  changeRoutingDataMode,
  changeRoutingDepartureWindow,
  changeRoutingMaxWalkKm,
  changeRoutingMode,
  changeRoutingBike,
  changeRoutingTimePreference,
  clearRouting,
  pickRoutingPoint,
  reorderRoutingPoints,
  rerunRouting,
  route,
  routingActivity,
  routingPlan,
  routingDetailOpen,
  routingDisplayPoints,
  routingNetwork,
  selectRoutingPlan,
  setRoutingAllowLongWalk,
  setRoutingAllowStreetTransfers,
  setRoutingMaxTransfers,
  setRoutingWheelchair,
  prepareRoutingWheelchair,
  wheelchairSelectionKey,
  setRoutingMinimumTransferBuffer,
  toggleRouting,
  wheelchairAvailable,
} from '../../state/route'
import { hasActiveOperationsData, routingScope } from '../../state/scope'
import { shell } from '../../state/shell'
import { SidebarPathfinderBox } from '../PathfinderPanel'
import { PrimaryNav } from '../PrimaryNav'

// Analysis tools load on first use; the public planner needs neither.
const AnalyzePanel = lazy(() => import('../AnalyzePanel').then(module => ({ default: module.AnalyzePanel })))
const ScenarioPanel = lazy(() => import('../scenarios/ScenarioPanel').then(module => ({ default: module.ScenarioPanel })))

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
      onOpenScenarios={openScenariosView}
      onOpenSettings={openSettingsView}
    />
  )
})

/** Keep the rail mounted while switching workspace panels and Settings. */
export const VigoSidebar = memo(function VigoSidebar({ hasCityData }: { hasCityData: boolean }) {
  countRender('VigoSidebar')
  const activeRouteTool = useStore(shell, (state) => state.activeRouteTool)
  const hasActiveData = useStudio(hasActiveOperationsData)
  const expanded = true
  const detailsOpen = useStudio(routingDetailOpen)
  const detailsWereOpen = useRef(detailsOpen)
  const panelRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const returningToRoutes = detailsWereOpen.current && !detailsOpen
    detailsWereOpen.current = detailsOpen
    if (!publicRouting || !expanded || detailsOpen) return
    const scroller = panelRef.current?.querySelector<HTMLElement>('.pathfinder-query')
    const results = scroller?.querySelector<HTMLElement>('.pathfinder-outcome')
    if (!scroller) return
    const top = returningToRoutes && results
      ? scroller.scrollTop + results.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      : 0
    scroller.scrollTo({ top })
  }, [expanded, detailsOpen])
  return (
    <aside className="app-sidebar" aria-label="City navigation">
      {publicRouting ? null : <StudioRail hasActiveData={hasCityData} />}
      {activeRouteTool === 'data' || activeRouteTool === 'agency' ? null : <section ref={panelRef} className={classNames('sidebar-panel', `is-${activeRouteTool}`)} aria-label="City panel" id="route-controls" data-map-occluder data-mobile-expanded={publicRouting ? expanded : undefined}>
        {!hasActiveData ? (
          <div className="sidebar-empty-note">
            <strong>No routes indexed</strong>
            <span>Load a GTFS ZIP to create route patterns, stops, schedules, and the network map.</span>
          </div>
        ) : activeRouteTool === 'analyze' ? <Suspense fallback={null}><AnalyzePanel /></Suspense> : activeRouteTool === 'scenarios' ? <Suspense fallback={null}><ScenarioPanel /></Suspense> : <SidebarRouteBox />}
      </section>}
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
    routingBike: state.routingBike,
    routingDataMode: state.routingDataMode,
    routingDepartureWindowMinutes: state.routingDepartureWindowMinutes,
    routingMaxWalkKm: state.routingMaxWalkKm,
    routingMaxTransfers: state.routingMaxTransfers,
    routingAllowLongWalk: state.routingAllowLongWalk,
    routingAllowStreetTransfers: state.routingAllowStreetTransfers,
    routingWheelchair: state.routingWheelchair,
    wheelchairPrepareKey: state.wheelchairPrepareKey,
    wheelchairBuildingKey: state.wheelchairBuildingKey,
    wheelchairReason: state.wheelchairReason,
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
      routingBike={settings.routingBike}
      onRoutingBikeChange={changeRoutingBike}
      routingDataMode={settings.routingMode === 'transit' && routingNetworkState.selectedId ? 'scheduled' : settings.routingDataMode}
      routingNetwork={publicRouting ? undefined : routingNetworkState}
      routingDepartureWindowMinutes={settings.routingDepartureWindowMinutes}
      routingMaxWalkKm={settings.routingMaxWalkKm}
      routingMaxTransfers={settings.routingMaxTransfers}
      routingAllowLongWalk={settings.routingAllowLongWalk}
      routingAllowStreetTransfers={settings.routingAllowStreetTransfers}
      routingWheelchair={showWheelchair && settings.routingWheelchair}
      routingWheelchairAvailable={showWheelchair}
      routingWheelchairReason={settings.wheelchairReason}
      routingWheelchairPreparing={Boolean(settings.wheelchairBuildingKey)}
      onPrepareWheelchair={!publicRouting && settings.wheelchairPrepareKey === wheelchairSelectionKey() ? prepareRoutingWheelchair : undefined}
      onRoutingWheelchairChange={setRoutingWheelchair}
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
