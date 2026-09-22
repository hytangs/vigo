import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { TimetableKernel } = require('../native/vigo-routing-kernel/vigo-routing-kernel.node')
let state = 619
const random = (limit) => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % limit)

function fixture() {
  const rows = []
  const tripStart = [0]
  const addTrip = (stops, times) => {
    const trip = tripStart.length - 1
    for (let i = 1; i < stops.length; i += 1) rows.push({
      from: stops[i - 1], to: stops[i], departure: times[i - 1], arrival: times[i],
      trip, sequence: i, first: i === 1,
    })
    tripStart.push(rows.length)
  }
  addTrip([0, 3], [300, 420])
  addTrip([3, 6], [450, 570])
  addTrip([6, 11], [600, 720])
  addTrip([0, 11], [300, 1020])
  for (let trip = 0; trip < 40; trip += 1) {
    const stops = [random(9)]
    const times = [150 + random(1300)]
    while (stops.at(-1) < 11 && stops.length < 5) {
      stops.push(Math.min(11, stops.at(-1) + 1 + random(3)))
      times.push(times.at(-1) + random(120))
    }
    addTrip(stops, times)
  }
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].from - rows[b].from
    || rows[a].departure - rows[b].departure || a - b)
  const offsets = [0]
  const transferOffset = [0], transferTo = [], transferDuration = []
  for (let stop = 0; stop < 12; stop += 1) {
    offsets.push(offsets.at(-1) + rows.filter((row) => row.from === stop).length)
    if (stop > 0 && stop < 11 && random(2)) {
      transferTo.push(stop + 1)
      transferDuration.push(10 + random(90))
    }
    transferOffset.push(transferTo.length)
  }
  const column = (key) => new Uint32Array(rows.map((row) => row[key]))
  return {
    stopCount: 12, runCount: tripStart.length - 1,
    departureSeconds: column('departure'), arrivalSeconds: column('arrival'),
    fromStop: column('from'), toStop: column('to'), sequence: column('sequence'),
    segmentTrip: column('trip'), segmentRun: column('trip'),
    continuityBreak: new Uint8Array(rows.map((row) => Number(row.first))),
    canBoard: new Uint8Array(rows.length).fill(1), canAlight: new Uint8Array(rows.length).fill(1),
    tripStart: new Uint32Array(tripStart), departureOffset: new Uint32Array(offsets),
    departureOrder: new Uint32Array(order), transferOffset: new Uint32Array(transferOffset),
    transferTo: new Uint32Array(transferTo), transferDuration: new Uint32Array(transferDuration),
    forbiddenSameStop: new Uint8Array(12),
  }
}

