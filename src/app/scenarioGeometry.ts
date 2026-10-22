import type { LngLat } from '../domain'
import { coordinateDistanceKm } from './geometry'

/** A drawn path split at its stops: one polyline and length per stop pair. */
export type ScenarioPathSegments = {
  geometry: LngLat[]
  segments: LngLat[][]
  distancesKm: number[]
}

const kmPerDegree = 111.32

function lineLengthKm(points: LngLat[]) {
  let total = 0
  for (let index = 1; index < points.length; index += 1) total += coordinateDistanceKm(points[index - 1], points[index])
  return total
}

/** Straight chords between stops. */
export function straightScenarioPath(stops: LngLat[]): ScenarioPathSegments {
  const segments = stops.slice(1).map((stop, index) => [stops[index], stop])
  return { geometry: [...stops], segments, distancesKm: segments.map(lineLengthKm) }
}

/**
 * A rail alignment: a centripetal Catmull-Rom curve through every stop. It
 * passes exactly through the stops, never loops or overshoots between close
 * stops, and bends gently where a road path would turn sharply. Distances are
 * measured along the curve, so run times follow the drawn track.
 */
export function smoothRailPath(stops: LngLat[]): ScenarioPathSegments {
  if (stops.length < 3) return straightScenarioPath(stops)
  // Work in a local plane so the curve bends evenly at any latitude.
  const latitude = stops.reduce((sum, stop) => sum + stop[1], 0) / stops.length
  const xScale = kmPerDegree * Math.max(0.05, Math.cos(latitude * Math.PI / 180))
  const plane = stops.map(([lon, lat]) => [lon * xScale, lat * kmPerDegree] as const)
  const toLngLat = ([x, y]: readonly [number, number]): LngLat => [x / xScale, y / kmPerDegree]
  // Mirror the end stops so the line leaves its terminals straight.
  const first = plane[0], second = plane[1], last = plane.at(-1)!, beforeLast = plane.at(-2)!
  const points = [
    [2 * first[0] - second[0], 2 * first[1] - second[1]] as const,
    ...plane,
    [2 * last[0] - beforeLast[0], 2 * last[1] - beforeLast[1]] as const,
  ]
  const knot = (a: readonly [number, number], b: readonly [number, number]) => Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5)
  const segments: LngLat[][] = []
  for (let index = 1; index < points.length - 2; index += 1) {
    const p0 = points[index - 1], p1 = points[index], p2 = points[index + 1], p3 = points[index + 2]
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3)
    // About one sample every 60 m, kept between 4 and 48 per segment.
    const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const samples = Math.max(4, Math.min(48, Math.ceil(chord / 0.06)))
    const segment: LngLat[] = [stops[index - 1]]
    for (let step = 1; step < samples; step += 1) {
      const t = t1 + (t2 - t1) * step / samples
      const mix = (a: readonly [number, number], b: readonly [number, number], ta: number, tb: number) => {
        const w = (t - ta) / (tb - ta)
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w] as const
      }
      const a1 = mix(p0, p1, 0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3)
      const b1 = mix(a1, a2, 0, t2), b2 = mix(a2, a3, t1, t3)
      segment.push(toLngLat(mix(b1, b2, t1, t2)))
    }
    segment.push(stops[index])
    segments.push(segment)
  }
  const geometry = segments.flatMap((segment, index) => index ? segment.slice(1) : segment)
  return { geometry, segments, distancesKm: segments.map(lineLengthKm) }
}

/** A Flex zone outline as a closed GeoJSON ring. */
export function flexZoneRing(vertices: LngLat[]): LngLat[] {
  if (vertices.length < 3) return []
  return [...vertices, vertices[0]]
}

/** The zone's area, in square kilometres. */
export function flexZoneAreaKm2(vertices: LngLat[]) {
  if (vertices.length < 3) return 0
  const latitude = vertices.reduce((sum, vertex) => sum + vertex[1], 0) / vertices.length
  const xScale = kmPerDegree * Math.cos(latitude * Math.PI / 180)
  let twiceArea = 0
  for (let index = 0; index < vertices.length; index += 1) {
    const [x1, y1] = vertices[index], [x2, y2] = vertices[(index + 1) % vertices.length]
    twiceArea += x1 * xScale * y2 * kmPerDegree - x2 * xScale * y1 * kmPerDegree
  }
  return Math.abs(twiceArea) / 2
}

/** True when two edges of the outline cross, which GTFS Flex zones may not do. */
export function flexZoneSelfIntersects(vertices: LngLat[]) {
  const count = vertices.length
  if (count < 4) return false
  const cross = (a: LngLat, b: LngLat, c: LngLat) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const intersects = (a: LngLat, b: LngLat, c: LngLat, d: LngLat) => (
    cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0
  )
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue
      if (intersects(vertices[i], vertices[(i + 1) % count], vertices[j], vertices[(j + 1) % count])) return true
    }
  }
  return false
}
