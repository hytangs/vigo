import assert from 'node:assert/strict'
import { importTestModules } from './helpers/import-test-modules.mjs'

const [{ syncBasemap }] = await importTestModules('map/basemaps.ts')
const originalFetch = globalThis.fetch
const requests = []
globalThis.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))

function mapFixture() {
  const overlay = { id: 'vigo-routes', type: 'line', source: 'routes' }
  const sources = new Map([['routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }]])
  const layers = new Map([[overlay.id, overlay]])
  const sprites = new Map()
  const order = [overlay.id]
  const events = []
  let glyphs = null
  let dispose
  let removed = false
  return {
    sources, layers, sprites, order, events, overlay,
    once(event, callback) { assert.equal(event, 'remove'); dispose = callback },
    remove() { removed = true; dispose() },
    getLayer(id) { assert.ok(!removed, 'Do not touch a disposed map'); return layers.get(id) },
    getSource(id) { return sources.get(id) },
    addSource(id, source) { assert.ok(!sources.has(id)); sources.set(id, source) },
    removeSource(id) { assert.ok(![...layers.values()].some(layer => layer.source === id)); sources.delete(id) },
    addLayer(layer, before) { assert.ok(!layers.has(layer.id)); layers.set(layer.id, layer); order.splice(before ? order.indexOf(before) : order.length, 0, layer.id) },
    removeLayer(id) { layers.delete(id); order.splice(order.indexOf(id), 1) },
    addSprite(id, url) { assert.ok(!sprites.has(id)); sprites.set(id, url) },
    removeSprite(id) { sprites.delete(id) },
    getGlyphs() { return glyphs },
    setGlyphs(value) { glyphs = value },
    fire(event, detail) { events.push({ event, ...detail }) },
  }
}

function style(name) {
  return { version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://tiles.openfreemap.org/sprites/fixture',
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: name, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
      { id: 'poi', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', layout: { 'icon-image': ['step', ['zoom'], 'circle', 10, ''] } },
    ],
  }
}
function reply(request, name) { request.resolve({ ok: true, json: async () => style(name) }) }
function assertOverlaysPreserved(map) {
  assert.equal(map.getLayer('vigo-routes'), map.overlay)
  assert.equal(map.order.at(-1), 'vigo-routes', 'Background must stay below route overlays')
  assert.ok(map.sources.has('routes'))
}

try {
  const map = mapFixture()
  const light = syncBasemap(map, 'minimal', 'light')
  assert.equal(syncBasemap(map, 'minimal', 'dark'), light, 'Repeated effects must share the pending style request')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://tiles.openfreemap.org/styles/positron')
  assert.equal(requests[0].options.credentials, 'omit')
  const dark = syncBasemap(map, 'dark', 'dark')
  assert.equal(requests[1].url, 'https://tiles.openfreemap.org/styles/fiord')
  assert.ok(requests[0].options.signal.aborted)
  reply(requests[1], 'dark'); await dark
  reply(requests[0], 'light'); await light
  assert.ok(map.layers.has('vigo-basemap-dark'))
  assert.ok(!map.layers.has('vigo-basemap-light'), 'An old request must not replace the current background')
  assert.deepEqual(map.layers.get('vigo-basemap-poi').layout['icon-image'], ['step', ['zoom'], 'circle', 10, ''], 'Preserve valid zoom-dependent style expressions')
  assertOverlaysPreserved(map)

  syncBasemap(map, 'offline', 'light')
  assert.deepEqual([...map.sources.keys()], ['routes'])
  assert.equal(map.sprites.size, 0)
  assert.equal(map.getGlyphs(), null, 'Local mode must stop remote font requests')
  const fetchCount = requests.length
  await syncBasemap(map, 'dark', 'dark')
  assert.equal(requests.length, fetchCount, 'Reuse a previously fetched style')
  syncBasemap(map, 'streets', 'light')
  assert.equal(map.sources.get('osm').type, 'raster')
  assert.equal(map.sources.get('osm').tiles[0], 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
  assertOverlaysPreserved(map)

  const detailed = syncBasemap(map, 'terrain', 'light')
  const cancelled = requests.at(-1)
  syncBasemap(map, 'none', 'light')
  assert.ok(cancelled.options.signal.aborted)
  cancelled.reject(new DOMException('Aborted', 'AbortError')); await detailed
  assert.equal(map.events.length, 0, 'Switching backgrounds is not a map failure')
  assert.deepEqual([...map.sources.keys()], ['routes'])

  const failure = syncBasemap(map, 'terrain', 'light')
  requests.at(-1).resolve({ ok: false, status: 503 }); await failure
  assert.equal(map.events.length, 1)
  assert.equal(map.events[0].sourceId, 'osm')
  assertOverlaysPreserved(map)
  const retry = syncBasemap(map, 'terrain', 'light')
  map.remove()
  reply(requests.at(-1), 'detail'); await retry

  const second = mapFixture()
  await syncBasemap(second, 'terrain', 'light')
  assert.ok(second.layers.has('vigo-basemap-detail'))
  assertOverlaysPreserved(second)
  second.remove()
  assert.ok(requests.every(request => !/cartocdn|[?&](?:key|token)=/.test(request.url)))
  console.log('Online basemaps: no-key styles, overlay preservation, switching, cancellation, failure recovery, and disposal passed')
} finally {
  globalThis.fetch = originalFetch
}
