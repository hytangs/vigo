// Portable public fixture: eight distinct timetables, one immutable street
// network, a two-City resident budget, and no traffic/realtime state leakage.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-collection-'))
let worker, server
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(dir)
  const original = digest(gtfsPath)
  const scenarios = []
  for (let n = 0; n < 8; n++) {
    const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
    const calls = await zip.file('stop_times.txt').async('string')
    zip.file('stop_times.txt', calls.replaceAll('08:30:00', `08:${30+n}:00`))
    zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,trip_headsign,trip_short_name\nR1,WKD,T1,0,Transfer,One\nR2,WKD,T2,0,Bravo,Two\n')
    // Distinct stop dimensions exercise workspace rebinding, not only
    // different clocks in identically sized schedules.
    const stops = await zip.file('stops.txt').async('string')
    zip.file('stops.txt', [stops.trimEnd(), ...Array.from({length:n},(_,i)=>`Q${i},Extra ${i},38.901,-77.049`)].join('\n') + '\n')
    const name = `s${n}.zip`
    fs.writeFileSync(path.join(dir, name), await zip.generateAsync({ type: 'nodebuffer' }))
    scenarios.push({ id: `s${n}`, name: `Scenario ${n}`, feeds: [{ path: name, scope: 'test', sha256: digest(path.join(dir, name)) }] })
  }
  const spec = { schemaVersion: 'vigo.scenarios.source.v1', name: 'Eight scenarios', maximumResidentScenarios: 2, prepareDates: ['2026-07-15'],
    osm: { path: path.basename(osmPath), sha256: digest(osmPath) }, scenarios }
  const specPath = path.join(dir, 'source.json')
  fs.writeFileSync(specPath, JSON.stringify(spec))
  const built = path.join(dir, 'built')
  execFileSync(process.execPath, ['public/vigo.mjs', 'build-scenarios', '--spec', specPath, '--output', built], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 8*1024*1024 })
  // Moving the entire collection must preserve all relative references.
  const collection = path.join(dir, 'moved')
  fs.renameSync(built, collection)
  assert.equal(digest(gtfsPath), original)
  const streetDirectories = scenarios.map(s => fs.realpathSync(path.join(collection, 'cities', s.id, 'osm')))
  assert.equal(new Set(streetDirectories).size, 1)
  assert(!fs.readdirSync(streetDirectories[0]).some(name => name.includes('.drive-')), 'Walking preparation must omit driving indexes')
  const checksums = JSON.parse(fs.readFileSync(path.join(collection, 'checksums.json')))
  for (const file of checksums.files) assert.equal(digest(path.join(collection, file.path)), file.sha256)
  const base = { kind: 'route', serviceDate: '2026-07-15', time: '07:55', maxWalkKm: .2,
    requireTransitRide: true, origin: { stopId: 'A' }, destination: { stopId: 'B' } }
  const coordinates = { ...base, disableCache: true,
    origin: { coordinate: [-77.0499, 38.90005] }, destination: { coordinate: [-77.0301, 38.90995] } }
  const isolated = scenarios.map(s => JSON.parse(execFileSync(standaloneBinary,
    ['route', '--city', path.join(collection, 'cities', s.id), '--request', '-'],
    { input: JSON.stringify(coordinates), encoding: 'utf8' })).journey)
  const residents = Number(process.env.VIGO_TEST_SCENARIO_RESIDENTS || 2)
  worker = spawn(standaloneBinary, ['stream', '--city', collection], { env: { ...process.env, VIGO_MAX_RESIDENT_SCENARIOS: String(residents), VIGO_ENDPOINT_CACHE_MAX_BYTES: '65536', VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES: '65536' } })
  let stderr = ''; worker.stderr.on('data', bytes => { stderr += bytes })
  const pending = []
  const reader = createInterface({ input: worker.stdout })
  reader.on('line', line => pending.shift()?.(JSON.parse(line)))
  const query = value => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker timeout ${stderr}`)), 10000)
    pending.push(value => { clearTimeout(timer); resolve(value) })
    worker.stdin.write(JSON.stringify(value) + '\n')
  })
  let walkingWitness
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let n = 0; n < 8; n++) {
      const walk = await query({ ...base, scenarioId: `s${n}`, mode: 'walk', requireTransitRide: false,
        origin: { coordinate: [-77.049, 38.9005] }, destination: { coordinate: [-77.031, 38.9095] } })
      assert.equal(walk.status, 'ok')
      walkingWitness ??= walk.journey
      assert.deepEqual(walk.journey, walkingWitness, 'Shared path scratch must preserve the complete directed geometry and timing')
      const fromCoordinates = await query({ ...coordinates, scenarioId: `s${n}` })
      assert.equal(fromCoordinates.status, 'ok')
      assert.deepEqual(fromCoordinates.journey, isolated[n], 'Reused street scratch must match an isolated City with its own access targets')
      const result = await query({ ...base, scenarioId: `s${n}` })
      assert.equal(result.status, 'ok', JSON.stringify(result))
      assert.equal(result.scenarioId, `s${n}`)
      assert.equal(result.journey.arrivalTime, `08:${30+n}:00`)
      const rides = result.journey.legs.filter(l => l.type === 'transit')
      assert.equal(rides.at(-1).headsign, 'Bravo')
      assert.equal(rides.at(-1).trip.id, 'T2')
      const arrive = await query({ ...base, scenarioId: `s${n}`, time: '09:00', timePreference: 'arrive_by', windowMinutes: 5 })
      assert.equal(arrive.journey.departureTime, '08:00:00')
      assert.equal(arrive.alternativeSearch.direction, 'earlier_arrival_deadlines')
    }
  }
  const info = await query({ kind: 'info' })
  assert.equal(info.residency.loadedScenarios, Math.min(residents, 8))
  assert.equal(info.residency.sharedStreetGraphs, 1)
  assert.equal(info.residency.timetableQueryWorkspaces, 1)
  assert.equal(info.memory.trackedHeapBytes, info.memory.networkHeapBytes + info.memory.workspaceHeapBytes
    + info.memory.cacheHeapBytes + info.memory.sqliteHeapBytes)
  const ledgers = info.residency.scenarios.map(s => s.memory.ledger)
  assert.equal(info.memory.mappedFileBytes, ledgers[0].street.sharedMappedFileBytes
    + ledgers.reduce((sum,s) => sum + s.street.accessMappedFileBytes + s.contextMappedFileBytes, 0),
    'The shared mapped network is counted once; scenario-specific mappings remain separate')
  assert(info.residency.timetableSharedBlockBytes > 0)
  assert(info.residency.timetableBlockReferences > info.residency.timetableUniqueBlocks,
    'Scenario views must reference shared immutable blocks; small fixtures need not save bytes after block overhead')
  assert(info.residency.timetableWorkspaceBytes > 0)
  assert(info.residency.scenarios.every(s => s.memory.timetable == null || s.memory.timetable.workspaceBytes === 0),
    'Inactive scenario schedules must not retain query workspaces')
  assert.equal(info.residency.evictions > 0, residents < 8)
  assert(info.residency.scenarios.every(s => s.memory.sharedStreetOwners === Math.min(residents, 8)))
  assert(info.residency.scenarios.reduce((n,s) => n + s.memory.access.endpointCacheMaximumBytesPerRole,0) <= 65536,
    'The endpoint budget applies to the entire collection, not independently to every scenario')
  assert(info.residency.scenarios.reduce((n,s) => n + s.memory.geometry.maximumBytes,0) <= 65536)
  const bad = await query({ ...base, scenarioId: 'missing' })
  assert.equal(bad.status, 'error')
  assert.match(bad.error.message, /Unknown scenarioId/)
  const unsupported = await query({ ...base, wheelchair: true })
  assert.equal(unsupported.status, 'error')
  assert.match(unsupported.error.message, /Wheelchair.*built with --wheelchair/)
  const date = await query({ ...base, serviceDate: '2026-07-19' })
  assert.equal(date.status, 'not_found')
  const weekday = await query({ ...base })
  assert.equal(weekday.journey.arrivalTime, '08:30:00')
  const delayed = await query({ ...base, scenarioId: 's0', realtimeSnapshot: { feedTimestamp: Math.floor(Date.now()/1000), tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }] } })
  assert.equal(delayed.journey.arrivalTime, '08:40:00')
  assert.equal((await query({ ...base, scenarioId: 's0' })).journey.arrivalTime, '08:30:00')
  const noAccess = await query({ ...base, windowMinutes: 10, origin: { coordinate: [-78, 38.9] } })
  assert.equal(noAccess.status, 'not_found')
  assert.equal(noAccess.access.origin.code, 'no_street_attachment')
  const cli = JSON.parse(execFileSync(standaloneBinary, ['route', '--city', collection, '--scenario', 's4', '--request', '-'], { input: JSON.stringify(base), encoding: 'utf8' }))
  assert.equal(cli.journey.arrivalTime, '08:34:00')
  server = spawn(standaloneBinary, ['serve', '--city', collection, '--port', '0'])
  const port = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error(log)), 10000)
    server.stderr.on('data', bytes => { log += bytes; const match = log.match(/listening on 127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
  })
  const http = await fetch(`http://127.0.0.1:${port}/v1/route`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, scenarioId: 's6' }) })
  assert.equal(http.status, 200)
  assert.equal((await http.json()).journey.arrivalTime, '08:36:00')
  console.log('Scenario collection passed: eight distinct timetables, shared immutable streets, bounded residency, source checksums, relocation, calendar/realtime isolation, native CLI and HTTP.')
} finally {
  for (const child of [worker, server]) if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  fs.rmSync(dir, { recursive: true, force: true })
}
