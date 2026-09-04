import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource } from 'maplibre-gl'

const submittedData = new WeakMap<GeoJSONSource, FeatureCollection>()

// Static map collections are immutable and memoized. A selection or visibility
// change should only send changed collections to the map worker. Key by the
// source instance so a rebuilt style always receives its initial data.
export function setMapSourceData(source: GeoJSONSource, data: FeatureCollection) {
  if (submittedData.get(source) === data) return
  source.setData(data)
  submittedData.set(source, data)
}
