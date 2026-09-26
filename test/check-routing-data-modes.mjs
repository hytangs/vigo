import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {
  buildNationalGtfsStore,
  disposeNationalGtfsStore,
  routeNationalGtfsDepartureWindow,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'

// Research-mode results are a function of the selected timetable, date, and
// query. Supplying or refreshing live observations must not change them.
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-routing-modes-'))
const storePath = path.join(folder, 'store.sqlite')
const zipPath = path.join(folder, 'exact-date.zip')
const selected = process.argv[2]
const failures = []
let passed = 0
const nowSeconds = Math.floor(Date.now() / 1000)
const ride = plan => plan.legs?.find(leg => leg.type === 'ride')
const provenance = plan => plan.diagnostics?.routingDataProvenance
const update = (tripId = 'late', delaySeconds = 600, changes = {}) => ({ tripId, startDate: '20260821', delaySeconds, ...changes })
const snapshot = (tripUpdates = [update()], changes = {}) => ({
  sourceUrl: 'https://example.test/mode-fixture.pb', feedTimestamp: nowSeconds, tripUpdates, ...changes,
})
const request = (changes = {}) => ({
  origin: { coordinate: [0, 0], source: 'stop', stopId: 'A' },
  destination: { coordinate: [.3, 0], source: 'stop', stopId: 'D' },
  serviceDate: '2026-08-21', serviceDay: 'weekday', timePreference: 'depart', departMinutes: 630,
  maxWalkKm: .2, __disableDirectWalkDominance: true, ...changes,
})

function semanticResult(plan) {
  return {
    status: plan.status, travelMode: plan.travelMode, timePreference: plan.timePreference,
    departMinutes: plan.departMinutes, arriveMinutes: plan.arriveMinutes,
    durationMinutes: plan.durationMinutes, scheduleMode: plan.scheduleMode,
    legs: (plan.legs ?? []).map(leg => ({
      type: leg.type, tripId: leg.tripId, fromStopId: leg.fromStopId, toStopId: leg.toStopId,
      startMinutes: leg.startMinutes, endMinutes: leg.endMinutes, scheduleMode: leg.scheduleMode,
    })),
    routingDataMode: plan.diagnostics?.routingDataMode,
    routingDataProvenance: provenance(plan),
  }
}

function assertProvenance(plan, mode, applied, serviceDate = '2026-08-21') {
  assert.equal(plan.diagnostics.routingDataMode, mode)
  const source = provenance(plan)
  assert(source, 'Every result must identify the timetable and routing data mode.')
  assert.equal(source.schemaVersion, 'vigo.routing.data-provenance.v1')
  assert.equal(source.mode, mode)
  assert.equal(typeof source.staticTimetableIdentity, 'string')
  assert(source.staticTimetableIdentity.length > 0)
  assert(Object.hasOwn(source, 'streetIdentity'))
  assert(source.streetIdentity === null || typeof source.streetIdentity === 'string')
  assert.equal(source.serviceDate, serviceDate)
  assert.equal(source.timeZone, 'UTC')
  assert.equal(source.realtimeApplied, applied)
  if (mode === 'scheduled') {
    assert.equal(source.snapshotId, undefined)
    assert.equal(source.feedTimestamp, undefined)
  }
}

async function check(name, run) {
  if (selected && !name.includes(selected)) return
  try {
    await run()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}: ${error.stack}`)
  }
}

// Import genuine exact-date GTFS. The persisted-schedule builder intentionally
// creates weekday templates, which would not test calendar-bound research.
const archive = new JSZip()
archive.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture,https://example.test,UTC\n')
archive.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Origin,0,0\nD,Destination,0,0.3\n')
archive.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,fixture,R,3\n')
archive.file('trips.txt', 'route_id,service_id,trip_id\nR,only-day,early\nR,only-day,late\n')
archive.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nonly-day,1,1,1,1,1,0,0,20260821,20260821\n')
archive.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nearly,10:00:00,10:00:00,A,1\nearly,10:20:00,10:20:00,D,2\nlate,10:30:00,10:30:00,A,1\nlate,10:40:00,10:40:00,D,2\n')
await fs.writeFile(zipPath, await archive.generateAsync({ type: 'nodebuffer' }))
await buildNationalGtfsStore({ zipPath, outputPath: storePath })

try {
  await check('scheduled mode never reads a supplied realtime snapshot', () => {
    for (const timePreference of ['depart', 'arrive']) {
      const protectedRequest = request({ routingDataMode: 'scheduled', timePreference, arriveMinutes: 650 })
      Object.defineProperty(protectedRequest, 'realtimeSnapshot', {
        enumerable: true, get() { throw new Error('Scheduled routing read the realtime snapshot getter.') },
      })
      const result = routeNationalGtfsStore(storePath, protectedRequest)
      assert.equal(result.status, 'ready')
      assert.equal(ride(result).tripId, 'late')
      assert.equal(ride(result).startMinutes, 630)
      assert.equal(ride(result).endMinutes, 640)
      assertProvenance(result, 'scheduled', false)
      const poisonedSnapshot = {
        get tripUpdates() { throw new Error('Scheduled routing read live trip updates.') },
        get feedTimestamp() { throw new Error('Scheduled routing read a feed timestamp.') },
      }
      const nested = routeNationalGtfsStore(storePath, request({
        routingDataMode: 'scheduled', timePreference, arriveMinutes: 650, realtimeSnapshot: poisonedSnapshot,
      }))
      assert.deepEqual(semanticResult(nested), semanticResult(result))
    }
  })

  await check('explicit research mode requires a date and query time and rejects invalid modes', () => {
    for (const routingDataMode of ['live', 'schedule', '', 'invalid', 1, null]) {
      assert.throws(() => routeNationalGtfsStore(storePath, request({ routingDataMode })), /routingDataMode|routing data mode/i)
    }
    for (const serviceDate of [undefined, '', 'not-a-date', '2026-13-40']) {
      assert.throws(() => routeNationalGtfsStore(storePath, request({ routingDataMode: 'scheduled', serviceDate })), /serviceDate|service date/i)
    }
    for (const timePreference of ['depart', 'arrive']) {
      const missing = request({ routingDataMode: 'scheduled', timePreference, departMinutes: undefined, arriveMinutes: undefined })
      assert.throws(() => routeNationalGtfsStore(storePath, missing), /departMinutes|arriveMinutes|explicit.*time|query time/i)
    }
    assert.throws(() => routeNationalGtfsDepartureWindow(storePath, request({
      routingDataMode: 'scheduled', departMinutes: undefined, departureWindowMinutes: 10,
    })), /departMinutes|explicit.*time|query time/i)
  })

  await check('scheduled mode refuses service date substitution even when requested', () => {
    for (const timePreference of ['depart', 'arrive']) {
      const result = routeNationalGtfsStore(storePath, request({
        routingDataMode: 'scheduled', timePreference, arriveMinutes: 650, serviceDate: '2026-08-24',
        allowServiceDateFallback: true, serviceDateFallbackPolicy: 'representative-snapshot',
        realtimeSnapshot: snapshot(),
      }))
      assert.equal(result.status, 'blocked', JSON.stringify({ timePreference, diagnostics: {
        requestedServiceDate: result.diagnostics.requestedServiceDate,
        resolvedServiceDate: result.diagnostics.resolvedServiceDate,
        serviceDateFallbackApplied: result.diagnostics.serviceDateFallbackApplied,
        routingDataProvenance: provenance(result),
      } }))
      assert.equal(ride(result), undefined)
      assert.notEqual(result.diagnostics.serviceDateFallbackApplied, true)
      assertProvenance(result, 'scheduled', false, '2026-08-24')
    }
  })

  await check('scheduled route and provenance remain stable across snapshot timestamps and live updates', () => {
    const baselines = new Map(['depart', 'arrive'].map(timePreference => [timePreference,
      semanticResult(routeNationalGtfsStore(storePath, request({ routingDataMode: 'scheduled', timePreference, arriveMinutes: 650 }))),
    ]))
    {
      for (const wallClockMs of [0, nowSeconds * 1000, (nowSeconds + 365 * 24 * 3600) * 1000]) {
        for (const tripUpdates of [[update()], [update('late', 0, { scheduleRelationship: 'CANCELED' })], []]) {
          for (const timePreference of ['depart', 'arrive']) {
            const result = routeNationalGtfsStore(storePath, request({
              routingDataMode: 'scheduled', timePreference, arriveMinutes: 650,
              realtimeSnapshot: snapshot(tripUpdates, { feedTimestamp: wallClockMs / 1000 }),
            }))
            assert.deepEqual(semanticResult(result), baselines.get(timePreference))
          }
        }
      }
    }
  })

  await check('scheduled realtime scheduled round trips never leak predictions', () => {
    const scheduled = routeNationalGtfsStore(storePath, request({ routingDataMode: 'scheduled' }))
    assertProvenance(scheduled, 'scheduled', false)
    for (const timePreference of ['depart', 'arrive']) {
      const live = routeNationalGtfsStore(storePath, request({
        routingDataMode: 'realtime', timePreference, arriveMinutes: 650, realtimeSnapshot: snapshot(),
      }))
      assert.equal(live.status, 'ready')
      assert.equal(ride(live).startMinutes, 640)
      assert.equal(ride(live).endMinutes, 650)
      assert.match(live.detail, /live predictions/)
      assert.doesNotMatch(live.detail, /exact local timetable/)
      assertProvenance(live, 'realtime', true)
      assert.equal(typeof provenance(live).snapshotId, 'string')
      assert(provenance(live).snapshotId.length > 0)
      assert.equal(provenance(live).feedTimestamp, nowSeconds)
      assert.equal(provenance(live).staticTimetableIdentity, provenance(scheduled).staticTimetableIdentity)
    }
    const again = routeNationalGtfsStore(storePath, request({ routingDataMode: 'scheduled', realtimeSnapshot: snapshot() }))
    assert.deepEqual(semanticResult(again), semanticResult(scheduled))
  })

  await check('legacy omitted modes preserve snapshot inference and scheduled compatibility', () => {
    const scheduled = routeNationalGtfsStore(storePath, request())
    assert.equal(ride(scheduled).endMinutes, 640)
    assertProvenance(scheduled, 'scheduled', false)
    const live = routeNationalGtfsStore(storePath, request({ realtimeSnapshot: snapshot() }))
    assert.equal(ride(live).endMinutes, 650)
    assertProvenance(live, 'realtime', true)
  })

  await check('realtime without a feed explicitly discloses scheduled fallback', () => {
    for (const timePreference of ['depart', 'arrive']) {
      const result = routeNationalGtfsStore(storePath, request({ routingDataMode: 'realtime', timePreference, arriveMinutes: 650 }))
      assert.equal(result.status, 'ready')
      assert.equal(ride(result).startMinutes, 630)
      assert.equal(ride(result).endMinutes, 640)
      assert.equal(result.scheduleMode, 'exact')
      assertProvenance(result, 'realtime', false)
      assert.equal(result.diagnostics.realtimeRouting.status, 'scheduled_fallback')
      assert.equal(result.diagnostics.realtimeRouting.fallbackReason, 'realtime_snapshot_unavailable')
      assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
    }
  })

  await check('realtime provenance identifies changed snapshots without changing static identity', () => {
    const first = routeNationalGtfsStore(storePath, request({ routingDataMode: 'realtime', realtimeSnapshot: snapshot() }))
    const repeat = routeNationalGtfsStore(storePath, request({ routingDataMode: 'realtime', realtimeSnapshot: snapshot() }))
    assert.deepEqual(provenance(first), provenance(repeat))
    const next = routeNationalGtfsStore(storePath, request({ routingDataMode: 'realtime', realtimeSnapshot: snapshot([update('late', 120)]) }))
    assert.equal(ride(next).endMinutes, 642)
    assert.notEqual(provenance(next).snapshotId, provenance(first).snapshotId)
    assert.equal(provenance(next).staticTimetableIdentity, provenance(first).staticTimetableIdentity)
  })

  await check('departure windows preserve scheduled isolation and realtime predictions', () => {
    const protectedRequest = request({ routingDataMode: 'scheduled', departureWindowMinutes: 10 })
    Object.defineProperty(protectedRequest, 'realtimeSnapshot', {
      enumerable: true, get() { throw new Error('Scheduled window read the realtime snapshot.') },
    })
    const scheduled = routeNationalGtfsDepartureWindow(storePath, protectedRequest)
    assert.equal(scheduled.profile.plans.length, 21)
    for (const plan of scheduled.profile.plans) {
      assertProvenance(plan, 'scheduled', false)
      if (plan.departMinutes <= 630) {
        assert.equal(plan.status, 'ready')
        assert.equal(ride(plan).endMinutes, 640)
      } else assert.equal(plan.status, 'blocked')
    }
    let repeat
    {
      repeat = routeNationalGtfsDepartureWindow(storePath, request({
        routingDataMode: 'scheduled', departureWindowMinutes: 10, realtimeSnapshot: snapshot(),
      }))
    }
    assert.deepEqual(repeat.profile.plans.map(semanticResult), scheduled.profile.plans.map(semanticResult))
    assert.deepEqual(semanticResult(repeat.plan), semanticResult(scheduled.plan))
    const live = routeNationalGtfsDepartureWindow(storePath, request({
      routingDataMode: 'realtime', departureWindowMinutes: 10, realtimeSnapshot: snapshot(),
    }))
    assert.equal(live.profile.plans.length, 21)
    for (const plan of live.profile.plans) {
      assert.equal(plan.status, 'ready')
      assert.equal(ride(plan).endMinutes, 650)
      assertProvenance(plan, 'realtime', true)
      assert.equal(provenance(plan).snapshotId, provenance(live.plan).snapshotId)
    }
  })
} finally {
  disposeNationalGtfsStore(storePath)
  await fs.rm(folder, { recursive: true, force: true })
}

assert.equal(failures.length, 0, `${failures.length} routing data mode regressions failed: ${failures.map(({ name }) => name).join('; ')}`)
assert(passed > 0, `No tests matched ${JSON.stringify(selected)}`)
console.log(`Routing data mode check passed (${passed} independent public-API regressions).`)
