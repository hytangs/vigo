import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  normalizeNativeMilliseconds,
  orientNativeStreetPathCoordinates,
} from '../src/server/native-routing-kernel.mjs'
import { integralNumber, timingMilliseconds } from '../src/server/number-utils.mjs'

assert.equal(normalizeNativeMilliseconds(2_500_000), 2.5)
assert.equal(normalizeNativeMilliseconds(undefined), 0)
assert.equal(normalizeNativeMilliseconds(Number.NaN), 0)
assert.equal(normalizeNativeMilliseconds(-1), 0)
assert.equal(normalizeNativeMilliseconds(true), 0)
assert.equal(timingMilliseconds(12.3456), 12.346)
assert.equal(timingMilliseconds(Number.NaN), 0)
assert.equal(timingMilliseconds(-1), 0)
assert.equal(timingMilliseconds(Symbol('malformed')), 0)
assert.equal(timingMilliseconds('', null), null)
assert.equal(timingMilliseconds(null, null), null)
assert.equal(integralNumber(480.5), undefined)
assert.equal(integralNumber(Number.NaN), undefined)
assert.equal(integralNumber(true), undefined)

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const bindingPath = path.join(
  repositoryRoot,
  'native',
  'vigo-routing-kernel',
  'vigo-routing-kernel.node',
)
const headerBytes = 4096

function buildAndLoadStreetCch(kernel, temporaryDirectory, name, orderStrategy = 'degree') {
  const structurePath = path.join(temporaryDirectory, `${name}.cch.structure`)
  const metricPath = path.join(temporaryDirectory, `${name}.cch.metric`)
  const built = kernel.buildStreetCchIndex({
    structurePath,
    metricPath,
    orderStrategy,
  })
  assert.equal(built.distanceUnitsPerMeter, 10_000)
  const loaded = kernel.loadStreetCchIndex({ structurePath, metricPath })
  assert.equal(loaded.distanceUnitsPerMeter, 10_000)
  return { structurePath, metricPath, built, loaded }
}

function align(offset, byteAlignment) {
  return Math.ceil(offset / byteAlignment) * byteAlignment
}

function writeFixtureSnapshot(snapshotPath, values, {
  spatialMinLat,
  spatialMinLon,
  spatialCellDegrees,
  spatialRows,
  spatialColumns,
  componentCount,
}) {
  if (!values.reciprocalEdgeFlags) {
    const reciprocalEdgeFlags = new Uint8Array(values.edgeTargets.length)
    for (let source = 0; source + 1 < values.edgeOffsets.length; source += 1) {
      for (let edge = values.edgeOffsets[source]; edge < values.edgeOffsets[source + 1]; edge += 1) {
        const target = values.edgeTargets[edge]
        for (let reverse = values.edgeOffsets[target]; reverse < values.edgeOffsets[target + 1]; reverse += 1) {
          if (values.edgeTargets[reverse] === source) {
            reciprocalEdgeFlags[edge] = 1
            break
          }
        }
      }
    }
    values.reciprocalEdgeFlags = reciprocalEdgeFlags
  }
  if (!values.reverseEdgeIndices) {
    const reverseEdgeIndices = new Uint32Array(values.reverseSources.length)
    const usedEdges = new Uint8Array(values.edgeTargets.length)
    for (let target = 0; target + 1 < values.reverseOffsets.length; target += 1) {
      for (let reverse = values.reverseOffsets[target]; reverse < values.reverseOffsets[target + 1]; reverse += 1) {
        const source = values.reverseSources[reverse]
        const expectedDistance = values.reverseDistances?.[reverse]
        let match = -1
        for (let edge = values.edgeOffsets[source]; edge < values.edgeOffsets[source + 1]; edge += 1) {
          if (usedEdges[edge] || values.edgeTargets[edge] !== target) continue
          if (expectedDistance !== undefined && values.edgeDistances[edge] !== expectedDistance) continue
          match = edge
          break
        }
        assert.notEqual(match, -1, `Unable to derive reverse edge index for ${source}->${target}.`)
        reverseEdgeIndices[reverse] = match
        usedEdges[match] = 1
      }
    }
    values.reverseEdgeIndices = reverseEdgeIndices
  }
  let nextOffset = headerBytes
  const arrays = {}
  for (const [name, value] of Object.entries(values)) {
    nextOffset = align(nextOffset, value.BYTES_PER_ELEMENT)
    arrays[name] = {
      type: value.constructor.name,
      offset: nextOffset,
      length: value.length,
    }
    nextOffset += value.byteLength
  }
  const header = {
    magic: 'vigo.street.accelerator',
    version: 7,
    nodeCount: values.nodeIds.length,
    edgeCount: values.edgeTargets.length,
    spatialMinLat,
    spatialMinLon,
    spatialCellDegrees,
    spatialRows,
    spatialColumns,
    spatialNodeOrder: 'cell_then_source_node_id',
    componentCount,
    arrays,
    byteLength: nextOffset,
  }
  const buffer = Buffer.alloc(nextOffset, 0)
  buffer.fill(0x20, 0, headerBytes)
  Buffer.from(JSON.stringify(header), 'utf8').copy(buffer)
  for (const [name, value] of Object.entries(values)) {
    Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(buffer, arrays[name].offset)
  }
  fs.writeFileSync(snapshotPath, buffer)
}

function buildDirectedFixtureSnapshot(snapshotPath) {
  // Four nodes on a one-way chain:
  //
  //   origin (0) -> stop A (1) -> destination (2) -> stop B (3)
  //
  // B is reachable from the origin but cannot reach the destination. A
  // therefore belongs in both frontiers while B belongs only in the origin
  // frontier. A forward search rooted at the destination would get this
  // egress condition backwards.
  const nodeIds = new Float64Array([10, 11, 12, 13])
  const nodeLats = new Float64Array([38, 38, 38, 38])
  const nodeLons = new Float64Array([0, 0.001, 0.002, 0.003])
  const edgeOffsets = new Uint32Array([0, 1, 2, 3, 3])
  const edgeTargets = new Uint32Array([1, 2, 3])
  const edgeDistances = new Float64Array([100, 100, 100])
  const spatialOffsets = new Uint32Array([0, 2, 4])
  const componentByNode = new Int32Array([0, 0, 0, 0])
  const componentLengthKm = new Float64Array([0.3])
  const reverseOffsets = new Uint32Array([0, 0, 1, 2, 3])
  const reverseSources = new Uint32Array([0, 1, 2])
  const reverseDistances = new Float64Array([100, 100, 100])
  const values = {
    nodeIds,
    nodeLats,
    nodeLons,
    edgeOffsets,
    edgeTargets,
    edgeDistances,
    spatialOffsets,
    componentByNode,
    componentLengthKm,
    reverseOffsets,
    reverseSources,
    reverseDistances,
  }
  writeFixtureSnapshot(snapshotPath, values, {
    spatialMinLat: 38,
    spatialMinLon: 0,
    spatialCellDegrees: 0.002,
    spatialRows: 1,
    spatialColumns: 2,
    componentCount: 1,
  })
}

function buildReciprocalEdgeSnapFixtureSnapshot(snapshotPath, farEndpoint = false) {
  // The query lies on the middle of reciprocal edge 1 <-> 2. Node 0 is a
  // geometrically closer vertex in the same weak component, but reaching the
  // destination through it requires a long detour. Segment projection must
  // seed both edge endpoints and recover the 199-meter path through node 2.
  const values = {
    nodeIds: new Float64Array([20, 21, 22, 23]),
    nodeLats: new Float64Array([38, farEndpoint ? 38.002 : 38.001, 37.999, 37.999]),
    nodeLons: new Float64Array([0.0001, 0, 0, 0.001]),
    edgeOffsets: new Uint32Array([0, 1, 3, 5, 6]),
    edgeTargets: new Uint32Array([1, 0, 2, 1, 3, 2]),
    edgeDistances: new Float64Array(farEndpoint ? [225, 225, 333, 333, 88, 88] : [112, 112, 222, 222, 88, 88]),
    spatialOffsets: new Uint32Array([0, 4]),
    componentByNode: new Int32Array([0, 0, 0, 0]),
    componentLengthKm: new Float64Array([0.422]),
    reverseOffsets: new Uint32Array([0, 1, 3, 5, 6]),
    reverseSources: new Uint32Array([1, 0, 2, 1, 3, 2]),
    reverseDistances: new Float64Array(farEndpoint ? [225, 225, 333, 333, 88, 88] : [112, 112, 222, 222, 88, 88]),
  }
  writeFixtureSnapshot(snapshotPath, values, {
    spatialMinLat: 37.995,
    spatialMinLon: -0.005,
    spatialCellDegrees: 0.01,
    spatialRows: 1,
    spatialColumns: 1,
    componentCount: 1,
  })
}

