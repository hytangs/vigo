import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { wheelchairBoardingValues, wheelchairPathwaySeconds, wheelchairWayAllowed, wheelchairNodeAllowed } from '../src/server/wheelchair-policy.mjs'

assert.deepEqual([...wheelchairBoardingValues(new Map([
  ['child', { boarding: 0, parent: 'parent' }], ['parent', { boarding: 1 }],
  ['denied', { boarding: 2, parent: 'parent' }], ['unknown', { boarding: 0 }],
]))], [['child', 1], ['parent', 1], ['denied', 2], ['unknown', 0]])
assert.throws(() => wheelchairBoardingValues(new Map([['a', { boarding: 0, parent: 'b' }], ['b', { boarding: 0, parent: 'a' }]])), /Cyclic/)
for (const row of [
  { pathway_mode: 2, wheelchair_traversal_time: 20 }, { pathway_mode: 4, wheelchair_traversal_time: 20 },
  { pathway_mode: 1, traversal_time: 20 }, { pathway_mode: 5, wheelchair_traversal_time: -1 },
  { pathway_mode: 1, wheelchair_traversal_time: 20, stair_count: -1 },
  { pathway_mode: 1, wheelchair_traversal_time: 20, max_slope: -.2 },
]) assert.equal(wheelchairPathwaySeconds(row), null)
assert.equal(wheelchairPathwaySeconds({ pathway_mode: 5, wheelchair_traversal_time: 40 }), 40)
assert.equal(wheelchairPathwaySeconds({ pathway_mode: 1, traversal_time: 15, max_slope: .02, min_width: 1.2 }), 15)
assert.equal(wheelchairWayAllowed({ highway: 'footway', wheelchair: 'yes' }), true)
for (const tags of [{ highway: 'footway' }, { highway: 'steps', wheelchair: 'yes' }, { wheelchair: 'limited' }, { wheelchair: 'yes', incline: '20%' }]) assert.equal(wheelchairWayAllowed(tags), false)
for (const tags of [{ barrier: 'stile', wheelchair: 'yes' }, { barrier: 'gate' }, { kerb: 'raised' }, { wheelchair: 'no' }, { 'wheelchair:conditional': 'yes @ (Mo-Fr)' }]) assert.equal(wheelchairNodeAllowed(tags), false)
assert.equal(wheelchairNodeAllowed({}), true)
assert.equal(wheelchairNodeAllowed({ barrier: 'gate', wheelchair: 'yes' }), true)

