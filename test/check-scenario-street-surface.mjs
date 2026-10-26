import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { buildNationalOsmWalkStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { rasterNativeStreetSurface, disposeNativeRoutingKernel } from '../src/server/native-routing-kernel.mjs'

const profile = process.argv.includes('--profile')
const size = profile ? 80 : 14
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-surface-reuse-'))
const store = path.join(folder, 'street.sqlite')
const point = (x, y) => [-71 + x * 0.0005, 42 + y * 0.0005]
let randomState = 78431
const random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 2 ** 32)
function writeGraph() {
  const db = new DatabaseSync(store)
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY,lat REAL NOT NULL,lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL,to_node INTEGER NOT NULL,distance_m REAL NOT NULL,way_id INTEGER NOT NULL);
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY,lat REAL NOT NULL,lon REAL NOT NULL);
    CREATE TABLE drive_edges(from_node INTEGER,to_node INTEGER,distance_m REAL,travel_time_s REAL,way_id INTEGER,road_class INTEGER);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node); CREATE INDEX edges_to ON edges(to_node);
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat,lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node); CREATE INDEX drive_edges_to ON drive_edges(to_node);
    INSERT INTO metadata VALUES ('schemaVersion','"vigo.street.store.v6"'),('sourceModel','"pbf"'),('storageLayout','"walk-drive-role-tables-v2"'); BEGIN;`)
  const node = db.prepare('INSERT INTO walk_nodes VALUES (?,?,?)')
  const edge = db.prepare('INSERT INTO edges VALUES (?,?,?,?)')
  let edges = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const id = y * size + x, [lon, lat] = point(x, y)
    node.run(id, lat, lon)
    for (const [dx, dy, distance] of [[1, 0, 41.3], [0, 1, 55.7]]) {
      if (x + dx >= size || y + dy >= size) continue
      // Directed streets and a disconnected island exercise non-Euclidean reach.
      if (x === size - 3 && dx === 1) continue
      const to = id + dx + dy * size
      edge.run(id, to, distance, ++edges)
      if ((x + y) % 4 !== 0) edge.run(to, id, distance, ++edges)
    }
  }
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('nodeCount', String(size * size))
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('edgeCount', String(edges))
  db.exec('COMMIT'); db.close()
  assert.equal(buildNationalOsmWalkStore(store, { force: true, persist: true }).ready, true)
}
const seed = (x, y, durationMinutes) => ({ coordinate: point(x, y), durationMinutes })
const common = {
  bounds: [-71.001, 41.999, -71 + size * .0005, 42 + size * .0005],
  width: profile ? 256 : 64, height: profile ? 256 : 64,
  maxWalkKm: profile ? .65 : .19, walkSpeedKph: 4.8, maximumDurationMinutes: 30,
  includeNodes: true, includeEdges: true, edgeDetailLimit: 0, expandBoundsToReachedEdges: true,
}
function same(actual, expected, label) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert(actual === expected || Math.abs(actual - expected) <= 1e-8, `${label}: ${actual} != ${expected}`)
  } else if (Array.isArray(actual) || ArrayBuffer.isView(actual)) {
    assert.equal(actual.length, expected.length, `${label} length`)
    actual.forEach((value, index) => same(value, expected[index], `${label}[${index}]`))
  } else if (actual && typeof actual === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label} keys`)
    for (const key of Object.keys(actual)) same(actual[key], expected[key], `${label}.${key}`)
  } else assert.equal(actual, expected, label)
}
function semantic(result) {
  const { diagnostics, ...data } = result
  return { ...data, reachedEdges: diagnostics.reachedEdgeCount, reachedLength: diagnostics.reachedEdgeLengthKm }
}
function run(seeds, surfaceReuse, overrides = {}) {
  return rasterNativeStreetSurface(store, { ...common, seeds, surfaceReuse, ...overrides })
}
function parity(base, changed, overrides = {}, expectedReuse) {
  const baseline = run(base, 'baseline')
  assert(Number.isFinite(baseline.diagnostics.referenceBuildMs))
  assert(baseline.diagnostics.referenceBuildMs >= 0)
  const candidate = run(changed, 'scenario', overrides)
  const fresh = run(changed, undefined, overrides)
  assert.equal(candidate.diagnostics.referenceBuildMs, 0)
  assert.equal(fresh.diagnostics.referenceBuildMs, undefined)
  same(semantic(candidate), semantic(fresh), 'fresh/incremental')
  assert(candidate.diagnostics.reuseCacheBytes <= 32 * 1024 * 1024)
  if (expectedReuse !== undefined) assert.equal(candidate.diagnostics.reusedLabels > 0, expectedReuse)
  return { candidate, fresh }
}
try {
  writeGraph()
  if (profile) {
    const base = [seed(0, 0, 0), ...Array.from({ length: 240 }, () => seed(Math.floor(random() * (size - 3)), Math.floor(random() * size), 5 + random() * 17))]
    const changed = [...base, seed(3, 3, 2)]
    parity(base, changed, { includeNodes: false, includeEdges: false }, true)
    run(base, 'baseline', { includeNodes: false, includeEdges: false })
    const measurements = { fresh: [], incremental: [] }
    let fresh, incremental
    for (let i = 0; i < 12; i++) for (const mode of i % 2 ? ['fresh', 'incremental'] : ['incremental', 'fresh']) {
      const start = performance.now()
      const result = run(changed, mode === 'incremental' ? 'scenario' : undefined, { includeNodes: false, includeEdges: false })
      if (i >= 2) measurements[mode].push(performance.now() - start)
      if (mode === 'fresh') fresh = result; else incremental = result
    }
    same(semantic(incremental), semantic(fresh), 'profile parity')
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    console.log(JSON.stringify({ fixture: 'public synthetic directed grid', nodes: size * size, baselineSeeds: base.length, variant: 'one added seed', raster: 256,
      boundary: 'warm native call plus JS materialization; baseline retention excluded',
      freshMedianMs: median(measurements.fresh), incrementalMedianMs: median(measurements.incremental),
      freshSettledLabels: fresh.diagnostics.settledLabels, incrementalSettledLabels: incremental.diagnostics.settledLabels,
      reusedLabels: incremental.diagnostics.reusedLabels, reusedRaster: incremental.diagnostics.reusedRaster, retainedBytes: incremental.diagnostics.reuseCacheBytes, samples: measurements }, null, 2))
  } else {
    const base = [seed(0, 0, 0), seed(4, 4, 7), seed(8, 8, 9), seed(12, 10, 8)]
    const unchanged = parity(base, base, {}, true)
    assert.deepEqual(semantic(unchanged.candidate), semantic(unchanged.fresh), 'Unchanged cached float evidence must be bit-exact.')
    assert.equal(unchanged.candidate.diagnostics.reusedRaster, true)
    assert.equal(unchanged.candidate.diagnostics.settledLabels, 0)
    parity(base, [...base, seed(6, 6, 3)], {}, true)
    parity(base, base.map((s, i) => i === 1 ? { ...s, durationMinutes: 2 } : s), {}, true)
    parity(base, base.slice(0, -1), {}, false)
    parity(base, base.map((s, i) => i === 1 ? { ...s, durationMinutes: 20 } : s), {}, false)
    for (const override of [{ maxWalkKm: .3 }, { maximumDurationMinutes: 12 }, { walkSpeedKph: 3 }, { independentTerminalWalk: true }]) parity(base, base, override, false)
    const regridded = parity(base, base, { width: 32, height: 48, bounds: [-71, 42, -70.999, 42.001] }, true)
    assert.equal(regridded.candidate.diagnostics.reusedRaster, false, 'A changed grid must be rasterized anew.')
    const expanded = parity([base[0]], [...base.slice(0, 1), seed(12, 12, 2)], {}, true)
    assert.equal(expanded.candidate.diagnostics.reusedRaster, false, 'New reached extents must be rasterized anew.')
    // A cut must recover previously dominated seed paths rather than just delete labels.
    const dominated = [seed(0, 0, 0), seed(5, 5, 1), seed(5, 5, 12)]
    parity(dominated, [dominated[0], dominated[2]], {}, false)
    parity(base, [base[0], ...base.slice(1).reverse()], {}, true)
    parity(base, [], {}, false)
    assert.throws(() => run(base, 'invalid'), /reuse mode/)
    parity(base, base, {}, true)
    for (let n = 0; n < 120; n++) {
      const reference = [seed(0, 0, 0), ...Array.from({ length: 12 }, () => seed(Math.floor(random() * size), Math.floor(random() * size), 2 + random() * 24))]
      const changed = reference.map((s, i) => i && random() < .3 ? { ...s, durationMinutes: Math.max(0, s.durationMinutes - random() * 8) } : s)
      changed.push(seed(random() * (size - 1), random() * (size - 1), random() * 10))
      parity(reference, changed, n % 3 === 0 ? { includeEdges: false } : {})
    }
    disposeNativeRoutingKernel(store)
    const reopened = run(base, 'scenario')
    assert.equal(reopened.diagnostics.reusedLabels, 0)
    assert.equal(reopened.diagnostics.reuseCacheBytes, 0, 'Dropping the graph must release its reference state.')
    console.log('Scenario street surfaces: 120 seeded variants, additions, improvements, cuts, delays, ties, duplicates, reordered seeds, directed/disconnected streets, partial edges, grid changes and fallback parity passed.')
  }
} finally {
  disposeNativeRoutingKernel(store); disposeNationalOsmStore(store)
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
