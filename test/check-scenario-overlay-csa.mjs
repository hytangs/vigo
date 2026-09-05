#!/usr/bin/env node

import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const { TimetableKernel } = require(path.join(
  repositoryRoot,
  'native',
  'vigo-routing-kernel',
  'vigo-routing-kernel.node',
))

const transferBoardSlackSeconds = 0
const residentConnections = [
  { from: 0, to: 1, departure: 100, arrival: 200 },
  { from: 2, to: 3, departure: 660, arrival: 760 },
]
const supplementalTransfers = [
  { from: 1, to: 4, duration: 0 },
  { from: 5, to: 2, duration: 0 },
]

function createKernel() {
  return new TimetableKernel({
    stopCount: 4,
    runCount: 2,
    departureSeconds: new Uint32Array([100, 660]),
    arrivalSeconds: new Uint32Array([200, 760]),
    fromStop: new Uint32Array([0, 2]),
    toStop: new Uint32Array([1, 3]),
    sequence: new Uint32Array([1, 1]),
    segmentTrip: new Uint32Array([0, 1]),
    segmentRun: new Uint32Array([0, 1]),
    continuityBreak: new Uint8Array([1, 1]),
    canBoard: new Uint8Array([1, 1]),
    canAlight: new Uint8Array([1, 1]),
    tripStart: new Uint32Array([0, 1, 2]),
    departureOffset: new Uint32Array([0, 1, 1, 2, 2]),
    departureOrder: new Uint32Array([0, 1]),
    transferOffset: new Uint32Array([0, 0, 0, 0, 0]),
    transferTo: new Uint32Array(),
    transferDuration: new Uint32Array(),
    forbiddenSameStop: new Uint8Array([0, 0, 0, 0]),
  })
}

function overlayQuery(serviceStartSeconds) {
  return {
    originStops: [0],
    originWalkSeconds: [0],
    destinationOffsets: [0, 1],
    destinationStops: [3],
    destinationWalkSeconds: [0],
    excludedTrips: [],
    departure: 0,
    horizon: 1_000,
    allowPreRideTransfers: false,
    overlayStopCount: 2,
    directionOffsets: [0, 2],
    directionStops: [0, 1],
    directionStopOffsetsSeconds: [0, 100],
    serviceStartSeconds: [serviceStartSeconds],
    serviceEndSeconds: [serviceStartSeconds],
    serviceHeadwaySeconds: [300],
    supplementalTransferOffsets: [0, 0, 1, 1, 1, 1, 2],
    supplementalTransferTo: [4, 2],
    supplementalTransferDuration: [0, 0],
  }
}

// This deliberately small, test-only temporal reference has no production
// routing role. Every connection is one segment, so exhaustive fixed-point
// relaxation is independent of the resident run-aware CSA implementation.
function smallTemporalReference(serviceStartSeconds) {
  const connections = [
    ...residentConnections,
    {
      from: 4,
      to: 5,
      departure: serviceStartSeconds,
      arrival: serviceStartSeconds + 100,
    },
  ]
  const labels = new Map()
  const key = (stop, hasRide, needsBoardSlack) => `${stop}:${Number(hasRide)}:${Number(needsBoardSlack)}`
  const relax = (stop, arrival, hasRide, needsBoardSlack) => {
    const label = key(stop, hasRide, needsBoardSlack)
    if (arrival >= (labels.get(label) ?? Number.POSITIVE_INFINITY)) return false
    labels.set(label, arrival)
    return true
  }
  relax(0, 0, false, false)
  let changed = true
  let passes = 0
  while (changed) {
    changed = false
    passes += 1
    assert(passes <= 32, 'The finite test reference failed to converge.')
    for (const [label, arrival] of [...labels]) {
      const [stopText, hasRideText] = label.split(':')
      const stop = Number(stopText)
      const hasRide = hasRideText === '1'
      for (const transfer of supplementalTransfers) {
        if (transfer.from !== stop) continue
        changed = relax(
          transfer.to,
          arrival + transfer.duration,
          hasRide,
          hasRide && transfer.duration === 0,
        ) || changed
      }
    }
    for (const connection of connections) {
      for (const [label, arrival] of [...labels]) {
        const [stopText, hasRideText, needsSlackText] = label.split(':')
        if (Number(stopText) !== connection.from) continue
        const hasRide = hasRideText === '1'
        const needsSlack = needsSlackText === '1'
        const ready = arrival + (hasRide && needsSlack ? transferBoardSlackSeconds : 0)
        if (ready > connection.departure) continue
        changed = relax(connection.to, connection.arrival, true, true) || changed
      }
    }
  }
  return Math.min(
    labels.get(key(3, true, false)) ?? Number.POSITIVE_INFINITY,
    labels.get(key(3, true, true)) ?? Number.POSITIVE_INFINITY,
  )
}

const kernel = createKernel()
const baseline = kernel.routeManyCsa({
  originStops: [0],
  originWalkSeconds: [0],
  destinationOffsets: [0, 1],
  destinationStops: [3],
  destinationWalkSeconds: [0],
  excludedTrips: [],
  departure: 0,
  horizon: 1_000,
  allowPreRideTransfers: false,
})
assert.equal(baseline.bestArrivals[0], Number.POSITIVE_INFINITY)

const cases = [
  { serviceStartSeconds: 200, expected: 760, boundary: 'equal-ready-time' },
  { serviceStartSeconds: 199, expected: Number.POSITIVE_INFINITY, boundary: 'one-second-before-ready' },
  { serviceStartSeconds: 561, expected: Number.POSITIVE_INFINITY, boundary: 'misses-baseline-tail' },
]
const results = []
for (const testCase of cases) {
  const result = kernel.routeOverlayManyCsa(overlayQuery(testCase.serviceStartSeconds))
  const nativeArrival = result.timetable.bestArrivals[0]
  const referenceArrival = smallTemporalReference(testCase.serviceStartSeconds)
  assert.equal(nativeArrival, referenceArrival, `Native overlay CSA disagreed with the temporal reference for ${testCase.boundary}.`)
  assert.equal(nativeArrival, testCase.expected)
  assert.equal(result.timetable.algorithm, 'rust_resident_query_overlay_connection_scan_one_to_many')
  assert.equal(result.overlayConnections, 1)
  assert.equal(result.supplementalTransferEdges, 2)
  assert(Number.isFinite(result.compileNs) && result.compileNs >= 0)
  assert(Number.isFinite(result.scanNs) && result.scanNs >= 0)
  assert(result.transientBytes > 0)
  assert(result.workspaceBytes > 0)
  results.push({
    ...testCase,
    expected: Number.isFinite(testCase.expected) ? testCase.expected : 'INF',
    nativeArrival: Number.isFinite(nativeArrival) ? nativeArrival : 'INF',
    referenceArrival: Number.isFinite(referenceArrival) ? referenceArrival : 'INF',
  })
}

console.log(JSON.stringify({
  status: 'passed',
  owner: 'rust_resident_timetable_kernel',
  algorithm: 'rust_resident_query_overlay_connection_scan_one_to_many',
  requiredCounterexample: 'baseline -> zero-duration identity transfer -> overlay -> zero-duration identity transfer -> baseline',
  zeroDurationRule: 'identity transfers are allowed; a subsequent boarding across a zero-second identity edge adds no implicit boarding margin, and equality is boardable',
  differentialReference: 'test-only exhaustive temporal fixed point over one-segment services',
  cases: results,
}, null, 2))
