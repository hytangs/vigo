import assert from 'node:assert/strict'
import { importTestModules } from './helpers/import-test-modules.mjs'
import { renderedStopAtPoint, selectableStopLayers } from '../src/app/mapStopSelection.ts'

{
  const stop = (id, x, y) => ({ properties: { stopId: id }, geometry: { type: 'Point', coordinates: [x, y] } })
  let hits = [stop('other-feed::S', 12, 0), stop('agency::S', 4, 0), stop('agency::S', 4, 0)]
  let queried = false
  const map = {
    getLayer: id => id === 'vigo-network-stops',
    queryRenderedFeatures: (box, options) => {
      queried = true
      assert.deepEqual(box, [[-18, -18], [18, 18]])
      assert.deepEqual(options.layers, ['vigo-network-stops'])
      return hits
    },
    project: ([x, y]) => ({ x, y }),
  }
  assert.equal(renderedStopAtPoint(map, { x: 0, y: 0 }).properties.stopId, 'agency::S', 'Nearest visible stop wins, not layer order or an unscoped ID')
  hits = [stop('outside-circle', 17, 17), stop('invalid', NaN, 0), { properties: { stopId: 'line' }, geometry: { type: 'LineString', coordinates: [] } }]
  assert.equal(renderedStopAtPoint(map, { x: 0, y: 0 }), undefined, 'A bounding-box corner or invalid geometry is not a nearby stop')
  hits = [stop('edge', 18, 0)]
  assert.equal(renderedStopAtPoint(map, { x: 0, y: 0 }).properties.stopId, 'edge', 'A tap need not land on the small visual dot')
  hits = []
  assert.equal(renderedStopAtPoint(map, { x: 0, y: 0 }), undefined, 'Hidden and offscreen stops are not selected from source data')
  queried = false
  assert.equal(renderedStopAtPoint({ ...map, getLayer: () => undefined }, { x: 0, y: 0 }), undefined)
  assert.equal(queried, false, 'Do not query absent layers while the map loads')
  assert.ok(selectableStopLayers.includes('vigo-selected-stop'), 'The selection ring remains an interactive stop')
}

const [presentation, routeServices, gtfsAnalysis, routePresentation, cityPreview, scheduledVehicles, serviceVehicles, firstRenderTelemetry] = await importTestModules(
  'app/mapPresentation.ts', 'routeServices.ts', 'app/gtfsAnalysis.ts', 'app/routePresentation.ts',
  'app/cityPreview.ts', 'scheduledVehicles.ts', 'serviceVehicles.ts', 'app/mapFirstRenderTelemetry.ts',
)
// Route arrows follow trip geometry, including overlapping outbound/return segments.
{
  const route = { coordinates: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]] }
  assert.equal(serviceVehicles.routeDirectionBearing([0.5, 0], route), 90)
  assert.equal(serviceVehicles.routeDirectionBearing([0.5, 1], route), 270)
  const trip = { stopTimes: [{ sequence: 1, shapeIndex: 2, progress: 0.5 }, { sequence: 2, shapeIndex: 3, progress: 0.75 }] }
  assert.equal(serviceVehicles.routeDirectionBearing([0.5, 0], route, trip, 2), 270, 'Stop sequence selects the correct leg rather than the nearest opposing leg')
  assert.equal(serviceVehicles.routeDirectionBearing([0.5, 1], route, trip, 1, true), 270, 'Stopped vehicles point along their onward leg')
  const sparse = { coordinates: [[0, 0], [1, 0], [2, 0]] }
  const sharedVertex = { stopTimes: [{ sequence: 1, shapeIndex: 1 }, { sequence: 2, shapeIndex: 1 }] }
  assert.equal(serviceVehicles.routeDirectionBearing([1, 0], sparse, sharedVertex, 2), 90, 'Stops sharing a shape vertex still have a heading')
  const terminal = { stopTimes: [{ sequence: 1, shapeIndex: 2 }, { sequence: 2, shapeIndex: 2 }] }
  assert.equal(serviceVehicles.routeDirectionBearing([2, 0], sparse, terminal, 2), 90, 'The final vertex retains its arriving segment')
  assert.equal(serviceVehicles.routeDirectionBearing([0, 0], undefined), undefined, 'No invented heading without a matched route')
  assert.equal(serviceVehicles.routeDirectionBearing([0, 0], { coordinates: [[0, 0], [0, 0]] }), undefined)
}
const stops = Array.from({ length: 1_200 }, (_value, index) => ({
  id: `stop-${index}`,
  name: `Stop ${index}`,
  lat: 45.8 + (index % 40) * 0.05,
  lon: 5.9 + Math.floor(index / 40) * 0.14,
  x: 0,
  y: 0,
  routes: [],
  tripCount: 0,
  transferScore: 0,
}))
const emptyRouteShells = Array.from({ length: 500 }, (_value, index) => ({
  id: `route-${index}`,
  shortName: `${index}`,
  longName: `${index}`,
  color: '#2f80ed',
  tripCount: 0,
  stopCount: 0,
  headwayMinutes: 0,
  spanHours: 0,
  serviceHours: 0,
  status: 'baseline',
  coordinates: [],
  points: [],
  stopIds: [],
}))

