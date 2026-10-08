import { localBasemapRemovalPending, removeLocalBasemap } from './localBasemapSource'
export { removeLocalBasemap, setLocalBasemapData } from './localBasemapSource'

import { type ExpressionSpecification, type LayerSpecification, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'
import type { Appearance, Basemap } from '../domain'
import { darkBasemapLayer, darkMapLand, darkMapWater } from './darkBasemap'

export function baseCanvasColor(basemap: Basemap, appearance: Appearance) {
  if (basemap === 'dark') return darkMapLand
  if (appearance === 'light') {
    if (basemap === 'none') return '#f2f5f6'
    if (basemap === 'offline') return '#f4f2ec'
    return '#e6eef5'
  }
  if (basemap === 'none') return '#101512'
  if (basemap === 'offline') return darkMapLand
  return '#151b17'
}

function firstVigoLayerId(map: MapLibreMap) {
  return [
    'vigo-scenario-area',
    'vigo-coverage',
    'vigo-scenario-routes',
    'vigo-route-casing',
    'vigo-routes',
  ].find((layerId) => map.getLayer(layerId))
}

export function localBasemapFeatureLimit(zoom: number) {
  if (zoom < 9) return 2_000
  if (zoom < 13) return 3_500
  return 4_500
}

const vectorBasemapUrls: Partial<Record<Basemap, string>> = {
  minimal: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/fiord',
  terrain: 'https://tiles.openfreemap.org/styles/liberty',
}

type OnlineBasemapState = {
  basemap?: Basemap
  request?: AbortController
  pending?: Promise<void>
  layers: string[]
  sources: string[]
  sprites: string[]
}

const onlineBasemaps = new WeakMap<MapLibreMap, OnlineBasemapState>()
// Only three small style documents are retained; tiles remain in MapLibre's cache.
const vectorStyles = new Map<string, StyleSpecification>()

function onlineBasemapState(map: MapLibreMap) {
  let state = onlineBasemaps.get(map)
  if (!state) {
    state = { layers: [], sources: [], sprites: [] }
    onlineBasemaps.set(map, state)
    const current = state
    map.once('remove', () => {
      current.request?.abort()
      onlineBasemaps.delete(map)
    })
  }
  return state
}

function clearOnlineBasemap(map: MapLibreMap, state: OnlineBasemapState) {
  state.request?.abort()
  state.request = undefined
  state.pending = undefined
  state.basemap = undefined
  for (const id of state.layers.reverse()) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of state.sources) if (map.getSource(id)) map.removeSource(id)
  for (const id of state.sprites) map.removeSprite(id)
  state.layers = []
  state.sources = []
  state.sprites = []
}

function installVectorBasemap(map: MapLibreMap, state: OnlineBasemapState, style: StyleSpecification) {
  const sourceIds = new Map(Object.keys(style.sources).map(id => [id, id === 'openmaptiles' ? 'osm' : `osm-${id}`]))
  // Keep local glyph rendering: provider fonts need not include VIGO's label fonts.
  if (typeof style.sprite === 'string') {
    // Keep the provider's expressions intact, including zoom-dependent icons.
    // VIGO's runtime images use their own vigo- names.
    map.addSprite('default', style.sprite)
    state.sprites.push('default')
  }
  for (const [id, source] of Object.entries(style.sources)) {
    const sourceId = sourceIds.get(id)!
    map.addSource(sourceId, source)
    state.sources.push(sourceId)
  }
  const before = firstVigoLayerId(map)
  for (const original of style.layers) {
    const layer = { ...(state.basemap === 'dark' ? darkBasemapLayer(original) : original), id: `vigo-basemap-${original.id}` }
    if ('source' in layer) layer.source = sourceIds.get(layer.source as string)!
    map.addLayer(layer, before)
    state.layers.push(layer.id)
  }
}

async function loadVectorBasemap(map: MapLibreMap, state: OnlineBasemapState, url: string, request: AbortController) {
  const timeout = setTimeout(() => request.abort(new Error('Background map request timed out')), 15_000)
  try {
    let style = vectorStyles.get(url)
    if (!style) {
      const response = await fetch(url, { signal: request.signal, credentials: 'omit' })
      if (!response.ok) throw new Error(`Background map returned HTTP ${response.status}`)
      style = await response.json() as StyleSpecification
      if (style.version !== 8 || !style.sources?.openmaptiles || !Array.isArray(style.layers)) {
        throw new Error('Invalid background map style')
      }
      vectorStyles.set(url, style)
    }
    // A late response must not restore an old background or touch a disposed map.
    if (request.signal.aborted || state.request !== request) return
    installVectorBasemap(map, state, style)
  } catch (error) {
    if (state.request !== request || !onlineBasemaps.has(map)) return
    clearOnlineBasemap(map, state)
    map.fire('error', { sourceId: 'osm', error: error instanceof Error ? error : new Error(String(error)) })
  } finally {
    clearTimeout(timeout)
  }
}

