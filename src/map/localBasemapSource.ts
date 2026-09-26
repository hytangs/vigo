import type { FeatureCollection } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { localBasemapLayerIds } from './layers'

const sourceId = 'vigo-local-basemap'
type Request = {
  data: FeatureCollection
  signal?: AbortSignal
  resolve: (applied: boolean) => void
  reject: (error: unknown) => void
}
type Updates = { running: boolean; remove: boolean; destroyed: boolean; pending?: Request }
const updates = new WeakMap<MapLibreMap, Updates>()

function discardPending(state: Updates) {
  state.pending?.resolve(false)
  state.pending = undefined
}

function removeSource(map: MapLibreMap, state: Updates) {
  if (map.getSource(sourceId)) map.removeSource(sourceId)
  state.remove = false
}

export function localBasemapRemovalPending(map: MapLibreMap) {
  return updates.get(map)?.remove === true
}

export function removeLocalBasemap(map: MapLibreMap) {
  for (const layerId of [...localBasemapLayerIds].reverse()) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  const state = updates.get(map)
  if (state) {
    discardPending(state)
    state.remove = true
    // Removing a source with queued MapLibre work can recreate its worker
    // index after removal and overwrite the next City's source with this id.
    if (state.running) return
    removeSource(map, state)
  } else if (map.getSource(sourceId)) map.removeSource(sourceId)
}

async function drain(map: MapLibreMap, state: Updates) {
  state.running = true
  try {
    while (state.pending && !state.destroyed) {
      const request = state.pending
      state.pending = undefined
      if (request.signal?.aborted) { request.resolve(false); continue }
      try {
        if (state.remove) removeSource(map, state)
        const source = map.getSource(sourceId) as GeoJSONSource | undefined
        if (source) await source.setData(request.data)
        else {
          map.addSource(sourceId, {
            type: 'geojson', data: request.data, maxzoom: 14, buffer: 32, tolerance: 0.75,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · local PBF',
          })
          // onAdd starts the initial load; load() returns that same worker
          // promise without queuing a second copy of the data.
          await (map.getSource(sourceId) as GeoJSONSource).load()
        }
        request.resolve(!request.signal?.aborted && !state.remove && !state.destroyed)
      } catch (error) {
        request.reject(error)
      }
      if (state.remove && !state.destroyed) removeSource(map, state)
    }
  } finally {
    state.running = false
    if (state.remove && !state.destroyed) removeSource(map, state)
  }
}

// At most one worker update plus the newest waiting viewport. Superseded
// waiting collections are released immediately, even before the worker finishes.
export function setLocalBasemapData(map: MapLibreMap, data: FeatureCollection, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  let state = updates.get(map)
  if (!state) {
    state = { running: false, remove: false, destroyed: false }
    updates.set(map, state)
    const current = state
    map.once('remove', () => {
      current.destroyed = true
      discardPending(current)
      updates.delete(map)
    })
  }
  const current = state
  return new Promise((resolve, reject) => {
    discardPending(current)
    current.pending = { data, signal, resolve, reject }
    if (!current.running) void drain(map, current)
  })
}