const metrics = (result) => ({
  status: result.status, arrival: result.bestArrival, boardings: result.bestBoardings,
  walking: result.bestWalkingSeconds, generalized: result.bestGeneralizedSeconds,
  alternatives: result.alternatives?.map((plan) => [plan.bestArrival, plan.bestBoardings, plan.bestWalkingSeconds]),
})
let comparisons = 0
for (let seed = 0; seed < 100; seed += 1) {
  const data = fixture()
  const kernel = new TimetableKernel(data)
  const query = {
    originStops: [0, 1], originWalkSeconds: [0, 30 + random(120)], originCandidateIndices: [0, 1],
    destinationStops: [11, 10], destinationWalkSeconds: [0, 30 + random(120)], destinationCandidateIndices: [0, 1],
    departure: random(241), horizon: 1800, allowPreRideTransfers: seed % 2 === 0,
  }
  // A capped journey may arrive after the unrestricted winner and use fewer
  // boardings. The completed scalar prefix remains a valid universal envelope;
  // every run in its unscanned suffix must be admitted through the new deadline.
  for (const maximumBoardings of [1, 2, 3]) {
    const scalar = kernel.routeScalarCsa(query)
    const arrival = kernel.routeManyCsa({ ...query, maximumBoardings,
      destinationOffsets: [0, query.destinationStops.length], excludedTrips: [],
    }).bestArrivals[0]
    if (!Number.isFinite(arrival)) continue
    const cappedQuery = { ...query, earliestArrival: arrival, boardingUpperBound: maximumBoardings,
      candidateDestinationIndex: 0, candidateWalkingSeconds: Number.MAX_VALUE,
      arrivalSlackSeconds: 0, transferPenaltySeconds: 0, walkReluctance: 0 }
    const reused = kernel.routeParetoRoundCsa(cappedQuery)
    assert.equal(reused.scalarEnvelopeReused, scalar.bestArrival <= arrival)
    const reference = kernel.routeParetoRoundCsa({ ...cappedQuery, restrictionMode: 'anchor-only' })
    assert.deepEqual(metrics(reused), metrics(reference), `Capped envelope, seed ${seed}, boardings ${maximumBoardings}`)
    assert.equal(reused.bestArrival, arrival)
    comparisons += 1
  }
  for (const [collectAlternatives, arrivalSlackSeconds, transferPenaltySeconds, walkReluctance] of [
    [true, 900, 0, 0], [false, 0, 0, 0], [false, 900, 300, 1],
  ]) {
    const scalar = kernel.routeScalarCsa(query)
    assert.equal(scalar.status, 'ready')
    const candidateWalkingSeconds = scalar.chainDurations.reduce((total, duration, i) =>
      total + ([1, 3].includes(scalar.chainKinds[i]) ? duration : 0), query.destinationWalkSeconds[scalar.bestDestinationIndex])
    const request = { ...query, earliestArrival: scalar.bestArrival, boardingUpperBound: scalar.bestBoardings,
      candidateDestinationIndex: scalar.bestDestinationIndex, candidateWalkingSeconds,
      collectAlternatives, arrivalSlackSeconds, transferPenaltySeconds, walkReluctance }
    const incremental = kernel.routeParetoRoundCsa(request)
    assert.equal(incremental.scalarEnvelopeReused, true)
    const open = kernel.routeParetoRoundCsa({ ...request, restrictionMode: 'anchor-only' })
    assert.deepEqual(metrics(incremental), metrics(open), `Universal envelope, seed ${seed}`)
    assert(incremental.corridorRunSegments <= data.arrivalSeconds.length,
      'An incremental reverse corridor must inspect each run segment at most once across all boarding rounds.')
    assert(incremental.corridorExitEvents <= data.arrivalSeconds.length,
      'An incremental reverse corridor must inspect each fixture exit at most once across all boarding rounds.')
    // No intervening scalar query: the forward envelope now has separate
    // boarding layers, whose masks may change between reverse rounds.
    const layered = kernel.routeParetoRoundCsa(request)
    assert.equal(layered.forwardEnvelopeBuilt, true)
    assert.deepEqual(metrics(layered), metrics(open), `Layered envelope, seed ${seed}`)
    comparisons += 2
  }
}
console.log(`Bounded search matched unrestricted expansion in ${comparisons} seeded comparisons; reverse-work bounds passed.`)

// Each destination has its own egress cost even when endpoints share stops.
// A large result must preserve those costs and must not rescan per target.
const manyKernel = new TimetableKernel(fixture())
const manyRequest = { originStops: [0], originWalkSeconds: [0], departure: 0, horizon: 1800,
  allowPreRideTransfers: false, excludedTrips: [] }
const stopArrivals = manyKernel.routeManyCsa({ ...manyRequest,
  destinationOffsets: Array.from({ length: 13 }, (_, i) => i),
  destinationStops: Array.from({ length: 12 }, (_, i) => i), destinationWalkSeconds: Array(12).fill(0),
})
const largeMany = manyKernel.routeManyCsa({ ...manyRequest,
  destinationOffsets: Array.from({ length: 100_001 }, (_, i) => i),
  destinationStops: Array.from({ length: 100_000 }, (_, i) => i % 12),
  destinationWalkSeconds: Array.from({ length: 100_000 }, (_, i) => i % 17),
})
assert.equal(largeMany.bestArrivals.length, 100_000)
assert.equal(largeMany.scannedDepartures, stopArrivals.scannedDepartures)
for (const [index, arrival] of largeMany.bestArrivals.entries()) {
  assert.equal(arrival, stopArrivals.bestArrivals[index % 12] + index % 17)
}
console.log('Native one-to-many retained all 100,000 destination-specific results in one scan.')

const reverseQuery = { destinationStops: [11], destinationWalkSeconds: [23],
  earliest: 0, deadline: 1800, excludedTrips: [] }
const reverseReferences = [false, true].map(allowPreRideTransfers => Array.from({ length: 12 }, (_, stop) =>
  manyKernel.routeArriveByCsa({ ...reverseQuery, originStops: [stop], originWalkSeconds: [0],
    originCandidateIndices: [0], destinationCandidateIndices: [0], allowPreRideTransfers }).latestDeparture ?? -Infinity))
const reverseInputs = {
  ...reverseQuery, originOffsets: Array.from({ length: 100_001 }, (_, i) => i),
  originStops: Array.from({ length: 100_000 }, (_, i) => i % 12),
  originWalkSeconds: Array.from({ length: 100_000 }, (_, i) => i % 17),
  allowPreRideTransfers: Array.from({ length: 100_000 }, (_, i) => Boolean(i % 2)),
}
const largeReverse = manyKernel.routeArriveByManyCsa(reverseInputs)
assert.equal(largeReverse.latestDepartures.length, 100_000)
for (const [i, latest] of largeReverse.latestDepartures.entries()) {
  const expected = reverseReferences[i % 2][i % 12] - i % 17
  assert.equal(latest, expected >= 0 ? expected : -Infinity)
}
const reverseMatrix = manyKernel.routeMatrixCsa({ ...reverseInputs,
  destinationOffsets: [0, 1], departure: 0, horizon: 1800, arriveBy: true })
