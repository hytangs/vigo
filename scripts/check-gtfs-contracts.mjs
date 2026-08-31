import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')
const domainSource = read('src/domain.ts')
const mapSource = read('src/VigoMap.tsx')
const scheduledSource = read('src/scheduledVehicles.ts')
const appSource = read('src/App.tsx')
const routingModelSource = read('src/routingModel.ts')
const routingUiSource = read('src/routingUi.ts')
const nationalRoutingSource = read('src/app/useNationalRouting.ts')
const serverSource = read('server/vigo-api.mjs')
const routeWorkerSource = read('server/national-route-worker.mjs')
const nationalOsmSource = read('server/national-osm-store.mjs')
const osmPbfReaderSource = read('server/osm-pbf-reader.mjs')
const nationalGtfsSource = read('server/national-gtfs-store.mjs')
const macPackageSource = read('scripts/package-macos-app.mjs')
const cliSource = read('scripts/vigo-cli.ts')
const rustRoutingSource = read('native/vigo-routing-kernel/src/lib.rs')
const rustTimetableSource = read('native/vigo-routing-kernel/src/timetable.rs')
const activeServiceActivationSource = nationalGtfsSource.slice(
  nationalGtfsSource.indexOf('function activateServices('),
  nationalGtfsSource.indexOf('function activeServiceKernelSnapshot('),
)
const singleNationalRouteSource = serverSource.slice(
  serverSource.indexOf('async function runSingleNationalRoute('),
  serverSource.indexOf('async function runNationalRoute('),
)
const lazyRouteDispatcherSource = serverSource.slice(
  serverSource.indexOf('async function dispatchLazyNationalTransitRoute('),
  serverSource.indexOf('async function runSingleNationalRoute('),
)
const pointRouteCoreSource = nationalGtfsSource.slice(
  nationalGtfsSource.indexOf('export function routeNationalGtfsStore('),
  nationalGtfsSource.indexOf('export function routeNationalGtfsDepartureWindow('),
)
const stopAccessRoleAdmissionSource = nationalGtfsSource.slice(
  nationalGtfsSource.indexOf('export async function ensureNationalGtfsStopAccessRoles('),
  nationalGtfsSource.indexOf('function linkNearbyTransferStops('),
)

