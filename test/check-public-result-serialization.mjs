import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { serializePublicResult, formatPublicResult } from '../src/server/native-routing-kernel.mjs'
import { publicResultJson } from '../src/cli/presentation.mjs'
const binding = createRequire(import.meta.url)('../native/vigo-routing-kernel/vigo-routing-kernel.node')
const plan = { status: 'ready', travelMode: 'transit', departMinutes: 480, arriveMinutes: 482,
  durationMinutes: 2, walkMinutes: 0, waitMinutes: 0, rideMinutes: 2,
  legs: [{ type: 'ride', startMinutes: 480, endMinutes: 482, fromStopId: 'feed\u001fA', toStopId: 'feed\u001fB',
    tripId: 'feed\u001fT', coordinates: [[-71, 42], [-71.1, 42.1]],
    routeShortName: '北 "A"', diagnostics: { sentinel: 4294967295 } }],
  diagnostics: { searchStats: { queryMs: .5 }, sentinel: 4294967295 } }
const kinds = {
  route: { result: plan, choices: [plan, { ...plan, arriveMinutes: 483 }] },
  matrix: { query: { origins: [{ id: 'a', point: { stopId: 'A' } }], destinations: [{ id: 'b', point: { stopId: 'B' } }] },
    rows: [{ originIndex: 0, destinationIndex: 0, durationMinutes: 2, journey: plan }] },
  reach: { cutoffsMinutes: [5], surface: { width: 1, height: 1, values: [2], bounds: [-71, 42, -70, 43] } },
}
let checks = 0
for (const [kind, body] of Object.entries(kinds)) for (const diagnostics of ['none', 'summary', 'profile', 'trace']) {
  const request = { id: 'request_1', diagnostics, includeLimitations: true, includeGeometry: true }
  const raw = { kind, status: 'ready', resultSchemaVersion: 1, city: { revisionId: 'test', accessibility: { profile: 'standard' } },
    query: { serviceDate: '2026-07-06', mode: 'transit', timeMinutes: 480 }, timing: { computeMs: .5 },
    warnings: [{ code: 'fixture', detail: 'Unicode 北 and "quotes"' }], ...body, sequence: 1 }
  const saved = JSON.stringify(raw)
  const expected = JSON.parse(binding.formatPublicResult(JSON.stringify({ kind, request, result: raw })))
  assert.deepEqual(JSON.parse(serializePublicResult(kind, request, raw)), expected)
  const actual = formatPublicResult(kind, request, raw)
  assert.deepEqual(actual, expected)
  assert.deepEqual(JSON.parse(publicResultJson(raw, request)), { ...expected, accessibility: raw.city.accessibility, sequence: 1 })
  if (diagnostics === 'trace') {
    assert.deepEqual(actual.trace, JSON.parse(saved))
    actual.trace.query.mode = 'changed'
    assert.equal(JSON.stringify(raw), saved, 'A public result must not alias internal state')
  }
  checks++
}
assert.throws(() => serializePublicResult('route', { diagnostics: 'invalid' }, {}), /diagnostics/)
console.log(`Public serialization: ${checks} projections preserve the native schema and lossless trace.`)
