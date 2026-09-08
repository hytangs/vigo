import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { readGtfsNetworkOverview, readGtfsRouteAnalysis } from '../src/server/gtfs-analysis-store.mjs'

const compile = async (relativePath) => ts.transpileModule(
  await fs.readFile(new URL(relativePath, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const geometryUrl = moduleUrl(await compile('../src/app/geometry.ts'))
const { scheduledVehiclesAtTime, scheduledVehicleDiagnostics } = await import(moduleUrl(
  (await compile('../src/scheduledVehicles.ts')).replace("from './app/geometry'", `from '${geometryUrl}'`),
))

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-gtfs-analysis-'))
const storePath = path.join(temporaryDirectory, 'analysis.sqlite')

try {
  const db = new DatabaseSync(storePath)
  db.exec(`
    CREATE TABLE route_services(
      source_scope TEXT NOT NULL,
      route_type INTEGER NOT NULL,
      service_key TEXT NOT NULL,
      representative_route_id TEXT NOT NULL,
      short_name TEXT,
      long_name TEXT,
      color TEXT,
      variant_count INTEGER NOT NULL,
      trip_count INTEGER NOT NULL,
      PRIMARY KEY(source_scope, route_type, service_key)
    ) WITHOUT ROWID;
    CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT);
    CREATE INDEX routes_service_identity ON routes(
      route_type,
      LOWER(COALESCE(NULLIF(TRIM(short_name), ''), NULLIF(TRIM(long_name), ''), route_id)),
      route_id
    );
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT);
    CREATE INDEX trips_route ON trips(route_id, trip_id);
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER, platform_code TEXT);
    CREATE TABLE connections(
      departure INTEGER NOT NULL, arrival INTEGER NOT NULL, trip_id TEXT NOT NULL,
      route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT,
      from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL,
      PRIMARY KEY(trip_id, stop_sequence)
    ) WITHOUT ROWID;
    CREATE TABLE trip_shapes(trip_id TEXT PRIMARY KEY, shape_id TEXT NOT NULL);
    CREATE TABLE shape_points(shape_id TEXT NOT NULL, sequence INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, PRIMARY KEY(shape_id, sequence)) WITHOUT ROWID;
    CREATE TABLE calendar(service_id TEXT PRIMARY KEY, monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER, start_date INTEGER, end_date INTEGER);
    CREATE TABLE calendar_dates(service_id TEXT, date INTEGER, exception_type INTEGER);
  `)

  const insertService = db.prepare('INSERT INTO route_services VALUES(?,?,?,?,?,?,?,?,?)')
  insertService.run('', 2, 'R1A', 'R1A', 'Harbor', '', '2457A6', 1, 4)
  insertService.run('', 2, 'R1B', 'R1B', 'Harbor', '', '2457A6', 1, 1)
  insertService.run('', 3, 'R2', 'R2', '20', 'Crosstown', '2D7FF9', 1, 1)
  insertService.run('', 3, 'R3', 'R3', '99', 'Inactive definition', '999999', 1, 0)
  insertService.run('inner_rail', 1, 'BLUE', 'inner_rail\u001fBLUE', 'Blue', 'Blue Line', '3776AB', 1, 1)

  const insertRoute = db.prepare('INSERT INTO routes VALUES(?,?,?,?,?)')
  insertRoute.run('R1A', 'Harbor', '', 2, '2457A6')
  insertRoute.run('R1B', 'Harbor', '', 2, '2457A6')
  insertRoute.run('R2', '20', 'Crosstown', 3, '2D7FF9')
  insertRoute.run('R3', '99', 'Inactive definition', 3, '999999')
  insertRoute.run('inner_rail\u001fBLUE', 'Blue', 'Blue Line', 1, '3776AB')

  const insertStop = db.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)')
  insertStop.run('A', 'Alpha', 42.30, -71.10, null, 0, null)
  insertStop.run('B', 'Bravo', 42.35, -71.05, null, 0, null)
  insertStop.run('C', 'Charlie', 42.40, -71.00, null, 0, null)
  insertStop.run('D', 'Delta', 42.45, -70.95, null, 0, null)
  insertStop.run('E', 'Echo', 42.50, -70.90, null, 0, null)

  const insertTrip = db.prepare('INSERT INTO trips VALUES(?,?,?,?)')
  const insertConnection = db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  const insertTripShape = db.prepare('INSERT INTO trip_shapes VALUES(?,?)')
  const addTrip = (tripId, routeId, directionId, departure, stops, shapeId, serviceId = 'WKD') => {
    insertTrip.run(tripId, routeId, serviceId, directionId)
    if (shapeId) insertTripShape.run(tripId, shapeId)
    for (let index = 0; index < stops.length - 1; index += 1) {
      const segmentDeparture = departure + index * 600
      insertConnection.run(segmentDeparture, segmentDeparture + 480, tripId, routeId, serviceId, directionId, stops[index], stops[index + 1], index + 1)
    }
  }
  addTrip('T1', 'R1A', '0', 6 * 3600, ['A', 'B', 'C'], 'S1')
  addTrip('T2', 'R1A', '0', 6.5 * 3600, ['A', 'B', 'C'], 'S1')
  addTrip('T2-SA-1', 'R1A', '0', 6.25 * 3600, ['A', 'B', 'C'], 'S1', 'SAT')
  addTrip('T2-SA-2', 'R1A', '0', 6.75 * 3600, ['A', 'B', 'C'], 'S1', 'SAT')
  addTrip('T3', 'R1B', '1', 7 * 3600, ['C', 'D', 'E'], 'S2')
  addTrip('T4', 'R2', '0', 8 * 3600, ['B', 'D'], null)
  addTrip('inner_rail\u001fBT1', 'inner_rail\u001fBLUE', '0', 9 * 3600, ['A', 'B', 'C'], 'S1')

  const insertShape = db.prepare('INSERT INTO shape_points VALUES(?,?,?,?)')
  ;[
    ['S1', 1, 42.30, -71.10], ['S1', 2, 42.325, -71.075], ['S1', 3, 42.35, -71.05], ['S1', 4, 42.40, -71.00],
    ['S2', 1, 42.40, -71.00], ['S2', 2, 42.425, -70.975], ['S2', 3, 42.45, -70.95], ['S2', 4, 42.50, -70.90],
  ].forEach((row) => insertShape.run(...row))
  db.prepare('INSERT INTO calendar VALUES(?,?,?,?,?,?,?,?,?,?)').run('WKD', 1, 1, 1, 1, 1, 0, 0, 20260901, 20260930)
  db.prepare('INSERT INTO calendar VALUES(?,?,?,?,?,?,?,?,?,?)').run('SAT', 0, 0, 0, 0, 0, 1, 0, 20260901, 20260930)
  db.close()

  const overview = readGtfsNetworkOverview(storePath)
  assert.equal(overview.routes.length, 4, 'Distinct same-name route IDs must remain separate; inactive definitions are excluded.')
  assert.equal(overview.coverage.routeGeometryIndexed, 4)
  assert.equal(overview.coverage.routeGeometryComplete, true)
  assert(overview.routes.every((route) => route.coordinates.length >= 2))
  assert(overview.routes.some((route) => route.geometrySource === 'shape'))
  assert(overview.routes.some((route) => route.geometrySource === 'stop_sequence'))
  assert.equal(overview.routes.find((route) => route.routeId === 'R1A')?.longName, 'Alpha → Charlie')
  assert.equal(overview.routes.find((route) => route.routeId === 'R1B')?.longName, 'Charlie → Echo')
  assert.equal(overview.routes.find((route) => route.routeId === 'R1A')?.headwayMinutes, 30)
  assert.equal(overview.routes.find((route) => route.routeId === 'R1A')?.firstDepartureMinutes, 360)
  assert.equal(overview.routes.find((route) => route.routeId === 'R1A')?.lastArrivalMinutes, 423)
  assert.equal(overview.routes.find((route) => route.routeId === 'R1A')?.spanHours, 1.05)
  assert.equal(overview.routes.find((route) => route.routeId === 'R1A')?.serviceHours, 1.2)

  const analysis = readGtfsRouteAnalysis(storePath, 'R1A')
  assert(analysis)
  assert.equal(analysis.source, 'sqlite')
  assert.deepEqual(analysis.memberRouteIds, ['R1A'])
  assert.equal(analysis.routes.length, 1)
  assert.equal(analysis.coverage.tripsIndexed, 4)
  assert.equal(
    analysis.routes[0].headwayMinutes,
    30,
    'Mutually exclusive service calendars must not interleave into a fake 15-minute headway.',
  )
  assert.equal(analysis.routes.reduce((sum, route) => sum + route.tripCount, 0), 4)
  assert.equal(analysis.stops.length, 3)
  assert.equal(analysis.stopPairs.length, 2)
  assert(analysis.routes.every((route) => route.stopIds.length === 3))
  assert(analysis.routes.every((route) => route.coordinates.length >= 2))

  const datedAnalysis = readGtfsRouteAnalysis(storePath, 'R1A', { serviceDate: '2026-09-04' })
  assert(datedAnalysis)
  assert.equal(datedAnalysis.routes[0].analysisServiceDate, '2026-09-04')
  assert.equal(datedAnalysis.routes[0].scheduledTrips.length, 2, 'Playback must load only trips active on the selected date.')
  assert.deepEqual(datedAnalysis.routes[0].scheduledTrips.map((trip) => trip.tripId), ['T1', 'T2'])
  assert(datedAnalysis.routes[0].scheduledTrips.every((trip) => trip.stopTimes.length === 3))
  assert(datedAnalysis.routes[0].scheduledTrips.every((trip) => trip.stopTimes[0].progress === 0))
  assert(datedAnalysis.routes[0].scheduledTrips.every((trip) => trip.stopTimes.at(-1).progress === 1))

  const branchAnalysis = readGtfsRouteAnalysis(storePath, 'R1B')
  assert(branchAnalysis)
  assert.deepEqual(branchAnalysis.memberRouteIds, ['R1B'])
  assert.equal(branchAnalysis.coverage.tripsIndexed, 1)
  assert.equal(branchAnalysis.routes[0].longName, 'Charlie → Echo')

  const nestedScopeAnalysis = readGtfsRouteAnalysis(storePath, 'inner_rail\u001fBLUE', {
    sourceScope: 'outer_project_feed',
  })
  assert(nestedScopeAnalysis, 'A canonical inner route scope must override a mismatched outer project-feed scope.')
  assert.equal(nestedScopeAnalysis.routes.length, 1)
  assert.equal(nestedScopeAnalysis.coverage.tripsIndexed, 1)
  assert.equal(nestedScopeAnalysis.representativeRouteId, 'inner_rail\u001fBLUE')
  assert.equal(nestedScopeAnalysis.coverage.sourceScope, 'inner_rail')

  // Exercise the SQLite calendar -> dated route analysis -> map playback
  // boundary. Exceptions must override weekday service, including holidays.
  const calendarDb = new DatabaseSync(storePath)
  calendarDb.exec(`
    INSERT INTO trips VALUES('SUNDAY-TRAM', 'R1A', 'SUN-EXCEPTION', '0');
    INSERT INTO trip_shapes VALUES('SUNDAY-TRAM', 'S1');
    INSERT INTO connections VALUES(52200, 52800, 'SUNDAY-TRAM', 'R1A', 'SUN-EXCEPTION', '0', 'A', 'B', 1);
    INSERT INTO connections VALUES(52800, 53400, 'SUNDAY-TRAM', 'R1A', 'SUN-EXCEPTION', '0', 'B', 'C', 2);
    INSERT INTO calendar_dates VALUES('SUN-EXCEPTION', 20260906, 1);
    INSERT INTO calendar_dates VALUES('WKD', 20260907, 2);
    INSERT INTO calendar_dates VALUES('SAT', 20260907, 1);
  `)
  calendarDb.close()
  const sunday = readGtfsRouteAnalysis(storePath, 'R1A', { serviceDate: '2026-09-06' })
  assert.deepEqual(sunday.routes.flatMap((route) => route.scheduledTrips.map((trip) => trip.tripId)), ['SUNDAY-TRAM'])
  assert.deepEqual(scheduledVehiclesAtTime(sunday, 877, '2026-09-06').map((vehicle) => vehicle.tripId), ['SUNDAY-TRAM'],
    'The Sunday 14:37 frame must show the trip selected by the GTFS date exception.')
  assert.equal(scheduledVehiclesAtTime(sunday, 877, '2026-09-07').length, 0)
  assert.equal(scheduledVehicleDiagnostics(sunday, [], 877, '2026-09-07').title, 'Schedule details not loaded')
  const holiday = readGtfsRouteAnalysis(storePath, 'R1A', { serviceDate: '2026-09-07' })
  assert.deepEqual(holiday.routes.flatMap((route) => route.scheduledTrips.map((trip) => trip.tripId)), ['T2-SA-1', 'T2-SA-2'])
  assert.deepEqual(scheduledVehiclesAtTime(holiday, 380, '2026-09-07').map((vehicle) => vehicle.tripId), ['T2-SA-1'],
    'A Monday with Saturday service must honor calendar_dates, not the calendar weekday.')
  const noService = readGtfsRouteAnalysis(storePath, 'R1A', { serviceDate: '2026-09-13' })
  assert.equal(scheduledVehiclesAtTime(noService, 877, '2026-09-13').length, 0)
  assert.equal(scheduledVehicleDiagnostics(noService, [], 877, '2026-09-13').title, 'No service on this date')

  console.log(`GTFS analysis store check passed (${overview.routes.length} complete services, ${analysis.routes.length + branchAnalysis.routes.length} focused patterns).`)
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}