const sameNameBranches = [
  { ...emptyRouteShells[0], id: 'feed::branch-a', routeId: 'agency-a-1', shortName: '1', longName: 'Alpha → Bravo' },
  { ...emptyRouteShells[0], id: 'feed::branch-b', routeId: 'agency-b-1', shortName: '1', longName: 'Charlie → Delta' },
]
assert.notEqual(
  routeServices.scopedRouteServiceKey(sameNameBranches[0]),
  routeServices.scopedRouteServiceKey(sameNameBranches[1]),
  'Same-name GTFS branches must retain distinct route_id identities.',
)
assert.equal(
  routeServices.scopedRouteServiceKey({ ...sameNameBranches[0], id: 'feed::branch-a--pattern-2' }),
  routeServices.scopedRouteServiceKey(sameNameBranches[0]),
  'Patterns from one GTFS route_id must remain grouped in the inspector.',
)
const secondServicePreview = { routes: sameNameBranches, stops: [], stopPairs: [] }
assert.deepEqual(presentation.previewForSelectedRoute({ routes: [], stops: [], stopPairs: [] }, sameNameBranches[1]).routes, [sameNameBranches[1]], 'Keep the explicitly selected line visible when the network preview excludes it')
assert.equal(presentation.previewForSelectedRoute(secondServicePreview, sameNameBranches[1], 'pattern').routes[0].id,
  sameNameBranches[1].id, 'Missing pattern IDs must not select the first unrelated route.')
assert.deepEqual(presentation.previewForSelectedRoute(secondServicePreview, sameNameBranches[1]).routes.map(route => route.id),
  [sameNameBranches[1].id], 'Selected service must remain scoped to its route identity.')

const tiedLabels = routePresentation.routeListLabels([
  { ...sameNameBranches[0], longName: 'Central loop' },
  { ...sameNameBranches[1], longName: 'Central loop' },
])
assert.equal(tiedLabels.get('feed::branch-a'), 'Central loop · agency-a-1')
assert.equal(tiedLabels.get('feed::branch-b'), 'Central loop · agency-b-1')

const sample = presentation.spatiallySampleStops(stops, 120)
assert.equal(sample.length, 120)
assert.ok(new Set(sample.map((stop) => Math.floor((stop.lat - 45.8) / 0.5))).size >= 4)
assert.ok(new Set(sample.map((stop) => Math.floor((stop.lon - 5.9) / 0.7))).size >= 5)
assert.equal(presentation.inferredRouteJumpThresholdKm([0.8, 1.1, 72]), 4.5)
assert.ok(presentation.inferredRouteJumpThresholdKm([34, 48, 62]) >= 100)
assert.deepEqual(
  presentation.routingLabelAnchor([[-77, 38], [-77, 38.01], [-77, 38.03]]),
  [-77, 38.015],
)
assert.equal(presentation.routingLabelAnchor([[-77, 38], [-77, 38.0001]]), null)

assert.deepEqual(presentation.routeStopPairCoordinates([[0, 0], [0.04, 0]], [[0.01, 0], [0.02, 0], [0.03, 0]])
  .map(interval => interval.map(point => point.map(value => Math.round(value * 1e9) / 1e9))),
  [[[0.01, 0], [0.02, 0]], [[0.02, 0], [0.03, 0]]],
  'Adjacent stops inside one sparse shape segment must clip to their projected locations.')
