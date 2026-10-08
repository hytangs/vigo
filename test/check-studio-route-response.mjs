import assert from 'node:assert/strict'
import { compactStudioRoutingPlan, compactStudioRoutingResponse } from '../src/server/studio-route-response.mjs'
const plan = { id: 'primary', status: 'ready', departMinutes: 480, arriveMinutes: 510,
  legs: [{ type: 'walk', coordinates: [[0, 0], [0, 1]], stationAccessStatus: 'unverified' }],
  diagnostics: {
    routingStatus: 'ready', departurePresentation: { requestedDepartMinutes: 475 },
    realtimeRouting: { status: 'stale_fallback' },
    searchStats: { queryMs: 10, engineQueryMs: 2, nativeCoordinateKernel: { inventory: 'x'.repeat(50000) } },
    dataSemantics: { blockingFeatures: [], limitations: [{ code: 'inferred_station_path' }], transferGeneration: { internal: true } },
    departureWindow: { centerMinutes: 475, afterMinutes: 20, sampleCount: 21 },
  },
}
const result = { plan, choices: [plan, { ...plan, id: 'other' }], earliestTransit: { status: 'ready' } }
const original = structuredClone(result), compact = compactStudioRoutingResponse(result)
assert.deepEqual(result, original, 'Output projection cannot mutate routing results')
assert.equal(compact.selectedPlanId, 'primary')
assert(!Object.hasOwn(compact, 'plan'), 'The primary journey is sent only once')
assert.deepEqual(compact.choices.map(p => p.legs), result.choices.map(p => p.legs))
assert.deepEqual(compact.choices[0].diagnostics.dataSemantics.limitations, plan.diagnostics.dataSemantics.limitations)
assert.deepEqual(compact.choices[0].diagnostics.realtimeRouting, plan.diagnostics.realtimeRouting)
assert.equal(compact.choices[0].diagnostics.departureWindow.centerMinutes, 475)
assert.deepEqual(compact.choices[0].diagnostics.searchStats, { queryMs: 10, engineQueryMs: 2 })
assert(JSON.stringify(compact).length < JSON.stringify(result).length / 20)
const blocked = { id: 'none', status: 'blocked', diagnostics: { failure: { code: 'unsupported_feature', category: 'unsupported_feature' } } }
assert.deepEqual(compactStudioRoutingPlan(blocked), blocked)
assert.deepEqual(compactStudioRoutingResponse({ plan: blocked, choices: [blocked] }).choices, [blocked])
const noAlternatives = { plan: blocked, choices: [], earliestTransit: { status: 'none' } }
assert.deepEqual(compactStudioRoutingResponse(noAlternatives), {
  choices: [blocked], selectedPlanId: blocked.id, earliestTransit: { status: 'none' },
}, 'A departure window without alternatives must retain the blocked primary result')
assert.deepEqual(noAlternatives.choices, [], 'Fallback projection cannot mutate engine alternatives')
console.log('Compact Studio output preserves journeys, warnings, request times and failure status without duplicate primary or cache inventories.')
