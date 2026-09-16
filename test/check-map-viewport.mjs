import assert from 'node:assert/strict'
import { mapFitPadding, previewStopBounds } from '../src/app/mapViewport.ts'

// Route and Analyze retain preview stops even when their map layers are hidden.
// A camera fit must use those coordinates without building a GeoJSON source.
const city = Object.freeze({
  stops: Object.freeze([
    Object.freeze({ id: 'south', lon: -71.12, lat: 42.31 }),
    Object.freeze({ id: 'north', lon: -71.04, lat: 42.39 }),
    Object.freeze({ id: 'center', lon: -71.08, lat: 42.35 }),
  ]),
})
assert.deepEqual(previewStopBounds(city), [[-71.12, 42.31], [-71.04, 42.39]])
assert.deepEqual(previewStopBounds({ stops: [{ lon: 0, lat: 0 }] }), [[0, 0], [0, 0]], 'Zero coordinates are valid')
assert.equal(previewStopBounds({ stops: [] }), null)
assert.equal(previewStopBounds({ stops: [
  { x: 20, y: 30 }, { lon: null, lat: 20 }, { lon: '-71', lat: 42 },
  { lon: NaN, lat: 42 }, { lon: -71, lat: Infinity },
  { lon: 181, lat: 42 }, { lon: -71, lat: -91 },
] }), null, 'Absent, projected, and invalid coordinates must not become geographic camera bounds')
assert.deepEqual(previewStopBounds({ stops: [...city.stops, { lon: Infinity, lat: 42 }, { lon: 0, lat: 91 }] }),
  [[-71.12, 42.31], [-71.04, 42.39]], 'Invalid records must not spoil usable city context')

const largeCity = { stops: [
  ...Array.from({ length: 10 }, () => ({ lon: -160, lat: -60 })),
  ...Array.from({ length: 240 }, () => ({ lon: -71.12, lat: 42.31 })),
  ...Array.from({ length: 240 }, () => ({ lon: -71.04, lat: 42.39 })),
  ...Array.from({ length: 10 }, () => ({ lon: 160, lat: 60 })),
] }
assert.deepEqual(previewStopBounds(largeCity), [[-71.12, 42.31], [-71.04, 42.39]],
  'Large-network initial framing should retain the existing map outlier policy')

assert.deepEqual(mapFitPadding(1200, 800), { top: 56, right: 58, bottom: 118, left: 58 },
  'Roomy desktop maps keep their existing control clearance')
for (const [width, height] of [[540, 277], [320, 240], [640, 240], [900, 300], [100, 80], [0, 0]]) {
  const padding = mapFitPadding(width, height)
  for (const value of Object.values(padding)) assert.ok(Number.isFinite(value) && value >= 0)
  assert.ok(padding.left + padding.right <= width * 0.4 + 1e-9, `${width}×${height}: retain horizontal map space`)
  assert.ok(padding.top + padding.bottom <= height * 0.4 + 1e-9, `${width}×${height}: retain vertical map space`)
}
const compact = mapFitPadding(540, 277)
assert.ok(277 - compact.top - compact.bottom >= 166.19,
  'The observed compact map must retain 166px of usable height, instead of 49px')
assert.ok(compact.bottom > compact.top, 'Compact maps still reserve more room for bottom controls')
assert.deepEqual(mapFitPadding(NaN, Infinity), { top: 0, right: 0, bottom: 0, left: 0 })

console.log('Map viewport checks passed: hidden-layer city context, valid coordinates, preserved outlier policy, and bounded compact padding.')
