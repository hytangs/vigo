import assert from 'node:assert/strict'
import './check-reach-blocks.mjs'
import { rasterBoundaryAreas as rasterAreas, rasterBoundaryContours as rasterContours } from '../src/server/reach-boundaries.mjs'
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
  const contours = rasterContours(values, width, height, bounds, [cutoff], 'baseline')
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
