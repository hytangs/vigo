import assert from 'node:assert/strict'
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

const identified = studioRouteResponse({ ...driveTrace, queryFingerprint: 'engine-query-identity' }, driveBody).choices[0]
assert.equal(identified.diagnostics.routingDataProvenance.reproducibilityKey, 'engine-query-identity')
