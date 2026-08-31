import assert from 'node:assert/strict'
import {
  nationalChoiceIdentity,
  nationalChoiceStrictlyDominates,
  nationalChoiceSupportedBurdenWeights,
  nationalPublicRouteSequence,
  nationalRideBoardingSummary,
  nationalRoutingReturnedRideCycle,
  selectNationalAlternativeWaypointGroups,
  selectNationalDepartureWindowChoices,
} from '../server/national-route-choices.mjs'
import { stitchNationalAlternativePlans } from '../server/national-gtfs-store.mjs'

function readyPlan({
  id,
  departMinutes,
  durationMinutes,
  transfers,
  walkMinutes,
  routes,
  trip = id,
}) {
  return {
    id,
    status: 'ready',
    travelMode: 'transit',
    departMinutes,
    arriveMinutes: departMinutes + durationMinutes,
    durationMinutes,
    transfers,
    walkMinutes,
    recommended: false,
    choiceLabel: 'sample',
    legs: routes.map((routeId, index) => ({
      type: 'ride',
      routeId,
      routeShortName: routeId,
      tripId: `${trip}-${index}`,
      fromStopId: `${routeId}-from`,
      toStopId: `${routeId}-to`,
    })),
    diagnostics: {},
  }
}

const centerMinutes = 8 * 60
const sameRouteEarly = readyPlan({
  id: 'same-route-early', departMinutes: 470, durationMinutes: 35,
  transfers: 0, walkMinutes: 5, routes: ['R1'], trip: 'early-trip',
})
const exactSelectedTime = readyPlan({
  id: 'exact-selected-time', departMinutes: centerMinutes, durationMinutes: 30,
  transfers: 0, walkMinutes: 5, routes: ['R1'], trip: 'exact-trip',
})
const sameRouteLate = readyPlan({
  id: 'same-route-late', departMinutes: 490, durationMinutes: 32,
  transfers: 0, walkMinutes: 5, routes: ['R1'], trip: 'late-trip',
})
const fastest = readyPlan({
  id: 'fastest', departMinutes: 475, durationMinutes: 21,
  transfers: 2, walkMinutes: 2, routes: ['R2', 'R2', 'R3'],
})
const duplicateFastSequence = readyPlan({
  id: 'duplicate-fast-sequence', departMinutes: 485, durationMinutes: 24,
  transfers: 1, walkMinutes: 2, routes: ['R2', 'R3'], trip: 'other-trip',
})
const fewestTransfers = readyPlan({
  id: 'fewest-transfers', departMinutes: 478, durationMinutes: 28,
  transfers: 0, walkMinutes: 3, routes: ['Route-5'],
})
const leastWalking = readyPlan({
  id: 'least-walking', departMinutes: 482, durationMinutes: 27,
  transfers: 2, walkMinutes: 0.1, routes: ['R4', 'R6', 'R7'],
})
const blocked = { ...fastest, id: 'blocked', status: 'blocked', legs: [] }

assert.equal(nationalPublicRouteSequence(fastest), 'R2>R2>R3')
assert.equal(nationalPublicRouteSequence(duplicateFastSequence), 'R2>R3')
assert.deepEqual(nationalRideBoardingSummary(fastest), {
  boardingCount: 3,
  transfers: 2,
  routeSequence: ['R2', 'R2', 'R3'],
  publicLabels: ['R2', 'R2', 'R3'],
  title: 'R2 -> R2 -> R3',
})

const choices = selectNationalDepartureWindowChoices([
  sameRouteEarly,
  exactSelectedTime,
  sameRouteLate,
  fastest,
  duplicateFastSequence,
  fewestTransfers,
  leastWalking,
  blocked,
], { centerMinutes, limit: 5 })

