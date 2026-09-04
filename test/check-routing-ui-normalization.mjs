import assert from 'node:assert/strict'
import {
  normalizeReceivedRoutingPlan,
  routingPlanJourneyMinutes,
  routingPlanStartWaitMinutes,
  routingPlanTotalWaitMinutes,
  routingPlanTotalElapsedMinutes,
  routingPlanRuntime,
} from '../src/app/routingPlan.ts'
import {
  formatRoutingLegDuration,
  routingLegDetail,
  routingLegPrimaryLabel,
  routingPlanRouteSequence,
} from '../src/app/presentation.ts'

const point = (label) => ({ label, coordinate: [0, 0], source: 'stop' })
const walk = ({
  fromName,
  toName,
  fromStopId,
  toStopId,
  startMinutes,
  endMinutes,
  distanceKm,
  walkSource,
}) => ({
  type: 'walk', travelMode: 'walk', walkSource,
  fromName, toName, fromStopId, toStopId,
  startMinutes, endMinutes,
  durationMinutes: endMinutes - startMinutes,
  distanceKm, stopCount: 0,
  coordinates: [[0, 0], [distanceKm, distanceKm]],
})
const ride = (routeShortName, fromName, toName, startMinutes, endMinutes) => ({
  type: 'ride', travelMode: 'transit', scheduleMode: 'exact',
  routeId: routeShortName, routeShortName, tripId: `${routeShortName}-trip`,
  fromStopId: fromName, toStopId: toName, fromName, toName,
  startMinutes, endMinutes, durationMinutes: endMinutes - startMinutes,
  distanceKm: 1, stopCount: 1, coordinates: [[0, 0], [1, 1]],
})
const plan = (id, legs, overrides = {}) => ({
  id, status: 'ready', travelMode: 'transit', timePreference: 'depart',
  maxWalkKm: 1.6, choiceLabel: 'Earliest arrival', recommended: false,
  title: id, detail: id, departMinutes: 480, arriveMinutes: 526,
  durationMinutes: 46, waitMinutes: 0,
  walkMinutes: legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + leg.durationMinutes, 0),
  rideMinutes: legs.filter((leg) => leg.type === 'ride').reduce((sum, leg) => sum + leg.durationMinutes, 0),
  transfers: Math.max(0, legs.filter((leg) => leg.type === 'ride').length - 1),
  origin: point('Origin terminal'), destination: point('Destination terminal'), legs,
  diagnostics: { serviceDay: 'weekday', serviceDate: '2025-12-08', scheduleMode: 'exact', timingPrecision: 'exact', routingHorizonMinutes: 480, walkingNetwork: 'osm', walkingSpeedKph: 3.8, searchProfile: 'fastest', searchStrategy: 'exact', algorithm: 'fixture', optimality: 'fixture', walkingPolicyId: 'fixture', originWalkKm: 0, destinationWalkKm: 0, scannedDepartures: 0, relaxedStops: 0 },
  ...overrides,
})

const exactStopPlan = plan('exact-stop-plan', [
  walk({ fromName: 'Origin terminal', toName: 'Origin terminal', fromStopId: 'stop-a', toStopId: 'stop-a', startMinutes: 480, endMinutes: 480, distanceKm: 0, walkSource: 'direct' }),
  ride('Line A', 'Origin terminal', 'Transfer hub', 484, 488),
  walk({ fromName: 'Transfer hub', toName: 'Transfer hub', fromStopId: 'stop-b', toStopId: 'stop-c', startMinutes: 488, endMinutes: 489, distanceKm: 0, walkSource: 'transfer' }),
  ride('Line B', 'Transfer hub', 'Second hub', 493, 512),
  walk({ fromName: 'Second hub', toName: 'Second hub', fromStopId: 'stop-d', toStopId: 'stop-e', startMinutes: 512, endMinutes: 513.55, distanceKm: 0.097, walkSource: 'transfer' }),
  ride('Line C', 'Second hub', 'Destination terminal', 516, 526),
  walk({ fromName: 'Destination terminal', toName: 'Destination terminal', fromStopId: 'stop-f', toStopId: 'stop-f', startMinutes: 526, endMinutes: 526, distanceKm: 0, walkSource: 'direct' }),
])
const normalizedExactStopPlan = normalizeReceivedRoutingPlan(exactStopPlan)
assert.equal(normalizedExactStopPlan.legs.length, 5, 'Exact-stop zero-length access and egress cards must be removed.')
assert.equal(normalizedExactStopPlan.legs[0].type, 'ride')
assert.equal(normalizedExactStopPlan.legs.at(-1).type, 'ride')
assert.equal(routingPlanRouteSequence(normalizedExactStopPlan), 'Line A -> Line B -> Line C')
assert.deepEqual(
  normalizedExactStopPlan.legs.filter((leg) => leg.type === 'walk').map(routingLegPrimaryLabel),
  ['Change at Transfer hub', 'Change at Second hub'],
)
assert.deepEqual(
  routingPlanRuntime({
    ...normalizedExactStopPlan,
    diagnostics: {
      ...normalizedExactStopPlan.diagnostics,
      searchStats: { queryMs: 4.934, engineQueryMs: 2.361 },
    },
  }),
  {
    engineMs: 2.361,
    totalMs: 4.934,
    label: '2.4 ms engine · 4.9 ms total',
    title: 'Exact route search: 2.361 ms engine; 4.934 ms including access and materialization.',
  },
)

