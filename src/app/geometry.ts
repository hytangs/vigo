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
  minimumProgress = 0,
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
    ? Math.max(minimumProgress, Math.min(1, (pointX * endX + pointY * endY) / denominator))
    : minimumProgress
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

export type PolylineAnchor = { progress: number; point: LngLat; measureKm: number }

/** Align the whole ordered stop sequence; a locally nearer later loop must not steal an earlier visit. */
export function orderedPolylineAnchors(coordinates: LngLat[], points: LngLat[]) {
  if (coordinates.length < 2) return undefined
  if (!points.length) return []
  const segmentCount = coordinates.length - 1
  const cumulativeKm = [0]
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulativeKm.push(cumulativeKm[index - 1] + coordinateDistanceKm(coordinates[index - 1], coordinates[index]))
  }
  let previousCosts = new Float64Array(segmentCount)
  let previousProgress = new Float64Array(segmentCount)
  const paths: Int32Array[] = []
  const better = (cost: number, progress: number, otherCost: number, otherProgress: number) => (
    cost < otherCost - 1e-12 || (Math.abs(cost - otherCost) <= 1e-12 && progress < otherProgress)
  )
  for (let stopIndex = 0; stopIndex < points.length; stopIndex += 1) {
    const costs = new Float64Array(segmentCount), progress = new Float64Array(segmentCount)
    const parents = new Int32Array(segmentCount).fill(-1)
    let prefix = -1
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const start = coordinates[segment], end = coordinates[segment + 1]
      const projection = projectedSegmentPoint(start, end, points[stopIndex])
      let bestCost = stopIndex === 0 ? projection.distanceSquared : Number.POSITIVE_INFINITY
      let bestProgress = segment + projection.progress
      let parent = -1
      if (stopIndex > 0) {
        if (segment > 0 && (prefix < 0 || better(previousCosts[segment - 1], previousProgress[segment - 1],
          previousCosts[prefix], previousProgress[prefix]))) prefix = segment - 1
        if (prefix >= 0) {
          bestCost = previousCosts[prefix] + projection.distanceSquared
          parent = prefix
        }
        // Adjacent platforms may project backwards within one shape segment.
        // Retain a clamped candidate so their ordered visits can share a measure.
        const clamped = projectedSegmentPoint(start, end, points[stopIndex], previousProgress[segment] - segment)
        const clampedProgress = segment + clamped.progress
        const clampedCost = previousCosts[segment] + clamped.distanceSquared
        if (better(clampedCost, clampedProgress, bestCost, bestProgress)) {
          bestCost = clampedCost
          bestProgress = clampedProgress
          parent = segment
        }
      }
      costs[segment] = bestCost
      progress[segment] = bestProgress
      parents[segment] = parent
    }
    paths.push(parents)
    previousCosts = costs
    previousProgress = progress
  }
  let segment = 0
  for (let index = 1; index < segmentCount; index += 1) {
    if (better(previousCosts[index], previousProgress[index], previousCosts[segment], previousProgress[segment])) segment = index
  }
  const selectedSegments = new Int32Array(points.length)
  for (let stopIndex = points.length - 1; stopIndex >= 0; stopIndex -= 1) {
    selectedSegments[stopIndex] = segment
    segment = paths[stopIndex][segment]
  }
  const anchors: PolylineAnchor[] = []
  for (let stopIndex = 0; stopIndex < points.length; stopIndex += 1) {
    const segment = selectedSegments[stopIndex]
    const start = coordinates[segment], end = coordinates[segment + 1]
    const minimum = stopIndex > 0 && selectedSegments[stopIndex - 1] === segment ? anchors[stopIndex - 1].progress - segment : 0
    const ratio = projectedSegmentPoint(start, end, points[stopIndex], minimum).progress
    anchors.push({
      progress: segment + ratio,
      point: [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio],
      measureKm: cumulativeKm[segment] + (cumulativeKm[segment + 1] - cumulativeKm[segment]) * ratio,
    })
  }
  return anchors
}

/** Apply multiple gaps against one immutable alignment of the published shape. */
export function splicePolylineIntervals(
  coordinates: LngLat[], anchors: PolylineAnchor[],
  intervals: Array<{ fromIndex: number; toIndex: number; coordinates: LngLat[] }>,
) {
  const joined: LngLat[] = []
  let previous = -1
  for (const interval of [...intervals].sort((left, right) => left.fromIndex - right.fromIndex)) {
    const from = anchors[interval.fromIndex], to = anchors[interval.toIndex]
    if (!from || !to || from.progress < previous || to.progress <= from.progress || interval.coordinates.length < 2) return undefined
    joined.push(...coordinates.slice(Math.floor(previous) + 1, Math.floor(from.progress) + 1), from.point,
      ...interval.coordinates, to.point)
    previous = to.progress
  }
  joined.push(...coordinates.slice(Math.floor(previous) + 1))
  return joined.filter((point, index) => index === 0 || point[0] !== joined[index - 1][0] || point[1] !== joined[index - 1][1])
}
