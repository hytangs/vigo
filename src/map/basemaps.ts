import { localStreetLayerIds } from './layers'

import { type Map as MapLibreMap } from 'maplibre-gl'
import type { Appearance, Basemap } from '../domain'

export function baseCanvasColor(basemap: Basemap, appearance: Appearance) {
  if (appearance === 'light') {
    if (basemap === 'none') return '#f2f5f6'
    if (basemap === 'offline') return '#eef4ef'
    return '#e6eef5'
  }
  if (basemap === 'none') return '#050a0f'
  if (basemap === 'offline') return '#0b1412'
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

export function localStreetLimitForZoom(zoom: number) {
  if (zoom <= 8) return 4_000
  if (zoom <= 10) return 8_000
  return 12_000
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

export function removeLocalStreetBasemap(map: MapLibreMap) {
  for (const layerId of [...localStreetLayerIds].reverse()) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  if (map.getSource('vigo-local-streets')) map.removeSource('vigo-local-streets')
}

function applyLocalStreetPaint(map: MapLibreMap, appearance: Appearance) {
  if (map.getLayer('vigo-local-streets-casing')) {
    map.setPaintProperty('vigo-local-streets-casing', 'line-color', appearance === 'light' ? '#ffffff' : '#07100e')
    map.setPaintProperty('vigo-local-streets-casing', 'line-opacity', appearance === 'light' ? 0.48 : 0.62)
  }
  if (map.getLayer('vigo-local-streets')) {
    map.setPaintProperty('vigo-local-streets', 'line-color', appearance === 'light' ? '#536a70' : '#b4d0c7')
    map.setPaintProperty('vigo-local-streets', 'line-opacity', appearance === 'light' ? 0.68 : 0.78)
  }
}

export function ensureLocalStreetLayers(map: MapLibreMap, appearance: Appearance) {
  if (!map.getSource('vigo-local-streets')) return
  const before = firstVigoLayerId(map)
  if (!map.getLayer('vigo-local-streets-casing')) {
    map.addLayer({
      id: 'vigo-local-streets-casing',
      type: 'line',
      source: 'vigo-local-streets',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': appearance === 'light' ? '#ffffff' : '#07100e',
        'line-opacity': appearance === 'light' ? 0.48 : 0.62,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 12, 1.35, 16, 2.7],
      },
    }, before)
  }
  if (!map.getLayer('vigo-local-streets')) {
    map.addLayer({
      id: 'vigo-local-streets',
      type: 'line',
      source: 'vigo-local-streets',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': appearance === 'light' ? '#536a70' : '#b4d0c7',
        'line-opacity': appearance === 'light' ? 0.68 : 0.78,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 12, 0.82, 16, 1.8],
      },
    }, before)
  }
  applyLocalStreetPaint(map, appearance)
}

export function syncBasemap(map: MapLibreMap, basemap: Basemap, appearance: Appearance) {
  if (map.getLayer('vigo-offline-bg')) {
    map.setPaintProperty('vigo-offline-bg', 'background-color', baseCanvasColor(basemap, appearance))
  }

  if (basemap === 'none' || basemap === 'offline') {
    if (map.getLayer('osm')) map.removeLayer('osm')
    if (map.getSource('osm')) map.removeSource('osm')
    if (basemap === 'none') removeLocalStreetBasemap(map)
    else applyLocalStreetPaint(map, appearance)
    return
  }

  removeLocalStreetBasemap(map)
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
