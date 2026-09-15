import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { TimetableKernel } = createRequire(import.meta.url)(
  process.env.VIGO_NATIVE_ROUTING_KERNEL ?? '../native/vigo-routing-kernel/vigo-routing-kernel.node',
)

function kernelFor(trips, stopCount, minimum = [0, 0, 0, 0]) {
  const departure = [], arrival = [], from = [], to = [], sequence = [], trip = [], board = [], alight = [], starts = [0]
  for (const [id, calls] of trips.entries()) {
    for (let i = 0; i < calls.length - 1; i++) {
      departure.push(calls[i].time); arrival.push(calls[i + 1].time)
      from.push(calls[i].stop); to.push(calls[i + 1].stop); sequence.push(i)
      trip.push(id); board.push(calls[i].board === false ? 0 : 1); alight.push(calls[i + 1].alight === false ? 0 : 1)
    }
    starts.push(departure.length)
  }
  const order = departure.map((_, i) => i).filter(i => board[i]).sort((a, b) => from[a] - from[b] || departure[a] - departure[b] || a - b)
  const offsets = Array(stopCount + 1).fill(0)
  for (const i of order) offsets[from[i] + 1]++
  for (let i = 0; i < stopCount; i++) offsets[i + 1] += offsets[i]
  return new TimetableKernel({
    stopCount, runCount: trips.length,
    departureSeconds: new Uint32Array(departure), arrivalSeconds: new Uint32Array(arrival),
    fromStop: new Uint32Array(from), toStop: new Uint32Array(to), sequence: new Uint32Array(sequence),
    segmentTrip: new Uint32Array(trip), segmentRun: new Uint32Array(trip),
    continuityBreak: new Uint8Array(trip.length), canBoard: new Uint8Array(board), canAlight: new Uint8Array(alight),
    tripStart: new Uint32Array(starts), departureOffset: new Uint32Array(offsets), departureOrder: new Uint32Array(order),
    transferOffset: new Uint32Array(stopCount + 1), transferTo: new Uint32Array(), transferDuration: new Uint32Array(),
    forbiddenSameStop: new Uint8Array(stopCount),
    sameStopTransferMinimum: new Uint32Array(minimum),
  })
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
// Exhaustive complete-journey enumeration on tiny acyclic networks. This is
// independent of the native stop labels, run dominance and Pareto machinery.
function enumerate(trips, walks, maximumBoardings, updates, minimum) {
  let best = [Infinity, Infinity, Infinity]
  function visit(stop, time, boardings, walking) {
    if (stop === 3 && boardings && compare([time, boardings, walking], best) < 0) best = [time, boardings, walking]
    if (boardings >= maximumBoardings) return
    for (const calls of trips) for (let i = 0; i < calls.length - 1; i++) {
      const ready = time + (boardings && !updates.includes(calls) ? minimum[stop] : 0)
      if (calls[i].stop !== stop || calls[i].time < ready || calls[i].board === false) continue
      for (let j = i + 1; j < calls.length; j++) {
        if (calls[j].alight !== false) visit(calls[j].stop, calls[j].time, boardings + 1, walking)
      }
    }
  }
  walks.forEach((walk, stop) => visit(stop, walk, 0, walk))
  return best
}

function overlayRequest(updates, walks, excluded, maximumBoardings) {
  const stops = [], times = [], offsets = [0], starts = [], canBoard = [], canAlight = []
  for (const calls of updates) {
    starts.push(calls[0].time)
    for (const call of calls) {
      stops.push(call.stop); times.push(call.time - calls[0].time)
      canBoard.push(call.board === false ? 0 : 1); canAlight.push(call.alight === false ? 0 : 1)
    }
    offsets.push(stops.length)
  }
  return {
    originStops: [0, 1, 2, 4, 5, 6], originWalkSeconds: [...walks, ...walks], originCandidateIndices: [0, 1, 2, 0, 1, 2],
    destinationOffsets: [0, 2], destinationStops: [3, 7], destinationWalkSeconds: [0, 0], destinationCandidateIndices: [0, 0],
    departure: 0, horizon: 2000, excludedTrips: excluded, allowPreRideTransfers: false, maximumBoardings,
    overlayStopCount: 4, directionOffsets: offsets, directionStops: stops, directionStopOffsetsSeconds: times,
    serviceStartSeconds: starts, serviceEndSeconds: starts, serviceHeadwaySeconds: starts.map(() => 1),
    directionCanBoard: canBoard, directionCanAlight: canAlight,
    supplementalTransferOffsets: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    supplementalTransferTo: [4, 5, 6, 7, 0, 1, 2, 3], supplementalTransferDuration: Array(8).fill(0),
    certifyJourney: true,
  }
}

let checked = 0
function check(trips, updates, replaced, canceled, walks, cap, minimum = [0, 0, 0, 0]) {
  const kernel = kernelFor(trips, 4, minimum)
  const excluded = [...replaced, ...canceled]
  const active = trips.filter((_, i) => !excluded.includes(i)).concat(updates)
  const expected = enumerate(active, walks, cap ?? 4, updates, minimum)
  const request = overlayRequest(updates, walks, excluded, cap)
  const result = kernel.routeOverlayManyCsa(request)
  assert.equal(result.timetable.bestArrivals[0], expected[0])
  if (Number.isFinite(expected[0])) {
    assert.equal(result.lexicographicCertified, true, result.qualityReason)
    const t = result.timetable
    const boardingCount = t.chainKinds.filter(kind => kind === 2).length
    const originCandidate = t.chainTripOrCandidate[t.chainKinds.indexOf(3)]
    assert.deepEqual([t.bestArrivals[0], boardingCount, walks[originCandidate]], expected,
      JSON.stringify({ trips, updates, walks, cap, canceled }))
    // Reconstruct each ride against its actual source; no canceled or stale
    // replacement trip may appear in a chain improved by the certifier.
    let at = originCandidate, time = walks[at]
    for (let i = 0; i < t.chainKinds.length; i++) {
      if (t.chainKinds[i] === 1) continue // zero-time identity bridge
      if (t.chainKinds[i] !== 2) continue
      const trip = t.chainTripOrCandidate[i]
      if (trip >= 0) assert(!excluded.includes(trip))
      const calls = trip < -1 ? updates[-trip - 2] : trips[trip]
      const board = calls[t.chainBoardSequences[i]], alight = calls[t.chainAlightSequences[i] + 1]
      assert.equal(board.stop, at); assert(board.time >= time); assert.notEqual(board.board, false)
      assert.notEqual(alight.alight, false); assert.equal(alight.time, t.chainArrivals[i])
      at = alight.stop; time = alight.time
    }
    assert.equal(at, 3); assert.equal(time, expected[0])
  }
  const scalar = kernel.routeOverlayManyCsa({ ...request, certifyJourney: false })
  assert.equal(scalar.qualityQueryNs, 0)
  assert.equal(scalar.lexicographicCertified, false)
  assert.deepEqual(scalar.timetable.bestArrivals, result.timetable.bestArrivals)
  checked++
}

const sameTrain = [{ stop: 0, time: 100 }, { stop: 1, time: 200 }, { stop: 3, time: 300 }]
check([sameTrain], [], [], [], [80, 20, 2000])
check([sameTrain], [sameTrain], [0], [], [80, 20, 2000])
check([sameTrain], [sameTrain.map(call => ({ ...call, board: call.stop !== 1 }))], [0], [], [80, 20, 2000])
check([
  [{ stop: 0, time: 100 }, { stop: 1, time: 200 }],
  [{ stop: 1, time: 200 }, { stop: 3, time: 400 }],
  [{ stop: 0, time: 150 }, { stop: 3, time: 400 }],
], [], [], [], [0, 2000, 2000])

// Fixed seed, broad combinations of unaffected, delayed, skipped and canceled
// trips; identifiers and coordinates play no role in the expected answer.
let seed = 4831
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
for (let sample = 0; sample < 120; sample++) {
  const trips = Array.from({ length: 4 }, () => {
    let time = 60 + random(100)
    return [0, 1, 2, 3].filter(stop => stop === 0 || stop === 3 || random(2)).map(stop => {
      time += 20 + random(180)
      return { stop, time, board: random(8) !== 0, alight: random(8) !== 0 }
    })
  })
  const updates = [trips[0].map(call => ({ ...call, time: call.time + 60 }))]
  check(trips, updates, [0], sample % 3 === 0 ? [1] : [], [random(160), random(160), random(160)], sample % 2 ? 1 : 3)
  check(trips, updates, [0], [], [random(160), random(160), random(160)], 3, [0, 70, 90, 0])
}
console.log(`Realtime journey quality: ${checked} exhaustive comparisons passed.`)