assert.deepEqual(reverseMatrix.times, largeReverse.latestDepartures)
assert.equal(reverseMatrix.reverseSearches, 1)
assert.equal(reverseMatrix.forwardSearches, 0)
assert.equal(reverseMatrix.scannedDepartures, largeReverse.scannedDepartures)
assert.throws(() => manyKernel.routeMatrixCsa({ ...reverseInputs,
  originOffsets: [0, 100_001], destinationOffsets: [0, 1], departure: 0, horizon: 1800, arriveBy: true }), /inconsistent/)
console.log('Native many-to-one retained 100,000 origin-specific latest departures, including directed pre-ride transfers, in one reverse scan.')

// Independent whole-ride enumeration checks semantics, not just agreement
// between two native algorithms that could share the same error.
const qualityTrips = [
  [[0, 300], [1, 400], [2, 450]],
  [[2, 460], [5, 700]],
  [[0, 300], [5, 650]],
  [[0, 300], [4, 780]],
  [[3, 560], [5, 600]],
]
const qualityTransfers = [[2, 3, 100]]
const qualityRows = [], qualityTripStart = [0]
qualityTrips.forEach((trip, id) => {
  for (let i = 1; i < trip.length; i += 1) qualityRows.push({
    from: trip[i - 1][0], to: trip[i][0], departure: trip[i - 1][1], arrival: trip[i][1],
    trip: id, sequence: i, first: i === 1,
  })
  qualityTripStart.push(qualityRows.length)
})
const qualityColumn = (key) => Uint32Array.from(qualityRows, (row) => row[key])
const qualityKernel = new TimetableKernel({
  stopCount: 6, runCount: qualityTrips.length,
  departureSeconds: qualityColumn('departure'), arrivalSeconds: qualityColumn('arrival'),
  fromStop: qualityColumn('from'), toStop: qualityColumn('to'), sequence: qualityColumn('sequence'),
  segmentTrip: qualityColumn('trip'), segmentRun: qualityColumn('trip'),
  continuityBreak: Uint8Array.from(qualityRows, (row) => Number(row.first)),
  canBoard: new Uint8Array(qualityRows.length).fill(1), canAlight: new Uint8Array(qualityRows.length).fill(1),
  tripStart: new Uint32Array(qualityTripStart),
  departureOffset: Uint32Array.from({ length: 7 }, (_, stop) => qualityRows.filter((row) => row.from < stop).length),
  departureOrder: Uint32Array.from(qualityRows.map((_, i) => i).sort((a, b) =>
    qualityRows[a].from - qualityRows[b].from || qualityRows[a].departure - qualityRows[b].departure)),
  transferOffset: new Uint32Array([0, 0, 0, 1, 1, 1, 1]),
  transferTo: new Uint32Array([3]), transferDuration: new Uint32Array([100]),
  forbiddenSameStop: new Uint8Array(6),
})
function enumerateQuality(originSeeds, destinationSeeds, departure, deadline, allowPostRideTransfers, maximumBoardings = Infinity, horizon = deadline) {
  const paths = []
  const visit = (stop, time, boards, walking, latest, transferred) => {
    if (boards && (!transferred || allowPostRideTransfers)) {
      for (const [target, egress] of destinationSeeds) if (target === stop && time + egress <= deadline) {
        paths.push({ arrival: time + egress, boards, walking: walking + egress, latest })
      }
    }
    if (boards < maximumBoardings) for (const trip of qualityTrips) for (let board = 0; board < trip.length - 1; board += 1) {
      if (trip[board][0] !== stop || trip[board][1] < time || trip[board][1] > horizon) continue
      for (let alight = board + 1; alight < trip.length; alight += 1) {
        if (trip[alight][1] <= Math.min(deadline, horizon)) visit(trip[alight][0], trip[alight][1], boards + 1, walking,
          boards ? latest : trip[board][1] - walking, false)
      }
    }
    if (boards && !transferred) for (const [from, to, seconds] of qualityTransfers) {
      if (from === stop && time + seconds <= deadline) visit(to, time + seconds, boards, walking + seconds, latest, true)
    }
  }
  for (const [stop, walk] of originSeeds) visit(stop, departure + walk, 0, walk, null, false)
  return paths
}
const qualityOrigins = [[[0, 60]], [[1, 10]], [[2, 0]]]
const qualityDestinations = [[[5, 80], [4, 0]], [[3, 200]], [[5, 0]]]
let qualityComparisons = 0
for (const deadline of [600, 680, 730, 780, 900]) {
  for (const allowPost of [false, true]) for (const maximumBoardings of [undefined, 1, 2, 3]) {
    for (const origins of qualityOrigins) for (const destinations of qualityDestinations) {
      const query = {
        originStops: origins.map((x) => x[0]), originWalkSeconds: origins.map((x) => x[1]), originCandidateIndices: origins.map((_, i) => i),
        destinationStops: destinations.map((x) => x[0]), destinationWalkSeconds: destinations.map((x) => x[1]), destinationCandidateIndices: destinations.map((_, i) => i),
        departure: 0, horizon: deadline, allowPreRideTransfers: false, allowPostRideTransfers: allowPost, maximumBoardings,
      }
      const feasible = enumerateQuality(origins, destinations, 0, deadline, allowPost, maximumBoardings)
      const latest = Math.max(-Infinity, ...feasible.map((p) => p.latest))
      const boundary = qualityKernel.routeArriveByCsa({ ...query, earliest: 0, deadline })
      assert.equal(boundary.latestDeparture ?? -Infinity, latest)
      for (const arriveBy of [false, true]) {
        const matrix = qualityKernel.routeMatrixCsa({ ...query,
          originOffsets: [0, origins.length], destinationOffsets: [0, destinations.length],
          allowPreRideTransfers: [false], allowPostRideTransfers: [allowPost], arriveBy,
        })
        const journeys = qualityKernel.routeMatrixCsa({ ...query, includeJourneys: true,
          originOffsets: [0, origins.length], destinationOffsets: [0, destinations.length],
          allowPreRideTransfers: [false], allowPostRideTransfers: [allowPost], arriveBy,
        })
        assert.deepEqual(journeys.times, matrix.times)
        const candidates = arriveBy ? feasible : enumerateQuality(origins, destinations, 0,
          Infinity, allowPost, maximumBoardings, deadline)
        const expectedJourney = candidates.slice().sort((a, b) =>
          (arriveBy ? b.latest - a.latest : a.arrival - b.arrival)
          || a.boards - b.boards || a.walking - b.walking || a.arrival - b.arrival)[0]
        const journey = journeys.journeys[0]
        if (!expectedJourney) assert.equal(journey, null)
        else {
          assert.deepEqual([journey.arrival, journey.boardings, journey.walkingSeconds],
            [expectedJourney.arrival, expectedJourney.boards, expectedJourney.walking])
          assert.equal(journey.departure, arriveBy ? expectedJourney.latest : 0)
          assert.equal(journey.arrival - journey.departure,
            journey.walkingSeconds + journey.rideSeconds + journey.waitingSeconds)
          assert.equal(journey.legs.filter((leg) => leg.kind === 'ride').length, journey.boardings)
        }
        // Forward horizons bound the timetable, so use an unlimited terminal
        // deadline in the independent reference for this part of the check.
        if (arriveBy) assert.equal(matrix.times[0], latest)
        else {
          const scalar = qualityKernel.routeScalarCsa(query)
          const expectedArrival = Math.min(Infinity, ...enumerateQuality(origins, destinations, 0,
            Infinity, allowPost, maximumBoardings, deadline).map((p) => p.arrival))
          assert.equal(matrix.times[0], expectedArrival)
          assert.equal(scalar.bestArrival ?? Infinity, expectedArrival)
        }
      }
      if (!feasible.length) continue
      query.departure = latest
      const scalar = qualityKernel.routeScalarCsa(query)
      const expected = feasible.filter((p) => p.latest === latest)
        .sort((a, b) => a.boards - b.boards || a.walking - b.walking || a.arrival - b.arrival)[0]
      const candidateWalkingSeconds = scalar.chainDurations.reduce((total, duration, i) =>
        total + ([1, 3].includes(scalar.chainKinds[i]) ? duration : 0), destinations[scalar.bestDestinationIndex][1])
      const request = { ...query, earliestArrival: scalar.bestArrival,
        boardingUpperBound: scalar.bestBoardings, candidateDestinationIndex: scalar.bestDestinationIndex,
        candidateWalkingSeconds, arrivalSlackSeconds: deadline - scalar.bestArrival,
        transferPenaltySeconds: 0, walkReluctance: 0, deadlineObjective: true }
      for (const restrictionMode of ['anchor+both', 'anchor-only']) {
        const best = qualityKernel.routeParetoRoundCsa({ ...request, restrictionMode })
        assert.deepEqual([best.bestBoardings, best.bestWalkingSeconds, best.bestArrival],
          [expected.boards, expected.walking, expected.arrival], `Deadline ${deadline}, post transfers ${allowPost}, ${restrictionMode}`)
        qualityComparisons += 1
      }
    }
  }
}
console.log(`Deadline routing and terminal transfer rules matched independent complete-ride enumeration (${qualityComparisons} comparisons).`)

