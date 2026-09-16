import { findNetworkStop } from './app/networkSelection'
import { setMapSourceData } from './app/mapSourceUpdates'
import { renderedStopAtPoint } from './app/mapStopSelection'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FeatureCollection as GeoJsonFeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import { X } from 'lucide-react'
import * as maplibregl from './app/mapRuntime'
import { type ExpressionSpecification, type FilterSpecification, type GeoJSONFeatureDiff, type GeoJSONFeatureId, type GeoJSONSource, type LngLatBoundsLike, type Map as MapLibreMap } from 'maplibre-gl'
import type { Appearance, Basemap, LayerState, LngLat, MapPreview, NetworkLens, Point, RouteMetric, StopMetric } from './domain'
import { classNames, formatNumber } from './domain'
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
import { inferredRouteJumpThresholdKm, routeStopPairCoordinates, routingLabelAnchor } from './app/mapPresentation'
import { mapFitPadding, previewStopBounds } from './app/mapViewport'
import { ensureVehicleDirectionSprite, vehicleHeadingLayer, vehicleMarkerLayer } from './app/mapDirections'
import { coordinateDistanceKm } from './app/geometry'
import { reportDesktopMapFailed, reportDesktopMapPhase, reportDesktopMapReady } from './app/desktopBridge'
import { routeGeometryLabel } from './app/routePresentation'
import { cityPublicRouteKey } from './app/cityPreview'
import { buildNetworkPerformanceProfile, type NetworkPerformanceProfile } from './networkPerformance'
import { serviceKeyForRoute, serviceVehicleIsVisible, type ServiceVehicleFrame } from './serviceVehicles'
import { VehicleOperationalWarnings, AgencyVehicleDetails, type VehicleNavigation } from './components/AgencyVehicleDetails'
import { StopArrivalBoard, type TripNavigation } from './components/StopArrivalBoard'
import type { RoutingPlan, RoutingPoint } from './routingModel'
import { routingPinLabel } from './routingPointSequence'
import {
  reachDifferenceColor,
  reachTimeColor,
  reachComparisonColor,
  type ReachResult,
  type ReachComparisonResult,
  type ScenarioRenderMode,
  type ScenarioStreetEdgeBundle,
  type ScenarioStreetEdgeSource,
  type ScenarioStopDraft,
  type ScenarioView,
  type ServiceEdgeDecomposition,
} from './reach'

type FeatureCollection = GeoJsonFeatureCollection<Geometry, GeoJsonProperties>
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
  onNavigateVehicle?: VehicleNavigation
  onSelectRoute: (id: string, options?: { inspect?: boolean }) => void
  onSelectStop: (id: string, options?: { inspect?: boolean }) => void
  onRoutingPoint?: (point: RoutingPoint) => void
}

const fallbackPreviewBounds = {
  west: -0.1,
  east: 0.1,
  south: -0.1,
  north: 0.1,
}

const emptyCollection: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
}
const routeLayerIds = ['vigo-route-casing', 'vigo-routes', 'vigo-selected-route']
const segmentLayerIds = ['vigo-segments-casing', 'vigo-segments', 'vigo-selected-segments']
const stopLayerIds = ['vigo-overview-stops', 'vigo-network-stops', 'vigo-stops', 'vigo-selected-stop']
const transferLayerIds = ['vigo-transfer-stops']
const coverageLayerIds = ['vigo-coverage']
const scenarioLayerIds = ['vigo-scenario-routes']
const accessLayerIds = ['vigo-access-outer', 'vigo-access-middle', 'vigo-access-inner']
const vehicleLayerIds = ['vigo-vehicle-pairs', 'vigo-vehicle-indicator-label', 'vigo-vehicle-halo', 'vigo-vehicles', 'vigo-vehicle-headings', 'vigo-vehicle-labels']
const routingLayerIds = ['vigo-routing-walk-casing', 'vigo-routing-walk', 'vigo-routing-drive-casing', 'vigo-routing-drive', 'vigo-routing-ride-casing', 'vigo-routing-ride', 'vigo-routing-labels', 'vigo-routing-pin-halo', 'vigo-routing-pins']
const reachResultLayerIds = [
  'vigo-scenario-area',
  'vigo-service-edges',
  'vigo-scenario-contours',
  'vigo-scenario-access-edges',
  'vigo-reach-route',
  'vigo-scenario-sketch-line',
  'vigo-scenario-sketch-hit',
  'vigo-scenario-sketch-stops',
  'vigo-scenario-sketch-labels',
]
const localStreetLayerIds = ['vigo-local-streets-casing', 'vigo-local-streets']

function reachComparisonLayerIds(count: number) {
  return Array.from({ length: count }, (_, index) => [
    `vigo-scenario-comparison-${index}-area`,
    `vigo-scenario-comparison-${index}-access-edges`,
    `vigo-scenario-comparison-${index}-contours`,
  ]).flat()
}

function existingScenarioComparisonLayerIds(map: MapLibreMap) {
  return (map.getStyle().layers ?? [])
    .map((layer) => layer.id)
    .filter((layerId) => layerId.startsWith('vigo-scenario-comparison-'))
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
    if (frame) window.cancelAnimationFrame(frame)
    frame = window.requestAnimationFrame(run)
  }

  if (ready || map.loaded()) schedule()
  else map.once('load', schedule)

  return () => {
    cancelled = true
    if (frame) window.cancelAnimationFrame(frame)
    if (!removed()) map.off('load', schedule)
  }
}

function pointToLngLat(point: Point): [number, number] {
  const lng = fallbackPreviewBounds.west + (point.x / 100) * (fallbackPreviewBounds.east - fallbackPreviewBounds.west)
  const lat = fallbackPreviewBounds.north - (point.y / 100) * (fallbackPreviewBounds.north - fallbackPreviewBounds.south)
  return [lng, lat]
}

function stopLngLat(stop: StopMetric): [number, number] {
  if (typeof stop.lon === 'number' && typeof stop.lat === 'number') return [stop.lon, stop.lat]
  return pointToLngLat({ x: stop.x, y: stop.y })
}

function routeCoordinates(route: RouteMetric, stopsById: Map<string, StopMetric>): Array<[number, number]> {
  if (route.coordinates && route.coordinates.length >= 2) return route.coordinates

  const fromStops = route.stopIds
    .map((stopId) => stopsById.get(stopId))
    .filter((stop): stop is StopMetric => Boolean(stop))
    .map(stopLngLat)

  if (fromStops.length >= 2) return fromStops
  return route.points.map(pointToLngLat)
}

function directionLabel(directionId?: string) {
  return directionId !== undefined && directionId !== '' ? `Direction ${directionId}` : 'Direction unspecified'
}

function routeDisplayName(shortName: string, longName?: string) {
  return longName ? `${shortName} / ${longName}` : shortName
}

function pathDistanceKm(coordinates: LngLat[]) {
  return coordinates.slice(1).reduce((sum, coordinate, index) => sum + coordinateDistanceKm(coordinates[index], coordinate), 0)
}

type LineGeometry =
  | { type: 'LineString'; coordinates: LngLat[] }
  | { type: 'MultiLineString'; coordinates: LngLat[][] }

const maxTrustedShapeJumpKm = 18
const maxInferredSegmentKm = 4.5

function isFiniteLngLat(coordinate: LngLat | undefined): coordinate is LngLat {
  return Boolean(
    coordinate &&
      Number.isFinite(coordinate[0]) &&
      Number.isFinite(coordinate[1]) &&
      coordinate[0] >= -180 &&
      coordinate[0] <= 180 &&
      coordinate[1] >= -90 &&
      coordinate[1] <= 90,
  )
}

function splitLineAtJumps(coordinates: LngLat[], maxJumpKm: number) {
  const segments: LngLat[][] = []
  let segment: LngLat[] = []

  for (const coordinate of coordinates) {
    if (!isFiniteLngLat(coordinate)) continue

    const previous = segment.at(-1)
    if (previous) {
      const jumpKm = coordinateDistanceKm(previous, coordinate)
      if (jumpKm > maxJumpKm) {
        if (segment.length >= 2) segments.push(segment)
        segment = [coordinate]
        continue
      }
      if (jumpKm < 0.001) continue
    }

    segment.push(coordinate)
  }

  if (segment.length >= 2) segments.push(segment)
  return segments
}

function lineGeometryFromSegments(segments: LngLat[][]): LineGeometry | null {
  const drawableSegments = segments.filter((segment) => segment.length >= 2)
  if (!drawableSegments.length) return null
  if (drawableSegments.length === 1) return { type: 'LineString', coordinates: drawableSegments[0] }
  return { type: 'MultiLineString', coordinates: drawableSegments }
}

