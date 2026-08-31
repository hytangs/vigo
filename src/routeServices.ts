import type { RouteMetric } from './domain'

export type RouteRenderMode = 'service' | 'pattern'

function routeFeedScope(route: RouteMetric) {
  const splitIndex = route.id.indexOf('::')
  return splitIndex > 0 ? route.id.slice(0, splitIndex) : ''
}

export function routeServiceId(route: RouteMetric) {
  return String(route.routeId || route.id).trim()
}

export function scopedRouteServiceKey(route: RouteMetric) {
  return `${routeFeedScope(route)}:${routeServiceId(route)}`
}
