import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { classifyResponse, classifyTransportError, withDeadline } from '../scripts/lib/benchmark-response.mjs'

const point = { coordinate: [-71, 42] }
const publicJourney = { departureTime: '25:00:00', arrivalTime: '25:01:00', durationSeconds: 60,
  walkingSeconds: 60, waitingSeconds: 0, ridingSeconds: 0, boardings: 0, transfers: 0,
  legs: [{ type: 'walk', from: point, to: point, departureTime: '25:00:00', arrivalTime: '25:01:00', durationSeconds: 60 }] }
const emptyFeatures = { type: 'FeatureCollection', features: [] }
const queries = { route: { kind: 'route', origin: point, destination: point },
  matrix: { kind: 'matrix', origins: [point], destinations: [point, point] },
  reach: { kind: 'reach', origin: point } }
function publicResult(query) {
  const result = { schema: `vigo.${query.kind}.v1`, status: 'ok',
    query: { serviceDate: '2026-10-08', requestedTime: '25:00:00', timePreference: 'depart_at' },
    meta: { engineVersion: 'fixture', queryFingerprint: 'a'.repeat(64) } }
  if (query.kind === 'route') return { ...result, journey: publicJourney }
  if (query.kind === 'matrix') return { ...result, query: { ...result.query, origins: query.origins, destinations: query.destinations }, durationsSeconds: [[60, null]] }
  if (query.reachFormat === 'map') return { ...result, cutoffsSeconds: [60], bounds: [-72, 41, -70, 43], areas: emptyFeatures }
  return { ...result, cutoffsSeconds: [60], areas: emptyFeatures, contours: emptyFeatures,
    surface: { width: 2, height: 1, bounds: [-72, 41, -70, 43], valuesSeconds: [60, null] } }
}
const noJourney = { ...publicResult(queries.route), status: 'not_found', journey: null, reason: { code: 'no_path', message: 'No path.' } }
const queryError = { schema: 'vigo.error.v1', status: 'error', error: { code: 'invalid_request', message: 'Invalid input.' } }

// Pure classification checks supplement transport tests and exercise malformed
// fields without needing a separate server request for every schema boundary.
for (const query of [...Object.values(queries), { ...queries.reach, reachFormat: 'map' }]) {
  assert.equal(classifyResponse(query, 200, publicResult(query)).outcome, 'ok')
  assert.equal(classifyResponse(query, 200, { status: 'ok' }).outcome, 'invalid_response')
  const wrongSchema = { ...publicResult(query), schema: 'vigo.wrong.v1' }
  assert.equal(classifyResponse(query, 200, wrongSchema).outcome, 'invalid_response')
  assert.equal(classifyResponse(query, 200, { ...publicResult(query), status: 'unexpected' }).outcome, 'invalid_response')
}
assert.equal(classifyResponse(queries.route, 200, noJourney).outcome, 'not_found')
assert.equal(classifyResponse(queries.route, 200, { ...noJourney, reason: null }).outcome, 'invalid_response')
assert.equal(classifyResponse(queries.route, 200, queryError).outcome, 'query_error')
assert.equal(classifyResponse(queries.route, 200, { status: 'error' }).outcome, 'invalid_response')
for (const [query, mutate] of [
  [queries.route, r => { delete r.journey }],
  [queries.route, r => { r.journey.durationSeconds = '60' }],
  [queries.route, r => { delete r.journey.legs }],
  [queries.route, r => { r.journey.legs[0].from = {} }],
  [queries.route, r => { r.journey.legs[0].to = { stop: { feed: null, id: 'A' }, coordinate: [null, null] } }],
  [queries.route, r => { r.journey.legs[0].geometry = { type: 'LineString', coordinates: [[-71, 42], [null, null]] } }],
  [queries.route, r => { r.alternatives = [{}] }],
  [queries.matrix, r => { delete r.durationsSeconds }],
  [queries.matrix, r => { r.durationsSeconds = [[60]] }],
  [queries.matrix, r => { r.durationsSeconds = [[60, -1]] }],
  [queries.matrix, r => { r.query.origins = [] }],
  [queries.matrix, r => { r.journeys = [[{}]] }],
  [queries.reach, r => { delete r.surface }],
  [queries.reach, r => { r.surface.valuesSeconds = [60] }],
  [queries.reach, r => { r.surface.valuesSeconds = [60, 'null'] }],
  [queries.reach, r => { r.surface.width = 0 }],
  [queries.reach, r => { r.surface.bounds = [0, 0, 0, 1] }],
  [queries.reach, r => { delete r.cutoffsSeconds }],
  [queries.reach, r => { r.areas = {} }],
  [{ ...queries.reach, reachFormat: 'map' }, r => { delete r.bounds }],
]) {
  const result = structuredClone(publicResult(query)); mutate(result)
  assert.equal(classifyResponse(query, 200, result).outcome, 'invalid_response')
}
for (const kind of ['matrix', 'reach']) assert.equal(classifyResponse(queries[kind], 200,
  { ...publicResult(queries[kind]), status: 'not_found', reason: noJourney.reason }).outcome, 'invalid_response')
assert.equal(classifyResponse(queries.matrix, 200, { ...publicResult(queries.matrix), durationsSeconds: [[null, null]] }).outcome, 'ok')
assert.equal(classifyResponse({ ...queries.reach, rasterSize: 48 }, 200, publicResult(queries.reach)).outcome, 'invalid_response')
const transitResult = structuredClone(publicResult(queries.route))
Object.assign(transitResult.journey.legs[0], { type: 'transit', route: { id: null }, trip: { feed: null, id: 'T1' } })
assert.equal(classifyResponse(queries.route, 200, transitResult).outcome, 'ok', 'Unknown source route metadata is explicitly nullable in public output')
delete transitResult.journey.legs[0].route.id
assert.equal(classifyResponse(queries.route, 200, transitResult).outcome, 'invalid_response')