function lineGeometryCoordinates(geometry: Geometry): Array<[number, number]> {
  if (geometry.type === 'LineString') return geometry.coordinates as Array<[number, number]>
  if (geometry.type === 'MultiLineString') return (geometry.coordinates as Array<Array<[number, number]>>).flat()
  return []
}

function downsampleCoordinates(coordinates: LngLat[], maxPoints: number) {
  const boundedLimit = Math.max(2, Math.floor(maxPoints))
  if (coordinates.length <= boundedLimit) return coordinates
  const sampled = Array.from({ length: boundedLimit }, (_value, index) => (
    coordinates[Math.round(index * (coordinates.length - 1) / (boundedLimit - 1))]
  ))
  return sampled.filter((coordinate, index) => index === 0 || coordinate !== sampled[index - 1])
}

function segmentKey(patternId: string, sequence: number, fromStopId: string, toStopId: string) {
  return `${patternId}::${sequence}::${fromStopId}::${toStopId}`
}

function fallbackSegmentCoordinates(pair: StopMetric[], preferred?: LngLat[]) {
  const fallback = pair.map(stopLngLat)
  const directDistance = coordinateDistanceKm(fallback[0], fallback[1])
  if (!preferred?.length) return directDistance <= maxInferredSegmentKm ? fallback : []

  const preferredDistance = pathDistanceKm(preferred)
  const maximumExpectedDistance = Math.max(0.45, directDistance * 7)

  if (preferredDistance <= maximumExpectedDistance) return preferred
  return directDistance <= maxInferredSegmentKm ? fallback : []
}

function routeLineSegments(route: RouteMetric, stopsById: Map<string, StopMetric>) {
  const coordinates = routeCoordinates(route, stopsById) as LngLat[]
  const source = route.geometrySource ?? (route.coordinates?.length ? 'shape' : 'stop_sequence')
  const inferredDistancesKm = coordinates.slice(1).map((coordinate, index) => coordinateDistanceKm(coordinates[index], coordinate))
  const maxJumpKm = source === 'shape'
    ? Math.max(7, Math.min(maxTrustedShapeJumpKm, (route.distanceKm ?? pathDistanceKm(coordinates)) * 0.22))
    : inferredRouteJumpThresholdKm(inferredDistancesKm)

  return splitLineAtJumps(coordinates, maxJumpKm)
}

function routeStopPairPaths(preview: MapPreview, stopsById: Map<string, StopMetric>, allowedPatternIds?: Set<string>) {
  const paths = new Map<string, LngLat[]>()

  for (const route of preview.routes) {
    const routeId = cityPublicRouteKey(route)
    if (allowedPatternIds && !allowedPatternIds.has(routeId)) continue
    const coordinates = routeCoordinates(route, stopsById)
    if (coordinates.length < 2 || route.stopIds.length < 2) continue

    const stops = route.stopIds.map((stopId) => stopsById.get(stopId))
    if (stops.some((stop) => !stop)) continue
    const intervals = routeStopPairCoordinates(coordinates, stops.map((stop) => stopLngLat(stop!)))
    intervals.forEach((interval, index) => {
      if (!interval) return
      const key = segmentKey(routeId, index + 1, route.stopIds[index], route.stopIds[index + 1])
      paths.set(key, downsampleCoordinates(interval, 90))
    })
  }

  return paths
}

function routeFeatures(
  preview: MapPreview,
  selectedRouteId: string,
  highlightRouteGroup = false,
): FeatureCollection {
  const stopsById = new Map(preview.stops.map((stop) => [stop.id, stop]))

  return {
    type: 'FeatureCollection',
    features: preview.routes
      .flatMap((route) => {
        const segments = routeLineSegments(route, stopsById)
        const routeId = cityPublicRouteKey(route)
        const selectedPattern = highlightRouteGroup || routeId === selectedRouteId
        // Route coordinates come from GTFS. Do not simplify or resample
        // them in the browser; derived stop-pair overlays retain their own
        // independent rendering budget below.
        const geometry = lineGeometryFromSegments(segments)
        if (!geometry) return []
        const geometrySource = route.geometrySource ?? (route.coordinates?.length ? 'shape' : 'stop_sequence')
        const geometryConfidence = geometrySource === 'shape' && segments.length === 1
          ? 'trusted'
          : geometrySource === 'shape'
            ? 'split'
            : 'inferred'

        return [{
          type: 'Feature' as const,
          geometry,
          properties: {
            featureId: cityPublicRouteKey(route),
            routeId: route.routeId ?? route.id,
            patternId: route.patternId ?? route.id,
            directionId: route.directionId ?? '',
            shapeId: route.shapeId ?? '',
            shortName: route.shortName,
            longName: route.longName,
            color: route.color,
            tripCount: route.tripCount,
            status: route.status,
            headwayMinutes: route.headwayMinutes,
            spanHours: route.spanHours,
            stopCount: route.stopCount,
            serviceHours: route.serviceHours,
            serviceShare: route.serviceShare ?? 0,
            frequencyClass: route.frequencyClass ?? 'low',
            geometrySource,
            geometryConfidence,
            geometryFragmentCount: segments.length,
            distanceKm: route.distanceKm ?? 0,
            scheduledSpeedKph: route.scheduledSpeedKph ?? 0,
            selectedPattern,
          },
        }]
      }),
  }
}

function segmentFeatures(preview: MapPreview, performanceProfile: NetworkPerformanceProfile): FeatureCollection {
  const stopsById = new Map(preview.stops.map((stop) => [stop.id, stop]))
  const visiblePairs = [...(preview.stopPairs ?? [])]
    .sort((left, right) => right.tripCount - left.tripCount)
    .slice(0, performanceProfile.segmentBudget)
  const visiblePatternIds = new Set(visiblePairs.map((pair) => pair.patternId))
  const pathsBySegment = routeStopPairPaths(preview, stopsById, visiblePatternIds)

  return {
    type: 'FeatureCollection',
    features: visiblePairs
      .map((pair) => {
        const fromStop = stopsById.get(pair.fromStopId)
        const toStop = stopsById.get(pair.toStopId)
        const segmentPath = pathsBySegment.get(segmentKey(pair.patternId, pair.sequence, pair.fromStopId, pair.toStopId))
        const rawCoordinates = fromStop && toStop
          ? segmentPath ?? fallbackSegmentCoordinates([fromStop, toStop], pair.coordinates)
          : []
        const coordinates = downsampleCoordinates(rawCoordinates, performanceProfile.segmentPointBudget)

        return {
          type: 'Feature' as const,
          geometry: {
            type: 'LineString' as const,
            coordinates: coordinates as LngLat[],
          },
          properties: {
            segmentId: pair.id,
            routeId: pair.routeId,
            patternId: pair.patternId,
            directionId: pair.directionId ?? '',
            fromStopId: pair.fromStopId,
            toStopId: pair.toStopId,
            fromStopName: pair.fromStopName,
            toStopName: pair.toStopName,
            sequence: pair.sequence,
            tripCount: pair.tripCount,
            headwayMinutes: pair.headwayMinutes,
            medianRuntimeMinutes: pair.medianRuntimeMinutes,
            distanceKm: pair.distanceKm,
            speedKph: pair.speedKph,
          },
        }
      })
      .filter((feature) => feature.geometry.coordinates.length >= 2),
  }
}

function stopFeatures(
  preview: MapPreview,
  selectedRouteId: string,
  selectedStopId: string,
  performanceProfile: NetworkPerformanceProfile,
): FeatureCollection {
  const selectedRoute = preview.routes.find((route) => route.id === selectedRouteId)
  const selectedStopIds = new Set(selectedRoute?.stopIds ?? [])
  const resolvedStopId = findNetworkStop(preview.stops, selectedStopId)?.id
  const hasSelectedPattern = selectedStopIds.size > 0
  const selectedStops = new Set([...selectedStopIds, resolvedStopId].filter(Boolean))
  let stops = preview.stops

  if (Number.isFinite(performanceProfile.stopBudget) && preview.stops.length > performanceProfile.stopBudget) {
    const rankedStops = [...preview.stops].sort((left, right) => {
      const selectedDelta = Number(selectedStops.has(right.id)) - Number(selectedStops.has(left.id))
      if (selectedDelta) return selectedDelta
      const transferDelta = right.transferScore - left.transferScore
      if (transferDelta) return transferDelta
      return right.tripCount - left.tripCount
    })
    const transferStops = rankedStops
      .filter((stop) => stop.routes.length >= 2 || stop.transferScore >= 20)
      .slice(0, performanceProfile.transferStopBudget)
    const chosenStops = new Map<string, StopMetric>()

    for (const stop of preview.stops) {
      if (selectedStops.has(stop.id)) chosenStops.set(stop.id, stop)
    }
    for (const stop of transferStops) chosenStops.set(stop.id, stop)
    for (const stop of rankedStops) {
      if (chosenStops.size >= performanceProfile.stopBudget) break
      chosenStops.set(stop.id, stop)
    }

    stops = preview.stops.filter((stop) => chosenStops.has(stop.id))
  }

  return {
    type: 'FeatureCollection',
    features: stops.map((stop) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: stopLngLat(stop),
      },
      properties: {
        stopId: stop.id,
        name: stop.name,
        routeCount: stop.routes.length,
        tripCount: stop.tripCount,
        transferScore: stop.transferScore,
        routes: stop.routes.join(', '),
        selectedPatternStop: hasSelectedPattern && selectedStopIds.has(stop.id),
        selectedStop: stop.id === resolvedStopId,
      },
    })),
  }
}

