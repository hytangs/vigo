import type { RoutingPoint } from './routingModel'

export const maxRoutingPointCount = 8

export function routingPointRoleLabel(index: number, total: number) {
  if (index <= 0) return 'Starting point'
  if (index >= total - 1) return 'Destination'
  return `Via stop ${index}`
}

export function routingPinLabel(index: number, total: number) {
  if (index <= 0) return 'FROM'
  if (index >= total - 1) return 'TO'
  return `VIA ${index}`
}

export function normalizeOrderedRoutingPoints(points: RoutingPoint[]) {
  return points.map((point, index) => (
    point.source === 'map'
      ? {
          coordinate: point.coordinate,
          label: routingPointRoleLabel(index, points.length),
          source: 'map' as const,
        }
      : point
  ))
}

export function appendRoutingPointSequence(points: RoutingPoint[], point: RoutingPoint) {
  if (points.length >= maxRoutingPointCount) return normalizeOrderedRoutingPoints(points)
  return normalizeOrderedRoutingPoints([...points, point])
}

export function insertRoutingPointBeforeDestination(points: RoutingPoint[], point: RoutingPoint) {
  if (points.length >= maxRoutingPointCount) return normalizeOrderedRoutingPoints(points)
  if (points.length < 2) return appendRoutingPointSequence(points, point)
  return normalizeOrderedRoutingPoints([...points.slice(0, -1), point, points.at(-1)!])
}
