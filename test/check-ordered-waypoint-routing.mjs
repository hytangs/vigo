import assert from 'node:assert/strict'

import { parseRoutingCommand } from '../src/routingCommand.ts'
import {
  appendRoutingPointSequence,
  maxRoutingPointCount,
  normalizeOrderedRoutingPoints,
  parseRoutingCoordinate,
} from '../src/routingPointSequence.ts'

const point = (label, longitude) => ({
  label,
  coordinate: [longitude, 40],
  source: 'map',
})

const a = point('Map point A', -75)
const b = point('Map point B', -74.9)
const c = point('Map point C', -74.8)
const d = point('Map point', -74.7)

const picked = [a, b, c, d].reduce(
  (points, nextPoint) => appendRoutingPointSequence(points, nextPoint),
  [],
)
assert.deepEqual(
  picked.map((entry) => entry.label),
  ['Starting point', 'Via stop 1', 'Via stop 2', 'Destination'],
)
assert.deepEqual(picked.map((entry) => entry.coordinate[0]), [-75, -74.9, -74.8, -74.7])

const extended = appendRoutingPointSequence([a, b], c)
assert.deepEqual(
  extended.map((entry) => entry.label),
  ['Starting point', 'Via stop 1', 'Destination'],
)
assert.deepEqual(
  extended.map((entry) => entry.coordinate[0]),
  [-75, -74.9, -74.8],
  'Adding a stop to A to B must give A, B, C: the new stop becomes the destination.',
)

const reorderedPicked = normalizeOrderedRoutingPoints([picked[0], picked[2], picked[1], picked[3]])
assert.deepEqual(
  reorderedPicked.map((entry) => entry.label),
  ['Starting point', 'Via stop 1', 'Via stop 2', 'Destination'],
)
assert.deepEqual(reorderedPicked.map((entry) => entry.coordinate[0]), [-75, -74.8, -74.9, -74.7])

// A map click named by the City keeps its place through reordering; unnamed ones take their role.
const named = { ...picked[1], label: 'Warren St & Dudley St', named: true }
assert.deepEqual(
  normalizeOrderedRoutingPoints([named, picked[0], picked[2]]).map((entry) => entry.label),
  ['Warren St & Dudley St', 'Via stop 1', 'Destination'],
)

const cappedPicked = Array.from({ length: maxRoutingPointCount + 1 }, (_, index) => (
  point('Map point', -75 + index * 0.01)
)).reduce(
  (points, nextPoint) => appendRoutingPointSequence(points, nextPoint),
  [],
)
assert.equal(cappedPicked.length, maxRoutingPointCount)

assert.deepEqual(parseRoutingCoordinate(' 42.35, -71.06 ')?.coordinate, [-71.06, 42.35])
assert.deepEqual(parseRoutingCoordinate('-90, +180')?.coordinate, [180, -90])
for (const invalid of ['Harvard', '91, 0', '0, -181', 'Infinity, 0', '42.3 -71.1', '42.3, -71.1 extra']) {
  assert.equal(parseRoutingCoordinate(invalid), null, `Reject invalid coordinate input: ${invalid}`)
}
assert.deepEqual(
  appendRoutingPointSequence(cappedPicked, a).map(entry => entry.coordinate),
  cappedPicked.map(entry => entry.coordinate),
  'Adding at the eight-point limit must preserve every existing point.',
)

const command = parseRoutingCommand('drive from Map point A -> Map point B -> Map point C')
assert.deepEqual(command?.locationTexts, ['Map point A', 'Map point B', 'Map point C'])
assert.deepEqual(command?.waypointTexts, ['Map point B'])
assert.equal(command?.originText, 'Map point A')
assert.equal(command?.destinationText, 'Map point C')

console.log('Ordered waypoint input behavior passed.')
