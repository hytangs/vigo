import type { FilterSpecification, LayerSpecification, Map as MapLibreMap, VectorTileSource } from 'maplibre-gl'
import type { LngLat } from '../domain'

const sourceId = 'vigo-network'

/**
 * A City scope's transit network tiles (the whole City or one feed) at one
 * revision, with the extent the Network view frames.
 */
export type NetworkTiles = { scope: string; revision: string; bounds?: [LngLat, LngLat] | null; displayMode?: number; stopIds?: string[] }

/**
 * GeoJSON network layers drawn from the Rust kernel's vector tiles in the
 * Network view. Each twin copies its layer's current style, so paint is
 * defined once in layers.ts and lens changes apply to both.
 */
const tiledLayers = {
  routes: ['vigo-scenario-routes', 'vigo-route-casing', 'vigo-routes', 'vigo-selected-route'],
  stops: ['vigo-coverage', 'vigo-overview-stops', 'vigo-network-stops', 'vigo-transfer-stops', 'vigo-selected-stop'],
} as const

export function networkTileLayerId(layerId: string) {
  return `${layerId}-tiles`
}

/** Route and Analyze keep a quiet reference network under the query result. */
export const contextRouteLayerId = 'vigo-context-routes'

export const networkTileStopLayerIds = tiledLayers.stops.map(networkTileLayerId)
export const networkTileRouteLayerIds = tiledLayers.routes.map(networkTileLayerId)

const contextRouteLayer: LayerSpecification = {
  id: contextRouteLayerId,
  type: 'line',
  source: sourceId,
  'source-layer': 'routes',
  filter: ['==', ['get', 'featureId'], '__none__'],
  layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
  paint: {
    'line-color': ['get', 'color'],
    'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 12, 1.8, 16, 3.4],
    'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.42, 13, 0.3, 16, 0.22],
  },
}

/** Rail, tram and ferry orient a query; bus-only Cities fall back to frequent routes. */
export function contextRouteFilter(routes: ReadonlyArray<{ routeType?: number }>): FilterSpecification {
  return routes.some((route) => route.routeType !== undefined && route.routeType !== 3)
    ? ['all', ['has', 'routeType'], ['!=', ['get', 'routeType'], 3]]
    : ['==', ['get', 'frequencyClass'], 'high']
}

/** Tiles are immutable for a revision, so MapLibre and the HTTP cache keep them. */
export function networkTileUrl(projectId: string, tiles: NetworkTiles) {
  const query = new URLSearchParams({ scope: tiles.scope, v: tiles.revision })
  return `${window.location.origin}/api/projects/${encodeURIComponent(projectId)}/network-tiles/{z}/{x}/{y}.mvt?${query}`
}

export function removeNetworkTiles(map: MapLibreMap) {
  for (const layerId of [contextRouteLayerId, ...networkTileRouteLayerIds, ...networkTileStopLayerIds]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId)
}

/**
 * Point the network source at a City scope and create the tile layers beside
 * their GeoJSON twins. Call after ensureLayers so every twin exists.
 */
export function installNetworkTiles(map: MapLibreMap, projectId: string, tiles: NetworkTiles) {
  const url = networkTileUrl(projectId, tiles)
  const existing = map.getSource(sourceId) as VectorTileSource | undefined
  if (existing?.type === 'vector') {
    if (existing.tiles?.[0] !== url) existing.setTiles([url])
  } else {
    if (existing) removeNetworkTiles(map)
    // Routes are simplified per zoom up to z15; MapLibre overzooms beyond it.
    map.addSource(sourceId, { type: 'vector', tiles: [url], minzoom: 0, maxzoom: 15 })
  }
  const styleLayers = map.getStyle().layers ?? []
  for (const [sourceLayer, layerIds] of Object.entries(tiledLayers)) {
    for (const layerId of layerIds) {
      const twinId = networkTileLayerId(layerId)
      const layer = styleLayers.find((candidate) => candidate.id === layerId)
      if (map.getLayer(twinId) || !layer || !('source' in layer)) continue
      // Insert directly beneath the twin so both keep the same stacking.
      map.addLayer({ ...layer, id: twinId, source: sourceId, 'source-layer': sourceLayer } as LayerSpecification, layerId)
    }
  }
  if (!map.getLayer(contextRouteLayerId)) {
    map.addLayer(contextRouteLayer, map.getLayer('vigo-route-casing') ? 'vigo-route-casing' : undefined)
  }
}

/** Filter existing tiles in place; catalog previews deliberately omit full geometry. */
export function applyNetworkTileMode(map: MapLibreMap, mode?: number, stopIds: string[] = []) {
  for (const [kind, ids] of Object.entries(tiledLayers)) {
    for (const id of ids) {
      const target = networkTileLayerId(id)
      if (!map.getLayer(target)) continue
      const original = map.getFilter(id)
      const restriction: FilterSpecification = kind === 'routes'
        ? ['==', ['to-number', ['get', 'routeType'], -1], mode ?? -1]
        : ['in', ['get', 'stopId'], ['literal', stopIds]]
      map.setFilter(target, mode === undefined ? original ?? null : original ? ['all', original, restriction] as FilterSpecification : restriction)
    }
  }
}
