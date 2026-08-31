import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const filesUnder = (relativeDirectory, predicate = () => true) => {
  const directory = path.join(root, relativeDirectory)
  if (!fs.existsSync(directory)) return []
  const files = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (predicate(child)) files.push(child)
    }
  }
  visit(directory)
  return files
}

const osm = read('server/national-osm-store.mjs')
const gtfs = read('server/national-gtfs-store.mjs')
const native = read('server/native-routing-kernel.mjs')
const scenario = read('server/scenario-analysis.mjs')
const exactRust = read('native/vigo-routing-kernel/src/exact_routing.rs')
const coreRust = read('native/vigo-routing-kernel/src/lib.rs')
const streetAnalysisRust = read('native/vigo-routing-kernel/src/street_analysis.rs')
const timetableRust = read('native/vigo-routing-kernel/src/timetable.rs')
const worker = read('server/national-route-worker.mjs')
const api = read('server/vigo-api.mjs')
const cli = read('scripts/vigo-cli.ts')
const domain = read('src/domain.ts')

for (const removed of [
  'streetDistancesToCandidates',
  'streetPathCoordinates',
  'standaloneWalkPathBetween',
  'acceleratedStreetPathBetween',
  'legacyStreetStoreSchemaVersion',
]) {
  assert(!osm.includes(removed), `Removed JavaScript pedestrian symbol returned: ${removed}`)
}

for (const removed of [
  'NumericDistanceQueue',
  'acceleratedDrivePathBetween',
  'heuristicSeconds',
  'beginAcceleratedSearch',
  'osm_profile_astar',
]) {
  assert(!osm.includes(removed), `Removed JavaScript drive-routing symbol returned: ${removed}`)
}
for (const removed of [
  'nextTripStart',
  'maximumRounds',
  'while (changed',
  'propagateScenario',
]) {
  assert(!scenario.includes(removed), `Removed JavaScript scenario-routing symbol returned: ${removed}`)
}

