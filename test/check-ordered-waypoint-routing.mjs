import assert from 'node:assert/strict'

import {
  composeOrderedRoutingFailure,
  composeOrderedRoutingPlans,
  routeOrderedRoutingSegments,
  validateOrderedRoutingPoints,
} from '../src/server/ordered-route-composition.mjs'
import { parseRoutingCommand } from '../src/routingCommand.ts'
import {
  appendRoutingPointSequence,
  insertRoutingPointBeforeDestination,
  maxRoutingPointCount,
  normalizeOrderedRoutingPoints,
} from '../src/routingPointSequence.ts'

const point = (label, longitude) => ({
  label,
  coordinate: [longitude, 40],
  source: 'map',
})

const a = point('Map point A', -75)
const b = point('Map point B', -74.9)
const c = point('Map point C', -74.8)
const d = point('Map point', -74.7)

const picked = [a, b, c, d].reduce(
  (points, nextPoint) => appendRoutingPointSequence(points, nextPoint),
  [],
)
assert.deepEqual(
  picked.map((entry) => entry.label),
  ['Starting point', 'Via stop 1', 'Via stop 2', 'Destination'],
)
assert.deepEqual(picked.map((entry) => entry.coordinate[0]), [-75, -74.9, -74.8, -74.7])

const addedVia = insertRoutingPointBeforeDestination([a, d], c)
assert.deepEqual(
  addedVia.map((entry) => entry.label),
  ['Starting point', 'Via stop 1', 'Destination'],
)
assert.deepEqual(
  addedVia.map((entry) => entry.coordinate[0]),
  [-75, -74.8, -74.7],
  'Adding a map via point must preserve the existing destination as the destination.',
)

const reorderedPicked = normalizeOrderedRoutingPoints([picked[0], picked[2], picked[1], picked[3]])
assert.deepEqual(
  reorderedPicked.map((entry) => entry.label),
  ['Starting point', 'Via stop 1', 'Via stop 2', 'Destination'],
)
assert.deepEqual(reorderedPicked.map((entry) => entry.coordinate[0]), [-75, -74.8, -74.9, -74.7])

const cappedPicked = Array.from({ length: maxRoutingPointCount + 1 }, (_, index) => (
  point('Map point', -75 + index * 0.01)
)).reduce(
  (points, nextPoint) => appendRoutingPointSequence(points, nextPoint),
  [],
)
assert.equal(cappedPicked.length, maxRoutingPointCount)

const command = parseRoutingCommand('drive from Map point A -> Map point B -> Map point C')
assert.deepEqual(command?.locationTexts, ['Map point A', 'Map point B', 'Map point C'])
assert.deepEqual(command?.waypointTexts, ['Map point B'])
assert.equal(command?.originText, 'Map point A')
assert.equal(command?.destinationText, 'Map point C')

assert.deepEqual(validateOrderedRoutingPoints(a, [b], c), [a, b, c])
assert.throws(
  () => validateOrderedRoutingPoints(a, [a], c),
  (error) => error?.code === 'VIGO_DUPLICATE_CONSECUTIVE_POINT',
  'Consecutive duplicate points must be rejected before routing.',
)

function streetPlan(id, origin, destination, departMinutes, durationMinutes) {
  return {
    id,
    status: 'ready',
    travelMode: 'drive',
    timePreference: 'depart',
    maxWalkKm: 0,
    choiceLabel: 'Fastest drive',
    recommended: true,
    title: id,
    detail: id,
    departMinutes,
    arriveMinutes: departMinutes + durationMinutes,
    durationMinutes,
    waitMinutes: 0,
    walkMinutes: 0,
    rideMinutes: durationMinutes,
    transfers: 0,
    origin,
    destination,
    legs: [{
      type: 'drive',
      travelMode: 'drive',
      fromName: origin.label,
      toName: destination.label,
      startMinutes: departMinutes,
      endMinutes: departMinutes + durationMinutes,
      durationMinutes,
      distanceKm: durationMinutes,
      stopCount: 0,
      coordinates: [origin.coordinate, destination.coordinate],
    }],
    diagnostics: {
      scannedDepartures: 0,
      relaxedStops: 0,
      serviceDay: 'weekday',
      scheduleMode: 'none',
      walkingNetwork: 'direct',
      walkingSpeedKph: 0,
      searchStats: { queryMs: 1, engineQueryMs: 0.5 },
    },
  }
}

