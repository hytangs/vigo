// Optional street modes must not allocate a bicycle/drive graph for transit,
// change transit answers, or write caches while reading a prepared City.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-transit-isolation-'))
function inventory(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative)).sort().flatMap(name => {
    const file = path.join(relative, name), full = path.join(directory, file)
    if (fs.statSync(full).isDirectory()) return inventory(directory, file)
    const bytes = fs.readFileSync(full)
    return [{ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
  })
}
function semantic(result) {
  return Object.fromEntries(['status', 'reason', 'journey', 'durationsSeconds', 'distancesMeters',
    'surface', 'stops', 'layout', 'percentiles', 'reachableSamples', 'sampling', 'cutoffsSeconds']
    .filter(key => key in result).map(key => [key, result[key]]))
}
const a = { stopId: 'A' }, b = { stopId: 'B' }, x = { stopId: 'X' }
const common = { mode: 'transit', serviceDate: '2026-07-15', timeMinutes: 475,
  maxWalkKm: .2, requireTransitRide: true, diagnostics: 'trace' }
const matrix = { ...common, kind: 'matrix', origins: [a, x, b], destinations: [b, a] }
const reach = { ...common, requireTransitRide: undefined, kind: 'reach', origin: a, rasterSize: 32,
  bounds: [-77.055, 38.895, -77.025, 38.915], reachFormat: 'surface', cutoffsMinutes: [45],
  includeStreetEdges: false, includeNodes: false }
const monteCarlo = { startMinutes: 475, endMinutes: 486, draws: 22, seed: 42, percentiles: [5, 50, 95] }
const queries = [
  { ...common, kind: 'route', origin: a, destination: b },
  { ...common, kind: 'route', origin: a, destination: b, timeMinutes: 510, timePreference: 'arrive_by' },
  { ...common, kind: 'route', origin: [-77.0499, 38.9], destination: [-77.0301, 38.91] },
  { ...common, kind: 'route', origin: b, destination: a },
  matrix,
  { ...matrix, timeMinutes: 510, timePreference: 'arrive_by' },
  reach,
  { ...reach, surfaceSampling: 'cell-center' },
  { ...reach, surfaceSampling: 'cell-center', origin: undefined, destination: b,
    timeMinutes: 510, timePreference: 'arrive_by' },
  { ...matrix, timeMinutes: undefined, monteCarlo },
  { ...reach, timeMinutes: undefined, rasterSize: 16, monteCarlo },
]
let reference, walkingReference
try {
  const inputs = await writeCliFixtureInputs(directory)
  for (const [name, modes] of [['walk', 'walk'], ['default', null], ['bike', 'walk,drive,bike']]) {
    const city = path.join(directory, name)
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`,
      `--osm=${inputs.osmPath}`, ...(modes ? [`--street-modes=${modes}`] : []), `--output=${city}`],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
    const db = new DatabaseSync(path.join(city, 'osm/street-index.sqlite'), { readOnly: true })
    const bikeTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bike_%'").all()
    assert.equal(bikeTables.length > 0, name === 'bike', 'Bicycle data must be opt-in')
    const walking = db.prepare("SELECT key,value FROM metadata WHERE key IN ('nodeCount','edgeCount','walkNodeCount','wayCount') ORDER BY key").all()
    db.close()
    if (walkingReference) assert.deepEqual(walking, walkingReference, 'Optional modes must preserve pedestrian counts')
    else walkingReference = walking
    const before = inventory(city)
    const requests = [{ kind: 'info' }, ...[0, 1].flatMap(() =>
      queries.flatMap(query => [query, { kind: 'info' }]))]
    // Without preparation on opening, so the ledger shows what transit loads.
    const run = spawnSync(binary, ['stream', '--city', city], {
      input: requests.map(q => JSON.stringify(q)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, VIGO_PREPARE: 'none' },
    })
    assert.equal(run.status, 0, run.stderr)
    const replies = run.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(replies.length, requests.length)
    const results = []
    replies.forEach((reply, i) => {
      assert(['ok', 'not_found'].includes(reply.status), JSON.stringify(reply))
      if (requests[i].kind === 'info') {
        assert.equal(reply.memory.ledger.bike, null, 'Transit must not load the bicycle graph')
        assert.equal(reply.memory.driveLoaded, false, 'Ordinary transit must not load the drive graph')
        assert.equal(reply.memory.ledger.drive, null)
      } else results.push(semantic(reply))
    })
    assert.equal(results[0].status, 'ok')
    assert.deepEqual(results[0].journey.legs.filter(leg => leg.type === 'transit').map(leg => leg.trip.id),
      ['T1', 'T2'], 'Exercise an actual transit transfer')
    assert.equal(results[3].status, 'not_found', 'Keep blocked requests distinct from errors')
    assert.deepEqual(results.slice(queries.length), results.slice(0, queries.length), 'Repeated answers')
    if (reference) assert.deepEqual(results, reference, 'Optional modes must preserve transit answers')
    else reference = results
    assert.deepEqual(inventory(city), before, 'Transit queries must not add or rewrite prepared files')
  }
  console.log('Transit isolation: 66 Route/Matrix/Reach/Monte Carlo results unchanged across walk/default/bike Cities; no bike/drive graph loaded; prepared files unchanged.')
} finally {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