function accessFeatures(preview: MapPreview, selectedStopId: string): FeatureCollection {
  const selectedStop = preview.stops.find((stop) => stop.id === selectedStopId) ?? preview.stops[0]
  if (!selectedStop) return emptyCollection
  const center = stopLngLat(selectedStop)
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: center,
        },
        properties: {
          stopId: selectedStop.id,
        },
      },
    ],
  }
}

function uniqueVehicleFeatureId(prefix: string, vehicleId: string, occurrences: Map<string, number>) {
  const occurrence = occurrences.get(vehicleId) ?? 0
  occurrences.set(vehicleId, occurrence + 1)
  return `${prefix}:${vehicleId}:${occurrence}`
}

function serviceVehicleFeatures(frame: ServiceVehicleFrame, preview: MapPreview, selectedRouteId: string): FeatureCollection {
  const selectedRoute = preview.routes.find((route) => route.id === selectedRouteId || route.patternId === selectedRouteId)
  const selectedServiceKey = selectedRoute ? serviceKeyForRoute(selectedRoute) : ''
  const occurrences = new Map<string, number>()

  const features: FeatureCollection['features'] = []
  for (let vehicleIndex = 0; vehicleIndex < frame.vehicles.length; vehicleIndex++) {
    const vehicle = frame.vehicles[vehicleIndex]
    if (!isFiniteLngLat(vehicle.coordinate)) continue
    const selectedRouteMatch = Boolean(selectedServiceKey && vehicle.serviceKey === selectedServiceKey)
    if (!serviceVehicleIsVisible(vehicle, preview, selectedRouteId)) continue
    const hasBearing = vehicle.bearing !== undefined && Number.isFinite(vehicle.bearing)
    features.push({
      type: 'Feature' as const,
      id: uniqueVehicleFeatureId(vehicle.source, vehicle.id, occurrences),
      geometry: {
        type: 'Point' as const,
        coordinates: vehicle.coordinate,
      },
      properties: {
        delaySeverity: vehicle.delaySeverity || '',
        gapSeverity: vehicle.gapSeverity || '',
        crowded: vehicle.crowded || false,
        indicatorLabel: vehicle.indicatorLabel || '',
        vehicleIndex,
        vehicleId: vehicle.id,
        label: vehicle.card.title,
        routeId: vehicle.routeId,
        routeShortName: vehicle.routeShortName,
        routeColor: vehicle.routeColor,
        selectedRoute: selectedRouteMatch,
        bearing: hasBearing ? vehicle.bearing : 0,
        hasBearing,
        source: vehicle.source,
      },
    })
    if (vehicle.pairedCoordinate) features.push({
      type: 'Feature' as const, id: `pair:${vehicle.sourceUrl || ''}:${vehicle.id}`,
      geometry: { type: 'LineString' as const, coordinates: [vehicle.pairedCoordinate, vehicle.coordinate] },
      properties: { pair: true, gapSeverity: vehicle.gapSeverity, vehicleIndex },
    })
  }
  return { type: 'FeatureCollection', features }
}

function routingLineFeatures(plan: RoutingPlan | null | undefined): FeatureCollection {
  if (!plan?.legs.length) return emptyCollection

  const lineFeatures = plan.legs
    .filter((leg) => leg.coordinates.length >= 2)
    .map((leg, index) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: leg.coordinates,
      },
      properties: {
        featureKind: 'line',
        legIndex: index,
        legType: leg.type,
        travelMode: leg.travelMode ?? '',
        walkSource: leg.walkSource ?? '',
        routeShortName: leg.routeShortName ?? '',
        routeColor: mapColor(leg.routeColor, '#7ddfe8'),
        durationMinutes: leg.durationMinutes,
        tripId: leg.tripId ?? '',
        geometrySource: leg.type === 'ride' ? leg.geometrySource ?? 'stop_sequence' : '',
        shapeId: leg.shapeId ?? '',
      },
    }))
  const labelFeatures = plan.legs.flatMap((leg, index) => {
    const routeShortName = leg.routeShortName?.trim()
    const anchor = leg.type === 'ride' && routeShortName
      ? routingLabelAnchor(leg.coordinates)
      : null
    if (!anchor) return []

    return [{
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: anchor,
      },
      properties: {
        featureKind: 'label',
        legIndex: index,
        legType: leg.type,
        routeShortName,
        routeColor: mapColor(leg.routeColor, '#7ddfe8'),
        geometrySource: leg.geometrySource ?? 'stop_sequence',
      },
    }]
  })

  return {
    type: 'FeatureCollection',
    features: [...lineFeatures, ...labelFeatures],
  }
}

function routingPinFeatures(
  origin: RoutingPoint | null | undefined,
  waypoints: RoutingPoint[],
  destination: RoutingPoint | null | undefined,
  plan?: RoutingPlan | null,
  reachMode = false,
): FeatureCollection {
  const points = [origin, ...waypoints, destination].filter((point): point is RoutingPoint => Boolean(point))
  const firstLeg = plan?.status === 'ready' ? plan.legs[0] : undefined
  const lastLeg = plan?.status === 'ready' ? plan.legs.at(-1) : undefined
  const features: FeatureCollection['features'] = points.map((point, index) => {
    const pointKind = index === 0
      ? 'origin'
      : index === points.length - 1
        ? 'destination'
        : 'waypoint'
    const plannedCoordinate = pointKind === 'origin'
      && firstLeg?.type === 'walk'
      && firstLeg.walkSource === 'osm'
      ? firstLeg.coordinates[0]
      : pointKind === 'destination'
        && lastLeg?.type === 'walk'
        && lastLeg.walkSource === 'osm'
        ? lastLeg.coordinates.at(-1)
        : undefined
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: plannedCoordinate ?? point.coordinate },
      properties: {
        pinType: routingPinLabel(index, points.length),
        label: point.label,
        pointKind,
        zeroMinuteOrigin: reachMode && pointKind === 'origin',
      },
    }
  })
  return { type: 'FeatureCollection', features }
}

function scenarioSketchFeatures(stops: ScenarioStopDraft[], geometry: LngLat[] = []): FeatureCollection {
  const features: FeatureCollection['features'] = stops.map((stop, index) => ({
    type: 'Feature',
    id: stop.id,
    properties: {
      id: stop.id,
      label: stop.label,
      sequenceLabel: String(index + 1),
      stopNumber: index + 1,
      index,
      kind: 'stop',
      source: stop.source,
      editStatus: stop.editStatus ?? 'baseline',
    },
    geometry: { type: 'Point', coordinates: stop.coordinate },
  }))
  if (stops.length >= 2) {
    features.unshift({
      type: 'Feature',
      id: 'scenario-sketch-line',
      properties: { id: 'scenario-sketch-line', kind: 'line' },
      geometry: { type: 'LineString', coordinates: geometry.length >= 2 ? geometry : stops.map((stop) => stop.coordinate) },
    })
  }
  return { type: 'FeatureCollection', features }
}

function scenarioContourFeatures(
  analysis: ReachResult | null | undefined,
  view: ScenarioView,
  cutoffMinutes: number,
): FeatureCollection {
  if (!analysis) return emptyCollection
  const surfaces = view === 'comparison'
    ? ['baseline', 'scenario'] as const
    : [view] as const
  return {
    type: 'FeatureCollection',
    features: surfaces.flatMap((surface) => (
      analysis.surface.contours[surface].features.filter((feature) => (
        Number(feature.properties?.cutoffMinutes) === cutoffMinutes
      ))
    )),
  }
}

function scenarioAreaFeatures(
  analysis: ReachResult | null | undefined,
  view: ScenarioView,
  cutoffMinutes: number,
): FeatureCollection {
  if (!analysis?.surface.areas) return emptyCollection
  const surfaces = view === 'comparison'
    ? ['baseline', 'scenario'] as const
    : [view] as const
  return {
    type: 'FeatureCollection',
    features: surfaces.flatMap((surface) => (
      analysis.surface.areas?.[surface].features
        .filter((feature) => Number(feature.properties?.cutoffMinutes) === cutoffMinutes)
        .map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            color: surface === 'scenario' ? '#35d0a1' : '#6da8ff',
          },
        })) ?? []
    )),
  }
}

