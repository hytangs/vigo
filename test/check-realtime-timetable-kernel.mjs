import assert from 'node:assert/strict'
import { realtimeRideAlerts, realtimeTimetableForRequest, withRealtimeQueryContext } from '../src/server/gtfs/realtime-timetable.mjs'
import { routeNativeTimetableScalar, routeNativeTimetableArriveBy } from '../src/server/native-routing-kernel.mjs'

const u32 = values => Uint32Array.from(values)
const u8 = values => Uint8Array.from(values)
// Trip `cancel` runs A-C, `live` A-B-C and `scheduled` A-C.
const schedule = (changes = {}) => ({
  stopIds: ['A', 'B', 'C'], stopIndex: new Map([['A', 0], ['B', 1], ['C', 2]]),
  tripIds: ['cancel', 'live', 'scheduled'], routeIds: ['R', 'R', 'R'],
  serviceIds: ['weekday', 'weekday', 'weekday'], directionIds: ['', '', ''],
  departureSeconds: u32([100, 110, 160, 120]), arrivalSeconds: u32([200, 150, 210, 220]),
  fromStop: u32([0, 0, 1, 0]), toStop: u32([2, 1, 2, 2]), sequence: u32([1, 10, 20, 1]),
  segmentTrip: u32([0, 1, 1, 2]), segmentRun: u32([0, 1, 1, 2]), continuityBreak: u8([0, 0, 0, 0]),
  canBoard: u8([1, 1, 1, 1]), canAlight: u8([1, 1, 1, 1]), tripStart: u32([0, 1, 3, 4]),
  departureOffset: u32([0, 3, 4, 4]), departureOrder: u32([0, 1, 3, 2]),
  transferOffset: u32([0, 0, 0, 0]), transferTo: u32([]), transferDuration: u32([]),
  forbiddenSameStop: u8([0, 0, 0]), sameStopTransferMinimum: u32([0, 0, 0]),
  runCount: 3, activeSegmentCount: 4, transferCount: 0, ...changes,
})
const base = schedule()
const frozenArrays = Object.fromEntries(Object.entries(base)
  .filter(([, value]) => ArrayBuffer.isView(value)).map(([name, value]) => [name, [...value]]))
// Service seconds are UTC seconds after midnight of the service date.
const store = { agencyTimezones: ['UTC'] }
const serviceDate = '2026-09-21'
const origin = Date.parse(`${serviceDate}T00:00:00Z`) / 1000
const now = origin + 90
const realtime = (snapshot, kernel = base, observation = now) => realtimeTimetableForRequest(store, kernel,
  withRealtimeQueryContext({ routingDataMode: 'realtime', realtimeSnapshot: { feedTimestamp: now, ...snapshot } }, observation),
  { resolvedServiceDate: serviceDate })

// `live` departs late from A, skips B and reports its terminal's actual sequence.
const delayed = { tripUpdates: [
  { tripId: 'cancel', scheduleRelationship: 'CANCELED' },
  { tripId: 'live', stopTimeUpdates: [
    { stopSequence: 10, departure: { time: origin + 130 } },
    { stopSequence: 20, scheduleRelationship: 'SKIPPED' },
    { stopSequence: 30, stopId: 'C', arrival: { time: origin + 230 } },
  ] },
] }
const result = realtime(delayed)
assert.equal(result.status, 'applied')
assert.equal(result.ready, true)
assert.deepEqual(result.trips, [{ tripId: 'cancel', feedTripId: 'cancel' }, { tripId: 'live', feedTripId: 'live' }])
assert.deepEqual([result.diagnostics.appliedTrips, result.diagnostics.canceledTrips, result.diagnostics.matchedTripUpdates], [1, 1, 2])
const kernel = result.kernel
for (const name of ['stopIds', 'tripIds', 'stopIndex', 'transferOffset', 'transferTo', 'transferDuration', 'sameStopTransferMinimum']) {
  assert.equal(kernel[name], base[name], `${name} must retain the original identity`)
}
assert.deepEqual([...kernel.tripStart], [0, 0, 1, 2], 'Cancellation retains the original trip index')
assert.deepEqual([...kernel.realtimeTripIndices], [1])
assert.deepEqual([...kernel.segmentRun], [0, 1], 'Remaining runs must be dense')
assert.deepEqual([...kernel.departureSeconds], [130, 120])
assert.equal(result.diagnostics.activeSegments, 2)
for (const [name, values] of Object.entries(frozenArrays)) assert.deepEqual([...base[name]], values, `${name} was mutated`)

