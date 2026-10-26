import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeBasemapFixture } from './helpers/basemap-fixture.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { localBasemapBudgets, readLocalBasemap } from '../src/server/local-basemap-store.mjs'
import { coastGeometryLimits, containsPoint, oceanPolygons, nearestCoastSide } from '../src/server/local-basemap-geometry.mjs'
import { renderNativeLocalBasemapTile } from '../src/server/native-routing-kernel.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-local-map-'))
const store = path.join(folder, 'street.sqlite')
const bounds = { west: -0.1, south: -0.08, east: 0.06, north: 0.08 }
const covers = (geometry, point) => containsPoint(geometry.coordinates[0], point) && !geometry.coordinates.slice(1).some((ring) => containsPoint(ring, point))

// Minimal MVT 2.1 reader: one layer, string values, MoveTo/LineTo/ClosePath.
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
    else if (wire === 2) { const length = readVarint(bytes, state); visit(field, bytes.subarray(state.position, state.position + length)); state.position += length }
    else throw new Error(`Unexpected protobuf wire type ${wire}`)
  }
}
function readPacked(bytes) { const values = [], state = { position: 0 }; while (state.position < bytes.length) values.push(readVarint(bytes, state)); return values }
function decodeTile(buffer) {
  const layers = []
  readMessage(buffer, (field, layerBytes) => {
    if (field !== 3) return
    const layer = { name: '', extent: 4096, version: 1, keys: [], values: [], features: [] }
    readMessage(layerBytes, (key, value) => {
      if (key === 1) layer.name = Buffer.from(value).toString()
      else if (key === 15) layer.version = value
      else if (key === 5) layer.extent = value
      else if (key === 3) layer.keys.push(Buffer.from(value).toString())
      else if (key === 4) readMessage(value, (valueField, text) => { if (valueField === 1) layer.values.push(Buffer.from(text).toString()) })
      else if (key === 2) {
        const feature = { tags: [], type: 0, geometry: [] }
        readMessage(value, (featureField, data) => {
          if (featureField === 2) feature.tags = readPacked(data)
          else if (featureField === 3) feature.type = data
          else if (featureField === 4) feature.geometry = readPacked(data)
        })
        layer.features.push(feature)
      }
    })
    layers.push(layer)
  })
  return layers.map((layer) => ({ ...layer, features: layer.features.map((feature) => {
    const properties = {}
    for (let i = 0; i < feature.tags.length; i += 2) properties[layer.keys[feature.tags[i]]] = layer.values[feature.tags[i + 1]]
    const parts = []
    let x = 0, y = 0, part = null
    for (let i = 0; i < feature.geometry.length;) {
      const command = feature.geometry[i] & 7, count = feature.geometry[i] >> 3
      i += 1
      if (command === 7) { part?.push(part[0]); continue }
      for (let n = 0; n < count; n += 1, i += 2) {
        const dx = feature.geometry[i], dy = feature.geometry[i + 1]
        x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1)
        if (command === 1) { part = []; parts.push(part) }
        part.push([x, y])
      }
    }
    return { properties, type: feature.type, parts }
  }) }))
}
const ringArea = (ring) => ring.slice(1).reduce((sum, point, i) => sum + ring[i][0] * point[1] - point[0] * ring[i][1], 0) / 2
function tileFor([lon, lat], z) {
  const scale = 2 ** z, radians = lat * Math.PI / 180
  const mercatorX = (lon + 180) / 360 * scale, mercatorY = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * scale
  return { z, x: Math.floor(mercatorX), y: Math.floor(mercatorY), point: [(mercatorX - Math.floor(mercatorX)) * 4096, (mercatorY - Math.floor(mercatorY)) * 4096] }
}
async function tileCovers(storePath, point, kind) {
  const tile = tileFor(point, 15)
  const [layer] = decodeTile(await renderNativeLocalBasemapTile(storePath, tile.z, tile.x, tile.y))
  for (const feature of layer?.features ?? []) {
    if (feature.type !== 3 || feature.properties.kind !== kind) continue
    // Exterior rings have positive area in tile space; holes are negative.
    let inside = false
    for (const ring of feature.parts) {
      if (ringArea(ring) > 0 && inside) return true
      if (ringArea(ring) > 0) inside = containsPoint(ring, tile.point)
      else if (inside && containsPoint(ring, tile.point)) inside = false
    }
    if (inside) return true
  }
  return false
}
let api
try {
  const pbfPath = path.join(folder, 'fixture.pbf')
  writeBasemapFixture(pbfPath)
  const built = await buildNationalOsmStore({ pbfPath, outputPath: store, buildDrivingProfile: true })
  assert.equal(built.localBasemap.skippedRelations, 0)
  assert.equal(built.localBasemap.counts.water, 2, 'Unordered untagged members must form a second lake')
  const detailed = readLocalBasemap(store, bounds, { zoom: 15 })
  assert.equal(detailed.metadata.status, 'ready')
  assert.deepEqual([...new Set(detailed.features.filter((f) => f.properties.kind === 'road').map((f) => f.properties.roadClass))].sort(),
    ['motorway', 'primary', 'secondary', 'tertiary'], 'Do not render residential, service or footway routing edges')
  assert(detailed.features.some((f) => f.properties.kind === 'river'))
  const lakes = detailed.features.filter((f) => f.properties.kind === 'water')
  assert(lakes.some((f) => covers(f.geometry, [-0.09, -0.03])))
  assert(!lakes.some((f) => covers(f.geometry, [-0.08, -0.03])), 'Keep the island in the lake dry')
  const oceans = detailed.features.filter((f) => f.properties.kind === 'ocean')
  assert(oceans.some((f) => covers(f.geometry, [0.01, 0.03])), 'The sea is on the right of a northbound coast')
  assert(!oceans.some((f) => covers(f.geometry, [-0.01, 0.03])), 'Do not flood the mainland')
  assert(!oceans.some((f) => covers(f.geometry, [0.03, 0])), 'Keep coastal islands dry')
  const overview = readLocalBasemap(store, bounds, { zoom: 7 })
  assert(overview.features.filter((f) => f.properties.kind === 'road').every((f) => f.properties.roadClass === 'motorway'))
  const offshore = readLocalBasemap(store, { west: 0.006, east: 0.015, south: 0.02, north: 0.03 }, { zoom: 15 })
  assert(offshore.features.some((f) => f.properties.kind === 'ocean'), 'Wholly offshore views need water even without an intersecting coast')
  const inland = readLocalBasemap(store, { west: -0.015, east: -0.005, south: 0.06, north: 0.07 }, { zoom: 15 })
  assert(!inland.features.some((f) => f.properties.kind === 'ocean'))
  const limited = readLocalBasemap(store, bounds, { zoom: 15, limit: 3 })
  assert(limited.features.length <= 3 && limited.metadata.sampled)
  assert(detailed.metadata.vertexCount <= localBasemapBudgets.vertices)
  assert.equal(oceanPolygons([[[0, -0.02], [0, 0.02]]], bounds).complete, false, 'Never close an incomplete interior coastline across land')
  // Two disconnected pieces of mainland create two coastal crossings. Compare
  // the filled sea to explicit dry rectangles, including clockwise boundary joins.
  const coastalBox = { west: -2, south: -2, east: 2, north: 2 }
  const shores = [[[-3, -0.5], [-0.5, -0.5], [-0.5, 3]], [[0.5, 3], [0.5, 0.5], [3, 0.5]]]
  const sea = oceanPolygons(shores, coastalBox, nearestCoastSide(shores, [-1.99, -1.99]))
  assert(sea.complete)
  for (const point of [[-1,-1],[0,0],[1,-1]]) assert(sea.polygons.some((coordinates) => covers({ coordinates }, point)), `Sea must cover ${point}`)
  for (const point of [[-1,1],[1,1]]) assert(!sea.polygons.some((coordinates) => covers({ coordinates }, point)), `Land must remain dry at ${point}`)
  // A valid input budget can still produce far more clipped pieces. Previously
  // this near-limit shore caused quadratic work and stalled the API for seconds.
  const intricateCoast = []
  for (let offset = 0; offset < 78_998; offset += 126) {
    const line = []
    for (let i = offset; i <= Math.min(offset + 126, 78_998); i += 1) line.push([i % 2 ? 0.0001 : -0.0001, 0.99 - i / 79_000 * 0.98])
    intricateCoast.push(line)
  }
  assert(intricateCoast.length < localBasemapBudgets.coastFeatures)
  assert(intricateCoast.reduce((sum, line) => sum + line.length, 0) < localBasemapBudgets.coastVertices)
  const guardedCoast = oceanPolygons(intricateCoast, { west: 0, south: 0, east: 1, north: 1 })
  assert.equal(guardedCoast.complete, false)
  assert.equal(guardedCoast.limited, true)
  assert.equal(guardedCoast.polygons.length, 0, 'Do not fill a coast after dropping geometry')
  assert.equal(guardedCoast.outlines.length, coastGeometryLimits.pieces)
  assert(guardedCoast.outlines.reduce((sum, line) => sum + line.length, 0) <= coastGeometryLimits.vertices)
  const inlets = Array.from({ length: 1_000 }, (_, i) => {
    const y = 0.999 - i * 0.0009
    return [[-0.01, y], [0.01, y - 0.0002], [-0.01, y - 0.0004]]
  })
  const joinedInlets = oceanPolygons(inlets, { west: 0, south: 0, east: 1, north: 1 })
  assert(joinedInlets.complete && !joinedInlets.limited)
  assert.equal(joinedInlets.polygons.length, inlets.length, 'Boundary joins must retain separate small coastal inlets')
  const sourceDb = new DatabaseSync(store, { readOnly: true })
  const routingCounts = Object.fromEntries(['edges', 'drive_edges'].map((table) => [table, sourceDb.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]))
  assert(routingCounts.edges > 0 && routingCounts.drive_edges > 0, 'The cartographic filter must not remove routing edges')
  assert(!sourceDb.prepare("SELECT name FROM sqlite_schema WHERE name IN ('map_members','map_relations','map_ways')").get(), 'Drop compiler-only map tables')
  const queryPlan = sourceDb.prepare('EXPLAIN QUERY PLAN SELECT id FROM map_features_rtree WHERE west<=? AND east>=? AND south<=? AND north>=? AND min_lod<=? AND max_lod>=?').all(1, -1, 1, -1, 2, 2)
  assert(queryPlan.some((row) => /VIRTUAL TABLE INDEX/.test(row.detail)))
  sourceDb.close()
  compactNationalOsmRuntimeStore(store)
  assert.deepEqual(readLocalBasemap(store, bounds, { zoom: 15 }), detailed, 'Map geometry must survive sealing the routing store')
  disposeNationalOsmStore(store)
  // Prove map queries never load the pedestrian/drive snapshot.
  for (const file of await fs.readdir(folder)) if (file.endsWith('.bin')) await fs.unlink(path.join(folder, file))
  assert.deepEqual(readLocalBasemap(store, bounds, { zoom: 15 }), detailed)
  const legacy = new DatabaseSync(path.join(folder, 'legacy.sqlite'))
  legacy.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);'); legacy.close()
  assert.equal(readLocalBasemap(path.join(folder, 'legacy.sqlite'), bounds).metadata.status, 'needs-import')
  // Rust vector tiles keep every cartographic guarantee of the viewport reader.
  assert.equal((await renderNativeLocalBasemapTile(path.join(folder, 'legacy.sqlite'), 15, 16383, 16383)).length, 0, 'Legacy stores draw empty tiles')
  assert(await tileCovers(store, [-0.09, -0.03], 'water'), 'Tiles draw the lake')
  assert(!await tileCovers(store, [-0.08, -0.03], 'water'), 'Tiles keep the island in the lake dry')
  assert(await tileCovers(store, [0.01, 0.03], 'ocean'), 'Tiles put the sea on the right of a northbound coast')
  assert(!await tileCovers(store, [-0.01, 0.03], 'ocean'), 'Tiles do not flood the mainland')
  assert(!await tileCovers(store, [0.03, 0], 'ocean'), 'Tiles keep coastal islands dry')
  assert(await tileCovers(store, [0.0105, 0.025], 'ocean'), 'Wholly offshore tiles need water without an intersecting coast')
  assert(!await tileCovers(store, [-0.01, 0.065], 'ocean'))
  const tileKinds = new Set(), tileRoadClasses = new Set()
  const [northWest, southEast] = [tileFor([bounds.west, bounds.north], 13), tileFor([bounds.east, bounds.south], 13)]
  let tileCount = 0
  for (let x = northWest.x; x <= southEast.x; x += 1) for (let y = northWest.y; y <= southEast.y; y += 1) {
    const bytes = await renderNativeLocalBasemapTile(store, 13, x, y)
    if (!bytes.length) continue
    const [layer] = decodeTile(bytes)
    assert.equal(layer.name, 'basemap'); assert.equal(layer.version, 2); assert.equal(layer.extent, 4096)
    assert(layer.features.length <= localBasemapBudgets.features)
    for (const feature of layer.features) {
      tileKinds.add(feature.properties.kind)
      if (feature.properties.roadClass) tileRoadClasses.add(feature.properties.roadClass)
      if (feature.type === 3) assert(ringArea(feature.parts[0]) > 0, 'MVT exterior rings wind clockwise in tile space')
      for (const part of feature.parts) for (const [px, py] of part) assert(px >= -64 && px <= 4160 && py >= -64 && py <= 4160, 'Clip to the tile buffer')
    }
    tileCount += 1
  }
  assert(tileCount > 0)
  assert.deepEqual([...tileRoadClasses].sort(), ['motorway', 'primary', 'secondary', 'tertiary'], 'Tiles keep only main roads')
  for (const kind of ['road', 'river', 'water', 'ocean']) assert(tileKinds.has(kind), `Tiles carry ${kind}`)
  api = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'), environment: {
    VIGO_CONFIG_DIR: path.join(folder, 'config'), VIGO_PROJECTS_DIR: path.join(folder, 'cities'),
  } })
  const request = async (url, method = 'GET', body, status = 200) => {
    const response = await api.fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  assert.equal((await request('/api/config')).config.basemap, 'offline', 'New installations start without external tile requests')
  const { project } = await request('/api/projects', 'POST', { name: 'Local basemap fixture' }, 201)
  const base = `/api/projects/${project.id}`
  let { job } = await request(`${base}/national-osm-import`, 'POST', { sourcePath: pbfPath }, 202)
  const deadline = Date.now() + 30_000
  while (['running', 'queued'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    job = (await request(`${base}/national-gtfs-job?jobId=${job.id}`)).job
  }
  assert.equal(job.status, 'complete', JSON.stringify(job))
  const served = await request(`${base}/local-basemap?west=-0.1&south=-0.08&east=0.06&north=0.08&zoom=15&limit=4500`)
  assert.deepEqual(served.features, detailed.features, 'Serve retained cartography through the real import worker and API')
  const ocean = tileFor([0.01, 0.03], 15)
  const tileResponse = await api.fetch(`${base}/basemap-tiles/15/${ocean.x}/${ocean.y}.mvt?v=fixture`)
  assert.equal(tileResponse.status, 200)
  assert.equal(tileResponse.headers.get('content-type'), 'application/vnd.mapbox-vector-tile')
  assert.match(tileResponse.headers.get('cache-control'), /immutable/, 'Versioned tiles are immutable')
  assert(Buffer.from(await tileResponse.arrayBuffer()).equals(await renderNativeLocalBasemapTile(store, 15, ocean.x, ocean.y)), 'Serve the same tile through the real import worker and API')
  assert.equal((await api.fetch(`${base}/basemap-tiles/15/0/0.mvt`)).status, 204, 'Empty tiles have no body')
  assert.equal((await api.fetch(`${base}/basemap-tiles/3/9/0.mvt`)).status, 400)
  await request(`${base}/local-streets?west=-0.1&south=-0.08&east=0.06&north=0.08`, 'GET', null, 404)
  await request(`${base}/local-basemap?west=-0.1&south=-0.08&east=0.06`, 'GET', null, 400)
  await request(`${base}/local-basemap?west=200&south=0&east=201&north=1`, 'GET', null, 400)
  await request('/api/config', 'PATCH', { basemap: 'streets' })
  assert.equal((await request('/api/config')).config.basemap, 'streets', 'Keep explicit online preferences available')
  console.log(JSON.stringify({ status: 'passed', features: detailed.features.length, vertices: detailed.metadata.vertexCount,
    payloadBytes: Buffer.byteLength(JSON.stringify(detailed)), routingCounts, offlineWater: true, snapshotIndependent: true, boundedViewport: true, vectorTiles: tileCount }))
} finally {
  await api?.stop()
  disposeNationalOsmStore(store)
  disposeNationalOsmStore(path.join(folder, 'legacy.sqlite'))
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
