import assert from 'node:assert/strict'
import { reachChangeCounts } from '../src/server/reach-comparison.mjs'

const before = new Float64Array([10, 20, 30, Infinity, 25.01, Infinity])
const after = new Float64Array([9, 40, Infinity, 20, 25, Infinity])
assert.deepEqual(reachChangeCounts(before, after, [15, 30, 45]), [
  { cutoffMinutes: 15, improvedPixels: 1, worsenedPixels: 0 },
  { cutoffMinutes: 30, improvedPixels: 2, worsenedPixels: 2 },
  { cutoffMinutes: 45, improvedPixels: 2, worsenedPixels: 2 },
])
assert.deepEqual(reachChangeCounts(before, before, [15, 30]).map(row => [row.improvedPixels, row.worsenedPixels]), [[0, 0], [0, 0]])
assert.throws(() => reachChangeCounts([10], [], [15]), /equal lengths/)
assert.deepEqual(reachChangeCounts([Infinity], [Infinity], [15]), [{ cutoffMinutes: 15, improvedPixels: 0, worsenedPixels: 0 }])
// Raw values retain an improvement that rounds to one identical display value.
assert.equal(reachChangeCounts([10.04], [9.98], [15])[0].improvedPixels, 1)
console.log('Reach comparisons retain cutoff-specific gains/losses, no-data cells, the existing tolerance, and raw precision before display quantization.')
