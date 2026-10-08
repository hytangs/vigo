// Exercise the shipped Compose configuration, not a parallel test-only image.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
assert(args.length === 2 && args[0] === '--image', 'Usage: node test/check-deployment.mjs --image VERIFIED_IMAGE')
const image = args[1]
const toolchain = fs.readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8').match(/channel\s*=\s*"([^"]+)"/)[1]
assert(fs.readFileSync(path.join(root, 'deploy/Dockerfile'), 'utf8').includes(`FROM rust:${toolchain}-slim-bookworm AS build`), 'The image must use the pinned Rust compiler')
fs.mkdirSync(path.join(root, 'temp'), { recursive: true })
const directory = fs.mkdtempSync(path.join(root, 'temp/deployment-'))
const project = `vigo-check-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
const token = 'public-synthetic-deployment-token'
const env = { ...process.env, VIGO_IMAGE: image, VIGO_API_TOKEN: token, VIGO_LOCAL_PORT: '0',
  VIGO_CPUS: '2', VIGO_MEMORY: '2g', VIGO_THREADS: '2', VIGO_MAX_RESIDENT_SCENARIOS: '1',
  VIGO_ENDPOINT_CACHE_MAX_BYTES: '8388608', VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES: '8388608',
  VIGO_MAX_QUEUE: '8', VIGO_MAX_CONNECTIONS: '16', VIGO_MAX_BODY_BYTES: '8388608',
  VIGO_REQUEST_TIMEOUT_MS: '10000', VIGO_QUERY_TIMEOUT_MS: '30000' }
const docker = (...args) => run('docker', args, { cwd: root, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
const compose = (...args) => docker('compose', '-f', 'deploy/compose.yml', '-p', project, ...args)
const cli = (...args) => run(process.execPath, ['public/vigo.mjs', ...args], { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function inventory(folder) {
  return Object.fromEntries(fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => { const file = path.join(entry.parentPath, entry.name); return [path.relative(folder, file), digest(file)] }).sort(([a], [b]) => a.localeCompare(b)))
}
const base = { serviceDate: '2026-07-15', time: '07:55', origin: { stopId: 'A' }, destination: { stopId: 'B' },
  requireTransitRide: true, maxWalkKm: .2, includeGeometry: true }
let checks = 0
try {
  const verifiedImage = JSON.parse((await docker('image', 'inspect', image)).stdout)[0].Id
  env.VIGO_IMAGE = verifiedImage
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  const city = path.join(directory, 'city')
  await cli('build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city)
  const scenarios = []
  for (let n = 0; n < 2; n++) {
    const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
    const calls = await zip.file('stop_times.txt').async('string')
    zip.file('stop_times.txt', calls.replaceAll('08:30:00', `08:${30 + n}:00`))
    const feed = path.join(directory, `s${n}.zip`)
    fs.writeFileSync(feed, await zip.generateAsync({ type: 'nodebuffer' }))
    scenarios.push({ id: `s${n}`, name: `Scenario ${n}`, feeds: [{ path: path.basename(feed), scope: 'test', sha256: digest(feed) }] })
  }
  const source = path.join(directory, 'source.json')
  fs.writeFileSync(source, JSON.stringify({ schemaVersion: 'vigo.scenarios.source.v1', name: 'Deployment fixture',
    maximumResidentScenarios: 1, prepareDates: [base.serviceDate],
    osm: { path: path.basename(osmPath), sha256: digest(osmPath) }, scenarios }))
  const collection = path.join(directory, 'collection')
  await cli('build-scenarios', '--spec', source, '--output', collection)
  // Prepared snapshots are private (0600) by default. This public fixture is
  // explicitly exported to the service UID, as the deployment guide requires.
  // Native Linux bind mounts enforce these modes; desktop file sharing may not.
  for (const folder of [city, collection]) {
    fs.chmodSync(folder, 0o755)
    for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue // Shared streets are visited at their actual directory.
      fs.chmodSync(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644)
    }
  }
  for (const folder of [city, collection]) {
    env.VIGO_CITY = folder
    const before = inventory(folder)
    await compose('up', '-d', '--wait', '--wait-timeout', '90')
    const id = (await compose('ps', '-q', 'engine')).stdout.trim()
    const inspected = JSON.parse((await docker('inspect', id)).stdout)[0]
    assert.equal(inspected.Image, verifiedImage, 'Check the exact image even if its tag changes during validation')
    assert.equal(inspected.Config.User, '65532:65532')
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true)
    assert.equal(inspected.HostConfig.Memory, 2 * 1024 ** 3)
    assert.equal(inspected.HostConfig.NanoCpus, 2 * 1e9)
    assert.equal(inspected.HostConfig.PidsLimit, 64)
    assert.equal(inspected.HostConfig.Init, true)
    assert.deepEqual(inspected.Config.Healthcheck.Test, ['CMD', '/vigo', 'health'])
    assert.equal(inspected.Mounts.find(m => m.Destination === '/city').RW, false)
    assert.equal(inspected.HostConfig.LogConfig.Config['max-size'], '5m')
    assert.equal(inspected.HostConfig.LogConfig.Config['max-file'], '2')
    const binding = inspected.NetworkSettings.Ports['8080/tcp'][0]
    assert.equal(binding.HostIp, '127.0.0.1')
    let origin = `http://127.0.0.1:${binding.HostPort}`
    async function waitForEndpoint() {
      const deadline = Date.now() + 15000
      while (true) {
        try {
          const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) })
          await response.arrayBuffer()
          if (response.status === 200) return
        } catch (error) {
          if (Date.now() >= deadline) throw error
        }
        assert(Date.now() < deadline, `Host endpoint did not become ready: ${origin}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await waitForEndpoint()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    async function post(kind, request) {
      const response = await fetch(`${origin}/v1/${kind}`, { method: 'POST', headers, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) })
      const value = await response.json()
      assert.equal(response.status, 200, JSON.stringify(value))
      assert.equal(value.status, 'ok', JSON.stringify(value))
      checks++
      return value
    }
    assert.equal((await fetch(`${origin}/readyz`)).status, 200)
    const unauthorized = await fetch(`${origin}/v1/info`)
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'unauthorized')
    assert.equal((await docker('exec', id, '/vigo', 'health')).stdout.trim(), 'ready')
    checks += 14
    const request = folder === city ? base : { ...base, scenarioId: 's0' }
    const route = await post('route', request)
    assert.equal(route.journey.arrivalTime, '08:30:00')
    assert(route.journey.legs.some(leg => leg.geometry?.coordinates?.length > 1))
    const arrive = await post('route', { ...request, time: '08:30', timePreference: 'arrive_by' })
    assert.equal(arrive.journey.arrivalTime, '08:30:00')
    const { origin: from, destination, ...options } = request
    const matrix = await post('matrix', { ...options, origins: [from], destinations: [destination], includeJourneys: true })
    assert.deepEqual(matrix.durationsSeconds, [[route.journey.durationSeconds]])
    const reach = await post('reach', { serviceDate: request.serviceDate, time: request.time, scenarioId: request.scenarioId,
      maxWalkKm: request.maxWalkKm, origin: from, rasterSize: 48, cutoffsMinutes: [15, 30], reachFormat: 'map' })
    assert.equal(reach.schema, 'vigo.reach.v1')
    assert.equal(reach.areas.type, 'FeatureCollection')
    assert(reach.areas.features.length > 0)
    if (folder === collection) {
      for (const n of [1, 0, 1, 0]) {
        const switched = await post('route', { ...base, scenarioId: `s${n}` })
        assert.equal(switched.journey.arrivalTime, `08:${30 + n}:00`)
      }
      const info = await (await fetch(`${origin}/v1/info`, { headers })).json()
      assert.equal(info.residency.loadedScenarios, 1)
      assert.equal(info.residency.sharedStreetGraphs, 1)
      assert(info.residency.evictions > 0)
      checks += 3
    }
    await compose('restart', '--timeout', '5', 'engine')
    await compose('up', '-d', '--wait', '--wait-timeout', '90')
    const restartedId = (await compose('ps', '-q', 'engine')).stdout.trim()
    const restarted = JSON.parse((await docker('inspect', restartedId)).stdout)[0]
    assert.equal(restarted.Image, verifiedImage)
    origin = `http://127.0.0.1:${restarted.NetworkSettings.Ports['8080/tcp'][0].HostPort}`
    await waitForEndpoint()
    assert.deepEqual((await post('route', request)).journey, route.journey, 'A restart must preserve the full journey')
    assert.deepEqual(inventory(folder), before, 'The service must not modify prepared City files')
    await compose('down', '--timeout', '5')
    checks += 2
  }
  const absent = path.join(directory, 'missing-city')
  env.VIGO_CITY = absent
  await assert.rejects(compose('up', '-d'), /does not exist|invalid mount/i)
  assert.equal(fs.existsSync(absent), false, 'A misspelled City path must not create an empty directory')
  checks += 2
  console.log(JSON.stringify({ status: 'passed', image, imageId: verifiedImage, checks, cpus: 2, memoryLimitBytes: 2 * 1024 ** 3,
    fixtures: ['prepared-city', 'shared-scenario-collection'], readOnly: true, restart: 'verified' }, null, 2))
} catch (error) {
  // Preserve startup evidence before cleanup removes the failed container.
  const logs = await compose('logs', '--no-color', '--tail', '50').catch(() => null)
  if (logs) console.error(logs.stdout, logs.stderr)
  throw error
} finally {
  env.VIGO_CITY ||= directory
  await compose('down', '--timeout', '5').catch(error => console.error(error.message))
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