assert.deepEqual(
  choices.map((choice) => choice.id),
  ['fastest', 'fewest-transfers', 'duplicate-fast-sequence', 'least-walking'],
  'Visible choices must stay on the measured elapsed-time, journey-time, transfer, and walking frontier.',
)
assert.deepEqual(
  choices.map((choice) => choice.choiceLabel),
  ['Fastest', 'Fewest transfers', 'Alternate', 'Least walking'],
)
assert.equal(choices.filter((choice) => choice.recommended).length, 1)
assert.equal(choices[0].recommended, true)
assert(!choices.some((choice) => choice.id === exactSelectedTime.id),
  'A dominated selected-time sample must not be forced back into a later-departure choice set.')
assert(choices.every((choice) => choice.diagnostics.selectedTimeChoice === false))
assert(!choices.some((choice) => choice.id === sameRouteEarly.id || choice.id === sameRouteLate.id))
assert.equal(new Set(choices.map(nationalPublicRouteSequence)).size, choices.length)
assert(
  choices.every((choice) => choice.transfers === Math.max(0, choice.legs.filter((leg) => leg.type === 'ride').length - 1)),
  'A public route sequence must preserve every boarding counted by the transfer total.',
)

const longerEarlier = readyPlan({
  id: '08-10-longer-journey', departMinutes: centerMinutes + 10, durationMinutes: 20,
  transfers: 0, walkMinutes: 2, routes: ['Local'], trip: '08-10-local',
})
const shorterLater = readyPlan({
  id: '08-25-shorter-journey', departMinutes: centerMinutes + 25, durationMinutes: 6,
  transfers: 0, walkMinutes: 2, routes: ['Express'], trip: '08-25-express',
})
const timeTradeoffChoices = selectNationalDepartureWindowChoices(
  [longerEarlier, shorterLater],
  { centerMinutes, limit: 5 },
)
assert.deepEqual(
  timeTradeoffChoices.map((choice) => choice.id),
  ['08-10-longer-journey', '08-25-shorter-journey'],
  'A later short journey must remain visible when it arrives one minute later than an earlier long journey.',
)
assert.equal(timeTradeoffChoices[0].choiceLabel, 'Fastest')
assert.equal(timeTradeoffChoices[1].choiceLabel, 'Shortest journey')
assert.equal(timeTradeoffChoices[0].durationMinutes, 20)
assert.equal(timeTradeoffChoices[1].durationMinutes, 6)

const constrained = selectNationalDepartureWindowChoices([
  sameRouteEarly,
  exactSelectedTime,
  fastest,
  fewestTransfers,
  leastWalking,
], { centerMinutes, limit: 2 })
assert.equal(constrained.length, 2)
assert(!constrained.some((choice) => choice.id === exactSelectedTime.id),
  'A tight choice limit must not displace a frontier journey with a dominated selected-time sample.')

const duplicatesOnly = selectNationalDepartureWindowChoices([
  sameRouteEarly,
  sameRouteLate,
], { centerMinutes, limit: 5 })
assert.equal(duplicatesOnly.length, 1, 'Trip and departure duplicates must not be presented as fake alternatives.')
assert.equal(duplicatesOnly[0].choiceLabel, 'Fastest')

const dominatedButDistinct = Array.from({ length: 6 }, (_, index) => readyPlan({
  id: `distinct-${index}`,
  departMinutes: centerMinutes + index,
  durationMinutes: 20 + index * 5,
  transfers: index,
  walkMinutes: 2 + index,
  routes: [`D${index}`],
}))
const fiveRealChoices = selectNationalDepartureWindowChoices(dominatedButDistinct, { centerMinutes, limit: 5 })
assert.deepEqual(
  fiveRealChoices.map((choice) => choice.id),
  ['distinct-0'],
  'The display limit is a maximum, not a target: dominated public ride sequences must not refill empty slots.',
)

const sameLineDifferentStation = {
  ...exactSelectedTime,
  id: 'same-line-different-station',
  legs: exactSelectedTime.legs.map((leg) => ({ ...leg, fromStopId: 'R1-other-station' })),
}
const stationAlternatives = selectNationalDepartureWindowChoices(
  [exactSelectedTime, sameLineDifferentStation],
  { centerMinutes, limit: 5 },
)
assert.equal(stationAlternatives.length, 2, 'Same-line journeys using different boarding stations are real alternatives and must not collapse.')
assert.notEqual(nationalChoiceIdentity(exactSelectedTime), nationalChoiceIdentity(sameLineDifferentStation))