const seed = stop => [{ stop, walkSeconds: 0, candidateIndex: 0 }]
const endpoints = { originSeeds: seed(0), destinationSeeds: seed(2), allowPreRideTransfers: false, allowPostRideTransfers: false }
const depart = routeNativeTimetableScalar(kernel, { ...endpoints, departure: 0, horizon: 300 })
assert.equal(depart.supported, true)
assert.equal(depart.bestArrival, 220, 'The unchanged trip beats the delayed live trip')
assert.equal(depart.chainTripOrCandidate[depart.chainKinds.indexOf(2)], 2, 'Native journey preserves original trip identity')
const arrive = routeNativeTimetableArriveBy(kernel, { ...endpoints, earliest: 0, deadline: 235 })
assert.equal(arrive.latestDeparture, 130, 'Reverse routing must see the same live times')
const reproduced = routeNativeTimetableScalar(kernel, { ...endpoints, departure: arrive.latestDeparture, horizon: 235 })
assert.equal(reproduced.bestArrival, 230)
assert.equal(reproduced.chainTripOrCandidate[reproduced.chainKinds.indexOf(2)], 1)
assert.equal(routeNativeTimetableScalar(kernel, {
  ...endpoints, originSeeds: seed(1), departure: 0, horizon: 300,
}).status, 'blocked', 'A skipped stop cannot board the updated trip')
assert.equal(routeNativeTimetableArriveBy(kernel, {
  ...endpoints, destinationSeeds: seed(1), earliest: 0, deadline: 300,
}).status, 'blocked', 'Reverse routing must respect skipped alighting')

// Views are retained by content and record validity, not by request.
assert.equal(realtime(structuredClone(delayed)), result, 'An identical snapshot reuses its view')
assert.notEqual(realtime({ tripUpdates: delayed.tripUpdates.slice(0, 1) }), result)
const aged = realtime(delayed, base, now + 600)
assert.notEqual(aged, result, 'Records that have become stale yield a new view')
assert.equal(aged.status, 'stale_fallback')
assert.equal(aged.kernel, base, 'An overlay that changes no service keeps the scheduled timetable')

const allCanceled = realtime({ tripUpdates: base.tripIds.map(tripId => ({ tripId, scheduleRelationship: 'CANCELED' })) })
assert.equal(allCanceled.status, 'cancellations_only')
assert.equal(allCanceled.kernel.activeSegmentCount, 0)
assert.equal(allCanceled.kernel.runCount, 0)
assert.deepEqual([...allCanceled.kernel.tripStart], [0, 0, 0, 0])
const noRemainingRide = realtime({ tripUpdates: [{ tripId: 'cancel', scheduleRelationship: 'CANCELED' },
  { tripId: 'live', stopTimeUpdates: [10, 20].map(stopSequence => ({ stopSequence, scheduleRelationship: 'SKIPPED' })) }] }).kernel
assert.equal(noRemainingRide.activeSegmentCount, 1)
assert.deepEqual([...noRemainingRide.realtimeTripIndices], [1], 'Updated trips remain counted even if every ride was skipped')
assert.deepEqual([...noRemainingRide.segmentRun], [0])
assert.deepEqual([...noRemainingRide.tripStart], [0, 0, 0, 1])
assert.equal(routeNativeTimetableScalar(noRemainingRide, {
  ...endpoints, originSeeds: seed(1), departure: 0, horizon: 300,
}).status, 'blocked', 'A fully skipped replacement must suppress its scheduled original')

// Malformed records reject their trip, never the snapshot or the schedule.
for (const stopTimeUpdates of [
  [{ stopSequence: 20, stopId: 'unknown', arrival: { delay: 60 } }],
  [{ stopSequence: 20, arrival: { time: origin + 100 } }],
  [{ stopSequence: 10, departure: { time: origin + (1 << 20) } }],
  [{ stopSequence: 10, departure: { time: origin + 0.5 } }],
]) {
  const rejected = realtime({ tripUpdates: [{ tripId: 'live', stopTimeUpdates }] })
  assert.equal(rejected.diagnostics.invalidTrips, 1, JSON.stringify(stopTimeUpdates))
  assert.equal(rejected.status, 'no_matches')
  assert.equal(rejected.kernel, base)
}
assert.equal(realtime({ tripUpdates: [{ tripId: 'live', scheduleRelationship: 'ADDED' }] }).diagnostics.unsupportedTrips, 1)
for (const change of [
  { tripStart: u32([0, 2, 1, 4]) }, { toStop: u32([9, 1, 2, 2]) },
  { canBoard: u8([1, 2, 1, 1]) }, { sequence: u32([]) },
]) assert.throws(() => realtime(delayed, schedule(change)), /Inconsistent realtime schedule|Malformed base/)
const cancellationWins = realtime({ tripUpdates: [{ tripId: 'live', scheduleRelationship: 'CANCELED', stopTimeUpdates: 'invalid but canceled' }] })
assert.equal(cancellationWins.kernel.activeSegmentCount, 2)
const broken = realtime({ tripUpdates: [{ tripId: 'scheduled', delaySeconds: 0 }] }, schedule({ continuityBreak: u8([0, 0, 1, 0]) }))
assert.deepEqual([...broken.kernel.segmentRun], [0, 1, 2, 3], 'Static discontinuities survive realtime reconstruction')
assert.deepEqual([...broken.kernel.departureOrder], [0, 1, 3, 2])
assert.equal(realtime({ tripUpdates: [{ tripId: 'live', delaySeconds: 60 }] }, schedule({ continuityBreak: u8([0, 0, 1, 0]) })).diagnostics.invalidTrips, 1,
  'An update cannot bridge disconnected scheduled runs')

