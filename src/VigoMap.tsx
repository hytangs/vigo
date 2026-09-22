import {
  baseCanvasColor,
  ensureLocalStreetLayers,
  localStreetLimitForZoom,
  removeLocalStreetBasemap,
  syncBasemap,
} from './map/basemaps'
import { emptyCollection, isFiniteLngLat, lineGeometryCoordinates, stopLngLat, type FeatureCollection } from './map/featureGeometry'
import { routingLineFeatures, routingPinFeatures, serviceVehicleFeatures } from './map/journeyFeatures'
import {
  applyLayerVisibility,
  applyNetworkLensPaint,
  ensureLayers,
  existingScenarioComparisonLayerIds,
  reachComparisonLayerIds,
  reachResultLayerIds,
  setVisibility,
  stopLayerIds,
} from './map/layers'
import { accessFeatures, directionLabel, routeDisplayName, routeFeatures, segmentFeatures, stopFeatures } from './map/networkFeatures'
import {
  reachComparisonAreaFeatures,
  reachComparisonContourFeatures,
  reachComparisonEdgeFeatures,
  scenarioAreaFeatures,
  scenarioContourFeatures,
  scenarioEdgeFeatures,
  scenarioSketchFeatures,
} from './map/reachFeatures'

import type { GeoJsonProperties, Geometry } from 'geojson'
import { X } from 'lucide-react'
import {
  type GeoJSONFeatureDiff,
  type GeoJSONFeatureId,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MapLibreMap,
} from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cityPublicRouteKey } from './app/cityPreview'
import { reportDesktopMapFailed, reportDesktopMapPhase, reportDesktopMapReady } from './app/desktopBridge'
import {
  basemapTelemetryStatus,
  browserNavigationStart,
  createMapFirstRenderTracker,
  mapFirstRenderTimings,
  markBasemapFailed,
  markBasemapReady,
  markBasemapRequested,
  markLocalSourceRendered,
  markLocalSourceSubmitted,
  markMapCreated,
  markMapLoaded,
  type MapFirstRenderPhase,
  type MapFirstRenderTracker,
} from './app/mapFirstRenderTelemetry'
import * as maplibregl from './app/mapRuntime'
import { setMapSourceData, setStreetMapSourceData } from './app/mapSourceUpdates'
import { renderedStopAtPoint } from './app/mapStopSelection'
import { mapFitPadding, previewStopBounds } from './app/mapViewport'
import { findNetworkStop } from './app/networkSelection'
import { routeGeometryLabel } from './app/routePresentation'
import { AgencyVehicleDetails, VehicleOperationalWarnings } from './components/AgencyVehicleDetails'
import { StopArrivalBoard, type TripNavigation } from './components/StopArrivalBoard'
import type { Appearance, Basemap, LayerState, LngLat, MapPreview, NetworkLens } from './domain'
import { classNames, formatNumber } from './domain'
import { buildNetworkPerformanceProfile, type NetworkPerformanceProfile } from './networkPerformance'
import {
  reachComparisonColor,
  type ReachComparisonResult,
  type ReachResult,
  type ScenarioRenderMode,
  type ScenarioStopDraft,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from './reach'
import type { RoutingPlan, RoutingPoint } from './routingModel'
import { serviceVehicleIsVisible, type ServiceVehicleFrame } from './serviceVehicles'
const emptyRoutingPoints: RoutingPoint[] = []
const emptyScenarioStops: ScenarioStopDraft[] = []
const emptyCoordinates: [number, number][] = []

type MapLiveSelection = {
  stopId?: string
  vehicleId?: string
  vehicleSourceUrl?: string
  tone: 'route' | 'segment' | 'stop' | 'vehicle'
  eyebrow: string
  title: string
  subtitle: string
  journey?: {
    destination: string
    nextStop: string
    arrival: string
    arrivalLabel: string
  }
  metrics: Array<{ value: string; label: string }>
}

export type VigoMapProps = {
  showStopDetails?: boolean
  projectId?: string
  localStreetGraphAvailable?: boolean
  preview: MapPreview
  feedName: string
  layers: LayerState
  networkLens: NetworkLens
  basemap: Basemap
  appearance: Appearance
  selectedRouteId: string
  selectedStopId: string
  focusLocation?: { id: string; label: string; coordinate: LngLat; stopId?: string }
  vehicleFrame: ServiceVehicleFrame
  routingEnabled?: boolean
  routingOrigin?: RoutingPoint | null
  routingWaypoints?: RoutingPoint[]
  routingDestination?: RoutingPoint | null
  routingPlan?: RoutingPlan | null
  routingStatusTitle?: string
  routingStatusDetail?: string
  reachResult?: ReachResult | null
  reachComparison?: ReachComparisonResult[] | null
  serviceDecomposition?: ServiceEdgeDecomposition | null
  scenarioView?: ScenarioView
  scenarioRenderMode?: ScenarioRenderMode
  scenarioCutoffMinutes?: number
  scenarioSketchStops?: ScenarioStopDraft[]
  scenarioSketchGeometry?: LngLat[]
  scenarioPointPicking?: boolean
  onMoveScenarioStop?: (index: number, coordinate: LngLat) => void
  performanceProfile?: NetworkPerformanceProfile
  focusMode?: 'network' | 'route' | 'routing' | 'scenario'
  onOpenTrip?: TripNavigation
  onSelectRoute: (id: string, options?: { inspect?: boolean }) => void
  onSelectStop: (id: string, options?: { inspect?: boolean }) => void
  onRoutingPoint?: (point: RoutingPoint) => void
}

function scheduleMapFrameUpdate(
  map: MapLibreMap,
  ready: boolean,
  update: () => void,
  removed: () => boolean,
) {
  let frame = 0
  let cancelled = false
  const run = () => {
    if (!cancelled) update()
  }
  const schedule = () => {
    map.off('styledata', scheduleWhenReady)
    map.off('load', schedule)
    if (frame) window.cancelAnimationFrame(frame)
    frame = window.requestAnimationFrame(run)
  }
  const scheduleWhenReady = () => {
    if (map.isStyleLoaded()) schedule()
  }

  if (ready || map.loaded() || map.isStyleLoaded()) schedule()
  else {
    // Source loading can postpone `load`; local updates and raster startup only
    // require a style. Subscribe before that transition so neither waits on data.
    map.on('styledata', scheduleWhenReady)
    map.once('load', schedule)
  }

  return () => {
    cancelled = true
    if (frame) window.cancelAnimationFrame(frame)
    if (!removed()) {
      map.off('load', schedule)
      map.off('styledata', scheduleWhenReady)
    }
  }
}

function textProperty(properties: GeoJsonProperties | undefined, key: string, fallback = '') {
  const value = properties?.[key]
  if (value === null || value === undefined) return fallback
  return String(value)
}

function routingPointForMapClick(event: maplibregl.MapMouseEvent): RoutingPoint {
  const coordinate: LngLat = [event.lngLat.lng, event.lngLat.lat]
  // A click in Pathfinder defines a street-access area. It must not inherit a
  // rendered stop hit and silently turn into an exact-station request; nearby
  // OSM-reachable stations need to compete inside the routing search.
  return { coordinate, label: 'Map point', source: 'map' }
}

function scenarioPointForMapClick(
  map: MapLibreMap,
  event: maplibregl.MapMouseEvent,
  preview: MapPreview,
): RoutingPoint {
  const stopLayers = ['vigo-overview-stops', 'vigo-network-stops', 'vigo-transfer-stops', 'vigo-stops']
    .filter((layerId) => map.getLayer(layerId))
  const stopHit = stopLayers.length
    ? map.queryRenderedFeatures(event.point, { layers: stopLayers })[0]
    : undefined
  const stopId = textProperty(stopHit?.properties, 'stopId')
  const stop = stopId ? preview.stops.find((candidate) => candidate.id === stopId) : undefined
  if (stop && Number.isFinite(stop.lon) && Number.isFinite(stop.lat)) {
    return {
      coordinate: [Number(stop.lon), Number(stop.lat)],
      label: stop.name || stop.id,
      stopId: stop.id,
      source: 'stop',
    }
  }
  return routingPointForMapClick(event)
}

function numberProperty(properties: GeoJsonProperties | undefined, key: string) {
  const value = properties?.[key]
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function geometryLngLats(geometry: Geometry): LngLat[] {
  if (geometry.type === 'Point') return [geometry.coordinates as LngLat]
  if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates as LngLat[]
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return (geometry.coordinates as LngLat[][]).flat()
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as LngLat[][][]).flat(2)
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(geometryLngLats)
  return []
}

function mapContentBounds(...collections: FeatureCollection[]): LngLatBoundsLike | null {
  const coordinates: LngLat[] = []

  for (const collection of collections) {
    for (const feature of collection.features) {
      for (const coordinate of geometryLngLats(feature.geometry)) {
        if (!isFiniteLngLat(coordinate)) continue
        coordinates.push(coordinate)
      }
    }
  }

  if (!coordinates.length) return null
  const longitude = coordinates.map((coordinate) => coordinate[0]).sort((left, right) => left - right)
  const latitude = coordinates.map((coordinate) => coordinate[1]).sort((left, right) => left - right)
  const trim = coordinates.length >= 500 ? Math.floor(coordinates.length * 0.02) : 0
  return new maplibregl.LngLatBounds(
    [longitude[trim], latitude[trim]],
    [longitude[longitude.length - trim - 1], latitude[latitude.length - trim - 1]],
  )
}

function source(map: MapLibreMap, id: string): GeoJSONSource {
  const mapSource = map.getSource(id)
  if (!mapSource || !('setData' in mapSource)) {
    throw new Error(`Missing GeoJSON source: ${id}`)
  }
  return mapSource as GeoJSONSource
}

type DynamicPointSourceState = {
  source: GeoJSONSource
  ids: Set<GeoJSONFeatureId>
}

function updateDynamicPointSource(
  map: MapLibreMap,
  sourceId: string,
  data: FeatureCollection,
  stateRef: { current: DynamicPointSourceState | null },
) {
  const mapSource = source(map, sourceId)
  const currentIds = new Set<GeoJSONFeatureId>()
  const add: FeatureCollection['features'] = []
  const update: GeoJSONFeatureDiff[] = []
  const previous = stateRef.current?.source === mapSource ? stateRef.current : null

  for (const feature of data.features) {
    if (feature.id === undefined || currentIds.has(feature.id)) {
      mapSource.setData(data)
      stateRef.current = null
      return
    }
    currentIds.add(feature.id)
    if (!previous?.ids.has(feature.id)) {
      add.push(feature)
      continue
    }
    update.push({
      id: feature.id,
      newGeometry: feature.geometry,
      addOrUpdateProperties: Object.entries(feature.properties ?? {}).map(([key, value]) => ({ key, value })),
    })
  }

  if (!previous) {
    mapSource.setData(data)
  } else {
    const remove = [...previous.ids].filter((id) => !currentIds.has(id))
    if (remove.length || add.length || update.length) {
      mapSource.updateData({
        ...(remove.length ? { remove } : {}),
        ...(add.length ? { add } : {}),
        ...(update.length ? { update } : {}),
      })
    }
  }
  stateRef.current = { source: mapSource, ids: currentIds }
}

function routeFitPadding(map: MapLibreMap) {
  const { clientWidth, clientHeight } = map.getContainer()
  return mapFitPadding(clientWidth, clientHeight)
}

function visibleMapLayerIds(map: MapLibreMap, layerIds: string[]) {
  return layerIds.filter((layerId) => (
    Boolean(map.getLayer(layerId)) && map.getLayoutProperty(layerId, 'visibility') !== 'none'
  ))
}

function uniqueRenderedFeatureCount(
  features: ReturnType<MapLibreMap['queryRenderedFeatures']>,
  propertyName: string,
) {
  const featureIds = new Set<string>()
  let anonymousFeatures = 0
  for (const feature of features) {
    const propertyValue = feature.properties?.[propertyName]
    const featureId = propertyValue ?? feature.id
    if (featureId === undefined || featureId === null || featureId === '') anonymousFeatures += 1
    else featureIds.add(String(featureId))
  }
  return featureIds.size + anonymousFeatures
}

function renderedMapFeatures(
  map: MapLibreMap,
  sourceRouteFeatures: number,
  sourceStopFeatures: number,
) {
  const canvas = map.getCanvas()
  const container = map.getContainer()
  if (canvas.width <= 0 || canvas.height <= 0 || container.clientWidth <= 0 || container.clientHeight <= 0) return null

  const routeLayers = sourceRouteFeatures > 0 && map.getSource('vigo-routes') && map.isSourceLoaded('vigo-routes')
    ? visibleMapLayerIds(map, ['vigo-routes'])
    : []
  const stopLayers = sourceStopFeatures > 0 && map.getSource('vigo-stops') && map.isSourceLoaded('vigo-stops')
    ? visibleMapLayerIds(map, stopLayerIds)
    : []
  const renderedRoutes = routeLayers.length
    ? uniqueRenderedFeatureCount(map.queryRenderedFeatures({ layers: routeLayers }), 'featureId')
    : 0
  const renderedStops = stopLayers.length
    ? uniqueRenderedFeatureCount(map.queryRenderedFeatures({ layers: stopLayers }), 'stopId')
    : 0

  if (!renderedRoutes && !renderedStops) return null
  return {
    state: renderedRoutes ? 'network' as const : 'stops-only' as const,
    renderedRoutes,
    renderedStops,
  }
}

function mapFailureMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }
  return 'The local map renderer stopped before drawing the GTFS network.'
}