const dcBest = readyPlan({
  id: 'dc-m82-red-best',
  departMinutes: centerMinutes + 14,
  durationMinutes: 33,
  transfers: 1,
  walkMinutes: 9,
  routes: ['M82', 'Red'],
})
const dcInferiorOne = readyPlan({
  id: 'dc-m82-red-inferior-one',
  departMinutes: centerMinutes + 18,
  durationMinutes: 49,
  transfers: 1,
  walkMinutes: 31,
  routes: ['M82', 'Red'],
})
const dcInferiorTwo = readyPlan({
  id: 'dc-m82-red-inferior-two',
  departMinutes: centerMinutes + 21,
  durationMinutes: 57,
  transfers: 1,
  walkMinutes: 33,
  routes: ['M82', 'Red'],
})
for (const [plan, suffix] of [[dcBest, 'best'], [dcInferiorOne, 'inferior-one'], [dcInferiorTwo, 'inferior-two']]) {
  plan.legs = plan.legs.map((leg) => ({
    ...leg,
    fromStopId: `${leg.fromStopId}-${suffix}`,
    toStopId: `${leg.toStopId}-${suffix}`,
  }))
}
const dcScreenshotChoices = selectNationalDepartureWindowChoices(
  [dcBest, dcInferiorOne, dcInferiorTwo],
  { centerMinutes, limit: 5 },
)
assert.equal(nationalChoiceStrictlyDominates(dcBest, dcInferiorOne, centerMinutes), true)
assert.deepEqual(
  dcScreenshotChoices.map((choice) => choice.id),
  ['dc-m82-red-best'],
  'Later M82 -> Red station variants with the same transfers and much more elapsed time and walking must be removed.',
)

const harvardMicroChain = readyPlan({
  id: 'harvard-micro-chain', departMinutes: centerMinutes, durationMinutes: 43,
  transfers: 2, walkMinutes: 16, routes: ['Red', '96', '66'],
})
const harvardSimpleRide = readyPlan({
  id: 'harvard-simple-ride', departMinutes: centerMinutes, durationMinutes: 49,
  transfers: 0, walkMinutes: 41, routes: ['Red'],
})
const harvardChoices = selectNationalDepartureWindowChoices(
  [harvardMicroChain, harvardSimpleRide],
  { centerMinutes, limit: 5 },
)
assert.equal(
  harvardChoices.find((choice) => choice.recommended)?.id,
  'harvard-micro-chain',
  'The recommended journey must be the shortest total elapsed route; transfer count remains a secondary choice.',
)

const selectedComplexChoice = readyPlan({
  id: 'selected-complex', departMinutes: centerMinutes, durationMinutes: 33,
  transfers: 2, walkMinutes: 11, routes: ['D10', 'Silver', 'Green'],
})
const laterSimplerChoice = readyPlan({
  id: 'later-simpler', departMinutes: centerMinutes + 10, durationMinutes: 29,
  transfers: 1, walkMinutes: 10, routes: ['D10', 'Green'],
})
const laterSimplerChoices = selectNationalDepartureWindowChoices(
  [selectedComplexChoice, laterSimplerChoice],
  { centerMinutes, limit: 5 },
)
assert.equal(
  laterSimplerChoices.find((choice) => choice.recommended)?.id,
  'selected-complex',
  'A later start must include its initial wait, so a 29-minute journey leaving ten minutes later ranks as 39 minutes.',
)

