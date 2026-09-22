import { emptyCollection } from './featureGeometry'

import { type ExpressionSpecification, type FilterSpecification, type Map as MapLibreMap } from 'maplibre-gl'
import { ensureVehicleDirectionSprite, vehicleHeadingLayer, vehicleMarkerLayer } from '../app/mapDirections'
import type { LayerState, NetworkLens } from '../domain'
import { reachComparisonColor } from '../reach'

const routeLayerIds = ['vigo-route-casing', 'vigo-routes', 'vigo-selected-route']

const segmentLayerIds = ['vigo-segments-casing', 'vigo-segments', 'vigo-selected-segments']

export const stopLayerIds = ['vigo-overview-stops', 'vigo-network-stops', 'vigo-stops', 'vigo-selected-stop']

const transferLayerIds = ['vigo-transfer-stops']

const coverageLayerIds = ['vigo-coverage']

const scenarioLayerIds = ['vigo-scenario-routes']

const accessLayerIds = ['vigo-access-outer', 'vigo-access-middle', 'vigo-access-inner']

const vehicleLayerIds = ['vigo-vehicle-pairs', 'vigo-vehicle-indicator-label', 'vigo-vehicle-halo', 'vigo-vehicles', 'vigo-vehicle-headings', 'vigo-vehicle-labels']

const routingLayerIds = ['vigo-routing-walk-casing', 'vigo-routing-walk', 'vigo-routing-drive-casing', 'vigo-routing-drive', 'vigo-routing-ride-casing', 'vigo-routing-ride', 'vigo-routing-labels', 'vigo-routing-pin-halo', 'vigo-routing-pins']

export const reachResultLayerIds = [
  'vigo-scenario-area',
  'vigo-service-edges',
  'vigo-scenario-contours',
  'vigo-scenario-access-edges',
  'vigo-reach-route',
  'vigo-scenario-sketch-line',
  'vigo-scenario-sketch-hit',
  'vigo-scenario-sketch-stops',
  'vigo-scenario-sketch-labels',
]

export const localStreetLayerIds = ['vigo-local-streets-casing', 'vigo-local-streets']

export function reachComparisonLayerIds(count: number) {
  return Array.from({ length: count }, (_, index) => [
    `vigo-scenario-comparison-${index}-area`,
    `vigo-scenario-comparison-${index}-access-edges`,
    `vigo-scenario-comparison-${index}-contours`,
  ]).flat()
}

export function existingScenarioComparisonLayerIds(map: MapLibreMap) {
  return (map.getStyle().layers ?? [])
    .map((layer) => layer.id)
    .filter((layerId) => layerId.startsWith('vigo-scenario-comparison-'))
}

export function setVisibility(map: MapLibreMap, layerIds: string[], visible: boolean) {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
    }
  }
}

