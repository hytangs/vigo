import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNativeShapeGeometry, createNativeShapeGeometrySource, alignNativeShapeStops } from '../src/server/native-routing-kernel.mjs'
import { nationalRideGeometry, clipNationalShapeCoordinatesThroughStops, clipPackedShapeCoordinates, deduplicateNationalRouteCoordinates } from '../src/server/national-route-geometry.mjs'
import { lineDistanceKm } from '../src/server/geometry-utils.mjs'

// Combining cleanup with distance must preserve degenerate lines, signed zero,
// edge summation order, and the caller's stop coordinates.
for (const points of [
  [[0, 0], [0, 0]],
  [[0, 0], [1, 0], [1, 0], [0, 0]],
  [[-0, 0], [0, -0], [1, 1], [2, 3]],
]) {
  const saved = structuredClone(points)
  const lookup = new Map(points.map(([lon, lat], i) => [String(i), { lon, lat }]))
  const connections = points.slice(1).map((_, i) => ({
    trip_id: 'unshaped', from_stop_id: String(i), to_stop_id: String(i + 1),
  }))
  const actual = nationalRideGeometry({}, connections, lookup)
  const expected = deduplicateNationalRouteCoordinates(points)
  assert.deepEqual(actual.coordinates, expected)
  assert.equal(actual.distanceKm, lineDistanceKm(expected))
  assert.deepEqual(points, saved)
}

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
store.shapeGeometryCacheMaxBytes = coordinates.length * 16 + createNativeShapeGeometry(coordinates).estimatedBytes + 257
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))
assert.equal(store.shapeGeometryCache.size, 0)
assert.equal(store.shapeGeometryCacheBytes, 0)
assert.deepEqual(leg(3, 'B', 'D').coordinates, coordinates.slice(3))

// Duplicate-point projection storage is part of the same cache byte budget.
// Repeated rendering can reuse the projection without growing that storage.
const repeatedCoordinates = coordinates.flatMap(point => [point, point])
db.prepare('INSERT INTO trips VALUES(?,?)').run('repeated', 'repeated')
repeatedCoordinates.forEach(([lon, lat], index) => insert.run('repeated', index, lon, lat))
const repeatedStore = { ...store, activeServiceKernel: null, shapeGeometryCache: new Map(),
  shapeGeometryCacheBytes: 0, shapeGeometryCacheMaxBytes: 1_000_000 }
const repeatedLeg = () => nationalRideGeometry(repeatedStore, [{
  trip_id: 'repeated', from_stop_id: 'A', to_stop_id: 'D',
}], stops)
assert.equal(repeatedLeg().geometrySource, 'shape')
const retainedShape = repeatedStore.shapeGeometryCache.get('repeated')
assert.equal(retainedShape.distinctIndices.byteLength, coordinates.length * 4)
assert.equal(repeatedStore.shapeGeometryCacheBytes,
  retainedShape.coordinates.byteLength + retainedShape.distinctIndices.byteLength + retainedShape.native.estimatedBytes + 256)
repeatedStore.shapeGeometryCacheMaxBytes = repeatedStore.shapeGeometryCacheBytes - 1
repeatedLeg()
assert.equal(repeatedStore.shapeGeometryCache.size, 0)
assert.equal(repeatedStore.shapeGeometryCacheBytes, 0)

// Native source reads have the same order, filtering and geometry as the JS
// adapter. Source closure releases SQLite while already selected shapes remain
// valid; closing twice is harmless during store invalidation.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-shape-source-'))
try {
  const sourcePath = path.join(directory, 'shapes.sqlite')
  const sourceDb = new DatabaseSync(sourcePath)
  sourceDb.exec('CREATE TABLE shape_points(shape_id TEXT, sequence INTEGER, lon REAL, lat REAL, PRIMARY KEY(shape_id, sequence)) WITHOUT ROWID')
  const insertPoint = sourceDb.prepare('INSERT INTO shape_points VALUES(?,?,?,?)')
  coordinates.forEach(([lon, lat], index) => insertPoint.run('loop', index, lon, lat))
  insertPoint.run('loop', -1, 'invalid', 0)
  insertPoint.run('loop', 99, Infinity, 0)
  insertPoint.run('single', 0, 0, 0)
  sourceDb.close()
  const source = createNativeShapeGeometrySource(sourcePath)
  const native = source.readShape('loop')
  assert.equal(native.pointCount, coordinates.length)
  assert.equal(source.readShape('missing'), null)
  assert.equal(source.readShape('single'), null)
  assert.deepEqual(clipPackedShapeCoordinates(native.packedCoordinates, 0, coordinates.length - 1), coordinates)
  assert.deepEqual(Array.from(alignNativeShapeStops(native, coordinates)), [0, 1, 2, 3, 4, 5])
  const sourceStore = { ...store, activeServiceKernel: { ...kernel }, nativeShapeSource: source,
    shapeGeometryCache: new Map(), shapeGeometryCacheBytes: 0, shapeGeometryCacheMaxBytes: 1 }
  assert.deepEqual(nationalRideGeometry(sourceStore, [{ trip_id: 'loop', kernel_segment_index: 3,
    from_stop_id: 'B', to_stop_id: 'D' }], stops).coordinates, coordinates.slice(3))
  assert.equal(sourceStore.shapeGeometryCache.size, 0)
  source.close()
  source.close()
  assert.throws(() => source.readShape('loop'), /closed/)
  assert.deepEqual(clipPackedShapeCoordinates(native.packedCoordinates, 3, 5), coordinates.slice(3))
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}

console.log(JSON.stringify({ check: 'selected-trip-geometry', status: 'passed' }))

db.close()
