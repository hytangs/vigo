import type { RouteMetric } from '../domain'
import { formatScheduleClock } from '../scheduledVehicles'

export function routeGeometryLabel(source?: string) {
  if (source === 'shape') return 'GTFS shape'
  if (source === 'stop_sequence') return 'stop order'
  return 'GTFS geometry'
}

export function routeListLabel(route: RouteMetric) {
  const scopedName = route.longName?.split(' / ').map((part) => part.trim()).filter(Boolean).pop()
  return scopedName || routeGeometryLabel(route.geometrySource)
}

function normalizedLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function localRouteReference(route: RouteMetric) {
  const value = String(route.routeId || route.id)
  const storeScope = value.lastIndexOf('\u001f')
  if (storeScope >= 0) return value.slice(storeScope + 1)
  const feedScope = value.indexOf('::')
  return feedScope > 0 ? value.slice(feedScope + 2) : value
}

export function routeListLabels(routes: RouteMetric[]) {
  const entries = routes.map((route) => ({
    route,
    base: routeListLabel(route),
    shortKey: normalizedLabel(route.shortName || route.routeId || route.id),
  }))
  const detailCounts = new Map<string, number>()
  for (const entry of entries) {
    const key = `${entry.shortKey}\u0000${normalizedLabel(entry.base)}`
    detailCounts.set(key, (detailCounts.get(key) ?? 0) + 1)
  }
  return new Map(entries.map((entry) => {
    const key = `${entry.shortKey}\u0000${normalizedLabel(entry.base)}`
    const reference = localRouteReference(entry.route)
    const label = (detailCounts.get(key) ?? 0) > 1 && normalizedLabel(reference) !== normalizedLabel(entry.base)
      ? `${entry.base} · ${reference}`
      : entry.base
    return [entry.route.id, label]
  }))
}

export function routeModeLabel(routeType?: number) {
  if (routeType === undefined) return 'Transit service'
  const labels: Record<number, string> = {
    0: 'Tram', 1: 'Metro', 2: 'Rail', 3: 'Bus', 4: 'Ferry', 5: 'Cable tram',
    6: 'Gondola', 7: 'Funicular', 11: 'Trolleybus', 12: 'Monorail',
  }
  if (labels[routeType]) return labels[routeType]
  if (routeType >= 100 && routeType < 200) return 'Rail'
  if (routeType >= 400 && routeType < 500) return 'Metro'
  if (routeType >= 700 && routeType < 800) return 'Bus'
  if (routeType >= 1000 && routeType < 1100) return 'Ferry'
  return `Transit mode ${routeType}`
}

export function routeSpanLabel(route: RouteMetric, loading: boolean) {
  if (loading) return 'Analyzing…'
  if (route.spanHours > 0) return `${route.spanHours.toFixed(1)} hours`
  if (route.firstDepartureMinutes !== undefined && route.lastArrivalMinutes !== undefined) {
    return `${formatScheduleClock(route.firstDepartureMinutes)}–${formatScheduleClock(route.lastArrivalMinutes)}`
  }
  return 'Schedule-based'
}

export function routeHeadwayLabel(route: RouteMetric, loading: boolean) {
  if (loading) return 'Analyzing…'
  if (route.headwayMinutes > 0) return `~${route.headwayMinutes} min`
  return route.tripCount <= 1 ? 'Single trip' : 'Trip-based'
}
