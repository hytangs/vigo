import { emptyCollection, isFiniteLngLat, pointToLngLat, stopLngLat, type FeatureCollection } from './featureGeometry'

import { cityPublicRouteKey } from '../app/cityPreview'
import { coordinateDistanceKm } from '../app/geometry'
import { inferredRouteJumpThresholdKm, routeStopPairCoordinates } from '../app/mapPresentation'
import { findNetworkStop } from '../app/networkSelection'
import type { LngLat, MapPreview, RouteMetric, StopMetric } from '../domain'
import { type NetworkPerformanceProfile } from '../networkPerformance'

function routeCoordinates(route: RouteMetric, stopsById: Map<string, StopMetric>): Array<[number, number]> {
  if (route.coordinates && route.coordinates.length >= 2) return route.coordinates

  const fromStops = route.stopIds
    .map((stopId) => stopsById.get(stopId))
    .filter((stop): stop is StopMetric => Boolean(stop))
    .map(stopLngLat)

  if (fromStops.length >= 2) return fromStops
  return route.points.map(pointToLngLat)
}

export function directionLabel(directionId?: string) {
  return directionId !== undefined && directionId !== '' ? `Direction ${directionId}` : 'Direction unspecified'
}

export function routeDisplayName(shortName: string, longName?: string) {
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

export function routeFeatures(
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

export function segmentFeatures(preview: MapPreview, performanceProfile: NetworkPerformanceProfile): FeatureCollection {
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

export function stopFeatures(
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

export function accessFeatures(preview: MapPreview, selectedStopId: string): FeatureCollection {
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
