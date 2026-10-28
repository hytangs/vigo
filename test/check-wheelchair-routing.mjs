import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { buildStudioWheelchair, wheelchairBuildSources } from '../src/server/studio-wheelchair-build.mjs'
import { studioWheelchairAvailability, studioWheelchairSelection } from '../src/server/studio-wheelchair.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { wheelchairBoardingValues, wheelchairPathwaySeconds, wheelchairWayAllowed, wheelchairNodeAllowed, wheelchairStreetPolicy } from '../src/server/wheelchair-policy.mjs'

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
assert.equal(wheelchairPathwaySeconds({ pathway_mode: 1, wheelchair_length: 40 }), 30)
for (const row of [
  { pathway_mode: 2, wheelchair_length: 40 }, { pathway_mode: 5, wheelchair_length: 40 },
  { pathway_mode: 1, wheelchair_length: 40, stair_count: 1 },
  { pathway_mode: 1, wheelchair_length: 40, max_slope: .2 },
  { pathway_mode: 1, wheelchair_length: 40, min_width: .5 },
  { pathway_mode: 1, wheelchair_length: 0 }, { pathway_mode: 1, wheelchair_length: -1 },
  { pathway_mode: 1, wheelchair_length: 'invalid' }, { pathway_mode: 6 },
]) assert.equal(wheelchairPathwaySeconds(row), null)
assert.equal(wheelchairPathwaySeconds({ pathway_mode: 1, traversal_time: 15, max_slope: .02, min_width: 1.2 }), 15)
assert.equal(wheelchairWayAllowed({ highway: 'footway', wheelchair: 'yes' }), true)
// Verified street evidence uses only ways tagged wheelchair=yes.
for (const tags of [{ highway: 'footway' }, { highway: 'steps', wheelchair: 'yes' }, { wheelchair: 'limited' }, { wheelchair: 'yes', incline: '20%' }]) assert.equal(wheelchairWayAllowed(tags, 'verified'), false)
for (const tags of [{ barrier: 'stile', wheelchair: 'yes' }, { barrier: 'gate' }, { barrier: 'kerb', kerb: 'lowered' }, { kerb: 'raised' }, { wheelchair: 'no' }, { 'wheelchair:conditional': 'yes @ (Mo-Fr)' }]) assert.equal(wheelchairNodeAllowed(tags, 'verified'), false)
// Inferred streets can lack wheelchair or surface tags. A positive wheelchair
// tag overrides the surface and trail inference, but not physical dimensions.
assert.equal(wheelchairWayAllowed({ highway: 'footway', surface: 'gravel' }), false)
assert.equal(wheelchairWayAllowed({ highway: 'footway', surface: 'gravel', wheelchair: 'yes' }), true)
assert.equal(wheelchairWayAllowed({ highway: 'footway', surface: 'gravel', wheelchair: 'yes', width: '.6' }), false)
for (const tags of [{ highway: 'footway' }, { highway: 'residential' }, { highway: 'path', surface: 'asphalt' }, { highway: 'footway', incline: '5%' }]) assert.equal(wheelchairWayAllowed(tags), true, JSON.stringify(tags))
for (const tags of [{ highway: 'path' }, { highway: 'track', surface: 'gravel' }, { highway: 'footway', surface: 'cobblestone' }, { highway: 'footway', smoothness: 'bad' },
  { highway: 'path', surface: 'asphalt', sac_scale: 'mountain_hiking' }, { highway: 'steps' }, { highway: 'footway', wheelchair: 'no' }, { highway: 'footway', incline: '12%' }, { highway: 'footway', width: '0.6' }]) {
  assert.equal(wheelchairWayAllowed(tags), false, JSON.stringify(tags))
}
for (const tags of [{ barrier: 'gate' }, { barrier: 'bollard' }, { barrier: 'kerb', kerb: 'lowered' }, {}]) assert.equal(wheelchairNodeAllowed(tags), true, JSON.stringify(tags))
for (const tags of [{ barrier: 'gate', locked: 'yes' }, { barrier: 'kerb' }, { barrier: 'stile' }, { barrier: 'cycle_barrier' }, { kerb: 'raised' }, { wheelchair: 'no' }]) assert.equal(wheelchairNodeAllowed(tags), false, JSON.stringify(tags))
assert.throws(() => wheelchairStreetPolicy('assumed'), /inferred or verified/)
// Malformed slope tags must not turn unknown access into an accessible edge.
for (const incline of ['.%', '1.2.3%', '+.%', '--2%', 'NaN%', 'Infinity%']) {
  assert.equal(wheelchairWayAllowed({ highway: 'footway', wheelchair: 'yes', incline }), false, incline)
  assert.equal(wheelchairNodeAllowed({ wheelchair: 'yes', incline }), false, incline)
}
for (const incline of ['0', '0%', '+8.3%', '-8.3%', '.5%']) {
  assert.equal(wheelchairWayAllowed({ highway: 'footway', wheelchair: 'yes', incline }), true, incline)
}
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
  assert.equal(manifest.accessibility.streetEvidence, 'inferred-step-free-v1', 'Wheelchair Cities infer step-free streets by default')
  assert(manifest.accessibility.limitations.some(text => text.includes('can lack wheelchair or surface tags')),
    'Results must describe the inferred street evidence honestly')
  assert.deepEqual(manifest.modes, ['transit', 'walk'])
  // The City profile is active even when the optional request flag is absent.
  // This destination needs the expanded walking budget, so the planner must
  // not find it through a search suppressed for explicit wheelchair requests.
  const expanded = { ...base, destination: { coordinate: [-77.035, 38.9075] },
    expandedWalkKm: 2.4, journeyPolicy: 'alternatives-v1' }
  for (const wheelchair of [undefined, true]) {
    const request = { ...expanded, ...(wheelchair === undefined ? {} : { wheelchair }) }
    assert.equal(run(accessible, 'route', request).status, 'not_found',
      'The active wheelchair profile must suppress expanded-walking candidates')
  }
  // A nearer destination has an ordinary journey, so the supported-window
  // path must retain that journey rather than widen its final walk.
  const supported = { ...base, destination: { coordinate: [-77.0305, 38.90975] },
    expandedWalkKm: 2.4, windowMinutes: 10, windowStepMinutes: 5, windowChoices: 'supported' }
  for (const wheelchair of [undefined, true]) {
    const request = { ...supported, ...(wheelchair === undefined ? {} : { wheelchair }) }
    const result = run(accessible, 'route', request)
    assert.equal(result.journey.arrivalTime, '08:30:39',
      'Window choices must apply the inherited wheelchair profile')
  }
  // Studio must select the same constrained City and never substitute ordinary paths.
  const studio = path.join(folder, 'cities', 'fixture', '.vigo')
  fs.mkdirSync(studio, { recursive: true })
  fs.cpSync(path.join(regular, 'routing'), path.join(studio, 'routing'), { recursive: true })
  fs.copyFileSync(path.join(regular, 'routing/project.sqlite'), path.join(studio, 'routing/feed.sqlite'))
  fs.cpSync(path.join(regular, 'osm'), path.join(studio, 'osm'), { recursive: true })
  const project = { id: 'fixture', name: 'Fixture', jobs: [], artifacts: [],
    feeds: [{ id: 'feed', routingStore: { status: 'ready', fileName: 'feed.sqlite', sourceFingerprint: manifest.sources.gtfs[0].sha256 } }],
    osmStreetIndex: { status: 'ready', sourceFingerprint: manifest.sources.osm.sha256 } }
  fs.writeFileSync(path.join(studio, 'project.json'), JSON.stringify(project))
  fs.mkdirSync(path.join(studio, 'jobs'))
  fs.writeFileSync(path.join(studio, 'jobs', 'gtfs.json'), JSON.stringify({ kind: 'national-gtfs-import', status: 'complete', createdAt: '2026-07-01',
    sourcePath: gtfsPath, result: { feedId: 'feed', store: { sourceFingerprint: manifest.sources.gtfs[0].sha256 } } }))
  fs.writeFileSync(path.join(studio, 'jobs', 'osm.json'), JSON.stringify({ kind: 'national-osm-import', status: 'complete', createdAt: '2026-07-01',
    sourcePath: osmPath, result: { sourceFingerprint: manifest.sources.osm.sha256 } }))
  const sources = await wheelchairBuildSources(studio, project, { feedId: 'feed' })
  assert.deepEqual(sources, { gtfs: gtfsPath, osm: osmPath, feedId: 'feed' })
  await assert.rejects(wheelchairBuildSources(studio, project, { scenario: {} }), /one source timetable/)
  await assert.rejects(wheelchairBuildSources(studio, { ...project, osmStreetIndex: { sourceFingerprint: 'changed' } }, {}), /Original source files/)
  await assert.rejects(buildStudioWheelchair({ directory: studio, sources, readProject: async () => project,
    signal: AbortSignal.abort(), onProgress: () => {} }), /abort/i)
  assert.throws(() => studioWheelchairSelection(studio, project, { wheelchair: true }), /no prepared wheelchair/)
  assert.equal(studioWheelchairAvailability(studio, project, {}).available, false)
  const attach = () => execFileSync(process.execPath, ['scripts/attach-studio-wheelchair.mjs', path.dirname(studio), accessible], { cwd: root })
  attach(); attach()
  assert(fs.readdirSync(studio).some(name => name.startsWith('wheelchair-backup-')))
  assert.equal(studioWheelchairSelection(studio, project, { wheelchair: false }), null)
  assert(studioWheelchairSelection(studio, project, { wheelchair: true, feedId: 'feed' }))
  assert.throws(() => studioWheelchairSelection(studio, project, { wheelchair: true, feedId: 'unrelated' }), /must match/)
  assert.throws(() => studioWheelchairSelection(studio, { ...project, osmStreetIndex: {} }, { wheelchair: true }), /must match/)
  assert.deepEqual(studioWheelchairAvailability(studio, project, { feedId: 'feed' }), { available: true })
  for (const request of [{ feedId: 'unrelated' }, { mode: 'drive' }, { waypoints: [{}] }, { scenario: {} }]) {
    assert.equal(studioWheelchairAvailability(studio, project, request).available, false)
  }
  assert.equal(studioWheelchairAvailability(studio, { ...project, osmStreetIndex: {} }, {}).available, false)
  const api = await startInMemoryVigoApi({ repositoryRoot: root, environment: {
    VIGO_PROJECTS_DIR: path.join(folder, 'cities'), VIGO_CONFIG_DIR: path.join(folder, 'config'), VIGO_ROUTE_PROJECT_PREWARM: '0' } })
  try {
    fs.renameSync(path.join(studio, 'wheelchair'), path.join(studio, 'wheelchair-test-backup'))
    const preparation = await api.requestJson('/api/projects/fixture/wheelchair-availability', { method: 'POST', body: { feedId: 'feed' } })
    assert.equal(preparation.body.available, false)
    assert.equal(preparation.body.canPrepare, true)
    const started = await api.requestJson('/api/projects/fixture/wheelchair-prepare', { method: 'POST', body: { feedId: 'feed' } })
    assert.equal(started.status, 202, JSON.stringify(started.body))
    const deadline = Date.now() + 60000
    let job
    do {
      await new Promise(resolve => setTimeout(resolve, 50))
      const response = await api.requestJson(`/api/projects/fixture/national-gtfs-job?jobId=${started.body.job.id}`)
      job = response.body.job
    } while (['queued', 'running'].includes(job?.status) && Date.now() < deadline)
    assert.equal(job?.status, 'complete', JSON.stringify(job))
    assert(studioWheelchairSelection(studio, project, { wheelchair: true }))
    for (const [feedId, available] of [['feed', true], ['unrelated', false]]) {
      const capability = await api.requestJson('/api/projects/fixture/wheelchair-availability', { method: 'POST', body: { feedId } })
      assert.equal(capability.status, 200)
      assert.equal(capability.body.available, available)
    }
    const request = { ...base, wheelchair: true, mode: 'transit', feedId: '__project__', routingDataMode: 'scheduled',
      timePreference: 'depart', departMinutes: 475, arriveMinutes: 510, departureWindowMinutes: 0, serviceDay: 'weekday' }
    for (const action of ['national-ready', 'national-route']) {
      const response = await api.requestJson(`/api/projects/fixture/${action}`, { method: 'POST', body: request })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      if (action === 'national-route') {
        assert(response.body.choices.some(plan => plan.status === 'ready' && plan.arriveMinutes === 510), JSON.stringify(response.body))
        assert(response.body.choices.every(plan => plan.diagnostics.accessibility.profile === 'wheelchair-strict-v1'))
      }
    }
    const buffered = await api.requestJson('/api/projects/fixture/national-route', { method: 'POST', body: { ...request, minimumTransferBufferMinutes: 11 } })
    assert.equal(buffered.status, 200, JSON.stringify(buffered.body))
    assert(buffered.body.choices.length > 0, 'Keep the blocked-route explanation')
    assert(buffered.body.choices.every(plan => plan.status !== 'ready'), 'Wheelchair routing must honor the transfer reserve')
    assert(buffered.body.choices.every(plan => plan.diagnostics.accessibility.profile === 'wheelchair-strict-v1'))
    for (const change of [{ wheelchair: 'true' }, { mode: 'drive' }, { routingDataMode: 'realtime' },
      { scenarioKey: 'x' }, { waypoints: [base.origin] }, { wheelchairAccessible: true }]) {
      const response = await api.requestJson('/api/projects/fixture/national-route', { method: 'POST', body: { ...request, ...change } })
      assert.equal(response.status, 400, JSON.stringify(response.body))
    }
    const multiple = { ...project, defaultRoutingFeedId: 'feed', osmStreetIndex: { ...project.osmStreetIndex, cch: { ready: true } },
      feeds: [...project.feeds, { ...project.feeds[0], id: 'alternative', routingStore: { ...project.feeds[0].routingStore, sourceFingerprint: '0'.repeat(64) } }] }
    fs.writeFileSync(path.join(studio, 'project.json'), JSON.stringify(multiple))
    for (const action of ['national-ready', 'national-route']) {
      const current = await api.requestJson(`/api/projects/fixture/${action}`, { method: 'POST', body: { ...request, feedId: undefined, feedIds: ['feed'], scenario: null } })
      assert.equal(current.status, 200, JSON.stringify(current.body))
      const alternative = await api.requestJson(`/api/projects/fixture/${action}`, { method: 'POST', body: { ...request, feedId: undefined, feedIds: ['alternative'], scenario: null } })
      assert.equal(alternative.status, 409, 'A different network must never use the baseline wheelchair profile')
    }
    const alternative = await api.requestJson('/api/projects/fixture/national-route', { method: 'POST', body: { ...request, wheelchair: false, feedId: undefined, feedIds: ['alternative'], scenario: null } })
    assert.equal(alternative.status, 200, JSON.stringify(alternative.body))
    assert(alternative.body.choices.some(plan => plan.status === 'ready' && plan.arriveMinutes === 485), JSON.stringify(alternative.body))
    const profileFile = path.join(studio, 'wheelchair', 'network.json')
    fs.renameSync(profileFile, `${profileFile}.saved`)
    try {
      const missing = await api.requestJson('/api/projects/fixture/national-route', { method: 'POST', body: request })
      assert.equal(missing.status, 409)
      assert.match(missing.body.error, /No ordinary route was substituted/)
    } finally { fs.renameSync(`${profileFile}.saved`, profileFile) }
  } finally { await api.stop() }
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
    assert.equal(walk.accessibility.streetEvidence, 'inferred-step-free-v1', 'Results name their street evidence')
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
  // Scenario compilation must preserve the same profile in every City and
  // their shared street graph; a spec flag must never be silently ignored.
  const collection = path.join(folder, 'collection')
  const specPath = path.join(folder, 'scenarios.json')
  const spec = { schemaVersion: 'vigo.scenarios.source.v1', wheelchair: true,
    osm: { path: osmPath }, scenarios: ['first', 'second'].map(id => ({ id, feeds: [{ path: gtfsPath, scope: 'test' }] })) }
  const compileCollection = (output, extra = []) => execFileSync(process.execPath,
    ['public/vigo.mjs', 'build-scenarios', '--spec', specPath, '--output', output, ...extra],
    { cwd: root, stdio: 'pipe', timeout: 60000 })
  fs.writeFileSync(specPath, JSON.stringify(spec))
  compileCollection(collection)
  for (const scenarioId of ['first', 'second']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(collection, 'cities', scenarioId, 'network.json'))).accessibility.profile, 'wheelchair-strict-v1')
    const result = run(collection, 'route', { ...base, scenarioId, wheelchair: true })
    assert.equal(result.journey.arrivalTime, '08:30:00')
    assert.equal(result.accessibility.profile, 'wheelchair-strict-v1')
    assert.equal(result.scenarioId, scenarioId)
    assert.throws(() => run(collection, 'route', { ...base, scenarioId, wheelchair: false }), /Command failed/)
  }
  for (const [change, flags] of [[{ wheelchair: 'true' }, []], [{ streetModes: 'walk,drive' }, []], [{}, ['--wheelchair=false']]]) {
    fs.writeFileSync(specPath, JSON.stringify({ ...spec, ...change }))
    const invalid = path.join(folder, 'invalid-collection')
    assert.throws(() => compileCollection(invalid, flags), /Command failed/)
    assert(!fs.existsSync(invalid))
  }
  const flagSpec = { ...spec, wheelchair: undefined, scenarios: [spec.scenarios[0]] }
  fs.writeFileSync(specPath, JSON.stringify(flagSpec))
  const flagCollection = path.join(folder, 'flag-collection')
  compileCollection(flagCollection, ['--wheelchair'])
  assert.equal(run(flagCollection, 'route', { ...base, wheelchair: true }).journey.arrivalTime, '08:30:00')
  // HTTP exercises the same constrained search and keeps serving after errors.
  const token = 'synthetic-wheelchair-test-token'
  server = spawn(standaloneBinary, ['serve', '--city', collection, '--port', '0'], { env: { ...process.env, VIGO_API_TOKEN: token } })
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
  const stationStops = await zip.file('stops.txt').async('string')
  const stairs = 'stairs,E,P,2,1,5,5\n', elevator = 'lift,E,P,5,0,60,60\n'
  for (const [variant, paths, ready] of [
    ['elevator-first', elevator + stairs, true], ['elevator-last', stairs + elevator, true],
    ['stairs-only', stairs, false], ['reverse-elevator', 'lift,P,E,5,0,60,60\n' + stairs, false],
    ['unknown-path', 'path,E,P,1,1,5,\n', false],
    ['minimum-after-stairs', stairs + elevator, false],
    ['minimum-before-stairs', elevator + stairs, false],
    ['generic-transfer-only', '', false], ['proved-street', '', true], ['street-minimum', '', false],
  ]) {
    zip.file('stops.txt', variant === 'proved-street' || variant === 'street-minimum'
      ? stationStops.replace('P,Platform,38.905,-77.0398,0,S,0', 'P,Bus,38.905,-77.0398,0,,1') : stationStops)
    if (variant === 'street-minimum') zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nX,P,2,600\n')
    else if (variant.startsWith('minimum')) zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nE,P,2,600\n')
    else if (['generic-transfer-only', 'proved-street'].includes(variant)) zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nX,P,0,0\n')
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
  // Untagged ordinary streets: inferred evidence routes over them; verified
  // evidence has no street to use and refuses to build a graphless City.
  fs.mkdirSync(path.join(folder, 'untagged'))
  const untagged = await writeCliFixtureInputs(path.join(folder, 'untagged'))
  const inferred = path.join(folder, 'untagged-inferred')
  build(untagged.gtfsPath, untagged.osmPath, inferred, ['--wheelchair'])
  for (const native of [false, true]) {
    const walk = run(inferred, 'route', { ...base, origin: { coordinate: [-77.05, 38.9] }, destination: { coordinate: [-77.04, 38.905] }, mode: 'walk', wheelchair: true, requireTransitRide: false }, native)
    assert.equal(walk.status, 'ok', JSON.stringify(walk).slice(0, 500))
    assert.equal(walk.accessibility.streetEvidence, 'inferred-step-free-v1')
  }
  assert.throws(() => build(untagged.gtfsPath, untagged.osmPath, path.join(folder, 'untagged-verified'), ['--wheelchair', '--wheelchair-streets', 'verified']), /Command failed/)
  assert.throws(() => build(untagged.gtfsPath, untagged.osmPath, path.join(folder, 'untagged-bad'), ['--wheelchair', '--wheelchair-streets', 'assumed']), /Command failed/)
  console.log('Wheelchair routing passed: inferred and verified street evidence, inheritance, barriers, accessible alternatives, CLI/native/HTTP/Studio, reverse, Matrix, Reach, transfer reserve, profile attachment and invalid requests.')
} finally {
  if (server) { server.kill(); await once(server, 'exit') }
  if (process.env.VIGO_KEEP_TEST_FIXTURES) console.log(folder)
  else fs.rmSync(folder, { recursive: true, force: true })
}
