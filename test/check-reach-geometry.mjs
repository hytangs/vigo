import assert from 'node:assert/strict'
import { createSsrTestServer } from './helpers/ssr-test-server.mjs'
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