export function ensureLayers(map: MapLibreMap, comparisonCount = 0) {
  ensureVehicleDirectionSprite(map)
  if (!map.getSource('vigo-routes')) {
    map.addSource('vigo-routes', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-segments')) {
    map.addSource('vigo-segments', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-stops')) {
    map.addSource('vigo-stops', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-access')) {
    map.addSource('vigo-access', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-service-vehicles')) {
    map.addSource('vigo-service-vehicles', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-routing')) {
    map.addSource('vigo-routing', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-routing-pins')) {
    map.addSource('vigo-routing-pins', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-area')) {
    map.addSource('vigo-scenario-area', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-access-edges')) {
    map.addSource('vigo-scenario-access-edges', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-service-edges')) {
    map.addSource('vigo-service-edges', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-contours')) {
    map.addSource('vigo-scenario-contours', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-reach-route')) {
    map.addSource('vigo-reach-route', { type: 'geojson', data: emptyCollection })
  }
  if (!map.getSource('vigo-scenario-sketch')) {
    map.addSource('vigo-scenario-sketch', { type: 'geojson', data: emptyCollection })
  }
  for (let index = 0; index < comparisonCount; index += 1) {
    if (!map.getSource(`vigo-scenario-comparison-${index}-area`)) {
      map.addSource(`vigo-scenario-comparison-${index}-area`, { type: 'geojson', data: emptyCollection })
    }
    if (!map.getSource(`vigo-scenario-comparison-${index}-access-edges`)) {
      map.addSource(`vigo-scenario-comparison-${index}-access-edges`, { type: 'geojson', data: emptyCollection })
    }
    if (!map.getSource(`vigo-scenario-comparison-${index}-contours`)) {
      map.addSource(`vigo-scenario-comparison-${index}-contours`, { type: 'geojson', data: emptyCollection })
    }
  }

  if (!map.getLayer('vigo-scenario-area')) {
    map.addLayer({
      id: 'vigo-scenario-area',
      type: 'fill',
      source: 'vigo-scenario-area',
      paint: {
        'fill-color': ['get', 'color'] as ExpressionSpecification,
        'fill-opacity': 0.2,
        'fill-outline-color': ['get', 'color'] as ExpressionSpecification,
      },
    })
  }
  if (!map.getLayer('vigo-scenario-access-edges')) {
    map.addLayer({
      id: 'vigo-scenario-access-edges',
      type: 'line',
      source: 'vigo-scenario-access-edges',
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.75, 12, 1.45, 16, 2.8] as ExpressionSpecification,
        'line-opacity': 0.9,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer('vigo-service-edges')) {
    map.addLayer({
      id: 'vigo-service-edges',
      type: 'line',
      source: 'vigo-service-edges',
      paint: {
        'line-color': [
          'match',
          ['get', 'serviceIndicator'],
          0, '#ff6757',
          1, '#35d0a1',
          2, '#6da8ff',
          '#a6b4bf',
        ] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.1, 12, 3.8, 16, 6] as ExpressionSpecification,
        'line-opacity': 0.92,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer('vigo-scenario-contours')) {
    map.addLayer({
      id: 'vigo-scenario-contours',
      type: 'line',
      source: 'vigo-scenario-contours',
      paint: {
        'line-color': [
          'match',
          ['get', 'surface'],
          'scenario', '#35d0a1',
          '#6da8ff',
        ] as ExpressionSpecification,
        'line-width': 2,
        'line-opacity': 0.92,
      },
    })
  }
  if (!map.getLayer('vigo-reach-route')) {
    map.addLayer({
      id: 'vigo-reach-route',
      type: 'line',
      source: 'vigo-reach-route',
      paint: {
        'line-color': '#ffd166',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2, 13, 5] as ExpressionSpecification,
        'line-opacity': 0.94,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-line')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-line',
      type: 'line',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'line'],
      paint: {
        'line-color': '#ffd166',
        'line-width': 2.4,
        'line-dasharray': [1.4, 1.1],
      },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-hit')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-hit',
      type: 'circle',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: {
        'circle-radius': 11,
        'circle-color': '#ffffff',
        'circle-opacity': 0.01,
      },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-stops')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-stops',
      type: 'circle',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'editStatus'], 'baseline'], 3.5, 5] as ExpressionSpecification,
        'circle-color': [
          'match',
          ['get', 'editStatus'],
          'replaced', '#ff735c',
          'inserted', '#35d0a1',
          'added', '#35d0a1',
          '#ffffff',
        ] as ExpressionSpecification,
        'circle-stroke-color': '#071018',
        'circle-stroke-width': 1.5,
      },
    })
  }
  if (!map.getLayer('vigo-scenario-sketch-labels')) {
    map.addLayer({
      id: 'vigo-scenario-sketch-labels',
      type: 'symbol',
      source: 'vigo-scenario-sketch',
      filter: ['==', ['get', 'kind'], 'stop'],
      layout: {
        'text-field': ['get', 'sequenceLabel'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 13, 11] as ExpressionSpecification,
        'text-offset': [0, 1.25],
        'text-anchor': 'top',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': [
          'match',
          ['get', 'editStatus'],
          'replaced', '#ffb3a7',
          'inserted', '#a9f5d9',
          'added', '#a9f5d9',
          '#fff2bd',
        ] as ExpressionSpecification,
        'text-halo-color': '#071018',
        'text-halo-width': 1.4,
      },
    })
  }

  for (let index = 0; index < comparisonCount; index += 1) {
    const layerPrefix = `vigo-scenario-comparison-${index}`
    const color = reachComparisonColor(index)
    if (!map.getLayer(`${layerPrefix}-area`)) {
      map.addLayer({
        id: `${layerPrefix}-area`,
        type: 'fill',
        source: `${layerPrefix}-area`,
        paint: {
          'fill-color': ['get', 'color'] as ExpressionSpecification,
          'fill-opacity': 0.16,
          'fill-outline-color': ['get', 'color'] as ExpressionSpecification,
        },
      })
    }
    if (!map.getLayer(`${layerPrefix}-access-edges`)) {
      map.addLayer({
        id: `${layerPrefix}-access-edges`,
        type: 'line',
        source: `${layerPrefix}-access-edges`,
        paint: {
          'line-color': ['get', 'color'] as ExpressionSpecification,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 12, 1.3, 16, 2.5] as ExpressionSpecification,
          'line-opacity': 0.84,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })
    }
    if (!map.getLayer(`${layerPrefix}-contours`)) {
      map.addLayer({
        id: `${layerPrefix}-contours`,
        type: 'line',
        source: `${layerPrefix}-contours`,
        paint: {
          'line-color': color,
          'line-width': 2.4,
          'line-opacity': 0.96,
        },
      })
    }
  }

  if (!map.getLayer('vigo-coverage')) {
    map.addLayer({
      id: 'vigo-coverage',
      type: 'heatmap',
      source: 'vigo-stops',
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 0, 700, 1],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 13, 1.45],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 16, 13, 46],
        'heatmap-opacity': 0.64,
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0,
          'rgba(53,208,161,0)',
          0.22,
          'rgba(53,208,161,0.34)',
          0.58,
          'rgba(255,209,102,0.48)',
          1,
          'rgba(255,115,92,0.68)',
        ],
      },
    })
  }

  if (!map.getLayer('vigo-scenario-routes')) {
    map.addLayer({
      id: 'vigo-scenario-routes',
      type: 'line',
      source: 'vigo-routes',
      filter: ['in', ['get', 'status'], ['literal', ['added', 'changed', 'removed']]],
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 10, 0.9, 14, 2.2],
        'line-opacity': 0.2,
        'line-dasharray': [1.4, 1.2],
      },
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tripCount'] as ExpressionSpecification },
    })
  }

  if (!map.getLayer('vigo-route-casing')) {
    map.addLayer({
      id: 'vigo-route-casing',
      type: 'line',
      source: 'vigo-routes',
      paint: {
        'line-color': '#02060a',
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['==', ['get', 'selectedPattern'], true], 2.5, 0.58],
          10,
          ['case', ['==', ['get', 'selectedPattern'], true], 4.6, 1.28],
          14,
          ['case', ['==', ['get', 'selectedPattern'], true], 8.4, 3.05],
        ] as ExpressionSpecification,
        'line-opacity': ['case', ['==', ['get', 'selectedPattern'], true], 0.72, 0.24] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tripCount'] as ExpressionSpecification },
    })
  }

  if (!map.getLayer('vigo-routes')) {
    map.addLayer({
      id: 'vigo-routes',
      type: 'line',
      source: 'vigo-routes',
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['==', ['get', 'selectedPattern'], true], 1.5, 0.42],
          10,
          ['case', ['==', ['get', 'selectedPattern'], true], 3.4, 1.02],
          14,
          ['case', ['==', ['get', 'selectedPattern'], true], 6.6, 2.35],
        ] as ExpressionSpecification,
        'line-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['==', ['get', 'selectedPattern'], true], 0.98, 0.4],
          10,
          ['case', ['==', ['get', 'selectedPattern'], true], 0.98, 0.58],
          14,
          ['case', ['==', ['get', 'selectedPattern'], true], 0.98, 0.74],
        ] as ExpressionSpecification,
        'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 0.08, 12, 0.02] as ExpressionSpecification,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'tripCount'] as ExpressionSpecification },
    })
  }

  if (!map.getLayer('vigo-selected-route')) {
    map.addLayer({
      id: 'vigo-selected-route',
      type: 'line',
      source: 'vigo-routes',
      filter: ['==', ['get', 'featureId'], '__none__'],
      paint: {
        'line-color': ['get', 'color'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.2, 10, 4.2, 14, 7.4],
        'line-opacity': 0.96,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-segments-casing')) {
    map.addLayer({
      id: 'vigo-segments-casing',
      type: 'line',
      source: 'vigo-segments',
      paint: {
        'line-color': '#02060a',
        'line-width': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 2.2, 650, 6.6],
        'line-opacity': 0.76,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-walk-casing')) {
    map.addLayer({
      id: 'vigo-routing-walk-casing',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'walk']],
      paint: {
        'line-color': '#0d8bd9',
        'line-width': 1,
        'line-opacity': 0,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-walk')) {
    map.addLayer({
      id: 'vigo-routing-walk',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'walk']],
      paint: {
        'line-color': '#0d8bd9',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 13, 2.6],
        'line-opacity': 0.94,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-drive-casing')) {
    map.addLayer({
      id: 'vigo-routing-drive-casing',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'drive']],
      paint: {
        'line-color': '#02060a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6.6, 13, 11],
        'line-opacity': 0.86,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-drive')) {
    map.addLayer({
      id: 'vigo-routing-drive',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'drive']],
      paint: {
        'line-color': '#ffad4d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 8],
        'line-opacity': 1,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-ride-casing')) {
    map.addLayer({
      id: 'vigo-routing-ride-casing',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'ride']],
      paint: {
        'line-color': '#02060a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5.6, 13, 9.5],
        'line-opacity': ['case', ['==', ['get', 'geometrySource'], 'shape'], 0.82, 0.48] as ExpressionSpecification,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-ride')) {
    map.addLayer({
      id: 'vigo-routing-ride',
      type: 'line',
      source: 'vigo-routing',
      filter: ['all', ['==', ['get', 'featureKind'], 'line'], ['==', ['get', 'legType'], 'ride']],
      paint: {
        'line-color': ['coalesce', ['get', 'routeColor'], '#7ddfe8'] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.2, 13, 6.8],
        'line-opacity': ['case', ['==', ['get', 'geometrySource'], 'shape'], 0.98, 0.72] as ExpressionSpecification,
        'line-dasharray': ['case', ['==', ['get', 'geometrySource'], 'shape'], ['literal', [1, 0]], ['literal', [2, 1.4]]] as ExpressionSpecification,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-routing-labels')) {
    map.addLayer({
      id: 'vigo-routing-labels',
      type: 'symbol',
      source: 'vigo-routing',
      filter: ['==', ['get', 'featureKind'], 'label'],
      layout: {
        'symbol-placement': 'point',
        'text-field': ['get', 'routeShortName'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9.5, 13, 11.5, 16, 12],
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
        'text-allow-overlap': false,
        'text-ignore-placement': false,
        'text-padding': 6,
      },
      paint: {
        'text-color': '#f8fbff',
        'text-halo-color': '#02060a',
        'text-halo-width': 1.45,
        'text-halo-blur': 0.35,
        'text-opacity': [
          'interpolate', ['linear'], ['zoom'], 9, 0, 10,
          ['case', ['==', ['get', 'geometrySource'], 'shape'], 0.96, 0.82],
        ] as ExpressionSpecification,
      },
    })
  }

  if (!map.getLayer('vigo-segments')) {
    map.addLayer({
      id: 'vigo-segments',
      type: 'line',
      source: 'vigo-segments',
      paint: {
        'line-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'speedKph'], 0],
          0,
          '#ff735c',
          15,
          '#ffd166',
          28,
          '#35d0a1',
          45,
          '#6da8ff',
        ],
        'line-width': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 1.4, 650, 4.8],
        'line-opacity': 0.9,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-selected-segments')) {
    map.addLayer({
      id: 'vigo-selected-segments',
      type: 'line',
      source: 'vigo-segments',
      filter: ['==', ['get', 'patternId'], '__none__'],
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['get', 'tripCount'], 0, 2.8, 650, 7.2],
        'line-opacity': 0.74,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  }

  if (!map.getLayer('vigo-overview-stops')) {
    map.addLayer({
      id: 'vigo-overview-stops',
      type: 'circle',
      source: 'vigo-stops',
      maxzoom: 10.5,
      paint: {
        'circle-color': '#2f80ed',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 6, 1.35, 10.4, 2.1],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.34, 6, 0.58, 10.4, 0.16],
        'circle-stroke-color': '#dff5ff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 0, 7, 0.25],
        'circle-stroke-opacity': 0.46,
      },
    })
  }

  if (!map.getLayer('vigo-network-stops')) {
    map.addLayer({
      id: 'vigo-network-stops',
      type: 'circle',
      source: 'vigo-stops',
      filter: ['!=', ['get', 'selectedPatternStop'], true],
      minzoom: 10.5,
      paint: {
        'circle-color': '#dbe8f4',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1.5, 14, 4, 17, 6],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0.45, 14, 0.95],
        'circle-stroke-color': '#071017',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10.5, 0.5, 14, 1.5],
      },
    })
  }

  if (!map.getLayer('vigo-transfer-stops')) {
    map.addLayer({
      id: 'vigo-transfer-stops',
      type: 'circle',
      source: 'vigo-stops',
      filter: ['>=', ['get', 'routeCount'], 2],
      minzoom: 10,
      paint: {
        'circle-color': '#f4d27a',
        'circle-radius': ['interpolate', ['linear'], ['get', 'transferScore'], 0, 0.75, 100, 2.7],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.1, 13.5, 0.46],
        'circle-stroke-color': '#060a0f',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.35, 14, 0.8],
      },
    })
  }

  if (!map.getLayer('vigo-stops')) {
    map.addLayer({
      id: 'vigo-stops',
      type: 'circle',
      source: 'vigo-stops',
      filter: ['==', ['get', 'selectedPatternStop'], true],
      minzoom: 9,
      paint: {
        'circle-color': ['step', ['get', 'routeCount'], '#f4f7fb', 2, '#dfe8f3', 4, '#f6c85f'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 11.5, 3, 14, 5, 17, 7],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.16, 11.5, 0.44, 14, 0.72],
        'circle-stroke-color': '#071017',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.5],
      },
    })
  }

  if (!map.getLayer('vigo-selected-stop')) {
    map.addLayer({
      id: 'vigo-selected-stop', type: 'circle', source: 'vigo-stops',
      filter: ['==', ['get', 'selectedStop'], true],
      paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-stroke-color': '#2f80ed', 'circle-stroke-width': 3 },
    })
  }

  if (!map.getLayer('vigo-vehicle-halo')) {
    map.addLayer({
      id: 'vigo-vehicle-halo',
      type: 'circle',
      source: 'vigo-service-vehicles',
      filter: ['==', ['get', 'selectedRoute'], true],
      paint: {
        'circle-color': ['coalesce', ['get', 'routeColor'], '#6af3ee'] as ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.7, 13, 9.8],
        'circle-opacity': [
          'interpolate', ['linear'], ['zoom'],
          8, ['case', ['==', ['get', 'source'], 'live'], 0.08, 0.035],
          12, ['case', ['==', ['get', 'source'], 'live'], 0.17, 0.08],
        ] as ExpressionSpecification,
        'circle-blur': 0.5,
      },
    })
  }

  if (!map.getLayer('vigo-routing-pin-halo')) {
    map.addLayer({
      id: 'vigo-routing-pin-halo',
      type: 'circle',
      source: 'vigo-routing-pins',
      paint: {
        'circle-color': [
          'case',
          ['==', ['get', 'zeroMinuteOrigin'], true],
          '#3550ff',
          ['==', ['get', 'pointKind'], 'waypoint'],
          '#f0b62e',
          ['==', ['get', 'pointKind'], 'destination'],
          '#9cbd23',
          '#13b8c7',
        ] as ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 7, 13, 11],
        'circle-opacity': 0.2,
        'circle-blur': 0.45,
      },
    })
  }

  if (!map.getLayer('vigo-routing-pins')) {
    map.addLayer({
      id: 'vigo-routing-pins',
      type: 'circle',
      source: 'vigo-routing-pins',
      paint: {
        'circle-color': [
          'case',
          ['==', ['get', 'zeroMinuteOrigin'], true],
          '#3550ff',
          ['==', ['get', 'pointKind'], 'waypoint'],
          '#f0b62e',
          ['==', ['get', 'pointKind'], 'destination'],
          '#9cbd23',
          '#13b8c7',
        ] as ExpressionSpecification,
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          7, ['case', ['==', ['get', 'zeroMinuteOrigin'], true], 5.5, 4.5],
          13, ['case', ['==', ['get', 'zeroMinuteOrigin'], true], 8, 6.5],
        ] as ExpressionSpecification,
        'circle-stroke-color': '#f8fbff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 7, 1.5, 13, 2.5],
        'circle-opacity': 1,
      },
    })
  }

  if (!map.getLayer('vigo-vehicle-pairs')) map.addLayer({
    id: 'vigo-vehicle-pairs', type: 'line', source: 'vigo-service-vehicles', minzoom: 11,
    filter: ['==', ['get', 'pair'], true],
    paint: { 'line-color': ['case', ['==', ['get', 'gapSeverity'], 'critical'], '#dc2626', '#d97706'], 'line-width': 1.5, 'line-dasharray': [2, 3], 'line-opacity': .75 },
  })
  if (!map.getLayer(vehicleMarkerLayer.id)) map.addLayer(vehicleMarkerLayer)
  if (!map.getLayer(vehicleHeadingLayer.id)) map.addLayer(vehicleHeadingLayer)

  if (!map.getLayer('vigo-vehicle-indicator-label')) map.addLayer({
    id: 'vigo-vehicle-indicator-label', type: 'symbol', source: 'vigo-service-vehicles', minzoom: 12,
    filter: ['!=', ['get', 'indicatorLabel'], ''],
    layout: { 'text-field': ['get', 'indicatorLabel'], 'text-size': 11, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': false },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#111827', 'text-halo-width': 2 },
  })

  if (!map.getLayer('vigo-vehicle-labels')) {
    map.addLayer({
      id: 'vigo-vehicle-labels',
      type: 'symbol',
      source: 'vigo-service-vehicles',
      filter: ['==', ['get', 'selectedRoute'], true],
      layout: {
        'text-field': ['coalesce', ['get', 'routeShortName'], ['get', 'routeId'], ['get', 'label']],
        'text-size': ['interpolate', ['linear'], ['zoom'], 13.2, 7.2, 15.5, 9.6],
        'text-offset': [0, 1.16],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-padding': 5,
      },
      paint: {
        'text-color': '#ffffff',
        'text-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12.4,
          0,
          14.4,
          ['case', ['==', ['get', 'selectedRoute'], true], 0.62, 0],
          15.8,
          ['case', ['==', ['get', 'selectedRoute'], true], 0.7, 0],
        ] as ExpressionSpecification,
        'text-halo-color': '#03070b',
        'text-halo-width': 1.2,
      },
    })
  }

  for (const [id, radius, opacity] of [
    ['vigo-access-outer', 1600, 0.12],
    ['vigo-access-middle', 950, 0.16],
    ['vigo-access-inner', 420, 0.22],
  ] as const) {
    if (!map.getLayer(id)) {
      map.addLayer({
        id,
        type: 'circle',
        source: 'vigo-access',
        paint: {
          'circle-color': '#35d0a1',
          'circle-opacity': opacity,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, radius / 190, 13, radius / 36],
          'circle-stroke-color': '#35d0a1',
          'circle-stroke-opacity': 0.38,
          'circle-stroke-width': 1.2,
        },
      })
    }
  }
}