const fastReference = readyPlan({
  id: 'fast-reference', departMinutes: centerMinutes, durationMinutes: 203,
  transfers: 2, walkMinutes: 64, routes: ['640', 'R', 'IC5'],
})
const nominalLeastWalk = readyPlan({
  id: 'nominal-least-walk', departMinutes: centerMinutes, durationMinutes: 224,
  transfers: 5, walkMinutes: 47, routes: ['640', 'R', 'IC5', 'S37', '6', '5'],
})
const relevantAccessible = readyPlan({
  id: 'relevant-accessible', departMinutes: centerMinutes, durationMinutes: 230,
  transfers: 5, walkMinutes: 12, routes: ['640', 'R', 'IC5', 'Lift', '5', '7'],
})
const qualityChoices = selectNationalDepartureWindowChoices(
  [fastReference, nominalLeastWalk, relevantAccessible],
  { centerMinutes, limit: 5 },
)
assert(!qualityChoices.some((choice) => choice.id === nominalLeastWalk.id),
  'An unsupported interior tradeoff must not be presented as a decision-relevant alternative.')
assert(qualityChoices.some((choice) => choice.id === relevantAccessible.id),
  'A complex journey must survive when it materially reduces walking for an accessibility-sensitive rider.')
assert.equal(
  nationalChoiceSupportedBurdenWeights(
    nominalLeastWalk,
    [fastReference, nominalLeastWalk, relevantAccessible],
    centerMinutes,
  ),
  null,
  'The middle route is never optimal for any nonnegative transfer and walking weights.',
)
assert(
  nationalChoiceSupportedBurdenWeights(
    relevantAccessible,
    [fastReference, nominalLeastWalk, relevantAccessible],
    centerMinutes,
  ),
  'The least-walking route must have an explicit generalized-cost weight witness.',
)
assert(
  qualityChoices.every((choice) => (
    choice.diagnostics.choiceSupport?.nonnegativeWeightFeasibility
      === 'exact_half_plane_intersection'
  )),
  'Every visible choice must disclose its supported-front witness method.',
)

const directRide = readyPlan({
  id: 'direct-ride', departMinutes: centerMinutes, durationMinutes: 35,
  transfers: 0, walkMinutes: 8, routes: ['Direct'],
})
directRide.legs[0].coordinates = [[7.20, 47.10], [7.28, 47.15]]
const explicitRideLoop = readyPlan({
  id: 'explicit-ride-loop', departMinutes: centerMinutes, durationMinutes: 37,
  transfers: 2, walkMinutes: 7, routes: ['Out', 'Back', 'Finish'],
})
explicitRideLoop.legs[0].coordinates = [[7.20, 47.10], [7.24, 47.12]]
explicitRideLoop.legs[1].coordinates = [[7.24, 47.12], [7.2005, 47.1004]]
explicitRideLoop.legs[2].coordinates = [[7.2005, 47.1004], [7.28, 47.15]]
const loopChoices = selectNationalDepartureWindowChoices(
  [directRide, explicitRideLoop],
  { centerMinutes, limit: 5 },
)
assert.deepEqual(loopChoices.map((choice) => choice.id), ['direct-ride', 'explicit-ride-loop'],
  'Geometry proximity alone must not suppress a timetable-valid journey without a repeated stop or station group.')
assert.equal(
  nationalRoutingReturnedRideCycle(explicitRideLoop),
  null,
  'A shape that approaches an earlier boarding area is not source evidence of a repeated transit state.',
)

const passThroughStationLoop = readyPlan({
  id: 'pass-through-station-loop', departMinutes: centerMinutes, durationMinutes: 54,
  transfers: 3, walkMinutes: 6, routes: ['IC5', 'S37', '6', '5'],
})
passThroughStationLoop.legs[0].coordinates = [[7.05, 47.00], [7.24, 47.13]]
passThroughStationLoop.legs[1].coordinates = [[7.24, 47.13], [7.25, 47.11]]
passThroughStationLoop.legs[2].coordinates = [
  [7.25, 47.11],
  [7.255, 47.12],
  [7.24, 47.13],
  [7.245, 47.15],
]
passThroughStationLoop.legs[3].coordinates = [[7.245, 47.15], [7.26, 47.18]]
const passThroughStationChoices = selectNationalDepartureWindowChoices(
  [directRide, passThroughStationLoop],
  { centerMinutes, limit: 5 },
)
assert.deepEqual(passThroughStationChoices.map((choice) => choice.id), ['direct-ride', 'pass-through-station-loop'],
  'Passing near an earlier station in display geometry cannot prove the rider revisited that transit state.')