const transferGhostChain = plan('transfer-ghost-chain', [
  ride('Line D', 'Origin terminal', 'Transfer hub', 510, 518),
  walk({ fromName: 'Transfer hub', toName: 'Transfer entrance', fromStopId: 'L', toStopId: 'L1', startMinutes: 518, endMinutes: 520, distanceKm: 0.117, walkSource: 'transfer' }),
  walk({ fromName: 'Transfer entrance', toName: 'Second entrance', fromStopId: 'L1', toStopId: 'L2', startMinutes: 520, endMinutes: 522, distanceKm: 0.139, walkSource: 'transfer' }),
  walk({ fromName: 'Second entrance', toName: 'Map point B', fromStopId: 'L2', startMinutes: 522, endMinutes: 528, distanceKm: 0.270, walkSource: 'osm' }),
])
const normalizedGhostChain = normalizeReceivedRoutingPlan(transferGhostChain)
const surfaceLegs = normalizedGhostChain.legs.slice(1)
assert.equal(surfaceLegs.length, 1, 'Consecutive transfer/access cards must collapse into one surface walk.')
assert.equal(surfaceLegs[0].fromName, 'Transfer hub')
assert.equal(surfaceLegs[0].toName, 'Map point B')
assert.equal(surfaceLegs[0].walkSource, 'osm')
assert.equal(routingLegPrimaryLabel(surfaceLegs[0]), 'Walk')
assert.match(routingLegDetail(surfaceLegs[0]), /street route/)
assert(!normalizedGhostChain.legs.some((leg, index, legs) => leg.type === 'walk' && legs[index + 1]?.type === 'walk'))

const threeMinuteLater = plan('three-minute-later', [
  ride('Later', 'Origin terminal', 'Destination terminal', 483, 584),
], {
  departMinutes: 483,
  arriveMinutes: 584,
  durationMinutes: 101,
  diagnostics: {
    ...exactStopPlan.diagnostics,
    departureWindow: { centerMinutes: 480, beforeMinutes: 0, afterMinutes: 20, sampleCount: 21 },
  },
})
assert.equal(routingPlanStartWaitMinutes(threeMinuteLater), 3)
assert.equal(routingPlanTotalElapsedMinutes(threeMinuteLater), 104, '08:03-09:44 after an 08:00 request must rank and display as 1h44.')
const shortLaterJourney = plan('short-later-journey', [
  ride('Express', 'Origin terminal', 'Destination terminal', 505, 511),
], {
  departMinutes: 505,
  arriveMinutes: 511,
  durationMinutes: 6,
  diagnostics: {
    ...exactStopPlan.diagnostics,
    departureWindow: { centerMinutes: 480, beforeMinutes: 0, afterMinutes: 30, sampleCount: 31 },
  },
})
assert.equal(routingPlanJourneyMinutes(shortLaterJourney), 6,
  'An 08:25-08:31 alternative must display six minutes from leave to arrival.')
assert.equal(routingPlanTotalWaitMinutes(shortLaterJourney), 25,
  'The same alternative must expose its 25-minute wait after the 08:00 request separately.')
assert.equal(routingPlanTotalElapsedMinutes(shortLaterJourney), 31,
  'Elapsed time remains available for arrival ranking without replacing visible journey time.')

const curbsideWait = plan('curbside-wait', [
  walk({
    fromName: 'Map point A',
    toName: 'Sheridan Blvd & W 101st Ave',
    toStopId: '53-board',
    startMinutes: 500,
    endMinutes: 502,
    distanceKm: 0.131,
    walkSource: 'osm',
  }),
  ride('53', 'Sheridan Blvd & W 101st Ave', 'US 36 & Sheridan Station', 531, 536),
  walk({
    fromName: 'US 36 & Sheridan Station',
    toName: 'US 36 & Sheridan Station',
    fromStopId: '53-alight',
    toStopId: 'FF1-board',
    startMinutes: 536,
    endMinutes: 538,
    distanceKm: 0.076,
    walkSource: 'transfer',
  }),
  ride('FF1', 'US 36 & Sheridan Station', 'Union Station', 547, 561),
  ride('E', 'Union Station Track 12', 'Colorado Station', 567, 591),
], {
  departMinutes: 500,
  arriveMinutes: 591,
  durationMinutes: 91,
  waitMinutes: 44,
})
const normalizedCurbsideWait = normalizeReceivedRoutingPlan(curbsideWait)
assert.equal(normalizedCurbsideWait.departMinutes, 529,
  'A two-minute initial walk for the 08:51 vehicle must be displayed as leaving at 08:49.')