export function applyLayerVisibility(
  map: MapLibreMap,
  layers: LayerState,
  options: { routingVisible?: boolean; reachResultVisible?: boolean; reachComparisonCount?: number } = {},
) {
  setVisibility(map, routeLayerIds, layers.routes)
  setVisibility(map, segmentLayerIds, layers.segments)
  setVisibility(map, stopLayerIds, layers.stops)
  setVisibility(map, transferLayerIds, layers.transfers)
  setVisibility(map, coverageLayerIds, layers.coverage)
  setVisibility(map, scenarioLayerIds, layers.scenario)
  setVisibility(map, accessLayerIds, layers.access)
  setVisibility(map, vehicleLayerIds, layers.routes)
  setVisibility(map, routingLayerIds, options.routingVisible ?? true)
  setVisibility(map, reachResultLayerIds, options.reachResultVisible ?? false)
  setVisibility(map, existingScenarioComparisonLayerIds(map), false)
  setVisibility(
    map,
    reachComparisonLayerIds(options.reachComparisonCount ?? 0),
    options.reachResultVisible ?? false,
  )
}

function routeLensColor(networkLens: NetworkLens): ExpressionSpecification {
  if (networkLens === 'shape') {
    return [
      'match',
      ['get', 'geometryConfidence'],
      'trusted',
      '#35d0a1',
      'split',
      '#ffb86b',
      'inferred',
      '#ffd166',
      '#9fb0c4',
    ] as ExpressionSpecification
  }

  if (networkLens === 'service') {
    return [
      'case',
      ['>', ['get', 'headwayMinutes'], 30],
      '#ff735c',
      ['<', ['get', 'spanHours'], 14],
      '#ffd166',
      ['>', ['get', 'headwayMinutes'], 15],
      '#8eeaf3',
      '#35d0a1',
    ] as ExpressionSpecification
  }

  if (networkLens === 'transfer') {
    return [
      'case',
      ['>=', ['get', 'stopCount'], 35],
      '#6da8ff',
      ['>=', ['get', 'tripCount'], 250],
      '#8eeaf3',
      '#7f8fa3',
    ] as ExpressionSpecification
  }

  if (networkLens === 'risk') {
    return [
      'case',
      ['>', ['get', 'geometryFragmentCount'], 1],
      '#ff735c',
      ['!=', ['get', 'geometrySource'], 'shape'],
      '#ffd166',
      ['>', ['get', 'headwayMinutes'], 30],
      '#ff735c',
      ['<', ['get', 'spanHours'], 14],
      '#ffb86b',
      ['in', ['get', 'status'], ['literal', ['added', 'changed', 'removed']]],
      '#b58cff',
      '#6d7b8d',
    ] as ExpressionSpecification
  }

  return ['get', 'color'] as ExpressionSpecification
}