function isFatalMapError(error: unknown) {
  const message = mapFailureMessage(error).toLowerCase()
  return /webgl|web graphics|context lost|failed to initialize|invalid style|style.*failed|missing geojson source|(?:source|layer).*vigo-/.test(message)
}

function desktopMapTelemetryPayload(
  tracker: MapFirstRenderTracker,
  feedName: string,
  sourceRouteFeatures: number,
  sourceStopFeatures: number,
) {
  return {
    feedName,
    basemap: tracker.basemap,
    basemapStatus: basemapTelemetryStatus(tracker),
    timings: mapFirstRenderTimings(tracker),
    sourceRouteFeatures,
    sourceStopFeatures,
  }
}

export function VigoMap({
  showStopDetails = true,
  projectId,
  localStreetGraphAvailable = false,
  preview,
  feedName,
  layers,
  networkLens,
  basemap,
  appearance,
  selectedRouteId,
  selectedStopId,
  focusLocation,
  vehicleFrame,
  routingEnabled = false,
  routingOrigin,
  routingWaypoints: suppliedWaypoints = emptyRoutingPoints,
  routingDestination,
  routingPlan,
  routingStatusTitle,
  routingStatusDetail,
  reachResult,
  reachComparison,
  serviceDecomposition,
  scenarioView = 'baseline',
  scenarioRenderMode = 'area',
  scenarioCutoffMinutes = 45,
  scenarioSketchStops: suppliedSketchStops = emptyScenarioStops,
  scenarioSketchGeometry: suppliedSketchGeometry = emptyCoordinates,
  scenarioPointPicking = false,
  onMoveScenarioStop,
  performanceProfile: providedPerformanceProfile,
  focusMode = 'network',
  onSelectRoute,
  onOpenTrip,
  onSelectStop,
  onRoutingPoint,
}: VigoMapProps) {
  // An absent overlay stays the same input across unrelated parent renders.
  const routingWaypoints = suppliedWaypoints.length ? suppliedWaypoints : emptyRoutingPoints
  const scenarioSketchStops = suppliedSketchStops.length ? suppliedSketchStops : emptyScenarioStops
  const scenarioSketchGeometry = suppliedSketchGeometry.length ? suppliedSketchGeometry : emptyCoordinates
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const mapRemovedRef = useRef(false)
  const mapReadyRef = useRef(false)
  const feedNameRef = useRef(feedName)
  const basemapRef = useRef(basemap)
  const appearanceRef = useRef(appearance)
  const projectIdRef = useRef(projectId)
  const localStreetGraphAvailableRef = useRef(localStreetGraphAvailable)
  const localStreetRequestRef = useRef<AbortController | null>(null)
  const localStreetRequestKeyRef = useRef('')
  const localStreetRefreshTimerRef = useRef<number | null>(null)
  const localStreetQueryRef = useRef('')
  const mapTelemetryRef = useRef<MapFirstRenderTracker | null>(null)
  const lastFitSignatureRef = useRef('')
  const lastRoutingFitSignatureRef = useRef('')
  const lastDesktopReadySignatureRef = useRef('')
  const lastDesktopFailureSignatureRef = useRef('')
  const scenarioDragRef = useRef<{ index: number; moved: boolean } | null>(null)
  const suppressScenarioClickRef = useRef(false)
  const vehicleSourceStateRef = useRef<DynamicPointSourceState | null>(null)
  const onMoveScenarioStopRef = useRef(onMoveScenarioStop)
  const [liveSelection, setLiveSelection] = useState<MapLiveSelection | null>(() => {
    if (!selectedStopId || routingEnabled || focusMode === 'scenario') return null
    const stop = findNetworkStop(preview.stops, selectedStopId)
    return { tone: 'stop', stopId: selectedStopId, eyebrow: 'Stop arrivals', title: stop?.name || 'Station', subtitle: '', metrics: [] }
  })
  const [mapFailure, setMapFailure] = useState('')
  const [localStreetStatus, setLocalStreetStatus] = useState<{
    phase: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
    featureCount: number
    detail?: string
  }>({ phase: 'idle', featureCount: 0 })
  const reportMapFailure = (stage: 'initialize' | 'render', error: unknown) => {
    const message = mapFailureMessage(error)
    setMapFailure(message)
    const failureSignature = `${feedNameRef.current}:${stage}:${message}`
    if (failureSignature === lastDesktopFailureSignatureRef.current) return
    lastDesktopFailureSignatureRef.current = failureSignature
    reportDesktopMapFailed({ feedName: feedNameRef.current, stage, message })
  }
  useEffect(() => {
    onMoveScenarioStopRef.current = onMoveScenarioStop
  }, [onMoveScenarioStop])
  useEffect(() => {
    projectIdRef.current = projectId
    localStreetGraphAvailableRef.current = localStreetGraphAvailable
  }, [localStreetGraphAvailable, projectId])
  const featureProcessingStartedAt = performance.now()
  const performanceProfile = useMemo(() => providedPerformanceProfile ?? buildNetworkPerformanceProfile(preview), [preview, providedPerformanceProfile])
  const routingFocus = focusMode === 'routing'
  const scenarioFocus = focusMode === 'scenario'
  const highlightRouteGroup = focusMode === 'route' && preview.routes.length > 0
  const effectiveLayers = useMemo(() => ({
    ...layers,
    routes: routingFocus || scenarioFocus ? false : focusMode === 'route' ? true : layers.routes,
    segments: routingFocus || scenarioFocus ? false : layers.segments,
    // Keep transit stops available while a Reach case is being
    // configured. Once a surface is ready, the result itself is represented
    // only by its area or street-path layer; settled OSM nodes stay internal.
    stops: routingFocus ? false : scenarioFocus ? !reachResult : layers.stops,
    transfers: routingFocus || scenarioFocus ? false : layers.transfers,
    coverage: routingFocus || scenarioFocus ? false : layers.coverage,
    scenario: routingFocus || scenarioFocus ? false : layers.scenario,
    access: routingFocus || scenarioFocus ? false : layers.access,
  }), [focusMode, layers, routingFocus, reachResult, scenarioFocus])
  const routesGeoJson = useMemo(() => routeFeatures(preview, selectedRouteId, highlightRouteGroup), [highlightRouteGroup, preview, selectedRouteId])
  const segmentsGeoJson = useMemo(() => (effectiveLayers.segments ? segmentFeatures(preview, performanceProfile) : emptyCollection), [effectiveLayers.segments, performanceProfile, preview])
  const stopsGeoJson = useMemo(
    () => (
      effectiveLayers.stops
      || effectiveLayers.transfers
      || effectiveLayers.coverage
      || effectiveLayers.access
      || scenarioFocus
        ? stopFeatures(preview, selectedRouteId, selectedStopId, performanceProfile)
        : emptyCollection
    ),
    [effectiveLayers.access, effectiveLayers.coverage, effectiveLayers.stops, effectiveLayers.transfers, performanceProfile, preview, scenarioFocus, selectedRouteId, selectedStopId],
  )
  const accessGeoJson = useMemo(() => accessFeatures(preview, selectedStopId), [preview, selectedStopId])
  const vehicleGeoJson = useMemo(
    () => effectiveLayers.routes
      ? serviceVehicleFeatures(vehicleFrame, preview, selectedRouteId)
      : emptyCollection,
    [effectiveLayers.routes, preview, selectedRouteId, vehicleFrame],
  )
  const routingGeoJson = useMemo(() => routingLineFeatures(routingPlan), [routingPlan])
  const routingPinsGeoJson = useMemo(
    () => routingPinFeatures(routingOrigin, routingWaypoints, routingDestination, routingPlan, scenarioFocus),
    [routingDestination, routingOrigin, routingPlan, routingWaypoints, scenarioFocus],
  )
  const scenarioSketchGeoJson = useMemo(
    () => scenarioSketchFeatures(scenarioSketchStops, scenarioSketchGeometry),
    [scenarioSketchGeometry, scenarioSketchStops],
  )
  const scenarioContoursGeoJson = useMemo(
    () => scenarioRenderMode === 'area'
      ? scenarioContourFeatures(reachResult, scenarioView, scenarioCutoffMinutes)
      : emptyCollection,
    [reachResult, scenarioCutoffMinutes, scenarioRenderMode, scenarioView],
  )
  const scenarioAreaGeoJson = useMemo(
    () => scenarioRenderMode === 'area'
      ? scenarioAreaFeatures(reachResult, scenarioView, scenarioCutoffMinutes)
      : emptyCollection,
    [reachResult, scenarioCutoffMinutes, scenarioRenderMode, scenarioView],
  )
  const scenarioAccessEdgesGeoJson = useMemo(
    () => scenarioRenderMode === 'streets'
      ? scenarioEdgeFeatures(reachResult, scenarioView, scenarioCutoffMinutes)
      : emptyCollection,
    [reachResult, scenarioCutoffMinutes, scenarioRenderMode, scenarioView],
  )
  const comparisonEntries = useMemo(
    () => reachComparison ?? [],
    [reachComparison],
  )
  const focusedAnalysis = reachResult ?? comparisonEntries[0]?.result
  const cityBounds = useMemo(() => previewStopBounds(preview), [preview.stops])
  const comparisonContoursGeoJson = useMemo(
    () => scenarioRenderMode === 'area'
      ? comparisonEntries.map((entry) => reachComparisonContourFeatures(entry.result, scenarioCutoffMinutes))
      : comparisonEntries.map(() => emptyCollection),
    [comparisonEntries, scenarioCutoffMinutes, scenarioRenderMode],
  )
  const comparisonAreasGeoJson = useMemo(
    () => scenarioRenderMode === 'area'
      ? comparisonEntries.map((entry, index) => reachComparisonAreaFeatures(
        entry.result,
        scenarioCutoffMinutes,
        reachComparisonColor(index),
      ))
      : comparisonEntries.map(() => emptyCollection),
    [comparisonEntries, scenarioCutoffMinutes, scenarioRenderMode],
  )
  const comparisonAccessEdgesGeoJson = useMemo(
    () => scenarioRenderMode === 'streets'
      ? comparisonEntries.map((entry, index) => reachComparisonEdgeFeatures(
        entry.result,
        scenarioCutoffMinutes,
        reachComparisonColor(index),
      ))
      : comparisonEntries.map(() => emptyCollection),
    [comparisonEntries, scenarioCutoffMinutes, scenarioRenderMode],
  )
  const hasDrawableNetwork = routesGeoJson.features.length > 0 || stopsGeoJson.features.length > 0
  const mapVisualState = routesGeoJson.features.length > 0 ? 'network' : stopsGeoJson.features.length > 0 ? 'stops-only' : 'empty'
  const routingFitSignature = useMemo(
    () => [
      routingEnabled ? 'on' : 'off',
      routingOrigin?.label ?? '',
      routingWaypoints.map((point) => `${point.label}:${point.coordinate.join(',')}`).join('|'),
      routingDestination?.label ?? '',
      routingPlan?.id ?? '',
      routingGeoJson.features.length,
    ].join(':'),
    [routingDestination?.label, routingEnabled, routingGeoJson.features.length, routingOrigin?.label, routingPlan?.id, routingWaypoints],
  )
  const fitSignature = useMemo(
    () => {
      const routePointCount = preview.routes.reduce((sum, route) => sum + (route.coordinates?.length ?? route.stopIds.length), 0)
      const firstRouteId = preview.routes[0] ? cityPublicRouteKey(preview.routes[0]) : 'none'
      const lastRoute = preview.routes[preview.routes.length - 1]
      const lastRouteId = lastRoute ? cityPublicRouteKey(lastRoute) : 'none'
      const firstStop = preview.stops[0]
      const lastStop = preview.stops[preview.stops.length - 1]
      const firstStopKey = firstStop ? `${firstStop.id}:${firstStop.lon ?? firstStop.x}:${firstStop.lat ?? firstStop.y}` : 'none'
      const lastStopKey = lastStop ? `${lastStop.id}:${lastStop.lon ?? lastStop.x}:${lastStop.lat ?? lastStop.y}` : 'none'
      return `${preview.routes.length}:${preview.stops.length}:${routePointCount}:${firstRouteId}:${lastRouteId}:${firstStopKey}:${lastStopKey}`
    },
    [preview],
  )
  const featureProcessingEndedAt = performance.now()
  const mapTelemetryKey = `${feedName}:${fitSignature}:${performanceProfile.mode}:${focusMode}`
  if (mapTelemetryRef.current?.key !== mapTelemetryKey) {
    mapTelemetryRef.current = createMapFirstRenderTracker({
      key: mapTelemetryKey,
      basemap,
      navigationStartedAt: browserNavigationStart(),
      mapMountedAt: featureProcessingStartedAt,
      featuresPreparedAt: featureProcessingEndedAt,
    })
  }
  useEffect(() => {
    feedNameRef.current = feedName
    basemapRef.current = basemap
    appearanceRef.current = appearance
  }, [appearance, basemap, feedName])

  useEffect(() => {
    const tracker = mapTelemetryRef.current
    if (!tracker || tracker.key !== mapTelemetryKey) return
    reportDesktopMapPhase({
      phase: 'features-prepared',
      ...desktopMapTelemetryPayload(tracker, feedName, routesGeoJson.features.length, stopsGeoJson.features.length),
    })
  }, [feedName, mapTelemetryKey, routesGeoJson.features.length, stopsGeoJson.features.length])

  const selectionScopeRef = useRef({ fitSignature, selectedRouteId })
  useEffect(() => {
    const previousScope = selectionScopeRef.current
    if (previousScope.fitSignature === fitSignature && previousScope.selectedRouteId === selectedRouteId) return
    selectionScopeRef.current = { fitSignature, selectedRouteId }
    // Keep a selected vehicle's card while
    // the route preview reloads, provided it still belongs to the visible scope.
    setLiveSelection(previous => previous?.stopId && previous.stopId === selectedStopId ? previous : previous?.vehicleId && vehicleFrame.vehicles.some(vehicle =>
      vehicle.id === previous.vehicleId && vehicle.sourceUrl === previous.vehicleSourceUrl
      && serviceVehicleIsVisible(vehicle, preview, selectedRouteId)) ? previous : null)
  }, [fitSignature, selectedRouteId, selectedStopId, vehicleFrame, preview])

  const stopSelectionRef = useRef({ projectId, selectedRouteId, selectedStopId })
  useEffect(() => {
    const previous = stopSelectionRef.current
    stopSelectionRef.current = { projectId, selectedRouteId, selectedStopId }
    // Search and Agency evidence share map selection. A route's automatically
    // selected first stop should not open a board over a vehicle or route card.
    if (previous.projectId !== projectId || previous.selectedRouteId !== selectedRouteId || previous.selectedStopId === selectedStopId || routingEnabled || scenarioFocus) return
    const stop = findNetworkStop(preview.stops, selectedStopId)
    if (stop) {
      setLiveSelection({ tone: 'stop', stopId: stop.id, eyebrow: 'Stop arrivals', title: stop.name, subtitle: '', metrics: [] })
      mapRef.current?.easeTo({ center: stopLngLat(stop), zoom: Math.max(mapRef.current.getZoom(), 14), duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450 })
    }
  }, [projectId, selectedRouteId, selectedStopId, preview, routingEnabled, scenarioFocus])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(entries => {
      if (entries.some(entry => entry.contentRect.width > 0 && entry.contentRect.height > 0)) mapRef.current?.resize()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const canvasStyle = {
      version: 8 as const,
      sources: {},
      layers: [
        {
          id: 'vigo-offline-bg',
          type: 'background' as const,
          paint: {
            'background-color': baseCanvasColor(basemap, appearance),
          },
        },
      ],
    }

    const analysisBounds = scenarioFocus && focusedAnalysis
      ? focusedAnalysis.surface.displayBounds ?? focusedAnalysis.surface.raster.bounds
      : null
    const initialRoutingBounds = routingEnabled || Boolean(routingPlan) || scenarioFocus
      ? mapContentBounds(routingGeoJson, routingPinsGeoJson)
      : null
    const initialBounds: LngLatBoundsLike | null = analysisBounds
      ? [[analysisBounds[0], analysisBounds[1]], [analysisBounds[2], analysisBounds[3]]]
      : initialRoutingBounds ?? mapContentBounds(routesGeoJson, stopsGeoJson) ?? cityBounds
    if (initialBounds) lastFitSignatureRef.current = fitSignature
    if (initialRoutingBounds) lastRoutingFitSignatureRef.current = routingFitSignature
    let map: MapLibreMap
    let mapReadyFallbackTimer: number | null = null
    let mapReadyFallbackAttempts = 0
    try {
      mapRemovedRef.current = false
      const tracker = mapTelemetryRef.current
      if (tracker) markMapCreated(tracker, performance.now())
      map = new maplibregl.Map({
        container: containerRef.current,
        style: canvasStyle,
        center: initialBounds ? undefined : [0, 20],
        zoom: initialBounds ? undefined : 1.7,
        bounds: initialBounds ?? undefined,
        fitBoundsOptions: initialBounds
          ? { padding: mapFitPadding(containerRef.current.clientWidth, containerRef.current.clientHeight), duration: 0, maxZoom: initialRoutingBounds ? 14.6 : 13.2 }
          : undefined,
        attributionControl: false,
      })
    } catch (error) {
      reportMapFailure('initialize', error)
      return
    }

    const reportPhase = (phase: MapFirstRenderPhase) => {
      const tracker = mapTelemetryRef.current
      if (!tracker) return
      reportDesktopMapPhase({
        phase,
        ...desktopMapTelemetryPayload(tracker, feedNameRef.current, routesGeoJson.features.length, stopsGeoJson.features.length),
      })
    }
    const reportBasemapReadiness = () => {
      const tracker = mapTelemetryRef.current
      if (!tracker) return
      const currentBasemap = basemapRef.current
      if (currentBasemap === 'none') {
        if (markBasemapReady(tracker, performance.now())) reportPhase('basemap-ready')
        return
      }
      if (currentBasemap === 'offline') {
        if (
          !localStreetGraphAvailableRef.current
          || (map.getSource('vigo-local-streets') && map.isSourceLoaded('vigo-local-streets'))
        ) {
          if (markBasemapReady(tracker, performance.now())) reportPhase('basemap-ready')
        }
        return
      }
      if (map.getSource('osm') && map.isSourceLoaded('osm') && markBasemapReady(tracker, performance.now())) {
        reportPhase('basemap-ready')
      }
    }
    const handleMapError = (event: maplibregl.ErrorEvent) => {
      const sourceId = 'sourceId' in event ? String(event.sourceId || '') : ''
      if (sourceId === 'osm' || sourceId === 'vigo-local-streets') {
        const tracker = mapTelemetryRef.current
        if (tracker && markBasemapFailed(tracker, performance.now())) reportPhase('basemap-failed')
        return
      }
      if (lastDesktopReadySignatureRef.current || !isFatalMapError(event.error)) return
      reportMapFailure('render', event.error)
    }
    const handleSourceData = (event: { sourceId?: string }) => {
      if (event.sourceId === 'osm' || event.sourceId === 'vigo-local-streets') reportBasemapReadiness()
    }
    const handleMapLoad = () => {
      if (mapRemovedRef.current || mapReadyRef.current) return
      try {
        mapReadyRef.current = true
        ensureLayers(map)
        ensureLayers(map, comparisonEntries.length)
        applyLayerVisibility(map, effectiveLayers, {
          routingVisible: routingEnabled || Boolean(routingPlan) || scenarioFocus,
          reachResultVisible: scenarioFocus,
          reachComparisonCount: comparisonEntries.length,
        })
        applyNetworkLensPaint(map, networkLens)
        const tracker = mapTelemetryRef.current
        if (tracker && markMapLoaded(tracker, performance.now())) reportPhase('map-load')
      } catch (error) {
        reportMapFailure('render', error)
      }
    }
    const retryMapReady = () => {
      if (mapRemovedRef.current || mapReadyRef.current) return
      if (map.loaded() || map.isStyleLoaded()) {
        handleMapLoad()
        return
      }
      mapReadyFallbackAttempts += 1
      if (mapReadyFallbackAttempts < 60) {
        mapReadyFallbackTimer = window.setTimeout(retryMapReady, 100)
      }
    }

    map.on('error', handleMapError)
    map.on('sourcedata', handleSourceData)
    map.on('load', handleMapLoad)
    map.on('idle', retryMapReady)
    try {
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    } catch (error) {
      map.off('error', handleMapError)
      map.off('sourcedata', handleSourceData)
      map.off('load', handleMapLoad)
      map.off('idle', retryMapReady)
      if (mapReadyFallbackTimer !== null) window.clearTimeout(mapReadyFallbackTimer)
      map.remove()
      reportMapFailure('initialize', error)
      return
    }
    mapRef.current = map
    mapReadyFallbackTimer = window.setTimeout(retryMapReady, 0)

    return () => {
      if (mapRemovedRef.current) return
      mapRemovedRef.current = true
      map.off('error', handleMapError)
      map.off('sourcedata', handleSourceData)
      map.off('load', handleMapLoad)
      map.off('idle', retryMapReady)
      if (mapReadyFallbackTimer !== null) window.clearTimeout(mapReadyFallbackTimer)
      mapRef.current = null
      mapReadyRef.current = false
      try {
        map.remove()
      } catch (error) {
        // MapLibre rejects calls after remove(); page navigation must remain usable
        // even when a browser tears down the WebGL context during unmount.
        console.warn('VIGO map cleanup failed', error)
      }
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const reportPhase = (phase: MapFirstRenderPhase) => {
      const tracker = mapTelemetryRef.current
      if (!tracker || tracker.key !== mapTelemetryKey) return
      reportDesktopMapPhase({
        phase,
        ...desktopMapTelemetryPayload(tracker, feedName, routesGeoJson.features.length, stopsGeoJson.features.length),
      })
    }
    const reportReadyIfRendered = () => {
      const rendered = renderedMapFeatures(map, routesGeoJson.features.length, stopsGeoJson.features.length)
      if (!rendered) return
      const { state, renderedRoutes, renderedStops } = rendered
      map.off('render', reportReadyIfRendered)

      const desktopReadySignature = `${feedName}:${fitSignature}:${state}:${renderedRoutes}:${renderedStops}`
      if (desktopReadySignature === lastDesktopReadySignatureRef.current) return
      lastDesktopReadySignatureRef.current = desktopReadySignature
      setMapFailure('')
      const tracker = mapTelemetryRef.current
      if (tracker && tracker.key === mapTelemetryKey && markLocalSourceRendered(tracker, performance.now())) {
        reportPhase('local-source-render')
      }
      reportDesktopMapReady({
        feedName,
        state,
        routeFeatures: renderedRoutes,
        stopFeatures: renderedStops,
        sourceRouteFeatures: routesGeoJson.features.length,
        sourceStopFeatures: stopsGeoJson.features.length,
        basemap: tracker?.basemap ?? basemapRef.current,
        basemapStatus: tracker ? basemapTelemetryStatus(tracker) : 'not-started',
        timings: tracker ? mapFirstRenderTimings(tracker) : {
          navigationToMapMountMs: 0,
          featureProcessingMs: 0,
        },
      })
    }
    const update = () => {
      try {
        ensureLayers(map)
        const tracker = mapTelemetryRef.current
        if (tracker && tracker.key === mapTelemetryKey) {
          const adoptedAt = performance.now()
          if (markMapCreated(tracker, adoptedAt)) {
            markMapLoaded(tracker, adoptedAt)
            reportPhase('map-load')
          }
          markLocalSourceSubmitted(tracker, adoptedAt)
        }
        setMapSourceData(source(map, 'vigo-routes'), routesGeoJson)
        setMapSourceData(source(map, 'vigo-segments'), segmentsGeoJson)
        setMapSourceData(source(map, 'vigo-stops'), stopsGeoJson)
        setMapSourceData(source(map, 'vigo-access'), accessGeoJson)
        const showRoutingPlan = routingEnabled || Boolean(routingPlan) || scenarioFocus
        setMapSourceData(source(map, 'vigo-routing'), showRoutingPlan ? routingGeoJson : emptyCollection)
        setMapSourceData(source(map, 'vigo-routing-pins'), showRoutingPlan ? routingPinsGeoJson : emptyCollection)
        const shouldFit = fitSignature !== lastFitSignatureRef.current
        const hasFocusedCamera = (scenarioFocus && Boolean(focusedAnalysis))
          || (showRoutingPlan && (routingGeoJson.features.length > 0 || routingPinsGeoJson.features.length > 0))
        // Late city data supplies an initial context, but must not replace the
        // camera already owned by route points, a Reach result, or the user.
        if (shouldFit && hasFocusedCamera) lastFitSignatureRef.current = fitSignature
        const bounds = shouldFit && !hasFocusedCamera ? mapContentBounds(routesGeoJson, stopsGeoJson) ?? cityBounds : null
        if (bounds) {
          const isFirstFit = lastFitSignatureRef.current === ''
          lastFitSignatureRef.current = fitSignature
          map.fitBounds(bounds, {
            padding: routeFitPadding(map),
            duration: isFirstFit ? 0 : 360,
            maxZoom: 13.2,
          })
        }
        if (showRoutingPlan && !(scenarioFocus && focusedAnalysis) && routingFitSignature !== lastRoutingFitSignatureRef.current) {
          const routingBounds = mapContentBounds(routingGeoJson, routingPinsGeoJson)
          if (routingBounds) {
            lastRoutingFitSignatureRef.current = routingFitSignature
            map.fitBounds(routingBounds, {
              padding: routeFitPadding(map),
              duration: 420,
              maxZoom: 14.6,
            })
          }
        }
        map.off('render', reportReadyIfRendered)
        map.on('render', reportReadyIfRendered)
        map.triggerRepaint()
      } catch (error) {
        reportMapFailure('render', error)
      }
    }
    const cancelUpdate = scheduleMapFrameUpdate(
      map,
      mapReadyRef.current,
      update,
      () => mapRemovedRef.current,
    )

    return () => {
      cancelUpdate()
      if (mapRemovedRef.current) return
      map.off('render', reportReadyIfRendered)
    }
  }, [accessGeoJson, cityBounds, feedName, fitSignature, focusedAnalysis, mapTelemetryKey, mapVisualState, routesGeoJson, routingEnabled, routingFitSignature, routingGeoJson, routingPinsGeoJson, routingPlan, scenarioFocus, segmentsGeoJson, stopsGeoJson])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const update = () => {
      ensureLayers(map, comparisonEntries.length)
      setMapSourceData(source(map, 'vigo-scenario-area'), scenarioAreaGeoJson)
      setStreetMapSourceData(source(map, 'vigo-scenario-access-edges'), scenarioAccessEdgesGeoJson)
      setMapSourceData(source(map, 'vigo-service-edges'), serviceDecomposition?.featureCollection ?? emptyCollection)
      setMapSourceData(source(map, 'vigo-scenario-contours'), scenarioContoursGeoJson)
      setMapSourceData(source(map, 'vigo-reach-route'),
        reachResult?.scenario.routes ?? emptyCollection,
      )
      setMapSourceData(source(map, 'vigo-scenario-sketch'), scenarioSketchGeoJson)
      comparisonEntries.forEach((_entry, index) => {
        setMapSourceData(source(map, `vigo-scenario-comparison-${index}-area`), comparisonAreasGeoJson[index] ?? emptyCollection)
        setStreetMapSourceData(source(map, `vigo-scenario-comparison-${index}-access-edges`), comparisonAccessEdgesGeoJson[index] ?? emptyCollection)
        setMapSourceData(source(map, `vigo-scenario-comparison-${index}-contours`), comparisonContoursGeoJson[index] ?? emptyCollection)
      })
      setVisibility(map, reachResultLayerIds, scenarioFocus)
      setVisibility(map, ['vigo-scenario-area', 'vigo-scenario-contours'], scenarioFocus && scenarioRenderMode === 'area')
      setVisibility(map, ['vigo-scenario-access-edges'], scenarioFocus && scenarioRenderMode === 'streets')
      setVisibility(map, existingScenarioComparisonLayerIds(map), false)
      setVisibility(map, reachComparisonLayerIds(comparisonEntries.length), scenarioFocus)
      setVisibility(map, reachComparisonLayerIds(comparisonEntries.length).filter((layerId) => layerId.endsWith('-area') || layerId.endsWith('-contours')), scenarioFocus && scenarioRenderMode === 'area')
      setVisibility(map, reachComparisonLayerIds(comparisonEntries.length).filter((layerId) => layerId.endsWith('-access-edges')), scenarioFocus && scenarioRenderMode === 'streets')
    }
    if (mapReadyRef.current || map.loaded()) update()
    else map.once('load', update)
    return () => {
      if (mapRemovedRef.current) return
      map.off('load', update)
    }
  }, [comparisonAccessEdgesGeoJson, comparisonAreasGeoJson, comparisonContoursGeoJson, comparisonEntries, scenarioAccessEdgesGeoJson, reachResult, scenarioAreaGeoJson, scenarioContoursGeoJson, scenarioFocus, scenarioRenderMode, scenarioSketchGeoJson, serviceDecomposition])

  // Editing overlays or refreshing unrelated state must not reset a user's
  // pan/zoom. Only a newly selected accessibility result changes the viewport.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !scenarioFocus || !focusedAnalysis) return
    const fit = () => {
      const [west, south, east, north] = focusedAnalysis.surface.displayBounds
        ?? focusedAnalysis.surface.raster.bounds
      map.fitBounds([[west, south], [east, north]], {
        padding: routeFitPadding(map),
        duration: 360,
        maxZoom: 14,
      })
    }
    if (mapReadyRef.current || map.loaded()) fit()
    else map.once('load', fit)
    return () => {
      if (mapRemovedRef.current) return
      map.off('load', fit)
    }
  }, [focusedAnalysis, scenarioFocus])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const update = () => {
      ensureLayers(map)
      updateDynamicPointSource(map, 'vigo-service-vehicles', vehicleGeoJson, vehicleSourceStateRef)
    }
    return scheduleMapFrameUpdate(
      map,
      mapReadyRef.current,
      update,
      () => mapRemovedRef.current,
    )
  }, [vehicleGeoJson])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const update = () => {
      const tracker = mapTelemetryRef.current
      if (tracker) markBasemapRequested(tracker, basemap, performance.now())
      syncBasemap(map, basemap, appearance)
      if (!tracker) return
      const ready = basemap === 'none'
        || (basemap === 'offline' && !localStreetGraphAvailable)
        || (basemap === 'offline' && Boolean(map.getSource('vigo-local-streets') && map.isSourceLoaded('vigo-local-streets')))
        || (basemap !== 'offline' && Boolean(map.getSource('osm') && map.isSourceLoaded('osm')))
      if (ready && markBasemapReady(tracker, performance.now())) {
        reportDesktopMapPhase({
          phase: 'basemap-ready',
          ...desktopMapTelemetryPayload(tracker, feedNameRef.current, routesGeoJson.features.length, stopsGeoJson.features.length),
        })
      }
    }
    // Start tiles once the style is ready, after local source updates have been
    // queued. Route and Analyze intentionally hide GTFS layers, so waiting for
    // a rendered route or stop can prevent the basemap from ever starting.
    return scheduleMapFrameUpdate(map, mapReadyRef.current, update, () => mapRemovedRef.current)
  }, [appearance, basemap, localStreetGraphAvailable, routesGeoJson.features.length, stopsGeoJson.features.length])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let cancelled = false
    let localStreetReadyTimer: number | null = null

    const clearLocalStreetBasemap = () => {
      if (localStreetRefreshTimerRef.current !== null) {
        window.clearTimeout(localStreetRefreshTimerRef.current)
        localStreetRefreshTimerRef.current = null
      }
      localStreetRequestRef.current?.abort()
      localStreetRequestRef.current = null
      localStreetRequestKeyRef.current = ''
      localStreetQueryRef.current = ''
      setLocalStreetStatus({ phase: 'idle', featureCount: 0 })
      if (mapRemovedRef.current) return
      removeLocalStreetBasemap(map)
    }

    const reportLocalBasemapFailure = (error: unknown) => {
      const tracker = mapTelemetryRef.current
      if (tracker && markBasemapFailed(tracker, performance.now())) {
        reportDesktopMapPhase({
          phase: 'basemap-failed',
          ...desktopMapTelemetryPayload(tracker, feedNameRef.current, routesGeoJson.features.length, stopsGeoJson.features.length),
        })
      }
      if (error instanceof Error && error.name !== 'AbortError') {
        setLocalStreetStatus({ phase: 'error', featureCount: 0, detail: error.message })
      }
    }

    const refreshLocalStreetBasemap = async () => {
      if (cancelled || mapRemovedRef.current || !mapReadyRef.current) return
      if (basemap !== 'offline' || !projectIdRef.current || !localStreetGraphAvailableRef.current) {
        clearLocalStreetBasemap()
        const tracker = mapTelemetryRef.current
        if (basemap === 'offline' && tracker && markBasemapReady(tracker, performance.now())) {
          reportDesktopMapPhase({
            phase: 'basemap-ready',
            ...desktopMapTelemetryPayload(tracker, feedNameRef.current, routesGeoJson.features.length, stopsGeoJson.features.length),
          })
        }
        return
      }

      const bounds = map.getBounds()
      const west = Number(bounds.getWest().toFixed(5))
      const south = Number(bounds.getSouth().toFixed(5))
      const east = Number(bounds.getEast().toFixed(5))
      const north = Number(bounds.getNorth().toFixed(5))
      const zoom = Math.max(1, Math.min(22, Math.round(map.getZoom())))
      const queryKey = `${projectIdRef.current}:${west}:${south}:${east}:${north}:${zoom}`
      if (queryKey === localStreetQueryRef.current && map.getSource('vigo-local-streets')) {
        ensureLocalStreetLayers(map, appearanceRef.current)
        return
      }
      if (queryKey === localStreetRequestKeyRef.current) return

      localStreetRequestRef.current?.abort()
      const controller = new AbortController()
      localStreetRequestRef.current = controller
      localStreetRequestKeyRef.current = queryKey
      setLocalStreetStatus((current) => ({
        phase: 'loading',
        featureCount: current.featureCount,
      }))
      const params = new URLSearchParams({
        west: String(west),
        south: String(south),
        east: String(east),
        north: String(north),
        zoom: String(zoom),
        limit: String(localStreetLimitForZoom(zoom)),
      })
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectIdRef.current)}/local-streets?${params.toString()}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`Local street request failed (${response.status}).`)
        const collection = await response.json() as FeatureCollection
        if (cancelled || mapRemovedRef.current || controller.signal.aborted || basemapRef.current !== 'offline') return
        if (!map.getStyle()) return
        const source = map.getSource('vigo-local-streets') as GeoJSONSource | undefined
        if (source) {
          source.setData(collection)
        } else {
          map.addSource('vigo-local-streets', {
            type: 'geojson',
            data: collection,
            attribution: '© OpenStreetMap contributors · local PBF',
          })
        }
        ensureLocalStreetLayers(map, appearanceRef.current)
        localStreetQueryRef.current = queryKey
        setLocalStreetStatus({
          phase: collection.features.length ? 'ready' : 'empty',
          featureCount: collection.features.length,
          detail: collection.features.length ? undefined : 'No local streets intersect this map view.',
        })
        const tracker = mapTelemetryRef.current
        if (tracker && markBasemapReady(tracker, performance.now())) {
          reportDesktopMapPhase({
            phase: 'basemap-ready',
            ...desktopMapTelemetryPayload(tracker, feedNameRef.current, routesGeoJson.features.length, stopsGeoJson.features.length),
          })
        }
      } catch (error) {
        if (controller.signal.aborted || cancelled) return
        reportLocalBasemapFailure(error)
      } finally {
        if (localStreetRequestRef.current === controller) {
          localStreetRequestRef.current = null
          localStreetRequestKeyRef.current = ''
        }
      }
    }

    const scheduleLocalStreetRefresh = () => {
      if (cancelled || mapRemovedRef.current) return
      if (localStreetRefreshTimerRef.current !== null) window.clearTimeout(localStreetRefreshTimerRef.current)
      localStreetRefreshTimerRef.current = window.setTimeout(() => {
        localStreetRefreshTimerRef.current = null
        void refreshLocalStreetBasemap()
      }, 220)
    }

    if (basemap === 'offline' && localStreetGraphAvailable && projectId) {
      if (mapReadyRef.current) scheduleLocalStreetRefresh()
      else {
        map.once('load', scheduleLocalStreetRefresh)
        map.once('idle', scheduleLocalStreetRefresh)
        localStreetReadyTimer = window.setTimeout(scheduleLocalStreetRefresh, 360)
      }
      map.on('moveend', scheduleLocalStreetRefresh)
    } else {
      clearLocalStreetBasemap()
    }

    return () => {
      cancelled = true
      if (localStreetRefreshTimerRef.current !== null) {
        window.clearTimeout(localStreetRefreshTimerRef.current)
        localStreetRefreshTimerRef.current = null
      }
      if (localStreetReadyTimer !== null) window.clearTimeout(localStreetReadyTimer)
      map.off('load', scheduleLocalStreetRefresh)
      map.off('idle', scheduleLocalStreetRefresh)
      map.off('moveend', scheduleLocalStreetRefresh)
      clearLocalStreetBasemap()
    }
  }, [basemap, localStreetGraphAvailable, projectId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    applyLayerVisibility(map, effectiveLayers, {
      routingVisible: routingEnabled || Boolean(routingPlan) || scenarioFocus,
      reachResultVisible: scenarioFocus,
    })
  }, [effectiveLayers, routingEnabled, routingPlan, scenarioFocus])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const update = () => {
      ensureLayers(map)
      applyNetworkLensPaint(map, networkLens)
    }
    if (mapReadyRef.current || map.loaded()) update()
    else map.once('load', update)

    return () => {
      if (mapRemovedRef.current) return
      map.off('load', update)
    }
  }, [networkLens])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const routeId = selectedRouteId || '__none__'
    if (map.getLayer('vigo-selected-route')) {
      map.setFilter('vigo-selected-route', highlightRouteGroup ? ['==', ['get', 'selectedPattern'], true] : ['==', ['get', 'featureId'], routeId])
    }
    if (map.getLayer('vigo-selected-segments')) {
      map.setFilter('vigo-selected-segments', ['==', ['get', 'patternId'], routeId])
    }
    const selectedFeature = routesGeoJson.features.find((feature) => feature.properties?.featureId === selectedRouteId)
    const selectedCoordinates = selectedFeature ? lineGeometryCoordinates(selectedFeature.geometry) : []
    if (selectedCoordinates.length) {
      const bounds = new maplibregl.LngLatBounds(selectedCoordinates[0], selectedCoordinates[0])
      for (const coordinate of selectedCoordinates) bounds.extend(coordinate)
      map.fitBounds(bounds, { padding: routeFitPadding(map), duration: 360, maxZoom: 14.1 })
    }
  }, [highlightRouteGroup, routesGeoJson, selectedRouteId])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const finishScenarioDrag = () => {
      const drag = scenarioDragRef.current
      if (!drag) return
      scenarioDragRef.current = null
      map.dragPan.enable()
      if (drag.moved) {
        suppressScenarioClickRef.current = true
        window.setTimeout(() => {
          suppressScenarioClickRef.current = false
        }, 0)
      }
      map.getCanvas().style.cursor = ''
    }
    const handleScenarioMouseDown = (event: maplibregl.MapMouseEvent) => {
      const moveScenarioStop = onMoveScenarioStopRef.current
      if (
        !scenarioFocus
        || scenarioPointPicking
        || !moveScenarioStop
        || event.originalEvent.button !== 0
        || !map.getLayer('vigo-scenario-sketch-hit')
      ) return
      const hit = map.queryRenderedFeatures(event.point, { layers: ['vigo-scenario-sketch-hit'] })[0]
      const index = Number(hit?.properties?.index)
      if (!Number.isInteger(index) || index < 0) return
      event.originalEvent.preventDefault()
      map.dragPan.disable()
      scenarioDragRef.current = { index, moved: false }
      map.getCanvas().style.cursor = 'grabbing'
    }
    const handleScenarioMouseMove = (event: maplibregl.MapMouseEvent) => {
      const drag = scenarioDragRef.current
      const moveScenarioStop = onMoveScenarioStopRef.current
      if (!drag || !moveScenarioStop) return
      drag.moved = true
      moveScenarioStop(drag.index, [event.lngLat.lng, event.lngLat.lat])
    }
    map.getCanvas().style.cursor = scenarioFocus && !scenarioPointPicking ? '' : map.getCanvas().style.cursor
    map.on('mousedown', handleScenarioMouseDown)
    map.on('mousemove', handleScenarioMouseMove)
    map.on('mouseup', finishScenarioDrag)
    map.getCanvas().addEventListener('mouseleave', finishScenarioDrag)
    return () => {
      if (mapRemovedRef.current) return
      finishScenarioDrag()
      map.off('mousedown', handleScenarioMouseDown)
      map.off('mousemove', handleScenarioMouseMove)
      map.off('mouseup', finishScenarioDrag)
      map.getCanvas().removeEventListener('mouseleave', finishScenarioDrag)
    }
  }, [scenarioFocus, scenarioPointPicking])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if (suppressScenarioClickRef.current) {
        suppressScenarioClickRef.current = false
        return
      }
      if ((routingEnabled || (scenarioFocus && scenarioPointPicking)) && onRoutingPoint && !event.originalEvent.shiftKey) {
        onRoutingPoint(
          scenarioFocus
            ? scenarioPointForMapClick(map, event, preview)
            : routingPointForMapClick(event),
        )
        return
      }

      if (scenarioFocus && map.getLayer('vigo-scenario-sketch-hit')) {
        const scenarioStopHit = map.queryRenderedFeatures(event.point, {
          layers: ['vigo-scenario-sketch-hit'],
        })[0]
        if (scenarioStopHit?.properties && textProperty(scenarioStopHit.properties, 'kind') === 'stop') {
          const stopNumber = Math.max(1, Math.round(numberProperty(scenarioStopHit.properties, 'stopNumber')))
          const status = textProperty(scenarioStopHit.properties, 'editStatus', 'baseline')
          const statusLabel = status === 'replaced'
            ? 'Edited stop'
            : ['inserted', 'added'].includes(status)
              ? 'Added stop'
              : 'GTFS stop'
          setLiveSelection({
            tone: 'stop',
            eyebrow: statusLabel,
            title: `${stopNumber} · ${textProperty(scenarioStopHit.properties, 'label', `Stop ${stopNumber}`)}`,
            subtitle: '',
            metrics: [],
          })
          return
        }
      }

      const selectServiceVehicle = (vehicle: ServiceVehicleFrame['vehicles'][number]) => {
        setLiveSelection({ tone: 'vehicle', ...vehicle.card, ...(vehicle.source === 'live' ? { vehicleId: vehicle.id, vehicleSourceUrl: vehicle.sourceUrl } : {}) })
      }
      let clickedVehicle: ServiceVehicleFrame['vehicles'][number] | undefined
      if (effectiveLayers.routes && map.getLayer('vigo-vehicles')) {
        const vehicleHit = map.queryRenderedFeatures(event.point, { layers: ['vigo-vehicle-headings', 'vigo-vehicles'] }).find(feature => textProperty(feature.properties, 'vehicleId'))
        if (vehicleHit?.properties) {
          const vehicleIndex = Math.round(numberProperty(vehicleHit.properties, 'vehicleIndex'))
          const vehicleId = textProperty(vehicleHit.properties, 'vehicleId')
          const indexedVehicle = vehicleFrame.vehicles[vehicleIndex]
          clickedVehicle = indexedVehicle?.id === vehicleId
            ? indexedVehicle
            : vehicleFrame.vehicles.find((candidate) => candidate.id === vehicleId)
        }
      }
      if (clickedVehicle) {
        selectServiceVehicle(clickedVehicle)
        return
      }
      const stopHit = renderedStopAtPoint(map, event.point)
      if (stopHit) {
        const stopId = textProperty(stopHit?.properties, 'stopId')
        if (typeof stopId === 'string' && stopId) {
          onSelectStop(stopId)
          setLiveSelection({
            tone: 'stop',
            eyebrow: 'GTFS stop',
            stopId,
            title: textProperty(stopHit.properties, 'name', stopId),
            subtitle: textProperty(stopHit.properties, 'routes') || `Stop ${stopId}`,
            metrics: [
              { value: formatNumber(numberProperty(stopHit.properties, 'tripCount')), label: 'trips' },
              { value: formatNumber(numberProperty(stopHit.properties, 'routeCount')), label: 'routes' },
              { value: `${Math.round(numberProperty(stopHit.properties, 'transferScore'))}`, label: 'transfer' },
            ],
          })
          return
        }
      }
      // A nearby vehicle must not steal a tap intended for a visible stop.
      if (effectiveLayers.routes && map.getLayer('vigo-vehicles')) {
        const nearbyVehicle = vehicleFrame.vehicles.reduce<{
          vehicle: ServiceVehicleFrame['vehicles'][number]
          distance: number
        } | null>((nearest, vehicle) => {
          if (!isFiniteLngLat(vehicle.coordinate) || !serviceVehicleIsVisible(vehicle, preview, selectedRouteId)) return nearest
          const point = map.project(vehicle.coordinate)
          const distance = Math.hypot(point.x - event.point.x, point.y - event.point.y)
          if (distance > 18 || (nearest && nearest.distance <= distance)) return nearest
          return { vehicle, distance }
        }, null)?.vehicle
        if (nearbyVehicle) { selectServiceVehicle(nearbyVehicle); return }
      }
      if (map.getLayer('vigo-segments') && effectiveLayers.segments) {
        const segmentHit = map.queryRenderedFeatures(event.point, { layers: ['vigo-selected-segments', 'vigo-segments'] })[0]
        const patternId = textProperty(segmentHit?.properties, 'patternId')
        const fromStopId = textProperty(segmentHit?.properties, 'fromStopId')
        if (typeof patternId === 'string' && patternId) onSelectRoute(patternId)
        if (typeof fromStopId === 'string' && fromStopId) onSelectStop(fromStopId)
        if (typeof patternId === 'string' && patternId) {
          setLiveSelection({
            tone: 'segment',
            eyebrow: 'Stop-pair segment',
            title: `${textProperty(segmentHit.properties, 'fromStopName', fromStopId)} -> ${textProperty(segmentHit.properties, 'toStopName', textProperty(segmentHit.properties, 'toStopId'))}`,
            subtitle: `Route ${textProperty(segmentHit.properties, 'routeId')} / ${directionLabel(textProperty(segmentHit.properties, 'directionId'))}`,
            metrics: [
              { value: formatNumber(numberProperty(segmentHit.properties, 'tripCount')), label: 'trips' },
              { value: `${numberProperty(segmentHit.properties, 'medianRuntimeMinutes').toFixed(1)}m`, label: 'runtime' },
              { value: `${numberProperty(segmentHit.properties, 'headwayMinutes')}m`, label: 'headway' },
              { value: `${numberProperty(segmentHit.properties, 'speedKph').toFixed(1)}`, label: 'kph' },
            ],
          })
          return
        }
      }
      if (map.getLayer('vigo-routes')) {
        const routeHit = map.queryRenderedFeatures(event.point, { layers: ['vigo-selected-route', 'vigo-routes'] })[0]
        const routeId = textProperty(routeHit?.properties, 'featureId')
        if (typeof routeId === 'string' && routeId) {
          onSelectRoute(routeId)
          setLiveSelection({
            tone: 'route',
            eyebrow: 'GTFS route',
            title: routeDisplayName(textProperty(routeHit.properties, 'shortName'), textProperty(routeHit.properties, 'longName')),
            subtitle: `${directionLabel(textProperty(routeHit.properties, 'directionId'))} / ${routeGeometryLabel(textProperty(routeHit.properties, 'geometrySource'))}`,
            metrics: [
              { value: formatNumber(numberProperty(routeHit.properties, 'tripCount')), label: 'trips' },
              { value: `${numberProperty(routeHit.properties, 'headwayMinutes')}m`, label: 'headway' },
              { value: `${numberProperty(routeHit.properties, 'distanceKm').toFixed(1)}`, label: 'km' },
              { value: routeGeometryLabel(textProperty(routeHit.properties, 'geometrySource')), label: 'geometry' },
            ],
          })
          return
        }
      }
    }
    const hoverTooltip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'map-stop-tooltip' })
    let hoveredFeatureId = ''
    const clearHoverTooltip = () => { hoveredFeatureId = ''; hoverTooltip.remove() }
    const handleMove = (event: maplibregl.MapMouseEvent) => {
      if (scenarioDragRef.current) {
        clearHoverTooltip()
        map.getCanvas().style.cursor = 'grabbing'
        return
      }
      if (routingEnabled || (scenarioFocus && scenarioPointPicking)) {
        clearHoverTooltip()
        map.getCanvas().style.cursor = 'crosshair'
        return
      }
      const scenarioHit = map.getLayer('vigo-scenario-sketch-hit')
        && map.queryRenderedFeatures(event.point, { layers: ['vigo-scenario-sketch-hit'] }).length > 0
      if (scenarioHit) {
        clearHoverTooltip()
        map.getCanvas().style.cursor = 'grab'
        return
      }
      const layersToQuery = ['vigo-vehicle-headings', 'vigo-vehicles', 'vigo-selected-route', 'vigo-routes', 'vigo-selected-segments', 'vigo-segments'].filter((layerId) => map.getLayer(layerId))
      const features = layersToQuery.length ? map.queryRenderedFeatures(event.point, { layers: layersToQuery }) : []
      const vehicleHit = features.find(feature => (feature.layer.id === 'vigo-vehicles' || feature.layer.id === 'vigo-vehicle-headings') && textProperty(feature.properties, 'vehicleId'))
      const stop = vehicleHit ? undefined : renderedStopAtPoint(map, event.point)
      map.getCanvas().style.cursor = stop || features.length ? 'pointer' : ''
      if (vehicleHit) {
        const index = Math.round(numberProperty(vehicleHit.properties, 'vehicleIndex'))
        const vehicle = vehicleFrame.vehicles[index]
        if (!vehicle || vehicle.id !== textProperty(vehicleHit.properties, 'vehicleId')) { clearHoverTooltip(); return }
        const id = `vehicle:${index}`
        if (id !== hoveredFeatureId) {
          hoveredFeatureId = id
          const lines = [
            vehicle.source === 'live' ? `Vehicle ${vehicle.card.title}` : 'Scheduled vehicle',
            `Route ${vehicle.routeShortName || vehicle.routeId}`,
            vehicle.card.journey?.destination ? `To ${vehicle.card.journey.destination}` : '',
            vehicle.tripId ? `Trip ${vehicle.tripId.split(/::|\u001f/).at(-1)}` : '',
          ].filter(Boolean)
          hoverTooltip.setLngLat(vehicle.coordinate).setText(lines.join('\n')).addTo(map)
        }
      } else if (stop?.geometry.type === 'Point') {
        const id = textProperty(stop.properties, 'stopId')
        if (`stop:${id}` !== hoveredFeatureId) {
          hoveredFeatureId = `stop:${id}`
          const [lon, lat] = stop.geometry.coordinates
          hoverTooltip.setLngLat([lon, lat]).setText(textProperty(stop.properties, 'name', id)).addTo(map)
        }
      } else clearHoverTooltip()
    }
    map.getCanvas().style.cursor = routingEnabled || (scenarioFocus && scenarioPointPicking) ? 'crosshair' : ''
    map.on('click', handleClick)
    map.on('mousemove', handleMove)
    map.on('movestart', clearHoverTooltip)
    map.getCanvas().addEventListener('mouseleave', clearHoverTooltip)
    return () => {
      clearHoverTooltip()
      if (mapRemovedRef.current) return
      map.off('click', handleClick)
      map.off('mousemove', handleMove)
      map.off('movestart', clearHoverTooltip)
      map.getCanvas().removeEventListener('mouseleave', clearHoverTooltip)
      map.getCanvas().style.cursor = ''
    }
  }, [effectiveLayers.routes, effectiveLayers.segments, onRoutingPoint, onSelectRoute, onSelectStop, preview, routingEnabled, scenarioFocus, scenarioPointPicking, selectedRouteId, vehicleFrame])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusLocation) return
    const focus = () => {
      if (mapRemovedRef.current) return
      map.easeTo({ center: focusLocation.coordinate, zoom: Math.max(map.getZoom(), 14), duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450 })
      setLiveSelection({ tone: 'stop', stopId: focusLocation.stopId, eyebrow: 'Reference stop', title: focusLocation.label, subtitle: 'Selected from Agency evidence', metrics: [] })
    }
    if (map.isStyleLoaded()) focus()
    else map.once('idle', focus)
    return () => { map.off('idle', focus) }
  }, [focusLocation])

  return (
    <div className={classNames('map-stage', `basemap-${basemap}`)} data-map-state={mapVisualState}>
      <div ref={containerRef} className="maplibre-canvas" />
      {basemap === 'offline' ? (
        <div
          className={classNames('map-basemap-status', `is-${localStreetStatus.phase}`)}
          data-local-street-status={localStreetStatus.phase}
          role="status"
          aria-live="polite"
        >
          <span className="map-basemap-status-dot" aria-hidden="true" />
          <strong>Local OSM</strong>
          <small>
            {!localStreetGraphAvailable
              ? 'No local street index'
              : localStreetStatus.phase === 'loading'
                ? localStreetStatus.featureCount
                  ? `Refreshing · ${formatNumber(localStreetStatus.featureCount)} segments`
                  : 'Loading streets…'
                : localStreetStatus.phase === 'ready'
                  ? `${formatNumber(localStreetStatus.featureCount)} segments`
                  : localStreetStatus.phase === 'empty'
                    ? 'No streets in this view'
                    : localStreetStatus.phase === 'error'
                      ? localStreetStatus.detail || 'Could not load streets'
                      : 'Waiting for map view'}
          </small>
        </div>
      ) : null}
      {liveSelection && (showStopDetails || !liveSelection.stopId) ? (
        <div className={classNames('map-live-card', `is-${liveSelection.tone}`, Boolean(liveSelection.vehicleId && projectId) && 'has-vehicle-timing', Boolean(liveSelection.stopId && projectId) && 'has-stop-arrivals')}>
          <button type="button" aria-label="Clear map selection" onClick={() => setLiveSelection(null)}>
            <X size={13} strokeWidth={2.6} aria-hidden="true" />
          </button>
          {liveSelection.vehicleId ? <VehicleOperationalWarnings vehicle={vehicleFrame.vehicles.find(vehicle => vehicle.id === liveSelection.vehicleId && vehicle.sourceUrl === liveSelection.vehicleSourceUrl)} /> : null}
          {liveSelection.stopId && projectId ? <StopArrivalBoard onOpenTrip={onOpenTrip} key={`${projectId}/${liveSelection.stopId}`} projectId={projectId} stopId={liveSelection.stopId} /> : liveSelection.vehicleId && projectId ? <AgencyVehicleDetails key={`${projectId}/${liveSelection.vehicleSourceUrl}/${liveSelection.vehicleId}`} projectId={projectId} vehicleId={liveSelection.vehicleId} sourceUrl={liveSelection.vehicleSourceUrl} onOpenTrip={onOpenTrip} /> : <><span>{liveSelection.eyebrow}</span>
          <strong>{liveSelection.title}</strong>
          <small>{liveSelection.subtitle}</small>
          {liveSelection.journey ? (
            <div className="map-vehicle-journey">
              <div>
                <small>Destination</small>
                <strong>{liveSelection.journey.destination}</strong>
              </div>
              <div>
                <span>
                  <small>Next stop</small>
                  <strong>{liveSelection.journey.nextStop}</strong>
                </span>
                <b>
                  <small>{liveSelection.journey.arrivalLabel}</small>
                  {liveSelection.journey.arrival}
                </b>
              </div>
            </div>
          ) : null}
          <div className="map-live-metrics">
            {liveSelection.metrics.map((metric) => (
              <b key={`${metric.label}-${metric.value}`}>
                {metric.value}
                <small>{metric.label}</small>
              </b>
            ))}
          </div>
          </>}
        </div>
      ) : null}
      {mapFailure ? (
        <div
          className="map-loading"
          role="alert"
          aria-live="assertive"
          style={{ position: 'absolute', inset: 0, zIndex: 9 }}
        >
          <span className="map-loading-status">
            <strong>Map could not render</strong>
            <small>{mapFailure}</small>
          </span>
        </div>
      ) : routingFocus && routingPlan?.status !== 'ready' ? (
        <div className="map-empty" role="status" aria-live="polite">
          {routingPlan?.status === 'blocked' ? (
            <>
              <strong>{routingPlan.title}</strong>
              <small>{routingPlan.detail}</small>
            </>
          ) : (
            <strong>{routingStatusTitle || routingStatusDetail || 'Search or pick two places to begin'}</strong>
          )}
        </div>
      ) : !routingFocus && !scenarioFocus && !routingEnabled && !routingPlan && !hasDrawableNetwork ? (
        <div className="map-empty">
          <strong>Network view is preparing</strong>
          <small>VIGO is reading service geometry from the local SQLite index.</small>
        </div>
      ) : null}
    </div>
  )
}