function roadWidth(scale: number): ExpressionSpecification {
  const width = (major: number, primary: number, secondary: number, tertiary: number): ExpressionSpecification =>
    ['match', ['get', 'roadClass'], ['motorway', 'trunk'], major * scale, 'primary', primary * scale, 'secondary', secondary * scale, tertiary * scale]
  return ['interpolate', ['linear'], ['zoom'], 5, width(0.7, 0.5, 0.4, 0.3), 10, width(2.2, 1.5, 1.0, 0.7), 14, width(4.6, 3.4, 2.6, 1.9), 18, width(10, 8, 6, 4.5)]
}

export function localBasemapLayers(appearance: Appearance): LayerSpecification[] {
  const light = appearance === 'light'
  const water = light ? '#acd0d8' : darkMapWater
  const shore = light ? '#91bbc5' : '#30463d'
  return [
    {
      id: 'vigo-local-water', type: 'fill', source: 'vigo-local-basemap',
      filter: ['in', ['get', 'kind'], ['literal', ['water', 'ocean']]],
      paint: { 'fill-color': water, 'fill-antialias': true },
    },
    {
      id: 'vigo-local-shore', type: 'line', source: 'vigo-local-basemap',
      filter: ['in', ['get', 'kind'], ['literal', ['water', 'coastline']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': shore, 'line-opacity': 0.6, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 15, 1] },
    },
    {
      id: 'vigo-local-rivers', type: 'line', source: 'vigo-local-basemap',
      filter: ['==', ['get', 'kind'], 'river'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': water, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 12, 1.8, 16, 5] },
    },
    {
      id: 'vigo-local-roads-casing',
      type: 'line',
      source: 'vigo-local-basemap',
      filter: ['==', ['get', 'kind'], 'road'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': light ? '#d0cdc3' : '#2c382f',
        'line-opacity': light ? 0.75 : 0.8,
        'line-width': roadWidth(1.45),
      },
    },
    {
      id: 'vigo-local-roads',
      type: 'line',
      source: 'vigo-local-basemap',
      filter: ['==', ['get', 'kind'], 'road'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': ['match', ['get', 'roadClass'], ['motorway', 'trunk'], light ? '#ebd8ab' : '#536053', 'primary', light ? '#fffdf5' : '#455346', light ? '#ffffff' : '#3c4b40'],
        'line-opacity': light ? 0.98 : 0.9,
        'line-width': roadWidth(1),
      },
    },
  ]
}

function applyLocalBasemapPaint(map: MapLibreMap, appearance: Appearance) {
  for (const layer of localBasemapLayers(appearance)) {
    if (!map.getLayer(layer.id)) continue
    for (const [property, value] of Object.entries(layer.paint ?? {})) {
      map.setPaintProperty(layer.id, property as Parameters<MapLibreMap['setPaintProperty']>[1], value)
    }
  }
}

export function ensureLocalBasemapLayers(map: MapLibreMap, appearance: Appearance) {
  if (!map.getSource('vigo-local-basemap') || localBasemapRemovalPending(map)) return
  const before = firstVigoLayerId(map)
  for (const layer of localBasemapLayers(appearance)) if (!map.getLayer(layer.id)) map.addLayer(layer, before)
}

export function syncBasemap(map: MapLibreMap, basemap: Basemap, appearance: Appearance) {
  if (map.getLayer('vigo-offline-bg')) {
    map.setPaintProperty('vigo-offline-bg', 'background-color', baseCanvasColor(basemap, appearance))
  }

  const state = onlineBasemapState(map)
  if (state.basemap !== basemap) clearOnlineBasemap(map, state)

  if (basemap === 'none' || basemap === 'offline') {
    if (basemap === 'none') removeLocalBasemap(map)
    else applyLocalBasemapPaint(map, appearance)
    return
  }

  removeLocalBasemap(map)
  if (state.basemap === basemap) return state.pending
  state.basemap = basemap
  const styleUrl = vectorBasemapUrls[basemap]
  if (styleUrl) {
    state.request = new AbortController()
    state.pending = loadVectorBasemap(map, state, styleUrl, state.request)
    return state.pending
  }

  map.addSource('osm', {
    type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  })
  state.sources.push('osm')
  map.addLayer({ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } }, firstVigoLayerId(map))
  state.layers.push('osm')
}