type DecodedStreetEdgeBundle = {
  nodes: Float64Array
  endpoints: Uint32Array
  edgeIds: Uint32Array
  durations: Float64Array
}

type StreetEdgeCallback = (
  coordinates: [LngLat, LngLat],
  durationMinutes: number,
) => void

type ScenarioEdgeSources = {
  baseline: ScenarioStreetEdgeSource
  scenario: ScenarioStreetEdgeSource
}

const decodedStreetEdgeBundles = new WeakMap<object, DecodedStreetEdgeBundle>()

function decodeBase64Bytes(value: string) {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function decodeStreetEdgeBundle(bundle: ScenarioStreetEdgeBundle): DecodedStreetEdgeBundle {
  const cached = decodedStreetEdgeBundles.get(bundle)
  if (cached) return cached
  const decoded = {
    nodes: new Float64Array(decodeBase64Bytes(bundle.nodes)),
    endpoints: new Uint32Array(decodeBase64Bytes(bundle.endpoints)),
    edgeIds: new Uint32Array(decodeBase64Bytes(bundle.edgeIds)),
    durations: new Float64Array(decodeBase64Bytes(bundle.durationMinutes)),
  }
  if (
    decoded.nodes.length !== bundle.nodeCount * 2
    || decoded.endpoints.length !== bundle.count * 2
    || decoded.edgeIds.length !== bundle.count
    || decoded.durations.length !== bundle.count
  ) throw new Error('Reach street-edge bundle has inconsistent packed lengths.')
  decodedStreetEdgeBundles.set(bundle, decoded)
  return decoded
}

function resolveStreetEdgeSource(source: ScenarioStreetEdgeSource, sources?: ScenarioEdgeSources) {
  let resolved = source
  const seen = new Set<string>()
  while (resolved.schemaVersion === 'vigo.street.edge-ref.v1') {
    if (seen.has(resolved.source)) throw new Error('Reach street-edge reference cycle.')
    seen.add(resolved.source)
    const next = sources?.[resolved.source]
    if (!next) throw new Error(`Reach street-edge reference is missing: ${resolved.source}.`)
    resolved = next
  }
  return resolved
}

function forEachStreetEdge(
  source: ScenarioStreetEdgeSource,
  callback: StreetEdgeCallback,
  sources?: ScenarioEdgeSources,
) {
  const resolved = resolveStreetEdgeSource(source, sources)
  if (resolved.schemaVersion !== 'vigo.street.edge-bundle.v1') {
    throw new Error('Reach street-edge bundle schema is unsupported.')
  }
  const decoded = decodeStreetEdgeBundle(resolved)
  for (let index = 0; index < resolved.count; index += 1) {
    const fromNode = decoded.endpoints[index * 2] * 2
    const toNode = decoded.endpoints[index * 2 + 1] * 2
    if (fromNode + 1 >= decoded.nodes.length || toNode + 1 >= decoded.nodes.length) {
      throw new Error('Reach street-edge bundle references an invalid node.')
    }
    callback(
      [
        [decoded.nodes[fromNode], decoded.nodes[fromNode + 1]],
        [decoded.nodes[toNode], decoded.nodes[toNode + 1]],
      ],
      decoded.durations[index],
    )
  }
}

function indexedStreetEdges(source: ScenarioStreetEdgeSource, sources?: ScenarioEdgeSources) {
  const resolved = resolveStreetEdgeSource(source, sources)
  if (resolved.schemaVersion !== 'vigo.street.edge-bundle.v1') {
    throw new Error('Reach street-edge bundle schema is unsupported.')
  }
  const decoded = decodeStreetEdgeBundle(resolved)
  for (let index = 1; index < decoded.edgeIds.length; index += 1) {
    if (decoded.edgeIds[index] <= decoded.edgeIds[index - 1]) {
      throw new Error('Reach street-edge IDs must be strictly increasing.')
    }
  }
  return { decoded }
}

function indexedEdgeArrival(decoded: DecodedStreetEdgeBundle, index: number) {
  return decoded.durations[index]
}

function indexedEdgeCoordinates(decoded: DecodedStreetEdgeBundle, index: number): [LngLat, LngLat] {
  const fromNode = decoded.endpoints[index * 2] * 2
  const toNode = decoded.endpoints[index * 2 + 1] * 2
  if (fromNode + 1 >= decoded.nodes.length || toNode + 1 >= decoded.nodes.length) {
    throw new Error('Reach street-edge bundle references an invalid node.')
  }
  return [
    [decoded.nodes[fromNode], decoded.nodes[fromNode + 1]],
    [decoded.nodes[toNode], decoded.nodes[toNode + 1]],
  ]
}

function groupedStreetFeatures(
  groups: Map<string, { color: string; coordinates: Array<[LngLat, LngLat]>; count: number }>,
  surface: string,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [...groups.values()].map((group) => ({
      type: 'Feature' as const,
      geometry: { type: 'MultiLineString' as const, coordinates: group.coordinates },
      properties: {
        color: group.color,
        surface,
        edgeCount: group.count,
      },
    })),
  }
}

function indexedScenarioEdgeFeatures(
  edges: ScenarioEdgeSources,
  cutoffMinutes: number,
): FeatureCollection {
  const baseline = indexedStreetEdges(edges.baseline, edges)
  const scenario = indexedStreetEdges(edges.scenario, edges)
  const groups = new Map<string, { color: string; coordinates: Array<[LngLat, LngLat]>; count: number }>()
  const add = (beforeIndex: number | undefined, afterIndex: number | undefined) => {
    const beforeMinutes = beforeIndex === undefined
      ? Number.POSITIVE_INFINITY
      : indexedEdgeArrival(baseline.decoded, beforeIndex)
    const afterMinutes = afterIndex === undefined
      ? Number.POSITIVE_INFINITY
      : indexedEdgeArrival(scenario.decoded, afterIndex)
    if (beforeMinutes > cutoffMinutes && afterMinutes > cutoffMinutes) return
    const edgeMinutes = Number.isFinite(afterMinutes) ? afterMinutes : beforeMinutes
    const deltaMinutes = Number.isFinite(beforeMinutes) && Number.isFinite(afterMinutes)
      ? beforeMinutes - afterMinutes
      : Number.isFinite(afterMinutes) ? cutoffMinutes : -cutoffMinutes
    const [red, green, blue] = reachDifferenceColor(deltaMinutes)
    const color = `rgb(${red}, ${green}, ${blue})`
    const group = groups.get(color) ?? { color, coordinates: [], count: 0 }
    const coordinates = indexedEdgeCoordinates(
      afterIndex === undefined ? baseline.decoded : scenario.decoded,
      afterIndex === undefined ? beforeIndex as number : afterIndex,
    )
    if (!Number.isFinite(edgeMinutes)) return
    group.coordinates.push(coordinates)
    group.count += 1
    groups.set(color, group)
  }
  let baselineIndex = 0
  let scenarioIndex = 0
  while (
    baselineIndex < baseline.decoded.edgeIds.length
    || scenarioIndex < scenario.decoded.edgeIds.length
  ) {
    const baselineId = baseline.decoded.edgeIds[baselineIndex]
    const scenarioId = scenario.decoded.edgeIds[scenarioIndex]
    if (scenarioIndex >= scenario.decoded.edgeIds.length || baselineId < scenarioId) {
      add(baselineIndex, undefined)
      baselineIndex += 1
    } else if (baselineIndex >= baseline.decoded.edgeIds.length || scenarioId < baselineId) {
      add(undefined, scenarioIndex)
      scenarioIndex += 1
    } else {
      add(baselineIndex, scenarioIndex)
      baselineIndex += 1
      scenarioIndex += 1
    }
  }
  return groupedStreetFeatures(groups, 'comparison')
}

function scenarioEdgeFeatures(
  analysis: ReachResult | null | undefined,
  view: ScenarioView,
  cutoffMinutes: number,
): FeatureCollection {
  const edges = analysis?.surface.edges
  if (!edges) return emptyCollection
  const colorForDuration = (durationMinutes: number) => {
    const [red, green, blue] = reachTimeColor(cutoffMinutes > 0 ? durationMinutes / cutoffMinutes : 1)
    return `rgb(${red}, ${green}, ${blue})`
  }
  if (view !== 'comparison') {
    const groups = new Map<string, { color: string; coordinates: Array<[LngLat, LngLat]>; count: number }>()
    forEachStreetEdge(edges[view], (coordinates, durationMinutes) => {
      const arrival = durationMinutes
      if (arrival > cutoffMinutes) return
      const color = colorForDuration(arrival)
      const group = groups.get(color) ?? { color, coordinates: [], count: 0 }
      group.coordinates.push(coordinates)
      group.count += 1
      groups.set(color, group)
    }, edges)
    return groupedStreetFeatures(groups, view)
  }
  return indexedScenarioEdgeFeatures(edges, cutoffMinutes)
}

