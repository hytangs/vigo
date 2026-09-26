import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importTestModules } from './helpers/import-test-modules.mjs'
import { readGtfsRouteAnalysis } from '../src/server/gtfs-analysis-store.mjs'

const [{ scheduledVehiclesAtTime, scheduledVehicleDiagnostics }, { buildServiceVehicleFrame, serviceVehicleCount, serviceVehicleIsVisible }] = await importTestModules('scheduledVehicles.ts', 'serviceVehicles.ts')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-schedule-projection-'))
const storePath = path.join(directory, 'schedule.sqlite')
const serviceDate = '2026-09-12'
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`)

try {
  const db = new DatabaseSync(storePath)
  db.exec(`
    CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT);
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, direction_id TEXT);
    CREATE INDEX trips_route ON trips(route_id, trip_id);
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER, platform_code TEXT);
    CREATE TABLE connections(departure INTEGER, arrival INTEGER, trip_id TEXT, route_id TEXT, service_id TEXT, direction_id TEXT, from_stop_id TEXT, to_stop_id TEXT, stop_sequence INTEGER, PRIMARY KEY(trip_id, stop_sequence));
    CREATE TABLE trip_shapes(trip_id TEXT PRIMARY KEY, shape_id TEXT);
    CREATE TABLE shape_points(shape_id TEXT, sequence INTEGER, lat REAL, lon REAL, PRIMARY KEY(shape_id, sequence));
    CREATE TABLE calendar_dates(service_id TEXT, date INTEGER, exception_type INTEGER);
    INSERT INTO calendar_dates VALUES('ACTIVE', 20260912, 1);
  `)
  const stopInsert = db.prepare('INSERT INTO stops VALUES(?,?,?,?,NULL,0,NULL)')
  const stop = (id, lon, lat = 42) => stopInsert.run(id, `Stop ${id}`, lat, lon)
  stop('A', -71.01)
  stop('B', -71)
  stop('C', -70.99)
  stop('D', -70.98)
  stop('L', -71)
  stop('M', -70.99, 42.01)
  stop('OA', 0, -0.0001)
  stop('OB', 0.01, 0)
  stop('OC', 0.02, 0.01)
  stop('OD', 0.02, -0.01)
  const route = (id) => db.prepare('INSERT INTO routes VALUES(?,?,?,3,?)').run(id, id, id, '3377CC')
  const shape = (id, coordinates) => coordinates.forEach(([lon, lat], index) => (
    db.prepare('INSERT INTO shape_points VALUES(?,?,?,?)').run(id, index + 1, lat, lon)
  ))
  const trip = (id, routeId, shapeId, stops, start = 480) => {
    db.prepare('INSERT INTO trips VALUES(?,?,?,?)').run(id, routeId, 'ACTIVE', '0')
    db.prepare('INSERT INTO trip_shapes VALUES(?,?)').run(id, shapeId)
    stops.slice(1).forEach((to, index) => db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)').run(
      (start + index * 12) * 60, (start + index * 12 + 10) * 60,
      id, routeId, 'ACTIVE', '0', stops[index], to, (index + 1) * 10,
    ))
  }
  route('SPARSE')
  shape('SPARSE', [[-71.02, 42], [-70.98, 42]])
  trip('SPARSE-TRIP', 'SPARSE', 'SPARSE', ['A', 'B', 'C'])
  trip('OVERNIGHT', 'SPARSE', 'SPARSE', ['A', 'B', 'C'], 1500)
  route('DETOUR')
  shape('DIRECT', [[-71.01, 42], [-70.99, 42]])
  shape('NORTH', [[-71.01, 42], [-71, 42.02], [-70.99, 42]])
  trip('DIRECT-TRIP', 'DETOUR', 'DIRECT', ['A', 'C'])
  trip('DETOUR-TRIP', 'DETOUR', 'NORTH', ['A', 'C'])
  route('LOOP')
  shape('LOOP', [[-71, 42], [-70.99, 42], [-70.99, 42.01], [-71, 42.01], [-71, 42]])
  trip('LOOP-TRIP', 'LOOP', 'LOOP', ['L', 'M', 'L'])
  route('OFFSHAPE-LOOP')
  shape('OFFSHAPE-LOOP', [[0, 0], [0.01, 0], [0.02, 0.01], [0, 0], [0.01, 0], [0.02, -0.01]])
  trip('OFFSHAPE-LOOP-TRIP', 'OFFSHAPE-LOOP', 'OFFSHAPE-LOOP', ['OA', 'OB', 'OC', 'OA', 'OB', 'OD'])
  route('REPEAT')
  trip('REPEAT-TRIP', 'REPEAT', 'DIRECT', ['A', 'A', 'C'])
  route('BROKEN')
  trip('BROKEN-TRIP', 'BROKEN', 'SPARSE', ['A', 'B', 'C'])
  db.prepare("UPDATE connections SET from_stop_id='C',to_stop_id='D' WHERE trip_id='BROKEN-TRIP' AND stop_sequence=20").run()
  db.close()

  const sparse = readGtfsRouteAnalysis(storePath, 'SPARSE', { serviceDate })
  const sparseTrip = sparse.routes[0].scheduledTrips[0]
  sparseTrip.stopTimes.forEach((stopTime, index) => near(stopTime.progress, [0.25, 0.5, 0.75][index], 'Stops project inside a sparse shape segment'))
  assert.deepEqual(sparseTrip.stopTimes.map((stopTime) => stopTime.sequence), [10, 20, 21], 'Indexed source sequences are retained; terminal sequence uses the store successor convention.')
  const vehicle = scheduledVehiclesAtTime(sparse, 485, serviceDate)[0]
  near(vehicle.coordinate[0], -71.005, 'Movement follows time between projected stop positions')
  near(vehicle.progress, 0.25, 'Trip progress excludes shape tails beyond passenger stops')
  assert.equal(vehicle.state, 'moving')
  const dwell = scheduledVehiclesAtTime(sparse, 491, serviceDate)[0]
  near(dwell.coordinate[0], -71, 'Scheduled dwell stays at the stop')
  assert.equal(dwell.state, 'dwelling')
  assert.equal(dwell.currentStopId, 'B')
  assert.equal(dwell.currentStopDepartureMinutes, 492)
  assert.equal(dwell.nextStopId, 'C')
  assert.equal(scheduledVehiclesAtTime(sparse, 502, serviceDate)[0].state, 'arrived')
  assert.equal(scheduledVehiclesAtTime(sparse, 503, serviceDate).length, 0)
  assert.equal(scheduledVehiclesAtTime(sparse, 485, '2026-09-13').length, 0)

  const overnight = scheduledVehiclesAtTime(sparse, 1505, serviceDate)
  const overnightFrame = buildServiceVehicleFrame({ mode: 'schedule', preview: sparse, scheduledVehicles: overnight, realtimeSnapshot: null })
  assert.match(overnightFrame.vehicles[0].card.subtitle, /2026-09-12 25:05/)
  assert.equal(overnightFrame.vehicles[0].card.journey.arrival, '25:10')
  assert.equal(overnightFrame.vehicles[0].card.eyebrow, 'Schedule simulation')
  const dwellFrame = buildServiceVehicleFrame({ mode: 'schedule', preview: sparse, scheduledVehicles: [dwell], realtimeSnapshot: null })
  assert.match(dwellFrame.vehicles[0].card.subtitle, /At Stop B · Departs 08:12/)

  const detour = readGtfsRouteAnalysis(storePath, 'DETOUR', { serviceDate })
  assert.equal(detour.routes.length, 2, 'Different published shapes remain separate patterns even with identical stops and direction')
  const detourVehicles = new Map(scheduledVehiclesAtTime(detour, 485, serviceDate).map((entry) => [entry.tripId, entry]))
  near(detourVehicles.get('DIRECT-TRIP').coordinate[1], 42, 'Direct trip uses its own shape')
  near(detourVehicles.get('DETOUR-TRIP').coordinate[1], 42.02, 'Detour trip follows its published branch')
  const liveSnapshot = (vehicles) => ({
    fetchedAt: '2026-09-12T12:00:00Z', counts: { vehicles: vehicles.length, tripUpdates: 0, alerts: 0, other: 0 },
    vehicles: vehicles.map((vehicle) => ({ lon: -71, lat: 42, ...vehicle })), tripUpdates: [], alerts: [],
  })
  const liveBranches = buildServiceVehicleFrame({
    mode: 'live', preview: detour, scheduledVehicles: [],
    realtimeSnapshot: liveSnapshot([
      { id: 'LIVE-DIRECT', routeId: 'DETOUR', tripId: 'DIRECT-TRIP' },
      { id: 'LIVE-DETOUR', routeId: 'DETOUR', tripId: 'DETOUR-TRIP' },
      { id: 'LIVE-UNKNOWN', routeId: 'DETOUR', tripId: 'ADDED-UNKNOWN' },
    ]),
  })
  const directPattern = detour.routes.find((route) => route.shapeId === 'DIRECT')
  const detourPattern = detour.routes.find((route) => route.shapeId === 'NORTH')
  assert.equal(liveBranches.vehicles[0].routeFeatureId, directPattern.id)
  assert.equal(liveBranches.vehicles[1].routeFeatureId, detourPattern.id, 'Realtime trip membership selects its exact pattern rather than the first service route')
  assert.equal(liveBranches.vehicles[2].routeFeatureId, undefined, 'An unknown live trip must not inherit a representative branch')
  const branchPreview = { ...detour, routes: [detourPattern] }
  assert.equal(serviceVehicleCount(liveBranches, detourPattern, branchPreview), 1, 'Pattern counts include only known membership in the selected branch')
  assert.deepEqual(liveBranches.vehicles.filter((vehicle) => serviceVehicleIsVisible(vehicle, branchPreview, detourPattern.id)).map((vehicle) => vehicle.id), ['LIVE-DETOUR'])
  assert.equal(serviceVehicleCount(liveBranches, detourPattern, detour), 3, 'Full-service counts retain live vehicles with unknown branch membership')
  assert(liveBranches.vehicles.every((vehicle) => serviceVehicleIsVisible(vehicle, branchPreview)), 'Network mode retains every valid position')

  const scopedRoutes = (scope) => detour.routes.map((route) => ({
    ...route, id: `${scope}::${route.id}`, patternId: `${scope}::${route.patternId}`,
    scheduledTrips: route.scheduledTrips.map((trip) => ({ ...trip, patternId: `${scope}::${trip.patternId}` })),
  }))
  const multiFeed = { ...detour, routes: [...scopedRoutes('feed-a'), ...scopedRoutes('feed-b')] }
  const multiFeedFrame = buildServiceVehicleFrame({
    mode: 'live', preview: multiFeed, scheduledVehicles: [],
    realtimeSnapshot: liveSnapshot([
      { id: 'SCOPED', routeId: 'DETOUR', tripId: 'feed-b::DETOUR-TRIP' },
      { id: 'AMBIGUOUS', routeId: 'DETOUR', tripId: 'DETOUR-TRIP' },
      { id: 'SOURCE', sourceScope: 'feed-b', routeId: 'DETOUR', tripId: 'DETOUR-TRIP' },
      { id: 'CONTRADICTORY', routeId: 'feed-a::DETOUR', tripId: 'feed-b::DETOUR-TRIP' },
    ]),
  })
  assert.equal(multiFeedFrame.vehicles[0].routeFeatureId, `feed-b::${detourPattern.id}`, 'A scoped trip distinguishes same-ID services in multiple feeds')
  assert.equal(multiFeedFrame.vehicles[1].routeFeatureId, undefined, 'Ambiguous unscoped trips must not be assigned to the first feed')
  assert.equal(multiFeedFrame.vehicles[3].routeFeatureId, undefined, 'Contradictory feed scopes cannot establish branch membership')
  assert.equal(multiFeedFrame.vehicles[2].routeFeatureId, `feed-b::${detourPattern.id}`, 'Source metadata binds a raw GTFS-RT trip to its own timetable')
  const feedBPattern = multiFeed.routes.find((route) => route.id === `feed-b::${detourPattern.id}`)
  assert.equal(serviceVehicleCount(multiFeedFrame, feedBPattern, { ...multiFeed, routes: [feedBPattern] }), 2)
  const loop = readGtfsRouteAnalysis(storePath, 'LOOP', { serviceDate })
  assert.equal(loop.routes[0].scheduledTrips[0].stopTimes.at(-1).progress, 1, 'A returning loop terminal projects after the intermediate stop')
  assert(Math.abs(scheduledVehiclesAtTime(loop, 491, serviceDate)[0].bearing - 270) < 1, 'A dwelling vehicle at a corner faces its departing segment')
  const offshapeLoop = readGtfsRouteAnalysis(storePath, 'OFFSHAPE-LOOP', { serviceDate })
  const offshapeProgress = offshapeLoop.routes[0].scheduledTrips[0].stopTimes.map((stopTime) => stopTime.progress)
  assert(offshapeProgress[0] < 0.01 && offshapeProgress[2] < offshapeProgress[3], 'Whole-sequence alignment keeps a slightly offset origin on its first loop occurrence')
  assert(offshapeProgress.every((progress, index) => index === 0 || progress > offshapeProgress[index - 1]), 'Every ordered call on the repeated loop retains its own forward position')
  near(scheduledVehiclesAtTime(offshapeLoop, 502, serviceDate)[0].coordinate[0], 0.02, 'The first loop reaches C before revisiting A')
  near(scheduledVehiclesAtTime(offshapeLoop, 502, serviceDate)[0].coordinate[1], 0.01, 'The first loop reaches C before revisiting A')
  const repeat = readGtfsRouteAnalysis(storePath, 'REPEAT', { serviceDate })
  assert.deepEqual(repeat.routes[0].stopIds, ['A', 'A', 'C'], 'Consecutive calls at a repeated stop remain separate occurrences')
  assert.deepEqual(repeat.routes[0].scheduledTrips[0].stopTimes.map((stopTime) => stopTime.progress), [0, 0, 1])
  const broken = readGtfsRouteAnalysis(storePath, 'BROKEN', { serviceDate })
  assert.equal(scheduledVehiclesAtTime(broken, 485, serviceDate).length, 0, 'Disconnected indexed edges cannot manufacture a continuous trip')
  assert.equal(scheduledVehicleDiagnostics(broken, [], 485, serviceDate).title, 'Vehicle path unavailable')

  const malformedCases = [
    { patternId: 'another-pattern' },
    { directionId: '1' },
    { stopTimes: sparseTrip.stopTimes.map((stopTime, index) => ({ ...stopTime, progress: index === 1 ? -0.2 : stopTime.progress })) },
    { stopTimes: sparseTrip.stopTimes.map((stopTime, index) => ({ ...stopTime, departureMinutes: index === 1 ? 489 : stopTime.departureMinutes })) },
    { stopTimes: sparseTrip.stopTimes.map((stopTime, index) => ({ ...stopTime, arrivalMinutes: index === 1 ? Number.NaN : stopTime.arrivalMinutes })) },
  ]
  for (const changes of malformedCases) {
    const malformed = { ...sparse, routes: [{ ...sparse.routes[0], scheduledTrips: [{ ...sparseTrip, ...changes }] }] }
    assert.equal(scheduledVehiclesAtTime(malformed, 485, serviceDate).length, 0, 'Invalid trip membership or timed progress must not yield a marker')
  }
  assert.deepEqual(scheduledVehiclesAtTime(sparse, Number.NaN, serviceDate), [])
  const malformedBounds = { ...sparse, routes: [{ ...sparse.routes[0], scheduledTrips: [
    { ...sparseTrip, tripId: 'INVALID-BOUNDS', firstDepartureMinutes: Number.NaN }, sparseTrip,
  ] }] }
  assert.equal(scheduledVehiclesAtTime(malformedBounds, 485, serviceDate).length, 1, 'One malformed trip bound must not poison the active-trip index for valid trips')
  const mixed = { ...sparse, routes: [...sparse.routes, ...broken.routes] }
  assert.equal(scheduledVehicleDiagnostics(mixed, scheduledVehiclesAtTime(mixed, 485, serviceDate), 485, serviceDate).tone, 'watch', 'Partial projection remains visible when some active trips cannot be located')

  const firstArrival = 1_788_000_000
  const nextArrival = firstArrival + 600
  const realtime = buildServiceVehicleFrame({
    mode: 'live', preview: sparse, scheduledVehicles: [],
    realtimeSnapshot: {
      fetchedAt: '2026-09-12T12:00:00Z', counts: { vehicles: 1, tripUpdates: 1, alerts: 0, other: 0 },
      vehicles: [{ id: 'LIVE', routeId: 'SPARSE', tripId: 'SPARSE-TRIP', lon: -71, lat: 42 }],
      tripUpdates: [{ tripId: 'SPARSE-TRIP', nextStopId: 'C', stopTimeUpdates: [
        { stopId: 'A', arrival: { time: firstArrival } },
        { stopId: 'C', arrival: { time: nextArrival } },
      ] }], alerts: [],
    },
  })
  assert.equal(realtime.vehicles[0].card.journey.arrival, new Date(nextArrival * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'Absent sequence fields must not match the wrong realtime stop update')
  const clock = Date.now() / 1000
  const pairVehicles = ['1816', '1867'].map((id, index) => ({ id, label: id, tripId: `trip-${id}`, routeId: 'SPARSE', startDate: '20260918', timestamp: clock, sourceFeedTimestamp: clock, lon: -71 + index / 1000, lat: 42 }))
  const bunchingFrame = buildServiceVehicleFrame({
    mode: 'live', preview: sparse, scheduledVehicles: [],
    realtimeSnapshot: { vehicles: pairVehicles, tripUpdates: [], alerts: [], counts: { vehicles: 2, tripUpdates: 0, alerts: 0, other: 0 } },
    operationalEvents: [{ type: 'bunching', severity: 'warning', vehicleId: '1867', tripId: 'trip-1867', routeId: 'SPARSE', serviceDate: '2026-09-18', observedAt: new Date(clock * 1000).toISOString(), stopId: 'A', evidence: { leadingVehicleId: '1816', tripIds: ['trip-1816', 'trip-1867'], observedHeadwaySeconds: 90, scheduledHeadwaySeconds: 600, predictedOrderReversed: true } }],
  })
  assert.deepEqual(bunchingFrame.vehicles.map(vehicle => vehicle.indicatorLabel), ['↔', '↔'], 'The shared map and line frame marks both bunching members')
  assert.equal(bunchingFrame.vehicles.flatMap(vehicle => vehicle.bunchingLinks).length, 1, 'Draw each pair link once')
  for (const vehicle of bunchingFrame.vehicles) {
    assert.match(vehicle.card.metrics.find(metric => metric.label.startsWith('Predicted at ')).label, /vehicles (1816 ↔ 1867|1867 ↔ 1816).*predicted trip order reversed/, 'Each vehicle card explains the same pair and its reversed prediction order')
  }
  console.log('Scheduled vehicle audit passed (shape variants, sparse shapes, dwell, loops, service dates, extended hours, malformed schedules, and realtime stop matching).')
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