const sameStationGroupOutAndBack = {
  ...explicitRideLoop,
  id: 'same-station-group-out-and-back',
  snappedOrigin: { id: 'station-a-platform-1', parentStationId: 'station-a' },
  snappedDestination: { id: 'station-a-platform-2', parentStationId: 'station-a' },
  legs: explicitRideLoop.legs.map((leg) => ({ ...leg })),
}
sameStationGroupOutAndBack.legs[0].fromStationGroupId = 'station-a'
sameStationGroupOutAndBack.legs[0].toStationGroupId = 'station-b'
sameStationGroupOutAndBack.legs[1].fromStationGroupId = 'station-b'
sameStationGroupOutAndBack.legs[1].toStationGroupId = 'station-a'
sameStationGroupOutAndBack.legs[2].fromStationGroupId = 'station-a'
sameStationGroupOutAndBack.legs[2].toStationGroupId = 'station-c'
assert.equal(
  nationalRoutingReturnedRideCycle(sameStationGroupOutAndBack)?.stationGroupId,
  'station-a',
  'A repeated persisted parent-station identity proves a returned transit state.',
)
assert.deepEqual(
  selectNationalDepartureWindowChoices([sameStationGroupOutAndBack], { centerMinutes, limit: 5 }),
  [],
  'A proven station-group cycle must not be resurrected merely because it is the only timetable result.',
)

const distinctEndpointReturnJourney = {
  ...sameStationGroupOutAndBack,
  id: 'distinct-endpoint-return-journey',
  snappedDestination: { id: 'station-c-platform-1', parentStationId: 'station-c' },
  legs: sameStationGroupOutAndBack.legs.map((leg) => {
    const copy = { ...leg }
    delete copy.fromStationGroupId
    delete copy.toStationGroupId
    return copy
  }),
}
assert.equal(
  nationalRoutingReturnedRideCycle(distinctEndpointReturnJourney),
  null,
  'Snapped endpoint groups and route geometry alone cannot manufacture a repeated ride state.',
)
assert.deepEqual(
  selectNationalDepartureWindowChoices([distinctEndpointReturnJourney], { centerMinutes, limit: 5 })
    .map((choice) => choice.id),
  ['distinct-endpoint-return-journey'],
  'A return-shaped journey between distinct endpoint groups must remain eligible when it is the only result.',
)

const legitimateOneMinuteRide = readyPlan({
  id: 'legitimate-one-minute-ride',
  departMinutes: centerMinutes,
  durationMinutes: 1,
  transfers: 0,
  walkMinutes: 0,
  routes: ['Shuttle'],
})
legitimateOneMinuteRide.snappedOrigin = { id: 'short-a', parentStationId: 'short-a' }
legitimateOneMinuteRide.snappedDestination = { id: 'short-b', parentStationId: 'short-b' }
legitimateOneMinuteRide.legs[0] = {
  ...legitimateOneMinuteRide.legs[0],
  fromStopId: 'short-a',
  toStopId: 'short-b',
  startMinutes: centerMinutes,
  endMinutes: centerMinutes + 1,
  durationMinutes: 1,
  coordinates: [[-71.10, 42.35], [-71.095, 42.35]],
}
assert.deepEqual(
  selectNationalDepartureWindowChoices([legitimateOneMinuteRide], { centerMinutes, limit: 5 })
    .map((choice) => choice.id),
  ['legitimate-one-minute-ride'],
)
assert.equal(
  nationalRoutingReturnedRideCycle(legitimateOneMinuteRide),
  null,
  'A distinct A-to-B ride is not a cycle regardless of its duration.',
)

