import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeBasemapFixture } from './helpers/basemap-fixture.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { localBasemapBudgets, readLocalBasemap } from '../src/server/local-basemap-store.mjs'
import { coastGeometryLimits, containsPoint, oceanPolygons, nearestCoastSide } from '../src/server/local-basemap-geometry.mjs'
import { localBasemapViewport } from '../src/map/localBasemapViewport.ts'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-local-map-'))
const store = path.join(folder, 'street.sqlite')
const bounds = { west: -0.1, south: -0.08, east: 0.06, north: 0.08 }
const covers = (geometry, point) => containsPoint(geometry.coordinates[0], point) && !geometry.coordinates.slice(1).some((ring) => containsPoint(ring, point))
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
  const viewport = localBasemapViewport({ ...bounds, zoom: 12.2 }, null)
  assert.equal(localBasemapViewport({ ...bounds, west: bounds.west + 0.001, east: bounds.east + 0.001, zoom: 12.8 }, viewport), null, 'Reuse the buffered viewport for small pans')
  assert(localBasemapViewport({ ...bounds, zoom: 13 }, viewport), 'Refresh when entering a new detail level')
  assert.equal(localBasemapViewport({ ...bounds, west: bounds.west + 360, east: bounds.east + 360, zoom: 12.2 }, viewport), null, 'Reuse geometry in repeated map worlds')
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
  await request(`${base}/local-streets?west=-0.1&south=-0.08&east=0.06&north=0.08`, 'GET', null, 404)
  await request(`${base}/local-basemap?west=-0.1&south=-0.08&east=0.06`, 'GET', null, 400)
  await request(`${base}/local-basemap?west=200&south=0&east=201&north=1`, 'GET', null, 400)
  await request('/api/config', 'PATCH', { basemap: 'streets' })
  assert.equal((await request('/api/config')).config.basemap, 'streets', 'Keep explicit online preferences available')
  console.log(JSON.stringify({ status: 'passed', features: detailed.features.length, vertices: detailed.metadata.vertexCount,
    payloadBytes: Buffer.byteLength(JSON.stringify(detailed)), routingCounts, offlineWater: true, snapshotIndependent: true, boundedViewport: true }))
} finally {
  await api?.stop()
  disposeNationalOsmStore(store)
  await fs.rm(folder, { recursive: true, force: true })
}
