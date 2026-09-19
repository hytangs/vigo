import type { CircleLayerSpecification, Map as MapLibreMap, SymbolLayerSpecification } from 'maplibre-gl'

// The locally bundled arrow points north and stays inside the vehicle disc.
function vehicleDirectionSprite() {
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')!
  context.lineJoin = 'round'
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(24, 12)
  context.lineTo(33, 33)
  context.lineTo(24, 28)
  context.lineTo(15, 33)
  context.closePath()
  context.strokeStyle = '#152632'
  context.lineWidth = 1.5
  context.stroke()
  context.fillStyle = '#ffffff'
  context.fill()
  return context.getImageData(0, 0, size, size)
}

export function ensureVehicleDirectionSprite(map: MapLibreMap) {
  const id = 'vigo-vehicle-direction'
  if (!map.hasImage(id)) map.addImage(id, vehicleDirectionSprite(), { pixelRatio: 2 })
}

export const vehicleMarkerLayer: CircleLayerSpecification = {
  id: 'vigo-vehicles',
  type: 'circle',
  source: 'vigo-service-vehicles',
  paint: {
    'circle-color': ['coalesce', ['get', 'routeColor'], '#35d0a1'],
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.4, 9, 2.4, 10, 4.5, 13, 7, 16, 9],
    'circle-opacity': 1,
    'circle-stroke-color': ['case', ['any', ['==', ['get', 'delaySeverity'], 'critical'], ['==', ['get', 'gapSeverity'], 'critical']], '#dc2626', ['any', ['==', ['get', 'delaySeverity'], 'warning'], ['==', ['get', 'gapSeverity'], 'warning']], '#d97706', '#ffffff'],
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['any', ['in', ['get', 'delaySeverity'], ['literal', ['warning', 'critical']]], ['in', ['get', 'gapSeverity'], ['literal', ['warning', 'critical']]]], 1, .25], 10, ['case', ['any', ['in', ['get', 'delaySeverity'], ['literal', ['warning', 'critical']]], ['in', ['get', 'gapSeverity'], ['literal', ['warning', 'critical']]]], 2, 1], 13, ['case', ['any', ['in', ['get', 'delaySeverity'], ['literal', ['warning', 'critical']]], ['in', ['get', 'gapSeverity'], ['literal', ['warning', 'critical']]]], 2, 1.5]],
    'circle-pitch-alignment': 'map',
    'circle-pitch-scale': 'viewport',
  },
}

export const vehicleHeadingLayer: SymbolLayerSpecification = {
  id: 'vigo-vehicle-headings',
  type: 'symbol',
  source: 'vigo-service-vehicles',
  minzoom: 10,
  filter: ['==', ['get', 'hasBearing'], true],
  layout: {
    'icon-image': 'vigo-vehicle-direction',
    'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 13, 0.8, 16, 1],
    'icon-rotate': ['get', 'bearing'],
    'icon-rotation-alignment': 'map',
    'icon-pitch-alignment': 'map',
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  },
}
