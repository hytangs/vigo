import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importTestModules } from './helpers/import-test-modules.mjs'
import { readGtfsRouteAnalysis } from '../src/server/gtfs-analysis-store.mjs'
import { hydrateScenarioRouteServices } from '../src/server/scenario-services.mjs'
import { compileReachScenario } from '../src/server/reach.mjs'

const [{ orderedPolylineAnchors }, reach] = await importTestModules('app/geometry.ts', 'reach.ts')
assert.deepEqual(orderedPolylineAnchors([[0, 0], [0.01, 0]], [[0, 0], [0.01, 0], [0.01, 0]])
  .map((anchor) => anchor.progress), [0, 1, 1], 'Repeated terminal visits can retain the same shape measure.')
assert.deepEqual(orderedPolylineAnchors([[0, 0], [0.01, 0]], [[0.006, 0], [0.005, 0]])
  .map((anchor) => anchor.progress), [0.6, 0.6], 'A projection behind the previous stop clamps to the current measure.')
const {
  scenarioStopsForRoute, scenarioBaselineStopIndexes, scenarioInsertionAnchors,
  scenarioInsertedStopsForEdge, scenarioEdgeEditError, scenarioStopsForEdgeBranch,
  scenarioEdgeGeometryForBranch, scenarioPublishedShapeSegmentIndexes, scenarioSegmentRuntimeMinutes,
} = reach
const coordinates = { A: [0, 0], B: [0.01, 0], C: [0.02, 0.01], D: [0.02, -0.01] }
const route = { id: 'loop', stopIds: ['A', 'B', 'C', 'A', 'B', 'D'], geometrySource: 'shape', scheduledSpeedKph: 25,
  coordinates: ['A', 'B', 'C', 'A', 'B', 'D'].map((id) => coordinates[id]) }
const preview = { stops: Object.entries(coordinates).map(([id, [lon, lat]]) => ({ id, name: id, lon, lat })),
  stopPairs: [1, 2, 3, 10, 5].map((medianRuntimeMinutes, index) => ({ patternId: route.id,
    fromStopId: route.stopIds[index], toStopId: route.stopIds[index + 1], sequence: index + 1, medianRuntimeMinutes })) }
const baseline = scenarioStopsForRoute(route, preview)
const patternService = { operation: 'replace', sourceRouteId: 'R', sourcePatternId: 'loop', stops: baseline }
assert.equal(compileReachScenario({ services: [patternService] }).overlay.directionOffsets.length, 2,
  'A selected-pattern replacement defaults to its existing direction, without inventing reverse service.')
assert.equal(compileReachScenario({ services: [{ ...patternService, bidirectional: true }] }).overlay.directionOffsets.length, 3,
  'An explicit reverse-service request remains supported.')
assert.deepEqual(scenarioBaselineStopIndexes(route, baseline), [0, 1, 2, 3, 4, 5])
assert.deepEqual(scenarioBaselineStopIndexes(route, baseline.slice(3).map(({ baselineStopIndex, ...stop }) => stop)), [3, 4, 5],
  'Saved drafts with stable occurrence IDs retain the later visit even without the new index field.')
assert.deepEqual(scenarioSegmentRuntimeMinutes(route, baseline, preview), [1, 2, 3, 10, 5],
  'Repeated A → B edges retain their distinct published segment runtimes.')
assert.deepEqual(scenarioPublishedShapeSegmentIndexes(route, baseline), [0, 1, 2, 3, 4])
assert.deepEqual(scenarioStopsForRoute(route, { ...preview, stops: preview.stops.filter((stop) => stop.id !== 'C') }), [],
  'Missing preview stops must not silently shorten the GTFS branch.')
assert.equal(scenarioSegmentRuntimeMinutes(route, baseline, { ...preview,
  stopPairs: preview.stopPairs.map((pair, index) => index ? pair : { ...pair, medianRuntimeMinutes: 0 }) })[0], 0,
  'A published zero runtime is data, not a missing-runtime fallback.')

const inserted = { id: 'new', stopId: 'C', label: 'Inserted', coordinate: [0.005, 0.005], source: 'route',
  editStatus: 'inserted', anchorBeforeStopId: 'A', anchorAfterStopId: 'B', anchorBeforeStopIndex: 3, anchorAfterStopIndex: 4 }
const editedStops = [...baseline.slice(0, 4), inserted, ...baseline.slice(4)]
assert.deepEqual(scenarioInsertionAnchors(baseline[3], inserted),
  { beforeStopId: 'A', afterStopId: 'B', beforeStopIndex: 3, afterStopIndex: 4 })
assert.equal(scenarioEdgeEditError(route, editedStops), undefined)
assert.match(scenarioEdgeEditError(route, editedStops.filter((stop) => stop.id !== baseline[2].id)), /complete original branch/)
assert.match(scenarioEdgeEditError(route, [...editedStops.slice(0, 2), { ...inserted, id: 'other-gap',
  anchorBeforeStopId: 'B', anchorAfterStopId: 'C' }, ...editedStops.slice(2)]), /one A → B gap/)