function reachComparisonContourFeatures(
  analysis: ReachResult | null | undefined,
  cutoffMinutes: number,
): FeatureCollection {
  if (!analysis) return emptyCollection
  return {
    type: 'FeatureCollection',
    features: analysis.surface.contours.baseline.features.filter((feature) => (
      Number(feature.properties?.cutoffMinutes) === cutoffMinutes
    )),
  }
}

function reachComparisonAreaFeatures(
  analysis: ReachResult | null | undefined,
  cutoffMinutes: number,
  color: string,
): FeatureCollection {
  const areas = analysis?.surface.areas?.baseline
  if (!areas) return emptyCollection
  return {
    type: 'FeatureCollection',
    features: areas.features
      .filter((feature) => Number(feature.properties?.cutoffMinutes) === cutoffMinutes)
      .map((feature) => ({
        ...feature,
        properties: { ...feature.properties, color },
      })),
  }
}

function reachComparisonEdgeFeatures(
  analysis: ReachResult,
  cutoffMinutes: number,
  color: string,
): FeatureCollection {
  const source = analysis.surface.edges?.baseline
  if (!source) return emptyCollection
  const coordinates: Array<[LngLat, LngLat]> = []
  forEachStreetEdge(source, (edgeCoordinates, durationMinutes) => {
    if (durationMinutes <= cutoffMinutes) coordinates.push(edgeCoordinates)
  }, analysis.surface.edges)
  return coordinates.length
    ? {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature' as const,
          geometry: { type: 'MultiLineString' as const, coordinates },
          properties: { color, surface: 'feed-comparison', edgeCount: coordinates.length },
        }],
      }
    : emptyCollection
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

