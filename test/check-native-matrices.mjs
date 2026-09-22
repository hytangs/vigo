import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { nativeGridFixture, loadGridStreetIndex } from './helpers/native-grid-fixture.mjs'

const require = createRequire(import.meta.url)
const binding = require('../native/vigo-routing-kernel/vigo-routing-kernel.node')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-native-matrices-'))
try {
  const fixture = nativeGridFixture(directory, 12)
  const street = loadGridStreetIndex(binding, fixture, directory)
  const origins = Array.from({ length: 36 }, (_, i) => (i * 37) % fixture.nodeCount)
  const destinations = [143, 70, 0, 143, 23, 69, 11, 133, 52]
  for (const reverse of [false, true, false]) {
    for (const targets of [destinations, destinations, [71], origins, destinations]) {
      for (const source of origins) {
        const result = street.probeStreetCch({
          sourceNodes: [source], sourceDistancesM: [0], targetNodes: targets, reverse,
        })
        assert.deepEqual(result.distancesM, targets.map((target) => reverse
          ? fixture.distance(target, source) : fixture.distance(source, target)))
      }
    }
  }
  for (const targets of [destinations, [17], origins, destinations]) {
    const matrix = street.routeStreetMatrix({
      originCoordinates: fixture.coordinates(origins),
      destinationCoordinates: fixture.coordinates(targets), maximumDistanceM: 5000,
    })
    const rows = origins.flatMap((source) => street.routeStreetMatrix({
      originCoordinates: fixture.coordinates([source]),
      destinationCoordinates: fixture.coordinates(targets), maximumDistanceM: 5000,
    }).distancesM)
    assert.deepEqual(matrix.distancesM, rows)
    assert.deepEqual(matrix.distancesM, origins.flatMap((source) => targets.map((target) => fixture.distance(source, target))))
  }
  for (const maximumDistanceM of [100, 110, 500]) {
    const result = street.routeStreetMatrix({
      originCoordinates: fixture.coordinates(origins),
      destinationCoordinates: fixture.coordinates(destinations), maximumDistanceM,
    })
    assert.deepEqual(result.distancesM, origins.flatMap((source) => destinations.map((target) => {
      const distance = fixture.distance(source, target)
      return distance <= maximumDistanceM ? distance : Infinity
    })))
  }

  // Origins outside the street graph must produce unreachable cells, including
  // when an earlier query populated the same reusable workspace.
  for (const originCoordinates of [[70, 70], [70, 70, ...fixture.coordinates(origins)]]) {
    const outside = street.routeStreetMatrix({
      originCoordinates, destinationCoordinates: fixture.coordinates(destinations), maximumDistanceM: 5000,
    })
    assert.deepEqual(outside.distancesM.slice(0, destinations.length), destinations.map(() => Infinity))
    if (originCoordinates.length > 2) assert.equal(outside.distancesM[destinations.length + 2], 0)
  }
  const sameOutside = street.routeStreetMatrix({
    originCoordinates: [70, 70], destinationCoordinates: [70, 70, 71, 71], maximumDistanceM: 5000,
  })
  assert.deepEqual(sameOutside.distancesM, [0, Infinity])

  // Transfer construction uses physical stops. A public entrance may have a
  // different attachment, so path reconstruction must select the same profile.
  const physicalProfile = {
    profileKey: 'physical-stops', anchorLons: [0, 0.005], anchorLats: [38, 38],
    anchorMemberOffsets: [0, 1, 2], anchorMemberIndices: [0, 1],
    memberLons: [0, 0.005], memberLats: [38, 38],
    memberOriginEligible: [1, 1], memberDestinationEligible: [1, 1],
    memberStopKeys: [0, 1], stopLons: [0, 0.005], stopLats: [38, 38],
  }
  street.setAccessProfile(physicalProfile)
  const transfers = street.buildStopTransferGraph({ maximumWalkM: 1000, maximumNeighbors: 0 })
  const edge = transfers.fromMemberIndices.findIndex((from, i) => from === 0 && transfers.toMemberIndices[i] === 1)
  assert(edge >= 0)
  street.setAccessProfile({ ...physicalProfile, profileKey: 'shifted-public-entrance',
    anchorLons: [0, 0.006], memberLons: [0, 0.006],
  })
  const pathQuery = { originMemberIndex: 0, destinationMemberIndex: 1, maximumDistanceM: 1000, maximumPoints: 256 }
  const entrancePath = street.routeAccessMemberPath(pathQuery)
  const transferPath = street.routeAccessMemberPath({ ...pathQuery, stopTransfer: true })
  assert.equal(transferPath.found, true)
  assert.equal(transferPath.distanceM, transfers.distancesM[edge])
  assert(entrancePath.distanceM > transferPath.distanceM + 50)

  street.setAccessProfile(physicalProfile)
  const timetable = new binding.TimetableKernel({
    stopCount: 2, runCount: 2,
    departureSeconds: new Uint32Array([300, 700]), arrivalSeconds: new Uint32Array([600, 800]),
    fromStop: new Uint32Array([1, 0]), toStop: new Uint32Array([0, 1]),
    sequence: new Uint32Array([1, 1]), segmentTrip: new Uint32Array([0, 1]), segmentRun: new Uint32Array([0, 1]),
    continuityBreak: new Uint8Array([1, 1]), canBoard: new Uint8Array([1, 1]), canAlight: new Uint8Array([1, 1]),
    tripStart: new Uint32Array([0, 1, 2]), departureOffset: new Uint32Array([0, 1, 2]), departureOrder: new Uint32Array([1, 0]),
    transferOffset: new Uint32Array(3), transferTo: new Uint32Array(), transferDuration: new Uint32Array(), forbiddenSameStop: new Uint8Array(2),
  })
  const projection = new Uint32Array([1, 0])
  const scalarRequest = {
    originLon: 0, originLat: 38, destinationLon: 0.005, destinationLat: 38,
    maximumWalkM: 400, memberTimetableStops: projection, departure: 0, horizon: 1000,
    maximumBoardings: 2, allowPreRideTransfers: false, retainFullFrontier: true,
    enableDirectWalkDominance: false, disableCache: true,
  }
  for (const arriveBy of [false, true]) {
    const request = { ...scalarRequest, ...(arriveBy ? { arriveByEarliest: 0, arriveByDeadline: 1000 } : {}) }
    const ready = street.routeEndpointsTimetableScalar(timetable, request)
    assert.equal(ready.timetable.status, 'ready')
    for (const outside of [{ originLon: 70, originLat: 70 }, { destinationLon: 70, destinationLat: 70 }]) {
      const blocked = street.routeEndpointsTimetableScalar(timetable, { ...request, ...outside })
      assert.equal(blocked.timetable, undefined)
      assert.equal(blocked.arriveBy, undefined)
      assert.equal(blocked.timetableNs, 0, 'An empty access frontier must not scan the timetable.')
      assert.equal(blocked.forwardTimetableNs, 0)
      assert.equal(blocked.arriveByNs, 0)
      assert.throws(() => street.routeEndpointsTimetableScalar(timetable, { ...request, ...outside, horizon: -1 }))
      assert.throws(() => street.routeEndpointsTimetableScalar(timetable, { ...request, ...outside, maximumBoardings: 0 }))
    }
    const again = street.routeEndpointsTimetableScalar(timetable, request)
    assert.equal(again.timetable.bestArrival, ready.timetable.bestArrival)
    assert.deepEqual(again.timetable.chainToStops, ready.timetable.chainToStops)
  }
  const seedSets = (nodes, role) => {
    const offsets = [0], stops = [], walkSeconds = []
    for (const node of nodes) {
      const [longitude, latitude] = fixture.coordinates([node])
      const access = street.routeEndpoint({ longitude, latitude, maximumWalkM: 400, role })
      access.memberIndices.forEach((member, i) => { stops.push(projection[member]); walkSeconds.push(access.accessSeconds[i]) })
      offsets.push(stops.length)
    }
    return { offsets, stops, walkSeconds }
  }
  for (const [sources, targets] of [[[0], [5, 6, 70]], [[0, 1, 70], [5]], [[0, 1], [5, 6, 0]]]) {
    const o = seedSets(sources, 'origin'), d = seedSets(targets, 'destination')
    for (const arriveBy of [false, true]) for (const maximumBoardings of [undefined, 1, 2]) {
      const bounds = { departure: 0, horizon: 1000, arriveBy, maximumBoardings }
      const reference = timetable.routeMatrixCsa({ ...bounds,
        originOffsets: o.offsets, originStops: o.stops, originWalkSeconds: o.walkSeconds,
        destinationOffsets: d.offsets, destinationStops: d.stops, destinationWalkSeconds: d.walkSeconds,
        allowPreRideTransfers: sources.map(() => false), allowPostRideTransfers: targets.map(() => false),
      })
      const fused = street.routeEndpointsTimetableMatrix(timetable, { ...bounds,
        originCoordinates: fixture.coordinates(sources), destinationCoordinates: fixture.coordinates(targets),
        maximumWalkM: 400, memberTimetableStops: projection,
      })
      assert.deepEqual(fused.timetable.times, reference.times)
      assert.equal(fused.timetable.scannedDepartures, reference.scannedDepartures)
      for (const disableCache of [false, true]) {
        const combined = street.routeEndpointsTimetableMatrix(timetable, { ...bounds,
          originCoordinates: fixture.coordinates(sources), destinationCoordinates: fixture.coordinates(targets),
          maximumWalkM: 400, memberTimetableStops: projection, directWalkMaximumM: 5000, disableCache,
        })
        assert.deepEqual(combined.timetable.times, reference.times)
        assert.deepEqual(combined.directWalk.distancesM,
          sources.flatMap(source => targets.map(target => fixture.distance(source, target))))
        assert.equal(combined.directWalk.reusedEndpointSnaps, sources.length + targets.length)
        assert.equal(combined.cacheDisabled, disableCache)
        if (disableCache) {
          assert.equal(combined.originCacheHits, 0)
          assert.equal(combined.destinationCacheHits, 0)
        }
      }
    }
  }
  for (const disableCache of [false, true]) {
    const outside = street.routeEndpointsTimetableMatrix(timetable, {
      originCoordinates: [70, 70, ...fixture.coordinates([0])],
      destinationCoordinates: [70, 70, ...fixture.coordinates([5])],
      maximumWalkM: 400, memberTimetableStops: projection, departure: 0, horizon: 650,
      arriveBy: false, directWalkMaximumM: 5000, disableCache,
    })
    assert.deepEqual(outside.directWalk.distancesM, [0, Infinity, Infinity, fixture.distance(0, 5)])
    assert.equal(outside.directWalk.reusedEndpointSnaps, 4)
  }
  for (const arriveBy of [false, true]) {
    const fused = street.routeEndpointsTimetableMatrix(timetable, {
      originCoordinates: fixture.coordinates(arriveBy ? Array(100_000).fill(0) : [0]),
      destinationCoordinates: fixture.coordinates(arriveBy ? [5] : Array(100_000).fill(5)),
      maximumWalkM: 400, memberTimetableStops: projection, departure: 0, horizon: 650, arriveBy, maximumBoardings: 1, directWalkMaximumM: 5000,
    })
    assert.equal(fused.directWalk.reusedEndpointSnaps, 100_001)
    assert(fused.directWalk.distancesM.every(distance => distance === fixture.distance(0, 5)))
    assert.equal(fused.timetable.times.length, 100_000)
    assert(fused.timetable.times.every((time) => time === (arriveBy ? 300 : 600)))
    assert.equal(fused.timetable.forwardSearches + fused.timetable.reverseSearches, 1)
  }
  assert.throws(() => street.routeEndpointsTimetableMatrix(timetable, {
    originCoordinates: [NaN, 38], destinationCoordinates: [0, 38],
    maximumWalkM: 400, memberTimetableStops: projection, departure: 0, horizon: 650, arriveBy: false,
  }), /valid coordinates/)

  const drive = new binding.DriveKernel(fixture.driveInput)
  const largeTargets = Array.from({ length: 100_000 }, (_, i) => i % fixture.nodeCount)
  const largeWalk = street.routeStreetMatrix({
    originCoordinates: fixture.coordinates([0]), destinationCoordinates: fixture.coordinates(largeTargets),
    maximumDistanceM: 5000,
  })
  const largeDrive = drive.routeMatrix({
    originOffsets: [0, 1], originNodes: [0], originSnapMeters: [0],
    targetOffsets: largeTargets.map((_, i) => i).concat(largeTargets.length),
    targetNodes: largeTargets, targetSnapMeters: largeTargets.map(() => 0), maximumDistanceMeters: 5000,
  })
  assert.equal(largeWalk.distancesM.length, largeTargets.length)
  assert.equal(largeDrive.distancesM.length, largeTargets.length)
  for (const [index, target] of largeTargets.entries()) {
    assert.equal(largeWalk.distancesM[index], fixture.distance(0, target))
    assert.equal(largeDrive.distancesM[index], fixture.distance(0, target))
  }
  assert.throws(() => street.routeStreetMatrix({
    originCoordinates: fixture.coordinates([0, 1]), destinationCoordinates: fixture.coordinates(largeTargets),
    maximumDistanceM: 5000,
  }), /100,000 pairs/)
  const reverseWalk = street.routeStreetMatrix({
    originCoordinates: fixture.coordinates(largeTargets), destinationCoordinates: fixture.coordinates([0]), maximumDistanceM: 5000,
  })
  const reverseDrive = drive.routeMatrix({
    originOffsets: largeTargets.map((_, i) => i).concat(largeTargets.length),
    originNodes: largeTargets, originSnapMeters: largeTargets.map(() => 0),
    targetOffsets: [0, 1], targetNodes: [0], targetSnapMeters: [0], maximumDistanceMeters: 5000,
  })
  for (const [i, origin] of largeTargets.entries()) {
    assert.equal(reverseWalk.distancesM[i], fixture.distance(origin, 0))
    assert.equal(reverseDrive.distancesM[i], fixture.distance(origin, 0))
  }
  const matrix = drive.routeMatrix({
    originOffsets: origins.map((_, i) => i).concat(origins.length), originNodes: origins,
    originSnapMeters: origins.map(() => 0),
    targetOffsets: destinations.map((_, i) => i).concat(destinations.length), targetNodes: destinations,
    targetSnapMeters: destinations.map(() => 0), maximumDistanceMeters: 5000,
  })
  assert.deepEqual(matrix.distancesM, origins.flatMap((source) => destinations.map((target) => fixture.distance(source, target))))
  for (const source of origins) {
    for (const target of destinations) {
      const result = drive.routeExact({
        originNodes: [source], originSnapMeters: [0], targetNodes: [target],
        targetSnapMeters: [0], maximumDistanceMeters: 5000,
      })
      assert.equal(result.status, 'ready')
      assert.equal(result.distanceMeters, fixture.distance(source, target))
      assert.equal(result.durationSeconds, fixture.distance(source, target) / 10)
    }
  }
  const snaps = Array.from({ length: 48 }, (_, i) => i * 2)
  const sources = Array.from({ length: 48 }, (_, i) => i)
  const targets = Array.from({ length: 48 }, (_, i) => 143 - i)
  const candidateQuery = { originNodes: sources, targetNodes: targets,
    originSnapMeters: snaps, targetSnapMeters: snaps, maximumDistanceMeters: 5000 }
  const selected = drive.routeExact(candidateQuery)
  const exhaustive = sources.flatMap((source, i) => targets.map((target, j) => drive.routeExact({
    originNodes: [source], targetNodes: [target], originSnapMeters: [snaps[i]], targetSnapMeters: [snaps[j]],
    maximumDistanceMeters: 5000,
  }))).filter((p) => p.status === 'ready')
    .sort((a, b) => a.durationSeconds - b.durationSeconds || a.distanceMeters - b.distanceMeters)[0]
  assert.equal(selected.durationSeconds, exhaustive.durationSeconds)
  assert.equal(selected.distanceMeters, exhaustive.distanceMeters)
  assert(selected.cchCandidateQueries < sources.length * targets.length,
    'Full paths should only be unpacked for primary-optimal candidate ties.')
  console.log('Native matrix checks passed: directed distances, target replacement, repeated rows, unsnapped origins, and drive paths.')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