const exactStopReturnedCycle = readyPlan({
  id: 'exact-stop-returned-cycle',
  departMinutes: centerMinutes,
  durationMinutes: 42,
  transfers: 2,
  walkMinutes: 5,
  routes: ['P12', 'Green', 'Green'],
})
exactStopReturnedCycle.legs[0] = {
  ...exactStopReturnedCycle.legs[0],
  fromStopId: 'origin-bus',
  toStopId: 'greenbelt-bus',
}
exactStopReturnedCycle.legs[1] = {
  ...exactStopReturnedCycle.legs[1],
  fromStopId: 'greenbelt-platform',
  toStopId: 'college-park-platform',
}
exactStopReturnedCycle.legs[2] = {
  ...exactStopReturnedCycle.legs[2],
  fromStopId: 'college-park-platform',
  toStopId: 'greenbelt-platform',
}
assert.deepEqual(
  nationalRoutingReturnedRideCycle(exactStopReturnedCycle),
  {
    firstLegIndex: 1,
    lastLegIndex: 2,
    firstRideIndex: 1,
    lastRideIndex: 2,
    departureStopId: 'greenbelt-platform',
    returnedStopId: 'greenbelt-platform',
    stationGroupId: 'greenbelt-platform',
    exactStopReturn: true,
    cycleBoardings: 2,
  },
  'A ride out from and back to the same exact transit stop is a proven cycle.',
)
assert.equal(
  nationalRoutingReturnedRideCycle(passThroughStationLoop),
  null,
  'Geometry-only corridor re-entry is not strong enough to suppress the sole point-route result.',
)

const platformReturnedCycle = {
  ...exactStopReturnedCycle,
  legs: exactStopReturnedCycle.legs.map((leg) => ({ ...leg })),
}
platformReturnedCycle.legs[1].fromStopId = 'greenbelt-platform-a'
platformReturnedCycle.legs[2].toStopId = 'greenbelt-platform-b'
const platformGroups = new Map([
  ['greenbelt-platform-a', 'greenbelt-station'],
  ['greenbelt-platform-b', 'greenbelt-station'],
])
assert.equal(
  nationalRoutingReturnedRideCycle(platformReturnedCycle, {
    stationGroupForStopId: (stopId) => platformGroups.get(stopId) ?? stopId,
  })?.exactStopReturn,
  false,
  'A station-group return remains detectable without pretending two platforms are the same stop.',
)

assert.deepEqual(selectNationalDepartureWindowChoices([blocked], { centerMinutes }), [])

const waypointGroups = selectNationalAlternativeWaypointGroups([
  { stop_id: 'near-bus', distanceKm: 0.1, accessPriority: 'sampled-bus:near-bus' },
  { stop_id: 'just-outside-budget', parent_station: 'rail-near', distanceKm: 1.217, accessPriority: 'sampled-rail-station:rail-near' },
  { stop_id: 'rail-a-1', parent_station: 'rail-a', distanceKm: 1.7, accessPriority: 'sampled-rail-station:rail-a' },
  { stop_id: 'rail-a-2', parent_station: 'rail-a', distanceKm: 1.7, accessPriority: 'sampled-rail-station:rail-a' },
  { stop_id: 'rail-b', parent_station: 'rail-b', distanceKm: 2.2, accessPriority: 'sampled-rail-station:rail-b' },
  { stop_id: 'too-far', parent_station: 'rail-c', distanceKm: 3.1, accessPriority: 'sampled-rail-station:rail-c' },
], { preferredWalkKm: 1.2, alternativeWalkKm: 2.8, limit: 6 })
assert.deepEqual(
  waypointGroups.map((group) => group.stopIds),
  [['just-outside-budget'], ['rail-a-1', 'rail-a-2'], ['rail-b']],
  'Alternative waypoints must be generic grouped station candidates outside the preferred walk budget.',
)

