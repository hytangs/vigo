import { localBasemapRemovalPending, removeLocalBasemap } from './localBasemapSource'
export { removeLocalBasemap, setLocalBasemapData } from './localBasemapSource'

import { type ExpressionSpecification, type LayerSpecification, type Map as MapLibreMap } from 'maplibre-gl'
import type { Appearance, Basemap } from '../domain'

export function baseCanvasColor(basemap: Basemap, appearance: Appearance) {
  if (appearance === 'light') {
    if (basemap === 'none') return '#f2f5f6'
    if (basemap === 'offline') return '#f4f2ec'
    return '#e6eef5'
  }
  if (basemap === 'none') return '#050a0f'
  if (basemap === 'offline') return '#19262d'
  return '#070c12'
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

type RasterBasemapDefinition = {
  tiles: string[]
  attribution: string
}

const cartoSubdomains = ['a', 'b', 'c', 'd']

const rasterBasemaps: Partial<Record<Basemap, RasterBasemapDefinition>> = {
  minimal: {
    tiles: cartoSubdomains.map((subdomain) => `https://${subdomain}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  streets: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
  },
  dark: {
    tiles: cartoSubdomains.map((subdomain) => `https://${subdomain}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  terrain: {
    tiles: cartoSubdomains.map((subdomain) => `https://${subdomain}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
  },
}

function roadWidth(scale: number): ExpressionSpecification {
  const width = (major: number, primary: number, secondary: number, tertiary: number): ExpressionSpecification =>
    ['match', ['get', 'roadClass'], ['motorway', 'trunk'], major * scale, 'primary', primary * scale, 'secondary', secondary * scale, tertiary * scale]
  return ['interpolate', ['linear'], ['zoom'], 5, width(0.7, 0.5, 0.4, 0.3), 10, width(2.2, 1.5, 1.0, 0.7), 14, width(4.6, 3.4, 2.6, 1.9), 18, width(10, 8, 6, 4.5)]
}

export function localBasemapLayers(appearance: Appearance): LayerSpecification[] {
  const light = appearance === 'light'
  const water = light ? '#acd0d8' : '#103b4a'
  const shore = light ? '#91bbc5' : '#28515d'
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
        'line-color': light ? '#d0cdc3' : '#111d23',
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
        'line-color': ['match', ['get', 'roadClass'], ['motorway', 'trunk'], light ? '#ebd8ab' : '#8a8d7c', 'primary', light ? '#fffdf5' : '#65767a', light ? '#ffffff' : '#475c65'],
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

  if (basemap === 'none' || basemap === 'offline') {
    if (map.getLayer('osm')) map.removeLayer('osm')
    if (map.getSource('osm')) map.removeSource('osm')
    if (basemap === 'none') removeLocalBasemap(map)
    else applyLocalBasemapPaint(map, appearance)
    return
  }

  removeLocalBasemap(map)
  const definition = rasterBasemaps[basemap]
  if (!definition) return
  const currentRasterSource = map.getStyle().sources.osm as { tiles?: string[] } | undefined
  if (currentRasterSource?.tiles?.[0] !== definition.tiles[0]) {
    if (map.getLayer('osm')) map.removeLayer('osm')
    if (map.getSource('osm')) map.removeSource('osm')
  }

  if (!map.getSource('osm')) {
    map.addSource('osm', {
      type: 'raster',
      tiles: definition.tiles,
      tileSize: 256,
      attribution: definition.attribution,
    })
  }

  if (!map.getLayer('osm')) {
    map.addLayer({
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
      },
    }, firstVigoLayerId(map))
  }

  map.setPaintProperty('osm', 'raster-opacity', 1)
  map.setPaintProperty('osm', 'raster-fade-duration', 0)
}
