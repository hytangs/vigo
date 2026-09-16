import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildRoutingStoreFromSchedules,
  disposeNationalGtfsStore,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-gtfs-rt-routing-'))
const schedulePath = path.join(folder, 'schedule.json')
const storePath = path.join(folder, 'store.sqlite')

await fs.writeFile(schedulePath, JSON.stringify({
  stops: [
    { id: 'A', name: 'Realtime origin', lat: 0, lon: 0, locationType: 0 },
    { id: 'B', name: 'Realtime middle', lat: 0, lon: 0.01, locationType: 0 },
    { id: 'C', name: 'Realtime destination', lat: 0, lon: 0.02, locationType: 0 },
  ],
  routes: [{
    id: 'R',
    shortName: 'R',
    routeType: 3,
    scheduledTrips: [
      {
        tripId: 'T1',
        serviceId: 'weekday',
        serviceDays: ['weekday'],
        stopTimes: [
          { stopId: 'A', arrivalMinutes: 600, departureMinutes: 600, sequence: 1 },
          { stopId: 'B', arrivalMinutes: 610, departureMinutes: 610, sequence: 2 },
          { stopId: 'C', arrivalMinutes: 620, departureMinutes: 620, sequence: 3 },
        ],
      },
      {
        tripId: 'T2',
        serviceId: 'weekday',
        serviceDays: ['weekday'],
        stopTimes: [
          { stopId: 'A', arrivalMinutes: 630, departureMinutes: 630, sequence: 1 },
          { stopId: 'B', arrivalMinutes: 635, departureMinutes: 635, sequence: 2 },
          { stopId: 'C', arrivalMinutes: 640, departureMinutes: 640, sequence: 3 },
        ],
      },
    ],
  }],
  transferRules: [],
}))

await buildRoutingStoreFromSchedules({
  schedules: [{ feedId: 'fixture', schedulePath }],
  outputPath: storePath,
})

const request = {
  origin: { coordinate: [0, 0], label: 'Origin', source: 'map' },
  destination: { coordinate: [0.02, 0], label: 'Destination', source: 'map' },
  departMinutes: 600,
  serviceDay: 'weekday',
  serviceDate: '2026-08-21',
  maxWalkKm: 1.6,
  __disableDirectWalkDominance: true,
}

const firstRide = (plan) => plan.legs.find((leg) => leg.type === 'ride')
const realtime = (tripUpdates) => ({
  sourceUrl: 'https://cdn.mbta.com/realtime/TripUpdates.pb',
  feedTimestamp: Math.floor(Date.now() / 1000),
  tripUpdates,
})

const scheduled = routeNationalGtfsStore(storePath, request)
assert.equal(scheduled.status, 'ready')
assert.equal(scheduled.scheduleMode, 'exact')
assert.equal(firstRide(scheduled).tripId, 'fixture\u001fT1')
assert.equal(scheduled.arriveMinutes, 620)

// An expired update has no compiled run. The later ride must still resolve
// against its original input trip, not the compacted run's array position.
const afterExpiredUpdate = routeNationalGtfsStore(storePath, {
  ...request, departMinutes: 630, maxWalkKm: .1,
  realtimeSnapshot: realtime(['T1', 'T2'].map(tripId => ({
    tripId, startDate: '20260821', delaySeconds: 0,
  }))),
})
assert.equal(afterExpiredUpdate.arriveMinutes, 640)
assert.equal(firstRide(afterExpiredUpdate).tripId, 'fixture\u001fT2', 'Expired overlay trips must not shift journey identities')
assert.equal(firstRide(afterExpiredUpdate).startMinutes, 630)
assert.equal(firstRide(afterExpiredUpdate).endMinutes, 640)

const delayed = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    delaySeconds: 300,
    stopTimeUpdates: [],
  }]),
})
assert.equal(delayed.status, 'ready')
assert.equal(delayed.scheduleMode, 'realtime-adjusted')
assert.equal(delayed.arriveMinutes, 625)
assert.equal(firstRide(delayed).scheduleMode, 'realtime-adjusted')
assert.equal(delayed.diagnostics.algorithm, 'rust_resident_query_overlay_connection_scan_one_to_many')
assert.equal(delayed.diagnostics.realtimeRouting.appliedTrips, 1)
assert.equal(delayed.diagnostics.realtimeRouting.replacedTrips, 1)