assert.equal(scenarioInsertedStopsForEdge(editedStops.map((stop, index) => index ? stop : { ...stop, editStatus: 'replaced' })), undefined)
const change = { id: 'edit', stops: editedStops,
  inferredSegmentGeometry: editedStops.slice(1).map((stop, index) => [editedStops[index].coordinate, stop.coordinate]),
  inferredSegmentDistanceKm: [1, 2, 3, 1, 3, 5] }
const expanded = scenarioStopsForEdgeBranch(change, route, preview)
assert.deepEqual(expanded.map((stop) => stop.editStatus === 'inserted' ? 'I' : stop.stopId), ['A', 'I', 'B', 'C', 'A', 'I', 'B', 'D'])
assert.equal(new Set(expanded.map((stop) => stop.id)).size, expanded.length)
assert(expanded.filter((stop) => stop.editStatus === 'inserted').every((stop) => stop.stopId === 'C'),
  'An insertion at an existing GTFS stop keeps its real stop identity in every branch.')
const geometry = scenarioEdgeGeometryForBranch(change, route, preview)
assert(geometry)
assert.equal(geometry.geometry.filter(([lon, lat]) => lon === inserted.coordinate[0] && lat === inserted.coordinate[1]).length, 2,
  'Both visits to the edited directed edge receive the detour geometry.')
assert.deepEqual(scenarioSegmentRuntimeMinutes(route, expanded, preview, { segmentDistancesKm: geometry.segmentDistancesKm }),
  [0.25, 0.75, 2, 3, 2.5, 7.5, 5], 'Each repeated occurrence preserves its own runtime when split across inserted stops.')
const reverse = { ...route, id: 'reverse', stopIds: ['B', 'A'], coordinates: [coordinates.B, coordinates.A] }
assert.equal(scenarioEdgeGeometryForBranch(change, reverse, preview), undefined, 'B → A is not the edited A → B edge.')
assert.equal(scenarioEdgeGeometryForBranch({ ...change, inferredSegmentDistanceKm: [1, 2, 3, NaN, 3, 5] }, route, preview), undefined)
for (const offset of [-0.0001, 0.0001]) {
  const offshapePreview = { ...preview, stops: preview.stops.map((stop) => stop.id === 'A' ? { ...stop, lat: offset } : stop) }
  const offshapeBaseline = scenarioStopsForRoute(route, offshapePreview)
  const anchors = orderedPolylineAnchors(route.coordinates, offshapeBaseline.map((stop) => stop.coordinate))
  assert(anchors[0].progress < 1 && anchors[3].progress >= 2 && anchors[3].progress < 4,
    'An off-shape stop must align to its proper loop occurrence using the complete ordered sequence.')
  const offshapeStops = [...offshapeBaseline.slice(0, 4), inserted, ...offshapeBaseline.slice(4)]
  const offshapeChange = { ...change, stops: offshapeStops,
    inferredSegmentGeometry: offshapeStops.slice(1).map((stop, index) => [offshapeStops[index].coordinate, stop.coordinate]) }
  assert(scenarioEdgeGeometryForBranch(offshapeChange, route, offshapePreview),
    'An 11-meter stop-to-shape offset must not make a valid repeated-edge edit fail.')
}
const throughExistingStop = editedStops.map((stop) => stop.editStatus === 'inserted' ? { ...stop, coordinate: coordinates.C } : stop)
const crossing = scenarioEdgeGeometryForBranch({ ...change, stops: throughExistingStop,
  inferredSegmentGeometry: throughExistingStop.slice(1).map((stop, index) => [throughExistingStop[index].coordinate, stop.coordinate]) }, route, preview)
assert.deepEqual(crossing.geometry, ['A', 'C', 'B', 'C', 'A', 'C', 'B', 'D'].map((id) => coordinates[id]),
  'All detours use the original branch alignment; a detour passing an existing stop cannot move another edited interval.')

