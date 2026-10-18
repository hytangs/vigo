import type { Map as MapLibreMap, VectorTileSource } from 'maplibre-gl'
import { localBasemapLayerIds } from './layers'

const sourceId = 'vigo-local-basemap'
const attribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · local PBF'

/**
 * The offline basemap is a vector tile pyramid rendered by the Rust kernel
 * from the City's street index. The street index build time versions the URL,
 * so MapLibre and the HTTP cache may keep every tile until the next import.
 */
export function localBasemapTileUrl(projectId: string, revision?: string) {
  const query = revision ? `?v=${encodeURIComponent(revision)}` : ''
  return `${window.location.origin}/api/projects/${encodeURIComponent(projectId)}/basemap-tiles/{z}/{x}/{y}.mvt${query}`
}

export function removeLocalBasemap(map: MapLibreMap) {
  for (const layerId of [...localBasemapLayerIds].reverse()) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId)
}

/** Point the local basemap at a City's tiles, reusing the source when possible. */
export function installLocalBasemap(map: MapLibreMap, projectId: string, revision?: string) {
  const tiles = [localBasemapTileUrl(projectId, revision)]
  const existing = map.getSource(sourceId) as VectorTileSource | undefined
  if (existing?.type === 'vector') {
    if (existing.tiles?.[0] !== tiles[0]) existing.setTiles(tiles)
    return
  }
  if (existing) removeLocalBasemap(map)
  // Generalized geometry exists up to z14; MapLibre overzooms beyond it.
  map.addSource(sourceId, { type: 'vector', tiles, minzoom: 0, maxzoom: 14, attribution })
}