function mapColor(value: string | undefined, fallback: string) {
  const color = value?.trim()
  if (!color) return fallback
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color}`
  return fallback
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

function setVisibility(map: MapLibreMap, layerIds: string[], visible: boolean) {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
    }
  }
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

function ensureLayers(map: MapLibreMap, comparisonCount = 0) {
  ensureVehicleDirectionSprite(map)
  if (!map.getSource('vigo-routes')) {
    map.addSource('vigo-routes', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-segments')) {
    map.addSource('vigo-segments', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-stops')) {
    map.addSource('vigo-stops', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-access')) {
    map.addSource('vigo-access', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-service-vehicles')) {
    map.addSource('vigo-service-vehicles', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-routing')) {
    map.addSource('vigo-routing', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-routing-pins')) {
    map.addSource('vigo-routing-pins', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-area')) {
    map.addSource('vigo-scenario-area', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-access-edges')) {
    map.addSource('vigo-scenario-access-edges', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-service-edges')) {
    map.addSource('vigo-service-edges', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-contours')) {
    map.addSource('vigo-scenario-contours', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-reach-route')) {
    map.addSource('vigo-reach-route', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-sketch')) {
    map.addSource('vigo-scenario-sketch', { type: 'geojson', data: emptyCollection })
  }
  for (let index = 0; index < comparisonCount; index += 1) {
    if (!map.getSource(`vigo-scenario-comparison-${index}-area`)) {
      map.addSource(`vigo-scenario-comparison-${index}-area`, { type: 'geojson', data: emptyCollection })
    }
    if (!map.getSource(`vigo-scenario-comparison-${index}-access-edges`)) {
      map.addSource(`vigo-scenario-comparison-${index}-access-edges`, { type: 'geojson', data: emptyCollection })
    }
    if (!map.getSource(`vigo-scenario-comparison-${index}-contours`)) {
      map.addSource(`vigo-scenario-comparison-${index}-contours`, { type: 'geojson', data: emptyCollection })
    }
  }

  if (!map.getLayer('vigo-scenario-area')) {
    map.addLayer({
      id: 'vigo-scenario-area',
      type: 'fill',
      source: 'vigo-scenario-area',
      paint: {
        'fill-color': ['get', 'color'] as ExpressionSpecification,
        'fill-opacity': 0.2,
        'fill-outline-color': ['get', 'color'] as ExpressionSpecification,
      },
    })
  }
  if (!map.getLayer('vigo-scenario-access-edges')) {
    map.addLayer({
      id: 'vigo-scenario-access-edges',
      type: 'line',
      source: 'vigo-scenario-access-edges',
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.75, 12, 1.45, 16, 2.8] as ExpressionSpecification,
        'line-opacity': 0.9,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer('vigo-service-edges')) {
    map.addLayer({
      id: 'vigo-service-edges',
      type: 'line',
      source: 'vigo-service-edges',
      paint: {
        'line-color': [
          'match',
          ['get', 'serviceIndicator'],
          0, '#ff6757',
          1, '#35d0a1',
          2, '#6da8ff',
          '#a6b4bf',
        ] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.1, 12, 3.8, 16, 6] as ExpressionSpecification,
        'line-opacity': 0.92,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer('vigo-scenario-contours')) {
    map.addLayer({
      id: 'vigo-scenario-contours',
      type: 'line',
      source: 'vigo-scenario-contours',
      paint: {
        'line-color': [
          'match',
          ['get', 'surface'],
          'scenario', '#35d0a1',
          '#6da8ff',
        ] as ExpressionSpecification,
        'line-width': 2,
        'line-opacity': 0.92,
      },
    })
  }
  if (!map.getLayer('vigo-reach-route')) {
    map.addLayer({
      id: 'vigo-reach-route',
      type: 'line',
      source: 'vigo-reach-route',
      paint: {
        'line-color': '#ffd166',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2, 13, 5] as ExpressionSpecification,
        'line-opacity': 0.94,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-line')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-line',
      type: 'line',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'line'],
      paint: {
        'line-color': '#ffd166',
        'line-width': 2.4,
        'line-dasharray': [1.4, 1.1],
      },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-hit')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-hit',
      type: 'circle',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: {
        'circle-radius': 11,
        'circle-color': '#ffffff',
        'circle-opacity': 0.01,
      },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-stops')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-stops',
      type: 'circle',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'editStatus'], 'baseline'], 3.5, 5] as ExpressionSpecification,
        'circle-color': [
          'match',
          ['get', 'editStatus'],
          'replaced', '#ff735c',
          'inserted', '#35d0a1',
          'added', '#35d0a1',
          '#ffffff',
        ] as ExpressionSpecification,
        'circle-stroke-color': '#071018',
        'circle-stroke-width': 1.5,
      },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-labels')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-labels',
      type: 'symbol',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'stop'],
      layout: {
        'text-field': ['get', 'sequenceLabel'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 13, 11] as ExpressionSpecification,
        'text-offset': [0, 1.25],
        'text-anchor': 'top',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': [
          'match',
          ['get', 'editStatus'],
          'replaced', '#ffb3a7',
          'inserted', '#a9f5d9',
          'added', '#a9f5d9',
          '#fff2bd',
        ] as ExpressionSpecification,
        'text-halo-color': '#071018',
        'text-halo-width': 1.4,
      },
    })
  }

  for (let index = 0; index < comparisonCount; index += 1) {
    const layerPrefix = `vigo-scenario-comparison-${index}`
    const color = reachComparisonColor(index)
    if (!map.getLayer(`${layerPrefix}-area`)) {
      map.addLayer({
        id: `${layerPrefix}-area`,
        type: 'fill',
        source: `${layerPrefix}-area`,
        paint: {
          'fill-color': ['get', 'color'] as ExpressionSpecification,
          'fill-opacity': 0.16,
          'fill-outline-color': ['get', 'color'] as ExpressionSpecification,
        },
      })
    }
    if (!map.getLayer(`${layerPrefix}-access-edges`)) {
      map.addLayer({
        id: `${layerPrefix}-access-edges`,
        type: 'line',
        source: `${layerPrefix}-access-edges`,
        paint: {
          'line-color': ['get', 'color'] as ExpressionSpecification,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 12, 1.3, 16, 2.5] as ExpressionSpecification,
          'line-opacity': 0.84,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })
    }
    if (!map.getLayer(`${layerPrefix}-contours`)) {
      map.addLayer({
        id: `${layerPrefix}-contours`,
        type: 'line',
        source: `${layerPrefix}-contours`,
        paint: {
          'line-color': color,
          'line-width': 2.4,
          'line-opacity': 0.96,
        },
      })
    }
  }

  if (!map.getLayer('vigo-coverage')) {
    map.addLayer({
      id: 'vigo-coverage',
      type: 'heatmap',
      source: 'vigo-stops',
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 0, 700, 1],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 13, 1.45],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 16, 13, 46],
        'heatmap-opacity': 0.64,
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0,
          'rgba(53,208,161,0)',
          0.22,
          'rgba(53,208,161,0.34)',
          0.58,
          'rgba(255,209,102,0.48)',
          1,
          'rgba(255,115,92,0.68)',
        ],
      },
    })
  }

  if (!map.getLayer('vigo-scenario-routes')) {
    map.addLayer({
      id: 'vigo-scenario-routes',
      type: 'line',
      source: 'vigo-routes',
      filter: ['in', ['get', 'status'], ['literal', ['added', 'changed', 'removed']]],
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 10, 0.9, 14, 2.2],
        'line-opacity': 0.2,
        'line-dasharray': [1.4, 1.2],
      },
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tripCount'] as ExpressionSpecification },
    })
  }

  if (!map.getLayer('vigo-route-casing')) {
    map.addLayer({
      id: 'vigo-route-casing',
      type: 'line',
      source: 'vigo-routes',
      paint: {
        'line-color': '#02060a',
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['==', ['get', 'selectedPattern'], true], 2.5, 0.58],
          10,
          ['case', ['==', ['get', 'selectedPattern'], true], 4.6, 1.28],
          14,
          ['case', ['==', ['get', 'selectedPattern'], true], 8.4, 3.05],
        ] as ExpressionSpecification,
        'line-opacity': ['case', ['==', ['get', 'selectedPattern'], true], 0.72, 0.24] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tripCount'] as ExpressionSpecification },
    })
  }

  if (!map.getLayer('vigo-routes')) {
    map.addLayer({
      id: 'vigo-routes',
      type: 'line',
      source: 'vigo-routes',
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['==', ['get', 'selectedPattern'], true], 1.5, 0.42],
          10,
          ['case', ['==', ['get', 'selectedPattern'], true], 3.4, 1.02],
          14,
          ['case', ['==', ['get', 'selectedPattern'], true], 6.6, 2.35],
        ] as ExpressionSpecification,
        'line-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['==', ['get', 'selectedPattern'], true], 0.98, 0.4],
          10,
          ['case', ['==', ['get', 'selectedPattern'], true], 0.98, 0.58],
          14,
          ['case', ['==', ['get', 'selectedPattern'], true], 0.98, 0.74],
        ] as ExpressionSpecification,
        'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 0.08, 12, 0.02] as ExpressionSpecification,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tripCount'] as ExpressionSpecification },
    })
  }

  if (!map.getLayer('vigo-selected-route')) {
    map.addLayer({
      id: 'vigo-selected-route',
      type: 'line',
      source: 'vigo-routes',
      filter: ['==', ['get', 'featureId'], '__none__'],
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.2, 10, 4.2, 14, 7.4],
        'line-opacity': 0.96,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }


  if (!map.getLayer('vigo-segments-casing')) {
    map.addLayer({
      id: 'vigo-segments-casing',
      type: 'line',
      source: 'vigo-segments',
      paint: {
        'line-color': '#02060a',
        'line-width': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 2.2, 650, 6.6],
        'line-opacity': 0.76,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-walk-casing')) {
    map.addLayer({
      id: 'vigo-routing-walk-casing',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'walk']],
      paint: {
        'line-color': '#0d8bd9',
        'line-width': 1,
        'line-opacity': 0,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-walk')) {
    map.addLayer({
      id: 'vigo-routing-walk',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'walk']],
      paint: {
        'line-color': '#0d8bd9',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 13, 2.6],
        'line-opacity': 0.94,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-drive-casing')) {
    map.addLayer({
      id: 'vigo-routing-drive-casing',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'drive']],
      paint: {
        'line-color': '#02060a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6.6, 13, 11],
        'line-opacity': 0.86,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-drive')) {
    map.addLayer({
      id: 'vigo-routing-drive',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'drive']],
      paint: {
        'line-color': '#ffad4d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 8],
        'line-opacity': 1,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-ride-casing')) {
    map.addLayer({
      id: 'vigo-routing-ride-casing',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'ride']],
      paint: {
        'line-color': '#02060a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5.6, 13, 9.5],
        'line-opacity': ['case', ['==', ['get', 'geometrySource'], 'shape'], 0.82, 0.48] as ExpressionSpecification,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-ride')) {
    map.addLayer({
      id: 'vigo-routing-ride',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'ride']],
      paint: {
        'line-color': ['coalesce', ['get', 'routeColor'], '#7ddfe8'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.2, 13, 6.8],
        'line-opacity': ['case', ['==', ['get', 'geometrySource'], 'shape'], 0.98, 0.72] as ExpressionSpecification,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-labels')) {
    map.addLayer({
      id: 'vigo-routing-labels',
      type: 'symbol',
      source: 'vigo-routing',
      filter: ['==', ['get', 'featureKind'], 'label'],
      layout: {
        'symbol-placement': 'point',
        'text-field': ['get', 'routeShortName'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9.5, 13, 11.5, 16, 12],
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
        'text-allow-overlap': false,
        'text-ignore-placement': false,
        'text-padding': 6,
      },
      paint: {
        'text-color': '#f8fbff',
        'text-halo-color': '#02060a',
        'text-halo-width': 1.45,
        'text-halo-blur': 0.35,
        'text-opacity': [
          'interpolate', ['linear'], ['zoom'], 9, 0, 10,
          ['case', ['==', ['get', 'geometrySource'], 'shape'], 0.96, 0.82],
        ] as ExpressionSpecification,
      },
    })
  }

  if (!map.getLayer('vigo-segments')) {
    map.addLayer({
      id: 'vigo-segments',
      type: 'line',
      source: 'vigo-segments',
      paint: {
        'line-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'speedKph'], 0],
          0,
          '#ff735c',
          15,
          '#ffd166',
          28,
          '#35d0a1',
          45,
          '#6da8ff',
        ],
        'line-width': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 1.4, 650, 4.8],
        'line-opacity': 0.9,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-selected-segments')) {
    map.addLayer({
      id: 'vigo-selected-segments',
      type: 'line',
      source: 'vigo-segments',
      filter: ['==', ['get', 'patternId'], '__none__'],
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 2.8, 650, 7.2],
        'line-opacity': 0.74,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-overview-stops')) {
    map.addLayer({
      id: 'vigo-overview-stops',
      type: 'circle',
      source: 'vigo-stops',
      maxzoom: 10.5,
      paint: {
        'circle-color': '#2f80ed',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 6, 1.35, 10.4, 2.1],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.34, 6, 0.58, 10.4, 0.16],
        'circle-stroke-color': '#dff5ff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 0, 7, 0.25],
        'circle-stroke-opacity': 0.46,
      },
    })
  }

  if (!map.getLayer('vigo-network-stops')) {
    map.addLayer({
      id: 'vigo-network-stops',
      type: 'circle',
      source: 'vigo-stops',
      filter: ['!=', ['get', 'selectedPatternStop'], true],
      minzoom: 10.5,
      paint: {
        'circle-color': '#dbe8f4',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1.5, 14, 4, 17, 6],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0.45, 14, 0.95],
        'circle-stroke-color': '#071017',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10.5, 0.5, 14, 1.5],
      },
    })
  }

  if (!map.getLayer('vigo-transfer-stops')) {
    map.addLayer({
      id: 'vigo-transfer-stops',
      type: 'circle',
      source: 'vigo-stops',
      filter: ['>=', ['get', 'routeCount'], 2],
      minzoom: 10,
      paint: {
        'circle-color': '#f4d27a',
        'circle-radius': ['interpolate', ['linear'], ['get', 'transferScore'], 0, 0.75, 100, 2.7],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.1, 13.5, 0.46],
        'circle-stroke-color': '#060a0f',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.35, 14, 0.8],
      },
    })
  }

  if (!map.getLayer('vigo-stops')) {
    map.addLayer({
      id: 'vigo-stops',
      type: 'circle',
      source: 'vigo-stops',
      filter: ['==', ['get', 'selectedPatternStop'], true],
      minzoom: 9,
      paint: {
        'circle-color': ['step', ['get', 'routeCount'], '#f4f7fb', 2, '#dfe8f3', 4, '#f6c85f'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 11.5, 3, 14, 5, 17, 7],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.16, 11.5, 0.44, 14, 0.72],
        'circle-stroke-color': '#071017',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.5],
      },
    })
  }

  if (!map.getLayer('vigo-selected-stop')) {
    map.addLayer({
      id: 'vigo-selected-stop', type: 'circle', source: 'vigo-stops',
      filter: ['==', ['get', 'selectedStop'], true],
      paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-stroke-color': '#2f80ed', 'circle-stroke-width': 3 },
    })
  }

  if (!map.getLayer('vigo-vehicle-halo')) {
    map.addLayer({
      id: 'vigo-vehicle-halo',
      type: 'circle',
      source: 'vigo-service-vehicles',
      filter: ['==', ['get', 'selectedRoute'], true],
      paint: {
        'circle-color': ['coalesce', ['get', 'routeColor'], '#6af3ee'] as ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.7, 13, 9.8],
        'circle-opacity': [
          'interpolate', ['linear'], ['zoom'],
          8, ['case', ['==', ['get', 'source'], 'live'], 0.08, 0.035],
          12, ['case', ['==', ['get', 'source'], 'live'], 0.17, 0.08],
        ] as ExpressionSpecification,
        'circle-blur': 0.5,
      },
    })
  }

  if (!map.getLayer('vigo-routing-pin-halo')) {
    map.addLayer({
      id: 'vigo-routing-pin-halo',
      type: 'circle',
      source: 'vigo-routing-pins',
      paint: {
        'circle-color': [
          'case',
          ['==', ['get', 'zeroMinuteOrigin'], true],
          '#3550ff',
          ['==', ['get', 'pointKind'], 'waypoint'],
          '#f0b62e',
          ['==', ['get', 'pointKind'], 'destination'],
          '#9cbd23',
          '#13b8c7',
        ] as ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 7, 13, 11],
        'circle-opacity': 0.2,
        'circle-blur': 0.45,
      },
    })
  }

  if (!map.getLayer('vigo-routing-pins')) {
    map.addLayer({
      id: 'vigo-routing-pins',
      type: 'circle',
      source: 'vigo-routing-pins',
      paint: {
        'circle-color': [
          'case',
          ['==', ['get', 'zeroMinuteOrigin'], true],
          '#3550ff',
          ['==', ['get', 'pointKind'], 'waypoint'],
          '#f0b62e',
          ['==', ['get', 'pointKind'], 'destination'],
          '#9cbd23',
          '#13b8c7',
        ] as ExpressionSpecification,
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          7, ['case', ['==', ['get', 'zeroMinuteOrigin'], true], 5.5, 4.5],
          13, ['case', ['==', ['get', 'zeroMinuteOrigin'], true], 8, 6.5],
        ] as ExpressionSpecification,
        'circle-stroke-color': '#f8fbff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 7, 1.5, 13, 2.5],
        'circle-opacity': 1,
      },
    })
  }

  if (!map.getLayer('vigo-vehicle-pairs')) map.addLayer({
    id: 'vigo-vehicle-pairs', type: 'line', source: 'vigo-service-vehicles', minzoom: 11,
    filter: ['==', ['get', 'pair'], true],
    paint: { 'line-color': ['case', ['==', ['get', 'gapSeverity'], 'critical'], '#dc2626', '#d97706'], 'line-width': 1.5, 'line-dasharray': [2, 3], 'line-opacity': .75 },
  })
  if (!map.getLayer(vehicleMarkerLayer.id)) map.addLayer(vehicleMarkerLayer)
  if (!map.getLayer(vehicleHeadingLayer.id)) map.addLayer(vehicleHeadingLayer)

  if (!map.getLayer('vigo-vehicle-indicator-label')) map.addLayer({
    id: 'vigo-vehicle-indicator-label', type: 'symbol', source: 'vigo-service-vehicles', minzoom: 12,
    filter: ['!=', ['get', 'indicatorLabel'], ''],
    layout: { 'text-field': ['get', 'indicatorLabel'], 'text-size': 11, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': false },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#111827', 'text-halo-width': 2 },
  })

  if (!map.getLayer('vigo-vehicle-labels')) {
    map.addLayer({
      id: 'vigo-vehicle-labels',
      type: 'symbol',
      source: 'vigo-service-vehicles',
      filter: ['==', ['get', 'selectedRoute'], true],
      layout: {
        'text-field': ['coalesce', ['get', 'routeShortName'], ['get', 'routeId'], ['get', 'label']],
        'text-size': ['interpolate', ['linear'], ['zoom'], 13.2, 7.2, 15.5, 9.6],
        'text-offset': [0, 1.16],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-padding': 5,
      },
      paint: {
        'text-color': '#ffffff',
        'text-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12.4,
          0,
          14.4,
          ['case', ['==', ['get', 'selectedRoute'], true], 0.62, 0],
          15.8,
          ['case', ['==', ['get', 'selectedRoute'], true], 0.7, 0],
        ] as ExpressionSpecification,
        'text-halo-color': '#03070b',
        'text-halo-width': 1.2,
      },
    })
  }

  for (const [id, radius, opacity] of [
    ['vigo-access-outer', 1600, 0.12],
    ['vigo-access-middle', 950, 0.16],
    ['vigo-access-inner', 420, 0.22],
  ] as const) {
    if (!map.getLayer(id)) {
      map.addLayer({
        id,
        type: 'circle',
        source: 'vigo-access',
        paint: {
          'circle-color': '#35d0a1',
          'circle-opacity': opacity,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, radius / 190, 13, radius / 36],
          'circle-stroke-color': '#35d0a1',
          'circle-stroke-opacity': 0.38,
          'circle-stroke-width': 1.2,
        },
      })
    }
  }
}

function baseCanvasColor(basemap: Basemap, appearance: Appearance) {
  if (appearance === 'light') {
    if (basemap === 'none') return '#f2f5f6'
    if (basemap === 'offline') return '#eef4ef'
    return '#e6eef5'
  }
  if (basemap === 'none') return '#050a0f'
  if (basemap === 'offline') return '#0b1412'
  return '#070c12'
}

function firstVigoLayerId(map: MapLibreMap) {
  return [
    'vigo-scenario-area',
    'vigo-coverage',
    'vigo-scenario-routes',
    'vigo-route-casing',
    'vigo-routes',
  ].find((layerId) => map.getLayer(layerId))
}

function localStreetLimitForZoom(zoom: number) {
  if (zoom <= 8) return 4_000
  if (zoom <= 10) return 8_000
  return 12_000
}

type RasterBasemapDefinition = {
  tiles: string[]
  attribution: string
}

const cartoSubdomains = ['a', 'b', 'c', 'd']
const rasterBasemaps: Partial<Record<Basemap, RasterBasemapDefinition>> = {
  minimal: {
    tiles: cartoSubdomains.map((subdomain) => `https://${subdomain}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  streets: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
  },
  dark: {
    tiles: cartoSubdomains.map((subdomain) => `https://${subdomain}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  terrain: {
    tiles: cartoSubdomains.map((subdomain) => `https://${subdomain}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
  },
}

