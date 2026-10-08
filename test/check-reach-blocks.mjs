import assert from 'node:assert/strict'
import { blockInteriorEstimates } from '../src/server/reach-blocks.mjs'
const width = 20, height = 20, bounds = [0, 0, .004, .004]
const dry = { metadata: { status: 'ready', sampled: false, coastlineComplete: true }, features: [] }
const values = new Float64Array(width * height).fill(5)
for (let y = 8; y <= 11; y++) for (let x = 8; x <= 11; x++) values[y * width + x] = Infinity
const before = values.slice()
const estimates = blockInteriorEstimates(values, width, height, bounds, dry)
assert.deepEqual(values, before, 'Display estimation must preserve raw routing evidence')
assert.equal([...estimates].filter(Number.isFinite).length, 16)
assert(estimates[9 * width + 9] > estimates[8 * width + 8])
assert(estimates[8 * width + 8] > 5, 'Off-street approach must cost time')
assert(!Number.isFinite(estimates[0]), 'Already sampled street cells must not be replaced')
const late = values.slice(); late[7 * width + 9] = 20
assert(blockInteriorEstimates(late, width, height, bounds, dry)[9 * width + 9] > 20,
  'A block must not become reachable before all surrounding boundary evidence')
const open = values.slice(); for (let y = 0; y < 9; y++) open[y * width + 8] = Infinity
assert([...blockInteriorEstimates(open, width, height, bounds, dry)].every(v => !Number.isFinite(v)))
const diagonal = values.slice(); for (let i = 0; i < 9; i++) diagonal[i * width + i] = Infinity
assert([...blockInteriorEstimates(diagonal, width, height, bounds, dry)].every(v => !Number.isFinite(v)), 'Diagonal gaps must remain open')
const large = values.slice(); for (let y = 1; y < 19; y++) for (let x = 1; x < 19; x++) large[y * width + x] = Infinity
assert([...blockInteriorEstimates(large, width, height, bounds, dry)].every(v => !Number.isFinite(v)))
for (const water of [undefined, { ...dry, metadata: { status: 'needs-import' } },
  { ...dry, metadata: { ...dry.metadata, sampled: true } }, { ...dry, metadata: { ...dry.metadata, coastlineComplete: false } }]) {
  assert([...blockInteriorEstimates(values, width, height, bounds, water)].every(v => !Number.isFinite(v)))
}
for (const geometry of [
  { type: 'Polygon', coordinates: [[[.00185, .00185], [.00215, .00185], [.00215, .00215], [.00185, .00215], [.00185, .00185]]] },
  { type: 'LineString', coordinates: [[.0016, .00191], [.0024, .00192]] },
]) {
  const water = { ...dry, features: [{ properties: { kind: geometry.type === 'Polygon' ? 'water' : 'river' }, geometry }] }
  assert([...blockInteriorEstimates(values, width, height, bounds, water)].every(v => !Number.isFinite(v)), 'Known water protects the whole connected gap')
}
console.log('Block estimates: bounded enclosure, walking cost, late boundary, water, missing coverage, open/diagonal gaps and unchanged raw values passed.')