for (const delay of [120, -60]) {
  const propagated = routeNationalGtfsStore(storePath, { ...request,
    realtimeSnapshot: realtime([{ tripId: 'T1', startDate: '20260821',
      stopTimeUpdates: [{ stopSequence: 2, arrival: { delay }, departure: { delay } }],
    }]),
  })
  assert.equal(propagated.arriveMinutes, 620 + delay / 60, 'A stop-level prediction applies to following unreported calls.')
  assert.equal(propagated.diagnostics.realtimeRouting.appliedTrips, 1)
}
const noData = routeNationalGtfsStore(storePath, { ...request,
  realtimeSnapshot: realtime([{ tripId: 'T1', startDate: '20260821', delaySeconds: 120,
    stopTimeUpdates: [{ stopSequence: 2, scheduleRelationship: 'NO_DATA' }],
  }]),
})
assert.equal(noData.arriveMinutes, 620, 'NO_DATA clears propagated delay; later timing falls back to the timetable.')

const stopTimed = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    stopTimeUpdates: [{
      stopSequence: 3,
      stopId: 'fixture\u001fC',
      scheduleRelationship: 'SCHEDULED',
      arrival: { delay: 120 },
      departure: { delay: 120 },
    }],
  }]),
})
assert.equal(stopTimed.status, 'ready')
assert.equal(stopTimed.scheduleMode, 'realtime-adjusted')
assert.equal(stopTimed.arriveMinutes, 622)
assert.equal(firstRide(stopTimed).endMinutes, 622)

const delayedFromMiddle = routeNationalGtfsStore(storePath, {
  ...request,
  origin: { coordinate: [0.01, 0], label: 'Middle', source: 'map' },
  departMinutes: 605,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    delaySeconds: 300,
    stopTimeUpdates: [],
  }]),
})
assert.equal(delayedFromMiddle.status, 'ready')
assert.equal(firstRide(delayedFromMiddle).fromStopId, 'fixture\u001fB')
assert.equal(firstRide(delayedFromMiddle).startMinutes, 615)
assert.equal(delayedFromMiddle.arriveMinutes, 625)

const skippedMiddle = routeNationalGtfsStore(storePath, {
  ...request,
  origin: { coordinate: [0.01, 0], source: 'stop', stopId: 'fixture\u001fB' },
  departMinutes: 605,
  realtimeSnapshot: realtime([{
    tripId: 'T1', startDate: '20260821', scheduleRelationship: 'SCHEDULED',
    stopTimeUpdates: [{ stopId: 'B', stopSequence: 2, scheduleRelationship: 'SKIPPED' }],
  }]),
})
assert.equal(skippedMiddle.status, 'ready')
assert.equal(firstRide(skippedMiddle).tripId, 'fixture\u001fT2', 'Never restore scheduled boarding at a live skipped stop.')
assert.equal(skippedMiddle.arriveMinutes, 640)
assert.equal(skippedMiddle.diagnostics.realtimeRouting.replacedTrips, 1)

const skippedAlighting = routeNationalGtfsStore(storePath, {
  ...request,
  origin: { ...request.origin, source: 'stop', stopId: 'fixture\u001fA' },
  destination: { coordinate: [0.01, 0], source: 'stop', stopId: 'fixture\u001fB' },
  realtimeSnapshot: realtime([{
    tripId: 'T1', startDate: '20260821', scheduleRelationship: 'SCHEDULED',
    stopTimeUpdates: [{ stopId: 'B', scheduleRelationship: 'SKIPPED' }],
  }]),
})
assert.equal(firstRide(skippedAlighting).tripId, 'fixture\u001fT2', 'A stop-ID-only update must also prevent alighting at a skipped stop.')
assert.equal(skippedAlighting.arriveMinutes, 635)

