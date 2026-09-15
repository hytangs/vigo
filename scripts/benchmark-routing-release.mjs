// Opt-in, sequential comparison using the same prepared City in both releases.
// Fresh process does not mean an empty OS disk cache. Never run alongside builds.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'

const args = process.argv.slice(2)
const canonicalPlan = plan => ({
  status: plan.status, departure: plan.departMinutes, arrival: plan.arriveMinutes,
  walk: plan.walkMinutes, ride: plan.rideMinutes, transfers: plan.transfers,
  legs: plan.legs?.map(leg => ({
    type: leg.type, trip: leg.tripId, from: leg.fromStopId, to: leg.toStopId,
    start: leg.startMinutes, end: leg.endMinutes, distance: leg.distanceKm,
    coordinates: leg.coordinates,
  })),
})
const canonicalReach = result => ({
  stops: result.stops, bounds: result.surface.bounds,
  values: Array.from(result.surface.values), contours: result.contours,
})
const signature = result => JSON.parse(JSON.stringify(result))

if (args[0] === '--worker') {
  const [, repo, city, configPath, family] = args
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const moduleAt = file => import(pathToFileURL(path.join(repo, 'src/server', file)))
  const { routeNationalGtfsStore, routeNationalGtfsDepartureWindow, routeNationalGtfsReach } = await moduleAt('national-gtfs-store.mjs')
  const { routeNationalStreetStore } = await moduleAt('national-osm-store.mjs')
  const { rasterBounds, rasterContours } = await moduleAt('reach.mjs')
  const store = path.join(city, 'routing/project.sqlite')
  const streets = path.join(city, 'osm/street-index.sqlite')
  const cases = config.cases.filter(c => c.family === family)
  const samples = [], results = {}
  // Round zero warms each query; the first query also includes store activation.
  for (let round = 0; round <= config.rounds; round++) for (const c of cases) {
    const request = { ...c.request, streetStorePath: streets }
    if (request.realtimeSnapshot) request.realtimeSnapshot = {
      ...request.realtimeSnapshot, feedTimestamp: Math.floor(Date.now() / 1000),
    }
    const start = performance.now()
    let result, canonical
    if (family === 'reach') {
      const bounds = rasterBounds(request.origin, c.radiusKm)
      result = routeNationalGtfsReach(store, { ...request, cutoffMinutes: c.cutoffs.at(-1), radiusKm: c.radiusKm,
        surface: { bounds, width: c.raster, height: c.raster } }, { streetStorePath: streets })
      result.contours = rasterContours(result.surface.values, c.raster, c.raster, bounds, c.cutoffs, 'reach')
    } else if (['walk', 'drive'].includes(request.mode)) result = routeNationalStreetStore(streets, request)
    else if (c.window) result = routeNationalGtfsDepartureWindow(store, { ...request, departureWindowMinutes: c.window })
    else result = routeNationalGtfsStore(store, request)
    const elapsedMs = performance.now() - start
    if (family === 'reach') {
      assert(result.stops.length > 0 && result.contours.features.length > 0, `${c.id}: empty Reach`)
      canonical = canonicalReach(result)
    } else {
      const plan = result.plan ?? result
      assert.equal(plan.status, 'ready', c.id)
      canonical = c.window ? { plan: canonicalPlan(plan), choices: result.choices?.map(canonicalPlan) } : canonicalPlan(plan)
    }
    const value = signature(canonical)
    if (round === 0) results[c.id] = value
    else assert.deepEqual(value, results[c.id], `${c.id}: unstable output`)
    samples.push({ id: c.id, round, elapsedMs, rssMb: process.memoryUsage().rss / 2 ** 20 })
  }
  process.stdout.write(JSON.stringify({ samples, results }))
} else {
  if (args.length !== 5) throw new Error('Usage: node scripts/benchmark-routing-release.mjs BASELINE_REPO CURRENT_REPO PREPARED_CITY CONFIG_JSON OUTPUT_JSON')
  const [baseline, current, city, configPath, outputPath] = args.map(a => path.resolve(a))
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const versions = { baseline, current }, samples = [], expected = new Map(), verified = new Set()
  const run = (argv, input) => new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout: ${argv.join(' ')}`)) }, 120_000)
    child.on('close', code => {
      clearTimeout(timer)
      const wallMs = performance.now() - started
      if (code !== 0) reject(new Error(`${code}: ${stderr.slice(-3000)}`))
      else resolve({ payload: JSON.parse(stdout), wallMs })
    })
    child.stdin.end(input)
  })
  const verify = (id, value) => {
    value = signature(value)
    if (!expected.has(id)) expected.set(id, value)
    else { assert.deepEqual(value, expected.get(id), `${id}: release result mismatch`); verified.add(id) }
  }
  const checkpoint = () => fs.writeFileSync(outputPath, JSON.stringify({ samples }, null, 2) + '\n')
  const order = batch => batch % 2 ? ['current', 'baseline'] : ['baseline', 'current']
  for (const family of ['route', 'reach'].filter(f => config.cases.some(c => c.family === f))) for (let batch = 0; batch < config.batches; batch++) {
    for (const version of order(batch)) {
      console.log(`${family}: ${version}, batch ${batch + 1}`)
      const { payload, wallMs } = await run([import.meta.filename, '--worker', versions[version], city, configPath, family])
      for (const [id, result] of Object.entries(payload.results)) verify(id, result)
      samples.push(...payload.samples.map(sample => ({ family, version, batch, ...sample })))
      samples.push({ family: `${family}-process`, id: family, version, batch, elapsedMs: wallMs })
      checkpoint()
    }
  }
  const requestsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-speed-input-'))
  const cliArgs = (repo, c) => [path.join(repo, 'public/vigo.mjs'), c.family, `--city=${city}`,
    `--request=${path.join(requestsFolder, c.id + '.json')}`, `--service-date=${c.request.serviceDate}`,
    `--time=${String(Math.floor(c.request.departMinutes / 60)).padStart(2, '0')}:${String(c.request.departMinutes % 60).padStart(2, '0')}`,
    `--max-walk=${c.request.maxWalkKm}`, ...(c.request.timePreference === 'arrive' ? ['--time-preference=arrive'] : []),
    ...(c.request.mode ? [`--mode=${c.request.mode}`] : []),
    ...(c.window ? [`--departure-window=${c.window}`] : []),
    ...(c.family === 'reach' ? [`--raster-size=${c.raster}`, `--extent-radius=${c.radiusKm}`, `--cutoffs=${c.cutoffs.join(',')}`] : [])]
  for (const c of config.cases.filter(c => c.cli)) {
    fs.writeFileSync(path.join(requestsFolder, c.id + '.json'), JSON.stringify(c.request))
    for (let batch = 0; batch < config.batches; batch++) for (const version of order(batch)) {
      console.log(`cli: ${c.id}, ${version}, batch ${batch + 1}`)
      const { payload, wallMs } = await run(cliArgs(versions[version], c))
      assert.equal(payload.status, 'ready', `${c.id}: CLI failed`)
      verify(`cli:${c.id}`, c.family === 'reach' ? canonicalReach(payload) : canonicalPlan(payload.plan ?? payload))
      samples.push({ family: 'cli-cold', id: c.id, version, batch, elapsedMs: wallMs, timing: payload.timing })
      checkpoint()
    }
  }
  fs.rmSync(requestsFolder, { recursive: true })
  // One request at a time. Wall clock ends when the complete JSON line arrives,
  // before parsing, so it includes query, materialization, serialization and IPC.
  const streamCases = config.cases.filter(c => c.stream)
  for (let batch = 0; streamCases.length && batch < config.batches; batch++) for (const version of order(batch)) {
    console.log(`cli stream: ${version}, batch ${batch + 1}`)
    const child = spawn(process.execPath, [path.join(versions[version], 'public/vigo.mjs'), '_route-stream',
      `--city=${city}`, `--service-date=${streamCases[0].request.serviceDate}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    let buffer = '', pending, stderr = ''
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => pending?.reject(error))
    child.on('close', code => pending?.reject(new Error(`Stream closed ${code}: ${stderr.slice(-2000)}`)))
    child.stdout.on('data', data => {
      buffer += data
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const wallMs = performance.now() - pending.started
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      pending.resolve({ payload: JSON.parse(line), wallMs }); pending = null
    })
    try {
      for (let round = 0; round <= config.rounds; round++) for (const c of streamCases) {
        const { payload, wallMs } = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('CLI stream timed out')) }, 120_000)
          pending = { started: performance.now(), resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }
          child.stdin.write(JSON.stringify({ ...c.request, id: c.id, timeMinutes: c.request.departMinutes }) + '\n')
        })
        assert.equal(payload.status, 'ok', JSON.stringify(payload.error))
        verify(`stream:${c.id}`, canonicalPlan(payload.plan))
        samples.push({ family: 'cli-stream', id: c.id, version, batch, round, elapsedMs: wallMs, timing: payload.timing })
      }
    } finally { child.stdin.end(); await closed }
    checkpoint()
  }
  const stats = rows => {
    const sorted = rows.map(r => r.elapsedMs).sort((a, b) => a - b)
    return { n: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }
  }
  const summaries = []
  for (const family of ['route', 'reach', 'cli-cold', 'cli-stream']) {
    const eligible = samples.filter(r => r.family === family && (r.round === undefined || r.round > 0))
    for (const id of new Set(eligible.map(r => r.id))) {
      const a = stats(eligible.filter(r => r.id === id && r.version === 'baseline'))
      const b = stats(eligible.filter(r => r.id === id && r.version === 'current'))
      summaries.push({ family, id, baseline: a, current: b, medianRatio: b.p50Ms / a.p50Ms })
    }
  }
  fs.writeFileSync(outputPath, JSON.stringify({
    capturedAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
    memoryGb: os.totalmem() / 2 ** 30, node: process.version, config,
    verifiedCases: [...verified], summaries, samples,
  }, null, 2) + '\n')
  console.table(summaries.map(r => ({ family: r.family, id: r.id,
    baselineMs: r.baseline.p50Ms.toFixed(2), currentMs: r.current.p50Ms.toFixed(2), ratio: r.medianRatio.toFixed(3) })))
}
