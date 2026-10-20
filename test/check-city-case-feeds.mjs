import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { buildNationalGtfsStore, buildNationalGtfsCityStore, disposeNationalGtfsStore, ensureNationalGtfsOsmStopTransfers, routeNationalGtfsReach } from '../src/server/national-gtfs-store.mjs'
import { buildNationalOsmWalkStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore, prepareNationalOsmNativeStore } from '../src/server/national-osm-store.mjs'
import { cityCaseFeedIds, assertCaseRouteSources, selectedSourceScopes, scopedServiceResolution } from '../src/server/gtfs/source-selection.mjs'
import { finalizeCurrentStreetFixture } from './helpers/street-fixture.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-case-feeds-'))
const projectId = 'groups', projectsRoot = path.join(folder, 'cities')
const meta = path.join(projectsRoot, projectId, '.vigo')
const storePath = path.join(meta, 'routing', 'project.sqlite')
const streetPath = path.join(meta, 'osm', 'street-index.sqlite')
let api
const point = id => ({ coordinate: [{ A: 8, B: 8.02, C: 8.04 }[id], 47], source: 'map' })
const query = { origin: point('A'), departMinutes: 480, serviceDate: '2026-07-20', serviceDay: 'weekday',
  maxWalkKm: 0.2, cutoffMinutes: 20, surface: { bounds: [7.999, 46.999, 8.041, 47.001], width: 48, height: 48 }, streetStorePath: streetPath }
