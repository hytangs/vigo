// Node is the development fixture builder only. Every query executes the Rust
// binary with no PATH or NODE_PATH, against a portable, public synthetic City.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-rust-check-'))
const city = path.join(directory, 'city')
const env = { PATH: '', NODE_PATH: '', VIGO_API_TOKEN: 'standalone-test-token-12345', RAYON_NUM_THREADS: '2' }
const base = { requireTransitRide: true, serviceDate: '2026-07-15', time: '07:55', origin: { stopId: 'A' }, destination: { stopId: 'B' }, maxWalkKm: 0.2 }
let count = 0
let server
const invoke = (kind, request, extra = []) => spawnSync(binary, [kind, '--city', city, ...(kind === 'info' ? [] : ['--request', '-']), ...extra], { input: JSON.stringify({ ...(['route', 'matrix'].includes(kind) ? { requireTransitRide: true } : {}), ...request, diagnostics: "trace" }), env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
function run(kind, request) {
  const p = invoke(kind, request)
  assert.equal(p.status, 0, p.stderr)
  count++
  const result = JSON.parse(p.stdout)
  return result.trace ?? result
}
function rejects(kind, request, pattern) {
  const p = invoke(kind, request)
  assert.equal(p.status, 2)
  assert.match(p.stderr, pattern)
  count++
}
function fingerprint(directory) {
  const hash = crypto.createHash('sha256')
  const visit = location => {
    for (const name of fs.readdirSync(location).sort()) {
      const file = path.join(location, name)
      if (fs.statSync(file).isDirectory()) visit(file)
      else { hash.update(path.relative(directory, file)); hash.update(fs.readFileSync(file)) }
    }
  }
  visit(directory)
  return hash.digest('hex')
}
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, [path.join(root, 'public/vigo.mjs'), 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  const original = fingerprint(city)
  assert.equal(run('info', {}).schema, 'vigo.info.v1')
  const forward = run('route', base)
  assert.equal(forward.status, 'ready')
  assert.equal(forward.diagnostics.native.journeys, null, 'Route diagnostics must not duplicate the materialized journey')
  assert.equal(forward.arrivalMinutes, 510)
  assert.deepEqual(forward.legs.filter(l => l.kind === 'ride').map(l => l.tripId), ['T1', 'T2'])
  assert.equal(run('route', { ...base, time: '08:30', timePreference: 'arrive_by' }).departureMinutes, 480)
  assert.equal(run('route', { ...base, maxTransfers: 0 }).status, 'blocked')
  assert.equal(run('route', { ...base, minimumTransferBufferMinutes: 6 }).status, 'blocked')
  assert.equal(run('route', { ...base, minimumTransferBufferMinutes: 5, allowStreetTransfers: false }).status, 'ready')
  assert.equal(run('route', { ...base, serviceDate: '2026-07-19' }).status, 'blocked')
  const coordinate = { ...base, origin: { coordinate: [-77.05, 38.9] }, destination: { coordinate: [-77.03, 38.91] } }
  assert.equal(run('route', coordinate).arrivalMinutes, forward.arrivalMinutes)
  assert.equal(run('route', { ...coordinate, disableCache: true }).arrivalMinutes, forward.arrivalMinutes)
  for (const timePreference of ['depart_at', 'arrive_by']) {
    const noAccess = { ...coordinate, timePreference, time: '08:30', maxWalkKm: .01,
      origin: { coordinate: [-77.0498, 38.9001] }, destination: { coordinate: [-77.0495, 38.90025] } }
    const transit = run('route', { ...noAccess, requireTransitRide: true })
    assert.equal(transit.status, 'blocked')
    assert.equal(transit.reason, 'no_access')
    assert.equal(transit.diagnostics.native.scannedDepartures, 0, 'Empty access cannot board transit')
    const fallback = run('route', { ...noAccess, requireTransitRide: false })
    assert.equal(fallback.status, 'ready', 'No transit access must still allow the requested direct-walk comparison')
    assert.equal(fallback.mode, 'walk')
  }
  const walk = run('route', { ...coordinate, mode: 'walk' })
  const drive = run('route', { ...coordinate, mode: 'drive' })
  assert.equal(walk.status, 'ready')
  assert.equal(drive.status, 'ready')
  assert(drive.durationMinutes < walk.durationMinutes)
  assert.equal(run('route', { ...coordinate, requireTransitRide: false }).mode, 'walk')
  assert.equal(run('route', { ...coordinate, mode: 'walk', via: [{ stopId: 'X' }] }).segments.length, 2)
  for (const timePreference of ['depart_at', 'arrive_by']) {
    const via = run('route', { ...coordinate, mode: 'transit', via: [{ stopId: 'X' }],
      timePreference, time: timePreference === 'arrive_by' ? '08:30' : base.time, requireTransitRide: false })
    assert.equal(via.status, 'ready')
    assert(via.segments.every(segment => segment.legs.some(leg => leg.kind === 'ride')),
      'Ordered Transit requires a boarding on each leg, including when point defaults allow walking.')
  }
  assert(run('route', { ...base, windowMinutes: 10 }).choices.length > 0)
  const matrix = run('matrix', { serviceDate: base.serviceDate, time: base.time, origins: [base.origin, { stopId: 'X' }], destinations: [base.destination], maxWalkKm: .2, includeJourneys: true })
  assert.deepEqual(matrix.durationsMinutes, [[35], [35]])
  assert.equal(matrix.journeys[0][0].arrivalMinutes, forward.arrivalMinutes)
  assert.equal(matrix.diagnostics.journeys, null, 'Matrix diagnostics must not duplicate every journey')
  assert.deepEqual(matrix.diagnostics.times, [510 * 60, 510 * 60], 'Native clock diagnostics remain available')
  for (const mode of ['transit', 'walk', 'drive']) {
    const q = { serviceDate: base.serviceDate, time: '08:30', timePreference: 'arrive_by', mode, origins: [coordinate.origin], destinations: [coordinate.destination], maxWalkKm: .2 }
    const m = run('matrix', q)
    assert(m.durationsMinutes[0][0] > 0)
  }
  const feedTimestamp = Math.floor(Date.now() / 1000)
  const realtimeSnapshot = { incrementality: 'FULL_DATASET', feedTimestamp, tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }] }
  assert.equal(run('route', { ...base, realtimeSnapshot }).arrivalMinutes, 520)
  assert.equal(run('route', { ...base, realtimeSnapshot: { feedTimestamp, tripUpdates: [{ tripId: 'T1', scheduleRelationship: 'CANCELED' }] } }).status, 'blocked')
  assert.equal(run('route', { ...base, realtimeSnapshot: { feedTimestamp, tripUpdates: ['T1', 'T2'].map(tripId => ({ tripId, scheduleRelationship: 'CANCELED' })) } }).status, 'blocked')
  const traffic = { observedAt: Date.now(), observations: [{ fromCoordinate: [-77.05, 38.9], toCoordinate: [-77.04, 38.905], delayFactor: 3 }] }
  const congested = run('route', { ...coordinate, mode: 'drive', traffic })
  assert(congested.durationMinutes > drive.durationMinutes)
  const reachQuery = { serviceDate: base.serviceDate, time: base.time, origin: coordinate.origin, maxWalkKm: 1.2, rasterSize: 48, cutoffsMinutes: [15, 30, 45], includeStreetEdges: true }
  const reach = run('reach', reachQuery)
  assert.equal(reach.surface.values.length, 48 * 48)
  assert.equal(reach.surface.fullValues.length, 48 * 48)
  // Both directions of each reached street interval count, including clipped edges.
  assert.equal(reach.diagnostics.surface.reachedEdgeCount, 4)
  assert.equal(reach.diagnostics.surface.edgeEvidenceTruncated, false)
  assert.equal(reach.surface.edges.schemaVersion, 'vigo.standalone.street-edges.v2')
  assert.equal(reach.surface.edges.endpoints.length, reach.surface.edges.count * 2)
  assert.equal(reach.surface.edges.durationMinutes.length, reach.surface.edges.count)
  assert(reach.areas.features.length > 0)
  assert.equal(run('reach', { ...reachQuery, mode: 'walk' }).stops.length, 0)
  const scenario = { services: [{ operation: 'add', timeModel: 'preserve-scheduled', stops: [base.origin, base.destination], startMinutes: 475, endMinutes: 600, headwayMinutes: 5, segmentRuntimeMinutes: [5] }] }
  const proposed = run('reach', { ...reachQuery, scenario })
  assert(proposed.stops.some(stop => stop.stopId === 'B' && stop.durationMinutes <= 5))
  const comparison = run('compare', { before: reach, after: proposed })
  assert(comparison.commonCells > 0)
  assert(comparison.meanChangeMinutes <= 0)
  const noBaseService = run('reach', { ...reachQuery, serviceDate: '2026-07-19', scenario })
  assert(noBaseService.stops.some(stop => stop.stopId === 'B' && stop.durationMinutes <= 5))
  const preserved = run('reach', { ...reachQuery, scenario: { services: [{ operation: 'replace', scheduleMode: 'preserve-trips', stops: [{ stopId: 'X' }, { stopId: 'B' }], scheduledTrips: [{ tripId: 'T2', departureSeconds: 495 * 60, arrivalOffsetsSeconds: [0, 600], departureOffsetsSeconds: [0, 600], canBoard: [1, 0], canAlight: [0, 1] }] }] } })
  assert(preserved.stops.some(stop => stop.stopId === 'B' && stop.durationMinutes <= 30))
  const identifiers = run('native', { serviceDate: base.serviceDate, operation: 'timetable.identifiers' }).result
  assert.deepEqual(identifiers.stopIds, ['A', 'B', 'X'])
  const rawMatrix = run('native', { serviceDate: base.serviceDate, operation: 'timetable.matrix', input: {
    originOffsets: [0, 1], originStops: [0], originWalkSeconds: [0], allowPreRideTransfers: [true],
    destinationOffsets: [0, 1], destinationStops: [1], destinationWalkSeconds: [0], allowPostRideTransfers: [true],
    departure: 475 * 60, horizon: 600 * 60, arriveBy: false, maximumBoardings: 3, includeJourneys: true,
  } }).result
  assert.equal(rawMatrix.journeys[0].arrival, 510 * 60, 'The explicit native operation keeps its full raw result')
  const removed = run('reach', { ...reachQuery, scenario: { excludedTripIds: ['T2'] }, maxWalkKm: .2 })
  assert(!removed.stops.some(stop => stop.stopId === 'B'))
  rejects('route', { ...base, maxTransfers: 1.5 }, /maxTransfers/)
  rejects('route', { ...base, serviceDate: '2026-02-30' }, /range|invalid/i)
  rejects('route', { ...base, serviceDay: 'sunday' }, /disagrees/)
  rejects('route', { ...base, surprise: true }, /Unknown route option/)
  rejects('route', { ...base, time: null }, /time/)
  rejects('route', { ...base, mode: false }, /mode/)
  rejects('route', { ...base, timePreference: 123 }, /timePreference/)
  rejects('route', { ...base, timeMinutes: 475 }, /not both/)
  rejects('route', { ...base, origin: { stopId: 'A', typo: true } }, /Unknown point field/)
  rejects('route', { ...base, allowStreetTransfers: 'false' }, /boolean/)
  rejects('route', { ...base, maxTransfers: 0, via: [{ stopId: 'X' }] }, /via points/)
  rejects('reach', { ...reachQuery, timePreference: 'arrive_by' }, /depart_at/)
  rejects('reach', { ...reachQuery, mode: 'drive' }, /transit or walk/)
  rejects('reach', { ...reachQuery, scenario: { excludedPatternIds: ['unsupported-editor-id'] } }, /Unsupported scenario field/)
  rejects('reach', { ...reachQuery, scenario: { services: true } }, /services must be an array/)
  rejects('reach', { ...reachQuery, bounds: [1, 2, 0, 3] }, /bounds/)
  rejects('reach', { ...reachQuery, scenario: { services: [{ ...scenario.services[0], typo: 1 }] } }, /Unknown planned service field/)
  rejects('native', { operation: 'drive.route', input: { traffic: [] } }, /traffic must be an object/)
  rejects('compare', { before: { ...reach, surface: { ...reach.surface, width: 1 } }, after: { ...reach, surface: { ...reach.surface, width: 1 } } }, /dimensions/)
  const privateOutput = path.join(directory, 'private-result.json')
  fs.writeFileSync(privateOutput, 'previous', { mode: 0o600 })
  const saved = invoke('route', base, ['--output', privateOutput])
  assert.equal(saved.status, 0, saved.stderr)
  assert.equal(JSON.parse(fs.readFileSync(privateOutput, 'utf8')).trace.arrivalMinutes, 510)
  if (process.platform !== 'win32') assert.equal(fs.statSync(privateOutput).mode & 0o777, 0o600)
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false)
  count++
  const largeRequest = path.join(directory, 'too-large.json')
  for (const [command, options] of [['route', ['--port', '9999']], ['serve', ['--pretty']], ['capabilities', ['--city', city]], ['stream', ['--output', 'ignored.json']], ['not-a-command', []]]) {
    const rejected = spawnSync(binary, [command, ...options], { env, encoding: 'utf8' })
    assert.equal(rejected.status, 2)
    assert.match(rejected.stderr, /does not apply|Unknown command/)
    count++
  }
  fs.writeFileSync(largeRequest, ' '.repeat(8 * 1024 * 1024 + 1))
  const tooLarge = spawnSync(binary, ['route', '--city', city, '--request', largeRequest], { env, encoding: 'utf8' })
  assert.equal(tooLarge.status, 2)
  assert.match(tooLarge.stderr, /8 MiB/)
  count++
  const streetHeader = JSON.parse(fs.readFileSync(path.join(city, 'osm/street-index.sqlite.drive-accelerator-v2.bin')).subarray(0, 4096).toString().replace(/[\0\s]+$/g, ''))
  const driveBytes = fs.readFileSync(path.join(city, 'osm/street-index.sqlite.drive-accelerator-v2.bin'))
  const weights = Array.from({ length: streetHeader.arrays.edgeTimeUnits.length }, (_, i) => driveBytes.readUInt32LE(streetHeader.arrays.edgeTimeUnits.offset + i * 4))
  const rawTraffic = factor => ({ snapshotKey: 'same-client-key', streetSourceFingerprint: streetHeader.identity.sourceFingerprint, edgeIndices: weights.map((_, i) => i), edgeTimeUnits: weights.map(v => v * factor) })
  const trafficRequests = [4, 1].map(factor => ({ ...coordinate, mode: 'drive', kind: 'route', traffic: rawTraffic(factor) }))
  const trafficStream = spawnSync(binary, ['stream', '--city', city], { input: trafficRequests.map(JSON.stringify).join('\n') + '\n', env, encoding: 'utf8' })
  assert.equal(trafficStream.status, 0, trafficStream.stderr)
  const trafficResults = trafficStream.stdout.trim().split('\n').map(JSON.parse)
  assert(trafficResults[0].journey.durationSeconds > trafficResults[1].journey.durationSeconds, 'Traffic cache identity must bind the actual weights, not a caller key')
  count++
  const lines = [{ kind: 'route', id: 1, ...base, realtimeSnapshot }, [], { kind: 'route', id: 2, ...base }]
  const stream = spawnSync(binary, ['stream', '--city', city], { input: lines.map(q => JSON.stringify(q)).join('\n') + '\n', env, encoding: 'utf8' })
  assert.equal(stream.status, 0, stream.stderr)
  const results = stream.stdout.trim().split('\n').map(s => JSON.parse(s))
  assert(results[1].error)
  assert.deepEqual(results.filter(r => !r.error).map(r => [r.id, r.journey.arrivalTime]), [[1, "08:40:00"], [2, "08:30:00"]])
  count++
  server = spawn(binary, ['serve', '--city', city, '--port', '0', '--max-body-bytes', '1024'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const address = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('Server did not start')), 20000)
    server.stderr.on('data', chunk => { text += chunk; const match = text.match(/listening on (127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(`http://${match[1]}`) } })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code} ${text}`)) })
  })
  assert.equal((await fetch(`${address}/healthz`)).status, 200)
  assert.equal((await fetch(`${address}/v1/info`)).status, 401)
  const headers = { authorization: `Bearer ${env.VIGO_API_TOKEN}`, 'content-type': 'application/json' }
  const response = await fetch(`${address}/v1/route`, { method: 'POST', headers, body: JSON.stringify(base) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).journey.arrivalTime, "08:30:00")
  assert.equal((await fetch(`${address}/v1/route`, { method: 'POST', headers, body: '{' })).status, 400)
  assert.equal((await fetch(`${address}/v1/route`, { method: 'POST', headers, body: ' '.repeat(1025) })).status, 413)
  assert.equal((await fetch(`${address}/v1/no-such-command`, { method: 'POST', headers, body: '{}' })).status, 404)
  count += 6
  assert.equal(fingerprint(city), original, 'Runtime changed immutable City artifacts')
  console.log(`Standalone Rust checks passed (${count} queries/checks, empty PATH, immutable synthetic City, authenticated HTTP).`)
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit') }
  if (process.env.VIGO_KEEP_STANDALONE_FIXTURE) console.log(`Retained synthetic fixture: ${city}`)
  else fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
