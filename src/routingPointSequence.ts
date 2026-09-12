import type { RoutingPoint } from './routingModel'

export const maxRoutingPointCount = 8

export function parseRoutingCoordinate(text: string): RoutingPoint | null {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(text)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { coordinate: [longitude, latitude], label: `${latitude}, ${longitude}`, source: 'map' }
}

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