assert.equal(presentation.routeStopPairCoordinates([[0, 0], [0.04, 0]], [[0.01, 1], [0.03, 1]])[0], undefined,
  'Stop-pair overlays must not attach distant stops to an unrelated shape.')

const denseRoutes = Array.from({ length: 160 }, (_value, routeIndex) => (
  Array.from({ length: 3 }, (_patternValue, patternIndex) => ({
    ...emptyRouteShells[0],
    id: `feed::pattern-${routeIndex}-${patternIndex}`,
    routeId: `route-${routeIndex}`,
    patternId: `feed::pattern-${routeIndex}-${patternIndex}`,
    shortName: `${routeIndex}`,
    tripCount: patternIndex + 1,
    stopIds: Array.from({ length: 250 }, (_stopValue, stopIndex) => `feed::stop-${(routeIndex * 17 + stopIndex) % 3_000}`),
    coordinates: Array.from({ length: 250 }, (_coordinateValue, coordinateIndex) => [
      -77.12 + routeIndex * 0.0004 + coordinateIndex * 0.00001,
      38.82 + routeIndex * 0.0003 + coordinateIndex * 0.00001,
    ]),
  }))
)).flat()
const denseStops = Array.from({ length: 3_000 }, (_value, index) => ({
  ...stops[0],
  id: `feed::stop-${index}`,
  name: `DC stop ${index}`,
  lat: 38.78 + (index % 60) * 0.002,
  lon: -77.14 + Math.floor(index / 60) * 0.002,
}))
const selectedPatternId = 'feed::pattern-159-0'
const cityLod = cityPreview.buildCityPreviewLod({
  routes: denseRoutes,
  stops: denseStops,
  stopPairs: [{ id: 'pair-that-must-not-ship' }],
}, selectedPatternId)
const workspaceShapePoints = cityLod.routes.reduce(
  (sum, route) => sum + (route.coordinates?.length ?? 0),
  0,
)

assert.equal(cityLod.routes.length, denseRoutes.length, 'Every public route pattern must remain in the workspace atlas.')
assert.ok(cityLod.stops.length <= 16_000)
assert.equal(cityLod.stopPairs.length, 0)
assert.equal(workspaceShapePoints, denseRoutes.length * 250, 'Published route points must remain unchanged in the workspace atlas.')
assert.ok(cityLod.routes.some((route) => route.id === selectedPatternId))
assert.equal(new Set(cityLod.routes.map(cityPreview.cityPublicRouteKey)).size, cityLod.routes.length)
assert.ok(cityLod.routes.some((route) => route.routeId === 'route-0' && route.tripCount === 3))
const stopFocusedLod = cityPreview.buildCityPreviewLod({ routes: [], stops: denseStops, stopPairs: [] }, '', { maxStops: 16 }, 'feed::stop-2999')
assert.ok(stopFocusedLod.stops.some(stop => stop.id === 'feed::stop-2999'), 'A searched stop remains available for its arrival board even in a sampled network.')
assert.ok(stopFocusedLod.stops.length <= 16)
const sameNameServiceLod = cityPreview.buildCityPreviewLod({
  routes: [
    { ...emptyRouteShells[0], id: 'feed::shuttle-a', routeId: 'shuttle-a', routeType: 3, shortName: 'Orange Line Shuttle', tripCount: 20, coordinates: [[-71.1, 42.3], [-71.0, 42.4]] },
    { ...emptyRouteShells[0], id: 'feed::shuttle-b', routeId: 'shuttle-b', routeType: 3, shortName: 'Orange Line Shuttle', tripCount: 10, coordinates: [[-71.2, 42.3], [-71.1, 42.4]] },
  ],
  stops: [],
  stopPairs: [],
})
assert.equal(sameNameServiceLod.routes.length, 2, 'Same-name route variants must remain independently inspectable.')

