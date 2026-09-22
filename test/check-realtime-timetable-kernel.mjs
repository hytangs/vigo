import assert from 'node:assert/strict'
import { compileRealtimeTimetableKernel } from '../src/server/realtime-timetable-kernel.mjs'
import { realtimeTimetableForRequest, withRealtimeQueryContext } from '../src/server/gtfs/realtime-timetable.mjs'
import { routeNativeTimetableScalar, routeNativeTimetableArriveBy } from '../src/server/native-routing-kernel.mjs'

const u32 = values => Uint32Array.from(values)
const u8 = values => Uint8Array.from(values)
const base = {
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
  runCount: 3, activeSegmentCount: 4, transferCount: 0,
}
const frozenArrays = Object.fromEntries(Object.entries(base)
  .filter(([, value]) => ArrayBuffer.isView(value)).map(([name, value]) => [name, [...value]]))
const stopTimes = [
  { stopId: 'A', sequence: 10, arrival: 130, departure: 130 },
  { stopId: 'B', sequence: 20, arrival: 170, departure: 180, canBoard: false, canAlight: false },
  { stopId: 'C', sequence: 30, arrival: 230, departure: 230 },
]
const kernel = compileRealtimeTimetableKernel(base, {
  replacements: new Map([[1, { stopTimes }]]), canceledTrips: new Set([0]),
})
for (const name of ['stopIds', 'tripIds', 'stopIndex', 'transferOffset', 'transferTo', 'transferDuration', 'sameStopTransferMinimum']) {
  assert.equal(kernel[name], base[name], `${name} must retain the original identity`)
}
assert.deepEqual([...kernel.tripStart], [0, 0, 2, 3], 'Cancellation retains the original trip index')
assert.deepEqual([...kernel.realtimeTripIndices], [1])
assert.deepEqual([...kernel.segmentRun], [0, 0, 1], 'Remaining runs must be dense')
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

const allCanceled = compileRealtimeTimetableKernel(base, { canceledTrips: new Set([0, 1, 2]) })
assert.equal(allCanceled.activeSegmentCount, 0)
assert.equal(allCanceled.runCount, 0)
assert.deepEqual([...allCanceled.tripStart], [0, 0, 0, 0])
for (const stopTimes of [[], [{ stopId: 'B', sequence: 20, arrival: 170, departure: 180 }]]) {
  const noRemainingRide = compileRealtimeTimetableKernel(base, {
    replacements: new Map([[1, { stopTimes }]]), canceledTrips: new Set([0]),
  })
  assert.equal(noRemainingRide.activeSegmentCount, 1)
  assert.deepEqual([...noRemainingRide.realtimeTripIndices], [1], 'Updated trips remain counted even if every ride was skipped')
  assert.deepEqual([...noRemainingRide.segmentRun], [0])
  assert.deepEqual([...noRemainingRide.tripStart], [0, 0, 0, 1])
  assert.equal(routeNativeTimetableScalar(noRemainingRide, {
    ...endpoints, originSeeds: seed(1), departure: 0, horizon: 300,
  }).status, 'blocked', 'A fully skipped replacement must suppress its scheduled original')
}
assert.throws(() => compileRealtimeTimetableKernel(base, {
  replacements: new Map([[1, { stopTimes: stopTimes.map((stop, i) => i === 1 ? { ...stop, stopId: 'unknown' } : stop) }]]),
}), /unknown stop unknown/)
assert.throws(() => compileRealtimeTimetableKernel(base, {
  replacements: new Map([[1, { stopTimes: stopTimes.map((stop, i) => i === 1 ? { ...stop, arrival: 100 } : stop) }]]),
}), /non-monotonic/)
for (const time of [-1, 1.5, 1 << 20, Infinity]) {
  assert.throws(() => compileRealtimeTimetableKernel(base, {
    replacements: new Map([[1, { stopTimes: stopTimes.map(stop => ({ ...stop, arrival: time, departure: time })) }]]),
  }), /unsupported event time/)
}
for (const change of [
  { tripStart: u32([0, 2, 1, 4]) }, { toStop: u32([9, 1, 2, 2]) },
  { canBoard: u8([1, 2, 1, 1]) }, { sequence: u32([]) },
]) assert.throws(() => compileRealtimeTimetableKernel({ ...base, ...change }), /Malformed base/)
const cancellationWins = compileRealtimeTimetableKernel(base, {
  canceledTrips: new Set([1]), replacements: new Map([[1, { stopTimes: 'invalid but canceled' }]]),
})
assert.equal(cancellationWins.activeSegmentCount, 2)
const broken = compileRealtimeTimetableKernel({ ...base, continuityBreak: u8([0, 0, 1, 0]) })
assert.deepEqual([...broken.segmentRun], [0, 1, 2, 3], 'Static discontinuities survive realtime reconstruction')
assert.deepEqual([...broken.departureOrder], [0, 1, 3, 2])
// Absolute event clocks remain local to the snapshot's service date/timezone.
// Repeated arrival/departure epochs must preserve DST and overnight offsets.
const originalNow = Date.now
try {
  for (const [timezone, serviceDate, absolute, seconds] of [
    ['America/New_York', '2026-03-08', '2026-03-08T03:30:00-04:00', 12600],
    ['America/New_York', '2026-11-01', '2026-11-01T01:30:00-04:00', 5400],
    ['America/New_York', '2026-11-01', '2026-11-01T01:30:00-05:00', 5400],
    ['UTC', '2026-09-21', '2026-09-22T00:30:00Z', 88200],
    ['UTC', '2026-09-22', '2026-09-22T00:30:00Z', 1800],
  ]) {
    const epoch = Date.parse(absolute) / 1000
    Date.now = () => (epoch - 60) * 1000
    const store = { agencyTimezones: [timezone], realtimeTripStopTimesLookup: {
      all: () => stopTimes.map(call => ({ stop_id: call.stopId, stop_sequence: call.sequence,
        arrival: call.arrival, departure: call.departure, can_board: 1, can_alight: 1 })),
    } }
    const request = withRealtimeQueryContext({ routingDataMode: 'realtime', realtimeSnapshot: {
      feedTimestamp: epoch - 60, tripUpdates: [{ tripId: 'live', startDate: serviceDate.replaceAll('-', ''),
        stopTimeUpdates: stopTimes.map((call, i) => ({ stopId: call.stopId, stopSequence: call.sequence,
          arrival: { time: epoch + i * 60 }, departure: { time: epoch + i * 60 } })),
      }],
    } })
    const result = realtimeTimetableForRequest(store, base, request, { resolvedServiceDate: serviceDate })
    assert.equal(result.status, 'applied')
    const start = result.kernel.tripStart[1], end = result.kernel.tripStart[2]
    assert.deepEqual([...result.kernel.departureSeconds.slice(start, end)], [seconds, seconds + 60])
    assert.deepEqual([...result.kernel.arrivalSeconds.slice(start, end)], [seconds + 60, seconds + 120])
  }
} finally { Date.now = originalNow }
console.log('Realtime timetable kernel passed: immutable identities, cancellations, delayed routing, reverse parity, skipped calls, native bounds, DST and overnight clocks.')
