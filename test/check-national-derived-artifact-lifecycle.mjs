import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import {
  buildNationalStaticTopologySidecar,
  disposeAllNationalGtfsStores,
  ensureNationalGtfsDerivedArtifactsCurrent,
  ensureNationalGtfsStopAccessRoles,
  inspectNationalStaticTopologySidecar,
  nationalStaticTopologySidecarPath,
  prepareNationalGtfsRoutingContext,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'

const execFileAsync = promisify(execFile)
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-derived-lifecycle-'))
const storePath = path.join(folder, 'routing.sqlite')
const sidecarPath = nationalStaticTopologySidecarPath(storePath)
const serviceDate = '2026-07-16'

function createFixture() {
  const db = new DatabaseSync(storePath)
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER, platform_code TEXT);
    CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT);
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT);
    CREATE TABLE route_services(
      source_scope TEXT NOT NULL, route_type INTEGER NOT NULL, service_key TEXT NOT NULL,
      representative_route_id TEXT NOT NULL, short_name TEXT, long_name TEXT, color TEXT,
      variant_count INTEGER NOT NULL, trip_count INTEGER NOT NULL,
      PRIMARY KEY(source_scope, route_type, service_key)
    ) WITHOUT ROWID;
    CREATE TABLE trip_shapes(trip_id TEXT PRIMARY KEY, shape_id TEXT NOT NULL);
    CREATE TABLE shape_points(shape_id TEXT NOT NULL, sequence INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, PRIMARY KEY(shape_id, sequence)) WITHOUT ROWID;
    CREATE TABLE calendar(service_id TEXT PRIMARY KEY, monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER, start_date INTEGER, end_date INTEGER);
    CREATE TABLE calendar_dates(service_id TEXT NOT NULL, date INTEGER NOT NULL, exception_type INTEGER NOT NULL, PRIMARY KEY(service_id, date));
    CREATE TABLE transfers(from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, transfer_type INTEGER, min_transfer_time INTEGER, PRIMARY KEY(from_stop_id, to_stop_id));
    CREATE TABLE transfer_provenance(
      from_stop_id TEXT NOT NULL,
      to_stop_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence_fingerprint TEXT,
      path_distance_m REAL,
      PRIMARY KEY(from_stop_id, to_stop_id)
    ) WITHOUT ROWID;
    CREATE TABLE frequencies(trip_id TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, headway_secs INTEGER NOT NULL, exact_times INTEGER);
    CREATE TABLE connections(departure INTEGER NOT NULL, arrival INTEGER NOT NULL, trip_id TEXT NOT NULL, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT, from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL, PRIMARY KEY(trip_id, stop_sequence)) WITHOUT ROWID;
    CREATE TABLE stop_access_roles(
      stop_id TEXT PRIMARY KEY,
      can_board INTEGER NOT NULL CHECK(can_board IN (0, 1)),
      can_alight INTEGER NOT NULL CHECK(can_alight IN (0, 1))
    ) WITHOUT ROWID;
    CREATE INDEX stops_lat_lon ON stops(lat, lon);
    CREATE INDEX stops_parent ON stops(parent_station);
    CREATE INDEX routes_service_identity ON routes(
      route_type,
      LOWER(COALESCE(NULLIF(TRIM(short_name), ''), NULLIF(TRIM(long_name), ''), route_id)),
      route_id
    );
    CREATE INDEX trips_service ON trips(service_id);
    CREATE INDEX trips_route ON trips(route_id, trip_id);
    CREATE INDEX trip_shapes_shape ON trip_shapes(shape_id, trip_id);
    CREATE INDEX calendar_dates_date ON calendar_dates(date, exception_type);
    CREATE INDEX transfers_from ON transfers(from_stop_id);
    CREATE INDEX connections_from_departure_cover ON connections(from_stop_id, departure, service_id, trip_id, stop_sequence, arrival, to_stop_id);
    CREATE INDEX route_services_representative ON route_services(representative_route_id);
    CREATE INDEX route_services_trip_rank ON route_services(source_scope, trip_count DESC, route_type, service_key);

    INSERT INTO metadata VALUES
      ('schemaVersion', '"vigo.routing.store.v1"'),
      ('storeId', '"derived-lifecycle-fixture"'),
      ('serviceModel', '"exact-date"'),
      ('transferSemanticsVersion', '"vigo.routing.transfers.v3"'),
      ('departureIndexState', '"ready"'),
      ('connectionCount', '1'),
      ('transferCount', '0'),
      ('stopCount', '2'),
      ('bridgedUntimedGapCount', '0');
    INSERT INTO stops VALUES
      ('O', 'Origin', 42.35, -71.06, NULL, 0, NULL),
      ('D', 'Destination', 42.37, -71.12, NULL, 0, NULL);
    INSERT INTO routes VALUES('R', 'R', 'Fixture route', 1, '');
    INSERT INTO trips VALUES('T1', 'R', 'S', '0');
    INSERT INTO calendar_dates VALUES('S', 20260716, 1);
    INSERT INTO connections VALUES(29100, 30000, 'T1', 'R', 'S', '0', 'O', 'D', 1);
    INSERT INTO stop_access_roles VALUES('O', 1, 0), ('D', 0, 1);
    INSERT INTO route_services VALUES('', 1, 'r', 'R', 'R', 'Fixture route', '', 1, 1);
    CREATE TABLE stop_modes AS
      SELECT COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id) AS stop_id,
        r.route_type AS route_type, COUNT(*) AS departure_count
      FROM connections c
      JOIN stops s ON s.stop_id=c.from_stop_id
      JOIN routes r ON r.route_id=c.route_id
      GROUP BY COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id), r.route_type;
    CREATE UNIQUE INDEX stop_modes_stop_type ON stop_modes(stop_id, route_type);
    CREATE INDEX stop_modes_type_stop ON stop_modes(route_type, stop_id);
  `)
  db.close()
}

function request() {
  return {
    origin: { label: 'Origin', coordinate: [-71.06, 42.35], stopId: 'O', source: 'national-search' },
    destination: { label: 'Destination', coordinate: [-71.12, 42.37], stopId: 'D', source: 'national-search' },
    departMinutes: 8 * 60,
    serviceDate,
    serviceDay: 'weekday',
    maxWalkKm: 0.3,
    horizonMinutes: 120,
  }
}

async function kernelFiles() {
  return (await fs.readdir(folder)).filter((name) => name.startsWith('routing.sqlite.active-service-kernel.'))
}

async function prepareKernelInWalkingPolicy(overrides = {}) {
  const environment = { ...process.env }
  for (const key of [
    'VIGO_ROUTING_WALK_SPEED_KPH',
    'VIGO_ROUTING_WALK_PADDING_FACTOR',
    'VIGO_ROUTING_WALK_OVERHEAD_SECONDS',
  ]) delete environment[key]
  Object.assign(environment, overrides)
  const moduleUrl = new URL('../src/server/national-gtfs-store.mjs', import.meta.url).href
  const source = `
    import { prepareNationalGtfsRoutingContext } from ${JSON.stringify(moduleUrl)};
    const context = prepareNationalGtfsRoutingContext(
      ${JSON.stringify(storePath)},
      { serviceDate: ${JSON.stringify(serviceDate)}, serviceDay: 'weekday' },
    );
    process.stdout.write(JSON.stringify(context.activeServiceKernel));
  `
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { cwd: path.resolve(new URL('..', import.meta.url).pathname), env: environment, maxBuffer: 4 * 1024 * 1024 },
  )
  return JSON.parse(stdout)
}

try {
  createFixture()
  const sealedStore = new DatabaseSync(storePath)
  sealedStore.exec(`
    DROP INDEX connections_from_departure_cover;
    DELETE FROM stop_access_roles;
    DELETE FROM metadata WHERE key IN ('stopAccessRoleCount', 'stopAccessRoleIndexVersion');
    UPDATE metadata SET value='"deferred"' WHERE key='departureIndexState';
  `)
  sealedStore.close()
  const rebuiltRoles = await ensureNationalGtfsStopAccessRoles(storePath)
  assert.equal(rebuiltRoles.built, true)
  assert.equal(rebuiltRoles.stopCount, 2)
  const initialSidecar = await buildNationalStaticTopologySidecar({ storePath, outputPath: sidecarPath })
  assert.equal(initialSidecar.ready, true)
  assert.equal(initialSidecar.version, 'vigo.routing.static-topology.v4')
  const initialAdmission = await ensureNationalGtfsDerivedArtifactsCurrent(
    storePath,
  )
  assert.equal(initialAdmission.ready, true)
  assert.equal(initialAdmission.refreshed, false)
  assert.equal(initialAdmission.source, 'sidecar')

  const relocatedDirectory = path.join(folder, 'relocated-city')
  const relocatedStorePath = path.join(relocatedDirectory, 'routing.sqlite')
  const relocatedSidecarPath = nationalStaticTopologySidecarPath(relocatedStorePath)
  await fs.mkdir(relocatedDirectory)
  await fs.copyFile(storePath, relocatedStorePath)
  await fs.copyFile(sidecarPath, relocatedSidecarPath)
  const relocatedSidecar = inspectNationalStaticTopologySidecar(
    relocatedStorePath,
    relocatedSidecarPath,
  )
  assert.equal(relocatedSidecar.ready, true)
  assert.equal(relocatedSidecar.reason, 'ready')

  const initialContext = prepareNationalGtfsRoutingContext(storePath, { serviceDate, serviceDay: 'weekday' })
  assert.equal(initialContext.activeServiceKernel.ready, true)
  assert.equal(initialContext.activeServiceKernel.persistenceState, 'written')
  assert.equal((await kernelFiles()).length, 1)
  const [portableKernelFile] = await kernelFiles()
  await fs.copyFile(
    path.join(folder, portableKernelFile),
    path.join(relocatedDirectory, portableKernelFile),
  )
  disposeAllNationalGtfsStores()

  const relocatedContext = prepareNationalGtfsRoutingContext(
    relocatedStorePath,
    { serviceDate, serviceDay: 'weekday' },
  )
  assert.equal(relocatedContext.activeServiceKernel.persistenceState, 'loaded')
  assert.deepEqual(
    (await fs.readdir(relocatedDirectory)).filter((name) => name.includes('active-service-kernel.')),
    [portableKernelFile],
  )
  disposeAllNationalGtfsStores()

  const [initialKernelFile] = await kernelFiles()
  await fs.truncate(path.join(folder, initialKernelFile), (513 * 1024 * 1024) + 1)
  const guardedContext = prepareNationalGtfsRoutingContext(storePath, { serviceDate, serviceDay: 'weekday' })
  assert.equal(guardedContext.activeServiceKernel.persistenceState, 'written')
  assert.equal(guardedContext.activeServiceKernel.snapshotReadState, 'read_error')
  assert.match(guardedContext.activeServiceKernel.snapshotReadError, /serialized-size guard/)
  assert(guardedContext.activeServiceKernel.snapshotBytes < 513 * 1024 * 1024)
  disposeAllNationalGtfsStores()

  const mutation = new DatabaseSync(storePath)
  mutation.exec(`
    INSERT INTO trips VALUES('T2', 'R', 'S', '0');
    INSERT INTO connections VALUES(30300, 31200, 'T2', 'R', 'S', '0', 'O', 'D', 1);
    UPDATE metadata SET value='2' WHERE key='connectionCount';
    UPDATE metadata SET value='1' WHERE key='bridgedUntimedGapCount';
  `)
  mutation.close()

  const stale = inspectNationalStaticTopologySidecar(storePath, sidecarPath)
  assert.equal(stale.ready, false)
  assert.match(stale.reason, /^source(?:_storage)?_mismatch$/)
  const rebuiltFromCurrentStore = routeNationalGtfsStore(storePath, request())
  assert.equal(rebuiltFromCurrentStore.status, 'ready')
  assert.match(
    rebuiltFromCurrentStore.diagnostics?.algorithm ?? '',
    /^rust_exact_connection_scan_(?:scalar|bounded_pareto)_no_heuristic$/u,
    'A stale analysis sidecar must not block rebuilding the exact Rust kernel from the current SQLite source.',
  )
  assert.deepEqual(
    rebuiltFromCurrentStore.diagnostics?.searchStats?.engineInvocationsThisPass,
    { rustTimetable: 1, sqlite: 0 },
    'SQLite may rebuild a stale native snapshot, but it must never execute the route search.',
  )
  disposeAllNationalGtfsStores()

  const refreshed = await ensureNationalGtfsDerivedArtifactsCurrent(storePath)
  assert.equal(refreshed.refreshed, true)
  assert.equal(refreshed.attestation.ready, true)
  assert.equal(refreshed.attestation.version, 'vigo.routing.static-topology.v4')
  assert(
    refreshed.activeServiceKernels.removedCount >= 1,
    'Refreshing a stale sidecar must remove every superseded active-service snapshot.',
  )
  assert.equal((await kernelFiles()).length, 0)
  const retainedAdmission = await ensureNationalGtfsDerivedArtifactsCurrent(
    storePath,
  )
  assert.equal(retainedAdmission.refreshed, false)
  assert.equal(retainedAdmission.source, 'sidecar')

  const rebuiltContext = prepareNationalGtfsRoutingContext(storePath, { serviceDate, serviceDay: 'weekday' })
  assert.equal(rebuiltContext.activeServiceKernel.ready, true)
  assert.equal(
    rebuiltContext.activeServiceKernel.schemaVersion,
    'vigo.routing.active-service-kernel.v14-rust-native',
  )
  assert.equal(rebuiltContext.activeServiceKernel.persistenceState, 'written')
  const exact = routeNationalGtfsStore(storePath, request())
  assert.equal(exact.diagnostics?.searchStats?.heuristicMode, 'none')
  assert.equal(
    Object.hasOwn(exact.diagnostics?.searchStats ?? {}, 'heuristicWeight'),
    false,
  )

  disposeAllNationalGtfsStores()
  const reloadedContext = prepareNationalGtfsRoutingContext(storePath, { serviceDate, serviceDay: 'weekday' })
  assert.equal(reloadedContext.activeServiceKernel.persistenceState, 'loaded')
  disposeAllNationalGtfsStores()

  const regularPolicyKernel = await prepareKernelInWalkingPolicy()
  const configuredPolicyKernel = await prepareKernelInWalkingPolicy({
    VIGO_ROUTING_WALK_SPEED_KPH: '4.2',
    VIGO_ROUTING_WALK_PADDING_FACTOR: '1.15',
    VIGO_ROUTING_WALK_OVERHEAD_SECONDS: '25',
  })
  assert.equal(regularPolicyKernel.persistenceState, 'loaded')
  assert.equal(
    configuredPolicyKernel.persistenceState,
    'written',
    'A different walking policy must compile a distinct transfer-duration snapshot.',
  )
  assert.notEqual(
    regularPolicyKernel.accessPolicyIdentity,
    configuredPolicyKernel.accessPolicyIdentity,
    'Persisted compact kernels must expose the walking-policy identity used to compile transfer durations.',
  )
  assert.equal(
    (await kernelFiles()).length,
    2,
    'Walking-policy variants must never share one active-service snapshot file.',
  )

  const rebuildSource = await fs.readFile(new URL('../scripts/rebuild-vigo-project-from-raw.mjs', import.meta.url), 'utf8')
  const osmBuildIndex = rebuildSource.indexOf("timedPhase('osm_build'")
  const stopTransferBuildIndex = rebuildSource.indexOf("'osm_stop_transfers'")
  const storeValidationIndex = rebuildSource.indexOf("timedPhase('store_validation'")
  assert(
    rebuildSource.includes('ensureNationalGtfsOsmStopTransfers,')
      && osmBuildIndex >= 0
      && stopTransferBuildIndex > osmBuildIndex
      && storeValidationIndex > stopTransferBuildIndex,
    'Raw project rebuild must compile OSM-certified stop transfers after both stores exist and before validating or publishing them.',
  )
  assert(
    rebuildSource.includes('inspectNationalStaticTopologySidecar(routingPath)')
      && rebuildSource.includes('nationalStaticTopologySidecarPath(routingPath)')
      && rebuildSource.includes('await fsp.rename(stagingRoot, projectRoot)'),
    'Raw project rebuild must validate and atomically publish the sidecar paired with the rebuilt store.',
  )
  assert(
    rebuildSource.includes('await fsp.rename(projectRoot, backupRoot)')
      && rebuildSource.includes('await fsp.rename(backupRoot, projectRoot)'),
    'Raw project rebuild must rollback the previous project, including its store and sidecar.',
  )

  // Run the real rebuild pipeline: compaction changes SQLite's generation,
  // so validating a topology created before compaction must not publish it.
  const rawInputsDirectory = path.join(folder, 'raw-inputs')
  const rawProjectsRoot = path.join(folder, 'raw-projects')
  await fs.mkdir(rawInputsDirectory)
  const rawInputs = await writeCliFixtureInputs(rawInputsDirectory)
  await execFileAsync(process.execPath, [
    path.resolve(import.meta.dirname, '../scripts/rebuild-vigo-project-from-raw.mjs'),
    '--project=fixture',
    `--gtfs=fixture:${rawInputs.gtfsPath}`,
    `--osm=${rawInputs.osmPath}`,
    '--keep-backup',
    '--sequential-raw-build',
  ], {
    env: { ...process.env, VIGO_PROJECTS_ROOT: rawProjectsRoot },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  })
  const rawRoutingPath = path.join(rawProjectsRoot, 'fixture/.vigo/routing/project.sqlite')
  assert.equal(inspectNationalStaticTopologySidecar(rawRoutingPath).ready, true)
  const rawProject = JSON.parse(await fs.readFile(path.join(rawProjectsRoot, 'fixture/.vigo/project.json'), 'utf8'))
  assert(rawProject.osmStreetIndex.driveEdgeCount > 0, 'The City must retain its rebuilt driving-network counts.')
  const rawPlan = routeNationalGtfsStore(rawRoutingPath, {
    ...request(),
    origin: { label: 'Alpha', coordinate: [-77.05, 38.9], stopId: 'A' },
    destination: { label: 'Bravo', coordinate: [-77.03, 38.91], stopId: 'B' },
  })
  assert.equal(rawPlan.status, 'ready')

  console.log(JSON.stringify({
    status: 'passed',
    staticTopologyVersion: refreshed.attestation.version,
    removedKernelSnapshots: refreshed.activeServiceKernels.removedCount,
    rebuiltKernelVersion: rebuiltContext.activeServiceKernel.schemaVersion,
    reloadedPersistenceState: reloadedContext.activeServiceKernel.persistenceState,
  }, null, 2))
} finally {
  disposeAllNationalGtfsStores()
  await fs.rm(folder, { recursive: true, force: true })
}