const vehiclePreview = {
  routes: [{
    ...emptyRouteShells[0],
    id: 'feed::route-p66::pattern-0',
    routeId: 'P66',
    shortName: 'P66',
    analysisServiceDate: '2026-09-04',
    geometrySource: 'shape',
    coordinates: [[-77.1, 38.9], [-77.05, 38.92], [-77, 38.94]],
    stopIds: ['feed::stop-a', 'feed::stop-b', 'feed::stop-c'],
    firstDepartureMinutes: 480,
    lastArrivalMinutes: 500,
    scheduledTrips: [{
      tripId: 'feed::trip-1',
      routeId: 'P66',
      firstDepartureMinutes: 480,
      lastArrivalMinutes: 500,
      serviceDays: ['weekday'],
      stopTimes: [
        { stopId: 'feed::stop-a', sequence: 1, arrivalMinutes: 480, departureMinutes: 480, progress: 0 },
        { stopId: 'feed::stop-b', sequence: 2, arrivalMinutes: 490, departureMinutes: 491, progress: 0.5 },
        { stopId: 'feed::stop-c', sequence: 3, arrivalMinutes: 500, departureMinutes: 500, progress: 1 },
      ],
    }],
  }],
  stops: [],
  stopPairs: [],
}
const focusedRouteWithoutTrips = {
  ...vehiclePreview.routes[0],
  analysisSource: 'focused',
  analysisServiceDate: '2026-09-04',
  serviceVariantCount: 1,
  spanHours: 1,
  scheduledTrips: undefined,
}
assert.equal(
  gtfsAnalysis.routeHasCompleteGtfsAnalysis(
    focusedRouteWithoutTrips,
    { ...vehiclePreview, routes: [focusedRouteWithoutTrips] },
    '2026-09-04',
  ),
  false,
  'A compact project response without trip-level schedule must refetch the selected route before playback.',
)
assert.equal(
  gtfsAnalysis.routeHasCompleteGtfsAnalysis(
    { ...focusedRouteWithoutTrips, scheduledTrips: [] },
    { ...vehiclePreview, routes: [{ ...focusedRouteWithoutTrips, scheduledTrips: [] }] },
    '2026-09-04',
  ),
  true,
  'An exact-date focused analysis with an explicit empty trip list is complete and must not refetch forever.',
)
const projectedVehicle = scheduledVehicles.scheduledVehiclesAtTime(vehiclePreview, 485, '2026-09-04')[0]
assert.equal(projectedVehicle.nextStopId, 'feed::stop-b')
assert.equal(projectedVehicle.nextStopArrivalMinutes, 490)
assert.equal(projectedVehicle.destinationStopId, 'feed::stop-c')
const sundayPreview = {
  ...vehiclePreview,
  routes: [{
    ...vehiclePreview.routes[0],
    analysisServiceDate: '2026-09-06',
    scheduledTrips: vehiclePreview.routes[0].scheduledTrips.map((trip) => ({ ...trip, serviceDays: ['sunday'] })),
  }],
}
assert.equal(scheduledVehicles.scheduledVehiclesAtTime(sundayPreview, 485, '2026-09-06').length, 1,
  'A loaded Sunday trip must appear without an independent weekday selector hiding it.')
assert.equal(scheduledVehicles.scheduledVehiclesAtTime(sundayPreview, 485, '2026-09-07').length, 0,
  'Changing the service date must suppress the old timetable until the new date loads.')
assert.equal(scheduledVehicles.scheduledVehicleDiagnostics(sundayPreview, [], 485, '2026-09-07').title,
  'Timetable not loaded', 'A stale date is missing data, not evidence of no service.')
assert.equal(scheduledVehicles.scheduledVehicleDiagnostics({
  ...sundayPreview, routes: sundayPreview.routes.map((route) => ({ ...route, scheduledTrips: [] })),
}, [], 485, '2026-09-06').title, 'No service on this date')
assert.equal(scheduledVehicles.scheduledVehicleDiagnostics(sundayPreview, [], 501, '2026-09-06').title,
  'No trips now')
