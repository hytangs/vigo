// Exercise the copyable manual examples against the real standalone process.
// The fixture compiler is a development dependency, never a runtime dependency.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const manual = fs.readFileSync(path.join(root, 'docs/guides/rust-standalone.md'), 'utf8')
const html = fs.readFileSync(path.join(root, 'docs/standalone.html'), 'utf8')
const spec = JSON.parse(fs.readFileSync(path.join(root, 'docs/standalone-openapi.json'), 'utf8'))
execFileSync(process.env.VIGO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['scripts/build-standalone-docs.py', '--check'], { cwd: root })
assert.equal(spec.openapi, '3.1.0')
const schemas = spec.components.schemas
function walk(value) {
  if (!value || typeof value !== 'object') return
  if (value.$ref) {
    assert.match(value.$ref, /^#\/components\/schemas\//)
    assert(schemas[value.$ref.split('/').at(-1)], `Unresolved schema ${value.$ref}`)
  }
  Object.values(value).forEach(walk)
}
walk(spec)
const links = [...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1])
const anchors = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
assert.equal(new Set(anchors).size, anchors.length, 'Generated reader contains duplicate anchors')
for (const link of links) assert(anchors.includes(link), `Missing HTML anchor ${link}`)
assert(!/<(?:script|link)[^>]+(?:src|href)="https?:/i.test(html), 'Offline reader must not fetch assets')
const env = { PATH: '', NODE_PATH: '', RAYON_NUM_THREADS: '2' }
const capabilities = JSON.parse(execFileSync(binary, ['capabilities'], { env, encoding: 'utf8' }))
const operations = schemas.NativeRequest.oneOf.map(s => s.properties.operation.const)
assert.deepEqual(operations.sort(), [...capabilities.nativeOperations].sort())
const source = fs.readFileSync(path.join(root, 'native/vigo-routing-kernel/src/standalone/transport.rs'), 'utf8')
const flags = [...source.match(/let known = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1])
for (const flag of flags) assert(manual.includes(`--${flag}`), `Undocumented CLI flag ${flag}`)
for (const method of ['route', 'matrix', 'reach', 'isochrone', 'compare', 'native']) assert(spec.paths[`/v1/${method}`]?.post)
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-rust-docs-'))
const city = path.join(directory, 'city')
const examples = []
const nativeContractCases = []
const outputCases = []
let server
let checks = 0
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { cwd: root, stdio: ['ignore','ignore','pipe'] })
  function execute(command, request) {
    const process = spawnSync(binary, [command, '--city', city, '--request', '-'], { input: JSON.stringify(request), env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    assert.equal(process.status, 0, `${command}: ${process.stderr}`)
    const result = JSON.parse(process.stdout)
    assert(!result.error)
    return result
  }
  for (const match of manual.matchAll(/```json query=(\w+)\n([\s\S]*?)\n```/g)) {
    const request = JSON.parse(match[2])
    const result = execute(match[1], request)
    if (match[1] === 'route') assert.equal(result.status, 'ready')
    if (match[1] === 'matrix') assert.equal(result.durationsMinutes.length, request.origins.length)
    if (match[1] === 'reach') assert.equal(result.surface.values.length, request.rasterSize ** 2)
    examples.push({ command: match[1], request, result })
    checks++
  }
  assert.equal(examples.length, 11, 'Update documented example coverage deliberately')
  assert.equal(examples[0].result.arrivalMinutes, 510)
  const excerpt = JSON.parse(manual.match(/```json response=quickstart\n([\s\S]*?)\n```/)[1])
  for (const [key, value] of Object.entries(excerpt)) assert.deepEqual(examples[0].result[key], value, `Quickstart response field ${key}`)
  checks++
  const identifiers = examples.find(e => e.request.operation === 'timetable.identifiers').result.result
  const origin = identifiers.stopIds.indexOf('A'), destination = identifiers.stopIds.indexOf('B')
  assert(origin >= 0 && destination >= 0)
  function nativeContract(operation, input, type) {
    const request = { operation, serviceDate: '2026-07-15', input }
    const result = execute('native', request)
    const schema = schemas[type]
    assert.deepEqual(Object.keys(result.result).sort(), Object.keys(schema.properties).sort(), `${type}: emitted fields`)
    assert.deepEqual([...schema.required].sort(), Object.keys(result.result).sort(), `${type}: present versus nullable`)
    nativeContractCases.push({ command: 'native', request, result })
    checks++
    return result.result
  }
  const nativeMatrix = {
    originOffsets: [0, 1], originStops: [origin], originWalkSeconds: [0], allowPreRideTransfers: [false],
    destinationOffsets: [0, 1], destinationStops: [destination], destinationWalkSeconds: [0],
    departure: 28500, horizon: 30600, arriveBy: false,
  }
  const forward = nativeContract('timetable.matrix', nativeMatrix, 'TimetableMatrixQueryResult')
  assert.deepEqual(forward.times, [30600], 'Native matrix returns arrival clocks in seconds')
  assert.equal(forward.journeys, null, 'Unrequested journeys are present and null')
  const reverse = nativeContract('timetable.matrix', { ...nativeMatrix, arriveBy: true }, 'TimetableMatrixQueryResult')
  assert.deepEqual(reverse.times, [28800], 'Native arrive-by matrix returns departure clocks in seconds')
  const blocked = nativeContract('timetable.matrix', { ...nativeMatrix, horizon: 28500 }, 'TimetableMatrixQueryResult')
  assert.deepEqual(blocked.times, [null], 'Unreachable native clock serializes as null')
  const scalar = nativeContract('timetable.route', {
    originStops: [origin], originWalkSeconds: [0], originCandidateIndices: [0],
    destinationStops: [destination], destinationWalkSeconds: [0], destinationCandidateIndices: [0],
    departure: 28500, horizon: 30600, allowPreRideTransfers: false,
  }, 'TimetableQueryResult')
  assert.equal(scalar.bestArrival, 30600)
  assert.equal(scalar.reason, null, 'A nullable result field remains present')
  const baseline = examples.find(e => e.command === 'reach' && !e.request.scenario)
  const proposed = execute('reach', { ...baseline.request, scenario: { excludedTripIds: ['T2'] }, bounds: baseline.result.surface.bounds })
  const comparison = execute('compare', { before: baseline.result, after: proposed })
  assert.equal(comparison.sign, 'after-minus-before'); checks++
  function outputCase(name, command, request) {
    const result = execute(command, request)
    outputCases.push({ name, command, request, result })
    return result
  }
  const ready = examples[0].result
  const matrixExample = examples.find(e => e.command === 'matrix')
  const blockedRoute = outputCase('blocked-route', 'route', {
    ...examples[0].request, origin: { stopId: 'B' }, destination: { stopId: 'A' },
  })
  const arithmeticGrid = values => ({ cityRevision: ready.cityRevision, stops: [],
    surface: { width: 2, height: 2, bounds: [0, 0, 2, 2], values } })
  const arithmeticComparison = outputCase('comparison', 'compare', {
    before: arithmeticGrid([10, null, 20, null]), after: arithmeticGrid([8, 15, null, null]),
  })
  const outputExamples = {
    'route-summary': ready, 'ride-leg': ready.legs[1], 'blocked-route': blockedRoute,
    'matrix-summary': matrixExample.result, comparison: arithmeticComparison,
  }
  const excerpts = [...manual.matchAll(/```json output=([\w-]+)\n([\s\S]*?)\n```/g)]
  assert.deepEqual(excerpts.map(m => m[1]).sort(), Object.keys(outputExamples).sort())
  for (const match of excerpts) {
    for (const [key, value] of Object.entries(JSON.parse(match[2]))) {
      assert.deepEqual(outputExamples[match[1]][key], value, `Output excerpt ${match[1]}.${key}`)
    }
    checks++
  }
  const gaps = ready.legs.slice(1).map((leg, i) => leg.departureMinutes - ready.legs[i].arrivalMinutes)
  assert.deepEqual(gaps, [5, 5, 0])
  assert.equal(gaps.reduce((a, b) => a + b, 0), ready.waitMinutes)
  assert.equal(ready.walkMinutes + ready.rideMinutes + ready.waitMinutes, ready.durationMinutes)
  checks++
  const arriveMatrix = outputCase('arrive-by-matrix', 'matrix', {
    ...matrixExample.request, origins: [{ stopId: 'A' }], destinations: [{ stopId: 'B' }],
    time: '08:40', timePreference: 'arrive_by',
  })
  assert.equal(arriveMatrix.durationsMinutes[0][0], 40)
  assert.equal(arriveMatrix.journeys[0][0].durationMinutes, 30)
  assert.equal(arriveMatrix.journeys[0][0].arrivalMinutes, 510)
  assert.equal(arriveMatrix.journeys[0][0].departureMinutes, 480)
  checks++
  const noJourneys = outputCase('matrix-no-journeys', 'matrix', {
    ...matrixExample.request, includeJourneys: false, includeGeometry: false,
  })
  assert.equal(noJourneys.journeys, null)
  const noGeometry = outputCase('matrix-no-geometry', 'matrix', {
    ...matrixExample.request, includeGeometry: false,
  })
  assert(noGeometry.journeys[0][0].legs.every(leg => !Object.hasOwn(leg, 'coordinates')))
  assert.deepEqual(noGeometry.durationsMinutes, matrixExample.result.durationsMinutes)
  checks++
  const compactWalk = outputCase('matrix-compact-walk', 'matrix', {
    ...matrixExample.request, origins: [{ stopId: 'A' }], destinations: [{ stopId: 'B' }], requireTransitRide: false,
  })
  assert.equal(compactWalk.journeys[0][0].mode, 'walk')
  assert(!Object.hasOwn(compactWalk.journeys[0][0], 'legs'))
  assert(compactWalk.durationsMinutes[0][0] < 35)
  checks++
  const viaExample = examples.find(e => e.request.via)
  const viaWindow = outputCase('via-before-window', 'route', { ...viaExample.request, windowMinutes: 10 })
  assert(viaWindow.segments.every(segment => !Object.hasOwn(segment, 'choices')))
  assert(!Object.hasOwn(viaWindow, 'legs'))
  assert(viaWindow.segments.every(segment => !Object.hasOwn(segment, 'cityRevision')))
  checks++
  const edgesResult = outputCase('reach-with-edges', 'reach', {
    ...baseline.request, maxWalkKm: 2, includeStreetEdges: true, includeNodes: true,
  })
  const edges = edgesResult.surface.edges
  assert(edges.count > 0)
  assert.equal(edges.nodes.length, edges.nodeCount * 2)
  assert.equal(edges.endpoints.length, edges.count * 2)
  for (const key of ['edgeIds', 'durationMinutes', 'walkDistanceM', 'transitArrivalMinutes']) assert.equal(edges[key].length, edges.count)
  assert.equal(edgesResult.surface.nodes.length, 1, 'Document the current wrapper node cap')
  assert(!Object.hasOwn(edgesResult.diagnostics.surface, 'nodeEvidenceTruncated'))
  checks++
  const decoders = new Map([...manual.matchAll(/```js decoder=(\w+)\n([\s\S]*?)\n```/g)].map(m => [m[1], m[2]]))
  assert.deepEqual([...decoders.keys()].sort(), ['edge', 'raster'])
  const readCell = runInNewContext(decoders.get('raster') + '\nreadCell;', {}, { timeout: 1000 })
  const plain = value => JSON.parse(JSON.stringify(value))
  const cells = arithmeticGrid([0, null, 12, 20]).surface
  assert.deepEqual(plain(readCell(cells, 0, 0)), { index: 0, coordinate: [0.5, 1.5], durationMinutes: 0 })
  assert.equal(readCell(cells, 1, 0).durationMinutes, null)
  assert.throws(() => readCell(cells, 2, 0), { name: 'RangeError' })
  for (const full of [false, true]) {
    const surface = { ...edgesResult.surface, ...(full ? { bounds: edgesResult.surface.fullBounds, values: edgesResult.surface.fullValues } : {}) }
    assert.equal(surface.values.length, surface.width * surface.height)
    const last = readCell(surface, surface.width - 1, surface.height - 1)
    assert.equal(last.index, surface.values.length - 1)
    assert.equal(last.durationMinutes, surface.values.at(-1))
    assert(last.coordinate[0] < surface.bounds[2] && last.coordinate[1] > surface.bounds[1])
  }
  checks++
  const readEdge = runInNewContext(decoders.get('edge') + '\nreadEdge;', {}, { timeout: 1000 })
  const direct = edges.transitArrivalMinutes.indexOf(-1)
  const transit = edges.transitArrivalMinutes.findIndex(t => t >= 0)
  assert(direct >= 0 && transit >= 0)
  assert.equal(readEdge(edges, direct).transitArrivalMinutes, null)
  assert.equal(readEdge(edges, transit).transitArrivalMinutes, edges.transitArrivalMinutes[transit])
  assert.deepEqual(plain(readEdge(edges, 0).coordinates[1]), edges.nodes.slice(2 * edges.endpoints[1], 2 * edges.endpoints[1] + 2))
  assert.throws(() => readEdge(edges, edges.count), { name: 'RangeError' })
  checks++
  const noCommon = outputCase('comparison-no-common', 'compare', {
    before: arithmeticGrid([10, null, 20, null]), after: arithmeticGrid([null, 15, null, 12]),
  })
  assert.equal(noCommon.commonCells, 0)
  assert.equal(noCommon.meanChangeMinutes, null)
  assert.equal(noCommon.newlyReachableCells, 2)
  assert.equal(noCommon.noLongerReachableCells, 2)
  checks++
  const walkSurface = outputCase('walk-only-reach', 'reach', {
    origin: { stopId: 'A' }, mode: 'walk', time: '07:55', maxWalkKm: 2, rasterSize: 48, extentRadiusKm: 2,
  })
  assert.deepEqual(walkSurface.stops, [])
  assert.equal(walkSurface.diagnostics.transit, null)
  assert.equal(walkSurface.surface.edges, null)
  assert(walkSurface.surface.values.some(v => v !== null))
  checks++
  const lines = manual.match(/```ndjson\n([\s\S]*?)\n```/)[1]
  const stream = spawnSync(binary, ['stream', '--city', city], { input: lines + '\n', env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(stream.status, 0, stream.stderr)
  assert.deepEqual(stream.stdout.trim().split('\n').map(line => JSON.parse(line).id), ['trip-1', 'area-1']); checks++
  const token = 'documentation-test-token-123'
  server = spawn(binary, ['serve', '--city', city, '--port', '0'], { env: { ...env, VIGO_API_TOKEN: token } })
  const port = await new Promise((resolve,reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Docs server startup timed out')), 15000)
    server.stderr.on('data', data => { text += data; const match = text.match(/listening on 127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Docs server exited ${code}: ${text}`)) })
  })
  const base = `http://127.0.0.1:${port}`
  for (const url of ['/', '/docs', '/docs/']) {
    const response = await fetch(base + url)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.equal(await response.text(), html); checks++
  }
  for (const url of ['/openapi.json', '/docs/openapi.json', '/standalone-openapi.json', '/docs/standalone-openapi.json']) {
    const response = await fetch(base + url)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), spec); checks++
  }
  assert.equal((await fetch(base + '/v1/info')).status, 401); checks++
  const response = await fetch(base + '/v1/route', { method:'POST', headers: { 'content-type':'application/json', authorization:`Bearer ${token}` }, body: JSON.stringify(examples[0].request) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).arrivalMinutes, 510); checks++
  // Optional retained output lets maintainers check examples with a full JSON
  // Schema validator without adding one to the executable or test dependency tree.
  if (process.env.VIGO_DOCS_EVIDENCE) fs.writeFileSync(process.env.VIGO_DOCS_EVIDENCE, JSON.stringify({ examples, nativeContractCases, outputCases, checks, nativeOperations:operations.length }, null, 2))
  console.log(`Standalone documentation passed (${checks} example/HTTP checks, ${examples.length} copyable JSON examples, ${operations.length} native contracts, all CLI flags, offline links, generated-file freshness).`)
} finally {
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit') }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries:20, retryDelay:50 })
}