const firstHalf = {
  ...readyPlan({
    id: 'first-half', departMinutes: centerMinutes, durationMinutes: 20,
    transfers: 0, walkMinutes: 2, routes: ['Rail'], trip: 'through-trip',
  }),
  origin: { label: 'A', coordinate: [0, 0] },
  destination: { label: 'Waypoint', coordinate: [1, 1] },
  snappedOrigin: { id: 'origin-stop' },
  snappedDestination: { id: 'waypoint-stop' },
  rideMinutes: 18,
  waitMinutes: 0,
  legs: [
    { type: 'walk', fromName: 'A', toName: 'Origin stop', startMinutes: 480, endMinutes: 482, durationMinutes: 2, distanceKm: 0.1, coordinates: [[0, 0], [0.1, 0.1]] },
    { type: 'ride', routeId: 'Rail', routeShortName: 'Rail', tripId: 'through-trip-0', fromStopId: 'origin-stop', toStopId: 'waypoint-stop', fromName: 'Origin stop', toName: 'Waypoint', startMinutes: 482, endMinutes: 500, durationMinutes: 18, distanceKm: 8, stopCount: 4, coordinates: [[0.1, 0.1], [1, 1]] },
    { type: 'walk', fromStopId: 'waypoint-stop', fromName: 'Waypoint', toName: 'Waypoint', startMinutes: 500, endMinutes: 500, durationMinutes: 0, distanceKm: 0, coordinates: [[1, 1], [1, 1]] },
  ],
}
const secondHalf = {
  ...readyPlan({
    id: 'second-half', departMinutes: 500, durationMinutes: 20,
    transfers: 1, walkMinutes: 3, routes: ['Rail', 'Bus'], trip: 'second',
  }),
  origin: { label: 'Waypoint', coordinate: [1, 1] },
  destination: { label: 'B', coordinate: [2, 2] },
  snappedOrigin: { id: 'waypoint-stop' },
  snappedDestination: { id: 'destination-stop' },
  rideMinutes: 14,
  waitMinutes: 3,
  legs: [
    { type: 'walk', fromName: 'Waypoint', toName: 'Waypoint', startMinutes: 500, endMinutes: 500, durationMinutes: 0, distanceKm: 0, coordinates: [[1, 1], [1, 1]] },
    { type: 'ride', routeId: 'Rail', routeShortName: 'Rail', tripId: 'through-trip-0', fromStopId: 'waypoint-stop', toStopId: 'transfer-stop', fromName: 'Waypoint', toName: 'Transfer stop', startMinutes: 500, endMinutes: 505, durationMinutes: 5, distanceKm: 2, stopCount: 1, coordinates: [[1, 1], [1.2, 1.2]] },
    { type: 'ride', routeId: 'Bus', routeShortName: 'Bus', tripId: 'bus-trip', fromStopId: 'transfer-stop', toStopId: 'destination-stop', fromName: 'Transfer stop', toName: 'Destination stop', startMinutes: 508, endMinutes: 517, durationMinutes: 9, distanceKm: 3, stopCount: 3, coordinates: [[1.2, 1.2], [1.8, 1.8]] },
    { type: 'walk', fromStopId: 'destination-stop', fromName: 'Destination stop', toName: 'B', startMinutes: 517, endMinutes: 520, durationMinutes: 3, distanceKm: 0.2, coordinates: [[1.8, 1.8], [2, 2]] },
  ],
}
const stitched = stitchNationalAlternativePlans(firstHalf, secondHalf, {
  origin: firstHalf.origin,
  destination: secondHalf.destination,
  preferredWalkKm: 1.2,
  waypoint: { stopId: 'waypoint-stop', name: 'Waypoint' },
})
assert.equal(stitched.status, 'ready')
assert.deepEqual(stitched.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName), ['Rail', 'Bus'])
assert.equal(stitched.transfers, 1, 'A through trip split at a waypoint must remain one ride before the real transfer.')
assert.equal(stitched.durationMinutes, 40)
assert.equal(stitched.walkMinutes, 5)
assert.equal(stitched.diagnostics.alternativeStrategy, 'station_pareto_waypoint')

console.log('National departure-window choice contracts passed.')
