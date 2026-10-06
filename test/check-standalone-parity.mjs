// Differential public-fixture checks: compare the standalone adapter with the
// established CLI, not merely with expected output from the same adapter.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-standalone-parity-'))
const failures = []
const processes = []
let checked = 0
function resident(executable, args, env) {
  const child = spawn(executable, args, { cwd: root, env })
  processes.push(child)
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', text => { errors += text })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  return async q => {
    child.stdin.write(`${JSON.stringify({ ...q, diagnostics: "trace" })}\n`)
    let timer
    const line = await Promise.race([
      lines.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Query timeout: ${errors}`)), 30_000) }),
    ]).finally(() => clearTimeout(timer))
    assert(!line.done, `Process exited: ${errors}`)
    const result = JSON.parse(line.value)
    return result.trace ?? result
  }
}
function check(name, fn) {
  checked++
  try { fn() } catch (error) { failures.push({ name, error: error.message }) }
}
const close = (actual, expected, label, tolerance = .0011) => {
  assert.equal(Number.isFinite(actual), Number.isFinite(expected), label)
  if (Number.isFinite(expected)) assert(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`)
}
const point = id => ({ stopId: id })
const coord = (lon, lat) => ({ coordinate: [lon, lat] })
const base = { kind: 'route', origin: point('A'), destination: point('B'), serviceDate: '2026-07-15', timeMinutes: 475, maxWalkKm: .2 }
const runtimeEnv = { PATH: '', RAYON_NUM_THREADS: '2' }
try {
  for (const policy of ['default', 'configured']) {
    const folder = path.join(directory, policy)
    fs.mkdirSync(folder)
    const inputs = await writeCliFixtureInputs(folder, { terminalAccess: true })
    const zip = await JSZip.loadAsync(fs.readFileSync(inputs.gtfsPath))
    zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,38.900,-77.050,0,\nX,Transfer,38.905,-77.040,0,P\nY,Other platform,38.9051,-77.040,0,P\nP,Station,38.905,-77.040,1,\nB,Bravo,38.910,-77.030,0,\n')
    zip.file('calendar_dates.txt', 'service_id,date,exception_type\nWKD,20260716,2\nWKD,20260719,1\n')
    zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,shape_id\nR1,WKD,T1,0,S1\nR2,WKD,T2,0,\n')
    zip.file('shapes.txt', 'shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\nS1,0,38.900,-77.050\nS1,1,38.903,-77.046\nS1,2,38.905,-77.040\n')
    fs.writeFileSync(inputs.gtfsPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    const env = { ...process.env, RAYON_NUM_THREADS: '2', VIGO_ROUTING_WALK_SPEED_KPH: '4.8', VIGO_ROUTING_WALK_PADDING_FACTOR: policy === 'configured' ? '1.5' : '1', VIGO_ROUTING_WALK_OVERHEAD_SECONDS: policy === 'configured' ? '60' : '0' }
    const city = path.join(folder, 'city')
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, '--private-access=endpoints', `--output=${city}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] })
    const rust = resident(binary, ['stream', '--city', city], runtimeEnv)
    const legacy = resident(process.execPath, ['public/vigo.mjs', 'stream', '--city', city, '--service-date=2026-07-15'], env)
    const dates = new Map([['2026-07-15', legacy]])
    async function route(q, label) {
      const input = { ...base, ...q }
      if (!dates.has(input.serviceDate)) dates.set(input.serviceDate, resident(process.execPath, ['public/vigo.mjs', 'stream', '--city', city, `--service-date=${input.serviceDate}`], env))
      const ref = await dates.get(input.serviceDate)({ ...input, timePreference: input.timePreference === 'arrive_by' ? 'arrive' : 'depart' })
      const r = await rust(input)
      check(`${policy} ${label}`, () => {
        assert(!ref.error, JSON.stringify(ref.error))
        assert(!r.error, JSON.stringify(r.error))
        const p = ref.result ?? ref.plan
        assert(p, JSON.stringify(ref).slice(0, 300))
        assert.equal(r.status, p.status, `status: ${JSON.stringify({ rust: r.status, reference: p.status })}`)
        if (p.status !== 'ready') return
        assert.equal(r.mode, p.travelMode)
        close(r.departureMinutes, p.departMinutes, 'departure')
        close(r.arrivalMinutes, p.arriveMinutes, 'arrival')
        assert.equal(r.transfers, p.transfers, 'transfers')
        assert.deepEqual(r.legs.filter(l => l.kind === 'ride').map(l => l.tripId), p.legs.filter(l => l.type === 'ride').map(l => l.tripId), 'selected trips')
        for (const ride of r.legs.filter(l => l.kind === 'ride')) {
          const original = p.legs.find(l => l.type === 'ride' && l.tripId === ride.tripId)
          assert.deepEqual(ride.stopIds, original.stopIds, 'source stop sequence')
          assert.deepEqual(ride.coordinates, original.coordinates, 'source geometry')
        }
      })
    }
    const endpoints = [[point('A'), point('B')], [point('A'), point('P')], [point('P'), point('B')], [point('Y'), point('B')], [coord(-77.049, 38.9005), coord(-77.031, 38.9095)], [point('B'), point('A')]]
    for (const [origin, destination] of endpoints) {
      for (const timePreference of ['depart_at', 'arrive_by']) {
        for (const timeMinutes of [475, 485, 510, 530]) {
          for (const maxTransfers of [0, 1]) {
            await route({ origin, destination, timePreference, timeMinutes, maxTransfers }, `${JSON.stringify([origin, destination, timePreference, timeMinutes, maxTransfers])}`)
          }
        }
      }
    }
    for (const mode of ['walk', 'drive', 'transit']) {
      for (const timePreference of ['depart_at', 'arrive_by']) {
        await route({ mode, origin: coord(-77.05, 38.9), destination: coord(-77.03, 38.91), timePreference, requireTransitRide: false }, `${mode} direct physical timing ${timePreference}`)
      }
    }
    await route({ origin: point('B'), destination: point('A'), requireTransitRide: false }, 'blocked selected-stop fallback')
    for (const arrivalBufferMinutes of [0, 5, 6]) {
      for (const minimumTransferBufferMinutes of [0, 3, 15]) {
        const q = { ...base, timePreference: 'arrive_by', timeMinutes: 515,
          arrivalBufferMinutes, minimumTransferBufferMinutes }
        await route(q, `arrival reserve ${arrivalBufferMinutes}, transfer reserve ${minimumTransferBufferMinutes}`)
        const matrix = { ...q, kind: 'matrix', origins: [point('A'), point('B')], destinations: [point('B')], includeJourneys: true }
        delete matrix.origin; delete matrix.destination
        const ref = await legacy({ ...matrix, timePreference: 'arrive' })
        const actual = await rust(matrix)
        check(`${policy} reserved Matrix ${arrivalBufferMinutes}/${minimumTransferBufferMinutes}`, () => {
          assert(!ref.error, JSON.stringify(ref.error)); assert(!actual.error, JSON.stringify(actual.error))
          for (const row of ref.rows) {
            close(actual.durationsMinutes[row.originIndex][row.destinationIndex], row.durationMinutes, 'reserved matrix duration')
            if (row.journey) close(actual.journeys[row.originIndex][row.destinationIndex].arrivalMinutes, row.journey.arriveMinutes, 'actual arrival')
          }
          assert.deepEqual(actual.diagnostics.timeReserves, ref.diagnostics.timeReserves)
        })
      }
    }
    for (const invalid of [{ arrivalBufferMinutes: -1 }, { arrivalBufferMinutes: '5' },
      { arrivalBufferMinutes: 5, timePreference: 'depart_at' }, { arrivalBufferMinutes: 5, mode: 'walk' },
      { arrivalBufferMinutes: 5, horizonMinutes: 5 }, { arrivalBufferMinutes: 5, timeMinutes: 4 },
      { arrivalBufferMinutes: 5, waypoints: [point('X')] }]) {
      const input = { ...base, timePreference: 'arrive_by', timeMinutes: 515, ...invalid }
      const a = await rust(input)
      const b = await legacy({ ...input, timePreference: input.timePreference === 'arrive_by' ? 'arrive' : 'depart' })
      check(`${policy} invalid arrival reserve ${JSON.stringify(invalid)}`, () => {
        assert(a.error, JSON.stringify(a)); assert(b.error, JSON.stringify(b))
      })
    }
    for (const serviceDate of ['2026-07-16', '2026-07-18', '2026-07-19']) {
      await route({ serviceDate }, `calendar ${serviceDate}`)
    }
    for (const mode of ['transit', 'walk', 'drive']) {
      for (const timePreference of ['depart_at', 'arrive_by']) {
        for (const requireTransitRide of [true, false]) {
          const q = { ...base, kind: 'matrix', origins: [point('A'), point('Y'), coord(-77.049, 38.9005), point('B')], destinations: [point('B'), point('A')], mode, timePreference, timeMinutes: 510, includeJourneys: mode === 'transit', requireTransitRide }
          delete q.origin; delete q.destination
          const ref = await legacy({ ...q, timePreference: timePreference === 'arrive_by' ? 'arrive' : 'depart' })
          const r = await rust(q)
          check(`${policy} Matrix ${mode} ${timePreference} ride=${requireTransitRide}`, () => {
            assert(!ref.error, JSON.stringify(ref.error)); assert(!r.error, JSON.stringify(r.error))
            for (const row of ref.rows) {
              const duration = r.durationsMinutes[row.originIndex][row.destinationIndex]
              assert.equal(duration !== null, row.status === 'ready', `pair ${row.originIndex},${row.destinationIndex}`)
              if (duration !== null) close(duration, row.durationMinutes, `pair ${row.originIndex},${row.destinationIndex}`, .0011)
            }
          })
        }
      }
    }
    // A point retains both selected street frontiers. A matrix replaces them
    // while preparing other endpoints; old tokens must use the exact fallback.
    // Repeat a coordinate to cover shared candidate evidence as well.
    for (const timePreference of ['depart_at', 'arrive_by']) {
      for (const disableCache of [true, false]) {
        const origins = [coord(-77.049, 38.9005), coord(-77.048, 38.901), coord(-77.049, 38.9005)]
        const destinations = [coord(-77.031, 38.9095), coord(-77.032, 38.909)]
        const q = { ...base, kind: 'matrix', origins, destinations, timePreference,
          timeMinutes: timePreference === 'arrive_by' ? 530 : 475,
          includeJourneys: true, includeGeometry: true, disableCache, requireTransitRide: true }
        delete q.origin; delete q.destination
        const matrix = await rust(q)
        check(`${policy} selected walking frontiers ${timePreference} disableCache=${disableCache}`, () => assert(!matrix.error, JSON.stringify(matrix.error)))
        for (let i = 0; i < origins.length; i++) {
          for (let j = 0; j < destinations.length; j++) {
            const request = { ...q, kind: 'route', origin: origins[i], destination: destinations[j] }
            for (const key of ['origins', 'destinations', 'includeJourneys', 'includeGeometry']) delete request[key]
            const point = await rust(request)
            check(`${policy} selected versus expired walking witness ${timePreference} disableCache=${disableCache} ${i},${j}`, () => {
              assert(!point.error, JSON.stringify(point.error))
              const journey = matrix.journeys[i][j]
              assert.equal(journey !== null, point.status === 'ready')
              if (!journey) return
              assert.deepEqual(journey.legs, point.legs, 'Path direction, costs, station evidence, and geometry must survive frontier replacement')
              for (const key of ['departureMinutes', 'arrivalMinutes', 'transfers']) assert.equal(journey[key], point[key])
            })
          }
        }
      }
    }
    for (const walkSpeedKph of [2, 4.8, 8]) {
      const q = { ...base, kind: 'reach', origin: coord(-77.049, 38.9005), walkSpeedKph, timeMinutes: 478, cutoffsMinutes: [15, 30, 45], extentRadiusKm: 2, rasterSize: 48, includeStreetEdges: true }
      delete q.destination
      const ref = await legacy(q)
      const r = await rust({ ...q, bounds: ref.surface?.bounds })
      check(`${policy} Reach walking speed ${walkSpeedKph}`, () => {
        assert(!ref.error, JSON.stringify(ref.error)); assert(!r.error, JSON.stringify(r.error))
        assert.equal(r.surface.values.length, ref.surface.values.length)
        r.surface.values.forEach((v, i) => {
          assert.equal(v === null, ref.surface.values[i] === null, `cell ${i} reachability`)
          // The existing adapter rounds transit seeds to 0.001 minutes before
          // building its raster; Rust retains the native seconds precision.
          if (v !== null) close(v, ref.surface.values[i], `cell ${i}`, .00051)
        })
      })
    }
    const service = { id: 'test', operation: 'add', stops: [{ ...point('A'), coordinate: [-77.05, 38.9] }, { ...point('B'), coordinate: [-77.03, 38.91] }], startMinutes: 475, endMinutes: 600, headwayMinutes: 5, segmentRuntimeMinutes: [5] }
    for (const scenario of [{ excludedTripIds: ['T2'] }, { services: [service] },
      { services: [{ ...service, timeModel: 'preserve-scheduled', addedStopDwellMinutes: 2, stops: [...service.stops].reverse().map((p, i) => ({ ...p, editStatus: i === 0 ? 'added' : 'unchanged' })) }] },
      { services: [{ ...service, timeModel: 'infer-road', segmentDistancesKm: [3] }] },
      { services: [{ ...service, operation: 'replace', scheduleMode: 'frequency', sourceRouteId: 'R1', timeModel: 'preserve-scheduled' }] },
    ]) {
      const q = { ...base, kind: 'reach', cutoffsMinutes: [15, 30, 45], extentRadiusKm: 2, rasterSize: 48, scenario }
      delete q.destination
      const ref = await legacy(q)
      const r = await rust({ ...q, bounds: ref.surface?.bounds })
      check(`${policy} Reach scenario ${JSON.stringify(scenario)}`, () => {
        assert(!ref.error, JSON.stringify(ref.error)); assert(!r.error, JSON.stringify(r.error))
        r.surface.values.forEach((v, i) => {
          assert.equal(v === null, ref.surface.values[i] === null, `cell ${i} reachability`)
          if (v !== null) close(v, ref.surface.values[i], `cell ${i}`, .00051)
        })
      })
    }
    const now = Math.floor(Date.now() / 1000)
    for (const [label, snapshot] of [
      ['fresh delay', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }] }],
      ['stale delay', { feedTimestamp: now - 1000, tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }] }],
      ['missing clock', { tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }] }],
      ['route identity mismatch', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', routeId: 'WRONG', delaySeconds: 600 }] }],
      ['fresh cancellation', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', scheduleRelationship: 'CANCELED' }] }],
      ['duplicate trips', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }, { tripId: 'T2', delaySeconds: 1200 }] }],
      ['ambiguous stop identity', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', stopTimeUpdates: [{ stopSequence: 1, stopId: 'A', departure: { delay: 600 } }] }] }],
      ['terminal sequence inference', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', stopTimeUpdates: [{ stopSequence: 10, stopId: 'B', arrival: { delay: 600 } }] }] }],
      ['NO_DATA delay reset', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', delaySeconds: 600, stopTimeUpdates: [{ stopSequence: 1, scheduleRelationship: 'NO_DATA' }] }] }],
      ['skipped terminal', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', stopTimeUpdates: [{ stopSequence: 2, scheduleRelationship: 'SKIPPED' }] }] }],
      ['contradictory prediction', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', stopTimeUpdates: [{ stopSequence: 2, arrival: { delay: -1800 } }] }] }],
      ['record freshness', { feedTimestamp: now, tripUpdates: [{ tripId: 'T2', timestamp: now - 1000, delaySeconds: 600 }] }],
    ]) {
      await route({ routingDataMode: 'realtime', realtimeSnapshot: snapshot }, `realtime ${label}`)
      await route({ routingDataMode: 'realtime', realtimeSnapshot: snapshot, timePreference: 'arrive_by',
        timeMinutes: 525, arrivalBufferMinutes: 5, minimumTransferBufferMinutes: 3 }, `realtime reserved ${label}`)
    }
  }
  console.log(JSON.stringify({ checked, failures }, null, 2))
  assert.equal(failures.length, 0, `${failures.length}/${checked} standalone parity checks failed`)
} finally {
  await Promise.all(processes.filter(child => child.exitCode === null).map(child => { const exited = once(child, 'exit'); child.kill(); return exited }))
  if (process.env.VIGO_KEEP_STANDALONE_FIXTURE) console.log(`Retained parity fixtures: ${directory}`)
  else fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
