import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { createNativeShapeGeometry } from '../src/server/native-routing-kernel.mjs'
import { nationalRideGeometry, clipNationalShapeCoordinatesThroughStops } from '../src/server/national-route-geometry.mjs'

// Far latitude points cannot displace accepted candidates. Longitude proximity
// alone is insufficient, and the latitude bound must remain valid at the poles
// and across the antimeridian.
for (const near of [
  [[0, 0], [0.002, 0], [0.004, 0]],
  [[179.999, 0], [-180, 0], [-179.999, 0]],
  [[10, 89.99], [11, 89.99], [12, 89.99]],
]) {
  const shape = [[0, -45], ...near, [0, 45]]
  assert.deepEqual(clipNationalShapeCoordinatesThroughStops(shape, near), near)
}

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
const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE trips(trip_id TEXT PRIMARY KEY, shape_id TEXT); CREATE TABLE shapes(shape_id TEXT, sequence INTEGER, lon REAL, lat REAL)')
db.prepare('INSERT INTO trips VALUES(?,?)').run('loop', 'loop')
const insert = db.prepare('INSERT INTO shapes VALUES(?,?,?,?)')
coordinates.forEach(([lon, lat], index) => insert.run('loop', index, lon, lat))
const store = {
  activeServiceKernel: kernel,
  stopLookup: stops,
  shapeGeometryCache: new Map(),
  tripShapeIdCache: new Map(),
  tripShapeLookup: db.prepare('SELECT shape_id FROM trips WHERE trip_id=?'),
  shapePointsLookup: db.prepare('SELECT lon,lat FROM shapes WHERE shape_id=? ORDER BY sequence'),
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
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))
assert.equal(store.shapeGeometryCache.size, 0)
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))
assert.equal(store.shapeGeometryCache.size, 0)

// A shape that initially fits must also be evicted when native candidate
// storage grows beyond the byte budget during alignment.
store.activeServiceKernel = { ...kernel }
store.shapeGeometryCacheMaxBytes = coordinates.length * 24 + createNativeShapeGeometry(coordinates).estimatedBytes + 257
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))
assert.equal(store.shapeGeometryCache.size, 0)
assert.equal(store.shapeGeometryCacheBytes, 0)
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))

console.log(JSON.stringify({ check: 'selected-trip-geometry', status: 'passed' }))

db.close()