const overnightPreview = {
  ...vehiclePreview,
  routes: [{
    ...vehiclePreview.routes[0],
    // Aggregate spans deliberately cover multiple calendars; only dated
    // trip times may determine whether a vehicle is actually active.
    lastArrivalMinutes: 1600,
    scheduledTrips: [0, 1440].map((offset) => ({
      ...vehiclePreview.routes[0].scheduledTrips[0],
      tripId: `overnight-${offset}`,
      firstDepartureMinutes: 60 + offset,
      lastArrivalMinutes: 80 + offset,
      stopTimes: [60, 70, 80].map((minute, index) => ({
        stopId: `stop-${index}`, sequence: index + 1,
        arrivalMinutes: minute + offset, departureMinutes: minute + offset, progress: index / 2,
      })),
    })),
  }],
}
assert.equal(scheduledVehicles.scheduledVehiclesAtTime(overnightPreview, 65, '2026-09-04')[0].tripId, 'overnight-0',
  '01:05 must not be moved to 25:05 because an unrelated trip ends after midnight.')
assert.equal(scheduledVehicles.scheduledVehiclesAtTime(overnightPreview, 1505, '2026-09-04')[0].tripId, 'overnight-1440')
assert.equal(scheduledVehicles.scheduledServiceEndMinutes(overnightPreview, '2026-09-04'), 1520)
assert.equal(scheduledVehicles.formatServiceTime(1505), '25:05')
assert.equal(scheduledVehicles.formatScheduleClock(1505), '01:05', 'Other wall-clock displays retain their existing format.')
const minuteByMinuteVehicles = [480, 481, 482, 483].map(
  (minute) => scheduledVehicles.scheduledVehiclesAtTime(vehiclePreview, minute, '2026-09-04')[0],
)
assert.deepEqual(
  minuteByMinuteVehicles.map((vehicle) => Number(vehicle.progress.toFixed(3))),
  [0, 0.05, 0.1, 0.15],
  'Minute playback must interpolate each minute instead of reusing a five-minute cache bucket.',
)
assert.ok(
  minuteByMinuteVehicles.slice(1).every((vehicle, index) => (
    vehicle.progress > minuteByMinuteVehicles[index].progress
    && vehicle.progress - minuteByMinuteVehicles[index].progress <= 0.051
  )),
  'Consecutive one-minute frames must move continuously without a multi-minute jump.',
)