// Matrix batching must preserve each endpoint set and its own terminal rule,
// while allocating boarding layers only once for the shared scan.
const flattenSeeds = (sets) => ({
  offsets: sets.reduce((a, seeds) => [...a, a.at(-1) + seeds.length], [0]),
  stops: sets.flatMap((seeds) => seeds.map((x) => x[0])),
  walks: sets.flatMap((seeds) => seeds.map((x) => x[1])),
})
for (const maximumBoardings of [1, 2, 3, undefined, 1]) {
  for (const [origins, destinations] of [
    [qualityOrigins, qualityDestinations], [qualityOrigins, qualityDestinations.slice(0, 1)],
    [qualityOrigins.slice(0, 1), qualityDestinations],
  ]) for (const arriveBy of [false, true]) {
    const o = flattenSeeds(origins), d = flattenSeeds(destinations)
    const post = destinations.map((_, i) => i % 2 === 0)
    const actual = qualityKernel.routeMatrixCsa({
      originOffsets: o.offsets, originStops: o.stops, originWalkSeconds: o.walks,
      destinationOffsets: d.offsets, destinationStops: d.stops, destinationWalkSeconds: d.walks,
      departure: 0, horizon: 780, arriveBy, maximumBoardings,
      allowPreRideTransfers: origins.map(() => false), allowPostRideTransfers: post,
    })
    const expected = origins.flatMap((origin) => destinations.map((destination, i) => {
      const paths = enumerateQuality(origin, destination, 0, arriveBy ? 780 : Infinity, post[i], maximumBoardings, 780)
      return arriveBy ? Math.max(-Infinity, ...paths.map((p) => p.latest)) : Math.min(Infinity, ...paths.map((p) => p.arrival))
    }))
    assert.deepEqual(actual.times, expected)
  }
}
for (const maximumBoardings of [1, 3]) {
  const stops = Array.from({ length: 100_000 }, (_, i) => i % 6)
  const offsets = Array.from({ length: stops.length + 1 }, (_, i) => i)
  const many = qualityKernel.routeManyCsa({ originStops: [0], originWalkSeconds: [60],
    destinationOffsets: offsets, destinationStops: stops, destinationWalkSeconds: stops.map(() => 0),
    departure: 0, horizon: 780, maximumBoardings, allowPreRideTransfers: false,
    allowPostRideTransfers: stops.map(() => false), excludedTrips: [],
  })
  const reverse = qualityKernel.routeArriveByManyCsa({ destinationStops: [5], destinationWalkSeconds: [0],
    originOffsets: offsets, originStops: stops, originWalkSeconds: stops.map(() => 0),
    earliest: 0, deadline: 780, maximumBoardings, excludedTrips: [], allowPreRideTransfers: stops.map(() => false), allowPostRideTransfers: false,
  })
  const expectedForward = Array.from({ length: 6 }, (_, stop) => Math.min(Infinity,
    ...enumerateQuality([[0, 60]], [[stop, 0]], 0, Infinity, false, maximumBoardings, 780).map((p) => p.arrival)))
  const expectedReverse = Array.from({ length: 6 }, (_, stop) => Math.max(-Infinity,
    ...enumerateQuality([[stop, 0]], [[5, 0]], 0, 780, false, maximumBoardings).map((p) => p.latest)))
  assert.deepEqual(many.bestArrivals, stops.map((stop) => expectedForward[stop]))
  assert.deepEqual(reverse.latestDepartures, stops.map((stop) => expectedReverse[stop]))
}
console.log('Transfer caps matched independent enumeration for all Matrix shapes and 100,000 forward and reverse targets.')

