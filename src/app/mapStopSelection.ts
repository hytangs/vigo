import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl'

export const selectableStopLayers = ['vigo-overview-stops', 'vigo-network-stops', 'vigo-transfer-stops', 'vigo-stops', 'vigo-selected-stop']

/** Screen-space tolerance only. Keep the exact GTFS identity of the visible stop. */
export function renderedStopAtPoint(map: Pick<MapLibreMap, 'getLayer' | 'queryRenderedFeatures' | 'project'>, point: { x: number; y: number }, radius = 18): MapGeoJSONFeature | undefined {
  const layers = selectableStopLayers.filter(id => map.getLayer(id))
  if (!layers.length) return undefined
  const hits = map.queryRenderedFeatures([[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]], { layers })
  let nearest: { feature: MapGeoJSONFeature; distance: number } | undefined
  for (const feature of hits) {
    if (!feature.properties?.stopId || feature.geometry.type !== 'Point') continue
    const [lon, lat] = feature.geometry.coordinates
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    const projected = map.project([lon, lat])
    const distance = Math.hypot(projected.x - point.x, projected.y - point.y)
    if (distance <= radius && (!nearest || distance < nearest.distance)) nearest = { feature, distance }
  }
  return nearest?.feature
}