assert.match(
  osm,
  /export function streetPathBetween[\s\S]*nativeStreetCchPrepared[\s\S]*routeNativeStreetPath/,
  'Point-to-point pedestrian routing must call only the prepared Rust street CCH.',
)
assert(!gtfs.includes('streetDistancesToCandidates'), 'Transit access must not call the removed JavaScript/SQLite candidate router.')
assert(!gtfs.includes('streetPathCoordinates'), 'Transit geometry must not call the removed JavaScript/SQLite materializer.')
for (const removed of [
  'prepareTransferLinkedAccessEvidence',
  'transferLinkedStreetAccess',
  'expandResolvedStationAccess',
  'nativeRoleAccessCandidates',
  'retainBestAccessCandidates',
  'exactCoordinateAccessCandidates',
]) {
  assert(!gtfs.includes(removed), `Removed JavaScript access-routing symbol returned: ${removed}`)
}
assert(gtfs.includes('routeNativeCoordinateFrontiers'), 'Coordinate transit access must use the fused Rust one-to-many frontier.')
assert(worker.includes('prepareNationalOsmNativeStore'), 'The production worker must prepare Rust pedestrian routing.')
assert(!worker.includes('prepareNationalOsmStore,'), 'The production worker must not hydrate the JavaScript pedestrian graph.')
assert(!worker.includes("from './national-gtfs-store.mjs'"), 'The route worker must not eagerly load the GTFS backend for a walk.')
assert(worker.includes("import('./national-gtfs-store.mjs')"), 'The single route worker must load the GTFS backend only for transit operations.')
assert(worker.includes("import('./national-osm-store.mjs')"), 'The single route worker must load the OSM/Rust adapter only for street operations.')
assert(cli.includes('prepareNationalOsmNativeStore'), 'The CLI must prepare the same Rust pedestrian kernel.')
assert(!cli.includes('prepareNationalOsmStore'), 'The CLI must not use the construction-only JavaScript snapshot builder.')
assert(native.includes('routeEndpoints'), 'The thin Node adapter must retain the fused endpoint call.')
assert(native.includes('rust_exact_station_transfer_frontier_v1'), 'The Node adapter must expose Rust-only station and linked-transfer reduction.')
assert(
  coreRust.includes('reduce_access_frontier'),
  'Rust must own the exact final transit-stop access frontier.',
)
assert(native.includes('street-accelerator-v7.bin'), 'Production Rust routing must require the current v7 snapshot.')
assert(native.includes('routeNativeDriveExact'), 'Drive requests must enter the exact Rust drive kernel.')
assert(native.includes('routeNativeWalkMatrix'), 'Walk matrices must enter the Rust coordinate matrix kernel.')
assert(native.includes('routeNativeDriveMatrix'), 'Drive matrices must enter the Rust time matrix kernel.')
assert(osm.includes('routeNationalStreetMatrix'), 'Walk and Drive matrices must have one canonical street-matrix owner.')
assert(worker.includes("operation === 'street-matrix'"), 'The unified route worker must expose the street matrix operation.')
assert(api.includes("action === 'national-street-matrix'"), 'The local API must expose the canonical street matrix operation.')
assert(native.includes('routeNativeCoordinateTimetableMany'), 'Accessibility must enter the fused resident Rust one-to-many boundary.')
assert(gtfs.includes('routeNationalGtfsAccessibilityRange'), 'Accessibility must use the canonical national routing owner.')
assert(worker.includes("operation === 'accessibility-range'"), 'The production worker must expose only the unified Accessibility range operation.')
assert(!worker.includes("operation === 'street-connectors'"), 'Scenario connectors must stay inside the unified Accessibility operation.')
assert(native.includes('routeNativeTimetableOverlayMany'), 'Scenario services must enter the resident Rust timetable scan.')
assert(gtfs.includes('scenarioOverlay'), 'Accessibility must own query-scoped scenario compilation and connectors.')
for (const required of [
  'run_cch_coordinate_distances',
  'run_cch_coordinate_distance_matrix',
  'aggregate_cch_accelerated',
  'matrix_cch_accelerated',
]) {
  assert(coreRust.includes(required), `Accessibility CCH ownership is missing: ${required}`)
}
assert(
  streetAnalysisRust.includes('remaining_walk_m')
    && streetAnalysisRust.includes('BinaryHeap<LabelQueueEntry>'),
  'The exact multi-seed timed-budget connector fallback must retain its two-resource dominance operator.',
)
for (const required of [
  'pub struct DriveKernel',
  'pub struct DriveMatrixInput',
  'pub fn route_matrix(',
  'rust_cch_drive_time_matrix_v1',
  'rust_cch_time_distance_certified',
  'rust_cch_candidate_exact_resource_constrained_fallback',
  'cch_time_metric_path',
  'cch_distance_metric_path',
]) {
  assert(exactRust.includes(required), `The Rust routing ownership contract is missing: ${required}`)
}
for (const required of [
  'pub struct StreetMatrixInput',
  'pub fn route_street_matrix(',
  'rust_cch_coordinate_distance_matrix_v1',
]) {
  assert(coreRust.includes(required), `The Rust street matrix ownership contract is missing: ${required}`)
}
for (const required of [
  'pub struct TimetableKernel',
  'pub fn route_many_csa(',
  'excluded_trip_generation',
  'rust_resident_generation_tagged_connection_scan_one_to_many',
  'pub fn route_overlay_many_csa(',
  'rust_resident_query_overlay_connection_scan_one_to_many',
]) {
  assert(timetableRust.includes(required), `The resident timetable ownership contract is missing: ${required}`)
}
for (const removed of [
  'RegionalTopologyKernel',
  'RegionalTimetableKernel',
  'rust_exact_regional_label_setting',
  'route_scenario_exact',
  'rust_exact_fifo_scenario_dijkstra',
  'rust_exact_bidirectional_time_dijkstra_distance_certified',
  'rust_exact_resource_constrained_dijkstra',
]) {
  assert(!exactRust.includes(removed), `Former Rust range kernel returned: ${removed}`)
  assert(!native.includes(removed), `Former native adapter returned: ${removed}`)
}
assert(!fs.existsSync(path.join(root, 'server', 'regional-analysis-kernel.mjs')))
assert(!native.includes('street-accelerator-v3.bin'), 'Production Rust routing must not admit the removed v3 snapshot.')
for (const persistedReverseArray of [
  'reverseOffsets',
  'reverseSources',
  'reverseEdgeIndices',
]) {
  assert(osm.includes(persistedReverseArray), `The v7 snapshot must persist ${persistedReverseArray}.`)
}
assert(!coreRust.includes('ReverseGraph::build'), 'Rust workers must not rebuild reverse adjacency.')
const pointPathSource = coreRust.slice(
  coreRust.indexOf('fn run_point_path('),
  coreRust.indexOf('fn street_path_result('),
)
assert(
  pointPathSource.includes('point_queue.push(PointHeapEntry')
    && coreRust.includes('other\n            .priority_m\n            .total_cmp(&self.priority_m)'),
  'Rust point routing must order its exact A-star queue by certified priority.',
)
assert(
  pointPathSource.includes('PointPathMetricCertificate::new')
    && pointPathSource.includes('certificate.lower_bound_m(')
    && pointPathSource.includes('current.priority_m > best.distance_m.min(maximum_distance_m)')
    && pointPathSource.includes('priority > best.distance_m.min(maximum_distance_m)'),
  'Rust point routing must use the admissible metric certificate and exact incumbent bound.',
)
assert(!coreRust.includes('VIGO_DISABLE_POINT_PATH_ASTAR'), 'Production point routing must not retain the retired differential switch.')
assert(!coreRust.includes('fn run_point_path_bidirectional('), 'The retired point-path differential implementation must stay removed.')
assert(!exactRust.toLowerCase().includes('astar'), 'Native routing kernels must remain heuristic-free.')
assert.match(
  api,
  /mode !== 'transit'[\s\S]*nationalRouteWorkerPool\.dispatch\(\s*streetPath,\s*'street-route'/,
  'Standalone Walk and Drive must use a street-keyed worker instead of waiting behind GTFS prewarm.',
)
assert(!domain.includes('vigo.street.store.v1'), 'The public project model must reject the removed legacy street schema.')

const heapOwners = filesUnder(
  'native/vigo-routing-kernel/src',
  (filePath) => filePath.endsWith('.rs') && fs.readFileSync(filePath, 'utf8').includes('BinaryHeap'),
).map((filePath) => path.relative(root, filePath)).sort()
assert.deepEqual(heapOwners, [
  'native/vigo-routing-kernel/src/exact_routing.rs',
  'native/vigo-routing-kernel/src/lib.rs',
  'native/vigo-routing-kernel/src/street_analysis.rs',
])

const forbiddenRuntimeTokens = [
  'RegionalTopologyKernel',
  'RegionalTimetableKernel',
  'rust_exact_regional_label_setting',
  'rust_exact_fifo_scenario_dijkstra',
  'rust_exact_bidirectional_time_dijkstra_distance_certified',
  'rust_exact_resource_constrained_dijkstra',
  'no_baseline_transit_after_scenario',
  "operation === 'street-connectors'",
]
const productionJavaScript = filesUnder(
  'server',
  (filePath) => /\.(?:mjs|js)$/u.test(filePath),
).map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')])
for (const [filePath, source] of productionJavaScript) {
  for (const token of forbiddenRuntimeTokens) {
    assert(!source.includes(token), `Former runtime token returned in ${path.relative(root, filePath)}: ${token}`)
  }
  assert(
    !/\b(?:Dijkstra|PriorityQueue|MinHeap|MaxHeap)\b/u.test(source),
    `A JavaScript routing heap/search returned in ${path.relative(root, filePath)}.`,
  )
}

const packagedServerFiles = filesUnder(
  'release/VIGO-mac-arm64/VIGO.app/Contents/Resources/server',
  (filePath) => /\.(?:mjs|js)$/u.test(filePath),
)
for (const filePath of packagedServerFiles) {
  const source = fs.readFileSync(filePath, 'utf8')
  for (const token of forbiddenRuntimeTokens) {
    assert(!source.includes(token), `Former runtime token survived in ${path.relative(root, filePath)}: ${token}`)
  }
}
const packagedKernelPath = path.join(
  root,
  'release/VIGO-mac-arm64/VIGO.app/Contents/Resources/server/vigo-routing-kernel.node',
)
if (fs.existsSync(packagedKernelPath)) {
  const packagedKernel = fs.readFileSync(packagedKernelPath)
  for (const token of forbiddenRuntimeTokens.slice(0, 7)) {
    assert(
      !packagedKernel.includes(Buffer.from(token)),
      `Former runtime token survived in the packaged native kernel: ${token}`,
    )
  }
}

console.log(JSON.stringify({
  status: 'passed',
  productionRoutingSearch: 'rust_node_api',
  nodeApiBoundary: 'fused_endpoint_snapping_directed_one_to_many_and_exact_access_reduction',
  snapshotSchema: 'vigo.street.accelerator.v7_spatial_ordered_mmap_reciprocal_flags',
  sqliteRole: 'import_and_snapshot_construction_only',
  intentionalNonCsaCchOperators: [
    'rust_accessibility_multi_resource_surface_and_timed_connector_labels',
    'rust_drive_hard_distance_pareto_fallback_after_dual_cch_certificates',
  ],
  packagedRuntimeScanned: packagedServerFiles.length > 0 && fs.existsSync(packagedKernelPath),
}, null, 2))
