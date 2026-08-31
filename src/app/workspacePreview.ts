import type { MapPreview, RouteMetric } from '../domain'
import { spatiallySampleStops } from './mapPresentation'

const workspacePreviewLimits = {
  maxStops: 16_000,
} as const

export function workspacePublicRouteKey(route: RouteMetric) {
  return route.id || route.patternId || route.routeId || route.shortName
}

export function buildWorkspacePreviewLod(
  preview: MapPreview,
  selectedRouteId = '',
  limits = workspacePreviewLimits,
): MapPreview {
  // Published route geometry is source evidence. Keep the original coordinate
  // sequence; only the independently rendered stop set is spatially sampled.
  const routes = preview.routes
  const selectedRoute = routes.find((route) => route.id === selectedRouteId)
  const retainedStopIds = new Set(selectedRoute?.stopIds ?? [])

  return {
    ...preview,
    routes,
    stops: spatiallySampleStops(preview.stops, limits.maxStops, retainedStopIds),
    stopPairs: [],
  }
}