const directory = mkdtempSync(join(tmpdir(), 'vigo-scenario-branches-'))
try {
  const storePath = join(directory, 'fixture.sqlite')
  const db = new DatabaseSync(storePath)
  db.exec(`
    CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT);
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, direction_id TEXT);
    CREATE INDEX trips_route ON trips(route_id, trip_id);
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER, platform_code TEXT);
    CREATE TABLE connections(departure INTEGER, arrival INTEGER, trip_id TEXT, route_id TEXT, service_id TEXT, direction_id TEXT,
      from_stop_id TEXT, to_stop_id TEXT, stop_sequence INTEGER, PRIMARY KEY(trip_id, stop_sequence));
    CREATE TABLE trip_shapes(trip_id TEXT PRIMARY KEY, shape_id TEXT);
    CREATE TABLE shape_points(shape_id TEXT, sequence INTEGER, lat REAL, lon REAL, PRIMARY KEY(shape_id, sequence));
  `)
  for (const [id, [lon, lat]] of Object.entries(coordinates)) db.prepare('INSERT INTO stops VALUES(?,?,?,?,NULL,0,NULL)').run(id, id, lat, lon)
  for (const [id, [lon, lat]] of Object.entries(coordinates)) db.prepare('INSERT INTO stops VALUES(?,?,?,?,NULL,0,NULL)').run(`feed-a\u001f${id}`, id, lat, lon)
  const addTrip = (routeId, tripId, direction, stopIds) => {
    db.prepare('INSERT OR IGNORE INTO routes VALUES(?,?,?,3,?)').run(routeId, routeId, routeId, '336699')
    db.prepare('INSERT INTO trips VALUES(?,?,?,?)').run(tripId, routeId, 'WKD', direction)
    stopIds.slice(1).forEach((stopId, index) => db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
      .run(28800 + index * 600, 29100 + index * 600, tripId, routeId, 'WKD', direction, stopIds[index], stopId, index + 1))
  }
  addTrip('R', 'forward', '0', ['A', 'B', 'C'])
  addTrip('R', 'backward', '1', ['C', 'B', 'A'])
  addTrip('feed-a\u001fR', 'feed-a\u001ftrip', '0', ['A', 'B', 'C'].map((id) => `feed-a\u001f${id}`))
  addTrip('feed-a\u001fR', 'feed-a\u001freverse', '1', ['C', 'B', 'A'].map((id) => `feed-a\u001f${id}`))
  addTrip('feed-b\u001fR', 'feed-b\u001ftrip', '0', ['A', 'B'])
  db.close()
  const analysis = readGtfsRouteAnalysis(storePath, 'R', { includeTripIds: true })
  const forward = analysis.routes.find((branch) => branch.directionId === '0')
  const backward = analysis.routes.find((branch) => branch.directionId === '1')
  const replacement = { id: 'replace-forward', operation: 'replace', sourceRouteId: 'feed-local::R',
    sourcePatternId: `feed-local::${forward.patternId}`, routeScope: 'pattern' }
  const hydrated = hydrateScenarioRouteServices(storePath, { storageGeneration: 'fixture' }, { scenario: { services: [replacement] } })
  assert.deepEqual(hydrated.scenario.excludedTripIds, ['forward'])
  assert.deepEqual(hydrated.scenario.excludedRouteIds, [])
  assert.deepEqual(hydrated.scenario.services[0].stops.map((stop) => stop.stopId), ['A', 'B', 'C'],
    'UI feed-scoped references fall back safely to an unscoped feed store.')
  assert.deepEqual(hydrated.scenario.services[0].stops.map((stop) => stop.baselineStopIndex), [0, 1, 2])
  assert.deepEqual(hydrateScenarioRouteServices(storePath, {}, { scenario: { services: [],
    excludedPatternIds: [{ routeId: 'R', patternId: backward.patternId }] } }).scenario.excludedTripIds, ['backward'])
  assert.throws(() => hydrateScenarioRouteServices(storePath, {}, { scenario: { services: [replacement, { ...replacement, id: 'duplicate' }] } }),
    /Conflicting replacement/)
  assert.throws(() => hydrateScenarioRouteServices(storePath, {}, { scenario: { services: [{ ...replacement, stops: baseline,
    sourcePatternId: 'missing', geometry: route.coordinates }] } }), /Unable to resolve the selected GTFS branch/)
  const scoped = hydrateScenarioRouteServices(storePath, {}, { scenario: { services: [{ operation: 'replace',
    sourceRouteId: 'feed-b::R', sourcePatternId: 'feed-b::R', routeScope: 'pattern' }] } })
  assert.deepEqual(scoped.scenario.excludedTripIds, ['feed-b\u001ftrip'], 'Same local route IDs from other feeds must remain untouched.')
  const mergedAnalysis = readGtfsRouteAnalysis(storePath, 'feed-a\u001fR', { includeTripIds: true })
  const mergedSecondary = mergedAnalysis.routes.find((branch) => branch.directionId === '1')
  assert.equal(mergedSecondary.patternId.replace('feed-a\u001f', ''), backward.patternId,
    'Secondary pattern identities must survive raw-feed versus merged-store scoping.')
  const rawStorePath = join(directory, 'raw-feed.sqlite')
  copyFileSync(storePath, rawStorePath)
  const rawDb = new DatabaseSync(rawStorePath)
  for (const table of ['connections', 'trips', 'routes']) rawDb.exec(`DELETE FROM ${table} WHERE INSTR(route_id, CHAR(31)) > 0`)
  rawDb.close()
  const crossStore = hydrateScenarioRouteServices(rawStorePath, {}, { scenario: { services: [{ operation: 'replace',
    sourceRouteId: 'feed-a::R', sourcePatternId: mergedSecondary.patternId.replace('\u001f', '::'), routeScope: 'pattern' }] } })
  assert.deepEqual(crossStore.scenario.excludedTripIds, ['backward'],
    'A secondary branch selected from merged analysis must hydrate against its own raw feed store.')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
console.log('Scenario branches retain occurrence order, repeated-edge geometry and timing, complete patterns, and exact feed/trip exclusions.')
