import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { auditPackageFiles } from '../scripts/lib/package-audit.mjs'

const run = promisify(execFile)
const engineNode = process.env.VIGO_ENGINE_TEST_NODE || process.execPath
const root = path.resolve(import.meta.dirname, '..')
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const name = `VIGO-Engine-${metadata.version}-${process.platform}-${process.arch}`
const output = path.resolve(process.env.VIGO_ENGINE_RELEASE_DIR || path.join(root, 'release', 'engine'))
const archivePath = path.join(output, `${name}.zip`)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-engine-extracted-'))
const runtime = path.join(temporary, name)
const digest = data => crypto.createHash('sha256').update(data).digest('hex')
const environment = { ...process.env, PATH: '', NODE_PATH: '' }
for (const key of Object.keys(environment)) if (key.startsWith('VIGO_')) delete environment[key]
const serviceDate = '2026-07-15'
const token = 'fixture-token'
let activeServer
const stoppedWorkers = new Set()

async function cli(args, input) {
  const child = spawn(engineNode, [path.join(runtime, 'vigo.mjs'), ...args], { cwd: runtime,
    env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  child.stdin.end(input)
  const timeout = setTimeout(() => child.kill(), 60000)
  const [code] = await once(child, 'exit')
  clearTimeout(timeout)
  assert.equal(code, 0, stderr)
  return JSON.parse(stdout)
}

async function startServer(city, extra = {}) {
  const child = spawn(engineNode, [path.join(runtime, 'engine-http.mjs')], { cwd: runtime,
    env: { ...environment, VIGO_CITY_DIR: city, VIGO_ENGINE_PORT: '0', VIGO_ENGINE_API_TOKEN: token,
      VIGO_ENGINE_MAX_WORKERS: '1', VIGO_ENGINE_MAX_BODY_BYTES: '4096', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const lines = createInterface({ input: child.stdout })
  const listen = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Engine HTTP startup timed out: ${stderr}`)) }, 30000)
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Engine HTTP exited ${code}: ${stderr}`)) })
    lines.once('line', line => { clearTimeout(timeout); resolve(JSON.parse(line)) })
  })
  assert.equal(listen.status, 'listening')
  return { child, lines, url: `http://127.0.0.1:${listen.port}` }
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return
  const exited = once(server.child, 'exit')
  server.child.kill('SIGTERM')
  const timeout = setTimeout(() => server.child.kill('SIGKILL'), 10000)
  await exited
  clearTimeout(timeout)
  server.lines.close()
}