const contracts = [
  {
    name: 'every GTFS selection surface uses one streamed SQLite routing-store builder',
    pass: serverSource.includes('startNationalGtfsImport') &&
      serverSource.includes("action === 'national-gtfs-import'") &&
      serverSource.includes("action === 'national-gtfs-upload'") &&
      serverSource.includes('stageUploadedProjectFile') &&
      serverSource.includes("action === 'national-route'") &&
      serverSource.includes("action === 'national-matrix'") &&
      appSource.includes('requestNativeGtfsFile') &&
      appSource.includes('/national-gtfs-import') &&
      appSource.includes("'national-gtfs-upload'") &&
      nationalRoutingSource.includes('/national-route') &&
      cliSource.includes('routeNationalGtfsStore') &&
      cliSource.includes('--store PATH') &&
      !cliSource.includes('--feed PATH'),
  },
  {
    name: 'explicit schedule replacement publishes before pruning obsolete store families',
    pass: serverSource.includes('replaceProjectSchedule') &&
      serverSource.includes('promoteToProjectStore') &&
      serverSource.includes('removeRoutingStoreFamily') &&
      serverSource.indexOf('const updated = await writeProject({') <
        serverSource.indexOf('await Promise.all(obsoleteStorePaths.map(removeRoutingStoreFamily))') &&
      serverSource.includes("await fs.rm(path.join(projectMetaDir(projectId), 'rebuild-manifest.json'), { force: true })"),
  },
  {
    name: 'GTFS and OSM imports overlap safely while same-source jobs remain serialized',
    pass: serverSource.includes('const nationalImportProjects = new Map()') &&
      serverSource.includes("reserveNationalImportProject(projectId, 'gtfs')") &&
      serverSource.includes("reserveNationalImportProject(projectId, 'osm')") &&
      serverSource.includes("releaseNationalImportProject(projectId, 'gtfs')") &&
      serverSource.includes("releaseNationalImportProject(projectId, 'osm')") &&
      serverSource.includes('enqueueProjectWrite') &&
      serverSource.includes('terminalMessageReceived') &&
      serverSource.includes('memoryJob?.projectId === projectId'),
  },
  {
    name: 'network builds persist the selected exact active-service kernel before publication',
    pass: serverSource.includes('preloadNationalBuiltStore') &&
      serverSource.includes("phase: 'Preloading exact timetable kernel'") &&
      serverSource.includes("activeServiceKernel.persistenceState") &&
      serverSource.includes('preloadServiceDate') &&
      appSource.includes('preloadServiceDay: routingServiceDay'),
  },
  {
    name: 'browser GTFS, GeoJSON OSM, and timetable JSON routing paths are absent',
    pass: !existsSync(resolve(root, 'src/gtfs.ts')) &&
      !existsSync(resolve(root, 'src/tides.ts')) &&
      !existsSync(resolve(root, 'src/osmPbf.ts')) &&
      !existsSync(resolve(root, 'src/timeAwareRouting.ts')) &&
      !existsSync(resolve(root, 'src/osmWalkNetwork.ts')) &&
      !existsSync(resolve(root, 'scripts/batch-route.mjs')) &&
      !appSource.includes('inspectGtfsZipInWorker') &&
      !appSource.includes('osmPbfToWalkGeoJson') &&
      !appSource.includes('buildOsmWalkNetworkFromGeoJson') &&
      !serverSource.includes("action === 'routing-schedule'") &&
      !serverSource.includes('buildRoutingStoreFromSchedules') &&
      !serverSource.includes('walk-network.json') &&
      !cliSource.includes('routingSchedule') &&
      !cliSource.includes('walk-network.json'),
  },
  {
    name: 'every SQLite builder excludes unproved radial transfers and persists literal provenance',
    pass: nationalGtfsSource.includes('const nearbyTransferMaxDistanceKm = 0.25') &&
      nationalGtfsSource.includes('function linkNearbyTransferStops(db') &&
      nationalGtfsSource.match(/linkNearbyTransferStops\(db\)/g)?.length === 3 &&
      nationalGtfsSource.includes('CREATE TABLE transfer_provenance(') &&
      nationalGtfsSource.includes("'gtfs_transfer'") &&
      nationalGtfsSource.includes("'gtfs_pathway'") &&
      nationalGtfsSource.includes('String(candidate.stop_id).localeCompare(String(stop.stop_id)) <= 0') &&
      nationalGtfsSource.includes('candidateCount += 2') &&
      !nationalGtfsSource.includes('inferredTransferCount += Number(insertTransfer.run'),
  },
  {
    name: 'GTFS service, hierarchy, transfer, pathway, and frequency semantics are persisted and classified',
    pass: nationalGtfsSource.includes('CREATE TABLE calendar(') &&
      nationalGtfsSource.includes('CREATE TABLE calendar_dates(') &&
      nationalGtfsSource.includes('CREATE TABLE stops(') &&
      nationalGtfsSource.includes('parent_station TEXT') &&
      nationalGtfsSource.includes('location_type INTEGER') &&
      nationalGtfsSource.includes('CREATE TABLE transfers(') &&
      nationalGtfsSource.includes('transfer_type INTEGER') &&
      nationalGtfsSource.includes('min_transfer_time INTEGER') &&
      nationalGtfsSource.includes("gtfsTableEntry(archive, 'pathways.txt')") &&
      nationalGtfsSource.includes('INSERT OR IGNORE INTO transfers VALUES(?,?,0,?)') &&
      nationalGtfsSource.includes('CREATE TABLE frequencies(') &&
      nationalGtfsSource.includes('exact_times INTEGER') &&
      nationalGtfsSource.includes('blockingRoutingFeatures') &&
      nationalGtfsSource.includes('unsupported_gtfs_feature'),
  },
  {
    name: 'preparation jobs are restart-safe and routing status is versioned across the desktop boundary',
    pass: serverSource.includes("const jobSchemaVersion = 'vigo.job.v2'") &&
      serverSource.includes("failureCode: 'preparation_interrupted'") &&
      serverSource.includes("action === 'national-job-retry'") &&
      serverSource.includes("action === 'national-job-cancel'") &&
      serverSource.includes("const routingStatusSchemaVersion = 'vigo.routing.status.v1'") &&
      serverSource.includes("action === 'reproducibility'") &&
      nationalGtfsSource.includes('exactFrequencyExpandedTripCount') &&
      nationalGtfsSource.includes("frequencyRoutingModel: exactFrequencyExpandedTripCount > 0") &&
      appSource.includes('onRetryGtfs') &&
      appSource.includes('onCancelOsm') &&
      appSource.includes('exportReproducibilityManifest'),
  },
  {
    name: 'canonical point routing uses the exact Rust scalar and bounded Pareto engines',
    pass: nationalGtfsSource.includes('function searchActiveServiceKernelNativeScalar(') &&
      nationalGtfsSource.includes('function searchActiveServiceKernelNativePareto(') &&
      rustTimetableSource.includes('const STATE_STRIDE: usize = 8') &&
      rustTimetableSource.includes('pub fn route_scalar_csa(') &&
      rustTimetableSource.includes('pub fn route_pareto_round_csa(') &&
      rustTimetableSource.includes('fn boarding_ready_time(') &&
      rustTimetableSource.includes('MAX_PARETO_LABELS') &&
      nationalGtfsSource.includes('rust_exact_connection_scan_bounded_pareto_no_heuristic') &&
      nationalGtfsSource.includes('paretoCertification') &&
      nationalGtfsSource.includes('lexicographic_earliest_arrival_then_boardings'),
  },
  {
    name: 'active-service switching is failure-atomic and native resident memory is budgeted',
    pass: activeServiceActivationSource.indexOf('runTemporaryTransaction(store.db') >= 0 &&
      activeServiceActivationSource.indexOf("store.db.exec('DELETE FROM active_services;')") >
        activeServiceActivationSource.indexOf('runTemporaryTransaction(store.db') &&
      activeServiceActivationSource.indexOf('store.activeServiceKernel = null') >
        activeServiceActivationSource.indexOf('runTemporaryTransaction(store.db') &&
      activeServiceActivationSource.indexOf('store.activeServiceDate = serviceSetKey') >
        activeServiceActivationSource.indexOf('runTemporaryTransaction(store.db') &&
      nationalGtfsSource.includes('nativeMemoryBudget') &&
      nationalGtfsSource.includes('nativeIndexBytes') &&
      nationalGtfsSource.includes('nativeWorkspaceBytes') &&
      nationalGtfsSource.includes('bytes.estimatedBytes > activeServiceKernelMaxEstimatedBytes') &&
      nationalGtfsSource.includes("error.code = 'resident_timetable_kernel_required'") &&
      !nationalGtfsSource.includes("engine: 'sqlite_memory_budget_fallback'"),
  },
  {
    name: 'national matrix routing reuses the prepared packaged route worker',
    pass: nationalGtfsSource.includes('routeNationalGtfsMatrix') &&
      routeWorkerSource.includes('routeNationalGtfsMatrix') &&
      routeWorkerSource.includes("operation === 'matrix'") &&
      serverSource.includes("dispatchRoutingAccessPrepared(storePath, 'matrix'") &&
      !serverSource.includes('dispatchPrepared(') &&
      !serverSource.includes('national-matrix-worker.mjs') &&
      !macPackageSource.includes('national-matrix-worker.mjs'),
  },
  {
    name: 'direct-walk early exits require configured-overhead, exact service-anchor, or complete-frontier proofs',
    pass: nationalGtfsSource.includes('const directWalkTransitEndpointLowerBoundMinutes = (') &&
      nationalGtfsSource.includes('2 * Math.ceil(accessOverheadSeconds) / 60') &&
      nationalGtfsSource.includes('if (!(directWalkTransitEndpointLowerBoundMinutes > 0)) return false') &&
      nationalGtfsSource.includes('durationMinutes < directWalkTransitEndpointLowerBoundMinutes') &&
      nationalGtfsSource.includes('direct_walk_strictly_dominates_configured_endpoint_overhead_lower_bound') &&
      nationalGtfsSource.includes('function accessFrontierDirectWalkProbe(') &&
      nationalGtfsSource.includes('minimumAccessSeconds + minimumEgressSeconds') &&
      nationalGtfsSource.includes('direct_walk_strictly_dominates_complete_endpoint_access_lower_bound') &&
      nationalGtfsSource.includes('function lightweightServiceAnchorDirectWalkProbe(') &&
      nationalGtfsSource.includes('function lightweightServiceAnchorDateResolution(') &&
      nationalGtfsSource.includes('function lightweightIncompleteCoveragePlan(') &&
      nationalGtfsSource.includes('single_feed_exact_date_global_anchor_superset_no_service_enumeration') &&
      nationalGtfsSource.includes('graph_verified_direct_walk_when_required_service_coverage_is_incomplete') &&
      nationalGtfsSource.includes('direct_walk_strictly_dominates_exact_service_anchor_lower_bound') &&
      nationalGtfsSource.includes('global_role_eligible_public_anchor_chord_certificate') &&
      !nationalGtfsSource.includes('directWalkDominanceMinutes') &&
      !routeWorkerSource.includes("'direct-walk-dominance'") &&
      !serverSource.includes("'direct-walk-dominance'"),
  },
  {
    name: 'point routing admits current transfers before exact route-core preflight without forcing a timetable kernel',
    pass: singleNationalRouteSource.includes('dispatchLazyNationalTransitRoute(') &&
      lazyRouteDispatcherSource.includes("'prepare-transfers'") &&
      lazyRouteDispatcherSource.includes("windowMinutes ? 'window' : 'route'") &&
      lazyRouteDispatcherSource.indexOf("'prepare-transfers'") <
        lazyRouteDispatcherSource.indexOf("windowMinutes ? 'window' : 'route'") &&
      lazyRouteDispatcherSource.includes("error?.code === 'VIGO_ROUTE_WORKER_RESTARTED'") &&
      lazyRouteDispatcherSource.includes("error?.code === 'resident_timetable_kernel_required'") &&
      lazyRouteDispatcherSource.includes(
        "error?.activeServiceKernel?.reason === 'topology_unavailable'",
      ) &&
      lazyRouteDispatcherSource.includes("'prepare-derived'") &&
      nationalGtfsSource.includes(
        'export async function ensureNationalGtfsDerivedArtifactsCurrent(',
      ) &&
      routeWorkerSource.includes(
        "operation === 'prepare-derived'",
      ) &&
      !singleNationalRouteSource.includes('dispatchPrepared') &&
      pointRouteCoreSource.indexOf(
        'const lightweightDirectWalk = lightweightServiceAnchorDirectWalkProbe(',
      ) < pointRouteCoreSource.indexOf('const store = openNationalStore(storePath)') &&
      pointRouteCoreSource.indexOf('const accessFrontierDirectWalk = accessFrontierDirectWalkProbe(') <
        pointRouteCoreSource.indexOf('const serviceActivationStartedAt = performance.now()'),
  },
  {
    name: 'every OSM selection surface uses the streamed disk-backed PBF street builder',
    pass: osmPbfReaderSource.includes('export async function forEachPbfBlock') &&
      nationalOsmSource.includes('forEachPbfBlock(pbfPath') &&
      nationalOsmSource.includes("sourceFingerprint: sourceHasher.digest('hex')") &&
      nationalOsmSource.includes('nationalOsmWalkDirections') &&
      nationalOsmSource.includes('CREATE TABLE walk_nodes') &&
      nationalOsmSource.includes('CREATE TABLE edges') &&
      nationalOsmSource.includes('prepareNationalOsmNativeStore') &&
      nationalOsmSource.includes('routeNativeStreetPath') &&
      nationalGtfsSource.includes('routeNativeCoordinateFrontiers') &&
      !nationalOsmSource.includes('streetDistancesToCandidates') &&
      !nationalOsmSource.includes('streetPathCoordinates') &&
      !nationalOsmSource.includes('arrayBuffer()') &&
      !nationalOsmSource.includes('legacy-geojson') &&
      serverSource.includes('startNationalOsmImport') &&
      serverSource.includes("action === 'national-osm-import'") &&
      serverSource.includes("action === 'national-osm-upload'") &&
      appSource.includes('requestNativeOsmFile') &&
      appSource.includes('/national-osm-import') &&
      !appSource.includes('.geojson,.json') &&
      !serverSource.includes("action === 'osm-walk'"),
  },
  {
    name: 'large national street snapshots are import-time, memory-gated, and query-time native only',
    pass: nationalOsmSource.includes('40_000_000') &&
      nationalOsmSource.includes('12_000_000_000') &&
      nationalOsmSource.includes('streetAcceleratorLargeGraphMinimumMemoryBytes') &&
      nationalOsmSource.includes('walkNodeCount') &&
      nationalOsmSource.includes('prepareNationalOsmNativeStore') &&
      routeWorkerSource.includes('prepareNationalOsmNativeStore') &&
      !routeWorkerSource.includes('prepareNationalOsmStore,'),
  },
  {
    name: 'GTFS publication prepares every directed local stop transfer before the new store becomes active',
    pass: routeWorkerSource.includes("operation === 'prepare-transfers'") &&
      routeWorkerSource.includes('ensureNationalGtfsOsmStopTransfers') &&
      serverSource.includes("'prepare-transfers'") &&
      serverSource.indexOf("'prepare-transfers'") <
        serverSource.indexOf('await enqueueProjectWrite(projectId, () => commitIndexedFeed') &&
      serverSource.includes(
        "if (!['prepare', 'prepare-street', 'prepare-transfers', 'prepare-derived', 'prepare-routing-access'].includes(job.operation))",
      ) &&
      nationalGtfsSource.includes('VIGO_ROUTING_TRANSFER_MAX_NEIGHBORS, 0') &&
      rustRoutingSource.includes('if input.maximum_neighbors == 0') &&
      rustRoutingSource.includes('usize::MAX'),
  },
  {
    name: 'boarding and alighting eligibility is exact and persisted before process-cold routing',
    pass: nationalGtfsSource.includes("const stopAccessRoleIndexVersion = 'vigo.routing.stop-access-roles.v1'") &&
      nationalGtfsSource.includes('CREATE TABLE stop_access_roles(') &&
      nationalGtfsSource.includes('function rebuildStopAccessRoles(db)') &&
      nationalGtfsSource.includes('ensureNationalGtfsStopAccessRoles') &&
      nationalGtfsSource.includes("strategy: 'immutable_grid_persisted_exact_stop_roles'") &&
      !nationalGtfsSource.includes('const serviceRoleQuery = (role) =>'),
  },
  {
    name: 'read-only stop-role admission preserves resident exact routing state',
    pass: (
      stopAccessRoleAdmissionSource.match(
        /invalidateNationalStore\(resolvedStorePath\)/gu,
      )?.length === 1
    ) &&
      stopAccessRoleAdmissionSource.indexOf(
        'invalidateNationalStore(resolvedStorePath)',
      ) < stopAccessRoleAdmissionSource.indexOf('BEGIN IMMEDIATE'),
  },
  {
    name: 'official OSM imports persist one exact PBF identity in project and visible metadata',
    pass: serverSource.includes('sourceModel: message.result.sourceModel') &&
      serverSource.includes('sourceFingerprint: message.result.sourceFingerprint') &&
      serverSource.includes('sourceSha256: message.result.sourceFingerprint') &&
      serverSource.includes('sourceModel: street.sourceModel') &&
      serverSource.includes('sourceFingerprint: street.sourceFingerprint') &&
      serverSource.includes('sourceSha256: street.sourceSha256'),
  },
  {
    name: 'route rendering preserves trustworthy geometry and caps inferred segments',
    pass: mapSource.includes("type: 'MultiLineString'") &&
      mapSource.includes('splitLineAtJumps') &&
      mapSource.includes('maxInferredSegmentKm') &&
      /directDistance <= maxInferredSegmentKm/.test(mapSource) &&
      mapSource.includes('geometryConfidence') &&
      mapSource.includes('geometryFragmentCount'),
  },
  {
    name: 'scheduled vehicles require published shape geometry',
    pass: scheduledSource.includes('hasTrustworthyVehiclePath') &&
      scheduledSource.includes("if (route.geometrySource !== 'shape') return false") &&
      scheduledSource.includes('maxTrustedShapeVehicleJumpKm') &&
      !scheduledSource.includes('maxTrustedStopSequenceVehicleJumpKm'),
  },
  {
    name: 'network mode does not treat every stop as selected',
    pass: mapSource.includes('const hasSelectedPattern = selectedStopIds.size > 0') &&
      mapSource.includes('selectedPatternStop: hasSelectedPattern &&'),
  },
  {
    name: 'desktop, worker, and CLI expose one canonical routing model',
    pass: routingModelSource.includes("RoutingTravelMode = 'transit' | 'walk' | 'drive'") &&
      !routingModelSource.includes("'bike'") &&
      routingUiSource.includes('export function buildRoutingPointFromMap') &&
      routingUiSource.includes('export function findNetworkSearchHits') &&
      !routingUiSource.includes('planRouteChoices') &&
      (
        routeWorkerSource.includes("from './national-gtfs-store.mjs'")
        || routeWorkerSource.includes("import('./national-gtfs-store.mjs')")
      ) &&
      cliSource.includes("from '../server/national-gtfs-store.mjs'"),
  },
  {
    name: 'production routing uses SQLite endpoints and never a browser planner',
    pass: nationalRoutingSource.includes('/national-route') &&
      serverSource.includes("action === 'national-route'") &&
      nationalOsmSource.includes('function openRuntimeStreetStore') &&
      nationalOsmSource.includes('new DatabaseSync') &&
      nationalGtfsSource.includes('routeNationalGtfsStore') &&
      !appSource.includes('planRouteChoices(') &&
      !appSource.includes('planTimeAwareRoute('),
  },
  {
    name: 'domain retains deterministic operator-facing summaries',
    pass: domainSource.includes('export type MapPreviewCoverage') &&
      domainSource.includes('MapPreview') &&
      domainSource.includes('RouteMetric'),
  },
]

const failed = contracts.filter((contract) => !contract.pass)
if (failed.length) {
  console.error('GTFS contract check failed:')
  for (const contract of failed) console.error(`- ${contract.name}`)
  process.exit(1)
}

console.log(`GTFS contract check passed (${contracts.length} contracts).`)