// NO_SERVICE closes service in the view; other alerts describe the rides.
const closed = realtime({ tripUpdates: [], alerts: [
  { id: 'b', effect: 'NO_SERVICE', informedEntities: [{ stopId: 'B' }] },
  { id: 'detour', effect: 'DETOUR', header: 'Detour', informedEntities: [{ routeId: 'R' }], activePeriods: [{ start: origin + 100, end: origin + 140 }] },
] })
assert.equal(closed.ready, true)
assert.deepEqual(closed.diagnostics.alerts, { received: 2, fresh: 2, stale: 0, noService: 1, unsupportedEntities: 0, closedBoardings: 1, closedAlightings: 1 })
assert.deepEqual([...closed.kernel.canBoard], [1, 1, 0, 1])
assert.deepEqual([...closed.kernel.canAlight], [1, 0, 1, 1])
assert.equal(routeNativeTimetableScalar(closed.kernel, { ...endpoints, originSeeds: seed(1), departure: 0, horizon: 300 }).status, 'blocked')
const ride = (from, to, departure, arrival) => [{ from_stop_id: from, to_stop_id: to, departure, arrival }]
assert.deepEqual(realtimeRideAlerts(closed, closed.kernel, 2, ride('A', 'C', 120, 220)).map(alert => alert.id), ['detour'])
assert.equal(realtimeRideAlerts(closed, closed.kernel, 2, ride('A', 'C', 150, 220)), undefined, 'An alert outside the ride is not shown')
assert.deepEqual(realtimeRideAlerts(closed, closed.kernel, 1, ride('A', 'B', 110, 150)).map(alert => alert.id), ['b', 'detour'])
const unzoned = realtimeTimetableForRequest({ agencyTimezones: [] }, base, withRealtimeQueryContext({ routingDataMode: 'realtime',
  realtimeSnapshot: { feedTimestamp: now, tripUpdates: [], alerts: [{ effect: 'NO_SERVICE', informedEntities: [{ stopId: 'B' }] }] } }, now),
  { resolvedServiceDate: serviceDate })
assert.equal(unzoned.diagnostics.alerts.closedBoardings, 1, 'The City clock defaults to UTC')

// GTFS service time is elapsed from local noon minus 12 hours, not wall time.
// On 2026-11-01 New York noon is 17:00Z, so the origin is 05:00Z.
// The two 01:30 wall clocks must remain distinct (00:30 and 01:30 GTFS time).
for (const [timezone, date, absolute, seconds] of [
  ['America/New_York', '2026-03-08', '2026-03-08T03:30:00-04:00', 12600],
  ['America/New_York', '2026-11-01', '2026-11-01T01:30:00-04:00', 1800],
  ['America/New_York', '2026-11-01', '2026-11-01T01:30:00-05:00', 5400],
  ['UTC', '2026-09-21', '2026-09-22T00:30:00Z', 88200],
  ['UTC', '2026-09-22', '2026-09-22T00:30:00Z', 1800],
]) {
  const epoch = Date.parse(absolute) / 1000
  const request = withRealtimeQueryContext({ routingDataMode: 'realtime', realtimeSnapshot: {
    feedTimestamp: epoch - 60, tripUpdates: [{ tripId: 'live', startDate: date.replaceAll('-', ''),
      stopTimeUpdates: [['A', 10], ['B', 20], ['C', 30]].map(([stopId, stopSequence], i) => ({ stopId, stopSequence,
        arrival: { time: epoch + i * 60 }, departure: { time: epoch + i * 60 } })),
    }],
  } }, epoch - 60)
  const zoned = realtimeTimetableForRequest({ agencyTimezones: [timezone] }, base, request, { resolvedServiceDate: date })
  assert.equal(zoned.status, 'applied')
  const start = zoned.kernel.tripStart[1], end = zoned.kernel.tripStart[2]
  assert.deepEqual([...zoned.kernel.departureSeconds.slice(start, end)], [seconds, seconds + 60])
  assert.deepEqual([...zoned.kernel.arrivalSeconds.slice(start, end)], [seconds + 60, seconds + 120])
}
console.log('Realtime timetable kernel passed: immutable identities, cancellations, delayed routing, reverse parity, skipped calls, view reuse, trip-level rejection, alerts, DST and overnight clocks.')
