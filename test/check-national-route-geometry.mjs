import assert from 'node:assert/strict'
import { nationalRideGeometry } from '../src/server/national-route-geometry.mjs'

const coordinates = [[0, 0], [0.01, 0], [0.02, 0], [0.01, 0], [0.01, -0.01], [0.03, -0.01]]
const stops = new Map(['A', 'B', 'C', 'D'].map((id, index) => {
  const [lon, lat] = coordinates[[0, 1, 2, 5][index]]
  return [id, { stop_id: id, lon, lat }]
}))
const kernel = {
  tripIds: ['loop', 'unused'],
  tripStart: [0, 4, 5],
  segmentTrip: [0, 0, 0, 0, 1],
  stopIds: ['A', 'B', 'C', 'D'],
  fromStop: [0, 1, 2, 1, 0],
  toStop: [1, 2, 1, 3, 3],
}
const loadedTrips = []
const loadedShapes = []
const store = {
  activeServiceKernel: kernel,
  stopLookup: stops,
  shapeGeometryCache: new Map(),
  tripShapeIdCache: new Map(),
  tripShapeLookup: { get(id) { loadedTrips.push(id); return { shape_id: id } } },
  shapePointsLookup: { all(id) { loadedShapes.push(id); return coordinates.map(([lon, lat]) => ({ lon, lat })) } },
}
function leg(segment, from, to) {
  return nationalRideGeometry(store, [{
    trip_id: 'loop', kernel_segment_index: segment,
    from_stop_id: from, to_stop_id: to,
  }], stops)
}

// A partial ride still aligns against every stop of the complete loop trip.
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))
assert.deepEqual(leg(0, 'A', 'B').coordinates, coordinates.slice(0, 2))
assert.deepEqual(leg(2, 'C', 'B').coordinates, coordinates.slice(2, 4))
assert.deepEqual(loadedTrips, ['loop'])
assert.deepEqual(loadedShapes, ['loop'], 'Unselected trips must not load shapes.')

// The same trip ID on another service kernel has different segment positions.
store.activeServiceKernel = {
  tripIds: ['loop'], tripStart: [0, 2], segmentTrip: [0, 0],
  stopIds: ['A', 'B', 'D'], fromStop: [0, 1], toStop: [1, 2],
}
assert.deepEqual(leg(1, 'B', 'D').coordinates, coordinates.slice(1))
assert.equal(leg(1, 'B', 'D').geometrySource, 'shape')
store.activeServiceKernel = kernel
assert.deepEqual(leg(2, 'C', 'B').coordinates, coordinates.slice(2, 4))

const unshaped = { ...store, activeServiceKernel: { ...kernel }, tripShapeLookup: null, shapePointsLookup: null }
assert.equal(nationalRideGeometry(unshaped, [{
  trip_id: 'loop', kernel_segment_index: 0, from_stop_id: 'A', to_stop_id: 'B',
}], stops).geometrySource, 'stop_sequence')

// A shape larger than the cache budget is read once per render and never retained.
store.activeServiceKernel = { ...kernel }
store.shapeGeometryCache.clear()
store.shapeGeometryCacheBytes = 0
store.shapeGeometryCacheMaxBytes = 1
loadedShapes.length = 0
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))
assert.equal(store.shapeGeometryCache.size, 0)
assert.equal(loadedShapes.length, 1)
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))
assert.equal(store.shapeGeometryCache.size, 0)
assert.equal(loadedShapes.length, 2)

console.log(JSON.stringify({ check: 'selected-trip-geometry', status: 'passed' }))