const fullFleetTripCount = 1_505
const fullFleetPreview = {
  ...vehiclePreview,
  routes: [{
    ...vehiclePreview.routes[0],
    scheduledTrips: Array.from({ length: fullFleetTripCount }, (_value, index) => ({
      ...vehiclePreview.routes[0].scheduledTrips[0],
      tripId: `feed::full-fleet-${index}`,
    })),
  }],
}
const fullFleetFrame = scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, '2026-09-04')
assert.equal(
  fullFleetFrame.length,
  fullFleetTripCount,
  'Full-network playback must retain every active scheduled trip beyond the former vehicle cap.',
)
assert.strictEqual(
  scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, '2026-09-04'),
  fullFleetFrame,
  'Repeated reads of the current playback frame should reuse the projection.',
)
scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 486, '2026-09-04')
assert.notStrictEqual(
  scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, '2026-09-04'),
  fullFleetFrame,
  'Playback must retain only the current full-fleet frame instead of accumulating fleet-sized history.',
)
assert.equal(
  scheduledVehicles.scheduledVehiclesAtTime(fullFleetPreview, 485, '2026-09-06').length,
  0,
  'An inactive service day must not invent static vehicles.',
)
const joinedVehiclePreview = {
  ...vehiclePreview,
  stops: [
    { ...stops[0], id: 'feed::stop-a', name: 'Stop A' },
    { ...stops[0], id: 'feed::stop-b', name: 'Stop B' },
    { ...stops[0], id: 'feed::stop-c', name: 'Stop C' },
  ],
}
for (const [bearing, expected] of [[0, 0], [135, 135], [360, 0], [undefined, undefined], [NaN, undefined], [-1, undefined], [361, undefined]]) {
  const frame = serviceVehicles.buildServiceVehicleFrame({ mode: 'live', preview: { routes: [], stops: [] }, scheduledVehicles: [],
    realtimeSnapshot: { vehicles: [{ id: 'unmatched', lat: 42, lon: -71, bearing }], tripUpdates: [], alerts: [], counts: {} } })
  assert.equal(frame.vehicles[0].bearing, expected, 'Unmatched patterns retain valid reported RT headings only')
}
const liveFrame = serviceVehicles.buildServiceVehicleFrame({
  mode: 'live',
  preview: joinedVehiclePreview,
  realtimeSnapshot: {
    fetchedAt: '2026-08-23T18:30:00.000Z',
    entityCount: 4,
    counts: { vehicles: 2, tripUpdates: 1, alerts: 2, other: 0 },
    vehicles: [
      { id: 'live-1', label: 'Vehicle 1', routeId: 'P66', tripId: 'ADDED-1', lat: 38.92, lon: -77.05, timestamp: 1_777_000_000 },
      { id: 'invalid-position', routeId: 'P66', tripId: 'ADDED-2', lat: 200, lon: -77.05 },
    ],
    tripUpdates: [{
      id: 'update-1',
      routeId: 'P66',
      tripId: 'ADDED-1',
      stopUpdateCount: 2,
      nextStopId: 'stop-b',
      nextStopSequence: 2,
      stopTimeUpdates: [
        { stopId: 'stop-b', stopSequence: 2, arrival: { time: 1_777_000_300 } },
        { stopId: 'stop-c', stopSequence: 3, arrival: { time: 1_777_000_900 } },
      ],
    }],
    alerts: [],
  },
  scheduledVehicles: [],
})
assert.equal(liveFrame.vehicles.length, 1, 'The live frame must retain every valid position and reject only invalid coordinates.')
assert.equal(liveFrame.vehicles[0].source, 'live')
assert.equal(liveFrame.vehicles[0].nextStopFeatureId, 'feed::stop-b')
assert.equal(liveFrame.vehicles[0].card.journey.nextStop, 'Stop B')
assert.equal(liveFrame.vehicles[0].card.journey.destination, 'Stop C')
assert.equal(liveFrame.vehicles[0].card.journey.arrivalLabel, 'Expected arrival')
assert.notEqual(liveFrame.vehicles[0].card.journey.arrival, 'Not encoded')
assert.equal(serviceVehicles.serviceVehicleCount(liveFrame, joinedVehiclePreview.routes[0]), 1)
const scheduleFrame = serviceVehicles.buildServiceVehicleFrame({
  mode: 'schedule',
  preview: joinedVehiclePreview,
  realtimeSnapshot: null,
  scheduledVehicles: [projectedVehicle],
})
assert.equal(scheduleFrame.vehicles[0].source, 'schedule')
assert.equal(scheduleFrame.vehicles[0].card.journey.nextStop, 'Stop B')
assert.equal(scheduleFrame.vehicles[0].card.journey.arrivalLabel, 'Scheduled arrival')
const tracker = firstRenderTelemetry.createMapFirstRenderTracker({
  key: 'dc:first-render',
  basemap: 'dark',
  navigationStartedAt: 100,
  mapMountedAt: 120,
  featuresPreparedAt: 125.125,
})
assert.equal(firstRenderTelemetry.markMapCreated(tracker, 130), true)
assert.equal(firstRenderTelemetry.markMapCreated(tracker, 131), false)
assert.equal(firstRenderTelemetry.markMapLoaded(tracker, 180), true)
assert.equal(firstRenderTelemetry.markLocalSourceSubmitted(tracker, 200), true)
assert.equal(firstRenderTelemetry.markLocalSourceRendered(tracker, 240), true)
assert.equal(firstRenderTelemetry.markBasemapRequested(tracker, 'dark', 190), true)
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'pending')
assert.equal(firstRenderTelemetry.markBasemapReady(tracker, 450), true)
assert.deepEqual(firstRenderTelemetry.mapFirstRenderTimings(tracker), {
  navigationToMapMountMs: 20,
  featureProcessingMs: 5.125,
  mapLoadMs: 50,
  localSourceRenderMs: 40,
  localFirstPaintMs: 140,
  basemapReadyMs: 260,
  basemapAfterLocalMs: 210,
})
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'ready')
assert.equal(firstRenderTelemetry.markBasemapRequested(tracker, 'none', 500), true)
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'pending')
assert.equal(firstRenderTelemetry.markBasemapReady(tracker, 500), true)
assert.equal(firstRenderTelemetry.basemapTelemetryStatus(tracker), 'not-requested')

console.log('Map presentation behavior passed.')
