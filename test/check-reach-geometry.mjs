import assert from 'node:assert/strict'
import './check-reach-blocks.mjs'
import { rasterBoundaryAreas as rasterAreas, boundaryContoursFromAreas } from '../src/server/reach-boundaries.mjs'
import { rasterAreas as cellAreas, rasterContours as publicContours } from '../src/server/reach.mjs'
import { createSsrTestServer } from './helpers/ssr-test-server.mjs'

const polygonsOf = collection => collection.features.flatMap(feature => feature.geometry.type === 'Polygon'
  ? [feature.geometry.coordinates] : feature.geometry.coordinates)
function inRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i], [c, d] = ring[j]
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside
  }
  return inside
}
const covered = (point, polygons) => polygons.some(([outer, ...holes]) => inRing(point, outer) && !holes.some(hole => inRing(point, hole)))
const area = ring => ring.slice(1).reduce((sum, p, i) => sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0) / 2
function checkSurface(values, width, height, cutoff = 1, bounds = [0, 0, width, height]) {
  const original = [...values]
  const areas = rasterAreas(values, width, height, bounds, [cutoff], 'baseline')
  const polygons = polygonsOf(areas)
  const contours = boundaryContoursFromAreas(areas)
  assert.deepEqual(publicContours(values, width, height, bounds, [cutoff], 'baseline'), contours, 'Public contours share closed interpolated boundaries')
  assert.deepEqual(contours.features.flatMap(feature => feature.geometry.coordinates), polygons.flat(), 'Fill and outline must use identical closed boundaries')
  assert.deepEqual([...values], original, 'Display interpolation must not change travel times or missing cells')
  for (const polygon of polygons) for (const [index, ring] of polygon.entries()) {
    assert(ring.length >= 4)
    assert.deepEqual(ring[0], ring.at(-1), 'Extent and missing-data boundaries must close')
    assert.equal(Math.sign(area(ring)), index === 0 ? 1 : -1, 'GeoJSON outer and hole winding')
    for (const [x, y] of ring) assert(x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3])
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = [bounds[0] + (x + .5) / width * (bounds[2] - bounds[0]), bounds[3] - (y + .5) / height * (bounds[3] - bounds[1])]
    assert.equal(covered(point, polygons), Number.isFinite(values[y * width + x]) && values[y * width + x] <= cutoff,
      `Sample classification must survive polygonization at ${x},${y}`)
  }
  return polygons
}
// CLI cell polygons preserve the exact raster mask, including nested islands.
function checkCells(values, width, height, bounds = [-74, 40, -73.9, 40.1]) {
  const original = [...values]
  const polygons = polygonsOf(cellAreas(values, width, height, bounds, [1], 'baseline'))
  assert.deepEqual([...values], original)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = [bounds[0] + (x + .5) / width * (bounds[2] - bounds[0]),
      bounds[3] - (y + .5) / height * (bounds[3] - bounds[1])]
    assert.equal(covered(point, polygons), Number.isFinite(values[y * width + x]) && values[y * width + x] <= 1,
      `CLI cell classification at ${x},${y}; mask=${[...values].map(v => Number.isFinite(v) ? 1 : 0).join('')}`)
  }
  // Public cell vertices use six decimal places; sum those represented cells.
  const xs = Array.from({length: width + 1}, (_, x) => +(bounds[0] + x / width * (bounds[2] - bounds[0])).toFixed(6))
  const ys = Array.from({length: height + 1}, (_, y) => +(bounds[3] - y / height * (bounds[3] - bounds[1])).toFixed(6))
  let expectedArea = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (Number.isFinite(values[y * width + x]) && values[y * width + x] <= 1) expectedArea += (xs[x + 1] - xs[x]) * (ys[y] - ys[y + 1])
  }
  const actualArea = polygons.reduce((sum, polygon) => sum + polygon.reduce((a, ring) => a + area(ring), 0), 0)
  assert(Math.abs(actualArea - expectedArea) < 1e-9, 'CLI polygon area equals reachable cell area')
  for (const polygon of polygons) for (const ring of polygon) {
    assert.deepEqual(ring[0], ring.at(-1))
    assert.equal(new Set(ring.slice(0, -1).map(p => p.join(','))).size, ring.length - 1,
      'Touching boundaries must be split into simple rings')
  }
  return polygons
}
for (let mask = 0; mask < 512; mask++) {
  checkCells(Float64Array.from({length: 9}, (_, i) => mask & (1 << i) ? 0 : Infinity), 3, 3)
}
// Exhaust every small no-data mask, including diagonal contacts, narrow gaps,
// isolated cells, interior holes and surfaces touching every extent edge.
for (let mask = 0; mask < 512; mask++) {
  checkSurface(Float64Array.from({ length: 9 }, (_, i) => mask & (1 << i) ? 0 : Infinity), 3, 3)
}
assert.equal(checkSurface([0, Infinity, Infinity, 0], 2, 2).length, 2, 'Diagonal-only cells must not create a bridge')
const nested = Float64Array.from({ length: 121 }, (_, i) => {
  const x = i % 11, y = Math.floor(i / 11), edge = Math.min(x, y, 10 - x, 10 - y)
  return edge % 2 === 0 ? 0 : Infinity
})
assert.deepEqual(checkCells(nested, 11, 11).map(p => p.length), [2, 2, 2])
let cellSeed = 20261012
for (let sample = 0; sample < 300; sample++) {
  const values = Float64Array.from({length: 120}, () => {
    cellSeed = (Math.imul(cellSeed, 1664525) + 1013904223) >>> 0
    return cellSeed >>> 31 ? 0 : Infinity
  })
  checkCells(values, 12, 10)
}
const cornerHoles = new Float64Array(16)
cornerHoles[5] = Infinity; cornerHoles[10] = Infinity
checkCells(cornerHoles, 4, 4)
console.log('CLI cell polygons: 512 masks, 300 seeded rasters, nested islands, touching holes, simple rings and represented area passed.')
const nestedPolygons = checkSurface(nested, 11, 11)
assert.equal(nestedPolygons.length, 3)
assert.deepEqual(nestedPolygons.map(p => p.length), [2, 2, 2], 'Each nested island owns its immediate hole')
const slope = Float64Array.from({ length: 16 }, (_, i) => (i % 4) + Math.floor(i / 4))
const slopedPolygons = checkSurface(slope, 4, 4, 2.4)
assert(slopedPolygons.flat(2).some(([x, y]) => Math.abs(x % .5) > .01 && Math.abs(y % .5) < .01), 'Contour positions must interpolate times rather than trace pixel corners')
checkSurface(slope, 4, 4, 2)
checkSurface(new Float64Array([1]), 1, 1, 1)
checkSurface([0, null, NaN, 0], 2, 2)
console.log('Reach boundaries: interpolated slopes, 512 masks, extent closure, disconnected islands, nested holes, equal cutoffs and unchanged samples passed.')
const server = await createSsrTestServer({ configFile: false, server: { host: '127.0.0.1', port: 0 } })
globalThis.window = { atob }
const pack = values => Buffer.from(values.buffer).toString('base64')
const bundle = segments => ({ schemaVersion: 'vigo.street.edge-bundle.v2', count: segments.length, nodeCount: 2,
  nodes: pack(new Float64Array([0, 0, 1, 0])), endpoints: pack(new Uint32Array(segments.flatMap(() => [0, 1]))),
  edgeIds: pack(new Uint32Array(segments.map(() => 7))),
  fromDurationMinutes: pack(new Float64Array(segments.map(s => s[2]))), durationMinutes: pack(new Float64Array(segments.map(s => s[3]))),
  startFractions: pack(new Float64Array(segments.map(s => s[0]))), endFractions: pack(new Float64Array(segments.map(s => s[1]))) })