function routeLensOpacity(networkLens: NetworkLens): ExpressionSpecification {
  if (networkLens === 'shape') {
    return [
      'case',
      ['==', ['get', 'selectedPattern'], true],
      0.98,
      ['!=', ['get', 'geometrySource'], 'shape'],
      0.96,
      0.44,
    ] as ExpressionSpecification
  }

  if (networkLens === 'service') {
    return [
      'case',
      ['==', ['get', 'selectedPattern'], true],
      0.98,
      ['any', ['>', ['get', 'headwayMinutes'], 30], ['<', ['get', 'spanHours'], 14]],
      0.96,
      0.58,
    ] as ExpressionSpecification
  }

  if (networkLens === 'risk') {
    return [
      'case',
      ['==', ['get', 'selectedPattern'], true],
      0.98,
      ['any', ['!=', ['get', 'geometrySource'], 'shape'], ['>', ['get', 'headwayMinutes'], 30], ['<', ['get', 'spanHours'], 14]],
      0.96,
      0.36,
    ] as ExpressionSpecification
  }

  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    ['case', ['==', ['get', 'selectedPattern'], true], 0.98, networkLens === 'transfer' ? 0.3 : 0.4],
    10,
    ['case', ['==', ['get', 'selectedPattern'], true], 0.98, networkLens === 'transfer' ? 0.42 : 0.58],
    14,
    ['case', ['==', ['get', 'selectedPattern'], true], 0.98, networkLens === 'transfer' ? 0.56 : 0.74],
  ] as ExpressionSpecification
}

