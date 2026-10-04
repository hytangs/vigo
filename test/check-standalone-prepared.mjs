// Exercise source-bound snapshot reuse and every fallback on a public City.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from '../src/server/routing-snapshot.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-prepared-rust-'))
const city = path.join(directory, 'city')
const env = { ...process.env, RAYON_NUM_THREADS: '2' }
const base = { kind: 'route', serviceDate: '2026-07-15', time: '07:55', origin: { stopId: 'A' }, destination: { stopId: 'B' }, maxWalkKm: .2 }
const query = q => JSON.parse(execFileSync(binary, ['stream', '--city', city], {
  input: `${JSON.stringify(q)}\n`, env: { PATH: '', RAYON_NUM_THREADS: '2' }, encoding: 'utf8',
}))
const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['diagnostics', 'timing'].includes(key)).map(([k, v]) => [k, semantic(v)])) : value
let checked = 0
try {
  const inputs = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${city}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] })
  execFileSync(process.execPath, ['public/vigo.mjs', 'stream', `--city=${city}`, `--service-date=${base.serviceDate}`], { cwd: root, env, input: `${JSON.stringify(base)}\n`, stdio: ['pipe', 'ignore', 'pipe'] })
  const routing = path.join(city, 'routing')
  const snapshots = fs.readdirSync(routing).filter(n => n.includes('.active-service-kernel.')).map(n => path.join(routing, n))
  assert(snapshots.length > 0)
  const originals = snapshots.map(file => [file, fs.readFileSync(file)])
  const queries = []
  for (const timePreference of ['depart_at', 'arrive_by']) {
    for (const maxTransfers of [0, 1, 3]) {
      for (const minimumTransferBufferMinutes of [0, 5, 6]) {
        queries.push({ ...base, time: timePreference === 'arrive_by' ? '08:30' : base.time, timePreference, maxTransfers, minimumTransferBufferMinutes })
      }
    }
  }
  const prepared = queries.map(q => {
    const r = query(q)
    assert.equal(r.timing.timetableSource, 'prepared_snapshot')
    checked++
    return semantic(r)
  })
  const restore = () => { for (const [file, bytes] of originals) fs.writeFileSync(file, bytes) }
  for (const [file] of originals) fs.unlinkSync(file)
  queries.forEach((q, i) => {
    const r = query(q)
    assert.equal(r.timing.timetableSource, 'source')
    assert.deepEqual(semantic(r), prepared[i], 'Prepared and SQLite journeys differ')
    checked++
  })
  restore()
  const corruptions = [
    m => { m.kernel.sourceArtifactIdentity += '-stale' },
    m => { m.kernel.accessPolicyIdentity += '-stale' },
    m => { m.kernel.serviceKey += '-other-date' },
    m => { m.kernel.transferProjectionVersion = 'old' },
    m => { m.kernel.transferProjectionVerified = false },
    m => { m.kernel.tripIds.pop() },
    m => { m.kernel.stopIds[0] = 'wrong-stop' },
    m => { m.kernel.stopIds[0] = m.kernel.stopIds[1] },
    m => { m.kernel.serviceIds[0] = 'wrong-service' },
    (_m, a) => { a.fromStop[0] = 0xffffffff },
  ]
  for (const corrupt of corruptions) {
    for (const [file, bytes] of originals) {
      const { metadata, arrays } = decodeRoutingSnapshot(bytes)
      corrupt(metadata, arrays)
      fs.writeFileSync(file, encodeRoutingSnapshot(metadata, arrays))
    }
    const r = query(queries[0])
    assert.equal(r.timing.timetableSource, 'source')
    assert.deepEqual(semantic(r), prepared[0])
    checked++
    restore()
  }
  for (const [file] of originals) fs.writeFileSync(file, Buffer.from('broken'))
  assert.equal(query(base).timing.timetableSource, 'source'); checked++
  restore()
  for (const [file, bytes] of originals) {
    const length = bytes.readUInt32LE(8)
    const header = JSON.parse(bytes.subarray(16, 16 + length))
    header.arrays.arrivalSeconds.offset = header.arrays.departureSeconds.offset
    const encoded = Buffer.from(JSON.stringify(header))
    assert(encoded.length <= length)
    const invalid = Buffer.from(bytes)
    invalid.fill(32, 16, 16 + length)
    encoded.copy(invalid, 16)
    fs.writeFileSync(file, invalid)
  }
  assert.equal(query(base).timing.timetableSource, 'source'); checked++
  restore()
  assert.equal(query({ ...base, allowStreetTransfers: false }).timing.timetableSource, 'source'); checked++
  assert.equal(query({ ...base, realtimeSnapshot: { feedTimestamp: Math.floor(Date.now() / 1000), tripUpdates: [] } }).timing.timetableSource, 'source'); checked++

  for (const timePreference of ['depart_at', 'arrive_by']) {
    const q = { kind: 'matrix', mode: 'transit', serviceDate: base.serviceDate, time: '08:30', timePreference, origins: [base.origin, base.origin, base.destination], destinations: [base.destination, base.origin], includeJourneys: true }
    const full = query(q)
    const compact = query({ ...q, journeyFormat: 'compact' })
    const unique = query({ ...q, origins: [base.origin, base.destination] })
    assert.deepEqual(full.durationsMinutes, [unique.durationsMinutes[0], unique.durationsMinutes[0], unique.durationsMinutes[1]])
    assert.deepEqual(full.journeys, [unique.journeys[0], unique.journeys[0], unique.journeys[1]],
      'Sharing repeated endpoints preserves every full journey and output position.')
    assert.deepEqual(query({ ...q, includeJourneys: false }).durationsMinutes, full.durationsMinutes)
    assert.deepEqual(compact.durationsMinutes, full.durationsMinutes)
    for (let i = 0; i < q.origins.length; i++) for (let j = 0; j < q.destinations.length; j++) {
      const a = compact.journeys[i][j], b = full.journeys[i][j]
      if (b === null) { assert.equal(a, null); continue }
      for (const key of ['departureMinutes', 'arrivalMinutes', 'durationMinutes', 'transfers', 'walkMinutes', 'rideMinutes', 'waitMinutes']) assert.equal(a[key], b[key])
      assert.deepEqual(a.legs, b.legs.map(l => ({ kind: l.kind, fromStopId: l.fromStopId ?? null, toStopId: l.toStopId ?? null, departureMinutes: l.departureMinutes, arrivalMinutes: l.arrivalMinutes, durationMinutes: l.durationMinutes,
        ...(l.kind === 'ride' ? { tripId: l.tripId, boardSequence: l.boardSequence, alightSequence: l.alightSequence } : {}) })))
    }
    checked++
    for (const patch of [{ journeyFormat: false }, { journeyFormat: 'other' }, { journeyFormat: 'compact', includeJourneys: false }, { journeyFormat: 'compact', includeGeometry: true }, { journeyFormat: 'full', mode: 'walk' }]) {
      assert(query({ ...q, ...patch }).error); checked++
    }
  }
  // A required stale access context is an error, not an optional-sidecar miss.
  const accessFile = path.join(routing, 'project.sqlite.access-context.bin')
  const { metadata, arrays } = decodeRoutingSnapshot(fs.readFileSync(accessFile))
  const originalAccess = fs.readFileSync(accessFile)
  const oldPolicy = JSON.parse(metadata.accessPolicyIdentity)
  delete oldPolicy.transferWalkingTimeFloor
  metadata.accessPolicyIdentity = JSON.stringify(oldPolicy)
  fs.writeFileSync(accessFile, encodeRoutingSnapshot(metadata, arrays))
  const stalePolicy = spawnSync(binary, ['info', '--city', city], { env, encoding: 'utf8' })
  assert.equal(stalePolicy.status, 2)
  assert.match(stalePolicy.stderr, /station walking times are stale/); checked++
  fs.writeFileSync(accessFile, originalAccess)
  metadata.accessPolicyIdentity = decodeRoutingSnapshot(originalAccess).metadata.accessPolicyIdentity
  metadata.sourceArtifactIdentity += '-stale'
  fs.writeFileSync(accessFile, encodeRoutingSnapshot(metadata, arrays))
  assert.equal(spawnSync(binary, ['info', '--city', city], { env }).status, 2); checked++
  console.log(JSON.stringify({ checked, status: 'passed' }))
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