try {
  const { scenarioEdgeFeatures } = await server.ssrLoadModule('/src/map/reachFeatures.ts')
  const baseline = bundle([[.2, .4, 2, 4], [.4, .8, 8, 12]])
  const scenario = bundle([[.3, .9, 3, 9]])
  const analysis = { surface: { edges: { baseline, scenario } } }
  const lines = (view, cutoff) => scenarioEdgeFeatures(analysis, view, cutoff).features.flatMap(f => f.geometry.coordinates)
  assert.deepEqual(lines('baseline', 3).map(l => l.map(p => p.map(v => +v.toFixed(12)))), [[[.2, 0], [.3, 0]]], 'Earlier cutoffs retain a partial segment.')
  assert.deepEqual(lines('baseline', 7), [[[.2, 0], [.4, 0]]], 'Later but farther labels do not appear before their arrival.')
  const compared = lines('comparison', 6).sort((a, b) => a[0][0] - b[0][0])
  assert.equal(compared.length, 3)
  const expected = [[.2, .3], [.3, .4], [.4, .6]]
  compared.forEach((line, i) => line.forEach((point, j) => assert(Math.abs(point[0] - expected[i][j]) < 1e-12)))
  assert.throws(() => scenarioEdgeFeatures({ surface: { edges: { baseline: bundle([[.2, .6, 2, 6], [.4, .8, 8, 12]]), scenario } } }, 'comparison', 10), /non-overlapping/)
  console.log('Reach geometry: partial cutoff clipping, separate arrival intervals, scenario interval alignment and overlap rejection passed.')
} finally { await server.close(); delete globalThis.window }
