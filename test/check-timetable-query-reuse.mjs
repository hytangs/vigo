import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { timetableQueryFixture, timetableMatrixRequest, timetableQuerySemantics } from './helpers/timetable-query-fixture.mjs'

const require = createRequire(import.meta.url)
const { TimetableKernel } = require(process.env.VIGO_NATIVE_ROUTING_KERNEL || '../native/vigo-routing-kernel/vigo-routing-kernel.node')
const fixture = timetableQueryFixture(4)
const reused = new TimetableKernel(fixture)
const initialBytes = reused.diagnostics().workspaceBytes
let checks = 0
const compareFresh = request => {
  const expected = new TimetableKernel(fixture).routeMatrixCsa(request)
  const actual = reused.routeMatrixCsa(request)
  assert.deepEqual(timetableQuerySemantics(actual), timetableQuerySemantics(expected))
  checks++
  return actual
}

// Use one resident kernel across changes in source, direction, boarding cap,
// terminal transfers, empty endpoint frontiers, and failed request validation.
for (let iteration = 0; iteration < 4; iteration++) {
  for (const arriveBy of [false, true]) {
    // Grow to the public cap limit, then shrink on the same kernel. Reverse
    // reachability summaries must not retain stops or runs from an old query.
    for (const maximumBoardings of [undefined, 1, 32, 3, 1]) {
      for (const [origins, destinations] of [
        [[0], [31]], [[32, 0, 127], [63, 31, 0]], [[127], [0]],
      ]) {
        const request = timetableMatrixRequest(origins, destinations, {
          arriveBy, maximumBoardings,
          allowPreRideTransfers: origins.map((_, i) => (i + iteration) % 2 === 0),
          allowPostRideTransfers: destinations.map((_, i) => (i + iteration) % 2 === 1),
          originWalkSeconds: origins.map((_, i) => i * 7),
          destinationWalkSeconds: destinations.map((_, i) => i * 11),
          departure: 590 + iteration * 19,
        })
        compareFresh(request)
        compareFresh({ ...request, includeJourneys: false })
        compareFresh({ ...request, originOffsets: origins.map(() => 0).concat(0), originStops: [], originWalkSeconds: [] })
        assert.throws(() => reused.routeMatrixCsa({ ...request, maximumBoardings: 0 }))
        assert.throws(() => reused.routeMatrixCsa({ ...request, destinationWalkSeconds: destinations.map(() => -1) }))
      }
    }
  }
}

const direct = compareFresh(timetableMatrixRequest([0], [31]))
assert.deepEqual(direct.times, [910])
assert.equal(direct.journeys[0].boardings, 1)
assert.equal(direct.journeys[0].walkingSeconds, 0)
assert.deepEqual(direct.journeys[0].legs.filter(leg => leg.kind === 'ride').map(leg => leg.trip), [0])
assert(reused.diagnostics().workspaceBytes > initialBytes, 'Lazy journey scratch must be included in memory diagnostics.')
// Modifying a returned journey must not alter the retained scratch or later results.
direct.journeys[0].legs.length = 0
compareFresh(timetableMatrixRequest([0], [31]))

// An empty extra destination with terminal transfers permitted cannot change
// existing cells, but disables the coordinate-bound round shortcut. Exercise
// shared source groups with differing target bounds and unreachable cells.
for (const arriveBy of [false, true]) {
  for (const maximumBoardings of [undefined, 1, 3]) {
    for (const [origins, destinations] of [
      [[0], [1, 7, 15, 31, 127]], [[0, 32, 127], [7, 31, 33, 63, 127]],
    ]) {
      const request = timetableMatrixRequest(origins, destinations, { arriveBy, maximumBoardings,
        allowPreRideTransfers: origins.map(() => false),
        allowPostRideTransfers: destinations.map(() => false) })
      const actual = reused.routeMatrixCsa(request)
      const reference = reused.routeMatrixCsa({ ...request,
        destinationOffsets: [...request.destinationOffsets, request.destinationOffsets.at(-1)],
        allowPostRideTransfers: [...request.allowPostRideTransfers, true] })
      for (let origin = 0; origin < origins.length; origin++) {
        for (let destination = 0; destination < destinations.length; destination++) {
          const a = origin * destinations.length + destination
          const b = origin * (destinations.length + 1) + destination
          assert.equal(actual.times[a], reference.times[b])
          assert.deepEqual(actual.journeys[a], reference.journeys[b])
          checks++
        }
      }
    }
  }
}

