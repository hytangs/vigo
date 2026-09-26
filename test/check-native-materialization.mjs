import assert from 'node:assert/strict'
import { createNativeShapeGeometry, alignNativeShapeStops } from '../src/server/native-routing-kernel.mjs'
import { clipPackedShapeCoordinates } from '../src/server/national-route-geometry.mjs'
import { stableKeySuffix, stablePlanId } from '../src/server/routing-plan-identity.mjs'
import { alignPreparedShapeStopIndices, shapeDistancePrefix } from './helpers/shape-alignment-reference.mjs'

function referenceHash(value) {
  let state = 0xcbf29ce484222325n
  for (const character of String(value)) {
    state ^= BigInt(character.codePointAt(0))
    state = BigInt.asUintN(64, state * 0x100000001b3n)
  }
  return state.toString(36).padStart(13, '0')
}
let seed = 0x62716271
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
const identifiers = ['', 'Washington', '北京 🚆', '\0', '\ud800', '\udfff', '\ud800x\udfff', '\ud83d\ude86', 123, null, undefined]
for (let index = 0; index < 1000; index += 1) {
  identifiers.push(String.fromCharCode(...Array.from({ length: index % 128 }, () => Math.floor(random() * 65536))))
}
for (const value of identifiers) assert.equal(stableKeySuffix(value), referenceHash(value), JSON.stringify(value))
assert.equal(stablePlanId('plan', { value: 1, nativeStreetQueryMs: 12 }), stablePlanId('plan', { value: 1, nativeStreetQueryMs: 99 }))

let alignments = 0
function parity(shape, stops) {
  const native = createNativeShapeGeometry(shape)
  const expected = alignPreparedShapeStopIndices({ coordinates: shape, prefixKm: shapeDistancePrefix(shape), candidatesByStop: new Map() }, stops, [])
  const actual = alignNativeShapeStops(native, stops)
  assert.deepEqual(actual ? Array.from(actual) : null, expected)
  assert.deepEqual(alignNativeShapeStops(native, stops)?.length ?? 0, expected?.length ?? 0, 'Repeated use is deterministic.')
  alignments += 1
}
for (const base of [[0, 0], [-77, 39], [179.999, 0], [0, 89.99], [0, -89.99]]) {
  for (let trial = 0; trial < 80; trial += 1) {
    let x = base[0], y = base[1]
    const shape = Array.from({ length: 20 + trial * 3 }, () => {
      x += (random() - 0.45) * 0.002; y += (random() - 0.5) * 0.0002
      return [((x + 540) % 360) - 180, y]
    })
    // Repeated points and a reversed section expose loop/tie ordering.
    if (trial % 3 === 0) shape.splice(10, 0, ...shape.slice(2, 10).reverse())
    const stops = [shape[1], shape[Math.floor(shape.length / 3)], shape[Math.floor(shape.length * 2 / 3)], shape.at(-2)]
    parity(shape, stops)
    if (trial % 10 === 0) parity(shape, [shape[0], [30, -40]])
  }
}
parity([], [[0, 0], [0, 0]])
parity([[0, 0]], [[0, 0], [0, 0]])
parity([[0, 0], [0.01, 0]], [])
parity(Array.from({ length: 80 }, (_, i) => [i % 2 ? 0.001 : 0, 0]), [[0, 0], [0.001, 0], [0, 0]])
// Dense east-west shapes used to scan almost every point for every stop.
// Match the original exhaustive oracle, including equal-distance duplicates,
// both poles, and longitude wrap. Each alignment starts with an empty cache.
for (const latitude of [0, 39, 61, 89.999, -89.999]) {
  for (const start of [-77, 179.99]) {
    const shape = Array.from({ length: 2048 }, (_, i) => [((start + i * .0001 + 540) % 360) - 180, latitude])
    for (let i = 200; i < 1900; i += 317) shape[i] = [...shape[i - 1]]
    parity(shape, Array.from({ length: 16 }, (_, i) => shape[1 + i * 125]))
    parity(shape, [shape[1], [shape[900][0], latitude - .00005], shape[2040]])
  }
}

// Clipping must preserve the old distinct-then-stride sampler, even when
// sampling makes nonadjacent equal points adjacent or the line is degenerate.
const distinct = points => points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1])
let clippingCases = 0
const clippingShapes = [
  [[0, 0], [-0, 0], [0, -0], [1, 1], [1, 1], [-0, -0], [0, 0]],
  Array.from({ length: 1025 }, () => [0, 0]),
]
for (const count of [1, 2, 15, 511, 512, 513, 1023, 4097]) {
  clippingShapes.push(Array.from({ length: count }, (_, i) => i % 5 < 2 ? [0, 0] : [i / 1e5, 39]))
  clippingShapes.push(Array.from({ length: count }, (_, i) => [i / 1e5, 39]))
}
for (const shape of clippingShapes) {
  const native = createNativeShapeGeometry(shape)
  assert.equal(native.pointCount, shape.length)
  const columns = native.renderCoordinates()
  assert.deepEqual(columns.coordinates, native.packedCoordinates)
  assert.equal(columns.distinctIndices == null, distinct(shape).length === shape.length)
  const slices = [[0, shape.length - 1]]
  for (let i = 0; i < 24; i += 1) {
    const start = Math.floor(random() * shape.length)
    slices.push([start, start + Math.floor(random() * (shape.length - start))])
  }
  for (const [start, end] of slices) {
    for (const from of [null, shape[start], [-77, 38]]) {
      for (const to of [null, shape[end], [-76, 40]]) {
        for (const limit of [2, 17, 512]) {
          const points = distinct([...(from ? [from] : []), ...shape.slice(start, end + 1), ...(to ? [to] : [])])
          const stride = Math.max(1, Math.ceil((points.length - 1) / (limit - 1)))
          const expected = points.filter((_, i) => i % stride === 0 || i === points.length - 1)
          assert.deepEqual(clipPackedShapeCoordinates(columns.coordinates, start, end, from, to, limit), expected)
          assert.deepEqual(clipPackedShapeCoordinates(columns.coordinates, start, end, from, to, limit, columns.distinctIndices ?? null), expected)
          clippingCases += 1
        }
      }
    }
  }
}
assert.throws(() => createNativeShapeGeometry([[NaN, 0], [0, 0]]), /finite/)
assert.throws(() => alignNativeShapeStops(createNativeShapeGeometry([[0, 0], [1, 1]]), [[Infinity, 0], [1, 1]]), /finite/)
const cached = createNativeShapeGeometry([[0, 0], [0.001, 0]])
const baseBytes = cached.estimatedBytes
alignNativeShapeStops(cached, [[0, 0], [0.001, 0]])
const populatedBytes = cached.estimatedBytes
assert(populatedBytes > baseBytes, 'Native candidate storage must be included in the byte estimate.')
for (let i = 0; i < 100; i += 1) alignNativeShapeStops(cached, [[0, 0], [0.001, 0]])
assert.equal(cached.estimatedBytes, populatedBytes, 'Repeated coordinates must reuse candidate storage.')
for (let i = 0; i < 5000; i += 1) alignNativeShapeStops(cached, [[i / 1e8, 0], [0.001, 0]])
assert(cached.estimatedBytes < baseBytes + 2048 * 512, 'Candidate reuse must stay bounded after eviction.')
console.log(JSON.stringify({ check: 'native-materialization', status: 'passed', identifiers: identifiers.length, alignments, clippingCases }))