try {
  await fs.mkdir(path.dirname(storePath), { recursive: true }); await fs.mkdir(path.dirname(streetPath), { recursive: true })
  const sources = []
  for (const [id, from, to, departure, arrival] of [
    ['bus', 'A', 'B', '08:01:00', '08:05:00'],
    ['rail', 'B', 'C', '08:08:00', '08:12:00'],
    ['express', 'A', 'C', '08:01:00', '08:03:00'],
  ]) {
    const zip = new JSZip()
    zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nagency,Fixture,https://example.test,UTC\n')
    zip.file('stops.txt', `stop_id,stop_name,stop_lat,stop_lon\n${from},${from},47,${point(from).coordinate[0]}\n${to},${to},47,${point(to).coordinate[0]}\n`)
    zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,agency,R,3\n')
    zip.file('trips.txt', 'route_id,service_id,trip_id\nR,S,T\n')
    zip.file('stop_times.txt', `trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,${departure},${departure},${from},1\nT,${arrival},${arrival},${to},2\n`)
    zip.file('calendar_dates.txt', 'service_id,date,exception_type\nS,20260720,1\n')
    const source = path.join(folder, `${id}.zip`)
    await fs.writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }))
    sources.push({ scope: id, path: source })
    await buildNationalGtfsStore({ zipPath: source, outputPath: path.join(meta, 'routing', `${id}.sqlite`) })
  }
  await buildNationalGtfsCityStore({ feeds: sources, outputPath: storePath })
  const streets = new DatabaseSync(streetPath)
  streets.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL,to_node INTEGER NOT NULL,distance_m REAL NOT NULL,way_id INTEGER NOT NULL);
    CREATE INDEX edges_from ON edges(from_node); CREATE INDEX edges_to ON edges(to_node);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    INSERT INTO metadata VALUES('schemaVersion','"vigo.street.store.v6"'),('sourceModel','"pbf"');
    INSERT INTO walk_nodes VALUES(1,47,8),(2,47,8.02),(3,47,8.04);
    INSERT INTO edges VALUES(1,2,1520,1),(2,1,1520,1),(2,3,1520,2),(3,2,1520,2);`)
  finalizeCurrentStreetFixture(streets); streets.close()
  assert(buildNationalOsmWalkStore(streetPath, { force: true, persist: true }).ready)
  compactNationalOsmRuntimeStore(streetPath); disposeNationalOsmStore(streetPath)
  assert(prepareNationalOsmNativeStore(streetPath, { prepareCch: true }).ready)
  await ensureNationalGtfsOsmStopTransfers(storePath, streetPath)
  const project = { schemaVersion: 'vigo.project.v1', id: projectId, name: 'Grouped timetables',
    storagePath: path.join(projectsRoot, projectId), createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z',
    summary: { feeds: 3, routes: 3, stops: 6 }, jobs: [], artifacts: [],
    feeds: sources.map(source => ({ id: source.scope, name: source.scope, routingStore: { status: 'ready', fileName: `${source.scope}.sqlite` } })),
    routingStore: { status: 'ready', fileName: 'project.sqlite' },
    osmStreetIndex: { status: 'ready', fileName: 'street-index.sqlite', cch: { ready: true } } }
  await fs.writeFile(path.join(meta, 'project.json'), JSON.stringify(project))
  assert.deepEqual(cityCaseFeedIds(project, { feedIds: ['rail', 'bus', 'bus'] }), ['bus', 'rail'])
  for (const feedIds of [[], ['missing'], 'bus', [null]]) assert.throws(() => cityCaseFeedIds(project, { feedIds }))
  assert.throws(() => cityCaseFeedIds(project, { feedIds: ['bus'], feedId: 'express' }))
  assert.throws(() => cityCaseFeedIds({ ...project, feeds: [{ id: 'bus' }] }, { feedIds: ['bus'] }), /not ready/)
  assert.throws(() => assertCaseRouteSources({ services: [{ sourceRouteId: 'express::R' }] }, ['bus', 'rail'], true), /outside/)
  const sourceStore = { sourceScopes: ['bus', 'rail', 'express'] }
  assert.throws(() => selectedSourceScopes(sourceStore, { sourceScopes: ['other'] }))
  const resolution = scopedServiceResolution(sourceStore, { services: new Set(['bus\u001fS', 'rail\u001fS']), availableServiceScopeCount: 3 }, { sourceScopes: ['bus', 'rail'] })
  assert.equal(resolution.availableServiceScopeCount, 2); assert.equal(resolution.resolvedServiceScopeCount, 2)
  const snapshots = async () => (await fs.readdir(path.dirname(storePath))).filter(name => name.includes('.active-service-kernel.')).sort()
  const before = await snapshots()
  for (const sourceScopes of [['bus', 'rail'], ['bus'], ['rail'], ['bus', 'rail']]) {
    const result = routeNationalGtfsReach(storePath, { ...query, sourceScopes })
    const reachedC = result.stops.filter(stop => stop.stopId.endsWith('\u001fC'))
    if (sourceScopes.length === 2) {
      assert(reachedC.length, `Selected feeds must transfer within one query: ${JSON.stringify({stops:result.stops,diagnostics:result.diagnostics})}`)
      assert(reachedC.every(stop => stop.durationMinutes >= 12), 'Excluded express service leaked into the group.')
      assert(reachedC.some(stop => Math.abs(stop.durationMinutes - 12) < .01), 'Bus to rail transfer did not match the timetable.')
    } else assert.equal(reachedC.length, 0, 'A case borrowed a connection from an unselected timetable.')
  }
  assert.deepEqual(await snapshots(), before, 'Groups must not write a new persistent timetable copy.')
  api = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'), environment: {
    VIGO_PROJECTS_DIR: projectsRoot, VIGO_CONFIG_DIR: path.join(folder, 'config'),
  } })
  const send = (feedIds, extra = {}) => api.requestJson(`/api/projects/${projectId}/reach`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...query,
      feedIds, rasterSize: 48, cutoffsMinutes: [10, 20], includePreliminary: false, includeStreetEdges: false, ...extra }),
  })
  for (const feeds of [['bus', 'rail'], ['express'], ['bus', 'rail']]) {
    const response = await send(feeds)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(response.body.result.request.feedIds, [...feeds].sort(), 'Result omitted its timetable inputs.')
    assert.equal(response.body.result.diagnostics.reach.timetable.residentTrips, feeds.length, 'API did not carry group membership into the native query.')
  }
  for (const feedIds of [['bus', 'rail'], ['bus']]) {
    const ranked = await api.requestJson(`/api/projects/${projectId}/national-route`, {
      method: 'POST', body: { ...query, feedIds, destination: point('C'), allowLongWalk: false,
        routingDataMode: 'scheduled', departureWindowMinutes: 10, includeRankedAlternatives: true },
    })
    assert.equal(ranked.status, 200, JSON.stringify(ranked.body))
    for (const plan of ranked.body.choices) {
      if (feedIds.length === 1) assert.equal(plan.status, 'blocked', 'Ranked alternatives cannot borrow unselected rail service')
      for (const leg of plan.legs) assert.notEqual(leg.routeId, 'express::R', 'Ranked alternatives must respect selected networks')
    }
  }
  const changed = await send(['bus', 'rail'], { scenario: { excludedRouteIds: ['rail::R'] } })
  const pointRoute = feedIds => api.requestJson(`/api/projects/${projectId}/national-route`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...query,
      feedIds, destination: point('C'), allowLongWalk: false, routingDataMode: 'scheduled', departureWindowMinutes: 0 }),
  })
  for (const feedIds of [['bus', 'rail'], ['express'], ['bus'], ['bus', 'rail']]) {
    const response = await pointRoute(feedIds)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const plan = response.body.choices[0]
    if (feedIds.length === 2) {
      assert.equal(plan.status, 'ready', JSON.stringify(plan))
      assert(Math.abs(plan.arriveMinutes - 492) < .01, 'Point inspection borrowed an unselected express trip.')
    } else if (feedIds[0] === 'bus') assert.equal(plan.status, 'blocked', 'Point routing crossed into an unselected rail feed.')
    else {
      assert.equal(plan.status, 'ready')
      assert(plan.arriveMinutes < 492, 'Selected express trip was not used.')
    }
  }
  assert.equal((await pointRoute([])).status, 400)
  assert.equal((await pointRoute(['missing'])).status, 400)
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.equal(changed.body.result.diagnostics.scenarioReach.timetable.residentTrips, 2)
  assert.equal(changed.body.result.diagnostics.scenarioReach.search.excludedTrips, 1)
  assert.equal((await send([])).status, 400)
  assert.equal((await send(['missing'])).status, 400)
  assert.equal((await send(['bus'], { scenario: { services: [{ sourceRouteId: 'express::R' }] } })).status, 400)
  const grid = await send(['bus', 'rail'], { surfaceSampling: 'cell-center' })
  assert.equal(grid.status, 200, JSON.stringify(grid.body))
  assert.equal(grid.body.result.diagnostics.reach.timetable.residentTrips, 2, 'Cell-center analysis ignored the feed selection.')

  // Point-to-point routing on a scenario: a planned line from B to C over new
  // stops completes a bus-only group's trip; removing a route blocks it.
  const plannedLine = { id: 'planned', name: 'Planned link', services: [{ id: 'link', name: 'B–C link', operation: 'add', headwayMinutes: 5,
    startMinutes: 480, endMinutes: 540, averageSpeedKph: 30, bidirectional: false,
    stops: [{ id: 'b', label: 'Planned B', coordinate: [8.02, 47], source: 'map' }, { id: 'c', label: 'Planned C', coordinate: [8.04, 47], source: 'map' }] }] }
  // The API's reference and scenario ranges share the same resident street
  // kernel, including station-egress resolution before the monotonicity check.
  const referenceSurface = await send(['bus'], { rasterSize: 64 })
  assert.equal(referenceSurface.status, 200, JSON.stringify(referenceSurface.body))
  const addedSurface = await send(['bus'], { rasterSize: 64, scenario: plannedLine })
  assert.equal(addedSurface.status, 200, JSON.stringify(addedSurface.body))
  assert(addedSurface.body.result.diagnostics.scenarioReach.surface.reusedLabels > 0,
    'Studio must reach the incremental Rust surface through its worker.')
  const cutSurface = await send(['bus'], { rasterSize: 64, scenario: { excludedRouteIds: ['bus::R'] } })
  assert.equal(cutSurface.status, 200, JSON.stringify(cutSurface.body))
  assert.equal(cutSurface.body.result.diagnostics.scenarioReach.surface.reusedLabels, 0,
    'A service cut must not reuse labels pruned by removed service.')
  const scenarioRoute = (feedIds, scenario) => api.requestJson(`/api/projects/${projectId}/national-route`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...query,
      feedIds, destination: point('C'), allowLongWalk: false, routingDataMode: 'realtime', departureWindowMinutes: 0, scenario }),
  })
  const planned = await scenarioRoute(['bus'], plannedLine)
  assert.equal(planned.status, 200, JSON.stringify(planned.body))
  const plannedPlan = planned.body.choices[0]
  assert.equal(plannedPlan.status, 'ready', `A planned line must make the bus-only trip routable: ${JSON.stringify(plannedPlan).slice(0, 600)}`)
  const plannedRide = plannedPlan.legs.find(leg => leg.scenarioService)
  assert(plannedRide, 'The journey must ride the planned service.')
  assert.equal(plannedRide.routeShortName, 'B–C link', 'Planned rides carry the service name.')
  assert.equal(plannedRide.fromName, 'Planned B')
  assert(plannedPlan.legs.some(leg => leg.type === 'ride' && !leg.scenarioService), 'Scheduled and planned service combine in one journey.')
  assert.equal((await pointRoute(['bus'])).body.choices[0].status, 'blocked', 'A scenario never leaks into routes without it.')
  const removed = await scenarioRoute(['bus', 'rail'], { id: 'cut', name: 'Cut', excludedRouteIds: ['rail::R'] })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  assert.equal(removed.body.choices[0].status, 'blocked', 'A removed route must not carry scenario journeys.')

  // Reach on a remix compares the scenario's timetables with the baseline group.
  const remix = await send(['express'], { baselineFeedIds: ['bus', 'rail'] })
  assert.equal(remix.status, 200, JSON.stringify(remix.body))
  assert.equal(remix.body.result.diagnostics.reachDispatches, 2, 'A remix runs its own scenario range.')
  assert.equal(remix.body.result.diagnostics.reach.timetable.residentTrips, 2, 'The remix baseline uses the baseline group.')
  assert.equal(remix.body.result.diagnostics.scenarioReach.timetable.residentTrips, 1, 'The remix scenario uses its own group.')
  // The baseline range is reused, and Studio's compact payload derives outlines from the fills.
  const first = await send(['bus', 'rail'], { payload: 'compact' })
  const second = await send(['bus', 'rail'], { payload: 'compact' })
  assert.equal(second.body.result.diagnostics.reach.totalMs, first.body.result.diagnostics.reach.totalMs, 'A repeated baseline must reuse its range.')
  assert.equal(second.body.result.surface.contours, undefined)
  assert.equal(second.body.result.surface.compact.scenario, 'baseline')
  assert.equal(second.body.result.surface.raster.scenario, undefined, 'An unchanged scenario is not sent twice.')

  // Saved scenarios live in the City folder, and a stale window cannot overwrite them.
  const library = { groups: [{ id: 'baseline', name: 'Baseline', feedIds: ['bus', 'rail'] }],
    scenarios: [{ id: 'case-a', name: 'Planned link', groupId: 'baseline', changes: [] }] }
  assert.deepEqual((await api.requestJson(`/api/projects/${projectId}/scenarios`)).body, { library: null, revision: 0 })
  const saveLibrary = baseRevision => api.requestJson(`/api/projects/${projectId}/scenarios`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision, library }),
  })
  assert.equal((await saveLibrary(0)).status, 200)
  assert.equal((await api.requestJson(`/api/projects/${projectId}/scenarios`)).body.library.scenarios[0].name, 'Planned link')
  const stale = await saveLibrary(0)
  assert.equal(stale.status, 409, 'A stale save must be rejected.')
  assert.equal(stale.body.revision, 1)
  assert(JSON.parse(await fs.readFile(path.join(meta, 'scenarios.json'), 'utf8')).scenarios.length === 1)
  console.log('City case groups: exact feed selection, cross-feed transfers, baseline and scenario, grid sampling, switching, input validation, and no per-group timetable files passed.')
  console.log('Scenarios: planned lines and removals in point-to-point routing, remix Reach, baseline reuse, compact payloads, and saved libraries passed.')
} finally {
  if (api) await api.stop()
  disposeNationalGtfsStore(storePath); disposeNationalOsmStore(streetPath)
  await fs.rm(folder, { recursive: true, force: true })
}