// Boarding later on the same vehicle can preserve arrival while reducing
// access walking; an earliest-stop label alone cannot certify this tie.
const tie = {
  originStops: [0, 1], originWalkSeconds: [100, 1], originCandidateIndices: [0, 1],
  destinationStops: [2], destinationWalkSeconds: [0], destinationCandidateIndices: [0],
  departure: 0, horizon: 780, allowPreRideTransfers: false, allowPostRideTransfers: false,
}
for (const maximumBoardings of [undefined, 1, 2]) {
  const scalar = qualityKernel.routeScalarCsa({ ...tie, maximumBoardings })
  const candidateWalkingSeconds = scalar.chainDurations.reduce((sum, duration, i) =>
    sum + ([1, 3].includes(scalar.chainKinds[i]) ? duration : 0), 0)
  const pareto = qualityKernel.routeParetoRoundCsa({ ...tie, earliestArrival: scalar.bestArrival,
    boardingUpperBound: scalar.bestBoardings, candidateDestinationIndex: 0, candidateWalkingSeconds,
    arrivalSlackSeconds: 0, transferPenaltySeconds: 0, walkReluctance: 0,
  })
  assert.deepEqual([pareto.bestArrival, pareto.bestBoardings, pareto.bestWalkingSeconds], [450, 1, 1])
}
console.log('Single-boarding walking ties retain the later boarding with identical arrival.')