function removeLocalStreetBasemap(map: MapLibreMap) {
  for (const layerId of [...localStreetLayerIds].reverse()) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  if (map.getSource('vigo-local-streets')) map.removeSource('vigo-local-streets')
}

function applyLocalStreetPaint(map: MapLibreMap, appearance: Appearance) {
  if (map.getLayer('vigo-local-streets-casing')) {
    map.setPaintProperty('vigo-local-streets-casing', 'line-color', appearance === 'light' ? '#ffffff' : '#07100e')
    map.setPaintProperty('vigo-local-streets-casing', 'line-opacity', appearance === 'light' ? 0.48 : 0.62)
  }
  if (map.getLayer('vigo-local-streets')) {
    map.setPaintProperty('vigo-local-streets', 'line-color', appearance === 'light' ? '#536a70' : '#b4d0c7')
    map.setPaintProperty('vigo-local-streets', 'line-opacity', appearance === 'light' ? 0.68 : 0.78)
  }
}

function ensureLocalStreetLayers(map: MapLibreMap, appearance: Appearance) {
  if (!map.getSource('vigo-local-streets')) return
  const before = firstVigoLayerId(map)
  if (!map.getLayer('vigo-local-streets-casing')) {
    map.addLayer({
      id: 'vigo-local-streets-casing',
      type: 'line',
      source: 'vigo-local-streets',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': appearance === 'light' ? '#ffffff' : '#07100e',
        'line-opacity': appearance === 'light' ? 0.48 : 0.62,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 12, 1.35, 16, 2.7],
      },
    }, before)
  }
  if (!map.getLayer('vigo-local-streets')) {
    map.addLayer({
      id: 'vigo-local-streets',
      type: 'line',
      source: 'vigo-local-streets',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': appearance === 'light' ? '#536a70' : '#b4d0c7',
        'line-opacity': appearance === 'light' ? 0.68 : 0.78,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 12, 0.82, 16, 1.8],
      },
    }, before)
  }
  applyLocalStreetPaint(map, appearance)
}

