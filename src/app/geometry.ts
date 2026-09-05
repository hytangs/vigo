import type { LngLat } from '../domain'

const earthMeanRadiusKm = 6371.0088

export function toRadians(value: number) {
  return (value * Math.PI) / 180
}

export function toDegrees(value: number) {
  return (value * 180) / Math.PI
}

export function coordinateDistanceKm(left: LngLat, right: LngLat) {
  const dLat = toRadians(right[1] - left[1])
  const dLon = toRadians(right[0] - left[0])
  const leftLatitude = toRadians(left[1])
  const rightLatitude = toRadians(right[1])
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(dLon / 2) ** 2
  return earthMeanRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

function projectedSegmentPoint(
  start: LngLat,
  end: LngLat,
  point: LngLat,
) {
  const latitude = ((start[1] + end[1] + point[1]) / 3) * Math.PI / 180
  const scaleX = 111.32 * Math.cos(latitude)
  const scaleY = 111.32
  const endX = (end[0] - start[0]) * scaleX
  const endY = (end[1] - start[1]) * scaleY
  const pointX = (point[0] - start[0]) * scaleX
  const pointY = (point[1] - start[1]) * scaleY
  const denominator = endX * endX + endY * endY
  const progress = denominator > 0
    ? Math.max(0, Math.min(1, (pointX * endX + pointY * endY) / denominator))
    : 0
  const deltaX = pointX - endX * progress
  const deltaY = pointY - endY * progress
  return { progress, distanceSquared: deltaX * deltaX + deltaY * deltaY }
}

function polylineMeasureAt(coordinates: LngLat[], point: LngLat) {
  let cumulativeKm = 0
  let bestDistanceSquared = Number.POSITIVE_INFINITY
  let bestMeasureKm = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1]
    const end = coordinates[index]
    const segmentKm = coordinateDistanceKm(start, end)
    const projection = projectedSegmentPoint(start, end, point)
    if (projection.distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = projection.distanceSquared
      bestMeasureKm = cumulativeKm + segmentKm * projection.progress
    }
    cumulativeKm += segmentKm
  }
  return bestMeasureKm
}

/**
 * Measures two points along a published route shape. This is deliberately
 * separate from coordinateDistanceKm: scenario timing should follow the
 * source shape when one exists, rather than turning every bend into a chord.
 */
export function polylineDistanceKm(coordinates: LngLat[] | undefined, left: LngLat, right: LngLat) {
  if (!coordinates || coordinates.length < 2) return coordinateDistanceKm(left, right)
  return Math.abs(polylineMeasureAt(coordinates, left) - polylineMeasureAt(coordinates, right))
}

/** Splice one ordered stop interval while retaining the branch's other shape vertices. */
export function splicePolylineInterval(
  coordinates: LngLat[], points: LngLat[], fromIndex: number, toIndex: number, replacement: LngLat[],
) {
  if (coordinates.length < 2 || replacement.length < 2) return undefined
  const anchors: Array<{ progress: number; point: LngLat }> = []
  let minimum = 0
  for (const point of points) {
    let best: { progress: number; point: LngLat; distance: number } | undefined
    for (let segment = Math.floor(minimum); segment < coordinates.length - 1; segment += 1) {
      const start = coordinates[segment], end = coordinates[segment + 1]
      const projection = projectedSegmentPoint(start, end, point)
      const progress = segment + projection.progress
      if (progress < minimum) continue
      if (!best || projection.distanceSquared < best.distance) {
        best = { progress, distance: projection.distanceSquared,
          point: [start[0] + (end[0] - start[0]) * projection.progress, start[1] + (end[1] - start[1]) * projection.progress] }
      }
    }
    if (!best) return undefined
    anchors.push(best)
    minimum = best.progress
  }
  const from = anchors[fromIndex], to = anchors[toIndex]
  if (!from || !to || to.progress <= from.progress) return undefined
  const joined = [
    ...coordinates.slice(0, Math.floor(from.progress) + 1), from.point,
    ...replacement, to.point, ...coordinates.slice(Math.floor(to.progress) + 1),
  ]
  return joined.filter((point, index) => index === 0 || point[0] !== joined[index - 1][0] || point[1] !== joined[index - 1][1])
}