// A trip may expose a bridged exit at the next departure even when that
// segment's arrival is outside the horizon. Both directions must retain it.
const bridgeKernel = new TimetableKernel({
  stopCount: 4, runCount: 1, departureSeconds: new Uint32Array([300, 500]),
  arrivalSeconds: new Uint32Array([450, 600]), fromStop: new Uint32Array([0, 2]), toStop: new Uint32Array([1, 3]),
  sequence: new Uint32Array([1, 2]), segmentTrip: new Uint32Array([0, 0]), segmentRun: new Uint32Array([0, 0]),
  continuityBreak: new Uint8Array([1, 0]), canBoard: new Uint8Array([1, 1]), canAlight: new Uint8Array([1, 1]),
  tripStart: new Uint32Array([0, 2]), departureOffset: new Uint32Array([0, 1, 1, 2, 2]), departureOrder: new Uint32Array([0, 1]),
  transferOffset: new Uint32Array(5), transferTo: new Uint32Array(), transferDuration: new Uint32Array(), forbiddenSameStop: new Uint8Array(4),
})
for (const arriveBy of [false, true]) {
  const result = bridgeKernel.routeMatrixCsa({ originOffsets: [0, 1], originStops: [0], originWalkSeconds: [0],
    destinationOffsets: [0, 1], destinationStops: [2], destinationWalkSeconds: [0],
    allowPreRideTransfers: [false], allowPostRideTransfers: [false], departure: 0, horizon: 510,
    maximumBoardings: 1, arriveBy, includeJourneys: true })
  assert.equal(result.times[0], arriveBy ? 300 : 500)
  assert.equal(result.journeys[0].legs.find(l => l.kind === 'ride').alightSequence, 1.5)
}

// A final admitted transfer and egress may finish beyond the ride horizon.
const terminalKernel = new TimetableKernel({
  stopCount: 3, runCount: 1, departureSeconds: new Uint32Array([300]), arrivalSeconds: new Uint32Array([450]),
  fromStop: new Uint32Array([0]), toStop: new Uint32Array([1]), sequence: new Uint32Array([1]),
  segmentTrip: new Uint32Array([0]), segmentRun: new Uint32Array([0]), continuityBreak: new Uint8Array([1]),
  canBoard: new Uint8Array([1]), canAlight: new Uint8Array([1]), tripStart: new Uint32Array([0, 1]),
  departureOffset: new Uint32Array([0, 1, 1, 1]), departureOrder: new Uint32Array([0]),
  transferOffset: new Uint32Array([0, 0, 1, 1]), transferTo: new Uint32Array([2]),
  transferDuration: new Uint32Array([90]), forbiddenSameStop: new Uint8Array(3),
})
const terminalResults = terminalKernel.routeMatrixCsa({
  originOffsets: [0, 1], originStops: [0], originWalkSeconds: [0],
  destinationOffsets: Array.from({ length: 1001 }, (_, i) => i), destinationStops: Array(1000).fill(2),
  destinationWalkSeconds: Array.from({ length: 1000 }, (_, i) => 60 + i),
  allowPreRideTransfers: [false], allowPostRideTransfers: Array(1000).fill(true),
  departure: 0, horizon: 450, maximumBoardings: 1, arriveBy: false, includeJourneys: true,
})
assert.equal(terminalResults.forwardSearches, 2)
terminalResults.journeys.forEach((journey, i) => {
  assert.equal(journey.arrival, 600 + i)
  assert.equal(journey.walkingSeconds, 150 + i)
})

// The scalar scan stops before earliest arrival when every destination still
// needs egress walking. A bounded search must resume at that actual boundary.
const envelopeKernel = new TimetableKernel({
  stopCount: 4, runCount: 3,
  departureSeconds: new Uint32Array([50, 80, 160]), arrivalSeconds: new Uint32Array([70, 100, 190]),
  fromStop: new Uint32Array([0, 1, 1]), toStop: new Uint32Array([1, 2, 3]),
  sequence: new Uint32Array([1, 1, 1]), segmentTrip: new Uint32Array([0, 1, 2]), segmentRun: new Uint32Array([0, 1, 2]),
  continuityBreak: new Uint8Array([1, 1, 1]), canBoard: new Uint8Array([1, 1, 1]), canAlight: new Uint8Array([1, 1, 1]),
  tripStart: new Uint32Array([0, 1, 2, 3]), departureOffset: new Uint32Array([0, 1, 3, 3, 3]), departureOrder: new Uint32Array([0, 1, 2]),
  transferOffset: new Uint32Array(5), transferTo: new Uint32Array(), transferDuration: new Uint32Array(), forbiddenSameStop: new Uint8Array(4),
})
const envelopeQuery = { originStops: [0], originWalkSeconds: [0], originCandidateIndices: [0],
  destinationStops: [2, 3], destinationWalkSeconds: [200, 150], destinationCandidateIndices: [0, 1],
  departure: 50, horizon: 350, allowPreRideTransfers: false, allowPostRideTransfers: false }
