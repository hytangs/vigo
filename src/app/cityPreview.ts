import type { MapPreview, RouteMetric } from '../domain'
import { spatiallySampleStops } from './mapPresentation'

const cityPreviewLimits = {
  maxStops: 16_000,
} as const

export function cityPublicRouteKey(route: RouteMetric) {
  return route.id || route.patternId || route.routeId || route.shortName
}

export function buildCityPreviewLod(
  preview: MapPreview,
  selectedRouteId = '',
  limits = cityPreviewLimits,
  selectedStopId = '',
): MapPreview {
  // Keep the original coordinates from published route geometry
  // sequence; only the independently rendered stop set is spatially sampled.
  const routes = preview.routes
  const selectedRoute = routes.find((route) => route.id === selectedRouteId)
  const retainedStopIds = new Set([...(selectedRoute?.stopIds ?? []), selectedStopId].filter(Boolean))

  return {
    ...preview,
    routes,
    stops: spatiallySampleStops(preview.stops, limits.maxStops, retainedStopIds),
    stopPairs: [],
  }
}
