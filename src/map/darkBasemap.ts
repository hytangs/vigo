import type { LayerSpecification } from 'maplibre-gl'

export const darkMapLand = '#101419'
export const darkMapWater = '#0b1a26'

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
      : source === 'park' ? '#121b17'
      : source === 'landcover' ? 'rgba(20, 30, 26, 0.55)'
      : source === 'landuse' ? '#12171c'
      : source === 'building' ? 'rgba(40, 48, 58, 0.72)'
      : source === 'aeroway' ? '#161c22' : darkMapLand
    return { ...layer, paint: { ...layer.paint, 'fill-color': color } }
  }
  if (layer.type === 'line') {
    const color = source === 'waterway' ? '#1b3141'
      : source === 'park' ? '#18221e'
      : source === 'boundary' ? 'rgba(140, 155, 175, 0.25)'
      : id.includes('pier') ? darkMapLand
      : id.includes('casing') ? '#0a0d11'
      : id.startsWith('railway') ? id.includes('dashline') ? '#38424e' : '#1c232b'
      : id.includes('path') ? '#2a333d'
      : id.includes('motorway') ? '#2e3742'
      : id.includes('major') ? '#262e38'
      : '#1f262e'
    return { ...layer, paint: { ...layer.paint, 'line-color': color } }
  }
  if (layer.type === 'symbol') {
    const color = source === 'water_name' ? '#5f86a3'
      : source === 'place' && /city|town|country|continent/.test(id) ? '#c3cad4'
      : '#7f8a99'
    return { ...layer, paint: { ...layer.paint, 'text-color': color, 'text-halo-color': darkMapLand } }
  }
  return layer
}
