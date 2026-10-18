// Same public source inputs, two compiler backends, one query runtime.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-compiler-city-parity-'))
const base = { serviceDate: '2026-07-15', time: '07:55', maxWalkKm: .2, requireTransitRide: true,
  origin: { stopId: 'A' }, destination: { stopId: 'B' } }
function query(collection, kind, request) {
  const input = { ...base, ...request }
  if (kind !== 'route') delete input.destination
  if (kind === 'matrix') delete input.origin
  const result = JSON.parse(execFileSync(standaloneBinary, [kind, '--city', collection, '--request', '-'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  }))
  // Build identity and per-request observations differ by construction. Keep
  // every semantic result field, geometry, schema and engine/scope marker.
  assert.equal(typeof result.meta.cityRevision, 'string')
  assert.match(result.meta.queryFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(typeof result.meta.requestId, 'string')
  assert(result.meta.computeUs >= 0)
  for (const key of ['cityRevision', 'queryFingerprint', 'requestId', 'computeUs']) delete result.meta[key]
  delete result.timing
  return result
}
function databaseContents(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'metadata' ORDER BY name").all()
    return Object.fromEntries(tables.map(({ name }) => {
      const q = value => '"' + value.replaceAll('"', '""') + '"'
      const columns = db.prepare(`PRAGMA table_info(${q(name)})`).all().map(c => q(c.name))
      return [name, db.prepare(`SELECT * FROM ${q(name)} ORDER BY ${columns.join(',')}`).all()]
    }))
  } finally { db.close() }
}
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(temporary)
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,shape_id\nR1,WKD,T1,0,S\nR2,WKD,T2,0,\n')
  zip.file('shapes.txt', 'shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\nS,0,38.900,-77.050\nS,1,38.903,-77.046\nS,2,38.905,-77.040\n')
  fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const calls = await zip.file('stop_times.txt').async('string')
  zip.file('stop_times.txt', calls.replaceAll('08:30:00', '08:37:00'))
  const changed = path.join(temporary, 'changed.zip')
  fs.writeFileSync(changed, await zip.generateAsync({ type: 'nodebuffer' }))
  const spec = path.join(temporary, 'scenarios.json')
  fs.writeFileSync(spec, JSON.stringify({ schemaVersion: 'vigo.scenarios.source.v1', name: 'Compiler parity', prepareDates: ['2026-07-15'],
    osm: { path: osmPath }, scenarios: [
      { id: 'base', feeds: [{ path: gtfsPath, scope: 'fixture' }] },
      { id: 'changed', feeds: [{ path: changed, scope: 'fixture' }] },
    ] }))
  const cities = {}
  for (const backend of ['js', 'rust']) {
    // Exercise handle transfer, scoped multi-feed merges, source rejection and
    // interrupted-build cleanup under both selectors, using the retained suite.
    execFileSync(process.execPath, ['test/check-city-build-equivalence.mjs'], {
      cwd: root, env: { ...process.env, VIGO_GTFS_CONNECTION_COMPILER: backend },
      stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000,
    })
    cities[backend] = path.join(temporary, backend)
    execFileSync(process.execPath, ['public/vigo.mjs', 'build-scenarios', '--spec', spec, '--output', cities[backend]], {
      cwd: root, env: { ...process.env, VIGO_GTFS_CONNECTION_COMPILER: backend },
      stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    })
  }
  let count = 0
  for (const scenarioId of ['base', 'changed']) {
    const database = backend => path.join(cities[backend], 'cities', scenarioId, 'routing', 'project.sqlite')
    assert.deepEqual(databaseContents(database('rust')), databaseContents(database('js')), `${scenarioId}: all routing tables`)
    const requests = [
      ['route', {}],
      ['route', { time: '09:00', timePreference: 'arrive_by' }],
      ['route', { origin: base.destination, destination: base.origin }],
      ['route', { mode: 'walk', requireTransitRide: false, maxWalkKm: 5, origin: { coordinate: [-77.049, 38.9005] }, destination: { coordinate: [-77.031, 38.9095] } }],
      ['matrix', { origins: [base.origin, base.destination], destinations: [base.destination], includeJourneys: true }],
      ['reach', { requireTransitRide: undefined, cutoffsMinutes: [45], rasterSize: 16, bounds: [-77.06, 38.89, -77.02, 38.92], reachFormat: 'map' }],
    ]
    for (const [kind, request] of requests) {
      const expected = query(cities.js, kind, { ...request, scenarioId })
      const actual = query(cities.rust, kind, { ...request, scenarioId })
      assert.deepEqual(actual, expected, `${scenarioId}: ${kind} ${JSON.stringify(request)}`)
      if (kind === 'route' && !Object.keys(request).length) {
        assert.equal(actual.status, 'ok')
        assert.equal(actual.journey.arrivalTime, scenarioId === 'base' ? '08:30:00' : '08:37:00')
        assert(actual.journey.legs.some(leg => leg.type === 'transit' && leg.quality.geometry === 'gtfs_shape'), 'Fixture must exercise source shape geometry')
      }
      count++
    }
  }
  console.log(`Compiler City parity: complete routing tables and ${count} public Route/Matrix/Reach results including geometry and changed scenarios passed.`)
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
