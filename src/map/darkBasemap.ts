import type { LayerSpecification } from 'maplibre-gl'

export const darkMapLand = '#202823'
export const darkMapWater = '#15221f'

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
      : source === 'park' ? '#344535'
      : source === 'landcover' ? 'rgba(47, 62, 48, 0.57)'
      : source === 'landuse' ? '#242d26'
      : source === 'building' ? 'rgba(89, 104, 91, 0.65)'
      : source === 'aeroway' ? '#303a32' : darkMapLand
    return { ...layer, paint: { ...layer.paint, 'fill-color': color } }
  }
  if (layer.type === 'line') {
    const color = source === 'waterway' ? '#30463d'
      : source === 'park' ? '#3a4c3c'
      : source === 'boundary' ? 'rgba(125, 143, 127, 0.3)'
      : id.includes('pier') ? darkMapLand
      : id.includes('casing') ? '#2c382f'
      : id.startsWith('railway') ? id.includes('dashline') ? '#536256' : '#253329'
      : id.includes('path') ? '#536455'
      : id.includes('motorway') ? '#536053'
      : id.includes('major') ? '#455346'
      : '#3c4b40'
    return { ...layer, paint: { ...layer.paint, 'line-color': color } }
  }
  if (layer.type === 'symbol') {
    const color = source === 'water_name' ? '#829c90'
      : source === 'place' && /city|town|country|continent/.test(id) ? '#bac7b9'
      : '#94a592'
    return { ...layer, paint: { ...layer.paint, 'text-color': color, 'text-halo-color': darkMapLand } }
  }
  return layer
}
