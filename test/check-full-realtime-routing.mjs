import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore, prepareNationalOsmNativeStore } from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import {
  buildNationalGtfsCityStore,
  buildRoutingStoreFromSchedules,
  disposeNationalGtfsStore,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'

// Public-API regressions use independent, hand-calculated routes. Remote
// service is deliberately as valid as the queried service: query endpoints
// must never determine which otherwise applicable predictions are retained.
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-full-realtime-'))
const stores = []
const failures = []
let passed = 0
const selected = process.argv[2]
const namespaced = (id, feedId = 'fixture') => `${feedId}\u001f${id}`
const stop = (id, lon, lat = 0) => ({ id, name: id, lon, lat, locationType: 0 })
const trip = (tripId, calls) => ({
  tripId, serviceId: 'weekday', serviceDays: ['weekday'],
  stopTimes: calls.map(([stopId, arrivalMinutes, departureMinutes = arrivalMinutes], index) => ({
    stopId, sequence: index + 1, arrivalMinutes, departureMinutes,
  })),
})
const update = (tripId, changes = {}) => ({ tripId, startDate: '20260821', delaySeconds: 0, ...changes })
const snapshot = (tripUpdates, changes = {}) => ({
  sourceUrl: 'https://example.test/trip-updates.pb',
  feedTimestamp: Math.floor(Date.now() / 1000),
  tripUpdates, ...changes,
})
const rides = plan => plan.legs?.filter(leg => leg.type === 'ride') ?? []
const rideIds = plan => rides(plan).map(leg => leg.tripId)
const point = (id, lon, feedId = 'fixture', lat = 0) => ({
  coordinate: [lon, lat], source: 'stop', stopId: namespaced(id, feedId), label: id,
})
const request = (origin = point('A', 0), destination = point('D', .3), changes = {}) => ({
  origin, destination, departMinutes: 600, serviceDay: 'weekday', serviceDate: '2026-08-21',
  maxWalkKm: .2, __disableDirectWalkDominance: true, ...changes,
})

async function build(name, stops, trips, feedId = 'fixture') {
  const schedulePath = path.join(folder, `${name}.json`)
  const storePath = path.join(folder, `${name}.sqlite`)
  await fs.writeFile(schedulePath, JSON.stringify({
    stops, routes: [{ id: 'R', shortName: 'R', routeType: 3, scheduledTrips: trips }], transferRules: [],
  }))
  await buildRoutingStoreFromSchedules({ schedules: [{ feedId, schedulePath }], outputPath: storePath })
  stores.push(storePath)
  return storePath
}

function connected(plan) {
  assert.equal(plan.status, 'ready', plan.detail)
  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i]
    assert(leg.endMinutes >= leg.startMinutes, 'No leg may run backward in time.')
    if (i) assert(leg.startMinutes >= plan.legs[i - 1].endMinutes - 1e-6, 'Legs cannot overlap in time.')
  }
  const transit = rides(plan)
  for (let i = 1; i < transit.length; i++) {
    assert.equal(transit[i].fromStopId, transit[i - 1].toStopId, 'These fixtures transfer at the same physical stop.')
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

const connectionStops = [stop('A', 0), stop('B', .1), stop('C', .2), stop('D', .3), stop('X', 10), stop('Y', 10.1)]
const connectionTrips = [
  trip('incoming', [['A', 600], ['B', 608]]),
  trip('Z-bridge', [['B', 610], ['C', 620]]),
  trip('backup-bridge', [['B', 645], ['C', 655]]),
  trip('outgoing', [['C', 625], ['D', 640]]),
  trip('later-outgoing', [['C', 660], ['D', 675]]),
]

try {
  await check('more than 256 trips includes delayed interior connection', async () => {
    const decoys = Array.from({ length: 260 }, (_, i) => trip(`A-${String(i).padStart(4, '0')}`, [['A', 600], ['X', 605]]))
    const store = await build('trip-coverage', connectionStops, [...connectionTrips, ...decoys])
    const updates = [...decoys.map(({ tripId }) => update(tripId)), update('Z-bridge', { delaySeconds: 1200 })]
    const scheduled = routeNationalGtfsStore(store, request())
    assert.equal(scheduled.arriveMinutes, 640)
    const live = routeNationalGtfsStore(store, request(undefined, undefined, { realtimeSnapshot: snapshot(updates) }))
    connected(live)
    assert.equal(live.arriveMinutes, 675, 'The delayed interior bridge misses the 625 departure.')
    assert.deepEqual(rideIds(live), ['incoming', 'Z-bridge', 'later-outgoing'].map(id => namespaced(id)))
    assert.equal(rides(live)[1].startMinutes, 630)
    assert.equal(rides(live)[1].endMinutes, 640)
    assert.equal(rides(live)[1].scheduleMode, 'realtime-adjusted')
    assert.equal(live.diagnostics.realtimeRouting.appliedTrips, updates.length)
    assert.equal(live.diagnostics.realtimeRouting.prunedTrips, 0)
  })

  await check('more than 1024 records includes late-sorted delays and cancellations', async () => {
    const decoys = Array.from({ length: 1100 }, (_, i) => trip(`A-${String(i).padStart(4, '0')}`, [['X', 600], ['Y', 605]]))
    const store = await build('record-coverage', connectionStops, [...connectionTrips, ...decoys])
    const updates = decoys.map(({ tripId }) => update(tripId))
    const delayed = routeNationalGtfsStore(store, request(undefined, undefined, {
      realtimeSnapshot: snapshot([...updates, update('Z-bridge', { delaySeconds: 1200 })]),
    }))
    connected(delayed)
    assert.equal(delayed.arriveMinutes, 675)
    assert.equal(rides(delayed)[1].startMinutes, 630)
    assert.equal(delayed.diagnostics.realtimeRouting.appliedTrips, 1101)
    const canceled = routeNationalGtfsStore(store, request(undefined, undefined, {
      realtimeSnapshot: snapshot([...updates, update('Z-bridge', { scheduleRelationship: 'CANCELED' })]),
    }))
    connected(canceled)
    assert.deepEqual(rideIds(canceled), ['incoming', 'backup-bridge', 'later-outgoing'].map(id => namespaced(id)))
    assert.equal(canceled.arriveMinutes, 675)
    assert.equal(canceled.diagnostics.realtimeRouting.canceledTrips, 1)
  })

  await check('more than 4096 updated stops preserves all applicable trips', async () => {
    const remoteStops = Array.from({ length: 4100 }, (_, i) => stop(`S-${i}`, 10 + (i % 100) * .1, 10 + Math.floor(i / 100) * .1))
    const decoys = Array.from({ length: 2050 }, (_, i) => trip(`A-${String(i).padStart(4, '0')}`, [[`S-${i * 2}`, 600], [`S-${i * 2 + 1}`, 605]]))
    const store = await build('stop-coverage', [...connectionStops, ...remoteStops], [...connectionTrips, ...decoys])
    const updates = [...decoys.map(({ tripId }) => update(tripId)), update('Z-bridge', { delaySeconds: 1200 })]
    const live = routeNationalGtfsStore(store, request(undefined, undefined, { realtimeSnapshot: snapshot(updates) }))
    connected(live)
    assert.equal(live.arriveMinutes, 675)
    assert.equal(rides(live)[1].startMinutes, 630)
    assert.equal(live.diagnostics.realtimeRouting.appliedTrips, updates.length)
    assert.equal(live.diagnostics.realtimeRouting.prunedTrips, 0)
  })

  const deadlineStops = [stop('A', 0), stop('B', .1), stop('D', .3)]
  const deadlineTrips = [
    trip('early', [['A', 600], ['B', 610], ['D', 620]]),
    trip('late', [['A', 630], ['B', 635], ['D', 640]]),
  ]
  let deadlineStore
  const getDeadlineStore = async () => deadlineStore ??= await build('deadline', deadlineStops, deadlineTrips)
  const deadlineRequest = changes => request(undefined, undefined, { timePreference: 'arrive', arriveMinutes: 640, ...changes })

  await check('arrive-by chooses earlier service when a live delay misses deadline', async () => {
    const store = await getDeadlineStore()
    const live = routeNationalGtfsStore(store, deadlineRequest({
      realtimeSnapshot: snapshot([update('late', { delaySeconds: 600 })]),
    }))
    connected(live)
    assert.equal(live.timePreference, 'arrive')
    assert.equal(live.departMinutes, 600, 'The 630 scheduled trip actually arrives at 650 and cannot meet 640.')
    assert.deepEqual(rideIds(live), [namespaced('early')], 'Never retain the scheduled duplicate of an updated trip.')
    assert(rides(live).at(-1).endMinutes <= 640)
    assert.equal(live.diagnostics.realtimeRouting.replacedTrips, 1)
  })

  await check('arrive-by uses predicted departures and arrivals of a feasible trip', async () => {
    const store = await getDeadlineStore()
    const live = routeNationalGtfsStore(store, deadlineRequest({
      arriveMinutes: 650, realtimeSnapshot: snapshot([update('late', { delaySeconds: 600 })]),
    }))
    connected(live)
    assert.equal(live.departMinutes, 640)
    assert.deepEqual(rideIds(live), [namespaced('late')])
    assert.equal(rides(live)[0].startMinutes, 640)
    assert.equal(rides(live)[0].endMinutes, 650)
    assert.equal(rides(live)[0].scheduleMode, 'realtime-adjusted')
  })

  await check('arrive-by respects cancellations and skipped boarding or alighting', async () => {
    const store = await getDeadlineStore()
    for (const changes of [
      { scheduleRelationship: 'CANCELED' },
      { scheduleRelationship: 'DELETED' },
      { stopTimeUpdates: [{ stopId: 'A', stopSequence: 1, scheduleRelationship: 'SKIPPED' }] },
      { stopTimeUpdates: [{ stopId: 'D', stopSequence: 3, scheduleRelationship: 'SKIPPED' }] },
    ]) {
      const live = routeNationalGtfsStore(store, deadlineRequest({ realtimeSnapshot: snapshot([update('late', changes)]) }))
      connected(live)
      assert.equal(live.departMinutes, 600, JSON.stringify(changes))
      assert.deepEqual(rideIds(live), [namespaced('early')], JSON.stringify(changes))
    }
  })

  await check('arrive-by follows predicted times across an interior transfer', async () => {
    const store = await build('arrival-transfer', connectionStops, [
      trip('incoming', [['A', 600], ['B', 608]]),
      trip('later-incoming', [['A', 620], ['B', 628]]),
      trip('bridge', [['B', 610], ['C', 620]]),
      trip('outgoing', [['C', 625], ['D', 640]]),
      trip('later-outgoing', [['C', 645], ['D', 655]]),
    ])
    const live = routeNationalGtfsStore(store, deadlineRequest({
      arriveMinutes: 655, realtimeSnapshot: snapshot([update('bridge', { delaySeconds: 1200 })]),
    }))
    connected(live)
    assert.equal(live.departMinutes, 620)
    assert.deepEqual(rideIds(live), ['later-incoming', 'bridge', 'later-outgoing'].map(id => namespaced(id)))
    assert.equal(rides(live)[1].startMinutes, 630)
    assert.equal(rides(live)[1].endMinutes, 640)
    assert.equal(rides(live).at(-1).endMinutes, 655)
  })

  await check('all canceled service blocks both query directions without scheduled resurrection', async () => {
    const store = await getDeadlineStore()
    const realtimeSnapshot = snapshot(['early', 'late'].map(id => update(id, { scheduleRelationship: 'CANCELED' })))
    for (const timePreference of ['depart', 'arrive']) {
      const result = routeNationalGtfsStore(store, request(undefined, undefined, {
        timePreference, arriveMinutes: 640, realtimeSnapshot,
      }))
      assert.equal(result.status, 'blocked', timePreference)
      assert.deepEqual(rideIds(result), [])
      assert.equal(result.diagnostics.realtimeRouting.canceledTrips, 2)
      assert.notEqual(result.diagnostics.realtimeRouting.status, 'scheduled_fallback')
    }
  })

  await check('snapshot changes replace predictions without leaking into scheduled queries', async () => {
    const store = await getDeadlineStore()
    // Identical feed timestamps intentionally ensure cache identity includes the
    // actual snapshot content, not just its fetch time or source URL.
    const feedTimestamp = Math.floor(Date.now() / 1000)
    for (const [delaySeconds, expected] of [[600, 650], [120, 642], [0, 640], [600, 650]]) {
      const live = routeNationalGtfsStore(store, request(undefined, undefined, {
        departMinutes: 630, realtimeSnapshot: snapshot([update('late', { delaySeconds })], { feedTimestamp }),
      }))
      connected(live)
      assert.equal(live.arriveMinutes, expected)
      assert.deepEqual(rideIds(live), [namespaced('late')])
    }
    const scheduled = routeNationalGtfsStore(store, request(undefined, undefined, { departMinutes: 630 }))
    assert.equal(scheduled.arriveMinutes, 640)
    assert.equal(scheduled.scheduleMode, 'exact')
  })

  await check('stale snapshots fall back honestly for departure and arrival queries', async () => {
    const store = await getDeadlineStore()
    for (const timePreference of ['depart', 'arrive']) {
      const result = routeNationalGtfsStore(store, request(undefined, undefined, {
        timePreference, departMinutes: 630, arriveMinutes: 640,
        realtimeSnapshot: snapshot([update('late', { delaySeconds: 600 })], { feedTimestamp: Math.floor(Date.now() / 1000) - 181 }),
      }))
      connected(result)
      assert.equal(result.departMinutes, 630)
      assert.equal(rides(result)[0].endMinutes, 640)
      assert.equal(result.scheduleMode, 'exact')
      assert.equal(result.diagnostics.realtimeRouting.status, 'stale_fallback')
      assert.equal(result.diagnostics.realtimeRouting.appliedTrips, 0)
      assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
    }
  })

  await check('unknown invalid and future feed timestamps disclose scheduled fallback', async () => {
    const store = await getDeadlineStore()
    for (const feedTimestamp of [undefined, 'not-a-timestamp', -1, Math.floor(Date.now() / 1000) + 3600]) {
      for (const timePreference of ['depart', 'arrive']) {
        const result = routeNationalGtfsStore(store, request(undefined, undefined, {
          timePreference, departMinutes: 630, arriveMinutes: 640,
          realtimeSnapshot: snapshot([update('late', { delaySeconds: 600 })], { feedTimestamp }),
        }))
        connected(result)
        assert.equal(rides(result)[0].endMinutes, 640, `Unusable timestamp ${feedTimestamp}`)
        assert.equal(result.scheduleMode, 'exact')
        assert.equal(result.diagnostics.realtimeRouting.status, 'stale_fallback')
        assert.equal(result.diagnostics.realtimeRouting.appliedTrips, 0)
        assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
      }
    }
  })

  await check('duplicate canonical trip updates are rejected and disclosed', async () => {
    const store = await getDeadlineStore()
    // Different representations of the same trip must also count as duplicate
    // identities; choosing one of these contradictory predictions is unsafe.
    const duplicates = [update('late', { delaySeconds: 120 }), update(namespaced('late'), { delaySeconds: 600 })]
    for (const otherUpdates of [[], [update('early', { delaySeconds: 120 })]]) {
      const result = routeNationalGtfsStore(store, request(undefined, undefined, {
        departMinutes: 630, realtimeSnapshot: snapshot([...duplicates, ...otherUpdates]),
      }))
      connected(result)
      assert.equal(result.arriveMinutes, 640)
      assert.deepEqual(rideIds(result), [namespaced('late')])
      assert.equal(result.diagnostics.realtimeRouting.appliedTrips, otherUpdates.length)
      assert.equal(result.diagnostics.realtimeRouting.duplicateTrips, 2)
      assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
      assert.equal(result.diagnostics.realtimeRouting.status, otherUpdates.length ? 'partial' : 'no_matches')
    }
  })

  await check('fully rejected input retains coverage diagnostics with no eligible updates', async () => {
    const store = await getDeadlineStore()
    for (const timePreference of ['depart', 'arrive']) {
      const result = routeNationalGtfsStore(store, request(undefined, undefined, {
        timePreference, departMinutes: 630, arriveMinutes: 640,
        realtimeSnapshot: snapshot([], {
          inputCoverage: { received: 3, eligible: 0, rejected: 3, rejectionReasons: { unmatched_identity: 3 }, complete: false },
        }),
      }))
      connected(result)
      assert.equal(result.scheduleMode, 'exact')
      assert.equal(rides(result)[0].endMinutes, 640)
      assert.equal(result.diagnostics.realtimeRouting.feedTripUpdates, 0)
      assert.equal(result.diagnostics.realtimeRouting.coverage.inputUpdates, 3)
      assert.equal(result.diagnostics.realtimeRouting.coverage.rejectedUpdates, 3)
      assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
    }
  })

  let preferenceStore
  const getPreferenceStore = async () => preferenceStore ??= await build('preferences', deadlineStops, [
    trip('transfer-in', [['A', 600], ['B', 605]]),
    trip('transfer-out', [['B', 606], ['D', 620]]),
    trip('direct', [['A', 600], ['D', 618]]),
  ])
  const preferenceSnapshot = () => snapshot([update('direct', {
    stopTimeUpdates: [{ stopId: 'D', stopSequence: 2, arrival: { delay: 360 }, departure: { delay: 360 } }],
  })])

  await check('balanced departures and arrivals optimize the complete predicted timetable', async () => {
    const store = await getPreferenceStore()
    for (const timePreference of ['depart', 'arrive']) {
      for (const routingPreference of ['fastest', 'balanced']) {
        const result = routeNationalGtfsStore(store, request(undefined, undefined, {
          timePreference, routingPreference, arriveMinutes: 624, realtimeSnapshot: preferenceSnapshot(),
        }))
        connected(result)
        assert.equal(result.departMinutes, 600)
        // Arrive-by breaks equal latest-departure ties by fewer boardings;
        // depart-at fastest instead minimizes the actual arrival time.
        const chooseDirect = routingPreference === 'balanced' || timePreference === 'arrive'
        assert.deepEqual(rideIds(result), (chooseDirect ? ['direct'] : ['transfer-in', 'transfer-out']).map(id => namespaced(id)))
        assert.equal(rides(result).at(-1).endMinutes, chooseDirect ? 624 : 620)
        if (chooseDirect) assert.equal(rides(result)[0].scheduleMode, 'realtime-adjusted')
        assert.equal(result.diagnostics.realtimeRouting.appliedTrips, 1)
        assert.equal(result.diagnostics.realtimeRouting.coverage.complete, true)
      }
    }
  })

  await check('transfer limits constrain both predicted departures and arrival deadlines', async () => {
    const store = await getPreferenceStore()
    for (const routingPreference of ['fastest', 'balanced']) {
      const direct = routeNationalGtfsStore(store, request(undefined, undefined, {
        routingPreference, maxTransfers: 0, realtimeSnapshot: preferenceSnapshot(),
      }))
      connected(direct)
      assert.deepEqual(rideIds(direct), [namespaced('direct')])
      assert.equal(direct.arriveMinutes, 624)
      for (const maxTransfers of [0, 1]) {
        const arrival = routeNationalGtfsStore(store, deadlineRequest({
          routingPreference, maxTransfers, arriveMinutes: 622, realtimeSnapshot: preferenceSnapshot(),
        }))
        if (maxTransfers === 0) {
          assert.equal(arrival.status, 'blocked', 'The only direct trip now misses the deadline.')
          assert.deepEqual(rideIds(arrival), [])
        } else {
          connected(arrival)
          assert.equal(arrival.departMinutes, 600)
          assert.deepEqual(rideIds(arrival), ['transfer-in', 'transfer-out'].map(id => namespaced(id)))
          assert.equal(rides(arrival).at(-1).endMinutes, 620)
        }
        assert.equal(arrival.diagnostics.realtimeRouting.appliedTrips, 1)
      }
    }
    const fastest = routeNationalGtfsStore(store, request(undefined, undefined, {
      maxTransfers: 1, realtimeSnapshot: preferenceSnapshot(),
    }))
    connected(fastest)
    assert.deepEqual(rideIds(fastest), ['transfer-in', 'transfer-out'].map(id => namespaced(id)))
    assert.equal(fastest.arriveMinutes, 620)
  })

  await check('mixed source and record freshness rejects only stale predictions', async () => {
    const store = await getDeadlineStore()
    const now = Math.floor(Date.now() / 1000)
    for (const staleField of ['sourceFeedTimestamp', 'timestamp']) {
      const realtimeSnapshot = snapshot([
        update('early', { delaySeconds: 120, sourceFeedTimestamp: now, timestamp: now }),
        update('late', { delaySeconds: 600, sourceFeedTimestamp: now, timestamp: now, [staleField]: now - 181 }),
      ], { feedTimestamp: now })
      for (const [timePreference, departMinutes, expectedTrip, expectedArrival] of [
        ['depart', 600, 'early', 622], ['depart', 630, 'late', 640], ['arrive', 600, 'late', 640],
      ]) {
        const result = routeNationalGtfsStore(store, request(undefined, undefined, {
          timePreference, departMinutes, arriveMinutes: 640, realtimeSnapshot,
        }))
        connected(result)
        assert.deepEqual(rideIds(result), [namespaced(expectedTrip)])
        assert.equal(rides(result).at(-1).endMinutes, expectedArrival)
        assert.equal(result.diagnostics.realtimeRouting.appliedTrips, 1)
        assert.equal(result.diagnostics.realtimeRouting.staleTrips, 1)
        assert.equal(result.diagnostics.realtimeRouting.status, 'partial')
        assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
        assert.equal(result.diagnostics.realtimeRouting.coverage.rejectedUpdates, 1)
      }
    }
  })

  await check('arrive-by freezes freshness across reverse forward and preference searches', async () => {
    const store = await getDeadlineStore()
    // Warm storage before replacing the wall clock. The getter deterministically
    // advances wall time only after routing has captured its observation time;
    // no sleeping, elapsed-time assumptions, or performance-clock changes.
    routeNationalGtfsStore(store, request())
    const realNow = Date.now
    const observedMs = Math.floor(realNow() / 1000) * 1000
    let wallClockMs = observedMs
    let timestampReads = 0
    const timedUpdate = update('late', { delaySeconds: 600 })
    Object.defineProperty(timedUpdate, 'sourceFeedTimestamp', {
      enumerable: true,
      get() {
        timestampReads++
        wallClockMs = observedMs + 181_000
        return observedMs / 1000
      },
    })
    const realtimeSnapshot = snapshot([timedUpdate], {
      sourceUrl: 'https://example.test/frozen-clock.pb', feedTimestamp: observedMs / 1000,
    })
    try {
      Date.now = () => wallClockMs
      const live = routeNationalGtfsStore(store, deadlineRequest({
        arriveMinutes: 650, routingPreference: 'balanced', realtimeSnapshot,
      }))
      connected(live)
      assert(timestampReads > 0)
      assert.equal(wallClockMs, observedMs + 181_000)
      assert.equal(live.departMinutes, 640)
      assert.equal(rides(live)[0].endMinutes, 650)
      assert.equal(live.diagnostics.realtimeRouting.status, 'applied')
      assert.equal(live.diagnostics.searchStats.arriveByRequestedPreferenceVerificationPerformed, true)
      const next = routeNationalGtfsStore(store, deadlineRequest({
        arriveMinutes: 650, routingPreference: 'balanced', realtimeSnapshot,
      }))
      connected(next)
      assert.equal(next.departMinutes, 630, 'The next query captures the advanced time and must expire the cached prediction.')
      assert.equal(rides(next)[0].endMinutes, 640)
      assert.equal(next.diagnostics.realtimeRouting.status, 'stale_fallback')
    } finally {
      Date.now = realNow
    }
  })

  let sourceIdentityStore
  const getSourceIdentityStore = async () => sourceIdentityStore ??= await build('source-identity',
    [stop('A', 0), stop('D', .3)], [trip('T', [['A', 600], ['D', 620]])], 'feed-a')
  const sourceRequest = changes => request(point('A', 0, 'feed-a'), point('D', .3, 'feed-a'), changes)

  await check('source scope and namespaced route IDs cannot match another feed', async () => {
    const store = await getSourceIdentityStore()
    for (const [identity, counter] of [
      [{ tripId: 'T', sourceScope: 'feed-b' }, 'unmatchedTrips'],
      [{ tripId: namespaced('T', 'feed-a'), sourceScope: 'feed-b' }, 'unmatchedTrips'],
      [{ tripId: 'T', routeId: namespaced('R', 'feed-b') }, 'invalidTrips'],
    ]) {
      for (const timePreference of ['depart', 'arrive']) {
        const result = routeNationalGtfsStore(store, sourceRequest({
          timePreference, arriveMinutes: 650,
          realtimeSnapshot: snapshot([update('T', { ...identity, delaySeconds: 300 })]),
        }))
        connected(result)
        assert.equal(rides(result)[0].endMinutes, 620, JSON.stringify(identity))
        assert.equal(result.departMinutes, 600)
        assert.equal(result.scheduleMode, 'exact')
        assert.equal(result.diagnostics.realtimeRouting.appliedTrips, 0)
        assert.equal(result.diagnostics.realtimeRouting[counter], 1)
        assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
      }
    }
  })

  await check('stale or other-date duplicates cannot suppress an applicable fresh update', async () => {
    const store = await getSourceIdentityStore()
    const now = Math.floor(Date.now() / 1000)
    for (const [irrelevant, counter] of [
      [{ timestamp: now - 181 }, 'staleTrips'],
      [{ sourceFeedTimestamp: now - 181 }, 'staleTrips'],
      [{ startDate: '20260820' }, 'dateMismatches'],
    ]) {
      for (const timePreference of ['depart', 'arrive']) {
        const result = routeNationalGtfsStore(store, sourceRequest({
          timePreference, arriveMinutes: 650,
          realtimeSnapshot: snapshot([
            update('T', { delaySeconds: 300, sourceScope: 'feed-a', timestamp: now }),
            update(namespaced('T', 'feed-a'), { delaySeconds: 900, ...irrelevant }),
          ], { feedTimestamp: now }),
        }))
        connected(result)
        assert.equal(rides(result)[0].startMinutes, 605)
        assert.equal(rides(result)[0].endMinutes, 625)
        assert.equal(result.scheduleMode, 'realtime-adjusted')
        assert.equal(result.diagnostics.realtimeRouting.appliedTrips, 1)
        assert.equal(result.diagnostics.realtimeRouting[counter], 1)
        assert.equal(result.diagnostics.realtimeRouting.duplicateTrips, 0)
        assert.equal(result.diagnostics.realtimeRouting.status, 'partial')
        assert.equal(result.diagnostics.realtimeRouting.coverage.rejectedUpdates, 1)
        assert.equal(result.diagnostics.realtimeRouting.coverage.complete, false)
      }
    }
  })

  await check('zero or one served call never resurrects the scheduled ride', async () => {
    const store = await build('no-ride-after-skipping', deadlineStops, [trip('T', [['A', 600], ['B', 610], ['D', 620]])])
    const baseline = routeNationalGtfsStore(store, request())
    assert.equal(baseline.arriveMinutes, 620)
    for (const retainedCall of [null, 'A', 'B', 'D']) {
      const stopTimeUpdates = ['A', 'B', 'D'].flatMap((stopId, index) => stopId === retainedCall ? [] : [{
        stopId, stopSequence: index + 1, scheduleRelationship: 'SKIPPED',
      }])
      for (const timePreference of ['depart', 'arrive']) {
        const result = routeNationalGtfsStore(store, request(undefined, undefined, {
          timePreference, arriveMinutes: 650,
          realtimeSnapshot: snapshot([update('T', { stopTimeUpdates })]),
        }))
        assert.equal(result.status, 'blocked', `Retained call ${retainedCall}, ${timePreference}`)
        assert.deepEqual(rideIds(result), [])
        assert.equal(result.diagnostics.realtimeRouting.appliedTrips, 1)
        assert.equal(result.diagnostics.realtimeRouting.replacedTrips, 1)
        assert.equal(result.diagnostics.realtimeRouting.coverage.complete, true)
      }
    }
  })

  await check('namespaced trip identities keep overlapping feed trip IDs separate', async () => {
    const schedules = []
    for (const [feedId, baseLon] of [['feed-a', 0], ['feed-b', 1]]) {
      const schedulePath = path.join(folder, `${feedId}.json`)
      await fs.writeFile(schedulePath, JSON.stringify({
        stops: [stop('A', baseLon), stop('D', baseLon + .3)],
        routes: [{ id: 'R', shortName: 'R', routeType: 3, scheduledTrips: [trip('T', [['A', 600], ['D', 620]])] }], transferRules: [],
      }))
      schedules.push({ feedId, schedulePath })
    }
    const store = path.join(folder, 'feed-identities.sqlite')
    await buildRoutingStoreFromSchedules({ schedules, outputPath: store })
    stores.push(store)
    const realtimeSnapshot = snapshot([update(namespaced('T', 'feed-b'), { delaySeconds: 300 })])
    const a = routeNationalGtfsStore(store, request(point('A', 0, 'feed-a'), point('D', .3, 'feed-a'), { realtimeSnapshot }))
    const b = routeNationalGtfsStore(store, request(point('A', 1, 'feed-b'), point('D', 1.3, 'feed-b'), { realtimeSnapshot }))
    assert.equal(a.arriveMinutes, 620)
    assert.equal(b.arriveMinutes, 625)
    assert.deepEqual(rideIds(a), [namespaced('T', 'feed-a')])
    assert.deepEqual(rideIds(b), [namespaced('T', 'feed-b')])
  })

  await check('applied cancellations never retry another service date in either direction', async () => {
    const feeds = []
    for (const scope of ['one', 'two']) {
      const zip = new JSZip()
      zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nf,F,https://example.test,UTC\n')
      zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,A,0,0\nD,D,0,0.3\nB,B,0,10\nC,C,0,10.3\n')
      zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,f,R,3\n')
      zip.file('trips.txt', 'route_id,service_id,trip_id\nR,day,main\nR,day,background\n')
      zip.file('calendar_dates.txt', `service_id,date,exception_type\nday,20260814,1\n${scope === 'one' ? 'day,20260821,1\n' : ''}`)
      zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nmain,10:00:00,10:00:00,A,1\nmain,10:20:00,10:20:00,D,2\nbackground,10:00:00,10:00:00,B,1\nbackground,10:20:00,10:20:00,C,2\n')
      const zipPath = path.join(folder, `fallback-${scope}.zip`)
      await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
      feeds.push({ scope, path: zipPath })
    }
    const store = path.join(folder, 'cancellation-fallback.sqlite')
    await buildNationalGtfsCityStore({ feeds, outputPath: store })
    stores.push(store)
    for (const timePreference of ['depart', 'arrive']) {
      const result = routeNationalGtfsStore(store, request(point('A', 0, 'one'), point('D', .3, 'one'), {
        timePreference, arriveMinutes: 620, routingDataMode: 'realtime', allowServiceDateFallback: true,
        realtimeSnapshot: snapshot([update('main', { sourceScope: 'one', scheduleRelationship: 'CANCELED' })]),
      }))
      assert.equal(result.status, 'blocked')
      assert.deepEqual(rideIds(result), [])
      assert.equal(result.diagnostics.resolvedServiceDate, '2026-08-21')
      assert.equal(result.diagnostics.serviceDateFallbackApplied, false)
      assert.equal(result.diagnostics.realtimeRouting.canceledTrips, 1)
      assert.equal(result.diagnostics.routingDataProvenance.realtimeApplied, true)
    }
  })

  await check('walk fallback preserves the realtime cancellation or delay that determined the result', async () => {
    const { osmPath } = await writeCliFixtureInputs(folder)
    const streetStorePath = path.join(folder, 'walk-fallback-streets.sqlite')
    await buildNationalOsmStore({ pbfPath: osmPath, outputPath: streetStorePath })
    compactNationalOsmRuntimeStore(streetStorePath)
    prepareNationalOsmNativeStore(streetStorePath)
    buildNativeStreetCchIndex(streetStorePath)
    try {
      const store = await build('walk-fallback', [stop('A', -77.05, 38.9), stop('D', -77.03, 38.91)],
        [trip('T', [['A', 600], ['D', 605]])])
      const origin = { coordinate: [-77.05, 38.9], source: 'map' }
      const destination = { coordinate: [-77.03, 38.91], source: 'map' }
      for (const timePreference of ['depart', 'arrive']) {
        const query = request(origin, destination, {
          streetStorePath, timePreference, arriveMinutes: 605, requireTransitRide: false,
          __disableDirectWalkDominance: false, routingDataMode: 'realtime',
        })
        const baseline = routeNationalGtfsStore(store, { ...query, routingDataMode: 'scheduled' })
        assert.equal(baseline.travelMode, 'transit')
        for (const changes of [{ scheduleRelationship: 'CANCELED' }, { delaySeconds: 1800 }]) {
          const result = routeNationalGtfsStore(store, { ...query, realtimeSnapshot: snapshot([update('T', changes)]) })
          assert.equal(result.status, 'ready')
          assert.equal(result.travelMode, 'walk')
          assert.equal(result.diagnostics.realtimeRouting.coverage.appliedUpdates, 1)
          assert.equal(result.diagnostics.routingDataProvenance.realtimeApplied, true)
          assert.equal(result.diagnostics.routingDataProvenance.snapshotId, result.diagnostics.realtimeRouting.snapshotId)
          assert.equal(result.diagnostics.routingDataProvenance.feedTimestamp, result.diagnostics.realtimeRouting.feedTimestamp)
        }
      }
    } finally { disposeNationalOsmStore(streetStorePath) }
  })
} finally {
  for (const store of stores) disposeNationalGtfsStore(store)
  await fs.rm(folder, { recursive: true, force: true })
}

assert.equal(failures.length, 0, `${failures.length} full realtime regressions failed: ${failures.map(({ name }) => name).join('; ')}`)
assert(passed > 0, `No tests matched ${JSON.stringify(selected)}`)
console.log(`Full realtime routing check passed (${passed} independent public-API regressions).`)
