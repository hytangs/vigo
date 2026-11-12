import { buildScheduleFixture } from './helpers/schedule-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { DatabaseSync } from 'node:sqlite'
import { buildNationalGtfsStore, buildNationalStaticTopologySidecar, disposeNationalGtfsStore, ensureNationalGtfsStopAccessRoles, mergeNationalGtfsStores, nationalFeedSummary, prepareNationalGtfsRoutingContext, readNationalGtfsPreview, readNationalGtfsStoreMetadata } from '../src/server/national-gtfs-store.mjs'
import {
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import { buildWalkSnapshot } from './helpers/street-snapshots.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { finalizeCurrentStreetFixture } from './helpers/street-fixture.mjs'
import { processFixtureDirectory } from './helpers/fixture-process.mjs'
import { disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'

async function rebuildFixtureRoutingDerivedArtifacts(storePath) {
  const database = new DatabaseSync(storePath)
  try {
    database.exec(`
      DELETE FROM metadata WHERE key IN ('stopAccessRoleIndexVersion', 'stopAccessRoleCount');
      DROP TABLE IF EXISTS stop_modes;
      CREATE TABLE stop_modes AS
        SELECT COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id) AS stop_id,
          r.route_type AS route_type, COUNT(*) AS departure_count
        FROM connections c
        JOIN stops s ON s.stop_id=c.from_stop_id
        JOIN routes r ON r.route_id=c.route_id
        LEFT JOIN connection_permissions permission
          ON permission.trip_id=c.trip_id AND permission.stop_sequence=c.stop_sequence
        WHERE COALESCE(permission.can_board, 1)=1
        GROUP BY COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id), r.route_type;
      CREATE UNIQUE INDEX stop_modes_stop_type ON stop_modes(stop_id, route_type);
      CREATE INDEX stop_modes_type_stop ON stop_modes(route_type, stop_id);
    `)
  } finally {
    database.close()
  }
  await ensureNationalGtfsStopAccessRoles(storePath)
  await buildNationalStaticTopologySidecar({
    storePath,
    outputPath: `${storePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
    force: true,
  })
}

const folder = await processFixtureDirectory(import.meta.url, 'vigo-national-store-')
const zipPath = path.join(folder, 'fixture.zip')
const storePath = path.join(folder, 'fixture.sqlite')
const kernelFallbackStorePath = path.join(folder, 'fixture-kernel-fallback.sqlite')
const weekdayTemplateStorePath = path.join(folder, 'fixture-weekday-template.sqlite')
const transferShortcutStorePath = path.join(folder, 'fixture-transfer-shortcut.sqlite')
const transferOnlyStorePath = path.join(folder, 'fixture-transfer-only.sqlite')
const legacyAccessStorePath = path.join(folder, 'fixture-legacy-access.sqlite')
const parentModeAccessStorePath = path.join(folder, 'fixture-parent-mode-access.sqlite')
const parentModeAccessStreetPath = path.join(folder, 'fixture-parent-mode-access-street.sqlite')
const gapZipPath = path.join(folder, 'fixture-gap.zip')
const gapStorePath = path.join(folder, 'fixture-gap.sqlite')
const legacyGapStorePath = path.join(folder, 'fixture-gap-legacy.sqlite')
const sectionGapStorePath = path.join(folder, 'fixture-section-gap.sqlite')
const directWalkStreetPath = path.join(folder, 'fixture-direct-walk-street.sqlite')
const shortTransitSchedulePath = path.join(folder, 'fixture-short-transit-schedule.json')
const shortTransitStorePath = path.join(folder, 'fixture-short-transit.sqlite')
const accessBoundSchedulePath = path.join(folder, 'fixture-access-bound-schedule.json')
const accessBoundStorePath = path.join(folder, 'fixture-access-bound.sqlite')
const incompleteCoverageStorePath = path.join(folder, 'fixture-incomplete-coverage.sqlite')
const denseAccessSchedulePath = path.join(folder, 'fixture-dense-access-schedule.json')
const denseAccessStorePath = path.join(folder, 'fixture-dense-access.sqlite')
const denseAccessStreetPath = path.join(folder, 'fixture-dense-access-street.sqlite')
const completeEgressSchedulePath = path.join(folder, 'fixture-complete-egress-schedule.json')
const completeEgressStorePath = path.join(folder, 'fixture-complete-egress.sqlite')
const completeEgressStreetPath = path.join(folder, 'fixture-complete-egress-street.sqlite')
const cacheTruthStorePath = path.join(folder, 'fixture-cache-truth.sqlite')
const matrixUpperBoundStorePath = path.join(folder, 'fixture-matrix-upper-bound.sqlite')
const matrixCycleSchedulePath = path.join(folder, 'fixture-matrix-cycle-schedule.json')
const matrixCycleStorePath = path.join(folder, 'fixture-matrix-cycle.sqlite')
const matrixHorizonSchedulePath = path.join(folder, 'fixture-matrix-horizon-schedule.json')
const matrixHorizonStorePath = path.join(folder, 'fixture-matrix-horizon.sqlite')
const migratedStorePath = path.join(folder, 'migrated.sqlite')
const transferSlackStorePath = path.join(folder, 'transfer-slack.sqlite')
const rawFeedAPath = path.join(folder, 'raw-feed-a.zip')
const rawFeedBPath = path.join(folder, 'raw-feed-b.zip')
const rawStoreAPath = path.join(folder, 'raw-feed-a.sqlite')
const rawStoreBPath = path.join(folder, 'raw-feed-b.sqlite')
const mergedRawStorePath = path.join(folder, 'merged-raw.sqlite')
const arriveTransferStorePath = path.join(folder, 'arrive-transfer.sqlite')
const arriveTransferLegacyStorePath = path.join(folder, 'arrive-transfer-legacy.sqlite')
const fallbackRailFeedPath = path.join(folder, 'fallback-rail.zip')
const fallbackBusFeedPath = path.join(folder, 'fallback-bus.zip')
const fallbackRailStorePath = path.join(folder, 'fallback-rail.sqlite')
const fallbackBusStorePath = path.join(folder, 'fallback-bus.sqlite')
const fallbackMergedStorePath = path.join(folder, 'fallback-merged.sqlite')
const fallbackStreetPath = path.join(folder, 'fallback-street.sqlite')
const invalidRawStorePath = path.join(folder, 'invalid-raw.sqlite')
const failedMergePath = path.join(folder, 'failed-merge.sqlite')
const cleanupMergePath = path.join(folder, 'cleanup-merge.sqlite')

const denseRouteCatalogStorePath = path.join(folder, 'dense-route-catalog.sqlite')

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function prepareRustFixtureStreetStore(storePath) {
  const snapshot = buildWalkSnapshot(storePath)
  assert.equal(snapshot.ready, true)
  assert.equal(
    compactNationalOsmRuntimeStore(storePath).storageLayout,
    'runtime-snapshots-v1',
  )
  disposeNationalOsmStore(storePath)
  const native = prepareNationalOsmNativeStore(storePath)
  assert.equal(native.ready, true)
  assert.equal(native.source, 'rust_mmap_node_api')
  assert(buildNativeStreetCchIndex(storePath).loaded.nodeCount > 0)
  return native
}

async function buildDenseRouteCatalogFixture(storePath) {
  const zip = new JSZip()
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,42.38,-71.10\nB,Bravo,42.39,-71.09\n')
  zip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type,route_color',
    'R1,1,Dense route,3,cc0000', 'R1B,1,Dense route variant,3,cc0000',
    'R2,2,Second route,3,0066cc', 'R3,3,Third route,3,00aa66',
    'R4,4,Fourth route,3,aa6600', 'R_FIVE,5,Fifth route,3,6600aa',
    'R6,6,Sixth route,3,008888', 'R7,7,Inactive route,3,777777', '',
  ].join('\n'))
  const trips = ['route_id,service_id,trip_id,direction_id']
  const times = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence']
  const time = (seconds) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const add = (routeId, tripId, departure) => {
    trips.push(`${routeId},S,${tripId},0`)
    times.push(`${tripId},${time(departure)},${time(departure)},A,1`,
      `${tripId},${time(departure + 60)},${time(departure + 60)},B,2`)
  }
  for (let index = 0; index < 2_001; index += 1) add('R1', `a-dense-${String(index).padStart(4, '0')}`, index)
  for (let index = 0; index < 3; index += 1) add('R1B', `variant-${index}`, 5_000 + index)
  for (let routeNumber = 2; routeNumber <= 6; routeNumber += 1) {
    const routeId = routeNumber === 5 ? 'R_FIVE' : `R${routeNumber}`
    add(routeId, `z-${routeId}`, 10_000 + routeNumber)
  }
  zip.file('trips.txt', `${trips.join('\n')}\n`)
  zip.file('stop_times.txt', `${times.join('\n')}\n`)
  zip.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260716,1\n')
  const zipPath = `${storePath}.zip`
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
}

async function startFixtureApi(projectsPath, configPath) {
  return startInMemoryVigoApi({
    repositoryRoot,
    environment: {
      VIGO_PROJECTS_DIR: projectsPath,
      VIGO_CONFIG_DIR: configPath,
    },
  })
}

async function runNodeJsonFixture({ source, args, env = {}, label }) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(exitCode, 0, `${label} child failed: ${stderr}`)
  return JSON.parse(stdout)
}

async function runOversizedSourcePreflightFixture(routingStorePath) {
  const modulePath = path.join(repositoryRoot, 'src', 'server', 'national-gtfs-store.mjs')
  const source = `
    import { pathToFileURL } from 'node:url'
    const routing = await import(pathToFileURL(process.argv[1]).href)
    const storePath = process.argv[2]
    const context = routing.prepareNationalGtfsRoutingContext(storePath, {
      serviceDate: '2026-07-12',
      serviceDay: 'sunday',
    })
    process.stdout.write(JSON.stringify({
      preflight: context.activeServiceKernelPreflight,
      staticTopology: context.staticTopology,
      activeServiceKernel: context.activeServiceKernel,
    }))
  `
  return runNodeJsonFixture({
    source,
    args: [modulePath, routingStorePath],
    env: {
      VIGO_ACTIVE_KERNEL_MAX_SEGMENTS: '1',
      VIGO_ACTIVE_KERNEL_MAX_SOURCE_CONNECTIONS: '1',
      VIGO_ACTIVE_KERNEL_PERSIST: '0',
    },
    label: 'Oversized-source preflight',
  })
}

try {
  await buildDenseRouteCatalogFixture(denseRouteCatalogStorePath)
  const denseRouteCatalogPreview = readNationalGtfsPreview(denseRouteCatalogStorePath, {
    routeCount: 8,
    stopCount: 2,
    tripCount: 2_009,
    routeLimit: 8,
  })
  assert.deepEqual(
    denseRouteCatalogPreview.routes.map((route) => route.routeId).sort(),
    ['R1', 'R1B', 'R2', 'R3', 'R4', 'R6', 'R_FIVE'],
    'An indexed SQLite route catalog must not lose routes behind dense early connection rows.',
  )
  const denseRouteCatalogSummary = nationalFeedSummary(denseRouteCatalogStorePath, {
    sourceFile: 'dense-route-catalog.zip',
    sourceBytes: 1,
    storeId: 'dense-route-catalog',
    builtAt: '2026-07-15T12:00:00.000Z',
    routeCount: 8,
    stopCount: 2,
    tripCount: 2_009,
    transferCount: 0,
    calendarDateCount: 0,
    frequencyCount: 0,
    tableProfiles: [],
    bytes: 1,
    connectionCount: 2_006,
  }, 'dense-route-catalog')
  assert.deepEqual(
    denseRouteCatalogSummary.routeMetrics.map((route) => route.routeId).sort(),
    ['R1', 'R1B', 'R2', 'R3', 'R4', 'R6', 'R7', 'R_FIVE'],
    'The route catalog must retain inactive SQLite route rows even when they have no drawable trip.',
  )
  const denseRoute = denseRouteCatalogSummary.routeMetrics.find((route) => route.routeId === 'R1')
  const denseBranch = denseRouteCatalogSummary.routeMetrics.find((route) => route.routeId === 'R1B')
  assert.equal(denseRoute?.serviceVariantCount, 1, 'A GTFS route_id must remain one public service identity.')
  assert.equal(denseRoute?.tripCount, 2_001)
  assert.equal(denseBranch?.tripCount, 3, 'A same-name branch must retain its own indexed trip count.')

  const directWalkStreet = new DatabaseSync(directWalkStreetPath)
  directWalkStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v6"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES
      (1, 0, 0), (2, 0, 0.0009),
      (3, 0.01, 0), (4, 0.01, 0.0016),
      (5, 0.02, 0), (6, 0.02, 0.0009),
      (7, 0.03, 0), (8, 0.03, 0.00225),
      (9, 47, 8), (10, 47.01, 8.01), (11, 47.02, 8.02),
      (12, 0, -0.0009), (13, 0, 0.0018);
    INSERT INTO edges VALUES
      (1, 2, 101, 1), (2, 1, 101, 1),
      (12, 1, 100, 4), (1, 12, 100, 4),
      (2, 13, 100, 5), (13, 2, 100, 5),
      (3, 4, 178, 2), (4, 3, 178, 2),
      (7, 8, 250, 3), (8, 7, 250, 3);
  `)
  finalizeCurrentStreetFixture(directWalkStreet)
  directWalkStreet.close()
  prepareRustFixtureStreetStore(directWalkStreetPath)

  const shortTransitSchedule = {
    stops: [
      { id: 'SHORT_A', name: 'Short transit origin', lat: 0, lon: 0, locationType: 0 },
      { id: 'SHORT_B', name: 'Short transit destination', lat: 0, lon: 0.0009, locationType: 0 },
      { id: 'LONG_A', name: 'Long-walk transit origin', lat: 0.03, lon: 0, locationType: 0 },
      { id: 'LONG_B', name: 'Long-walk transit destination', lat: 0.03, lon: 0.00225, locationType: 0 },
    ],
    routes: [
      {
        id: 'SHORT', shortName: 'SHORT', routeType: 3,
        scheduledTrips: [{
          tripId: 'short-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'SHORT_A', arrivalMinutes: 480, departureMinutes: 480, sequence: 1 },
            { stopId: 'SHORT_B', arrivalMinutes: 480.5, departureMinutes: 480.5, sequence: 2 },
          ],
        }],
      },
      {
        id: 'EQUAL', shortName: 'EQUAL', routeType: 3,
        scheduledTrips: [{
          tripId: 'equal-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'SHORT_A', arrivalMinutes: 540, departureMinutes: 540, sequence: 1 },
            { stopId: 'SHORT_B', arrivalMinutes: 540, departureMinutes: 540, sequence: 2 },
          ],
        }],
      },
      {
        id: 'WALK_TIE', shortName: 'WALK_TIE', routeType: 3,
        scheduledTrips: [{
          tripId: 'walk-tie-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'SHORT_A', arrivalMinutes: 600, departureMinutes: 600, sequence: 1 },
            { stopId: 'SHORT_B', arrivalMinutes: 601.2625, departureMinutes: 601.2625, sequence: 2 },
          ],
        }],
      },
      {
        id: 'LONG', shortName: 'LONG', routeType: 3,
        scheduledTrips: [{
          tripId: 'long-1',
          serviceId: 'sunday',
          serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'LONG_A', arrivalMinutes: 480, departureMinutes: 480, sequence: 1 },
            { stopId: 'LONG_B', arrivalMinutes: 490, departureMinutes: 490, sequence: 2 },
          ],
        }],
      },
    ],
    transferRules: [],
  }
  await fs.writeFile(shortTransitSchedulePath, JSON.stringify(shortTransitSchedule))
  await buildScheduleFixture({
    schedules: [{ feedId: 'short', schedulePath: shortTransitSchedulePath }],
    outputPath: shortTransitStorePath,
  })

  const accessBoundSchedule = {
    stops: [
      { id: 'ACCESS_A', name: 'Access-bound origin stop', lat: 0, lon: -0.0009, locationType: 0 },
      { id: 'ACCESS_B', name: 'Access-bound destination stop', lat: 0, lon: 0.0018, locationType: 0 },
    ],
    routes: [{
      id: 'SLOW', shortName: 'SLOW', routeType: 3,
      scheduledTrips: [{
        tripId: 'slow-1',
        serviceId: 'sunday',
        serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'ACCESS_A', arrivalMinutes: 482, departureMinutes: 482, sequence: 1 },
          { stopId: 'ACCESS_B', arrivalMinutes: 483, departureMinutes: 483, sequence: 2 },
        ],
      }],
    }],
    transferRules: [],
  }
  await fs.writeFile(accessBoundSchedulePath, JSON.stringify(accessBoundSchedule))
  await buildScheduleFixture({
    schedules: [{ feedId: 'access-bound', schedulePath: accessBoundSchedulePath }],
    outputPath: accessBoundStorePath,
  })
  await fs.copyFile(accessBoundStorePath, incompleteCoverageStorePath)
  const incompleteCoverageStore = new DatabaseSync(incompleteCoverageStorePath)
  try {
    const setMetadata = incompleteCoverageStore.prepare(
      'INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)',
    )
    setMetadata.run('serviceModel', JSON.stringify('exact-date-multi-feed'))
    setMetadata.run('sourceStores', JSON.stringify([
      {
        scope: 'access-bound',
        storeId: 'access-bound',
        sourceFingerprint: 'access-bound',
        sourceFile: 'access-bound.zip',
      },
      {
        scope: 'missing-scope',
        storeId: 'missing-scope',
        sourceFingerprint: 'missing-scope',
        sourceFile: 'missing-scope.zip',
      },
    ]))
  } finally {
    incompleteCoverageStore.close()
  }
  const singleFeedAccessBoundStore = new DatabaseSync(accessBoundStorePath)
  try {
    singleFeedAccessBoundStore.prepare(
      "UPDATE metadata SET value='\"exact-date\"' WHERE key='serviceModel'",
    ).run()
    singleFeedAccessBoundStore.prepare(
      "UPDATE metadata SET value='[]' WHERE key='sourceStores'",
    ).run()
  } finally {
    singleFeedAccessBoundStore.close()
  }

  // Dense reachable candidates can consume the street helper's default
  // 12-result budget before it returns a slightly farther, correct-direction
  // stop on the same mode. One decoy still produces a valid but
  // 20-minute-slower route, so no-path-only recovery cannot repair this case.
  const denseDecoyStops = Array.from({ length: 12 }, (_value, index) => ({
    id: `D${String(index + 1).padStart(2, '0')}`,
    name: `Dense decoy ${index + 1}`,
    lat: index === 0 ? 0 : 0.0009 + index * 0.00002,
    lon: index === 0 ? -0.0009 : -0.0004,
    locationType: 0,
  }))
  const denseSchedule = {
    stops: [
      ...denseDecoyStops,
      { id: 'USEFUL', name: 'Useful boarding stop', lat: 0, lon: 0.00135, locationType: 0 },
      { id: 'DEST', name: 'Dense destination', lat: 0, lon: 0.004, locationType: 0 },
      { id: 'OTHER', name: 'Other terminus', lat: 0.01, lon: 0, locationType: 0 },
    ],
    routes: [
      {
        id: 'SLOW', shortName: 'SLOW', routeType: 3,
        scheduledTrips: [
          {
            tripId: 'slow-1', serviceId: 'weekday', serviceDays: ['weekday'],
            stopTimes: [
              { stopId: 'D01', arrivalMinutes: 485, departureMinutes: 485, sequence: 1 },
              { stopId: 'DEST', arrivalMinutes: 515, departureMinutes: 515, sequence: 2 },
            ],
          },
          {
            tripId: 'slow-2', serviceId: 'weekday', serviceDays: ['weekday'],
            stopTimes: [
              { stopId: 'D01', arrivalMinutes: 600, departureMinutes: 600, sequence: 1 },
              { stopId: 'DEST', arrivalMinutes: 630, departureMinutes: 630, sequence: 2 },
            ],
          },
        ],
      },
      {
        id: 'FAST', shortName: 'FAST', routeType: 3,
        scheduledTrips: [{
          tripId: 'fast-1', serviceId: 'weekday', serviceDays: ['weekday'],
          stopTimes: [
            { stopId: 'USEFUL', arrivalMinutes: 485, departureMinutes: 485, sequence: 1 },
            { stopId: 'DEST', arrivalMinutes: 495, departureMinutes: 495, sequence: 2 },
          ],
        }],
      },
      ...denseDecoyStops.slice(1).map((stop) => ({
        id: `DECOY-${stop.id}`, shortName: `DECOY-${stop.id}`, routeType: 3,
        scheduledTrips: [1, 2].map((trip) => ({
          tripId: `decoy-${stop.id}-${trip}`,
          serviceId: 'weekday',
          serviceDays: ['weekday'],
          stopTimes: [
            { stopId: stop.id, arrivalMinutes: 540 + trip * 30, departureMinutes: 540 + trip * 30, sequence: 1 },
            { stopId: 'OTHER', arrivalMinutes: 550 + trip * 30, departureMinutes: 550 + trip * 30, sequence: 2 },
          ],
        })),
      })),
    ],
    transferRules: [],
  }
  await fs.writeFile(denseAccessSchedulePath, JSON.stringify(denseSchedule))
  await buildScheduleFixture({
    schedules: [{ feedId: 'dense', schedulePath: denseAccessSchedulePath }],
    outputPath: denseAccessStorePath,
  })
  const denseAccessStreet = new DatabaseSync(denseAccessStreetPath)
  denseAccessStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v6"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES
      (1, 0, 0), (2, 0, -0.0009), (3, 0, 0.00135), (4, 0, 0.004), (16, 0.01, 0),
      (17, 0, 0.0044),
      (5, 0.00092, -0.0004), (6, 0.00094, -0.0004), (7, 0.00096, -0.0004),
      (8, 0.00098, -0.0004), (9, 0.001, -0.0004), (10, 0.00102, -0.0004),
      (11, 0.00104, -0.0004), (12, 0.00106, -0.0004), (13, 0.00108, -0.0004),
      (14, 0.0011, -0.0004), (15, 0.00112, -0.0004);
    INSERT INTO edges VALUES
      (1, 2, 100, 1), (2, 1, 100, 1),
      (1, 5, 101, 4), (5, 1, 101, 4),
      (1, 6, 102, 5), (6, 1, 102, 5),
      (1, 7, 103, 6), (7, 1, 103, 6),
      (1, 8, 104, 7), (8, 1, 104, 7),
      (1, 9, 105, 8), (9, 1, 105, 8),
      (1, 10, 106, 9), (10, 1, 106, 9),
      (1, 11, 107, 10), (11, 1, 107, 10),
      (1, 12, 108, 11), (12, 1, 108, 11),
      (1, 13, 109, 12), (13, 1, 109, 12),
      (1, 14, 110, 13), (14, 1, 110, 13),
      (1, 15, 111, 14), (15, 1, 111, 14),
      (1, 3, 150, 2), (3, 1, 150, 2),
      (3, 4, 300, 3), (4, 3, 300, 3),
      (4, 17, 45.32, 15), (17, 4, 45.32, 15);
  `)
  finalizeCurrentStreetFixture(denseAccessStreet)
  denseAccessStreet.close()
  prepareRustFixtureStreetStore(denseAccessStreetPath)

  const completeEgressSchedule = {
    stops: [
      { id: 'ORIGIN', name: 'Egress origin', lat: 0, lon: 0, locationType: 0 },
      { id: 'X', name: 'Useful alighting stop', lat: 0, lon: 0.01, locationType: 0 },
      { id: 'Y', name: 'Unnecessary connector stop', lat: 0, lon: 0.011, locationType: 0 },
    ],
    routes: [
      {
        id: 'MAIN', shortName: 'MAIN', routeType: 3,
        scheduledTrips: [{
          tripId: 'main-1', serviceId: 'weekday', serviceDays: ['weekday'],
          stopTimes: [
            { stopId: 'ORIGIN', arrivalMinutes: 480, departureMinutes: 480, sequence: 1 },
            { stopId: 'X', arrivalMinutes: 490, departureMinutes: 490, sequence: 2 },
          ],
        }],
      },
      {
        id: 'CONNECTOR', shortName: 'CONNECTOR', routeType: 3,
        scheduledTrips: [{
          tripId: 'connector-1', serviceId: 'weekday', serviceDays: ['weekday'],
          stopTimes: [
            { stopId: 'X', arrivalMinutes: 500, departureMinutes: 500, sequence: 1 },
            { stopId: 'Y', arrivalMinutes: 501, departureMinutes: 501, sequence: 2 },
          ],
        }],
      },
    ],
    transferRules: [],
  }
  await fs.writeFile(completeEgressSchedulePath, JSON.stringify(completeEgressSchedule))
  await buildScheduleFixture({
    schedules: [{ feedId: 'egress', schedulePath: completeEgressSchedulePath }],
    outputPath: completeEgressStorePath,
  })
  const completeEgressStreet = new DatabaseSync(completeEgressStreetPath)
  completeEgressStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v6"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES (1, 0, 0.01), (2, 0, 0.011), (3, 0, 0.012);
    INSERT INTO edges VALUES
      (1, 2, 100, 1), (2, 1, 100, 1),
      (2, 3, 100, 2), (3, 2, 100, 2);
  `)
  finalizeCurrentStreetFixture(completeEgressStreet)
  completeEgressStreet.close()
  prepareRustFixtureStreetStore(completeEgressStreetPath)

  const zip = new JSZip()
  zip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'A,Alpha,47.0000,8.0000,0',
    'B,Bravo,47.0100,8.0100,0',
    'C,Charlie,47.0200,8.0200,0',
  ].join('\n'))
  zip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type,route_color',
    'R1,1,Alpha Bravo,2,cc0000',
    'R2,2,Bravo Charlie,2,0066cc',
  ].join('\n'))
  zip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id,shape_id',
    'R1,S,t1,0,shape-r1',
    'R2,S,t2,0,',
  ].join('\n'))
  zip.file('shapes.txt', [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    'shape-r1,47.0000,8.0000,1',
    'shape-r1,47.0040,8.0030,2',
    'shape-r1,47.0070,8.0080,3',
    'shape-r1,47.0100,8.0100,4',
  ].join('\n'))
  zip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    't1,08:05:00,08:05:00,A,1',
    't1,08:15:00,08:15:00,B,2',
    't2,08:20:00,08:20:00,B,1',
    't2,08:30:00,08:30:00,C,2',
  ].join('\n'))
  zip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n')
  zip.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260712,1\n')
  zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,B,0,0\n')
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

  const result = await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  assert.equal(result.stopTimeCount, 4)
  assert.equal(result.connectionCount, 2)
  assert.equal(result.shapePointCount, 4)
  assert.equal(readNationalGtfsStoreMetadata(storePath).schemaVersion, 'vigo.routing.store.v4')
  const oversizedSourcePreflight = await runOversizedSourcePreflightFixture(storePath)
  assert.equal(oversizedSourcePreflight.preflight.eligible, false)
  assert.equal(oversizedSourcePreflight.preflight.reason, 'source_connection_guard')
  assert.equal(
    oversizedSourcePreflight.staticTopology.routingRole,
    'analysis_only',
    'Routing prewarm must not materialize the analysis-only reverse topology graph.',
  )
  assert.equal(oversizedSourcePreflight.activeServiceKernel.reason, 'source_connection_guard')
  const indexedStore = new DatabaseSync(storePath, { readOnly: true })
  assert.equal(
    indexedStore.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='trips_route'").get()?.present,
    1,
    'New national stores must index trips by route for bounded preview counts.',
  )
  indexedStore.close()

  const feedSummary = nationalFeedSummary(storePath, result, 'fixture-feed')
  const drawableRoutes = feedSummary.mapPreview.routes.filter((route) => (
    route.geometrySource === 'stop_sequence'
      && route.tripCount > 0
      && route.stopIds.length >= 2
      && route.coordinates.length >= 2
      && route.coordinates.every((coordinate) => coordinate.length === 2 && coordinate.every(Number.isFinite))
  ))
  assert(drawableRoutes.length >= 1, 'A shape-less national feed must expose a finite stop-sequence route preview.')
  assert.equal(drawableRoutes.find((route) => route.routeId === 'R1')?.tripCount, 1)
  assert.equal(feedSummary.mapPreview.routes.reduce((sum, route) => sum + route.tripCount, 0), result.tripCount)
  assert.equal(feedSummary.mapPreview.coverage.tripCountStrategy, 'exact-indexed')

  const repairProjectId = 'national-preview-repair'
  const repairFeedId = 'fixture-feed'
  const repairProjectsPath = path.join(folder, 'projects')
  const repairConfigPath = path.join(folder, 'config')
  const repairMetaPath = path.join(repairProjectsPath, repairProjectId, '.vigo')
  const repairTransportPath = path.join(repairMetaPath, 'transport', `${repairFeedId}.json`)
  const { routeMetrics: _routeMetrics, stopMetrics: _stopMetrics, mapPreview: _mapPreview, ...storedFeed } = feedSummary
  const repairProject = {
    schemaVersion: 'vigo.project.v1',
    id: repairProjectId,
    name: 'National preview repair',
    region: 'Fixture',
    createdAt: result.builtAt,
    updatedAt: result.builtAt,
    storagePath: path.join(repairProjectsPath, repairProjectId),
    summary: { feeds: 1, routes: result.routeCount, stops: result.stopCount, transferCandidates: result.transferCount, qualityScore: 100 },
    feeds: [storedFeed],
    jobs: [],
    artifacts: [],
  }
  await fs.mkdir(path.join(repairMetaPath, 'routing'), { recursive: true })
  await Promise.all([
    fs.copyFile(storePath, path.join(repairMetaPath, 'routing', `${repairFeedId}.sqlite`)),
    fs.writeFile(path.join(repairMetaPath, 'project.json'), JSON.stringify(repairProject)),
  ])
  const fixtureApi = await startFixtureApi(repairProjectsPath, repairConfigPath)
  let firstRepairMs = 0
  let secondRepairMs = 0
  try {
    const firstStartedAt = performance.now()
    const firstResponse = await fixtureApi.requestJson(
      `/api/projects/${repairProjectId}`,
    )
    const firstProject = firstResponse.body.project
    firstRepairMs = performance.now() - firstStartedAt
    assert.equal(firstResponse.status, 200)
    assert.equal(firstProject.feeds[0].routeMetrics.length, result.routeCount, 'Project transport must keep the complete SQLite route catalog.')
    assert.equal(firstProject.feeds[0].mapPreview.routes.length, result.routeCount, 'A drawable but incomplete indexed preview must be repaired from SQLite.')
    assert(firstProject.feeds[0].mapPreview.routes.some((route) => route.geometrySource === 'stop_sequence' && route.tripCount > 0 && route.coordinates.length >= 2))
    await assert.rejects(
      fs.stat(repairTransportPath),
      (error) => error?.code === 'ENOENT',
      'Project hydration must not recreate a transport JSON sidecar.',
    )

    const secondStartedAt = performance.now()
    const secondResponse = await fixtureApi.requestJson(
      `/api/projects/${repairProjectId}`,
    )
    secondRepairMs = performance.now() - secondStartedAt
    assert.equal(secondResponse.status, 200)
    await assert.rejects(fs.stat(repairTransportPath), (error) => error?.code === 'ENOENT')
  } finally {
    await fixtureApi.stop()
  }

  const compactKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(compactKernelContext.activeServiceKernel.ready, true, 'Prewarm must compile the bounded Rust active-service kernel.')
  assert.equal(compactKernelContext.activeServiceKernel.activeSegments, 2)
  assert.equal(compactKernelContext.activeServiceKernel.engine, 'rust_exact_connection_scan')
  assert.equal(compactKernelContext.activeServiceKernel.heuristicMode, 'none')
  assert(
    compactKernelContext.activeServiceKernel.nativeMemoryBudget.limitBytes === null
      || compactKernelContext.activeServiceKernel.nativeMemoryBudget.usedBytes
        <= compactKernelContext.activeServiceKernel.nativeMemoryBudget.limitBytes,
  )
  const retainedRoleAdmission = await ensureNationalGtfsStopAccessRoles(storePath)
  assert.equal(retainedRoleAdmission.built, false)

  const inactiveKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-19',
    serviceDay: 'sunday',
  })
  assert.equal(inactiveKernelContext.activeServiceKernel.ready, false)
  const restoredKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(restoredKernelContext.activeServiceKernel.ready, true)
  assert.equal(restoredKernelContext.activeServiceKernel.contextCacheHit, true, 'A repeated service set in the same process must restore the bounded in-memory context.')

  disposeNationalGtfsStore(storePath)
  const reloadedKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(reloadedKernelContext.activeServiceKernel.ready, true)
  assert.equal(reloadedKernelContext.activeServiceKernel.persistenceState, 'loaded', 'A later process/service activation must load the versioned compact snapshot instead of recompiling it.')
  assert.equal(reloadedKernelContext.activeServiceKernel.compileMs, 0)

  await fs.copyFile(storePath, kernelFallbackStorePath)
  const compactKernelFallbackContext = prepareNationalGtfsRoutingContext(kernelFallbackStorePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(
    compactKernelFallbackContext.activeServiceKernel.ready,
    true,
    'The Rust exact timetable kernel must not depend on a static-topology sidecar.',
  )
  for (const departureMinutes of [8 * 60, 8 * 60 + 4, 8 * 60 + 5, 8 * 60 + 6]) {
  }

  await fs.copyFile(storePath, weekdayTemplateStorePath)
  const weekdayTemplateStore = new DatabaseSync(weekdayTemplateStorePath)
  weekdayTemplateStore.prepare("UPDATE metadata SET value='\"weekday-template\"' WHERE key='serviceModel'").run()
  weekdayTemplateStore.close()

  const denseAccessRequest = {
    origin: { coordinate: [0, 0], label: 'Dense access origin', source: 'map' },
    destination: { coordinate: [0.004, 0], label: 'Dense access destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDay: 'weekday',
    serviceDate: '2026-07-13',
    maxWalkKm: 1,
    streetStorePath: denseAccessStreetPath,
  }

  denseAccessRequest.requireTransitRide = false
  for (const timePreference of ['depart', 'arrive']) {
  }

  // A walk can win now while a later departure catches faster transit. Reuse
  // only the proven interval, including when the moving horizon admits a trip.
  for (const shortHorizon of [false, true]) {
    const schedulePath = path.join(folder, `walk-window-${shortHorizon}.json`)
    const windowStorePath = path.join(folder, `walk-window-${shortHorizon}.sqlite`)
    const stops = shortTransitSchedule.stops.filter((stop) => stop.id.startsWith('LONG_'))
      .map((stop) => shortHorizon && stop.id === 'LONG_B' ? { ...stop, lon: 0.001125 } : stop)
    const trips = [{ id: 'LATER', departure: 485, arrival: shortHorizon ? 485.5 : 487, to: 'LONG_B' }]
    if (shortHorizon) {
      stops.push({ id: 'LONG_C', name: 'Direct destination', lat: 0.03, lon: 0.00225, locationType: 0 })
      trips.push({ id: 'OUTSIDE', departure: 486 + 1 / 60, arrival: 486 + 2 / 60, to: 'LONG_C' })
    }
    await fs.writeFile(schedulePath, JSON.stringify({
      stops,
      routes: trips.map((trip) => ({
        id: trip.id, shortName: trip.id, routeType: 3,
        scheduledTrips: [{
          tripId: trip.id, serviceId: 'sunday', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'LONG_A', arrivalMinutes: trip.departure, departureMinutes: trip.departure, sequence: 1 },
            { stopId: trip.to, arrivalMinutes: trip.arrival, departureMinutes: trip.arrival, sequence: 2 },
          ],
        }],
      })),
      transferRules: [],
    }))
    await buildScheduleFixture({ schedules: [{ feedId: 'walk-window', schedulePath }], outputPath: windowStorePath })
    try {
    } finally {
      disposeNationalGtfsStore(windowStorePath)
    }
  }

  await fs.copyFile(storePath, cacheTruthStorePath)
  const cacheTruthStore = new DatabaseSync(cacheTruthStorePath)
  cacheTruthStore.prepare('UPDATE connections SET departure=?, arrival=? WHERE trip_id=?').run(11 * 3600 + 50 * 60, 12 * 3600, 't2')
  cacheTruthStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: cacheTruthStorePath,
    outputPath: `${cacheTruthStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })

  await buildNationalGtfsStore({ zipPath, outputPath: cacheTruthStorePath })

  await fs.copyFile(storePath, transferShortcutStorePath)
  const transferShortcutStore = new DatabaseSync(transferShortcutStorePath)
  transferShortcutStore.prepare('INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)').run('A', 'C', 0, 60)
  transferShortcutStore.prepare(`
    INSERT OR REPLACE INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('A', 'C')
  transferShortcutStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferShortcutStorePath,
    outputPath: `${transferShortcutStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })
  const preboardingShortcutStore = new DatabaseSync(transferShortcutStorePath)
  preboardingShortcutStore.prepare('INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)').run('A', 'B', 0, 60)
  preboardingShortcutStore.prepare(`
    INSERT OR REPLACE INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('A', 'B')
  preboardingShortcutStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferShortcutStorePath,
    outputPath: `${transferShortcutStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })

  const earlyShortcutStore = new DatabaseSync(transferShortcutStorePath)
  earlyShortcutStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('R-EARLY', 'EARLY', 'Early transfer trap', 3, 'cc00cc')
  earlyShortcutStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('early-transfer-trap', 'R-EARLY', 'S', '0')
  earlyShortcutStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
    .run(8 * 3600 + 5 * 60, 8 * 3600 + 10 * 60, 'early-transfer-trap', 'R-EARLY', 'S', '0', 'B', 'C', 1)
  earlyShortcutStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferShortcutStorePath,
    outputPath: `${transferShortcutStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })

  await fs.copyFile(transferShortcutStorePath, transferOnlyStorePath)
  const transferOnlyStore = new DatabaseSync(transferOnlyStorePath)
  transferOnlyStore.exec('DELETE FROM connections; DELETE FROM trips;')
  transferOnlyStore.close()
  await buildNationalStaticTopologySidecar({
    storePath: transferOnlyStorePath,
    outputPath: `${transferOnlyStorePath}.static-topology.sqlite`,
    minimumFreeBytes: 128 * 1024 * 1024,
  })

  await fs.copyFile(storePath, legacyAccessStorePath)
  const legacyAccessStore = new DatabaseSync(legacyAccessStorePath)
  legacyAccessStore.exec('DROP TABLE stop_modes;')
  legacyAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('A_PARENT', 'Alpha station', 47, 8, null, 1, null)
  legacyAccessStore.prepare('UPDATE stops SET parent_station=? WHERE stop_id=?').run('A_PARENT', 'A')
  const insertLegacyLocalStop = legacyAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)')
  for (let index = 0; index < 12; index += 1) {
    insertLegacyLocalStop.run(`L${index}`, `Local ${index}`, 46.9992 + index * 0.00002, 8, null, 0, null)
  }
  legacyAccessStore.close()

  await fs.copyFile(storePath, parentModeAccessStorePath)
  const parentModeAccessStore = new DatabaseSync(parentModeAccessStorePath)
  parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('A_PARENT', 'Alpha station', 47, 8, null, 1, null)
  parentModeAccessStore.prepare('UPDATE stops SET parent_station=? WHERE stop_id=?').run('A_PARENT', 'A')
  parentModeAccessStore.prepare('UPDATE stops SET lon=? WHERE stop_id=?').run(8.002, 'A')
  parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('A_ENTRANCE', 'Alpha public entrance', 47, 8, 'A_PARENT', 2, null)
  parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)').run('C_PARENT', 'Charlie station', 47.02, 8.02, null, 1, null)
  parentModeAccessStore.prepare('UPDATE stops SET parent_station=? WHERE stop_id=?').run('C_PARENT', 'C')
  const insertParentModeLocalStop = parentModeAccessStore.prepare('INSERT INTO stops VALUES(?,?,?,?,?,?,?)')
  for (let index = 0; index < 12; index += 1) {
    insertParentModeLocalStop.run(`M${index}`, `Mode local ${index}`, 46.9992 + index * 0.00002, 8, null, 0, null)
  }
  insertParentModeLocalStop.run('T_PARENT', 'Busy tram parent', 46.9992, 8.0001, null, 1, null)
  insertParentModeLocalStop.run('T_PLATFORM', 'Busy tram platform', 46.9992, 8.0001, 'T_PARENT', 0, null)
  insertParentModeLocalStop.run('T_END', 'Busy tram terminus', 46.98, 7.98, null, 0, null)
  parentModeAccessStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('TR', 'T', 'Busy tram', 0, 'cc6600')
  const insertTramTrip = parentModeAccessStore.prepare('INSERT INTO trips VALUES(?,?,?,?)')
  const insertTramConnection = parentModeAccessStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  for (let index = 0; index < 12; index += 1) {
    const tripId = `tram-${index}`
    const departure = 9 * 3600 + index * 60
    insertTramTrip.run(tripId, 'TR', 'S', '0')
    insertTramConnection.run(departure, departure + 5 * 60, tripId, 'TR', 'S', '0', 'T_PLATFORM', 'T_END', 1)
  }
  parentModeAccessStore.prepare('UPDATE connections SET departure=? WHERE trip_id=?').run(8 * 3600 + 4 * 60, 't1')
  parentModeAccessStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(parentModeAccessStorePath)
  const parentModeAccessStreet = new DatabaseSync(parentModeAccessStreetPath)
  parentModeAccessStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v6"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES(1, 46.9992, 8), (2, 47, 8), (3, 47.02, 8.02);
    INSERT INTO edges VALUES(1, 2, 100, 1), (2, 1, 100, 1);
  `)
  finalizeCurrentStreetFixture(parentModeAccessStreet)
  parentModeAccessStreet.close()
  prepareRustFixtureStreetStore(parentModeAccessStreetPath)

  const gapZip = new JSZip()
  gapZip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'G0,Gap origin,47.1000,8.1000,0',
    'G1,Untimed intermediate,47.1050,8.1050,0',
    'G2,Gap bridge,47.1100,8.1100,0',
    'G3,Gap destination,47.1150,8.1150,0',
  ].join('\n'))
  gapZip.file('routes.txt', 'route_id,route_short_name,route_long_name,route_type,route_color\nGR,G,Gap route,2,663399\n')
  gapZip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nGR,GS,gt,0\n')
  gapZip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'gt,08:00:00,08:00:00,G0,1',
    'gt,,,G1,2',
    'gt,08:20:00,08:20:00,G2,3',
    'gt,08:30:00,08:30:00,G3,4',
  ].join('\n'))
  gapZip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nGS,1,1,1,1,1,1,1,20260101,20261231\n')
  await fs.writeFile(gapZipPath, await gapZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const gapBuild = await buildNationalGtfsStore({ zipPath: gapZipPath, outputPath: gapStorePath })
  assert.equal(gapBuild.connectionCount, 2, 'Untimed intermediate stops must bridge adjacent timed anchors without disconnecting the trip.')

  await fs.copyFile(gapStorePath, legacyGapStorePath)
  const legacyGapStore = new DatabaseSync(legacyGapStorePath)
  legacyGapStore.exec('DELETE FROM connections;')
  const insertLegacyGapConnection = legacyGapStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  insertLegacyGapConnection.run(8 * 3600, 8 * 3600 + 10 * 60, 'gt', 'GR', 'GS', '0', 'G0', 'G1', 1)
  insertLegacyGapConnection.run(8 * 3600 + 20 * 60, 8 * 3600 + 30 * 60, 'gt', 'GR', 'GS', '0', 'G2', 'G3', 4)
  legacyGapStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(legacyGapStorePath)

  await fs.copyFile(gapStorePath, sectionGapStorePath)
  const sectionGapStore = new DatabaseSync(sectionGapStorePath)
  sectionGapStore.exec('DELETE FROM connections; DELETE FROM trips;')
  sectionGapStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('UR', 'U', 'Gap connector', 2, '336699')
  sectionGapStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('gt', 'GR', 'GS', '0')
  sectionGapStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('ut', 'UR', 'GS', '0')
  const insertSectionGapConnection = sectionGapStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  insertSectionGapConnection.run(8 * 3600, 8 * 3600 + 10 * 60, 'gt', 'GR', 'GS', '0', 'G0', 'G1', 1)
  insertSectionGapConnection.run(8 * 3600 + 20 * 60, 8 * 3600 + 30 * 60, 'gt', 'GR', 'GS', '0', 'G2', 'G3', 2)
  insertSectionGapConnection.run(8 * 3600 + 5 * 60, 8 * 3600 + 15 * 60, 'ut', 'UR', 'GS', '0', 'G0', 'G2', 1)
  sectionGapStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(sectionGapStorePath)

  const matrixKernelContext = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(matrixKernelContext.activeServiceKernel.ready, true)

  await fs.writeFile(matrixHorizonSchedulePath, JSON.stringify({
    stops: [
      { id: 'O', name: 'Horizon origin', lat: 47, lon: 8 },
      { id: 'X', name: 'In-horizon alighting', lat: 47, lon: 8.01 },
      // About 152 m: the published two-minute transfer remains walkable.
      { id: 'D', name: 'Post-horizon transfer destination', lat: 47, lon: 8.012 },
      { id: 'Z', name: 'Destination service witness', lat: 47, lon: 8.03 },
    ],
    transferRules: [{
      fromStopId: 'X', toStopId: 'D', transferType: 2, minTransferTimeSeconds: 120,
    }],
    routes: [{
      routeId: 'IN', shortName: 'IN', routeType: 3,
      scheduledTrips: [{
        tripId: 'in-horizon', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'O', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
          { stopId: 'X', sequence: 2, arrivalMinutes: 489, departureMinutes: 489 },
        ],
      }],
    }, {
      routeId: 'RESIDENT', shortName: 'RESIDENT', routeType: 3,
      scheduledTrips: [{
        tripId: 'destination-resident', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'D', sequence: 1, arrivalMinutes: 600, departureMinutes: 600 },
          { stopId: 'Z', sequence: 2, arrivalMinutes: 610, departureMinutes: 610 },
        ],
      }],
    }],
  }))
  await buildScheduleFixture({
    schedules: [{ feedId: 'matrix-horizon', schedulePath: matrixHorizonSchedulePath }],
    outputPath: matrixHorizonStorePath,
  })

  const matrixIdentitySchedulePath = path.join(folder, 'matrix-point-identity.json')
  const matrixIdentityStorePath = path.join(folder, 'matrix-point-identity.sqlite')
  await fs.writeFile(matrixIdentitySchedulePath, JSON.stringify({
    stops: [
      { id: 'O1', name: 'Co-located origin one', lat: 47, lon: 8 },
      { id: 'O2', name: 'Co-located origin two', lat: 47, lon: 8 },
      { id: 'U', name: 'Unserved co-located origin', lat: 47, lon: 8 },
      { id: 'D1', name: 'Co-located destination one', lat: 47, lon: 8.01 },
      { id: 'D2', name: 'Co-located destination two', lat: 47, lon: 8.01 },
    ],
    routes: [
      {
        id: 'FAST', shortName: 'FAST', routeType: 3,
        scheduledTrips: [{
          tripId: 'fast', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O1', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D1', sequence: 2, arrivalMinutes: 490, departureMinutes: 490 },
          ],
        }],
      },
      {
        id: 'O1-D2', shortName: 'O1-D2', routeType: 3,
        scheduledTrips: [{
          tripId: 'o1-d2', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O1', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D2', sequence: 2, arrivalMinutes: 500, departureMinutes: 500 },
          ],
        }],
      },
      {
        id: 'O2-D1', shortName: 'O2-D1', routeType: 3,
        scheduledTrips: [{
          tripId: 'o2-d1', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O2', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D1', sequence: 2, arrivalMinutes: 510, departureMinutes: 510 },
          ],
        }],
      },
      {
        id: 'O2-D2', shortName: 'O2-D2', routeType: 3,
        scheduledTrips: [{
          tripId: 'o2-d2', serviceId: 'SUN', serviceDays: ['sunday'],
          stopTimes: [
            { stopId: 'O2', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
            { stopId: 'D2', sequence: 2, arrivalMinutes: 520, departureMinutes: 520 },
          ],
        }],
      },
    ],
  }))
  await buildScheduleFixture({
    schedules: [{ feedId: 'matrix-id', schedulePath: matrixIdentitySchedulePath }],
    outputPath: matrixIdentityStorePath,
  })

  const matrixIdentityContext = prepareNationalGtfsRoutingContext(matrixIdentityStorePath, {
    serviceDate: '2026-07-12',
    serviceDay: 'sunday',
  })
  assert.equal(matrixIdentityContext.activeServiceKernel.ready, true)

  await fs.writeFile(matrixCycleSchedulePath, JSON.stringify({
    stops: [
      { id: 'O', name: 'Cycle origin', lat: 47, lon: 7.98 },
      { id: 'S', name: 'Shared station', lat: 47, lon: 8, locationType: 1 },
      { id: 'P1', name: 'Shared station platform 1', lat: 47, lon: 8, parentStationId: 'S' },
      { id: 'X', name: 'Turnaround', lat: 47.01, lon: 8.01 },
      { id: 'P2', name: 'Shared station platform 2', lat: 47, lon: 8.0001, parentStationId: 'S' },
      { id: 'D', name: 'Cycle destination', lat: 47, lon: 8.02 },
    ],
    transferRules: [
      { fromStopId: 'X', toStopId: 'X', transferType: 0, minTransferTimeSeconds: 60 },
      { fromStopId: 'P1', toStopId: 'P1', transferType: 0, minTransferTimeSeconds: 60 },
      { fromStopId: 'P2', toStopId: 'P2', transferType: 0, minTransferTimeSeconds: 60 },
      { fromStopId: 'P1', toStopId: 'P2', transferType: 3, minTransferTimeSeconds: 0 },
      { fromStopId: 'P2', toStopId: 'P1', transferType: 3, minTransferTimeSeconds: 0 },
    ],
    routes: [{
      routeId: 'IN', shortName: 'IN', routeType: 3,
      scheduledTrips: [{
        tripId: 'in', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'O', sequence: 1, arrivalMinutes: 450, departureMinutes: 450 },
          { stopId: 'P1', sequence: 2, arrivalMinutes: 470, departureMinutes: 470 },
        ],
      }],
    }, {
      routeId: 'OUT', shortName: 'OUT', routeType: 3,
      scheduledTrips: [{
        tripId: 'out', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'P1', sequence: 1, arrivalMinutes: 480, departureMinutes: 480 },
          { stopId: 'X', sequence: 2, arrivalMinutes: 490, departureMinutes: 490 },
        ],
      }],
    }, {
      routeId: 'BACK', shortName: 'BACK', routeType: 3,
      scheduledTrips: [{
        tripId: 'back', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'X', sequence: 1, arrivalMinutes: 495, departureMinutes: 495 },
          { stopId: 'P2', sequence: 2, arrivalMinutes: 505, departureMinutes: 505 },
        ],
      }],
    }, {
      routeId: 'ONWARD', shortName: 'ONWARD', routeType: 3,
      scheduledTrips: [{
        tripId: 'onward', serviceId: 'SUN', serviceDays: ['sunday'],
        stopTimes: [
          { stopId: 'P2', sequence: 1, arrivalMinutes: 510, departureMinutes: 510 },
          { stopId: 'D', sequence: 2, arrivalMinutes: 520, departureMinutes: 520 },
        ],
      }],
    }],
  }))
  await buildScheduleFixture({
    schedules: [{ feedId: 'matrix-cycle', schedulePath: matrixCycleSchedulePath }],
    outputPath: matrixCycleStorePath,
  })

  disposeNationalGtfsStore(matrixCycleStorePath)

  await fs.copyFile(storePath, matrixUpperBoundStorePath)
  const matrixUpperBoundStore = new DatabaseSync(matrixUpperBoundStorePath)
  matrixUpperBoundStore.prepare('INSERT INTO routes VALUES(?,?,?,?,?)').run('R3', '3', 'Alpha Charlie direct', 2, '339966')
  matrixUpperBoundStore.prepare('INSERT INTO trips VALUES(?,?,?,?)').run('direct', 'R3', 'S', '0')
  matrixUpperBoundStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
    .run(8 * 3600 + 8 * 60, 8 * 3600 + 27 * 60, 'direct', 'R3', 'S', '0', 'A', 'C', 1)
  const insertLateTrip = matrixUpperBoundStore.prepare('INSERT INTO trips VALUES(?,?,?,?)')
  const insertLateConnection = matrixUpperBoundStore.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  for (let index = 0; index < 128; index += 1) {
    const tripId = `late-${index}`
    const lateDeparture = 10 * 3600 + index * 120
    insertLateTrip.run(tripId, 'R3', 'S', '0')
    insertLateConnection.run(lateDeparture, lateDeparture + 20 * 60, tripId, 'R3', 'S', '0', 'A', 'C', 1)
  }
  matrixUpperBoundStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(matrixUpperBoundStorePath)

  const schedulePaths = [path.join(folder, 'feed-a.json'), path.join(folder, 'feed-b.json')]
  const schedule = (routeId, shortName, from, to, depart, arrive) => ({
    schemaVersion: 'vigo.routing.schedule.v1', routeCount: 1, tripCount: 1, stopTimeCount: 2,
    stops: [from, to],
    routes: [{
      id: routeId, routeId, shortName, longName: shortName, routeType: 2, color: '#336699',
      scheduledTrips: [{
        tripId: `${routeId}-trip`, serviceId: 'daily', serviceDays: ['weekday', 'saturday', 'sunday'], routeId,
        firstDepartureMinutes: depart, lastArrivalMinutes: arrive,
        stopTimes: [
          { stopId: from.id, sequence: 1, departureMinutes: depart, arrivalMinutes: depart, progress: 0 },
          { stopId: to.id, sequence: 2, departureMinutes: arrive, arrivalMinutes: arrive, progress: 1 },
        ],
      }],
    }],
  })
  await fs.writeFile(schedulePaths[0], JSON.stringify(schedule('A', 'A',
    { id: 'origin', name: 'Origin', lat: 47, lon: 8 },
    { id: 'interchange-a', name: 'Interchange A', lat: 47.01, lon: 8.01 }, 485, 495)))
  await fs.writeFile(schedulePaths[1], JSON.stringify(schedule('B', 'B',
    { id: 'interchange-b', name: 'Interchange B', lat: 47.0102, lon: 8.0102 },
    { id: 'destination', name: 'Destination', lat: 47.02, lon: 8.02 }, 500, 510)))
  const migrated = await buildScheduleFixture({
    schedules: [{ feedId: 'feed-a', schedulePath: schedulePaths[0] }, { feedId: 'feed-b', schedulePath: schedulePaths[1] }],
    outputPath: migratedStorePath,
  })
  assert.equal(migrated.connectionCount, 2)
  const migratedTransferStore = new DatabaseSync(migratedStorePath)
  migratedTransferStore.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(
    'feed-a\u001finterchange-a',
    'feed-b\u001finterchange-b',
    0,
    120,
  )
  migratedTransferStore.prepare(`
    INSERT INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('feed-a\u001finterchange-a', 'feed-b\u001finterchange-b')
  migratedTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(migratedStorePath)

  await fs.copyFile(migratedStorePath, transferSlackStorePath)
  const transferSlackStore = new DatabaseSync(transferSlackStorePath)
  transferSlackStore.prepare("UPDATE connections SET departure=?, arrival=? WHERE route_id LIKE '%B'").run(498 * 60, 508 * 60)
  transferSlackStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(transferSlackStorePath)

  const rawFeed = async ({ zipPath: output, prefix, from, to, depart, arrive }) => {
    const fixture = new JSZip()
    fixture.file('stops.txt', [
      'stop_id,stop_name,stop_lat,stop_lon,location_type',
      `${from.id},${from.name},${from.lat},${from.lon},0`,
      `${to.id},${to.name},${to.lat},${to.lon},0`,
    ].join('\n'))
    fixture.file('routes.txt', `route_id,route_short_name,route_long_name,route_type\n${prefix},${prefix},${prefix},2\n`)
    fixture.file('trips.txt', `route_id,service_id,trip_id,direction_id\n${prefix},S,${prefix}-trip,0\n`)
    fixture.file('stop_times.txt', [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      `${prefix}-trip,${depart},${depart},${from.id},1`,
      `${prefix}-trip,${arrive},${arrive},${to.id},2`,
    ].join('\n'))
    fixture.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n')
    fixture.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260712,1\n')
    await fs.writeFile(output, await fixture.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  }
  await rawFeed({ zipPath: rawFeedAPath, prefix: 'RA', from: { id: 'O', name: 'Origin', lat: 47, lon: 8 }, to: { id: 'XA', name: 'Exchange A', lat: 47.01, lon: 8.01 }, depart: '08:05:00', arrive: '08:15:00' })
  await rawFeed({ zipPath: rawFeedBPath, prefix: 'RB', from: { id: 'XB', name: 'Exchange B', lat: 47.0101, lon: 8.0101 }, to: { id: 'D', name: 'Destination', lat: 47.02, lon: 8.02 }, depart: '08:20:00', arrive: '08:30:00' })
  await buildNationalGtfsStore({ zipPath: rawFeedAPath, outputPath: rawStoreAPath })
  await buildNationalGtfsStore({ zipPath: rawFeedBPath, outputPath: rawStoreBPath })
  const mergedRaw = await mergeNationalGtfsStores({
    stores: [{ scope: 'feed-a', storePath: rawStoreAPath }, { scope: 'feed-b', storePath: rawStoreBPath }],
    outputPath: mergedRawStorePath,
  })
  assert.equal(mergedRaw.connectionCount, 2)
  assert.equal(mergedRaw.serviceModel, 'exact-date-multi-feed')
  const mergedRawTransferStore = new DatabaseSync(mergedRawStorePath)
  mergedRawTransferStore.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(
    'feed-a\u001fXA',
    'feed-b\u001fXB',
    0,
    120,
  )
  mergedRawTransferStore.prepare(`
    INSERT INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('feed-a\u001fXA', 'feed-b\u001fXB')
  mergedRawTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(mergedRawStorePath)
  const rawMetadataA = readNationalGtfsStoreMetadata(rawStoreAPath)
  const rawMetadataB = readNationalGtfsStoreMetadata(rawStoreBPath)
  const mergedRawMetadata = readNationalGtfsStoreMetadata(mergedRawStorePath)
  assert.equal(
    mergedRawMetadata.sourceFingerprint,
    `feed-a:${rawMetadataA.sourceFingerprint}|feed-b:${rawMetadataB.sourceFingerprint}`,
  )
  assert.deepEqual(
    mergedRawMetadata.featureInventory,
    Object.fromEntries(Object.keys(rawMetadataA.featureInventory).map((key) => [
      key,
      Number(rawMetadataA.featureInventory[key] ?? 0) + Number(rawMetadataB.featureInventory[key] ?? 0),
    ])),
    'A multi-feed store must preserve the complete summed import feature inventory.',
  )
  assert.deepEqual(
    mergedRawMetadata.sourceStores.map((source) => source.sourceFingerprint),
    [rawMetadataA.sourceFingerprint, rawMetadataB.sourceFingerprint],
    'A multi-feed store must retain each component content fingerprint.',
  )

  await fs.copyFile(mergedRawStorePath, arriveTransferStorePath)
  const arriveTransferStore = new DatabaseSync(arriveTransferStorePath)
  arriveTransferStore.prepare('UPDATE stops SET lat=?, lon=? WHERE stop_id=?').run(47.03, 8.03, 'feed-b\u001fXB')
  arriveTransferStore.prepare('INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)').run('feed-a\u001fXA', 'feed-b\u001fXB', 0, 120)
  arriveTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(arriveTransferStorePath)
  await fs.copyFile(arriveTransferStorePath, arriveTransferLegacyStorePath)
  const arriveTransferLegacyStore = new DatabaseSync(arriveTransferLegacyStorePath)
  assert.equal(
    arriveTransferLegacyStore.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='connections_to_arrival_cover'",
    ).get()?.present ?? 0,
    0,
    'Current routing stores intentionally omit the redundant reverse SQLite index.',
  )
  arriveTransferLegacyStore.close()

  const fallbackRail = new JSZip()
  fallbackRail.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'RO,Rail Origin,47.0000,8.0000,0',
    'RX,Rail Exchange,47.0100,8.0100,0',
    'RD,Rail Destination,47.0200,8.0200,0',
  ].join('\n'))
  fallbackRail.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    'DIRECT,Rail direct,Rail direct,1',
    'CONNECTOR,Rail connector,Rail connector,1',
  ].join('\n'))
  fallbackRail.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'DIRECT,R,DIRECT-trip,0',
    'CONNECTOR,R,CONNECTOR-trip,0',
  ].join('\n'))
  fallbackRail.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'DIRECT-trip,08:10:00,08:10:00,RO,1',
    'DIRECT-trip,08:50:00,08:50:00,RD,2',
    'CONNECTOR-trip,08:20:00,08:20:00,RX,1',
    'CONNECTOR-trip,08:30:00,08:30:00,RD,2',
  ].join('\n'))
  fallbackRail.file('calendar.txt', [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'R,1,1,1,1,1,0,0,20250101,20261231',
  ].join('\n'))
  fallbackRail.file('calendar_dates.txt', 'service_id,date,exception_type\n')

  const fallbackBus = new JSZip()
  fallbackBus.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'BO,Bus Origin,46.9900,7.9900,0',
    'BX,Bus Exchange,47.0101,8.0101,0',
  ].join('\n'))
  fallbackBus.file('routes.txt', 'route_id,route_short_name,route_long_name,route_type\nBUS,Bus,Bus,3\n')
  fallbackBus.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nBUS,B,BUS-trip,0\n')
  fallbackBus.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'BUS-trip,08:05:00,08:05:00,BO,1',
    'BUS-trip,08:15:00,08:15:00,BX,2',
  ].join('\n'))
  fallbackBus.file('calendar.txt', [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'B,1,1,1,1,1,0,0,20250101,20251227',
  ].join('\n'))
  fallbackBus.file('calendar_dates.txt', 'service_id,date,exception_type\n')

  await Promise.all([
    fs.writeFile(fallbackRailFeedPath, await fallbackRail.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })),
    fs.writeFile(fallbackBusFeedPath, await fallbackBus.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })),
  ])
  await Promise.all([
    buildNationalGtfsStore({ zipPath: fallbackRailFeedPath, outputPath: fallbackRailStorePath }),
    buildNationalGtfsStore({ zipPath: fallbackBusFeedPath, outputPath: fallbackBusStorePath }),
  ])
  await mergeNationalGtfsStores({
    stores: [{ scope: 'rail', storePath: fallbackRailStorePath }, { scope: 'bus', storePath: fallbackBusStorePath }],
    outputPath: fallbackMergedStorePath,
  })
  const fallbackTransferStore = new DatabaseSync(fallbackMergedStorePath)
  fallbackTransferStore.prepare('INSERT INTO transfers VALUES(?,?,?,?)').run(
    'bus\u001fBX',
    'rail\u001fRX',
    0,
    120,
  )
  fallbackTransferStore.prepare(`
    INSERT INTO transfer_provenance(
      from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
    ) VALUES(?,?,'gtfs_transfer',NULL,NULL)
  `).run('bus\u001fBX', 'rail\u001fRX')
  fallbackTransferStore.close()
  await rebuildFixtureRoutingDerivedArtifacts(fallbackMergedStorePath)
  const fallbackStreet = new DatabaseSync(fallbackStreetPath)
  fallbackStreet.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v6"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES
      (1, 46.9900, 7.9900),
      (2, 47.0101, 8.0101),
      (3, 47.0200, 8.0200);
    -- One walkable edge: a sealed street store needs a pedestrian graph.
    INSERT INTO edges VALUES(2, 3, 1329, 1), (3, 2, 1329, 1);
  `)
  finalizeCurrentStreetFixture(fallbackStreet)
  fallbackStreet.close()
  prepareRustFixtureStreetStore(fallbackStreetPath)
  const smartEarlierDateContext = prepareNationalGtfsRoutingContext(fallbackMergedStorePath, {
    serviceDate: '2025-07-12',
    serviceDay: 'saturday',
    requireCompleteServiceCoverage: true,
  })
  assert.deepEqual(
    smartEarlierDateContext.serviceDateOptions,
    [
      { date: '2025-07-11', relation: 'earlier', recommended: true },
      { date: '2025-07-14', relation: 'later', recommended: false },
    ],
    'An incomplete date must recommend the closest actually complete date, preferring an earlier date when it is closer.',
  )

  await fs.copyFile(rawStoreAPath, invalidRawStorePath)
  const invalidStore = new DatabaseSync(invalidRawStorePath)
  invalidStore.exec("DELETE FROM metadata WHERE key='sourceFingerprint'")
  invalidStore.close()
  await assert.rejects(() => mergeNationalGtfsStores({
    stores: [{ scope: 'valid', storePath: rawStoreAPath }, { scope: 'invalid', storePath: invalidRawStorePath }],
    outputPath: failedMergePath,
    removeSourcesAfterMerge: true,
  }), /lacks a source identity/)
  await fs.access(rawStoreAPath)
  await fs.access(invalidRawStorePath)
  await assert.rejects(() => fs.access(failedMergePath))
  await assert.rejects(() => mergeNationalGtfsStores({
    stores: [{ scope: 'feed-a', storePath: rawStoreAPath }, { scope: 'feed-b', storePath: rawStoreBPath }],
    outputPath: rawStoreAPath,
    removeSourcesAfterMerge: true,
  }), /must differ from every source store/)
  await fs.access(rawStoreAPath)
  await fs.access(rawStoreBPath)
  await mergeNationalGtfsStores({
    stores: [{ scope: 'feed-a', storePath: rawStoreAPath }, { scope: 'feed-b', storePath: rawStoreBPath }],
    outputPath: cleanupMergePath,
    removeSourcesAfterMerge: true,
  })
  await fs.access(cleanupMergePath)
  await assert.rejects(() => fs.access(rawStoreAPath))
  await assert.rejects(() => fs.access(rawStoreBPath))

} finally {
  disposeAllNationalGtfsStores()
  for (const streetPath of [parentModeAccessStreetPath, directWalkStreetPath, denseAccessStreetPath,
    completeEgressStreetPath, fallbackStreetPath]) disposeNationalOsmStore(streetPath)
}
