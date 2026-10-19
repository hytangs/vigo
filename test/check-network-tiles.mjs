import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { buildNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { registerNativeTransitNetwork, releaseNativeTransitNetwork } from '../src/server/native-routing-kernel.mjs'
import {
  bundleNetworkScope,
  createTransitNetworkTiles,
  transitNetworkCatalog,
  transitNetworkInput,
  transitNetworkRevisions,
} from '../src/server/transit-network-tiles.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const root = path.resolve(import.meta.dirname, '..')

// Minimal MVT 2.1 reader with typed values (string, double, sint64).
function readVarint(bytes, state) {
  let result = 0, shift = 0, byte
  do { byte = bytes[state.position++]; result += (byte & 0x7f) * 2 ** shift; shift += 7 } while (byte & 0x80)
  return result
}
function readMessage(bytes, visit) {
  const state = { position: 0 }
  while (state.position < bytes.length) {
    const key = readVarint(bytes, state), field = Math.floor(key / 8), wire = key % 8
    if (wire === 0) visit(field, readVarint(bytes, state))
    else if (wire === 1) { visit(field, Buffer.from(bytes.subarray(state.position, state.position + 8)).readDoubleLE(0)); state.position += 8 }
    else if (wire === 2) { const length = readVarint(bytes, state); visit(field, bytes.subarray(state.position, state.position + length)); state.position += length }
    else throw new Error(`Unexpected protobuf wire type ${wire}`)
  }
}
function decodeTile(buffer) {
  const layers = {}
  readMessage(buffer, (field, layerBytes) => {
    if (field !== 3) return
    const layer = { name: '', keys: [], values: [], features: [] }
    readMessage(layerBytes, (key, value) => {
      if (key === 1) layer.name = Buffer.from(value).toString()
      else if (key === 3) layer.keys.push(Buffer.from(value).toString())
      else if (key === 4) readMessage(value, (kind, data) => {
        layer.values.push(kind === 1 ? Buffer.from(data).toString() : kind === 6 ? (data % 2 ? -(data + 1) / 2 : data / 2) : data)
      })
      else if (key === 2) {
        const feature = { tags: [], type: 0 }
        readMessage(value, (featureField, data) => {
          if (featureField === 2) { const state = { position: 0 }; while (state.position < data.length) feature.tags.push(readVarint(data, state)) }
          else if (featureField === 3) feature.type = data
        })
        layer.features.push(feature)
      }
    })
    layers[layer.name] = layer.features.map((feature) => {
      const properties = {}
      for (let i = 0; i < feature.tags.length; i += 2) properties[layer.keys[feature.tags[i]]] = layer.values[feature.tags[i + 1]]
      return { type: feature.type, properties }
    })
  })
  return layers
}
function tileFor([lon, lat], z) {
  const scale = 2 ** z, radians = lat * Math.PI / 180
  return {
    x: Math.floor((lon + 180) / 360 * scale),
    y: Math.floor((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * scale),
  }
}

// --- Catalog, scoping and the kernel registry over a two-feed City. ---
const lineFeed = (id, name, offset) => ({
  id,
  name,
  importedAt: '2026-10-01T00:00:00.000Z',
  routeCount: 2,
  stopCount: 3,
  routingStore: { status: 'ready', builtAt: '2026-10-01T00:00:00.000Z' },
  routeMetrics: [],
  stopMetrics: [],
  mapPreview: {
    routes: [
      {
        id: 'rail', routeId: 'rail', patternId: 'rail', routeType: 1, shortName: 'R', longName: 'Rail', color: '#DA291C',
        tripCount: 400, stopCount: 3, headwayMinutes: 6, spanHours: 19.5, serviceHours: 120, frequencyClass: 'high',
        status: 'baseline', geometrySource: 'shape', distanceKm: 2.2, points: [], stopIds: ['a', 'b', 'c'],
        coordinates: [[-71.06 + offset, 42.35], [-71.05 + offset, 42.355], [-71.04 + offset, 42.36]],
      },
      // No shape and no published route type: drawn from its stops, never invented as rail.
      {
        id: 'bus', routeId: 'bus', shortName: 'B', longName: 'Bus', color: '#FFC72C', tripCount: 90, stopCount: 2,
        headwayMinutes: 20, spanHours: 16, serviceHours: 30, status: 'baseline', points: [], stopIds: ['a', 'c'],
      },
    ],
    stops: ['a', 'b', 'c'].map((stopId, index) => ({
      id: stopId, name: `Stop ${stopId}`, x: 0, y: 0, lon: -71.06 + offset + index * 0.01, lat: 42.35 + index * 0.005,
      routes: index === 1 ? ['rail'] : ['rail', 'bus'], tripCount: 100 + index, transferScore: index === 1 ? 10.4 : 80,
    })),
    stopPairs: [{ id: 'pair' }],
  },
})
const city = {
  id: 'network-tiles-fixture',
  name: 'Fixture',
  feeds: [lineFeed('north', 'North', 0), lineFeed('south', 'South', 0.05)],
  routingStore: { status: 'ready', builtAt: '2026-10-01T00:00:00.000Z' },
}

const catalog = transitNetworkCatalog(city)
for (const feed of catalog.feeds) {
  assert(feed.mapPreview.routes.every((route) => !('coordinates' in route) && route.stopIds.length === 0), 'The catalog carries no route geometry or stop sequences')
  assert(feed.mapPreview.stops.every((stop) => !('x' in stop) && Number.isFinite(stop.lon)), 'Stops keep coordinates without placeholder x/y')
  assert.equal(feed.mapPreview.stopPairs.length, 0)
  assert.equal(feed.routeMetrics.length, 0, 'The route catalog is sent once, in mapPreview')
}
assert.equal(catalog.feeds[0].mapPreview.routes[0].shortName, 'R', 'Route metadata survives')
assert.deepEqual(Object.keys(catalog.networkTiles), [bundleNetworkScope, 'north', 'south'])
assert.notEqual(catalog.networkTiles.north.revision, catalog.networkTiles.south.revision)
assert.deepEqual(catalog.networkTiles.north.bounds.flat().map((value) => Number(value.toFixed(9))), [-71.06, 42.35, -71.04, 42.36], 'Small networks frame every vertex and stop')

const bundleInput = transitNetworkInput(city, bundleNetworkScope)
assert.deepEqual(bundleInput.routes.map((route) => route.featureId), ['north::rail', 'north::bus', 'south::rail', 'south::bus'], 'Bundle tiles use the Studio’s feed-scoped ids')
assert.equal(bundleInput.routes[0].longName, 'North / Rail')
assert.equal(bundleInput.routes[1].routeType, undefined)
assert.deepEqual(bundleInput.routes[1].coordinates, [[-71.06, 42.35], [-71.04, 42.36]], 'Routes without shapes follow their stops')
assert.equal(bundleInput.routes[1].geometrySource, 'stop_sequence')
assert.deepEqual(bundleInput.stops.map((stop) => stop.stopId).slice(0, 3), ['north::a', 'north::b', 'north::c'])
assert.equal(transitNetworkInput(city, 'south').routes[0].featureId, 'rail', 'A feed scope keeps unscoped ids')

let projectReads = 0
let current = city
const tiles = createTransitNetworkTiles({ readProject: async () => { projectReads += 1; return current } })
const revision = transitNetworkRevisions(city)[bundleNetworkScope]
const { x, y } = tileFor([-71.05, 42.355], 12)
const burst = await Promise.all(Array.from({ length: 6 }, () => tiles.tile(city.id, bundleNetworkScope, revision, 12, x, y)))
assert.equal(projectReads, 1, 'Concurrent tiles share one registration')
assert(burst.every((tile) => tile.current && tile.bytes.equals(burst[0].bytes)))
const layers = decodeTile(burst[0].bytes)
const rail = layers.routes.find((feature) => feature.properties.featureId === 'north::rail')
assert.equal(rail.type, 2)
assert.equal(rail.properties.color, '#DA291C')
assert.equal(rail.properties.routeType, 1)
assert.equal(rail.properties.tripCount, 400)
assert.equal(rail.properties.spanHours, 19.5)
assert.equal(rail.properties.frequencyClass, 'high')
assert.equal(rail.properties.geometryConfidence, 'trusted')
assert(!('routeType' in layers.routes.find((feature) => feature.properties.featureId === 'north::bus').properties))
const stop = layers.stops.find((feature) => feature.properties.stopId === 'north::b')
assert.deepEqual(stop.properties, { stopId: 'north::b', routeCount: 1, tripCount: 101, transferScore: 10 })
assert.equal((await tiles.tile(city.id, bundleNetworkScope, 'stale', 12, x, y)).current, false, 'A stale revision is served but not cached')
assert.equal(projectReads, 2)

// Evict the kernel entry through its bounded registry, without depending on private keys.
for (let index = 0; index < 17; index++) await registerNativeTransitNetwork(`evict-${index}`, '{"routes":[],"stops":[]}')
for (let index = 0; index < 17; index++) releaseNativeTransitNetwork(`evict-${index}`)
assert((await tiles.tile(city.id, bundleNetworkScope, revision, 12, x, y)).bytes.equals(burst[0].bytes))
// A rebuilt store is a new revision with new content.
current = { ...city, feeds: city.feeds.map((feed) => ({
  ...feed,
  routingStore: { ...feed.routingStore, builtAt: '2026-10-02T00:00:00.000Z' },
  mapPreview: { ...feed.mapPreview, routes: feed.mapPreview.routes.map((route) => ({ ...route, color: '#00843D' })) },
})) }
const rebuilt = transitNetworkRevisions(current)[bundleNetworkScope]
assert.notEqual(rebuilt, revision)
const recolored = decodeTile((await tiles.tile(city.id, bundleNetworkScope, rebuilt, 12, x, y)).bytes)
assert(recolored.routes.every((feature) => feature.properties.color === '#00843D'))
tiles.invalidate(city.id)
await tiles.tile(city.id, bundleNetworkScope, rebuilt, 12, x, y)
assert.equal(projectReads, 5, 'Invalidation releases the City’s networks')
await assert.rejects(tiles.tile(city.id, 'missing-feed', '', 12, x, y), (error) => error.statusCode === 404)

// Invalidation during an asynchronous read cannot publish an obsolete network.
let finishRead
const delayedTiles = createTransitNetworkTiles({ readProject: () => new Promise(resolve => { finishRead = resolve }) })
const delayed = delayedTiles.tile(city.id, bundleNetworkScope, revision, 12, x, y)
delayedTiles.invalidate(city.id)
finishRead(city)
await assert.rejects(delayed, error => error.statusCode === 409)
const fresh = delayedTiles.tile(city.id, bundleNetworkScope, revision, 12, x, y)
finishRead(city)
assert((await fresh).bytes.equals(burst[0].bytes), 'A new read recovers after invalidation')
delayedTiles.invalidate(city.id)

// --- The Studio's City open and tiles through the real API and SQLite store. ---
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-network-tiles-'))
const projectId = 'network-tiles-api'
const metaRoot = path.join(folder, 'projects', projectId, '.vigo')
let api
try {
  await fs.mkdir(path.join(metaRoot, 'routing'), { recursive: true })
  const routes = Array.from({ length: 12 }, (_, index) => ({
    routeId: `route-${index}`,
    coordinates: Array.from({ length: 30 }, (_, point) => [-77.2 + point / 2_000, 38.7 + index / 1_000]),
  }))
  const stops = routes.flatMap((route, index) => [0, 15, 29].map((point) => ({
    id: `stop-${index}-${point}`, lon: route.coordinates[point][0], lat: route.coordinates[point][1],
  })))
  const archive = new JSZip()
  const csv = (header, rows) => `${[header, ...rows].join('\n')}\n`
  archive.file('agency.txt', csv('agency_id,agency_name,agency_url,agency_timezone', ['fixture,Fixture,https://example.test,America/New_York']))
  archive.file('stops.txt', csv('stop_id,stop_name,stop_lat,stop_lon', stops.map((stop) => `${stop.id},Stop ${stop.id},${stop.lat},${stop.lon}`)))
  archive.file('routes.txt', csv('route_id,agency_id,route_short_name,route_long_name,route_type,route_color',
    routes.map((route, index) => `${route.routeId},fixture,${index},Route ${index},${index ? 3 : 1},${index ? '005DAA' : 'DA291C'}`)))
  archive.file('trips.txt', csv('route_id,service_id,trip_id,direction_id,shape_id', routes.map((route, index) => `${route.routeId},service,trip-${index},0,shape-${index}`)))
  archive.file('stop_times.txt', csv('trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    routes.flatMap((_, index) => [0, 15, 29].map((point, sequence) => `trip-${index},08:${String(sequence * 10).padStart(2, '0')}:00,08:${String(sequence * 10).padStart(2, '0')}:00,stop-${index}-${point},${sequence + 1}`))))
  archive.file('calendar_dates.txt', csv('service_id,date,exception_type', ['service,20261018,1']))
  archive.file('shapes.txt', csv('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    routes.flatMap((route, index) => route.coordinates.map(([lon, lat], point) => `shape-${index},${lat},${lon},${point + 1}`))))
  const zipPath = path.join(folder, 'fixture.zip')
  await fs.writeFile(zipPath, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  await buildNationalGtfsStore({ zipPath, outputPath: path.join(metaRoot, 'routing', 'project.sqlite') })
  const routingStore = { schemaVersion: 'vigo.routing.store.v4', status: 'ready', fileName: 'project.sqlite', builtAt: '2026-10-18T00:00:00.000Z' }
  await fs.writeFile(path.join(metaRoot, 'project.json'), JSON.stringify({
    schemaVersion: 'vigo.project.v1', id: projectId, name: 'Network tiles fixture', region: 'Fixture',
    createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', storagePath: path.join(folder, 'projects', projectId),
    summary: { feeds: 1, routes: 12, stops: stops.length, transferCandidates: 0, qualityScore: 100 },
    feeds: [{ id: 'feed', name: 'Fixture feed', routeCount: 12, stopCount: stops.length, tripCount: 12, transferCandidates: 0, qualityScore: 100, routingStore }],
    jobs: [], artifacts: [], routingStore,
  }))
  api = await startInMemoryVigoApi({ repositoryRoot: root, environment: { VIGO_PROJECTS_DIR: path.join(folder, 'projects'), VIGO_CONFIG_DIR: path.join(folder, 'config') } })
  const base = `/api/projects/${projectId}`
  const fullText = await (await api.fetch(base)).text()
  const full = JSON.parse(fullText).project
  assert(full.feeds[0].mapPreview.routes.every((route) => route.coordinates.length === 30), 'Other clients keep the full preview')
  const catalogResponse = await api.fetch(`${base}?detail=catalog`)
  assert.equal(catalogResponse.status, 200)
  const catalogText = await catalogResponse.text()
  const opened = JSON.parse(catalogText).project
  assert(Buffer.byteLength(catalogText) < Buffer.byteLength(fullText) / 2, 'City open drops route geometry')
  assert.equal(opened.feeds[0].mapPreview.routes.length, 12)
  assert(opened.feeds[0].mapPreview.routes.every((route) => !route.coordinates))
  const scopeTiles = opened.networkTiles[bundleNetworkScope]
  assert.match(scopeTiles.revision, /^[0-9a-f]{16}$/)
  // Fewer than 500 points: the framed extent is every route vertex and stop.
  const near = (actual, expected) => actual.flat().every((value, index) => Math.abs(value - expected.flat()[index]) < 1e-9)
  assert(near(scopeTiles.bounds, [[-77.2, 38.7], [-77.2 + 29 / 2_000, 38.7 + 11 / 1_000]]), JSON.stringify(scopeTiles.bounds))
  const tile = tileFor([-77.19, 38.705], 13)
  const response = await api.fetch(`${base}/network-tiles/13/${tile.x}/${tile.y}.mvt?v=${scopeTiles.revision}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/vnd.mapbox-vector-tile')
  assert.match(response.headers.get('cache-control'), /immutable/, 'Versioned tiles are immutable')
  const served = decodeTile(Buffer.from(await response.arrayBuffer()))
  assert.deepEqual(new Set(served.routes.map((feature) => feature.properties.featureId)), new Set(full.feeds[0].mapPreview.routes.map((route) => `feed::${route.id}`)), 'Tiles carry every route under the ids the Studio selects')
  assert.equal(served.routes.find((feature) => feature.properties.featureId === 'feed::route-0').properties.routeType, 1)
  assert.equal(served.stops.length, stops.length)
  const stale = await api.fetch(`${base}/network-tiles/13/${tile.x}/${tile.y}.mvt?v=stale`)
  assert.equal(stale.headers.get('cache-control'), 'no-cache', 'A stale revision is never cached as immutable')
  await stale.arrayBuffer()
  assert.equal((await api.fetch(`${base}/network-tiles/13/0/0.mvt?v=${scopeTiles.revision}`)).status, 204, 'Empty tiles have no body')
  assert.equal((await api.fetch(`${base}/network-tiles/3/9/0.mvt`)).status, 400)
  assert.equal((await api.fetch(`${base}/network-tiles/13/${tile.x}/${tile.y}.mvt?scope=missing`)).status, 404)
  const feedTile = decodeTile(Buffer.from(await (await api.fetch(`${base}/network-tiles/13/${tile.x}/${tile.y}.mvt?scope=feed&v=${opened.networkTiles.feed.revision}`)).arrayBuffer()))
  assert(feedTile.routes.some((feature) => feature.properties.featureId === 'route-0'), 'A feed scope serves unscoped ids')
  console.log(JSON.stringify({ check: 'network-tiles', fullBytes: Buffer.byteLength(fullText), catalogBytes: Buffer.byteLength(catalogText), routes: served.routes.length, stops: served.stops.length }))
} finally {
  await api?.stop()
  await fs.rm(folder, { recursive: true, force: true })
}