for (const deadlineObjective of [false, true]) {
  const scalar = envelopeKernel.routeScalarCsa(envelopeQuery)
  assert.equal(scalar.bestArrival, 300)
  const request = { ...envelopeQuery, earliestArrival: 300, boardingUpperBound: 2,
    candidateDestinationIndex: 0, candidateWalkingSeconds: 200, arrivalSlackSeconds: 50,
    transferPenaltySeconds: 0, walkReluctance: 0, collectAlternatives: !deadlineObjective, deadlineObjective }
  const bounded = envelopeKernel.routeParetoRoundCsa(request)
  const reference = envelopeKernel.routeParetoRoundCsa({ ...request, restrictionMode: 'anchor-only' })
  assert.deepEqual(metrics(bounded), metrics(reference))
  if (deadlineObjective) assert.deepEqual([bounded.bestArrival, bounded.bestWalkingSeconds], [340, 150])
  else assert.deepEqual(bounded.alternatives.map((p) => [p.bestArrival, p.bestBoardings, p.bestWalkingSeconds]),
    [[300, 2, 200], [340, 2, 150]])
}
console.log('Bounded envelope resumption preserves departures before earliest arrival but after the scalar egress cutoff.')

// Scalar and bounded operators must admit the same ride events. The horizon
// bounds boardings and ride exits, while a final transfer and egress may finish
// later. Comparing only bounded and anchor-only searches cannot detect a shared
// mistake in that event domain, so these small networks have explicit answers.
function horizonTestKernel(runs, transfers = []) {
  const rows = runs.flatMap((run, trip) => run.map(([from, to, departure, arrival], i) => ({
    from, to, departure, arrival, trip, sequence: i + 1, first: i === 0,
  })))
  const stopCount = 6
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].from - rows[b].from
    || rows[a].departure - rows[b].departure || a - b)
  const offsets = [0], transferOffset = [0], transferTo = [], transferDuration = []
  for (let stop = 0; stop < stopCount; stop += 1) {
    offsets.push(offsets.at(-1) + rows.filter((row) => row.from === stop).length)
    for (const [from, to, duration] of transfers) if (from === stop) {
      transferTo.push(to)
      transferDuration.push(duration)
    }
    transferOffset.push(transferTo.length)
  }
  const column = (key) => new Uint32Array(rows.map((row) => row[key]))
  return new TimetableKernel({
    stopCount, runCount: runs.length,
    departureSeconds: column('departure'), arrivalSeconds: column('arrival'),
    fromStop: column('from'), toStop: column('to'), sequence: column('sequence'),
    segmentTrip: column('trip'), segmentRun: column('trip'),
    continuityBreak: new Uint8Array(rows.map((row) => Number(row.first))),
    canBoard: new Uint8Array(rows.length).fill(1), canAlight: new Uint8Array(rows.length).fill(1),
    tripStart: new Uint32Array(runs.reduce((starts, run) => [...starts, starts.at(-1) + run.length], [0])),
    departureOffset: new Uint32Array(offsets), departureOrder: new Uint32Array(order),
    transferOffset: new Uint32Array(transferOffset), transferTo: new Uint32Array(transferTo),
    transferDuration: new Uint32Array(transferDuration), forbiddenSameStop: new Uint8Array(stopCount),
  })
}
const horizonBaseRuns = [[[0, 1, 100, 150]], [[1, 2, 160, 290]]]
const horizonCases = [
  ...[350, 390].map((arrival) => ({
    name: `ride alights after horizon at ${arrival}`,
    runs: [...horizonBaseRuns, [[0, 3, 100, arrival]]],
    destinations: [[2, 100], [3, 0]], primary: [390, 2, 100],
  })),
  {
    name: 'boarding after horizon',
    runs: [...horizonBaseRuns, [[0, 3, 310, 350]]],
    destinations: [[2, 100], [3, 0]], primary: [390, 2, 100],
  },
  {
    name: 'bridge exit after horizon',
    runs: [...horizonBaseRuns, [[0, 4, 100, 150], [3, 5, 310, 400]]],
    destinations: [[2, 100], [3, 0]], primary: [390, 2, 100],
  },
  {
    name: 'bridge exit at horizon before a later segment arrival',
    runs: [[[0, 1, 100, 150], [2, 3, 300, 400]]],
    destinations: [[2, 90]], primary: [390, 1, 90],
  },
  {
    name: 'terminal transfer and egress after horizon',
    runs: [[[0, 1, 100, 300]]], transfers: [[1, 2, 50]],
    destinations: [[2, 40]], allowPostRideTransfers: true, primary: [390, 1, 90],
  },
  {
    name: 'slack admits later terminal egress with fewer boardings',
    runs: [...horizonBaseRuns, [[0, 3, 100, 290]]],
    destinations: [[2, 100], [3, 140]], primary: [390, 2, 100],
    slackAlternative: [430, 1, 140],
  },
]
let horizonComparisons = 0
for (const example of horizonCases) {
  const makeKernel = () => horizonTestKernel(example.runs, example.transfers)
  const query = {
    originStops: [0], originWalkSeconds: [0], originCandidateIndices: [0],
    destinationStops: example.destinations.map(([stop]) => stop),
    destinationWalkSeconds: example.destinations.map(([, walk]) => walk),
    destinationCandidateIndices: example.destinations.map((_, i) => i),
    departure: 0, horizon: 300, allowPreRideTransfers: false,
    allowPostRideTransfers: example.allowPostRideTransfers === true,
  }
  const anchor = makeKernel().routeScalarCsa(query)
  assert.deepEqual([anchor.bestArrival, anchor.bestBoardings], example.primary.slice(0, 2), example.name)
  const matrix = makeKernel().routeMatrixCsa({ ...query,
    originOffsets: [0, 1], destinationOffsets: [0, query.destinationStops.length],
    allowPreRideTransfers: [false], allowPostRideTransfers: [query.allowPostRideTransfers],
    arriveBy: false, includeJourneys: true,
  })
  assert.equal(matrix.times[0], example.primary[0], example.name)
  assert.deepEqual([matrix.journeys[0].arrival, matrix.journeys[0].boardings,
    matrix.journeys[0].walkingSeconds], example.primary, example.name)
  for (const options of [
    { arrivalSlackSeconds: 0 },
    { arrivalSlackSeconds: 60 },
    { arrivalSlackSeconds: 60, collectAlternatives: true },
    { arrivalSlackSeconds: 60, deadlineObjective: true },
  ]) for (const restrictionMode of ['anchor-only', 'anchor+forward', 'anchor+reverse', 'anchor+both']) {
    for (const reuseScalar of [false, true]) {
      const kernel = makeKernel()
      if (reuseScalar) kernel.routeScalarCsa(query)
      const actual = kernel.routeParetoRoundCsa({ ...query, ...options, restrictionMode,
        earliestArrival: anchor.bestArrival, boardingUpperBound: anchor.bestBoardings,
        candidateDestinationIndex: anchor.bestDestinationIndex, candidateWalkingSeconds: example.primary[2],
        transferPenaltySeconds: 0, walkReluctance: 0,
      })
      const context = `${example.name}, ${JSON.stringify(options)}, ${restrictionMode}, reuse=${reuseScalar}`
      assert.equal(actual.status, 'ready', context)
      const expected = options.deadlineObjective && example.slackAlternative
        ? example.slackAlternative : example.primary
      assert.deepEqual([actual.bestArrival, actual.bestBoardings, actual.bestWalkingSeconds], expected, context)
      const usesForward = ['anchor+forward', 'anchor+both'].includes(restrictionMode)
      assert.equal(actual.scalarEnvelopeReused, reuseScalar && usesForward, context)
      assert.equal(actual.forwardEnvelopeBuilt, !reuseScalar && usesForward, context)
      for (const result of [actual, ...(actual.alternatives ?? [])]) {
        result.chainKinds.forEach((kind, i) => {
          if (kind === 2) assert(result.chainArrivals[i] <= query.horizon, context)
        })
      }
      if (options.collectAlternatives) {
        assert.deepEqual(actual.alternatives.map((plan) =>
          [plan.bestArrival, plan.bestBoardings, plan.bestWalkingSeconds]),
        [example.primary, ...(example.slackAlternative ? [example.slackAlternative] : [])], context)
      }
      horizonComparisons += 1
    }
  }
  // Capped scalar routing internally reconstructs through bounded rounds too.
  const capped = makeKernel().routeScalarCsa({ ...query, maximumBoardings: 2 })
  assert.deepEqual([capped.bestArrival, capped.bestBoardings], example.primary.slice(0, 2), example.name)
}
console.log(`Ride horizons and legal terminal walks matched explicit fixtures (${horizonComparisons} bounded comparisons).`)
