// Contract checks use public synthetic GTFS/OSM and both production transports.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { renderPublicText } from '../src/server/native-routing-kernel.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { classifyResponse } from '../scripts/lib/benchmark-response.mjs'
const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-public-results-'))
const city = path.join(directory, 'city')
const servers = []
let checks = 0
const base = { serviceDate: '2026-07-15', time: '07:55', origin: { stop: { feed: null, id: 'A' } }, destination: { stop: { feed: null, id: 'B' } }, maxWalkKm: .2, requireTransitRide: true }
const forbidden = ['memberIndices', 'pathMemberIndices', 'queryToken', 'linkFromStopKeys', 'originAccess', 'accessReductionNs', '4294967295', '\\u001f']
function assertPublic(result, request = result.query) {
  assert.match(result.schema, /^vigo\.(route|matrix|reach)\.v1$/)
  assert(['ok', 'not_found'].includes(result.status))
  const encoded = JSON.stringify(result)
  for (const key of forbidden) assert(!encoded.includes(key), `Leaked ${key}`)
  assert(!encoded.includes(String.fromCharCode(92) + 'u001f'), 'Leaked scoped identifier delimiter')
  assert(!Object.hasOwn(result, 'diagnostics'))
  assert(!Object.hasOwn(result, 'timing'))
  assert.match(result.meta.queryFingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(classifyResponse({ ...request, kind: result.schema.split('.')[1] }, 200, result), { outcome: result.status },
    'Benchmark validation must accept production public output from both runtimes.')
  checks++
}
try {
  const inputs = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${city}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
  function cli(runtime, kind, query) {
    const node = runtime === 'node'
    return JSON.parse(execFileSync(node ? process.execPath : standaloneBinary,
      [...(node ? ['public/vigo.mjs'] : []), kind, '--city', city, '--request', '-', ...(node ? ['--service-date', query.serviceDate ?? base.serviceDate] : [])],
      { cwd: root, input: JSON.stringify(query), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  }
  const results = []
  for (const runtime of ['rust', 'node']) {
    // The wrapper transport must preserve the complete detailed result while
    // omitting the public projection. Errors remain framed and recoverable.
    const wireRequests = [
      { ...base, id: 'route', kind: 'route' },
      { serviceDate: base.serviceDate, time: base.time, id: 'matrix', kind: 'matrix', origins: [base.origin], destinations: [base.destination], includeJourneys: true },
      { serviceDate: base.serviceDate, time: base.time, id: 'reach', kind: 'reach', origin: base.origin, cutoffsMinutes: [15], rasterSize: 48 },
      { ...base, id: 'blocked', kind: 'route', time: '29:50' },
    ]
    const wire = wireRequests.map(q => JSON.stringify(q)).join('\n') + '\n{bad json\n' + JSON.stringify({ ...base, id: 'recovery', kind: 'route' }) + '\n'
    const stream = options => execFileSync(runtime === 'node' ? process.execPath : standaloneBinary,
      [...(runtime === 'node' ? ['public/vigo.mjs'] : []), 'stream', '--city', city, ...options],
      { cwd: root, input: wire, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n').map(line => JSON.parse(line))
    const traced = stream(['--diagnostics=trace'])
    const detailed = stream(['--stream-output=detailed'])
    const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !['timing', 'diagnostics', 'profile', 'meta', 'nativeStreetQueryMs'].includes(key)).map(([key, item]) => [key, semantic(item)])) : value
    assert.equal(detailed.length, traced.length)
    for (let index = 0; index < traced.length; index++) {
      if (traced[index].status === 'error') { assert.equal(detailed[index].status, 'error'); continue }
      assert.equal(detailed[index].schema, 'vigo.stream.detail.v1')
      assert.equal(detailed[index].id, traced[index].id)
      assert(!Object.hasOwn(detailed[index], 'journey'))
      assert.deepEqual(semantic(detailed[index].trace), semantic(traced[index].trace))
      checks++
    }
    const result = cli(runtime, 'route', base)
    assertPublic(result)
    assert.equal(result.journey.arrivalTime, '08:30:00')
    assert.equal(result.journey.durationSeconds, 2100)
    assert.equal(result.journey.walkingSeconds + result.journey.waitingSeconds + result.journey.ridingSeconds, result.journey.durationSeconds)
    assert.deepEqual(result.journey.legs.filter(l => l.type === 'transit').map(l => l.trip.id), ['T1', 'T2'])
    assert(result.journey.legs.some(l => l.geometry?.coordinates?.length > 1))
    const compact = cli(runtime, 'route', { ...base, includeGeometry: false })
    assert(compact.journey.legs.every(l => !Object.hasOwn(l, 'geometry')))
    assert.equal(compact.journey.arrivalTime, result.journey.arrivalTime)
    assert.equal(compact.meta.queryFingerprint, result.meta.queryFingerprint)
    checks += 3
    const summary = cli(runtime, 'route', { ...base, diagnostics: 'summary' })
    assert(summary.diagnostics && !summary.trace && !summary.profile)
    assert.match(renderPublicText(result), /08:30:00/)
    assert.equal(renderPublicText(summary), null, 'Requested diagnostics must remain visible as JSON')
    const executable = runtime === 'node' ? process.execPath : standaloneBinary
    const prefix = runtime === 'node' ? ['public/vigo.mjs'] : []
    const terminal = (...options) => execFileSync(executable, [...prefix, 'route', '--city', city, '--request', '-', ...options], { cwd: root, input: JSON.stringify(base), encoding: 'utf8' })
    assert.match(terminal('--format', 'text'), /08:30:00/)
    assert.equal(JSON.parse(terminal('--format', 'text', '--diagnostics', 'summary')).schema, 'vigo.route.v1')
    assert.equal(JSON.parse(terminal('--format=json')).schema, 'vigo.route.v1')
    checks += 5
    assert.equal(summary.meta.queryFingerprint, result.meta.queryFingerprint)
    const profile = cli(runtime, 'route', { ...base, diagnostics: 'profile' })
    assert(profile.profile.timingsUs && !profile.trace)
    const trace = cli(runtime, 'route', { ...base, diagnostics: 'trace', includeGeometry: true })
    assert(trace.trace)
    assert.deepEqual(result.journey.legs.map(l => l.geometry), trace.journey.legs.map(l => l.geometry))
    checks++
    assert(trace.journey.legs.some(l => l.geometry?.coordinates?.length > 1))
    assert.equal(trace.journey.arrivalTime, result.journey.arrivalTime)
    const noJourney = cli(runtime, 'route', { ...base, maxTransfers: 0 })
    assert.equal(noJourney.status, 'not_found')
    assertPublic(noJourney)
    assert.equal(cli(runtime, 'route', { ...base, serviceDate: '2026-07-19' }).status, 'not_found')
    const matrix = cli(runtime, 'matrix', { serviceDate: base.serviceDate, time: base.time, origins: [base.origin], destinations: [base.destination], maxWalkKm: .2, requireTransitRide: true, includeJourneys: true })
    assertPublic(matrix, { origins: [base.origin], destinations: [base.destination] })
    assert.deepEqual(matrix.durationsSeconds, [[2100]])
    const { requireTransitRide, ...defaultQuery } = base
    const defaultRoute = cli(runtime, 'route', defaultQuery)
    const walkingRoute = cli(runtime, 'route', { ...defaultQuery, mode: 'walk' })
    assertPublic(defaultRoute)
    assert.equal(defaultRoute.journey.durationSeconds, walkingRoute.journey.durationSeconds)
    assert(defaultRoute.journey.durationSeconds < result.journey.durationSeconds)
    assert(defaultRoute.journey.legs.every(leg => leg.type === 'walk'))
    assert(defaultRoute.journey.legs.every(leg => leg.geometry?.coordinates?.length >= 2))
    if (runtime === 'rust') {
      const window = cli(runtime, 'route', { ...defaultQuery, windowMinutes: 5 })
      assertPublic(window)
      for (const candidate of [window.journey, ...(window.alternatives ?? [])]) {
        if (candidate.legs.length === 1 && candidate.legs[0].type === 'walk') {
          assert.deepEqual(candidate.legs[0].from.stop, base.origin.stop)
          assert.deepEqual(candidate.legs[0].to.stop, base.destination.stop)
        }
      }
    }
    const defaultMatrix = cli(runtime, 'matrix', { serviceDate: base.serviceDate, time: base.time, origins: [base.origin], destinations: [base.destination], maxWalkKm: .2, includeJourneys: true })
    assertPublic(defaultMatrix)
    assert.deepEqual(defaultMatrix.durationsSeconds, [[defaultRoute.journey.durationSeconds]])
    assert.deepEqual(defaultMatrix.journeys[0][0].legs[0].from.stop, base.origin.stop)
    assert.deepEqual(defaultMatrix.journeys[0][0].legs[0].to.stop, base.destination.stop)
    checks += 5
    const reach = cli(runtime, 'reach', { serviceDate: base.serviceDate, time: base.time, origin: base.origin, rasterSize: 48, cutoffsMinutes: [15, 30], maxWalkKm: .2 })
    assertPublic(reach, { rasterSize: 48 })
    const map = cli(runtime, 'reach', { serviceDate: base.serviceDate, time: base.time, origin: base.origin, rasterSize: 48, cutoffsMinutes: [15, 30], maxWalkKm: .2, reachFormat: 'map' })
    assertPublic(map, { reachFormat: 'map' })
    assert.deepEqual(map.areas, reach.fullAreas || reach.areas)
    assert(!Object.hasOwn(map, 'surface') && !Object.hasOwn(map, 'stops') && !Object.hasOwn(map, 'contours'))
    assert.equal(map.meta.queryFingerprint, reach.meta.queryFingerprint)
    assert.equal(reach.surface.valuesSeconds.length, 48 * 48)
    assert.deepEqual(reach.cutoffsSeconds, [900, 1800])
    assert(reach.surface.valuesSeconds.every(v => v === null || Number.isInteger(v)))
    results.push(result)
    checks += 12
  }
  assert.equal(results[0].journey.arrivalTime, results[1].journey.arrivalTime)
  {
    const child = spawn(standaloneBinary, ['serve', '--city', city, '--port', '0'], { env: { ...process.env, VIGO_API_TOKEN: 'public-contract-test-token' } })
    servers.push(child)
    const port = await new Promise((resolve, reject) => {
      let log = ''; const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${log}`)), 15000)
      const read = data => { log += data; const match = log.match(/listening on 127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])) } }
      child.stdout.on('data', read); child.stderr.on('data', read)
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exit ${code}: ${log}`)) })
    })
    const url = `http://127.0.0.1:${port}/v1/route`
    const headers = { authorization: 'Bearer public-contract-test-token', 'content-type': 'application/json' }
    for (const level of ['none', 'summary', 'profile', 'trace']) {
      const response = await fetch(`${url}?diagnostics=${level}`, { method: 'POST', headers, body: JSON.stringify(base) })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('server-timing') ?? '', /serialize;dur=/)
      const result = await response.json()
      assert.equal(result.journey.arrivalTime, '08:30:00')
      assert(result.journey.legs.some(l => l.geometry?.coordinates?.length > 1))
      assert.equal(Object.hasOwn(result, 'diagnostics'), level !== 'none')
      assert.equal(Object.hasOwn(result, 'trace'), level === 'trace')
      checks++
    }
    const invalid = await fetch(`${url}?diagnostics=banana`, { method: 'POST', headers, body: JSON.stringify(base) })
    assert(invalid.status >= 400 && invalid.status < 500)
    assert.equal((await invalid.json()).error.code, 'invalid_request')
    const unauthenticated = await fetch(url, { method: 'POST', body: JSON.stringify(base) })
    assert.equal(unauthenticated.status, 401)
    assert.equal((await unauthenticated.json()).error.code, 'unauthorized')
    checks += 2
  }
  console.log(`Public result contract: ${checks} checks passed across both CLIs and native HTTP.`)
} finally {
  for (const child of servers) if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
  fs.rmSync(directory, { recursive: true, force: true })
}