export function applyNetworkLensPaint(map: MapLibreMap, networkLens: NetworkLens) {
  const lineColor = routeLensColor(networkLens)
  const lineOpacity = routeLensOpacity(networkLens)
  const transferOpacity = networkLens === 'transfer' ? 0.78 : networkLens === 'risk' ? 0.28 : 0.46
  const stopOpacity = ['interpolate', ['linear'], ['zoom'], 9, 0.5, 12, 0.85, 14, 1]
  // Schematic stop-to-stop geometry is still a route. Keep it visible in
  // every lens instead of silently dropping services without shapes.txt.
  const routeFilter: FilterSpecification | null = null

  if (map.getLayer('vigo-routes')) {
    map.setFilter('vigo-routes', routeFilter)
    map.setPaintProperty('vigo-routes', 'line-color', lineColor)
    map.setPaintProperty('vigo-routes', 'line-opacity', lineOpacity)
  }
  if (map.getLayer('vigo-selected-route')) {
    map.setPaintProperty('vigo-selected-route', 'line-color', lineColor)
  }
  if (map.getLayer('vigo-route-casing')) {
    map.setFilter('vigo-route-casing', routeFilter)
    map.setPaintProperty('vigo-route-casing', 'line-opacity', networkLens === 'network' ? ['case', ['==', ['get', 'selectedPattern'], true], 0.72, 0.24] : ['case', ['==', ['get', 'selectedPattern'], true], 0.78, 0.32])
  }
  if (map.getLayer('vigo-transfer-stops')) {
    map.setPaintProperty('vigo-transfer-stops', 'circle-opacity', transferOpacity)
    map.setPaintProperty('vigo-transfer-stops', 'circle-radius', networkLens === 'transfer'
      ? ['interpolate', ['linear'], ['get', 'transferScore'], 0, 1.2, 100, 4.4]
      : ['interpolate', ['linear'], ['get', 'transferScore'], 0, 0.75, 100, 2.7])
  }
  if (map.getLayer('vigo-stops')) {
    map.setPaintProperty('vigo-stops', 'circle-opacity', stopOpacity as ExpressionSpecification)
  }
}