const abc = composeOrderedRoutingPlans([
  streetPlan('a-b', a, b, 480, 10),
  streetPlan('b-c', b, c, 490, 15),
], [a, b, c], { mode: 'drive', timePreference: 'depart' })

assert.equal(abc.origin, a)
assert.deepEqual(abc.waypoints, [b])
assert.equal(abc.destination, c)
assert.equal(abc.departMinutes, 480)
assert.equal(abc.arriveMinutes, 505)
assert.equal(abc.durationMinutes, 25)
assert.deepEqual(abc.legs.map((leg) => [leg.fromName, leg.toName]), [
  ['Map point A', 'Map point B'],
  ['Map point B', 'Map point C'],
])
assert.equal(abc.diagnostics.algorithm, 'ordered_waypoint_composition')
assert.equal(abc.diagnostics.optimality, 'exact_per_leg_for_fixed_user_order')
assert.equal(abc.diagnostics.sequenceOptimization, 'user_order_preserved')
assert.equal(abc.diagnostics.searchStats.componentSearches, 2)
assert.equal(abc.diagnostics.searchStats.queryMs, 2)

const acb = composeOrderedRoutingPlans([
  streetPlan('a-c', a, c, 480, 12),
  streetPlan('c-b', c, b, 492, 8),
], [a, c, b], { mode: 'drive', timePreference: 'depart' })
assert.deepEqual(acb.waypoints, [c])
assert.equal(acb.destination, b)
assert.notEqual(acb.id, abc.id, 'Changing destination order must create a distinct route identity.')
assert.deepEqual(acb.legs.map((leg) => [leg.fromName, leg.toName]), [
  ['Map point A', 'Map point C'],
  ['Map point C', 'Map point B'],
])

const departRequests = []
const departed = await routeOrderedRoutingSegments(
  [a, b, c],
  { mode: 'drive', timePreference: 'depart', departMinutes: 480, departureWindowMinutes: 20 },
  async (request, index) => {
    departRequests.push(request)
    return streetPlan(`depart-${index}`, request.origin, request.destination, request.departMinutes, index === 0 ? 10 : 15)
  },
)
assert.equal(departed.failedIndex, -1)
assert.deepEqual(departRequests.map((request) => request.departMinutes), [480, 490])
assert.deepEqual(departRequests.map((request) => request.departureWindowMinutes), [20, 0])

await assert.rejects(() => routeOrderedRoutingSegments([a, b, c],
  { mode: 'transit', maxTransfers: 1 }, () => assert.fail('Do not apply an overall cap independently per segment')),
/ordered transit waypoints/)

const arriveRequests = []
const arrived = await routeOrderedRoutingSegments(
  [a, b, c],
  { mode: 'transit', timePreference: 'arrive', arriveMinutes: 600 },
  async (request, index) => {
    arriveRequests.push({ ...request, index })
    const durationMinutes = index === 1 ? 12 : 8
    const plan = streetPlan(`arrive-${index}`, request.origin, request.destination, request.arriveMinutes - durationMinutes, durationMinutes)
    return {
      ...plan,
      travelMode: 'transit',
      timePreference: 'arrive',
      arriveMinutes: request.arriveMinutes,
      legs: plan.legs.map((leg) => ({
        ...leg,
        type: 'ride',
        travelMode: 'transit',
        routeId: `arrive-route-${index}`,
        routeShortName: `R${index}`,
        tripId: `arrive-trip-${index}`,
      })),
    }
  },
)
assert.equal(arrived.failedIndex, -1)
assert.deepEqual(arriveRequests.map((request) => request.index), [1, 0])
assert.deepEqual(arriveRequests.map((request) => request.arriveMinutes), [600, 588])

function transitPlan(id, origin, destination, departMinutes, arriveMinutes, legs) {
  return {
    ...streetPlan(id, origin, destination, departMinutes, arriveMinutes - departMinutes),
    travelMode: 'transit',
    maxWalkKm: 1.2,
    legs,
    rideMinutes: arriveMinutes - departMinutes,
    diagnostics: {
      ...streetPlan(id, origin, destination, departMinutes, arriveMinutes - departMinutes).diagnostics,
      scheduleMode: 'exact',
      walkingNetwork: 'osm',
    },
  }
}

