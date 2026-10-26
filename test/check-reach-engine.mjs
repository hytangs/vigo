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
  buildNationalGtfsCityStore,
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
import { normalizeRoutingPointIdentities } from '../src/server/routing-point-identity.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { readGtfsRouteAnalysis } from '../src/server/gtfs-analysis-store.mjs'
import { nativePreliminaryRequest, nativeReachRangeRequest, studioReachRange } from '../src/server/studio-reach-ranges.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'vigo-reach-'))
const zipPath = path.join(folder, 'fixture.zip')
const projectsRoot = path.join(folder, 'projects')
const projectId = 'identity-fixture'
const metaRoot = path.join(projectsRoot, projectId, '.vigo')
const storePath = path.join(metaRoot, 'routing', 'fixture.sqlite')
const streetStorePath = path.join(metaRoot, 'osm', 'street-index.sqlite')
const mergedStorePath = path.join(folder, 'merged.sqlite')
const terminalStorePath = path.join(folder, 'terminal-transfer.sqlite')
let apiRuntime

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
    'R3,S,late-connection,0',
    'R3,S,late-tail,0',
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
    'late-connection,08:21:00,08:21:00,A,1',
    'late-connection,08:25:00,08:25:00,B,2',
    'late-tail,08:26:00,08:26:00,B,1',
    'late-tail,08:30:00,08:30:00,X,2',
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

  await fsp.mkdir(path.dirname(streetStorePath), { recursive: true })
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
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v6"');
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
  assert.equal(prepareNationalOsmNativeStore(streetStorePath, { prepareCch: true }).ready, true)
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

  for (const cutoffMinutes of [1, 1.25, 2, 2.5, 4, 4.75, 5]) {
    const short = routeNationalGtfsReach(storePath, request({ cutoffMinutes }), { streetStorePath })
    assert(short.stops.every(stop => stop.durationMinutes <= cutoffMinutes),
      `A ${cutoffMinutes}-minute Reach must not count later transit stops: ${JSON.stringify(short.stops.map(stop => [stop.stopId, stop.durationMinutes]))}`)
    assert(short.surface.values.every(value => !Number.isFinite(value) || value <= cutoffMinutes + 1e-9),
      `A ${cutoffMinutes}-minute street surface must not retain later walking arrivals.`)
    assert(short.surface.values.some(Number.isFinite), 'Short Reach retains the origin walking context.')
  }

  const selectedOrigin = { coordinate: [8, 47], label: 'Imported origin', source: 'stop', stopId: 'feed-local::O' }
  const selectedDestination = { coordinate: [8, 47.005], label: 'Imported destination', source: 'stop', stopId: 'feed-local::D' }
  const selectedRequest = request({ origin: selectedOrigin })
  const normalized = normalizeRoutingPointIdentities(storePath, selectedRequest, 'feed-local')
  for (const origin of [request().origin, normalized.origin]) {
    for (const [maxTransfers, expected] of [
      [0, ['A', 'D']], [1, ['A', 'B', 'D']], [2, ['A', 'B', 'D', 'X']],
      [undefined, ['A', 'B', 'D', 'X']], [0, ['A', 'D']],
    ]) {
      const capped = routeNationalGtfsReach(storePath, request({ origin, cutoffMinutes: 40, maxTransfers }), { streetStorePath })
      assert.deepEqual(capped.stops.map(stop => stop.stopId).sort(), expected,
        `Reach must honor maxTransfers=${maxTransfers} for ${origin.source} origins on each resident request.`)
    }
  }
  for (const maxTransfers of [-1, 0.5, 32, NaN, null, '1']) {
    assert.throws(() => routeNationalGtfsReach(storePath, request({ maxTransfers }), { streetStorePath }),
      /maxTransfers must be an integer/)
  }
  assert.equal(normalized.origin.stopId, 'O')
  assert.equal(selectedRequest.origin.stopId, 'feed-local::O', 'Resolving an endpoint must not mutate a shared comparison request.')
  const importedReach = routeNationalGtfsReach(storePath, normalized, { streetStorePath })
  assert(importedReach.stops.some(stop => stop.stopId === 'D'), 'Desktop imported-stop IDs must reach scheduled destinations through the actual native engine.')
  for (const stopId of ['foreign-feed::O', 'feed-local::missing']) {
    const resolved = normalizeRoutingPointIdentities(storePath, request({ origin: { ...request().origin, source: 'stop', stopId } }), 'feed-local')
    assert.equal(resolved.origin.stopId, undefined)
    assert.equal(resolved.origin.source, 'map')
    assert.deepEqual(routeNationalGtfsReach(storePath, resolved, { streetStorePath }).stops, first.stops,
      'A foreign or missing selected stop must use its coordinates without borrowing a same-named local stop.')
  }
  assert.equal(normalizeRoutingPointIdentities(storePath, request({ origin: { ...request().origin, stopId: 'feed-local::O' } }), 'feed-local').origin.stopId, undefined,
    'Free coordinates remain authoritative even with stale stop metadata.')
  await buildNationalGtfsCityStore({ feeds: [{ scope: 'feed-local', path: zipPath }, { scope: 'foreign-feed', path: zipPath }], outputPath: mergedStorePath })
  const mergedRequest = normalizeRoutingPointIdentities(mergedStorePath, selectedRequest)
  assert.equal(mergedRequest.origin.stopId, 'feed-local\u001fO')
  assert(routeNationalGtfsReach(mergedStorePath, mergedRequest, { streetStorePath }).stops.some(stop => stop.stopId === 'feed-local\u001fD'),
    'Merged stores must preserve the source feed while resolving desktop IDs.')
  const opaqueStorePath = path.join(folder, 'opaque-stop-ids.sqlite')
  const opaqueStore = new DatabaseSync(opaqueStorePath)
  opaqueStore.exec('CREATE TABLE stops(stop_id TEXT PRIMARY KEY); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)')
  opaqueStore.prepare('INSERT INTO metadata VALUES(?,?)').run('sourceStores', JSON.stringify([{ scope: 'feed-local' }]))
  for (const stopId of ['station::platform', 'feed-local\u001fstation::platform']) opaqueStore.prepare('INSERT INTO stops VALUES(?)').run(stopId)
  opaqueStore.close()
  for (const stopId of ['station::platform', 'feed-local\u001fstation::platform']) {
    assert.equal(normalizeRoutingPointIdentities(opaqueStorePath, { origin: { ...selectedOrigin, stopId } }, 'feed-local').origin.stopId, stopId,
      'An exact opaque GTFS ID must survive delimiter characters without being mistaken for a desktop namespace.')
  }
  assert.equal(normalizeRoutingPointIdentities(opaqueStorePath, { origin: { ...selectedOrigin, stopId: 'feed-local::station::platform' } }, 'feed-local').origin.stopId,
    'feed-local\u001fstation::platform')

  // Arrive-by ranges name the destination and search afresh: surface reuse
  // grows depart-at surfaces only.
  const rangeSurface = { width: 48, height: 48, bounds: [7.99, 46.99, 8.02, 47.01] }
  const departRange = { stage: 'baseline-range', origin: selectedOrigin, departMinutes: 480, cutoffMinutes: 20, surface: rangeSurface }
  const arriveRange = { stage: 'baseline-range', timePreference: 'arrive', destination: selectedDestination, departMinutes: 490, cutoffMinutes: 20, surface: rangeSurface }
  assert.deepEqual([nativeReachRangeRequest(departRange).timePreference, nativeReachRangeRequest(departRange).surfaceReuse], ['depart_at', 'baseline'])
  assert.equal(nativeReachRangeRequest({ ...departRange, stage: 'scenario-range' }).surfaceReuse, 'scenario')
  for (const stage of ['baseline-range', 'scenario-range']) {
    const native = nativeReachRangeRequest({ ...arriveRange, stage })
    assert.equal(native.timePreference, 'arrive_by')
    assert.deepEqual(native.destination, { stopId: 'feed-local::D', coordinate: [8, 47.005], label: 'Imported destination', source: 'stop' })
    assert.equal(native.origin, undefined)
    assert.equal(native.surfaceReuse, undefined)
    assert.equal(native.timeMinutes, 490)
  }
  const preliminary = nativePreliminaryRequest({ timePreference: 'arrive', seeds: [{ coordinate: [8, 47.005] }], width: 48, bounds: rangeSurface.bounds }, selectedDestination, '2026-07-20', 490)
  assert.deepEqual([preliminary.timePreference, preliminary.destination, preliminary.origin], ['arrive_by', { coordinate: [8, 47.005] }, undefined])
  // A placed planned stop returns under the view's identifier; a GTFS stop at
  // the same place keeps its own name.
  const placedOverlay = { stops: [{ id: 'p', label: 'Planned P', coordinate: [8.0075, 47] }] }
  const ranged = studioReachRange({ stops: [
    { stopId: 'scenario-0123456789ab\u001fstop:0', name: 'Planned P', coordinate: [8.0075, 47], durationMinutes: 5 },
    { stopId: 'G', name: 'GTFS stop', coordinate: [8.0075, 47], durationMinutes: 7 },
  ] }, { ...arriveRange, stage: 'scenario-range', scenarioOverlay: placedOverlay })
  assert.deepEqual([ranged.stops.map(stop => stop.stopId), ranged.scenarioStops.map(stop => stop.name)], [['G'], ['Planned P']])
  assert.equal(ranged.diagnostics.transit.requestedArrivalMinutes, 490)

  await fsp.writeFile(path.join(metaRoot, 'project.json'), JSON.stringify({
    schemaVersion: 'vigo.project.v1', id: projectId, name: 'Endpoint identity fixture',
    storagePath: path.join(projectsRoot, projectId), createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z',
    summary: { feeds: 1, routes: 4, stops: 6 }, jobs: [], artifacts: [],
    feeds: [{ id: 'feed-local', name: 'Fixture', routeCount: 4, stopCount: 6, routingStore: { status: 'ready', fileName: 'fixture.sqlite' } }],
    osmStreetIndex: { status: 'ready', fileName: 'street-index.sqlite', cch: { ready: true } },
  }))
  apiRuntime = await startInMemoryVigoApi({ repositoryRoot, environment: {
    VIGO_PROJECTS_DIR: projectsRoot, VIGO_CONFIG_DIR: path.join(folder, 'config'),
  } })
  const boundaryRequest = { feedId: 'feed-local', ...selectedRequest, destination: selectedDestination }
  async function endpoint(action, body) {
    const response = await apiRuntime.requestJson(`/api/projects/${projectId}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  const apiReach = await endpoint('reach', { ...boundaryRequest, cutoffsMinutes: [20], rasterSize: 48, includePreliminary: false, includeStreetEdges: false })
  assert(apiReach.result.summary.transitStopSeeds > 0, 'Reach API must resolve imported-stop identity before dispatch.')
  const localPattern = readGtfsRouteAnalysis(storePath, 'R1', { includeTripIds: true }).routes[0]
  const replacement = { operation: 'replace', sourceRouteId: 'feed-local::R1', sourcePatternId: localPattern.patternId,
    routeScope: 'pattern', headwayMinutes: 10, startMinutes: 300, endMinutes: 1500 }
  const unchangedReach = await endpoint('reach', { ...boundaryRequest, cutoffsMinutes: [20], rasterSize: 48,
    includePreliminary: false, includeStreetEdges: false, scenario: { services: [replacement] } })
  assert.equal(unchangedReach.result.surface.raster.scenario, unchangedReach.result.surface.raster.baseline,
    'An unchanged branch replacement must preserve the actual Reach surface, including through the API hydration boundary.')
  // This hand-built fixture has no compiled A-B street transfer. Its three
  // rides reach A, then B, then X; agree with the independent stop checks above.
  for (const [maxTransfers, stopCount] of [[0, 2], [1, 3], [2, 4], [0, 2]]) {
    const capped = await endpoint('reach', { ...boundaryRequest, maxTransfers, cutoffsMinutes: [40], rasterSize: 48,
      includePreliminary: false, includeStreetEdges: false, scenario: { services: [replacement] } })
    assert.equal(capped.result.request.maxTransfers, maxTransfers)
    assert.equal(capped.result.summary.transitStopsByCutoff[0].stops, stopCount,
      'The HTTP Reach boundary must preserve the transfer cap in the baseline search.')
    assert.equal(capped.result.summary.scenarioTransitStopsByCutoff[0].stops, stopCount,
      'The same transfer cap must constrain the scenario search.')
  }
  const invalidCap = await apiRuntime.requestJson(`/api/projects/${projectId}/reach`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...boundaryRequest, maxTransfers: -1 }),
  })
  assert.equal(invalidCap.status, 400, 'An invalid Reach transfer cap must fail at the HTTP boundary.')
  for (const cutoff of [1.25, 37.25]) {
    const precise = await endpoint('reach', { ...boundaryRequest, maxTransfers: 0, maxWalkKm: 0.35, walkSpeedKph: 4.65,
      cutoffsMinutes: [cutoff], rasterSize: 48, includePreliminary: false, includeStreetEdges: false })
    assert.deepEqual(precise.result.request.cutoffsMinutes, [cutoff], 'Custom time budgets must not be rounded or expanded.')
    assert.equal(precise.result.summary.maximumCutoffMinutes, cutoff)
    assert.equal(precise.result.request.maxWalkKm, 0.35)
    assert.equal(precise.result.request.walkSpeedKph, 4.65)
    assert.equal(precise.result.request.maxTransfers, 0)
    assert.equal(precise.result.summary.transitStopsByCutoff[0].cutoffMinutes, cutoff)
  }
  const editedReplacement = { ...replacement, timeModel: 'infer-road', segmentDistancesKm: [1, 1],
    addedStopDwellMinutes: 0.35, stops: [
      { id: 'O', stopId: 'O', baselineStopIndex: 0, coordinate: [8, 47], editStatus: 'baseline' },
      { id: 'inserted', coordinate: [8.0025, 47], editStatus: 'inserted' },
      { id: 'A', stopId: 'A', baselineStopIndex: 1, coordinate: [8.005, 47], editStatus: 'baseline' },
    ] }
  const missedReach = await endpoint('reach', { ...boundaryRequest, departMinutes: 483, cutoffsMinutes: [20], rasterSize: 48,
    includePreliminary: false, includeStreetEdges: false, scenario: { services: [editedReplacement] } })
  assert.equal(missedReach.result.summary.improvedPixels, 0, 'A stop edit after the sole bus departed cannot manufacture an accessibility gain.')

  // Arrive-by Reach: where D is reached from by an 08:10 deadline. O boards
  // the 08:02 direct trip, 8 minutes before; the walk to D exceeds the limit.
  const rasterMinutes = ({ bounds: [west, south, east, north], width, height, scale, nodata, baseline }, [lon, lat]) => {
    const x = Math.floor((lon - west) / (east - west) * width), y = Math.floor((north - lat) / (north - south) * height)
    const value = Buffer.from(baseline, 'base64').readUInt16LE(2 * (y * width + x))
    return value === nodata ? null : value / scale
  }
  const { origin: _origin, ...destinationRequest } = boundaryRequest
  const arriving = { ...destinationRequest, timePreference: 'arrive', departMinutes: 490, cutoffsMinutes: [20], rasterSize: 48,
    includePreliminary: false, includeStreetEdges: false }
  const arriveReach = (await endpoint('reach', arriving)).result
  assert.equal(arriveReach.request.timePreference, 'arrive')
  assert.equal(arriveReach.request.origin, undefined)
  assert.equal(arriveReach.request.destination.stopId, 'D', 'Arrive-by Reach resolves the destination stop identity')
  assert.equal(arriveReach.summary.transitStatus.requestedArrivalMinutes, 490)
  assert.equal(arriveReach.summary.transitStatus.windowStartMinutes, 470)
  assert.match(arriveReach.summary.transitStatus.detail, /reach the destination/)
  assert(arriveReach.summary.transitStopsByCutoff[0].stops > 0)
  assert(arriveReach.diagnostics.destinationAccess && !arriveReach.diagnostics.originAccess)
  assert(arriveReach.limitations.some(limitation => limitation.code === 'single_destination_arrival_snapshot'))
  const leaveO = rasterMinutes(arriveReach.surface.raster, selectedOrigin.coordinate)
  assert(leaveO >= 8 && leaveO < 9, `Leaving O takes its 08:02 boarding, 8 minutes before the deadline, not ${leaveO}`)
  const arriveRoute = (await endpoint('national-route', { ...boundaryRequest, timePreference: 'arrive', departMinutes: 490, arriveMinutes: 490,
    maxWalkKm: 0.2, requireTransitRide: true })).choices[0]
  assert.equal(arriveRoute.departMinutes, 482, 'Arrive-by Route agrees: leave O at 08:02')
  assert.notEqual(arriveReach.surface.raster.baseline, apiReach.result.surface.raster.baseline, 'Arrive-by must not reuse the depart-at surface')

  // A planned line from a placed stop to D, on the scenario's timetable view.
  const plannedLine = { id: 'line', name: 'Planned line', operation: 'add', scheduleMode: 'frequency', bidirectional: false,
    timeModel: 'preserve-scheduled', startMinutes: 420, endMinutes: 540, headwayMinutes: 5, segmentRuntimeMinutes: [3],
    stops: [{ id: 'planned-p', label: 'Planned P', coordinate: [8.0075, 47] }, { id: 'D', stopId: 'D', label: 'Direct D', coordinate: [8, 47.005], source: 'stop' }] }
  const arriveScenario = (await endpoint('reach', { ...arriving, scenario: { id: 'line', name: 'Line', services: [plannedLine] } })).result
  assert.equal(arriveScenario.diagnostics.scenarioPropagation.settledStops, 1, 'The placed stop is a planned stop, not a GTFS stop')
  assert(arriveScenario.summary.improvedPixels > 0, 'The planned line reaches D by the deadline from new places')
  assert.deepEqual(arriveScenario.summary.transitStopsByCutoff, arriveReach.summary.transitStopsByCutoff, 'The reference search is unchanged')
  const fromP = rasterMinutes({ ...arriveScenario.surface.raster, baseline: arriveScenario.surface.raster.scenario }, [8.0075, 47])
  assert(fromP >= 5 && fromP < 6, `Leaving P catches the 08:05 planned trip, arriving 08:08, not ${fromP}`)

  const apiRoute = await endpoint('national-route', { ...boundaryRequest, requireTransitRide: true })
  assert.equal(apiRoute.choices[0].status, 'ready', 'Route API must resolve both imported-stop endpoints.')
  assert(apiRoute.choices[0].legs.some(leg => leg.type === 'ride'))
  await apiRuntime.stop()
  apiRuntime = null

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
  assert.equal(fullGeometry.surface.edges.schemaVersion, 'vigo.street.edge-bundle.v2')
  assert(
    fullGeometry.surface.edges.count >=
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
      edgeIdBytes.readUInt32LE(offset) >= edgeIdBytes.readUInt32LE(offset - 4),
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

  const scenarioOverlay = {
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
  }
  const overlay = routeNationalGtfsReach(storePath, request({ scenarioOverlay }), { streetStorePath })
  for (const origin of [request().origin, normalized.origin]) {
    for (const [maxTransfers, expected] of [
      [0, ['A', 'D']], [1, ['A', 'B', 'D']], [2, ['A', 'B', 'D', 'X']],
    ]) {
      const capped = routeNationalGtfsReach(storePath, request({ origin, scenarioOverlay, maxTransfers }), { streetStorePath })
      assert.deepEqual(capped.stops.map(stop => stop.stopId).sort(), expected,
        `A scenario ride must count toward maxTransfers=${maxTransfers} for ${origin.source} origins.`)
    }
  }
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
  assert(outsideWindow.diagnostics.timetable.departureLookupMs >= 0)

  const noService = routeNationalGtfsReach(
    storePath,
    request({ serviceDate: '2026-07-21' }),
    { streetStorePath },
  )
  assert.equal(noService.stops.length, 0)
  assert.equal(noService.diagnostics.transit.status, 'no_service')
  assert(noService.diagnostics.timetable.departureLookupMs >= 0)

  const noServiceWindow = routeNationalGtfsReach(
    storePath,
    request({ departMinutes: 1_000 }),
    { streetStorePath },
  )
  assert.equal(noServiceWindow.stops.length, 0)
  assert.equal(noServiceWindow.diagnostics.transit.status, 'no_service_window')

  const replay = routeNationalGtfsReach(storePath, request(), { streetStorePath })
  assert.deepEqual(replay.diagnostics.transit, first.diagnostics.transit,
    'Changing clocks and visiting an empty service date must preserve the original transit diagnostic.')
  assert.deepEqual(
    replay.stops,
    first.stops,
    'Generation-tagged exclusions must not leak into the next resident query.',
  )

  const terminalZip = await JSZip.loadAsync(await fsp.readFile(zipPath))
  terminalZip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nA,B,2,285\n')
  const terminalZipPath = path.join(folder, 'terminal-transfer.zip')
  await fsp.writeFile(terminalZipPath, await terminalZip.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath: terminalZipPath, outputPath: terminalStorePath })
  for (const origin of [request().origin, normalized.origin]) {
    const terminal = routeNationalGtfsReach(terminalStorePath, request({ origin, maxTransfers: 0 }), { streetStorePath })
    assert.deepEqual(terminal.stops.map(stop => stop.stopId).sort(), ['A', 'D'],
      'A transfer walk after the last ride must not become a fresh full-budget Reach seed.')
  }

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
    path.join(repositoryRoot, 'crates', 'vigo-runtime', 'vigo-routing-kernel.node'),
  )
  assert.equal(native.RegionalTopologyKernel, undefined)
  assert.equal(native.RegionalTimetableKernel, undefined)
  assert.equal(typeof native.TimetableKernel, 'function')
  assert.equal(typeof native.CoordinateKernel, 'function')

  const sourceFiles = [
    'src/server/native-routing-kernel.mjs',
    'src/server/national-route-worker.mjs',
    'src/server/reach.mjs',
    'crates/vigo-runtime/src/exact_routing.rs',
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
  await apiRuntime?.stop()
  disposeNationalGtfsStore(storePath)
  disposeNationalGtfsStore(mergedStorePath)
  disposeNationalGtfsStore(terminalStorePath)
  disposeNationalOsmStore(streetStorePath)
  await fsp.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
