import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-all-day-'))
const children = []
function resident(city) {
  const child = spawn(standaloneBinary, ['stream', '--city', city], { cwd: root })
  children.push(child)
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  return async request => {
    child.stdin.write(JSON.stringify(request) + '\n')
    let timeout
    const line = await Promise.race([lines.next(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`All-day query timeout: ${stderr}`)), 60000)
    })]).finally(() => clearTimeout(timeout))
    assert(!line.done, stderr)
    return JSON.parse(line.value)
  }
}
try {
  const inputs = await writeCliFixtureInputs(temporary)
  const city = path.join(temporary, 'city')
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${city}`], { cwd: root, stdio: 'pipe' })
  const aggregate = resident(city)
  // Separate process, no endpoint cache and no batch aggregation implementation.
  const independent = resident(city)
  const q = { kind: 'reach', serviceDate: '2026-07-15', mode: 'transit',
    origin: { coordinate: [-77.049, 38.9005] }, rasterSize: 16,
    extentRadiusKm: 1, maxWalkKm: .2, cutoffsMinutes: [5, 15, 30], reachFormat: 'surface' }
  for (const window of [{}, { startMinutes: 475, endMinutes: 492 }]) {
    const actual = await aggregate({ ...q, allDay: window })
    assert.equal(actual.status, 'ok', JSON.stringify(actual))
    assert.equal(actual.schema, 'vigo.reach.v1')
    assert.equal(actual.query.requestedTime, undefined)
    assert.equal(actual.surface.valuesSeconds, undefined)
    assert.equal(actual.samples, undefined)
    const counts = Array(256).fill(0), sums = Array(256).fill(0)
    const cutoffCounts = q.cutoffsMinutes.map(() => Array(256).fill(0))
    let samples = 0
    for (let minute = window.startMinutes ?? 0; minute < (window.endMinutes ?? 1440); minute += 5) {
      const sample = await independent({ ...q, timeMinutes: minute, disableCache: true, diagnostics: 'trace' })
      assert.equal(sample.status, 'ok', JSON.stringify(sample))
      assert.deepEqual(sample.surface.bounds, actual.surface.bounds)
      sample.trace.surface.values.forEach((minutes, i) => {
        if (minutes === null) return
        const seconds = minutes * 60
        counts[i]++; sums[i] += seconds
        q.cutoffsMinutes.forEach((cutoff, k) => { if (seconds <= cutoff * 60) cutoffCounts[k][i]++ })
      })
      samples++
    }
    assert.equal(actual.allDay.sampleCount, samples)
    assert.deepEqual(actual.surface.reachableSamples, counts)
    assert.deepEqual(actual.surface.reachableSamplesByCutoff, cutoffCounts)
    actual.surface.meanReachableDurationSeconds.forEach((mean, i) => {
      if (!counts[i]) assert.equal(mean, null)
      else assert(Math.abs(mean - sums[i] / counts[i]) < 1e-8)
    })
    assert(counts.some(n => n === 0), 'Fixture must include unreachable cells')
    assert(counts.some(n => n > 0), 'Fixture must include reachable cells')
  }
  const requestFile = path.join(temporary, 'all-day.json')
  fs.writeFileSync(requestFile, JSON.stringify({ ...q, allDay: { startMinutes: 480, endMinutes: 485 } }))
  const oneOff = JSON.parse(execFileSync(standaloneBinary, ['reach', '--city', city, '--request', requestFile], { encoding: 'utf8' }))
  assert.equal(oneOff.allDay.sampleCount, 1)
  assert.throws(() => execFileSync(process.execPath,
    ['public/vigo.mjs', 'reach', `--city=${city}`, `--request=${requestFile}`],
    { cwd: root, stdio: 'pipe' }), error => /allDay Reach currently requires the Rust/.test(String(error.stderr)),
    'The Node CLI must reject allDay explicitly rather than silently running one time.')

  const server = spawn(standaloneBinary, ['serve', '--city', city, '--port', '0'], {
    env: { ...process.env, VIGO_API_TOKEN: 'all-day-fixture-token' },
  })
  children.push(server)
  const port = await new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => reject(new Error(`HTTP startup timeout: ${log}`)), 30000)
    server.stderr.on('data', chunk => {
      log += chunk
      const match = log.match(/listening on 127\.0\.0\.1:(\d+)/)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`HTTP exited ${code}: ${log}`)) })
  })
  const response = await fetch(`http://127.0.0.1:${port}/v1/reach`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer all-day-fixture-token' },
    body: fs.readFileSync(requestFile, 'utf8'), signal: AbortSignal.timeout(30000),
  })
  assert.equal(response.status, 200)
  const http = await response.json()
  assert.deepEqual(http.surface, oneOff.surface)
  assert.deepEqual(http.allDay, oneOff.allDay)

  const short = { ...q, allDay: { startMinutes: 480, endMinutes: 485 } }
  const alias = await aggregate({ ...short, dataMode: 'scheduled' })
  assert.equal(alias.status, 'ok')
  assert.deepEqual(alias.surface, oneOff.surface)
  const traced = await aggregate({ ...short, diagnostics: 'trace' })
  assert.equal(traced.status, 'ok')
  assert.deepEqual(traced.trace.surface, traced.surface)
  assert.deepEqual(traced.trace.allDay, traced.allDay)
  assert.equal(traced.trace.query.requestedTime, undefined)
  for (const invalid of [
    { allDay: true }, { allDay: { stepMinutes: 10 } },
    { allDay: { startMinutes: 5, endMinutes: 5 } },
    { allDay: { startMinutes: .5 } }, { allDay: { endMinutes: 1441 } },
    { allDay: {}, timeMinutes: 480 }, { allDay: {}, timePreference: 'arrive_by' },
    { allDay: {}, mode: 'drive' }, { allDay: {}, surfaceSampling: 'cell-center' },
    { allDay: {}, disableCache: true }, { allDay: {}, routingDataMode: 'realtime' },
    { allDay: {}, unexpected: true },
    { allDay: {}, mode: 7 }, { allDay: {}, mode: null },
    { allDay: {}, dataMode: 'scheduled', routingDataMode: 'scheduled' },
  ]) {
    const result = await aggregate({ ...q, ...invalid })
    assert.notEqual(result.status, 'ok', JSON.stringify(invalid))
  }
  const after = await aggregate({ ...q, timeMinutes: 480 })
  assert.equal(after.status, 'ok', 'Rejected batches must leave resident queries usable')
  console.log('All-day Reach: 292 independent time samples, all raster counts and conditional means agree; validation and resident recovery passed.')
} finally {
  for (const child of children) child.kill()
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
