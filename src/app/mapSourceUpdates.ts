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

const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] }
const streetUpdates = new WeakMap<GeoJSONSource, {
  requested: FeatureCollection
  applied?: FeatureCollection
  running: boolean
}>()

// A city-wide street result can contain millions of segments. MapLibre builds
// the next worker index before releasing the previous one. Clear that index
// first so changing the cutoff cannot hold two complete street indexes at once.
// Serialize updates and retain only the latest selection while the worker runs.
export function setStreetMapSourceData(source: GeoJSONSource, data: FeatureCollection) {
  let state = streetUpdates.get(source)
  if (!state) {
    state = { requested: data, running: false }
    streetUpdates.set(source, state)
  }
  state.requested = data
  if (state.running || state.applied === data) return
  state.running = true
  const update = async () => {
    try {
      while (state.applied !== state.requested) {
        if (state.applied?.features.length && state.requested.features.length) {
          await source.setData(emptyCollection)
          state.applied = emptyCollection
        }
        const latest = state.requested
        await source.setData(latest)
        state.applied = latest
      }
    } finally {
      state.running = false
    }
  }
  void update().catch(error => source.fire('error', { error }))
}