const canceled = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'T1',
    startDate: '20260821',
    scheduleRelationship: 'CANCELED',
    stopTimeUpdates: [],
  }]),
})
assert.equal(canceled.status, 'ready')
assert.equal(canceled.scheduleMode, 'exact')
assert.equal(firstRide(canceled).tripId, 'fixture\u001fT2')
assert.equal(canceled.arriveMinutes, 640)
assert.equal(canceled.diagnostics.realtimeRouting.canceledTrips, 1)
for (const scheduleRelationship of ['DELETED', 3, 7]) {
  const removed = routeNationalGtfsStore(storePath, { ...request,
    realtimeSnapshot: realtime([{ tripId: 'T1', startDate: '20260821', scheduleRelationship }]),
  })
  assert.equal(removed.status, 'ready')
  assert.equal(firstRide(removed).tripId, 'fixture\u001fT2')
  assert.equal(removed.diagnostics.realtimeRouting.canceledTrips, 1)
}

const unmatched = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: realtime([{
    tripId: 'not-in-static-feed',
    startDate: '20260821',
    scheduleRelationship: 'SCHEDULED',
    delaySeconds: 600,
    stopTimeUpdates: [],
  }]),
})
assert.equal(unmatched.status, 'ready')
assert.equal(unmatched.scheduleMode, 'exact')
assert.equal(firstRide(unmatched).tripId, 'fixture\u001fT1')
assert.equal(unmatched.arriveMinutes, 620)
assert.equal(unmatched.diagnostics.realtimeRouting.status, 'no_matches')
assert.equal(unmatched.diagnostics.realtimeRouting.unmatchedTrips, 1)

const stale = routeNationalGtfsStore(storePath, {
  ...request,
  realtimeSnapshot: {
    ...realtime([{
      tripId: 'T1',
      startDate: '20260821',
      scheduleRelationship: 'SCHEDULED',
      delaySeconds: 600,
      stopTimeUpdates: [],
    }]),
    feedTimestamp: Math.floor(Date.now() / 1000) - 181,
  },
})
assert.equal(stale.status, 'ready')
assert.equal(stale.scheduleMode, 'exact')
assert.equal(firstRide(stale).tripId, 'fixture\u001fT1')
assert.equal(stale.arriveMinutes, 620)
assert.equal(stale.diagnostics.realtimeRouting.status, 'stale_fallback')

// A later stop is much closer to the origin and boards the same vehicle.
// An update to another trip must not change the scheduled route's tie-break.
const downstreamAccess = {
  ...request,
  departMinutes: 580,
  origin: { coordinate: [0.009, 0], label: 'Near the middle stop', source: 'map' },
}
const downstreamScheduled = routeNationalGtfsStore(storePath, downstreamAccess)
assert.equal(firstRide(downstreamScheduled).fromStopId, 'fixture\u001fB')
for (const tripId of ['T1', 'T2']) {
  const live = routeNationalGtfsStore(storePath, {
    ...downstreamAccess,
    realtimeSnapshot: realtime([{ tripId, startDate: '20260821', scheduleRelationship: 'SCHEDULED', delaySeconds: 0, stopTimeUpdates: [] }]),
  })
  assert.equal(firstRide(live).fromStopId, 'fixture\u001fB', `An update to ${tripId} must retain the closer boarding stop.`)
  assert.equal(live.arriveMinutes, downstreamScheduled.arriveMinutes)
  assert.equal(live.walkMinutes, downstreamScheduled.walkMinutes)
  assert.equal(live.diagnostics.searchStats.activeServiceKernel.lexicographicCertified, true)
  assert.equal(live.diagnostics.searchStats.nativeTimetableKernel.scalar.journeyQuality.certified, true)
}

disposeNationalGtfsStore(storePath)