// Duplicating the destination preserves the exact problem. Compare complete
// witnesses, including walking ties, across point and shared Matrix requests.
let pointChecks = 0
for (const arriveBy of [false, true]) {
  for (const maximumBoardings of [undefined, 1, 3]) {
    for (const departure of [590, 609, 628, 647]) {
      for (const walks of [[0, 0], [0, 17], [23, 0]]) {
        const request = {
          ...timetableMatrixRequest([0], [31], { arriveBy, maximumBoardings, departure }),
          originOffsets: [0, 2], originStops: [0, 1], originWalkSeconds: walks,
          destinationOffsets: [0, 2], destinationStops: [30, 31], destinationWalkSeconds: [...walks].reverse(),
          allowPreRideTransfers: [false], allowPostRideTransfers: [false],
        }
        const point = reused.routeMatrixCsa(request)
        const matrix = reused.routeMatrixCsa({
          ...request,
          destinationOffsets: [0, 2, 4],
          destinationStops: [...request.destinationStops, ...request.destinationStops],
          destinationWalkSeconds: [...request.destinationWalkSeconds, ...request.destinationWalkSeconds],
          allowPostRideTransfers: [false, false],
        })
        assert.equal(point.times[0], matrix.times[0])
        assert.deepEqual(point.journeys[0], matrix.journeys[0])
        pointChecks++
      }
    }
  }
}
// The unrestricted fastest route needs two boardings. A one-boarding cap
// must fall back to the exact bounded scan, including when it becomes blocked.
const cappedInput = {
  stopCount: 3, runCount: 3,
  departureSeconds: new Uint32Array([10, 10, 20]), arrivalSeconds: new Uint32Array([100, 20, 30]),
  fromStop: new Uint32Array([0, 0, 1]), toStop: new Uint32Array([2, 1, 2]),
  sequence: new Uint32Array([1, 1, 1]), segmentTrip: new Uint32Array([0, 1, 2]), segmentRun: new Uint32Array([0, 1, 2]),
  continuityBreak: new Uint8Array([1, 1, 1]), canBoard: new Uint8Array([1, 1, 1]), canAlight: new Uint8Array([1, 1, 1]),
  tripStart: new Uint32Array([0, 1, 2, 3]), departureOffset: new Uint32Array([0, 2, 3, 3]), departureOrder: new Uint32Array([0, 1, 2]),
  transferOffset: new Uint32Array([0, 0, 0, 0]), transferTo: new Uint32Array(), transferDuration: new Uint32Array(),
  forbiddenSameStop: new Uint8Array(3),
}
const capped = new TimetableKernel(cappedInput)
for (const horizon of [50, 120]) {
  for (const maximumBoardings of [1, 2, undefined]) {
    const q = timetableMatrixRequest([0], [2], { departure: 0, horizon, maximumBoardings,
      allowPreRideTransfers: [false], allowPostRideTransfers: [false] })
    const point = capped.routeMatrixCsa(q)
    const general = capped.routeMatrixCsa({ ...q, destinationOffsets: [0, 1, 2, 2], destinationStops: [2, 2],
      destinationWalkSeconds: [0, 0], allowPostRideTransfers: [false, false, true] })
    assert.deepEqual(point.journeys[0], general.journeys[0])
    assert.equal(point.times[0], maximumBoardings === 1 ? (horizon < 100 ? Infinity : 100) : 30)
    assert.throws(() => capped.routeMatrixCsa({ ...q, maximumBoardings: 0 }))
    pointChecks++
  }
}
const reverseCapped = new TimetableKernel({ ...cappedInput,
  departureSeconds: new Uint32Array([10, 50, 60]), arrivalSeconds: new Uint32Array([100, 60, 70]) })
for (const horizon of [80, 120]) for (const maximumBoardings of [1, 2, undefined]) {
  const q = timetableMatrixRequest([0], [2], { arriveBy: true, departure: 0, horizon, maximumBoardings,
    allowPreRideTransfers: [false], allowPostRideTransfers: [false] })
  const actual = reverseCapped.routeMatrixCsa(q)
  const reference = reverseCapped.routeMatrixCsa({ ...q, destinationOffsets: [0, 1, 2],
    destinationStops: [2, 2], destinationWalkSeconds: [0, 0], allowPostRideTransfers: [false, false] })
  assert.equal(actual.times[0], maximumBoardings === 1 ? (horizon < 100 ? -Infinity : 10) : 50)
  assert.equal(actual.times[0], reference.times[0])
  assert.deepEqual(actual.journeys[0], reference.journeys[0], 'Capped reverse proof retains exact journey ties')
  assert.throws(() => reverseCapped.routeMatrixCsa({ ...q, departure: -1 }))
  assert.throws(() => reverseCapped.routeMatrixCsa({ ...q, maximumBoardings: 0 }))
  pointChecks++
}
assert.throws(() => new TimetableKernel({ ...cappedInput, segmentRun: new Uint32Array([0, 1, 0]), runCount: 2 }), /contiguous/)
const reversedRun = new Uint32Array(fixture.departureSeconds)
reversedRun[1] = reversedRun[0]
assert.throws(() => new TimetableKernel({ ...fixture, departureSeconds: reversedRun }), /chronological/)
const brokenRun = new Uint8Array(fixture.continuityBreak)
brokenRun[1] = 1
assert.throws(() => new TimetableKernel({ ...fixture, continuityBreak: brokenRun }), /contiguous/)
const repeatedSequence = new Uint32Array(fixture.sequence)
repeatedSequence[1] = repeatedSequence[0]
assert.throws(() => new TimetableKernel({ ...fixture, sequence: repeatedSequence }), /contiguous/)
console.log(`Timetable query reuse passed: ${checks} fresh/resident and ${pointChecks} point/general-Matrix comparisons, both directions, scalar and full journeys, invalid-input recovery.`)
