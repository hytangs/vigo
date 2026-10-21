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
plan.sharedLegAlternatives = { coverage: 'single_leg_substitutions', options: [{legIndex:0,plan:{...plan,id:'shared'}}] }
const original = structuredClone(result), compact = compactStudioRoutingResponse(result)
assert.deepEqual(result, original, 'Output projection cannot mutate routing results')
assert.equal(compact.selectedPlanId, 'primary')
assert(!Object.hasOwn(compact, 'plan'), 'The primary journey is sent only once')
assert.deepEqual(compact.choices.map(p => p.legs), result.choices.map(p => p.legs))
assert.deepEqual(compact.choices[0].diagnostics.dataSemantics.limitations, plan.diagnostics.dataSemantics.limitations)
assert.deepEqual(compact.choices[0].diagnostics.realtimeRouting, plan.diagnostics.realtimeRouting)
assert.equal(compact.choices[0].diagnostics.departureWindow.centerMinutes, 475)
assert.deepEqual(compact.choices[0].sharedLegAlternatives.options[0].plan.diagnostics.searchStats, {queryMs:10,engineQueryMs:2})
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

const { nativeRouteRequest, studioRouteResponse } = await import('../src/server/studio-route-plans.mjs')
const driveBody = { mode: 'drive', origin: { coordinate: [0, 0], label: 'From' },
  destination: { coordinate: [1, 1], label: 'To' }, departMinutes: 480,
  routingDataMode: 'realtime', walkSpeedKph: 3, traffic: { testSnapshot: true } }
const request = nativeRouteRequest(driveBody)
assert.equal(request.routingDataMode, 'realtime')
assert.equal(request.walkSpeedKph, 3)
assert.deepEqual(request.traffic, driveBody.traffic)
assert.equal(nativeRouteRequest({ ...driveBody, routingDataMode: 'scheduled' }).routingDataMode, 'scheduled')
assert.equal(nativeRouteRequest({ ...driveBody, routingDataMode: 'scheduled' }).traffic, undefined)
assert.equal(nativeRouteRequest({ ...driveBody, traffic: undefined }).routingDataMode, 'scheduled')
const streetLeg = (kind, departureMinutes, arrivalMinutes, distanceMeters, coordinates) => ({
  kind, departureMinutes, arrivalMinutes, distanceMeters, coordinates,
  geometrySource: kind === 'walk' ? 'coordinate-snap' : 'osm', streetPathVerified: kind === 'drive',
})
const driveTrace = { status: 'ready', runtime: 'rust', mode: 'drive', departureMinutes: 480, arrivalMinutes: 493,
  legs: [streetLeg('walk', 480, 481, 50, [[0, 0], [0.1, 0.1]]),
    streetLeg('drive', 481, 491, 5000, [[0.1, 0.1], [0.9, 0.9]]),
    streetLeg('walk', 491, 493, 100, [[0.9, 0.9], [1, 1]])] }
for (const status of ['applied', 'stale_fallback', 'unavailable_fallback']) {
  const trace = { ...driveTrace, diagnostics: { traffic: { status } } }
  for (const waypoints of [undefined, [{ coordinate: [0.5, 0.5] }]]) {
    const raw = waypoints ? { ...trace, segments: [{ mode: 'drive' }, { mode: 'drive' }] } : trace
    const plan = studioRouteResponse(raw, { ...driveBody, waypoints }).choices[0]
    assert.deepEqual(plan.legs.map(l => l.type), ['walk', 'drive', 'walk'])
    assert.deepEqual(plan.legs.map(l => l.coordinates), driveTrace.legs.map(l => l.coordinates))
    assert.deepEqual(plan.legs.map(l => l.streetPathVerified), [false, true, false])
    assert.equal(plan.walkMinutes, 3)
    assert.equal(plan.rideMinutes, 10)
    assert.equal(plan.durationMinutes, 13)
    assert.equal(plan.diagnostics.originStreetPathVerified, false)
    assert.equal(plan.diagnostics.destinationStreetPathVerified, false)
    assert.equal(plan.diagnostics.roadMetricMode, status === 'applied' ? 'traffic-adjusted' : 'free-flow')
    if (!waypoints) assert.match(plan.detail, /5.15 km/)
  }
}
console.log('Studio preserves every Rust drive leg, road-access verification, distance and traffic status.')
