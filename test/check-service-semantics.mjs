import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-services-'))
const children = []
let records = 0
const corpus = process.env.VIGO_SERVICE_CORPUS
if (corpus) fs.mkdirSync(corpus, { recursive: true })
try {
  for (const variant of ['scoped', 'scoped-street', 'headway', 'headway-only', 'headway-overnight']) {
    const folder = path.join(dir, variant)
    fs.mkdirSync(folder)
    const inputs = await writeCliFixtureInputs(folder)
    const zip = await JSZip.loadAsync(fs.readFileSync(inputs.gtfsPath))
    zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nR1,WKD,T1,0\nR1,WKD,T0,0\nR2,WKD,T2,1\n')
    zip.file(
      'stop_times.txt',
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT0,07:59:00,07:59:00,A,1\nT0,08:09:00,08:09:00,X,2\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,X,2\nT2,08:15:00,08:15:00,X,1\nT2,08:30:00,08:30:00,B,2\n'
    )
    zip.file('transfers.txt', 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type\nX,X,T0,T2,3\n')
    if (variant === 'scoped-street') {
      zip.file('stops.txt', (await zip.file('stops.txt').async('string')) + 'Y,Separate street stop,38.905,-77.039\n')
      zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string')).replace('T2,08:15:00,08:15:00,X,1', 'T2,08:15:00,08:15:00,Y,1'))
      zip.file('transfers.txt', 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\nX,Y,T0,T2,3,0\nX,Y,T1,T2,2,120\n')
    }
    if (variant.startsWith('headway'))
      zip.file(
        'frequencies.txt',
        'trip_id,start_time,end_time,headway_secs,exact_times\nT2,08:10:00,09:00:00,600,0\n'
      )
    if (variant === 'headway-overnight')
      zip.file(
        'frequencies.txt',
        'trip_id,start_time,end_time,headway_secs,exact_times\nT2,08:10:00,25:00:00,600,0\n'
      )
    if (variant === 'headway-only')
      zip.file(
        'frequencies.txt',
        (await zip.file('frequencies.txt').async('string')) +
          'T1,08:00:00,09:00:00,600,0\nT0,08:00:00,09:00:00,600,0\n'
      )
    fs.writeFileSync(inputs.gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const city = path.join(folder, 'city')
    execFileSync(
      process.execPath,
      [
        'public/vigo.mjs',
        'build',
        `--gtfs=${inputs.gtfsPath}`,
        `--osm=${inputs.osmPath}`,
        `--output=${city}`
      ],
      { cwd: root, stdio: 'pipe' }
    )
    const child = spawn(standaloneBinary, ['stream', '--city', city])
    children.push(child)
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const run = async (q) => {
      child.stdin.write(JSON.stringify(q) + '\n')
      const line = await lines.next()
      assert(!line.done, stderr)
      const r = JSON.parse(line.value)
      assert.notEqual(r.status, 'error', JSON.stringify(r))
      if (corpus) {
        const request = { ...q }
        delete request.kind
        fs.writeFileSync(
          path.join(corpus, `${String(records++).padStart(3, '0')}.json`),
          JSON.stringify({ case: `${variant}-${records}`, kind: q.kind, request, result: r, exitCode: 0 })
        )
      }
      return r
    }
    const base = {
      kind: 'route',
      origin: { stopId: 'A' },
      destination: { stopId: 'B' },
      serviceDate: '2026-07-15',
      timeMinutes: 478,
      maxWalkKm: 0.01,
      maxTransfers: 1,
      requireTransitRide: true,
      includeGeometry: true,
      diagnostics: 'trace'
    }
    for (const reverse of [false, true]) {
      const r = await run({
        ...base,
        ...(reverse
          ? { timePreference: 'arrive_by', timeMinutes: variant === 'headway-only' ? 515 : 510 }
          : {})
      })
      assert.equal(r.status, 'ok', JSON.stringify(r))
      assert.deepEqual(
        r.journey.legs.filter((l) => l.type === 'transit').map((l) => l.trip.id),
        ['T1', 'T2'],
        JSON.stringify(r)
      )
      assert.equal(r.journey.arrivalTime, variant === 'headway-only' ? '08:35:00' : '08:30:00')
      if (variant.startsWith('headway'))
        assert.equal(
          r.journey.legs.filter((l) => l.type === 'transit').at(-1).quality.schedule,
          'headway_estimate'
        )
    }
    if (variant === 'scoped-street') {
      for (const reverse of [false, true]) {
        const blocked = await run({ ...base, allowStreetTransfers: false,
          ...(reverse ? { timePreference: 'arrive_by', timeMinutes: 510 } : {}) })
        assert.equal(blocked.status, 'not_found', JSON.stringify(blocked))
      }
      const restored = await run({ ...base, allowStreetTransfers: true })
      assert.equal(restored.status, 'ok')
      assert.deepEqual(restored.journey.legs.filter(l => l.type === 'transit').map(l => l.trip.id), ['T1', 'T2'])
    }
    const expected = variant === 'headway-only' ? 2220 : 1920
    const matrix = await run({
      ...base,
      kind: 'matrix',
      origins: [base.origin],
      destinations: [base.destination],
      origin: undefined,
      destination: undefined,
      includeJourneys: true
    })
    assert.deepEqual(matrix.durationsSeconds, [[expected]])
    const compact = await run({ ...base, kind: 'matrix', origins: [base.origin],
      destinations: [base.destination], origin: undefined, destination: undefined,
      includeJourneys: true, includeGeometry: false, journeyFormat: 'compact' })
    assert.deepEqual(compact.durationsSeconds, matrix.durationsSeconds)
    if (variant.startsWith('headway')) {
      const ride = compact.trace.journeys[0][0].legs.find(leg => leg.headwayEstimate)
      assert.deepEqual(ride.headwayEstimate, { headwaySeconds: 600,
        waitingAssumption: 'half_headway', expectedWaitSeconds: 300 })
    }

    const reach = await run({
      kind: 'reach',
      origin: base.origin,
      serviceDate: base.serviceDate,
      timeMinutes: 478,
      maxWalkKm: 0.01,
      maxTransfers: 1,
      cutoffsMinutes: [45],
      extentRadiusKm: 3,
      rasterSize: 16,
      reachFormat: 'surface',
      diagnostics: 'trace'
    })
    assert.equal(reach.trace.stops.find((s) => s.stopId === 'B').durationMinutes, expected / 60)
    if (variant.startsWith('headway')) {
      for (const minutes of [490, 492, 494, 500, 520]) {
        const r = await run({ ...base, origin: { stopId: 'X' }, timeMinutes: minutes })
        assert.equal(r.status, 'ok')
        const total = minutes + 20
        assert.equal(
          r.journey.arrivalTime,
          `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`
        )
      }
    }
    if (variant === 'headway-overnight') {
      for (const reverse of [false, true]) {
        const r = await run({
          ...base,
          origin: { stopId: 'X' },
          timeMinutes: reverse ? 30 : 10,
          ...(reverse ? { timePreference: 'arrive_by' } : {})
        })
        assert.equal(r.status, 'ok', JSON.stringify(r))
        assert.equal(r.journey.durationSeconds, 1200, JSON.stringify(r))
      }
    }
    if (variant === 'headway-only') {
      const q = {
        kind: 'reach',
        origin: base.origin,
        serviceDate: base.serviceDate,
        maxWalkKm: 0.01,
        maxTransfers: 1,
        cutoffsMinutes: [45],
        extentRadiusKm: 3,
        rasterSize: 16,
        reachFormat: 'surface'
      }
      const all = await run({ ...q, allDay: { startMinutes: 480, endMinutes: 495 } })
      const counts = Array(256).fill(0),
        sums = Array(256).fill(0)
      for (const timeMinutes of [480, 485, 490]) {
        const sample = await run({ ...q, timeMinutes, disableCache: true, diagnostics: 'trace' })
        sample.trace.surface.values.forEach((value, i) => {
          if (value !== null) {
            counts[i]++
            sums[i] += value * 60
          }
        })
      }
      assert.deepEqual(all.surface.reachableSamples, counts)
      all.surface.meanReachableDurationSeconds.forEach((mean, i) => {
        if (counts[i]) assert(Math.abs(mean - sums[i] / counts[i]) < 1e-8)
        else assert.equal(mean, null)
      })
    }
    console.log(`${variant}: Route, reverse Route, Matrix and Reach passed`)
    child.stdin.end()
  }
  console.log('Scoped transfer and headway end-to-end checks passed')
} finally {
  for (const child of children) child.kill()
  fs.rmSync(dir, { recursive: true, force: true })
}
