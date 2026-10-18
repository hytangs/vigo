import type { LayerSpecification } from 'maplibre-gl'

export const darkMapLand = '#0a111d'
export const darkMapWater = '#071a2d'

// Recolor the background only. Provider geometry, label placement, zoom ranges and
// sprite expressions stay intact; VIGO's transit overlays keep their colors.
export function darkBasemapLayer(layer: LayerSpecification): LayerSpecification {
  const id = layer.id
  const source = 'source-layer' in layer ? layer['source-layer'] : ''
  if (layer.type === 'background') {
    return { ...layer, paint: { ...layer.paint, 'background-color': darkMapLand } }
  }
  if (layer.type === 'fill') {
    const color = source === 'water' ? darkMapWater
      : source === 'park' ? '#0d1a1c'
      : source === 'landcover' ? 'rgba(16, 30, 32, 0.5)'
      : source === 'landuse' ? '#0d1522'
      : source === 'building' ? 'rgba(34, 46, 64, 0.72)'
      : source === 'aeroway' ? '#121b28' : darkMapLand
    return { ...layer, paint: { ...layer.paint, 'fill-color': color } }
  }
  if (layer.type === 'line') {
    const color = source === 'waterway' ? '#17324a'
      : source === 'park' ? '#152224'
      : source === 'boundary' ? 'rgba(140, 155, 175, 0.25)'
      : id.includes('pier') ? darkMapLand
      : id.includes('casing') ? '#060b13'
      : id.startsWith('railway') ? id.includes('dashline') ? '#334156' : '#182231'
      : id.includes('path') ? '#243042'
      : id.includes('motorway') ? '#283548'
      : id.includes('major') ? '#1f2b3c'
      : '#192434'
    return { ...layer, paint: { ...layer.paint, 'line-color': color } }
  }
  if (layer.type === 'symbol') {
    const color = source === 'water_name' ? '#5a87a8'
      : source === 'place' && /city|town|country|continent/.test(id) ? '#c0cad8'
      : '#7b889c'
    return { ...layer, paint: { ...layer.paint, 'text-color': color, 'text-halo-color': darkMapLand } }
  }
  return layer
}