function syncBasemap(map: MapLibreMap, basemap: Basemap, appearance: Appearance) {
  if (map.getLayer('vigo-offline-bg')) {
    map.setPaintProperty('vigo-offline-bg', 'background-color', baseCanvasColor(basemap, appearance))
  }

  if (basemap === 'none' || basemap === 'offline') {
    if (map.getLayer('osm')) map.removeLayer('osm')
    if (map.getSource('osm')) map.removeSource('osm')
    if (basemap === 'none') removeLocalStreetBasemap(map)
    else applyLocalStreetPaint(map, appearance)
    return
  }

  removeLocalStreetBasemap(map)
  const definition = rasterBasemaps[basemap]
  if (!definition) return
  const currentRasterSource = map.getStyle().sources.osm as { tiles?: string[] } | undefined
  if (currentRasterSource?.tiles?.[0] !== definition.tiles[0]) {
    if (map.getLayer('osm')) map.removeLayer('osm')
    if (map.getSource('osm')) map.removeSource('osm')
  }

  if (!map.getSource('osm')) {
    map.addSource('osm', {
      type: 'raster',
      tiles: definition.tiles,
      tileSize: 256,
      attribution: definition.attribution,
    })
  }

  if (!map.getLayer('osm')) {
    map.addLayer({
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
      },
    }, firstVigoLayerId(map))
  }

  map.setPaintProperty('osm', 'raster-opacity', 1)
  map.setPaintProperty('osm', 'raster-fade-duration', 0)
}

function applyLayerVisibility(
  map: MapLibreMap,
  layers: LayerState,
  options: { routingVisible?: boolean; reachResultVisible?: boolean; reachComparisonCount?: number } = {},
) {
  setVisibility(map, routeLayerIds, layers.routes)
  setVisibility(map, segmentLayerIds, layers.segments)
  setVisibility(map, stopLayerIds, layers.stops)
  setVisibility(map, transferLayerIds, layers.transfers)
  setVisibility(map, coverageLayerIds, layers.coverage)
  setVisibility(map, scenarioLayerIds, layers.scenario)
  setVisibility(map, accessLayerIds, layers.access)
  setVisibility(map, vehicleLayerIds, layers.routes)
  setVisibility(map, routingLayerIds, options.routingVisible ?? true)
  setVisibility(map, reachResultLayerIds, options.reachResultVisible ?? false)
  setVisibility(map, existingScenarioComparisonLayerIds(map), false)
  setVisibility(
    map,
    reachComparisonLayerIds(options.reachComparisonCount ?? 0),
    options.reachResultVisible ?? false,
  )
}

function routeLensColor(networkLens: NetworkLens): ExpressionSpecification {
  if (networkLens === 'shape') {
    return [
      'match',
      ['get', 'geometryConfidence'],
      'trusted',
      '#35d0a1',
      'split',
      '#ffb86b',
      'inferred',
      '#ffd166',
      '#9fb0c4',
    ] as ExpressionSpecification
  }

  if (networkLens === 'service') {
    return [
      'case',
      ['>', ['get', 'headwayMinutes'], 30],
      '#ff735c',
      ['<', ['get', 'spanHours'], 14],
      '#ffd166',
      ['>', ['get', 'headwayMinutes'], 15],
      '#8eeaf3',
      '#35d0a1',
    ] as ExpressionSpecification
  }

  if (networkLens === 'transfer') {
    return [
      'case',
      ['>=', ['get', 'stopCount'], 35],
      '#6da8ff',
      ['>=', ['get', 'tripCount'], 250],
      '#8eeaf3',
      '#7f8fa3',
    ] as ExpressionSpecification
  }

  if (networkLens === 'risk') {
    return [
      'case',
      ['>', ['get', 'geometryFragmentCount'], 1],
      '#ff735c',
      ['!=', ['get', 'geometrySource'], 'shape'],
      '#ffd166',
      ['>', ['get', 'headwayMinutes'], 30],
      '#ff735c',
      ['<', ['get', 'spanHours'], 14],
      '#ffb86b',
      ['in', ['get', 'status'], ['literal', ['added', 'changed', 'removed']]],
      '#b58cff',
      '#6d7b8d',
    ] as ExpressionSpecification
  }

  return ['get', 'color'] as ExpressionSpecification
}

function routeLensOpacity(networkLens: NetworkLens): ExpressionSpecification {
  if (networkLens === 'shape') {
    return [
      'case',
      ['==', ['get', 'selectedPattern'], true],
      0.98,
      ['!=', ['get', 'geometrySource'], 'shape'],
      0.96,
      0.44,
    ] as ExpressionSpecification
  }

  if (networkLens === 'service') {
    return [
      'case',
      ['==', ['get', 'selectedPattern'], true],
      0.98,
      ['any', ['>', ['get', 'headwayMinutes'], 30], ['<', ['get', 'spanHours'], 14]],
      0.96,
      0.58,
    ] as ExpressionSpecification
  }

  if (networkLens === 'risk') {
    return [
      'case',
      ['==', ['get', 'selectedPattern'], true],
      0.98,
      ['any', ['!=', ['get', 'geometrySource'], 'shape'], ['>', ['get', 'headwayMinutes'], 30], ['<', ['get', 'spanHours'], 14]],
      0.96,
      0.36,
    ] as ExpressionSpecification
  }

  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    ['case', ['==', ['get', 'selectedPattern'], true], 0.98, networkLens === 'transfer' ? 0.3 : 0.4],
    10,
    ['case', ['==', ['get', 'selectedPattern'], true], 0.98, networkLens === 'transfer' ? 0.42 : 0.58],
    14,
    ['case', ['==', ['get', 'selectedPattern'], true], 0.98, networkLens === 'transfer' ? 0.56 : 0.74],
  ] as ExpressionSpecification
}

function applyNetworkLensPaint(map: MapLibreMap, networkLens: NetworkLens) {
  const lineColor = routeLensColor(networkLens)
  const lineOpacity = routeLensOpacity(networkLens)
  const transferOpacity = networkLens === 'transfer' ? 0.78 : networkLens === 'risk' ? 0.28 : 0.46
  const stopOpacity = ['interpolate', ['linear'], ['zoom'], 9, 0.5, 12, 0.85, 14, 1]
  // Schematic stop-to-stop geometry is still a route. Keep it visible in
  // every lens instead of silently dropping services without shapes.txt.
  const routeFilter: FilterSpecification | null = null

  if (map.getLayer('vigo-routes')) {
    map.setFilter('vigo-routes', routeFilter)
    map.setPaintProperty('vigo-routes', 'line-color', lineColor)
    map.setPaintProperty('vigo-routes', 'line-opacity', lineOpacity)
  }
  if (map.getLayer('vigo-selected-route')) {
    map.setPaintProperty('vigo-selected-route', 'line-color', lineColor)
  }
  if (map.getLayer('vigo-route-casing')) {
    map.setFilter('vigo-route-casing', routeFilter)
    map.setPaintProperty('vigo-route-casing', 'line-opacity', networkLens === 'network' ? ['case', ['==', ['get', 'selectedPattern'], true], 0.72, 0.24] : ['case', ['==', ['get', 'selectedPattern'], true], 0.78, 0.32])
  }
  if (map.getLayer('vigo-transfer-stops')) {
    map.setPaintProperty('vigo-transfer-stops', 'circle-opacity', transferOpacity)
    map.setPaintProperty('vigo-transfer-stops', 'circle-radius', networkLens === 'transfer'
      ? ['interpolate', ['linear'], ['get', 'transferScore'], 0, 1.2, 100, 4.4]
      : ['interpolate', ['linear'], ['get', 'transferScore'], 0, 0.75, 100, 2.7])
  }
  if (map.getLayer('vigo-stops')) {
    map.setPaintProperty('vigo-stops', 'circle-opacity', stopOpacity as ExpressionSpecification)
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
  onNavigateVehicle,
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
      setMapSourceData(source(map, 'vigo-scenario-access-edges'), scenarioAccessEdgesGeoJson)
      setMapSourceData(source(map, 'vigo-service-edges'), serviceDecomposition?.featureCollection ?? emptyCollection)
      setMapSourceData(source(map, 'vigo-scenario-contours'), scenarioContoursGeoJson)
      setMapSourceData(source(map, 'vigo-reach-route'),
        reachResult?.scenario.routes ?? emptyCollection,
      )
      setMapSourceData(source(map, 'vigo-scenario-sketch'), scenarioSketchGeoJson)
      comparisonEntries.forEach((_entry, index) => {
        setMapSourceData(source(map, `vigo-scenario-comparison-${index}-area`), comparisonAreasGeoJson[index] ?? emptyCollection)
        setMapSourceData(source(map, `vigo-scenario-comparison-${index}-access-edges`), comparisonAccessEdgesGeoJson[index] ?? emptyCollection)
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
          {liveSelection.stopId && projectId ? <StopArrivalBoard onOpenTrip={onOpenTrip} key={`${projectId}/${liveSelection.stopId}`} projectId={projectId} stopId={liveSelection.stopId} /> : liveSelection.vehicleId && projectId ? <AgencyVehicleDetails key={`${projectId}/${liveSelection.vehicleSourceUrl}/${liveSelection.vehicleId}`} projectId={projectId} vehicleId={liveSelection.vehicleId} sourceUrl={liveSelection.vehicleSourceUrl} onNavigate={onNavigateVehicle} /> : <><span>{liveSelection.eyebrow}</span>
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