assert.equal(normalizedCurbsideWait.legs[0].startMinutes, 529)
assert.equal(normalizedCurbsideWait.legs[0].endMinutes, 531)
assert.equal(normalizedCurbsideWait.durationMinutes, 62)
assert.equal(normalizedCurbsideWait.waitMinutes, 15,
  'Only waits after the journey has actually begun may remain in the displayed itinerary.')
assert.equal(routingPlanStartWaitMinutes(normalizedCurbsideWait), 29)
assert.equal(routingPlanTotalElapsedMinutes(normalizedCurbsideWait), 91,
  'Deferring the initial walk must not make a later journey rank as though it departed at the requested time.')
assert.deepEqual(
  normalizedCurbsideWait.legs.filter((leg) => leg.type === 'ride').map((leg) => ({
    route: leg.routeShortName,
    tripId: leg.tripId,
    startMinutes: leg.startMinutes,
    endMinutes: leg.endMinutes,
  })),
  curbsideWait.legs.filter((leg) => leg.type === 'ride').map((leg) => ({
    route: leg.routeShortName,
    tripId: leg.tripId,
    startMinutes: leg.startMinutes,
    endMinutes: leg.endMinutes,
  })),
  'Presentation normalization must preserve every selected vehicle and its timetable.',
)
assert.equal(normalizedCurbsideWait.arriveMinutes, curbsideWait.arriveMinutes)

const sourceEqualTimeRide = {
  ...ride('5', 'Schaffhausen, Bahnhof', 'Schaffhausen, Feuerwehrzentrum', 21 * 60 + 17, 21 * 60 + 17),
  sourceEqualTime: true,
  sourceEqualTimeConnectionCount: 1,
  sourceTimestampQuality: 'equal-whole-minute',
  distanceKm: 0.433,
}
assert.equal(
  formatRoutingLegDuration(sourceEqualTimeRide),
  'same minute',
  'A moving ride with equal published timestamps must not be presented as a physical 0m ride.',
)
assert.match(
  routingLegDetail(sourceEqualTimeRide),
  /sub-minute runtime not distinguished/,
  'The itinerary must disclose source timestamp precision instead of inventing travel time.',
)

const laterWindowCurbsideWait = {
  ...curbsideWait,
  diagnostics: {
    ...curbsideWait.diagnostics,
    departureWindow: {
      centerMinutes: 480,
      beforeMinutes: 0,
      afterMinutes: 20,
      sampleCount: 21,
    },
  },
}
const normalizedLaterWindowCurbsideWait = normalizeReceivedRoutingPlan(laterWindowCurbsideWait)
assert.equal(routingPlanStartWaitMinutes(normalizedLaterWindowCurbsideWait), 49)
assert.equal(routingPlanTotalElapsedMinutes(normalizedLaterWindowCurbsideWait), 111,
  'Just-in-time presentation must retain both the later sample offset and initial-walk deferral in ranking.')

console.log(JSON.stringify({
  schemaVersion: 'vigo.routing-ui-normalization.check.v1',
  status: 'passed',
  exactStopPlan: {
    route: routingPlanRouteSequence(normalizedExactStopPlan),
    durationMinutes: normalizedExactStopPlan.durationMinutes,
    visibleLegs: normalizedExactStopPlan.legs.length,
    platformChanges: normalizedExactStopPlan.legs.filter((leg) => leg.type === 'walk').map(routingLegPrimaryLabel),
  },
  ghostChain: {
    visibleSurfaceCards: surfaceLegs.length,
    label: routingLegPrimaryLabel(surfaceLegs[0]),
    detail: routingLegDetail(surfaceLegs[0]),
  },
  laterDeparture: {
    startsAfterRequestedMinutes: routingPlanStartWaitMinutes(threeMinuteLater),
    totalElapsedMinutes: routingPlanTotalElapsedMinutes(threeMinuteLater),
  },
  curbsideWait: {
    requestedDepartMinutes: curbsideWait.departMinutes,
    leaveMinutes: normalizedCurbsideWait.departMinutes,
    deferredMinutes: routingPlanStartWaitMinutes(normalizedCurbsideWait),
    routes: normalizedCurbsideWait.legs
      .filter((leg) => leg.type === 'ride')
      .map((leg) => leg.routeShortName),
  },
}, null, 2))