const expired = new AbortController(), timeoutError = new DOMException('Deadline expired', 'TimeoutError')
expired.abort(timeoutError)
assert.equal(classifyTransportError(timeoutError, expired.signal), 'timeout')
const unrelatedAbort = new DOMException('Caller cancelled', 'AbortError')
assert.equal(classifyTransportError(unrelatedAbort, expired.signal), 'transport_error')
assert.equal(classifyTransportError(new Error('Connection reset'), expired.signal), 'transport_error')
const activeDeadline = new AbortController()
await assert.rejects(withDeadline(() => Promise.reject(unrelatedAbort), activeDeadline.signal), error => {
  assert.equal(classifyTransportError(error, activeDeadline.signal), 'transport_error'); return error === unrelatedAbort
})
const cancelled = new AbortController(); cancelled.abort(unrelatedAbort)
assert.equal(classifyTransportError(unrelatedAbort, cancelled.signal), 'transport_error')
let startedExpired = false
await assert.rejects(withDeadline(() => { startedExpired = true }, expired.signal), error => error === timeoutError)
assert.equal(startedExpired, false)
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-benchmark-check-'))
let active = 0, maximum = 0
const server = http.createServer(async (request, response) => {
  if (request.method === 'GET') {
    if (!['/healthz', '/readyz', '/v1/capabilities'].includes(request.url)) response.writeHead(404)
    response.end(JSON.stringify({ status: 'ready', version: 'fixture' })); return
  }
  active++; maximum = Math.max(maximum, active)
  const parts = []; for await (const part of request) parts.push(part)
  const query = JSON.parse(Buffer.concat(parts).toString())
  if (query.reset) { active--; request.socket.destroy(); return }
  if (query.stall) {
    if (query.stall === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{') }
    response.once('close', () => { active-- })
    return
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  if (query.httpStatus || query.fail) response.writeHead(query.httpStatus || 400)
  response.end(query.rawResponse ?? JSON.stringify(query.fail ? queryError : query.unreachable ? noJourney : publicResult(query)))
  active--
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
async function run(name, queries, args = []) {
  const input = path.join(directory, `${name}.ndjson`), output = path.join(directory, `${name}.json`)
  await fs.writeFile(input, queries.map(q => JSON.stringify(q)).join('\n'))
  const child = spawn(process.execPath, ['scripts/benchmark-service.mjs', '--url', `http://127.0.0.1:${server.address().port}`, '--requests', input,
    '--output', output, '--concurrency', '2', '--rounds', '3', '--warmup', '1', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  child.stdout.resume()
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  return { code, report: JSON.parse(await fs.readFile(output, 'utf8')) }
}
try {
  const success = await run('success', [queries.route, queries.matrix, queries.reach, { ...queries.reach, reachFormat: 'map' }, { ...queries.route, unreachable: true }])
  assert.equal(success.code, 0)
  assert.equal(success.report.samples.length, 15)
  assert.equal(success.report.health.status, 'ready')
  assert.equal(success.report.readiness.status, 'ready')
  assert.equal(success.report.warmup.length, 5)
  assert.equal(success.report.groups['route:not_found'].count, 3)
  assert.equal(success.report.groups['route:ok'].count, 3)
  assert.equal(maximum, 2)
  const failure = await run('failure', [{ kind: 'route', fail: true }])
  assert.equal(failure.code, 1)
  assert.equal(failure.report.failures, 4, 'Warmup errors must not be hidden')
  assert.equal(failure.report.groups['route:http_error'].count, 3)
  const classified = await run('classified-failures', [
    { kind: 'route', httpStatus: 503, rawResponse: '<html>Unavailable</html>' },
    { kind: 'matrix', httpStatus: 429, rawResponse: '' },
    { kind: 'reach', httpStatus: 504, rawResponse: 'Gateway timeout' },
    { kind: 'route', rawResponse: 'null' },
    { kind: 'matrix', rawResponse: '[]' },
    { kind: 'reach', rawResponse: 'invalid JSON' },
    { kind: 'route', stall: true },
    { kind: 'matrix', stall: 'body' },
    { kind: 'reach', httpStatus: 500, rawResponse: 'Internal server error' },
    { kind: 'route', reset: true },
    { kind: 'route', rawResponse: JSON.stringify(queryError) },
    { kind: 'reach', rawResponse: '{"status":"surprise"}' },
    { kind: 'route', rawResponse: '{"status":"ok"}' },
  ], ['--timeout', '250'])
  assert.equal(classified.code, 1)
  assert.equal(classified.report.failures, 52)
  for (const [group, count] of Object.entries({ 'route:unavailable': 3, 'matrix:overloaded': 3, 'reach:timeout': 3,
    'route:invalid_response': 6, 'matrix:invalid_response': 3, 'reach:invalid_response': 6, 'route:timeout': 3,
    'matrix:timeout': 3, 'reach:http_error': 3, 'route:transport_error': 3, 'route:query_error': 3 })) {
    assert.equal(classified.report.groups[group]?.count, count, `Wrong failure classification: ${group}`)
  }
  console.log('Public benchmark validates endpoint outputs, concurrency, warmup, no-journey results, HTTP failures, header/body deadlines, unrelated aborts and connection resets.')
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }) }