function buildContractedChainFixtureSnapshot(snapshotPath) {
  // A six-node reciprocal street with four degree-2 interior vertices. Point
  // queries may begin or end on any interior node, so contraction must protect
  // query snaps dynamically and expand the exact raw geometry afterward.
  const values = {
    nodeIds: new Float64Array([50, 51, 52, 53, 54, 55]),
    nodeLats: new Float64Array([38, 38, 38, 38, 38, 38]),
    nodeLons: new Float64Array([0, 0.001, 0.002, 0.003, 0.004, 0.005]),
    edgeOffsets: new Uint32Array([0, 1, 3, 5, 7, 9, 10]),
    edgeTargets: new Uint32Array([1, 0, 2, 1, 3, 2, 4, 3, 5, 4]),
    edgeDistances: new Float64Array([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
    spatialOffsets: new Uint32Array([0, 6]),
    componentByNode: new Int32Array([0, 0, 0, 0, 0, 0]),
    componentLengthKm: new Float64Array([0.5]),
    reverseOffsets: new Uint32Array([0, 1, 3, 5, 7, 9, 10]),
    reverseSources: new Uint32Array([1, 0, 2, 1, 3, 2, 4, 3, 5, 4]),
    reverseDistances: new Float64Array([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
  }
  writeFixtureSnapshot(snapshotPath, values, {
    spatialMinLat: 37.995,
    spatialMinLon: -0.005,
    spatialCellDegrees: 0.02,
    spatialRows: 1,
    spatialColumns: 1,
    componentCount: 1,
  })
}

function buildContractedCycleFixtureSnapshot(snapshotPath) {
  // Every static node has reciprocal degree two. Query terminals must break
  // the cycle dynamically; the shorter side is unique and must match raw
  // Dijkstra exactly.
  const values = {
    nodeIds: new Float64Array([60, 61, 62, 63]),
    nodeLats: new Float64Array([38, 38, 38.001, 38.001]),
    nodeLons: new Float64Array([0, 0.001, 0.001, 0]),
    edgeOffsets: new Uint32Array([0, 2, 4, 6, 8]),
    edgeTargets: new Uint32Array([1, 3, 0, 2, 1, 3, 0, 2]),
    edgeDistances: new Float64Array([100, 400, 100, 100, 100, 400, 400, 400]),
    spatialOffsets: new Uint32Array([0, 4]),
    componentByNode: new Int32Array([0, 0, 0, 0]),
    componentLengthKm: new Float64Array([1]),
    reverseOffsets: new Uint32Array([0, 2, 4, 6, 8]),
    reverseSources: new Uint32Array([1, 3, 0, 2, 1, 3, 0, 2]),
    reverseDistances: new Float64Array([100, 400, 100, 100, 100, 400, 400, 400]),
  }
  writeFixtureSnapshot(snapshotPath, values, {
    spatialMinLat: 37.995,
    spatialMinLon: -0.005,
    spatialCellDegrees: 0.02,
    spatialRows: 1,
    spatialColumns: 1,
    componentCount: 1,
  })
}

function buildProjectedEdgeFrontierFixtureSnapshot(snapshotPath) {
  // The destination lies 1.1 m from the bad edge (1 <-> 2) and 2.2 m from
  // the good edge (3 <-> 4). Greedy projection chooses the bad edge, whose
  // graph connection from origin 0 costs 1,100 m. The complete in-policy
  // frontier must retain the good edge and return the roughly 190 m path.
  const values = {
    nodeIds: new Float64Array([30, 31, 32, 33, 34]),
    nodeLats: new Float64Array([
      37.99998,
      38.00001,
      38.00001,
      37.99998,
      37.99998,
    ]),
    nodeLons: new Float64Array([0.002, -0.001, 0.001, -0.001, 0.001]),
    edgeOffsets: new Uint32Array([0, 1, 2, 4, 5, 8]),
    edgeTargets: new Uint32Array([4, 2, 1, 4, 4, 0, 2, 3]),
    edgeDistances: new Float64Array([100, 176, 176, 1000, 176, 100, 1000, 176]),
    spatialOffsets: new Uint32Array([0, 5]),
    componentByNode: new Int32Array([0, 0, 0, 0, 0]),
    componentLengthKm: new Float64Array([2.452]),
    reverseOffsets: new Uint32Array([0, 1, 2, 4, 5, 8]),
    reverseSources: new Uint32Array([4, 2, 1, 4, 4, 0, 2, 3]),
    reverseDistances: new Float64Array([100, 176, 176, 1000, 176, 100, 1000, 176]),
  }
  writeFixtureSnapshot(snapshotPath, values, {
    spatialMinLat: 37.995,
    spatialMinLon: -0.005,
    spatialCellDegrees: 0.01,
    spatialRows: 1,
    spatialColumns: 1,
    componentCount: 1,
  })
}

function buildDisconnectedBarrierFixtureSnapshot(snapshotPath) {
  // Two reciprocal pedestrian edges are geometrically adjacent but belong to
  // different weak components. Component 0 is deliberately shorter than the
  // retired 250 m fragment threshold. An anchor attaches to its nearest
  // physical edge and cannot bridge the two components.
  const values = {
    nodeIds: new Float64Array([40, 41, 42, 43]),
    nodeLats: new Float64Array([38, 38, 38.0001, 38.0001]),
    nodeLons: new Float64Array([0, 0.001, 0, 0.001]),
    edgeOffsets: new Uint32Array([0, 1, 2, 3, 4]),
    edgeTargets: new Uint32Array([1, 0, 3, 2]),
    edgeDistances: new Float64Array([88, 88, 88, 88]),
    spatialOffsets: new Uint32Array([0, 4]),
    componentByNode: new Int32Array([0, 0, 1, 1]),
    componentLengthKm: new Float64Array([0.088, 1]),
    reverseOffsets: new Uint32Array([0, 1, 2, 3, 4]),
    reverseSources: new Uint32Array([1, 0, 3, 2]),
    reverseDistances: new Float64Array([88, 88, 88, 88]),
  }
  writeFixtureSnapshot(snapshotPath, values, {
    spatialMinLat: 37.995,
    spatialMinLon: -0.005,
    spatialCellDegrees: 0.01,
    spatialRows: 1,
    spatialColumns: 1,
    componentCount: 2,
  })
}

assert.equal(
  fs.existsSync(bindingPath),
  true,
  'Rust routing binding is missing; run npm run build:rust-routing-kernel.',
)

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-rust-kernel-'))
try {
  const snapshotPath = path.join(temporaryDirectory, 'directed.street-accelerator-v7.bin')
  buildDirectedFixtureSnapshot(snapshotPath)
  const { CoordinateKernel, DriveKernel, TimetableKernel } = require(bindingPath)
  const overflowingSnapshotPath = path.join(temporaryDirectory, 'overflowing.street-accelerator-v7.bin')
  const overflowingSnapshot = fs.readFileSync(snapshotPath)
  const headerText = overflowingSnapshot.subarray(0, headerBytes).toString('utf8').trim()
  const overflowingHeader = headerText.replace(
    /("reciprocalEdgeFlags":[{]"type":"Uint8Array","offset":)\d+/u,
    (_match, prefix) => `${prefix}18446744073709551615`,
  )
  assert.notEqual(overflowingHeader, headerText, 'Fixture header must expose reciprocalEdgeFlags.')
  overflowingSnapshot.fill(0x20, 0, headerBytes)
  Buffer.from(overflowingHeader, 'utf8').copy(overflowingSnapshot)
  fs.writeFileSync(overflowingSnapshotPath, overflowingSnapshot)
  assert.throws(
    () => new CoordinateKernel(overflowingSnapshotPath),
    /overflows/,
    'A maximal persisted array offset must fail before native pointer construction.',
  )
  assert.throws(
    () => new TimetableKernel({
      stopCount: 2,
      runCount: 1,
      departureSeconds: new Uint32Array([10]),
      arrivalSeconds: new Uint32Array([20]),
      fromStop: new Uint32Array([0]),
      toStop: new Uint32Array([1]),
      sequence: new Uint32Array([1]),
      segmentTrip: new Uint32Array([0]),
      segmentRun: new Uint32Array([0]),
      continuityBreak: new Uint8Array([1]),
      canBoard: new Uint8Array([1]),
      canAlight: new Uint8Array([1]),
      tripStart: new Uint32Array([0, 1]),
      departureOffset: new Uint32Array([0, 1, 1]),
      departureOrder: new Uint32Array([0]),
      transferOffset: new Uint32Array([0, 1, 1]),
      transferTo: new Uint32Array([2]),
      transferDuration: new Uint32Array([60]),
      forbiddenSameStop: new Uint8Array([0, 0]),
    }),
    /arrays are inconsistent/,
    'An out-of-range transfer target must return a N-API error without aborting Node.',
  )
  const horizonBoundaryKernel = new TimetableKernel({
    stopCount: 3,
    runCount: 2,
    departureSeconds: new Uint32Array([90, 285]),
    arrivalSeconds: new Uint32Array([105, 295]),
    fromStop: new Uint32Array([0, 1]),
    toStop: new Uint32Array([1, 2]),
    sequence: new Uint32Array([1, 1]),
    segmentTrip: new Uint32Array([0, 1]),
    segmentRun: new Uint32Array([0, 1]),
    continuityBreak: new Uint8Array([1, 1]),
    canBoard: new Uint8Array([1, 1]),
    canAlight: new Uint8Array([1, 1]),
    tripStart: new Uint32Array([0, 1, 2]),
    departureOffset: new Uint32Array([0, 1, 2, 2]),
    departureOrder: new Uint32Array([0, 1]),
    transferOffset: new Uint32Array([0, 0, 0, 0]),
    transferTo: new Uint32Array(),
    transferDuration: new Uint32Array(),
    forbiddenSameStop: new Uint8Array([0, 0, 0]),
  })
  const horizonBoundaryQuery = {
    originStops: [0],
    originWalkSeconds: [0],
    originCandidateIndices: [0],
    destinationStops: [2],
    destinationWalkSeconds: [20],
    destinationCandidateIndices: [0],
    departure: 0,
    horizon: 300,
    allowPreRideTransfers: false,
  }
  const horizonBoundaryScalar = horizonBoundaryKernel.routeScalarCsa(
    horizonBoundaryQuery,
  )
  assert.equal(horizonBoundaryScalar.status, 'ready')
  assert.equal(horizonBoundaryScalar.bestArrival, 315)
  assert.equal(horizonBoundaryScalar.bestBoardings, 2)
  const horizonBoundaryPareto = horizonBoundaryKernel.routeParetoRoundCsa({
    ...horizonBoundaryQuery,
    earliestArrival: horizonBoundaryScalar.bestArrival,
    boardingUpperBound: horizonBoundaryScalar.bestBoardings,
    candidateDestinationIndex: horizonBoundaryScalar.bestDestinationIndex,
    candidateWalkingSeconds: 20,
    arrivalSlackSeconds: 0,
    transferPenaltySeconds: 0,
    walkReluctance: 0,
  })
  assert.equal(
    horizonBoundaryPareto.status,
    'ready',
    'The exact Pareto corridor must retain a scalar witness whose final arrival exceeds the connection-departure horizon.',
  )
  assert.equal(horizonBoundaryPareto.bestArrival, 315)
  const equalArrivalBoardingTieKernel = new TimetableKernel({
    stopCount: 3,
    runCount: 3,
    departureSeconds: new Uint32Array([0, 300, 200]),
    arrivalSeconds: new Uint32Array([100, 400, 400]),
    fromStop: new Uint32Array([0, 1, 0]),
    toStop: new Uint32Array([1, 2, 2]),
    sequence: new Uint32Array([1, 1, 1]),
    segmentTrip: new Uint32Array([0, 1, 2]),
    segmentRun: new Uint32Array([0, 1, 2]),
    continuityBreak: new Uint8Array([1, 1, 1]),
    canBoard: new Uint8Array([1, 1, 1]),
    canAlight: new Uint8Array([1, 1, 1]),
    tripStart: new Uint32Array([0, 1, 2, 3]),
    departureOffset: new Uint32Array([0, 2, 3, 3]),
    departureOrder: new Uint32Array([0, 2, 1]),
    transferOffset: new Uint32Array([0, 0, 0, 0]),
    transferTo: new Uint32Array(),
    transferDuration: new Uint32Array(),
    forbiddenSameStop: new Uint8Array([0, 0, 0]),
  })
  const equalArrivalBoardingTie = equalArrivalBoardingTieKernel.routeScalarCsa({
    originStops: [0],
    originWalkSeconds: [0],
    originCandidateIndices: [0],
    destinationStops: [2],
    destinationWalkSeconds: [0],
    destinationCandidateIndices: [0],
    departure: 0,
    horizon: 500,
    allowPreRideTransfers: false,
  })
  assert.equal(equalArrivalBoardingTie.status, 'ready')
  assert.equal(equalArrivalBoardingTie.bestArrival, 400)
  assert.equal(
    equalArrivalBoardingTie.bestBoardings,
    1,
    'The scalar pass must choose the exhaustive one-boarding witness on an exact arrival tie.',
  )
  assert.deepEqual(equalArrivalBoardingTie.chainTripOrCandidate, [0, 2])
  const transferEgressKernel = new TimetableKernel({
    stopCount: 3,
    runCount: 1,
    departureSeconds: new Uint32Array([100]),
    arrivalSeconds: new Uint32Array([200]),
    fromStop: new Uint32Array([0]),
    toStop: new Uint32Array([1]),
    sequence: new Uint32Array([1]),
    segmentTrip: new Uint32Array([0]),
    segmentRun: new Uint32Array([0]),
    continuityBreak: new Uint8Array([1]),
    canBoard: new Uint8Array([1]),
    canAlight: new Uint8Array([1]),
    tripStart: new Uint32Array([0, 1]),
    departureOffset: new Uint32Array([0, 1, 1, 1]),
    departureOrder: new Uint32Array([0]),
    transferOffset: new Uint32Array([0, 0, 1, 1]),
    transferTo: new Uint32Array([2]),
    transferDuration: new Uint32Array([30]),
    forbiddenSameStop: new Uint8Array([0, 0, 0]),
  })
  const transferEgressQuery = {
    originStops: [0],
    originWalkSeconds: [0],
    originCandidateIndices: [0],
    destinationStops: [2],
    destinationWalkSeconds: [0],
    destinationCandidateIndices: [0],
    departure: 0,
    horizon: 300,
    allowPreRideTransfers: false,
  }
  const transferEgressScalar = transferEgressKernel.routeScalarCsa(
    transferEgressQuery,
  )
  assert.equal(transferEgressScalar.status, 'ready')
  assert.equal(transferEgressScalar.bestArrival, 230)
  assert.deepEqual(transferEgressScalar.chainKinds, [3, 2, 1])
  const transferEgressMany = transferEgressKernel.routeManyCsa({
    originStops: [0],
    originWalkSeconds: [0],
    destinationOffsets: [0, 1],
    destinationStops: [2],
    destinationWalkSeconds: [0],
    excludedTrips: [],
    departure: 0,
    horizon: 300,
    allowPreRideTransfers: false,
  })
  assert.equal(transferEgressMany.status, 'complete')
  assert.deepEqual(transferEgressMany.bestArrivals, [230])
  const lateAccessMany = transferEgressKernel.routeManyCsa({
    originStops: [0],
    originWalkSeconds: [150],
    destinationOffsets: [0, 1],
    destinationStops: [2],
    destinationWalkSeconds: [0],
    excludedTrips: [],
    departure: 0,
    horizon: 300,
    allowPreRideTransfers: false,
  })
  assert.deepEqual(
    lateAccessMany.bestArrivals,
    [Number.POSITIVE_INFINITY],
    'One-to-many routing must not scan before coordinate access reaches the origin stop.',
  )
  const excludedTripMany = transferEgressKernel.routeManyCsa({
    originStops: [0],
    originWalkSeconds: [0],
    destinationOffsets: [0, 1],
    destinationStops: [2],
    destinationWalkSeconds: [0],
    excludedTrips: [0],
    departure: 0,
    horizon: 300,
    allowPreRideTransfers: false,
  })
  assert.deepEqual(excludedTripMany.bestArrivals, [Number.POSITIVE_INFINITY])
  assert.equal(excludedTripMany.excludedDepartures, 1)
  const transferEgressPareto = transferEgressKernel.routeParetoRoundCsa({
    ...transferEgressQuery,
    earliestArrival: transferEgressScalar.bestArrival,
    boardingUpperBound: transferEgressScalar.bestBoardings,
    candidateDestinationIndex: transferEgressScalar.bestDestinationIndex,
    candidateWalkingSeconds: 30,
    arrivalSlackSeconds: 0,
    transferPenaltySeconds: 0,
    walkReluctance: 0,
  })
  assert.equal(transferEgressPareto.status, 'ready')
  assert.equal(transferEgressPareto.bestArrival, 230)
  const mixedOverlayKernel = new TimetableKernel({
    stopCount: 4,
    runCount: 2,
    departureSeconds: new Uint32Array([100, 800]),
    arrivalSeconds: new Uint32Array([200, 900]),
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
  const baselineOnlyMixedQuery = mixedOverlayKernel.routeManyCsa({
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
  assert.equal(baselineOnlyMixedQuery.bestArrivals[0], Number.POSITIVE_INFINITY)
  const mixedOverlayRequest = {
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
    serviceStartSeconds: [450],
    serviceEndSeconds: [450],
    serviceHeadwaySeconds: [300],
    supplementalTransferOffsets: [0, 0, 1, 1, 1, 1, 2],
    supplementalTransferTo: [4, 2],
    supplementalTransferDuration: [50, 50],
  }
  const mixedOverlayQuery = mixedOverlayKernel.routeOverlayManyCsa(mixedOverlayRequest)
  assert.equal(mixedOverlayQuery.timetable.status, 'complete')
  assert.equal(mixedOverlayQuery.timetable.bestArrivals[0], 900)
  assert.equal(
    mixedOverlayQuery.timetable.algorithm,
    'rust_resident_query_overlay_connection_scan_one_to_many',
  )
  assert.equal(mixedOverlayQuery.overlayConnections, 1)
  assert.equal(mixedOverlayQuery.overlayRuns, 1)
  assert.equal(mixedOverlayQuery.supplementalTransferEdges, 2)
  assert(Number.isFinite(mixedOverlayQuery.compileNs) && mixedOverlayQuery.compileNs >= 0)
  assert(Number.isFinite(mixedOverlayQuery.scanNs) && mixedOverlayQuery.scanNs >= 0)
  assert(mixedOverlayQuery.transientBytes > 0)
  assert(mixedOverlayQuery.workspaceBytes > 0)
  for (const maximumBoardings of [1, 2, 3, undefined, 3, 1]) {
    const capped = mixedOverlayKernel.routeOverlayManyCsa({ ...mixedOverlayRequest, maximumBoardings })
    assert.equal(capped.timetable.bestArrivals[0], maximumBoardings < 3 ? Infinity : 900)
  }
  const driveCchStructurePath = path.join(temporaryDirectory, 'drive.cch.structure')
  const driveCchTimeMetricPath = path.join(temporaryDirectory, 'drive.cch.time.metric')
  const driveCchDistanceMetricPath = path.join(temporaryDirectory, 'drive.cch.distance.metric')
  const driveKernel = new DriveKernel({
    nodeCount: 3,
    nodeLats: new Float64Array([38, 38, 38]),
    nodeLons: new Float64Array([0, 0.001, 0.002]),
    edgeOffsets: new Uint32Array([0, 2, 3, 3]),
    edgeTargets: new Uint32Array([1, 1, 2]),
    edgeDistances: new Float64Array([6, 1, 2]),
    edgeTravelTimes: new Float64Array([1, 5, 1]),
    cchStructurePath: driveCchStructurePath,
    cchTimeMetricPath: driveCchTimeMetricPath,
    cchDistanceMetricPath: driveCchDistanceMetricPath,
  })
  assert.equal(driveKernel.diagnostics().cchSource, 'built_mmap')
  const constrainedDrive = driveKernel.routeExact({
    originNodes: [0],
    originSnapMeters: [0],
    targetNodes: [2],
    targetSnapMeters: [0],
    maximumDistanceMeters: 7,
  })
  assert.equal(constrainedDrive.status, 'ready')
  assert.equal(constrainedDrive.durationSeconds, 6)
  assert.equal(constrainedDrive.distanceMeters, 3)
  assert.deepEqual(constrainedDrive.nodeIndices, [0, 1, 2])
  assert.equal(
    constrainedDrive.algorithm,
    'rust_cch_candidate_exact_resource_constrained_fallback',
  )
  assert.equal(constrainedDrive.fallbackUsed, true)
  assert.equal(constrainedDrive.cchAccelerated, true)
  const certifiedDrive = driveKernel.routeExact({
    originNodes: [0],
    originSnapMeters: [0],
    targetNodes: [2],
    targetSnapMeters: [0],
    maximumDistanceMeters: 20,
  })
  assert.equal(certifiedDrive.status, 'ready')
  assert.equal(certifiedDrive.durationSeconds, 2)
  assert.equal(certifiedDrive.distanceMeters, 8)
  assert.deepEqual(certifiedDrive.nodeIndices, [0, 1, 2])
  assert.equal(
    certifiedDrive.algorithm,
    'rust_cch_time_distance_certified',
  )
  assert.equal(certifiedDrive.fallbackUsed, false)
  assert.equal(certifiedDrive.cchAccelerated, true)
  const infeasibleDrive = driveKernel.routeExact({
    originNodes: [0, 1],
    originSnapMeters: [0, 10],
    targetNodes: [2],
    targetSnapMeters: [0],
    maximumDistanceMeters: 2,
  })
  assert.equal(infeasibleDrive.status, 'blocked')
  assert.equal(infeasibleDrive.algorithm, 'rust_cch_distance_infeasible')
  assert.equal(infeasibleDrive.cchCandidateQueries, 2)
  const reloadedDriveKernel = new DriveKernel({
    nodeCount: 3,
    nodeLats: new Float64Array([38, 38, 38]),
    nodeLons: new Float64Array([0, 0.001, 0.002]),
    edgeOffsets: new Uint32Array([0, 2, 3, 3]),
    edgeTargets: new Uint32Array([1, 1, 2]),
    edgeDistances: new Float64Array([6, 1, 2]),
    edgeTravelTimes: new Float64Array([1, 5, 1]),
    cchStructurePath: driveCchStructurePath,
    cchTimeMetricPath: driveCchTimeMetricPath,
    cchDistanceMetricPath: driveCchDistanceMetricPath,
  })
  assert.equal(reloadedDriveKernel.diagnostics().cchSource, 'existing_mmap')
  const incompleteDriveCchStructure = path.join(temporaryDirectory, 'drive-incomplete.cch.structure')
  fs.copyFileSync(driveCchStructurePath, incompleteDriveCchStructure)
  assert.throws(
    () => new DriveKernel({
      nodeCount: 3,
      nodeLats: new Float64Array([38, 38, 38]),
      nodeLons: new Float64Array([0, 0.001, 0.002]),
      edgeOffsets: new Uint32Array([0, 2, 3, 3]),
      edgeTargets: new Uint32Array([1, 1, 2]),
      edgeDistances: new Float64Array([6, 1, 2]),
      edgeTravelTimes: new Float64Array([1, 5, 1]),
      cchStructurePath: incompleteDriveCchStructure,
      cchTimeMetricPath: path.join(temporaryDirectory, 'drive-incomplete.cch.time.metric'),
      cchDistanceMetricPath: path.join(temporaryDirectory, 'drive-incomplete.cch.distance.metric'),
    }),
    /incomplete/,
  )
  const kernel = new CoordinateKernel(snapshotPath)
  const surfaceKernel = new CoordinateKernel(snapshotPath)
  const surfaceProfile = {
    profileKey: 'directed-station-egress',
    memberLons: [0.003, 0.001], memberLats: [38, 38],
    memberOriginEligible: [1, 1], memberDestinationEligible: [1, 1],
    memberStopKeys: [0, 1], memberStationKeys: [0, 1],
    anchorLons: [0.001], anchorLats: [38], anchorMemberOffsets: [0, 1], anchorMemberIndices: [1],
    transferFromStopKeys: [0], transferToStopKeys: [1], transferToStationKeys: [1],
    transferMinDurations: [120], transferPathDistancesM: [150], transferOsmCertified: [0],
    walkingSpeedKph: 4.8,
  }
  surfaceKernel.setAccessProfile(surfaceProfile)
  const surfaceQuery = {
    bounds: [-0.001, 37.999, 0.004, 38.001], width: 48, height: 48,
    seedCoordinates: [-10, 0, 0.003, 38], seedDurationsMinutes: [0, 5], seedMemberIndices: [-1, 0],
    maximumWalkM: 250, walkSpeedKph: 4.8, maximumDurationMinutes: 20,
    independentTerminalWalk: false, includeNodes: true, nodeEvidenceLimit: 100,
    includeEdges: true, edgeEvidenceLimit: 0, expandBoundsToReachedEdges: true,
  }
  const stationSurface = surfaceKernel.streetSurface(surfaceQuery)
  assert.deepEqual(stationSurface.nodeEvidence.map(n => [n.longitude, n.durationMinutes, n.walkDistanceM]).sort(),
    [[0.001, 7, 150], [0.002, 8.25, 250]],
    'Reach must leave a platform through its entrance, pay the pathway time, and charge its distance to the final walk.')
  surfaceKernel.setAccessProfile({ ...surfaceProfile, profileKey: 'entrance-only',
    transferFromStopKeys: [1], transferToStopKeys: [0], transferToStationKeys: [0] })
  assert.equal(surfaceKernel.streetSurface(surfaceQuery).nodeEvidence.length, 0,
    'An entrance-only pathway cannot become a platform exit through coordinate snapping.')
  assert.throws(() => surfaceKernel.streetSurface({ ...surfaceQuery, seedMemberIndices: [0] }), /inconsistent/)
  assert.throws(() => surfaceKernel.streetSurface({ ...surfaceQuery, seedMemberIndices: [-1, 9] }), /Invalid.*member/)
  assert.throws(() => surfaceKernel.streetSurface({ ...surfaceQuery, seedMemberIndices: undefined,
    seedWalkDistancesM: [0, -1] }), /walking distances/)
  const directedCch = buildAndLoadStreetCch(kernel, temporaryDirectory, 'directed')
  const diagnostics = kernel.diagnostics()
  assert.equal(diagnostics.nodeCount, 4)
  assert.equal(diagnostics.edgeCount, 3)
  assert.equal(diagnostics.reverseEdgeCount, 3)

  const profile = kernel.setAccessProfile({
    profileKey: 'directed-fixture-v1',
    anchorLons: [0.001, 0.003],
    anchorLats: [38, 38],
    anchorMemberOffsets: [0, 2, 3],
    anchorMemberIndices: [0, 2, 1],
    memberLons: [0.001, 0.003, 0.001],
    memberLats: [38, 38, 38],
    memberOriginEligible: [1, 1, 0],
    memberDestinationEligible: [1, 1, 0],
  })
  assert.equal(profile.snappedMemberCount, 3)
  assert(profile.snapReferenceCount > profile.snapCount)
  assert(profile.snapStorageDeduplicationRatio > 1)
  const accessProfileSnapshotPath = path.join(temporaryDirectory, 'access-profile.bin')
  const persistedProfile = kernel.persistAccessProfileSnapshot(accessProfileSnapshotPath)
  assert.equal(persistedProfile.profileKey, 'directed-fixture-v1')
  assert(persistedProfile.snapshotBytes > 0)
  const obsoleteProfilePath = path.join(temporaryDirectory, 'obsolete-access-profile.bin')
  const obsoleteProfileBytes = fs.readFileSync(accessProfileSnapshotPath)
  obsoleteProfileBytes.writeUInt32LE(4, 8)
  fs.writeFileSync(obsoleteProfilePath, obsoleteProfileBytes)
  assert.throws(() => new CoordinateKernel(snapshotPath).loadAccessProfileSnapshot(obsoleteProfilePath, 'directed-fixture-v1'),
    /unsupported schema/, 'Old stop attachments must not survive a snapping-policy change')
  const reloadedKernel = new CoordinateKernel(snapshotPath)
  reloadedKernel.loadStreetCchIndex({
    structurePath: directedCch.structurePath,
    metricPath: directedCch.metricPath,
  })
  const reloadedProfile = reloadedKernel.loadAccessProfileSnapshot(
    accessProfileSnapshotPath,
    'directed-fixture-v1',
  )
  assert.equal(reloadedProfile.snapshotBytes, persistedProfile.snapshotBytes)
  assert.equal(reloadedKernel.profileDiagnostics().profileKey, 'directed-fixture-v1')
  assert.throws(
    () => new CoordinateKernel(snapshotPath).loadAccessProfileSnapshot(
      accessProfileSnapshotPath,
      'wrong-profile-key',
    ),
    /identity does not match/,
  )

  const request = {
    originLon: 0,
    originLat: 38,
    destinationLon: 0.002,
    destinationLat: 38,
    maximumWalkM: 400,
  }
  const first = kernel.routeEndpoints(request)
  const reloadedFirst = reloadedKernel.routeEndpoints(request)
  assert.deepEqual(reloadedFirst.originMemberIndices, first.originMemberIndices)
  assert.deepEqual(reloadedFirst.originDistancesM, first.originDistancesM)
  assert.deepEqual(reloadedFirst.destinationMemberIndices, first.destinationMemberIndices)
  assert.deepEqual(reloadedFirst.destinationDistancesM, first.destinationDistancesM)
  assert.deepEqual(first.originMemberIndices, [0, 1])
  assert.deepEqual(first.originDistancesM.map(Math.round), [100, 300])
  assert.deepEqual(first.destinationMemberIndices, [0])
  assert.deepEqual(first.destinationDistancesM.map(Math.round), [100])
  assert.equal(first.cacheHit, false)

  const destinationPath = kernel.materializePath({
    queryToken: first.queryToken,
    role: 'destination',
    memberIndex: 0,
    maximumPoints: 32,
  })
  assert.deepEqual(destinationPath.coordinates, [
    0.001, 38,
    0.002, 38,
  ])
  assert.deepEqual(
    orientNativeStreetPathCoordinates([
      [0.001, 38],
      [0.002, 38],
    ], 'destination'),
    [
      [0.002, 38],
      [0.001, 38],
    ],
    'The destination frontier must enter itinerary assembly in clicked-point-to-stop order.',
  )
  assert.deepEqual(
    orientNativeStreetPathCoordinates([
      [0, 38],
      [0.001, 38],
    ], 'origin'),
    [
      [0, 38],
      [0.001, 38],
    ],
    'The origin frontier is already ordered from the clicked point to the stop.',
  )

  const repeated = kernel.routeEndpoints(request)
  assert.equal(repeated.cacheHit, true)
  assert.equal(repeated.originCacheHit, true)
  assert.equal(repeated.destinationCacheHit, true)
  assert.deepEqual(repeated.destinationMemberIndices, [0])
  const retimed = kernel.routeEndpoints({ ...request, walkingSpeedKph: 2.4 })
  assert.equal(retimed.cacheHit, true, 'A timing override must reuse the immutable street frontier.')
  assert(
    retimed.originAccessSeconds[0] >= first.originAccessSeconds[0] * 2 - 1
      && retimed.originAccessSeconds[0] <= first.originAccessSeconds[0] * 2,
    'Halving walking speed must retime the cached frontier within the one-second ceiling bound.',
  )
  assert(
    retimed.destinationAccessSeconds[0] >= first.destinationAccessSeconds[0] * 2 - 1
      && retimed.destinationAccessSeconds[0] <= first.destinationAccessSeconds[0] * 2,
    'Destination retiming must obey the same one-second ceiling bound.',
  )
  const cachedProfile = kernel.profileDiagnostics()
  assert.equal(cachedProfile.endpointCacheEntries, 2)
  assert(cachedProfile.endpointCacheEstimatedBytes > 0)
  assert.equal(cachedProfile.endpointCacheMaximumEntriesPerRole, 100_000)
  assert.equal(cachedProfile.endpointCacheMaximumBytesPerRole, 64 * 1024 * 1024)
  assert(
    cachedProfile.endpointCacheEstimatedBytes
      <= 2 * cachedProfile.endpointCacheMaximumBytesPerRole,
  )

  const outsidePrimaryAttachment = kernel.routeEndpoints({
    originLon: 0,
    originLat: 38.001,
    destinationLon: 0.002,
    destinationLat: 38.001,
    maximumWalkM: 400,
  })
  assert.deepEqual(
    outsidePrimaryAttachment.originMemberIndices,
    [0],
    'The recovery neighborhood must attach an endpoint to a real OSM component when the nearest node is outside the primary snap radius.',
  )
  assert.deepEqual(
    outsidePrimaryAttachment.destinationMemberIndices,
    [0],
    'Origin and destination endpoints must share the same graph-backed recovery behavior.',
  )

  const recoveredPointPath = kernel.routePath({
    originLon: 0,
    originLat: 38.001,
    destinationLon: 0.002,
    destinationLat: 38.001,
    maximumDistanceM: 600,
    maximumPoints: 32,
  })
  assert.equal(
    recoveredPointPath.found,
    true,
    'Point-to-point walking must use the declared recovery radius when both endpoints are outside the primary snap radius.',
  )
  assert(recoveredPointPath.originSnapDistanceM > 80)
  assert(recoveredPointPath.originSnapDistanceM <= 160)
  assert(recoveredPointPath.destinationSnapDistanceM > 80)
  assert(recoveredPointPath.destinationSnapDistanceM <= 160)
  assert(
    Math.abs(
      recoveredPointPath.distanceM
        - recoveredPointPath.originSnapDistanceM
        - 200
        - recoveredPointPath.destinationSnapDistanceM,
    ) < 1e-6,
    'Recovery connectors must remain fully charged in the point-to-point distance.',
  )
  const outsideRecoveryPointPath = kernel.routePath({
    originLon: 0,
    originLat: 38.002,
    destinationLon: 0.002,
    destinationLat: 38,
    maximumDistanceM: 1000,
    maximumPoints: 32,
  })
  assert.equal(
    outsideRecoveryPointPath.found,
    false,
    'Point-to-point walking must remain blocked outside the declared recovery radius.',
  )

  const forwardPath = kernel.routePath({
    originLon: 0,
    originLat: 38,
    destinationLon: 0.002,
    destinationLat: 38,
    maximumDistanceM: 400,
    maximumPoints: 32,
  })
  assert.equal(forwardPath.found, true)
  assert.equal(Math.round(forwardPath.distanceM), 200)
  assert.deepEqual(
    forwardPath.coordinates,
    [0, 38, 0.001, 38, 0.002, 38],
    'Native point geometry must be ordered from the requested origin to the destination.',
  )
  const impossibleReversePath = kernel.routePath({
    originLon: 0.002,
    originLat: 38,
    destinationLon: 0,
    destinationLat: 38,
    maximumDistanceM: 400,
    maximumPoints: 32,
  })
  assert.equal(impossibleReversePath.found, false)
  const memberPath = kernel.routeAccessMemberPath({
    originMemberIndex: 0,
    destinationMemberIndex: 1,
    maximumDistanceM: 400,
    maximumPoints: 32,
  })
  assert.equal(memberPath.found, true)
  assert.equal(Math.round(memberPath.distanceM), 200)
  const impossibleReverseMemberPath = kernel.routeAccessMemberPath({
    originMemberIndex: 1,
    destinationMemberIndex: 0,
    maximumDistanceM: 400,
    maximumPoints: 32,
  })
  assert.equal(
    impossibleReverseMemberPath.found,
    false,
    'Member-path materialization must preserve directed anchor connectivity.',
  )

  const reciprocalSnapshotPath = path.join(temporaryDirectory, 'reciprocal-edge-snap.street-accelerator-v7.bin')
  buildReciprocalEdgeSnapFixtureSnapshot(reciprocalSnapshotPath)
  const reciprocalKernel = new CoordinateKernel(reciprocalSnapshotPath)
  buildAndLoadStreetCch(reciprocalKernel, temporaryDirectory, 'reciprocal-edge-snap')
  const projectedPath = reciprocalKernel.routePath({
    originLon: 0,
    originLat: 38,
    destinationLon: 0.001,
    destinationLat: 37.999,
    maximumDistanceM: 400,
    maximumPoints: 32,
  })
  assert.equal(projectedPath.found, true)
  assert.equal(Math.round(projectedPath.distanceM), 199)
  assert.equal(Math.round(projectedPath.originSnapDistanceM), 111)
  assert.deepEqual(
    projectedPath.coordinates,
    [0, 37.999, 0.001, 37.999],
    'A reciprocal pedestrian edge projection must beat a nearer same-component detour vertex.',
  )
  const recoveredProjectedPath = reciprocalKernel.routePath({
    originLon: -0.00085,
    originLat: 38,
    destinationLon: 0,
    destinationLat: 37.999,
    maximumDistanceM: 200,
    maximumPoints: 32,
  })
  assert.equal(
    recoveredProjectedPath.found,
    true,
    'Recovery snapping must retain a primary-radius edge projection when every endpoint vertex is outside the primary radius.',
  )
  assert(recoveredProjectedPath.originSnapDistanceM > 180)
  assert(recoveredProjectedPath.originSnapDistanceM < 190)

  // The road passes through the query, but one endpoint lies outside the
  // 160 m vertex lookup. Rejecting that edge attaches to the detour vertex.
  const longEdgeSnapshot = path.join(temporaryDirectory, 'long-edge-snap.street-accelerator-v7.bin')
  buildReciprocalEdgeSnapFixtureSnapshot(longEdgeSnapshot, true)
  const longEdgeKernel = new CoordinateKernel(longEdgeSnapshot)
  buildAndLoadStreetCch(longEdgeKernel, temporaryDirectory, 'long-edge-snap')
  for (const reverse of [false, true]) {
    const query = { originLon: 0, originLat: 38, destinationLon: 0.001, destinationLat: 37.999,
      maximumDistanceM: 400, maximumPoints: 32 }
    if (reverse) Object.assign(query, {originLon: 0.001, originLat: 37.999, destinationLon: 0, destinationLat: 38})
    const result = longEdgeKernel.routePath(query)
    assert.equal(result.found, true, 'A nearby reciprocal edge remains eligible when its far endpoint is outside the vertex radius')
    assert.equal(Math.round(result.distanceM), 199)
  }

  const interiorSnapshot = path.join(temporaryDirectory, 'long-edge-interior.street-accelerator-v7.bin')
  writeFixtureSnapshot(interiorSnapshot, {
    nodeIds: new Float64Array([1, 2]), nodeLats: new Float64Array([38, 38]),
    nodeLons: new Float64Array([-0.004, 0.004]),
    edgeOffsets: new Uint32Array([0, 1, 2]), edgeTargets: new Uint32Array([1, 0]),
    edgeDistances: new Float64Array([700, 700]), spatialOffsets: new Uint32Array([0, 2]),
    componentByNode: new Int32Array([0, 0]), componentLengthKm: new Float64Array([0.7]),
    reverseOffsets: new Uint32Array([0, 1, 2]), reverseSources: new Uint32Array([1, 0]),
  }, { spatialMinLat: 37.995, spatialMinLon: -0.005, spatialCellDegrees: 0.01,
    spatialRows: 1, spatialColumns: 1, componentCount: 1 })
  const interiorKernel = new CoordinateKernel(interiorSnapshot)
  buildAndLoadStreetCch(interiorKernel, temporaryDirectory, 'long-edge-interior')
  {
    for (const reverse of [false, true]) {
      const originLon = reverse ? 0.004 : 0, destinationLon = reverse ? 0 : 0.004
      const query = { originLon, originLat: 38, destinationLon, destinationLat: 38,
        maximumDistanceM: 400, maximumPoints: 32 }
      const result = interiorKernel.routePath(query)
      assert.equal(result.found, true, 'A long edge must remain attachable when both vertices are outside 160 metres.')
      assert.equal(result.distanceM, 350)
      assert.equal(interiorKernel.routePath({ ...query, maximumDistanceM: 349 }).found, false,
        'Interior projection must still pay the distance to the retained street vertex.')
    }
    assert.equal(interiorKernel.routePath({ originLon: 0, originLat: 38.001,
      destinationLon: 0.004, destinationLat: 38, maximumDistanceM: 1000, maximumPoints: 32 }).found, false,
    'The long-edge index must preserve the 80 metre projection limit.')
  }
  for (const [originLon, destinationLon] of [[0, 0.0008], [0.0008, 0]]) {
    const query = { originLon, originLat: 38, destinationLon, destinationLat: 38,
      maximumDistanceM: 100, maximumPoints: 32 }
    const result = interiorKernel.routePath(query)
    assert(result.found, 'Two points 70 metres apart inside a 700 metre street must not detour through a vertex.')
    assert(Math.abs(result.distanceM - 70) < 1e-6)
    result.coordinates.forEach((v, i) => assert(Math.abs(v - [originLon, 38, destinationLon, 38][i]) < 1e-12))
    assert.equal(interiorKernel.routePath({ ...query, maximumDistanceM: 69 }).found, false)
    const matrix = interiorKernel.routeStreetMatrix({ originCoordinates: [originLon, 38],
      destinationCoordinates: [destinationLon, 38], maximumDistanceM: 100 })
    assert(Math.abs(matrix.distancesM[0] - 70) < 1e-6)
  }
  interiorKernel.setAccessProfile({ profileKey: 'interior-access', anchorLons: [0, 0.0008],
    anchorLats: [38, 38], anchorMemberOffsets: [0, 1, 2], anchorMemberIndices: [0, 1],
    memberLons: [0, 0.0008], memberLats: [38, 38], memberOriginEligible: [1, 1], memberDestinationEligible: [1, 1] })
  for (const disableCache of [true, false, false]) {
    const ends = interiorKernel.routeEndpoints({ originLon: 0, originLat: 38, destinationLon: 0,
      destinationLat: 38, maximumWalkM: 100, disableCache })
    for (const role of ['origin', 'destination']) {
      const index = ends[`${role}MemberIndices`].indexOf(1)
      assert(index >= 0, 'A nearby stop on the same edge must remain reachable within the walking cap.')
      assert(Math.abs(ends[`${role}DistancesM`][index] - 70) < 1e-6)
      const geometry = interiorKernel.materializePath({ queryToken: ends.queryToken, role, memberIndex: 1, maximumPoints: 32 }).coordinates
      const expected = role === 'origin' ? [0, 38, 0.0008, 38] : [0.0008, 38, 0, 38]
      geometry.forEach((v, i) => assert(Math.abs(v - expected[i]) < 1e-12))
    }
  }
  const transfer = interiorKernel.buildStopTransferGraph({ maximumWalkM: 100, maximumNeighbors: 0 })
  assert.equal(transfer.distancesM.filter(d => Math.abs(d - 70) < 1e-6).length, 2,
    'Both stop-transfer directions must use the interior segment.')
  const transferPath = interiorKernel.routeAccessMemberPath({ originMemberIndex: 0, destinationMemberIndex: 1,
    maximumDistanceM: 100, maximumPoints: 32 })
  assert(transferPath.found && Math.abs(transferPath.distanceM - 70) < 1e-6)
  const interiorSurface = interiorKernel.streetSurface({ bounds: [-0.005, 37.999, 0.005, 38.001],
    width: 48, height: 48, seedCoordinates: [0, 38], seedDurationsMinutes: [0],
    maximumWalkM: 400, walkSpeedKph: 4.8, maximumDurationMinutes: 10,
    independentTerminalWalk: false, includeNodes: true, nodeEvidenceLimit: 10,
    includeEdges: false, edgeEvidenceLimit: 0, expandBoundsToReachedEdges: false })
  assert.deepEqual(interiorSurface.nodeEvidence.map(n => n.walkDistanceM), [350, 350])

  const boundarySurfaceInput = { bounds: [-0.0041, 37.999, 0.0041, 38.001], width: 128, height: 48,
    seedCoordinates: [-0.004, 38], seedDurationsMinutes: [0], maximumWalkM: 1000,
    walkSpeedKph: 4.8, maximumDurationMinutes: 3, independentTerminalWalk: false,
    includeNodes: true, nodeEvidenceLimit: 10, includeEdges: true, edgeEvidenceLimit: 0,
    expandBoundsToReachedEdges: true }
  const partialFromNode = interiorKernel.streetSurface(boundarySurfaceInput)
  assert(partialFromNode.values.filter(Number.isFinite).length > 20,
    'The reachable prefix of an edge must survive when its far endpoint exceeds the time cutoff.')
  assert.equal(partialFromNode.reachedEdgeCount, 1)
  assert(Math.abs(partialFromNode.reachedEdgeLengthM - 240) < 1e-6)
  assert(Math.abs(partialFromNode.edgeEvidenceDurations[0] - 3) < 1e-10)
  assert(Math.abs(partialFromNode.edgeEvidenceEndFractions[0] - 240 / 700) < 1e-10)
  const partialFromInterior = interiorKernel.streetSurface({ ...boundarySurfaceInput,
    seedCoordinates: [0, 38], maximumWalkM: 100, maximumDurationMinutes: 10 })
  assert(partialFromInterior.values.filter(Number.isFinite).length > 20,
    'An interior street attachment must reach both adjacent portions even when neither endpoint is reachable.')
  assert.equal(partialFromInterior.nodeEvidence.length, 0)
  assert.equal(partialFromInterior.reachedEdgeCount, 2)
  assert(Math.abs(partialFromInterior.reachedEdgeLengthM - 200) < 1e-6)
  const remainingWalk = interiorKernel.streetSurface({ ...boundarySurfaceInput,
    seedCoordinates: [0, 38], seedDurationsMinutes: [2], seedWalkDistancesM: [60],
    maximumWalkM: 100, maximumDurationMinutes: 10 })
  assert(Math.abs(remainingWalk.reachedEdgeLengthM - 80) < 1e-6,
    'An interior projection must charge the already consumed station walking distance.')
  const competingPrefixes = interiorKernel.streetSurface({ ...boundarySurfaceInput,
    seedCoordinates: [-0.004, 38, -0.004, 38], seedDurationsMinutes: [2, 3],
    seedWalkDistancesM: [200, 0], maximumWalkM: 250, maximumDurationMinutes: 10 })
  assert.equal(competingPrefixes.edgeEvidenceIds.length, 2,
    'An earlier short prefix and a later longer prefix need separate arrival intervals.')
  assert.deepEqual([...competingPrefixes.edgeEvidenceDurations], [2.625, 6.125])
  assert.deepEqual([...competingPrefixes.edgeEvidenceStartDurations], [2, 3.625])
  const unsnappedSurface = interiorKernel.streetSurface({ ...boundarySurfaceInput,
    seedCoordinates: [1, 38] })
  assert(!unsnappedSurface.values.some(Number.isFinite))
  assert(!unsnappedSurface.fullSurfaceValues.some(Number.isFinite),
    'An unsnapped origin must not invent a zero-minute cell in the expanded surface.')

  const contractedChainSnapshotPath = path.join(
    temporaryDirectory,
    'contracted-chain.street-accelerator-v7.bin',
  )
  buildContractedChainFixtureSnapshot(contractedChainSnapshotPath)
  const contractedChainKernel = new CoordinateKernel(contractedChainSnapshotPath)
  const contractedChainCchKernel = new CoordinateKernel(contractedChainSnapshotPath)
  const contractedChainCch = buildAndLoadStreetCch(
    contractedChainCchKernel,
    temporaryDirectory,
    'contracted-chain',
  )
  contractedChainKernel.loadStreetCchIndex({
    structurePath: contractedChainCch.structurePath,
    metricPath: contractedChainCch.metricPath,
  })
  const contractedChainQuery = {
    originLon: 0,
    originLat: 38,
    destinationLon: 0.005,
    destinationLat: 38,
    maximumDistanceM: 1000,
    maximumPoints: 32,
  }
  const contractedChainPath = contractedChainKernel.routePath(contractedChainQuery)
  assert.equal(contractedChainPath.found, true)
  const { structurePath: contractedChainCchStructure, metricPath: contractedChainCchMetric } = contractedChainCch
  const contractedChainProfileInput = {
    profileKey: 'contracted-chain-cch-profile-v2',
    anchorLons: [0.001, 0.004],
    anchorLats: [38, 38],
    anchorMemberOffsets: [0, 1, 2],
    anchorMemberIndices: [0, 1],
    memberLons: [0.001, 0.004],
    memberLats: [38, 38],
    memberOriginEligible: [1, 1],
    memberDestinationEligible: [1, 1],
  }
  const contractedChainProfile = contractedChainCchKernel.setAccessProfile(
    contractedChainProfileInput,
  )
  assert.equal(contractedChainProfile.configured, true)
  assert(contractedChainProfile.estimatedBytes > 0)
  const contractedChainProfileSnapshot = path.join(
    temporaryDirectory,
    'contracted-chain.native-access-profile.bin',
  )
  contractedChainCchKernel.persistAccessProfileSnapshot(contractedChainProfileSnapshot)
  const reloadedContractedChainKernel = new CoordinateKernel(contractedChainSnapshotPath)
  reloadedContractedChainKernel.loadStreetCchIndex({
    structurePath: contractedChainCchStructure,
    metricPath: contractedChainCchMetric,
  })
  reloadedContractedChainKernel.loadAccessProfileSnapshot(
    contractedChainProfileSnapshot,
    contractedChainProfileInput.profileKey,
  )
  const reloadedContractedChainProfile = reloadedContractedChainKernel.profileDiagnostics()
  for (const field of [
    'anchorCount',
    'memberCount',
    'snapCount',
    'linkedAccessEdgeCount',
  ]) {
    assert.equal(
      reloadedContractedChainProfile[field],
      contractedChainProfile[field],
      `Persisted exact local-graph access profile must preserve ${field}.`,
    )
  }
  const contractedChainEndpointQuery = {
    originLon: 0,
    originLat: 38,
    destinationLon: 0.005,
    destinationLat: 38,
    maximumWalkM: 1000,
    disableCache: true,
  }
  const builtExactEndpoints = contractedChainCchKernel.routeEndpoints(
    contractedChainEndpointQuery,
  )
  const mappedExactEndpoints = reloadedContractedChainKernel.routeEndpoints(
    contractedChainEndpointQuery,
  )
  for (const field of [
    'originMemberIndices',
    'originDistancesM',
    'originAccessSeconds',
    'destinationMemberIndices',
    'destinationDistancesM',
    'destinationAccessSeconds',
  ]) {
    assert.deepEqual(
      mappedExactEndpoints[field],
      builtExactEndpoints[field],
      `Reloaded exact local-graph access must preserve ${field}.`,
    )
  }
  const contractedChainCchPath = contractedChainCchKernel.routePath(contractedChainQuery)
  assert.equal(contractedChainCchPath.cchAccelerated, true)
  assert.equal(contractedChainCchPath.distanceM, contractedChainPath.distanceM)
  assert.deepEqual(contractedChainCchPath.coordinates, contractedChainPath.coordinates)

  const interiorChainQuery = {
    originLon: 0.002,
    originLat: 38,
    destinationLon: 0.004,
    destinationLat: 38,
    maximumDistanceM: 1000,
    maximumPoints: 32,
  }
  const interiorChainPath = contractedChainKernel.routePath(interiorChainQuery)
  assert.equal(interiorChainPath.found, true)
  assert.equal(interiorChainPath.distanceM, 200)
  assert.deepEqual(interiorChainPath.coordinates, [0.002, 38, 0.003, 38, 0.004, 38])

  const contractedCycleSnapshotPath = path.join(
    temporaryDirectory,
    'contracted-cycle.street-accelerator-v7.bin',
  )
  buildContractedCycleFixtureSnapshot(contractedCycleSnapshotPath)
  const contractedCycleKernel = new CoordinateKernel(contractedCycleSnapshotPath)
  buildAndLoadStreetCch(contractedCycleKernel, temporaryDirectory, 'contracted-cycle')
  const contractedCycleQuery = {
    originLon: 0,
    originLat: 38,
    destinationLon: 0.001,
    destinationLat: 38.001,
    maximumDistanceM: 1000,
    maximumPoints: 32,
  }
  const contractedCyclePath = contractedCycleKernel.routePath(contractedCycleQuery)
  assert.equal(contractedCyclePath.found, true)
  assert.equal(contractedCyclePath.distanceM, 200)
  assert.deepEqual(contractedCyclePath.coordinates, [0, 38, 0.001, 38, 0.001, 38.001])

  const frontierSnapshotPath = path.join(
    temporaryDirectory,
    'projected-edge-frontier.street-accelerator-v7.bin',
  )
  buildProjectedEdgeFrontierFixtureSnapshot(frontierSnapshotPath)
  const frontierKernel = new CoordinateKernel(frontierSnapshotPath)
  buildAndLoadStreetCch(frontierKernel, temporaryDirectory, 'projected-edge-frontier')
  const conservativePointPath = frontierKernel.routePath({
    originLon: 0.002,
    originLat: 37.99998,
    destinationLon: 0,
    destinationLat: 38,
    maximumDistanceM: 2000,
    maximumPoints: 32,
  })
  assert(
    conservativePointPath.found === false
      || conservativePointPath.distanceM > 1000,
  )

  const frontierProfile = frontierKernel.setAccessProfile({
    profileKey: 'projected-edge-anchor-frontier-v1',
    anchorLons: [0],
    anchorLats: [38],
    anchorMemberOffsets: [0, 1],
    anchorMemberIndices: [0],
    memberLons: [0],
    memberLats: [38],
    memberOriginEligible: [1],
    memberDestinationEligible: [1],
  })
  assert(frontierProfile.snapCount <= 2)
  const frontierEndpoints = frontierKernel.routeEndpoints({
    originLon: 0.002,
    originLat: 37.99998,
    destinationLon: 0.002,
    destinationLat: 37.99998,
    maximumWalkM: 2000,
  })
  assert.deepEqual(frontierEndpoints.originMemberIndices, [0])
  assert(Math.abs(frontierEndpoints.originDistancesM[0] - conservativePointPath.distanceM) < 0.0001,
    'A GTFS anchor must use the same physical attachment as an ordinary coordinate.')
  const frontierPath = frontierKernel.materializePath({
    queryToken: frontierEndpoints.queryToken,
    role: 'origin',
    memberIndex: 0,
    maximumPoints: 32,
  })
  assert.deepEqual(frontierPath.coordinates, conservativePointPath.coordinates,
    'Stop access cannot create a shortcut between nearby disconnected streets.')

  const barrierSnapshotPath = path.join(
    temporaryDirectory,
    'disconnected-barrier.street-accelerator-v7.bin',
  )
  buildDisconnectedBarrierFixtureSnapshot(barrierSnapshotPath)
  const barrierKernel = new CoordinateKernel(barrierSnapshotPath)
  buildAndLoadStreetCch(barrierKernel, temporaryDirectory, 'disconnected-barrier')
  const barrierProfile = barrierKernel.setAccessProfile({
    profileKey: 'disconnected-barrier-anchor-frontier-v1',
    anchorLons: [0.001],
    anchorLats: [38.00004],
    anchorMemberOffsets: [0, 1],
    anchorMemberIndices: [0],
    memberLons: [0.001],
    memberLats: [38.00004],
    memberOriginEligible: [1],
    memberDestinationEligible: [1],
  })
  assert(barrierProfile.snapCount <= 2)
  const barrierEndpoints = barrierKernel.routeEndpoints({
    originLon: 0,
    originLat: 38,
    destinationLon: 0,
    destinationLat: 38,
    maximumWalkM: 400,
  })
  assert.deepEqual(barrierEndpoints.originMemberIndices, [0])
  const barrierPath = barrierKernel.materializePath({
    queryToken: barrierEndpoints.queryToken,
    role: 'origin',
    memberIndex: 0,
    maximumPoints: 32,
  })
  assert.deepEqual(barrierPath.coordinates.slice(0, 2), [0, 38])
  assert.equal(
    barrierPath.coordinates.includes(38.0001),
    false,
    'A shared anchor frontier must not cross a disconnected pedestrian component.',
  )
  const farSideAccess = barrierKernel.routeEndpoints({
    originLon: 0, originLat: 38.0001,
    destinationLon: 0, destinationLat: 38.0001, maximumWalkM: 400,
  })
  assert.deepEqual(farSideAccess.originMemberIndices, [],
    'A stop between disconnected streets cannot join both components.')
  const disconnectedPointPath = barrierKernel.routePath({
    originLon: 0,
    originLat: 38,
    destinationLon: 0.001,
    destinationLat: 38.0001,
    maximumDistanceM: 400,
    maximumPoints: 32,
  })
  assert.equal(
    disconnectedPointPath.found,
    false,
    'A virtual query point on a short component must not seed an adjacent disconnected component.',
  )
  const linkedMembers = Array.from({ length: 21 }, (_, index) => index)
  barrierKernel.setAccessProfile({
    profileKey: 'directed-station-footpaths-v1',
    anchorLons: linkedMembers.map(() => 0),
    anchorLats: linkedMembers.map(index => index ? 38.0001 : 38),
    anchorMemberOffsets: Array.from({ length: 22 }, (_, index) => index),
    anchorMemberIndices: linkedMembers,
    memberLons: linkedMembers.map(() => 0),
    memberLats: linkedMembers.map(index => index ? 38.0001 : 38),
    memberOriginEligible: linkedMembers.map(() => 1),
    memberDestinationEligible: linkedMembers.map(() => 1),
    memberStopKeys: linkedMembers, memberStationKeys: linkedMembers,
    transferFromStopKeys: linkedMembers.slice(1).map(() => 0),
    transferToStopKeys: linkedMembers.slice(1),
    transferToStationKeys: linkedMembers.slice(1),
    transferMinDurations: linkedMembers.slice(1).map(index => 1200 + index),
    transferPathDistancesM: linkedMembers.slice(1).map(() => 10),
    transferOsmCertified: linkedMembers.slice(1).map(() => 0),
  })
  const fromBottom = barrierKernel.routeEndpoints({
    originLon: 0, originLat: 38, destinationLon: 0, destinationLat: 38,
    maximumWalkM: 50,
  })
  assert.equal(fromBottom.originMemberIndices.length, 21,
    'All declared footpaths survive; no station-count or 15-minute heuristic cap.')
  assert.deepEqual(fromBottom.destinationMemberIndices, [0],
    'One-way footpaths must not be reversed for egress.')
  const fromTop = barrierKernel.routeEndpoints({
    originLon: 0, originLat: 38.0001, destinationLon: 0, destinationLat: 38.0001,
    maximumWalkM: 50,
  })
  assert(!fromTop.originMemberIndices.includes(0))
  const bottom = fromTop.destinationMemberIndices.indexOf(0)
  assert(bottom >= 0)
  assert.equal(fromTop.destinationAccessSeconds[bottom], 1201)
  const overBudget = barrierKernel.routeEndpoints({
    originLon: 0, originLat: 38, destinationLon: 0, destinationLat: 38,
    maximumWalkM: 5,
  })
  assert.deepEqual(overBudget.originMemberIndices, [0],
    'Station walking consumes the same complete endpoint distance budget.')


  console.log(JSON.stringify({
    status: 'ready',
    binding: path.relative(repositoryRoot, bindingPath),
    directedEgress: 'verified',
    nodeApiCallsPerCoordinatePair: 1,
    repeatedEndpointCacheHit: repeated.cacheHit,
    repeatedQueryMs: repeated.queryNs / 1e6,
    recoveredPointPathDistanceM: recoveredPointPath.distanceM,
    reciprocalEdgeProjectedDistanceM: projectedPath.distanceM,
    recoveredProjectedPathDistanceM: recoveredProjectedPath.distanceM,
    streetCchArcCount: contractedChainCch.loaded.cchArcCount,
    exactChainCycleDistanceM: contractedCyclePath.distanceM,
    identityBoundMemberPathDistanceM: memberPath.distanceM,
    conservativePointDistanceM: conservativePointPath.distanceM,
    projectedEdgeAnchorFrontierDistanceM:
      frontierEndpoints.originDistancesM[0],
    disconnectedBarrierComponent: 'verified',
    disconnectedPointFragmentRecovery: 'rejected',
    constrainedDriveParetoLabels: constrainedDrive.generatedLabels,
    certifiedDriveFallbackUsed: certifiedDrive.fallbackUsed,
    persistedAccessProfileBytes: persistedProfile.snapshotBytes,
    snapStorageDeduplicationRatio: profile.snapStorageDeduplicationRatio,
    nativeResidentBytes: diagnostics.nativeResidentBytes,
  }, null, 2))
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
