import type { FeatureCollection as GeoJsonFeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import type { LngLat, Point, StopMetric } from '../domain'

export type FeatureCollection = GeoJsonFeatureCollection<Geometry, GeoJsonProperties>

const fallbackPreviewBounds = {
  west: -0.1,
  east: 0.1,
  south: -0.1,
  north: 0.1,
}

export const emptyCollection: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
}

export function pointToLngLat(point: Point): [number, number] {
  const lng = fallbackPreviewBounds.west + (point.x / 100) * (fallbackPreviewBounds.east - fallbackPreviewBounds.west)
  const lat = fallbackPreviewBounds.north - (point.y / 100) * (fallbackPreviewBounds.north - fallbackPreviewBounds.south)
  return [lng, lat]
}

export function stopLngLat(stop: StopMetric): [number, number] {
  if (typeof stop.lon === 'number' && typeof stop.lat === 'number') return [stop.lon, stop.lat]
  return pointToLngLat({ x: stop.x, y: stop.y })
}

export function isFiniteLngLat(coordinate: LngLat | undefined): coordinate is LngLat {
  return Boolean(
    coordinate &&
      Number.isFinite(coordinate[0]) &&
      Number.isFinite(coordinate[1]) &&
      coordinate[0] >= -180 &&
      coordinate[0] <= 180 &&
      coordinate[1] >= -90 &&
      coordinate[1] <= 90,
  )
}

export function lineGeometryCoordinates(geometry: Geometry): Array<[number, number]> {
  if (geometry.type === 'LineString') return geometry.coordinates as Array<[number, number]>
  if (geometry.type === 'MultiLineString') return (geometry.coordinates as Array<Array<[number, number]>>).flat()
  return []
}

export function mapColor(value: string | undefined, fallback: string) {
  const color = value?.trim()
  if (!color) return fallback
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color}`
  return fallback
}
