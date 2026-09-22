import { emptyCollection, isFiniteLngLat, mapColor, type FeatureCollection } from './featureGeometry'

import { routingLabelAnchor } from '../app/mapPresentation'
import type { MapPreview } from '../domain'
import type { RoutingPlan, RoutingPoint } from '../routingModel'
import { routingPinLabel } from '../routingPointSequence'
import { serviceKeyForRoute, serviceVehicleIsVisible, type ServiceVehicleFrame } from '../serviceVehicles'

function uniqueVehicleFeatureId(prefix: string, vehicleId: string, occurrences: Map<string, number>) {
  const occurrence = occurrences.get(vehicleId) ?? 0
  occurrences.set(vehicleId, occurrence + 1)
  return `${prefix}:${vehicleId}:${occurrence}`
}

export function serviceVehicleFeatures(frame: ServiceVehicleFrame, preview: MapPreview, selectedRouteId: string): FeatureCollection {
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
    for (const link of vehicle.bunchingLinks ?? []) features.push({
      type: 'Feature' as const, id: `pair:${vehicle.sourceUrl || ''}:${vehicle.id}:${link.id}`,
      geometry: { type: 'LineString' as const, coordinates: [link.coordinate, vehicle.coordinate] },
      properties: { pair: true, gapSeverity: link.severity, vehicleIndex },
    })
  }
  return { type: 'FeatureCollection', features }
}

export function routingLineFeatures(plan: RoutingPlan | null | undefined): FeatureCollection {
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

export function routingPinFeatures(
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
