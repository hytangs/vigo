import { liveVehicleDiagnostics, type MapScope } from './presentation'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { OperationalEvent } from '../../agency/types'
import { apiJson } from '../../app/api'
import { buildCityPreviewLod } from '../../app/cityPreview'
import { networkRouteId } from '../../app/networkSelection'
import { type RoutingActivity } from '../../app/routingPlan'
import {
  classNames,
  formatNumber,
  type Appearance,
  type Basemap,
  type FeedSummary,
  type LayerState,
  type MapPreview,
  type NetworkLens,
  type RealtimeSnapshot,
  type RouteMetric,
} from '../../domain'
import { buildNetworkPerformanceProfile } from '../../networkPerformance'
import {
  type ReachComparisonResult,
  type ReachResult,
  type ScenarioRenderMode,
  type ScenarioStopDraft,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from '../../reach'
import { type RoutingPlan, type RoutingPoint } from '../../routingModel'
import {
  formatServiceTime,
  scheduledServiceEndMinutes,
  scheduledVehicleDiagnostics,
  scheduledVehiclesAtTime,
} from '../../scheduledVehicles'
import {
  buildServiceVehicleFrame,
  serviceKeyForRoute,
  serviceVehicleCount,
  type ServiceVehicleFrame,
  type ServiceVehicleMode,
} from '../../serviceVehicles'
import { AgencyRouteLine } from '../AgencyRouteLine'
import { LazyVigoMap } from '../LazyVigoMap'
import { ServiceStateControl } from '../ServiceStateControl'
import type { TripTarget } from '../StopArrivalBoard'

function MapScopeControl({
  mapScope,
  routeFocusAvailable,
  onMapScopeChange,
}: {
  mapScope: MapScope
  routeFocusAvailable: boolean
  onMapScopeChange: (scope: MapScope) => void
}) {
  return (
    <div className="map-scope-control">
      <span className="map-scope-actions" role="group" aria-label="Map view">
        <button
          type="button"
          className={classNames(mapScope === 'network' && 'is-active')}
          aria-pressed={mapScope === 'network'}
          onClick={() => onMapScopeChange('network')}
        >
          Network
        </button>
        <button
          type="button"
          className={classNames(mapScope === 'route' && routeFocusAvailable && 'is-active')}
          aria-pressed={mapScope === 'route' && routeFocusAvailable}
          disabled={!routeFocusAvailable}
          onClick={() => onMapScopeChange('route')}
        >
          Route
        </button>
      </span>
    </div>
  )
}

const emptyVehicleFrame: ServiceVehicleFrame = { mode: 'schedule', vehicles: [], tripUpdateCount: 0, alertCount: 0 }

export function RouteSurface({
  onOpenTrip,
  operationalEvents,
  agencyFocus,
  scheduleLoadStatus,
  agencyLocation,
  routeDetailStatus,
  projectId,
  feed,
  focusedPreview,
  visiblePreview,
  selectedRoute,
  mapScope,
  networkLens,
  layers,
  appearance,
  basemap,
  localBasemapAvailable,
  localBasemapRevision,
  selectedRouteId,
  selectedStopId,
  realtimeSnapshot,
  vehicleMode,
  scheduleTimeMinutes,
  scheduleServiceDate,
  routingEnabled,
  routingOrigin,
  routingWaypoints,
  routingDestination,
  routingPlan,
  routingFocus,
  analysisFocus,
  reachResult,
  reachComparison,
  serviceDecomposition,
  scenarioView,
  scenarioRenderMode,
  scenarioCutoffMinutes,
  scenarioSketchStops,
  scenarioSketchGeometry,
  scenarioPointPicking,
  onMoveScenarioStop,
  routingActivity,
  cityPreviewLoading,
  onMapScopeChange,
  onVehicleModeChange,
  onScheduleTimeChange,
  onScheduleServiceDateChange,
  onRoutingPoint,
  onSelectRoute,
  onSelectStop,
}: {
  agencyLocation?: { id: string; label: string; coordinate: [number, number]; stopId?: string }
  operationalEvents?: OperationalEvent[]
  agencyFocus: boolean
  scheduleLoadStatus?: string
  routeDetailStatus?: string
  projectId: string
  feed: FeedSummary
  focusedPreview: MapPreview
  visiblePreview: MapPreview
  selectedRoute?: RouteMetric
  networkLens: NetworkLens
  layers: LayerState
  appearance: Appearance
  basemap: Basemap
  localBasemapAvailable: boolean
  localBasemapRevision?: string
  selectedRouteId: string
  selectedStopId: string
  realtimeSnapshot: RealtimeSnapshot | null
  vehicleMode: ServiceVehicleMode
  mapScope: MapScope
  scheduleTimeMinutes: number
  scheduleServiceDate: string
  routingEnabled: boolean
  routingOrigin: RoutingPoint | null
  routingWaypoints: RoutingPoint[]
  routingDestination: RoutingPoint | null
  routingPlan: RoutingPlan | null
  routingFocus: boolean
  analysisFocus: boolean
  reachResult: ReachResult | null
  reachComparison: ReachComparisonResult[] | null
  serviceDecomposition: ServiceEdgeDecomposition | null
  scenarioView: ScenarioView
  scenarioRenderMode: ScenarioRenderMode
  scenarioCutoffMinutes: number
  scenarioSketchStops: ScenarioStopDraft[]
  scenarioSketchGeometry: [number, number][]
  scenarioPointPicking: boolean
  onMoveScenarioStop?: (index: number, coordinate: [number, number]) => void
  routingActivity: RoutingActivity
  cityPreviewLoading: boolean
  onMapScopeChange: (scope: MapScope) => void
  onVehicleModeChange: (mode: ServiceVehicleMode) => void
  onScheduleTimeChange: (minutes: number) => void
  onScheduleServiceDateChange: (serviceDate: string) => void
  onRoutingPoint?: (point: RoutingPoint) => void
  onOpenTrip?: (trip: TripTarget) => void
  onSelectRoute: (id: string, options?: { inspect?: boolean }) => void
  onSelectStop: (id: string, options?: { inspect?: boolean }) => void
}) {
  const isNetworkMap = mapScope === 'network' || !selectedRoute
  const scheduledNetwork = isNetworkMap && agencyFocus && vehicleMode === 'schedule' && !routingFocus && !analysisFocus
  const routingCanvasPreview = useMemo<MapPreview>(() => ({ routes: [], stops: visiblePreview.stops, stopPairs: [] }), [visiblePreview.stops])
  const cityMapPreview = useMemo(
    () => buildCityPreviewLod(visiblePreview, selectedRouteId, undefined, selectedStopId),
    [selectedRouteId, selectedStopId, visiblePreview],
  )
  const mapPreview = routingFocus || analysisFocus ? routingCanvasPreview : isNetworkMap || scheduledNetwork ? cityMapPreview : focusedPreview
  const mapLayers = useMemo<LayerState>(() => (
    routingFocus || analysisFocus
      ? {
        ...layers,
        routes: false,
        segments: false,
        stops: true,
        transfers: false,
        coverage: false,
        scenario: false,
        access: false,
      }
      : layers
  ), [analysisFocus, layers, routingFocus])
  const selectedMapRouteId = routingFocus || analysisFocus || isNetworkMap || scheduledNetwork ? '' : selectedRouteId
  const performanceProfile = useMemo(
    () => buildNetworkPerformanceProfile(routingFocus || analysisFocus ? visiblePreview : mapPreview, { precise: !isNetworkMap && !routingFocus && !analysisFocus }),
    [analysisFocus, isNetworkMap, mapPreview, routingFocus, visiblePreview],
  )
  const scheduledVehicles = useMemo(
    () => vehicleMode === 'live' || routingFocus || analysisFocus
      ? []
      : scheduledVehiclesAtTime(mapPreview, scheduleTimeMinutes, scheduleServiceDate),
    [analysisFocus, mapPreview, routingFocus, scheduleServiceDate, scheduleTimeMinutes, vehicleMode],
  )
  const vehicleFrame = useMemo(
    () => routingFocus || analysisFocus ? emptyVehicleFrame : buildServiceVehicleFrame({
      mode: vehicleMode,
      preview: vehicleMode === 'live' ? visiblePreview : mapPreview,
      realtimeSnapshot,
      operationalEvents,
      scheduledVehicles,
    }),
    [analysisFocus, mapPreview, realtimeSnapshot, operationalEvents, routingFocus, scheduledVehicles, vehicleMode, visiblePreview],
  )
  const visibleVehicleCount = serviceVehicleCount(vehicleFrame, isNetworkMap || scheduledNetwork ? undefined : selectedRoute, mapPreview)
  const selectedPatternOnly = !isNetworkMap && mapPreview.routes.length === 1 && (selectedRoute?.serviceVariantCount ?? 1) > 1
  const unknownBranchVehicles = vehicleMode === 'live' && selectedPatternOnly && selectedRoute
    ? vehicleFrame.vehicles.filter((vehicle) => vehicle.serviceKey === serviceKeyForRoute(selectedRoute) && !vehicle.routeFeatureId).length
    : 0
  const serviceDiagnostics = useMemo(
    () => vehicleMode === 'live'
      ? selectedPatternOnly
        ? {
            tone: unknownBranchVehicles || !visibleVehicleCount ? 'watch' as const : 'good' as const,
            title: visibleVehicleCount ? `${formatNumber(visibleVehicleCount)} matched live vehicles` : 'No vehicles matched to this pattern',
            detail: `${formatNumber(visibleVehicleCount)} live vehicles matched to this GTFS pattern.${unknownBranchVehicles ? ` ${formatNumber(unknownBranchVehicles)} vehicles have an unknown branch; view Full service to see them.` : ''}`,
          }
        : liveVehicleDiagnostics(visibleVehicleCount, realtimeSnapshot !== null)
      : scheduledVehicleDiagnostics(mapPreview, scheduledVehicles, scheduleTimeMinutes, scheduleServiceDate),
    [mapPreview, realtimeSnapshot, scheduleServiceDate, scheduleTimeMinutes, scheduledVehicles, selectedPatternOnly, unknownBranchVehicles, vehicleMode, visibleVehicleCount],
  )
  const routeStyle = {
    '--route-color': selectedRoute?.color ?? '#6da8ff',
  } as CSSProperties
  const scheduleEndMinutes = useMemo(
    () => scheduledServiceEndMinutes(mapPreview, scheduleServiceDate),
    [mapPreview, scheduleServiceDate],
  )
  const [servicePlaybackRunning, setServicePlaybackRunning] = useState(false)
  const [scheduleClockError, setScheduleClockError] = useState('')
  async function scheduleNow() {
    setServicePlaybackRunning(false)
    setScheduleClockError('')
    try {
      const result = await apiJson<{ data: { instant: string; clocks: Array<{ timezone: string }> } }>(`/api/projects/${encodeURIComponent(projectId)}/agency`, {
        method: 'POST', body: JSON.stringify({ action: 'tool', name: 'current_time', arguments: { resultUse: 'continue' } }),
      })
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: result.data.clocks[0].timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(result.data.instant)).map(part => [part.type, part.value]))
      onScheduleServiceDateChange(`${parts.year}-${parts.month}-${parts.day}`)
      onScheduleTimeChange(Number(parts.hour) * 60 + Number(parts.minute))
    } catch (error) { setScheduleClockError(error instanceof Error ? error.message : 'Current City time is unavailable.') }
  }
  const [agencyView, setAgencyView] = useState<'map' | 'line'>('map')
  useEffect(() => { if (agencyLocation || isNetworkMap) setAgencyView('map') }, [agencyLocation, isNetworkMap])
  const showAgencyLine = agencyFocus && agencyView === 'line' && !routingFocus && !analysisFocus
  const [servicePlaybackStep, setServicePlaybackStep] = useState(1)
  const playbackTimeRef = useRef(scheduleTimeMinutes)

  useEffect(() => {
    playbackTimeRef.current = scheduleTimeMinutes
  }, [scheduleTimeMinutes])

  useEffect(() => {
    if ((routingFocus || analysisFocus || vehicleMode === 'live') && servicePlaybackRunning) setServicePlaybackRunning(false)
  }, [analysisFocus, routingFocus, servicePlaybackRunning, vehicleMode])

  useEffect(() => {
    if (!servicePlaybackRunning || routingFocus || analysisFocus || vehicleMode === 'live') return undefined
    const timer = window.setInterval(() => {
      const nextTime = (playbackTimeRef.current + servicePlaybackStep) % (scheduleEndMinutes + 1)
      playbackTimeRef.current = nextTime
      onScheduleTimeChange(nextTime)
    }, 650)
    return () => window.clearInterval(timer)
  }, [analysisFocus, onScheduleTimeChange, routingFocus, scheduleEndMinutes, servicePlaybackRunning, servicePlaybackStep, vehicleMode])

  return (
    <section className="route-surface" aria-label="GTFS map and service state" style={routeStyle}>
      <div className="service-toolbar">
        {!showAgencyLine && !routingFocus && !analysisFocus ? (
          <ServiceStateControl
            onNow={() => void scheduleNow()}
            mode={vehicleMode}
            frame={vehicleFrame}
            vehicleCount={visibleVehicleCount}
            diagnostics={serviceDiagnostics}
            scheduleTimeMinutes={scheduleTimeMinutes}
            scheduleServiceDate={scheduleServiceDate}
            scheduleEndMinutes={scheduleEndMinutes}
            playbackRunning={servicePlaybackRunning}
            playbackStep={servicePlaybackStep}
            onModeChange={onVehicleModeChange}
            onTogglePlayback={() => setServicePlaybackRunning((current) => !current)}
            onPlaybackStepChange={setServicePlaybackStep}
            onScheduleTimeChange={onScheduleTimeChange}
            onScheduleServiceDateChange={onScheduleServiceDateChange}
          />
        ) : null}
      </div>
      <div className="surface-panel route-map-shell">
        {showAgencyLine ? <AgencyRouteLine vehicleFrame={vehicleFrame} onOpenTrip={onOpenTrip} key={`${projectId}/${selectedRouteId}`} projectId={projectId} preview={focusedPreview} routeId={isNetworkMap ? '' : selectedRoute ? networkRouteId(selectedRoute) : selectedRouteId} selectedStopId={selectedStopId} showStopDetails={false} onSelectStop={onSelectStop} /> : <LazyVigoMap
          onOpenTrip={agencyFocus ? onOpenTrip : undefined}
          showStopDetails={!agencyFocus}
          focusLocation={agencyFocus ? agencyLocation : undefined}
          projectId={projectId}
          localBasemapAvailable={localBasemapAvailable}
          localBasemapRevision={localBasemapRevision}
          preview={mapPreview}
          feedName={feed.name}
          layers={mapLayers}
          networkLens={networkLens}
          basemap={basemap}
          appearance={appearance}
          performanceProfile={performanceProfile}
          focusMode={analysisFocus ? 'scenario' : routingFocus ? 'routing' : isNetworkMap || scheduledNetwork ? 'network' : 'route'}
          selectedRouteId={selectedMapRouteId}
          selectedStopId={selectedStopId}
          vehicleFrame={vehicleFrame}
          routingEnabled={routingEnabled}
          routingOrigin={routingOrigin}
          routingWaypoints={routingWaypoints}
          routingDestination={routingDestination}
          routingPlan={routingPlan}
          reachResult={reachResult}
          reachComparison={reachComparison}
          serviceDecomposition={serviceDecomposition}
          scenarioView={scenarioView}
          scenarioRenderMode={scenarioRenderMode}
          scenarioCutoffMinutes={scenarioCutoffMinutes}
          scenarioSketchStops={scenarioSketchStops}
          scenarioSketchGeometry={scenarioSketchGeometry}
          scenarioPointPicking={scenarioPointPicking}
          onMoveScenarioStop={onMoveScenarioStop}
          routingStatusTitle={!routingOrigin && !routingDestination ? 'Choose origin and destination' : routingActivity.title}
          routingStatusDetail={!routingOrigin && !routingDestination ? 'Search for two places or pick them on the map.' : routingActivity.detail}
          onSelectRoute={onSelectRoute}
          onSelectStop={onSelectStop}
          onRoutingPoint={onRoutingPoint}
        />}
        {!agencyFocus && !routingFocus && !analysisFocus ? (
          <MapScopeControl
            mapScope={isNetworkMap ? 'network' : 'route'}
            routeFocusAvailable={Boolean(selectedRoute)}
            onMapScopeChange={onMapScopeChange}
          />
        ) : null}
        {agencyFocus && (!isNetworkMap || routingFocus || analysisFocus) ? (
          <div className="agency-map-context">
            <div>
              <span>{routingFocus ? 'Journey' : analysisFocus ? 'Reachable area' : isNetworkMap ? vehicleMode === 'live' ? 'Live network' : 'Scheduled network' : `Route ${selectedRoute?.shortName || selectedRoute?.longName || ''}`}</span>
              <small aria-live="polite">
                {routingFocus || analysisFocus ? 'From your investigation' : (
                  <>
                    {vehicleMode === 'schedule' ? `Estimated positions · ${formatServiceTime(scheduleTimeMinutes)}` : realtimeSnapshot ? `Latest feed · ${visibleVehicleCount} vehicle ${visibleVehicleCount === 1 ? 'location' : 'locations'}` : 'Connect feeds to see vehicle reports'}
                    {vehicleMode === 'schedule' && scheduleLoadStatus ? ` · ${scheduleLoadStatus}` : ''}
                    {scheduleClockError ? ` · ${scheduleClockError}` : ''}
                    {!isNetworkMap && routeDetailStatus ? ` · ${routeDetailStatus}` : ''}
                  </>
                )}
              </small>
            </div>
            <div className="agency-map-actions">
              {!isNetworkMap && !routingFocus && !analysisFocus ? <div className="agency-view-switch" role="group" aria-label="Route display"><button aria-pressed={!showAgencyLine} onClick={() => setAgencyView('map')}>Map</button><button aria-pressed={showAgencyLine} onClick={() => setAgencyView('line')}>Line view</button></div> : null}
              {!isNetworkMap || routingFocus || analysisFocus ? <button className="agency-button" onClick={() => { setAgencyView('map'); onMapScopeChange('network') }}>Network map</button> : null}
            </div>
          </div>
        ) : null}
        {cityPreviewLoading ? (
          <div className="surface-loading-overlay" role="status" aria-live="polite">
            <span className="surface-preview-loading" />
            <strong>Loading City…</strong>
          </div>
        ) : null}

        {!showAgencyLine && !routingFocus && !analysisFocus && !cityPreviewLoading && !mapPreview.routes.length ? (
          <div className="route-geometry-empty">
            <strong>No spatial alignment in this scope</strong>
            <span>The service remains indexed. Inspect stop coordinates, stop sequences, and shapes.txt to establish defensible map geometry.</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
