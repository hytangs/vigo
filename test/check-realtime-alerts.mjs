// Service Alerts in routing, realtime leg quality, and realtime Matrix and
// Reach, through the Rust binary on the public synthetic City. Studio's Node
// runtime applies the same overlay and must publish the same Route results.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-realtime-alerts-'))
const city = path.join(directory, 'city')
const env = { PATH: '', NODE_PATH: '', RAYON_NUM_THREADS: '2' }
const base = { requireTransitRide: true, serviceDate: '2026-07-15', time: '07:55', origin: { stopId: 'A' }, destination: { stopId: 'B' }, maxWalkKm: 0.2 }
let checks = 0
function run(kind, request, { trace = true } = {}) {
  const p = spawnSync(binary, [kind, '--city', city, '--request', '-'], { input: JSON.stringify({ ...request, ...(trace ? { diagnostics: 'trace' } : {}) }), env, encoding: 'utf8', maxBuffer: 32 << 20 })
  assert.equal(p.status, 0, p.stderr)
  return JSON.parse(p.stdout)
}
const route = (request, options) => run('route', { ...base, routingDataMode: 'realtime', ...request }, options)
// The public Route result of both runtimes for one realtime request.
function both(request) {
  const input = { ...base, routingDataMode: 'realtime', ...request }
  const node = spawnSync(process.execPath, [path.join(root, 'public/vigo.mjs'), 'route', '--city', city, '--request', '-'],
    { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 << 20 })
  assert.equal(node.status, 0, node.stderr)
  return [run('route', input, { trace: false }), JSON.parse(node.stdout)]
}
const transit = result => (result.journey?.legs ?? []).filter(l => l.type === 'transit')
function sameRoute(request) {
  const [rust, node] = both(request)
  assert.equal(node.status, rust.status, JSON.stringify(node).slice(0, 400))
  assert.deepEqual(node.meta?.realtime?.alerts, rust.meta?.realtime?.alerts)
  assert.deepEqual(transit(node).map(l => [l.trip, l.quality.schedule, l.alerts, l.departureTime, l.arrivalTime]),
    transit(rust).map(l => [l.trip, l.quality.schedule, l.alerts, l.departureTime, l.arrivalTime]))
  return rust
}
const feedTimestamp = Math.floor(Date.now() / 1000)
// Local midnight of the service date in the City's America/New_York clock.
const midnight = Date.UTC(2026, 6, 15, 4) / 1000
const at = (hours, minutes) => midnight + hours * 3600 + minutes * 60
const snapshot = (alerts, tripUpdates = []) => ({ feedTimestamp, tripUpdates, alerts })

