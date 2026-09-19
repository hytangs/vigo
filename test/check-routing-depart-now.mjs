import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { resolveDepartNowRequest } from '../src/server/routing-depart-now.mjs'
import { buildNationalGtfsStore, disposeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const live = { routingDataMode: 'realtime', mode: 'transit', departNow: true,
  serviceDate: '1999-01-01', serviceDay: 'weekday', departMinutes: 10, arriveMinutes: 20,
  timeMinutes: 20, timePreference: 'arrive', allowServiceDateFallback: true }
const at = (instant, zone, request = live) => resolveDepartNowRequest(request, [zone], () => Date.parse(instant))
const local = result => [result.serviceDate, result.serviceDay, result.departMinutes]
assert.deepEqual(local(at('2026-09-20T06:58:40Z', 'America/Los_Angeles')), ['2026-09-19', 'saturday', 1439])
assert.deepEqual(local(at('2026-09-19T15:00:50Z', 'America/Los_Angeles')), ['2026-09-19', 'saturday', 481],
  'Depart now rounds forward so a departure earlier in the same minute is not boardable')
assert.deepEqual(local(at('2026-09-20T06:59:50Z', 'America/Los_Angeles')), ['2026-09-20', 'sunday', 0],
  'Rounding across agency-local midnight advances the service date and day together')
assert.deepEqual(local(at('2026-09-19T15:00:00.001Z', 'America/Los_Angeles')), ['2026-09-19', 'saturday', 481])
assert.deepEqual(local(at('2026-09-19T15:00:00Z', 'America/Los_Angeles')), ['2026-09-19', 'saturday', 480])
assert.deepEqual(local(at('2026-09-19T18:30:00Z', 'Asia/Kathmandu')), ['2026-09-20', 'sunday', 15])
assert.deepEqual(local(at('2026-03-08T06:59:00Z', 'America/New_York')), ['2026-03-08', 'sunday', 119])
assert.deepEqual(local(at('2026-03-08T07:01:00Z', 'America/New_York')), ['2026-03-08', 'sunday', 181])
const now = at('2026-09-20T06:58:40Z', 'America/Los_Angeles')
assert.equal(now.timePreference, 'depart')
assert.equal(now.timeZone, 'America/Los_Angeles')
assert.equal(now.allowServiceDateFallback, false)
for (const field of ['arriveMinutes', 'timeMinutes', 'departNow']) assert.equal(Object.hasOwn(now, field), false)
assert.equal(live.timePreference, 'arrive', 'Resolving the live request must not mutate retained research controls')
const explicit = { ...live }; delete explicit.departNow
assert.strictEqual(resolveDepartNowRequest(explicit, [], () => { throw Error('Replay read the clock') }), explicit,
  'Explicit realtime API/replay requests remain unchanged without departNow')
assert.strictEqual(resolveDepartNowRequest(now, [], () => { throw Error('Ordered leg reset to now') }), now,
  'Resolving an ordered leg a second time must not replace its propagated departure')
for (const zones of [[], ['UTC', 'America/New_York'], ['Invalid/Timezone']]) {
  assert.throws(() => resolveDepartNowRequest(live, zones), error => error.statusCode === 409 && error.code === 'depart_now_timezone_unavailable')
}
assert.throws(() => resolveDepartNowRequest({ ...live, departNow: 'true' }, ['UTC']), /boolean/)
assert.throws(() => resolveDepartNowRequest({ ...live, routingDataMode: 'scheduled' }, ['UTC']), /realtime transit/)
assert.throws(() => resolveDepartNowRequest({ ...live, mode: 'walk' }, ['UTC']), /realtime transit/)

const root = path.resolve(import.meta.dirname, '..')
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-depart-now-'))
const projectsRoot = path.join(folder, 'projects')
const projectId = 'clock-fixture'
const meta = path.join(projectsRoot, projectId, '.vigo')
const storePath = path.join(meta, 'routing', 'feed.sqlite')
const zipPath = path.join(folder, 'fixture.zip')
let runtime
try {
  const archive = new JSZip()
  archive.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture,https://example.test,America/Los_Angeles\n')
  archive.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Origin,0,0\nB,Waypoint,0,0.3\nC,Destination,0,0.6\n')
  archive.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,fixture,R,3\n')
  archive.file('trips.txt', 'route_id,service_id,trip_id\nR,S,first\nR,S,second\nR,S,already-left\nR,S,next-departure\n')
  archive.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260919,1\n')
  archive.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nfirst,23:59:00,23:59:00,A,1\nfirst,24:05:00,24:05:00,B,2\nsecond,24:06:00,24:06:00,B,1\nsecond,24:10:00,24:10:00,C,2\nalready-left,08:00:30,08:00:30,A,1\nalready-left,08:10:00,08:10:00,B,2\nnext-departure,08:01:00,08:01:00,A,1\nnext-departure,08:15:00,08:15:00,B,2\n')
  await fs.writeFile(zipPath, await archive.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  await fs.writeFile(path.join(meta, 'project.json'), JSON.stringify({
    schemaVersion: 'vigo.project.v1', id: projectId, name: 'Clock fixture',
    storagePath: path.join(projectsRoot, projectId), createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
    summary: { feeds: 1, routes: 1, stops: 3 }, jobs: [], artifacts: [],
    feeds: [{ id: 'feed', name: 'Fixture', routeCount: 1, stopCount: 3, routingStore: { status: 'ready', fileName: 'feed.sqlite' } }],
  }))
  async function start(instant) {
    const boot = path.join(folder, 'fixed-clock-api.mjs')
    await fs.writeFile(boot, `const NativeDate=Date; const instant=${Date.parse(instant)};
globalThis.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[instant]))}static now(){return instant}};
await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/server/vigo-api.mjs')).href)});`)
    return startInMemoryVigoApi({ repositoryRoot: root, serverPath: boot, environment: {
      VIGO_PROJECTS_DIR: projectsRoot, VIGO_CONFIG_DIR: path.join(folder, 'config'),
    } })
  }
  async function post(action, body) {
    const response = await runtime.requestJson(`/api/projects/${projectId}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  const point = (stopId, lon) => ({ source: 'stop', stopId, coordinate: [lon, 0] })
  const request = { ...live, feedId: 'feed', origin: point('A', 0), destination: point('B', .3), maxWalkKm: .2 }
  runtime = await start('2026-09-19T15:00:50Z')
  const { plan: currentMinute } = await post('national-route', request)
  assert.equal(currentMinute.status, 'ready')
  assert.equal(currentMinute.departMinutes, 481)
  assert.equal(currentMinute.legs.find(leg => leg.type === 'ride').tripId, 'next-departure',
    'At 08:00:50 the native route must exclude the faster trip that already departed at 08:00:30')
  await runtime.stop(); runtime = null
  runtime = await start('2026-09-20T06:58:40Z')
  const { routing: readiness } = await post('national-ready', request)
  assert.notEqual(readiness.dateOutsideCoverage, true, 'Readiness must use the current agency date before checking saved-date coverage')
  assert.deepEqual(local(readiness.requestedRoutingContext), ['2026-09-19', 'saturday', 1439])
  assert.equal(readiness.requestedRoutingContext.timePreference, 'depart')
  assert.equal(readiness.requestedRoutingContext.timeZone, 'America/Los_Angeles')
  const { plan } = await post('national-route', request)
  assert.equal(plan.status, 'ready')
  assert.equal(plan.timePreference, 'depart')
  assert.equal(plan.departMinutes, 1439)
  assert.equal(plan.diagnostics.routingDataProvenance.serviceDate, '2026-09-19')
  assert.equal(plan.legs.find(leg => leg.type === 'ride').tripId, 'first')
  const { plan: ordered } = await post('national-route', { ...request, destination: point('C', .6), waypoints: [point('B', .3)] })
  assert.equal(ordered.status, 'ready')
  assert.equal(ordered.departMinutes, 1439)
  assert.deepEqual(ordered.legs.filter(leg => leg.type === 'ride').map(leg => leg.tripId), ['first', 'second'])
  const replay = { ...request, serviceDate: '2026-09-19', serviceDay: 'saturday', timePreference: 'arrive', arriveMinutes: 1450 }
  delete replay.departNow
  const { plan: explicitPlan } = await post('national-route', replay)
  assert.equal(explicitPlan.status, 'ready')
  assert.equal(explicitPlan.timePreference, 'arrive', 'Explicit realtime replay requests retain arrive-by semantics')
  await runtime.stop(); runtime = null
  runtime = await start('2026-09-22T06:58:40Z')
  const { routing: outside } = await post('national-ready', request)
  assert.equal(outside.dateOutsideCoverage, true)
  assert.deepEqual(local(outside.requestedRoutingContext), ['2026-09-21', 'weekday', 1439],
    'Coverage-gated readiness still identifies the actual current agency date and time')
  const { plan: blocked } = await post('national-route', request)
  assert.equal(blocked.status, 'blocked', 'Depart now must not substitute an earlier available service date')
  assert.equal(blocked.diagnostics.routingDataProvenance.serviceDate, '2026-09-21')
} finally {
  await runtime?.stop()
  disposeNationalGtfsStore(storePath)
  await fs.rm(folder, { recursive: true, force: true })
}
console.log('Depart now: agency-local midnight/DST, forced departure, readiness coverage, native route and ordered legs, replay compatibility passed.')