const root = path.resolve(import.meta.dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-wheelchair-'))
const base = { origin: { stopId: 'A' }, destination: { stopId: 'B' }, serviceDate: '2026-07-15', time: '07:55', maxWalkKm: .1, requireTransitRide: true }
const run = (city, command, request, native = true, extra = []) => {
  const executable = native ? standaloneBinary : process.execPath
  const args = [...(native ? [] : ['public/vigo.mjs']), command, '--city', city, '--request', '-', ...extra]
  return JSON.parse(execFileSync(executable, args, { cwd: root, input: JSON.stringify(request), encoding: 'utf8', stdio: 'pipe', timeout: 30000 }))
}
const build = (gtfsPath, osmPath, city, extra = []) => execFileSync(process.execPath,
  ['public/vigo.mjs', 'build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city, ...extra],
  { cwd: root, stdio: 'pipe', timeout: 60000 })
let server
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder, { wheelchair: true })
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding\n'
    + 'S,Parent,38.9,-77.05,1,,1\nA,Alpha,38.9,-77.05,0,S,0\nX,Transfer,38.905,-77.04,0,,1\nB,Bravo,38.91,-77.03,0,,1\nD,Denied,38.906,-77.038,0,S,2\nU,Unknown,38.907,-77.036,0,,0\n')
  zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,wheelchair_accessible\nR1,WKD,T1,0,1\nR2,WKD,T2,0,1\nR1,WKD,FAST,0,2\nR1,WKD,UNKNOWN,0,0\n')
  zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string'))
    .replace('T1,08:10:00,08:10:00,X,2', 'T1,08:02:00,08:02:00,D,2\nT1,08:03:00,08:03:00,U,3\nT1,08:10:00,08:10:00,X,4')
    + 'FAST,08:00:00,08:00:00,A,1\nFAST,08:05:00,08:05:00,B,2\nUNKNOWN,08:00:00,08:00:00,A,1\nUNKNOWN,08:06:00,08:06:00,B,2\n')
  fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const regular = path.join(folder, 'regular'), accessible = path.join(folder, 'wheelchair')
  build(gtfsPath, osmPath, regular)
  build(gtfsPath, osmPath, accessible, ['--wheelchair'])
  const manifest = JSON.parse(fs.readFileSync(path.join(accessible, 'network.json')))
  assert.equal(manifest.accessibility.profile, 'wheelchair-strict-v1')
  assert.deepEqual(manifest.modes, ['transit', 'walk'])
  const db = new DatabaseSync(path.join(accessible, 'routing/project.sqlite'), { readOnly: true })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connections WHERE trip_id IN ('FAST','UNKNOWN')").get().n, 0)
  assert.equal(db.prepare("SELECT boarding FROM wheelchair_stops WHERE stop_id='A'").get().boarding, 1)
  assert.equal(db.prepare("SELECT boarding FROM wheelchair_stops WHERE stop_id='D'").get().boarding, 2)
  const deniedEvents = db.prepare("SELECT can_board,can_alight FROM connection_permissions WHERE trip_id='T1' ORDER BY stop_sequence").all()
  assert.deepEqual(deniedEvents.map(row => [row.can_board,row.can_alight]), [[1,0],[0,0],[0,1]], 'The chair can remain aboard through unknown/inaccessible stops.')
  db.close()
  for (const native of [false, true]) {
    assert.equal(run(regular, 'route', base, native).journey.arrivalTime, '08:05:00')
    assert.equal(run(accessible, 'route', base, native, ['--wheelchair']).journey.arrivalTime, '08:30:00')
    const walk = run(accessible, 'route', { ...base, mode: 'walk', requireTransitRide: false, wheelchair: true, maxWalkKm: 5,
      origin: { coordinate: [-77.049, 38.9005] }, destination: { coordinate: [-77.031, 38.9095] } }, native)
    assert.equal(walk.status, 'ok')
    assert.equal(walk.accessibility.profile, 'wheelchair-strict-v1')
    for (const wheelchair of [undefined, true]) {
      const q = { ...base, ...(wheelchair === undefined ? {} : { wheelchair }) }
      const result = run(accessible, 'route', q, native)
      assert.equal(result.status, 'ok', JSON.stringify(result))
      assert.equal(result.journey.arrivalTime, '08:30:00')
      assert.equal(result.accessibility.profile, 'wheelchair-strict-v1')
      assert(result.journey.legs.filter(l => l.type === 'transit').every(l => ['T1', 'T2'].includes(l.trip.id)))
    }
    const arrive = run(accessible, 'route', { ...base, wheelchair: true, time: '08:30', timePreference: 'arrive_by' }, native)
    assert.equal(arrive.journey.departureTime, '08:00:00')
    const matrix = run(accessible, 'matrix', { ...base, origin: undefined, destination: undefined, origins: [base.origin], destinations: [base.destination], wheelchair: true }, native)
    assert.equal(matrix.status, 'ok')
    assert.equal(matrix.accessibility.profile, 'wheelchair-strict-v1')
    for (const request of [{ ...base, wheelchair: false }, { ...base, wheelchair: 'true' }, { ...base, wheelchair: true, routingDataMode: 'realtime' }, { ...base, wheelchair: true, scenario: {} }]) {
      assert.throws(() => run(accessible, 'route', request, native), /Command failed/)
    }
    assert.throws(() => run(regular, 'route', { ...base, wheelchair: true }, native), /Command failed/)
    const reach = run(accessible, 'reach', { origin: base.origin, serviceDate: base.serviceDate, time: '07:55', wheelchair: true, cutoffsMinutes: [45], rasterSize: 48, extentRadiusKm: 1 }, native)
    assert.equal(reach.status, 'ok')
    assert.equal(reach.accessibility.profile, 'wheelchair-strict-v1')
  }
  // Raw feeds retain independently scoped accessibility values in a combined City.
  const merged = path.join(folder, 'merged')
  build(gtfsPath, osmPath, merged, ['--wheelchair', '--gtfs', gtfsPath, '--gtfs-scope', 'one', '--gtfs-scope', 'two'])
  for (const feed of ['one', 'two']) {
    const result = run(merged, 'route', { ...base, origin: { stop: { id: 'A', feed } }, destination: { stop: { id: 'B', feed } }, wheelchair: true })
    assert.equal(result.journey.arrivalTime, '08:30:00')
  }
  // HTTP exercises the same constrained search and keeps serving after errors.
  const token = 'synthetic-wheelchair-test-token'
  server = spawn(standaloneBinary, ['serve', '--city', accessible, '--port', '0'], { env: { ...process.env, VIGO_API_TOKEN: token } })
  const port = await new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => reject(new Error(`HTTP startup timeout: ${log}`)), 15000)
    server.stderr.on('data', data => { log += data; const match = log.match(/listening on 127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])) } })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`HTTP exited ${code}: ${log}`)) })
  })
  const post = body => fetch(`http://127.0.0.1:${port}/v1/route`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ ...base, wheelchair: false })).status, 400)
  const response = await post({ ...base, wheelchair: true })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.journey.arrivalTime, '08:30:00')
  assert.equal(result.accessibility.profile, 'wheelchair-strict-v1')
  for (const [kind, body] of [
    ['matrix', { ...base, origin: undefined, destination: undefined, origins: [base.origin], destinations: [base.destination], wheelchair: true }],
    ['reach', { origin: base.origin, serviceDate: base.serviceDate, time: '07:55', cutoffsMinutes: [45], rasterSize: 48, extentRadiusKm: 1, wheelchair: true }],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${kind}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).accessibility.profile, 'wheelchair-strict-v1')
  }
  server.kill(); await once(server, 'exit'); server = null
  // Entrance-to-platform alternatives must survive parallel stairs in either order.
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding\n'
    + 'A,Alpha,38.9,-77.05,0,,1\nX,Bus,38.905,-77.04,0,,1\nS,Station,38.905,-77.04,1,,1\nE,Entrance,38.905,-77.04,2,S,0\nP,Platform,38.905,-77.0398,0,S,0\nB,Bravo,38.91,-77.03,0,,1\n')
  zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,wheelchair_accessible\nR1,WKD,T1,0,1\nR2,WKD,T2,0,1\n')
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,X,2\nT2,08:15:00,08:15:00,P,1\nT2,08:30:00,08:30:00,B,2\n')
  const stairs = 'stairs,E,P,2,1,5,5\n', elevator = 'lift,E,P,5,0,60,60\n'
  for (const [variant, paths, ready] of [
    ['elevator-first', elevator + stairs, true], ['elevator-last', stairs + elevator, true],
    ['stairs-only', stairs, false], ['reverse-elevator', 'lift,P,E,5,0,60,60\n' + stairs, false],
    ['unknown-path', 'path,E,P,1,1,5,\n', false],
    ['minimum-after-stairs', stairs + elevator, false],
    ['minimum-before-stairs', elevator + stairs, false],
    ['generic-transfer-only', '', false],
  ]) {
    if (variant.startsWith('minimum')) zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nE,P,2,600\n')
    else if (variant === 'generic-transfer-only') zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nX,P,0,0\n')
    else zip.remove('transfers.txt')
    zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,traversal_time,wheelchair_traversal_time\n' + paths)
    fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const city = path.join(folder, variant)
    build(gtfsPath, osmPath, city, ['--wheelchair'])
    for (const native of [false, true]) {
      const result = run(city, 'route', { ...base, wheelchair: true, diagnostics: 'trace' }, native)
      assert.equal(result.status, ready ? 'ok' : 'not_found', `${variant}/${native}: ${JSON.stringify(result).slice(0,500)}`)
      if (ready) assert.equal(result.journey.arrivalTime, '08:30:00')
    }
  }
  // A City cannot be relabeled to opt an unrestricted graph into the profile.
  const regularManifestPath = path.join(regular, 'network.json')
  const changed = JSON.parse(fs.readFileSync(regularManifestPath)); changed.accessibility = manifest.accessibility
  fs.writeFileSync(regularManifestPath, JSON.stringify(changed))
  for (const native of [false, true]) assert.throws(() => run(regular, 'route', { ...base, wheelchair: true }, native), /Command failed/)
  console.log('Wheelchair routing passed: inheritance, barriers, accessible alternatives, CLI/native/HTTP, reverse, Matrix, Reach, profile admission and invalid requests.')
} finally {
  if (server) { server.kill(); await once(server, 'exit') }
  if (process.env.VIGO_KEEP_TEST_FIXTURES) console.log(folder)
  else fs.rmSync(folder, { recursive: true, force: true })
}
