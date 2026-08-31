import type { LngLat, StopMetric } from '../domain'
import { coordinateDistanceKm } from './geometry'

export function inferredRouteJumpThresholdKm(distancesKm: number[]) {
  const distances = distancesKm
    .filter((distance) => Number.isFinite(distance) && distance > 0)
    .sort((left, right) => left - right)
  if (!distances.length) return 4.5
  const typicalDistanceKm = distances[Math.floor((distances.length - 1) / 2)]
  return Math.max(4.5, Math.min(120, typicalDistanceKm * 3))
}

/**
 * Place one route label at the travelled midpoint of a ride instead of asking
 * the renderer to find space along the line. Line placement can choose a short
 * stop-to-shape connector and rotate an otherwise readable route name.
 */
export function routingLabelAnchor(coordinates: LngLat[], minimumLengthKm = 0.05): LngLat | null {
  const drawable = coordinates.filter((coordinate) => (
    coordinate.length === 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1])
    && coordinate[0] >= -180
    && coordinate[0] <= 180
    && coordinate[1] >= -90
    && coordinate[1] <= 90
  ))
  if (drawable.length < 2) return null

  const segmentLengths = drawable.slice(1).map((coordinate, index) => (
    coordinateDistanceKm(drawable[index], coordinate)
  ))
  const totalLengthKm = segmentLengths.reduce((sum, length) => sum + length, 0)
  if (totalLengthKm < minimumLengthKm) return null

  const targetDistanceKm = totalLengthKm / 2
  let travelledKm = 0
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLengthKm = segmentLengths[index]
    if (travelledKm + segmentLengthKm < targetDistanceKm) {
      travelledKm += segmentLengthKm
      continue
    }

    const progress = segmentLengthKm > 0
      ? Math.max(0, Math.min(1, (targetDistanceKm - travelledKm) / segmentLengthKm))
      : 0
    const from = drawable[index]
    const to = drawable[index + 1]
    return [
      from[0] + (to[0] - from[0]) * progress,
      from[1] + (to[1] - from[1]) * progress,
    ]
  }

  return drawable.at(-1) ?? null
}

function hasFiniteLngLat(stop: StopMetric) {
  return Number.isFinite(stop.lon) && Number.isFinite(stop.lat)
}

function evenlySampleStops(stops: StopMetric[], limit: number) {
  if (stops.length <= limit) return stops
  const sample: StopMetric[] = []
  for (let index = 0; index < limit; index += 1) {
    sample.push(stops[Math.floor(index * stops.length / limit)])
  }
  return sample
}

export function spatiallySampleStops(stops: StopMetric[], limit: number, retainedStopIds: ReadonlySet<string> = new Set()) {
  const boundedLimit = Math.max(0, Math.floor(limit))
  if (!boundedLimit) return []
  if (stops.length <= boundedLimit) return stops

  const retained = stops.filter((stop) => retainedStopIds.has(stop.id)).slice(0, boundedLimit)
  const retainedIds = new Set(retained.map((stop) => stop.id))
  const candidates = stops.filter((stop) => !retainedIds.has(stop.id))
  const positioned = candidates.filter(hasFiniteLngLat)
  if (!positioned.length) return [...retained, ...evenlySampleStops(candidates, boundedLimit - retained.length)]

  let south = Number.POSITIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  let west = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  for (const stop of positioned) {
    const latitude = Number(stop.lat)
    const longitude = Number(stop.lon)
    south = Math.min(south, latitude)
    north = Math.max(north, latitude)
    west = Math.min(west, longitude)
    east = Math.max(east, longitude)
  }
  const gridSide = Math.max(1, Math.ceil(Math.sqrt(boundedLimit - retained.length)))
  const cells = new Map<string, StopMetric[]>()

  for (const stop of positioned) {
    const row = Math.min(gridSide - 1, Math.floor((Number(stop.lat) - south) / Math.max(1e-9, north - south) * gridSide))
    const column = Math.min(gridSide - 1, Math.floor((Number(stop.lon) - west) / Math.max(1e-9, east - west) * gridSide))
    const key = `${row}:${column}`
    const cell = cells.get(key) ?? []
    cell.push(stop)
    cells.set(key, cell)
  }

  const orderedCells = [...cells.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([, cell]) => cell)
  const sampled = [...retained]
  let depth = 0
  while (sampled.length < boundedLimit) {
    let added = 0
    for (const cell of orderedCells) {
      const stop = cell[depth]
      if (!stop) continue
      sampled.push(stop)
      added += 1
      if (sampled.length >= boundedLimit) break
    }
    if (!added) break
    depth += 1
  }

  if (sampled.length < boundedLimit) {
    const sampledIds = new Set(sampled.map((stop) => stop.id))
    sampled.push(...evenlySampleStops(candidates.filter((stop) => !sampledIds.has(stop.id)), boundedLimit - sampled.length))
  }
  return sampled
}
