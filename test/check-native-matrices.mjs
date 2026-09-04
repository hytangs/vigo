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

  const drive = new binding.DriveKernel(fixture.driveInput)
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
  console.log('Native matrix checks passed: directed distances, target replacement, repeated rows, unsnapped origins, and drive paths.')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