// Exercise the public store adapter as well as the native kernel. The stop's
// identity and minimum transfer time must survive replacing either vehicle.
const interchangeSchedule = {
  stops: ['A', 'B', 'C'].map((id, i) => ({ id, name: id, lon: i * 0.1, lat: 0, locationType: 0 })),
  routes: [{ id: 'R', shortName: 'R', routeType: 3, scheduledTrips: [
    ['feeder', [['A', 600], ['B', 610]]],
    ['tight', [['B', 611], ['C', 620]]],
    ['later', [['B', 620], ['C', 630]]],
  ].map(([tripId, calls]) => ({ tripId, serviceId: 'weekday', serviceDays: ['weekday'],
    stopTimes: calls.map(([stopId, time], i) => ({ stopId, sequence: i + 1, arrivalMinutes: time, departureMinutes: time })),
  })) }],
}
for (const minTransferTimeSeconds of [60, 61, 120, Infinity]) {
  const transferStore = path.join(folder, `transfer-${minTransferTimeSeconds}.sqlite`)
  const transferSchedule = path.join(folder, `transfer-${minTransferTimeSeconds}.json`)
  await fs.writeFile(transferSchedule, JSON.stringify({ ...interchangeSchedule, transferRules: [{
    fromStopId: 'B', toStopId: 'B', transferType: minTransferTimeSeconds === Infinity ? 3 : 2,
    ...(Number.isFinite(minTransferTimeSeconds) ? { minTransferTimeSeconds } : {}),
  }] }))
  await buildRoutingStoreFromSchedules({ schedules: [{ feedId: 'fixture', schedulePath: transferSchedule }], outputPath: transferStore })
  const anchored = { ...request, maxWalkKm: 0.2,
    origin: { coordinate: [0, 0], source: 'stop', stopId: 'fixture\u001fA' },
    destination: { coordinate: [0.2, 0], source: 'stop', stopId: 'fixture\u001fC' },
  }
  for (const updatedTrips of [[], ['feeder'], ['tight'], ['feeder', 'tight']]) {
    const plan = routeNationalGtfsStore(transferStore, { ...anchored,
      realtimeSnapshot: updatedTrips.length ? realtime(updatedTrips.map(tripId => ({ tripId,
        startDate: '20260821', scheduleRelationship: 'SCHEDULED', delaySeconds: 0, stopTimeUpdates: [],
      }))) : undefined,
    })
    const label = `${minTransferTimeSeconds}s transfer; updated: ${updatedTrips}`
    assert.equal(plan.status, minTransferTimeSeconds === Infinity ? 'blocked' : 'ready', label)
    if (plan.status === 'ready') assert.equal(plan.arriveMinutes, minTransferTimeSeconds <= 60 ? 620 : 630, label)
  }
  // Starting at the platform is not an interchange, even when transfers are
  // prohibited there. The realtime vehicle remains available for first boarding.
  const initial = routeNationalGtfsStore(transferStore, { ...anchored,
    origin: { coordinate: [0.1, 0], source: 'stop', stopId: 'fixture\u001fB' }, departMinutes: 610,
    realtimeSnapshot: realtime([{ tripId: 'tight', startDate: '20260821', delaySeconds: 0 }]),
  })
  assert.equal(initial.status, 'ready')
  assert.equal(initial.arriveMinutes, 620)
  disposeNationalGtfsStore(transferStore)
}
// A bus may reach the interchange, yet arrive too late for its published
// platform transfer. Do not round 181 seconds down to three minutes or force
// the nearest alighting stop. With 180 seconds, staying aboard must win the
// walking tie; otherwise the preceding stop can still catch the same train.
for (const minimum of [0, 180, 181, Infinity]) {
  const interchangeStore = path.join(folder, `interchange-${minimum}.sqlite`)
  const interchangePath = path.join(folder, `interchange-${minimum}.json`)
  const positions = { A: 0, X: .01, H: .013, B: .013, D: .03 }
  await fs.writeFile(interchangePath, JSON.stringify({
    stops: Object.entries(positions).map(([id, lon]) => ({ id, name: id, lon, lat: 0, locationType: 0 })),
    routes: [{ id: 'R', shortName: 'R', routeType: 3, scheduledTrips: [
      ['bus', [['A', 480], ['X', 489], ['H', 493]]],
      ['train', [['B', 496], ['D', 510]]],
      ['later', [['B', 500], ['D', 514]]],
    ].map(([tripId, calls]) => ({ tripId, serviceId: 'weekday', serviceDays: ['weekday'],
      stopTimes: calls.map(([stopId, time], i) => ({ stopId, sequence: i + 1, arrivalMinutes: time, departureMinutes: time })),
    })) }],
    transferRules: [
      { fromStopId: 'X', toStopId: 'B', transferType: 2, minTransferTimeSeconds: 297 },
      { fromStopId: 'H', toStopId: 'B', transferType: minimum === Infinity ? 3 : 2,
        ...(Number.isFinite(minimum) ? { minTransferTimeSeconds: minimum } : {}) },
      ...(minimum === 0 ? [{ fromStopId: 'B', toStopId: 'B', transferType: 2, minTransferTimeSeconds: 400 }] : []),
    ],
  }))
  await buildRoutingStoreFromSchedules({ schedules: [{ feedId: 'fixture', schedulePath: interchangePath }], outputPath: interchangeStore })
  for (const updated of [[], ['bus'], ['train'], ['bus', 'train']]) {
    const plan = routeNationalGtfsStore(interchangeStore, { ...request, departMinutes: 480, maxWalkKm: .2,
      origin: { coordinate: [0, 0], source: 'stop', stopId: 'fixture\u001fA' },
      destination: { coordinate: [.03, 0], source: 'stop', stopId: 'fixture\u001fD' },
      ...(updated.length ? { realtimeSnapshot: realtime(updated.map(tripId => ({ tripId, startDate: '20260821', delaySeconds: 0 }))) } : {}),
    })
    assert.equal(plan.status, 'ready', `transfer ${minimum}, realtime ${updated}: ${plan.detail}`)
    assert.equal(plan.arriveMinutes, 510)
    assert.equal(firstRide(plan).toStopId, `fixture\u001f${minimum <= 180 ? 'H' : 'X'}`, `transfer ${minimum}, realtime ${updated}`)
  }
  disposeNationalGtfsStore(interchangeStore)
}