const noOpAtB = (startMinutes) => ({
  type: 'walk',
  travelMode: 'walk',
  fromStopId: 'B',
  toStopId: 'B',
  fromName: b.label,
  toName: b.label,
  startMinutes,
  endMinutes: startMinutes,
  durationMinutes: 0,
  distanceKm: 0,
  stopCount: 0,
  coordinates: [b.coordinate, b.coordinate],
})
const throughRide = (origin, destination, startMinutes, endMinutes) => ({
  type: 'ride',
  travelMode: 'transit',
  routeId: 'T',
  routeShortName: 'T',
  tripId: 'through-trip',
  fromStopId: origin.label.at(-1),
  toStopId: destination.label.at(-1),
  fromName: origin.label,
  toName: destination.label,
  startMinutes,
  endMinutes,
  durationMinutes: endMinutes - startMinutes,
  distanceKm: 1,
  stopCount: 1,
  coordinates: [origin.coordinate, destination.coordinate],
})
const through = composeOrderedRoutingPlans([
  transitPlan('through-a-b', a, b, 480, 490, [
    throughRide(a, b, 480, 490),
    noOpAtB(490),
  ]),
  transitPlan('through-b-c', b, c, 490, 500, [
    noOpAtB(490),
    throughRide(b, c, 490, 500),
  ]),
], [a, b, c], { mode: 'transit', timePreference: 'depart' })
assert.equal(through.legs.filter((leg) => leg.type === 'ride').length, 1)
assert.equal(through.transfers, 0, 'Staying on the same trip through a waypoint must not create a false transfer.')

const walkOnlyBToC = {
  ...streetPlan('walk-only-b-c', b, c, 490, 15),
  travelMode: 'walk',
  legs: [{
    type: 'walk',
    travelMode: 'walk',
    walkSource: 'osm',
    fromName: b.label,
    toName: c.label,
    startMinutes: 490,
    endMinutes: 505,
    durationMinutes: 15,
    distanceKm: 1.1,
    stopCount: 0,
    coordinates: [b.coordinate, c.coordinate],
  }],
  rideMinutes: 0,
  walkMinutes: 15,
  diagnostics: {
    ...streetPlan('walk-only-b-c', b, c, 490, 15).diagnostics,
    algorithm: 'osm_direct_walk_vs_transit',
  },
}
const transitWithWalkOnlyLeg = await routeOrderedRoutingSegments(
  [a, b, c],
  { mode: 'transit', timePreference: 'depart', departMinutes: 480 },
  async (_request, index) => index === 0
    ? transitPlan('transit-a-b', a, b, 480, 490, [throughRide(a, b, 480, 490)])
    : walkOnlyBToC,
)
assert.equal(transitWithWalkOnlyLeg.failedIndex, 1)
assert.equal(transitWithWalkOnlyLeg.failedPlan.status, 'blocked')
assert.equal(
  transitWithWalkOnlyLeg.failedPlan.diagnostics.failureCode,
  'ordered_transit_ride_required',
  'A walk-only component must not silently satisfy an ordered Transit route.',
)
assert.equal(transitWithWalkOnlyLeg.failedPlan.diagnostics.walkOnlyCandidate.distanceKm, 1.1)

const rejectedWalkOnlyComposition = composeOrderedRoutingPlans(
  [
    transitPlan('transit-a-b-compose', a, b, 480, 490, [throughRide(a, b, 480, 490)]),
    walkOnlyBToC,
  ],
  [a, b, c],
  { mode: 'transit', timePreference: 'depart' },
)
assert.equal(rejectedWalkOnlyComposition.status, 'blocked')
assert.equal(rejectedWalkOnlyComposition.title, 'No route for leg 2')
assert.match(rejectedWalkOnlyComposition.detail, /requires at least one scheduled ride/)

const displayedWalkOnlyFailure = composeOrderedRoutingFailure(
  transitWithWalkOnlyLeg.failedPlan,
  transitWithWalkOnlyLeg.failedIndex,
  [a, b, c],
  transitWithWalkOnlyLeg.componentPlans,
)
assert.equal(displayedWalkOnlyFailure.title, 'No route for leg 2')
assert.match(displayedWalkOnlyFailure.detail, /Map point B to Map point C/)

const reversed = [a, b].reverse()
assert.equal(reversed[0], b)
assert.deepEqual(reversed[0].coordinate, b.coordinate)
assert.equal(reversed[1], a)
assert.deepEqual(reversed[1].coordinate, a.coordinate)

console.log('Ordered waypoint routing behavior passed.')
