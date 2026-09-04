import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import {
  buildNationalGtfsStore,
  disposeNationalGtfsStore,
  routeNationalGtfsReach,
} from '../src/server/national-gtfs-store.mjs'
import {
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  buildNationalOsmWalkStore,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import { finalizeCurrentStreetFixture } from './helpers/street-fixture.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'vigo-reach-'))
const zipPath = path.join(folder, 'fixture.zip')
const storePath = path.join(folder, 'fixture.sqlite')
const streetStorePath = path.join(folder, 'street.sqlite')

async function createRoutingFixture() {
  const zip = new JSZip()
  zip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'O,Origin,47.0000,8.0000,0',
    'A,Local A,47.0000,8.0050,0',
    'B,Local B,47.0000,8.0100,0',
    'D,Direct D,47.0050,8.0000,0',
    'X,Mixed X,47.0000,8.0150,0',
    'FAR,Far stop,48.5000,10.0000,0',
  ].join('\n'))
  zip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    'R1,R1,Local line,3',
    'R2,R2,Direct line,3',
    'R3,R3,Mixed tail,3',
    'RF,RF,Far line,3',
  ].join('\n'))
  zip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'R1,S,local,0',
    'R2,S,direct,0',
    'R3,S,tail,0',
    'RF,S,far,0',
  ].join('\n'))
  zip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'local,08:01:00,08:01:00,O,1',
    'local,08:05:00,08:05:00,A,2',
    'direct,08:02:00,08:02:00,O,1',
    'direct,08:07:00,08:07:00,D,2',
    'tail,08:14:00,08:14:00,B,1',
    'tail,08:18:00,08:18:00,X,2',
    'far,08:01:00,08:01:00,FAR,1',
    'far,08:05:00,08:05:00,FAR,2',
  ].join('\n'))
  zip.file('calendar_dates.txt', [
    'service_id,date,exception_type',
    'S,20260720,1',
  ].join('\n'))
  await fsp.writeFile(
    zipPath,
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  )
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })

  const street = new DatabaseSync(streetStorePath)
  street.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      way_id INTEGER NOT NULL
    );
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v3"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES
      (1,47.0000,7.9995),
      (2,47.0000,8.0000),
      (3,47.0000,8.0050),
      (4,47.0000,8.0100),
      (5,47.0050,8.0000),
      (6,48.5000,10.0000),
      (7,47.0000,8.0150);
    INSERT INTO edges VALUES
      (1,2,38,1),(2,1,38,1),
      (2,3,380,2),(3,2,380,2),
      (3,4,380,3),(4,3,380,3),
      (4,7,380,5),(7,4,380,5),
      (2,5,556,4),(5,2,556,4);
  `)
  finalizeCurrentStreetFixture(street)
  street.close()
  assert.equal(
    buildNationalOsmWalkStore(streetStorePath, { force: true, persist: true }).ready,
    true,
  )
  assert.equal(
    compactNationalOsmRuntimeStore(streetStorePath).storageLayout,
    'runtime-snapshots-v1',
  )
  disposeNationalOsmStore(streetStorePath)
  assert.equal(prepareNationalOsmNativeStore(streetStorePath).ready, true)
}

function request(overrides = {}) {
  return {
    origin: {
      coordinate: [7.9995, 47],
      label: 'Coordinate origin',
      source: 'map',
    },
    departMinutes: 480,
    serviceDate: '2026-07-20',
    serviceDay: 'weekday',
    maxWalkKm: 0.2,
    walkSpeedKph: 4.8,
    radiusKm: 5,
    cutoffMinutes: 20,
    surface: {
      bounds: [7.99, 46.99, 8.02, 47.01],
      width: 48,
      height: 48,
    },
    ...overrides,
  }
}

try {
  await createRoutingFixture()
  const progress = []
  const first = routeNationalGtfsReach(storePath, request(), {
    streetStorePath,
    onProgress: (event) => progress.push(event),
  })
  assert.equal(first.schemaVersion, 'vigo.result.reach.v1')
  assert.equal(first.diagnostics.owner, 'rust_resident_timetable_kernel')
  assert.equal(
    first.diagnostics.algorithm,
    'rust_resident_generation_tagged_connection_scan_one_to_many',
  )
  assert.equal(
    first.diagnostics.access.kernel,
    'rust_node_api_coordinate_timetable_one_to_many_v1',
  )
  assert.equal(first.diagnostics.access.nodeApiCalls, 1)
  assert.equal(first.diagnostics.timetable.nationalConnectionScan, true)
  assert.equal(first.surface.schemaVersion, 'vigo.street.network-raster.v1')
  assert.equal(first.surface.values.length, 48 * 48)
  assert(first.surface.nodes.length > 0, 'Reach must retain exact reached OSM node evidence.')
  assert(first.surface.nodes.every((node) => (
    node.coordinate.length === 2
    && node.coordinate.every(Number.isFinite)
    && Number.isFinite(node.durationMinutes)
  )))
  assert.equal(first.diagnostics.surface.owner, 'rust_resident_reach_pipeline')
  assert.equal(first.diagnostics.stopSelection.sampled, false)
  assert.equal(first.diagnostics.stopSelection.proof, 'no_geographic_pruning')
  assert.equal(first.diagnostics.stopSelection.strategy, 'all_active_timetable_stops')
  assert.equal(first.diagnostics.stopSelection.distanceSelection, 'none')
  assert.equal(first.diagnostics.transit.status, 'reached')
  assert.equal(first.diagnostics.transit.earliestScheduledDepartureMinutes, 481)
  assert.deepEqual(
    first.stops.map((stop) => stop.stopId).sort(),
    ['A', 'D'],
    'The fused query must return every reachable stop without geographic preselection.',
  )
  assert.deepEqual(
    [...new Set(progress.map((event) => event.phase))],
    ['access', 'targets', 'search', 'surface', 'complete'],
  )
  for (let index = 1; index < progress.length; index += 1) {
    assert(progress[index].progress >= progress[index - 1].progress)
  }

  const fullGeometry = routeNationalGtfsReach(
    storePath,
    request({
      surface: {
        ...request().surface,
        includeNodes: false,
        includeEdges: true,
      },
    }),
    { streetStorePath },
  )
  assert.equal(fullGeometry.surface.diagnostics.edgeDetailLimit, 0)
  assert.equal(fullGeometry.surface.diagnostics.edgeDetailTruncated, false)
  assert.equal(fullGeometry.surface.diagnostics.fullSurfaceRaster, true)
  assert.equal(fullGeometry.surface.edges.schemaVersion, 'vigo.street.edge-bundle.v1')
  assert.equal(
    fullGeometry.surface.edges.count,
    fullGeometry.surface.diagnostics.reachedEdgeCount,
    'Reach street paths must return every reached directed OSM edge.',
  )
  assert.equal(fullGeometry.surface.fullValues.length, 48 * 48)
  assert(Array.isArray(fullGeometry.surface.fullBounds))
  assert.notDeepEqual(
    fullGeometry.surface.fullBounds,
    request().surface.bounds,
    'The complete vector surface must use the reached-edge envelope, not the requested rectangle.',
  )
  const edgeIdBytes = Buffer.from(fullGeometry.surface.edges.edgeIds, 'base64')
  assert.equal(
    edgeIdBytes.byteLength,
    fullGeometry.surface.edges.count * 4,
    'Full street bundles must carry one exact directed OSM edge ID per path.',
  )
  for (let offset = 4; offset < edgeIdBytes.byteLength; offset += 4) {
    assert(
      edgeIdBytes.readUInt32LE(offset) > edgeIdBytes.readUInt32LE(offset - 4),
      'Full street bundles must sort directed edge IDs for a linear comparison merge.',
    )
  }

  const excluded = routeNationalGtfsReach(
    storePath,
    request({ excludedRouteIds: ['R1'] }),
    { streetStorePath },
  )
  assert.deepEqual(excluded.stops.map((stop) => stop.stopId), ['D'])
  assert(excluded.diagnostics.search.excludedTrips > 0)
  assert(excluded.diagnostics.search.excludedDepartures > 0)

  const overlay = routeNationalGtfsReach(storePath, request({
    scenarioOverlay: {
      stops: [
        { id: 'scenario-a', label: 'Scenario A', coordinate: [8.005, 47], stopId: 'A' },
        { id: 'scenario-b', label: 'Scenario B', coordinate: [8.010, 47], stopId: 'B' },
      ],
      directionOffsets: [0, 2],
      directionStops: [0, 1],
      directionStopOffsetsSeconds: [0, 120],
      serviceStartSeconds: [8 * 3_600 + 8 * 60],
      serviceEndSeconds: [8 * 3_600 + 8 * 60],
      serviceHeadwaySeconds: [600],
    },
  }), { streetStorePath })
  assert.equal(
    overlay.diagnostics.algorithm,
    'rust_resident_query_overlay_connection_scan_one_to_many',
  )
  assert.equal(overlay.diagnostics.timetable.scenarioOverlay.mixedBaselineScenarioTransfers, true)
  assert.equal(overlay.diagnostics.timetable.scenarioOverlay.overlayConnections, 1)
  assert(overlay.diagnostics.timetable.scenarioOverlay.compileMs >= 0)
  assert(overlay.diagnostics.timetable.scenarioOverlay.scanMs >= 0)
  assert(overlay.diagnostics.timetable.scenarioOverlay.transientBytes > 0)
  assert(overlay.diagnostics.timetable.scenarioOverlay.workspaceBytes > 0)
  assert(
    overlay.stops.some((stop) => stop.stopId === 'X'),
    'The resident overlay scan must complete baseline feeder -> scenario service -> baseline tail.',
  )
  assert.deepEqual(
    overlay.scenarioStops.map((stop) => stop.id),
    ['scenario-a', 'scenario-b'],
  )

  const outsideWindow = routeNationalGtfsReach(
    storePath,
    request({ departMinutes: 420, cutoffMinutes: 5 }),
    { streetStorePath },
  )
  assert.equal(outsideWindow.stops.length, 0)
  assert.equal(outsideWindow.diagnostics.transit.status, 'outside_window')
  assert.equal(outsideWindow.diagnostics.transit.earliestScheduledDepartureMinutes, 481)

  const noService = routeNationalGtfsReach(
    storePath,
    request({ serviceDate: '2026-07-21' }),
    { streetStorePath },
  )
  assert.equal(noService.stops.length, 0)
  assert.equal(noService.diagnostics.transit.status, 'no_service')

  const noServiceWindow = routeNationalGtfsReach(
    storePath,
    request({ departMinutes: 1_000 }),
    { streetStorePath },
  )
  assert.equal(noServiceWindow.stops.length, 0)
  assert.equal(noServiceWindow.diagnostics.transit.status, 'no_service_window')

  const replay = routeNationalGtfsReach(storePath, request(), { streetStorePath })
  assert.deepEqual(
    replay.stops,
    first.stops,
    'Generation-tagged exclusions must not leak into the next resident query.',
  )

  let cancelled = false
  await assert.rejects(
    async () => routeNationalGtfsReach(
      storePath,
      request({ departMinutes: 481 }),
      {
        streetStorePath,
        onProgress: (event) => {
          if (event.phase === 'targets') cancelled = true
        },
        isCancelled: () => cancelled,
      },
    ),
    (error) => error?.name === 'AbortError',
  )

  const native = createRequire(import.meta.url)(
    path.join(repositoryRoot, 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node'),
  )
  assert.equal(native.RegionalTopologyKernel, undefined)
  assert.equal(native.RegionalTimetableKernel, undefined)
  assert.equal(typeof native.TimetableKernel, 'function')
  assert.equal(typeof native.CoordinateKernel, 'function')

  const sourceFiles = [
    'src/server/native-routing-kernel.mjs',
    'src/server/national-route-worker.mjs',
    'src/server/reach.mjs',
    'native/vigo-routing-kernel/src/exact_routing.rs',
  ]
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(repositoryRoot, file), 'utf8')
    assert(!source.includes('RegionalTopologyKernel'))
    assert(!source.includes('RegionalTimetableKernel'))
    assert(!source.includes("'regional-range'"))
  }
  assert(!fs.existsSync(path.join(repositoryRoot, 'src', 'server', 'regional-analysis-kernel.mjs')))

  console.log(JSON.stringify({
    ok: true,
    reachedStops: first.stops.length,
    targetStops: first.diagnostics.stopSelection.selected,
    algorithm: first.diagnostics.algorithm,
    coldMs: first.diagnostics.totalMs,
    warmMs: replay.diagnostics.totalMs,
    nativeQueryMs: replay.diagnostics.search.nativeQueryMs,
    fusedNodeApiCalls: replay.diagnostics.access.nodeApiCalls,
  }, null, 2))
} finally {
  disposeNationalGtfsStore(storePath)
  disposeNationalOsmStore(streetStorePath)
  await fsp.rm(folder, { recursive: true, force: true })
}