const dwellStore = path.join(folder, 'dwell.sqlite')
const dwellSchedule = path.join(folder, 'dwell.json')
await fs.writeFile(dwellSchedule, JSON.stringify({
  stops: ['A', 'B', 'C', 'D'].map((id, i) => ({ id, name: id, lon: i * 0.1, lat: 0, locationType: 0 })),
  routes: [{ id: 'R', shortName: 'R', routeType: 3, scheduledTrips: [
    ['dwell', [['A', 600, 600], ['B', 610, 615], ['C', 620, 620]]],
    ['connection', [['B', 612, 612], ['D', 618, 618]]],
    ['later', [['B', 630, 630], ['D', 636, 636]]],
  ].map(([tripId, calls]) => ({ tripId, serviceId: 'weekday', serviceDays: ['weekday'],
    stopTimes: calls.map(([stopId, arrivalMinutes, departureMinutes], i) => ({ stopId, sequence: i + 1, arrivalMinutes, departureMinutes })),
  })) }], transferRules: [],
}))
await buildRoutingStoreFromSchedules({ schedules: [{ feedId: 'fixture', schedulePath: dwellSchedule }], outputPath: dwellStore })
const stopPoint = (id, i) => ({ coordinate: [i * 0.1, 0], source: 'stop', stopId: `fixture\u001f${id}` })
const dwellRequest = { ...request, maxWalkKm: 0.2, origin: stopPoint('A', 0), destination: stopPoint('D', 3),
  realtimeSnapshot: realtime([{ tripId: 'dwell', startDate: '20260821', delaySeconds: 0 }]),
}
const transferDuringDwell = routeNationalGtfsStore(dwellStore, dwellRequest)
assert.equal(transferDuringDwell.arriveMinutes, 618)
assert.equal(firstRide(transferDuringDwell).endMinutes, 610)
assert.equal(routeNationalGtfsStore(dwellStore, { ...dwellRequest, destination: stopPoint('B', 1) }).arriveMinutes, 610)
const boardDuringDwell = routeNationalGtfsStore(dwellStore, { ...dwellRequest,
  origin: stopPoint('B', 1), destination: stopPoint('C', 2), departMinutes: 613,
})
assert.equal(firstRide(boardDuringDwell).startMinutes, 615)
assert.equal(boardDuringDwell.arriveMinutes, 620)
const deadline = routeNationalGtfsStore(dwellStore, { ...dwellRequest, timePreference: 'arrive', arriveMinutes: 619 })
assert.equal(deadline.status, 'ready')
assert(deadline.arriveMinutes <= 619)
assert.equal(firstRide(deadline).endMinutes, 610)
disposeNationalGtfsStore(dwellStore)
console.log('GTFS-RT routing check passed (dwell, propagated delay, skipped stops, cancellation, fallback, and transfer rules).')
