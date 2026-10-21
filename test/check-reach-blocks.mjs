import assert from 'node:assert/strict'
import { nativeOffStreetEstimates } from '../src/server/native-routing-kernel.mjs'
// 20 cells of about 22 m across a 0.004° square at the equator.
const width = 20, height = 20, bounds = [0, 0, .004, .004]
const cellMeters = .004 / width * 111320, metersPerMinute = 4.8 * 1000 / 60
const dry = { metadata: { status: 'ready', sampled: false, coastlineComplete: true }, features: [] }
const estimate = (values, water = dry) => nativeOffStreetEstimates(values, width, height, bounds, water, 4.8)
const clear = (values, [x0, x1], [y0, y1]) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) values[y * width + x] = Infinity
  return values
}
const streets = (minutes) => new Float64Array(width * height).fill(minutes)
const none = (estimates) => [...estimates].every(value => !Number.isFinite(value))

const values = clear(streets(5), [8, 11], [8, 11])
const before = values.slice()
const estimates = estimate(values)
assert.deepEqual(values, before, 'Display estimation must preserve raw routing evidence')
assert.equal([...estimates].filter(Number.isFinite).length, 16)
assert(estimates[9 * width + 9] > estimates[8 * width + 8])
assert(estimates[8 * width + 8] > 5, 'Off-street approach must cost time')
assert(!Number.isFinite(estimates[0]), 'Already sampled street cells must not be replaced')

const late = clear(streets(5), [4, 15], [8, 11]); for (let x = 4; x <= 15; x++) late[7 * width + x] = 20
const fastest = estimate(late)
assert(Math.abs(fastest[8 * width + 4] - (5 + cellMeters / metersPerMinute)) < 1e-6, 'Each cell walks in from its fastest street')
assert(fastest[8 * width + 9] < 20, 'A late boundary street must not delay the whole block')

const large = estimate(clear(streets(5), [1, 18], [1, 18]))
assert(Number.isFinite(large[width + 1]), 'A large block still shades the land beside its streets')
assert(!Number.isFinite(large[10 * width + 10]), 'Land more than 100 m from a reached street stays empty')
assert([...large].filter(Number.isFinite).every(value => value <= 5 + 100 / metersPerMinute + 1e-9), 'Walks stop at 100 m')

assert(none(estimate(clear(clear(streets(5), [8, 11], [8, 11]), [8, 8], [0, 8]))), 'Land open to the grid edge stays empty')
const diagonal = clear(streets(5), [8, 11], [8, 11]); for (let i = 0; i < 9; i++) diagonal[i * width + i] = Infinity
assert(none(estimate(diagonal)), 'Diagonal gaps must remain open')

for (const water of [undefined, { ...dry, metadata: { status: 'needs-import' } },
  { ...dry, metadata: { ...dry.metadata, sampled: true } }, { ...dry, metadata: { ...dry.metadata, coastlineComplete: false } }]) {
  assert(none(nativeOffStreetEstimates(values, width, height, bounds, water, 4.8)), 'Missing water coverage is not evidence of dry land')
}

// A river splits a block between an early north street and late streets elsewhere.
const split = clear(streets(30), [2, 17], [2, 17]); for (let x = 2; x <= 17; x++) split[width + x] = 0
const river = estimate(split, { ...dry, features: [{ properties: { kind: 'river' }, geometry: { type: 'LineString', coordinates: [[.0002, .0018], [.0038, .0018]] } }] })
assert(!Number.isFinite(river[11 * width + 9]), 'Water cells are not shaded')
assert(river[3 * width + 9] < 30 && river[16 * width + 9] > 30, 'Walks never cross water')
const lake = estimate(split, { ...dry, features: [{ properties: { kind: 'water' }, geometry: { type: 'Polygon', coordinates: [[[.0012, .0012], [.0028, .0012], [.0028, .0028], [.0012, .0028], [.0012, .0012]]] } }] })
assert(!Number.isFinite(lake[10 * width + 10]) && Number.isFinite(lake[3 * width + 3]), 'Only the water itself stays empty')
console.log('Off-street estimates: fastest street, 100 m walks, enclosure, water per cell, missing coverage, open/diagonal gaps and unchanged raw values passed.')