try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, [path.join(root, 'public/vigo.mjs'), 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  const scheduled = run('route', base).trace
  assert.equal(scheduled.arrivalMinutes, 510)

  // A suspended route removes its trips.
  const suspended = route({ realtimeSnapshot: snapshot([{ id: 'r2', effect: 'NO_SERVICE', informedEntities: [{ routeId: 'R2' }] }]) }).trace
  assert.equal(suspended.status, 'blocked')
  assert.equal(suspended.diagnostics.realtime.alerts.noService, 1)
  assert(suspended.diagnostics.realtime.alerts.closedBoardings >= 1); checks++

  // A stop closure applies only during its active period; vehicles pass through.
  const closure = period => route({ realtimeSnapshot: snapshot([{ id: 'x', effect: 1, activePeriods: [period], informedEntities: [{ stopId: 'X' }] }]) }).trace
  assert.equal(closure({ start: at(8, 5), end: at(8, 20) }).status, 'blocked')
  assert.equal(closure({ start: at(9, 0), end: at(10, 0) }).arrivalMinutes, 510)
  assert.equal(closure({ start: at(8, 12) }).status, 'blocked', 'open-ended period closes the transfer boarding'); checks++

  // Other effects leave service intact and describe the legs they affect.
  const detour = route({ realtimeSnapshot: snapshot([
    { id: 'detour', effect: 'DETOUR', cause: 'CONSTRUCTION', header: 'R1 detour', informedEntities: [{ routeId: 'R1' }] },
    { id: 'agency', effect: 'NO_SERVICE', informedEntities: [{ agencyId: 'fixture' }] },
    { id: 'old', effect: 'NO_SERVICE', sourceFeedTimestamp: feedTimestamp - 3600, informedEntities: [{ routeId: 'R2' }] },
    { id: 'later', effect: 'SIGNIFICANT_DELAYS', activePeriods: [{ start: at(12, 0), end: at(13, 0) }], informedEntities: [{ routeId: 'R1' }] },
  ]) }, { trace: false })
  assert.equal(detour.status, 'ok', JSON.stringify(detour).slice(0, 400))
  const rides = detour.journey.legs.filter(l => l.type === 'transit')
  assert.deepEqual(rides.map(l => l.alerts?.map(a => a.id)), [['detour'], undefined])
  assert.equal(rides[0].alerts[0].effect, 'DETOUR')
  assert.equal(rides[0].alerts[0].header, 'R1 detour')
  assert.deepEqual(detour.meta.realtime.alerts, { received: 4, fresh: 3, stale: 1, noService: 1, unsupportedEntities: 1, closedBoardings: 0, closedAlightings: 0 }); checks++

  // Legs on trips with applied predictions report realtime schedule quality.
  const delayed = route({ realtimeSnapshot: snapshot(undefined, [{ tripId: 'T2', delaySeconds: 300 }]) }, { trace: false })
  assert.deepEqual(delayed.journey.legs.filter(l => l.type === 'transit').map(l => l.quality.schedule), ['timetable', 'realtime'])
  assert.equal(run('route', base, { trace: false }).journey.legs.filter(l => l.type === 'transit').every(l => l.quality.schedule === 'timetable'), true); checks++

  // The Node runtime closes the same service and describes the same rides.
  for (const realtimeSnapshot of [
    snapshot([{ id: 'r2', effect: 'NO_SERVICE', informedEntities: [{ routeId: 'R2' }] }]),
    snapshot([{ id: 'x', effect: 1, activePeriods: [{ start: at(8, 5), end: at(8, 20) }], informedEntities: [{ stopId: 'X' }] }]),
    snapshot([{ id: 'x', effect: 1, activePeriods: [{ start: at(9, 0), end: at(10, 0) }], informedEntities: [{ stopId: 'X' }] }]),
    snapshot([{ id: 'p', effect: 'NO_SERVICE', informedEntities: [{ stopId: 'P' }] }]),
    snapshot([
      { id: 'detour', effect: 'DETOUR', cause: 'CONSTRUCTION', header: 'R1 detour', informedEntities: [{ routeId: 'R1' }] },
      { id: 'agency', effect: 'NO_SERVICE', informedEntities: [{ agencyId: 'fixture' }] },
      { id: 'old', effect: 'NO_SERVICE', sourceFeedTimestamp: feedTimestamp - 3600, informedEntities: [{ routeId: 'R2' }] },
      { id: 'later', effect: 'SIGNIFICANT_DELAYS', activePeriods: [{ start: at(12, 0), end: at(13, 0) }], informedEntities: [{ routeId: 'R1' }] },
    ]),
    snapshot([{ id: 'stop', effect: 'STOP_MOVED', informedEntities: [{ stopId: 'X' }] }], [{ tripId: 'T2', delaySeconds: 300 }]),
  ]) sameRoute({ realtimeSnapshot })
  const [, nodeDetour] = both({ realtimeSnapshot: snapshot([{ id: 'detour', effect: 'DETOUR', informedEntities: [{ routeId: 'R1' }] }]) })
  assert.deepEqual(transit(nodeDetour).map(l => l.alerts?.map(a => a.id)), [['detour'], undefined])
  const [, nodeDelayed] = both({ realtimeSnapshot: snapshot(undefined, [{ tripId: 'T2', delaySeconds: 300 }]) })
  assert.deepEqual(transit(nodeDelayed).map(l => l.quality.schedule), ['timetable', 'realtime']); checks++

  // Matrix and Reach search the same realtime view as Route.
  const matrix = (extra = {}) => run('matrix', { serviceDate: base.serviceDate, time: base.time, origins: [base.origin], destinations: [base.destination], maxWalkKm: 0.2, requireTransitRide: true, ...extra }, { trace: false })
  const scheduledMatrix = matrix()
  const realtimeMatrix = matrix({ routingDataMode: 'realtime', realtimeSnapshot: snapshot(undefined, [{ tripId: 'T2', delaySeconds: 600 }]) })
  assert.equal(realtimeMatrix.durationsSeconds[0][0] - scheduledMatrix.durationsSeconds[0][0], 600, JSON.stringify(realtimeMatrix.durationsSeconds))
  assert.equal(realtimeMatrix.query.dataMode, 'realtime')
  assert.equal(realtimeMatrix.meta.realtime.appliedTrips, 1); checks++
  const reachQuery = { serviceDate: base.serviceDate, time: base.time, origin: base.origin, maxWalkKm: 1.2, rasterSize: 48, cutoffsMinutes: [15, 30, 45] }
  const reached = request => run('reach', request).trace.surface.values.filter(v => v !== null).length
  const canceled = { ...reachQuery, routingDataMode: 'realtime', realtimeSnapshot: { feedTimestamp, tripUpdates: [{ tripId: 'T1', scheduleRelationship: 'CANCELED' }] } }
  assert(reached(canceled) < reached(reachQuery), 'a canceled first trip shrinks Reach')
  assert.equal(run('reach', canceled).trace.diagnostics.realtime.canceledTrips, 1); checks++

  // Scenarios still compose with realtime on Reach; walking and driving refuse snapshots.
  assert(reached({ ...canceled, scenario: { excludedTripIds: ['T2'] } }) <= reached(canceled))
  const refused = spawnSync(binary, ['matrix', '--city', city, '--request', '-'], { input: JSON.stringify({ serviceDate: base.serviceDate, time: base.time, mode: 'walk', origins: [base.origin], destinations: [base.destination], realtimeSnapshot: snapshot([]) }), env, encoding: 'utf8' })
  assert.equal(refused.status, 2); assert.match(refused.stderr, /transit Route, Matrix and Reach/); checks++

  console.log(`Realtime alerts and query kinds passed (${checks} checks: NO_SERVICE routes and stops, active periods, leg alerts, stale and agency entities, realtime schedule quality, Node runtime parity, Matrix, Reach and scenarios).`)
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
