import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { adjustScheduledTrip } from '../src/server/scenario-timing.mjs'
const root = path.resolve(import.meta.dirname, '..')
const binary = process.env.VIGO_MONTE_CARLO_BINARY || standaloneBinary
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-monte-carlo-'))
const children = []
function resident(city, detailed = false, node = false) {
  const child = spawn(node ? process.execPath : binary, [...(node ? ['public/vigo.mjs'] : []), 'stream', '--city', city, ...(detailed ? ['--stream-output=detailed'] : [])], { cwd: root })
  // Register immediately so cleanup also observes a reader that exited early.
  const closed = new Promise(resolve => child.once('close', resolve))
  children.push({ child, closed })
  let stderr = ''; child.stderr.on('data', data => { stderr += data })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  return async request => {
    child.stdin.write(JSON.stringify(request) + '\n')
    let timer
    const line = await Promise.race([lines.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Query timeout: ${stderr}`)), 60000)
    })]).finally(() => clearTimeout(timer))
    assert(!line.done, stderr)
    return JSON.parse(line.value)
  }
}
function ok(value) { assert.equal(value.status, 'ok', JSON.stringify(value)); return value }
try {
  for (const mode of ['scheduled', 'frequency', 'exact-frequency']) {
    const folder = path.join(temporary, mode); fs.mkdirSync(folder)
    const inputs = await writeCliFixtureInputs(folder)
    if (mode === 'scheduled') {
      const zip = await JSZip.loadAsync(fs.readFileSync(inputs.gtfsPath))
      zip.file('trips.txt', (await zip.file('trips.txt').async('string')) + 'R1,MON,LATE,0\n')
      zip.file('calendar.txt', (await zip.file('calendar.txt').async('string')) + 'MON,1,0,0,0,0,0,0,20260101,20261231\n')
      zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string')) +
        'LATE,12:01:00,12:01:00,B,1\nLATE,12:11:00,12:11:00,A,2\n')
      fs.writeFileSync(inputs.gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    }
    if (mode !== 'scheduled') {
      const zip = await JSZip.loadAsync(fs.readFileSync(inputs.gtfsPath))
      zip.file('frequencies.txt', `trip_id,start_time,end_time,headway_secs,exact_times\nT1,08:00:00,09:00:00,600,${mode === 'frequency' ? 0 : 1}\n`)
      fs.writeFileSync(inputs.gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    }
    const city = path.join(folder, 'city')
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${city}`], { cwd: root, stdio: 'pipe' })
    const run = resident(city)
    const base = { kind: 'matrix', serviceDate: '2026-07-15', origins: [{ stopId: 'A' }, { stopId: 'A' }],
      destinations: [{ stopId: 'X' }, { stopId: 'B' }], requireTransitRide: true, maxWalkKm: .01, horizonMinutes: 60 }
    ok(await run({ ...base, origins: [{ coordinate: [-77.05, 38.9] }],
      destinations: [{ coordinate: [-77.049, 38.9] }], requireTransitRide: false,
      monteCarlo: { startMinutes: 480, endMinutes: 481, draws: 1 } }))
    const ordinary = ok(await run({ ...base, timeMinutes: 480 }))
    const mc = { startMinutes: 480, endMinutes: 483, draws: 200, seed: 42, percentiles: [0, 5, 50, 95, 100] }
    const result = ok(await run({ ...base, monteCarlo: mc }))
    const runDetailed = resident(city, true)
    const detailed = ok(await runDetailed({ ...base, monteCarlo: mc }))
    assert.equal(detailed.schema, 'vigo.stream.detail.v1')
    assert.equal(detailed.trace.meta.queryFingerprint, result.meta.queryFingerprint)
    for (const key of ['schema', 'status', 'kind', 'query', 'sampling', 'layout', 'percentiles', 'durationsSeconds', 'reachableSamples', 'warnings', 'assumptions']) {
      assert.deepEqual(detailed.trace[key], result[key], `Detailed output preserves ${key}`)
    }
    for (const detail of [false, true]) {
      const nodeRun = resident(city, detail, true)
      const response = ok(await nodeRun({ ...base, monteCarlo: mc }))
      const distribution = detail ? response.trace : response
      for (const key of ['schema', 'status', 'kind', 'query', 'sampling', 'layout', 'percentiles', 'durationsSeconds', 'reachableSamples', 'warnings', 'assumptions']) {
        assert.deepEqual(distribution[key], result[key], `Node ${mode} detailed=${detail} preserves ${key}`)
      }
      assert.equal(distribution.meta.queryFingerprint, result.meta.queryFingerprint)
      assert.equal((await nodeRun({ ...base, monteCarlo: mc, time: '08:00' })).status, 'error')
      const following = ok(await nodeRun({ ...base, timeMinutes: 480 }))
      if (!detail) assert.deepEqual(following.durationsSeconds, ordinary.durationsSeconds)
      else assert.equal(following.trace.rows.length, 4)
    }
    if (mode === 'scheduled') {
      // Exercise nearly the full output budget while retaining only two unique
      // OD observations. Public and detailed streams must expand identically.
      const percentiles = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 95, 100]
      const simulation = { ...mc, percentiles }
      const small = ok(await run({ ...base, monteCarlo: simulation }))
      const largeRequest = { ...base, origins: Array.from({ length: 256 }, () => ({ stopId: 'A' })),
        destinations: Array.from({ length: 256 }, (_, i) => ({ stopId: i % 2 ? 'B' : 'X' })), monteCarlo: simulation }
      const large = ok(await run(largeRequest))
      const largeDetail = ok(await runDetailed(largeRequest)).trace
      assert.equal(large.sampling.observationBytes, small.sampling.observationBytes)
      assert.equal(large.layout.rows, 256)
      assert.equal(large.layout.columns, 256)
      assert.deepEqual(largeDetail.durationsSeconds, large.durationsSeconds)
      assert.deepEqual(largeDetail.reachableSamples, large.reachableSamples)
      for (let p = 0; p < percentiles.length; p++) {
        assert.equal(large.durationsSeconds[p].length, 65536)
        assert(large.durationsSeconds[p].every((value, i) => value === small.durationsSeconds[p][i % 2]))
      }
      assert(large.reachableSamples.every((value, i) => value === small.reachableSamples[i % 2]))
      const requestFile = path.join(folder, 'simulation.json')
      fs.writeFileSync(requestFile, JSON.stringify({ ...base, monteCarlo: mc }))
      const nodeCli = spawnSync(process.execPath, ['public/vigo.mjs', 'matrix', '--city', city, '--request', requestFile], { cwd: root, encoding: 'utf8' })
      assert.equal(nodeCli.status, 0, nodeCli.stderr)
      const nodeResult = ok(JSON.parse(nodeCli.stdout))
      assert.equal(nodeResult.schema, 'vigo.distribution.v1')
      assert.deepEqual(nodeResult.durationsSeconds, result.durationsSeconds)
      assert.equal(nodeResult.meta.queryFingerprint, result.meta.queryFingerprint)
    }
    if (process.env.VIGO_MONTE_CARLO_CORPUS) {
      fs.mkdirSync(process.env.VIGO_MONTE_CARLO_CORPUS, { recursive: true })
      fs.writeFileSync(path.join(process.env.VIGO_MONTE_CARLO_CORPUS, `${mode}.json`), JSON.stringify({
        case: `monte-carlo/${mode}`, kind: 'matrix', exitCode: 0, request: { ...base, monteCarlo: mc }, result }))
    }
    const opportunityRequest = { ...base, monteCarlo: { ...mc, accessibility: {
      layers: [{ id: 'jobs', counts: [2, 3] }], cutoffsMinutes: [15, 60], dualThresholds: [1, 5, 6] } } }
    const opportunities = ok(await run(opportunityRequest))
    const detailedOpportunities = ok(await runDetailed(opportunityRequest)).trace
    assert.deepEqual(detailedOpportunities.accessibility, opportunities.accessibility)
    assert.equal(detailedOpportunities.meta.queryFingerprint, opportunities.meta.queryFingerprint)
    const indicator = opportunities.accessibility.layers[0]
    for (let p = 0; p < mc.percentiles.length; p++) for (let origin = 0; origin < 2; origin++) {
      const times = result.durationsSeconds[p].slice(origin * 2, origin * 2 + 2)
      assert.deepEqual(indicator.access[p][origin], [900, 3600].map(cutoff =>
        times.reduce((sum, time, i) => sum + (time !== null && time < cutoff ? [2, 3][i] : 0), 0)))
      assert.equal(indicator.dualSeconds[p][origin][2], null)
      assert.equal(indicator.dualSeconds[p][origin][0], times.filter(t => t !== null).length ? Math.min(...times.filter(t => t !== null)) : null)
    }
    if (process.env.VIGO_MONTE_CARLO_CORPUS) fs.writeFileSync(path.join(process.env.VIGO_MONTE_CARLO_CORPUS, `${mode}-access.json`), JSON.stringify({
      case: `monte-carlo/${mode}-access`, kind: 'matrix', exitCode: 0, request: opportunities.query, result: opportunities }))
    assert.equal(result.schema, 'vigo.distribution.v1')
    // GTFS frequency templates, exact or not, are departures every headway;
    // only a scenario's non-exact planned services sample phases.
    assert.equal(result.sampling.stochastic, false)
    assert.equal(result.sampling.sampleCount, 3)
    if (mode === 'exact-frequency') {
      const closed = ok(await run({ ...base, monteCarlo: { ...mc, startMinutes: 540, endMinutes: 541 } }))
      assert(closed.durationsSeconds.flat().every(value => value === null), 'City creation must not invent an exact departure at the frequency end time')
    }
    assert.equal(result.sampling.observationBytes, result.sampling.sampleCount * 2 * 8,
      'Duplicate origins share observations, while public cells stay expanded')
    assert(result.meta.queryFingerprint)
    assert.equal(result.query.maxWalkKm, .01)
    for (const values of result.durationsSeconds) {
      assert.deepEqual(values.slice(0, 2), values.slice(2), 'All origins in a draw use one realization')
    }
    ok(await run({ ...base, timeMinutes: 480, horizonMinutes: 2880 }))
    const repeat = ok(await run({ ...base, monteCarlo: mc }))
    assert.deepEqual(repeat.durationsSeconds, result.durationsSeconds)
    assert.deepEqual(repeat.reachableSamples, result.reachableSamples)
    assert.equal(repeat.meta.queryFingerprint, result.meta.queryFingerprint)
    if (mode === 'frequency') {
      const late = { ...base, monteCarlo: { ...mc, startMinutes: 840, endMinutes: 843 } }
      const outside = ok(await run(late))
      assert.equal(outside.sampling.stochastic, false, 'Out-of-window frequency entries need no random draws')
      assert.equal(outside.sampling.sampleCount, 3)
      ok(await run({ ...base, timeMinutes: 840, horizonMinutes: 2880 }))
      assert.deepEqual(ok(await run(late)).sampling, outside.sampling,
        'Loading future frequency entries must not change sampling or its memory budget')
    }
    const different = ok(await run({ ...base, monteCarlo: { ...mc, seed: 43 } }))
    // Every GTFS timetable here is deterministic: the distribution is the
    // ordinary answer at each sampled minute, for any seed.
    const samples = []
    for (let minute = 480; minute < 483; minute++) samples.push(ok(await run({ ...base, timeMinutes: minute })).durationsSeconds.flat())
    for (let cell = 0; cell < 4; cell++) {
      const sorted = samples.map(row => row[cell] ?? Infinity).sort((a, b) => a - b)
      mc.percentiles.forEach((p, i) => assert.equal(result.durationsSeconds[i][cell],
        Number.isFinite(sorted[Math.max(0, Math.ceil(p * 3 / 100) - 1)]) ? sorted[Math.max(0, Math.ceil(p * 3 / 100) - 1)] : null))
    }
    assert.deepEqual(different.durationsSeconds, result.durationsSeconds)
    assert.deepEqual(ok(await run({ ...base, timeMinutes: 480 })).durationsSeconds, ordinary.durationsSeconds, 'Sampling must not affect later ordinary queries')
    const route = ok(await run({ ...base, kind: 'route', origins: undefined, destinations: undefined,
      origin: { stopId: 'A' }, destination: { stopId: 'X' }, monteCarlo: mc }))
    assert.deepEqual(route.durationsSeconds.map(row => row[0]), result.durationsSeconds.map(row => row[0]))
    const reach = ok(await run({ kind: 'reach', serviceDate: base.serviceDate, origin: { coordinate: [-77.05, 38.9] },
      rasterSize: 16, extentRadiusKm: 1, maxWalkKm: .01, cutoffsMinutes: [15, 30],
      monteCarlo: { startMinutes: 480, endMinutes: 483, draws: 3 } }))
    assert.equal(reach.layout.width, 16)
    assert.equal(reach.durationsSeconds[0].length, 256)
    if (mode === 'scheduled') {
      // Saturday-to-Monday: the last departures need coverage beyond the
      // first draw's 60-hour prepared prefix. Pin the complete window first.
      const late = { ...base, serviceDate: '2026-07-18', origins: [{ stopId: 'B' }],
        destinations: [{ stopId: 'A' }], horizonMinutes: 2880 }
      const window = { startMinutes: 719, endMinutes: 734, percentiles: [0, 50, 100] }
      const distribution = ok(await run({ ...late, monteCarlo: window }))
      const arrivals = []
      for (let minute = 719; minute < 734; minute++) {
        arrivals.push(ok(await run({ ...late, timeMinutes: minute })).durationsSeconds[0][0] ?? Infinity)
      }
      arrivals.sort((a, b) => a - b)
      assert(arrivals[0] < Infinity && arrivals.at(-1) === Infinity)
      window.percentiles.forEach((p, i) => {
        const expected = arrivals[Math.max(0, Math.ceil(p * 15 / 100) - 1)]
        assert.equal(distribution.durationsSeconds[i][0], Number.isFinite(expected) ? expected : null)
      })
      // Shared coordinate access and direct walks must match independent
      // ordinary queries, including duplicates and an unattached endpoint.
      const walking = { ...base, origins: [{ coordinate: [-77.05, 38.9] }, { stopId: 'A' }],
        destinations: [{ coordinate: [-77.049, 38.9] }, { coordinate: [0, 0] },
          { coordinate: [-77.049, 38.9] }], requireTransitRide: false, maxWalkKm: .8 }
      const sampled = ok(await run({ ...walking, monteCarlo: mc }))
      const ordinaryRows = []
      for (let minute = 480; minute < 483; minute++) {
        const raw = ok(await run({ ...walking, timeMinutes: minute, diagnostics: 'trace' })).trace
        ordinaryRows.push(raw.durationsMinutes.flat().map(v => v === null ? null : v * 60))
      }
      const surfaces = []
      for (let minute = 480; minute < 483; minute++) {
        const raw = ok(await run({ ...reach.query, kind: 'reach', monteCarlo: undefined, timeMinutes: minute,
          reachFormat: 'surface', diagnostics: 'trace' })).trace
        surfaces.push(raw.surface.values.map(v => v === null ? Infinity : v * 60))
      }
      for (let cell = 0; cell < 256; cell++) {
        const sorted = surfaces.map(row => row[cell]).sort((a, b) => a - b)
        reach.percentiles.forEach((p, i) => {
          const expected = sorted[Math.max(0, Math.ceil(p * 3 / 100) - 1)]
          if (!Number.isFinite(expected)) assert.equal(reach.durationsSeconds[i][cell], null)
          else assert(Math.abs(reach.durationsSeconds[i][cell] - expected) < 1e-8)
        })
      }
      for (let cell = 0; cell < sampled.durationsSeconds[0].length; cell++) {
        const sorted = ordinaryRows.map(row => row[cell] ?? Infinity).sort((a, b) => a - b)
        mc.percentiles.forEach((p, i) => {
          const expected = sorted[Math.max(0, Math.ceil(p * ordinaryRows.length / 100) - 1)]
          if (!Number.isFinite(expected)) assert.equal(sampled.durationsSeconds[i][cell], null)
          else assert(Math.abs(sampled.durationsSeconds[i][cell] - expected) < 1e-8,
            `Matrix percentile ${p}, cell ${cell}: ${sampled.durationsSeconds[i][cell]} / ${expected}`)
        })
      }
    }
    for (const extra of [{ monteCarlo: { ...mc, endMinutes: 480 } }, { monteCarlo: { ...mc, draws: 0 } },
      { monteCarlo: { ...mc, seed: -1 } }, { monteCarlo: { ...mc, percentiles: [95, 50] } },
      { timeMinutes: 480 }, { scenario: { unknown: true } }, { includeJourneys: true }, { mode: 'bike' },
      { routingDataMode: 'realtime' }, { timePreference: 'arrive_by' }, { unknown: true }]) {
      assert.equal((await run({ ...base, monteCarlo: mc, ...extra })).status, 'error', JSON.stringify(extra))
    }
    assert.deepEqual(ok(await run({ ...base, timeMinutes: 480 })).durationsSeconds, ordinary.durationsSeconds)
    if (mode === 'scheduled') {
      const service = (id, from, to) => ({ id, stops: [{ stopId: from }, { stopId: to }],
        scheduleMode: 'frequency', bidirectional: false, startMinutes: 480, endMinutes: 600,
        headwayMinutes: 20, timeModel: 'preserve-scheduled', segmentRuntimeMinutes: [10] })
      const first = service('first', 'A', 'X'), second = service('second', 'X', 'B')
      const scenario = { excludedRouteIds: ['R1', 'R2'], services: [first, { ...second,
        phaseFrom: { serviceId: 'first', atStopIndex: 0, fromStopIndex: 1, offsetMinutes: 2 } }] }
      const phased = ok(await run({ ...base, scenario, monteCarlo: { ...mc, endMinutes: 481 } }))
      assert.equal(phased.sampling.stochastic, true)
      assert.deepEqual(phased.reachableSamples, [200, 200, 200, 200])
      for (const row of phased.durationsSeconds) assert.equal(Math.round(row[1] - row[0]), 720,
        'A two-minute pulse follows the first vehicle at its actual transfer stop')
      const independent = ok(await run({ ...base, scenario: { ...scenario, services: [first, second] },
        monteCarlo: { ...mc, endMinutes: 481 } }))
      assert(independent.durationsSeconds[4][1] > phased.durationsSeconds[4][1])
      const fixed = ok(await run({ ...base, scenario: { ...scenario, services: [
        { ...first, exactTimes: true }, { ...second, exactTimes: true }] }, monteCarlo: mc }))
      assert.equal(fixed.sampling.stochastic, false)
      assert.equal(fixed.sampling.sampleCount, 3)
      const originalTrip = { tripId: 'T1', departureSeconds: 480 * 60,
        arrivalOffsetsSeconds: [0, 600, 1320], departureOffsetsSeconds: [0, 720, 1320],
        canBoard: [1, 1, 0], canAlight: [0, 1, 1] }
      for (const [timing, expected] of [
        [{ speedFactor: 2, dwellScale: .5 }, [300, 660]],
        [{ speedFactor: 2, segmentIndexes: [0], dwellMinutes: .5, stopIndexes: [1] }, [300, 930]],
        [{ dwellScale: 0 }, [600, 1200]],
      ]) {
        const edited = { ...first, stops: [{ stopId: 'A' }, { stopId: 'X' }, { stopId: 'B' }],
          scheduleMode: 'preserve-trips', scheduledTrips: [originalTrip], timing }
        const query = { ...base, scenario: { ...scenario, services: [edited] }, monteCarlo: { ...mc, endMinutes: 481 } }
        const adjusted = ok(await run(query))
        assert.deepEqual(adjusted.durationsSeconds[2].slice(0, 2), expected, 'Separate moving and standing times')
        const single = ok(await run({ kind: 'route', serviceDate: base.serviceDate, origin: { stopId: 'A' }, destination: { stopId: 'B' },
          timeMinutes: 480, maxWalkKm: .01, requireTransitRide: true, scenario: query.scenario }))
        assert.equal(single.journey.durationSeconds, expected[1], 'Ordinary scenario routing must use the same timing edits')
        const nodeTrip = adjustScheduledTrip(originalTrip, timing)
        assert.equal(nodeTrip.departureSeconds, originalTrip.departureSeconds, 'First departure must remain fixed')
        assert.deepEqual(nodeTrip.arrivalOffsetsSeconds.slice(1), expected)
        assert.deepEqual(originalTrip.departureOffsetsSeconds, [0, 720, 1320], 'Timing edits cannot mutate the baseline')
        if (process.env.VIGO_MONTE_CARLO_CORPUS) fs.writeFileSync(path.join(process.env.VIGO_MONTE_CARLO_CORPUS, 'timing-edit.json'),
          JSON.stringify({ case: 'monte-carlo/timing-edit', kind: 'matrix', exitCode: 0, request: query, result: adjusted }))
      }
      for (const timing of [{ speedFactor: 0 }, { dwellScale: -1 }, { dwellScale: 1, dwellMinutes: 1 },
        { segmentIndexes: [2] }, { stopIndexes: [0] }, { segmentIndexes: [0, 0] }]) {
        assert.throws(() => adjustScheduledTrip(originalTrip, timing))
        assert.equal((await run({ ...base, scenario: { ...scenario, services: [{ ...first,
          scheduleMode: 'preserve-trips', stops: [{ stopId: 'A' }, { stopId: 'X' }, { stopId: 'B' }], scheduledTrips: [originalTrip], timing }] },
          monteCarlo: { ...mc, endMinutes: 481 } })).status, 'error')
      }
      const timetableService = { ...first, timetables: [
        { id: 'morning', startMinutes: 480, endMinutes: 481, headwayMinutes: 10, daysOfWeek: [3], exactTimes: true },
        { id: 'later', startMinutes: 485, endMinutes: 486, headwayMinutes: 10, daysOfWeek: [3], exactTimes: true },
        { id: 'weekend', startMinutes: 480, endMinutes: 600, headwayMinutes: 1, daysOfWeek: [6, 7] },
      ] }
      const rows = ok(await run({ ...base, scenario: { ...scenario, services: [timetableService] }, monteCarlo: mc }))
      assert.equal(rows.sampling.sampleCount, 3, 'Inactive stochastic rows must not trigger extra draws')
      assert.deepEqual(rows.durationsSeconds.map(row => row[0]), [600, 600, 780, 840, 840], 'Independent timetable-row schedule oracle')
      const noWednesday = ok(await run({ ...base, scenario: { ...scenario, services: [{ ...timetableService,
        timetables: timetableService.timetables.map(row => ({ ...row, daysOfWeek: [1] })) }] }, monteCarlo: mc }))
      assert(noWednesday.durationsSeconds.flat().every(value => value === null), 'Inactive weekdays must not create service')
      const overlapping = ok(await run({ ...base, scenario: { ...scenario, services: [{ ...first, timetables: [
        { id: 'one', startMinutes: 480, endMinutes: 600, headwayMinutes: 20 },
        { id: 'two', startMinutes: 480, endMinutes: 600, headwayMinutes: 20 },
      ] }] }, monteCarlo: { ...mc, endMinutes: 481 } }))
      assert(overlapping.durationsSeconds[2][0] < independent.durationsSeconds[2][0], 'Overlapping entries need independent phases')
      for (const patch of [{ timetables: [] }, { timetables: [timetableService.timetables[0], timetableService.timetables[0]] },
        { timetables: [{ ...timetableService.timetables[0], daysOfWeek: [8] }] },
        { timetables: [{ ...timetableService.timetables[0], endMinutes: 480 }] }]) {
        assert.equal((await run({ ...base, scenario: { ...scenario, services: [{ ...first, ...patch }] }, monteCarlo: mc })).status, 'error')
      }
      const cyclic = structuredClone(scenario)
      cyclic.services[0].phaseFrom = { serviceId: 'second', atStopIndex: 0, fromStopIndex: 0 }
      assert.equal((await run({ ...base, scenario: cyclic, monteCarlo: mc })).status, 'error')
      const memoryError = await run({ kind: 'reach', serviceDate: base.serviceDate,
        origin: { coordinate: [-77.05, 38.9] }, rasterSize: 32, extentRadiusKm: 1, scenario,
        monteCarlo: { ...mc, draws: 10000 } })
      assert.equal(memoryError.status, 'error')
      assert.match(JSON.stringify(memoryError), /64 MiB/)
      const matrixMemoryError = await run({ ...base, scenario,
        destinations: Array.from({ length: 1000 }, (_, i) => ({ coordinate: [-77.05 + i * .000001, 38.9] })),
        monteCarlo: { ...mc, endMinutes: 481, draws: 10000 } })
      assert.match(JSON.stringify(matrixMemoryError), /64 MiB/,
        'Reject observation overflow before preparing thousands of coordinate endpoints')
      assert.deepEqual(ok(await run({ ...base, timeMinutes: 480 })).durationsSeconds, ordinary.durationsSeconds)
    }
  }
} finally {
  // EOF lets the Node CLI close its native reader too. Windows keeps mapped
  // City files locked until these processes and their streams have closed.
  await Promise.all(children.map(async ({ child, closed }) => {
    const timeout = setTimeout(() => child.kill(), 5000)
    try {
      child.stdin.end()
      assert.equal(await closed, 0, 'Resident stream must close cleanly on EOF')
    } finally { clearTimeout(timeout) }
  }))
  if (!process.env.VIGO_KEEP_MONTE_CARLO_FIXTURES) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
console.log('Monte Carlo: exact-minute oracle, sampled bounds, transfers, shared draws, reproducibility, cleanup and validation passed')
