import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { readGtfsRouteAnalysis } from '../src/server/gtfs-analysis-store.mjs'
import { hydrateScenarioRouteServices } from '../src/server/scenario-services.mjs'
import { compileReachScenario } from '../src/server/reach.mjs'

const { TimetableKernel } = createRequire(import.meta.url)('../native/vigo-routing-kernel/vigo-routing-kernel.node')
const directory = mkdtempSync(join(tmpdir(), 'vigo-scenario-schedules-'))
const storePath = join(directory, 'fixture.sqlite')
const db = new DatabaseSync(storePath)
try {
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT);
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, direction_id TEXT);
    CREATE INDEX trips_route ON trips(route_id, trip_id);
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER, platform_code TEXT);
    CREATE TABLE connections(departure INTEGER, arrival INTEGER, trip_id TEXT, route_id TEXT, service_id TEXT, direction_id TEXT,
      from_stop_id TEXT, to_stop_id TEXT, stop_sequence INTEGER, PRIMARY KEY(trip_id, stop_sequence));
    CREATE TABLE connection_permissions(trip_id TEXT, stop_sequence INTEGER, can_board INTEGER, can_alight INTEGER, PRIMARY KEY(trip_id, stop_sequence));
    CREATE TABLE trip_shapes(trip_id TEXT PRIMARY KEY, shape_id TEXT);
    CREATE TABLE shape_points(shape_id TEXT, sequence INTEGER, lat REAL, lon REAL, PRIMARY KEY(shape_id, sequence));
    CREATE TABLE calendar(service_id TEXT, start_date INTEGER, end_date INTEGER,
      monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER);
    CREATE TABLE calendar_dates(service_id TEXT, date INTEGER, exception_type INTEGER);
    INSERT INTO calendar VALUES('daily',20260701,20260731,1,1,1,1,1,1,1);
    INSERT INTO calendar_dates VALUES('daily',20260721,2),('exception',20260721,1);
  `)
  const coordinates = { A: [8, 47], B: [8.01, 47], C: [8.02, 47], X: [8.0025, 47] }
  for (const [id, [lon, lat]] of Object.entries(coordinates)) {
    db.prepare('INSERT INTO stops VALUES(?,?,?,?,NULL,0,NULL)').run(id, id, lat, lon)
  }
  function trip(route, id, start, durations = [300, 480], stops = ['A', 'B', 'C'], calendar = 'daily', direction = '0') {
    db.prepare('INSERT OR IGNORE INTO routes VALUES(?,?,?,3,?)').run(route, route, route, '336699')
    db.prepare('INSERT INTO trips VALUES(?,?,?,?)').run(id, route, calendar, direction)
    let departure = start
    for (let index = 0; index < stops.length - 1; index += 1) {
      const arrival = departure + durations[index]
      db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
        .run(departure, arrival, id, route, calendar, direction, stops[index], stops[index + 1], index + 1)
      departure = arrival + 60
    }
  }
  trip('single', 'one-bus', 28800)
  trip('single', 'reverse-bus', 30000, [400, 300], ['C', 'B', 'A'], 'daily', '1')
  trip('single', 'holiday-bus', 36000, [300, 480], ['A', 'B', 'C'], 'exception')
  trip('irregular', 'early', 28800)
  trip('irregular', 'peak', 29220, [600, 660])
  trip('irregular', 'late', 33900)
  trip('irregular', 'night', 90000)
  trip('loop', 'loop-trip', 28800, [60, 120, 180, 600, 300], ['A', 'B', 'C', 'A', 'B', 'C'])
  db.prepare('INSERT INTO connection_permissions VALUES(?,?,?,?)').run('early', 2, 0, 1)

  function service(routeId, overrides = {}) {
    const analysis = readGtfsRouteAnalysis(storePath, routeId, { includeTripIds: true })
    const pattern = analysis.routes.find((route) => route.directionId === '0')
    return { operation: 'replace', sourceRouteId: routeId, sourcePatternId: pattern.patternId,
      routeScope: 'pattern', timeModel: 'infer-road', headwayMinutes: 10, startMinutes: 300, endMinutes: 1500,
      bidirectional: true, // Old saved drafts must not synthesize a reverse trip.
      stops: pattern.stopIds.map((id, index) => ({ id: `${pattern.patternId}:stop:${index + 1}`,
        stopId: id, baselineStopId: id, baselineStopIndex: index, coordinate: coordinates[id], editStatus: 'baseline' })),
      segmentRuntimeMinutes: Array(pattern.stopIds.length - 1).fill(5), ...overrides }
  }
  function compile(value, serviceDate = '2026-07-20') {
    return compileReachScenario(hydrateScenarioRouteServices(storePath, {}, {
      serviceDate, scenario: { services: [value] },
    }).scenario)
  }
  const original = service('single')
  const unchanged = compile(original)
  assert.deepEqual(unchanged.overlay.serviceStartSeconds, [28800])
  assert.deepEqual(unchanged.overlay.serviceEndSeconds, [28800])
  assert.deepEqual(unchanged.overlay.directionStopOffsetsSeconds, [0, 360, 840])
  assert.deepEqual(unchanged.overlay.directionArrivalOffsetsSeconds, [0, 300, 840])
  assert.equal(unchanged.scenario.services[0].bidirectional, false)
  assert(!unchanged.scenario.excludedTripIds.includes('reverse-bus'), 'The opposite branch remains scheduled.')
  assert.equal(unchanged.scenario.services[0].headwayMinutes, undefined, 'Inherited headway defaults do not survive a timetable-preserving edit.')
  assert.deepEqual(compile({ ...original, sourceRouteId: 'feed-local::single',
    stops: original.stops.map((stop) => ({ ...stop, stopId: `feed-local::${stop.stopId}` })) }).overlay.stops.map((stop) => stop.stopId),
  ['A', 'B', 'C'], 'Desktop stop identities resolve to the same stations as the original trips.')

  const inserted = { id: 'new', stopId: 'X', coordinate: coordinates.X, editStatus: 'inserted' }
  const edit = { ...original, stops: [original.stops[0], inserted, ...original.stops.slice(1)],
    segmentRuntimeMinutes: [1.25, 3.75, 5], segmentDistancesKm: [1, 3, 4], addedStopDwellMinutes: 0.35 }
  const changed = compile(edit)
  assert.deepEqual(changed.overlay.serviceStartSeconds, [28800], 'Adding a stop retains exactly one departure.')
  assert.deepEqual(changed.overlay.directionStopOffsetsSeconds, [0, 96, 381, 861])
  assert.deepEqual(changed.overlay.directionArrivalOffsetsSeconds, [0, 75, 321, 861], 'Original dwell and inserted dwell stay separate from arrival times.')
  assert.deepEqual(compile(edit, '2026-07-21').overlay.serviceStartSeconds, [36000], 'Calendar additions and removals use the query date.')
  assert.equal(compile(edit, '2026-08-01').overlay, null, 'No active trips means no invented departures.')
  const irregular = compile(service('irregular')).scenario.services[0].scheduledTrips
  assert.deepEqual(irregular.map((run) => run.departureSeconds).sort((a, b) => a - b), [28800, 29220, 33900, 90000])
  assert.deepEqual(irregular.find((run) => run.tripId === 'peak').departureOffsetsSeconds, [0, 660, 1320], 'Each trip retains its own running times.')
  assert.deepEqual(irregular.find((run) => run.tripId === 'early').canBoard, [1, 0, 0], 'No-pickup permissions are preserved.')
  const loop = service('loop')
  const loopEdit = { ...loop, stops: [...loop.stops.slice(0, 4), inserted, ...loop.stops.slice(4)],
    segmentRuntimeMinutes: undefined, segmentDistancesKm: [1, 1, 1, 1, 3, 1] }
  const loopRun = compile(loopEdit).scenario.services[0].scheduledTrips[0]
  assert.equal(loopRun.arrivalOffsetsSeconds[4] - loopRun.departureOffsetsSeconds[3], 150,
    'An insertion on the second A -> B uses that occurrence’s 600-second running time.')
  const truncated = compile({ ...original, stops: original.stops.slice(1), segmentRuntimeMinutes: [5] })
  assert.deepEqual(truncated.overlay.serviceStartSeconds, [29160], 'A new first stop keeps its published departure.')
  assert.deepEqual(truncated.overlay.directionArrivalOffsetsSeconds, [0, 480])
  const removed = compile({ ...original, stops: [original.stops[0], original.stops[2]], segmentRuntimeMinutes: [10] })
  assert.deepEqual(removed.overlay.directionArrivalOffsetsSeconds, [0, 780], 'Removing a stop removes its dwell, without changing the departure.')
  const moved = compile({ ...original, stops: original.stops.map((stop, index) => index === 1
    ? { ...stop, stopId: undefined, coordinate: [8.008, 47], editStatus: 'replaced' } : stop) })
  assert.deepEqual(moved.overlay.directionStopOffsetsSeconds, [0, 360, 840], 'Moved stops keep the trip and its original dwell.')
  const extension = { ...original, stops: [{ id: 'extension', coordinate: [7.99, 47], editStatus: 'added' }, ...original.stops],
    segmentRuntimeMinutes: [1, 5, 5] }
  assert.deepEqual(compile(extension).overlay.serviceStartSeconds, [28740], 'A preceding extension anchors to the original first departure.')
  assert.throws(() => compile({ ...extension, segmentRuntimeMinutes: [1000, 5, 5] }), /before the start of the service date/)
  assert.throws(() => compile({ ...edit, stops: [...edit.stops].reverse() }), /occurrence order/)
  assert.throws(() => compile({ ...original, routeScope: 'route' }), /selected-branch scope/)
  assert.throws(() => compileReachScenario({ services: [original] }), /hydrated/)
  assert.equal(compile({ ...edit, scheduleMode: 'frequency', bidirectional: false }).overlay.serviceStartSeconds[0], 18000)
  assert.equal(compile({ ...edit, scheduleMode: 'frequency', bidirectional: false }).overlay.serviceHeadwaySeconds[0], 600,
    'Explicit frequency changes remain available.')

  // Exercise the actual Rust scanner: after the sole departure there is no next bus.
  const kernel = new TimetableKernel({
    stopCount: 2, runCount: 1,
    departureSeconds: new Uint32Array([100]), arrivalSeconds: new Uint32Array([200]),
    fromStop: new Uint32Array([0]), toStop: new Uint32Array([1]), sequence: new Uint32Array([1]),
    segmentTrip: new Uint32Array([0]), segmentRun: new Uint32Array([0]), continuityBreak: new Uint8Array([1]),
    canBoard: new Uint8Array([1]), canAlight: new Uint8Array([1]), tripStart: new Uint32Array([0, 1]),
    departureOffset: new Uint32Array([0, 1, 1]), departureOrder: new Uint32Array([0]),
    transferOffset: new Uint32Array([0, 0, 0]), transferTo: new Uint32Array(), transferDuration: new Uint32Array(),
    forbiddenSameStop: new Uint8Array([0, 0]),
  })
  function route(overlay, departure, from = 0, to = overlay.stops.length - 1) {
    const { stops, ...arrays } = overlay
    return kernel.routeOverlayManyCsa({ ...arrays, overlayStopCount: stops.length,
      overlayBaseStops: stops.map(() => -1),
      originStops: [2 + from], originWalkSeconds: [0], destinationOffsets: [0, 1], destinationStops: [2 + to],
      destinationWalkSeconds: [0], excludedTrips: [], departure, horizon: departure + 3600,
      allowPreRideTransfers: false, supplementalTransferOffsets: Array(3 + stops.length).fill(0),
      supplementalTransferTo: [], supplementalTransferDuration: [],
    })
  }
  const caught = route(changed.overlay, 28800)
  assert.equal(caught.overlayRuns, 1)
  assert.equal(caught.timetable.bestArrivals[0], 29661)
  assert.equal(route(changed.overlay, 28801).timetable.bestArrivals[0], Infinity, 'Missing the bus cannot expose a fictitious 10-minute service.')
  assert.equal(route(changed.overlay, 28890, 1).timetable.bestArrivals[0], 29661, 'An existing run can still be boarded downstream.')
  assert.equal(route(unchanged.overlay, 28800, 0, 1).timetable.bestArrivals[0], 29100, 'Alighting uses arrival, not the later departure after dwell.')
  assert.equal(route(compile(service('irregular')).overlay, 29150, 1).timetable.bestArrivals[0], 30540,
    'No-pickup blocks the early trip; the next permitted trip retains its own timetable.')
  console.log('Scheduled scenario edits preserve individual trips, calendars, irregular/overnight departures, dwell, permissions and loop occurrences; the native scanner invents no next bus.')
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
