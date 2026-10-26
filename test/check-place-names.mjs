import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeOsmFixture } from './helpers/basemap-fixture.mjs'
import { buildNationalOsmStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { describeNativePlaces } from '../src/server/native-routing-kernel.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

// Place names for map clicks: written by the OSM importer, read by the Rust
// describer and served per City.
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-place-names-'))
const pbfPath = path.join(folder, 'places.osm.pbf')
const store = path.join(folder, 'street.sqlite')
let api
try {
  writeOsmFixture(pbfPath, ({ way }) => {
    way([[-0.004, 0], [0, 0], [0.003, 0], [0.004, 0]], { highway: 'primary', name: 'Massachusetts Avenue' })
    way([[0, -0.004], [0, 0], [0, 0.004]], { highway: 'secondary', name: 'Tremont Street' })
    way([[0.003, -0.004], [0.003, 0], [0.003, 0.004]], { highway: 'residential', name: 'Shawmut Street' })
    way([[-0.002, -0.004], [-0.002, 0.004]], { highway: 'primary', name: 'Under Tunnel', tunnel: 'yes' })
    way([[0.0007, 0.0015], [0.0023, 0.0015]], { highway: 'footway', name: 'Park Path' })
    way([[0.0005, 0.0005], [0.0025, 0.0005], [0.0025, 0.0025], [0.0005, 0.0025], [0.0005, 0.0005]], { leisure: 'park', name: 'Titus Sparrow Park' })
    way([[-0.003, 0.001], [-0.002, 0.001], [-0.002, 0.002], [-0.003, 0.001]], { leisure: 'park' })
  })
  const points = [
    [0.00005, 0.00005], // the corner
    [-0.0015, 0.0002], // along Massachusetts Avenue, above the tunnel's line
    [0.0015, 0.0016], // in the park, beside its path
    [5, 5], // nowhere
  ]
  const expected = ['Massachusetts Ave & Tremont St', 'Massachusetts Ave near Tremont St', 'Titus Sparrow Park', null]
  const labels = (places) => places.map((place) => place?.label ?? null)

  await buildNationalOsmStore({ pbfPath, outputPath: store, buildDrivingProfile: false })
  disposeNationalOsmStore(store)
  const database = new DatabaseSync(store, { readOnly: true })
  const counts = {
    streets: database.prepare('SELECT count(*) AS n FROM place_streets').get().n,
    areas: database.prepare('SELECT count(*) AS n FROM place_areas').get().n,
  }
  database.close()
  assert.deepEqual(counts, { streets: 3, areas: 1 }, 'Import named streets and the named park; skip paths, tunnels and unnamed ways')
  const imported = await describeNativePlaces(store, '', points)
  assert.deepEqual(labels(imported), expected)
  assert.deepEqual(imported[0], { label: expected[0], kind: 'intersection' })

  // Warm lookups stay in microseconds per point.
  const many = Array.from({ length: 2000 }, (_, i) => [-0.004 + (i % 50) * 0.00016, -0.004 + Math.floor(i / 50) * 0.0002])
  const started = performance.now()
  const described = await describeNativePlaces(store, '', many)
  const elapsedMs = performance.now() - started
  assert.equal(described.length, many.length)
  assert(elapsedMs < 200, `2,000 warm lookups took ${elapsedMs.toFixed(1)} ms`)

  api = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'), environment: {
    VIGO_CONFIG_DIR: path.join(folder, 'config'), VIGO_PROJECTS_DIR: path.join(folder, 'cities'),
  } })
  const request = async (url, status = 200, method = 'GET', body) => {
    const response = await api.fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  const { project } = await request('/api/projects', 201, 'POST', { name: 'Place names fixture' })
  const base = `/api/projects/${project.id}`
  assert.deepEqual(await request(`${base}/place?points=0.00005,0.00005`), { places: [null] }, 'A City without data names nothing')
  let { job } = await request(`${base}/national-osm-import`, 202, 'POST', { sourcePath: pbfPath })
  const deadline = Date.now() + 30_000
  while (['running', 'queued'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    job = (await request(`${base}/national-gtfs-job?jobId=${job.id}`)).job
  }
  assert.equal(job.status, 'complete', JSON.stringify(job))
  assert.deepEqual(await request(`${base}/place`), { places: [] }, 'No points only warms the index')
  const served = await request(`${base}/place?points=${points.map((point) => point.join(',')).join(';')}`)
  assert.deepEqual(labels(served.places), expected, 'Serve the same names through the real import and API')
  await request(`${base}/place?points=0,0;1`, 400)
  await request(`${base}/place?points=200,0`, 400)
  await request(`${base}/place?points=,0`, 400)
  await request(`${base}/place?points=${Array.from({ length: 257 }, () => '0,0').join(';')}`, 400)
  console.log(JSON.stringify({ status: 'passed', ...counts, warmLookupsPerMs: Math.round(many.length / elapsedMs) }))
} finally {
  await api?.stop()
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