async function post(kind, body, headers = {}, server = activeServer) {
  const response = await fetch(`${server.url}/v1/${kind}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

async function incompleteBody(server) {
  const socket = net.connect(Number(new URL(server.url).port), '127.0.0.1')
  const response = new Promise((resolve, reject) => {
    let text = ''
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Absolute body deadline was not enforced.')) })
    socket.setEncoding('utf8').on('data', data => { text += data })
    socket.once('end', () => resolve(text))
    socket.once('error', reject)
  })
  await once(socket, 'connect')
  socket.write(`POST /v1/route HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`)
  return response
}

try {
  const archive = await fs.readFile(archivePath)
  assert.equal((await fs.readFile(`${archivePath}.sha256`, 'utf8')).split(' ')[0], digest(archive))
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true })
  const allowed = new Set(['vigo.mjs', 'engine-http.mjs', 'vigo-routing-kernel.node', 'LICENSE', 'NOTICE',
    'CCH-LICENSE', 'CCH-NOTICE', 'THIRD-PARTY-NOTICES', 'README.md', 'manifest.json',
    ...(process.platform === 'linux' ? ['Dockerfile', 'compose.yml'] : [])])
  await fs.mkdir(runtime)
  const extracted = new Set()
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) { assert.equal(entry.name, `${name}/`); continue }
    assert.equal(entry.name, `${name}/${path.posix.basename(entry.name)}`)
    const file = path.posix.basename(entry.name)
    assert(allowed.has(file), `Unexpected Engine payload file: ${file}`)
    assert.equal(Number(entry.unixPermissions) & 0o170000, 0o100000, 'Only regular payload files are allowed.')
    await fs.writeFile(path.join(runtime, file), await entry.async('nodebuffer'))
    await fs.chmod(path.join(runtime, file), Number(entry.unixPermissions) & 0o777)
    extracted.add(file)
  }
  assert.deepEqual(extracted, allowed)
  const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'manifest.json'), 'utf8'))
  assert.equal(manifest.platform, process.platform)
  assert.equal(manifest.architecture, process.arch)
  assert.equal(manifest.productVersion, metadata.version)
  for (const [file, expected] of Object.entries(manifest.files)) {
    const data = await fs.readFile(path.join(runtime, file))
    assert.equal(data.length, expected.bytes)
    assert.equal(digest(data), expected.sha256)
  }
  assert.deepEqual(new Set(Object.keys(manifest.files)), new Set([...allowed].filter(file => file !== 'manifest.json')))
  await auditPackageFiles(runtime, { forbiddenRoots: [root] })
  const capabilities = await cli(['capabilities'])
  assert(['route', 'matrix', 'reach'].every(id => capabilities.queries.some(query => query.id === id && query.resident)))
  assert.match((await run(engineNode, [path.join(runtime, 'engine-http.mjs'), '--help'], { cwd: runtime, env: environment })).stdout, /\/v1\/route/)

  const { gtfsPath, osmPath } = await writeCliFixtureInputs(temporary)
  const feed = await JSZip.loadAsync(await fs.readFile(gtfsPath))
  feed.file('stop_times.txt', (await feed.file('stop_times.txt').async('string'))
    .replaceAll('08:10:00', '08:03:00').replaceAll('08:15:00', '08:04:00').replaceAll('08:30:00', '08:10:00'))
  for (const [file, rows] of [
    ['routes.txt', 'DIRECT,fixture,DIRECT,Direct service,3\n'],
    ['trips.txt', 'DIRECT,WKD,TD,0\n'],
    ['stop_times.txt', 'TD,08:00:00,08:00:00,A,1\nTD,08:12:00,08:12:00,B,2\n'],
  ]) feed.file(file, await feed.file(file).async('string') + rows)
  await fs.writeFile(gtfsPath, await feed.generateAsync({ type: 'nodebuffer' }))
  const city = path.join(temporary, 'city')
  await cli(['build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`])
  const common = { serviceDate, time: 475, maxWalkKm: .2 }
  const query = { origin: 'A', destination: 'B', allowStreetTransfers: false, minimumTransferBufferMinutes: 2 }
  const route = await cli(['route', `--city=${city}`, `--service-date=${serviceDate}`, '--time=07:55', '--max-walk=.2', '--request=-'], JSON.stringify(query))
  assert.equal(route.schema, 'vigo.route.v1')
  assert.equal(route.status, 'ok')
  assert.equal(route.journey.arrivalTime, '08:12:00')
  assert.equal(route.journey.transfers, 0)
  const matrixQuery = { origins: ['A'], destinations: ['B'], allowStreetTransfers: false, minimumTransferBufferMinutes: 2 }
  const matrix = await cli(['matrix', `--city=${city}`, `--service-date=${serviceDate}`, '--time=07:55', '--max-walk=.2', '--request=-'], JSON.stringify(matrixQuery))
  assert.deepEqual(matrix.durationsSeconds, [[1020]])
  const reachQuery = { origin: 'A', cutoffsMinutes: [15], rasterSize: 48, extentRadiusKm: 1 }
  const reach = await cli(['reach', `--city=${city}`, `--service-date=${serviceDate}`, '--time=07:55', '--max-walk=.2', '--request=-'], JSON.stringify(reachQuery))
  assert.equal(reach.surface.valuesSeconds.length, 48 ** 2)

  activeServer = await startServer(city)
  assert.equal((await fetch(`${activeServer.url}/health`)).status, 200)
  assert.equal((await fetch(`${activeServer.url}/v1/capabilities`)).status, 401)
  assert.equal((await fetch(`${activeServer.url}/v1/capabilities`, { headers: { authorization: token } })).status, 401)
  const httpCaps = await fetch(`${activeServer.url}/v1/capabilities`, { headers: { authorization: `Bearer ${token}` } })
  assert.deepEqual(await httpCaps.json(), capabilities)
  const cold = await post('route', { ...query, ...common })
  assert.equal(cold.status, 200, JSON.stringify(cold.body))
  assert.deepEqual(cold.body.journey, route.journey)
  const warm = await post('route', { ...query, ...common, time: '07:55', diagnostics: 'trace' })
  assert.equal(warm.body.trace.timing.openMs, 0, 'Same-date/mode HTTP requests reuse resident preparation.')
  const httpMatrix = await post('matrix', { ...matrixQuery, ...common })
  assert.equal(httpMatrix.status, 200, JSON.stringify(httpMatrix.body))
  assert.deepEqual(httpMatrix.body.durationsSeconds, matrix.durationsSeconds)
  const httpReach = await post('reach', { ...reachQuery, ...common })
  assert.equal(httpReach.status, 200, JSON.stringify(httpReach.body))
  assert.deepEqual(httpReach.body.surface.valuesSeconds, reach.surface.valuesSeconds)
  const otherDate = await post('route', { ...query, ...common, serviceDate: '2026-07-16' })
  assert.equal(otherDate.status, 200)
  assert.equal((await (await fetch(`${activeServer.url}/health`)).json()).residentWorkers, 1)
  assert.equal((await post('route', { ...query, ...common })).status, 200, 'Idle date eviction must permit returning to a previous date.')
  assert.equal((await post('route', { ...query, ...common, serviceDay: 'sunday' })).status, 400)
  assert.equal((await post('route', { ...query, ...common, serviceDate: '2026-02-31' })).status, 400)
  assert.equal((await post('route', { ...query, ...common, cityPath: city })).status, 400)
  assert.equal((await post('route', { ...query, ...common, kind: 'matrix' })).status, 400)
  assert.equal((await post('route', { ...query, ...common, time: 1.5 })).status, 400)
  assert.equal((await post('route', '{broken')).status, 400)
  assert.equal((await post('route', '{}', { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post('route', { ...common, origin: 'missing', destination: 'B' })).status, 422)
  const blocked = await post('route', { ...common, origin: 'B', destination: 'A', allowLongWalk: false })
  assert.equal(blocked.status, 200, 'A valid blocked Result is not a transport error.')
  assert.equal(blocked.body.status, 'not_found')
  assert.equal((await post('route', { ...common, origin: 'A', destination: 'B' })).status, 200, 'A bad request cannot poison the resident worker.')
  assert.equal((await post('route', JSON.stringify({ padding: 'x'.repeat(5000) }))).status, 413)
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(5000))); controller.close() } })
  const oversizedResponse = await fetch(`${activeServer.url}/v1/route`, { method: 'POST', duplex: 'half', body: oversized,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } })
  assert.equal(oversizedResponse.status, 413, 'Chunked bodies must respect the same bound.')
  await stopServer(activeServer); activeServer = null

  activeServer = await startServer(city, { VIGO_ENGINE_TIMEOUT_MS: '2000', VIGO_ENGINE_BODY_TIMEOUT_MS: '100' })
  assert.equal((await post('route', { ...query, ...common })).status, 200)
  if (process.platform !== 'win32') {
    const childrenText = process.platform === 'linux'
      ? await fs.readFile(`/proc/${activeServer.child.pid}/task/${activeServer.child.pid}/children`, 'utf8')
      : (await run('pgrep', ['-P', String(activeServer.child.pid)])).stdout
    const children = childrenText.trim().split(/\s+/).map(Number)
    assert.equal(children.length, 1)
    const pid = children[0]
    stoppedWorkers.add(pid)
    process.kill(pid, 'SIGSTOP')
    assert.equal((await post('route', { ...query, ...common })).status, 504)
    const deadline = Date.now() + 3000
    while (true) {
      try { process.kill(pid, 0) }
      catch (error) { assert.equal(error.code, 'ESRCH'); break }
      assert(Date.now() < deadline, 'Timed-out stopped worker must be terminated and reaped.')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    stoppedWorkers.delete(pid)
    assert.equal((await post('route', { ...query, ...common })).status, 200, 'Routing must recover after terminating native work.')
  }
  const slowBody = incompleteBody(activeServer)
  assert.equal((await fetch(`${activeServer.url}/health`)).status, 200)
  assert.match(await slowBody, /^HTTP\/1\.1 408 /)
  assert.equal((await post('route', { ...query, ...common })).status, 200, 'A slow body cannot poison routing.')
  await stopServer(activeServer); activeServer = null

  activeServer = await startServer(city, { VIGO_ENGINE_MAX_RESPONSE_BYTES: '256' })
  const oversizedResult = await post('route', { ...query, ...common })
  assert.equal(oversizedResult.status, 503)
  assert.match(oversizedResult.body.error.message, /response exceeded its byte limit/)
  assert.equal((await fetch(`${activeServer.url}/health`)).status, 200)
  await stopServer(activeServer); activeServer = null

  activeServer = await startServer(city, { VIGO_ENGINE_QUEUE_LIMIT: '1' })
  const concurrent = await Promise.all([post('route', { ...query, ...common }), post('route', { ...query, ...common })])
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 429])
  await stopServer(activeServer); activeServer = null
  activeServer = await startServer(city, { VIGO_ENGINE_TIMEOUT_MS: '1' })
  assert.equal((await post('route', { ...query, ...common })).status, 504)
  assert.equal((await post('route', { ...query, ...common })).status, 504, 'A timed-out worker must be replaced for the next request.')
  assert.equal((await fetch(`${activeServer.url}/health`)).status, 200)
  console.log(JSON.stringify({ status: 'passed', platform: process.platform, architecture: process.arch,
    zipBytes: archive.length, files: allowed.size, extractedWithoutNodeModules: true,
    cliBuildRouteMatrixReach: true, httpParity: true, residentReuse: true,
    authentication: true, boundedBodyQueueWorkers: true, timeoutRecovery: true,
    absoluteBodyDeadline: true, boundedWorkerOutput: true,
    stoppedWorkerReaped: process.platform !== 'win32' }, null, 2))
} finally {
  for (const pid of stoppedWorkers) { try { process.kill(pid, 'SIGKILL') } catch { /* Already reaped. */ } }
  await stopServer(activeServer)
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
