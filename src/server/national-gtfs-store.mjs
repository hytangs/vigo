import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance as nodePerformance } from 'node:perf_hooks'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from './routing-snapshot.mjs'
import {
  loadPreparedAccessContext,
  persistPreparedAccessContext,
  packStationPaths,
  stationPathLookup,
} from './prepared-access-context.mjs'
import {
  createGtfsZipImportBudget,
  gtfsTableEntry,
  inspectGtfsZip,
  streamGtfsZipCsv,
} from './gtfs-zip-reader.mjs'
import {
  appendDistinctCoordinates,
  haversineKm,
} from './geometry-utils.mjs'
import { integralNumber, numeric, timingMilliseconds } from './number-utils.mjs'
import { assertMatrixSize } from './matrix-size.mjs'
import { annotateStationAccess, stationAccessPaths, stationFallbackSeconds } from './station-access.mjs'
import { routeDisplayLongName, routePreviewColor } from './route-presentation.mjs'
import {
  readNationalOsmStoreMetadata,
  routeNationalStreetMatrix,
  streetPathBetween,
} from './national-osm-store.mjs'
import {
  stableJson,
  stableNationalTransitPlanId,
  stablePlanId,
  stableKeySuffix,
} from './routing-plan-identity.mjs'
import { WeightedLruCache } from './weighted-lru-cache.mjs'
import {
  buildNativeStopTransferGraph,
  configureNativeRoutingAccessProfile,
  materializeNativeCoordinateEndpointCandidates,
  materializeNativeStreetPath,
  nativeRoutingAccessProfilePrepared,
  nativeStreetAccessPermission,
  prepareNativeTimetableKernel,
  rasterNativeStreetSurface,
  routeNativeAccessMemberPath,
  routeNativeCoordinateFrontier,
  routeNativeCoordinateFrontiers,
  routeNativeCoordinateTimetableMany,
  routeNativeCoordinateTimetableMatrix,
  routeNativeCoordinateTimetableScalar,
  routeNativeTimedConnectors,
  routeNativeTimetableArriveBy,
  routeNativeTimetableMany,
  routeNativeTimetableMatrix,
  routeNativeTimetableOverlayMany,
  routeNativeTimetablePareto,
  routeNativeTimetableScalar,
  normalizeNativeMilliseconds,
} from './native-routing-kernel.mjs'
import {
  nationalRideGeometry,
} from './national-route-geometry.mjs'
import {
  nationalChoiceIdentity,
  nationalPublicRouteSequence,
  nationalRideBoardingSummary,
  nationalRoutingReturnedRideCycle,
  selectNationalAlternativeWaypointGroups,
  selectNationalDepartureWindowChoices,
} from './national-route-choices.mjs'
import { resolveServiceDay } from './service-day.mjs'

function withResolvedServiceDay(request) {
  const serviceDay = resolveServiceDay(request?.serviceDate, request?.serviceDay)
  // Preserve descriptors instead of spreading the request. Besides retaining
  // the module-private prepared-access symbol, this avoids invoking unrelated
  // getters (for example, an optional cache field) before the selected route
  // path has decided whether it needs them.
  const descriptors = Object.getOwnPropertyDescriptors(request)
  delete descriptors.serviceDay
  descriptors.serviceDay = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: serviceDay,
  }
  return Object.defineProperties(
    Object.create(Object.getPrototypeOf(request)),
    descriptors,
  )
}

function integralRoutingMinute(value, label, fallback = 8 * 60, maximum = 2_880) {
  const candidate = value === undefined ? fallback : value
  const parsed = integralNumber(candidate)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} must be an integral minute in [0, ${maximum}].`)
  }
  return parsed
}

export {
  nationalChoiceIdentity,
  nationalPublicRouteSequence,
  nationalRideBoardingSummary,
  nationalRoutingReturnedRideCycle,
  selectNationalAlternativeWaypointGroups,
  selectNationalDepartureWindowChoices,
} from './national-route-choices.mjs'
export { WeightedLruCache } from './weighted-lru-cache.mjs'
import { readGtfsFareCatalog, writeGtfsFareCatalog, copyGtfsFareCatalogs, addGtfsFares } from './gtfs-fare-store.mjs'
import { resolveRealtimeTripTimes } from './realtime-trip-timing.mjs'

const storeSchemaVersion = 'vigo.routing.store.v1'
const transferSemanticsVersion = 'vigo.routing.transfers.v3'
const stopAccessRoleIndexVersion = 'vigo.routing.stop-access-roles.v1'
// Admission checks only the objects needed to identify a current store and
// execute the routing queries. SQLite remains the source of truth for column
// details; keeping a second copy of every table and index definition here was
// brittle and added no useful protection after the store was opened read-only.
const routingStoreTableNames = Object.freeze([
  'metadata', 'stops', 'routes', 'trips', 'route_services',
  'trip_shapes', 'shape_points', 'calendar', 'calendar_dates', 'transfers',
  'frequencies', 'connections', 'stop_modes', 'stop_access_roles',
])
const routingStoreIndexTables = Object.freeze({
  calendar_dates_date: 'calendar_dates',
  connections_from_departure_cover: 'connections',
  route_services_representative: 'route_services',
  route_services_trip_rank: 'route_services',
  routes_service_identity: 'routes',
  stop_modes_stop_type: 'stop_modes',
  stop_modes_type_stop: 'stop_modes',
  stops_lat_lon: 'stops',
  stops_parent: 'stops',
  transfers_from: 'transfers',
  trip_shapes_shape: 'trip_shapes',
  trips_route: 'trips',
  trips_service: 'trips',
})
const staticTopologySchemaVersion = 'vigo.routing.static-topology.v4'
const staticTopologySourceIdentityVersion = 'vigo.routing.static-topology-source.v3'
const monotonicNow = nodePerformance.now.bind(nodePerformance)
const realtimeRoutingMaxTripUpdates = 256
const realtimeRoutingMaxStops = 4_096
const realtimeTripLookupCache = new WeakMap()
const realtimeTimezoneFormatterCache = new Map()
// Internal controls must not be representable in HTTP, CLI, worker, or JSON
// request payloads. A module-private Symbol survives local object spreads used
// by retries but cannot be forged across a serialization boundary.
// Departure-window samples share one immutable endpoint-access frontier. Keep
// the handoff module-private and non-enumerable: it cannot cross HTTP/CLI/worker
// serialization, and ordinary object spreads used by fallback or synthetic
// alternative searches cannot accidentally carry it to changed endpoints.
const preparedNativeCoordinateAccessPair = Symbol(
  'vigo.internal.prepared-native-coordinate-access-pair',
)
const departureWindowAlternativePlans = Symbol('vigo.internal.departure-window-alternative-plans')
const alternativeArrivalSlackSeconds = 15 * 60
const staticTopologyMinimumFreeBytes = 2 * 1024 * 1024 * 1024
const staticTopologyReserveFloorBytes = 128 * 1024 * 1024
const staticTopologyTransientWorkspaceBytes = 64 * 1024 * 1024
const staticTopologySourceGrowthFactor = 2
// The desktop uses an ordinary walking pace without hidden reliability
// padding. Deployments may tune each term explicitly through the environment;
// one immutable walking model is bound to each worker process.
const customWalkingParametersEnabled = [
  'VIGO_ROUTING_WALK_SPEED_KPH',
  'VIGO_ROUTING_WALK_PADDING_FACTOR',
  'VIGO_ROUTING_WALK_OVERHEAD_SECONDS',
].some((key) => String(process.env[key] ?? '').trim() !== '')
const configuredWalkingSpeedKph = Math.max(
  1.5,
  Math.min(
    8,
    numeric(
      process.env.VIGO_ROUTING_WALK_SPEED_KPH,
      4.8,
    ),
  ),
)
const configuredAccessPaddingFactor = Math.max(
  0.75,
  Math.min(
    3,
    numeric(
      process.env.VIGO_ROUTING_WALK_PADDING_FACTOR,
      1,
    ),
  ),
)
const configuredAccessOverheadSeconds = Math.max(
  0,
  Math.min(
    900,
    numeric(
      process.env.VIGO_ROUTING_WALK_OVERHEAD_SECONDS,
      0,
    ),
  ),
)
const nationalRoutingAccessPolicy = Object.freeze({
  schemaVersion: 'vigo.routing.access-policy.v3',
  id: customWalkingParametersEnabled
    ? 'vigo-national-configured-access'
    : 'vigo-national-regular-access',
  durationModel: 'osm-distance-at-configured-walking-speed',
  walkingSpeedKph: configuredWalkingSpeedKph,
  accessPaddingFactor: configuredAccessPaddingFactor,
  accessOverheadSeconds: configuredAccessOverheadSeconds,
  physicalLimitScope: 'per-endpoint',
  customOverride: customWalkingParametersEnabled,
  configuration: customWalkingParametersEnabled
    ? 'environment'
    : 'product-default',
})
const nationalRoutingAccessPolicyIdentity = stableJson(nationalRoutingAccessPolicy)
const walkingSpeedKph = nationalRoutingAccessPolicy.walkingSpeedKph
const accessPaddingFactor = nationalRoutingAccessPolicy.accessPaddingFactor
const accessOverheadSeconds = nationalRoutingAccessPolicy.accessOverheadSeconds
// A free coordinate must pay access overhead before boarding and egress
// overhead after alighting. Scheduled, transfer, and walking transitions are
// nonnegative, so this is the only process-wide transit-duration lower bound
// available before the timetable is searched. At the product default of zero
// overhead there is no valid direct-walk early exit.
const directWalkTransitEndpointLowerBoundMinutes = (
  2 * Math.ceil(accessOverheadSeconds) / 60
)
const osmTransferGraphSchemaVersion = 'vigo.routing.osm-stop-transfers.v3'
const osmTransferMaximumWalkM = Math.max(
  50,
  Math.min(1_200, numeric(process.env.VIGO_ROUTING_TRANSFER_RADIUS_M, 500)),
)
const osmTransferMaximumNeighbors = Math.max(
  0,
  Math.min(4_096, Math.floor(numeric(process.env.VIGO_ROUTING_TRANSFER_MAX_NEIGHBORS, 0))),
)
// Stored transfer seconds are a topology lower bound. The resident store
// replaces them with the configured walking policy using path_distance_m.
const osmTransferLowerBoundSpeedKph = 8
// A minute-precise earliest arrival is false precision for a public journey
// choice, but transfers are not an absolute priority: a faster journey that
// also walks materially less must remain preferable. The certifier minimizes
// generalized time over every nondominated itinerary inside this window that
// does not add boardings beyond the exact earliest-arrival witness. Advanced
// deployments can vary each parameter without changing the timetable graph.
const balancedTransferArrivalSlackSeconds = Math.max(
  0,
  Math.min(60 * 60, numeric(process.env.VIGO_ROUTING_BALANCED_ARRIVAL_SLACK_SECONDS, 15 * 60)),
)
const balancedTransferPenaltySeconds = Math.max(
  0,
  Math.min(60 * 60, numeric(process.env.VIGO_ROUTING_BALANCED_TRANSFER_PENALTY_SECONDS, 5 * 60)),
)
const balancedWalkReluctance = Math.max(
  0,
  Math.min(5, numeric(process.env.VIGO_ROUTING_BALANCED_WALK_RELUCTANCE, 1)),
)
const nearbyTransferMaxDistanceKm = 0.25
const nearbyTransferCellDegrees = 0.01
const alternativeStreetAccessAnchorLimit = 160
const nationalPreviewRouteLimit = 500
const nationalRouteCatalogLimit = 10_000
const nationalPreviewStopLimit = 12_000
const nationalPreviewConnectionsPerRoute = 96
const nationalStoreCache = new Map()
const serviceAccessAnchorCache = new Map()
const streetStorageIdentityCache = new Map()
const nationalStoreCacheMaxEntries = Math.max(1, Math.min(32, Math.floor(Number(process.env.VIGO_STORE_CACHE_MAX_ENTRIES ?? 8) || 8)))
const serviceAccessAnchorCacheMaxEntries = Math.max(
  1,
  Math.min(
    16,
    Math.floor(Number(process.env.VIGO_ACCESS_ANCHOR_CACHE_MAX_ENTRIES ?? 4) || 4),
  ),
)
const streetStorageIdentityCacheMaxEntries = Math.max(1, Math.min(64, Math.floor(Number(process.env.VIGO_STREET_IDENTITY_CACHE_MAX_ENTRIES ?? 16) || 16)))
// Selected transfer and access-member paths are immutable for one street
// storage identity. Keep them separate from endpoint frontiers: endpoint
// predecessor tokens are query-local and cannot safely survive another
// coordinate query, while these materialized paths do not depend on a token.
const nativeStreetPathCacheLimits = Object.freeze({
  maxEntries: Math.max(
    128,
    Math.min(4_096, Math.floor(Number(process.env.VIGO_NATIVE_STREET_PATH_CACHE_ENTRIES ?? 2_048) || 2_048)),
  ),
  maxSegments: Math.max(
    16_000,
    Math.min(500_000, Math.floor(Number(process.env.VIGO_NATIVE_STREET_PATH_CACHE_SEGMENTS ?? 250_000) || 250_000)),
  ),
  maxBytes: Math.max(
    2 * 1024 * 1024,
    Math.min(64 * 1024 * 1024, Math.floor(Number(process.env.VIGO_NATIVE_STREET_PATH_CACHE_BYTES ?? 32 * 1024 * 1024) || 32 * 1024 * 1024)),
  ),
})
const supportedScheduledCoreLimitationCodes = new Set([
  'frequency_based_service',
  'on_demand_boarding_or_alighting',
  'restricted_boarding_or_alighting',
  'continuous_pickup_or_drop_off',
  'scoped_transfer_rules',
  'timed_transfer_guarantee',
  'in_seat_transfer_rules',
  'block_interlining',
  'pathway_accessibility',
  'wheelchair_accessibility',
  'bicycle_accessibility',
  'station_entrances',
  'station_level_hierarchy',
  'feature_inventory_incomplete',
])
const requiredRoutingFeatureInventoryKeys = Object.freeze([
  'stopWheelchairBoardingRuleCount',
  'tripWheelchairAccessibleRuleCount',
  'tripBikesAllowedRuleCount',
  'stationEntranceCount',
  'stationLevelRuleCount',
])
const stopAccessSpatialCellDegrees = 0.01
function optionalPositiveLimit(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return 0
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) && value > 0 ? value : 0
}

// These are opt-in operational safeguards. A zero value means unbounded: the
// current resident kernel remains the routing engine for every city that fits
// the native integer representation and the host's available memory. Routing
// must not silently become unavailable merely because a deployment-specific
// byte or segment budget was chosen for a smaller feed.
const activeServiceKernelMaxSegments = optionalPositiveLimit('VIGO_ACTIVE_KERNEL_MAX_SEGMENTS')
const activeServiceKernelMaxSourceConnections = optionalPositiveLimit('VIGO_ACTIVE_KERNEL_MAX_SOURCE_CONNECTIONS')
  || activeServiceKernelMaxSegments
const activeServiceKernelMaxEstimatedBytes = optionalPositiveLimit('VIGO_ACTIVE_KERNEL_MAX_BYTES')
// A malformed/oversized persisted snapshot is a cache miss, never a routing
// capability failure: the active timetable is rebuilt from the authoritative
// GTFS SQLite source. Keep a finite default only to bound snapshot admission;
// the current route engine itself remains unbounded by city size.
const activeServiceKernelMaxSnapshotBytes = optionalPositiveLimit('VIGO_ACTIVE_KERNEL_MAX_SNAPSHOT_BYTES')
  || 512 * 1024 * 1024
const activeServiceKernelCacheBudgetBytes = Math.max(
  640 * 1024 * 1024,
  Math.min(
    4 * 1024 * 1024 * 1024,
    Math.floor(Number(process.env.VIGO_ACTIVE_KERNEL_CACHE_BUDGET_BYTES ?? 1280 * 1024 * 1024) || 0),
  ),
)
const activeServiceKernelSnapshotCacheBudgetBytes = Math.max(
  128 * 1024 * 1024,
  Math.min(
    2 * 1024 * 1024 * 1024,
    Math.floor(Number(process.env.VIGO_ACTIVE_KERNEL_SNAPSHOT_CACHE_BUDGET_BYTES ?? 512 * 1024 * 1024) || 0),
  ),
)
const activeServiceKernelSchemaVersion = 'vigo.routing.active-service-kernel.v15-portable'
const activeServiceTransferProjectionVersion = 'single_edge_service_ingress.v6-station-time'
const activeServiceKernelContextCacheMaxEntries = Math.max(
  1,
  Math.min(8, Math.floor(Number(process.env.VIGO_ACTIVE_KERNEL_CONTEXT_CACHE_MAX_ENTRIES ?? 2) || 0)),
)
const activeServiceKernelContextCacheMaxBytes = Math.max(
  activeServiceKernelCacheBudgetBytes,
  Math.min(
    activeServiceKernelCacheBudgetBytes * 4,
    Math.floor(Number(
      process.env.VIGO_ACTIVE_KERNEL_CONTEXT_CACHE_MAX_BYTES
      ?? activeServiceKernelCacheBudgetBytes * 2,
    ) || 0),
  ),
)
const activeServiceKernelSnapshotCacheMaxEntries = Math.max(
  1,
  Math.min(8, Math.floor(Number(
    process.env.VIGO_ACTIVE_KERNEL_SNAPSHOT_CACHE_MAX_ENTRIES ?? 2,
  ) || 0)),
)
const activeServiceKernelSnapshotCacheMaxBytes = Math.max(
  activeServiceKernelSnapshotCacheBudgetBytes,
  Math.min(2 * 1024 * 1024 * 1024, Math.floor(Number(
    process.env.VIGO_ACTIVE_KERNEL_SNAPSHOT_CACHE_MAX_BYTES ?? 512 * 1024 * 1024,
  ) || 0)),
)
const nativeAccessProfileSnapshotCacheMaxEntries = Math.max(
  1,
  Math.min(4, Math.floor(Number(
    process.env.VIGO_NATIVE_ACCESS_PROFILE_CACHE_MAX_ENTRIES ?? 1,
  ) || 0)),
)
const nativeAccessProfileSnapshotCacheMaxBytes = Math.max(
  64 * 1024 * 1024,
  Math.min(1024 * 1024 * 1024, Math.floor(Number(
    process.env.VIGO_NATIVE_ACCESS_PROFILE_CACHE_MAX_BYTES ?? 256 * 1024 * 1024,
  ) || 0)),
)
const readOnlySqliteMmapBytes = Math.max(
  0,
  Math.min(
    2 * 1024 * 1024 * 1024,
    // Keep the authoritative GTFS file out of the process address-space RSS.
    // The resident timetable and OSM snapshots are the hot path; SQLite is
    // used for bounded metadata/geometry lookups and can use its small pager
    // cache without mapping the whole multi-city file.
    Math.floor(Number(process.env.VIGO_READONLY_SQLITE_MMAP_BYTES ?? 0) || 0),
  ),
)
const readOnlySqliteCacheKiB = Math.max(
  4 * 1024,
  Math.min(256 * 1024, Math.floor(Number(process.env.VIGO_READONLY_SQLITE_CACHE_KIB ?? 16 * 1024) || 0)),
)
// Larger pages materially reduce B-tree fan-out overhead for large connection
// and street stores while keeping the immutable runtime files
// SQLite-compatible. Small stores also benefit from the same deterministic
// layout, so this is a build format rather than a city switch.
const buildSqlitePageSize = 32 * 1024
const buildSqliteCacheKiB = Math.max(
  4 * 1024,
  Math.min(256 * 1024, Math.floor(Number(process.env.VIGO_BUILD_SQLITE_CACHE_KIB ?? 32 * 1024) || 0)),
)
const shapeGeometryCacheMaxEntries = Math.max(
  128,
  Math.min(4096, Math.floor(Number(process.env.VIGO_SHAPE_GEOMETRY_CACHE_MAX_ENTRIES ?? 1024) || 0)),
)
const shapeGeometryCacheMaxBytes = Math.max(
  8 * 1024 * 1024,
  Math.min(256 * 1024 * 1024, Math.floor(Number(process.env.VIGO_SHAPE_GEOMETRY_CACHE_MAX_BYTES ?? 64 * 1024 * 1024) || 0)),
)
const tripShapeIdCacheMaxEntries = Math.max(
  10_000,
  Math.min(500_000, Math.floor(Number(process.env.VIGO_TRIP_SHAPE_ID_CACHE_MAX_ENTRIES ?? 250_000) || 0)),
)
const routeServiceCatalogSchemaVersion = 'vigo.routing.route-services.v2'
const activeServiceKernelPersistenceEnabled = process.env.VIGO_ACTIVE_KERNEL_PERSIST !== '0'
const nativeAccessProfilePersistenceEnabled = process.env.VIGO_NATIVE_ACCESS_PROFILE_PERSIST !== '0'

function estimateNativeStreetPathWeight(pathResult) {
  const coordinatePoints = Array.isArray(pathResult?.coordinates)
    ? pathResult.coordinates.length
    : 0
  return {
    segments: Math.max(1, coordinatePoints),
    bytes: 1_024 + coordinatePoints * 32,
  }
}

function coordinateCacheKey(coordinate) {
  return Array.isArray(coordinate) && coordinate.length === 2
    ? coordinate.map((value) => Number(value).toString()).join(',')
    : ''
}

function nativeStreetPathCacheKey({
  kind,
  streetStorePath,
  streetStorageIdentity,
  fromStopId = '',
  toStopId = '',
  fromCoordinate,
  toCoordinate,
  maximumDistanceKm,
  maximumPoints,
}) {
  return [
    kind,
    path.resolve(streetStorePath),
    streetStorageIdentity ?? '',
    fromStopId,
    toStopId,
    coordinateCacheKey(fromCoordinate),
    coordinateCacheKey(toCoordinate),
    Number(maximumDistanceKm).toFixed(6),
    String(maximumPoints),
  ].join('|')
}

function cachedNativeStreetPath(
  store,
  {
    streetStorePath,
    streetStorageIdentity,
    fromCoordinate,
    toCoordinate,
    maximumDistanceKm,
    maximumPoints = 160,
  },
  diagnostics = null,
) {
  if (diagnostics?.disableCache === true) {
    if (diagnostics) diagnostics.misses += 1
    const pathResult = streetPathBetween(
      streetStorePath,
      fromCoordinate,
      toCoordinate,
      maximumDistanceKm,
      maximumPoints,
    )
    if (!pathResult) return null
    if (diagnostics) diagnostics.queryMs += timingMilliseconds(pathResult.nativeQueryMs)
    return { ...pathResult, nativeCacheHit: false }
  }
  const key = nativeStreetPathCacheKey({
    kind: 'street-path',
    streetStorePath,
    streetStorageIdentity,
    fromCoordinate,
    toCoordinate,
    maximumDistanceKm,
    maximumPoints,
  })
  const cached = store.nativeStreetPathCache.get(key)
  if (cached) {
    if (diagnostics) diagnostics.hits += 1
    return {
      ...cached,
      nativeCacheHit: true,
      nativeQueryMs: 0,
    }
  }
  if (diagnostics) diagnostics.misses += 1
  const pathResult = streetPathBetween(
    streetStorePath,
    fromCoordinate,
    toCoordinate,
    maximumDistanceKm,
    maximumPoints,
  )
  if (!pathResult) return null
  store.nativeStreetPathCache.set(
    key,
    pathResult,
    estimateNativeStreetPathWeight(pathResult),
  )
  if (diagnostics) diagnostics.queryMs += timingMilliseconds(pathResult.nativeQueryMs)
  return { ...pathResult, nativeCacheHit: false }
}

function cachedNativeAccessMemberPath(
  store,
  {
    streetStorePath,
    streetStorageIdentity,
    fromStopId,
    toStopId,
    fromCoordinate,
    toCoordinate,
    maximumDistanceKm,
    maximumPoints = 160,
    stopTransfer = false,
  },
  diagnostics = null,
) {
  if (diagnostics?.disableCache === true) {
    if (diagnostics) diagnostics.misses += 1
    nativeCoordinateAccessProfile(store, streetStorePath, streetStorageIdentity)
    const pathResult = routeNativeAccessMemberPath(
      streetStorePath,
      fromStopId,
      toStopId,
      fromCoordinate,
      toCoordinate,
      maximumDistanceKm,
      maximumPoints,
      stopTransfer,
    )
    if (!pathResult) return null
    if (diagnostics) diagnostics.queryMs += timingMilliseconds(pathResult.nativeQueryMs)
    return { ...pathResult, nativeCacheHit: false }
  }
  const key = nativeStreetPathCacheKey({
    kind: stopTransfer ? 'stop-transfer-path' : 'access-member-path',
    streetStorePath,
    streetStorageIdentity,
    fromStopId,
    toStopId,
    fromCoordinate,
    toCoordinate,
    maximumDistanceKm,
    maximumPoints,
  })
  const cached = store.nativeStreetPathCache.get(key)
  if (cached) {
    if (diagnostics) diagnostics.hits += 1
    return {
      ...cached,
      nativeCacheHit: true,
      nativeQueryMs: 0,
    }
  }
  if (diagnostics) diagnostics.misses += 1
  nativeCoordinateAccessProfile(store, streetStorePath, streetStorageIdentity)
  const pathResult = routeNativeAccessMemberPath(
    streetStorePath,
    fromStopId,
    toStopId,
    fromCoordinate,
    toCoordinate,
    maximumDistanceKm,
    maximumPoints,
    stopTransfer,
  )
  if (!pathResult) return null
  store.nativeStreetPathCache.set(
    key,
    pathResult,
    estimateNativeStreetPathWeight(pathResult),
  )
  if (diagnostics) diagnostics.queryMs += timingMilliseconds(pathResult.nativeQueryMs)
  return { ...pathResult, nativeCacheHit: false }
}

function nativeStreetPathCacheDiagnostics(store) {
  return store.nativeStreetPathCache.snapshot()
}

function activeServiceKernelSourcePreflight(store) {
  if (
    activeServiceKernelMaxSourceConnections > 0
    && store.connectionCount > activeServiceKernelMaxSourceConnections
  ) {
    return {
      eligible: false,
      reason: 'source_connection_guard',
      detail: `The ${store.connectionCount.toLocaleString()}-connection source exceeds the ${activeServiceKernelMaxSourceConnections.toLocaleString()} source preflight guard.`,
      sourceConnections: store.connectionCount,
      maxSourceConnections: activeServiceKernelMaxSourceConnections || null,
    }
  }
  return {
    eligible: true,
    reason: activeServiceKernelMaxSourceConnections > 0 ? 'eligible' : 'unbounded',
    sourceConnections: store.connectionCount,
    maxSourceConnections: activeServiceKernelMaxSourceConnections || null,
    engine: 'rust_exact_connection_scan',
  }
}

function invalidateNationalStore(storePath) {
  const resolvedPath = path.resolve(storePath)
  const cached = nationalStoreCache.get(resolvedPath)
  if (cached) {
    try { cached.db.close() } catch {}
    nationalStoreCache.delete(resolvedPath)
  }
  for (const cacheKey of serviceAccessAnchorCache.keys()) {
    if (cacheKey.startsWith(`${resolvedPath}\u0000`)) {
      serviceAccessAnchorCache.delete(cacheKey)
    }
  }
}

export function disposeNationalGtfsStore(storePath) {
  const resolvedPath = path.resolve(storePath)
  invalidateNationalStore(resolvedPath)
}

export function disposeAllNationalGtfsStores() {
  for (const storePath of [...nationalStoreCache.keys()]) invalidateNationalStore(storePath)
  serviceAccessAnchorCache.clear()
}

function boundedCacheGet(cache, key) {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

function boundedCacheSet(cache, key, value, limit) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value)
}

function gtfsSeconds(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (minutes > 59 || seconds > 59) return null
  return Number(match[1]) * 3600 + minutes * 60 + seconds
}

function yyyymmdd(value) {
  return Number(String(value ?? '').replace(/-/g, '')) || 0
}

function requiredGtfsDate(value, field, context = '') {
  const text = String(value ?? '').trim()
  if (!/^\d{8}$/.test(text)) {
    throw new Error(`Invalid GTFS ${field}${context ? ` for ${context}` : ''}: ${text || '(missing)'}.`)
  }
  const year = Number(text.slice(0, 4))
  const month = Number(text.slice(4, 6))
  const day = Number(text.slice(6, 8))
  // Date.UTC maps years 0-99 to 1900-1999. Construct the date first and set
  // the complete year explicitly so GTFS validation agrees with the public
  // YYYY-MM-DD service-date contract for every four-digit year.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(12, 0, 0, 0)
  if (
    year < 1
    || year > 9999
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid GTFS ${field}${context ? ` for ${context}` : ''}: ${text}.`)
  }
  return Number(text)
}

function requiredGtfsEnum(value, allowed, field, context = '', defaultValue = undefined) {
  const text = String(value ?? '').trim()
  if (!text && defaultValue !== undefined) return defaultValue
  const parsed = Number(text)
  if (!Number.isInteger(parsed) || !allowed.includes(parsed)) {
    throw new Error(`Invalid GTFS ${field}${context ? ` for ${context}` : ''}: ${text || '(missing)'}.`)
  }
  return parsed
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function configureBuildDatabase(db) {
  db.exec(`PRAGMA page_size=${buildSqlitePageSize}; PRAGMA journal_mode=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-${buildSqliteCacheKiB};`)
}

function runTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE')
  try {
    callback()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function runTemporaryTransaction(db, callback) {
  // active_services lives in TEMP. A deferred transaction lets SQLite keep the
  // write entirely on the per-connection temp database instead of reserving the
  // immutable GTFS file and serializing otherwise independent route workers.
  db.exec('BEGIN')
  try {
    callback()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function metadataRecord(db) {
  const metadata = {}
  for (const row of db.prepare('SELECT key, value FROM metadata').all()) {
    try {
      metadata[row.key] = JSON.parse(row.value)
    } catch {
      metadata[row.key] = row.value
    }
  }
  return metadata
}

function routingStoreAdmissionError(storePath, reason, detail) {
  const message = [
    `Routing store admission failed for ${storePath}: ${detail}`,
    `Expected an exact current ${storeSchemaVersion} SQLite store.`,
    'Rebuild the routing store from the source GTFS instead of modifying it in place.',
  ].join(' ')
  const error = new Error(message)
  error.code = 'VIGO_ROUTING_STORE_ADMISSION_FAILED'
  error.reason = reason
  error.storePath = storePath
  return error
}

function admitRoutingStoreVersion(storePath, metadata) {
  if (metadata.schemaVersion !== storeSchemaVersion) {
    throw routingStoreAdmissionError(storePath, 'schema_version_mismatch',
      `metadata.schemaVersion is ${JSON.stringify(metadata.schemaVersion)}.`)
  }
  if (metadata.transferSemanticsVersion !== transferSemanticsVersion) {
    throw routingStoreAdmissionError(
      storePath,
      'transfer_semantics_mismatch',
      `Transfer semantics are ${String(metadata.transferSemanticsVersion ?? 'unspecified')}; ${transferSemanticsVersion} is required.`,
    )
  }
}

function admitCurrentTransferSemantics(db, storePath, metadata = metadataRecord(db)) {
  admitRoutingStoreVersion(storePath, metadata)
  const hasTransferProvenance = db.prepare(`
    SELECT 1 AS ready
    FROM sqlite_master
    WHERE type='table' AND name='transfer_provenance'
  `).get()?.ready === 1
  if (!hasTransferProvenance) {
    throw routingStoreAdmissionError(
      storePath,
      'transfer_provenance_missing',
      `${transferSemanticsVersion} requires a complete transfer_provenance table.`,
    )
  }
  if (db.prepare(`
    SELECT 1 AS invalid
    FROM (
      SELECT from_stop_id, to_stop_id FROM transfers
      EXCEPT
      SELECT from_stop_id, to_stop_id FROM transfer_provenance
    )
    LIMIT 1
  `).get()?.invalid === 1) {
    throw routingStoreAdmissionError(
      storePath,
      'transfer_provenance_incomplete',
      'A routable transfer lacks provenance.',
    )
  }
  return metadata
}

function admitNationalRoutingStore(db, storePath) {
  const startedAt = monotonicNow()
  const requiredTableNames = routingStoreTableNames
  let departureIndexState = 'ready'
  try {
    const row = db.prepare(
      "SELECT value FROM metadata WHERE key='departureIndexState'",
    ).get()
    if (row?.value !== undefined) departureIndexState = JSON.parse(String(row.value))
  } catch {}
  const deferredDepartureIndex = departureIndexState === 'deferred'
  const requiredIndexNames = Object.keys(routingStoreIndexTables).filter((name) => (
    !deferredDepartureIndex || name !== 'connections_from_departure_cover'
  ))
  const requiredObjectNames = [...requiredTableNames, ...requiredIndexNames]
  const placeholders = requiredObjectNames.map(() => '?').join(',')
  let schemaRows
  try {
    schemaRows = db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY type, name
    `).all(...requiredObjectNames)
  } catch (error) {
    throw routingStoreAdmissionError(
      storePath,
      'schema_catalog_unreadable',
      `SQLite could not read the schema catalog (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  const schemaByName = new Map(schemaRows.map((row) => [String(row.name), row]))

  for (const tableName of requiredTableNames) {
    const object = schemaByName.get(tableName)
    if (!object) {
      throw routingStoreAdmissionError(storePath, 'required_table_missing', `Required table "${tableName}" is missing.`)
    }
    if (object.type !== 'table' || object.tbl_name !== tableName) {
      throw routingStoreAdmissionError(
        storePath,
        'required_table_wrong_type',
        `Required table "${tableName}" resolves to ${object.type}:${object.tbl_name}.`,
      )
    }
  }

  for (const [indexName, tableName] of Object.entries(routingStoreIndexTables)) {
    if (!requiredIndexNames.includes(indexName)) continue
    const object = schemaByName.get(indexName)
    if (!object) {
      throw routingStoreAdmissionError(storePath, 'required_index_missing', `Required index "${indexName}" is missing.`)
    }
    if (object.type !== 'index' || object.tbl_name !== tableName) {
      throw routingStoreAdmissionError(
        storePath,
        'required_index_wrong_target',
        `Required index "${indexName}" resolves to ${object.type}:${object.tbl_name}; expected index:${tableName}.`,
      )
    }
  }

  let metadata
  try {
    metadata = metadataRecord(db)
  } catch (error) {
    throw routingStoreAdmissionError(
      storePath,
      'metadata_unreadable',
      `SQLite could not read store metadata (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  const schemaVersion = metadata.schemaVersion
  if (schemaVersion === undefined) {
    throw routingStoreAdmissionError(storePath, 'schema_version_missing', 'metadata.schemaVersion is missing.')
  }
  admitRoutingStoreVersion(storePath, metadata)
  return {
    metadata,
    admission: Object.freeze({
      status: 'admitted',
      schemaVersion,
      requiredTableCount: requiredTableNames.length,
      requiredIndexCount: requiredIndexNames.length,
      departureIndexState,
      metadataRows: Object.keys(metadata).length,
      admissionMs: Number((monotonicNow() - startedAt).toFixed(3)),
      integrityScan: 'not_run_on_open',
      authoritativeConnection: 'read_only',
      temporaryState: 'connection_local',
    }),
  }
}

export function compactNationalGtfsRuntimeStore(storePath) {
  const resolvedPath = path.resolve(storePath)
  const beforeBytes = fs.statSync(resolvedPath).size
  const inspection = new DatabaseSync(resolvedPath, { readOnly: true })
  let alreadyDeferred = false
  try {
    const { metadata } = admitNationalRoutingStore(inspection, resolvedPath)
    admitCurrentTransferSemantics(inspection, resolvedPath, metadata)
    alreadyDeferred = metadata.departureIndexState === 'deferred'
  } finally {
    inspection.close()
  }
  if (alreadyDeferred) {
    return {
      ready: true,
      built: false,
      state: 'deferred',
      beforeBytes,
      afterBytes: beforeBytes,
      bytesSaved: 0,
    }
  }
  invalidateNationalStore(resolvedPath)
  const database = new DatabaseSync(resolvedPath)
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec('DROP INDEX IF EXISTS connections_from_departure_cover')
    database.prepare(`
      INSERT INTO metadata(key,value) VALUES('departureIndexState', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(JSON.stringify('deferred'))
    database.exec('COMMIT')
    database.exec('VACUUM')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    database.close()
  }
  // Compaction changes the authoritative generation. Its old sidecars and
  // snapshots must be retired before any subsequent preparation.
  const prefix = `${path.basename(resolvedPath)}.`
  for (const entry of fs.readdirSync(path.dirname(resolvedPath), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    const suffix = entry.name.slice(prefix.length)
    if (suffix === 'static-topology.sqlite' || suffix === 'access-context.bin'
      || /^active-service-kernel\..+\.bin$/.test(suffix)
      || /^native-access-profile\..+\.bin$/.test(suffix)) {
      fs.rmSync(path.join(path.dirname(resolvedPath), entry.name))
    }
  }
  const afterBytes = fs.statSync(resolvedPath).size
  return {
    ready: true,
    built: true,
    state: 'deferred',
    beforeBytes,
    afterBytes,
    bytesSaved: beforeBytes - afterBytes,
  }
}

function immutableJsonSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJsonSnapshot))
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, immutableJsonSnapshot(entry)]),
    ))
  }
  return value
}

function supportedScheduledCoreCoverage(store) {
  const excludedFeatures = (store.routingLimitations ?? [])
    .filter((feature) => supportedScheduledCoreLimitationCodes.has(feature.code))
    .map((feature) => ({
      code: feature.code,
      count: Number(feature.count ?? 0),
      detail: feature.detail,
    }))
  return {
    mode: excludedFeatures.length ? 'supported_scheduled_core' : 'complete_supported_feed',
    complete: excludedFeatures.length === 0,
    excludedFeatures,
  }
}

function staticTopologySourceFingerprint(metadata) {
  return String(metadata.sourceFingerprint ?? metadata.storeId ?? '')
}

function staticTopologySourceIdentity(metadata) {
  return stableJson({
    identityVersion: staticTopologySourceIdentityVersion,
    storeId: metadata.storeId ?? null,
    schemaVersion: metadata.schemaVersion ?? null,
    connectionCount: Number(metadata.connectionCount ?? -1),
    transferCount: Number(metadata.transferCount ?? -1),
    transferSemanticsVersion: metadata.transferSemanticsVersion ?? null,
    transferGeneration: metadata.transferGeneration ?? null,
    stopCount: Number(metadata.stopCount ?? -1),
    bridgedUntimedGapCount: Number(metadata.bridgedUntimedGapCount ?? -1),
  })
}

function staticTopologySourceMatches(
  artifactMetadata,
  sourceMetadata,
  sourceGeneration = '',
) {
  return artifactMetadata.staticTopologySourceIdentity === staticTopologySourceIdentity(sourceMetadata)
    && artifactMetadata.staticTopologySourceGeneration === sourceGeneration
}

function staticTopologySourceStorageIdentity(storePath) {
  return sqliteStoreStatSignature(storePath)
}

function sqliteFileStatSignature(filePath) {
  const stats = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false })
  if (!stats) return ''
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`
}

function sqliteStoreStatSignature(storePath) {
  return `${sqliteFileStatSignature(storePath)}|${sqliteFileStatSignature(`${storePath}-wal`)}`
}

function sqliteFileGeneration(filePath, headerBytes) {
  const stats = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false })
  if (!stats) return ''
  const header = Buffer.alloc(headerBytes)
  const handle = fs.openSync(filePath, 'r')
  let bytesRead
  try {
    bytesRead = fs.readSync(handle, header, 0, header.length, 0)
  } finally {
    fs.closeSync(handle)
  }
  if (bytesRead < headerBytes) return `${stats.size}:short`
  if (
    headerBytes === 100
    && header.subarray(0, 16).equals(Buffer.from('SQLite format 3\u0000'))
  ) {
    return [
      stats.size,
      header.readUInt32BE(24),
      header.readUInt32BE(28),
      header.readUInt32BE(40),
      header.readUInt32BE(92),
    ].join(':')
  }
  return [
    stats.size,
    header.readUInt32BE(0),
    header.readUInt32BE(12),
    header.readUInt32BE(16),
    header.readUInt32BE(20),
  ].join(':')
}

function sqliteStoreGeneration(storePath) {
  return `${sqliteFileGeneration(storePath, 100)}|${sqliteFileGeneration(`${storePath}-wal`, 32)}`
}

function staticTopologySourceStorageSnapshot(storePath) {
  // Read twice so a concurrently replaced SQLite file is not admitted as a
  // stable cache baseline.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const statSignature = sqliteStoreStatSignature(storePath)
    if (sqliteStoreStatSignature(storePath) === statSignature) {
      return statSignature
    }
  }
  throw new Error('Routing store changed repeatedly while its source identity was being read.')
}

function streetStoreStorageSnapshot(storePath) {
  const resolvedPath = path.resolve(storePath)
  // Keep the storage key cheap; the store admission path remains responsible
  // for opening and validating the SQLite file before it is used.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const statSignature = sqliteStoreStatSignature(resolvedPath)
    if (sqliteStoreStatSignature(resolvedPath) === statSignature) {
      return statSignature
    }
  }
  throw new Error('Street store changed repeatedly while its storage identity was being read.')
}

function currentStreetStoreStorageIdentity(storePath) {
  if (!storePath) return 'direct'
  const resolvedPath = path.resolve(storePath)
  const statSignature = sqliteStoreStatSignature(resolvedPath)
  const cached = streetStorageIdentityCache.get(resolvedPath)
  if (cached === statSignature) {
    streetStorageIdentityCache.delete(resolvedPath)
    streetStorageIdentityCache.set(resolvedPath, cached)
    return cached
  }
  const snapshot = streetStoreStorageSnapshot(resolvedPath)
  streetStorageIdentityCache.delete(resolvedPath)
  streetStorageIdentityCache.set(resolvedPath, snapshot)
  while (streetStorageIdentityCache.size > streetStorageIdentityCacheMaxEntries) {
    const oldestPath = streetStorageIdentityCache.keys().next().value
    if (oldestPath === undefined) break
    streetStorageIdentityCache.delete(oldestPath)
  }
  return snapshot
}

function currentStaticTopologySourceStorageIdentity(store) {
  if (sqliteStoreStatSignature(store.storePath) === store.sourceStorageIdentity) {
    return store.sourceStorageIdentity
  }
  return staticTopologySourceStorageSnapshot(store.storePath)
}

function inspectStaticTopologyDatabase(db) {
  const tablePresent = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='static_topology_edges'").get()?.present === 1
  if (!tablePresent) return { ready: false, reason: 'table_absent', version: staticTopologySchemaVersion }
  const reverseIndexPresent = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='static_topology_edges_to'").get()?.present === 1
  if (!reverseIndexPresent) return { ready: false, reason: 'reverse_index_absent', version: staticTopologySchemaVersion }
  const metadata = metadataRecord(db)
  if (!metadata.staticTopologyVersion || !metadata.staticTopologySourceFingerprint) {
    return { ready: false, reason: 'metadata_absent', version: staticTopologySchemaVersion }
  }
  if (metadata.staticTopologyVersion !== staticTopologySchemaVersion) {
    return {
      ready: false,
      reason: 'version_mismatch',
      version: metadata.staticTopologyVersion,
      expectedVersion: staticTopologySchemaVersion,
    }
  }
  const sourceFingerprint = staticTopologySourceFingerprint(metadata)
  if (!staticTopologySourceMatches(
    metadata,
    metadata,
    metadata.staticTopologySourceGeneration ?? '',
  )) {
    return { ready: false, reason: 'source_mismatch', version: staticTopologySchemaVersion }
  }
  return {
    ready: true,
    reason: 'ready',
    version: staticTopologySchemaVersion,
    edgeCount: Number(metadata.staticTopologyEdgeCount ?? 0),
    builtAt: metadata.staticTopologyBuiltAt,
    sourceFingerprint,
  }
}

function report(onProgress, phase, progress, detail = '') {
  onProgress?.({ phase, progress, detail, memory: process.memoryUsage().rss })
}

export function nationalStaticTopologySidecarPath(storePath) {
  return `${path.resolve(storePath)}.static-topology.sqlite`
}

function routingArtifactSourceIdentity(storePath, sourceMetadata) {
  return `${staticTopologySourceIdentity(sourceMetadata)}\n${sqliteStoreGeneration(storePath)}`
}

async function pruneNationalActiveServiceKernelSnapshots(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  const directory = path.dirname(resolvedStorePath)
  const prefix = `${path.basename(resolvedStorePath)}.active-service-kernel.`
  const removed = []
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    if (!entry.name.endsWith('.bin') && !(entry.name.includes('.bin.') && entry.name.endsWith('.tmp'))) continue
    const artifactPath = path.join(directory, entry.name)
    const stats = await fsp.stat(artifactPath).catch(() => null)
    await fsp.rm(artifactPath, { force: true })
    removed.push({ path: artifactPath, bytes: Number(stats?.size ?? 0) })
  }
  return {
    removed,
    removedCount: removed.length,
    removedBytes: removed.reduce((sum, artifact) => sum + artifact.bytes, 0),
  }
}

async function refreshNationalGtfsDerivedArtifacts(storePath, options = {}) {
  const resolvedStorePath = path.resolve(storePath)
  const sidecarPath = path.resolve(options.sidecarPath ?? nationalStaticTopologySidecarPath(resolvedStorePath))
  disposeNationalGtfsStore(resolvedStorePath)
  const before = inspectNationalStaticTopologySidecar(resolvedStorePath, sidecarPath)
  const staticTopology = await buildNationalStaticTopologySidecar({
    storePath: resolvedStorePath,
    outputPath: sidecarPath,
    onProgress: options.onProgress,
    minimumFreeBytes: options.minimumFreeBytes,
    force: true,
  })
  disposeNationalGtfsStore(resolvedStorePath)
  const activeServiceKernels = await pruneNationalActiveServiceKernelSnapshots(resolvedStorePath)
  const attestation = inspectNationalStaticTopologySidecar(resolvedStorePath, sidecarPath)
  if (!attestation.ready) {
    throw new Error(`Static-topology refresh did not produce a current sidecar: ${attestation.reason}.`)
  }
  return {
    schemaVersion: 'vigo.routing.derived-artifact-refresh.v1',
    storePath: resolvedStorePath,
    sidecarPath,
    before,
    staticTopology,
    activeServiceKernels,
    attestation,
  }
}

export async function ensureNationalGtfsDerivedArtifactsCurrent(storePath, options = {}) {
  const resolvedStorePath = path.resolve(storePath)
  readNationalGtfsStoreMetadata(resolvedStorePath)
  const sidecarPath = path.resolve(
    options.sidecarPath ?? nationalStaticTopologySidecarPath(resolvedStorePath),
  )
  const embedded = inspectNationalStaticTopology(resolvedStorePath)
  const sidecar = inspectNationalStaticTopologySidecar(
    resolvedStorePath,
    sidecarPath,
  )
  const current = sidecar.ready ? sidecar : embedded.ready ? embedded : null
  if (current) {
    return {
      schemaVersion: 'vigo.routing.derived-artifact-admission.v1',
      ready: true,
      refreshed: false,
      source: sidecar.ready ? 'sidecar' : 'embedded',
      storePath: resolvedStorePath,
      sidecarPath,
      embedded,
      before: sidecar,
      attestation: current,
    }
  }
  options.onProgress?.({
    phase: 'Repairing derived routing topology',
    progress: 0,
    detail: `${sidecar.reason ?? 'sidecar unavailable'} / ${embedded.reason ?? 'embedded topology unavailable'}`,
  })
  const refreshed = await refreshNationalGtfsDerivedArtifacts(
    resolvedStorePath,
    {
      ...options,
      sidecarPath,
    },
  )
  return {
    ...refreshed,
    schemaVersion: 'vigo.routing.derived-artifact-admission.v1',
    ready: true,
    refreshed: true,
    source: 'sidecar',
    embedded,
  }
}

function adaptiveStaticTopologyReserveBytes(sourceBytes, ceilingBytes = staticTopologyMinimumFreeBytes) {
  return Math.min(
    Math.max(staticTopologyReserveFloorBytes, numeric(ceilingBytes, staticTopologyMinimumFreeBytes)),
    Math.max(
      staticTopologyReserveFloorBytes,
      numeric(sourceBytes, 0) * staticTopologySourceGrowthFactor + staticTopologyReserveFloorBytes,
    ),
  )
}

async function buildDefaultStaticTopologySidecar(tempStorePath, outputStorePath, onProgress) {
  const finalPath = nationalStaticTopologySidecarPath(outputStorePath)
  const stagedPath = `${finalPath}.next`
  const sourceBytes = Number((await fsp.stat(tempStorePath)).size)
  // A fixed multi-gigabyte reserve makes tiny, disposable stores impossible to
  // build on otherwise healthy low-space systems. Scale the reserve with the
  // source while retaining the existing 2 GiB ceiling for large production
  // feeds. The sidecar builder still retains a 128 MiB post-build reserve, a
  // separate 64 MiB transient-workspace allowance, and a SQLite page-count
  // guard. Those bounds let tiny disposable feeds build on constrained local
  // machines without weakening the source-size-derived guard for large feeds.
  const minimumFreeBytes = adaptiveStaticTopologyReserveBytes(sourceBytes)
  await Promise.all([
    fsp.rm(stagedPath, { force: true }),
    fsp.rm(`${stagedPath}.building`, { force: true }),
  ])
  const result = await buildNationalStaticTopologySidecar({
    storePath: tempStorePath,
    outputPath: stagedPath,
    minimumFreeBytes,
    onProgress: onProgress ? (event) => report(
      onProgress,
      event.phase,
      0.91 + Math.max(0, Math.min(1, event.progress)) * 0.08,
      event.detail,
    ) : undefined,
  })
  return { ...result, stagedPath, outputPath: finalPath }
}

async function publishRoutingStoreWithSidecar(tempStorePath, outputStorePath, topology) {
  const finalSidecarPath = topology.outputPath
  const backupSidecarPath = `${finalSidecarPath}.previous`
  const hadPreviousSidecar = fs.existsSync(finalSidecarPath)
  await fsp.rm(backupSidecarPath, { force: true })
  invalidateNationalStore(outputStorePath)
  if (hadPreviousSidecar) await fsp.rename(finalSidecarPath, backupSidecarPath)
  let sidecarPublished = false
  try {
    await fsp.rename(topology.stagedPath, finalSidecarPath)
    sidecarPublished = true
    await fsp.rename(tempStorePath, outputStorePath)
  } catch (error) {
    if (sidecarPublished) await fsp.rm(finalSidecarPath, { force: true })
    if (hadPreviousSidecar && fs.existsSync(backupSidecarPath)) await fsp.rename(backupSidecarPath, finalSidecarPath)
    throw error
  }
  await fsp.rm(backupSidecarPath, { force: true })
  return { ...topology, stagedPath: undefined, outputPath: finalSidecarPath }
}

async function finalizeRoutingStoreBuild(db, tempPath, outputPath, onProgress, { forCity = false } = {}) {
  db.exec('PRAGMA optimize;')
  db.close()
  if (forCity) {
    // The City compiler adds OSM transfers before publishing its final topology.
    // These files remain inside the City's unpublished staging directory.
    await fsp.rename(tempPath, outputPath)
    return { staticTopology: { ready: false, reason: 'city_transfers_pending' }, outputStats: await fsp.stat(outputPath) }
  }
  const topology = await buildDefaultStaticTopologySidecar(tempPath, outputPath, onProgress)
  const staticTopology = await publishRoutingStoreWithSidecar(tempPath, outputPath, topology)
  return { staticTopology, outputStats: await fsp.stat(outputPath) }
}

async function cleanupFailedRoutingStoreBuild(databases, tempPath, outputPath, extraPaths = []) {
  for (const db of databases) {
    try { db.close() } catch {}
  }
  await Promise.all([
    tempPath,
    `${nationalStaticTopologySidecarPath(outputPath)}.next`,
    `${nationalStaticTopologySidecarPath(outputPath)}.next.building`,
    ...extraPaths,
  ].map((filePath) => fsp.rm(filePath, { force: true })))
}

function createRoutingStoreSchema(db) {
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL, lon REAL, parent_station TEXT, location_type INTEGER, platform_code TEXT);
    CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, route_type INTEGER, color TEXT);
    CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT);
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
    CREATE TABLE trip_shapes(trip_id TEXT PRIMARY KEY, shape_id TEXT NOT NULL);
    CREATE TABLE shape_points(shape_id TEXT NOT NULL, sequence INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, PRIMARY KEY(shape_id, sequence)) WITHOUT ROWID;
    CREATE TABLE calendar(service_id TEXT PRIMARY KEY, monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER, start_date INTEGER, end_date INTEGER);
    CREATE TABLE calendar_dates(service_id TEXT NOT NULL, date INTEGER NOT NULL, exception_type INTEGER NOT NULL, PRIMARY KEY(service_id, date));
    CREATE TABLE transfers(from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, transfer_type INTEGER, min_transfer_time INTEGER, PRIMARY KEY(from_stop_id, to_stop_id));
    CREATE TABLE transfer_provenance(
      from_stop_id TEXT NOT NULL,
      to_stop_id TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK(provenance IN ('gtfs_transfer', 'gtfs_pathway', 'schedule_transfer', 'schedule_pathway', 'osm_certified_radial')),
      evidence_fingerprint TEXT,
      path_distance_m REAL,
      CHECK(
        (provenance='osm_certified_radial' AND evidence_fingerprint IS NOT NULL AND path_distance_m>=0)
        OR (provenance='gtfs_pathway' AND evidence_fingerprint IS NULL AND path_distance_m>=0)
        OR (provenance!='osm_certified_radial' AND evidence_fingerprint IS NULL AND path_distance_m IS NULL)
      ),
      PRIMARY KEY(from_stop_id, to_stop_id)
    ) WITHOUT ROWID;
    CREATE TABLE frequencies(trip_id TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, headway_secs INTEGER NOT NULL, exact_times INTEGER);
    CREATE TABLE connections(departure INTEGER NOT NULL, arrival INTEGER NOT NULL, trip_id TEXT NOT NULL, route_id TEXT NOT NULL, service_id TEXT NOT NULL, direction_id TEXT, from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL, PRIMARY KEY(trip_id, stop_sequence)) WITHOUT ROWID;
    CREATE TABLE connection_permissions(
      trip_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      can_board INTEGER NOT NULL,
      can_alight INTEGER NOT NULL,
      PRIMARY KEY(trip_id, stop_sequence)
    ) WITHOUT ROWID;
    CREATE TABLE stop_access_roles(
      stop_id TEXT PRIMARY KEY,
      can_board INTEGER NOT NULL CHECK(can_board IN (0, 1)),
      can_alight INTEGER NOT NULL CHECK(can_alight IN (0, 1))
    ) WITHOUT ROWID;
  `)
}

function assertNoBrokenGtfsReferences(db) {
  const checks = [
    {
      query: `
        SELECT trips.trip_id AS owner_id, trips.route_id AS referenced_id
        FROM trips LEFT JOIN routes ON routes.route_id=trips.route_id
        WHERE routes.route_id IS NULL LIMIT 1
      `,
      relation: 'trips.route_id -> routes.route_id',
    },
    {
      query: `
        SELECT trips.trip_id AS owner_id, trips.service_id AS referenced_id
        FROM trips
        WHERE NOT EXISTS (SELECT 1 FROM calendar WHERE calendar.service_id=trips.service_id)
          AND NOT EXISTS (SELECT 1 FROM calendar_dates WHERE calendar_dates.service_id=trips.service_id)
        LIMIT 1
      `,
      relation: 'trips.service_id -> calendar/calendar_dates.service_id',
    },
    {
      query: `
        SELECT stops.stop_id AS owner_id, stops.parent_station AS referenced_id
        FROM stops LEFT JOIN stops AS parents ON parents.stop_id=stops.parent_station
        WHERE stops.parent_station IS NOT NULL AND parents.stop_id IS NULL LIMIT 1
      `,
      relation: 'stops.parent_station -> stops.stop_id',
    },
    {
      query: `
        SELECT transfers.from_stop_id AS owner_id, transfers.from_stop_id AS referenced_id
        FROM transfers LEFT JOIN stops ON stops.stop_id=transfers.from_stop_id
        WHERE stops.stop_id IS NULL LIMIT 1
      `,
      relation: 'transfers.from_stop_id -> stops.stop_id',
    },
    {
      query: `
        SELECT transfers.to_stop_id AS owner_id, transfers.to_stop_id AS referenced_id
        FROM transfers LEFT JOIN stops ON stops.stop_id=transfers.to_stop_id
        WHERE stops.stop_id IS NULL LIMIT 1
      `,
      relation: 'transfers.to_stop_id -> stops.stop_id',
    },
    {
      query: `
        SELECT frequencies.trip_id AS owner_id, frequencies.trip_id AS referenced_id
        FROM frequencies LEFT JOIN trips ON trips.trip_id=frequencies.trip_id
        WHERE trips.trip_id IS NULL LIMIT 1
      `,
      relation: 'frequencies.trip_id -> trips.trip_id',
    },
  ]
  for (const check of checks) {
    const violation = db.prepare(check.query).get()
    if (!violation) continue
    throw new Error(
      `Broken GTFS reference ${check.relation}: ${violation.owner_id || '(missing)'} references ${violation.referenced_id || '(missing)'}.`,
    )
  }
}

function ensureRouteServiceCatalogSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_services(
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
    CREATE INDEX IF NOT EXISTS route_services_representative ON route_services(representative_route_id);
    CREATE INDEX IF NOT EXISTS route_services_trip_rank ON route_services(source_scope, trip_count DESC, route_type, service_key);
  `)
}

function refreshRouteServiceCatalog(db) {
  ensureRouteServiceCatalogSchema(db)
  db.exec(`
    DELETE FROM route_services;
    INSERT INTO route_services(
      source_scope, route_type, service_key, representative_route_id,
      short_name, long_name, color, variant_count, trip_count
    )
    WITH route_trip_counts AS (
      SELECT route_id, COUNT(*) AS trip_count
      FROM trips INDEXED BY trips_route
      GROUP BY route_id
    )
    SELECT
      CASE
        WHEN INSTR(route.route_id, CHAR(31)) > 0
          THEN SUBSTR(route.route_id, 1, INSTR(route.route_id, CHAR(31)) - 1)
        ELSE ''
      END AS source_scope,
      COALESCE(route.route_type, 3) AS route_type,
      CASE
        WHEN INSTR(route.route_id, CHAR(31)) > 0
          THEN SUBSTR(route.route_id, INSTR(route.route_id, CHAR(31)) + 1)
        ELSE route.route_id
      END AS service_key,
      route.route_id,
      route.short_name,
      route.long_name,
      route.color,
      1 AS variant_count,
      COALESCE(route_trip_counts.trip_count, 0) AS trip_count
    FROM routes AS route
    LEFT JOIN route_trip_counts ON route_trip_counts.route_id=route.route_id;
  `)
}

function rebuildStopAccessRoles(db) {
  const hasConnectionPermissions = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type='table' AND name='connection_permissions'
  `).get()?.present === 1
  const permissionJoin = hasConnectionPermissions
    ? `LEFT JOIN connection_permissions AS permission
        ON permission.trip_id=connection.trip_id
        AND permission.stop_sequence=connection.stop_sequence`
    : ''
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_access_roles(
      stop_id TEXT PRIMARY KEY,
      can_board INTEGER NOT NULL CHECK(can_board IN (0, 1)),
      can_alight INTEGER NOT NULL CHECK(can_alight IN (0, 1))
    ) WITHOUT ROWID;
    DELETE FROM stop_access_roles;
    INSERT OR IGNORE INTO stop_access_roles(stop_id, can_board, can_alight)
    SELECT connection.from_stop_id, 1, 0
    FROM connections AS connection
    ${permissionJoin}
    WHERE ${hasConnectionPermissions ? 'COALESCE(permission.can_board, 1)' : '1'}=1;
    INSERT INTO stop_access_roles(stop_id, can_board, can_alight)
    SELECT connection.to_stop_id, 0, 1
    FROM connections AS connection
    ${permissionJoin}
    WHERE ${hasConnectionPermissions ? 'COALESCE(permission.can_alight, 1)' : '1'}=1
    ON CONFLICT(stop_id) DO UPDATE SET can_alight=1;
  `)
  return Number(db.prepare('SELECT COUNT(*) AS count FROM stop_access_roles').get()?.count ?? 0)
}

// The covering departure index belongs to the raw-build SQL lane only. Runtime
// routing uses the in-memory/native active-service representation; compacted
// stores intentionally do not retain or recreate this index.
function ensureNationalGtfsRawSqlDepartureIndex(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS connections_from_departure_cover
      ON connections(from_stop_id, departure, service_id, trip_id, stop_sequence, arrival, to_stop_id);
  `)
}

function createRoutingStoreIndexes(db, { forCity = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_modes AS
      SELECT COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id) AS stop_id,
        r.route_type AS route_type, COUNT(*) AS departure_count
      FROM connections c
      JOIN stops s ON s.stop_id=c.from_stop_id
      JOIN routes r ON r.route_id=c.route_id
      LEFT JOIN connection_permissions permission
        ON permission.trip_id=c.trip_id AND permission.stop_sequence=c.stop_sequence
      WHERE COALESCE(permission.can_board, 1)=1
      GROUP BY COALESCE(NULLIF(s.parent_station, ''), c.from_stop_id), r.route_type;
    CREATE UNIQUE INDEX IF NOT EXISTS stop_modes_stop_type ON stop_modes(stop_id, route_type);
    CREATE INDEX IF NOT EXISTS stop_modes_type_stop ON stop_modes(route_type, stop_id);
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
  `)
  if (!forCity) ensureNationalGtfsRawSqlDepartureIndex(db)
  rebuildStopAccessRoles(db)
  refreshRouteServiceCatalog(db)
  db.exec('ANALYZE;')
}

export async function ensureNationalGtfsStopAccessRoles(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  const startedAt = performance.now()
  // Reject old source semantics before opening any writable connection.
  readNationalGtfsStoreMetadata(resolvedStorePath)
  let database = new DatabaseSync(resolvedStorePath)
  try {
    const metadata = metadataRecord(database)
    const tableReady = database.prepare(`
      SELECT 1 AS ready
      FROM sqlite_master
      WHERE type='table' AND name='stop_access_roles'
    `).get()?.ready === 1
    const retainedRows = tableReady
      ? Number(database.prepare('SELECT COUNT(*) AS count FROM stop_access_roles').get()?.count ?? 0)
      : 0
    if (
      metadata.stopAccessRoleIndexVersion === stopAccessRoleIndexVersion
      && Number(metadata.stopAccessRoleCount ?? -1) === retainedRows
    ) {
      return {
        ready: true,
        built: false,
        schemaVersion: stopAccessRoleIndexVersion,
        stopCount: retainedRows,
        buildMs: Number((performance.now() - startedAt).toFixed(3)),
      }
    }

    if (metadata.departureIndexState !== 'deferred') {
      ensureNationalGtfsRawSqlDepartureIndex(database)
    }

    invalidateNationalStore(resolvedStorePath)
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;')
    let stopCount
    try {
      stopCount = rebuildStopAccessRoles(database)
      const setMetadata = database.prepare(`
        INSERT INTO metadata(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `)
      setMetadata.run('stopAccessRoleIndexVersion', JSON.stringify(stopAccessRoleIndexVersion))
      setMetadata.run('stopAccessRoleCount', JSON.stringify(stopCount))
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;')
    return {
      ready: true,
      built: true,
      schemaVersion: stopAccessRoleIndexVersion,
      stopCount,
      buildMs: Number((performance.now() - startedAt).toFixed(3)),
    }
  } finally {
    database.close()
  }
}

function linkNearbyTransferStops(db, options = {}) {
  const maxDistanceKm = Math.max(0, numeric(options.maxDistanceKm, nearbyTransferMaxDistanceKm))
  if (!maxDistanceKm) return { inferredTransferCount: 0, stopCount: 0 }
  const stopPoints = db.prepare(`
    SELECT stop_id, lat, lon FROM stops
    WHERE lat IS NOT NULL AND lon IS NOT NULL AND COALESCE(location_type, 0)=0
  `).all()
  const cells = new Map()
  for (const stop of stopPoints) {
    const key = `${Math.floor(stop.lat / nearbyTransferCellDegrees)}:${Math.floor(stop.lon / nearbyTransferCellDegrees)}`
    const entries = cells.get(key) ?? []
    entries.push(stop)
    cells.set(key, entries)
  }

  let candidateCount = 0
  for (const stop of stopPoints) {
      const latCell = Math.floor(stop.lat / nearbyTransferCellDegrees)
      const lonCell = Math.floor(stop.lon / nearbyTransferCellDegrees)
      const latitudeRadius = Math.ceil((maxDistanceKm / 111.2) / nearbyTransferCellDegrees) + 1
      const longitudeKmPerDegree = 111.2 * Math.max(0.05, Math.cos(Number(stop.lat) * Math.PI / 180))
      const longitudeRadius = Math.min(20, Math.ceil((maxDistanceKm / longitudeKmPerDegree) / nearbyTransferCellDegrees) + 1)
      for (let latOffset = -latitudeRadius; latOffset <= latitudeRadius; latOffset += 1) {
        for (let lonOffset = -longitudeRadius; lonOffset <= longitudeRadius; lonOffset += 1) {
          for (const candidate of cells.get(`${latCell + latOffset}:${lonCell + lonOffset}`) ?? []) {
            if (String(candidate.stop_id).localeCompare(String(stop.stop_id)) <= 0) continue
            const distanceKm = haversineKm([stop.lon, stop.lat], [candidate.lon, candidate.lat])
            if (distanceKm > maxDistanceKm) continue
            candidateCount += 2
          }
        }
      }
  }
  return { candidateCount, inferredTransferCount: 0, stopCount: stopPoints.length }
}

function scopedId(scope, value) {
  return `${scope}\u001f${String(value ?? '')}`
}

function calendarWeekdays(trip) {
  const explicit = Array.isArray(trip.serviceCalendar?.weekdays) ? trip.serviceCalendar.weekdays : []
  if (explicit.length) return new Set(explicit.map(Number))
  const days = new Set()
  for (const serviceDay of trip.serviceDays ?? []) {
    if (serviceDay === 'weekday') [1, 2, 3, 4, 5].forEach((day) => days.add(day))
    else if (serviceDay === 'saturday') days.add(6)
    else if (serviceDay === 'sunday') days.add(0)
  }
  return days.size ? days : new Set([0, 1, 2, 3, 4, 5, 6])
}

export async function buildRoutingStoreFromSchedules({ schedules, outputPath, onProgress }) {
  const startedAt = performance.now()
  if (!Array.isArray(schedules) || !schedules.length) throw new Error('At least one persisted routing schedule is required.')
  const orderedSchedules = schedules
    .map((descriptor, index) => ({
      ...descriptor,
      feedId: String(descriptor.feedId || `feed-${index + 1}`),
      schedulePath: path.resolve(descriptor.schedulePath),
    }))
    .sort((left, right) => left.feedId.localeCompare(right.feedId) || left.schedulePath.localeCompare(right.schedulePath))
  if (new Set(orderedSchedules.map((descriptor) => descriptor.feedId)).size !== orderedSchedules.length) {
    throw new Error('Persisted routing schedule feed IDs must be unique.')
  }
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.building`
  await fsp.rm(tempPath, { force: true })
  const db = new DatabaseSync(tempPath)
  configureBuildDatabase(db)
  createRoutingStoreSchema(db)
  const insertStop = db.prepare('INSERT OR REPLACE INTO stops VALUES(?,?,?,?,?,?,?)')
  const insertRoute = db.prepare('INSERT OR IGNORE INTO routes VALUES(?,?,?,?,?)')
  const insertTrip = db.prepare('INSERT OR IGNORE INTO trips VALUES(?,?,?,?)')
  const insertCalendar = db.prepare('INSERT OR IGNORE INTO calendar VALUES(?,?,?,?,?,?,?,?,?,?)')
  const insertCalendarDate = db.prepare('INSERT OR REPLACE INTO calendar_dates VALUES(?,?,?)')
  const insertConnection = db.prepare('INSERT OR IGNORE INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  const insertTransfer = db.prepare('INSERT OR IGNORE INTO transfers VALUES(?,?,?,?)')
  const insertTransferProvenance = db.prepare('INSERT OR IGNORE INTO transfer_provenance VALUES(?,?,?,NULL,NULL)')
  let routeCount = 0
  let stopCount = 0
  let tripCount = 0
  let stopTimeCount = 0
  let connectionCount = 0
  let transferCount = 0
  let sourceBytes = 0
  const sourceHasher = crypto.createHash('sha256')
  sourceHasher.update('vigo.routing.schedule-sources.v1\u0000')
  try {
    for (let scheduleIndex = 0; scheduleIndex < orderedSchedules.length; scheduleIndex += 1) {
      const descriptor = orderedSchedules[scheduleIndex]
      const scope = descriptor.feedId
      report(onProgress, 'Reading persisted timetable', scheduleIndex / orderedSchedules.length * 0.55, path.basename(descriptor.schedulePath))
      const scheduleSource = await fsp.readFile(descriptor.schedulePath, 'utf8')
      sourceBytes += Buffer.byteLength(scheduleSource)
      sourceHasher.update(`${scope}\u0000${scheduleSource.length}\u0000`)
      sourceHasher.update(scheduleSource)
      sourceHasher.update('\u0000')
      const schedule = JSON.parse(scheduleSource)
      runTransaction(db, () => {
        for (const stop of schedule.stops ?? []) {
          const stopId = scopedId(scope, stop.id)
          const parentStation = stop.parentStationId ? scopedId(scope, stop.parentStationId) : null
          insertStop.run(stopId, stop.name || stop.id, numeric(stop.lat, null), numeric(stop.lon, null), parentStation, numeric(stop.locationType, 0), stop.platformCode || null)
          stopCount += 1
        }
      })
      let batchRows = 0
      db.exec('BEGIN IMMEDIATE')
      for (const route of schedule.routes ?? []) {
        const routeId = scopedId(scope, route.routeId || route.id)
        const insertedRoute = insertRoute.run(routeId, route.shortName || '', route.longName || '', numeric(route.routeType, 3), String(route.color || '').replace(/^#/, ''))
        routeCount += Number(insertedRoute.changes ?? 0)
        for (const trip of route.scheduledTrips ?? []) {
          const tripId = scopedId(scope, trip.tripId)
          const serviceId = scopedId(scope, trip.serviceId || `${trip.patternId || route.id}:service`)
          const insertedTrip = insertTrip.run(tripId, routeId, serviceId, trip.directionId ?? route.directionId ?? null)
          if (!Number(insertedTrip.changes ?? 0)) continue
          tripCount += 1
          const weekdays = calendarWeekdays(trip)
          insertCalendar.run(serviceId, Number(weekdays.has(1)), Number(weekdays.has(2)), Number(weekdays.has(3)), Number(weekdays.has(4)), Number(weekdays.has(5)), Number(weekdays.has(6)), Number(weekdays.has(0)), yyyymmdd(trip.serviceCalendar?.startDate) || 19000101, yyyymmdd(trip.serviceCalendar?.endDate) || 29991231)
          for (const date of trip.serviceCalendar?.addedDates ?? []) insertCalendarDate.run(serviceId, yyyymmdd(date), 1)
          for (const date of trip.serviceCalendar?.removedDates ?? []) insertCalendarDate.run(serviceId, yyyymmdd(date), 2)
          const times = trip.stopTimes ?? []
          stopTimeCount += times.length
          for (let index = 1; index < times.length; index += 1) {
            const from = times[index - 1]
            const to = times[index]
            const departure = numeric(from.departureMinutes ?? from.arrivalMinutes, NaN) * 60
            const arrival = numeric(to.arrivalMinutes ?? to.departureMinutes, NaN) * 60
            if (!Number.isFinite(departure) || !Number.isFinite(arrival) || arrival < departure) continue
            insertConnection.run(Math.round(departure), Math.round(arrival), tripId, routeId, serviceId, trip.directionId ?? route.directionId ?? null, scopedId(scope, from.stopId), scopedId(scope, to.stopId), numeric(from.sequence, index))
            connectionCount += 1
            batchRows += 1
            if (batchRows >= 250_000) {
              db.exec('COMMIT; BEGIN IMMEDIATE')
              batchRows = 0
              report(onProgress, 'Compiling transit connections', 0.55 + Math.min(0.25, connectionCount / Math.max(1, schedule.stopTimeCount ?? stopTimeCount) * 0.25), `${connectionCount.toLocaleString()} connections`)
            }
          }
        }
      }
      db.exec('COMMIT')
      runTransaction(db, () => {
        for (const transfer of schedule.transferRules ?? []) {
          const fromStopId = scopedId(scope, transfer.fromStopId)
          const toStopId = scopedId(scope, transfer.toStopId)
          const result = insertTransfer.run(fromStopId, toStopId, numeric(transfer.transferType, 0), numeric(transfer.minTransferTimeSeconds, 0))
          if (Number(result.changes ?? 0)) insertTransferProvenance.run(fromStopId, toStopId, 'schedule_transfer')
          transferCount += Number(result.changes ?? 0)
        }
        for (const pathway of schedule.pathways ?? []) {
          const fromStopId = scopedId(scope, pathway.fromStopId)
          const toStopId = scopedId(scope, pathway.toStopId)
          const result = insertTransfer.run(fromStopId, toStopId, 0, Math.max(0, numeric(pathway.traversalTimeSeconds, 0)))
          if (Number(result.changes ?? 0)) insertTransferProvenance.run(fromStopId, toStopId, 'schedule_pathway')
          transferCount += Number(result.changes ?? 0)
          if (pathway.isBidirectional) {
            const reverse = insertTransfer.run(toStopId, fromStopId, 0, Math.max(0, numeric(pathway.traversalTimeSeconds, 0)))
            if (Number(reverse.changes ?? 0)) insertTransferProvenance.run(toStopId, fromStopId, 'schedule_pathway')
            transferCount += Number(reverse.changes ?? 0)
          }
        }
      })
    }

    report(onProgress, 'Linking nearby interchanges', 0.82)
    const nearbyTransfers = linkNearbyTransferStops(db)
    report(onProgress, 'Building routing indexes', 0.9)
    createRoutingStoreIndexes(db)
    const sourceFingerprint = sourceHasher.digest('hex')
    const metadata = {
      schemaVersion: storeSchemaVersion,
      storeId: sourceFingerprint.slice(0, 20),
      sourceFingerprint,
      sourceFile: orderedSchedules.map((item) => path.basename(item.schedulePath)).join(', '),
      sourceBytes,
      builtAt: new Date().toISOString(),
      routeCount,
      stopCount,
      tripCount,
      stopTimeCount,
      connectionCount,
      connectionPermissionCount: 0,
      boardingAlightingModel: 'sparse-connection-permissions-v1',
      departureIndexState: 'ready',
      stopAccessRoleIndexVersion,
      stopAccessRoleCount: Number(db.prepare('SELECT COUNT(*) AS count FROM stop_access_roles').get()?.count ?? 0),
      calendarDateCount: Number(db.prepare('SELECT COUNT(*) AS count FROM calendar_dates').get().count),
      transferCount,
      frequencyCount: 0,
      shapePointCount: 0,
      routeServiceCatalogVersion: routeServiceCatalogSchemaVersion,
      routeServiceCatalogBuiltAt: new Date().toISOString(),
      serviceModel: 'weekday-template',
      blockingRoutingFeatures: [],
      routingLimitations: [],
      transferSemanticsVersion,
      transferGeneration: {
        strategy: 'source_literal_only',
        exact: true,
        maxDistanceKm: nearbyTransferMaxDistanceKm,
        radialCandidateCount: nearbyTransfers.candidateCount,
        inferredTransferCount: 0,
      },
    }
    runTransaction(db, () => {
      const insert = db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)')
      for (const [key, value] of Object.entries(metadata)) insert.run(key, JSON.stringify(value))
    })
    const { staticTopology, outputStats } = await finalizeRoutingStoreBuild(db, tempPath, outputPath, onProgress)
    report(onProgress, 'Routing store ready', 1, `${Math.round(outputStats.size / 1024 / 1024).toLocaleString()} MB`)
    return { ...metadata, staticTopology, path: outputPath, bytes: outputStats.size, buildSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)) }
  } catch (error) {
    await cleanupFailedRoutingStoreBuild([db], tempPath, outputPath)
    throw error
  }
}

export async function buildNationalGtfsStore({ zipPath, outputPath, onProgress, forCity = false }) {
  return importGtfsFeed({ zipPath, outputPath, onProgress, forCity })
}

// City feeds share the final database. Namespace references at the CSV boundary
// so the same validation and connection compiler serve both build paths.
async function importGtfsFeed({ zipPath, outputPath, onProgress, forCity = false, sharedDatabase = null, scope = '' }) {
  const startedAt = performance.now()
  const archive = await inspectGtfsZip(zipPath)
  const sourceFingerprint = await sha256File(zipPath)
  const prefix = scope ? `${scope}\u001f` : ''
  const streamTable = (entry, onRow, options) => streamGtfsZipCsv(archive, entry, prefix
    ? (row) => {
        for (const field of ['stop_id', 'route_id', 'trip_id', 'service_id', 'shape_id', 'from_stop_id', 'to_stop_id']) {
          if (row[field] !== undefined) row[field] = prefix + row[field]
        }
        if (row.parent_station) row.parent_station = prefix + row.parent_station
        return onRow(row)
      }
    : onRow, options)
  for (const required of ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) {
    if (!gtfsTableEntry(archive, required)) throw new Error(`GTFS is missing ${required}.`)
  }
  if (!gtfsTableEntry(archive, 'calendar.txt') && !gtfsTableEntry(archive, 'calendar_dates.txt')) {
    throw new Error('GTFS requires calendar.txt, calendar_dates.txt, or both to define active service.')
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.building`
  const stagePath = `${outputPath}.stop-times-building`
  await fsp.rm(stagePath, { force: true })
  if (!sharedDatabase) await fsp.rm(tempPath, { force: true })
  const db = sharedDatabase ?? new DatabaseSync(tempPath)
  const stage = new DatabaseSync(stagePath)
  if (!sharedDatabase) configureBuildDatabase(db)
  configureBuildDatabase(stage)
  if (!sharedDatabase) createRoutingStoreSchema(db)
  stage.exec(`
    CREATE TABLE stop_times(
      trip_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      stop_id TEXT NOT NULL,
      arrival INTEGER,
      departure INTEGER,
      can_board INTEGER NOT NULL,
      can_alight INTEGER NOT NULL,
      pickup_type INTEGER NOT NULL,
      drop_off_type INTEGER NOT NULL
    );
  `)

  const counts = {}
  const profiles = []
  const agencyTimezones = new Set()
  const featureInventory = {
    blockTripCount: 0,
    routeContinuousRuleCount: 0,
    tripContinuousRuleCount: 0,
    restrictedPickupStopTimeCount: 0,
    restrictedDropOffStopTimeCount: 0,
    onDemandPickupStopTimeCount: 0,
    onDemandDropOffStopTimeCount: 0,
    continuousPickupStopTimeCount: 0,
    continuousDropOffStopTimeCount: 0,
    routeSpecificTransferCount: 0,
    tripSpecificTransferCount: 0,
    timedTransferCount: 0,
    inSeatTransferCount: 0,
    pathwayCount: 0,
    pathwayAccessibilityRuleCount: 0,
    stopWheelchairBoardingRuleCount: 0,
    tripWheelchairAccessibleRuleCount: 0,
    tripBikesAllowedRuleCount: 0,
    stationEntranceCount: 0,
    stationLevelRuleCount: 0,
    exactFrequencyCount: 0,
    inexactFrequencyCount: 0,
    exactFrequencyExpandedTripCount: 0,
    exactFrequencyExpandedConnectionCount: 0,
    excludedTripCount: 0,
    excludedTransferCount: 0,
  }
  const excludedTripIds = new Set()
  const zipImportBudget = createGtfsZipImportBudget()
  const importTable = async (name, progress, insertSql, values) => {
    const entry = gtfsTableEntry(archive, name)
    if (!entry) {
      profiles.push({ name, present: false, rowCount: 0, fields: [] })
      return
    }
    report(onProgress, `Reading ${name}`, progress)
    const statement = (name === 'stop_times.txt' ? stage : db).prepare(insertSql)
    const target = name === 'stop_times.txt' ? stage : db
    let batch = 0
    target.exec('BEGIN IMMEDIATE')
    try {
      const result = await streamTable(entry, (row) => {
        const prepared = values(row)
        if (prepared !== null) {
          try {
            statement.run(...prepared)
          } catch (error) {
            const sqliteErrorCode = Number(error?.errcode)
            if (
              String(error?.code ?? '').startsWith('SQLITE_CONSTRAINT')
              || (Number.isInteger(sqliteErrorCode) && (sqliteErrorCode & 0xff) === 19)
            ) {
              throw new Error(`Duplicate or conflicting GTFS key in ${name}.`, { cause: error })
            }
            throw error
          }
        }
        batch += 1
        if (batch % 100_000 === 0) {
          target.exec('COMMIT; BEGIN IMMEDIATE')
          report(onProgress, `Reading ${name}`, progress, `${batch.toLocaleString()} rows`)
        }
      }, { budget: zipImportBudget })
      target.exec('COMMIT')
      counts[name] = result.rows
      profiles.push({ name, present: true, rowCount: result.rows, fields: result.fields })
    } catch (error) {
      target.exec('ROLLBACK')
      throw error
    }
  }

  try {
    const fareCatalog = await readGtfsFareCatalog(archive, { budget: zipImportBudget })
    writeGtfsFareCatalog(db, fareCatalog, scope)
    const agencyEntry = gtfsTableEntry(archive, 'agency.txt')
    if (agencyEntry) {
      const agencyProfile = await streamTable(agencyEntry, (row) => {
        const timezone = String(row.agency_timezone ?? '').trim()
        if (timezone) agencyTimezones.add(timezone)
      }, { budget: zipImportBudget })
      counts['agency.txt'] = agencyProfile.rows
      profiles.push({ name: 'agency.txt', present: true, rowCount: agencyProfile.rows, fields: agencyProfile.fields })
    } else {
      profiles.push({ name: 'agency.txt', present: false, rowCount: 0, fields: [] })
    }
    await importTable('stops.txt', 0.05,
      'INSERT INTO stops VALUES(?,?,?,?,?,?,?)',
      (row) => {
        const locationType = numeric(row.location_type, 0)
        const wheelchairBoarding = String(row.wheelchair_boarding ?? '').trim()
        if (wheelchairBoarding && numeric(wheelchairBoarding, 0) !== 0) {
          featureInventory.stopWheelchairBoardingRuleCount += 1
        }
        if (locationType === 2) featureInventory.stationEntranceCount += 1
        if (String(row.level_id ?? '').trim()) featureInventory.stationLevelRuleCount += 1
        return [row.stop_id, row.stop_name ?? '', numeric(row.stop_lat, null), numeric(row.stop_lon, null), row.parent_station || null, locationType, row.platform_code || null]
      })
    await importTable('routes.txt', 0.09,
      'INSERT INTO routes VALUES(?,?,?,?,?)',
      (row) => {
        const continuousPickup = String(row.continuous_pickup ?? '').trim()
        const continuousDropOff = String(row.continuous_drop_off ?? '').trim()
        if ((continuousPickup && numeric(continuousPickup, 1) !== 1) || (continuousDropOff && numeric(continuousDropOff, 1) !== 1)) {
          featureInventory.routeContinuousRuleCount += 1
        }
        return [row.route_id, row.route_short_name || '', row.route_long_name || '', numeric(row.route_type, 3), row.route_color || '']
      })
    await importTable('trips.txt', 0.14,
      'INSERT INTO trips VALUES(?,?,?,?)',
      (row) => {
        if (String(row.block_id ?? '').trim()) featureInventory.blockTripCount += 1
        const wheelchairAccessible = String(row.wheelchair_accessible ?? '').trim()
        const bikesAllowed = String(row.bikes_allowed ?? '').trim()
        if (wheelchairAccessible && numeric(wheelchairAccessible, 0) !== 0) {
          featureInventory.tripWheelchairAccessibleRuleCount += 1
        }
        if (bikesAllowed && numeric(bikesAllowed, 0) !== 0) {
          featureInventory.tripBikesAllowedRuleCount += 1
        }
        const continuousPickup = String(row.continuous_pickup ?? '').trim()
        const continuousDropOff = String(row.continuous_drop_off ?? '').trim()
        if ((continuousPickup && numeric(continuousPickup, 1) !== 1) || (continuousDropOff && numeric(continuousDropOff, 1) !== 1)) {
          featureInventory.tripContinuousRuleCount += 1
        }
        return [row.trip_id, row.route_id, row.service_id, row.direction_id || null]
      })
    if (gtfsTableEntry(archive, 'shapes.txt')) {
      const tripEntry = gtfsTableEntry(archive, 'trips.txt')
      const insertTripShape = db.prepare('INSERT INTO trip_shapes VALUES(?,?)')
      let mappedTrips = 0
      db.exec('BEGIN IMMEDIATE')
      try {
        await streamTable(tripEntry, (row) => {
          const shapeId = String(row.shape_id ?? '').slice(prefix.length).trim()
          if (!shapeId) return
          insertTripShape.run(row.trip_id, prefix + shapeId)
          mappedTrips += 1
          if (mappedTrips % 100_000 === 0) db.exec('COMMIT; BEGIN IMMEDIATE')
        }, { budget: zipImportBudget })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    await importTable('calendar.txt', 0.18,
      'INSERT INTO calendar VALUES(?,?,?,?,?,?,?,?,?,?)',
      (row) => {
        const context = `service ${row.service_id || '(missing service_id)'}`
        const startDate = requiredGtfsDate(row.start_date, 'start_date', context)
        const endDate = requiredGtfsDate(row.end_date, 'end_date', context)
        if (endDate < startDate) throw new Error(`Invalid GTFS calendar date range for ${context}: end_date precedes start_date.`)
        return [
          row.service_id,
          requiredGtfsEnum(row.monday, [0, 1], 'monday', context),
          requiredGtfsEnum(row.tuesday, [0, 1], 'tuesday', context),
          requiredGtfsEnum(row.wednesday, [0, 1], 'wednesday', context),
          requiredGtfsEnum(row.thursday, [0, 1], 'thursday', context),
          requiredGtfsEnum(row.friday, [0, 1], 'friday', context),
          requiredGtfsEnum(row.saturday, [0, 1], 'saturday', context),
          requiredGtfsEnum(row.sunday, [0, 1], 'sunday', context),
          startDate,
          endDate,
        ]
      })
    await importTable('calendar_dates.txt', 0.23,
      'INSERT INTO calendar_dates VALUES(?,?,?)',
      (row) => {
        const context = `service ${row.service_id || '(missing service_id)'}`
        return [
          row.service_id,
          requiredGtfsDate(row.date, 'date', context),
          requiredGtfsEnum(row.exception_type, [1, 2], 'exception_type', context),
        ]
      })
    await importTable('transfers.txt', 0.27,
      'INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)',
      (row) => {
        const routeSpecific = Boolean(String(row.from_route_id ?? '').trim() || String(row.to_route_id ?? '').trim())
        const tripSpecific = Boolean(String(row.from_trip_id ?? '').trim() || String(row.to_trip_id ?? '').trim())
        if (routeSpecific) featureInventory.routeSpecificTransferCount += 1
        if (tripSpecific) featureInventory.tripSpecificTransferCount += 1
        const transferContext = `${row.from_stop_id || '(missing from_stop_id)'} -> ${row.to_stop_id || '(missing to_stop_id)'}`
        const transferType = requiredGtfsEnum(row.transfer_type, [0, 1, 2, 3, 4, 5], 'transfer_type', transferContext, 0)
        const minimumTransferTimeText = String(row.min_transfer_time ?? '').trim()
        const minimumTransferTime = minimumTransferTimeText ? Number(minimumTransferTimeText) : 0
        if (!Number.isInteger(minimumTransferTime) || minimumTransferTime < 0) {
          throw new Error(`Invalid GTFS min_transfer_time for ${transferContext}: ${minimumTransferTimeText || '(missing)'}.`)
        }
        if (transferType === 1) featureInventory.timedTransferCount += 1
        if (transferType === 4 || transferType === 5) featureInventory.inSeatTransferCount += 1
        if (routeSpecific || tripSpecific || [1, 4, 5].includes(transferType)) {
          featureInventory.excludedTransferCount += 1
          return null
        }
        return [row.from_stop_id, row.to_stop_id, transferType, minimumTransferTime]
      })
    db.prepare(`
      INSERT OR REPLACE INTO transfer_provenance(from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m)
      SELECT from_stop_id, to_stop_id, 'gtfs_transfer', NULL, NULL FROM transfers
      WHERE ? = '' OR substr(from_stop_id, 1, length(?)) = ?
    `).run(prefix, prefix, prefix)
    await importTable('frequencies.txt', 0.29,
      'INSERT INTO frequencies VALUES(?,?,?,?,?)',
      (row) => {
        const startTime = gtfsSeconds(row.start_time)
        const endTime = gtfsSeconds(row.end_time)
        const headwaySecs = numeric(row.headway_secs, 0)
        const exactTimes = numeric(row.exact_times, 0)
        if (startTime === null || endTime === null || endTime < startTime || !Number.isInteger(headwaySecs) || headwaySecs <= 0) {
          throw new Error(`Invalid GTFS frequency window for trip ${row.trip_id || '(missing trip_id)'}.`)
        }
        if (exactTimes === 1) featureInventory.exactFrequencyCount += 1
        else {
          featureInventory.inexactFrequencyCount += 1
          excludedTripIds.add(row.trip_id)
        }
        return [row.trip_id, startTime, endTime, headwaySecs, exactTimes]
      })
    await importTable('shapes.txt', 0.3,
      'INSERT INTO shape_points VALUES(?,?,?,?)',
      (row) => [row.shape_id, numeric(row.shape_pt_sequence), numeric(row.shape_pt_lat), numeric(row.shape_pt_lon)])
    await importTable('stop_times.txt', 0.32,
      'INSERT INTO stop_times VALUES(?,?,?,?,?,?,?,?,?)',
      (row) => {
        const context = `trip ${row.trip_id || '(missing trip_id)'} stop_sequence ${row.stop_sequence || '(missing sequence)'}`
        const pickupType = requiredGtfsEnum(row.pickup_type, [0, 1, 2, 3], 'pickup_type', context, 0)
        const dropOffType = requiredGtfsEnum(row.drop_off_type, [0, 1, 2, 3], 'drop_off_type', context, 0)
        const restrictedPickup = pickupType !== 0
        const restrictedDropOff = dropOffType !== 0
        const continuousPickup = Boolean(String(row.continuous_pickup ?? '').trim()) && numeric(row.continuous_pickup, 1) !== 1
        const continuousDropOff = Boolean(String(row.continuous_drop_off ?? '').trim()) && numeric(row.continuous_drop_off, 1) !== 1
        if (restrictedPickup) featureInventory.restrictedPickupStopTimeCount += 1
        if (restrictedDropOff) featureInventory.restrictedDropOffStopTimeCount += 1
        if (pickupType === 2 || pickupType === 3) featureInventory.onDemandPickupStopTimeCount += 1
        if (dropOffType === 2 || dropOffType === 3) featureInventory.onDemandDropOffStopTimeCount += 1
        if (continuousPickup) featureInventory.continuousPickupStopTimeCount += 1
        if (continuousDropOff) featureInventory.continuousDropOffStopTimeCount += 1
        const arrivalText = String(row.arrival_time ?? '').trim()
        const departureText = String(row.departure_time ?? '').trim()
        const stopSequenceText = String(row.stop_sequence ?? '').trim()
        const stopSequence = Number(stopSequenceText)
        if (!stopSequenceText || !Number.isInteger(stopSequence) || stopSequence < 0) {
          throw new Error(`Invalid GTFS stop_sequence for trip ${row.trip_id || '(missing trip_id)'}: ${stopSequenceText || '(missing sequence)'}.`)
        }
        const arrival = gtfsSeconds(arrivalText)
        const departure = gtfsSeconds(departureText)
        if ((arrivalText && arrival === null) || (departureText && departure === null)) {
          throw new Error(`Invalid GTFS time for trip ${row.trip_id || '(missing trip_id)'} at stop_sequence ${row.stop_sequence || '(missing sequence)'}.`)
        }
        if (arrival !== null && departure !== null && departure < arrival) {
          throw new Error(`Non-monotone GTFS dwell time for trip ${row.trip_id || '(missing trip_id)'} at stop_sequence ${stopSequence}.`)
        }
        return [
          row.trip_id,
          stopSequence,
          row.stop_id,
          arrival,
          departure,
          restrictedPickup ? 0 : 1,
          restrictedDropOff ? 0 : 1,
          pickupType,
          dropOffType,
        ]
      })
    featureInventory.excludedTripCount = excludedTripIds.size

    const pathwaysEntry = gtfsTableEntry(archive, 'pathways.txt')
    if (pathwaysEntry) {
      report(onProgress, 'Reading pathways.txt', 0.31)
      const insertPathway = db.prepare('INSERT OR IGNORE INTO transfers VALUES(?,?,0,?)')
      const insertPathwayProvenance = db.prepare('INSERT OR IGNORE INTO transfer_provenance VALUES(?,?,?,NULL,?)')
      const pathwayStop = db.prepare('SELECT lon, lat FROM stops WHERE stop_id=?')
      let pathwayBatch = 0
      db.exec('BEGIN IMMEDIATE')
      try {
        const pathwayProfile = await streamTable(pathwaysEntry, (row) => {
          const seconds = String(row.traversal_time ?? '').trim()
            ? Math.max(0, numeric(row.traversal_time, 0)) : null
          const from = pathwayStop.get(row.from_stop_id)
          const to = pathwayStop.get(row.to_stop_id)
          const distanceM = String(row.length ?? '').trim()
            ? Math.max(0, numeric(row.length, 0))
            : from && to ? haversineKm([from.lon, from.lat], [to.lon, to.lat]) * 1000 : 0
          const forward = insertPathway.run(row.from_stop_id, row.to_stop_id, seconds)
          if (Number(forward.changes ?? 0)) insertPathwayProvenance.run(row.from_stop_id, row.to_stop_id, 'gtfs_pathway', distanceM)
          if (numeric(row.is_bidirectional, 0) === 1) {
            const reverse = insertPathway.run(row.to_stop_id, row.from_stop_id, seconds)
            if (Number(reverse.changes ?? 0)) insertPathwayProvenance.run(row.to_stop_id, row.from_stop_id, 'gtfs_pathway', distanceM)
          }
          featureInventory.pathwayCount += 1
          if ([row.wheelchair_traversal_time, row.stair_count, row.max_slope, row.min_width].some((value) => String(value ?? '').trim())) {
            featureInventory.pathwayAccessibilityRuleCount += 1
          }
          pathwayBatch += 1
          if (pathwayBatch % 100_000 === 0) db.exec('COMMIT; BEGIN IMMEDIATE')
        }, { budget: zipImportBudget })
        db.exec('COMMIT')
        counts['pathways.txt'] = pathwayProfile.rows
        profiles.push({ name: 'pathways.txt', present: true, rowCount: pathwayProfile.rows, fields: pathwayProfile.fields })
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } else {
      profiles.push({ name: 'pathways.txt', present: false, rowCount: 0, fields: [] })
    }

    assertNoBrokenGtfsReferences(db)
    report(onProgress, 'Ordering stop times', 0.72)
    stage.exec('CREATE INDEX stop_times_trip_sequence ON stop_times(trip_id, stop_sequence);')
    const tripLookup = db.prepare('SELECT route_id, service_id, direction_id FROM trips WHERE trip_id=?')
    const frequencyLookup = db.prepare('SELECT start_time, end_time, headway_secs, exact_times FROM frequencies WHERE trip_id=? ORDER BY start_time, end_time, headway_secs')
    const insertFrequencyTrip = db.prepare('INSERT OR IGNORE INTO trips VALUES(?,?,?,?)')
    const tripShapeLookup = db.prepare('SELECT shape_id FROM trip_shapes WHERE trip_id=?')
    const insertFrequencyTripShape = db.prepare('INSERT OR IGNORE INTO trip_shapes VALUES(?,?)')
    const knownStopIds = new Set(db.prepare('SELECT stop_id FROM stops').all().map((row) => row.stop_id))
    const insertConnection = db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
    const insertConnectionPermission = db.prepare('INSERT INTO connection_permissions VALUES(?,?,?,?)')
    const rows = stage.prepare(`
      SELECT trip_id, stop_sequence, stop_id, arrival, departure,
        can_board, can_alight, pickup_type, drop_off_type
      FROM stop_times
      ORDER BY trip_id, stop_sequence
    `).iterate()
    let previous = null
    let trip = null
    let connectionCount = 0
    let bridgedUntimedGapCount = 0
    let exactFrequencyExpandedTripCount = 0
    let exactFrequencyExpandedConnectionCount = 0
    const frequencyTripIds = new Set()
    const exactFrequencyInstances = (templateTripId, templateStartSeconds) => {
      if (!Number.isFinite(templateStartSeconds)) return []
      const instances = frequencyLookup.all(templateTripId)
        .filter((frequency) => Number(frequency.exact_times ?? 0) === 1)
        .flatMap((frequency) => {
          const start = Number(frequency.start_time)
          const end = Number(frequency.end_time)
          const headway = Number(frequency.headway_secs)
          const count = Math.floor((end - start) / headway) + 1
          if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(headway) || count <= 0 || count > 100_000) {
            throw new Error(`GTFS exact frequency window for trip ${templateTripId} is outside the supported expansion bound.`)
          }
          return Array.from({ length: count }, (_, index) => {
            const departure = start + index * headway
            return { tripId: `${templateTripId}#frequency-${departure}`, offsetSeconds: departure - templateStartSeconds }
          })
        })
      return [...new Map(instances.map((instance) => [instance.tripId, instance])).values()]
    }
    db.exec('BEGIN IMMEDIATE')
    for (const row of rows) {
      if (!knownStopIds.has(row.stop_id)) {
        throw new Error(`Broken GTFS reference stop_times.stop_id -> stops.stop_id: trip ${row.trip_id || '(missing)'} references ${row.stop_id || '(missing)'}.`)
      }
      if (!previous || previous.trip_id !== row.trip_id) {
        const referencedTrip = tripLookup.get(row.trip_id)
        if (!referencedTrip) {
          throw new Error(`Broken GTFS reference stop_times.trip_id -> trips.trip_id: ${row.trip_id || '(missing)'}.`)
        }
        trip = excludedTripIds.has(row.trip_id) ? null : {
          ...referencedTrip,
          frequencyInstances: null,
          frequencyInstancesReady: false,
        }
        previous = row
        continue
      }
      if (numeric(row.stop_sequence, -1) <= numeric(previous.stop_sequence, -1)) {
        throw new Error(`Non-increasing or duplicate GTFS stop_sequence for trip ${row.trip_id} at ${row.stop_sequence}.`)
      }
      const departure = previous.departure ?? previous.arrival
      const arrival = row.arrival ?? row.departure
      if (departure !== null && arrival !== null && arrival < departure) {
        throw new Error(`Non-monotone GTFS trip time for trip ${row.trip_id} between stop_sequence ${previous.stop_sequence} and ${row.stop_sequence}.`)
      }
      if (trip && !trip.frequencyInstancesReady) {
        const templateStartSeconds = previous.departure ?? previous.arrival
        const instances = exactFrequencyInstances(row.trip_id, Number(templateStartSeconds))
        trip.frequencyInstances = instances.length ? instances : [{ tripId: row.trip_id, offsetSeconds: 0 }]
        trip.frequencyInstancesReady = true
        for (const instance of instances) {
          if (frequencyTripIds.has(instance.tripId)) continue
          frequencyTripIds.add(instance.tripId)
          insertFrequencyTrip.run(instance.tripId, trip.route_id, trip.service_id, trip.direction_id)
          const shape = tripShapeLookup.get(row.trip_id)?.shape_id
          if (shape) insertFrequencyTripShape.run(instance.tripId, shape)
          exactFrequencyExpandedTripCount += 1
        }
      }
      if (trip && departure !== null && arrival !== null && arrival >= departure) {
        for (const instance of trip.frequencyInstances ?? []) {
          const instanceDeparture = departure + Number(instance.offsetSeconds ?? 0)
          const instanceArrival = arrival + Number(instance.offsetSeconds ?? 0)
          insertConnection.run(instanceDeparture, instanceArrival, instance.tripId, trip.route_id, trip.service_id, trip.direction_id, previous.stop_id, row.stop_id, previous.stop_sequence)
          if (previous.can_board !== 1 || row.can_alight !== 1) {
            insertConnectionPermission.run(
              instance.tripId,
              previous.stop_sequence,
              previous.can_board === 1 ? 1 : 0,
              row.can_alight === 1 ? 1 : 0,
            )
          }
          connectionCount += 1
          if (instance.tripId !== row.trip_id) exactFrequencyExpandedConnectionCount += 1
        }
        if (numeric(row.stop_sequence) > numeric(previous.stop_sequence) + 1) bridgedUntimedGapCount += 1
        if (connectionCount % 250_000 === 0) {
          db.exec('COMMIT; BEGIN IMMEDIATE')
          report(onProgress, 'Compiling transit connections', 0.72 + Math.min(0.17, connectionCount / Math.max(1, counts['stop_times.txt']) * 0.17), `${connectionCount.toLocaleString()} connections`)
        }
      }
      if (row.arrival !== null || row.departure !== null) previous = row
    }
    db.exec('COMMIT')
    counts.connections = connectionCount

    if (!sharedDatabase) report(onProgress, 'Linking nearby interchanges', 0.895)
    const nearbyTransfers = sharedDatabase ? { candidateCount: 0, inferredTransferCount: 0 } : linkNearbyTransferStops(db)
    counts.inferredTransfers = nearbyTransfers.inferredTransferCount

    if (!sharedDatabase) report(onProgress, 'Building routing indexes', 0.9)
    if (!sharedDatabase) createRoutingStoreIndexes(db, { forCity })
    const blockingRoutingFeatures = []
    const routingLimitations = []
    const blockFeature = (code, count, detail) => {
      if (count > 0) blockingRoutingFeatures.push({ code, count, detail })
    }
    const limitFeature = (code, count, detail) => {
      if (count > 0) routingLimitations.push({ code, count, exactness: 'unsupported', detail })
    }
    blockFeature('multiple_agency_timezones', Math.max(0, agencyTimezones.size - 1),
      'A single routing store cannot yet resolve service-day coordinates across multiple agency timezones.')
    featureInventory.exactFrequencyExpandedTripCount = exactFrequencyExpandedTripCount
    featureInventory.exactFrequencyExpandedConnectionCount = exactFrequencyExpandedConnectionCount
    limitFeature('frequency_based_service', featureInventory.inexactFrequencyCount,
      'Headway-based frequency windows with exact_times=0 remain excluded; exact_times=1 windows are expanded into fixed departures during import.')
    limitFeature('on_demand_boarding_or_alighting', featureInventory.onDemandPickupStopTimeCount + featureInventory.onDemandDropOffStopTimeCount,
      'pickup_type/drop_off_type values 2 and 3 require rider-agency coordination; the default routing request conservatively treats those events as unavailable.')
    limitFeature('continuous_pickup_or_drop_off', featureInventory.routeContinuousRuleCount + featureInventory.tripContinuousRuleCount + featureInventory.continuousPickupStopTimeCount + featureInventory.continuousDropOffStopTimeCount,
      'Fixed-stop service is retained, but continuous pickup or drop-off between scheduled stops is not represented by the point-to-point router.')
    limitFeature('scoped_transfer_rules', featureInventory.routeSpecificTransferCount + featureInventory.tripSpecificTransferCount,
      'Route- or trip-scoped transfer rows are retained in the source inventory but excluded from the generic stop-pair transfer graph.')
    limitFeature('in_seat_transfer_rules', featureInventory.inSeatTransferCount,
      'In-seat linked-trip continuations are not modeled by the supported scheduled routing core.')
    limitFeature('block_interlining', featureInventory.blockTripCount,
      'block_id is retained as an operational limitation; VIGO does not infer passenger in-seat continuation from it.')
    limitFeature('timed_transfer_guarantee', featureInventory.timedTransferCount,
      'Timed-transfer guarantee rows are excluded from the generic stop-pair transfer graph.')
    limitFeature('pathway_accessibility', featureInventory.pathwayAccessibilityRuleCount,
      'Pathway direction and traversal time are used, but accessibility attributes are not query constraints.')
    limitFeature('wheelchair_accessibility', featureInventory.stopWheelchairBoardingRuleCount + featureInventory.tripWheelchairAccessibleRuleCount,
      'Stop wheelchair_boarding and trip wheelchair_accessible values are inventoried, but VIGO does not yet expose a wheelchair-constrained routing request.')
    limitFeature('bicycle_accessibility', featureInventory.tripBikesAllowedRuleCount,
      'Trip bikes_allowed values are inventoried, but VIGO does not yet expose a bicycle-constrained routing request.')
    limitFeature('station_entrances', featureInventory.stationEntranceCount,
      'Station entrances are inventoried, but the routing graph does not yet use the complete GTFS entrance hierarchy for access and egress.')
    limitFeature('station_level_hierarchy', featureInventory.stationLevelRuleCount,
      'Stop level_id values are inventoried, but station levels are not complete routing constraints.')
    const countFeedRows = (table, id) => Number(prefix
      ? db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE substr(${id}, 1, length(?)) = ?`).get(prefix, prefix).count
      : db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
    const storeId = sourceFingerprint.slice(0, 20)
    const metadata = {
      schemaVersion: storeSchemaVersion,
      storeId,
      sourceFingerprint,
      sourceFile: path.basename(zipPath),
      sourceBytes: archive.compressedBytes,
      fareData: fareCatalog ? { standard: fareCatalog.tables.fare_products ? 'GTFS Fares v2' : fareCatalog.tables.fare_attributes ? 'GTFS Fares v1' : null, boardingPrices: !fareCatalog.unavailableReason, transferTotals: false } : null,
      builtAt: new Date().toISOString(),
      routeCount: counts['routes.txt'] ?? 0,
      stopCount: counts['stops.txt'] ?? 0,
      tripCount: countFeedRows('trips', 'trip_id'),
      stopTimeCount: counts['stop_times.txt'] ?? 0,
      connectionCount,
      connectionPermissionCount: countFeedRows('connection_permissions', 'trip_id'),
      boardingAlightingModel: 'sparse-connection-permissions-v1',
      departureIndexState: forCity ? 'deferred' : 'ready',
      stopAccessRoleIndexVersion,
      stopAccessRoleCount: countFeedRows('stop_access_roles', 'stop_id'),
      calendarDateCount: counts['calendar_dates.txt'] ?? 0,
      transferCount: countFeedRows('transfers', 'from_stop_id'),
      frequencyCount: counts['frequencies.txt'] ?? 0,
      frequencyRoutingModel: exactFrequencyExpandedTripCount > 0 ? 'exact_times_1_expanded_fixed_departures' : 'none',
      shapePointCount: counts['shapes.txt'] ?? 0,
      bridgedUntimedGapCount,
      routeServiceCatalogVersion: routeServiceCatalogSchemaVersion,
      routeServiceCatalogBuiltAt: new Date().toISOString(),
      serviceModel: 'exact-date',
      agencyTimezones: [...agencyTimezones].sort(),
      featureInventory,
      blockingRoutingFeatures,
      routingLimitations,
      transferSemanticsVersion,
      transferGeneration: {
        strategy: 'source_literal_only',
        exact: true,
        maxDistanceKm: nearbyTransferMaxDistanceKm,
        radialCandidateCount: nearbyTransfers.candidateCount,
        inferredTransferCount: 0,
      },
    }
    stage.close()
    await fsp.rm(stagePath, { force: true })
    if (sharedDatabase) return { ...metadata, tableProfiles: profiles }
    runTransaction(db, () => {
      const insert = db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)')
      for (const [key, value] of Object.entries(metadata)) insert.run(key, JSON.stringify(value))
    })
    const { staticTopology, outputStats } = await finalizeRoutingStoreBuild(db, tempPath, outputPath, onProgress, { forCity })
    report(onProgress, 'Routing store ready', 1, `${Math.round(outputStats.size / 1024 / 1024).toLocaleString()} MB`)
    return {
      ...metadata,
      path: outputPath,
      bytes: outputStats.size,
      buildSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)),
      tableProfiles: profiles,
      staticTopology,
    }
  } catch (error) {
    if (sharedDatabase) {
      try { stage.close() } catch {}
      await fsp.rm(stagePath, { force: true })
    } else {
      await cleanupFailedRoutingStoreBuild([db, stage], tempPath, outputPath, [stagePath])
    }
    throw error
  }
}

export async function buildNationalGtfsCityStore({ feeds, outputPath, onProgress }) {
  if (!Array.isArray(feeds) || !feeds.length) throw new Error('At least one GTFS feed is required.')
  const descriptors = feeds.map((feed) => ({ scope: String(feed.scope ?? '').trim(), zipPath: path.resolve(feed.path) }))
    .sort((left, right) => left.scope.localeCompare(right.scope))
  if (descriptors.some((feed) => !feed.scope) || new Set(descriptors.map((feed) => feed.scope)).size !== descriptors.length) {
    throw new Error('GTFS scopes must be non-empty and unique.')
  }
  if (descriptors.length === 1) {
    return buildNationalGtfsStore({ zipPath: descriptors[0].zipPath, outputPath, onProgress, forCity: true })
  }
  const started = performance.now()
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.building`
  await fsp.rm(tempPath, { force: true })
  const db = new DatabaseSync(tempPath)
  configureBuildDatabase(db)
  createRoutingStoreSchema(db)
  try {
    const metadataByStore = []
    for (const feed of descriptors) {
      metadataByStore.push(await importGtfsFeed({
        zipPath: feed.zipPath, outputPath, sharedDatabase: db, scope: feed.scope, forCity: true,
        onProgress: onProgress ? (event) => onProgress({ ...event, phase: `${feed.scope}: ${event.phase}` }) : undefined,
      }))
    }
    report(onProgress, 'Building combined routing indexes', 0.9)
    createRoutingStoreIndexes(db, { forCity: true })
    const nearbyTransfers = linkNearbyTransferStops(db)
    const metadata = mergedGtfsMetadata(db, descriptors, metadataByStore, nearbyTransfers, true)
    runTransaction(db, () => {
      const insert = db.prepare('INSERT INTO metadata VALUES(?,?)')
      for (const [key, value] of Object.entries(metadata)) insert.run(key, JSON.stringify(value))
    })
    const { staticTopology, outputStats } = await finalizeRoutingStoreBuild(db, tempPath, outputPath, onProgress, { forCity: true })
    return { ...metadata, staticTopology, path: outputPath, bytes: outputStats.size, buildSeconds: (performance.now() - started) / 1000 }
  } catch (error) {
    await cleanupFailedRoutingStoreBuild([db], tempPath, outputPath)
    throw error
  }
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function mergedGtfsMetadata(db, descriptors, metadataByStore, nearbyTransfers, forCity) {
  const featureInventory = {}
  for (const source of metadataByStore) {
    for (const [key, value] of Object.entries(source.featureInventory)) {
      const count = Number(value)
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`Routing store contains invalid feature inventory count ${key}: ${value}`)
      }
      featureInventory[key] = Number(featureInventory[key] ?? 0) + count
    }
  }
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
  const sourceFingerprint = descriptors
    .map((descriptor, index) => ({
      scope: descriptor.scope,
      sourceFingerprint: metadataByStore[index].sourceFingerprint,
    }))
    .sort((left, right) => left.scope.localeCompare(right.scope))
    .map((source) => `${source.scope}:${source.sourceFingerprint}`)
    .join('|')
  const agencyTimezones = [...new Set(metadataByStore.flatMap((metadata) => metadata.agencyTimezones ?? []))].sort()
  const blockingByCode = new Map()
  const limitationsByCode = new Map()
  const mergeFeatures = (target, features) => {
    for (const feature of features ?? []) {
      const current = target.get(feature.code)
      target.set(feature.code, current
        ? { ...current, count: Number(current.count ?? 0) + Number(feature.count ?? 0) }
        : { ...feature })
    }
  }
  for (const source of metadataByStore) {
    mergeFeatures(blockingByCode, source.blockingRoutingFeatures)
    mergeFeatures(limitationsByCode, source.routingLimitations?.filter((feature) => feature.code !== 'generated_radial_transfers'))
  }
  if (agencyTimezones.length > 1) blockingByCode.set('multiple_agency_timezones', {
    code: 'multiple_agency_timezones',
    count: agencyTimezones.length,
    detail: 'The merged store contains agencies in multiple timezones; cross-timezone service-day routing is unsupported.',
  })
  return {
    schemaVersion: storeSchemaVersion,
    storeId: `merged-${descriptors.map((descriptor) => descriptor.scope).sort().join('+')}`,
    sourceFingerprint,
    sourceFile: descriptors.map((descriptor, index) => `${descriptor.scope}:${metadataByStore[index].sourceFile}`).join(', '),
    sourceBytes: metadataByStore.reduce((sum, metadata) => sum + Number(metadata.sourceBytes ?? 0), 0),
    builtAt: new Date().toISOString(),
    routeCount: count('routes'),
    stopCount: count('stops'),
    tripCount: count('trips'),
    stopTimeCount: metadataByStore.reduce((sum, metadata) => sum + Number(metadata.stopTimeCount ?? 0), 0),
    connectionCount: count('connections'),
    connectionPermissionCount: count('connection_permissions'),
    boardingAlightingModel: 'sparse-connection-permissions-v1',
    departureIndexState: forCity ? 'deferred' : 'ready',
    stopAccessRoleIndexVersion,
    stopAccessRoleCount: count('stop_access_roles'),
    calendarDateCount: count('calendar_dates'),
    transferCount: count('transfers'),
    frequencyCount: count('frequencies'),
    shapePointCount: count('shape_points'),
    routeServiceCatalogVersion: routeServiceCatalogSchemaVersion,
    routeServiceCatalogBuiltAt: new Date().toISOString(),
    serviceModel: 'exact-date-multi-feed',
    agencyTimezones,
    featureInventory,
    blockingRoutingFeatures: [...blockingByCode.values()].sort((left, right) => left.code.localeCompare(right.code)),
    routingLimitations: [...limitationsByCode.values()].sort((left, right) => left.code.localeCompare(right.code)),
    transferSemanticsVersion,
    transferGeneration: {
      strategy: 'source_literal_only',
      exact: true,
      maxDistanceKm: nearbyTransferMaxDistanceKm,
      radialCandidateCount: nearbyTransfers.candidateCount,
      inferredTransferCount: 0,
    },
    sourceStores: descriptors.map((descriptor, index) => ({
      scope: descriptor.scope,
      storeId: metadataByStore[index].storeId,
      sourceFingerprint: metadataByStore[index].sourceFingerprint,
      sourceFile: metadataByStore[index].sourceFile,
    })),
  }
}

export async function mergeNationalGtfsStores({ stores, outputPath, onProgress, removeSourcesAfterMerge = false, forCity = false }) {
  const startedAt = performance.now()
  if (!Array.isArray(stores) || stores.length < 2) throw new Error('At least two exact-date routing stores are required.')
  const descriptors = stores.map((descriptor, index) => ({
    scope: String(descriptor.scope || `feed-${index + 1}`),
    storePath: path.resolve(descriptor.storePath),
  })).sort((left, right) => left.scope.localeCompare(right.scope) || left.storePath.localeCompare(right.storePath))
  if (new Set(descriptors.map((descriptor) => descriptor.scope)).size !== descriptors.length) throw new Error('Routing-store scopes must be unique.')
  const resolvedOutputPath = path.resolve(outputPath)
  if (descriptors.some((descriptor) => descriptor.storePath === resolvedOutputPath)) {
    throw new Error('Merged routing-store output must differ from every source store.')
  }
  const metadataByStore = []
  for (const descriptor of descriptors) {
    const stats = await fsp.stat(descriptor.storePath).catch(() => null)
    if (!stats?.isFile()) throw new Error(`Routing store is missing: ${descriptor.storePath}`)
    const source = new DatabaseSync(descriptor.storePath, { readOnly: true })
    let metadata
    try {
      metadata = admitNationalRoutingStore(source, descriptor.storePath).metadata
      admitCurrentTransferSemantics(source, descriptor.storePath, metadata)
    } finally {
      source.close()
    }
    if (metadata.serviceModel !== 'exact-date') {
      throw new Error(`Routing store is not an exact-date raw GTFS store: ${descriptor.storePath}`)
    }
    if (!String(metadata.sourceFingerprint ?? '').trim()) {
      throw new Error(`Routing store lacks a source identity and must be rebuilt from raw GTFS: ${descriptor.storePath}`)
    }
    if (!metadata.featureInventory || typeof metadata.featureInventory !== 'object' || Array.isArray(metadata.featureInventory)) {
      throw new Error(`Routing store lacks a 0.1.4 feature inventory and must be rebuilt from raw GTFS: ${descriptor.storePath}`)
    }
    metadataByStore.push(metadata)
  }


  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.building`
  await fsp.rm(tempPath, { force: true })
  const db = new DatabaseSync(tempPath)
  configureBuildDatabase(db)
  createRoutingStoreSchema(db)
  try {
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index]
      const alias = `source_${index}`
      const prefix = `${descriptor.scope}\u001f`
      const prefixSql = sqlLiteral(prefix)
      report(onProgress, 'Merging exact GTFS stores', index / descriptors.length * 0.72, path.basename(descriptor.storePath))
      db.exec(`ATTACH DATABASE ${sqlLiteral(descriptor.storePath)} AS ${alias}`)
      runTransaction(db, () => {
        copyGtfsFareCatalogs(db, alias, descriptor.scope)
        db.exec(`
          INSERT INTO stops
            SELECT ${prefixSql} || stop_id, name, lat, lon,
              CASE WHEN parent_station IS NULL OR parent_station='' THEN NULL ELSE ${prefixSql} || parent_station END,
              location_type, platform_code
            FROM ${alias}.stops;
          INSERT INTO routes
            SELECT ${prefixSql} || route_id, short_name, long_name, route_type, color FROM ${alias}.routes;
          INSERT INTO trips
            SELECT ${prefixSql} || trip_id, ${prefixSql} || route_id, ${prefixSql} || service_id, direction_id FROM ${alias}.trips;
          INSERT INTO trip_shapes
            SELECT ${prefixSql} || trip_id, ${prefixSql} || shape_id FROM ${alias}.trip_shapes;
          INSERT INTO shape_points
            SELECT ${prefixSql} || shape_id, sequence, lat, lon FROM ${alias}.shape_points;
          INSERT INTO calendar
            SELECT ${prefixSql} || service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date FROM ${alias}.calendar;
          INSERT INTO calendar_dates
            SELECT ${prefixSql} || service_id, date, exception_type FROM ${alias}.calendar_dates;
          INSERT INTO transfers
            SELECT ${prefixSql} || from_stop_id, ${prefixSql} || to_stop_id, transfer_type, min_transfer_time FROM ${alias}.transfers;
          INSERT INTO transfer_provenance
            SELECT ${prefixSql} || from_stop_id, ${prefixSql} || to_stop_id,
              provenance, evidence_fingerprint, path_distance_m
            FROM ${alias}.transfer_provenance;
          INSERT INTO frequencies
            SELECT ${prefixSql} || trip_id, start_time, end_time, headway_secs, exact_times FROM ${alias}.frequencies;
          INSERT INTO connections
            SELECT departure, arrival, ${prefixSql} || trip_id, ${prefixSql} || route_id, ${prefixSql} || service_id,
              direction_id, ${prefixSql} || from_stop_id, ${prefixSql} || to_stop_id, stop_sequence
            FROM ${alias}.connections;
        `)
        const hasConnectionPermissions = db.prepare(`
          SELECT 1 AS ready
          FROM ${alias}.sqlite_master
          WHERE type='table' AND name='connection_permissions'
        `).get()?.ready === 1
        if (hasConnectionPermissions) {
          db.exec(`
            INSERT INTO connection_permissions
              SELECT ${prefixSql} || trip_id, stop_sequence, can_board, can_alight
              FROM ${alias}.connection_permissions;
          `)
        }
      })
      db.exec(`DETACH DATABASE ${alias}`)
    }

    report(onProgress, 'Linking nearby interchanges', 0.76)
    const nearbyTransfers = linkNearbyTransferStops(db)

    report(onProgress, 'Building routing indexes', 0.88)
    createRoutingStoreIndexes(db, { forCity })
    const metadata = mergedGtfsMetadata(db, descriptors, metadataByStore, nearbyTransfers, forCity)
    runTransaction(db, () => {
      const insert = db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)')
      for (const [key, value] of Object.entries(metadata)) insert.run(key, JSON.stringify(value))
    })
    const { staticTopology, outputStats } = await finalizeRoutingStoreBuild(db, tempPath, outputPath, onProgress, { forCity })
    const cleanupWarnings = []
    if (removeSourcesAfterMerge) {
      const cleanup = await Promise.allSettled(descriptors.map((descriptor) => fsp.rm(descriptor.storePath, { force: true })))
      for (let index = 0; index < cleanup.length; index += 1) {
        const result = cleanup[index]
        if (result.status === 'rejected') cleanupWarnings.push({
          storePath: descriptors[index].storePath,
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }
    report(onProgress, cleanupWarnings.length ? 'Routing store ready with cleanup warnings' : 'Routing store ready', 1,
      `${Math.round(outputStats.size / 1024 / 1024).toLocaleString()} MB${cleanupWarnings.length ? ` / ${cleanupWarnings.length} source cleanup warning(s)` : ''}`)
    return { ...metadata, staticTopology, path: outputPath, bytes: outputStats.size, cleanupWarnings, buildSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)) }
  } catch (error) {
    await cleanupFailedRoutingStoreBuild([db], tempPath, outputPath)
    throw error
  }
}

export function readNationalGtfsStoreMetadata(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const metadata = metadataRecord(db)
    admitRoutingStoreVersion(storePath, metadata)
    return metadata
  } finally {
    db.close()
  }
}

function inspectNationalStaticTopology(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    return inspectStaticTopologyDatabase(db)
  } finally {
    db.close()
  }
}

export function inspectNationalStaticTopologySidecar(storePath, sidecarPath = nationalStaticTopologySidecarPath(storePath)) {
  const resolvedSidecarPath = path.resolve(sidecarPath)
  if (!fs.existsSync(resolvedSidecarPath)) {
    return { ready: false, reason: 'sidecar_absent', version: staticTopologySchemaVersion, sidecarPath: resolvedSidecarPath }
  }
  const sourceDb = new DatabaseSync(storePath, { readOnly: true })
  const sidecarDb = new DatabaseSync(resolvedSidecarPath, { readOnly: true })
  try {
    const sourceMetadata = metadataRecord(sourceDb)
    const sourceFingerprint = staticTopologySourceFingerprint(sourceMetadata)
    const sourceStorageIdentity = staticTopologySourceStorageIdentity(storePath)
    const sourceGeneration = sqliteStoreGeneration(storePath)
    const metadata = metadataRecord(sidecarDb)
    const tablePresent = sidecarDb.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='static_topology_edges'").get()?.present === 1
    const reverseIndexPresent = sidecarDb.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='static_topology_edges_to'").get()?.present === 1
    if (!tablePresent) return { ready: false, reason: 'table_absent', version: staticTopologySchemaVersion, sidecarPath: resolvedSidecarPath }
    if (!reverseIndexPresent) return { ready: false, reason: 'reverse_index_absent', version: staticTopologySchemaVersion, sidecarPath: resolvedSidecarPath }
    if (metadata.staticTopologyVersion !== staticTopologySchemaVersion) {
      return { ready: false, reason: 'version_mismatch', version: metadata.staticTopologyVersion, expectedVersion: staticTopologySchemaVersion, sidecarPath: resolvedSidecarPath }
    }
    if (!staticTopologySourceMatches(
      metadata,
      sourceMetadata,
      sourceGeneration,
    )) {
      return { ready: false, reason: 'source_mismatch', version: staticTopologySchemaVersion, sidecarPath: resolvedSidecarPath }
    }
    return {
      ready: true,
      reason: 'ready',
      version: staticTopologySchemaVersion,
      edgeCount: Number(metadata.staticTopologyEdgeCount ?? 0),
      builtAt: metadata.staticTopologyBuiltAt,
      sidecarPath: resolvedSidecarPath,
      sourceFingerprint,
      sourceStorageIdentity,
    }
  } finally {
    sidecarDb.close()
    sourceDb.close()
  }
}

function upsertStaticTopologyMetadata(db, values) {
  const insert = db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)')
  for (const [key, value] of Object.entries(values)) insert.run(key, JSON.stringify(value))
}

function populateStaticTopology(sourceDb, targetDb, { expectedConnections = 1, onProgress } = {}) {
  const insertEdge = targetDb.prepare(`
    INSERT INTO static_topology_edges(from_stop_id, to_stop_id, min_duration) VALUES(?, ?, ?)
    ON CONFLICT(from_stop_id, to_stop_id) DO UPDATE SET
      min_duration=MIN(static_topology_edges.min_duration, excluded.min_duration)
  `)
  let scheduledRows = 0
  let scheduledEdges = 0
  // Reduce inside SQLite before crossing into JavaScript. The file-backed
  // grouping retains every connection while bounding the JS working set.
  let nextProgress = 1_000_000
  for (const row of sourceDb.prepare(`
    SELECT from_stop_id, to_stop_id, MIN(arrival - departure) AS min_duration,
      COUNT(*) AS connection_count
    FROM connections
    WHERE from_stop_id != to_stop_id AND arrival >= departure
    GROUP BY from_stop_id, to_stop_id
  `).iterate()) {
    insertEdge.run(row.from_stop_id, row.to_stop_id, row.min_duration)
    scheduledEdges += 1
    scheduledRows += Number(row.connection_count)
    if (scheduledRows >= nextProgress) {
      onProgress?.({
        phase: 'Building static routing topology',
        progress: 0.02 + Math.min(0.6, scheduledRows / Math.max(1, expectedConnections) * 0.6),
        detail: `${scheduledRows.toLocaleString()} scheduled connections`,
      })
      nextProgress = scheduledRows + 1_000_000
    }
  }

  onProgress?.({ phase: 'Building static routing topology', progress: 0.64, detail: 'Validating interpolated stop-time gaps' })
  let bridgeCount = 0
  // LAG examines the immediately preceding compiled connection in each trip,
  // including connections that do not themselves qualify for a bridge.
  for (const row of sourceDb.prepare(`
    SELECT previous_to_stop_id, from_stop_id, departure - previous_arrival AS duration
    FROM (
      SELECT from_stop_id, departure, stop_sequence, route_id, service_id,
        LAG(to_stop_id) OVER trip_order AS previous_to_stop_id,
        LAG(arrival) OVER trip_order AS previous_arrival,
        LAG(stop_sequence) OVER trip_order AS previous_sequence,
        LAG(route_id) OVER trip_order AS previous_route_id,
        LAG(service_id) OVER trip_order AS previous_service_id
      FROM connections
      WINDOW trip_order AS (PARTITION BY trip_id ORDER BY stop_sequence)
    )
    WHERE previous_to_stop_id != from_stop_id
      AND stop_sequence - previous_sequence > 1
      AND route_id = previous_route_id AND service_id = previous_service_id
      AND departure >= previous_arrival
  `).iterate()) {
    insertEdge.run(row.previous_to_stop_id, row.from_stop_id, row.duration)
    bridgeCount += 1
  }

  onProgress?.({ phase: 'Building static routing topology', progress: 0.78, detail: 'Transfers and station members' })
  let transferCount = 0
  for (const transfer of sourceDb.prepare(`
    SELECT transfer.from_stop_id, transfer.to_stop_id,
      transfer.min_transfer_time, provenance.provenance, provenance.path_distance_m
    FROM transfers AS transfer
    JOIN transfer_provenance AS provenance
      ON provenance.from_stop_id=transfer.from_stop_id
      AND provenance.to_stop_id=transfer.to_stop_id
    WHERE COALESCE(transfer.transfer_type, 0) != 3
      AND transfer.from_stop_id != transfer.to_stop_id
  `).iterate()) {
    insertEdge.run(
      transfer.from_stop_id,
      transfer.to_stop_id,
      transferDurationSeconds(transfer),
    )
    transferCount += 1
  }

  const stopRows = sourceDb.prepare('SELECT stop_id, parent_station, lat, lon FROM stops').all()
  const stopRecords = new Map(stopRows.map(stop => [stop.stop_id, stop]))
  const stopIds = new Set(stopRows.map((stop) => stop.stop_id))
  const stationGroups = new Map()
  for (const stop of stopRows) {
    const groupId = String(stop.parent_station ?? '').trim()
    if (!groupId) continue
    const members = stationGroups.get(groupId) ?? new Set()
    members.add(stop.stop_id)
    stationGroups.set(groupId, members)
  }
  let stationSiblingCount = 0
  for (const [groupId, members] of stationGroups) {
    if (stopIds.has(groupId)) members.add(groupId)
    for (const fromStopId of members) {
      for (const toStopId of members) {
        if (fromStopId === toStopId) continue
        insertEdge.run(fromStopId, toStopId, stationFallbackSeconds(stopRecords.get(fromStopId), stopRecords.get(toStopId), walkingSpeedKph))
        stationSiblingCount += 1
      }
    }
  }
  return { scheduledRows, scheduledEdges, bridgeCount, transferCount, stationSiblingCount }
}

export async function buildNationalStaticTopologySidecar({ storePath, outputPath, onProgress, minimumFreeBytes, force = false }) {
  const resolvedStorePath = path.resolve(storePath)
  const resolvedOutputPath = path.resolve(outputPath)
  readNationalGtfsStoreMetadata(resolvedStorePath)
  const before = inspectNationalStaticTopologySidecar(resolvedStorePath, resolvedOutputPath)
  if (before.ready && force !== true) {
    return {
      ...before,
      built: false,
      sourceStorePath: resolvedStorePath,
      outputPath: resolvedOutputPath,
      bytes: fs.statSync(resolvedOutputPath).size,
    }
  }
  const tempPath = `${resolvedOutputPath}.building`
  await fsp.mkdir(path.dirname(resolvedOutputPath), { recursive: true })
  const sourceStats = await fsp.stat(resolvedStorePath)
  const filesystem = await fsp.statfs(path.dirname(resolvedOutputPath))
  const freeBytesBefore = Number(filesystem.bavail) * Number(filesystem.bsize)
  const reservedBytes = minimumFreeBytes === undefined
    ? adaptiveStaticTopologyReserveBytes(sourceStats.size)
    : Math.max(staticTopologyReserveFloorBytes, numeric(minimumFreeBytes, staticTopologyMinimumFreeBytes))
  if (freeBytesBefore <= reservedBytes + staticTopologyTransientWorkspaceBytes) {
    throw new Error(`Static-topology sidecar requires at least ${Math.ceil((reservedBytes + staticTopologyTransientWorkspaceBytes) / 1024 / 1024)} MB free; only ${Math.floor(freeBytesBefore / 1024 / 1024)} MB is available.`)
  }
  await fsp.rm(tempPath, { force: true })
  const sourceDb = new DatabaseSync(resolvedStorePath, { readOnly: true })
  const targetDb = new DatabaseSync(tempPath)
  const startedAt = performance.now()
  let sourceTransactionOpen = false
  let sourceStorageIdentity = null
  try {
    sourceDb.exec(`PRAGMA query_only=ON; PRAGMA temp_store=FILE; PRAGMA mmap_size=${readOnlySqliteMmapBytes}; PRAGMA cache_size=-${readOnlySqliteCacheKiB};`)
    sourceStorageIdentity = staticTopologySourceStorageIdentity(resolvedStorePath)
    sourceDb.exec('BEGIN')
    sourceTransactionOpen = true
    const sourceMetadata = metadataRecord(sourceDb)
    admitCurrentTransferSemantics(sourceDb, resolvedStorePath, sourceMetadata)
    const sourceFingerprint = staticTopologySourceFingerprint(sourceMetadata)
    targetDb.exec(`PRAGMA page_size=${buildSqlitePageSize}`)
    const pageSize = Number(targetDb.prepare('PRAGMA page_size').get().page_size)
    const guardedMaxPageCount = Math.max(1, Math.floor((freeBytesBefore - reservedBytes) / pageSize))
    targetDb.exec(`
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-${buildSqliteCacheKiB};
      PRAGMA max_page_count=${guardedMaxPageCount};
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE static_topology_edges(
        from_stop_id TEXT NOT NULL,
        to_stop_id TEXT NOT NULL,
        min_duration INTEGER NOT NULL CHECK(min_duration >= 0),
        PRIMARY KEY(from_stop_id, to_stop_id)
      ) WITHOUT ROWID;
      CREATE INDEX static_topology_edges_to ON static_topology_edges(to_stop_id, from_stop_id, min_duration);
      BEGIN IMMEDIATE;
    `)
    const topologyBuild = populateStaticTopology(sourceDb, targetDb, {
      expectedConnections: Math.max(1, Number(sourceMetadata.connectionCount ?? 1)),
      onProgress,
    })
    const identityDuringSnapshot = staticTopologySourceStorageIdentity(resolvedStorePath)
    if (identityDuringSnapshot !== sourceStorageIdentity) {
      throw new Error('Routing store changed while its static-topology snapshot was being built; retry against a stable store.')
    }
    sourceDb.exec('COMMIT')
    sourceTransactionOpen = false
    sourceDb.close()
    if (staticTopologySourceStorageIdentity(resolvedStorePath) !== sourceStorageIdentity) {
      throw new Error('Routing store changed before the static-topology sidecar could be sealed; retry against a stable store.')
    }
    const edgeCount = Number(targetDb.prepare('SELECT COUNT(*) AS count FROM static_topology_edges').get().count)
    const builtAt = new Date().toISOString()
    upsertStaticTopologyMetadata(targetDb, {
      staticTopologyVersion: staticTopologySchemaVersion,
      staticTopologySourceFingerprint: sourceFingerprint,
      staticTopologySourceIdentityVersion,
      staticTopologySourceIdentity: staticTopologySourceIdentity(sourceMetadata),
      staticTopologySourceGeneration: sqliteStoreGeneration(resolvedStorePath),
      staticTopologySourceStorageIdentity: sourceStorageIdentity,
      staticTopologyEdgeCount: edgeCount,
      staticTopologyBuiltAt: builtAt,
      sourceStoreId: sourceMetadata.storeId ?? null,
      sourceConnectionCount: Number(sourceMetadata.connectionCount ?? topologyBuild.scheduledRows),
    })
    targetDb.exec('COMMIT; PRAGMA optimize;')
    targetDb.close()
    await fsp.rename(tempPath, resolvedOutputPath)
    const outputStats = await fsp.stat(resolvedOutputPath)
    onProgress?.({ phase: 'Static routing topology sidecar ready', progress: 1, detail: `${edgeCount.toLocaleString()} edges` })
    return {
      ready: true,
      reason: 'ready',
      version: staticTopologySchemaVersion,
      built: true,
      builtAt,
      edgeCount,
      sourceFingerprint,
      sourceStorageIdentity,
      sourceStorePath: resolvedStorePath,
      outputPath: resolvedOutputPath,
      buildSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)),
      bytes: outputStats.size,
      freeBytesBefore,
      minimumFreeBytes: reservedBytes,
      ...topologyBuild,
    }
  } catch (error) {
    if (sourceTransactionOpen) {
      try { sourceDb.exec('ROLLBACK') } catch {}
    }
    try { targetDb.close() } catch {}
    try { sourceDb.close() } catch {}
    await fsp.rm(tempPath, { force: true })
    throw error
  }
}

function routeModeBand(routeType) {
  const value = numeric(routeType, 3)
  if (value <= 2) return 'rail'
  if (value === 3) return 'bus'
  return 'other'
}

function isHeavyRailRouteType(routeType) {
  const value = numeric(routeType, 3)
  return value === 1 || value === 2 || (value >= 100 && value < 200) || (value >= 400 && value < 500)
}

function stopAccessCellKey(latitudeCell, longitudeCell) {
  return `${latitudeCell}:${longitudeCell}`
}

function buildStopAccessIndex(db, stopRecords, stationMembers) {
  const startedAt = performance.now()
  const hasStopModes = Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='stop_modes'").get())
  if (!hasStopModes) {
    return {
      ready: false,
      reason: 'stop_modes_absent',
      strategy: 'resident_stop_access_index_required',
      cellDegrees: stopAccessSpatialCellDegrees,
      anchorCount: 0,
      profiledAnchorCount: 0,
      cellCount: 0,
      modeRowCount: 0,
      estimatedBytes: 0,
      buildMs: Number((performance.now() - startedAt).toFixed(3)),
      queryCount: 0,
      queryMs: 0,
    }
  }
  const rawDeparturesByStop = new Map()
  let modeRowCount = 0
  for (const row of db.prepare('SELECT stop_id, route_type, departure_count FROM stop_modes ORDER BY stop_id, route_type').iterate()) {
    const stopId = String(row.stop_id)
    const routeType = numeric(row.route_type, 3)
    const departures = Math.max(0, numeric(row.departure_count, 0))
    const routeDepartures = rawDeparturesByStop.get(stopId) ?? new Map()
    routeDepartures.set(routeType, (routeDepartures.get(routeType) ?? 0) + departures)
    rawDeparturesByStop.set(stopId, routeDepartures)
    modeRowCount += 1
  }
  const departureServiceStopIds = new Set()
  const arrivalServiceStopIds = new Set()
  const directServiceStopIds = new Set()
  let roleRowCount = 0
  for (const row of db.prepare(`
    SELECT stop_id, can_board, can_alight
    FROM stop_access_roles
    ORDER BY stop_id
  `).iterate()) {
    const stopId = String(row.stop_id)
    const parentStation = String(stopRecords.get(stopId)?.parent_station ?? '').trim()
    if (row.can_board === 1) {
      directServiceStopIds.add(stopId)
      departureServiceStopIds.add(stopId)
      if (parentStation) departureServiceStopIds.add(parentStation)
    }
    if (row.can_alight === 1) {
      directServiceStopIds.add(stopId)
      arrivalServiceStopIds.add(stopId)
      if (parentStation) arrivalServiceStopIds.add(parentStation)
    }
    roleRowCount += 1
  }

  const createProfile = (routeDepartureMap, sampleCount) => {
    const routeDepartures = [...routeDepartureMap]
      .map(([routeType, departures]) => ({ routeType, departures }))
      .sort((left, right) => left.routeType - right.routeType)
    const departureCount = routeDepartures.reduce((sum, entry) => sum + entry.departures, 0)
    const profile = { routeDepartures, departureCount, sampleCount }
    profile.routeTypes = profile.routeDepartures.map((entry) => entry.routeType)
    profile.modes = ['rail', 'bus', 'other'].filter((mode) => profile.routeTypes.some((routeType) => routeModeBand(routeType) === mode))
    profile.hasHeavyRail = profile.routeTypes.some(isHeavyRailRouteType)
    return Object.freeze(profile)
  }
  const profilesByStop = new Map()
  const directProfilesByStop = new Map()
  for (const [stopId, routeDepartures] of rawDeparturesByStop) {
    const directDepartureCount = [...routeDepartures.values()].reduce((sum, departures) => sum + departures, 0)
    directProfilesByStop.set(stopId, createProfile(routeDepartures, Math.min(12, directDepartureCount)))
  }
  for (const stop of stopRecords.values()) {
    const direct = rawDeparturesByStop.get(stop.stop_id) ?? new Map()
    const routeDepartures = new Map(direct)
    const directDepartureCount = [...direct.values()].reduce((sum, departures) => sum + departures, 0)
    let sampleCount = Math.min(12, directDepartureCount)
    if (numeric(stop.location_type, 0) === 1) {
      const memberDepartures = new Map()
      let memberSampleCount = 0
      for (const memberId of stationMembers.get(stop.stop_id) ?? []) {
        if (memberId === stop.stop_id) continue
        const member = rawDeparturesByStop.get(memberId)
        if (!member) continue
        const memberTotal = [...member.values()].reduce((sum, departures) => sum + departures, 0)
        memberSampleCount += Math.min(12, memberTotal)
        for (const [routeType, departures] of member) {
          memberDepartures.set(routeType, (memberDepartures.get(routeType) ?? 0) + departures)
        }
      }
      if (memberDepartures.size) {
        // Platform rows and their parent aggregate may describe the same
        // departures. Max preserves the signal without counting service twice.
        for (const [routeType, departures] of memberDepartures) {
          routeDepartures.set(routeType, Math.max(routeDepartures.get(routeType) ?? 0, departures))
        }
        sampleCount = Math.max(memberSampleCount, Math.min(12, directDepartureCount))
      }
    }
    if (routeDepartures.size) profilesByStop.set(stop.stop_id, createProfile(routeDepartures, sampleCount))
  }

  const anchors = []
  const cells = new Map()
  for (const stop of stopRecords.values()) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue
    if (numeric(stop.location_type, 0) !== 1 && stop.parent_station !== null && stop.parent_station !== undefined && stop.parent_station !== '') continue
    const anchor = Object.freeze(stop)
    anchors.push(anchor)
    const latitudeCell = Math.floor(anchor.lat / stopAccessSpatialCellDegrees)
    const longitudeCell = Math.floor(anchor.lon / stopAccessSpatialCellDegrees)
    const key = stopAccessCellKey(latitudeCell, longitudeCell)
    const entries = cells.get(key) ?? []
    entries.push(anchor)
    cells.set(key, entries)
  }
  anchors.sort((left, right) => String(left.stop_id).localeCompare(String(right.stop_id)))
  for (const entries of cells.values()) entries.sort((left, right) => String(left.stop_id).localeCompare(String(right.stop_id)))
  const estimatedBytes = anchors.length * 96 + modeRowCount * 40 + roleRowCount * 24 + cells.size * 64
  return {
    ready: true,
    reason: 'ready',
    strategy: 'immutable_grid_persisted_exact_stop_roles',
    cellDegrees: stopAccessSpatialCellDegrees,
    anchors,
    cells,
    profilesByStop,
    directProfilesByStop,
    directServiceStopIds,
    departureServiceStopIds,
    arrivalServiceStopIds,
    anchorCount: anchors.length,
    profiledAnchorCount: anchors.reduce((count, anchor) => count + (profilesByStop.has(anchor.stop_id) ? 1 : 0), 0),
    cellCount: cells.size,
    modeRowCount,
    roleRowCount,
    estimatedBytes,
    buildMs: Number((performance.now() - startedAt).toFixed(3)),
    queryCount: 0,
    queryMs: 0,
  }
}

function stopAccessIndexDiagnostics(store) {
  const index = store.stopAccessIndex
  return {
    ready: index.ready,
    reason: index.reason,
    strategy: index.strategy,
    cellDegrees: index.cellDegrees,
    anchorCount: index.anchorCount,
    profiledAnchorCount: index.profiledAnchorCount,
    cellCount: index.cellCount,
    modeRowCount: index.modeRowCount,
    estimatedBytes: index.estimatedBytes,
    buildMs: index.buildMs,
    queryCount: index.queryCount,
    queryMs: timingMilliseconds(index.queryMs),
  }
}

function sampledAnchorServiceProfile(store, anchor) {
  return store.stopAccessIndex.profilesByStop?.get(anchor.stop_id) ?? {
    modes: [], routeTypes: [], routeDepartures: [], hasHeavyRail: false, sampleCount: 0, departureCount: 0,
  }
}

function compareAccessDistance(left, right) {
  return left.distanceKm - right.distanceKm || String(left.stop_id).localeCompare(String(right.stop_id))
}

function expandAccessAnchors(store, anchors, limit = Number.POSITIVE_INFINITY) {
  const expanded = new Map()
  for (const anchor of anchors) {
    if (expanded.size >= limit) break
    const memberIds = anchor.location_type === 1 && (anchor.distanceKm <= 0.02 || anchor.expandServiceMembers)
      ? (store.stationMembers.get(anchor.stop_id) ?? [anchor.stop_id])
      : [anchor.stop_id]
    for (const stopId of memberIds) {
      const member = store.stopRecords.get(stopId)
      if (!member) continue
      if (!expanded.has(member.stop_id) && expanded.size >= limit) break
      expanded.set(member.stop_id, {
        ...member,
        distanceKm: anchor.distanceKm,
        accessPriority: anchor.accessPriority,
        expandServiceMembers: anchor.expandServiceMembers,
      })
    }
  }
  return [...expanded.values()].sort(compareAccessDistance)
}

function nearbyIndexedAccessAnchors(index, coordinate, maxWalkKm, options = {}) {
  const latDelta = maxWalkKm / 110.574
  const lonDelta = maxWalkKm / Math.max(1, 111.32 * Math.cos(coordinate[1] * Math.PI / 180))
  const minimumLatitude = coordinate[1] - latDelta
  const maximumLatitude = coordinate[1] + latDelta
  const minimumLongitude = coordinate[0] - lonDelta
  const maximumLongitude = coordinate[0] + lonDelta
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : Number.POSITIVE_INFINITY
  const bounded = []
  for (let latitudeCell = Math.floor(minimumLatitude / index.cellDegrees); latitudeCell <= Math.floor(maximumLatitude / index.cellDegrees); latitudeCell += 1) {
    for (let longitudeCell = Math.floor(minimumLongitude / index.cellDegrees); longitudeCell <= Math.floor(maximumLongitude / index.cellDegrees); longitudeCell += 1) {
      for (const anchor of index.cells.get(stopAccessCellKey(latitudeCell, longitudeCell)) ?? []) {
        if (anchor.lat < minimumLatitude || anchor.lat > maximumLatitude || anchor.lon < minimumLongitude || anchor.lon > maximumLongitude) continue
        const distanceKm = haversineKm(coordinate, [anchor.lon, anchor.lat])
        if (Number.isFinite(limit) && distanceKm > maxWalkKm) continue
        bounded.push({ ...anchor, distanceKm })
        if (Number.isFinite(limit) && bounded.length >= limit * 2) {
          bounded.sort(compareAccessDistance)
          bounded.length = limit
        }
      }
    }
  }
  bounded.sort(compareAccessDistance)
  if (Number.isFinite(limit) && bounded.length > limit) bounded.length = limit
  return { bounded, nearby: bounded.filter((anchor) => anchor.distanceKm <= maxWalkKm) }
}

function nearestStopsFromIndex(store, coordinate, maxWalkKm, limit = 12) {
  const startedAt = performance.now()
  const index = store.stopAccessIndex
  const { bounded, nearby } = nearbyIndexedAccessAnchors(index, coordinate, maxWalkKm)
  const anchorMap = new Map(nearby.slice(0, limit).map((stop) => [stop.stop_id, stop]))
  const profiled = nearby.slice(0, 256)
    .map((anchor) => ({ anchor, profile: sampledAnchorServiceProfile(store, anchor) }))
    .filter(({ profile }) => profile.sampleCount > 0)
    .sort((left, right) => (
      right.profile.sampleCount - left.profile.sampleCount
      || compareAccessDistance(left.anchor, right.anchor)
    ))
  const retained = new Map()
  for (const candidate of profiled.slice(0, 4)) retained.set(candidate.anchor.stop_id, candidate)
  const priorityModesByStop = new Map()
  const primaryHeavyRail = profiled.find(({ anchor, profile }) => anchor.location_type === 1 && profile.hasHeavyRail)
    ?? profiled.find(({ profile }) => profile.hasHeavyRail)
  for (const mode of ['rail', 'bus', 'other']) {
    const candidate = mode === 'rail'
      ? primaryHeavyRail ?? profiled.find(({ profile }) => profile.modes.includes(mode))
      : profiled.find(({ profile }) => profile.modes.includes(mode))
    if (!candidate) continue
    retained.set(candidate.anchor.stop_id, candidate)
    const modes = priorityModesByStop.get(candidate.anchor.stop_id) ?? []
    modes.push(mode)
    priorityModesByStop.set(candidate.anchor.stop_id, modes)
  }
  const primaryRailStopId = primaryHeavyRail?.anchor.stop_id
    ?? profiled.find(({ profile }) => profile.modes.includes('rail'))?.anchor.stop_id
  for (const { anchor } of retained.values()) {
    const priorityModes = priorityModesByStop.get(anchor.stop_id)
    anchorMap.set(anchor.stop_id, {
      ...anchor,
      accessPriority: priorityModes?.length ? `sampled-${priorityModes.join('-')}:${anchor.stop_id}` : undefined,
      expandServiceMembers: anchor.stop_id === primaryRailStopId,
    })
  }

  // A map point is an access area, not a request to bind to one station.
  // Keep every heavy-rail station inside the physical walk radius in the
  // street target set. Dense bus stops can otherwise consume the crow-flight
  // shortlist before OSM routing sees a station entrance at all.
  for (const anchor of nearby) {
    if (numeric(anchor.location_type, 0) !== 1) continue
    const profile = sampledAnchorServiceProfile(store, anchor)
    if (!profile.hasHeavyRail) continue
    anchorMap.set(anchor.stop_id, {
      ...anchor,
      accessPriority: `sampled-rail-station:${anchor.stop_id}`,
      expandServiceMembers: true,
    })
  }

  const squaredDistance = (anchor) => (anchor.lat - coordinate[1]) ** 2 + (anchor.lon - coordinate[0]) ** 2
  for (const [minimumType, maximumType] of [[0, 2], [3, 3], [4, 99]]) {
    const rows = []
    for (const anchor of bounded) {
      const profile = index.directProfilesByStop.get(anchor.stop_id)
      for (const entry of profile?.routeDepartures ?? []) {
        if (entry.routeType >= minimumType && entry.routeType <= maximumType) rows.push({ anchor, ...entry })
      }
    }
    rows.sort((left, right) => (
      squaredDistance(left.anchor) - squaredDistance(right.anchor)
      || right.departures - left.departures
      || String(left.anchor.stop_id).localeCompare(String(right.anchor.stop_id))
      || left.routeType - right.routeType
    ))
    for (const { anchor } of rows.slice(0, 6)) {
      if (anchor.distanceKm > maxWalkKm) continue
      const existing = anchorMap.get(anchor.stop_id)
      anchorMap.set(anchor.stop_id, {
        ...anchor,
        accessPriority: existing?.accessPriority,
        expandServiceMembers: existing?.expandServiceMembers,
      })
    }
  }

  const serviceCandidates = bounded
    .filter((anchor) => (index.directProfilesByStop.get(anchor.stop_id)?.departureCount ?? 0) > 0)
    .sort((left, right) => (
      (index.directProfilesByStop.get(right.stop_id)?.departureCount ?? 0) - (index.directProfilesByStop.get(left.stop_id)?.departureCount ?? 0)
      || squaredDistance(left) - squaredDistance(right)
      || String(left.stop_id).localeCompare(String(right.stop_id))
    ))
    .slice(0, 6)
    .filter((anchor) => anchor.distanceKm <= maxWalkKm)
    .sort(compareAccessDistance)
  for (const anchor of serviceCandidates) {
    const existing = anchorMap.get(anchor.stop_id)
    anchorMap.set(anchor.stop_id, {
      ...anchor,
      accessPriority: existing?.accessPriority,
      expandServiceMembers: existing?.expandServiceMembers,
    })
  }
  const candidates = expandAccessAnchors(store, [...anchorMap.values()])
  index.queryCount += 1
  index.queryMs += performance.now() - startedAt
  return candidates
}

function nearestStops(store, coordinate, maxWalkKm, limit = 12) {
  if (!store.stopAccessIndex.ready) {
    const error = new Error(
      `Resident stop-access index is required: ${store.stopAccessIndex.reason ?? 'unavailable'}`,
    )
    error.code = 'resident_stop_access_index_required'
    throw error
  }
  return nearestStopsFromIndex(store, coordinate, maxWalkKm, limit)
}

function expandParentStationTransfers(rawTransfers, stopRecords, stationMembers) {
  const targetMaps = new Map()
  let rawTransferCount = 0
  const add = (transfer) => {
    if (!stopRecords.has(transfer.from_stop_id) || !stopRecords.has(transfer.to_stop_id)) return
    const targets = targetMaps.get(transfer.from_stop_id) ?? new Map()
    const current = targets.get(transfer.to_stop_id)
    const duration = transferDurationSeconds(transfer)
    if (!current || duration < current.min_transfer_time) {
      targets.set(transfer.to_stop_id, {
        ...transfer,
        min_transfer_time: duration,
      })
    }
    targetMaps.set(transfer.from_stop_id, targets)
  }
  const serviceMembers = (stopId) => {
    const stop = stopRecords.get(stopId)
    if (numeric(stop?.location_type, 0) !== 1) return [stopId]
    const members = (stationMembers.get(stopId) ?? []).filter((memberId) => (
      memberId !== stopId
      && numeric(stopRecords.get(memberId)?.location_type, 0) === 0
    ))
    return members.length ? members : [stopId]
  }

  for (const rawTransfer of rawTransfers) {
    rawTransferCount += 1
    const transfer = rawTransfer.provenance === 'osm_certified_radial'
      ? {
          ...rawTransfer,
          min_transfer_time: walkSeconds(numeric(rawTransfer.path_distance_m, 0) / 1000),
        }
      : rawTransfer
    add(transfer)
    const fromMembers = serviceMembers(transfer.from_stop_id)
    const toMembers = serviceMembers(transfer.to_stop_id)
    if (fromMembers.length === 1 && fromMembers[0] === transfer.from_stop_id
      && toMembers.length === 1 && toMembers[0] === transfer.to_stop_id) continue
    for (const fromStopId of fromMembers) {
      for (const toStopId of toMembers) {
        add({
          ...transfer,
          from_stop_id: fromStopId,
          to_stop_id: toStopId,
          parent_station_transfer: true,
        })
      }
    }
  }

  const transfers = new Map()
  let resolvedTransferCount = 0
  for (const [fromStopId, targets] of targetMaps) {
    const rows = [...targets.values()].sort((left, right) => left.to_stop_id.localeCompare(right.to_stop_id))
    transfers.set(fromStopId, rows)
    resolvedTransferCount += rows.length
  }
  return { transfers, rawTransferCount, resolvedTransferCount }
}

function transferPairKey(fromStopId, toStopId) {
  return `${fromStopId}\u0000${toStopId}`
}

function isForbiddenTransfer(store, fromStopId, toStopId) {
  return store.forbiddenTransferPairs.has(transferPairKey(fromStopId, toStopId))
}

function routingSemanticsFromMetadata(metadata, hasConnectionPermissions) {
  const blockingRoutingFeatures = Array.isArray(metadata.blockingRoutingFeatures)
    ? metadata.blockingRoutingFeatures
    : []
  const routingLimitations = Array.isArray(metadata.routingLimitations)
    ? [...metadata.routingLimitations]
    : []
  const missingFeatureInventoryKeys = requiredRoutingFeatureInventoryKeys.filter((key) => (
    !metadata.featureInventory
    || !Object.prototype.hasOwnProperty.call(metadata.featureInventory, key)
  ))
  if (
    missingFeatureInventoryKeys.length
    && !routingLimitations.some((feature) => feature.code === 'feature_inventory_incomplete')
  ) {
    routingLimitations.push({
      code: 'feature_inventory_incomplete',
      count: missingFeatureInventoryKeys.length,
      exactness: 'unknown',
      detail: `This routing store predates required feature inventory fields (${missingFeatureInventoryKeys.join(', ')}); rebuild it before making complete-feed claims.`,
    })
  }
  const transferGeneration = metadata.transferGeneration ?? null
  const sourceFingerprint = staticTopologySourceFingerprint(metadata)
  const routingCoverage = immutableJsonSnapshot(supportedScheduledCoreCoverage({
    routingLimitations,
  }))
  const routingDataSemantics = immutableJsonSnapshot({
    sourceFingerprint,
    blockingFeatures: blockingRoutingFeatures,
    limitations: routingLimitations,
    routingCoverage,
    transferSemanticsVersion,
    transferEpisode: {
      schemaVersion: 'vigo.routing.transfer-episode.v1',
      maximumExplicitEdgesBeforeBoarding: 1,
      maximumGeneratedOsmWalkM: osmTransferMaximumWalkM,
      resetsAfterBoarding: true,
    },
    transferGeneration,
    hasConnectionPermissions,
  })
  return {
    blockingRoutingFeatures,
    routingLimitations,
    routingCoverage,
    routingDataSemantics,
    transferGeneration,
    sourceFingerprint,
  }
}

function deferredStopAccessIndex() {
  return {
    ready: false,
    reason: 'deferred',
    strategy: 'deferred_until_coordinate_access',
    cellDegrees: stopAccessSpatialCellDegrees,
    anchors: [],
    cells: new Map(),
    profilesByStop: new Map(),
    directProfilesByStop: new Map(),
    directServiceStopIds: new Set(),
    departureServiceStopIds: new Set(),
    arrivalServiceStopIds: new Set(),
    anchorCount: 0,
    profiledAnchorCount: 0,
    cellCount: 0,
    modeRowCount: 0,
    roleRowCount: 0,
    estimatedBytes: 0,
    buildMs: 0,
    queryCount: 0,
    queryMs: 0,
  }
}

function ensureNationalStoreTransferSemantics(store) {
  if (store.transferSemanticsAdmission?.ready) return store.transferSemanticsAdmission
  const startedAt = performance.now()
  admitCurrentTransferSemantics(store.db, store.storePath, store.metadata)
  store.transferSemanticsAdmission = {
    ready: true,
    reason: 'ready',
    admissionMs: Number((performance.now() - startedAt).toFixed(3)),
  }
  return store.transferSemanticsAdmission
}

function buildNationalStoreAccessMaterialization(store) {
  ensureNationalStoreTransferSemantics(store)
  const db = store.db
  const transferSelect = `
    SELECT transfer.from_stop_id, transfer.to_stop_id, transfer.transfer_type,
      transfer.min_transfer_time, provenance.provenance,
      provenance.evidence_fingerprint, provenance.path_distance_m
    FROM transfers AS transfer
    JOIN transfer_provenance AS provenance
      ON provenance.from_stop_id=transfer.from_stop_id
      AND provenance.to_stop_id=transfer.to_stop_id
  `
  const stationMembers = new Map()
  const stopRecords = new Map()
  for (const stop of db.prepare('SELECT stop_id, name, lat, lon, parent_station, location_type FROM stops ORDER BY stop_id').all()) {
    stopRecords.set(stop.stop_id, stop)
    if (stop.parent_station) {
      const list = stationMembers.get(stop.parent_station) ?? []
      list.push(stop.stop_id)
      stationMembers.set(stop.parent_station, list)
    }
  }
  for (const [parentStation, members] of stationMembers) {
    if (stopRecords.has(parentStation) && !members.includes(parentStation)) members.unshift(parentStation)
  }
  const {
    transfers,
    rawTransferCount,
    resolvedTransferCount,
  } = expandParentStationTransfers(
    db.prepare(`${transferSelect} WHERE transfer.transfer_type != 3`).iterate(),
    stopRecords,
    stationMembers,
  )
  const forbiddenTransferExpansion = expandParentStationTransfers(
    db.prepare(`${transferSelect} WHERE transfer.transfer_type = 3`).iterate(),
    stopRecords,
    stationMembers,
  )
  const forbiddenTransferPairs = new Set()
  for (const [fromStopId, targets] of forbiddenTransferExpansion.transfers) {
    for (const transfer of targets) forbiddenTransferPairs.add(transferPairKey(fromStopId, transfer.to_stop_id))
  }
  const stopAccessIndex = buildStopAccessIndex(db, stopRecords, stationMembers)
  if (!stopAccessIndex.ready) {
    const error = new Error(
      `Routing store requires a resident stop-access index and must be rebuilt: ${stopAccessIndex.reason}`,
    )
    error.code = 'resident_stop_access_index_required'
    throw error
  }
  return {
    transfers,
    forbiddenTransferPairs,
    rawTransferCount,
    rawForbiddenTransferCount: forbiddenTransferExpansion.rawTransferCount,
    resolvedTransferCount,
    stationMembers,
    stopRecords,
    stopAccessIndex,
  }
}

function ensureNationalStoreAccessMaterialization(store) {
  if (store.accessMaterialization?.ready) return store.accessMaterialization
  const startedAt = performance.now()
  ensureNationalStoreTransferSemantics(store)
  const prepared = loadPreparedAccessContext(store, nationalRoutingAccessPolicyIdentity)
  const materialized = prepared.materialized ?? buildNationalStoreAccessMaterialization(store)
  Object.assign(store, materialized)
  store.preparedStationPaths = prepared.stationPaths ?? null
  store.stopLookup = { get: (stopId) => store.stopRecords.get(stopId) }
  store.accessMaterialization = {
    ready: true,
    reason: 'ready',
    stopCount: store.stopRecords.size,
    stationGroups: store.stationMembers.size,
    transferOrigins: store.transfers.size,
    resolvedTransferEdges: store.resolvedTransferCount,
    materializeMs: Number((performance.now() - startedAt).toFixed(3)),
    persistenceState: prepared.persistenceState,
    snapshotPath: prepared.snapshotPath,
    ...(prepared.persistenceError ? { persistenceError: prepared.persistenceError } : {}),
  }
  return store.accessMaterialization
}

function persistNationalStoreAccessMaterialization(store) {
  if (!store.accessMaterialization?.ready
    || ['loaded', 'written'].includes(store.accessMaterialization.persistenceState)) return
  Object.assign(store.accessMaterialization, persistPreparedAccessContext(store, nationalRoutingAccessPolicyIdentity))
}

function openNationalStore(storePath, options = {}) {
  const resolvedStorePath = path.resolve(storePath)
  const cached = boundedCacheGet(nationalStoreCache, resolvedStorePath)
  const requireAccess = options.requireAccess !== false
  const validateTransfers = options.validateTransfers !== false
  if (cached) {
    if (validateTransfers) ensureNationalStoreTransferSemantics(cached)
    if (requireAccess) ensureNationalStoreAccessMaterialization(cached)
    return cached
  }
  let db
  try {
    // The authoritative GTFS SQLite file is immutable at request time. All
    // per-request service activation remains writable because active_services
    // belongs to this connection's TEMP database, not to the main file.
    try {
      db = new DatabaseSync(resolvedStorePath, { readOnly: true })
    } catch (error) {
      throw routingStoreAdmissionError(
        resolvedStorePath,
        'sqlite_open_failed',
        `SQLite could not open the authoritative file read-only (${error instanceof Error ? error.message : String(error)}).`,
      )
    }
    const { admission, metadata } = admitNationalRoutingStore(db, resolvedStorePath)
    db.exec(`PRAGMA mmap_size=${readOnlySqliteMmapBytes}; PRAGMA cache_size=-${readOnlySqliteCacheKiB}; PRAGMA temp_store=MEMORY; CREATE TEMP TABLE active_services(service_id TEXT PRIMARY KEY) WITHOUT ROWID;`)
  const shapeTablesPresent = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type='table' AND name IN ('trip_shapes', 'shape_points')
  `).get()?.count ?? 0) === 2
  const shapeTablesReady = shapeTablesPresent
    && Boolean(db.prepare('SELECT 1 AS ready FROM trip_shapes LIMIT 1').get()?.ready)
    && Boolean(db.prepare('SELECT 1 AS ready FROM shape_points LIMIT 1').get()?.ready)
  const hasConnectionPermissions = db.prepare(`
    SELECT 1 AS ready
    FROM sqlite_master
    WHERE type='table' AND name='connection_permissions'
  `).get()?.ready === 1
  const stopTimesTablePresent = db.prepare(`
    SELECT 1 AS ready FROM sqlite_master
    WHERE type='table' AND name='stop_times'
  `).get()?.ready === 1
  const staticTopology = inspectStaticTopologyDatabase(db)
  const sourceStorageSnapshot = staticTopologySourceStorageSnapshot(resolvedStorePath)
  const sourceArtifactIdentity = routingArtifactSourceIdentity(
    resolvedStorePath,
    metadata,
  )
  const {
    blockingRoutingFeatures,
    routingLimitations,
    routingCoverage,
    routingDataSemantics,
    transferGeneration,
    sourceFingerprint,
  } = routingSemanticsFromMetadata(metadata, hasConnectionPermissions)
  const state = {
    db,
    metadata,
    agencyTimezones: Array.isArray(metadata.agencyTimezones)
      ? metadata.agencyTimezones.map((timezone) => String(timezone)).filter(Boolean)
      : [],
    admission,
    storePath: resolvedStorePath,
    staticTopologySidecarPath: nationalStaticTopologySidecarPath(resolvedStorePath),
    transfers: new Map(),
    forbiddenTransferPairs: new Set(),
    rawTransferCount: 0,
    rawForbiddenTransferCount: 0,
    resolvedTransferCount: 0,
    stationMembers: new Map(),
    stopRecords: new Map(),
    stopAccessIndex: deferredStopAccessIndex(),
    accessMaterialization: {
      ready: false,
      reason: 'deferred',
      materializeMs: 0,
    },
    transferSemanticsAdmission: {
      ready: false,
      reason: 'deferred',
      admissionMs: 0,
    },
    servicesByDate: new Map(),
    serviceDateResolutionCache: new Map(),
    activeServiceDate: null,
    activeServiceCalendarKey: null,
    serviceModel: metadata.serviceModel || 'exact-date',
    connectionCount: Number(metadata.connectionCount ?? 0),
    sourceFingerprint,
    blockingRoutingFeatures,
    routingLimitations,
    routingCoverage,
    routingDataSemantics,
    transferSemanticsVersion,
    transferGeneration,
    hasConnectionPermissions,
    sourceStorageIdentity: sourceStorageSnapshot,
    sourceArtifactIdentity,
    sourceScopes: Array.isArray(metadata.sourceStores)
      ? metadata.sourceStores.map((source) => String(source.scope || '')).filter(Boolean)
      : [],
    accessStopsCache: new Map(),
    reachTargetCache: new Map(),
    nativeCoordinateAccessProfiles: new Map(),
    shapeGeometryCache: new Map(),
    shapeGeometryCacheBytes: 0,
    shapeGeometryCacheMaxEntries,
    shapeGeometryCacheMaxBytes,
    tripShapeIdCache: new Map(),
    tripShapeIdCacheMaxEntries,
    nativeStreetPathCache: new WeightedLruCache(nativeStreetPathCacheLimits),
    activeServiceKernel: null,
    activeServiceKernelContexts: new Map(),
    activeServiceKernelStatus: {
      ready: false,
      reason: 'not_prepared',
      maxSegments: activeServiceKernelMaxSegments || null,
      maxEstimatedBytes: activeServiceKernelMaxEstimatedBytes || null,
    },
    stopLookup: null,
    routeLookup: new Map(db.prepare('SELECT route_id, route_type, short_name, long_name, color FROM routes').all()
      .map(route => [route.route_id, route])),
    realtimeTripStopTimesLookup: stopTimesTablePresent ? db.prepare(`
      SELECT stop_sequence, stop_id, arrival, departure, can_board, can_alight
      FROM stop_times WHERE trip_id=? ORDER BY stop_sequence
    `) : null,
    realtimeTripConnectionsLookup: db.prepare(`
      SELECT trip_id, route_id, service_id, direction_id,
        from_stop_id, to_stop_id, departure, arrival, stop_sequence
      FROM connections WHERE trip_id=? ORDER BY stop_sequence
    `),
    tripShapeLookup: shapeTablesReady ? db.prepare('SELECT shape_id FROM trip_shapes WHERE trip_id=?') : null,
    shapePointsLookup: shapeTablesReady ? db.prepare('SELECT lon, lat FROM shape_points WHERE shape_id=? ORDER BY sequence') : null,
    staticTopology,
  }
  state.stopLookup = { get: (stopId) => state.stopRecords.get(stopId) }
  if (validateTransfers) ensureNationalStoreTransferSemantics(state)
  if (requireAccess) ensureNationalStoreAccessMaterialization(state)
  while (nationalStoreCache.size >= nationalStoreCacheMaxEntries) {
    const oldestStorePath = nationalStoreCache.keys().next().value
    if (oldestStorePath === undefined) break
    invalidateNationalStore(oldestStorePath)
  }
  nationalStoreCache.set(resolvedStorePath, state)
  return state
  } catch (error) {
    try { db?.close() } catch {}
    throw error
  }
}

export function prepareNationalGtfsStore(storePath) {
  const store = openNationalStore(storePath)
  persistNationalStoreAccessMaterialization(store)
  return {
    ready: true,
    accessMaterialization: store.accessMaterialization,
    serviceModel: store.serviceModel,
    transferOrigins: store.transfers.size,
    rawTransferRules: store.rawTransferCount,
    rawForbiddenTransferRules: store.rawForbiddenTransferCount,
    resolvedTransferEdges: store.resolvedTransferCount,
    sourceFingerprint: store.sourceFingerprint,
    blockingRoutingFeatures: store.blockingRoutingFeatures,
    routingLimitations: store.routingLimitations,
    routingCoverage: store.routingCoverage,
    transferSemanticsVersion: store.transferSemanticsVersion,
    transferGeneration: store.transferGeneration,
    storeAdmission: store.admission,
    stationGroups: store.stationMembers.size,
    stopAccessIndex: stopAccessIndexDiagnostics(store),
    staticTopology: { ...store.staticTopology, source: 'store', routingRole: 'analysis_only' },
  }
}

export function prepareNationalGtfsRoutingReadiness(storePath) {
  const startedAt = performance.now()
  const store = openNationalStore(storePath, {
    requireAccess: false,
    validateTransfers: false,
  })
  return {
    ready: true,
    queryMs: Number((performance.now() - startedAt).toFixed(3)),
    serviceModel: store.serviceModel,
    storeAdmission: store.admission,
    transferSemanticsAdmission: store.transferSemanticsAdmission,
    accessMaterialization: store.accessMaterialization,
    serviceDateResolution: null,
    serviceDateOptions: [],
    activeServiceKernel: {
      ready: false,
      reason: 'background_preparation',
    },
    nativeTimetableKernel: null,
    routeGeometry: null,
    nativeCoordinateAccess: null,
    routingPipelinePrewarm: null,
    staticTopology: {
      ...store.staticTopology,
      source: 'store',
      routingRole: 'analysis_only',
    },
  }
}

export function prepareNationalGtfsRoutingContext(storePath, options = {}) {
  const startedAt = performance.now()
  const store = openNationalStore(storePath, {
    requireAccess: options.prepareAccess !== false,
  })
  const kernelSourcePreflight = activeServiceKernelSourcePreflight(store)
  let serviceDateResolution = null
  let activeServices = 0
  let activeServiceKernel = activeServiceKernelSnapshot(store)
  let nativeTimetableKernel = null
  const serviceDay = options.serviceDate
    ? resolveServiceDay(options.serviceDate, options.serviceDay)
    : null
  if (options.serviceDate) {
    serviceDateResolution = resolveServiceDate(
      store,
      options.serviceDate,
      serviceDay,
      options.allowServiceDateFallback === true,
    )
    const services = activateServices(store, serviceDateResolution.resolvedServiceDate, serviceDay)
    activeServices = services.size
    activeServiceKernel = requiredServiceCoverageIncomplete(options, serviceDateResolution)
      ? {
          ready: false,
          reason: 'incomplete_service_coverage',
          detail: `Only ${serviceDateResolution.resolvedServiceScopeCount} of ${serviceDateResolution.availableServiceScopeCount} required feed scopes are active.`,
          serviceKey: store.activeServiceDate,
        }
      : ensureActiveServiceKernel(store, services).status
    if (activeServiceKernel.ready) {
      nativeTimetableKernel = store.activeServiceKernel?.nativeTimetableKernel ?? null
    }
  }
  const nativeCoordinateAccess = options.streetStorePath
    ? (() => {
        const streetStorageIdentity = currentStreetStoreStorageIdentity(options.streetStorePath)
        const prepared = nativeCoordinateAccessProfile(
          store,
          options.streetStorePath,
          streetStorageIdentity,
        )
        return {
          ready: true,
          profileKey: prepared.profile.profileKey,
          transferLinkedAccess: {
            ready: true,
            engine: 'rust_exact_station_transfer_frontier_v1',
            sourceTransfers: prepared.profile.transferFromStopKeys.length,
            eligibleEdges: prepared.diagnostics.linkedAccessEdgeCount,
          },
          ...prepared.diagnostics,
        }
      })()
    : null
  persistNationalStoreAccessMaterialization(store)
  return {
    ready: true,
    queryMs: Number((performance.now() - startedAt).toFixed(3)),
    accessMaterialization: store.accessMaterialization,
    serviceModel: store.serviceModel,
    activeServices,
    activeServiceKernelPreflight: kernelSourcePreflight,
    serviceDateResolution: serviceDateResolution ? serviceDateDiagnostics(serviceDateResolution) : null,
    serviceDateOptions: completeServiceDateSuggestions(
      store,
      serviceDateResolution,
      serviceDay ?? 'weekday',
    ),
    staticTopology: {
      ...store.staticTopology,
      source: 'store',
      routingRole: 'analysis_only',
    },
    activeServiceKernel,
    nativeTimetableKernel,
    routeGeometry: null,
    nativeCoordinateAccess,
    routingPipelinePrewarm: null,
  }
}

export function nationalGtfsRuntimeView(storePath) {
  const store = openNationalStore(storePath)
  return Object.freeze({
    metadata: store.metadata,
    stop(stopId) {
      return store.stopLookup.get(String(stopId ?? '').trim()) ?? null
    },
  })
}

function activeServiceIds(db, date, serviceModel = 'exact-date', serviceDay = 'weekday') {
  const dateNumber = yyyymmdd(date)
  const parsed = parseServiceDate(date)
  if (!dateNumber || !parsed) throw new Error('A valid service date is required for national routing.')
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][parsed.getUTCDay()]
  const services = new Set(db.prepare(`SELECT service_id FROM calendar WHERE start_date <= ? AND end_date >= ? AND ${weekday}=1`).all(dateNumber, dateNumber).map((row) => row.service_id))
  for (const row of db.prepare('SELECT service_id, exception_type FROM calendar_dates WHERE date=?').all(dateNumber)) {
    if (row.exception_type === 1) services.add(row.service_id)
    else if (row.exception_type === 2) services.delete(row.service_id)
  }
  if (!services.size && serviceModel === 'weekday-template') {
    const templateColumn = serviceDay === 'saturday' ? 'saturday' : serviceDay === 'sunday' ? 'sunday' : 'monday'
    for (const row of db.prepare(`SELECT service_id FROM calendar WHERE ${templateColumn}=1`).all()) services.add(row.service_id)
  }
  return services
}

function parseServiceDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').slice(0, 10))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  // Date.UTC treats years 0-99 as 1900-1999. Set the full year after
  // construction so date arithmetic and service-day derivation remain correct
  // for every supported four-digit ISO year.
  const parsed = new Date(0)
  parsed.setUTCFullYear(year, month - 1, day)
  parsed.setUTCHours(12, 0, 0, 0)
  if (
    year < 1
    || year > 9999
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null
  return parsed
}

function parseNumericServiceDate(value) {
  const text = String(Math.trunc(numeric(value))).padStart(8, '0')
  return parseServiceDate(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`)
}

function formatServiceDate(date) {
  return date.toISOString().slice(0, 10)
}

function shiftServiceDate(date, days) {
  return new Date(date.getTime() + days * 86_400_000)
}

function servicesForDate(store, serviceDate, serviceDay = 'weekday') {
  const serviceKey = `${serviceDate}|${serviceDay}`
  const cached = store.servicesByDate.get(serviceKey)
  if (cached) return cached
  const services = activeServiceIds(store.db, serviceDate, store.serviceModel, serviceDay)
  boundedCacheSet(store.servicesByDate, serviceKey, services, 512)
  return services
}

function activeServiceScopes(services, expectedScopes) {
  const scopes = new Set()
  for (const serviceId of services) {
    const separator = String(serviceId).indexOf('\u001f')
    if (separator <= 0) continue
    const scope = String(serviceId).slice(0, separator)
    if (expectedScopes.has(scope)) scopes.add(scope)
  }
  return scopes
}

function completeServiceDateSuggestions(store, resolution, serviceDay = 'weekday') {
  if (
    !resolution
    || store.serviceModel !== 'exact-date-multi-feed'
    || resolution.availableServiceScopeCount < 2
    || resolution.resolvedServiceScopeCount >= resolution.availableServiceScopeCount
  ) return []

  const requested = parseServiceDate(resolution.requestedServiceDate)
  if (!requested) return []
  const cacheKey = `complete-date-options|${resolution.requestedServiceDate}|${serviceDay}`
  const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
  if (cached) return cached

  const expectedScopes = new Set(store.sourceScopes)
  const isComplete = (date) => {
    const services = servicesForDate(store, formatServiceDate(date), serviceDay)
    return activeServiceScopes(services, expectedScopes).size >= expectedScopes.size
  }
  let earlier = null
  let later = null
  // This is a bounded calendar lookup inside the resident worker, not an OD
  // search. Normal gaps resolve in one or two probes; the guard prevents a
  // malformed or disjoint feed pair from scanning an unbounded date range.
  for (let distanceDays = 1; distanceDays <= 62 && (!earlier || !later); distanceDays += 1) {
    if (!earlier) {
      const candidate = shiftServiceDate(requested, -distanceDays)
      if (isComplete(candidate)) earlier = { date: formatServiceDate(candidate), relation: 'earlier', distanceDays }
    }
    if (!later) {
      const candidate = shiftServiceDate(requested, distanceDays)
      if (isComplete(candidate)) later = { date: formatServiceDate(candidate), relation: 'later', distanceDays }
    }
  }

  const options = [earlier, later].filter(Boolean)
  if (options.length) {
    const recommended = [...options].sort((left, right) => (
      left.distanceDays - right.distanceDays
      || (left.relation === 'earlier' ? -1 : 1)
    ))[0]
    recommended.recommended = true
  }
  const result = options.map(({ date, relation, recommended = false }) => ({ date, relation, recommended }))
  boundedCacheSet(store.serviceDateResolutionCache, cacheKey, result, 256)
  return result
}

function serviceDateCandidates(store, requestedDate) {
  const requested = parseServiceDate(requestedDate)
  if (!requested) throw new Error('A valid service date is required for national routing.')
  const targetWeekday = requested.getUTCDay()
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][targetWeekday]
  const seeds = new Set([formatServiceDate(requested)])
  for (const row of store.db.prepare(`SELECT start_date, end_date FROM calendar WHERE ${weekday}=1`).all()) {
    const start = parseNumericServiceDate(row.start_date)
    const end = parseNumericServiceDate(row.end_date)
    if (!start || !end || start > end) continue
    const first = shiftServiceDate(start, (targetWeekday - start.getUTCDay() + 7) % 7)
    const last = shiftServiceDate(end, -((end.getUTCDay() - targetWeekday + 7) % 7))
    if (first > last) continue
    const nearest = requested < first ? first : requested > last ? last : requested
    seeds.add(formatServiceDate(first))
    seeds.add(formatServiceDate(last))
    seeds.add(formatServiceDate(nearest))
  }
  for (const row of store.db.prepare('SELECT DISTINCT date FROM calendar_dates').all()) {
    const exceptionDate = parseNumericServiceDate(row.date)
    if (exceptionDate?.getUTCDay() === targetWeekday) seeds.add(formatServiceDate(exceptionDate))
  }
  const candidates = new Set()
  for (const seed of seeds) {
    const date = parseServiceDate(seed)
    for (const offset of [-7, 0, 7]) {
      const candidate = shiftServiceDate(date, offset)
      if (candidate.getUTCDay() === targetWeekday) candidates.add(formatServiceDate(candidate))
    }
  }
  return candidates
}

function resolveServiceDateUncached(store, requestedServiceDate, serviceDay = 'weekday', allowFallback = false) {
  const requestedDate = parseServiceDate(requestedServiceDate)
  if (!requestedDate) throw new Error('A valid service date is required for national routing.')
  const requested = formatServiceDate(requestedDate)
  if (store.serviceModel === 'weekday-template') {
    const exactRequestedServices = activeServiceIds(store.db, requested, 'exact-date', serviceDay)
    const templateServices = exactRequestedServices.size ? exactRequestedServices : servicesForDate(store, requested, serviceDay)
    const expectedScopes = new Set(store.sourceScopes)
    const requestedScopeCount = activeServiceScopes(exactRequestedServices, expectedScopes).size
    const exact = {
      requestedServiceDate: requested,
      resolvedServiceDate: requested,
      serviceDateFallbackApplied: false,
      serviceDateTemplateApplied: exactRequestedServices.size === 0 && templateServices.size > 0,
      requestedServiceScopeCount: requestedScopeCount,
      resolvedServiceScopeCount: requestedScopeCount,
      availableServiceScopeCount: expectedScopes.size,
      services: templateServices,
    }
    if (exactRequestedServices.size || !allowFallback) return exact
    const cacheKey = `weekday-template|${requested}|${serviceDay}`
    const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
    if (cached) return cached
    let best = null
    for (const candidate of serviceDateCandidates(store, requested)) {
      const services = activeServiceIds(store.db, candidate, 'exact-date', serviceDay)
      if (!services.size) continue
      const candidateDate = parseServiceDate(candidate)
      const distanceDays = Math.abs(candidateDate.getTime() - requestedDate.getTime()) / 86_400_000
      if (
        best
        && (distanceDays > best.distanceDays
          || (distanceDays === best.distanceDays && services.size < best.services.size)
          || (distanceDays === best.distanceDays && services.size === best.services.size && candidate <= best.resolvedServiceDate))
      ) continue
      best = {
        requestedServiceDate: requested,
        resolvedServiceDate: candidate,
        serviceDateFallbackApplied: candidate !== requested,
        serviceDateTemplateApplied: false,
        requestedServiceScopeCount: requestedScopeCount,
        resolvedServiceScopeCount: activeServiceScopes(services, expectedScopes).size,
        availableServiceScopeCount: expectedScopes.size,
        services,
        distanceDays,
      }
    }
    const resolution = best
      ? {
        requestedServiceDate: best.requestedServiceDate,
        resolvedServiceDate: best.resolvedServiceDate,
        serviceDateFallbackApplied: best.serviceDateFallbackApplied,
        serviceDateTemplateApplied: best.serviceDateTemplateApplied,
        requestedServiceScopeCount: best.requestedServiceScopeCount,
        resolvedServiceScopeCount: best.resolvedServiceScopeCount,
        availableServiceScopeCount: best.availableServiceScopeCount,
        services: best.services,
      }
      : exact
    boundedCacheSet(store.serviceDateResolutionCache, cacheKey, resolution, 256)
    return resolution
  }
  const requestedServices = servicesForDate(store, requested, serviceDay)
  const expectedScopes = new Set(store.sourceScopes)
  const requestedScopeCount = activeServiceScopes(requestedServices, expectedScopes).size
  const exact = {
    requestedServiceDate: requested,
    resolvedServiceDate: requested,
    serviceDateFallbackApplied: false,
    serviceDateTemplateApplied: false,
    requestedServiceScopeCount: requestedScopeCount,
    resolvedServiceScopeCount: requestedScopeCount,
    availableServiceScopeCount: expectedScopes.size,
    services: requestedServices,
  }
  if (
    !allowFallback
    || store.serviceModel !== 'exact-date-multi-feed'
    || expectedScopes.size < 2
    || requestedScopeCount >= expectedScopes.size
  ) return exact

  const cacheKey = `${requested}|${serviceDay}`
  const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
  if (cached) return cached
  let best = { ...exact, distanceDays: 0 }
  for (const candidate of serviceDateCandidates(store, requested)) {
    const services = servicesForDate(store, candidate, serviceDay)
    const scopeCount = activeServiceScopes(services, expectedScopes).size
    if (!scopeCount) continue
    const candidateDate = parseServiceDate(candidate)
    const distanceDays = Math.abs(candidateDate.getTime() - requestedDate.getTime()) / 86_400_000
    if (
      scopeCount < best.resolvedServiceScopeCount
      || (scopeCount === best.resolvedServiceScopeCount && distanceDays > best.distanceDays)
      || (scopeCount === best.resolvedServiceScopeCount && distanceDays === best.distanceDays && candidate >= best.resolvedServiceDate)
    ) continue
    best = {
      requestedServiceDate: requested,
      resolvedServiceDate: candidate,
      serviceDateFallbackApplied: candidate !== requested,
      serviceDateTemplateApplied: false,
      requestedServiceScopeCount: requestedScopeCount,
      resolvedServiceScopeCount: scopeCount,
      availableServiceScopeCount: expectedScopes.size,
      services,
      distanceDays,
    }
  }
  const resolution = {
    requestedServiceDate: best.requestedServiceDate,
    resolvedServiceDate: best.resolvedServiceDate,
    serviceDateFallbackApplied: best.serviceDateFallbackApplied,
    serviceDateTemplateApplied: best.serviceDateTemplateApplied,
    requestedServiceScopeCount: best.requestedServiceScopeCount,
    resolvedServiceScopeCount: best.resolvedServiceScopeCount,
    availableServiceScopeCount: best.availableServiceScopeCount,
    services: best.services,
  }
  boundedCacheSet(store.serviceDateResolutionCache, cacheKey, resolution, 256)
  return resolution
}

function resolveServiceDate(store, requestedServiceDate, serviceDay, allowFallback = false) {
  const resolvedServiceDay = resolveServiceDay(requestedServiceDate, serviceDay)
  // Calendar resolution depends only on the immutable, storage-identity-bound
  // GTFS store and these scalar inputs. Cache this derived calendar context,
  // never an OD, access frontier, timetable answer, or materialized plan.
  // openNationalStore invalidation discards the cache when source storage
  // identity changes, so a hot route avoids reparsing the same date and
  // rescanning the same active service set without weakening data freshness.
  const cacheKey = [
    'resolved-service-date-v1',
    String(requestedServiceDate ?? ''),
    resolvedServiceDay,
    allowFallback ? 'fallback' : 'exact',
  ].join('|')
  const cached = boundedCacheGet(store.serviceDateResolutionCache, cacheKey)
  if (cached) return cached
  const resolution = resolveServiceDateUncached(
    store,
    requestedServiceDate,
    resolvedServiceDay,
    allowFallback,
  )
  boundedCacheSet(store.serviceDateResolutionCache, cacheKey, resolution, 256)
  return resolution
}

function serviceDateDiagnostics(resolution) {
  return {
    serviceDate: resolution.requestedServiceDate,
    requestedServiceDate: resolution.requestedServiceDate,
    resolvedServiceDate: resolution.resolvedServiceDate,
    serviceDateFallbackApplied: resolution.serviceDateFallbackApplied,
    serviceDateTemplateApplied: resolution.serviceDateTemplateApplied === true,
    requestedServiceScopeCount: resolution.requestedServiceScopeCount,
    resolvedServiceScopeCount: resolution.resolvedServiceScopeCount,
    availableServiceScopeCount: resolution.availableServiceScopeCount,
    resolutionStrategy: resolution.resolutionStrategy,
  }
}

function lightweightServiceAnchorDateResolution(store, request) {
  // A single exact-date store has no cross-feed completeness choice and does
  // not support nearest-date substitution. The service-anchor certificate is
  // deliberately built from the all-service role superset, so enumerating
  // every active service_id cannot tighten or validate that lower bound. On
  // very large feeds it only repeats tens of thousands of indexed table
  // lookups before the normal route core would perform the same enumeration.
  if (store.serviceModel === 'exact-date' && store.sourceScopes.length === 0) {
    const requestedDate = parseServiceDate(request.serviceDate)
    if (!requestedDate) throw new Error('A valid service date is required for national routing.')
    const requestedServiceDate = formatServiceDate(requestedDate)
    return {
      requestedServiceDate,
      resolvedServiceDate: requestedServiceDate,
      serviceDateFallbackApplied: false,
      serviceDateTemplateApplied: false,
      requestedServiceScopeCount: 0,
      resolvedServiceScopeCount: 0,
      availableServiceScopeCount: 0,
      services: new Set(),
      resolutionStrategy:
        'single_feed_exact_date_global_anchor_superset_no_service_enumeration',
    }
  }
  return resolveServiceDate(
    store,
    request.serviceDate,
    request.serviceDay,
    request.allowServiceDateFallback === true,
  )
}

function requiredServiceCoverageIncomplete(request, resolution) {
  return request.requireCompleteServiceCoverage === true
    && resolution.availableServiceScopeCount > 1
    && resolution.resolvedServiceScopeCount < resolution.availableServiceScopeCount
}

function incompleteServiceCoveragePlan(request, departureMinutes, maxWalkKm, resolution) {
  return blockedPlan(
    request,
    departureMinutes,
    maxWalkKm,
    'Incomplete timetable coverage',
    `Only ${resolution.resolvedServiceScopeCount} of ${resolution.availableServiceScopeCount} required feed scopes have service on ${resolution.resolvedServiceDate}. Choose a fully covered date; nearest-date fallback remains opt-in.`,
    { originStops: 0, destinationStops: 0 },
    resolution,
  )
}

function timetableDetail(durationMinutes, resolution) {
  if (resolution?.serviceDateTemplateApplied) return `${Math.round(durationMinutes)} min / representative timetable template`
  if (!resolution?.serviceDateFallbackApplied) return `${Math.round(durationMinutes)} min / exact local timetable`
  return `${Math.round(durationMinutes)} min / timetable for ${resolution.resolvedServiceDate} (fallback from ${resolution.requestedServiceDate})`
}

function routeTimingDetail(
  durationMinutes,
  resolution,
  bridgedUntimedGapCount = 0,
  sourceEqualTimeRideCount = numeric(resolution?.sourceEqualTimeRideCount, 0),
) {
  const stationDetail = resolution?.unverifiedStationAccessLegs > 0 ? ' / station access unverified' : ''
  if (!bridgedUntimedGapCount) {
    const detail = timetableDetail(durationMinutes, resolution) + stationDetail
    if (!sourceEqualTimeRideCount) return detail
    const rideLabel = sourceEqualTimeRideCount === 1 ? 'ride' : 'rides'
    return `${detail} / ${sourceEqualTimeRideCount} ${rideLabel} published within one timestamp`
  }
  const serviceDate = resolution?.serviceDateFallbackApplied
    ? ` for ${resolution.resolvedServiceDate} (fallback from ${resolution.requestedServiceDate})`
    : ''
  return `${Math.round(durationMinutes)} min / interpolated stop-time gap${serviceDate} / degraded timing precision${stationDetail}`
}

function materializeDirectWalkCandidate(request, maxWalkKm, path, diagnostics = {}) {
  const origin = request.origin
  const destination = request.destination
  const durationMinutes = path.distanceKm / walkingSpeedKph * 60
  const timePreference = request.timePreference === 'arrive' ? 'arrive' : 'depart'
  const selectedMinutes = numeric(
    timePreference === 'arrive'
      ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
      : request.departMinutes,
    8 * 60,
  )
  const departMinutes = timePreference === 'arrive'
    ? Math.max(0, selectedMinutes - durationMinutes)
    : selectedMinutes
  const arriveMinutes = timePreference === 'arrive' ? selectedMinutes : departMinutes + durationMinutes
  const requestedServiceDate = String(request.serviceDate ?? '')
  const roundedDurationMinutes = Number(durationMinutes.toFixed(3))
  const roundedDepartMinutes = Number(departMinutes.toFixed(3))
  const roundedArriveMinutes = Number(arriveMinutes.toFixed(3))

  return {
    id: stablePlanId('national-walk', {
      serviceDate: requestedServiceDate,
      timePreference,
      departMinutes: roundedDepartMinutes,
      arriveMinutes: roundedArriveMinutes,
      origin,
      destination,
      distanceKm: Number(path.distanceKm.toFixed(6)),
      coordinates: path.coordinates,
    }),
    status: 'ready',
    travelMode: 'walk',
    timePreference,
    maxWalkKm,
    scheduleMode: 'none',
    choiceLabel: diagnostics.choiceLabel ?? 'Walk instead',
    recommended: diagnostics.recommended ?? true,
    title: diagnostics.title ?? 'Walk instead',
    detail: `${Math.max(1, Math.round(durationMinutes))} min / direct OSM walk`,
    departMinutes: roundedDepartMinutes,
    arriveMinutes: roundedArriveMinutes,
    durationMinutes: roundedDurationMinutes,
    waitMinutes: 0,
    walkMinutes: roundedDurationMinutes,
    rideMinutes: 0,
    transfers: 0,
    origin,
    destination,
    legs: [{
      type: 'walk',
      travelMode: 'walk',
      walkSource: 'osm',
      fromName: origin.label,
      toName: destination.label,
      startMinutes: roundedDepartMinutes,
      endMinutes: roundedArriveMinutes,
      durationMinutes: roundedDurationMinutes,
      distanceKm: path.distanceKm,
      stopCount: 0,
      coordinates: path.coordinates,
    }],
    diagnostics: {
      scannedDepartures: 0,
      relaxedStops: 0,
      serviceDay: request.serviceDay ?? 'weekday',
      serviceDate: requestedServiceDate,
      requestedServiceDate,
      resolvedServiceDate: requestedServiceDate,
      serviceDateFallbackApplied: false,
      requestedServiceScopeCount: 0,
      resolvedServiceScopeCount: 0,
      availableServiceScopeCount: 0,
      scheduleMode: 'none',
      walkingNetwork: 'osm',
      walkingAccessPermission: nativeStreetAccessPermission(request.streetStorePath),
      walkingSpeedKph,
      originStreetPathVerified: true,
      destinationStreetPathVerified: true,
      searchProfile: diagnostics.searchProfile ?? 'fastest',
      searchStrategy: diagnostics.searchStrategy ?? 'exact',
      algorithm: diagnostics.algorithm ?? 'osm_direct_walk_dominance',
      optimality: diagnostics.optimality ?? 'direct_walk_strictly_dominates_transit_lower_bound',
      walkingPolicyId: 'vigo-national-direct-physical-walk',
      accessDurationModel: 'osm-distance-at-declared-walking-speed',
      accessPaddingFactor: 1,
      accessOverheadSeconds: 0,
      directWalkDistanceKm: path.distanceKm,
      transitLowerBoundMinutes: Object.hasOwn(diagnostics, 'transitLowerBoundMinutes')
        ? diagnostics.transitLowerBoundMinutes
        : undefined,
      transitAlternativeMinutes: diagnostics.transitAlternativeMinutes,
      originStopCandidates: 0,
      destinationStopCandidates: 0,
      destinationLabels: 0,
    },
  }
}

function directWalkAlternativePlan(request, preferredWalkKm, alternativeWalkKm) {
  if (
    transitRideRequired(request)
    || request.allowLongWalk === false
    || !request.streetStorePath
  ) {
    return { plan: null, walkSearches: 0 }
  }
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return { plan: null, walkSearches: 0 }
  if (haversineKm(origin.coordinate, destination.coordinate) > alternativeWalkKm) {
    return { plan: null, walkSearches: 0 }
  }
  const path = streetPathBetween(
    request.streetStorePath,
    origin.coordinate,
    destination.coordinate,
    alternativeWalkKm,
  )
  if (!path || path.distanceKm > directWalkEndToEndLimitKm({ ...request,
    allowLongWalk: true, maxStreetKm: alternativeWalkKm }) + 1e-9) return { plan: null, walkSearches: 1 }
  const plan = materializeDirectWalkCandidate(request, alternativeWalkKm, path, {
    choiceLabel: 'Walk only',
    title: 'Walk only',
    recommended: false,
    searchProfile: 'pareto',
    searchStrategy: 'exact_constrained_access',
    algorithm: 'osm_direct_walk_alternative',
    optimality: 'graph_verified_direct_walk_alternative',
    transitLowerBoundMinutes: undefined,
  })
  return {
    plan: {
      ...plan,
      diagnostics: {
        ...plan.diagnostics,
        alternativeStrategy: 'long_walk_direct',
        longerWalkAlternative: path.distanceKm > preferredWalkKm + 0.01,
        preferredMaxWalkKm: preferredWalkKm,
        alternativeMaxWalkKm: alternativeWalkKm,
      },
    },
    walkSearches: 1,
  }
}

function shouldProbeNationalDirectWalkDominance(request) {
  if (transitRideRequired(request) || !request?.streetStorePath) return false
  if (!(directWalkTransitEndpointLowerBoundMinutes > 0)) return false
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return false
  // Explicitly selected stops pay no endpoint overhead, so this coordinate
  // lower-bound proof does not apply to mixed or exact-stop requests.
  if (explicitRoutingStopId(origin) || explicitRoutingStopId(destination)) return false
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
  const crowFlightKm = haversineKm(origin.coordinate, destination.coordinate)
  const physicalWalkLowerBoundMinutes = crowFlightKm / walkingSpeedKph * 60
  return crowFlightKm <= maxWalkKm + 1e-9
    && physicalWalkLowerBoundMinutes < directWalkTransitEndpointLowerBoundMinutes
}

function dominantDirectWalkPlan(request, maxWalkKm) {
  if (!shouldProbeNationalDirectWalkDominance(request)) return null
  const strictProofDistanceKm = Math.min(
    maxWalkKm,
    directWalkEndToEndLimitKm(request),
    directWalkTransitEndpointLowerBoundMinutes / 60 * walkingSpeedKph,
  )
  const path = streetPathBetween(
    request.streetStorePath,
    request.origin.coordinate,
    request.destination.coordinate,
    strictProofDistanceKm,
  )
  if (!path) return null
  const durationMinutes = path.distanceKm / walkingSpeedKph * 60
  if (!(durationMinutes < directWalkTransitEndpointLowerBoundMinutes)) return null
  return materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: 'osm_direct_walk_dominance',
    optimality: 'direct_walk_strictly_dominates_configured_endpoint_overhead_lower_bound',
    transitLowerBoundMinutes: directWalkTransitEndpointLowerBoundMinutes,
  })
}

function minimumAccessWalkSeconds(stops) {
  let minimumSeconds = Number.POSITIVE_INFINITY
  for (const stop of stops) {
    minimumSeconds = Math.min(minimumSeconds, accessWalkSeconds(stop))
  }
  return minimumSeconds
}

// OSM edges use spherical haversine lengths. The native endpoint snap uses a
// local metric whose smallest scale is 110.574 km/degree; over the supported
// five-kilometre endpoint envelope and |latitude| <= 85 degrees, 0.98 times
// the Earth chord is therefore below every legal snap-plus-graph path. This is
// a conservative metric certificate, not a product-tuning threshold.
const serviceAnchorChordLowerBoundFactor = 0.98
const serviceAnchorLatitudeLimit = 85
const earthMeanRadiusKm = 6371.0088

function sphericalChordKm(leftLon, leftLat, rightLon, rightLat) {
  const radians = (degrees) => degrees * Math.PI / 180
  const latitudeDelta = radians(rightLat - leftLat)
  const longitudeDelta = radians(rightLon - leftLon)
  const leftLatitude = radians(leftLat)
  const rightLatitude = radians(rightLat)
  const haversineValue = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude)
      * Math.cos(rightLatitude)
      * Math.sin(longitudeDelta / 2) ** 2
  return earthMeanRadiusKm
    * 2
    * Math.sqrt(Math.max(0, Math.min(1, haversineValue)))
}

function unitSphereCoordinate(longitude, latitude) {
  const longitudeRadians = longitude * Math.PI / 180
  const latitudeRadians = latitude * Math.PI / 180
  const latitudeScale = Math.cos(latitudeRadians)
  return {
    x: latitudeScale * Math.cos(longitudeRadians),
    y: latitudeScale * Math.sin(longitudeRadians),
    z: Math.sin(latitudeRadians),
  }
}

function unitSphereChordKm(coordinate, unitX, unitY, unitZ) {
  const xDelta = coordinate.x - unitX
  const yDelta = coordinate.y - unitY
  const zDelta = coordinate.z - unitZ
  return earthMeanRadiusKm * Math.sqrt(
    xDelta * xDelta + yDelta * yDelta + zDelta * zDelta,
  )
}

function serviceAccessAnchorProfile(
  db,
  resolvedStorePath,
  metadata,
  sourceStorageIdentity,
) {
  const retainedRoleCount = Number(
    db.prepare('SELECT COUNT(*) AS count FROM stop_access_roles').get()?.count ?? 0,
  )
  if (
    metadata.stopAccessRoleIndexVersion !== stopAccessRoleIndexVersion
    || Number(metadata.stopAccessRoleCount ?? -1) !== retainedRoleCount
  ) {
    const error = new Error(
      'Routing store requires a current persisted stop-access role index.',
    )
    error.code = 'resident_stop_access_index_required'
    throw error
  }
  const cacheKey = [
    resolvedStorePath,
    sourceStorageIdentity,
    metadata.stopAccessRoleIndexVersion,
    retainedRoleCount,
  ].join('\u0000')
  const cached = serviceAccessAnchorCache.get(cacheKey)
  if (cached) {
    serviceAccessAnchorCache.delete(cacheKey)
    serviceAccessAnchorCache.set(cacheKey, cached)
    return { profile: cached, cacheHit: true, buildMs: 0 }
  }

  const startedAt = performance.now()
  const longitudes = []
  const latitudes = []
  const unitX = []
  const unitY = []
  const unitZ = []
  const originEligible = []
  const destinationEligible = []
  const rows = db.prepare(`
    SELECT
      CASE
        WHEN NULLIF(stop.parent_station, '') IS NULL THEN stop.stop_id
        ELSE parent.stop_id
      END AS anchor_id,
      CASE
        WHEN NULLIF(stop.parent_station, '') IS NULL THEN stop.lon
        ELSE parent.lon
      END AS anchor_lon,
      CASE
        WHEN NULLIF(stop.parent_station, '') IS NULL THEN stop.lat
        ELSE parent.lat
      END AS anchor_lat,
      MAX(role.can_board) AS can_board,
      MAX(role.can_alight) AS can_alight
    FROM stop_access_roles AS role
    JOIN stops AS stop ON stop.stop_id=role.stop_id
    LEFT JOIN stops AS parent ON parent.stop_id=NULLIF(stop.parent_station, '')
    GROUP BY anchor_id, anchor_lon, anchor_lat
    HAVING anchor_lon IS NOT NULL AND anchor_lat IS NOT NULL
    ORDER BY anchor_id
  `)
  let originAnchorCount = 0
  let destinationAnchorCount = 0
  for (const row of rows.iterate()) {
    const canBoard = row.can_board === 1
    const canAlight = row.can_alight === 1
    if (!canBoard && !canAlight) continue
    const longitude = Number(row.anchor_lon)
    const latitude = Number(row.anchor_lat)
    const unitCoordinate = unitSphereCoordinate(longitude, latitude)
    longitudes.push(longitude)
    latitudes.push(latitude)
    unitX.push(unitCoordinate.x)
    unitY.push(unitCoordinate.y)
    unitZ.push(unitCoordinate.z)
    originEligible.push(Number(canBoard))
    destinationEligible.push(Number(canAlight))
    if (canBoard) originAnchorCount += 1
    if (canAlight) destinationAnchorCount += 1
  }
  const profileIdentity = [
    'service-access-v1',
    metadata.sourceFingerprint ?? metadata.storeId ?? 'unknown',
    sourceStorageIdentity,
    metadata.stopAccessRoleIndexVersion,
    retainedRoleCount,
    longitudes.length,
    originAnchorCount,
    destinationAnchorCount,
  ].join('|')
  const profile = Object.freeze({
    schemaVersion: 'vigo.routing.service-access-anchor-profile.v1',
    profileIdentity,
    sourceStorageIdentity,
    retainedRoleCount,
    longitudes: Float64Array.from(longitudes),
    latitudes: Float64Array.from(latitudes),
    unitX: Float64Array.from(unitX),
    unitY: Float64Array.from(unitY),
    unitZ: Float64Array.from(unitZ),
    originEligible: Uint8Array.from(originEligible),
    destinationEligible: Uint8Array.from(destinationEligible),
    anchorCount: longitudes.length,
    originAnchorCount,
    destinationAnchorCount,
  })
  serviceAccessAnchorCache.set(cacheKey, profile)
  while (serviceAccessAnchorCache.size > serviceAccessAnchorCacheMaxEntries) {
    const oldestKey = serviceAccessAnchorCache.keys().next().value
    if (oldestKey === undefined) break
    serviceAccessAnchorCache.delete(oldestKey)
  }
  return {
    profile,
    cacheHit: false,
    buildMs: Number((performance.now() - startedAt).toFixed(3)),
  }
}

function materializeServiceAnchorLowerBound(profile, coordinate, state) {
  if (state.anchorIndex < 0) return null
  const exactCoordinate = (
    coordinate[0] === profile.longitudes[state.anchorIndex]
    && coordinate[1] === profile.latitudes[state.anchorIndex]
  )
  return {
    anchorIndex: state.anchorIndex,
    distanceKm: state.distanceKm,
    seconds: exactCoordinate ? 0 : walkSeconds(state.distanceKm),
  }
}

function minimumServiceAnchorLowerBounds(
  profile,
  originCoordinate,
  destinationCoordinate,
) {
  const originUnit = unitSphereCoordinate(
    originCoordinate[0],
    originCoordinate[1],
  )
  const destinationUnit = unitSphereCoordinate(
    destinationCoordinate[0],
    destinationCoordinate[1],
  )
  const origin = {
    distanceKm: Number.POSITIVE_INFINITY,
    anchorIndex: -1,
  }
  const destination = {
    distanceKm: Number.POSITIVE_INFINITY,
    anchorIndex: -1,
  }
  for (let index = 0; index < profile.anchorCount; index += 1) {
    const anchorLatitude = profile.latitudes[index]
    if (Math.abs(anchorLatitude) > serviceAnchorLatitudeLimit) continue
    if (profile.originEligible[index] === 1) {
      const distanceKm = unitSphereChordKm(
        originUnit,
        profile.unitX[index],
        profile.unitY[index],
        profile.unitZ[index],
      ) * serviceAnchorChordLowerBoundFactor
      if (distanceKm < origin.distanceKm) {
        origin.distanceKm = distanceKm
        origin.anchorIndex = index
      }
    }
    if (profile.destinationEligible[index] === 1) {
      const distanceKm = unitSphereChordKm(
        destinationUnit,
        profile.unitX[index],
        profile.unitY[index],
        profile.unitZ[index],
      ) * serviceAnchorChordLowerBoundFactor
      if (distanceKm < destination.distanceKm) {
        destination.distanceKm = distanceKm
        destination.anchorIndex = index
      }
    }
  }
  return {
    origin: materializeServiceAnchorLowerBound(
      profile,
      originCoordinate,
      origin,
    ),
    destination: materializeServiceAnchorLowerBound(
      profile,
      destinationCoordinate,
      destination,
    ),
  }
}

function lightweightIncompleteCoveragePlan(
  resolvedStorePath,
  sourceStorageIdentity,
  request,
  maxWalkKm,
  routingSemantics,
  serviceDateResolution,
  startedAt,
) {
  const directWalkEligible = (
    !transitRideRequired(request)
    && request.streetStorePath
    && Array.isArray(request.origin?.coordinate)
    && Array.isArray(request.destination?.coordinate)
    && !explicitRoutingStopId(request.origin)
    && !explicitRoutingStopId(request.destination)
    && haversineKm(request.origin.coordinate, request.destination.coordinate)
      <= maxWalkKm + 1e-9
  )
  const streetSearchStartedAt = performance.now()
  const directPath = directWalkEligible
    ? streetPathBetween(
        request.streetStorePath,
        request.origin.coordinate,
        request.destination.coordinate,
        maxWalkKm,
      )
    : null
  const streetSearchMs = directWalkEligible
    ? Number((performance.now() - streetSearchStartedAt).toFixed(3))
    : 0
  if (
    staticTopologySourceStorageSnapshot(resolvedStorePath)
    !== sourceStorageIdentity
  ) return null
  if (directPath && directPath.distanceKm <= directWalkEndToEndLimitKm(request) + 1e-9) {
    const plan = materializeDirectWalkCandidate(
      request,
      maxWalkKm,
      directPath,
      {
        algorithm: 'osm_direct_walk_incomplete_service_coverage',
        optimality:
          'graph_verified_direct_walk_when_required_service_coverage_is_incomplete',
        transitLowerBoundMinutes: undefined,
      },
    )
    const queryMs = Number((performance.now() - startedAt).toFixed(3))
    return {
      ...plan,
      diagnostics: {
        ...plan.diagnostics,
        ...serviceDateDiagnostics(serviceDateResolution),
        dataSemantics: routingSemantics.routingDataSemantics,
        methodState: 'complete',
        transitSearchAttempted: false,
        transitSearchSkippedReason: 'incomplete_required_service_coverage',
        transitFailureCode: 'incomplete_service_coverage',
        transitFailureCategory: 'schedule',
        directWalkFallback: {
          streetSearchMs,
          streetPathReused: false,
          distanceKm: directPath.distanceKm,
        },
        transitServiceCoverageProbe:
          serviceDateDiagnostics(serviceDateResolution),
        searchStats: {
          queryMs,
          engineQueryMs: streetSearchMs,
        },
      },
    }
  }
  const selectedMinutes = numeric(
    request.timePreference === 'arrive'
      ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
      : request.departMinutes,
    8 * 60,
  )
  const plan = incompleteServiceCoveragePlan(
    request,
    selectedMinutes,
    maxWalkKm,
    serviceDateResolution,
  )
  const queryMs = Number((performance.now() - startedAt).toFixed(3))
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      optimality: 'search_limited_to_supported_scheduled_core',
      dataSemantics: routingSemantics.routingDataSemantics,
      methodState: 'failed',
      transitSearchAttempted: false,
      transitSearchSkippedReason: 'incomplete_required_service_coverage',
      transitFailureCode: 'incomplete_service_coverage',
      transitFailureCategory: 'data_coverage',
      transitServiceCoverageProbe:
        serviceDateDiagnostics(serviceDateResolution),
      searchStats: {
        ...plan.diagnostics.searchStats,
        queryMs,
        engineQueryMs: streetSearchMs,
      },
    },
  }
}

function lightweightServiceAnchorDirectWalkProbe(storePath, request, maxWalkKm) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || directWalkTransitEndpointLowerBoundMinutes > 0
    || explicitRoutingStopId(request.origin)
    || explicitRoutingStopId(request.destination)
    || requestedAccessStopIds(request, '__originAccessStopIds')
    || requestedAccessStopIds(request, '__destinationAccessStopIds')
    || !Array.isArray(request.origin?.coordinate)
    || !Array.isArray(request.destination?.coordinate)
    || !request.origin.coordinate.every(Number.isFinite)
    || !request.destination.coordinate.every(Number.isFinite)
    || Math.abs(request.origin.coordinate[1]) > serviceAnchorLatitudeLimit
    || Math.abs(request.destination.coordinate[1]) > serviceAnchorLatitudeLimit
  ) return null

  const directWalkEligible = (
    haversineKm(request.origin.coordinate, request.destination.coordinate)
      <= maxWalkKm + 1e-9
  )
  const startedAt = performance.now()
  const resolvedStorePath = path.resolve(storePath)
  const sourceStorageSnapshot = staticTopologySourceStorageSnapshot(
    resolvedStorePath,
  )
  let db
  let anchorProfile
  let serviceDateResolution
  let routingSemantics
  let incompleteServiceCoverage = false
  try {
    db = new DatabaseSync(resolvedStorePath, { readOnly: true })
    db.exec('PRAGMA mmap_size=0; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY;')
    const { metadata } = admitNationalRoutingStore(db, resolvedStorePath)
    admitCurrentTransferSemantics(db, resolvedStorePath, metadata)
    const hasConnectionPermissions = db.prepare(`
      SELECT 1 AS ready
      FROM sqlite_master
      WHERE type='table' AND name='connection_permissions'
    `).get()?.ready === 1
    routingSemantics = routingSemanticsFromMetadata(
      metadata,
      hasConnectionPermissions,
    )
    if (routingSemantics.blockingRoutingFeatures.length) return null
    const lightweightStore = {
      db,
      serviceModel: metadata.serviceModel || 'exact-date',
      sourceScopes: Array.isArray(metadata.sourceStores)
        ? metadata.sourceStores
          .map((source) => String(source.scope || ''))
          .filter(Boolean)
        : [],
      servicesByDate: new Map(),
      serviceDateResolutionCache: new Map(),
    }
    serviceDateResolution = lightweightServiceAnchorDateResolution(
      lightweightStore,
      request,
    )
    incompleteServiceCoverage = requiredServiceCoverageIncomplete(
      request,
      serviceDateResolution,
    )
    if (!incompleteServiceCoverage && directWalkEligible) {
      anchorProfile = serviceAccessAnchorProfile(
        db,
        resolvedStorePath,
        metadata,
        sourceStorageSnapshot,
      )
    }
  } finally {
    try { db?.close() } catch {}
  }

  if (incompleteServiceCoverage) {
    return lightweightIncompleteCoveragePlan(
      resolvedStorePath,
      sourceStorageSnapshot,
      request,
      maxWalkKm,
      routingSemantics,
      serviceDateResolution,
      startedAt,
    )
  }
  if (!directWalkEligible) return null

  const anchorScanStartedAt = performance.now()
  const anchorLowerBounds = minimumServiceAnchorLowerBounds(
    anchorProfile.profile,
    request.origin.coordinate,
    request.destination.coordinate,
  )
  const originLowerBound = anchorLowerBounds.origin
  const destinationLowerBound = anchorLowerBounds.destination
  const anchorScanMs = Number(
    (performance.now() - anchorScanStartedAt).toFixed(3),
  )
  if (!originLowerBound || !destinationLowerBound) return null
  const transitEndpointLowerBoundSeconds = originLowerBound.seconds
    + destinationLowerBound.seconds
  if (!(transitEndpointLowerBoundSeconds > 0)) return null
  const directPhysicalLowerBoundSeconds = (
    sphericalChordKm(
      request.origin.coordinate[0],
      request.origin.coordinate[1],
      request.destination.coordinate[0],
      request.destination.coordinate[1],
    )
    * serviceAnchorChordLowerBoundFactor
    / walkingSpeedKph
    * 3600
    * accessPaddingFactor
  )
  if (!(directPhysicalLowerBoundSeconds < transitEndpointLowerBoundSeconds)) {
    return null
  }

  const streetSearchStartedAt = performance.now()
  const directPath = streetPathBetween(
    request.streetStorePath,
    request.origin.coordinate,
    request.destination.coordinate,
    maxWalkKm,
  )
  const streetSearchMs = Number(
    (performance.now() - streetSearchStartedAt).toFixed(3),
  )
  if (!directPath || directPath.distanceKm > directWalkEndToEndLimitKm(request) + 1e-9) return null
  const directWalkSeconds = directPath.distanceKm / walkingSpeedKph * 3600
  if (!(directWalkSeconds < transitEndpointLowerBoundSeconds)) return null
  if (
    staticTopologySourceStorageSnapshot(resolvedStorePath)
    !== sourceStorageSnapshot
  ) return null

  const plan = materializeDirectWalkCandidate(
    request,
    maxWalkKm,
    directPath,
    {
      algorithm: 'osm_direct_walk_service_anchor_lower_bound',
      optimality:
        'direct_walk_strictly_dominates_exact_service_anchor_lower_bound',
      transitLowerBoundMinutes: transitEndpointLowerBoundSeconds / 60,
    },
  )
  const queryMs = Number((performance.now() - startedAt).toFixed(3))
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      dataSemantics: routingSemantics.routingDataSemantics,
      methodState: 'complete',
      originStopCandidates: anchorProfile.profile.originAnchorCount,
      destinationStopCandidates:
        anchorProfile.profile.destinationAnchorCount,
      originAccessLowerBoundSeconds: originLowerBound.seconds,
      destinationEgressLowerBoundSeconds: destinationLowerBound.seconds,
      transitEndpointLowerBoundSeconds,
      coordinateAccessLowerBound:
        'global_role_eligible_public_anchor_chord_certificate',
      serviceAccessAnchorProfile: {
        schemaVersion: anchorProfile.profile.schemaVersion,
        profileIdentity: anchorProfile.profile.profileIdentity,
        sourceStorageIdentity: anchorProfile.profile.sourceStorageIdentity,
        anchors: anchorProfile.profile.anchorCount,
        originAnchors: anchorProfile.profile.originAnchorCount,
        destinationAnchors: anchorProfile.profile.destinationAnchorCount,
        retainedRoleCount: anchorProfile.profile.retainedRoleCount,
        cacheHit: anchorProfile.cacheHit,
        buildMs: anchorProfile.buildMs,
        scanMs: anchorScanMs,
        distanceKernel: 'single_pass_precomputed_unit_chord',
        scanPasses: 1,
        chordLowerBoundFactor: serviceAnchorChordLowerBoundFactor,
        latitudeDomain: [-serviceAnchorLatitudeLimit, serviceAnchorLatitudeLimit],
      },
      transitServiceCoverageProbe:
        serviceDateDiagnostics(serviceDateResolution),
      directWalkProof: {
        streetSearchMs,
        directWalkSeconds,
        transitEndpointLowerBoundSeconds,
      },
      searchStats: {
        queryMs,
        engineQueryMs: streetSearchMs,
      },
    },
  }
}

function accessFrontierDirectWalkProbe(
  request,
  maxWalkKm,
  originStops,
  destinationStops,
) {
  return accessFrontierDirectWalkProbeFromMetrics(
    request,
    maxWalkKm,
    minimumAccessWalkSeconds(originStops),
    minimumAccessWalkSeconds(destinationStops),
    originStops.length,
    destinationStops.length,
  )
}

function accessFrontierDirectWalkProbeFromNative(
  request,
  maxWalkKm,
  routed,
) {
  const endpoints = routed.endpoints
  const minimum = (values) => {
    let result = Number.POSITIVE_INFINITY
    for (const value of values) result = Math.min(result, Number(value))
    return result
  }
  const verifiedPath = routed.directWalkPathChecked
    ? routed.directWalkPath
    : routed.directWalkCchChecked
    ? Number.isFinite(routed.directWalkDistanceKm)
      ? {
          distanceKm: routed.directWalkDistanceKm,
          nativeDistanceOnly: true,
          nativeQueryMs: timingMilliseconds(routed.directWalkQueryMs),
          nativeSettledNodes: 0,
          nativeRelaxedEdges: 0,
        }
      : null
    : undefined
  return accessFrontierDirectWalkProbeFromMetrics(
    request,
    maxWalkKm,
    Number.isFinite(routed.minimumOriginAccessSeconds)
      ? routed.minimumOriginAccessSeconds
      : minimum(endpoints.originAccessSeconds),
    Number.isFinite(routed.minimumDestinationAccessSeconds)
      ? routed.minimumDestinationAccessSeconds
      : minimum(endpoints.destinationAccessSeconds),
    routed.originCandidateCount,
    routed.destinationCandidateCount,
    verifiedPath,
    routed.directWalkQueryMs,
  )
}

function accessFrontierDirectWalkProbeFromMetrics(
  request,
  maxWalkKm,
  minimumAccessSeconds,
  minimumEgressSeconds,
  originCandidateCount,
  destinationCandidateCount,
  verifiedPath = undefined,
  verifiedPathSearchMs = undefined,
) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || explicitRoutingStopId(request.origin)
    || explicitRoutingStopId(request.destination)
    || requestedAccessStopIds(request, '__originAccessStopIds')
    || requestedAccessStopIds(request, '__destinationAccessStopIds')
  ) return { plan: null, path: undefined }
  const transitEndpointLowerBoundSeconds = minimumAccessSeconds + minimumEgressSeconds
  if (!(transitEndpointLowerBoundSeconds > 0)) return { plan: null, path: undefined }
  const crowFlightKm = haversineKm(
    request.origin.coordinate,
    request.destination.coordinate,
  )
  if (crowFlightKm > maxWalkKm + 1e-9) return { plan: null, path: undefined }
  const physicalWalkLowerBoundSeconds = crowFlightKm / walkingSpeedKph * 3600
  if (!(physicalWalkLowerBoundSeconds < transitEndpointLowerBoundSeconds)) {
    return { plan: null, path: undefined }
  }
  const streetSearchStartedAt = performance.now()
  let path = verifiedPath === undefined
    ? streetPathBetween(
        request.streetStorePath,
        request.origin.coordinate,
        request.destination.coordinate,
        maxWalkKm,
      )
    : verifiedPath
  let streetSearchMs = verifiedPath === undefined
    ? Number((performance.now() - streetSearchStartedAt).toFixed(3))
    : numeric(verifiedPathSearchMs, 0)
  if (!path || path.distanceKm > directWalkEndToEndLimitKm(request) + 1e-9) return { plan: null, path, streetSearchMs }
  const durationSeconds = path.distanceKm / walkingSpeedKph * 3600
  if (!(durationSeconds < transitEndpointLowerBoundSeconds)) {
    return { plan: null, path, streetSearchMs }
  }
  if (path.nativeDistanceOnly) {
    const materializationStartedAt = performance.now()
    path = streetPathBetween(
      request.streetStorePath,
      request.origin.coordinate,
      request.destination.coordinate,
      maxWalkKm,
    )
    streetSearchMs += performance.now() - materializationStartedAt
    if (!path) return { plan: null, path: null, streetSearchMs }
  }
  const plan = materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: 'osm_direct_walk_access_frontier_dominance',
    optimality: 'direct_walk_strictly_dominates_complete_endpoint_access_lower_bound',
    transitLowerBoundMinutes: transitEndpointLowerBoundSeconds / 60,
  })
  return {
    path,
    streetSearchMs,
    plan: {
      ...plan,
      diagnostics: {
        ...plan.diagnostics,
        originStopCandidates: originCandidateCount,
        destinationStopCandidates: destinationCandidateCount,
        originAccessLowerBoundSeconds: minimumAccessSeconds,
        destinationEgressLowerBoundSeconds: minimumEgressSeconds,
        transitEndpointLowerBoundSeconds,
        coordinateAccessFrontier: 'complete_osm_reachable',
        directWalkProof: {
          streetSearchMs,
          directWalkSeconds: durationSeconds,
          transitEndpointLowerBoundSeconds,
        },
      },
    },
  }
}

function directWalkEndToEndLimitKm(request) {
  const distance = request?.allowLongWalk === false
    ? Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
    : Math.max(0.05, Math.min(100, Number(request.maxStreetKm) || 50))
  const minutes = request.timePreference === 'arrive'
    ? Math.min(routingHorizonMinutes(request), Math.max(0, numeric(request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes, 480)))
    : routingHorizonMinutes(request)
  return Math.min(distance, minutes / 60 * walkingSpeedKph)
}

function directWalkEnvelopeDiagnostics(request, maxWalkKm, path) {
  const directWalkLimitKm = directWalkEndToEndLimitKm(request)
  return {
    distanceKm: path.distanceKm,
    maxWalkKm,
    accessEgressLimitKm: maxWalkKm,
    directWalkLimitKm,
    directWalkLimitScope: 'end-to-end',
    exceedsAccessEgressLimit: path.distanceKm > maxWalkKm + 1e-9,
  }
}

function directWalkAfterBlockedTransitPlan(
  request,
  maxWalkKm,
  transitPlan,
  verifiedPath = undefined,
  verifiedPathSearchMs = undefined,
) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || transitPlan?.status === 'ready'
  ) return null
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return null
  // Exact-stop routing is a distinct API surface. This fallback completes the
  // arbitrary-point WALK+TRANSIT contract without changing the exact-stop
  // endpoint contract.
  if (explicitRoutingStopId(origin) || explicitRoutingStopId(destination)) return null
  // maxWalkKm is a per-endpoint transit access/egress constraint. A complete
  // A-to-B pedestrian journey has the independent end-to-end envelope used by
  // the public walk router; conflating the two incorrectly blocks valid walks
  // whenever neither endpoint can reach transit inside the selected budget.
  const directWalkLimitKm = directWalkEndToEndLimitKm(request)
  if (
    haversineKm(origin.coordinate, destination.coordinate)
      > directWalkLimitKm + 1e-9
  ) return null
  const streetSearchStartedAt = performance.now()
  // A failed proof bounded by maxWalkKm says nothing about a longer, legal
  // end-to-end walk, so only reuse that miss when both envelopes are equal.
  const streetPathReused = verifiedPath !== undefined && (
    verifiedPath !== null
    || directWalkLimitKm <= maxWalkKm + 1e-9
  )
  let path = !streetPathReused
    ? streetPathBetween(
        request.streetStorePath,
        origin.coordinate,
        destination.coordinate,
        directWalkLimitKm,
      )
    : verifiedPath
  let streetSearchMs = streetPathReused
    ? numeric(verifiedPathSearchMs, 0)
    : Number((performance.now() - streetSearchStartedAt).toFixed(3))
  if (path?.nativeDistanceOnly) {
    const materializationStartedAt = performance.now()
    path = streetPathBetween(
      request.streetStorePath,
      origin.coordinate,
      destination.coordinate,
      directWalkLimitKm,
    )
    streetSearchMs += performance.now() - materializationStartedAt
  }
  if (!path || path.distanceKm > directWalkLimitKm + 1e-9) return null
  const failureCode = transitPlan?.diagnostics?.failure?.code
    ?? transitPlan?.diagnostics?.failureCode
    ?? 'no_path'
  const walkPlan = materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: 'osm_direct_walk_no_transit_fallback',
    optimality: 'graph_verified_direct_walk_when_no_supported_transit_path',
    transitLowerBoundMinutes: undefined,
  })
  return {
    ...walkPlan,
    diagnostics: {
      ...walkPlan.diagnostics,
      scannedDepartures: numeric(transitPlan?.diagnostics?.scannedDepartures, 0),
      relaxedStops: numeric(transitPlan?.diagnostics?.relaxedStops, 0),
      serviceDay: transitPlan?.diagnostics?.serviceDay ?? walkPlan.diagnostics.serviceDay,
      serviceDate: transitPlan?.diagnostics?.serviceDate ?? walkPlan.diagnostics.serviceDate,
      requestedServiceDate: transitPlan?.diagnostics?.requestedServiceDate
        ?? walkPlan.diagnostics.requestedServiceDate,
      resolvedServiceDate: transitPlan?.diagnostics?.resolvedServiceDate
        ?? walkPlan.diagnostics.resolvedServiceDate,
      serviceDateFallbackApplied: transitPlan?.diagnostics?.serviceDateFallbackApplied === true,
      requestedServiceScopeCount: numeric(
        transitPlan?.diagnostics?.requestedServiceScopeCount,
        walkPlan.diagnostics.requestedServiceScopeCount,
      ),
      resolvedServiceScopeCount: numeric(
        transitPlan?.diagnostics?.resolvedServiceScopeCount,
        walkPlan.diagnostics.resolvedServiceScopeCount,
      ),
      availableServiceScopeCount: numeric(
        transitPlan?.diagnostics?.availableServiceScopeCount,
        walkPlan.diagnostics.availableServiceScopeCount,
      ),
      originStopCandidates: numeric(transitPlan?.diagnostics?.originStopCandidates, 0),
      destinationStopCandidates: numeric(transitPlan?.diagnostics?.destinationStopCandidates, 0),
      searchStats: {
        ...transitPlan?.diagnostics?.searchStats,
        directWalkFallbackMs: streetSearchMs,
        directWalkFallbackNativeQueryMs: timingMilliseconds(path.nativeQueryMs),
        directWalkFallbackSettledNodes: path.nativeSettledNodes,
        directWalkFallbackRelaxedEdges: path.nativeRelaxedEdges,
        directWalkFallbackChainSkippedNodes: path.nativeChainSkippedNodes,
        directWalkFallbackContractedArcRelaxations:
          path.nativeContractedArcRelaxations,
        directWalkFallbackCchAccelerated: path.nativeCchAccelerated === true,
      },
      transitSearchAttempted: true,
      transitFailureCode: failureCode,
      transitFailureCategory: transitPlan?.diagnostics?.failure?.category
        ?? transitPlan?.diagnostics?.failureCategory
        ?? 'routing',
      directWalkFallback: {
        streetSearchMs,
        streetPathReused,
        nativeQueryMs: timingMilliseconds(path.nativeQueryMs),
        nativeSettledNodes: path.nativeSettledNodes,
        nativeRelaxedEdges: path.nativeRelaxedEdges,
        nativeChainSkippedNodes: path.nativeChainSkippedNodes,
        nativeContractedArcRelaxations: path.nativeContractedArcRelaxations,
        nativeCchAccelerated: path.nativeCchAccelerated === true,
        ...directWalkEnvelopeDiagnostics(request, maxWalkKm, path),
        transitStatus: transitPlan?.status ?? 'blocked',
        transitFailureCode: failureCode,
        transitAlgorithm: transitPlan?.diagnostics?.algorithm ?? null,
        transitSearchQueryMs: timingMilliseconds(
          transitPlan?.diagnostics?.searchStats?.queryMs,
          null,
        ),
      },
    },
  }
}

function transitDominatingDirectWalkPlan(
  request,
  maxWalkKm,
  transitPlan,
  verifiedPath = undefined,
  verifiedPathSearchMs = undefined,
) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || transitPlan?.status !== 'ready'
    || transitPlan?.travelMode !== 'transit'
  ) return null
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return null
  // Transit access/egress and a complete A-to-B walk have distinct envelopes.
  // The final mode comparator must use the same end-to-end street bound as the
  // no-transit fallback, regardless of whether a transit plan is available.
  const directWalkLimitKm = directWalkEndToEndLimitKm(request)
  const crowFlightKm = haversineKm(origin.coordinate, destination.coordinate)
  if (crowFlightKm > directWalkLimitKm + 1e-9) return null
  const arriveBy = request.timePreference === 'arrive'
  const selectedArrival = numeric(request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes, 8 * 60)
  const physicalWalkLowerBoundMinutes = crowFlightKm / walkingSpeedKph * 60
  // Avoid a street-graph query when the physical lower bound cannot improve
  // the public objective. Depart-at minimizes arrival/duration; arrive-by
  // maximizes the first departure, even when the direct walk lasts longer.
  if (arriveBy) {
    if (selectedArrival - physicalWalkLowerBoundMinutes <= numeric(transitPlan.departMinutes, Number.NEGATIVE_INFINITY)) return null
  } else if (physicalWalkLowerBoundMinutes > numeric(transitPlan.durationMinutes, 0) + 1e-9) return null
  const competitiveWalkMinutes = arriveBy
    ? selectedArrival - numeric(transitPlan.departMinutes, selectedArrival)
    : numeric(transitPlan.durationMinutes, 0)
  const competitiveDistanceLimitKm = Math.min(
    directWalkLimitKm,
    competitiveWalkMinutes / 60 * walkingSpeedKph,
  )
  if (!(competitiveDistanceLimitKm > 0)) return null
  const streetSearchStartedAt = performance.now()
  // A miss bounded by the narrower endpoint envelope cannot prove that no
  // legal end-to-end path exists. Reuse a miss only when both bounds coincide.
  const streetPathReused = verifiedPath !== undefined && (
    verifiedPath !== null
    || competitiveDistanceLimitKm <= maxWalkKm + 1e-9
  )
  let path = streetPathReused
    ? verifiedPath
    : streetPathBetween(
        request.streetStorePath,
        origin.coordinate,
        destination.coordinate,
        competitiveDistanceLimitKm,
      )
  let streetSearchMs = streetPathReused
    ? numeric(verifiedPathSearchMs, 0)
    : Number((performance.now() - streetSearchStartedAt).toFixed(3))
  if (
    path?.nativeDistanceOnly
    && path.distanceKm <= competitiveDistanceLimitKm + 1e-9
  ) {
    const materializationStartedAt = performance.now()
    path = streetPathBetween(
      request.streetStorePath,
      origin.coordinate,
      destination.coordinate,
      competitiveDistanceLimitKm,
    )
    streetSearchMs += performance.now() - materializationStartedAt
  }
  const comparisonDiagnostics = {
    streetSearchMs,
    streetPathReused,
    competitiveDistanceLimitKm,
    directWalkLimitKm,
    ...(path ? {
      nativeQueryMs: timingMilliseconds(path.nativeQueryMs),
      nativeSettledNodes: path.nativeSettledNodes,
      nativeRelaxedEdges: path.nativeRelaxedEdges,
      nativeChainSkippedNodes: path.nativeChainSkippedNodes,
      nativeContractedArcRelaxations: path.nativeContractedArcRelaxations,
      nativeCchAccelerated: path.nativeCchAccelerated === true,
    } : {}),
  }
  const retainTransitPlan = (outcome) => ({
    ...transitPlan,
    diagnostics: {
      ...transitPlan.diagnostics,
      directWalkComparison: { ...comparisonDiagnostics, outcome },
      searchStats: {
        ...transitPlan.diagnostics?.searchStats,
        directWalkComparisonMs: streetSearchMs,
      },
    },
  })
  if (!path || path.distanceKm > competitiveDistanceLimitKm + 1e-9) {
    return retainTransitPlan('no_competitive_path')
  }
  const durationMinutes = path.distanceKm / walkingSpeedKph * 60
  const materializedWalkPlan = materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: arriveBy ? 'osm_direct_walk_latest_departure' : 'osm_direct_walk_vs_transit',
    optimality: arriveBy
      ? 'latest_departure_across_direct_walk_and_materialized_transit_plan'
      : 'direct_walk_dominates_materialized_transit_plan',
    transitLowerBoundMinutes: undefined,
    transitAlternativeMinutes: transitPlan.durationMinutes,
  })
  const walkPlan = {
    ...materializedWalkPlan,
    diagnostics: {
      ...materializedWalkPlan.diagnostics,
      directWalkStreetSearchMs: streetSearchMs,
      directWalkStreetPathReused: streetPathReused,
      directWalkComparison: { ...comparisonDiagnostics, outcome: 'direct_walk' },
      searchStats: {
        ...transitPlan.diagnostics?.searchStats,
        directWalkComparisonMs: streetSearchMs,
      },
      directWalkEnvelope: directWalkEnvelopeDiagnostics(
        request,
        maxWalkKm,
        path,
      ),
    },
  }
  if (arriveBy) {
    return walkPlan.departMinutes > numeric(transitPlan.departMinutes, Number.NEGATIVE_INFINITY)
      ? walkPlan
      : retainTransitPlan('transit')
  }
  // The strict point objective is lexicographic in (arrival, boardings, walking).
  // A walk-only path has zero boardings, so it wins an exact arrival tie with
  // a ride-bearing path instead of inheriting an implementation-order tie.
  return durationMinutes <= numeric(transitPlan.durationMinutes, 0) + 1e-9
    ? walkPlan
    : retainTransitPlan('transit')
}

function materializeDirectWalkPlan(plan, departMinutes) {
  const arriveMinutes = Number((departMinutes + plan.durationMinutes).toFixed(3))
  return {
    ...plan,
    id: `${plan.id}-window-${Number(departMinutes).toFixed(3)}`,
    departMinutes,
    arriveMinutes,
    recommended: false,
    legs: plan.legs.map((leg) => ({
      ...leg,
      startMinutes: departMinutes,
      endMinutes: arriveMinutes,
    })),
  }
}

function coalesceContinuousWalkLegs(legs) {
  const result = []
  for (let index = 0; index < legs.length;) {
    const leg = legs[index]
    if (leg.type !== 'walk') {
      result.push(leg)
      index += 1
      continue
    }
    let end = index + 1
    while (end < legs.length && legs[end].type === 'walk') end += 1
    const group = legs.slice(index, end)
    if (group.length === 1 || group.some((candidate) => candidate.walkSource !== 'transfer')) {
      result.push(...group)
      index = end
      continue
    }
    const coordinates = []
    for (const candidate of group) {
      for (const coordinate of candidate.coordinates ?? []) {
        const previous = coordinates.at(-1)
        if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate)
      }
    }
    const last = group.at(-1)
    result.push({
      type: 'walk',
      travelMode: 'walk',
      walkSource: 'transfer',
      transferSource: group.every((candidate) => candidate.transferSource === leg.transferSource)
        ? leg.transferSource : undefined,
      geometrySource: group.every((candidate) => candidate.geometrySource === leg.geometrySource)
        ? leg.geometrySource : undefined,
      streetPathVerified: group.every((candidate) => candidate.streetPathVerified === true),
      streetSegmentVerified: group.every((candidate) => (candidate.streetSegmentVerified ?? candidate.streetPathVerified) === true),
      stationAccessStatus: group.some((candidate) => candidate.stationAccessStatus === 'unverified')
        ? 'unverified' : group.find((candidate) => candidate.stationAccessStatus)?.stationAccessStatus,
      stationAccessStopIds: [...new Set(group.flatMap((candidate) => candidate.stationAccessStopIds ?? []))],
      fromStopId: leg.fromStopId,
      toStopId: last.toStopId,
      fromName: leg.fromName,
      toName: last.toName,
      startMinutes: leg.startMinutes,
      endMinutes: last.endMinutes,
      durationMinutes: Math.max(0, last.endMinutes - leg.startMinutes),
      distanceKm: group.reduce((sum, candidate) => sum + Math.max(0, numeric(candidate.distanceKm, 0)), 0),
      stopCount: 0,
      coordinates,
    })
    index = end
  }
  return result
}

function annotateNationalTransferSemantics(legs) {
  return legs.map((leg, index) => {
    if (leg?.type !== 'walk' || leg.walkSource !== 'transfer') return leg
    const previousRide = [...legs.slice(0, index)].reverse().find((candidate) => candidate?.type === 'ride')
    const nextRide = legs.slice(index + 1).find((candidate) => candidate?.type === 'ride')
    if (!previousRide || !nextRide) return leg
    const previousLabel = String(previousRide.routeShortName || previousRide.routeId || '').trim()
    const nextLabel = String(nextRide.routeShortName || nextRide.routeId || '').trim()
    const samePublicLine = Boolean(previousLabel && nextLabel && previousLabel === nextLabel)
    return {
      ...leg,
      transferAction: samePublicLine ? 'same-route-change' : 'interchange',
      connectingRouteShortName: nextLabel || undefined,
    }
  })
}

function normalizeNationalLegs(legs) {
  if (!legs.some((leg) => leg?.walkSource === 'transfer')) return legs
  return annotateNationalTransferSemantics(coalesceContinuousWalkLegs(legs))
}

function fallbackRetryRequest(store, request) {
  if (request.__suppressServiceDateFallback === true || request.allowServiceDateFallback !== true || request.__serviceDateFallbackRetry === true) return null
  const resolution = resolveServiceDate(store, request.serviceDate, request.serviceDay, true)
  if (!resolution.serviceDateFallbackApplied) return null
  return attachPreparedNativeCoordinateAccessPair(
    { ...request, __serviceDateFallbackRetry: true },
    request?.[preparedNativeCoordinateAccessPair],
  )
}

function stopRecord(row) {
  return {
    id: row.stop_id,
    name: row.name || row.stop_id,
    x: 0,
    y: 0,
    lat: row.lat,
    lon: row.lon,
    routes: [],
    tripCount: 0,
    transferScore: 0,
    parentStationId: row.parent_station || undefined,
    locationType: row.location_type ?? 0,
  }
}

function walkSeconds(distanceKm) {
  return Math.ceil(distanceKm / walkingSpeedKph * 3600 * accessPaddingFactor + accessOverheadSeconds)
}

function transferDurationSeconds(transfer) {
  if (transfer?.provenance === 'gtfs_pathway' && transfer.min_transfer_time == null) {
    return walkSeconds(numeric(transfer.path_distance_m, 0) / 1000)
  }
  return Math.max(0, numeric(transfer?.min_transfer_time, 0))
}

function accessWalkSeconds(stop) {
  if (stop?.exactStopAccess) return 0
  const explicit = numeric(stop?.accessSeconds, NaN)
  return Number.isFinite(explicit) ? Math.max(0, explicit) : walkSeconds(stop?.distanceKm ?? 0)
}

function activeServiceKernelGeneralizedScore(
  arrivalSeconds,
  boardings,
  walkingSeconds,
  departure,
) {
  const transfers = Math.max(0, boardings - 1)
  return {
    arrivalSeconds,
    elapsedSeconds: arrivalSeconds - departure,
    boardings,
    transfers,
    walkingSeconds,
    generalizedSeconds: arrivalSeconds
      + transfers * balancedTransferPenaltySeconds
      + walkingSeconds * balancedWalkReluctance,
  }
}

function activeServiceKernelBalancedSelectionDiagnostics(
  earliestArrivalWitness,
  selected,
  terminalCandidatesEvaluated,
  boardingUpperBound,
  selectedFromFrontier,
) {
  return {
    selectedRole: selectedFromFrontier
      ? 'nondominated_generalized_cost'
      : 'earliest_arrival',
    objective: 'min_generalized_seconds',
    candidateDomain:
      'all_nondominated_itineraries_within_arrival_slack_and_no_more_boardings_than_earliest',
    arrivalSlackSeconds: balancedTransferArrivalSlackSeconds,
    boardingUpperBound,
    transferPenaltySeconds: balancedTransferPenaltySeconds,
    walkReluctance: balancedWalkReluctance,
    terminalCandidatesEvaluated,
    earliestArrivalWitness,
    selected,
  }
}

function activeServiceKernelSearchGeneralizedCost(
  search,
  originStops,
  destinationStops,
  departure,
) {
  if (!search?.chain?.length || !Number.isFinite(search.bestArrival)) return null
  const accessStep = search.chain.find((step) => step.kind === 'access')
  const originStop = accessStep ? originStops[accessStep.candidateIndex] : null
  const destinationStop = destinationStops[search.bestDestinationIndex]
  if (!originStop || !destinationStop) return null
  const boardings = search.chain.reduce(
    (count, step) => count + (step.kind === 'ride' ? 1 : 0),
    0,
  )
  const transferWalkSeconds = search.chain.reduce(
    (sum, step) => sum + (step.kind === 'transfer' ? numeric(step.duration, 0) : 0),
    0,
  )
  const walkingSeconds = accessWalkSeconds(originStop)
    + transferWalkSeconds
    + accessWalkSeconds(destinationStop)
  return activeServiceKernelGeneralizedScore(
    search.bestArrival,
    boardings,
    walkingSeconds,
    departure,
  )
}

function appendDistinctCoordinate(coordinates, coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isFinite)) return coordinates
  const previous = coordinates.at(-1)
  if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate)
  return coordinates
}

function pointToAccessCoordinates(
  store,
  streetStorePath,
  streetStorageIdentity,
  pointCoordinate,
  candidate,
  maxWalkKm,
  streetPathDiagnostics,
) {
  const accessTarget = candidate.streetAccessCoordinate ?? [candidate.lon, candidate.lat]
  const exactStationAccess = candidate.exactStopAccess === true
  const appendTransferCompletion = (coordinates) => {
    const transferCoordinate = candidate.accessTransferCoordinate
    if (candidate.accessTransferCoordinates) {
      for (const coordinate of candidate.accessTransferCoordinates) appendDistinctCoordinate(coordinates, coordinate)
      return coordinates
    }
    if (candidate.accessTransferStreetPathVerified === true && Array.isArray(transferCoordinate)) {
      const destinationRole = candidate.accessRole === 'destination'
        || candidate.nativeStreetPath?.role === 'destination'
      const fromCoordinate = destinationRole ? transferCoordinate : accessTarget
      const toCoordinate = destinationRole ? accessTarget : transferCoordinate
      const fromStopId = destinationRole
        ? candidate.accessTransferToStopId
        : candidate.accessTransferFromStopId
      const toStopId = destinationRole
        ? candidate.accessTransferFromStopId
        : candidate.accessTransferToStopId
      const maximumDistanceKm = Math.max(
        maxWalkKm,
        numeric(candidate.accessTransferPathDistanceKm, 0) * 1.05 + 0.02,
      )
      const identityBoundPath = fromStopId && toStopId
        ? cachedNativeAccessMemberPath(
            store,
            {
              streetStorePath,
              streetStorageIdentity,
              fromStopId,
              toStopId,
              fromCoordinate,
              toCoordinate,
              maximumDistanceKm,
            },
            streetPathDiagnostics,
          )
        : null
      const transferPath = identityBoundPath ?? (
        fromStopId && toStopId
          ? null
          : cachedNativeStreetPath(
              store,
              {
                streetStorePath,
                streetStorageIdentity,
                fromCoordinate,
                toCoordinate,
                maximumDistanceKm,
              },
              streetPathDiagnostics,
            )
      )
      if (!Array.isArray(transferPath?.coordinates)) {
        const error = new Error('Rust could not materialize an OSM-certified linked-station access path.')
        error.code = 'VIGO_NATIVE_LINKED_STATION_PATH_REQUIRED'
        throw error
      }
      const transferCoordinates = destinationRole
        ? [...transferPath.coordinates].reverse()
        : transferPath.coordinates
      for (const coordinate of transferCoordinates) {
        appendDistinctCoordinate(coordinates, coordinate)
      }
    } else {
      appendDistinctCoordinate(coordinates, transferCoordinate)
    }
    appendDistinctCoordinate(coordinates, candidate.accessServiceCoordinate)
    return coordinates
  }
  if (!streetStorePath || exactStationAccess) {
    const direct = []
    appendDistinctCoordinate(direct, pointCoordinate)
    appendDistinctCoordinate(direct, accessTarget)
    return appendTransferCompletion(direct)
  }
  if (candidate.nativeStreetPath) {
    const coordinates = []
    const nativeCoordinates = candidate.nativeStreetPathCoordinates
      ?? materializeNativeStreetPath(streetStorePath, candidate.nativeStreetPath)
    for (const coordinate of nativeCoordinates) appendDistinctCoordinate(coordinates, coordinate)
    appendDistinctCoordinate(coordinates, accessTarget)
    return appendTransferCompletion(coordinates)
  }
  const accessStreetPath = streetPathBetween(
    streetStorePath,
    pointCoordinate,
    accessTarget,
    maxWalkKm,
  )
  if (!Array.isArray(accessStreetPath?.coordinates)) {
    const error = new Error('Rust could not materialize the verified street-access path.')
    error.code = 'VIGO_NATIVE_STREET_PATH_REQUIRED'
    throw error
  }
  const coordinates = accessStreetPath.coordinates
  if (accessStreetPath.originSnapDistanceKm > 0 && coordinates.length > 1) coordinates.shift()
  return appendTransferCompletion(coordinates)
}

function endpointConnector(coordinate, streetCoordinate, reverse = false) {
  if (!streetCoordinate || (coordinate[0] === streetCoordinate[0] && coordinate[1] === streetCoordinate[1])) return undefined
  return {
    source: 'coordinate-snap', streetPathVerified: false,
    coordinates: reverse ? [streetCoordinate, coordinate] : [coordinate, streetCoordinate],
    distanceKm: haversineKm(coordinate, streetCoordinate),
  }
}

function secondsToMinutes(seconds) {
  return Number((seconds / 60).toFixed(3))
}

function minuteCoordinate(value) {
  return Number((value / 60).toFixed(3))
}

function pointKey(point) {
  const coordinate = Array.isArray(point?.coordinate) ? point.coordinate : []
  if (coordinate.length !== 2 || !coordinate.every(Number.isFinite)) throw new Error('Every matrix point requires a valid [longitude, latitude] coordinate.')
  const explicitStopId = explicitRoutingStopId(point)
  return explicitStopId
    ? `stop:${explicitStopId}`
    : `coordinate:${coordinate.map((value) => Number(value).toString()).join(',')}`
}

function exactStationAccessCandidate(stop, accessPriority) {
  return {
    ...stop,
    distanceKm: 0,
    exactStopAccess: true,
    walkSource: 'station-selection',
    accessPriority,
    expandServiceMembers: true,
  }
}

function explicitRoutingStopId(point) {
  // `source: map` is the authoritative free-coordinate contract. Ignore a
  // stale stopId from older desktop payloads so a map A/B can never collapse
  // to one station before access candidates are searched.
  return point?.source === 'map' ? '' : String(point?.stopId ?? '').trim()
}

function stopHasDirectService(store, stopId) {
  if (store.stopAccessIndex.departureServiceStopIds) {
    return store.stopAccessIndex.departureServiceStopIds.has(stopId)
  }
  const indexedProfile = store.stopAccessIndex.directProfilesByStop?.get(stopId)
  return Boolean(indexedProfile && indexedProfile.departureCount > 0)
}

function stopParticipatesInScheduledService(store, stopId) {
  return store.stopAccessIndex.directServiceStopIds?.has(stopId) === true
}

function stopSupportsStationAccessRole(store, stopId, accessRole) {
  if (accessRole !== 'destination') return stopHasDirectService(store, stopId)
  return store.stopAccessIndex.arrivalServiceStopIds?.has(stopId) === true
}

function nativeAccessProfileSnapshotPath(storePath, profileKey) {
  return `${path.resolve(storePath)}.native-access-profile.${stableKeySuffix(profileKey)}.bin`
}


function pruneRoutingSnapshotCache({
  storePath,
  currentSnapshotPath,
  suffix,
  maximumEntries,
  maximumBytes,
  temporaryMinimumAgeMs = 0,
  temporaryReason = 'orphan-temporary',
  schemaVersion,
}) {
  const resolvedStorePath = path.resolve(storePath)
  const resolvedCurrentPath = path.resolve(currentSnapshotPath)
  const directory = path.dirname(resolvedStorePath)
  const prefix = `${path.basename(resolvedStorePath)}.${suffix}`
  const temporaryCutoffMs = Date.now() - temporaryMinimumAgeMs
  const removed = []
  const snapshots = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    const artifactPath = path.join(directory, entry.name)
    const stats = fs.statSync(artifactPath)
    if (entry.name.includes('.bin.') && entry.name.endsWith('.tmp')) {
      if (stats.mtimeMs >= temporaryCutoffMs) continue
      fs.rmSync(artifactPath, { force: true })
      removed.push({ path: artifactPath, bytes: stats.size, reason: temporaryReason })
      continue
    }
    if (!entry.name.endsWith('.bin')) continue
    snapshots.push({
      path: artifactPath,
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
      current: path.resolve(artifactPath) === resolvedCurrentPath,
    })
  }
  snapshots.sort((left, right) => (
    Number(right.current) - Number(left.current)
    || right.mtimeMs - left.mtimeMs
    || left.path.localeCompare(right.path)
  ))
  let retainedCount = 0
  let retainedBytes = 0
  for (const snapshot of snapshots) {
    const retain = snapshot.current || (
      retainedCount < maximumEntries
      && retainedBytes + snapshot.bytes <= maximumBytes
    )
    if (retain) {
      retainedCount += 1
      retainedBytes += snapshot.bytes
      continue
    }
    fs.rmSync(snapshot.path, { force: true })
    removed.push({ ...snapshot, reason: 'retention-budget' })
  }
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    maximumEntries,
    maximumBytes,
    retainedCount,
    retainedBytes,
    removedCount: removed.length,
    removedBytes: removed.reduce((sum, artifact) => sum + artifact.bytes, 0),
    removed,
  }
}

function pruneNativeAccessProfileSnapshots(storePath, currentSnapshotPath) {
  return pruneRoutingSnapshotCache({
    storePath,
    currentSnapshotPath,
    suffix: 'native-access-profile.',
    maximumEntries: nativeAccessProfileSnapshotCacheMaxEntries,
    maximumBytes: nativeAccessProfileSnapshotCacheMaxBytes,
    temporaryMinimumAgeMs: 10 * 60 * 1000,
    temporaryReason: 'stale-temporary',
  })
}

function coordinateAccessArtifactStreetIdentity(store, streetStorePath) {
  const retained = store.metadata.osmStopTransferGraph
  return String(
    retained?.streetIdentity
    ?? retained?.streetStorageIdentity
    ?? osmStopTransferStreetIdentity(readNationalOsmStoreMetadata(streetStorePath)),
  )
}

function nativeCoordinateAccessProfile(store, streetStorePath, streetStorageIdentity) {
  const cacheKey = `${path.resolve(streetStorePath)}\u0000${streetStorageIdentity}`
  let profile = store.nativeCoordinateAccessProfiles.get(cacheKey)
  if (!profile) {
    if (!store.stopAccessIndex.ready) {
      const error = new Error(
        `Resident stop-access index is required for native coordinate routing: ${store.stopAccessIndex.reason ?? 'unavailable'}`,
      )
      error.code = 'resident_stop_access_index_required'
      throw error
    }
    profile = physicalStopAccessProfile(store, streetStorePath, 'coordinate-access-v11')
    store.nativeCoordinateAccessProfiles.set(cacheKey, profile)
    while (store.nativeCoordinateAccessProfiles.size > 4) {
      store.nativeCoordinateAccessProfiles.delete(
        store.nativeCoordinateAccessProfiles.keys().next().value,
      )
    }
  }
  if (
    profile.nativeConfiguration
    && nativeRoutingAccessProfilePrepared(streetStorePath, profile.profileKey)
  ) {
    return {
      profile,
      diagnostics: {
        ...profile.nativeConfiguration,
        cacheHit: true,
        snapshotRetention: null,
      },
    }
  }
  const snapshotPath = nativeAccessProfileSnapshotPath(store.storePath, profile.profileKey)
  const diagnostics = configureNativeRoutingAccessProfile(
    streetStorePath,
    profile,
    { snapshotPath: nativeAccessProfilePersistenceEnabled ? snapshotPath : '' },
  )
  const snapshotRetention = ['memory', 'disabled'].includes(diagnostics.persistenceState)
    ? null
    : pruneNativeAccessProfileSnapshots(store.storePath, snapshotPath)
  const configuredDiagnostics = {
    ...diagnostics,
    snapshotRetention,
  }
  profile.nativeConfiguration = configuredDiagnostics
  return {
    profile,
    diagnostics: configuredDiagnostics,
  }
}

function physicalStopAccessProfile(store, streetStorePath, version) {
  // Access, egress and generated transfers attach to the same physical stop.
  // A parent centroid cannot provide free movement to every platform, and a
  // stop cannot connect street components that ordinary walking cannot join.
  const members = []
  const memberLons = []
  const memberLats = []
  const memberOriginEligible = []
  const memberDestinationEligible = []
  const memberStreetAccessStopIds = []
  const anchorLons = []
  const anchorLats = []
  const anchorMemberOffsets = [0]
  const anchorMemberIndices = []
  for (const stop of store.stopRecords.values()) {
    if (
      numeric(stop.location_type, 0) === 1
      || !Number.isFinite(stop.lon)
      || !Number.isFinite(stop.lat)
    ) {
      continue
    }
    const originEligible = stopHasDirectService(store, stop.stop_id)
    const destinationEligible = stopSupportsStationAccessRole(
      store,
      stop.stop_id,
      'destination',
    )
    if (!originEligible && !destinationEligible
      && (numeric(stop.location_type, 0) === 0 || version.startsWith('stop-transfer'))) continue
    const memberIndex = members.length
    members.push(stop)
    memberLons.push(stop.lon)
    memberLats.push(stop.lat)
    memberOriginEligible.push(Number(originEligible))
    memberDestinationEligible.push(Number(destinationEligible))
    memberStreetAccessStopIds.push(stop.stop_id)
    // Interior pathway nodes carry their declared connections, not additional
    // entrances through the nearest external street.
    if ([0, 2].includes(numeric(stop.location_type, 0))) {
      anchorLons.push(stop.lon)
      anchorLats.push(stop.lat)
      anchorMemberIndices.push(memberIndex)
      anchorMemberOffsets.push(anchorMemberIndices.length)
    }
  }
  const profileKey = [
    version,
    encodeURIComponent(store.sourceArtifactIdentity),
    encodeURIComponent(coordinateAccessArtifactStreetIdentity(store, streetStorePath)),
    members.length,
    anchorLons.length,
    encodeURIComponent(nationalRoutingAccessPolicyIdentity),
  ].join(':')
  const profile = {
    profileKey,
    members,
    stops: members,
    stopIds: members.map(stop => stop.stop_id),
    anchorLons,
    anchorLats,
    anchorMemberOffsets,
    anchorMemberIndices,
    memberLons,
    memberLats,
    memberOriginEligible,
    memberDestinationEligible,
    memberStreetAccessStopIds,
    walkingSpeedKph: nationalRoutingAccessPolicy.walkingSpeedKph,
    accessPaddingFactor: nationalRoutingAccessPolicy.accessPaddingFactor,
    accessOverheadSeconds: nationalRoutingAccessPolicy.accessOverheadSeconds,
  }
  if (version.startsWith('coordinate-access')) {
    let paths = store.preparedStationPaths
    if (!paths || paths.stopIds.length !== members.length
      || paths.stopIds.some((id, index) => id !== members[index].stop_id)) {
      paths = packStationPaths(members, stationAccessPaths(store, members, walkingSpeedKph))
      store.preparedStationPaths = paths
      Object.assign(store.accessMaterialization, persistPreparedAccessContext(store, nationalRoutingAccessPolicyIdentity))
    }
    profile.memberStopKeys = members.map((_, index) => index)
    // Each physical stop has its own key; no centroid-to-platform broadcast.
    profile.memberStationKeys = profile.memberStopKeys
    profile.memberOriginExpansionEligible = memberOriginEligible
    profile.memberDestinationExpansionEligible = memberDestinationEligible
    profile.memberOriginEligible = members.map(() => 1)
    profile.memberDestinationEligible = members.map(() => 1)
    profile.transferFromStopKeys = paths.from
    profile.transferToStopKeys = paths.to
    profile.transferToStationKeys = profile.transferToStopKeys
    profile.transferMinDurations = paths.seconds
    profile.transferPathDistancesM = paths.distanceM
    profile.transferOsmCertified = new Uint8Array(paths.from.length)
    profile.transferPaths = stationPathLookup(paths, members)
  }
  return profile
}

function nativeStopTransferProfile(store, streetStorePath) {
  const profile = physicalStopAccessProfile(store, streetStorePath, 'stop-transfer-v2')
  const diagnostics = configureNativeRoutingAccessProfile(streetStorePath, profile)
  return { profile, diagnostics }
}

export function prepareNationalGtfsNativeCoordinateAccess(storePath, streetStorePath) {
  const startedAt = performance.now()
  const store = openNationalStore(storePath)
  const streetStorageIdentity = currentStreetStoreStorageIdentity(streetStorePath)
  const prepared = nativeCoordinateAccessProfile(
    store,
    streetStorePath,
    streetStorageIdentity,
  )
  return {
    ready: true,
    prepareMs: Number((performance.now() - startedAt).toFixed(3)),
    profileKey: prepared.profile.profileKey,
    ...prepared.diagnostics,
  }
}

function osmStopTransferStreetIdentity(metadata) {
  return [
    metadata.schemaVersion ?? '',
    metadata.sourceModel ?? '',
    metadata.sourceFingerprint ?? '',
    Number(metadata.sourceBytes ?? -1),
    Number(metadata.nodeCount ?? -1),
    Number(metadata.edgeCount ?? -1),
  ].join('|')
}

function osmStopTransferGraphIdentity(metadata, streetMetadata, options) {
  return [
    osmTransferGraphSchemaVersion,
    metadata.storeId ?? metadata.sourceFingerprint ?? '',
    Number(metadata.stopCount ?? 0),
    osmStopTransferStreetIdentity(streetMetadata),
    options.maximumWalkM,
    options.maximumNeighbors,
  ].join('|')
}



export async function ensureNationalGtfsOsmStopTransfers(
  storePath,
  streetStorePath,
  options = {},
) {
  const resolvedStorePath = path.resolve(storePath)
  const resolvedStreetStorePath = path.resolve(streetStorePath)
  // Both authoritative inputs must be current before changing either store.
  readNationalGtfsStoreMetadata(resolvedStorePath)
  const streetMetadata = readNationalOsmStoreMetadata(resolvedStreetStorePath)
  const stopAccessRoles = await ensureNationalGtfsStopAccessRoles(resolvedStorePath)
  const maximumWalkM = Math.max(
    50,
    Math.min(1_200, numeric(options.maximumWalkM, osmTransferMaximumWalkM)),
  )
  const maximumNeighbors = Math.max(
    0,
    Math.min(4_096, Math.floor(numeric(options.maximumNeighbors, osmTransferMaximumNeighbors))),
  )
  const streetStorageIdentity = currentStreetStoreStorageIdentity(resolvedStreetStorePath)
  const inspection = new DatabaseSync(resolvedStorePath, { readOnly: true })
  let metadata
  let expectedFingerprint
  let retainedFingerprint
  let retainedEdges = 0
  try {
    metadata = metadataRecord(inspection)
    admitCurrentTransferSemantics(inspection, resolvedStorePath, metadata)
    expectedFingerprint = osmStopTransferGraphIdentity(
      metadata,
      streetMetadata,
      { maximumWalkM, maximumNeighbors },
    )
    retainedFingerprint = metadata.osmStopTransferGraph?.fingerprint
    retainedEdges = Number(inspection.prepare(`
      SELECT COUNT(*) AS count
      FROM transfer_provenance
      WHERE provenance='osm_certified_radial'
    `).get()?.count ?? 0)
    if (
      retainedFingerprint === expectedFingerprint
      && Number(metadata.osmStopTransferGraph?.edgeCount ?? -1) === retainedEdges
    ) {
      const derivedArtifacts = stopAccessRoles.built
        ? await refreshNationalGtfsDerivedArtifacts(resolvedStorePath, {
            onProgress: options.onProgress,
          })
        : undefined
      return {
        ready: true,
        built: false,
        schemaVersion: osmTransferGraphSchemaVersion,
        fingerprint: retainedFingerprint,
        edgeCount: retainedEdges,
        maximumWalkM,
        maximumNeighbors,
        walkingPolicy: nationalRoutingAccessPolicy,
        stopAccessRoles,
        ...(derivedArtifacts ? { derivedArtifacts } : {}),
      }
    }
  } finally {
    inspection.close()
  }

  options.onProgress?.({
    phase: 'Building pedestrian stop transfers',
    progress: 0.05,
    detail: `${Number(metadata.stopCount ?? 0).toLocaleString()} stops`,
  })
  const store = openNationalStore(resolvedStorePath)
  const prepared = nativeStopTransferProfile(
    store,
    resolvedStreetStorePath,
  )
  let built
  try {
    built = buildNativeStopTransferGraph(resolvedStreetStorePath, {
      maximumWalkM,
      maximumNeighbors,
    })
  } finally {
    // Endpoint routing deliberately snaps station members through their public
    // access anchor. Stop-to-stop transfers deliberately do not. Restore the
    // endpoint profile before the worker begins serving point queries.
    nativeCoordinateAccessProfile(
      store,
      resolvedStreetStorePath,
      streetStorageIdentity,
    )
  }
  const pairDistances = new Map()
  for (let index = 0; index < built.fromMemberIndices.length; index += 1) {
    const from = prepared.profile.members[built.fromMemberIndices[index]]
    const to = prepared.profile.members[built.toMemberIndices[index]]
    const fromStreetAccessStopId = prepared.profile.memberStreetAccessStopIds[
      built.fromMemberIndices[index]
    ] ?? from?.stop_id
    const toStreetAccessStopId = prepared.profile.memberStreetAccessStopIds[
      built.toMemberIndices[index]
    ] ?? to?.stop_id
    const distanceM = numeric(built.distancesM[index], Number.POSITIVE_INFINITY)
    if (
      !from
      || !to
      || from.stop_id === to.stop_id
      || !Number.isFinite(distanceM)
      || distanceM < 0
      || distanceM > maximumWalkM + 0.1
      || (
        String(fromStreetAccessStopId ?? '')
        && fromStreetAccessStopId === toStreetAccessStopId
      )
      || (
        String(from.parent_station ?? '')
        && from.parent_station === to.parent_station
      )
    ) {
      continue
    }
    const key = transferPairKey(from.stop_id, to.stop_id)
    if (distanceM < (pairDistances.get(key)?.distanceM ?? Number.POSITIVE_INFINITY)) {
      pairDistances.set(key, {
        fromStopId: from.stop_id,
        toStopId: to.stop_id,
        distanceM,
      })
    }
  }

  invalidateNationalStore(resolvedStorePath)
  const database = new DatabaseSync(resolvedStorePath)
  let insertedEdges = 0
  try {
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;')
    try {
      database.exec(`
        DELETE FROM transfers
        WHERE EXISTS(
          SELECT 1 FROM transfer_provenance AS provenance
          WHERE provenance.from_stop_id=transfers.from_stop_id
            AND provenance.to_stop_id=transfers.to_stop_id
            AND provenance.provenance='osm_certified_radial'
        );
        DELETE FROM transfer_provenance WHERE provenance='osm_certified_radial';
      `)
      const insertTransfer = database.prepare(`
        INSERT OR IGNORE INTO transfers(
          from_stop_id, to_stop_id, transfer_type, min_transfer_time
        ) VALUES(?, ?, 2, ?)
      `)
      const insertProvenance = database.prepare(`
        INSERT INTO transfer_provenance(
          from_stop_id, to_stop_id, provenance, evidence_fingerprint, path_distance_m
        ) VALUES(?, ?, 'osm_certified_radial', ?, ?)
      `)
      for (const edge of pairDistances.values()) {
        const lowerBoundSeconds = Math.max(
          1,
          Math.ceil(edge.distanceM / 1000 / osmTransferLowerBoundSpeedKph * 3600),
        )
        const inserted = insertTransfer.run(
          edge.fromStopId,
          edge.toStopId,
          lowerBoundSeconds,
        )
        if (Number(inserted.changes ?? 0) !== 1) continue
        insertProvenance.run(
          edge.fromStopId,
          edge.toStopId,
          expectedFingerprint,
          edge.distanceM,
        )
        insertedEdges += 1
      }
      const transferCount = Number(database.prepare(
        'SELECT COUNT(*) AS count FROM transfers',
      ).get()?.count ?? 0)
      const previousGeneration = metadata.transferGeneration
        && typeof metadata.transferGeneration === 'object'
        ? metadata.transferGeneration
        : {}
      const completedAt = new Date().toISOString()
      const graphMetadata = {
        schemaVersion: osmTransferGraphSchemaVersion,
        fingerprint: expectedFingerprint,
        streetIdentity: osmStopTransferStreetIdentity(streetMetadata),
        maximumWalkM,
        maximumNeighbors,
        candidateEdgeCount: pairDistances.size,
        edgeCount: insertedEdges,
        builtAt: completedAt,
      }
      const setMetadata = database.prepare(`
        INSERT INTO metadata(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `)
      setMetadata.run('transferCount', JSON.stringify(transferCount))
      setMetadata.run('osmStopTransferGraph', JSON.stringify(graphMetadata))
      setMetadata.run('transferGeneration', JSON.stringify({
        ...previousGeneration,
        strategy: 'source-plus-osm-certified-directed-stop-frontier',
        exact: true,
        osmCertifiedTransferCount: insertedEdges,
        osmMaximumWalkM: maximumWalkM,
        osmMaximumNeighbors: maximumNeighbors,
      }))
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;')
  } finally {
    database.close()
    invalidateNationalStore(resolvedStorePath)
  }

  options.onProgress?.({
    phase: 'Refreshing transfer-aware topology',
    progress: 0.75,
    detail: `${insertedEdges.toLocaleString()} directed stop transfers`,
  })
  const derivedArtifacts = await refreshNationalGtfsDerivedArtifacts(resolvedStorePath, {
    onProgress: options.onProgress
      ? (progress) => options.onProgress({
          ...progress,
          progress: 0.75 + Math.max(0, Math.min(1, progress.progress)) * 0.25,
        })
      : undefined,
  })
  return {
    ready: true,
    built: true,
    schemaVersion: osmTransferGraphSchemaVersion,
    fingerprint: expectedFingerprint,
    edgeCount: insertedEdges,
    candidateEdgeCount: pairDistances.size,
    maximumWalkM,
    maximumNeighbors,
    walkingPolicy: nationalRoutingAccessPolicy,
    stopAccessRoles,
    native: built.diagnostics,
    derivedArtifacts,
  }
}

function prepareNativeCoordinateAccessPair(
  store,
  origin,
  destination,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity,
  disableCache = false,
) {
  if (
    !streetStorePath
    || explicitRoutingStopId(origin)
    || explicitRoutingStopId(destination)
    || !Array.isArray(origin?.coordinate)
    || !Array.isArray(destination?.coordinate)
  ) return null
  const pairPreparationStartedAt = performance.now()
  const profileReadinessStartedAt = performance.now()
  const profile = nativeCoordinateAccessProfile(
    store,
    streetStorePath,
    streetStorageIdentity,
  )
  const profileReadinessMs = performance.now() - profileReadinessStartedAt
  // Candidate labels contain a predecessor token owned by the most recent
  // Rust endpoint query. Never retain those labels in a JavaScript cache:
  // another coordinate query invalidates the token before geometry
  // materialization. Rust already caches the immutable frontier and returns a
  // fresh token cheaply on the next call.
  const routed = routeNativeCoordinateFrontiers(streetStorePath, {
    origin: origin.coordinate,
    destination: destination.coordinate,
    maximumWalkM: maxWalkKm * 1000,
    disableCache,
  })
  const originPostprocessing = {
    engine: routed.diagnostics.accessReducer,
    native: true,
    totalMs: timingMilliseconds(routed.diagnostics.originAccessReductionMs),
    rawCandidates: routed.diagnostics.originRawCandidates,
    linkedStations: routed.diagnostics.originLinkedStations,
    selectedCandidates: routed.origin.length,
  }
  const destinationPostprocessing = {
    engine: routed.diagnostics.accessReducer,
    native: true,
    totalMs: timingMilliseconds(routed.diagnostics.destinationAccessReductionMs),
    rawCandidates: routed.diagnostics.destinationRawCandidates,
    linkedStations: routed.diagnostics.destinationLinkedStations,
    selectedCandidates: routed.destination.length,
  }
  const prepared = {
    origin: routed.origin,
    destination: routed.destination,
    diagnostics: {
      ...routed.diagnostics,
      profileReadinessMs,
      pairPreparationMs: 0,
      accessProfile: profile.diagnostics,
      originPostprocessing,
      destinationPostprocessing,
    },
  }
  prepared.diagnostics.pairPreparationMs = performance.now() - pairPreparationStartedAt
  return prepared
}

function bindPreparedNativeCoordinateAccessPair(
  store,
  origin,
  destination,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity,
  accessPair,
  preparationMs,
) {
  if (!accessPair) return null
  return {
    accessPair,
    preparationMs,
    reuseCount: 0,
    binding: {
      store,
      sourceStorageIdentity: store.sourceStorageIdentity,
      streetStorePath: path.resolve(streetStorePath),
      streetStorageIdentity,
      originCoordinate: [...origin.coordinate],
      destinationCoordinate: [...destination.coordinate],
      maxWalkKm,
    },
  }
}

function preparedNativeCoordinateAccessPairMatches(
  prepared,
  store,
  origin,
  destination,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity,
) {
  const binding = prepared?.binding
  return (
    Boolean(binding)
    && binding.store === store
    && binding.sourceStorageIdentity === store.sourceStorageIdentity
    && binding.streetStorePath === path.resolve(streetStorePath)
    && binding.streetStorageIdentity === streetStorageIdentity
    && binding.maxWalkKm === maxWalkKm
    && binding.originCoordinate[0] === origin?.coordinate?.[0]
    && binding.originCoordinate[1] === origin?.coordinate?.[1]
    && binding.destinationCoordinate[0] === destination?.coordinate?.[0]
    && binding.destinationCoordinate[1] === destination?.coordinate?.[1]
  )
}

function nativeCoordinateAccessPairForRequest(
  request,
  store,
  origin,
  destination,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity,
) {
  const prepared = request?.[preparedNativeCoordinateAccessPair]
  if (!prepared) {
    return prepareNativeCoordinateAccessPair(
      store,
      origin,
      destination,
      maxWalkKm,
      streetStorePath,
      streetStorageIdentity,
      request.__disableNativeStreetPathCache === true,
    )
  }
  if (!preparedNativeCoordinateAccessPairMatches(
    prepared,
    store,
    origin,
    destination,
    maxWalkKm,
    streetStorePath,
    streetStorageIdentity,
  )) {
    const error = new Error(
      'A request-local coordinate-access frontier was presented to a different routing identity.',
    )
    error.code = 'VIGO_PREPARED_COORDINATE_ACCESS_IDENTITY_MISMATCH'
    throw error
  }
  prepared.reuseCount += 1
  return {
    ...prepared.accessPair,
    diagnostics: {
      ...prepared.accessPair.diagnostics,
      requestLocalFrontierReuse: true,
      requestLocalFrontierReuseOrdinal: prepared.reuseCount,
      requestLocalFrontierIdentity:
        'gtfs-store-object+gtfs-storage+street-path+street-storage+coordinates+walk-envelope',
    },
  }
}

function attachPreparedNativeCoordinateAccessPair(request, prepared) {
  if (!prepared) return request
  Object.defineProperty(request, preparedNativeCoordinateAccessPair, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: prepared,
  })
  return request
}

function prepareRequestLocalNativeCoordinateAccessPair(
  request,
  store,
  origin,
  destination,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity,
) {
  const inheritedPrepared = request?.[preparedNativeCoordinateAccessPair] ?? null
  const startedAt = performance.now()
  const accessPair = nativeCoordinateAccessPairForRequest(
    request,
    store,
    origin,
    destination,
    maxWalkKm,
    streetStorePath,
    streetStorageIdentity,
  )
  const requestMs = Number((performance.now() - startedAt).toFixed(3))
  const prepared = inheritedPrepared ?? bindPreparedNativeCoordinateAccessPair(
    store,
    origin,
    destination,
    maxWalkKm,
    streetStorePath,
    streetStorageIdentity,
    accessPair,
    requestMs,
  )
  return {
    accessPair,
    prepared,
    preparedHere: Boolean(prepared && !inheritedPrepared),
    inherited: Boolean(inheritedPrepared),
    requestMs,
  }
}

function prepareNativeCoordinateAccessRole(
  store,
  point,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity,
  accessRole,
) {
  if (
    !streetStorePath
    || explicitRoutingStopId(point)
    || !Array.isArray(point?.coordinate)
    || point.coordinate.length !== 2
    || !point.coordinate.every(Number.isFinite)
  ) return null
  const profile = nativeCoordinateAccessProfile(
    store,
    streetStorePath,
    streetStorageIdentity,
  )
  const routed = routeNativeCoordinateFrontier(streetStorePath, {
    coordinate: point.coordinate,
    role: accessRole,
    maximumWalkM: maxWalkKm * 1000,
  })
  return {
    candidates: routed.candidates,
    diagnostics: {
      ...routed.diagnostics,
      accessProfile: profile.diagnostics,
    },
  }
}

function preparePointAccessStops(
  store,
  point,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity = currentStreetStoreStorageIdentity(streetStorePath),
  accessRole = 'origin',
) {
  const native = prepareNativeCoordinateAccessRole(
    store,
    point,
    maxWalkKm,
    streetStorePath,
    streetStorageIdentity,
    accessRole,
  )
  return native?.candidates
    ?? prepareAccessStops(
      store,
      point,
      maxWalkKm,
      streetStorePath,
      streetStorageIdentity,
      accessRole,
    )
}

function prepareAccessStops(
  store,
  point,
  maxWalkKm,
  streetStorePath,
  streetStorageIdentity = currentStreetStoreStorageIdentity(streetStorePath),
  accessRole = 'origin',
) {
  const explicitStopId = explicitRoutingStopId(point)
  const cacheKey = JSON.stringify([
    point?.coordinate,
    explicitStopId,
    point?.source ?? '',
    maxWalkKm,
    streetStorePath ?? 'direct',
    streetStorageIdentity,
    accessRole,
  ])
  const cached = boundedCacheGet(store.accessStopsCache, cacheKey)
  if (cached) return cached
  const selectedStop = explicitStopId ? store.stopLookup.get(explicitStopId) : null
  if (explicitStopId && !selectedStop) {
    boundedCacheSet(store.accessStopsCache, cacheKey, [], 20_000)
    return []
  }
  if (selectedStop) {
    const stationId = selectedStop.location_type === 1
      ? selectedStop.stop_id
      : String(selectedStop.parent_station ?? '').trim()
    const memberIds = stationId
      ? [stationId, ...(store.stationMembers.get(stationId) ?? [])]
      : [selectedStop.stop_id]
    const uniqueMembers = [...new Set(memberIds)]
      .map((stopId) => store.stopLookup.get(stopId))
      .filter(Boolean)
    const serviceAnchor = selectedStop.location_type === 1 ? selectedStop : (store.stopLookup.get(stationId) ?? selectedStop)
    const profile = sampledAnchorServiceProfile(store, serviceAnchor)
    const accessPriority = profile.hasHeavyRail
      ? `selected-rail:${selectedStop.stop_id}`
      : profile.modes.length ? `selected-${profile.modes.join('-')}:${selectedStop.stop_id}` : undefined
    const selected = uniqueMembers.map((stop) => exactStationAccessCandidate(stop, accessPriority))
    boundedCacheSet(store.accessStopsCache, cacheKey, selected, 20_000)
    return selected
  }
  if (streetStorePath) {
    const error = new Error(
      'Coordinate access with an OSM street store requires the Rust one-to-many access adapter.',
    )
    error.code = 'VIGO_NATIVE_COORDINATE_ACCESS_REQUIRED'
    throw error
  }
  const stops = nearestStops(store, point.coordinate, maxWalkKm, 12)
  boundedCacheSet(store.accessStopsCache, cacheKey, stops, 20_000)
  return stops
}

function requestedAccessStopIds(request, field) {
  const values = request?.[field]
  if (!Array.isArray(values) || !values.length) return null
  const stopIds = new Set()
  for (const value of values) {
    const stopId = String(value ?? '').trim()
    if (stopId) stopIds.add(stopId)
  }
  return stopIds.size ? stopIds : null
}

function restrictAccessStops(stops, requestedStopIds) {
  if (!requestedStopIds) return stops
  return stops.filter((stop) => requestedStopIds.has(stop.stop_id))
}

function accessAvailabilityHint(
  store,
  point,
  currentCandidates,
  selectedMaxWalkKm,
  streetStorePath,
  streetStorageIdentity,
  accessRole,
  requestedStopIds = null,
) {
  if (currentCandidates.length || explicitRoutingStopId(point)) return null
  const probeWalkKm = Math.min(
    5,
    Math.max(selectedMaxWalkKm + 0.5, selectedMaxWalkKm * 2),
  )
  let candidates
  let strategy
  let diagnosticError = null
  try {
    candidates = restrictAccessStops(
      preparePointAccessStops(
        store,
        point,
        probeWalkKm,
        streetStorePath,
        streetStorageIdentity,
        accessRole,
      ),
      requestedStopIds,
    )
    strategy = streetStorePath ? 'osm-street-frontier-probe' : 'resident-stop-access-index-probe'
  } catch (error) {
    diagnosticError = error instanceof Error ? error.message : String(error)
    candidates = []
  }
  if (!candidates.length && streetStorePath) {
    try {
      const nearby = restrictAccessStops(
        nearestStops(store, point?.coordinate, probeWalkKm, 256)
          .filter((stop) => stopSupportsStationAccessRole(
            store,
            stop.stop_id,
            accessRole,
          )),
        requestedStopIds,
      )
      const nearestPhysical = nearby[0]
      if (nearestPhysical) {
        const distanceKm = Number(nearestPhysical.distanceKm)
        const walkSeconds = accessWalkSeconds(nearestPhysical)
        return {
          role: accessRole,
          status: 'street_access_unverified',
          selectedWalkKm: selectedMaxWalkKm,
          probeWalkKm,
          nearestStop: {
            id: nearestPhysical.stop_id,
            name: nearestPhysical.name || nearestPhysical.stop_id,
            distanceKm: Number(distanceKm.toFixed(3)),
            walkMinutes: Number((walkSeconds / 60).toFixed(1)),
          },
          strategy: 'stop-index-plus-street-frontier',
          detail: diagnosticError,
        }
      }
    } catch (error) {
      diagnosticError ??= error instanceof Error ? error.message : String(error)
    }
  }
  const nearest = candidates[0]
  if (!nearest) {
    if (diagnosticError) {
      return {
        role: accessRole,
        status: 'diagnostic_unavailable',
        selectedWalkKm: selectedMaxWalkKm,
        probeWalkKm,
        detail: diagnosticError,
      }
    }
    return {
      role: accessRole,
      status: 'none_within_probe',
      selectedWalkKm: selectedMaxWalkKm,
      probeWalkKm,
      strategy,
    }
  }
  const requiredWalkKm = Number(nearest.distanceKm)
  const requiredWalkSeconds = accessWalkSeconds(nearest)
  const suggestedMaxWalkKm = Math.min(
    5,
    Math.max(
      selectedMaxWalkKm + 0.1,
      Math.ceil((requiredWalkKm + 0.05) * 10) / 10,
    ),
  )
  return {
    role: accessRole,
    status: 'outside_selected_budget',
    selectedWalkKm: selectedMaxWalkKm,
    probeWalkKm,
    requiredWalkKm: Number(requiredWalkKm.toFixed(3)),
    requiredWalkMinutes: Number((requiredWalkSeconds / 60).toFixed(1)),
    suggestedMaxWalkKm,
    nearestStop: {
      id: nearest.stop_id,
      name: nearest.name || nearest.stop_id,
      distanceKm: Number(requiredWalkKm.toFixed(3)),
      walkMinutes: Number((requiredWalkSeconds / 60).toFixed(1)),
    },
    strategy,
  }
}

export function inspectNationalGtfsAccessCandidates(storePath, point, options = {}) {
  const store = openNationalStore(storePath)
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(options.maxWalkKm, 1.6)))
  const explicitStopId = explicitRoutingStopId(point)
  const accessRole = options.accessRole === 'destination' ? 'destination' : 'origin'
  const before = stopAccessIndexDiagnostics(store)
  let candidates
  let strategy
  if (explicitStopId) {
    candidates = prepareAccessStops(store, point, maxWalkKm, options.streetStorePath, undefined, accessRole)
    strategy = 'exact_station_selection'
  } else if (options.streetStorePath) {
    candidates = preparePointAccessStops(
      store,
      point,
      maxWalkKm,
      options.streetStorePath,
      undefined,
      accessRole,
    )
    strategy = `${store.stopAccessIndex.strategy}+street_graph`
  } else {
    candidates = nearestStops(store, point?.coordinate, maxWalkKm, numeric(options.limit, 12))
    strategy = store.stopAccessIndex.strategy
  }
  const after = stopAccessIndexDiagnostics(store)
  return {
    candidates: candidates.map((candidate) => ({
      stopId: candidate.stop_id,
      name: candidate.name,
      coordinate: [candidate.lon, candidate.lat],
      distanceKm: candidate.distanceKm,
      accessPriority: candidate.accessPriority,
      expandServiceMembers: candidate.expandServiceMembers === true,
      exactStopAccess: candidate.exactStopAccess === true,
      walkSource: candidate.walkSource,
      streetPathVerified: candidate.streetPathVerified === true,
      accessCandidateClass: candidate.accessCandidateClass,
      accessSearchComplete: candidate.accessSearchComplete === true,
      accessTransferFromStopId: candidate.accessTransferFromStopId,
      accessTransferToStopId: candidate.accessTransferToStopId,
      accessTransferSeconds: candidate.accessTransferSeconds,
      accessDurationSeconds: accessWalkSeconds(candidate),
      accessTransferPathDistanceKm: candidate.accessTransferPathDistanceKm,
      accessTransferStreetPathVerified: candidate.accessTransferStreetPathVerified === true,
    })),
    diagnostics: {
      ...after,
      strategy,
      candidateCount: candidates.length,
      queryCountDelta: after.queryCount - before.queryCount,
      queryMsDelta: timingMilliseconds(
        timingMilliseconds(after.queryMs) - timingMilliseconds(before.queryMs),
      ),
      completeStreetAccessFrontier: Boolean(options.streetStorePath) && !explicitStopId,
    },
  }
}

function activateServices(store, serviceDate, serviceDay = 'weekday') {
  const serviceCalendarKey = `${serviceDate}|${serviceDay}`
  if (
    store.activeServiceCalendarKey === serviceCalendarKey
    && store.activeServices instanceof Set
  ) return store.activeServices
  const services = servicesForDate(store, serviceDate, serviceDay)
  if (store.activeServiceCalendarKey === serviceCalendarKey) {
    store.activeServices = services
    return services
  }
  const serviceSetKey = `services:${[...services].sort().join('\u001f')}`
  // Calendar dates are resolved before this identity is computed, including
  // calendar_dates additions/removals. Equivalent dates may therefore reuse
  // one immutable timetable kernel, while any exception that changes the
  // active service set necessarily receives a different identity.
  if (store.activeServiceDate === serviceSetKey) {
    store.activeServiceCalendarKey = serviceCalendarKey
    store.activeServices = services
    store.activeServiceKernelStatus = {
      ...store.activeServiceKernelStatus,
      serviceKey: serviceSetKey,
      serviceCalendarKey,
      equivalentServiceSetReused: true,
      contextCache: activeServiceKernelContextCacheSnapshot(store),
    }
    return services
  }
  const insertService = store.db.prepare('INSERT INTO active_services VALUES(?)')
  // Keep the previous active table, key, and kernel usable unless the complete
  // TEMP-table replacement commits. This matters for read-only source stores:
  // a failed service switch must never leave JS state describing a half-written
  // TEMP table or discard the last valid in-memory kernel.
  runTemporaryTransaction(store.db, () => {
    store.db.exec('DELETE FROM active_services;')
    for (const serviceId of services) insertService.run(serviceId)
  })
  store.activeServiceCalendarKey = serviceCalendarKey
  store.activeServices = services
  store.activeServiceDate = serviceSetKey
  const cached = boundedCacheGet(store.activeServiceKernelContexts, serviceSetKey)
  if (cached?.kernel?.sourceStorageIdentity === store.sourceStorageIdentity) {
    store.activeServiceKernel = cached.kernel
    store.activeServiceKernelStatus = {
      ...cached.status,
      serviceKey: serviceSetKey,
      serviceCalendarKey,
      contextCacheHit: true,
      contextCache: activeServiceKernelContextCacheSnapshot(store),
    }
  } else {
    store.activeServiceKernel = null
    store.activeServiceKernelStatus = {
      ready: false,
      reason: 'service_context_changed',
      serviceKey: serviceSetKey,
      serviceCalendarKey,
      contextCacheHit: false,
      contextCache: activeServiceKernelContextCacheSnapshot(store),
      maxSegments: activeServiceKernelMaxSegments || null,
      maxEstimatedBytes: activeServiceKernelMaxEstimatedBytes || null,
    }
  }
  return services
}

function activeServiceKernelContextCacheSnapshot(store) {
  const contexts = [...(store.activeServiceKernelContexts?.entries() ?? [])]
  const productionEstimatedBytes = contexts.reduce(
    (sum, [, entry]) => sum + Math.max(0, numeric(entry?.status?.estimatedBytes, 0)),
    0,
  )
  return {
    entries: contexts.length,
    estimatedBytes: productionEstimatedBytes,
    productionEstimatedBytes,
    maxEntries: activeServiceKernelContextCacheMaxEntries,
    maxBytes: activeServiceKernelContextCacheMaxBytes,
    serviceKeys: contexts.map(([serviceKey]) => serviceKey),
  }
}

function activeServiceKernelContextEntryBytes(entry) {
  return Math.max(0, numeric(entry?.status?.estimatedBytes, 0))
}

function trimActiveServiceKernelContexts(store, protectedServiceKey = null) {
  if (!store.activeServiceKernelContexts) return
  const totalBytes = () => [...store.activeServiceKernelContexts.values()].reduce(
    (sum, entry) => sum + activeServiceKernelContextEntryBytes(entry),
    0,
  )
  while (
    store.activeServiceKernelContexts.size > activeServiceKernelContextCacheMaxEntries
    || (
      store.activeServiceKernelContexts.size > 1
      && totalBytes() > activeServiceKernelContextCacheMaxBytes
    )
  ) {
    let oldestKey = store.activeServiceKernelContexts.keys().next().value
    if (
      oldestKey === protectedServiceKey
      && store.activeServiceKernelContexts.size > 1
    ) {
      oldestKey = [...store.activeServiceKernelContexts.keys()]
        .find((serviceKey) => serviceKey !== protectedServiceKey)
    }
    if (oldestKey === undefined) break
    if (
      oldestKey === protectedServiceKey
      && store.activeServiceKernelContexts.size === 1
    ) break
    store.activeServiceKernelContexts.delete(oldestKey)
  }
}

function rememberActiveServiceKernelContext(store) {
  const kernel = store.activeServiceKernel
  const status = store.activeServiceKernelStatus
  if (!kernel || status?.ready !== true || !kernel.serviceKey) return
  if (!store.activeServiceKernelContexts) store.activeServiceKernelContexts = new Map()
  const cacheStatus = { ...status, contextCache: undefined, contextCacheHit: undefined }
  if (store.activeServiceKernelContexts.has(kernel.serviceKey)) {
    store.activeServiceKernelContexts.delete(kernel.serviceKey)
  }
  store.activeServiceKernelContexts.set(kernel.serviceKey, { kernel, status: cacheStatus })
  trimActiveServiceKernelContexts(store, kernel.serviceKey)
  store.activeServiceKernelStatus = {
    ...store.activeServiceKernelStatus,
    contextCacheHit: false,
    contextCache: activeServiceKernelContextCacheSnapshot(store),
  }
}

const activeServiceKernelSnapshotCache = new WeakMap()

function activeServiceKernelSnapshot(store) {
  const status = store.activeServiceKernelStatus ?? {
    ready: false,
    reason: 'not_prepared',
    maxSegments: activeServiceKernelMaxSegments || null,
    maxEstimatedBytes: activeServiceKernelMaxEstimatedBytes || null,
  }
  const cached = activeServiceKernelSnapshotCache.get(status)
  if (cached) return cached
  const snapshot = Object.freeze({
    ...status,
    contextCache: activeServiceKernelContextCacheSnapshot(store),
  })
  activeServiceKernelSnapshotCache.set(status, snapshot)
  return snapshot
}

const activeServiceKernelTypedArrayKeys = Object.freeze([
  'departureSeconds', 'arrivalSeconds', 'fromStop', 'toStop', 'sequence', 'segmentTrip', 'segmentRun', 'continuityBreak',
  'canBoard', 'canAlight',
  'tripStart', 'departureOffset', 'departureOrder', 'transferOffset', 'transferTo', 'transferDuration', 'forbiddenSameStop', 'sameStopTransferMinimum',
])

const activeServiceKernelDictionaryKeys = Object.freeze([
  'stopIds', 'tripIds', 'routeIds', 'serviceIds', 'directionIds',
])

function activeServiceKernelByteEstimate(kernel) {
  const sourceTypedArrayBytes = activeServiceKernelTypedArrayKeys
    .reduce((sum, key) => sum + kernel[key].byteLength, 0)
  const nativeIndexBytes = Math.max(0, numeric(kernel.nativeTimetableKernel?.nativeIndexBytes, 0))
  const nativeWorkspaceBytes = Math.max(0, numeric(kernel.nativeTimetableKernel?.workspaceBytes, 0))
  const typedArrayBytes = sourceTypedArrayBytes + nativeIndexBytes
  const dictionaryBytes = activeServiceKernelDictionaryKeys
    .flatMap((key) => kernel[key])
    .reduce((sum, value) => sum + String(value ?? '').length * 2 + 16, 0)
  return {
    sourceTypedArrayBytes,
    nativeIndexBytes,
    nativeWorkspaceBytes,
    typedArrayBytes,
    dictionaryBytes,
    estimatedBytes: typedArrayBytes + nativeWorkspaceBytes + dictionaryBytes,
  }
}

function preloadNativeTimetableKernel(kernel) {
  const prepared = prepareNativeTimetableKernel(kernel)
  const diagnostics = {
    ready: true,
    configureMs: timingMilliseconds(prepared.configureMs),
    ...prepared.diagnostics,
  }
  kernel.nativeTimetableKernel = diagnostics
  const bytes = activeServiceKernelByteEstimate(kernel)
  if (
    activeServiceKernelMaxEstimatedBytes > 0
    && bytes.estimatedBytes > activeServiceKernelMaxEstimatedBytes
  ) {
    const error = new Error(
      `The Rust timetable kernel retains ${Math.ceil(bytes.estimatedBytes / 1024 / 1024)} MiB, exceeding the ${Math.floor(activeServiceKernelMaxEstimatedBytes / 1024 / 1024)} MiB guard.`,
    )
    error.code = 'native_timetable_memory_guard'
    error.bytes = bytes
    throw error
  }
  Object.assign(kernel, bytes)
  return diagnostics
}

function activeServiceKernelSnapshotPath(store, serviceKey) {
  const key = stableKeySuffix(JSON.stringify({
    schemaVersion: activeServiceKernelSchemaVersion,
    sourceArtifactIdentity: store.sourceArtifactIdentity,
    serviceKey,
    accessPolicyIdentity: nationalRoutingAccessPolicyIdentity,
  }))
  return `${store.storePath}.active-service-kernel.${key}.bin`
}

function pruneActiveServiceKernelSnapshotCache(storePath, currentSnapshotPath) {
  return pruneRoutingSnapshotCache({
    storePath,
    currentSnapshotPath,
    suffix: 'active-service-kernel.',
    schemaVersion: 'vigo.routing.active-service-snapshot-retention.v1',
    maximumEntries: activeServiceKernelSnapshotCacheMaxEntries,
    maximumBytes: activeServiceKernelSnapshotCacheMaxBytes,
  })
}

function persistActiveServiceKernel(kernel, snapshotPath, storePath) {
  if (!activeServiceKernelPersistenceEnabled) return { persisted: false, persistenceReason: 'disabled' }
  const startedAt = performance.now()
  const temporaryPath = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const persistedKernel = {
      schemaVersion: activeServiceKernelSchemaVersion,
      serviceKey: kernel.serviceKey,
      sourceArtifactIdentity: kernel.sourceArtifactIdentity,
      accessPolicyIdentity: nationalRoutingAccessPolicyIdentity,
      runCount: kernel.runCount,
      activeSegmentCount: kernel.activeSegmentCount,
      transferCount: kernel.transferCount,
      transferProjectionVersion: kernel.transferProjectionVersion,
      transferProjectionVerified: kernel.transferProjectionVerified,
      sourceExpandedTransferEdges: kernel.sourceExpandedTransferEdges,
      excludedNonServiceTransferEdges: kernel.excludedNonServiceTransferEdges,
      excludedNonServiceStationMembers: kernel.excludedNonServiceStationMembers,
    }
    for (const key of activeServiceKernelDictionaryKeys) persistedKernel[key] = kernel[key]
    const bytes = encodeRoutingSnapshot({
      schemaVersion: activeServiceKernelSchemaVersion,
      kernel: persistedKernel,
    }, Object.fromEntries(activeServiceKernelTypedArrayKeys.map(key => [key, kernel[key]])))
    fs.writeFileSync(temporaryPath, bytes, { mode: 0o600 })
    fs.renameSync(temporaryPath, snapshotPath)
    const snapshotRetention = pruneActiveServiceKernelSnapshotCache(
      storePath,
      snapshotPath,
    )
    return {
      persisted: true,
      persistenceState: 'written',
      snapshotPath,
      snapshotBytes: bytes.byteLength,
      snapshotWriteMs: Number((performance.now() - startedAt).toFixed(3)),
      snapshotRetention,
    }
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }) } catch {}
    return {
      persisted: false,
      persistenceState: 'write_error',
      persistenceError: error instanceof Error ? error.message : String(error),
      snapshotPath,
      snapshotWriteMs: Number((performance.now() - startedAt).toFixed(3)),
    }
  }
}

function assertCompactCsrSnapshot(offset, targets, nodeCount, targetCount, label) {
  if (
    !(offset instanceof Uint32Array)
    || !(targets instanceof Uint32Array)
    || offset.length !== nodeCount + 1
    || offset[0] !== 0
    || offset[offset.length - 1] !== targets.length
  ) {
    throw new Error(`Compact-kernel snapshot ${label} dimensions are invalid.`)
  }
  for (let node = 0; node < nodeCount; node += 1) {
    if (offset[node] > offset[node + 1]) {
      throw new Error(`Compact-kernel snapshot ${label} offsets are not monotone.`)
    }
  }
  for (let index = 0; index < targets.length; index += 1) {
    if (targets[index] >= targetCount) {
      throw new Error(`Compact-kernel snapshot ${label} target is out of range.`)
    }
  }
}

function loadPersistedActiveServiceKernel(
  store,
  serviceKey,
  snapshotPath,
) {
  if (!activeServiceKernelPersistenceEnabled) return { kernel: null, persistenceReason: 'disabled' }
  if (!fs.existsSync(snapshotPath)) return { kernel: null, persistenceReason: 'not_found', snapshotPath }
  const startedAt = performance.now()
  try {
    const snapshotStat = fs.statSync(snapshotPath)
    if (!snapshotStat.isFile()) throw new Error('Compact-kernel snapshot is not a regular file.')
    if (
      activeServiceKernelMaxSnapshotBytes > 0
      && snapshotStat.size > activeServiceKernelMaxSnapshotBytes
    ) {
      throw new Error(
        `Compact-kernel snapshot exceeds the ${Math.floor(activeServiceKernelMaxSnapshotBytes / 1024 / 1024)} MiB serialized-size guard.`,
      )
    }
    const bytes = fs.readFileSync(snapshotPath)
    const { metadata: envelope, arrays } = decodeRoutingSnapshot(bytes)
    const persisted = envelope?.kernel
    if (
      envelope?.schemaVersion !== activeServiceKernelSchemaVersion
      || persisted?.schemaVersion !== activeServiceKernelSchemaVersion
      || persisted?.serviceKey !== serviceKey
      || persisted?.sourceArtifactIdentity !== store.sourceArtifactIdentity
      || persisted?.accessPolicyIdentity !== nationalRoutingAccessPolicyIdentity
      || persisted?.transferProjectionVersion !== activeServiceTransferProjectionVersion
      || persisted?.transferProjectionVerified !== true
    ) throw new Error('Compact-kernel snapshot identity does not match the active routing context.')
    for (const key of activeServiceKernelTypedArrayKeys) {
      if (!ArrayBuffer.isView(arrays[key])) throw new Error(`Compact-kernel snapshot is missing ${key}.`)
      persisted[key] = arrays[key]
    }
    for (const key of activeServiceKernelDictionaryKeys) {
      if (!Array.isArray(persisted[key])) throw new Error(`Compact-kernel snapshot is missing ${key}.`)
    }
    if (
      (activeServiceKernelMaxSegments > 0
        && persisted.activeSegmentCount > activeServiceKernelMaxSegments)
      || persisted.departureSeconds.length !== persisted.activeSegmentCount
      || persisted.arrivalSeconds.length !== persisted.activeSegmentCount
      || persisted.canBoard.length !== persisted.activeSegmentCount
      || persisted.canAlight.length !== persisted.activeSegmentCount
      || persisted.tripStart.length !== persisted.tripIds.length + 1
      || persisted.transferDuration.length !== persisted.transferTo.length
      || persisted.sameStopTransferMinimum.length !== persisted.stopIds.length
    ) throw new Error('Compact-kernel snapshot dimensions are invalid.')
    assertCompactCsrSnapshot(
      persisted.transferOffset,
      persisted.transferTo,
      persisted.stopIds.length,
      persisted.stopIds.length,
      'transfer CSR',
    )
    const kernel = {
      ...persisted,
      serviceKey,
      sourceStorageIdentity: store.sourceStorageIdentity,
      stopIndex: new Map(persisted.stopIds.map((stopId, index) => [stopId, index])),
    }
    const bytesEstimate = activeServiceKernelByteEstimate(kernel)
    if (
      activeServiceKernelMaxEstimatedBytes > 0
      && bytesEstimate.estimatedBytes > activeServiceKernelMaxEstimatedBytes
    ) {
      throw new Error('Compact-kernel snapshot exceeds the configured memory guard.')
    }
    Object.assign(kernel, bytesEstimate)
    const snapshotRetention = pruneActiveServiceKernelSnapshotCache(
      store.storePath,
      snapshotPath,
    )
    return {
      kernel,
      persisted: true,
      persistenceState: 'loaded',
      snapshotPath,
      snapshotBytes: bytes.byteLength,
      snapshotLoadMs: Number((performance.now() - startedAt).toFixed(3)),
      snapshotRetention,
    }
  } catch (error) {
    return {
      kernel: null,
      persisted: false,
      persistenceState: 'read_error',
      persistenceError: error instanceof Error ? error.message : String(error),
      snapshotPath,
      snapshotLoadMs: Number((performance.now() - startedAt).toFixed(3)),
    }
  }
}

function prepareActiveServiceKernel(store, services, serviceKey) {
  if (store.activeServiceKernel?.serviceKey === serviceKey) return store.activeServiceKernelStatus
  const skipped = (reason, detail, extra = {}) => {
    store.activeServiceKernel = null
    store.activeServiceKernelStatus = {
      ready: false,
      reason,
      detail,
      serviceKey,
      serviceCalendarKey: store.activeServiceCalendarKey,
      maxSegments: activeServiceKernelMaxSegments || null,
      maxEstimatedBytes: activeServiceKernelMaxEstimatedBytes || null,
      ...extra,
    }
    return store.activeServiceKernelStatus
  }
  const sourcePreflight = activeServiceKernelSourcePreflight(store)
  if (!sourcePreflight.eligible) {
    return skipped(sourcePreflight.reason, sourcePreflight.detail, {
      sourceConnections: sourcePreflight.sourceConnections,
      maxSourceConnections: sourcePreflight.maxSourceConnections,
    })
  }
  if (!services?.size) return skipped('no_active_services', 'No active service is available for this routing context.')

  const startedAt = performance.now()
  const memoryBefore = process.memoryUsage()
  const snapshotPath = activeServiceKernelSnapshotPath(store, serviceKey)
  const persistedKernel = loadPersistedActiveServiceKernel(store, serviceKey, snapshotPath)
  if (persistedKernel.kernel) {
    const kernel = persistedKernel.kernel
    Object.assign(kernel, {
      compileMs: 0,
      buildMs: 0,
      memoryDelta: null,
    })
    let nativeTimetableKernel
    try {
      nativeTimetableKernel = preloadNativeTimetableKernel(kernel)
    } catch (error) {
      return skipped(
        'native_timetable_kernel_error',
        error instanceof Error ? error.message : String(error),
      )
    }
    kernel.buildMs = Number((performance.now() - startedAt).toFixed(3))
    const memoryAfter = process.memoryUsage()
    kernel.memoryDelta = {
      rssBytes: memoryAfter.rss - memoryBefore.rss,
      heapUsedBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      externalBytes: memoryAfter.external - memoryBefore.external,
      arrayBufferBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
    }
    store.activeServiceKernel = kernel
    store.activeServiceKernelStatus = {
      ready: true,
      reason: 'ready',
      schemaVersion: kernel.schemaVersion,
      sourceStorageIdentity: kernel.sourceStorageIdentity,
      accessPolicyIdentity: nationalRoutingAccessPolicyIdentity,
      serviceKey,
      serviceCalendarKey: store.activeServiceCalendarKey,
      activeServices: services.size,
      activeSegments: kernel.activeSegmentCount,
      trips: kernel.tripIds.length,
      stops: kernel.stopIds.length,
      runs: kernel.runCount,
      transfers: kernel.transferCount,
      engine: 'rust_exact_connection_scan',
      heuristicMode: 'none',
      transferProjectionVersion: kernel.transferProjectionVersion,
      transferProjectionVerified: kernel.transferProjectionVerified,
      sourceExpandedTransferEdges: kernel.sourceExpandedTransferEdges,
      excludedNonServiceTransferEdges: kernel.excludedNonServiceTransferEdges,
      excludedNonServiceStationMembers: kernel.excludedNonServiceStationMembers,
      sourceTypedArrayBytes: kernel.sourceTypedArrayBytes,
      nativeIndexBytes: kernel.nativeIndexBytes,
      nativeWorkspaceBytes: kernel.nativeWorkspaceBytes,
      typedArrayBytes: kernel.typedArrayBytes,
      estimatedBytes: kernel.estimatedBytes,
      nativeMemoryBudget: {
        limitBytes: activeServiceKernelMaxEstimatedBytes || null,
        usedBytes: kernel.estimatedBytes,
        remainingBytes: activeServiceKernelMaxEstimatedBytes > 0
          ? activeServiceKernelMaxEstimatedBytes - kernel.estimatedBytes
          : null,
      },
      compileMs: 0,
      buildMs: kernel.buildMs,
      memoryDelta: kernel.memoryDelta,
      nativeTimetableKernel,
      ...persistedKernel,
      kernel: undefined,
    }
    rememberActiveServiceKernelContext(store)
    return store.activeServiceKernelStatus
  }
  // A persisted timetable snapshot does not need the coordinate-access object
  // graph. Only the slower SQLite rebuild path consumes expanded transfers,
  // station membership, and stop access roles.
  ensureNationalStoreAccessMaterialization(store)
  let builder = null
  try {
    builder = new DatabaseSync(store.storePath, { readOnly: true })
    builder.exec('PRAGMA mmap_size=0; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; CREATE TEMP TABLE active_kernel_services(service_id TEXT PRIMARY KEY) WITHOUT ROWID;')
    const insertService = builder.prepare('INSERT INTO active_kernel_services VALUES(?)')
    runTemporaryTransaction(builder, () => { for (const serviceId of services) insertService.run(serviceId) })
    const activeSegmentCount = Number(builder.prepare(`
      SELECT COUNT(*) AS count
      FROM connections c JOIN active_kernel_services a ON a.service_id=c.service_id
    `).get().count)
    if (
      activeServiceKernelMaxSegments > 0
      && activeSegmentCount > activeServiceKernelMaxSegments
    ) {
      return skipped(
        'active_segment_guard',
        `The ${activeSegmentCount.toLocaleString()}-segment service slice exceeds the ${activeServiceKernelMaxSegments.toLocaleString()} compact-kernel guard.`,
        { activeSegments: activeSegmentCount, sourceConnections: store.connectionCount },
      )
    }
    if (!activeSegmentCount) return skipped('no_active_segments', 'The active services contain no routable connections.')
    const preliminaryEstimatedBytes = activeSegmentCount * 96
      + store.stopRecords.size * 256
    if (
      activeServiceKernelMaxEstimatedBytes > 0
      && preliminaryEstimatedBytes > activeServiceKernelMaxEstimatedBytes
    ) {
      return skipped(
        'memory_estimate_guard',
        `The preliminary ${Math.ceil(preliminaryEstimatedBytes / 1024 / 1024)} MiB estimate exceeds the ${Math.floor(activeServiceKernelMaxEstimatedBytes / 1024 / 1024)} MiB compact-kernel guard.`,
        { activeSegments: activeSegmentCount, estimatedBytes: preliminaryEstimatedBytes },
      )
    }

    const stopIds = [...store.stopRecords.keys()]
    const stopIndex = new Map(stopIds.map((stopId, index) => [stopId, index]))
    const ensureStop = (stopId) => {
      let index = stopIndex.get(stopId)
      if (index !== undefined) return index
      index = stopIds.length
      stopIds.push(stopId)
      stopIndex.set(stopId, index)
      return index
    }
    const departureSeconds = new Uint32Array(activeSegmentCount)
    const arrivalSeconds = new Uint32Array(activeSegmentCount)
    const fromStop = new Uint32Array(activeSegmentCount)
    const toStop = new Uint32Array(activeSegmentCount)
    const sequence = new Uint32Array(activeSegmentCount)
    const segmentTrip = new Uint32Array(activeSegmentCount)
    const segmentRun = new Uint32Array(activeSegmentCount)
    const continuityBreak = new Uint8Array(activeSegmentCount)
    const canBoard = new Uint8Array(activeSegmentCount)
    const canAlight = new Uint8Array(activeSegmentCount)
    const tripStarts = []
    const tripIds = []
    const routeIds = []
    const serviceIds = []
    const directionIds = []
    let segment = 0
    let trip = -1
    let run = -1
    let previous = null
    const permissionJoin = store.hasConnectionPermissions
      ? 'LEFT JOIN connection_permissions permission ON permission.trip_id=c.trip_id AND permission.stop_sequence=c.stop_sequence'
      : ''
    const canBoardExpression = store.hasConnectionPermissions ? 'COALESCE(permission.can_board, 1)' : '1'
    const canAlightExpression = store.hasConnectionPermissions ? 'COALESCE(permission.can_alight, 1)' : '1'
    const tripRows = builder.prepare(`
      SELECT c.departure, c.arrival, c.trip_id, c.route_id, c.service_id, c.direction_id,
             c.from_stop_id, c.to_stop_id, c.stop_sequence,
             ${canBoardExpression} AS can_board,
             ${canAlightExpression} AS can_alight
      FROM connections c JOIN active_kernel_services a ON a.service_id=c.service_id
      ${permissionJoin}
      ORDER BY c.trip_id, c.stop_sequence
    `)
    for (const row of tripRows.iterate()) {
      const newTrip = !previous || row.trip_id !== previous.trip_id
      if (newTrip) {
        trip += 1
        run += 1
        tripStarts.push(segment)
        tripIds.push(row.trip_id)
        routeIds.push(row.route_id)
        serviceIds.push(row.service_id)
        directionIds.push(row.direction_id ?? '')
      }
      const unsafeGap = !newTrip
        && previous.to_stop_id !== row.from_stop_id
        && !(
          numeric(row.stop_sequence) - numeric(previous.stop_sequence) > 1
          && row.route_id === previous.route_id
          && row.service_id === previous.service_id
          && numeric(row.departure, -1) >= numeric(previous.arrival, Number.POSITIVE_INFINITY)
        )
      if (unsafeGap) run += 1
      departureSeconds[segment] = numeric(row.departure)
      arrivalSeconds[segment] = numeric(row.arrival)
      fromStop[segment] = ensureStop(row.from_stop_id)
      toStop[segment] = ensureStop(row.to_stop_id)
      sequence[segment] = numeric(row.stop_sequence)
      segmentTrip[segment] = trip
      segmentRun[segment] = run
      continuityBreak[segment] = unsafeGap ? 1 : 0
      canBoard[segment] = numeric(row.can_board, 1) === 1 ? 1 : 0
      canAlight[segment] = numeric(row.can_alight, 1) === 1 ? 1 : 0
      previous = row
      segment += 1
    }
    tripStarts.push(segment)
    if (segment !== activeSegmentCount) throw new Error(`Compact kernel read ${segment} of ${activeSegmentCount} active segments.`)
    const tripStart = Uint32Array.from(tripStarts)
    const runCount = run + 1
    const stopCount = stopIds.length
    const departureCounts = new Uint32Array(stopCount)
    for (let index = 0; index < activeSegmentCount; index += 1) {
      if (canBoard[index] === 1) departureCounts[fromStop[index]] += 1
    }
    const departureOffset = new Uint32Array(stopCount + 1)
    for (let index = 0; index < stopCount; index += 1) departureOffset[index + 1] = departureOffset[index] + departureCounts[index]
    const departureCursor = departureOffset.slice(0, stopCount)
    const departureOrder = new Uint32Array(departureOffset[stopCount])
    // The compact kernel already has each active segment's origin, departure,
    // and boarding permission in typed arrays. Build the same per-stop,
    // departure-ordered view in memory instead of recreating the large SQLite
    // covering index that the published runtime layout intentionally omits.
    for (let index = 0; index < activeSegmentCount; index += 1) {
      if (canBoard[index] !== 1) continue
      const stop = fromStop[index]
      departureOrder[departureCursor[stop]] = index
      departureCursor[stop] += 1
    }
    for (let stop = 0; stop < stopCount; stop += 1) {
      const start = departureOffset[stop]
      const end = departureOffset[stop + 1]
      departureOrder.subarray(start, end).sort((left, right) => (
        departureSeconds[left] - departureSeconds[right] || left - right
      ))
    }

    const routableTransferStopMask = new Uint8Array(stopCount)
    for (let stop = 0; stop < stopCount; stop += 1) {
      if (stopParticipatesInScheduledService(store, stopIds[stop])) {
        routableTransferStopMask[stop] = 1
      }
    }
    for (let connection = 0; connection < activeSegmentCount; connection += 1) {
      routableTransferStopMask[fromStop[connection]] = 1
      routableTransferStopMask[toStop[connection]] = 1
    }
    const retainsTransferStop = (stopId) => {
      const stop = stopIndex.get(stopId)
      return stop !== undefined && routableTransferStopMask[stop] === 1
    }
    const transferMaps = new Map()
    let sourceExpandedTransferEdges = 0
    let excludedNonServiceTransferEdges = 0
    let excludedNonServiceStationMembers = 0
    const addTransferTo = (fromId, toId, duration) => {
      if (fromId === toId) return
      const from = stopIndex.get(fromId)
      const to = stopIndex.get(toId)
      if (from === undefined || to === undefined) return
      const targets = transferMaps.get(from) ?? new Map()
      targets.set(
        to,
        Math.min(
          targets.get(to) ?? Number.POSITIVE_INFINITY,
          Math.max(0, numeric(duration, 0)),
        ),
      )
      transferMaps.set(from, targets)
    }
    for (const [fromId, transfers] of store.transfers) {
      for (const transfer of transfers) {
        if (isForbiddenTransfer(store, fromId, transfer.to_stop_id)) continue
        sourceExpandedTransferEdges += 1
        if (!retainsTransferStop(transfer.to_stop_id)) {
          excludedNonServiceTransferEdges += 1
          continue
        }
        addTransferTo(
          fromId,
          transfer.to_stop_id,
          transfer.min_transfer_time,
        )
      }
    }
    for (const rawMembers of store.stationMembers.values()) {
      const uniqueMembers = [...new Set(rawMembers)].filter((stopId) => stopIndex.has(stopId))
      const members = uniqueMembers.filter(retainsTransferStop)
      excludedNonServiceStationMembers += uniqueMembers.length - members.length
      for (const fromId of members) {
        for (const toId of members) {
          // A published rule takes precedence over the station walking fallback.
          if (!isForbiddenTransfer(store, fromId, toId)
            && !transferMaps.get(stopIndex.get(fromId))?.has(stopIndex.get(toId))) {
            addTransferTo(fromId, toId, stationFallbackSeconds(store.stopRecords.get(fromId), store.stopRecords.get(toId), walkingSpeedKph))
          }
        }
      }
    }
    const transferCounts = new Uint32Array(stopCount)
    let transferCount = 0
    for (const [from, targets] of transferMaps) {
      transferCounts[from] = targets.size
      transferCount += targets.size
    }
    const transferOffset = new Uint32Array(stopCount + 1)
    for (let stop = 0; stop < stopCount; stop += 1) {
      transferOffset[stop + 1] = transferOffset[stop] + transferCounts[stop]
    }
    const transferTo = new Uint32Array(transferCount)
    const transferDuration = new Uint32Array(transferCount)
    const transferCursor = transferOffset.slice(0, stopCount)
    for (const [from, targets] of transferMaps) {
      for (const [to, duration] of targets) {
        const index = transferCursor[from]++
        transferTo[index] = to
        transferDuration[index] = duration
      }
    }
    transferMaps.clear()
    const forbiddenSameStop = new Uint8Array(stopCount)
    const sameStopTransferMinimum = new Uint32Array(stopCount)
    for (let stop = 0; stop < stopCount; stop += 1) {
      if (isForbiddenTransfer(store, stopIds[stop], stopIds[stop])) forbiddenSameStop[stop] = 1
      const rule = store.transfers.get(stopIds[stop])?.find((transfer) => transfer.to_stop_id === stopIds[stop])
      if (rule) sameStopTransferMinimum[stop] = transferDurationSeconds(rule)
    }

    try { builder.exec('PRAGMA shrink_memory') } catch {}
    try { builder.close() } catch {}
    builder = null
    const compileMs = Number((performance.now() - startedAt).toFixed(3))
    const kernel = {
      schemaVersion: activeServiceKernelSchemaVersion,
      serviceKey,
      sourceStorageIdentity: store.sourceStorageIdentity,
      sourceArtifactIdentity: store.sourceArtifactIdentity,
      accessPolicyIdentity: nationalRoutingAccessPolicyIdentity,
      stopIds,
      stopIndex,
      departureSeconds,
      arrivalSeconds,
      fromStop,
      toStop,
      sequence,
      segmentTrip,
      segmentRun,
      continuityBreak,
      canBoard,
      canAlight,
      tripStart,
      tripIds,
      routeIds,
      serviceIds,
      directionIds,
      departureOffset,
      departureOrder,
      transferOffset,
      transferTo,
      transferDuration,
      forbiddenSameStop,
      sameStopTransferMinimum,
      transferProjectionVersion: activeServiceTransferProjectionVersion,
      transferProjectionVerified: true,
      sourceExpandedTransferEdges,
      excludedNonServiceTransferEdges,
      excludedNonServiceStationMembers,
      runCount,
      activeSegmentCount,
      transferCount,
      compileMs,
      buildMs: 0,
      memoryDelta: null,
    }

    const nativeTimetableKernel = preloadNativeTimetableKernel(kernel)
    const persistence = persistActiveServiceKernel(kernel, snapshotPath, store.storePath)
    const memoryAfter = process.memoryUsage()
    const buildMs = Number((performance.now() - startedAt).toFixed(3))
    kernel.buildMs = buildMs
    kernel.memoryDelta = {
      rssBytes: memoryAfter.rss - memoryBefore.rss,
      heapUsedBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      externalBytes: memoryAfter.external - memoryBefore.external,
      arrayBufferBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
    }
    store.activeServiceKernel = kernel
    store.activeServiceKernelStatus = {
      ready: true,
      reason: 'ready',
      schemaVersion: kernel.schemaVersion,
      sourceStorageIdentity: kernel.sourceStorageIdentity,
      accessPolicyIdentity: nationalRoutingAccessPolicyIdentity,
      serviceKey,
      serviceCalendarKey: store.activeServiceCalendarKey,
      activeServices: services.size,
      activeSegments: activeSegmentCount,
      trips: tripIds.length,
      stops: stopCount,
      runs: runCount,
      transfers: transferCount,
      engine: 'rust_exact_connection_scan',
      heuristicMode: 'none',
      transferProjectionVersion: kernel.transferProjectionVersion,
      transferProjectionVerified: kernel.transferProjectionVerified,
      sourceExpandedTransferEdges,
      excludedNonServiceTransferEdges,
      excludedNonServiceStationMembers,
      sourceTypedArrayBytes: kernel.sourceTypedArrayBytes,
      nativeIndexBytes: kernel.nativeIndexBytes,
      nativeWorkspaceBytes: kernel.nativeWorkspaceBytes,
      typedArrayBytes: kernel.typedArrayBytes,
      estimatedBytes: kernel.estimatedBytes,
      nativeMemoryBudget: {
        limitBytes: activeServiceKernelMaxEstimatedBytes || null,
        usedBytes: kernel.estimatedBytes,
        remainingBytes: activeServiceKernelMaxEstimatedBytes > 0
          ? activeServiceKernelMaxEstimatedBytes - kernel.estimatedBytes
          : null,
      },
      compileMs,
      buildMs,
      memoryDelta: kernel.memoryDelta,
      nativeTimetableKernel,
      ...(persistedKernel.persistenceState === 'read_error' ? {
        snapshotReadState: persistedKernel.persistenceState,
        snapshotReadError: persistedKernel.persistenceError,
      } : {}),
      ...persistence,
    }
    rememberActiveServiceKernelContext(store)
    return store.activeServiceKernelStatus
  } catch (error) {
    return skipped('build_error', error instanceof Error ? error.message : String(error), {
      buildMs: Number((performance.now() - startedAt).toFixed(3)),
    })
  } finally {
    if (builder) {
      try { builder.close() } catch {}
    }
  }
}

function currentActiveServiceKernel(store) {
  return (
    store.activeServiceKernel?.serviceKey === store.activeServiceDate
    && store.activeServiceKernel?.sourceStorageIdentity === store.sourceStorageIdentity
  ) ? store.activeServiceKernel : null
}

function ensureActiveServiceKernel(store, services) {
  const retained = currentActiveServiceKernel(store)
  if (retained) return { kernel: retained, preparationMs: 0, status: store.activeServiceKernelStatus }
  const startedAt = performance.now()
  const status = prepareActiveServiceKernel(store, services, store.activeServiceDate)
  return {
    kernel: status?.ready === true ? currentActiveServiceKernel(store) : null,
    preparationMs: Number((performance.now() - startedAt).toFixed(3)),
    status,
  }
}

function validateMaximumTransfers(value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 31)) {
    throw new Error('maxTransfers must be an integer between 0 and 31; omit it for no additional limit.')
  }
}

function allowsTerminalTransfers(accessStops) {
  // Fused candidates retain their native path handle and use 'osm-rust';
  // normalized candidates use 'osm'. Both already include the complete walk.
  return accessStops.every((stop) => !stop?.nativeStreetPath && stop?.walkSource !== 'osm')
}

function activeServiceKernelAccessSeeds(kernel, accessStops) {
  const seeds = []
  for (let candidateIndex = 0; candidateIndex < accessStops.length; candidateIndex += 1) {
    const accessStop = accessStops[candidateIndex]
    const stop = kernel.stopIndex.get(accessStop.stop_id)
    if (stop === undefined) continue
    seeds.push({ stop, walkSeconds: accessWalkSeconds(accessStop), candidateIndex })
  }
  return seeds
}

function normalizeRealtimeSnapshotForRouting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const tripUpdates = Array.isArray(value.tripUpdates) ? value.tripUpdates : []
  if (!tripUpdates.length) return null
  return {
    sourceUrl: String(value.sourceUrl ?? '').trim() || undefined,
    sourceUrls: Array.isArray(value.sourceUrls)
      ? value.sourceUrls.map((sourceUrl) => String(sourceUrl ?? '').trim()).filter(Boolean)
      : [],
    fetchedAt: String(value.fetchedAt ?? '').trim() || undefined,
    feedTimestamp: numeric(value.feedTimestamp, undefined),
    tripUpdates,
    counts: value.counts && typeof value.counts === 'object' ? value.counts : undefined,
  }
}

function realtimeTripLookup(kernel) {
  const cached = realtimeTripLookupCache.get(kernel)
  if (cached) return cached
  const exact = new Map()
  const suffix = new Map()
  for (let index = 0; index < kernel.tripIds.length; index += 1) {
    const tripId = String(kernel.tripIds[index] ?? '')
    exact.set(tripId, index)
    const baseId = tripId.includes('\u001f') ? tripId.split('\u001f').at(-1) : tripId
    const matches = suffix.get(baseId) ?? []
    matches.push(index)
    suffix.set(baseId, matches)
  }
  const lookup = { exact, suffix }
  realtimeTripLookupCache.set(kernel, lookup)
  return lookup
}

function resolveRealtimeTripIndex(kernel, tripId) {
  const normalizedTripId = String(tripId ?? '').trim()
  if (!normalizedTripId) return undefined
  const lookup = realtimeTripLookup(kernel)
  const exact = lookup.exact.get(normalizedTripId)
  if (exact !== undefined) return exact
  const matches = lookup.suffix.get(normalizedTripId)
  return matches?.length === 1 ? matches[0] : undefined
}

function realtimeTripRelationship(value) {
  if (value === undefined || value === null || value === '') return 'SCHEDULED'
  if (typeof value === 'number') {
    return { 0: 'SCHEDULED', 1: 'ADDED', 2: 'UNSCHEDULED', 3: 'CANCELED', 5: 'REPLACEMENT', 6: 'DUPLICATED', 7: 'DELETED' }[value] ?? 'UNKNOWN'
  }
  return String(value).trim().toUpperCase()
}

function realtimeServiceDateToken(serviceDate) {
  return String(serviceDate ?? '').replaceAll('-', '')
}

function realtimeTimezoneFormatter(timezone) {
  const key = String(timezone || 'UTC')
  const cached = realtimeTimezoneFormatterCache.get(key)
  if (cached) return cached
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  }
  realtimeTimezoneFormatterCache.set(key, formatter)
  return formatter
}

function realtimeEpochToServiceSeconds(epochSeconds, serviceDate, timezone) {
  const epoch = numeric(epochSeconds, Number.NaN)
  if (!Number.isFinite(epoch)) return undefined
  const parts = Object.fromEntries(
    realtimeTimezoneFormatter(timezone).formatToParts(new Date(epoch * 1000))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  const dateParts = String(serviceDate ?? '').split('-').map(Number)
  if (dateParts.length !== 3 || dateParts.some((part) => !Number.isInteger(part))) return undefined
  const dayOffset = Math.round(
    (Date.UTC(parts.year, parts.month - 1, parts.day) - Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]))
    / 86_400_000,
  )
  return dayOffset * 86_400 + parts.hour * 3_600 + parts.minute * 60 + parts.second
}

function realtimeStaticTripStopTimes(store, tripId) {
  if (store.realtimeTripStopTimesLookup) {
    return store.realtimeTripStopTimesLookup.all(tripId)
  }
  const connections = store.realtimeTripConnectionsLookup.all(tripId)
  if (!connections.length) return []
  const stopTimes = [{
    stop_sequence: connections[0].stop_sequence,
    stop_id: connections[0].from_stop_id,
    arrival: connections[0].departure,
    departure: connections[0].departure,
    can_board: 1,
    can_alight: 1,
  }]
  for (let index = 0; index < connections.length; index += 1) {
    const connection = connections[index]
    const next = connections[index + 1]
    stopTimes.push({
      stop_sequence: next?.stop_sequence ?? Number(connection.stop_sequence) + 1,
      stop_id: connection.to_stop_id,
      arrival: connection.arrival,
      departure: next && next.from_stop_id === connection.to_stop_id
        ? next.departure
        : connection.arrival,
      can_board: 1,
      can_alight: 1,
    })
  }
  return stopTimes
}

function realtimeOverlaySeeds(kernel, accessStops, overlay) {
  const seeds = activeServiceKernelAccessSeeds(kernel, accessStops)
  if (!overlay?.overlayStopIndexById?.size) return seeds
  const augmented = [...seeds]
  for (const seed of seeds) {
    const stopId = kernel.stopIds[seed.stop]
    const localStop = overlay.overlayStopIndexById.get(stopId)
    if (localStop === undefined) continue
    augmented.push({
      stop: kernel.stopIds.length + localStop,
      walkSeconds: seed.walkSeconds,
      candidateIndex: seed.candidateIndex,
    })
  }
  return augmented
}

function realtimeOverlayDestinationSeeds(kernel, destinationStops, overlay) {
  return realtimeOverlaySeeds(kernel, destinationStops, overlay)
}

function buildRealtimeTimetableOverlay(store, kernel, snapshot, context) {
  if (!snapshot?.tripUpdates?.length) return null
  const serviceDate = context.serviceDateResolution?.resolvedServiceDate
  const serviceDateToken = realtimeServiceDateToken(serviceDate)
  const timezone = store.agencyTimezones[0] || 'UTC'
  const originStopIds = new Set(context.originStops.map((stop) => String(stop.stop_id)))
  const destinationStopIds = new Set(context.destinationStops.map((stop) => String(stop.stop_id)))
  const candidateStopIds = new Set([...originStopIds, ...destinationStopIds])
  const diagnostics = {
    feedTimestamp: snapshot.feedTimestamp,
    fetchedAt: snapshot.fetchedAt,
    feedTripUpdates: snapshot.tripUpdates.length,
    matchedTripUpdates: 0,
    appliedTrips: 0,
    replacedTrips: 0,
    canceledTrips: 0,
    unsupportedTrips: 0,
    dateMismatches: 0,
    unmatchedTrips: 0,
    invalidTrips: 0,
    prunedTrips: 0,
    stale: Number.isFinite(snapshot.feedTimestamp)
      ? Math.max(0, Date.now() / 1000 - snapshot.feedTimestamp) > 180
      : undefined,
  }
  if (diagnostics.stale === true) {
    return {
      ready: false,
      status: 'stale_fallback',
      diagnostics: {
        ...diagnostics,
        fallbackReason: 'feed_timestamp_stale',
      },
      excludedTrips: [],
      trips: [],
    }
  }
  const excludedTripIndices = new Set()
  const candidates = []
  const sortedUpdates = [...snapshot.tripUpdates]
    .sort((left, right) => {
      const leftMatched = resolveRealtimeTripIndex(kernel, left?.tripId) !== undefined
      const rightMatched = resolveRealtimeTripIndex(kernel, right?.tripId) !== undefined
      return Number(rightMatched) - Number(leftMatched)
        || String(left.tripId ?? '').localeCompare(String(right.tripId ?? ''))
    })
    .slice(0, Math.max(realtimeRoutingMaxTripUpdates * 4, realtimeRoutingMaxTripUpdates))
  for (const update of sortedUpdates) {
    const tripIndex = resolveRealtimeTripIndex(kernel, update?.tripId)
    if (tripIndex === undefined) {
      diagnostics.unmatchedTrips += 1
      continue
    }
    diagnostics.matchedTripUpdates += 1
    const relationship = realtimeTripRelationship(update?.scheduleRelationship)
    if (update?.startDate && String(update.startDate) !== serviceDateToken) {
      diagnostics.dateMismatches += 1
      continue
    }
    if (relationship === 'CANCELED' || relationship === 'DELETED') {
      excludedTripIndices.add(tripIndex)
      diagnostics.canceledTrips += 1
      continue
    }
    if (relationship !== 'SCHEDULED') {
      diagnostics.unsupportedTrips += 1
      continue
    }
    const staticTripId = kernel.tripIds[tripIndex]
    const rows = realtimeStaticTripStopTimes(store, staticTripId)
    if (rows.length < 2) {
      diagnostics.invalidTrips += 1
      continue
    }
    const timing = resolveRealtimeTripTimes(rows, update,
      epoch => realtimeEpochToServiceSeconds(epoch, serviceDate, timezone))
    if (timing.status !== 'ready') {
      diagnostics[timing.status === 'unsupported' ? 'unsupportedTrips' : 'invalidTrips'] += 1
      continue
    }
    const stopTimes = timing.stopTimes
    const intersectsCandidate = stopTimes.some(stop => candidateStopIds.has(stop.stopId))
    candidates.push({
      tripIndex,
      tripId: staticTripId,
      feedTripId: String(update.tripId),
      routeId: kernel.routeIds[tripIndex],
      serviceId: kernel.serviceIds[tripIndex],
      directionId: kernel.directionIds[tripIndex],
      stopTimes,
      intersectsCandidate,
    })
  }
  candidates.sort((left, right) => (
    Number(right.intersectsCandidate) - Number(left.intersectsCandidate)
    || left.stopTimes[0].departure - right.stopTimes[0].departure
    || left.tripId.localeCompare(right.tripId)
  ))
  const selected = candidates.slice(0, realtimeRoutingMaxTripUpdates)
  diagnostics.prunedTrips = Math.max(0, candidates.length - selected.length)
  if (!selected.length && !excludedTripIndices.size) {
    return {
      ready: false,
      status: 'no_matches',
      diagnostics,
      excludedTrips: [],
      trips: [],
    }
  }

  const overlayStopIds = []
  const overlayStopIndexById = new Map()
  for (const trip of selected) {
    for (const stopTime of trip.stopTimes) {
      if (overlayStopIndexById.has(stopTime.stopId)) continue
      if (overlayStopIds.length >= realtimeRoutingMaxStops) {
        diagnostics.prunedTrips += 1
        break
      }
      overlayStopIndexById.set(stopTime.stopId, overlayStopIds.length)
      overlayStopIds.push(stopTime.stopId)
    }
  }
  const selectedTrips = selected.filter((trip) => trip.stopTimes.every((stopTime) => overlayStopIndexById.has(stopTime.stopId)))
  diagnostics.appliedTrips = selectedTrips.length
  for (const trip of selectedTrips) excludedTripIndices.add(trip.tripIndex)
  const directionOffsets = [0]
  const directionStops = []
  const directionStopOffsetsSeconds = []
  const directionArrivalOffsetsSeconds = []
  const directionCanBoard = []
  const directionCanAlight = []
  const serviceStartSeconds = []
  const serviceEndSeconds = []
  const serviceHeadwaySeconds = []
  const realtimeTrips = []
  for (const trip of selectedTrips) {
    const firstDeparture = trip.stopTimes[0].departure
    const directionStart = directionStops.length
    for (let index = 0; index < trip.stopTimes.length; index += 1) {
      const stopTime = trip.stopTimes[index]
      directionStops.push(overlayStopIndexById.get(stopTime.stopId))
      directionCanBoard.push(stopTime.canBoard !== false ? 1 : 0)
      directionCanAlight.push(stopTime.canAlight !== false ? 1 : 0)
      const eventTime = index + 1 < trip.stopTimes.length ? stopTime.departure : stopTime.arrival
      directionStopOffsetsSeconds.push(eventTime - firstDeparture)
      directionArrivalOffsetsSeconds.push(index === 0 ? 0 : stopTime.arrival - firstDeparture)
    }
    if (directionStopOffsetsSeconds.slice(directionStart).some((offset, index, offsets) => !Number.isFinite(offset) || offset < 0 || (index > 0 && offset < offsets[index - 1]))) {
      diagnostics.invalidTrips += 1
      directionStops.length = directionStart
      directionStopOffsetsSeconds.length = directionStart
      directionArrivalOffsetsSeconds.length = directionStart
      directionCanBoard.length = directionStart
      directionCanAlight.length = directionStart
      excludedTripIndices.delete(trip.tripIndex)
      continue
    }
    directionOffsets.push(directionStops.length)
    serviceStartSeconds.push(firstDeparture)
    serviceEndSeconds.push(firstDeparture)
    serviceHeadwaySeconds.push(1)
    realtimeTrips.push({
      tripId: trip.tripId,
      feedTripId: trip.feedTripId,
      routeId: trip.routeId,
      serviceId: trip.serviceId,
      directionId: trip.directionId,
      connections: trip.stopTimes.slice(0, -1).map((from, index) => {
        const to = trip.stopTimes[index + 1]
        return {
          departure: from.departure,
          arrival: to.arrival,
          trip_id: trip.tripId,
          route_id: trip.routeId,
          service_id: trip.serviceId,
          direction_id: trip.directionId,
          from_stop_id: from.stopId,
          to_stop_id: to.stopId,
          stop_sequence: from.sequence,
        }
      }),
    })
  }
  diagnostics.appliedTrips = realtimeTrips.length
  diagnostics.replacedTrips = realtimeTrips.length
  const overlayStopBaseStopIds = overlayStopIds.map((stopId) => kernel.stopIndex.get(stopId))
  const outgoing = Array.from(
    { length: kernel.stopIds.length + overlayStopIds.length },
    () => new Map(),
  )
  for (let localStop = 0; localStop < overlayStopIds.length; localStop += 1) {
    const baseStop = overlayStopBaseStopIds[localStop]
    if (baseStop === undefined) continue
    const combinedStop = kernel.stopIds.length + localStop
    retainOverlayTransfer(outgoing, combinedStop, baseStop, 0)
    retainOverlayTransfer(outgoing, baseStop, combinedStop, 0)
  }
  const transfer = overlayTransferCsr(outgoing)
  const ready = realtimeTrips.length > 0 || excludedTripIndices.size > 0
  return {
    ready,
    status: realtimeTrips.length ? 'applied' : 'cancellations_only',
    diagnostics,
    excludedTrips: [...excludedTripIndices],
    trips: realtimeTrips,
    overlayStopIds,
    overlayStopBaseStopIds,
    overlayStopIndexById,
    directionOffsets,
    directionStops,
    directionStopOffsetsSeconds,
    directionArrivalOffsetsSeconds,
    directionCanBoard,
    directionCanAlight,
    serviceStartSeconds,
    serviceEndSeconds,
    serviceHeadwaySeconds,
    supplementalTransferOffsets: transfer.offsets,
    supplementalTransferTo: transfer.to,
    supplementalTransferDuration: transfer.duration,
  }
}

function activeServiceKernelArriveByRecoveryCandidates(
  kernel,
  originSeeds,
  earliest,
  deadline,
  allowPreRideTransfers,
) {
  // Allocate the complete initial-departure frontier only when the exact
  // reverse boundary cannot be reproduced by forward materialization. Ordinary
  // arrive-by queries never build or sort this list.
  const maximumOffset = deadline - earliest
  const offsets = new Float64Array(kernel.stopIds.length)
  offsets.fill(Number.POSITIVE_INFINITY)
  const touchedStops = []
  const retainOffset = (stop, offset) => {
    if (offset > maximumOffset || offset >= offsets[stop]) return
    if (!Number.isFinite(offsets[stop])) touchedStops.push(stop)
    offsets[stop] = offset
  }
  for (const seed of originSeeds) retainOffset(seed.stop, seed.walkSeconds)
  if (allowPreRideTransfers) {
    for (const seed of originSeeds) {
      if (seed.walkSeconds > maximumOffset) continue
      for (
        let edge = kernel.transferOffset[seed.stop];
        edge < kernel.transferOffset[seed.stop + 1];
        edge += 1
      ) {
        retainOffset(
          kernel.transferTo[edge],
          seed.walkSeconds + kernel.transferDuration[edge],
        )
      }
    }
  }

  const candidates = []
  for (const stop of touchedStops) {
    const offset = offsets[stop]
    let low = kernel.departureOffset[stop]
    let high = kernel.departureOffset[stop + 1]
    const minimumBoardingTime = earliest + offset
    while (low < high) {
      const middle = (low + high) >>> 1
      const segment = kernel.departureOrder[middle]
      if (kernel.departureSeconds[segment] < minimumBoardingTime) low = middle + 1
      else high = middle
    }
    for (let cursor = low; cursor < kernel.departureOffset[stop + 1]; cursor += 1) {
      const segment = kernel.departureOrder[cursor]
      const candidate = kernel.departureSeconds[segment] - offset
      if (candidate > deadline) break
      if (candidate >= earliest) candidates.push(candidate)
    }
  }
  candidates.sort((left, right) => right - left)
  return candidates.filter((candidate, index) => index === 0 || candidate !== candidates[index - 1])
}

function nativeTimetableChain(kernel, raw) {
  return raw.chainKinds.map((kind, index) => {
    const fromStop = raw.chainFromStops[index]
    const toStop = raw.chainToStops[index]
    const tripOrCandidate = raw.chainTripOrCandidate[index]
    if (kind === 3) {
      return {
        kind: 'access',
        candidateIndex: tripOrCandidate,
        arrival: raw.chainArrivals[index],
        toStopId: kernel.stopIds[toStop],
      }
    }
    if (kind === 1) {
      return {
        kind: 'transfer',
        fromStopId: kernel.stopIds[fromStop],
        toStopId: kernel.stopIds[toStop],
        arrival: raw.chainArrivals[index],
        duration: raw.chainDurations[index],
      }
    }
    return {
      kind: 'ride',
      fromStopId: kernel.stopIds[fromStop],
      toStopId: kernel.stopIds[toStop],
      kernelTripIndex: tripOrCandidate,
      tripId: kernel.tripIds[tripOrCandidate],
      boardingStopSequence: raw.chainBoardSequences[index],
      alightingStopSequence: raw.chainAlightSequences[index],
    }
  })
}

function realtimeOverlayStopId(kernel, overlay, combinedStop) {
  if (combinedStop < kernel.stopIds.length) return kernel.stopIds[combinedStop]
  const localStop = combinedStop - kernel.stopIds.length
  return overlay.overlayStopBaseStopIds?.[localStop] !== undefined
    ? kernel.stopIds[overlay.overlayStopBaseStopIds[localStop]]
    : overlay.overlayStopIds?.[localStop]
}

function nativeRealtimeOverlayChain(kernel, raw, overlay) {
  return raw.chainKinds.map((kind, index) => {
    const fromStop = raw.chainFromStops[index]
    const toStop = raw.chainToStops[index]
    const tripOrCandidate = raw.chainTripOrCandidate[index]
    if (kind === 3) {
      return {
        kind: 'access',
        candidateIndex: tripOrCandidate,
        arrival: raw.chainArrivals[index],
        toStopId: realtimeOverlayStopId(kernel, overlay, toStop),
      }
    }
    if (kind === 1) {
      return {
        kind: 'transfer',
        fromStopId: realtimeOverlayStopId(kernel, overlay, fromStop),
        toStopId: realtimeOverlayStopId(kernel, overlay, toStop),
        arrival: raw.chainArrivals[index],
        duration: raw.chainDurations[index],
      }
    }
    const overlayTripIndex = tripOrCandidate < -1 ? -tripOrCandidate - 2 : undefined
    const realtimeTrip = overlayTripIndex === undefined ? undefined : overlay.trips[overlayTripIndex]
    return {
      kind: 'ride',
      fromStopId: realtimeOverlayStopId(kernel, overlay, fromStop),
      toStopId: realtimeOverlayStopId(kernel, overlay, toStop),
      ...(overlayTripIndex === undefined
        ? {
            kernelTripIndex: tripOrCandidate,
            tripId: kernel.tripIds[tripOrCandidate],
          }
        : {
            realtimeTripIndex: overlayTripIndex,
            tripId: realtimeTrip?.tripId,
          }),
      boardingStopSequence: raw.chainBoardSequences[index],
      alightingStopSequence: raw.chainAlightSequences[index],
      ...(overlayTripIndex !== undefined
        ? {
            boardingSegmentIndex: raw.chainBoardSequences[index],
            alightingSegmentIndex: raw.chainAlightSequences[index],
          }
        : {}),
      realtimeAdjusted: overlayTripIndex !== undefined,
    }
  })
}

function realtimeTripConnectionsForStep(trip, step) {
  const connections = trip?.connections ?? []
  if (!connections.length) return []
  const first = Math.max(0, Math.floor(numeric(step.boardingSegmentIndex, 0)))
  const last = Math.min(
    connections.length - 1,
    Math.floor(numeric(step.alightingSegmentIndex, connections.length - 1)),
  )
  return last >= first ? connections.slice(first, last + 1) : []
}

function searchActiveServiceKernelNativeRealtime(
  kernel,
  originStops,
  destinationStops,
  departure,
  horizon,
  allowPreRideTransfers,
  overlay,
  maxTransfers,
) {
  const raw = routeNativeTimetableOverlayMany(kernel, {
    certifyJourney: true,
    originSeeds: realtimeOverlaySeeds(kernel, originStops, overlay),
    destinationSeedSets: [realtimeOverlayDestinationSeeds(kernel, destinationStops, overlay)],
    excludedTrips: overlay.excludedTrips,
    departure,
    horizon,
    allowPreRideTransfers,
    maxTransfers,
    allowPostRideTransfers: [allowsTerminalTransfers(destinationStops)],
    overlay: {
      stopCount: overlay.overlayStopIds?.length ?? 0,
      baseStops: overlay.overlayStopBaseStopIds.map(stop => stop ?? -1),
      directionOffsets: overlay.directionOffsets,
      directionStops: overlay.directionStops,
      directionStopOffsetsSeconds: overlay.directionStopOffsetsSeconds,
      directionArrivalOffsetsSeconds: overlay.directionArrivalOffsetsSeconds,
      serviceStartSeconds: overlay.serviceStartSeconds,
      serviceEndSeconds: overlay.serviceEndSeconds,
      serviceHeadwaySeconds: overlay.serviceHeadwaySeconds,
      supplementalTransferOffsets: overlay.supplementalTransferOffsets,
      supplementalTransferTo: overlay.supplementalTransferTo,
      supplementalTransferDuration: overlay.supplementalTransferDuration,
      directionCanBoard: overlay.directionCanBoard,
      directionCanAlight: overlay.directionCanAlight,
    },
  })
  const bestArrival = raw.bestArrivals?.reduce(
    (best, arrival) => Math.min(best, numeric(arrival, Number.POSITIVE_INFINITY)),
    Number.POSITIVE_INFINITY,
  ) ?? Number.POSITIVE_INFINITY
  const chain = nativeRealtimeOverlayChain(kernel, raw, overlay)
  const status = raw.supported !== true
    ? raw.status
    : Number.isFinite(bestArrival) ? 'ready' : 'blocked'
  const queryMs = timingMilliseconds(raw.queryMs)
  return {
    supported: raw.supported,
    status,
    reason: raw.reason,
    bestArrival: Number.isFinite(bestArrival) ? bestArrival : undefined,
    bestBoardings: chain.reduce((count, step) => count + (step.kind === 'ride' ? 1 : 0), 0),
    bestDestinationIndex: raw.bestDestinationIndex,
    chain,
    realtimeOverlay: true,
    lexicographicCertified: raw.lexicographicCertified,
    realtimeOverlayDiagnostics: overlay.diagnostics,
    overlayConnections: raw.overlayConnections,
    overlayRuns: raw.overlayRuns,
    supplementalTransferEdges: raw.supplementalTransferEdges,
    queryMs: Number(queryMs.toFixed(3)),
    scannedDepartures: raw.scannedDepartures,
    relaxedStops: raw.relaxedStops,
    expandedTripRuns: raw.expandedTripRuns,
    dominatedTripBoardings: raw.dominatedTripBoardings,
    explicitTransferChecks: raw.explicitTransferChecks,
    scalarPhases: {
      compileMs: timingMilliseconds(raw.compileMs),
      scanMs: timingMilliseconds(raw.scanMs),
      qualityMs: timingMilliseconds(raw.qualityQueryMs),
      chainMs: 0,
    },
    heuristicMode: 'none',
    nativeTimetableKernel: {
      source: 'rust_node_api_query_scoped_gtfs_rt_trip_update_overlay',
      configureMs: timingMilliseconds(raw.configureMs),
      queryMs: Number(queryMs.toFixed(3)),
      diagnostics: raw.kernelDiagnostics,
      journeyQuality: {
        certified: raw.lexicographicCertified,
        queryMs: raw.qualityQueryMs,
        bytes: raw.qualityBytes,
        reason: raw.qualityReason,
      },
    },
  }
}

function searchActiveServiceKernelNativeScalar(
  kernel,
  originStops,
  destinationStops,
  departure,
  horizon,
  allowPreRideTransfers,
  maxTransfers,
) {
  const raw = routeNativeTimetableScalar(kernel, {
    originSeeds: activeServiceKernelAccessSeeds(kernel, originStops),
    destinationSeeds: activeServiceKernelAccessSeeds(kernel, destinationStops),
    departure,
    horizon,
    allowPreRideTransfers,
    maxTransfers,
    allowPostRideTransfers: allowsTerminalTransfers(destinationStops),
  })
  return activeServiceKernelSearchFromNativeScalar(kernel, raw)
}

function activeServiceKernelSearchFromNativeScalar(kernel, raw, metadata = raw) {
  const queryMs = timingMilliseconds(raw.queryMs)
  return {
    supported: raw.supported,
    status: raw.status,
    reason: raw.reason,
    bestArrival: raw.bestArrival,
    bestBoardings: raw.bestBoardings,
    bestDestinationIndex: raw.bestDestinationIndex,
    chain: nativeTimetableChain(kernel, raw),
    queryMs: Number(queryMs.toFixed(3)),
    poppedStates: raw.poppedStates,
    scannedDepartures: raw.scannedDepartures,
    relaxedStops: raw.relaxedStops,
    expandedTripRuns: raw.expandedTripRuns,
    dominatedTripBoardings: raw.dominatedTripBoardings,
    explicitTransferChecks: raw.explicitTransferChecks,
    scalarPhases: {
      destinationSeedMs: normalizeNativeMilliseconds(raw.destinationSeedNs),
      originSeedMs: normalizeNativeMilliseconds(raw.originSeedNs),
      scanMs: normalizeNativeMilliseconds(raw.scanNs),
      chainMs: normalizeNativeMilliseconds(raw.chainNs),
    },
    heuristicMode: 'none',
    nativeTimetableKernel: {
      source: 'rust_node_api_zero_copy_active_service_arrays',
      configureMs: timingMilliseconds(metadata.configureMs),
      queryMs: Number(queryMs.toFixed(3)),
      diagnostics: metadata.kernelDiagnostics,
    },
  }
}

export function routeNativeParetoWithRestrictionFallback(routePareto, kernel, nativeRequest) {
  const restrictedRaw = routePareto(kernel, nativeRequest)
  let raw = restrictedRaw
  let restrictionFallback = null
  if (
    restrictedRaw.supported !== true
    && restrictedRaw.reason === 'origin_outside_kernel'
  ) {
    raw = routePareto(kernel, {
      ...nativeRequest,
      restrictionMode: 'anchor-only',
    })
    restrictionFallback = {
      status: raw.supported === true && raw.status === 'ready' ? 'passed' : 'failed',
      triggerReason: restrictedRaw.reason,
      primaryRestrictionMode: restrictedRaw.restrictionMode ?? 'anchor+both',
      fallbackRestrictionMode: raw.restrictionMode ?? 'anchor-only',
      primaryQueryMs: timingMilliseconds(restrictedRaw.queryMs),
      fallbackQueryMs: timingMilliseconds(raw.queryMs),
      exactness: 'same_arrival_and_boarding_anchor_without_forward_or_reverse_corridor_pruning',
    }
  }
  return {
    raw,
    restrictionFallback,
    combinedQueryMs: timingMilliseconds(
      timingMilliseconds(restrictedRaw.queryMs)
      + (restrictionFallback ? timingMilliseconds(raw.queryMs) : 0),
    ),
  }
}

function searchActiveServiceKernelNativePareto(
  kernel,
  originStops,
  destinationStops,
  departure,
  horizon,
  allowPreRideTransfers,
  candidateSearch,
  options = {},
) {
  const optimizeGeneralizedCost = options.optimizeGeneralizedCost === true
  const collectAlternatives = options.collectAlternatives === true
  const deadlineObjective = options.deadlineObjective === true
  const arrivalSlackSeconds = optimizeGeneralizedCost || collectAlternatives || deadlineObjective
    ? Math.max(0, Number(options.arrivalSlackSeconds) || 0)
    : 0
  const transferPenaltySeconds = optimizeGeneralizedCost
    ? Math.max(0, Number(options.transferPenaltySeconds) || 0)
    : 0
  const walkReluctance = optimizeGeneralizedCost
    ? Math.max(0, Number(options.walkReluctance) || 0)
    : 0
  const earliestArrivalWitness = activeServiceKernelSearchGeneralizedCost(
    candidateSearch,
    originStops,
    destinationStops,
    departure,
  )
  if (!earliestArrivalWitness) {
    return { supported: false, reason: 'invalid_native_generalized_cost_candidate' }
  }
  const nativeRequest = {
    originSeeds: activeServiceKernelAccessSeeds(kernel, originStops),
    destinationSeeds: activeServiceKernelAccessSeeds(kernel, destinationStops),
    departure,
    horizon,
    allowPreRideTransfers,
    allowPostRideTransfers: allowsTerminalTransfers(destinationStops),
    earliestArrival: candidateSearch.bestArrival,
    boardingUpperBound: candidateSearch.bestBoardings,
    candidateDestinationIndex: candidateSearch.bestDestinationIndex,
    candidateWalkingSeconds: earliestArrivalWitness.walkingSeconds,
    arrivalSlackSeconds,
    transferPenaltySeconds,
    walkReluctance,
    collectAlternatives,
    deadlineObjective,
  }
  // The forward+reverse corridor is an accelerator, not part of the public
  // objective. A scalar witness is already known to be feasible here. If the
  // restricted certifier nevertheless excludes every origin, repeat the exact
  // bounded Pareto proof without corridor pruning instead of turning a valid
  // time-specific query into an engine exception.
  const { raw, restrictionFallback, combinedQueryMs } =
    routeNativeParetoWithRestrictionFallback(routeNativeTimetablePareto, kernel, nativeRequest)
  if (!raw.supported || raw.status !== 'ready') {
    return {
      supported: raw.supported,
      status: raw.status,
      reason: raw.reason,
      queryMs: combinedQueryMs,
      restrictionFallback,
      nativeTimetableKernel: {
        source: 'rust_exact_connection_scan_bounded_pareto_no_heuristic',
        configureMs: timingMilliseconds(raw.configureMs),
        queryMs: combinedQueryMs,
        diagnostics: raw.kernelDiagnostics,
      },
    }
  }
  const selected = optimizeGeneralizedCost
    ? activeServiceKernelGeneralizedScore(
        raw.bestArrival,
        raw.bestBoardings,
        raw.bestWalkingSeconds,
        departure,
      )
    : null
  return {
    supported: raw.supported,
    status: raw.status,
    reason: raw.reason,
    bestArrival: raw.bestArrival,
    bestBoardings: raw.bestBoardings,
    bestDestinationIndex: raw.bestDestinationIndex,
    chain: raw.improvedCandidate ? nativeTimetableChain(kernel, raw) : candidateSearch.chain,
    alternatives: raw.alternatives?.map((candidate) => ({
      bestArrival: candidate.bestArrival,
      bestBoardings: candidate.bestBoardings,
      bestDestinationIndex: candidate.bestDestinationIndex,
      chain: nativeTimetableChain(kernel, candidate),
    })),
    queryMs: combinedQueryMs,
    corridorMs: timingMilliseconds(raw.corridorMs),
    forwardMs: timingMilliseconds(raw.forwardMs),
    reverseMs: timingMilliseconds(raw.reverseMs),
    roundMs: timingMilliseconds(raw.roundMs),
    corridorExitEvents: raw.corridorExitEvents,
    corridorRunSegments: raw.corridorRunSegments,
    corridorTransferEdges: raw.corridorTransferEdges,
    forwardDepartureEvents: raw.forwardDepartureEvents,
    forwardRunSegments: raw.forwardRunSegments,
    forwardTransferEdges: raw.forwardTransferEdges,
    scannedDepartures: raw.scannedDepartures,
    relaxedStops: raw.relaxedStops,
    expandedTripRuns: raw.expandedTripRuns,
    dominatedTripBoardings: raw.dominatedTripBoardings,
    explicitTransferChecks: raw.explicitTransferChecks,
    dominatedCandidateLabels: raw.dominatedCandidateLabels,
    dominatedExistingLabels: raw.dominatedExistingLabels,
    heuristicMode: 'none',
    restrictionMode: raw.restrictionMode ?? null,
    restrictionFallback,
    paretoFrontier: true,
    strictBoardingBound: true,
    boardingObjectivePrunedLabels: raw.dominatedCandidateLabels,
    boardingObjectiveCutoffStates: raw.dominatedExistingLabels,
    tripRunDedupStorage: 'rust_fixed_round_run_layers',
    tripRunDedupBytes: raw.kernelDiagnostics.workspaceBytes,
    certifier: deadlineObjective ? 'rust_exact_deadline_boardings_walking' : 'rust_exact_bounded_nondominated_frontier',
    deadlineObjective,
    paretoLabels: raw.paretoLabels,
    runProfiles: raw.runProfiles,
    earliestArrival: candidateSearch.bestArrival,
    arrivalUpperBound: candidateSearch.bestArrival + arrivalSlackSeconds,
    arrivalPreferenceSlackSeconds: arrivalSlackSeconds,
    preferFewerBoardingsWithinSlack: options.preferFewerBoardingsWithinSlack === true,
    boardingUpperBound: candidateSearch.bestBoardings,
    optimizeGeneralizedCost,
    paretoImprovedCandidate: raw.improvedCandidate,
    transferPreferenceApplied: raw.bestBoardings < candidateSearch.bestBoardings,
    ...(optimizeGeneralizedCost ? {
      balancedGeneralizedSelection: activeServiceKernelBalancedSelectionDiagnostics(
        earliestArrivalWitness,
        selected,
        raw.terminalCandidatesEvaluated,
        candidateSearch.bestBoardings,
        raw.improvedCandidate,
      ),
    } : {}),
    nativeTimetableKernel: {
      source: 'rust_exact_connection_scan_bounded_pareto_no_heuristic',
      configureMs: timingMilliseconds(raw.configureMs),
      queryMs: combinedQueryMs,
      diagnostics: raw.kernelDiagnostics,
    },
  }
}

function activeKernelTripConnections(kernel, step) {
  const trip = step.kernelTripIndex
  const connections = []
  let previous = null
  for (let index = kernel.tripStart[trip]; index < kernel.tripStart[trip + 1]; index += 1) {
    const stopSequence = kernel.sequence[index]
    if (stopSequence < step.boardingStopSequence) {
      previous = index
      continue
    }
    if (kernel.continuityBreak[index] && connections.length) break
    if (
      previous !== null
      && !kernel.continuityBreak[index]
      && kernel.toStop[previous] !== kernel.fromStop[index]
    ) {
      const bridgeSequence = kernel.sequence[previous] + 0.5
      if (bridgeSequence >= step.boardingStopSequence) {
        connections.push({
          departure: kernel.arrivalSeconds[previous],
          arrival: kernel.departureSeconds[index],
          trip_id: kernel.tripIds[trip],
          route_id: kernel.routeIds[trip],
          service_id: kernel.serviceIds[trip],
          direction_id: kernel.directionIds[trip],
          from_stop_id: kernel.stopIds[kernel.toStop[previous]],
          to_stop_id: kernel.stopIds[kernel.fromStop[index]],
          stop_sequence: bridgeSequence,
          bridged_untimed_gap: 1,
        })
        if (bridgeSequence >= step.alightingStopSequence) break
      }
    }
    connections.push({
      kernel_segment_index: index,
      departure: kernel.departureSeconds[index],
      arrival: kernel.arrivalSeconds[index],
      trip_id: kernel.tripIds[trip],
      route_id: kernel.routeIds[trip],
      service_id: kernel.serviceIds[trip],
      direction_id: kernel.directionIds[trip],
      from_stop_id: kernel.stopIds[kernel.fromStop[index]],
      to_stop_id: kernel.stopIds[kernel.toStop[index]],
      stop_sequence: stopSequence,
    })
    if (stopSequence >= step.alightingStopSequence) break
    previous = index
  }
  return connections
}

function activeServiceKernelAlgorithm(search) {
  if (search.realtimeOverlay === true) return 'rust_resident_query_overlay_connection_scan_one_to_many'
  return search.paretoFrontier
    ? 'rust_exact_connection_scan_bounded_pareto_no_heuristic'
    : 'rust_exact_connection_scan_scalar_no_heuristic'
}

function activeServiceKernelMethod() { return 'rust_timetable_kernel' }

function activeServiceKernelTransferWork(search) {
  if (!search) return null
  const explicitTransferChecks = Math.max(
    0,
    Math.floor(numeric(search.explicitTransferChecks, 0)),
  )
  return {
    explicitTransferChecks,
    totalTransferCandidateChecks: explicitTransferChecks,
  }
}

function activeServiceKernelTransferWorkPhases(scalarSearch, certifierSearch = null) {
  const scalar = activeServiceKernelTransferWork(scalarSearch)
  const certifier = activeServiceKernelTransferWork(certifierSearch)
  return {
    scalar,
    certifier,
    total: {
      explicitTransferChecks: numeric(scalar?.explicitTransferChecks, 0)
        + numeric(certifier?.explicitTransferChecks, 0),
      totalTransferCandidateChecks: numeric(scalar?.totalTransferCandidateChecks, 0)
        + numeric(certifier?.totalTransferCandidateChecks, 0),
    },
  }
}

function materializeActiveServiceKernelBlockedPlan(store, search, context) {
  if (!search?.supported || search.status !== 'blocked') return null
  const {
    request, departureMinutes, horizon, maxWalkKm, serviceDateResolution, services,
    startedAt, accessPreparationMs, serviceActivationMs, serviceKernelPreparationMs = 0,
    realtimeOverlay = null,
  } = context
  const noPathDetail = serviceDateResolution.serviceDateFallbackApplied
    ? `No scheduled path was found on fallback service date ${serviceDateResolution.resolvedServiceDate} within the routing horizon (requested ${serviceDateResolution.requestedServiceDate}).`
    : 'No exact-date path was found within the routing horizon.'
  const plan = blockedPlan(
    request,
    departureMinutes,
    maxWalkKm,
    'No scheduled path',
    noPathDetail,
    {
      originStops: context.originStops.length,
      destinationStops: context.destinationStops.length,
      scanned: search.scannedDepartures,
      relaxed: search.relaxedStops,
    },
    serviceDateResolution,
  )
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      searchStrategy: 'exact',
      algorithm: activeServiceKernelAlgorithm(search),
      optimality: 'no_path_within_active_service_and_access_model',
      methodState: 'complete',
      methodRequested: activeServiceKernelMethod(search),
      methodUsed: activeServiceKernelMethod(search),
      ...(realtimeOverlay ? {
        realtimeRouting: {
          ...realtimeOverlay.diagnostics,
          mode: 'trip-update-overlay',
          status: realtimeOverlay.status,
          overlayConnections: search.overlayConnections,
          overlayRuns: search.overlayRuns,
          supplementalTransferEdges: search.supplementalTransferEdges,
          appliedTripIds: realtimeOverlay.trips.map((trip) => trip.feedTripId ?? trip.tripId),
        },
      } : {}),
      searchStats: {
        ...plan.diagnostics.searchStats,
        queryMs: Number((performance.now() - startedAt).toFixed(3)),
        engineQueryMs: timingMilliseconds(search.queryMs),
        transferWork: activeServiceKernelTransferWorkPhases(search),
        accessPreparationMs,
        serviceActivationMs,
        serviceKernelPreparationMs,
        materializationMs: 0,
        heuristicMode: 'none',
        activeServices: services.size,
        ...(realtimeOverlay ? {
          realtimeRouting: {
            ...realtimeOverlay.diagnostics,
            status: realtimeOverlay.status,
          },
        } : {}),
        engineInvocationsThisPass: { rustTimetable: 1, sqlite: 0 },
        activeServiceKernel: {
          ...activeServiceKernelSnapshot(store),
          engineQueryMs: timingMilliseconds(search.queryMs),
          transferWork: activeServiceKernelTransferWorkPhases(search),
          paretoFrontier: false,
        },
        tripExpansion: {
          expandedTripRuns: search.expandedTripRuns,
          dominatedTripBoardings: search.dominatedTripBoardings,
        },
      },
    },
  }
}

function activeServiceKernelUnmaterializedSearchStats(store, search, context) {
  const {
    request, services, startedAt, accessPreparationMs, serviceActivationMs,
    serviceKernelPreparationMs = 0, nativeTimetableKernel = null,
    nativeCoordinateAccess = null,
  } = context
  const paretoCertifier = search.paretoFrontier === true
  const lexicographicCertifier = paretoCertifier || search.lexicographicCertified === true
    || (request.maxTransfers !== undefined && search.realtimeOverlay !== true)
  const transferWork = paretoCertifier
    ? activeServiceKernelTransferWorkPhases(null, search)
    : activeServiceKernelTransferWorkPhases(search)
  return {
    engineInvocationsThisPass: { rustTimetable: 1, sqlite: 0 },
    queryMs: Number((performance.now() - startedAt).toFixed(3)),
    engineQueryMs: timingMilliseconds(search.queryMs),
    transferWork,
    accessPreparationMs,
    serviceActivationMs,
    serviceKernelPreparationMs,
    nativeStreetPathCache: nativeStreetPathCacheDiagnostics(store),
    nativeStreetPathCacheHits: 0,
    nativeStreetPathCacheMisses: 0,
    nativeStreetPathQueryMs: 0,
    nativeStreetPathCacheDisabled: request.__disableNativeStreetPathCache === true,
    selectedArrivalSeconds: search.bestArrival,
    scalarPhases: search.scalarPhases,
    materializationMs: 0,
    tripConnectionMaterializationMs: 0,
    routeMetadataLookupMs: 0,
    shapeExtractionMs: 0,
    heuristicMode: 'none',
    activeServices: services.size,
    ...(nativeTimetableKernel ? { nativeTimetableKernel } : {}),
    ...(nativeCoordinateAccess ? {
      nativeCoordinateKernel: nativeCoordinateAccess.diagnostics,
    } : {}),
    ...activeServiceKernelSearchDiagnostics(store, search, transferWork, lexicographicCertifier),
    transitPlanMaterializationSkipped: true,
  }
}

function activeServiceKernelSearchDiagnostics(store, search, transferWork, lexicographicCertified) {
  return {
    activeServiceKernel: {
      ...activeServiceKernelSnapshot(store),
      engineQueryMs: timingMilliseconds(search.queryMs),
      scalarPhases: search.scalarPhases,
      transferWork,
      paretoFrontier: search.paretoFrontier === true,
      lexicographicCertified,
      certifier: search.certifier,
      paretoLabels: search.paretoLabels,
      dominatedCandidateLabels: search.dominatedCandidateLabels,
      dominatedExistingLabels: search.dominatedExistingLabels,
      strictBoardingBound: search.strictBoardingBound,
      boardingObjectivePrunedLabels: search.boardingObjectivePrunedLabels,
      boardingObjectiveCutoffStates: search.boardingObjectiveCutoffStates,
      tripRunDedupStorage: search.tripRunDedupStorage,
      tripRunDedupBytes: search.tripRunDedupBytes,
    },
    tripExpansion: {
      expandedTripRuns: search.expandedTripRuns,
      dominatedTripBoardings: search.dominatedTripBoardings,
    },
  }
}

function decorateActiveServiceKernelParetoPlan(
  plan,
  scalarSearch,
  paretoSearch,
  candidateBoardings,
) {
  if (!paretoSearch) return plan
  const certifierName = paretoSearch.certifier
  const engineName = activeServiceKernelMethod(paretoSearch)
  const engineQueryMs = timingMilliseconds(
    timingMilliseconds(scalarSearch.queryMs)
      + timingMilliseconds(paretoSearch.queryMs),
  )
  const transferWork = activeServiceKernelTransferWorkPhases(
    scalarSearch,
    paretoSearch,
  )
  return {
    ...plan,
    choiceLabel: (
      plan.diagnostics?.balancedGeneralizedSelection?.selectedRole
      === 'nondominated_generalized_cost'
    ) || paretoSearch.transferPreferenceApplied === true
      ? 'Best balance'
      : plan.choiceLabel,
    diagnostics: {
      ...plan.diagnostics,
      optimality: plan.scheduleMode === 'interpolated-stop-time-gap'
        ? 'lexicographic_routing_within_interpolated_stop_time_gap_model'
        : paretoSearch.deadlineObjective
        ? `fewest_boardings_then_walking_then_arrival_within_deadline_certified_by_${certifierName}`
        : plan.diagnostics?.balancedGeneralizedSelection
        ? 'balanced_generalized_selection_over_exact_certified_nondominated_frontier'
        : paretoSearch.transferPreferenceApplied === true
          ? `fewer_boardings_within_bounded_arrival_equivalence_certified_by_${certifierName}`
          : `lexicographic_earliest_arrival_then_boardings_then_walking_certified_by_${certifierName}`,
      methodRequested: engineName,
      methodUsed: [engineName, certifierName],
      paretoCertification: {
        status: 'passed',
        accelerator: engineName,
        certifier: certifierName,
        arrivalUpperBoundSeconds: paretoSearch.arrivalUpperBound,
        selectedArrivalSeconds: paretoSearch.bestArrival,
        arrivalPreferenceSlackSeconds:
          paretoSearch.arrivalPreferenceSlackSeconds ?? 0,
        candidateBoardings,
        certifiedBoardings: paretoSearch.bestBoardings,
        improvedCandidate: paretoSearch.paretoImprovedCandidate === true,
        transferPreferenceApplied: paretoSearch.transferPreferenceApplied === true,
        restrictionMode: paretoSearch.restrictionMode,
        restrictionFallback: paretoSearch.restrictionFallback,
      },
      searchStats: {
        ...plan.diagnostics?.searchStats,
        engineQueryMs,
        acceleratorQueryMs: timingMilliseconds(scalarSearch.queryMs),
        paretoCertificationQueryMs: timingMilliseconds(paretoSearch.queryMs),
        paretoCorridorMs: timingMilliseconds(paretoSearch.corridorMs),
        paretoForwardMs: timingMilliseconds(paretoSearch.forwardMs),
        paretoReverseMs: timingMilliseconds(paretoSearch.reverseMs),
        paretoRoundMs: timingMilliseconds(paretoSearch.roundMs),
        paretoRestrictionFallback: paretoSearch.restrictionFallback,
        transferWork,
        activeServiceKernel: {
          ...plan.diagnostics?.searchStats?.activeServiceKernel,
          engineQueryMs,
          paretoRestrictionFallback: paretoSearch.restrictionFallback,
          transferWork,
        },
      },
    },
  }
}

function nationalRoutingStationGroupForStop(store, stopId) {
  const normalizedStopId = String(stopId ?? '').trim()
  if (!normalizedStopId) return ''
  const stop = store.stopLookup.get(normalizedStopId)
  return String(stop?.parent_station ?? '').trim() || normalizedStopId
}

function withReturnedStationAdvisory(store, plan) {
  const cycle = nationalRoutingReturnedRideCycle(plan, {
    stationGroupForStopId: (stopId) => nationalRoutingStationGroupForStop(store, stopId),
  })
  if (!cycle) return plan
  return { ...plan, diagnostics: { ...plan.diagnostics,
    returnedStationCycle: { policy: 'represented', advisory: true, ...cycle },
  } }
}

function materializeActiveServiceKernelPlan(store, kernel, search, context) {
  if (!search?.supported || search.status !== 'ready') return null
  const materializationStartedAt = performance.now()
  const {
    request, origin, destination, departureMinutes, departure, horizon, maxWalkKm,
    serviceDateResolution, services, startedAt, accessPreparationMs, serviceActivationMs,
    serviceKernelPreparationMs = 0, nativeTimetableKernel = null, streetStorageIdentity,
    nativeCoordinateAccess = null, realtimeOverlay = null,
  } = context
  const stopLookup = store.stopLookup
  const routeLookup = store.routeLookup
  const chain = search.chain
  const paretoCertifier = search.paretoFrontier === true
  const lexicographicCertifier = paretoCertifier || search.lexicographicCertified === true
    || (request.maxTransfers !== undefined && search.realtimeOverlay !== true)
  const transferWork = paretoCertifier
    ? activeServiceKernelTransferWorkPhases(null, search)
    : activeServiceKernelTransferWorkPhases(search)
  const bestStop = context.destinationStops[search.bestDestinationIndex]
  const bestArrival = search.bestArrival
  let tripConnectionMaterializationMs = 0
  let routeMetadataLookupMs = 0
  let shapeExtractionMs = 0
  let accessGeometryMs = 0
  let egressGeometryMs = 0
  let legNormalizationMs = 0
  let realtimeAdjustedRideCount = 0
  const nativeStreetPathDiagnostics = {
    hits: 0,
    misses: 0,
    queryMs: 0,
    disableCache: request.__disableNativeStreetPathCache === true,
  }
  let legs = []
  const firstAccess = chain.find((step) => step.kind === 'access')
  const firstAccessStop = firstAccess ? context.originStops[firstAccess.candidateIndex] : null
  if (!firstAccess || !firstAccessStop || !bestStop) return null
  const exactStationAccess = firstAccessStop.exactStopAccess === true
  if (request.streetStorePath && !exactStationAccess && firstAccessStop.walkSource === 'osm' && firstAccessStop.streetPathVerified !== true) return null
  const accessGeometryStartedAt = performance.now()
  const accessCoordinates = pointToAccessCoordinates(
    store,
    request.streetStorePath,
    streetStorageIdentity,
    origin.coordinate,
    firstAccessStop,
    maxWalkKm,
    nativeStreetPathDiagnostics,
  )
  accessGeometryMs = performance.now() - accessGeometryStartedAt
  legs.push({
    type: 'walk', travelMode: 'walk', walkSource: firstAccessStop.walkSource || (request.streetStorePath ? 'osm' : 'direct'),
    fromName: origin.label, toName: firstAccessStop.name, toStopId: firstAccessStop.stop_id,
    streetPathVerified: firstAccessStop.streetPathVerified === true,
    stationPathSources: firstAccessStop.accessTransferSources,
    startMinutes: departureMinutes, endMinutes: minuteCoordinate(firstAccess.arrival),
    durationMinutes: secondsToMinutes(firstAccess.arrival - departure), distanceKm: firstAccessStop.distanceKm,
    stopCount: 0, coordinates: accessCoordinates,
    endpointConnector: endpointConnector(origin.coordinate, accessCoordinates[0]),
  })
  for (const step of chain) {
    if (step.kind === 'access') continue
    if (step.kind === 'transfer') {
      const from = stopLookup.get(step.fromStopId)
      const to = stopLookup.get(step.toStopId)
      const transfer = store.transfers.get(step.fromStopId)
        ?.find((rule) => rule.to_stop_id === step.toStopId)
      const transferSource = transfer?.provenance ?? 'parent_station_fallback'
      let transferPath = null
      if (
        transferSource === 'osm_certified_radial'
        && request.streetStorePath
        && Number.isFinite(from?.lon)
        && Number.isFinite(from?.lat)
        && Number.isFinite(to?.lon)
        && Number.isFinite(to?.lat)
      ) {
        const transferPathInput = {
          stopTransfer: true,
          streetStorePath: request.streetStorePath,
          streetStorageIdentity,
          fromStopId: step.fromStopId,
          toStopId: step.toStopId,
          fromCoordinate: [from.lon, from.lat],
          toCoordinate: [to.lon, to.lat],
          maximumDistanceKm: Math.max(maxWalkKm, osmTransferMaximumWalkM / 1000),
        }
        // Generated transfer weights use physical stop coordinates. Public
        // endpoint entrance anchors can describe a different, longer path.
        transferPath = cachedNativeAccessMemberPath(
          store,
          transferPathInput,
          nativeStreetPathDiagnostics,
        ) ?? cachedNativeStreetPath(
          store,
          transferPathInput,
          nativeStreetPathDiagnostics,
        )
      }
      legs.push({
        type: 'walk', travelMode: 'walk', walkSource: 'transfer', fromStopId: step.fromStopId, toStopId: step.toStopId,
        transferSource,
        fromName: from?.name ?? step.fromStopId, toName: to?.name ?? step.toStopId,
        startMinutes: minuteCoordinate(step.arrival - step.duration), endMinutes: minuteCoordinate(step.arrival),
        durationMinutes: secondsToMinutes(step.duration),
        distanceKm: transferPath?.distanceKm ?? (transfer?.path_distance_m != null ? transfer.path_distance_m / 1000 : undefined)
          ?? (from && to ? haversineKm([from.lon, from.lat], [to.lon, to.lat]) : 0),
        stopCount: 0,
        coordinates: transferPath?.coordinates
          ?? (from && to ? [[from.lon, from.lat], [to.lon, to.lat]] : []),
        // Source transfer/pathway times and the station fallback describe their
        // own connections, not a detour through the external street network.
        geometrySource: transferPath ? 'osm-rust-selected-transfer'
          : transferSource === 'parent_station_fallback' ? 'station-transfer-schematic' : 'stop-coordinate-fallback',
        streetPathVerified: Boolean(transferPath),
        nativeStreetQueryMs: timingMilliseconds(transferPath?.nativeQueryMs),
      })
      continue
    }
    const tripConnectionStartedAt = performance.now()
    const connections = step.realtimeAdjusted && realtimeOverlay
      ? realtimeTripConnectionsForStep(realtimeOverlay.trips[step.realtimeTripIndex], step)
      : activeKernelTripConnections(kernel, step)
    tripConnectionMaterializationMs += performance.now() - tripConnectionStartedAt
    const first = connections[0]
    const last = connections.at(-1)
    if (!first || !last) return null
    if (step.realtimeAdjusted) realtimeAdjustedRideCount += 1
    const from = stopLookup.get(first.from_stop_id)
    const to = stopLookup.get(last.to_stop_id)
    const routeLookupStartedAt = performance.now()
    const route = routeLookup.get(first.route_id) ?? {}
    routeMetadataLookupMs += performance.now() - routeLookupStartedAt
    const bridgedUntimedGapCount = connections.filter((connection) => connection.bridged_untimed_gap).length
    const sourceEqualTimeConnectionCount = connections.filter((connection) => (
      connection.arrival === connection.departure
      && connection.from_stop_id !== connection.to_stop_id
    )).length
    const sourceEqualTime = (
      last.arrival === first.departure
      && first.from_stop_id !== last.to_stop_id
    )
    const sourceWholeMinuteTimes = sourceEqualTime
      && first.departure % 60 === 0
      && last.arrival % 60 === 0
    const shapeExtractionStartedAt = performance.now()
    const geometry = nationalRideGeometry(store, connections, stopLookup)
    shapeExtractionMs += performance.now() - shapeExtractionStartedAt
    legs.push({
      type: 'ride', travelMode: 'transit', scheduleMode: step.realtimeAdjusted
        ? 'realtime-adjusted'
        : bridgedUntimedGapCount ? 'interpolated-stop-time-gap' : 'exact',
      fromStopId: first.from_stop_id, toStopId: last.to_stop_id,
      fromStationGroupId: from?.parent_station || first.from_stop_id,
      toStationGroupId: to?.parent_station || last.to_stop_id,
      fromName: from?.name ?? first.from_stop_id, toName: to?.name ?? last.to_stop_id,
      routeFeatureId: first.route_id, routeId: first.route_id,
      routeType: route.route_type,
      routeShortName: route.short_name || route.long_name || first.route_id, routeColor: route.color || undefined,
      tripId: first.trip_id, directionId: first.direction_id || undefined,
      startMinutes: minuteCoordinate(first.departure), endMinutes: minuteCoordinate(last.arrival),
      durationMinutes: secondsToMinutes(last.arrival - first.departure), distanceKm: geometry.distanceKm,
      stopIds: [first.from_stop_id, ...connections.map((connection) => connection.to_stop_id)],
      stopCount: connections.length, coordinates: geometry.coordinates, geometrySource: geometry.geometrySource, shapeId: geometry.shapeId,
      bridgedUntimedGapCount: bridgedUntimedGapCount || undefined,
      sourceEqualTime: sourceEqualTime || undefined,
      sourceEqualTimeConnectionCount: sourceEqualTimeConnectionCount || undefined,
      sourceTimestampQuality: sourceEqualTime
        ? sourceWholeMinuteTimes
          ? 'equal-whole-minute'
          : 'equal-time'
        : undefined,
    })
  }
  const lastStop = stopLookup.get(bestStop.stop_id)
  const egressStart = bestArrival - accessWalkSeconds(bestStop)
  const exactStationEgress = bestStop.exactStopAccess === true
  if (request.streetStorePath && !exactStationEgress && bestStop.walkSource === 'osm' && bestStop.streetPathVerified !== true) return null
  const egressGeometryStartedAt = performance.now()
  const destinationToStopCoordinates = pointToAccessCoordinates(
    store,
    request.streetStorePath,
    streetStorageIdentity,
    destination.coordinate,
    bestStop,
    maxWalkKm,
    nativeStreetPathDiagnostics,
  )
  egressGeometryMs = performance.now() - egressGeometryStartedAt
  legs.push({
    type: 'walk', travelMode: 'walk', walkSource: bestStop.walkSource || (request.streetStorePath ? 'osm' : 'direct'),
    fromStopId: bestStop.stop_id, fromName: lastStop?.name ?? bestStop.stop_id, toName: destination.label,
    streetPathVerified: bestStop.streetPathVerified === true,
    stationPathSources: bestStop.accessTransferSources,
    startMinutes: minuteCoordinate(egressStart), endMinutes: minuteCoordinate(bestArrival),
    durationMinutes: secondsToMinutes(bestArrival - egressStart), distanceKm: bestStop.distanceKm,
    stopCount: 0, coordinates: [...destinationToStopCoordinates].reverse(),
    endpointConnector: endpointConnector(destination.coordinate, destinationToStopCoordinates[0], true),
  })
  const legNormalizationStartedAt = performance.now()
  const stationAccess = annotateStationAccess(legs, {
    exactStationAccess, exactStationEgress,
  })
  const originStreetPathVerified = exactStationAccess || legs[0].streetPathVerified === true
  const destinationStreetPathVerified = exactStationEgress || legs.at(-1).streetPathVerified === true
  legs = normalizeNationalLegs(legs)
  legNormalizationMs = performance.now() - legNormalizationStartedAt
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  if (!rideLegs.length) return null
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + leg.durationMinutes, 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0)
  const bridgedUntimedGapCount = rideLegs.reduce((sum, leg) => sum + numeric(leg.bridgedUntimedGapCount, 0), 0)
  const sourceEqualTimeRideCount = rideLegs.filter((leg) => leg.sourceEqualTime === true).length
  const sourceEqualTimeConnectionCount = rideLegs.reduce(
    (sum, leg) => sum + numeric(leg.sourceEqualTimeConnectionCount, 0),
    0,
  )
  const durationMinutes = secondsToMinutes(bestArrival - departure)
  const waitMinutes = Math.max(0, durationMinutes - walkMinutes - rideMinutes)
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  const routeTitle = boardingSummary.title
  const scheduleMode = realtimeAdjustedRideCount
    ? 'realtime-adjusted'
    : bridgedUntimedGapCount ? 'interpolated-stop-time-gap' : 'exact'
  const balancedRequest = request.routingPreference === 'balanced'
  const balancedSelectedRole = search.balancedGeneralizedSelection?.selectedRole
  const planIdentityStartedAt = performance.now()
  const planId = stableNationalTransitPlanId({
    store,
    streetStorageIdentity,
    serviceDate: serviceDateResolution.resolvedServiceDate,
    departMinutes: departureMinutes,
    arriveMinutes: minuteCoordinate(bestArrival),
    origin,
    destination,
    legs,
  })
  const planIdentityMs = performance.now() - planIdentityStartedAt
  return {
    id: planId, status: 'ready', travelMode: 'transit', timePreference: 'depart', maxWalkKm, scheduleMode,
    choiceLabel: realtimeAdjustedRideCount
      ? 'Live · earliest arrival'
      : balancedRequest
      ? search.balancedGeneralizedSelection
        ? 'Best balance'
        : balancedSelectedRole === 'earliest_arrival'
          ? 'Balanced · Fastest'
          : 'Balanced · Lower burden'
      : 'Earliest arrival',
    recommended: true, title: routeTitle || 'Transit',
    detail: routeTimingDetail(
      durationMinutes,
      { ...serviceDateResolution, ...stationAccess },
      bridgedUntimedGapCount,
      sourceEqualTimeRideCount,
    ),
    departMinutes: departureMinutes, arriveMinutes: minuteCoordinate(bestArrival), durationMinutes, waitMinutes, walkMinutes, rideMinutes,
    transfers: boardingSummary.transfers, origin, destination,
    snappedOrigin: stopRecord(firstAccessStop), snappedDestination: stopRecord(bestStop), legs,
    diagnostics: {
      ...stationAccess,
      originWalkKm: firstAccessStop.distanceKm, destinationWalkKm: bestStop.distanceKm,
      scannedDepartures: search.scannedDepartures, relaxedStops: search.relaxedStops,
      serviceDay: request.serviceDay ?? 'weekday', ...serviceDateDiagnostics(serviceDateResolution), scheduleMode,
      timingPrecision: bridgedUntimedGapCount
        ? 'degraded'
        : sourceEqualTimeRideCount
          ? 'source-equal-time'
          : 'exact',
      sourceEqualTimeRideCount,
      sourceEqualTimeConnectionCount,
      routingHorizonMinutes: (horizon - departure) / 60,
      walkingNetwork: request.streetStorePath ? 'osm' : 'direct', walkingSpeedKph,
      walkingAccessPermission: request.streetStorePath ? nativeStreetAccessPermission(request.streetStorePath) : 'public',
      accessDurationModel: nationalRoutingAccessPolicy.durationModel,
      accessPaddingFactor,
      accessOverheadSeconds,
      originStreetPathVerified,
      destinationStreetPathVerified,
      searchProfile: balancedRequest ? 'balanced' : 'fastest', searchStrategy: 'exact',
      algorithm: activeServiceKernelAlgorithm(search),
      optimality: realtimeAdjustedRideCount
        ? 'earliest_arrival_within_scheduled_plus_gtfs_rt_trip_update_overlay'
        : bridgedUntimedGapCount
        ? 'earliest_arrival_within_interpolated_stop_time_gap_model'
        : search.balancedGeneralizedSelection
          ? 'balanced_generalized_selection_over_exact_nondominated_frontier'
        : search.deadlineObjective
          ? 'fewest_boardings_then_walking_then_arrival_within_deadline'
        : lexicographicCertifier
          ? 'lexicographic_earliest_arrival_then_boardings_then_walking_within_active_service_and_access_model'
          : 'earliest_arrival_within_active_service_and_access_model',
      ...(search.balancedGeneralizedSelection ? {
        balancedGeneralizedSelection: search.balancedGeneralizedSelection,
      } : {}),
      methodRequested: activeServiceKernelMethod(search),
      methodUsed: activeServiceKernelMethod(search),
      walkingPolicyId: nationalRoutingAccessPolicy.id, bridgedUntimedGapCount,
      ...(realtimeOverlay ? {
        realtimeRouting: {
          ...realtimeOverlay.diagnostics,
          mode: 'trip-update-overlay',
          status: realtimeAdjustedRideCount ? 'applied' : realtimeOverlay.status,
          overlayConnections: search.overlayConnections,
          overlayRuns: search.overlayRuns,
          supplementalTransferEdges: search.supplementalTransferEdges,
          appliedTripIds: realtimeOverlay.trips.map((trip) => trip.feedTripId ?? trip.tripId),
        },
      } : {}),
      originStopCandidates: context.originStops.length, destinationStopCandidates: context.destinationStops.length,
      coordinateAccessFrontier: (
        context.originStops.some((stop) => stop.accessSearchComplete === true)
        || context.destinationStops.some((stop) => stop.accessSearchComplete === true)
      )
        ? 'complete_osm_reachable'
        : 'exact_stop_selection',
      destinationLabels: 1,
      searchStats: {
        engineInvocationsThisPass: { rustTimetable: 1, sqlite: 0 },
        queryMs: Number((performance.now() - startedAt).toFixed(3)),
        engineQueryMs: timingMilliseconds(search.queryMs),
        transferWork,
        accessPreparationMs,
        serviceActivationMs,
        serviceKernelPreparationMs,
        nativeStreetPathCache: nativeStreetPathCacheDiagnostics(store),
        nativeStreetPathCacheHits: nativeStreetPathDiagnostics.hits,
        nativeStreetPathCacheMisses: nativeStreetPathDiagnostics.misses,
        nativeStreetPathQueryMs: timingMilliseconds(nativeStreetPathDiagnostics.queryMs),
        nativeStreetPathCacheDisabled: nativeStreetPathDiagnostics.disableCache,
        selectedArrivalSeconds: bestArrival,
        scalarPhases: search.scalarPhases,
        ...(realtimeOverlay ? { realtimeRouting: { ...realtimeOverlay.diagnostics, status: realtimeOverlay.status } } : {}),
        materializationMs: Number((performance.now() - materializationStartedAt).toFixed(3)),
        tripConnectionMaterializationMs: Number(tripConnectionMaterializationMs.toFixed(3)),
        routeMetadataLookupMs: Number(routeMetadataLookupMs.toFixed(3)),
        shapeExtractionMs: Number(shapeExtractionMs.toFixed(3)),
        accessGeometryMs: Number(accessGeometryMs.toFixed(3)),
        egressGeometryMs: Number(egressGeometryMs.toFixed(3)),
        legNormalizationMs: Number(legNormalizationMs.toFixed(3)),
        planIdentityMs: Number(planIdentityMs.toFixed(3)),
        heuristicMode: 'none',
        activeServices: services.size,
        ...(nativeTimetableKernel ? { nativeTimetableKernel } : {}),
        ...(nativeCoordinateAccess ? {
          nativeCoordinateKernel: nativeCoordinateAccess.diagnostics,
        } : {}),
        ...activeServiceKernelSearchDiagnostics(store, search, transferWork, lexicographicCertifier),
      },
    },
  }
}

function normalizedReachScenarioOverlay(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const stops = Array.isArray(value.stops) ? value.stops.map((stop, index) => {
    const coordinate = Array.isArray(stop?.coordinate) ? stop.coordinate.map(Number) : []
    if (coordinate.length !== 2 || !coordinate.every(Number.isFinite)) {
      throw new Error(`Reach scenario overlay stop ${index} has an invalid coordinate.`)
    }
    return {
      id: String(stop?.id ?? `scenario-stop-${index + 1}`),
      label: String(stop?.label ?? stop?.id ?? `Scenario stop ${index + 1}`),
      coordinate,
      ...(String(stop?.stopId ?? '').trim() ? { stopId: String(stop.stopId).trim() } : {}),
    }
  }) : []
  if (stops.length > 256) {
    throw new Error('Reach scenario overlays are limited to 256 stops.')
  }
  const directionOffsets = Array.from(value.directionOffsets ?? [], Number)
  const directionStops = Array.from(value.directionStops ?? [], Number)
  const directionStopOffsetsSeconds = Array.from(
    value.directionStopOffsetsSeconds ?? [],
    Number,
  )
  const serviceStartSeconds = Array.from(value.serviceStartSeconds ?? [], Number)
  const serviceEndSeconds = Array.from(value.serviceEndSeconds ?? [], Number)
  const serviceHeadwaySeconds = Array.from(value.serviceHeadwaySeconds ?? [], Number)
  const directionCount = serviceStartSeconds.length
  if (
    directionOffsets.length !== directionCount + 1
    || directionOffsets[0] !== 0
    || directionOffsets.at(-1) !== directionStops.length
    || directionStops.length !== directionStopOffsetsSeconds.length
    || serviceEndSeconds.length !== directionCount
    || serviceHeadwaySeconds.length !== directionCount
    || directionOffsets.some((offset) => !Number.isInteger(offset) || offset < 0)
    || directionStops.some((stop) => !Number.isInteger(stop) || stop < 0 || stop >= stops.length)
    || directionStopOffsetsSeconds.some((seconds) => !Number.isFinite(seconds) || seconds < 0)
    || [...serviceStartSeconds, ...serviceEndSeconds, ...serviceHeadwaySeconds]
      .some((seconds) => !Number.isFinite(seconds) || seconds < 0)
  ) {
    throw new Error('Reach scenario overlay service arrays are inconsistent.')
  }
  return {
    stops,
    directionOffsets,
    directionStops,
    directionStopOffsetsSeconds,
    serviceStartSeconds,
    serviceEndSeconds,
    serviceHeadwaySeconds,
  }
}

function retainOverlayTransfer(outgoing, from, to, durationSeconds) {
  if (
    !Number.isInteger(from)
    || !Number.isInteger(to)
    || from < 0
    || to < 0
    || from >= outgoing.length
    || to >= outgoing.length
    || !Number.isFinite(durationSeconds)
    || durationSeconds < 0
    || from === to
  ) return
  const duration = Math.min(0xffff_ffff, Math.ceil(durationSeconds))
  const retained = outgoing[from].get(to)
  if (retained === undefined || duration < retained) outgoing[from].set(to, duration)
}

function overlayTransferCsr(outgoing) {
  const offsets = [0]
  const to = []
  const duration = []
  for (const edges of outgoing) {
    for (const [target, seconds] of [...edges].sort((left, right) => left[0] - right[0])) {
      to.push(target)
      duration.push(seconds)
    }
    offsets.push(to.length)
  }
  return { offsets, to, duration }
}

function normalizedReachSurface(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const bounds = Array.isArray(value.bounds) ? value.bounds.map(Number) : []
  const width = Math.floor(Number(value.width))
  const height = Math.floor(Number(value.height))
  if (
    bounds.length !== 4
    || !bounds.every(Number.isFinite)
    || bounds[0] >= bounds[2]
    || bounds[1] >= bounds[3]
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
    || width > 1024
    || height > 1024
  ) {
    throw new Error('Reach surface requires valid bounds and 1-1024 pixel dimensions.')
  }
  return {
    bounds,
    width,
    height,
    includeNodes: value.includeNodes !== false,
    includeEdges: value.includeEdges === true,
    expandBoundsToReachedEdges: value.expandBoundsToReachedEdges !== false,
    terminalWalkMode: value.terminalWalkMode === 'independent-full-budget'
      ? 'independent-full-budget'
      : 'elapsed-total',
  }
}

function buildReachSurface(
  streetStorePath,
  surfaceRequest,
  seeds,
  maxWalkKm,
  walkSpeedKph,
  cutoffMinutes,
) {
  if (!surfaceRequest) return null
  if (!streetStorePath) {
    throw new Error('Reach surfaces require a persisted OSM street store.')
  }
  const independentTerminalWalk = surfaceRequest.terminalWalkMode === 'independent-full-budget'
  const terminalWalkMinutes = maxWalkKm / walkSpeedKph * 60
  const maximumDurationMinutes = independentTerminalWalk
    ? cutoffMinutes + terminalWalkMinutes
    : cutoffMinutes
  const surface = rasterNativeStreetSurface(streetStorePath, {
    ...surfaceRequest,
    seeds,
    maxWalkKm,
    walkSpeedKph,
    maximumDurationMinutes,
    independentTerminalWalk,
    // Reach owns the complete directed OSM edge surface. Native code
    // packs this exact edge set; no path is selected, sampled, or cropped for
    // the desktop view.
    compactEdges: true,
    includeNodes: surfaceRequest.includeNodes !== false,
    includeEdges: surfaceRequest.includeEdges === true,
    edgeDetailLimit: 0,
    // Area and street modes share the complete reached-network envelope. The
    // native query can replay that surface without serializing every edge.
    expandBoundsToReachedEdges: surfaceRequest.expandBoundsToReachedEdges,
  })
  return {
    ...surface,
    diagnostics: {
      ...surface.diagnostics,
      terminalWalkMode: independentTerminalWalk ? 'independent-full-budget' : 'elapsed-total',
      cutoffMinutes,
      terminalWalkCapKm: maxWalkKm,
      terminalWalkCapMinutes: Number(terminalWalkMinutes.toFixed(3)),
      maximumSurfaceDurationMinutes: Number(maximumDurationMinutes.toFixed(3)),
    },
  }
}

function annotateReachSurface(surface, { transitSeedCount = 0, scenarioSeedCount = 0 } = {}) {
  if (!surface) return surface
  const seedModel = scenarioSeedCount > 0
    ? 'origin_plus_reached_transit_and_scenario_stops'
    : transitSeedCount > 0
      ? 'origin_plus_reached_transit_stops'
      : 'origin_only'
  return {
    ...surface,
    diagnostics: {
      ...surface.diagnostics,
      seedModel,
      originSeedCount: 1,
      transitSeedCount,
      scenarioSeedCount,
      edgeSelection: 'all-reached-directed-edges',
    },
  }
}

function earliestActiveTransitDeparture(store, departure) {
  const row = store.db.prepare(`
    SELECT
      MIN(connection.departure) AS next_departure
    FROM connections AS connection
    INNER JOIN active_services AS active_service
      ON active_service.service_id = connection.service_id
    WHERE connection.departure >= ?
      AND connection.departure <= ?
  `).get(departure, departure + 24 * 60 * 60)
  const nextDeparture = row?.next_departure == null
    ? Number.NaN
    : Number(row.next_departure)
  return Number.isFinite(nextDeparture) ? nextDeparture : null
}

function reachTransitStatus({
  services,
  activeKernel,
  departure,
  horizon,
  targetStopCount,
  reachedStopCount,
  earliestDeparture,
}) {
  const activeConnections = Number(activeKernel?.activeSegmentCount ?? 0)
  const base = {
    requestedDepartureMinutes: departure / 60,
    windowEndMinutes: horizon / 60,
    earliestScheduledDepartureMinutes: Number.isFinite(earliestDeparture)
      ? earliestDeparture / 60
      : null,
    waitMinutes: Number.isFinite(earliestDeparture)
      ? Math.max(0, (earliestDeparture - departure) / 60)
      : null,
    targetStops: targetStopCount,
    reachedStops: reachedStopCount,
  }
  if (!services?.size || activeConnections <= 0) {
    return {
      ...base,
      status: 'no_service',
      detail: 'No scheduled transit service is active for the selected date.',
    }
  }
  if (!targetStopCount) {
    return {
      ...base,
      status: 'no_target_stops',
      detail: 'No transit stops fall inside the selected analysis envelope.',
    }
  }
  if (reachedStopCount > 0) {
    return {
      ...base,
      status: 'reached',
      detail: `${reachedStopCount} transit stops are reachable within the selected window.`,
    }
  }
  if (Number.isFinite(earliestDeparture) && earliestDeparture > horizon) {
    return {
      ...base,
      status: 'outside_window',
      detail: `The first scheduled departure is after the ${Math.round((horizon - departure) / 60)}-minute analysis window.`,
    }
  }
  if (!Number.isFinite(earliestDeparture)) {
    return {
      ...base,
      status: 'no_service_window',
      detail: 'No scheduled transit departure is available after the selected departure time.',
    }
  }
  return {
    ...base,
    status: 'no_reachable_stops',
    detail: 'Scheduled transit is present, but no transit stop is reachable within the selected window and access budget.',
  }
}

/**
 * Exact Reach range over the one resident timetable image. Free
 * coordinates fuse exact directed Rust access and the generation-tagged
 * timetable scan into one Node-API call; a compatible resident CCH metric
 * accelerates access, while selected stops use the same resident timetable
 * operator with zero-cost station access.
 */
export function routeNationalGtfsReach(storePath, request, options = {}) {
  request = withResolvedServiceDay(request)
  const started = performance.now()
  const onProgress = options.onProgress
  const isCancelled = options.isCancelled
  const checkCancelled = () => {
    if (!isCancelled?.()) return
    const error = new Error('Reach analysis was cancelled.')
    error.name = 'AbortError'
    error.code = 'ABORT_ERR'
    throw error
  }
  const report = (phase, progress, detail) => onProgress?.({ phase, progress, detail })
  const origin = Array.isArray(request?.origin?.coordinate)
    ? request.origin.coordinate.map(Number)
    : []
  if (origin.length !== 2 || !origin.every(Number.isFinite)) {
    throw new Error('Reach analysis requires a valid origin coordinate.')
  }
  const departureMinutes = integralRoutingMinute(request.departMinutes, 'departMinutes')
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.2)))
  const walkSpeedKph = Math.max(1, Math.min(8, numeric(
    request.walkSpeedKph,
    nationalRoutingAccessPolicy.walkingSpeedKph,
  )))
  const cutoffMinutes = Math.max(5, Math.min(240, numeric(request.cutoffMinutes, 90)))
  const departure = Math.round(departureMinutes * 60)
  const horizon = departure + Math.round(cutoffMinutes * 60)
  const excludedRouteIds = [...new Set(
    (Array.isArray(request.excludedRouteIds) ? request.excludedRouteIds : [])
      .map((routeId) => String(routeId ?? '').trim())
      .filter(Boolean),
  )].slice(0, 512)
  const excludedTripIds = new Set(
    (Array.isArray(request.excludedTripIds) ? request.excludedTripIds : [])
      .map((tripId) => String(tripId ?? '').trim())
      .filter(Boolean),
  )
  const streetStorePath = String(options.streetStorePath ?? request.streetStorePath ?? '').trim()
  const scenarioOverlay = normalizedReachScenarioOverlay(request.scenarioOverlay)
  const surfaceRequest = normalizedReachSurface(request.surface)

  checkCancelled()
  report('access', 0.04, 'Opening the resident routing image')
  const store = openNationalStore(storePath)
  ensureNationalStoreAccessMaterialization(store)
  if (store.blockingRoutingFeatures.length) {
    const error = new Error('Reach analysis cannot route unsupported GTFS features.')
    error.code = 'unsupported_gtfs_feature'
    error.features = store.blockingRoutingFeatures
    throw error
  }
  const serviceDateResolution = resolveServiceDate(
    store,
    request.serviceDate,
    request.serviceDay,
    false,
  )
  if (requiredServiceCoverageIncomplete(request, serviceDateResolution)) {
    const error = new Error('Reach analysis requires complete service coverage for the selected date.')
    error.code = 'coverage_incomplete'
    throw error
  }
  const services = activateServices(
    store,
    serviceDateResolution.resolvedServiceDate,
    request.serviceDay,
  )
  const residentStarted = performance.now()
  const activeKernel = ensureActiveServiceKernel(store, services).kernel
  const residentPrepareMs = performance.now() - residentStarted
  const earliestScheduledDeparture = earliestActiveTransitDeparture(store, departure)
  if (!activeKernel) {
    if (!services.size) {
      report('surface', 0.76, 'Building the origin-only pedestrian context')
      const surfaceStarted = performance.now()
      const surface = annotateReachSurface(buildReachSurface(
        streetStorePath,
        surfaceRequest,
        [{ coordinate: origin, durationMinutes: 0 }],
        maxWalkKm,
        walkSpeedKph,
        cutoffMinutes,
      ), { transitSeedCount: 0, scenarioSeedCount: 0 })
      const transit = reachTransitStatus({
        services,
        activeKernel: null,
        departure,
        horizon,
        targetStopCount: 0,
        reachedStopCount: 0,
        earliestDeparture: earliestScheduledDeparture,
      })
      report('complete', 1, transit.detail)
      return {
        schemaVersion: 'vigo.result.reach.v1',
        stops: [],
        scenarioStops: [],
        surface,
        diagnostics: {
          owner: 'rust_resident_timetable_kernel',
          algorithm: 'rust_resident_generation_tagged_connection_scan_one_to_many',
          activeServiceKernel: activeServiceKernelSnapshot(store),
          timetable: {
            activeServices: 0,
            residentTrips: 0,
            residentConnections: 0,
            residentPrepareMs: Number(residentPrepareMs.toFixed(3)),
            nationalConnectionScan: false,
          },
          search: {
            engine: 'rust_resident_timetable_kernel',
            reachedStops: 0,
            excludedRouteIds,
            excludedTripIds: [...excludedTripIds],
            excludedTrips: 0,
            excludedDepartures: 0,
            scannedDepartures: 0,
            expandedTripRuns: 0,
            dominatedTripBoardings: 0,
            relaxedStops: 0,
            explicitTransferChecks: 0,
            nativeQueryMs: 0,
            wallMs: 0,
          },
          transit,
          surface: surface ? {
            ...surface.diagnostics,
            owner: 'rust_resident_reach_pipeline',
            wallMs: Number((performance.now() - surfaceStarted).toFixed(3)),
          } : null,
          stopSelection: {
            candidates: 0,
            selected: 0,
            sampled: false,
            strategy: 'no_active_service',
            distanceSelection: 'none',
          },
          ...serviceDateDiagnostics(serviceDateResolution),
          totalMs: Number((performance.now() - started).toFixed(3)),
        },
      }
    }
    const error = new Error(
      `Resident timetable kernel is required for Reach: ${store.activeServiceKernelStatus?.detail ?? store.activeServiceKernelStatus?.reason ?? 'unavailable'}`,
    )
    error.code = 'resident_timetable_kernel_required'
    error.activeServiceKernel = activeServiceKernelSnapshot(store)
    throw error
  }
  report('targets', 0.20, 'Preparing every active timetable stop')
  checkCancelled()

  // Keep every active timetable stop. The complete reached-edge surface is
  // bounded only by the exact timetable cutoff and the declared walking
  // policy; no geographic envelope or distance heuristic is applied here.
  const targetSelectionStarted = performance.now()
  const targetSelectionKey = `${activeKernel.serviceKey}|all-active-timetable-stops`
  store.reachTargetCache ??= new Map()
  let targetSelection = boundedCacheGet(
    store.reachTargetCache,
    targetSelectionKey,
  )
  const targetSelectionCacheHit = Boolean(targetSelection)
  if (!targetSelection) {
    const targetStops = []
    const targetTimetableStops = []
    for (const [stopId, stop] of store.stopRecords) {
      if (
        ![0, 4].includes(numeric(stop.location_type, 0))
        || !Number.isFinite(stop.lon)
        || !Number.isFinite(stop.lat)
      ) continue
      const timetableStop = activeKernel.stopIndex.get(stopId)
      if (timetableStop === undefined) continue
      targetStops.push(stop)
      targetTimetableStops.push(timetableStop)
    }
    targetSelection = {
      targetStops,
      targetTimetableStops: Uint32Array.from(targetTimetableStops),
    }
    boundedCacheSet(
      store.reachTargetCache,
      targetSelectionKey,
      targetSelection,
      48,
    )
  }
  const { targetStops, targetTimetableStops } = targetSelection
  const targetSelectionMs = performance.now() - targetSelectionStarted
  const excludedRouteSet = new Set(excludedRouteIds)
  const excludedTrips = []
  for (let trip = 0; trip < activeKernel.routeIds.length; trip += 1) {
    if (
      excludedRouteSet.has(activeKernel.routeIds[trip])
      || excludedTripIds.has(activeKernel.tripIds?.[trip])
    ) excludedTrips.push(trip)
  }
  if (!targetStops.length && !scenarioOverlay?.stops.length) {
    report('surface', 0.76, 'Building the reach-owned pedestrian surface')
    const surfaceStarted = performance.now()
    const surface = annotateReachSurface(buildReachSurface(
      streetStorePath,
      surfaceRequest,
      [{ coordinate: origin, durationMinutes: 0 }],
      maxWalkKm,
      walkSpeedKph,
      cutoffMinutes,
    ), { transitSeedCount: 0, scenarioSeedCount: 0 })
    report('complete', 1, 'No transit stops reached')
    return {
      schemaVersion: 'vigo.result.reach.v1',
      stops: [],
      scenarioStops: [],
      surface,
      diagnostics: {
        owner: 'rust_resident_timetable_kernel',
        algorithm: 'rust_resident_generation_tagged_connection_scan_one_to_many',
        activeServiceKernel: activeServiceKernelSnapshot(store),
        stopSelection: {
            candidates: 0,
            selected: 0,
            sampled: false,
            strategy: 'all_active_timetable_stops',
            distanceSelection: 'none',
            cacheHit: targetSelectionCacheHit,
          queryMs: Number(targetSelectionMs.toFixed(3)),
        },
        surface: surface ? {
          ...surface.diagnostics,
          owner: 'rust_resident_reach_pipeline',
          wallMs: Number((performance.now() - surfaceStarted).toFixed(3)),
        } : null,
        transit: reachTransitStatus({
          services,
          activeKernel,
          departure,
          horizon,
          targetStopCount: 0,
          reachedStopCount: 0,
          earliestDeparture: earliestScheduledDeparture,
        }),
        totalMs: Number((performance.now() - started).toFixed(3)),
      },
    }
  }

  report('search', 0.42, `Scanning once for ${targetStops.length.toLocaleString()} surface stops`)
  checkCancelled()
  const searchStarted = performance.now()
  const explicitStopId = explicitRoutingStopId(request.origin)
  let routed
  let accessDiagnostics
  let overlayDiagnostics = null
  if (scenarioOverlay?.stops.length) {
    if (!streetStorePath) {
      throw new Error('Reach scenario overlays require a persisted OSM street store.')
    }
    const streetStorageIdentity = currentStreetStoreStorageIdentity(streetStorePath)
    const profileStarted = performance.now()
    const profile = nativeCoordinateAccessProfile(store, streetStorePath, streetStorageIdentity)
    const profilePrepareMs = performance.now() - profileStarted
    const transferTiming = {
      walkingSpeedKph: walkSpeedKph,
      accessPaddingFactor: 1,
      accessOverheadSeconds: 0,
    }
    let originSeeds
    let originAccess = null
    if (explicitStopId) {
      const accessStops = prepareAccessStops(
        store,
        request.origin,
        maxWalkKm,
        streetStorePath,
        streetStorageIdentity,
        'origin',
      )
      originSeeds = activeServiceKernelAccessSeeds(activeKernel, accessStops)
    } else {
      originAccess = routeNativeCoordinateFrontier(streetStorePath, {
        coordinate: origin,
        maximumWalkM: maxWalkKm * 1_000,
        role: 'origin',
        walkingSpeedKph: walkSpeedKph,
        accessPaddingFactor: nationalRoutingAccessPolicy.accessPaddingFactor,
        accessOverheadSeconds: nationalRoutingAccessPolicy.accessOverheadSeconds,
      })
      originSeeds = activeServiceKernelAccessSeeds(activeKernel, originAccess.candidates)
    }

    const baseStopCount = activeKernel.stopIds.length
    const combinedStopCount = baseStopCount + scenarioOverlay.stops.length
    const outgoing = Array.from({ length: combinedStopCount }, () => new Map())
    let endpointFrontierCalls = explicitStopId ? 0 : 1
    let endpointFrontierQueryMs = timingMilliseconds(originAccess?.diagnostics?.queryMs)
    for (let overlayStop = 0; overlayStop < scenarioOverlay.stops.length; overlayStop += 1) {
      checkCancelled()
      const stop = scenarioOverlay.stops[overlayStop]
      const combinedStop = baseStopCount + overlayStop
      const exactBaseStop = stop.stopId ? activeKernel.stopIndex.get(stop.stopId) : undefined
      if (exactBaseStop !== undefined) {
        retainOverlayTransfer(outgoing, exactBaseStop, combinedStop, 0)
        retainOverlayTransfer(outgoing, combinedStop, exactBaseStop, 0)
      }
      const [fromOverlay, toOverlay] = [
        routeNativeCoordinateFrontier(streetStorePath, {
          coordinate: stop.coordinate,
          maximumWalkM: maxWalkKm * 1_000,
          role: 'origin',
          ...transferTiming,
        }),
        routeNativeCoordinateFrontier(streetStorePath, {
          coordinate: stop.coordinate,
          maximumWalkM: maxWalkKm * 1_000,
          role: 'destination',
          ...transferTiming,
        }),
      ]
      endpointFrontierCalls += 2
      endpointFrontierQueryMs += timingMilliseconds(fromOverlay.diagnostics.queryMs)
        + timingMilliseconds(toOverlay.diagnostics.queryMs)
      for (const candidate of fromOverlay.candidates) {
        const baseStop = activeKernel.stopIndex.get(candidate.stop_id)
        if (baseStop !== undefined) {
          retainOverlayTransfer(outgoing, combinedStop, baseStop, candidate.accessSeconds)
        }
      }
      for (const candidate of toOverlay.candidates) {
        const baseStop = activeKernel.stopIndex.get(candidate.stop_id)
        if (baseStop !== undefined) {
          retainOverlayTransfer(outgoing, baseStop, combinedStop, candidate.accessSeconds)
        }
      }
    }

    const connectorStarted = performance.now()
    const connectors = routeNativeTimedConnectors(streetStorePath, {
      seeds: [{
        coordinate: origin,
        durationMinutes: 0,
        maxWalkKm,
      }],
      targets: scenarioOverlay.stops,
      includeTargetMatrix: true,
      maxWalkKm,
      walkSpeedKph,
      maximumDurationMinutes: cutoffMinutes,
    })
    for (let overlayStop = 0; overlayStop < connectors.arrivals.length; overlayStop += 1) {
      const arrival = connectors.arrivals[overlayStop]
      if (arrival?.status !== 'ready' || !Number.isFinite(arrival.durationMinutes)) continue
      originSeeds.push({
        stop: baseStopCount + overlayStop,
        walkSeconds: Math.ceil(arrival.durationMinutes * 60),
        candidateIndex: originSeeds.length,
      })
    }
    const matrix = connectors.matrix
    if (matrix?.size !== scenarioOverlay.stops.length || matrix.directed !== true) {
      throw new Error('Reach scenario overlay received an invalid directed street matrix.')
    }
    for (let from = 0; from < matrix.size; from += 1) {
      for (let to = 0; to < matrix.size; to += 1) {
        const durationMinutes = Number(matrix.durationsMinutes[from * matrix.size + to])
        if (Number.isFinite(durationMinutes)) {
          retainOverlayTransfer(
            outgoing,
            baseStopCount + from,
            baseStopCount + to,
            durationMinutes * 60,
          )
        }
      }
    }
    const supplemental = overlayTransferCsr(outgoing)
    routed = routeNativeTimetableOverlayMany(activeKernel, {
      originSeeds,
      destinationSeedSets: [
        ...Array.from(targetTimetableStops, (stop) => [{ stop, walkSeconds: 0 }]),
        ...scenarioOverlay.stops.map((_, index) => ([{
          stop: baseStopCount + index,
          walkSeconds: 0,
        }])),
      ],
      excludedTrips,
      departure,
      horizon,
      allowPreRideTransfers: true,
      overlay: {
        stopCount: scenarioOverlay.stops.length,
        directionOffsets: scenarioOverlay.directionOffsets,
        directionStops: scenarioOverlay.directionStops,
        directionStopOffsetsSeconds: scenarioOverlay.directionStopOffsetsSeconds,
        serviceStartSeconds: scenarioOverlay.serviceStartSeconds,
        serviceEndSeconds: scenarioOverlay.serviceEndSeconds,
        serviceHeadwaySeconds: scenarioOverlay.serviceHeadwaySeconds,
        supplementalTransferOffsets: supplemental.offsets,
        supplementalTransferTo: supplemental.to,
        supplementalTransferDuration: supplemental.duration,
      },
    })
    overlayDiagnostics = {
      stopCount: scenarioOverlay.stops.length,
      directionCount: scenarioOverlay.serviceStartSeconds.length,
      overlayConnections: routed.overlayConnections,
      overlayRuns: routed.overlayRuns,
      supplementalTransferEdges: routed.supplementalTransferEdges,
      compileMs: timingMilliseconds(routed.compileMs),
      scanMs: timingMilliseconds(routed.scanMs),
      transientBytes: routed.transientBytes,
      workspaceBytes: routed.workspaceBytes,
      connectorQueryMs: Number((performance.now() - connectorStarted).toFixed(3)),
      connectorAggregateCchAccelerated:
        connectors.diagnostics?.aggregateCchAccelerated === true,
      connectorAggregateCchQueryMs: timingMilliseconds(
        connectors.diagnostics?.aggregateCchQueryMs,
      ),
      connectorMatrixCchAccelerated:
        connectors.diagnostics?.matrixCchAccelerated === true,
      connectorMatrixCchQueryMs: timingMilliseconds(
        connectors.diagnostics?.matrixCchQueryMs,
      ),
      endpointFrontierCalls,
      endpointFrontierQueryMs: timingMilliseconds(endpointFrontierQueryMs),
      mixedBaselineScenarioTransfers: true,
    }
    accessDiagnostics = {
      owner: 'rust_resident_coordinate_and_connector_kernels',
      kernel: 'rust_query_scoped_scenario_overlay_access_v1',
      profileKey: profile.profile.profileKey,
      profilePrepareMs: Number(profilePrepareMs.toFixed(3)),
      origin: originAccess?.diagnostics ?? { selectedStop: true },
      connectors: connectors.diagnostics,
      nodeApiCalls: endpointFrontierCalls + 2,
      walkingPolicy: {
        ...nationalRoutingAccessPolicy,
        walkingSpeedKph: walkSpeedKph,
        queryScopedSpeed: true,
      },
    }
  } else if (!explicitStopId && streetStorePath) {
    const streetStorageIdentity = currentStreetStoreStorageIdentity(streetStorePath)
    const profileStarted = performance.now()
    const profile = nativeCoordinateAccessProfile(store, streetStorePath, streetStorageIdentity)
    const profilePrepareMs = performance.now() - profileStarted
    routed = routeNativeCoordinateTimetableMany(streetStorePath, activeKernel, {
      origin,
      maximumWalkM: maxWalkKm * 1_000,
      walkingSpeedKph: walkSpeedKph,
      accessPaddingFactor: nationalRoutingAccessPolicy.accessPaddingFactor,
      accessOverheadSeconds: nationalRoutingAccessPolicy.accessOverheadSeconds,
      targetTimetableStops,
      excludedTrips: Uint32Array.from(excludedTrips),
      departure,
      horizon,
      allowPreRideTransfers: false,
    })
    accessDiagnostics = {
      ...routed.diagnostics,
      profileKey: profile.profile.profileKey,
      profilePrepareMs: Number(profilePrepareMs.toFixed(3)),
      walkingPolicy: {
        ...nationalRoutingAccessPolicy,
        walkingSpeedKph: walkSpeedKph,
        queryScopedSpeed: true,
      },
    }
  } else {
    const accessStarted = performance.now()
    const streetStorageIdentity = currentStreetStoreStorageIdentity(streetStorePath)
    const accessStops = prepareAccessStops(
      store,
      request.origin,
      maxWalkKm,
      streetStorePath || undefined,
      streetStorageIdentity,
      'origin',
    )
    const originSeeds = activeServiceKernelAccessSeeds(activeKernel, accessStops)
    routed = routeNativeTimetableMany(activeKernel, {
      originSeeds,
      destinationSeedSets: Array.from(
        targetTimetableStops,
        (stop) => [{ stop, walkSeconds: 0 }],
      ),
      excludedTrips,
      departure,
      horizon,
      allowPreRideTransfers: true,
    })
    accessDiagnostics = {
      kernel: 'resident_exact_or_direct_coordinate_access',
      selectedStop: Boolean(explicitStopId),
      candidates: originSeeds.length,
      queryMs: Number((performance.now() - accessStarted).toFixed(3)),
      walkingPolicy: {
        ...nationalRoutingAccessPolicy,
        walkingSpeedKph: walkSpeedKph,
        queryScopedSpeed: true,
      },
      nodeApiCalls: 1,
    }
  }
  const timetable = routed.timetable ?? routed
  const bestArrivals = timetable.bestArrivals
  const overlayTargetCount = scenarioOverlay?.stops.length ?? 0
  if (
    !Array.isArray(bestArrivals)
    || bestArrivals.length !== targetStops.length + overlayTargetCount
  ) {
    throw new Error('Resident one-to-many timetable kernel returned an inconsistent target frontier.')
  }
  checkCancelled()
  const stops = []
  for (let index = 0; index < targetStops.length; index += 1) {
    const arrival = bestArrivals[index]
    if (!Number.isFinite(arrival) || arrival > horizon) continue
    const stop = targetStops[index]
    stops.push({
      id: `transit-stop:${stop.stop_id}`,
      label: String(stop.name || stop.stop_id),
      coordinate: [Number(stop.lon), Number(stop.lat)],
      source: 'stop',
      stopId: String(stop.stop_id),
      durationMinutes: Number(((arrival - departure) / 60).toFixed(3)),
    })
  }
  const scenarioStops = []
  for (let index = 0; index < overlayTargetCount; index += 1) {
    const arrival = bestArrivals[targetStops.length + index]
    if (!Number.isFinite(arrival) || arrival > horizon) continue
    const stop = scenarioOverlay.stops[index]
    scenarioStops.push({
      id: stop.id,
      label: stop.label,
      coordinate: stop.coordinate,
      source: 'scenario-stop',
      ...(stop.stopId ? { stopId: stop.stopId } : {}),
      durationMinutes: Number(((arrival - departure) / 60).toFixed(3)),
    })
  }
  const searchWallMs = performance.now() - searchStarted
  report('surface', 0.76, 'Building the reach-owned pedestrian surface')
  checkCancelled()
  const surfaceStarted = performance.now()
  const surface = annotateReachSurface(buildReachSurface(
    streetStorePath,
    surfaceRequest,
    [
      { coordinate: origin, durationMinutes: 0 },
      ...stops.map((stop) => ({
        coordinate: stop.coordinate,
        durationMinutes: stop.durationMinutes,
      })),
      ...scenarioStops.map((stop) => ({
        coordinate: stop.coordinate,
        durationMinutes: stop.durationMinutes,
      })),
    ],
    maxWalkKm,
    walkSpeedKph,
    cutoffMinutes,
  ), {
    transitSeedCount: stops.length,
    scenarioSeedCount: scenarioStops.length,
  })
  const surfaceWallMs = performance.now() - surfaceStarted
  checkCancelled()
  report('complete', 1, `${stops.length.toLocaleString()} reached stops`)
  return {
    schemaVersion: 'vigo.result.reach.v1',
    stops,
    scenarioStops,
    surface,
    diagnostics: {
      owner: 'rust_resident_timetable_kernel',
      algorithm: timetable.algorithm
        ?? 'rust_resident_generation_tagged_connection_scan_one_to_many',
      routingCoverage: supportedScheduledCoreCoverage(store),
      source: {
        stops: store.stopRecords.size,
        connections: store.connectionCount,
      },
      access: accessDiagnostics,
      timetable: {
        activeServices: services.size,
        residentTrips: activeKernel.tripIds.length,
        residentConnections: activeKernel.activeSegmentCount,
        compileMs: timingMilliseconds(activeKernel.compileMs),
        residentPrepareMs: Number(residentPrepareMs.toFixed(3)),
        nationalConnectionScan: true,
        ...(overlayDiagnostics ? { scenarioOverlay: overlayDiagnostics } : {}),
      },
      search: {
        engine: 'rust_resident_timetable_kernel',
        reachedStops: stops.length,
        excludedRouteIds,
        excludedTripIds: [...excludedTripIds],
        excludedTrips: excludedTrips.length,
        excludedDepartures: timetable.excludedDepartures ?? 0,
        scannedDepartures: timetable.scannedDepartures,
        expandedTripRuns: timetable.expandedTripRuns,
        dominatedTripBoardings: timetable.dominatedTripBoardings,
        relaxedStops: timetable.relaxedStops,
        explicitTransferChecks: timetable.explicitTransferChecks,
        nativeQueryMs: timingMilliseconds(timetable.queryMs),
        wallMs: Number(searchWallMs.toFixed(3)),
      },
      transit: reachTransitStatus({
        services,
        activeKernel,
        departure,
        horizon,
        targetStopCount: targetStops.length,
        reachedStopCount: stops.length,
        earliestDeparture: earliestScheduledDeparture,
      }),
      surface: surface ? {
        ...surface.diagnostics,
        owner: 'rust_resident_reach_pipeline',
        wallMs: Number(surfaceWallMs.toFixed(3)),
      } : null,
      stopSelection: {
        candidates: targetStops.length,
        selected: targetStops.length,
        sampled: false,
        limit: null,
        strategy: 'all_active_timetable_stops',
        proof: 'no_geographic_pruning',
        distanceSelection: 'none',
        maximumWalkKm: maxWalkKm,
        cacheHit: targetSelectionCacheHit,
        queryMs: Number(targetSelectionMs.toFixed(3)),
      },
      activeServiceKernel: activeServiceKernelSnapshot(store),
      ...serviceDateDiagnostics(serviceDateResolution),
      totalMs: Number((performance.now() - started).toFixed(3)),
    },
  }
}


function routingHorizonMinutes(request) {
  const minutes = Number(request.horizonMinutes)
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.min(2_880, minutes)) : 480
}

function transitRideRequired(request) {
  return request?.requireTransitRide !== false || request?.__disableDirectWalkDominance === true
}

function validateTransitRideRequirement(request) {
  if (request.requireTransitRide != null && typeof request.requireTransitRide !== 'boolean') {
    throw new Error('requireTransitRide must be a boolean.')
  }
}

export function routeNationalGtfsMatrix(storePath, request) {
  validateTransitRideRequirement(request)
  validateMaximumTransfers(request.maxTransfers)
  if (request.includeJourneys != null && typeof request.includeJourneys !== 'boolean') {
    throw new Error('Matrix includeJourneys must be a boolean.')
  }
  if (request.includeGeometry != null && (typeof request.includeGeometry !== 'boolean'
    || (request.includeGeometry && request.includeJourneys !== true))) {
    throw new Error('Matrix includeGeometry requires includeJourneys: true.')
  }
  if (request.includeJourneys === true && request.routingPreference === 'balanced') {
    throw new Error('Matrix journeys currently use the exact fastest/deadline objective. Balanced alternatives require Route.')
  }
  const started = performance.now()
  const result = routeNationalGtfsTransitMatrix(storePath, request)
  if (!request.streetStorePath || transitRideRequired(request)
    || result.diagnostics.failure?.code === 'unsupported_gtfs_feature') return result

  const horizonMinutes = routingHorizonMinutes(request)
  const walks = routeNationalStreetMatrix(request.streetStorePath, {
    origins: request.origins,
    destinations: request.destinations,
    mode: 'walk',
    walkingSpeedKph,
    maxDistanceKm: Math.min(directWalkEndToEndLimitKm(request), horizonMinutes / 60 * walkingSpeedKph),
  })
  let selectedWalkPairs = 0
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index]
    const walk = walks.rows[index]
    // A selected stop is a distinct transit endpoint contract: preserve a
    // blocked exact-stop result, just as the scalar Route fallback does.
    if (row.status !== 'ready' && (
      explicitRoutingStopId(request.origins[row.originIndex])
      || explicitRoutingStopId(request.destinations[row.destinationIndex])
    )) continue
    if (walk.status !== 'ready' || walk.durationMinutes > horizonMinutes + 1e-9
      || (request.timePreference === 'arrive' && walk.durationMinutes > row.arriveMinutes)
      || (row.status === 'ready' && row.durationMinutes <= walk.durationMinutes)) continue
    row.status = 'ready'
    if (request.timePreference === 'arrive') {
      row.departMinutes = minuteCoordinate((row.arriveMinutes - walk.durationMinutes) * 60)
    } else {
      row.arriveMinutes = minuteCoordinate((row.departMinutes + walk.durationMinutes) * 60)
    }
    row.durationMinutes = secondsToMinutes(walk.durationMinutes * 60)
    if (request.includeJourneys === true) {
      row.journey = { departMinutes: row.departMinutes, arriveMinutes: row.arriveMinutes,
        durationMinutes: row.durationMinutes, transfers: 0, walkMinutes: row.durationMinutes,
        rideMinutes: 0, waitMinutes: 0, legs: [{ type: 'walk', startMinutes: row.departMinutes,
          endMinutes: row.arriveMinutes, durationMinutes: row.durationMinutes, distanceKm: walk.distanceKm }] }
      if (request.includeGeometry === true) {
        const origin = request.origins[row.originIndex], destination = request.destinations[row.destinationIndex]
        const path = streetPathBetween(request.streetStorePath, origin.coordinate, destination.coordinate,
          directWalkEndToEndLimitKm(request))
        if (!path) throw new Error('Matrix selected walk could not be materialized.')
        row.journey = materializeDirectWalkCandidate({ ...request, origin, destination }, request.maxWalkKm, path)
      }
    }
    delete row.failureCode
    selectedWalkPairs += 1
  }
  if (selectedWalkPairs && result.diagnostics.failure) {
    result.diagnostics.transitFailure = result.diagnostics.failure
    delete result.diagnostics.failure
  }
  result.diagnostics.directWalk = {
    matrixEngine: walks.diagnostics.matrixEngine,
    selectedPairs: selectedWalkPairs,
    maximumDistanceKm: walks.diagnostics.maximumDistanceKm,
    queryMs: walks.diagnostics.queryMs,
  }
  result.diagnostics.queryMs = Number((performance.now() - started).toFixed(3))
  return result
}

function matrixJourney(kernel, journey) {
  return {
    departMinutes: minuteCoordinate(journey.departure), arriveMinutes: minuteCoordinate(journey.arrival),
    durationMinutes: secondsToMinutes(journey.arrival - journey.departure),
    transfers: Math.max(0, journey.boardings - 1), walkMinutes: secondsToMinutes(journey.walkingSeconds),
    rideMinutes: secondsToMinutes(journey.rideSeconds), waitMinutes: secondsToMinutes(journey.waitingSeconds),
    legs: journey.legs.map((leg) => ({
      type: leg.kind, fromStopId: kernel.stopIds[leg.fromStop] ?? null, toStopId: kernel.stopIds[leg.toStop] ?? null,
      startMinutes: minuteCoordinate(leg.departure), endMinutes: minuteCoordinate(leg.arrival),
      durationMinutes: secondsToMinutes(leg.arrival - leg.departure),
      ...(leg.kind === 'ride' ? { tripId: kernel.tripIds[leg.trip],
        boardSequence: leg.boardSequence, alightSequence: leg.alightSequence } : {}),
    })),
  }
}

function materializeMatrixJourney(store, kernel, journey, context) {
  const { request, maxWalkKm, streetStorageIdentity } = context
  // Both endpoint tokens must belong to the same native coordinate query.
  const pair = prepareNativeCoordinateAccessPair(store, request.origin, request.destination,
    maxWalkKm, request.streetStorePath, streetStorageIdentity)
  const originStops = pair?.origin ?? preparePointAccessStops(store, request.origin, maxWalkKm,
    request.streetStorePath, streetStorageIdentity, 'origin')
  const destinationStops = pair?.destination ?? preparePointAccessStops(store, request.destination, maxWalkKm,
    request.streetStorePath, streetStorageIdentity, 'destination')
  const first = journey.legs[0], last = journey.legs.at(-1)
  const candidate = (stops, stop, seconds) => stops.findIndex((entry) => entry.stop_id === kernel.stopIds[stop]
    && Math.abs(accessWalkSeconds(entry) - seconds) < 1e-7)
  const originCandidate = candidate(originStops, first.toStop, first.arrival - first.departure)
  const destinationCandidate = candidate(destinationStops, last.fromStop, last.arrival - last.departure)
  if (originCandidate < 0 || destinationCandidate < 0) throw new Error('Matrix journey endpoint witness changed during materialization.')
  const chain = journey.legs.slice(0, -1).map((leg, i) => i === 0
    ? { kind: 'access', candidateIndex: originCandidate, toStopId: kernel.stopIds[leg.toStop], arrival: leg.arrival }
    : leg.kind === 'walk' ? { kind: 'transfer', fromStopId: kernel.stopIds[leg.fromStop],
      toStopId: kernel.stopIds[leg.toStop], arrival: leg.arrival, duration: leg.arrival - leg.departure }
      : { kind: 'ride', kernelTripIndex: leg.trip, tripId: kernel.tripIds[leg.trip],
        fromStopId: kernel.stopIds[leg.fromStop], toStopId: kernel.stopIds[leg.toStop],
        boardingStopSequence: leg.boardSequence, alightingStopSequence: leg.alightSequence })
  const plan = materializeActiveServiceKernelPlan(store, kernel, {
    supported: true, status: 'ready', chain, bestArrival: journey.arrival, bestBoardings: journey.boardings,
    bestDestinationIndex: destinationCandidate, paretoFrontier: true, certifier: 'rust_shared_journey_rounds',
    deadlineObjective: request.timePreference === 'arrive',
    queryMs: 0, scannedDepartures: 0, relaxedStops: 0, expandedTripRuns: 0, explicitTransferChecks: 0,
  }, { ...context, request: { ...request, returnedStationCyclePolicy: 'represented' },
    origin: request.origin, destination: request.destination, originStops, destinationStops,
    departure: journey.departure, departureMinutes: journey.departure / 60,
    accessPreparationMs: 0, serviceActivationMs: 0 })
  if (!plan) throw new Error('Matrix journey could not be materialized.')
  Object.assign(plan.diagnostics, { algorithm: 'rust_shared_journey_rounds', dataSemantics: store.routingDataSemantics })
  plan.diagnostics.searchStats.timingScope = 'matrix_journey_materialization'
  return { ...plan, timePreference: request.timePreference ?? 'depart' }
}

function routeNationalGtfsTransitMatrix(storePath, request) {
  const started = performance.now()
  const origins = Array.isArray(request?.origins) ? request.origins : []
  const destinations = Array.isArray(request?.destinations) ? request.destinations : []
  assertMatrixSize(origins.length, destinations.length)
  request = withResolvedServiceDay(request)
  if (request.timePreference != null && !['depart', 'arrive'].includes(request.timePreference)) {
    throw new Error('Matrix timePreference must be depart or arrive.')
  }
  const arriveBy = request.timePreference === 'arrive'
  const queryMode = arriveBy ? 'arrive_by_transit_time_only' : 'depart_at_transit_time_only'
  const store = openNationalStore(storePath)
  const routingCoverage = supportedScheduledCoreCoverage(store)
  const anchorMinutes = integralRoutingMinute(
    arriveBy ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes : request.departMinutes,
    arriveBy ? 'arriveMinutes' : 'departMinutes',
  )
  const anchor = Math.round(anchorMinutes * 60)
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
  const matrixHorizonMinutes = routingHorizonMinutes(request)
  const departure = arriveBy ? Math.max(0, anchor - matrixHorizonMinutes * 60) : anchor
  const horizon = arriveBy ? anchor : anchor + matrixHorizonMinutes * 60
  const blockedTimes = { departMinutes: arriveBy ? null : anchorMinutes, arriveMinutes: arriveBy ? anchorMinutes : null, durationMinutes: null }
  const representativeSnapshot = request.allowServiceDateFallback === true && request.serviceDateFallbackPolicy === 'representative-snapshot'
  const serviceDateResolution = resolveServiceDate(store, request.serviceDate, request.serviceDay, representativeSnapshot)
  if (store.blockingRoutingFeatures.length) {
    return {
      schemaVersion: 'vigo.routing.matrix.v1',
      rows: origins.flatMap((_, originIndex) => destinations.map((__, destinationIndex) => ({
        originIndex,
        destinationIndex,
        status: 'blocked',
        failureCode: 'unsupported_gtfs_feature',
        ...blockedTimes,
      }))),
      diagnostics: {
        matrixStrategy: 'not_run',
        queryMode,
        routingCoverage,
        failure: {
          code: 'unsupported_gtfs_feature',
          category: 'unsupported_feature',
          features: store.blockingRoutingFeatures,
        },
        queryMs: Number((performance.now() - started).toFixed(3)),
      },
    }
  }
  if (requiredServiceCoverageIncomplete(request, serviceDateResolution)) {
    return {
      schemaVersion: 'vigo.routing.matrix.v1',
      rows: origins.flatMap((_, originIndex) => destinations.map((__, destinationIndex) => ({
        originIndex,
        destinationIndex,
        status: 'blocked',
        failureCode: 'coverage_incomplete',
        ...blockedTimes,
      }))),
      diagnostics: {
        matrixStrategy: 'not_run',
        queryMode,
        routingCoverage,
        failure: {
          code: 'coverage_incomplete',
          category: 'data_coverage',
          retryable: false,
          message: `Only ${serviceDateResolution.resolvedServiceScopeCount} of ${serviceDateResolution.availableServiceScopeCount} required feed scopes have service on ${serviceDateResolution.resolvedServiceDate}.`,
        },
        ...serviceDateDiagnostics(serviceDateResolution),
        queryMs: Number((performance.now() - started).toFixed(3)),
      },
    }
  }
  const services = activateServices(store, serviceDateResolution.resolvedServiceDate, request.serviceDay)
  const activeKernel = ensureActiveServiceKernel(store, services).kernel
  if (!activeKernel) {
    if (['no_active_segments', 'no_active_services'].includes(store.activeServiceKernelStatus?.reason)) {
      const failureCode = store.activeServiceKernelStatus.reason
      return {
        schemaVersion: 'vigo.routing.matrix.v1',
        rows: origins.flatMap((_, originIndex) => destinations.map((__, destinationIndex) => ({
          originIndex,
          destinationIndex,
          status: 'blocked',
          failureCode,
          ...blockedTimes,
        }))),
        diagnostics: {
          matrixStrategy: 'not_run',
          matrixEngine: 'resident_timetable_kernel',
          queryMode,
          routingCoverage,
          activeServices: services.size,
          failure: {
            code: failureCode,
            category: 'no_active_service',
            retryable: false,
            message: 'The selected service set contains no boarding-to-alighting connection supported by the routing contract.',
          },
          activeServiceKernel: activeServiceKernelSnapshot(store),
          serviceDateFallbackPolicy: representativeSnapshot ? 'representative-snapshot' : 'exact',
          ...serviceDateDiagnostics(serviceDateResolution),
          queryMs: Number((performance.now() - started).toFixed(3)),
        },
      }
    }
    const error = new Error(
      `Resident timetable kernel is required for matrix routing: ${store.activeServiceKernelStatus?.detail ?? store.activeServiceKernelStatus?.reason ?? 'unavailable'}`,
    )
    error.code = 'resident_timetable_kernel_required'
    error.activeServiceKernel = activeServiceKernelSnapshot(store)
    throw error
  }

  const uniqueOrigins = []
  const originLookup = new Map()
  const originIndexes = origins.map((point) => {
    const key = pointKey(point)
    if (!originLookup.has(key)) {
      originLookup.set(key, uniqueOrigins.length)
      uniqueOrigins.push(point)
    }
    return originLookup.get(key)
  })
  const uniqueDestinations = []
  const destinationLookup = new Map()
  const destinationIndexes = destinations.map((point) => {
    const key = pointKey(point)
    if (!destinationLookup.has(key)) {
      destinationLookup.set(key, uniqueDestinations.length)
      uniqueDestinations.push(point)
    }
    return destinationLookup.get(key)
  })
  // Uniform scalar search for every City and every OD set.
  const matrixStrategy = 'shared'
  const streetStorageIdentity = currentStreetStoreStorageIdentity(request.streetStorePath)
  let search
  const coordinateOnly = request.streetStorePath
    && uniqueOrigins.every((point) => !explicitRoutingStopId(point))
    && uniqueDestinations.every((point) => !explicitRoutingStopId(point))
  if (coordinateOnly) {
    nativeCoordinateAccessProfile(store, request.streetStorePath, streetStorageIdentity)
    search = routeNativeCoordinateTimetableMatrix(request.streetStorePath, activeKernel, {
      origins: uniqueOrigins, destinations: uniqueDestinations, maximumWalkM: maxWalkKm * 1000,
      departure, horizon, arriveBy, maxTransfers: request.maxTransfers, includeJourneys: request.includeJourneys,
    })
  } else {
    const destinationSeedSets = uniqueDestinations.map((point) => activeServiceKernelAccessSeeds(activeKernel,
      preparePointAccessStops(store, point, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'destination')))
    const originSeedSets = uniqueOrigins.map((point) => activeServiceKernelAccessSeeds(activeKernel,
      preparePointAccessStops(store, point, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'origin')))
    search = routeNativeTimetableMatrix(activeKernel, {
      originSeedSets, destinationSeedSets, maxTransfers: request.maxTransfers,
      allowPreRideTransfers: uniqueOrigins.map((point) => !request.streetStorePath || Boolean(explicitRoutingStopId(point))),
      allowPostRideTransfers: uniqueDestinations.map((point) => !request.streetStorePath || Boolean(explicitRoutingStopId(point))),
      departure, horizon, arriveBy, includeJourneys: request.includeJourneys,
    })
  }
  const rows = new Array(origins.length * destinations.length)
  let rowIndex = 0
  for (let originIndex = 0; originIndex < origins.length; originIndex += 1) {
    for (let destinationIndex = 0; destinationIndex < destinations.length; destinationIndex += 1) {
      const cell = originIndexes[originIndex] * uniqueDestinations.length + destinationIndexes[destinationIndex]
      const time = search.times[cell]
      const ready = Number.isFinite(time)
      rows[rowIndex] = {
        originIndex,
        destinationIndex,
        status: ready ? 'ready' : 'blocked',
        departMinutes: arriveBy ? (ready ? minuteCoordinate(time) : null) : anchorMinutes,
        arriveMinutes: arriveBy ? anchorMinutes : (ready ? minuteCoordinate(time) : null),
        durationMinutes: ready ? secondsToMinutes(arriveBy ? anchor - time : time - anchor) : null,
        ...(request.includeJourneys === true ? { journey: search.journeys?.[cell]
          ? request.includeGeometry === true
            ? materializeMatrixJourney(store, activeKernel, search.journeys[cell], {
              request: { ...request, origin: origins[originIndex], destination: destinations[destinationIndex] },
              maxWalkKm, streetStorageIdentity, horizon, services, serviceDateResolution, startedAt: performance.now(),
            }) : matrixJourney(activeKernel, search.journeys[cell]) : null } : {}),
      }
      rowIndex += 1
    }
  }
  return {
    schemaVersion: 'vigo.routing.matrix.v1',
    rows,
    diagnostics: {
      matrixStrategy,
      matrixEngine: request.includeJourneys === true ? 'rust_shared_journey_rounds'
        : arriveBy ? 'rust_exact_reverse_connection_scan_many_to_one' : 'rust_exact_connection_scan_one_to_many',
      queryMode: request.includeJourneys === true ? (arriveBy ? 'arrive_by_transit_journeys' : 'depart_at_transit_journeys') : queryMode,
      timePreference: arriveBy ? 'arrive' : 'depart',
      ...(arriveBy ? { arrivalSemantics: 'deadline_including_destination_wait' } : {}),
      routingCoverage,
      optimality: routingCoverage.complete ? (arriveBy ? 'latest_departure_within_supported_feed' : 'earliest_arrival_within_supported_feed') : 'travel_times_within_supported_scheduled_core',
      origins: origins.length,
      destinations: destinations.length,
      pairs: rows.length,
      uniqueOrigins: uniqueOrigins.length,
      uniqueDestinations: uniqueDestinations.length,
      forwardSearches: search.forwardSearches,
      reverseSearches: search.reverseSearches,
      coordinateAccessExecution: coordinateOnly ? 'rust_fused_matrix' : 'endpoint_adapter',
      ...(coordinateOnly ? { coordinateAccessMs: search.accessMs, coordinateMatrixMs: search.coordinateMatrixMs } : {}),
      originAccessComputations: uniqueOrigins.length,
      destinationAccessComputations: uniqueDestinations.length,
      activeServices: services.size,
      serviceDateFallbackPolicy: representativeSnapshot ? 'representative-snapshot' : 'exact',
      ...serviceDateDiagnostics(serviceDateResolution),
      scannedDepartures: search.scannedDepartures,
      upperBoundSeedScans: 0,
      seededDestinationUpperBounds: 0,
      upperBoundedForwardSearches: 0,
      poppedStates: 0,
      relaxedStops: search.relaxedStops,
      expandedTripRuns: search.expandedTripRuns,
      dominatedTripBoardings: search.dominatedTripBoardings,
      explicitTransferChecks: search.explicitTransferChecks,
      engineQueryMs: timingMilliseconds(search.queryMs),
      returnedStationCyclePolicy: 'represented',
      memoryBudgetFallbacks: 0,
      queryMs: Number((performance.now() - started).toFixed(3)),
    },
  }
}

function routeNationalGtfsArriveByStore(
  storePath,
  request,
  streetStorageIdentity = currentStreetStoreStorageIdentity(request.streetStorePath),
) {
  const store = openNationalStore(storePath)
  const started = performance.now()
  const targetMinutes = numeric(request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes, 8 * 60)
  const deadline = Math.round(targetMinutes * 60)
  const horizonSeconds = routingHorizonMinutes(request) * 60
  const earliest = Math.max(0, deadline - horizonSeconds)
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
  const serviceDateResolution = resolveServiceDate(
    store,
    request.serviceDate,
    request.serviceDay,
    request.__serviceDateFallbackRetry === true || (store.serviceModel === 'weekday-template' && request.allowServiceDateFallback === true),
  )
  if (requiredServiceCoverageIncomplete(request, serviceDateResolution)) {
    const retry = fallbackRetryRequest(store, request)
    if (retry) return routeNationalGtfsStore(storePath, retry)
    const blocked = incompleteServiceCoveragePlan(request, earliest / 60, maxWalkKm, serviceDateResolution)
    return { ...blocked, timePreference: 'arrive', choiceLabel: 'No complete timetable' }
  }
  const serviceActivationStartedAt = performance.now()
  const services = activateServices(store, serviceDateResolution.resolvedServiceDate, request.serviceDay)
  const serviceActivationMs = Number((performance.now() - serviceActivationStartedAt).toFixed(3))
  if (!services.size) {
    const retry = fallbackRetryRequest(store, request)
    if (retry) {
      const retryAccess = prepareRequestLocalNativeCoordinateAccessPair(
        request,
        store,
        request.origin,
        request.destination,
        maxWalkKm,
        request.streetStorePath,
        streetStorageIdentity,
      )
      return routeNationalGtfsStore(
        storePath,
        attachPreparedNativeCoordinateAccessPair(retry, retryAccess.prepared),
      )
    }
    const blocked = blockedPlan(request, earliest / 60, maxWalkKm, 'No active service', `No GTFS service is active on ${serviceDateResolution.resolvedServiceDate}.`, { originStops: 0, destinationStops: 0 }, serviceDateResolution)
    return { ...blocked, timePreference: 'arrive', choiceLabel: 'No arrive-by itinerary' }
  }
  const activeKernelReadiness = ensureActiveServiceKernel(store, services)
  const activeKernel = activeKernelReadiness.kernel
  if (!activeKernel) {
    const error = new Error(
      `Resident timetable kernel is required for arrive-by routing: ${store.activeServiceKernelStatus?.detail ?? store.activeServiceKernelStatus?.reason ?? 'unavailable'}`,
    )
    error.code = 'resident_timetable_kernel_required'
    error.activeServiceKernel = activeServiceKernelSnapshot(store)
    throw error
  }
  const kernel = activeKernel
  const fusedCoordinateEligible = Boolean(
    request.routingPreference !== 'balanced'
    && request.streetStorePath
    && !request?.[preparedNativeCoordinateAccessPair]
    && !explicitRoutingStopId(request.origin)
    && !explicitRoutingStopId(request.destination)
    && Array.isArray(request.origin?.coordinate)
    && request.origin.coordinate.length === 2
    && request.origin.coordinate.every(Number.isFinite)
    && Array.isArray(request.destination?.coordinate)
    && request.destination.coordinate.length === 2
    && request.destination.coordinate.every(Number.isFinite)
  )
  let fusedCoordinateTimetable = null
  let fusedForwardSearch = null
  let requestLocalCoordinateAccess
  let nativeCoordinateAccess
  let preparedArriveByCoordinateAccess = null
  let originStops
  let destinationStops
  if (fusedCoordinateEligible) {
    const profileReadinessStartedAt = performance.now()
    const profile = nativeCoordinateAccessProfile(
      store,
      request.streetStorePath,
      streetStorageIdentity,
    )
    const profileReadinessMs = performance.now() - profileReadinessStartedAt
    const routed = routeNativeCoordinateTimetableScalar(
      request.streetStorePath,
      kernel,
      {
        origin: request.origin.coordinate,
        destination: request.destination.coordinate,
        maximumWalkM: maxWalkKm * 1000,
        departure: earliest,
        horizon: deadline,
        arriveByEarliest: earliest,
        arriveByDeadline: deadline,
        allowPreRideTransfers: false,
        maxTransfers: request.maxTransfers,
        retainFullFrontier: true,
        enableDirectWalkDominance: false,
        disableCache: request.__disableNativeStreetPathCache === true,
      },
    )
    fusedCoordinateTimetable = routed
    const fusedAccessWallMs = Math.max(
      routed.accessMs,
      routed.nodeApiWallMs - routed.timetableMs,
    )
    nativeCoordinateAccess = {
      endpoints: routed.endpoints,
      diagnostics: {
        ...routed.diagnostics,
        profileReadinessMs,
        pairPreparationMs: fusedAccessWallMs,
        candidateRestrictionMs: 0,
        accessOrchestrationMs: 0,
        accessProfile: profile.diagnostics,
      },
    }
    const candidateAssemblyStartedAt = performance.now()
    fusedForwardSearch = routed.timetable
      ? activeServiceKernelSearchFromNativeScalar(kernel, routed.timetable, routed)
      : null
    if (routed.arriveBy?.status === 'ready') {
      originStops = materializeNativeCoordinateEndpointCandidates(
        request.streetStorePath,
        routed.endpoints,
        'origin',
      )
      destinationStops = materializeNativeCoordinateEndpointCandidates(
        request.streetStorePath,
        routed.endpoints,
        'destination',
      )
    } else {
      originStops = new Array(routed.originCandidateCount)
      destinationStops = new Array(routed.destinationCandidateCount)
    }
    nativeCoordinateAccess.origin = originStops
    nativeCoordinateAccess.destination = destinationStops
    const candidateAssemblyMs = performance.now() - candidateAssemblyStartedAt
    nativeCoordinateAccess.diagnostics.candidateAssemblyMs = candidateAssemblyMs
    const requestMs = Number((
      profileReadinessMs + fusedAccessWallMs + candidateAssemblyMs
    ).toFixed(3))
    if (!routed.compactFrontier && routed.arriveBy?.status === 'ready') {
      preparedArriveByCoordinateAccess = bindPreparedNativeCoordinateAccessPair(
        store,
        request.origin,
        request.destination,
        maxWalkKm,
        request.streetStorePath,
        streetStorageIdentity,
        nativeCoordinateAccess,
        requestMs,
      )
    }
    requestLocalCoordinateAccess = {
      accessPair: nativeCoordinateAccess,
      prepared: preparedArriveByCoordinateAccess,
      preparedHere: true,
      inherited: false,
      requestMs,
    }
  } else {
    requestLocalCoordinateAccess = prepareRequestLocalNativeCoordinateAccessPair(
      request,
      store,
      request.origin,
      request.destination,
      maxWalkKm,
      request.streetStorePath,
      streetStorageIdentity,
    )
    nativeCoordinateAccess = requestLocalCoordinateAccess.accessPair
    preparedArriveByCoordinateAccess = requestLocalCoordinateAccess.prepared
    originStops = nativeCoordinateAccess?.origin
      ?? preparePointAccessStops(store, request.origin, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'origin')
    destinationStops = nativeCoordinateAccess?.destination
      ?? preparePointAccessStops(store, request.destination, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'destination')
  }
  const arriveByCoordinateAccessReuseStart =
    preparedArriveByCoordinateAccess?.reuseCount ?? 0
  const fallbackRetryWithPreparedCoordinateAccess = () => {
    if (!preparedArriveByCoordinateAccess && fusedCoordinateTimetable) {
      ensureRecoverySeeds()
    }
    return fallbackRetryRequest(
      store,
      attachPreparedNativeCoordinateAccessPair(
        { ...request },
        preparedArriveByCoordinateAccess,
      ),
    )
  }
  if (!originStops.length || !destinationStops.length) {
    const accessAvailability = {
      origin: accessAvailabilityHint(
        store,
        request.origin,
        originStops,
        maxWalkKm,
        request.streetStorePath,
        streetStorageIdentity,
        'origin',
      ),
      destination: accessAvailabilityHint(
        store,
        request.destination,
        destinationStops,
        maxWalkKm,
        request.streetStorePath,
        streetStorageIdentity,
        'destination',
      ),
    }
    const blocked = blockedPlan(request, earliest / 60, maxWalkKm, 'No reachable station', 'No station is reachable within the selected walking budget.', { originStops: originStops.length, destinationStops: destinationStops.length, accessAvailability }, serviceDateResolution)
    return { ...blocked, timePreference: 'arrive', choiceLabel: 'No arrive-by itinerary' }
  }
  const allowPreRideTransfers =
    !request.streetStorePath || Boolean(explicitRoutingStopId(request.origin))

  const planMeetsArriveByDeadline = (plan) => {
    if (plan.status !== 'ready') return false
    const selectedArrivalSeconds = numeric(
      plan.diagnostics?.searchStats?.selectedArrivalSeconds,
      Math.round(Number(plan.arriveMinutes) * 60),
    )
    return selectedArrivalSeconds <= deadline
  }
  const materializeFastestThroughPublicRoute = (candidateSeconds) => {
    const plan = routeNationalGtfsStore(storePath, attachPreparedNativeCoordinateAccessPair({
      ...request,
      timePreference: 'depart',
      departMinutes: candidateSeconds / 60,
      // The public API accepts integral minutes; arrive-by's native boundary
      // is exact to the second and needs this private internal precision when
      // it materializes a candidate for final verification.
      __allowSubMinuteTimes: true,
      routingPreference: 'fastest',
      __disableDirectWalkDominance: true,
      __suppressServiceDateFallback: true,
    }, preparedArriveByCoordinateAccess))
    return planMeetsArriveByDeadline(plan) ? plan : null
  }
  const materializeFastest = (candidateSeconds) => {
    if (request.routingPreference === 'balanced') {
      return materializeFastestThroughPublicRoute(candidateSeconds)
    }
    const candidateRequest = {
      ...request,
      timePreference: 'depart',
      departMinutes: candidateSeconds / 60,
      __allowSubMinuteTimes: true,
      routingPreference: 'fastest',
      __disableDirectWalkDominance: true,
      __suppressServiceDateFallback: true,
    }
    const fusedBoundaryMatches = fusedCoordinateTimetable?.arriveBy
      && Math.abs(
        numeric(fusedCoordinateTimetable.arriveBy.latestDeparture, Number.NaN)
          - candidateSeconds,
      ) <= 1e-9
    const candidateHorizon = deadline
    if (!fusedBoundaryMatches && fusedCoordinateTimetable?.compactFrontier) {
      return materializeFastestThroughPublicRoute(candidateSeconds)
    }
    const search = fusedBoundaryMatches && fusedForwardSearch
      ? fusedForwardSearch
      : searchActiveServiceKernelNativeScalar(
          kernel,
          originStops,
          destinationStops,
          candidateSeconds,
          candidateHorizon,
          allowPreRideTransfers,
          request.maxTransfers,
        )
    if (search.supported !== true || search.status !== 'ready') return null

    const candidateBoardings = search.chain.reduce(
      (count, step) => count + (step.kind === 'ride' ? 1 : 0),
      0,
    )
    let selectedSearch = search
    let paretoSearch = null
    const nativeTimetableKernel = {
      schemaVersion: 'vigo.routing.native-timetable.v3',
      engineQueryMs: timingMilliseconds(search.queryMs),
      scalar: search.nativeTimetableKernel,
    }
    if (candidateBoardings >= 1) {
      paretoSearch = searchActiveServiceKernelNativePareto(
        kernel,
        originStops,
        destinationStops,
        candidateSeconds,
        candidateHorizon,
        allowPreRideTransfers,
        search,
        {
          allowPreRideTransfers,
          deadlineObjective: true,
          optimizeGeneralizedCost: false,
          arrivalSlackSeconds: Math.max(0, deadline - search.bestArrival),
          transferPenaltySeconds: balancedTransferPenaltySeconds,
          walkReluctance: balancedWalkReluctance,
        },
      )
      if (
        paretoSearch.supported !== true
        || paretoSearch.status !== 'ready'
        || numeric(paretoSearch.bestArrival) > deadline
      ) {
        throw new Error(`Required Rust deadline search failed: ${paretoSearch.reason ?? paretoSearch.status}`)
      }
      selectedSearch = paretoSearch
      Object.assign(nativeTimetableKernel, {
        paretoSelected: true,
        engineQueryMs: timingMilliseconds(
          timingMilliseconds(search.queryMs)
            + timingMilliseconds(paretoSearch.queryMs),
        ),
        pareto: paretoSearch.nativeTimetableKernel,
      })
    }

    let candidatePlan = materializeActiveServiceKernelPlan(store, kernel, selectedSearch, {
      request: candidateRequest,
      origin: request.origin,
      destination: request.destination,
      originStops,
      destinationStops,
      departureMinutes: candidateSeconds / 60,
      departure: candidateSeconds,
      horizon: candidateHorizon,
      maxWalkKm,
      serviceDateResolution,
      services,
      startedAt: started,
      accessPreparationMs: requestLocalCoordinateAccess.requestMs,
      serviceActivationMs,
      serviceKernelPreparationMs: activeKernelReadiness.preparationMs ?? 0,
      nativeTimetableKernel,
      streetStorageIdentity,
      nativeCoordinateAccess,
    })
    if (!candidatePlan) return null
    candidatePlan = decorateActiveServiceKernelParetoPlan(
      candidatePlan,
      search,
      paretoSearch,
      candidateBoardings,
    )
    candidatePlan = withReturnedStationAdvisory(store, candidatePlan)
    return planMeetsArriveByDeadline(candidatePlan) ? candidatePlan : null
  }
  let requestedPreferenceVerificationPerformed = false
  let requestedPreferenceMetDeadline = null
  const decorate = (
    plan,
    boundary,
    forwardParityRecovery = null,
    materializationSearches = 1,
  ) => {
    const recoveredByDirectWalk = forwardParityRecovery?.outcome?.startsWith('direct_walk_') === true
    const candidateCount = forwardParityRecovery?.reproducedCandidateCount
      ?? boundary.candidateCount
    return {
    ...plan,
    id: `${plan.id}-arrive-${targetMinutes}`,
    timePreference: 'arrive',
    choiceLabel: 'Latest departure',
    recommended: true,
    diagnostics: {
      ...plan.diagnostics,
      algorithm: recoveredByDirectWalk
        ? 'rust_arrive_by_reverse_upper_bound_plus_osm_direct_walk_certificate'
        : forwardParityRecovery
          ? 'rust_arrive_by_reverse_scan_plus_complete_public_candidate_recovery'
          : 'rust_exact_arrive_by_reverse_scan',
      optimality: recoveredByDirectWalk
        ? 'latest_departure_certified_by_direct_walk_dominating_scalar_transit_upper_bound'
        : forwardParityRecovery
          ? 'latest_public_departure_certified_over_complete_initial_board_event_set_after_cycle_filter'
          : 'latest_departure_guaranteed_by_exact_reverse_timetable_scan',
      searchStats: {
        ...plan.diagnostics.searchStats,
        forwardEngineQueryMs: timingMilliseconds(plan.diagnostics.searchStats?.engineQueryMs),
        engineQueryMs: timingMilliseconds(
          timingMilliseconds(plan.diagnostics.searchStats?.engineQueryMs) + timingMilliseconds(boundary.queryMs),
        ),
        arriveByCandidateSource: forwardParityRecovery
          ? 'resident_departure_index_after_materialization_rejection'
          : 'rust_exact_reverse_scan',
        arriveByCandidates: candidateCount,
        arriveByVerifiedCandidates: Math.max(
          boundary.verifiedCandidates,
          materializationSearches,
        ),
        arriveByReverseScans: 1,
        arriveBySearchStrategy: forwardParityRecovery
          ? 'rust_exact_reverse_scan_plus_complete_public_candidate_recovery'
          : 'rust_exact_reverse_connection_scan',
        arriveByNativeQueryMs: timingMilliseconds(boundary.queryMs),
        arriveByNativeEngineQueryMs: timingMilliseconds(boundary.engineQueryMs),
        arriveByNativeScannedDepartures: boundary.scannedDepartures,
        arriveByNativeRelaxedStops: boundary.relaxedStops,
        arriveByNativeExpandedTripRuns: boundary.expandedTripRuns,
        arriveByNativeExplicitTransferChecks: boundary.explicitTransferChecks,
        arriveByMaterializationSearches: materializationSearches,
        ...(forwardParityRecovery ? {
          arriveByForwardParityRecovery: forwardParityRecovery,
        } : {}),
        arriveByFeasibilityInvariant:
          'reverse_deadlines_preserve_every_timetable_ride_and_single_explicit_transfer',
        arriveByFeasibilityRoutingPreference: 'fastest',
        arriveByRequestedRoutingPreference:
          request.routingPreference === 'balanced' ? 'balanced' : 'fastest',
        arriveBySelectedRoutingPreference:
          plan.diagnostics?.searchProfile === 'balanced' ? 'balanced' : 'fastest',
        arriveByRequestedPreferenceVerificationPerformed:
          requestedPreferenceVerificationPerformed,
        arriveByRequestedPreferenceMetDeadline:
          requestedPreferenceMetDeadline,
        arriveByDeadlineSeconds: deadline,
        arriveBySecondaryObjective: 'fewest_boardings_then_walking_then_arrival_within_deadline',
        coordinateAccessFrontierPreparations:
          nativeCoordinateAccess ? 1 : 0,
        coordinateAccessFrontierReuses:
          preparedArriveByCoordinateAccess?.reuseCount ?? 0,
        coordinateAccessFrontierArriveByReuses: Math.max(
          0,
          (preparedArriveByCoordinateAccess?.reuseCount ?? 0)
            - arriveByCoordinateAccessReuseStart,
        ),
        coordinateAccessFrontierPreparationMs:
          requestLocalCoordinateAccess.requestMs,
        coordinateAccessFrontierPreparedHere:
          requestLocalCoordinateAccess.preparedHere,
        coordinateAccessFrontierInherited:
          requestLocalCoordinateAccess.inherited,
        coordinateAccessFrontierIdentity:
          nativeCoordinateAccess
            ? 'gtfs-store-object+gtfs-storage+street-path+street-storage+coordinates+walk-envelope'
            : 'not-applicable',
        arriveByQueryMs: Number((performance.now() - started).toFixed(3)),
      },
    },
    }
  }

  let arriveByOriginSeeds = fusedCoordinateTimetable
    ? null
    : activeServiceKernelAccessSeeds(kernel, originStops)
  let arriveByDestinationSeeds = fusedCoordinateTimetable
    ? null
    : activeServiceKernelAccessSeeds(kernel, destinationStops)
  const ensureRecoverySeeds = () => {
    if (arriveByOriginSeeds && arriveByDestinationSeeds) {
      return { origin: arriveByOriginSeeds, destination: arriveByDestinationSeeds }
    }
    const preparedAt = performance.now()
    nativeCoordinateAccess = prepareNativeCoordinateAccessPair(
      store,
      request.origin,
      request.destination,
      maxWalkKm,
      request.streetStorePath,
      streetStorageIdentity,
      request.__disableNativeStreetPathCache === true,
    )
    originStops = nativeCoordinateAccess?.origin ?? []
    destinationStops = nativeCoordinateAccess?.destination ?? []
    preparedArriveByCoordinateAccess = bindPreparedNativeCoordinateAccessPair(
      store,
      request.origin,
      request.destination,
      maxWalkKm,
      request.streetStorePath,
      streetStorageIdentity,
      nativeCoordinateAccess,
      performance.now() - preparedAt,
    )
    requestLocalCoordinateAccess = {
      accessPair: nativeCoordinateAccess,
      prepared: preparedArriveByCoordinateAccess,
      preparedHere: true,
      inherited: false,
      requestMs: preparedArriveByCoordinateAccess?.preparationMs ?? 0,
    }
    arriveByOriginSeeds = activeServiceKernelAccessSeeds(kernel, originStops)
    arriveByDestinationSeeds = activeServiceKernelAccessSeeds(kernel, destinationStops)
    return { origin: arriveByOriginSeeds, destination: arriveByDestinationSeeds }
  }
  const nativeBoundary = fusedCoordinateTimetable?.arriveBy
    ?? routeNativeTimetableArriveBy(kernel, {
      originSeeds: arriveByOriginSeeds,
      destinationSeeds: arriveByDestinationSeeds,
      maxTransfers: request.maxTransfers,
      allowPostRideTransfers: allowsTerminalTransfers(destinationStops),
      earliest,
      deadline,
      allowPreRideTransfers,
    })
  if (!nativeBoundary.supported) {
    const error = new Error(
      `Rust arrive-by boundary is unsupported: ${nativeBoundary.reason ?? 'unknown reason'}`,
    )
    error.code = 'native_arrive_by_boundary_unsupported'
    throw error
  }
  const latestFeasibleCandidateSeconds = nativeBoundary.latestDeparture
  let selectedFeasibleCandidateSeconds = latestFeasibleCandidateSeconds
  let materializationSearches = Number.isFinite(latestFeasibleCandidateSeconds) ? 1 : 0
  let forwardParityRecovery = null
  let latestFeasiblePlan = Number.isFinite(latestFeasibleCandidateSeconds)
    ? materializeFastest(latestFeasibleCandidateSeconds)
    : null
  if (Number.isFinite(latestFeasibleCandidateSeconds) && !latestFeasiblePlan) {
    const recoverySeeds = ensureRecoverySeeds()
    const candidates = activeServiceKernelArriveByRecoveryCandidates(
      kernel,
      recoverySeeds.origin,
      earliest,
      deadline,
      allowPreRideTransfers,
    )
    const selectedCandidateIndex = candidates.findIndex(
      (candidate) => Math.abs(candidate - latestFeasibleCandidateSeconds) <= 1e-9,
    )
    if (selectedCandidateIndex < 0) {
      const error = new Error(
        'Arrive-by recovery did not contain the departure selected by the reverse scan.',
      )
      error.code = 'native_arrive_by_candidate_mismatch'
      error.nativeCandidateCount = nativeBoundary.candidateCount
      error.reproducedCandidateCount = candidates.length
      error.nativeLatestDeparture = latestFeasibleCandidateSeconds
      error.selectedCandidateIndex = selectedCandidateIndex
      throw error
    }

    let directWalkWitness = null
    if (
      !transitRideRequired(request)
      && request.streetStorePath
      && request.origin?.coordinate
      && request.destination?.coordinate
      && !explicitRoutingStopId(request.origin)
      && !explicitRoutingStopId(request.destination)
    ) {
      const directWalkLimitKm = directWalkEndToEndLimitKm(request)
      if (
        haversineKm(request.origin.coordinate, request.destination.coordinate)
          <= directWalkLimitKm + 1e-9
      ) {
        const path = streetPathBetween(
          request.streetStorePath,
          request.origin.coordinate,
          request.destination.coordinate,
          directWalkLimitKm,
        )
        if (path && path.distanceKm <= directWalkLimitKm + 1e-9) {
          const durationSeconds = path.distanceKm / walkingSpeedKph * 3600
          const plan = materializeDirectWalkCandidate(request, maxWalkKm, path, {
            algorithm: 'osm_direct_walk_latest_departure',
            optimality:
              'latest_departure_certified_by_direct_walk_dominating_scalar_transit_upper_bound',
            transitLowerBoundMinutes: undefined,
          })
          directWalkWitness = {
            departureSeconds: deadline - durationSeconds,
            plan: {
              ...plan,
              diagnostics: {
                ...plan.diagnostics,
                ...serviceDateDiagnostics(serviceDateResolution),
                originStopCandidates: originStops.length,
                destinationStopCandidates: destinationStops.length,
                directWalkEnvelope: directWalkEnvelopeDiagnostics(request, maxWalkKm, path),
              },
            },
          }
        }
      }
    }

    const recovery = {
      status: 'passed',
      trigger: 'native_reverse_boundary_failed_public_forward_materialization',
      exactness:
        'initial_departure_frontier_verified_by_forward_materialization',
      nativeLatestDepartureSeconds: latestFeasibleCandidateSeconds,
      nativeCandidateCount: nativeBoundary.candidateCount,
      reproducedCandidateCount: candidates.length,
      selectedCandidateIndex,
      directWalkDepartureSeconds: directWalkWitness?.departureSeconds ?? null,
      materializationSearches,
      recoveredCandidateSeconds: null,
      outcome: null,
    }

    if (
      directWalkWitness
      && directWalkWitness.departureSeconds > latestFeasibleCandidateSeconds + 1e-9
    ) {
      latestFeasiblePlan = directWalkWitness.plan
      selectedFeasibleCandidateSeconds = directWalkWitness.departureSeconds
      recovery.outcome = 'direct_walk_dominates_scalar_transit_upper_bound'
    } else {
      for (let index = selectedCandidateIndex + 1; index < candidates.length; index += 1) {
        const candidateSeconds = candidates[index]
        if (
          directWalkWitness
          && candidateSeconds <= directWalkWitness.departureSeconds + 1e-9
        ) {
          latestFeasiblePlan = directWalkWitness.plan
          selectedFeasibleCandidateSeconds = directWalkWitness.departureSeconds
          recovery.outcome = 'direct_walk_dominates_remaining_public_candidate_frontier'
          break
        }
        materializationSearches += 1
        const candidatePlan = materializeFastest(candidateSeconds)
        if (candidatePlan) {
          latestFeasiblePlan = candidatePlan
          selectedFeasibleCandidateSeconds = candidateSeconds
          recovery.recoveredCandidateSeconds = candidateSeconds
          recovery.outcome = 'earlier_public_transit_candidate'
          break
        }
      }
      if (!latestFeasiblePlan && directWalkWitness) {
        latestFeasiblePlan = directWalkWitness.plan
        selectedFeasibleCandidateSeconds = directWalkWitness.departureSeconds
        recovery.outcome = 'direct_walk_after_public_transit_candidate_exhaustion'
      } else if (!latestFeasiblePlan) {
        recovery.outcome = 'no_public_path_after_complete_candidate_exhaustion'
      }
    }
    recovery.materializationSearches = materializationSearches
    forwardParityRecovery = recovery
  }
  if (latestFeasiblePlan) {
    if (request.routingPreference === 'balanced' && latestFeasiblePlan.travelMode === 'transit') {
      requestedPreferenceVerificationPerformed = true
      const requestedPreferencePlan = routeNationalGtfsStore(
        storePath,
        attachPreparedNativeCoordinateAccessPair({
          ...request,
          timePreference: 'depart',
          departMinutes: selectedFeasibleCandidateSeconds / 60,
          __allowSubMinuteTimes: true,
          routingPreference: 'balanced',
          __disableDirectWalkDominance: true,
          __suppressServiceDateFallback: true,
        }, preparedArriveByCoordinateAccess),
      )
      requestedPreferenceMetDeadline =
        planMeetsArriveByDeadline(requestedPreferencePlan)
      if (requestedPreferenceMetDeadline) {
        latestFeasiblePlan = requestedPreferencePlan
      }
    }
    return decorate(
      latestFeasiblePlan,
      nativeBoundary,
      forwardParityRecovery,
      materializationSearches,
    )
  }
  const noPathDetail = serviceDateResolution.serviceDateFallbackApplied
    ? `No scheduled path on fallback service date ${serviceDateResolution.resolvedServiceDate} arrives by the selected deadline (requested ${serviceDateResolution.requestedServiceDate}).`
    : 'No exact-date path arrives by the selected deadline.'
  const retry = fallbackRetryWithPreparedCoordinateAccess()
  if (retry) return routeNationalGtfsStore(storePath, retry)
  const arriveBySearchStats = {
    engineQueryMs: timingMilliseconds(nativeBoundary.queryMs),
    arriveByCandidates: forwardParityRecovery?.reproducedCandidateCount
      ?? nativeBoundary.candidateCount,
    arriveByCandidateSource: forwardParityRecovery
      ? 'resident_departure_index_after_materialization_rejection'
      : 'rust_exact_reverse_scan',
    arriveByVerifiedCandidates: Math.max(
      nativeBoundary.verifiedCandidates,
      materializationSearches,
    ),
    arriveByReverseScans: 1,
    arriveBySearchStrategy: 'rust_exact_reverse_connection_scan',
    arriveByNativeQueryMs: timingMilliseconds(nativeBoundary.queryMs),
    arriveByNativeEngineQueryMs: timingMilliseconds(nativeBoundary.engineQueryMs),
    arriveByNativeScannedDepartures: nativeBoundary.scannedDepartures,
    arriveByNativeRelaxedStops: nativeBoundary.relaxedStops,
    arriveByNativeExpandedTripRuns: nativeBoundary.expandedTripRuns,
    arriveByNativeExplicitTransferChecks: nativeBoundary.explicitTransferChecks,
    arriveByMaterializationSearches: materializationSearches,
    ...(forwardParityRecovery ? {
      arriveByForwardParityRecovery: forwardParityRecovery,
    } : {}),
    arriveByFeasibilityInvariant:
      'reverse_deadlines_preserve_every_timetable_ride_and_single_explicit_transfer',
    arriveByFeasibilityRoutingPreference: 'fastest',
    arriveByRequestedRoutingPreference:
      request.routingPreference === 'balanced' ? 'balanced' : 'fastest',
    arriveByDeadlineSeconds: deadline,
    coordinateAccessFrontierPreparations:
      preparedArriveByCoordinateAccess ? 1 : 0,
    coordinateAccessFrontierReuses:
      preparedArriveByCoordinateAccess?.reuseCount ?? 0,
    coordinateAccessFrontierArriveByReuses: Math.max(
      0,
      (preparedArriveByCoordinateAccess?.reuseCount ?? 0)
        - arriveByCoordinateAccessReuseStart,
    ),
    coordinateAccessFrontierPreparationMs:
      preparedArriveByCoordinateAccess?.preparationMs ?? 0,
    coordinateAccessFrontierPreparedHere:
      requestLocalCoordinateAccess.preparedHere,
    coordinateAccessFrontierInherited:
      requestLocalCoordinateAccess.inherited,
  }
  const blocked = blockedPlan(
    request,
    earliest / 60,
    maxWalkKm,
    'No scheduled path',
    noPathDetail,
    {
      originStops: originStops.length,
      destinationStops: destinationStops.length,
    },
    serviceDateResolution,
  )
  return {
    ...blocked,
    timePreference: 'arrive',
    choiceLabel: 'No arrive-by itinerary',
    diagnostics: {
      ...blocked.diagnostics,
      searchStats: arriveBySearchStats,
    },
  }
}


export function addNationalGtfsFares(storePath, plan) {
  if (plan?.status !== 'ready' || !plan.legs?.some(leg => leg.type === 'ride')) return plan
  return addGtfsFares(openNationalStore(storePath).db, plan)
}

export function routeNationalGtfsStore(storePath, request) {
  validateTransitRideRequirement(request)
  validateMaximumTransfers(request.maxTransfers)
  request = withResolvedServiceDay(request)
  if (request.__allowSubMinuteTimes !== true) {
    integralRoutingMinute(
      request.timePreference === 'arrive'
        ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
        : request.departMinutes,
      request.timePreference === 'arrive' ? 'arriveMinutes' : 'departMinutes',
    )
  }
  const routeStartedAt = performance.now()
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
  const realtimeSnapshot = normalizeRealtimeSnapshotForRouting(request.realtimeSnapshot)
  const realtimeRoutingRequested = Boolean(realtimeSnapshot?.tripUpdates?.length)
  const resolvedStorePath = path.resolve(storePath)
  if (!nationalStoreCache.has(resolvedStorePath)) {
    const lightweightDirectWalk = lightweightServiceAnchorDirectWalkProbe(
      resolvedStorePath,
      request,
      maxWalkKm,
    )
    if (lightweightDirectWalk) return lightweightDirectWalk
  }
  const store = openNationalStore(storePath)
  // Keep the large immutable kernel-status object stable across successful
  // queries. Replacing it on every OD defeated activeServiceKernelSnapshot's
  // WeakMap and rebuilt the full diagnostic snapshot in the measured path.
  if (store.activeServiceKernelStatus?.lastQueryError) {
    store.activeServiceKernelStatus = {
      ...store.activeServiceKernelStatus,
      lastQueryError: '',
    }
  }
  const routingCoverage = store.routingCoverage
  const decorateResult = (plan) => {
    const resultStatus = routingResultStatus(plan)
    const transitResult = plan?.travelMode === 'transit'
      || plan?.legs?.some((leg) => leg.type === 'ride')
      || plan?.status === 'blocked'
    const coreOptimality = !routingCoverage.complete && transitResult
      ? plan?.status === 'ready'
        ? 'earliest_arrival_within_supported_scheduled_core'
        : plan?.diagnostics?.failureCode === 'no_path'
          ? 'no_path_within_supported_scheduled_core'
          : 'search_limited_to_supported_scheduled_core'
      : plan?.diagnostics?.optimality
    if (plan?.diagnostics?.searchStats) {
      Object.assign(plan.diagnostics, {
        routingStatus: resultStatus,
        routingStatusSchemaVersion: 'vigo.routing.status.v1',
        optimality: coreOptimality,
        dataSemantics: store.routingDataSemantics,
        methodState: plan.diagnostics.methodState
          ?? (plan.status === 'ready' ? 'complete' : 'failed'),
        fallbackReason: plan.diagnostics.fallbackReason,
      })
      Object.assign(plan.diagnostics.searchStats, {
        queryMs: Number((performance.now() - routeStartedAt).toFixed(3)),
      })
      return plan
    }
    return {
      ...plan,
      diagnostics: {
        ...plan?.diagnostics,
        routingStatus: resultStatus,
        routingStatusSchemaVersion: 'vigo.routing.status.v1',
        optimality: coreOptimality,
        dataSemantics: store.routingDataSemantics,
        methodState: plan?.diagnostics?.methodState ?? (plan?.status === 'ready' ? 'complete' : 'failed'),
        fallbackReason: plan?.diagnostics?.fallbackReason,
        searchStats: {
          ...plan?.diagnostics?.searchStats,
          queryMs: Number((performance.now() - routeStartedAt).toFixed(3)),
        },
      },
    }
  }
  const currentSourceStorageIdentity = currentStaticTopologySourceStorageIdentity(store)
  if (currentSourceStorageIdentity !== store.sourceStorageIdentity) {
    invalidateNationalStore(storePath)
    if (request.__storeIdentityRefresh === true) throw new Error('Routing store changed repeatedly while a route was being prepared.')
    return routeNationalGtfsStore(storePath, { ...request, __storeIdentityRefresh: true })
  }
  if (store.blockingRoutingFeatures.length) {
    const selectedMinutes = numeric(
      request.timePreference === 'arrive'
        ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
        : request.departMinutes,
      8 * 60,
    )
    return decorateResult(blockedPlan(
      request,
      selectedMinutes,
      maxWalkKm,
      'Unsupported GTFS feature',
      `Exact routing is unavailable because this feed uses: ${store.blockingRoutingFeatures.map((feature) => feature.code).join(', ')}.`,
      {
        originStops: 0,
        destinationStops: 0,
        failure: {
          code: 'unsupported_gtfs_feature',
          category: 'unsupported_feature',
          retryable: false,
          features: store.blockingRoutingFeatures,
        },
      },
    ))
  }
  const streetStorageIdentity = currentStreetStoreStorageIdentity(request.streetStorePath)
  const directWalk = dominantDirectWalkPlan(request, maxWalkKm)
  if (directWalk) return decorateResult(directWalk)
  if (request.timePreference === 'arrive') {
    const routedArrivePlan = routeNationalGtfsArriveByStore(storePath, request, streetStorageIdentity)
    const transitPreferredPlan = transitDominatingDirectWalkPlan(
      request,
      maxWalkKm,
      routedArrivePlan,
    ) ?? routedArrivePlan
    if (transitPreferredPlan.status === 'ready') {
      return decorateResult(transitPreferredPlan)
    }
    return decorateResult(
      directWalkAfterBlockedTransitPlan(request, maxWalkKm, transitPreferredPlan)
        ?? transitPreferredPlan,
    )
  }
  const started = performance.now()
  try {
    const origin = request.origin
    const destination = request.destination
    const originAccessStopIds = requestedAccessStopIds(request, '__originAccessStopIds')
    const destinationAccessStopIds = requestedAccessStopIds(request, '__destinationAccessStopIds')
    const departureMinutes = numeric(request.departMinutes, 8 * 60)
    const departure = Math.round(departureMinutes * 60)
    const normalizedHorizonMinutes = routingHorizonMinutes(request)
    const serviceDateResolution = resolveServiceDate(
      store,
      request.serviceDate,
      request.serviceDay,
      request.__serviceDateFallbackRetry === true || (store.serviceModel === 'weekday-template' && request.allowServiceDateFallback === true),
    )
    if (requiredServiceCoverageIncomplete(request, serviceDateResolution)) {
      const retry = fallbackRetryRequest(store, request)
      if (retry) return routeNationalGtfsStore(storePath, retry)
      const transitBlockedPlan = incompleteServiceCoveragePlan(
        request,
        departureMinutes,
        maxWalkKm,
        serviceDateResolution,
      )
      return decorateResult(
        directWalkAfterBlockedTransitPlan(request, maxWalkKm, transitBlockedPlan)
          ?? transitBlockedPlan,
      )
    }
    const horizon = departure + normalizedHorizonMinutes * 60
    const requestedServiceCalendarKey = `${serviceDateResolution.resolvedServiceDate}|${request.serviceDay ?? 'weekday'}`
    const residentFusedKernel = store.activeServiceCalendarKey === requestedServiceCalendarKey
      ? currentActiveServiceKernel(store)
      : null
    const fusedCoordinateEligible = Boolean(
      residentFusedKernel
      && !realtimeRoutingRequested
      && request.streetStorePath
      && !request?.[preparedNativeCoordinateAccessPair]
      && !explicitRoutingStopId(origin)
      && !explicitRoutingStopId(destination)
      && !originAccessStopIds
      && !destinationAccessStopIds
      && Array.isArray(origin?.coordinate)
      && Array.isArray(destination?.coordinate)
      && origin.coordinate.length === 2
      && destination.coordinate.length === 2
      && origin.coordinate.every(Number.isFinite)
      && destination.coordinate.every(Number.isFinite)
    )
    const accessPreparationStartedAt = performance.now()
    let fusedCoordinateTimetable = null
    let nativeCoordinateAccess = null
    let originStops
    let destinationStops
    if (fusedCoordinateEligible) {
      const profileReadinessStartedAt = performance.now()
      const profile = nativeCoordinateAccessProfile(
        store,
        request.streetStorePath,
        streetStorageIdentity,
      )
      const profileReadinessMs = performance.now() - profileReadinessStartedAt
      const routed = routeNativeCoordinateTimetableScalar(
        request.streetStorePath,
        residentFusedKernel,
        {
          origin: origin.coordinate,
          destination: destination.coordinate,
          maximumWalkM: maxWalkKm * 1000,
          departure,
          horizon,
          allowPreRideTransfers: false,
          maxTransfers: request.maxTransfers,
          retainFullFrontier: true,
          enableDirectWalkDominance: !transitRideRequired(request),
          disableCache: request.__disableNativeStreetPathCache === true,
        },
      )
      fusedCoordinateTimetable = {
        ...routed,
        activeKernel: residentFusedKernel,
      }
      const fusedAccessWallMs = Math.max(
        routed.accessMs,
        routed.nodeApiWallMs - routed.timetableMs,
      )
      nativeCoordinateAccess = {
        endpoints: routed.endpoints,
        diagnostics: {
          ...routed.diagnostics,
          profileReadinessMs,
          pairPreparationMs: fusedAccessWallMs,
          candidateRestrictionMs: 0,
          accessOrchestrationMs: 0,
          accessProfile: profile.diagnostics,
          originPostprocessing: {
            engine: routed.diagnostics.accessReducer,
            native: true,
            totalMs: timingMilliseconds(routed.diagnostics.originAccessReductionMs),
            rawCandidates: routed.diagnostics.originRawCandidates,
            linkedStations: routed.diagnostics.originLinkedStations,
            selectedCandidates: routed.originCandidateCount,
          },
          destinationPostprocessing: {
            engine: routed.diagnostics.accessReducer,
            native: true,
            totalMs: timingMilliseconds(routed.diagnostics.destinationAccessReductionMs),
            rawCandidates: routed.diagnostics.destinationRawCandidates,
            linkedStations: routed.diagnostics.destinationLinkedStations,
            selectedCandidates: routed.destinationCandidateCount,
          },
        },
      }
      originStops = new Array(routed.originCandidateCount)
      destinationStops = new Array(routed.destinationCandidateCount)
    } else {
      nativeCoordinateAccess = nativeCoordinateAccessPairForRequest(
        request,
        store,
        origin,
        destination,
        maxWalkKm,
        request.streetStorePath,
        streetStorageIdentity,
      )
      const candidateRestrictionStartedAt = performance.now()
      originStops = restrictAccessStops(
        nativeCoordinateAccess?.origin
          ?? preparePointAccessStops(store, origin, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'origin'),
        originAccessStopIds,
      )
      destinationStops = restrictAccessStops(
        nativeCoordinateAccess?.destination
          ?? preparePointAccessStops(store, destination, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'destination'),
        destinationAccessStopIds,
      )
      const candidateRestrictionMs = performance.now() - candidateRestrictionStartedAt
      if (nativeCoordinateAccess) {
        nativeCoordinateAccess.diagnostics.candidateRestrictionMs = candidateRestrictionMs
      }
    }
    const accessPreparationMs = fusedCoordinateTimetable
      ? Number((
          nativeCoordinateAccess.diagnostics.profileReadinessMs
          + nativeCoordinateAccess.diagnostics.pairPreparationMs
        ).toFixed(3))
      : Number((performance.now() - accessPreparationStartedAt).toFixed(3))
    if (nativeCoordinateAccess) {
      nativeCoordinateAccess.diagnostics.accessOrchestrationMs = Math.max(
        0,
        accessPreparationMs
          - nativeCoordinateAccess.diagnostics.pairPreparationMs
          - nativeCoordinateAccess.diagnostics.candidateRestrictionMs,
      )
    }
    if (!originStops.length || !destinationStops.length) {
      const accessAvailability = {
        origin: accessAvailabilityHint(
          store,
          origin,
          originStops,
          maxWalkKm,
          request.streetStorePath,
          streetStorageIdentity,
          'origin',
          originAccessStopIds,
        ),
        destination: accessAvailabilityHint(
          store,
          destination,
          destinationStops,
          maxWalkKm,
          request.streetStorePath,
          streetStorageIdentity,
          'destination',
          destinationAccessStopIds,
        ),
      }
      const transitBlockedPlan = blockedPlan(
        request,
        departureMinutes,
        maxWalkKm,
        'No reachable station',
        'No station is reachable within the selected walking budget.',
        {
          originStops: originStops.length,
          destinationStops: destinationStops.length,
          nativeCoordinateKernel: nativeCoordinateAccess?.diagnostics,
          accessAvailability,
        },
        serviceDateResolution,
      )
      return decorateResult(
        directWalkAfterBlockedTransitPlan(request, maxWalkKm, transitBlockedPlan)
          ?? transitBlockedPlan,
      )
    }
    const accessFrontierDirectWalk = fusedCoordinateTimetable
      ? accessFrontierDirectWalkProbeFromNative(
          request,
          maxWalkKm,
          fusedCoordinateTimetable,
        )
      : accessFrontierDirectWalkProbe(
          request,
          maxWalkKm,
          originStops,
          destinationStops,
        )
    if (accessFrontierDirectWalk.plan) {
      return decorateResult(accessFrontierDirectWalk.plan)
    }
    const serviceActivationStartedAt = performance.now()
    const services = activateServices(store, serviceDateResolution.resolvedServiceDate, request.serviceDay)
    const serviceActivationMs = Number((performance.now() - serviceActivationStartedAt).toFixed(3))
    if (!services.size) {
      const retry = fallbackRetryRequest(store, request)
      if (retry) return routeNationalGtfsStore(storePath, retry)
      const transitBlockedPlan = blockedPlan(
        request,
        departureMinutes,
        maxWalkKm,
        'No active service',
        `No GTFS service is active on ${serviceDateResolution.resolvedServiceDate}.`,
        { originStops: originStops.length, destinationStops: destinationStops.length },
        serviceDateResolution,
      )
      return decorateResult(
        directWalkAfterBlockedTransitPlan(
          request,
          maxWalkKm,
          transitBlockedPlan,
          accessFrontierDirectWalk.path,
          accessFrontierDirectWalk.streetSearchMs,
        )
          ?? transitBlockedPlan,
      )
    }

    let activeKernel = fusedCoordinateTimetable?.activeKernel ?? currentActiveServiceKernel(store)
    let serviceKernelPreparationMs = 0
    if (!activeKernel) {
      const prepared = ensureActiveServiceKernel(store, services)
      activeKernel = prepared.kernel
      serviceKernelPreparationMs = prepared.preparationMs
    }
    if (activeKernel) {
      let realtimeOverlay = null
      try {
        const allowPreRideTransfers = (
          !request.streetStorePath || Boolean(explicitRoutingStopId(origin))
        )
        realtimeOverlay = realtimeRoutingRequested
          ? buildRealtimeTimetableOverlay(store, activeKernel, realtimeSnapshot, {
              originStops,
              destinationStops,
              serviceDateResolution,
            })
          : null
        let realtimeSearch = null
        if (realtimeOverlay?.ready) {
          try {
            realtimeSearch = searchActiveServiceKernelNativeRealtime(
              activeKernel,
              originStops,
              destinationStops,
              departure,
              horizon,
              allowPreRideTransfers,
              realtimeOverlay,
              request.maxTransfers,
            )
          } catch (error) {
            const fallbackError = error instanceof Error ? error.message : String(error)
            realtimeOverlay.ready = false
            realtimeOverlay.status = 'scheduled_fallback'
            realtimeOverlay.diagnostics.fallbackReason = 'realtime_overlay_query_failed'
            realtimeOverlay.diagnostics.fallbackError = fallbackError
          }
        }
        if (
          realtimeSearch
          && (
            realtimeSearch.supported !== true
            || !['ready', 'blocked'].includes(realtimeSearch.status)
          )
        ) {
          realtimeOverlay.ready = false
          realtimeOverlay.status = 'scheduled_fallback'
          realtimeOverlay.diagnostics.fallbackReason = 'realtime_overlay_query_unsupported'
          realtimeOverlay.diagnostics.fallbackError = realtimeSearch.reason
          realtimeSearch = null
        }
        const kernelSearch = realtimeSearch ?? (
          fusedCoordinateTimetable
            ? activeServiceKernelSearchFromNativeScalar(
                activeKernel,
                fusedCoordinateTimetable.timetable,
                fusedCoordinateTimetable,
              )
            : searchActiveServiceKernelNativeScalar(
                activeKernel,
                originStops,
                destinationStops,
                departure,
                horizon,
                allowPreRideTransfers,
                request.maxTransfers,
              )
        )
        if (
          kernelSearch.supported !== true
          || !['ready', 'blocked'].includes(kernelSearch.status)
        ) {
          throw new Error(
            `Required Rust scalar timetable search is unsupported: ${kernelSearch.reason ?? kernelSearch.status ?? 'unknown'}`,
          )
        }

        const kernelCandidateBoardings = kernelSearch.chain?.reduce(
          (count, step) => count + (step.kind === 'ride' ? 1 : 0),
          0,
        ) ?? 0
        const realtimeSearchApplied = kernelSearch.realtimeOverlay === true
        const collectAlternatives = Array.isArray(request[departureWindowAlternativePlans])
          && !realtimeSearchApplied
        const balancedTransferPreference = request.routingPreference === 'balanced' && !realtimeSearchApplied
        const paretoOptions = {
          allowPreRideTransfers,
          collectAlternatives,
          preferFewerBoardingsWithinSlack: balancedTransferPreference,
          optimizeGeneralizedCost: balancedTransferPreference,
          arrivalSlackSeconds: balancedTransferPreference
            ? balancedTransferArrivalSlackSeconds
            : collectAlternatives ? alternativeArrivalSlackSeconds : 0,
          transferPenaltySeconds: balancedTransferPenaltySeconds,
          walkReluctance: balancedWalkReluctance,
        }
        let selectedKernelSearch = kernelSearch
        let paretoSearch = null
        const nativeTimetableKernel = {
          schemaVersion: 'vigo.routing.native-timetable.v3',
          engineQueryMs: timingMilliseconds(kernelSearch.queryMs),
          scalar: kernelSearch.nativeTimetableKernel,
        }

        // Scalar arrival dominance can discard a later stop label with less
        // walking that still catches the same vehicle. Exact Pareto rounds
        // certify secondary objectives even for one- and two-boarding paths.
        const requiresParetoCertification = !realtimeSearchApplied
          && kernelSearch.status === 'ready' && kernelCandidateBoardings > 0
          && (request.maxTransfers === undefined || collectAlternatives || balancedTransferPreference)
        // The scalar scan already proves the earliest transit arrival. A
        // graph-verified walk that wins that comparison needs no bounded
        // transit frontier, nor materialization of all endpoint candidates.
        const scalarDirectComparison = collectAlternatives && !balancedTransferPreference
          && kernelSearch.status === 'ready'
          ? transitDominatingDirectWalkPlan(
              request,
              maxWalkKm,
              {
                status: 'ready', travelMode: 'transit', departMinutes: departureMinutes,
                durationMinutes: secondsToMinutes(kernelSearch.bestArrival - departure),
              },
              accessFrontierDirectWalk.path,
              accessFrontierDirectWalk.streetSearchMs,
            )
          : null
        if (scalarDirectComparison?.travelMode === 'walk') {
          scalarDirectComparison.diagnostics.searchStats = {
            ...activeServiceKernelUnmaterializedSearchStats(store, kernelSearch, {
              request, services, startedAt: started, accessPreparationMs, serviceActivationMs,
              serviceKernelPreparationMs, nativeTimetableKernel, nativeCoordinateAccess,
            }),
            ...scalarDirectComparison.diagnostics.searchStats,
            boundedSearchSkipped: 'direct_walk_beats_exact_earliest_transit_arrival',
          }
          scalarDirectComparison.diagnostics.directWalkComparison.dominatesThroughDepartureMinutes =
            Math.min(kernelSearch.bestArrival, horizon) / 60
            - scalarDirectComparison.diagnostics.directWalkDistanceKm / walkingSpeedKph * 60
          return decorateResult(scalarDirectComparison)
        }
        if (requiresParetoCertification) {
          if (fusedCoordinateTimetable) {
            const candidateAssemblyStartedAt = performance.now()
            originStops = materializeNativeCoordinateEndpointCandidates(
              request.streetStorePath,
              fusedCoordinateTimetable.endpoints,
              'origin',
            )
            destinationStops = materializeNativeCoordinateEndpointCandidates(
              request.streetStorePath,
              fusedCoordinateTimetable.endpoints,
              'destination',
            )
            nativeCoordinateAccess.origin = originStops
            nativeCoordinateAccess.destination = destinationStops
            nativeCoordinateAccess.diagnostics.candidateAssemblyMs =
              performance.now() - candidateAssemblyStartedAt
          }
          paretoSearch = searchActiveServiceKernelNativePareto(
            activeKernel,
            originStops,
            destinationStops,
            departure,
            horizon,
            allowPreRideTransfers,
            kernelSearch,
            paretoOptions,
          )
          if (
            paretoSearch.supported !== true
            || paretoSearch.status !== 'ready'
            || numeric(paretoSearch.bestArrival) > (
              numeric(kernelSearch.bestArrival)
              + paretoOptions.arrivalSlackSeconds
              + 0.1
            )
          ) {
            throw new Error(
              `Required Rust Pareto timetable search is unsupported: ${paretoSearch.reason ?? paretoSearch.status ?? 'unknown'}`,
            )
          }
          selectedKernelSearch = paretoSearch
          Object.assign(nativeTimetableKernel, {
            paretoSelected: true,
            engineQueryMs: timingMilliseconds(
              timingMilliseconds(kernelSearch.queryMs)
              + timingMilliseconds(paretoSearch.queryMs),
            ),
            pareto: paretoSearch.nativeTimetableKernel,
          })
        }

        // When the fused street query already found a graph-verified direct
        // path whose distance can beat the exact timetable arrival, compare it
        // before building a transit plan. The normal comparator still performs
        // the exact street-path materialization and objective tie handling; the
        // only skipped work is construction of a transit plan that would be
        // discarded immediately afterward.
        const directPathCandidate = accessFrontierDirectWalk.path
        const selectedTransitDurationMinutes = selectedKernelSearch.status === 'ready'
          ? secondsToMinutes(selectedKernelSearch.bestArrival - departure)
          : Number.POSITIVE_INFINITY
        const hasEndpointCoordinates = Array.isArray(origin?.coordinate)
          && origin.coordinate.length === 2
          && origin.coordinate.every(Number.isFinite)
          && Array.isArray(destination?.coordinate)
          && destination.coordinate.length === 2
          && destination.coordinate.every(Number.isFinite)
        const earlyDirectCrowFlightKm = selectedKernelSearch.status === 'ready' && hasEndpointCoordinates
          ? haversineKm(origin.coordinate, destination.coordinate)
          : Number.POSITIVE_INFINITY
        const earlyDirectPhysicalMinutes = earlyDirectCrowFlightKm / walkingSpeedKph * 60
        let earlyDirectComparison = null
        if (
          selectedKernelSearch.status === 'ready'
          && !transitRideRequired(request)
          && request.streetStorePath
          && earlyDirectCrowFlightKm <= directWalkEndToEndLimitKm(request) + 1e-9
          && earlyDirectPhysicalMinutes <= selectedTransitDurationMinutes + 1e-9
        ) {
          if (nativeCoordinateAccess) {
            nativeCoordinateAccess.diagnostics.candidateAssemblyMs ??= 0
          }
          const unmaterializedSearchStats = activeServiceKernelUnmaterializedSearchStats(
            store,
            selectedKernelSearch,
            {
              request,
              services,
              startedAt: started,
              accessPreparationMs,
              serviceActivationMs,
              serviceKernelPreparationMs,
              nativeTimetableKernel,
              nativeCoordinateAccess,
            },
          )
          if (paretoSearch) {
            const engineQueryMs = timingMilliseconds(
              timingMilliseconds(kernelSearch.queryMs)
              + timingMilliseconds(paretoSearch.queryMs),
            )
            const transferWork = activeServiceKernelTransferWorkPhases(
              kernelSearch,
              paretoSearch,
            )
            Object.assign(unmaterializedSearchStats, {
              engineQueryMs,
              acceleratorQueryMs: timingMilliseconds(kernelSearch.queryMs),
              paretoCertificationQueryMs: timingMilliseconds(paretoSearch.queryMs),
              paretoCorridorMs: timingMilliseconds(paretoSearch.corridorMs),
              paretoForwardMs: timingMilliseconds(paretoSearch.forwardMs),
              paretoReverseMs: timingMilliseconds(paretoSearch.reverseMs),
              paretoRoundMs: timingMilliseconds(paretoSearch.roundMs),
              paretoRestrictionFallback: paretoSearch.restrictionFallback,
              transferWork,
            })
            Object.assign(unmaterializedSearchStats.activeServiceKernel, {
              engineQueryMs,
              paretoRestrictionFallback: paretoSearch.restrictionFallback,
              transferWork,
            })
          }
          const earlyTransitSummary = {
            status: 'ready',
            travelMode: 'transit',
            departMinutes: departureMinutes,
            durationMinutes: selectedTransitDurationMinutes,
            diagnostics: {
              searchStats: unmaterializedSearchStats,
            },
          }
          earlyDirectComparison = scalarDirectComparison ?? transitDominatingDirectWalkPlan(
            request,
            maxWalkKm,
            earlyTransitSummary,
            directPathCandidate,
            accessFrontierDirectWalk.streetSearchMs,
          )
          if (earlyDirectComparison?.travelMode === 'walk') {
            if (collectAlternatives && !balancedTransferPreference) {
              // Later departures cannot arrive before this exact earliest
              // transit arrival. Stop the proof at the original scan horizon:
              // moving that horizon may admit another, earlier-arriving trip.
              earlyDirectComparison.diagnostics.directWalkComparison.dominatesThroughDepartureMinutes =
                Math.min(selectedKernelSearch.bestArrival, horizon) / 60
                - earlyDirectComparison.diagnostics.directWalkDistanceKm / walkingSpeedKph * 60
            }
            return decorateResult(earlyDirectComparison)
          }
        }

        if (
          fusedCoordinateTimetable
          && selectedKernelSearch.status === 'ready'
          && !requiresParetoCertification
        ) {
          const candidateAssemblyStartedAt = performance.now()
          const selectedOriginIndices = selectedKernelSearch.chain
            .filter((step) => step.kind === 'access')
            .map((step) => step.candidateIndex)
          originStops = materializeNativeCoordinateEndpointCandidates(
            request.streetStorePath,
            fusedCoordinateTimetable.endpoints,
            'origin',
            selectedOriginIndices,
          )
          destinationStops = materializeNativeCoordinateEndpointCandidates(
            request.streetStorePath,
            fusedCoordinateTimetable.endpoints,
            'destination',
            [selectedKernelSearch.bestDestinationIndex],
          )
          if (fusedCoordinateTimetable.compactFrontier) {
            originStops.length = fusedCoordinateTimetable.originCandidateCount
            destinationStops.length = fusedCoordinateTimetable.destinationCandidateCount
          }
          nativeCoordinateAccess.origin = originStops
          nativeCoordinateAccess.destination = destinationStops
          nativeCoordinateAccess.diagnostics.candidateAssemblyMs =
            performance.now() - candidateAssemblyStartedAt
        }

        const kernelMaterializationContext = {
          request,
          origin,
          destination,
          originStops,
          destinationStops,
          departureMinutes,
          departure,
          horizon,
          maxWalkKm,
          serviceDateResolution,
          services,
          startedAt: started,
          accessPreparationMs,
          serviceActivationMs,
          serviceKernelPreparationMs,
          nativeTimetableKernel,
          streetStorageIdentity,
          nativeCoordinateAccess,
          realtimeOverlay,
        }
        if (selectedKernelSearch.status === 'blocked') {
          const serviceDateRetry = fallbackRetryRequest(store, request)
          if (serviceDateRetry) return routeNationalGtfsStore(storePath, serviceDateRetry)
          let transitBlockedPlan = materializeActiveServiceKernelBlockedPlan(
            store,
            selectedKernelSearch,
            kernelMaterializationContext,
          )
          if (nativeCoordinateAccess) {
            transitBlockedPlan = {
              ...transitBlockedPlan,
              diagnostics: {
                ...transitBlockedPlan.diagnostics,
                searchStats: {
                  ...transitBlockedPlan.diagnostics?.searchStats,
                  nativeCoordinateKernel: nativeCoordinateAccess.diagnostics,
                },
              },
            }
          }
          return decorateResult(
            directWalkAfterBlockedTransitPlan(
              request,
              maxWalkKm,
              transitBlockedPlan,
              accessFrontierDirectWalk.path,
              accessFrontierDirectWalk.streetSearchMs,
            ) ?? transitBlockedPlan,
          )
        }

        let kernelPlan = materializeActiveServiceKernelPlan(
          store,
          activeKernel,
          selectedKernelSearch,
          kernelMaterializationContext,
        )
        if (!kernelPlan) {
          throw new Error('Rust timetable result could not be materialized.')
        }
        kernelPlan = decorateActiveServiceKernelParetoPlan(
          kernelPlan,
          kernelSearch,
          paretoSearch,
          kernelCandidateBoardings,
        )
        if (collectAlternatives) {
          for (const alternative of paretoSearch?.alternatives ?? []) {
            const candidatePlan = materializeActiveServiceKernelPlan(
              store,
              activeKernel,
              { ...paretoSearch, ...alternative },
              kernelMaterializationContext,
            )
            if (!candidatePlan) continue
            const decorated = decorateResult(candidatePlan)
            decorated.recommended = false
            decorated.diagnostics.searchProfile = 'pareto'
            decorated.diagnostics.optimality = 'nondominated_within_alternative_arrival_and_boarding_bounds'
            decorated.diagnostics.alternativeSearch = {
              arrivalSlackSeconds: alternativeArrivalSlackSeconds,
              boardingUpperBound: kernelCandidateBoardings,
            }
            request[departureWindowAlternativePlans].push(decorated)
          }
        }
        if (earlyDirectComparison?.diagnostics?.directWalkComparison) {
          kernelPlan = {
            ...kernelPlan,
            diagnostics: {
              ...kernelPlan.diagnostics,
              directWalkComparison:
                earlyDirectComparison.diagnostics.directWalkComparison,
              searchStats: {
                ...kernelPlan.diagnostics?.searchStats,
                directWalkComparisonMs:
                  earlyDirectComparison.diagnostics?.searchStats
                    ?.directWalkComparisonMs,
              },
            },
          }
        }
        const visiblePlan = withReturnedStationAdvisory(store, kernelPlan)
        return decorateResult(visiblePlan)
      } catch (error) {
        store.activeServiceKernelStatus = {
          ...store.activeServiceKernelStatus,
          lastQueryError: error instanceof Error ? (error.stack ?? error.message) : String(error),
        }
      }
    }

    if (!activeKernel && store.activeServiceKernelStatus?.reason === 'no_active_segments') {
      const transitBlockedPlan = blockedPlan(
        request,
        departureMinutes,
        maxWalkKm,
        'No scheduled path',
        'Active service exists, but it contains no boarding-to-alighting connection supported by the routing contract.',
        {
          originStops: originStops.length,
          destinationStops: destinationStops.length,
          methodRequested: 'rust_timetable_kernel',
          methodUsed: 'rust_timetable_kernel',
          activeServiceKernel: activeServiceKernelSnapshot(store),
          engineInvocationsThisPass: { rustTimetable: 0, sqlite: 0 },
        },
        serviceDateResolution,
      )
      return decorateResult(
        directWalkAfterBlockedTransitPlan(
          request,
          maxWalkKm,
          transitBlockedPlan,
          accessFrontierDirectWalk.path,
          accessFrontierDirectWalk.streetSearchMs,
        )
          ?? transitBlockedPlan,
      )
    }

    const detail = store.activeServiceKernelStatus?.lastQueryError
      ?? store.activeServiceKernelStatus?.reason
      ?? (activeKernel ? 'compact kernel did not materialize a plan' : 'compact kernel is unavailable')
    const error = new Error(`Resident timetable kernel unavailable: ${detail}`)
    error.code = 'resident_timetable_kernel_required'
    error.activeServiceKernel = activeServiceKernelSnapshot(store)
    throw error
  } finally {
    // Routing is resident-only; the persisted store stays open in the project cache.
  }
}

function materializeWindowPlan(plan, departMinutes, centerMinutes, latestCatchMinutes = null) {
  const delta = departMinutes - plan.departMinutes
  const firstRideIndex = plan.legs.findIndex((leg) => leg.type === 'ride')
  const legs = plan.legs.map((leg, index) => index >= 0 && index < firstRideIndex
    ? { ...leg, startMinutes: leg.startMinutes + delta, endMinutes: leg.endMinutes + delta }
    : leg)
  const durationMinutes = Number((plan.arriveMinutes - departMinutes).toFixed(3))
  const waitMinutes = Number(Math.max(0, plan.waitMinutes - delta).toFixed(3))
  return {
    ...plan,
    id: `${plan.id}-window-sample-${departMinutes}`,
    departMinutes,
    durationMinutes,
    waitMinutes,
    detail: routeTimingDetail(durationMinutes, plan.diagnostics, plan.diagnostics?.bridgedUntimedGapCount),
    diagnostics: {
      ...plan.diagnostics,
      windowSample: {
        sourceSearchMinutes: plan.departMinutes,
        sampleMinutes: departMinutes,
        reused: Math.abs(departMinutes - plan.departMinutes) > 1e-9,
        latestCatchMinutes: Number.isFinite(latestCatchMinutes) ? latestCatchMinutes : null,
      },
    },
    legs,
    recommended: false,
    choiceLabel: departMinutes === centerMinutes
      ? 'Exact selected time'
      : `${Math.abs(Math.round(departMinutes - centerMinutes))} min ${departMinutes < centerMinutes ? 'earlier' : 'later'}`,
  }
}

function mergeNationalThroughRide(left, right) {
  if (
    left?.type !== 'ride'
    || right?.type !== 'ride'
    || !left.tripId
    || left.tripId !== right.tripId
    || String(left.routeId || left.routeFeatureId || '') !== String(right.routeId || right.routeFeatureId || '')
    || left.toStopId !== right.fromStopId
    || Math.abs(numeric(left.endMinutes) - numeric(right.startMinutes)) > 0.01
  ) return null
  const durationMinutes = Math.max(0, numeric(right.endMinutes) - numeric(left.startMinutes))
  const sourceEqualTime = durationMinutes === 0 && left.fromStopId !== right.toStopId
  return {
    ...left,
    toStopId: right.toStopId,
    toStationGroupId: right.toStationGroupId,
    toName: right.toName,
    endMinutes: right.endMinutes,
    durationMinutes,
    distanceKm: Math.max(0, numeric(left.distanceKm, 0)) + Math.max(0, numeric(right.distanceKm, 0)),
    stopCount: Math.max(0, numeric(left.stopCount, 0)) + Math.max(0, numeric(right.stopCount, 0)),
    stopIds: Array.isArray(left.stopIds) && Array.isArray(right.stopIds)
      ? [...left.stopIds, ...right.stopIds.slice(1)] : undefined,
    coordinates: appendDistinctCoordinates(left.coordinates, right.coordinates),
    bridgedUntimedGapCount: numeric(left.bridgedUntimedGapCount, 0) + numeric(right.bridgedUntimedGapCount, 0) || undefined,
    sourceEqualTime: sourceEqualTime || undefined,
    sourceEqualTimeConnectionCount:
      numeric(left.sourceEqualTimeConnectionCount, 0)
      + numeric(right.sourceEqualTimeConnectionCount, 0)
      || undefined,
    sourceTimestampQuality: sourceEqualTime
      ? left.sourceTimestampQuality === 'equal-whole-minute'
        && right.sourceTimestampQuality === 'equal-whole-minute'
        ? 'equal-whole-minute'
        : 'equal-time'
      : undefined,
  }
}

function compactNationalAlternativeLegs(firstLegs, secondLegs) {
  const first = [...(firstLegs ?? [])]
  const second = [...(secondLegs ?? [])]
  while (first.at(-1)?.type === 'walk' && numeric(first.at(-1)?.durationMinutes, 0) <= 0.01) first.pop()
  while (second[0]?.type === 'walk' && numeric(second[0]?.durationMinutes, 0) <= 0.01) second.shift()
  const combined = [...first, ...second]
  const compacted = []
  for (const leg of combined) {
    const throughRide = mergeNationalThroughRide(compacted.at(-1), leg)
    if (throughRide) compacted[compacted.length - 1] = throughRide
    else compacted.push(leg)
  }
  return normalizeNationalLegs(compacted)
}

export function stitchNationalAlternativePlans(firstPlan, secondPlan, options = {}) {
  if (firstPlan?.status !== 'ready' || secondPlan?.status !== 'ready') return null
  const legs = compactNationalAlternativeLegs(firstPlan.legs, secondPlan.legs).map(leg => ({ ...leg }))
  const stationAccess = annotateStationAccess(legs, {
    exactStationAccess: firstPlan.origin?.source === 'stop' && firstPlan.origin.stopId === legs[0]?.toStopId,
    exactStationEgress: secondPlan.destination?.source === 'stop' && secondPlan.destination.stopId === legs.at(-1)?.fromStopId,
  })
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  if (!rideLegs.length) return null
  const departMinutes = numeric(firstPlan.departMinutes)
  const arriveMinutes = numeric(secondPlan.arriveMinutes)
  if (!Number.isFinite(departMinutes) || !Number.isFinite(arriveMinutes) || arriveMinutes < departMinutes) return null
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const durationMinutes = Number((arriveMinutes - departMinutes).toFixed(3))
  const waitMinutes = Number(Math.max(0, durationMinutes - walkMinutes - rideMinutes).toFixed(3))
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  const bridgedUntimedGapCount = rideLegs.reduce((sum, leg) => sum + numeric(leg.bridgedUntimedGapCount, 0), 0)
  const sourceEqualTimeRideCount = rideLegs.filter((leg) => leg.sourceEqualTime === true).length
  const sourceEqualTimeConnectionCount = rideLegs.reduce(
    (sum, leg) => sum + numeric(leg.sourceEqualTimeConnectionCount, 0),
    0,
  )
  const preferredWalkKm = Math.max(0.2, numeric(options.preferredWalkKm, firstPlan.maxWalkKm ?? secondPlan.maxWalkKm ?? 1.6))
  return {
    ...firstPlan,
    id: stablePlanId('national-alternative', { departMinutes, arriveMinutes, legs }),
    status: 'ready',
    travelMode: 'transit',
    timePreference: 'depart',
    maxWalkKm: preferredWalkKm,
    scheduleMode: bridgedUntimedGapCount ? 'interpolated-stop-time-gap' : 'exact',
    choiceLabel: 'Alternate',
    recommended: false,
    title: boardingSummary.title || firstPlan.title || secondPlan.title || 'Transit',
    detail: routeTimingDetail(
      durationMinutes,
      { ...firstPlan.diagnostics, ...stationAccess },
      bridgedUntimedGapCount,
      sourceEqualTimeRideCount,
    ),
    departMinutes,
    arriveMinutes,
    durationMinutes,
    waitMinutes,
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    transfers: boardingSummary.transfers,
    origin: options.origin ?? firstPlan.origin,
    destination: options.destination ?? secondPlan.destination,
    snappedOrigin: firstPlan.snappedOrigin,
    snappedDestination: secondPlan.snappedDestination,
    legs,
    diagnostics: {
      ...secondPlan.diagnostics,
      ...stationAccess,
      originWalkKm: firstPlan.diagnostics?.originWalkKm,
      destinationWalkKm: secondPlan.diagnostics?.destinationWalkKm,
      searchProfile: 'pareto',
      searchStrategy: 'exact_waypoint_composition',
      optimality: 'nondominated_station_waypoint_alternative',
      alternativeStrategy: 'station_pareto_waypoint',
      alternativeWaypointStopId: options.waypoint?.stopId,
      alternativeWaypointName: options.waypoint?.name,
      preferredMaxWalkKm: preferredWalkKm,
      bridgedUntimedGapCount,
      sourceEqualTimeRideCount,
      sourceEqualTimeConnectionCount,
      timingPrecision: bridgedUntimedGapCount
        ? 'degraded'
        : sourceEqualTimeRideCount
          ? 'source-equal-time'
          : 'exact',
      searchStats: {
        ...secondPlan.diagnostics?.searchStats,
        queryMs: timingMilliseconds(
          timingMilliseconds(firstPlan.diagnostics?.searchStats?.queryMs)
          + timingMilliseconds(secondPlan.diagnostics?.searchStats?.queryMs),
        ),
        componentSearches: 2,
      },
    },
  }
}

function nationalPlanBeforeFinalEgress(plan, waypoint, request) {
  if (plan?.status !== 'ready') return null
  const legs = [...(plan.legs ?? [])]
  const egress = legs.at(-1)
  if (
    egress?.type !== 'walk'
    || egress.fromStopId !== waypoint.stopId
    || Math.abs(numeric(egress.endMinutes) - numeric(plan.arriveMinutes)) > 0.01
  ) return null
  legs.pop()
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  if (!rideLegs.length) return null
  const arriveMinutes = numeric(egress.startMinutes)
  const departMinutes = numeric(plan.departMinutes)
  const durationMinutes = Number((arriveMinutes - departMinutes).toFixed(3))
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  return {
    ...plan,
    id: stablePlanId('national-waypoint-prefix', { sourcePlanId: plan.id, waypointStopId: waypoint.stopId, arriveMinutes, legs }),
    maxWalkKm: Math.max(0.2, numeric(request.maxWalkKm, plan.maxWalkKm ?? 1.6)),
    destination: waypoint.point,
    snappedDestination: plan.snappedDestination,
    legs,
    title: boardingSummary.title,
    arriveMinutes,
    durationMinutes,
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    waitMinutes: Number(Math.max(0, durationMinutes - walkMinutes - rideMinutes).toFixed(3)),
    transfers: boardingSummary.transfers,
    diagnostics: {
      ...plan.diagnostics,
      destinationWalkKm: 0,
      alternativeStrategy: 'station_waypoint_prefix',
    },
  }
}

function markNationalLongWalkAlternative(plan, preferredWalkKm, alternativeWalkKm, waypoint) {
  if (plan?.status !== 'ready') return plan
  return {
    ...plan,
    recommended: false,
    choiceLabel: 'Longer walk',
    diagnostics: {
      ...plan.diagnostics,
      searchProfile: 'pareto',
      searchStrategy: 'exact_constrained_egress',
      optimality: 'nondominated_extended_egress_alternative',
      alternativeStrategy: 'long_walk_egress',
      longerWalkAlternative: true,
      preferredMaxWalkKm: preferredWalkKm,
      alternativeMaxWalkKm: alternativeWalkKm,
      alternativeWaypointStopId: waypoint.stopId,
      alternativeWaypointName: waypoint.name,
    },
  }
}

function materializeNationalLongWalkAlternative(prefix, path, request, preferredWalkKm, alternativeWalkKm, waypoint) {
  if (prefix?.status !== 'ready' || !path?.coordinates?.length || !Number.isFinite(path.distanceKm)) return null
  const startMinutes = numeric(prefix.arriveMinutes)
  const durationMinutes = secondsToMinutes(walkSeconds(path.distanceKm))
  const endMinutes = Number((startMinutes + durationMinutes).toFixed(3))
  const legs = [...(prefix.legs ?? []).map(leg => ({ ...leg })), {
    type: 'walk',
    travelMode: 'walk',
    walkSource: 'osm',
    fromStopId: waypoint.stopId,
    fromName: prefix.snappedDestination?.name || waypoint.name,
    toName: request.destination.label,
    startMinutes,
    endMinutes,
    durationMinutes,
    distanceKm: path.distanceKm,
    stopCount: 0,
    coordinates: path.coordinates,
  }]
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const departMinutes = numeric(prefix.departMinutes)
  const totalMinutes = Number((endMinutes - departMinutes).toFixed(3))
  const stationAccess = annotateStationAccess(legs, {
    exactStationAccess: prefix.origin?.source === 'stop' && prefix.origin.stopId === legs[0]?.toStopId,
  })
  return markNationalLongWalkAlternative({
    ...prefix,
    id: stablePlanId('national-long-walk', { sourcePlanId: prefix.id, destination: request.destination, endMinutes, legs }),
    maxWalkKm: alternativeWalkKm,
    destination: request.destination,
    legs,
    title: boardingSummary.title,
    arriveMinutes: endMinutes,
    durationMinutes: totalMinutes,
    detail: routeTimingDetail(totalMinutes, { ...prefix.diagnostics, ...stationAccess }, prefix.diagnostics?.bridgedUntimedGapCount),
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    waitMinutes: Number(Math.max(0, totalMinutes - walkMinutes - rideMinutes).toFixed(3)),
    transfers: boardingSummary.transfers,
    diagnostics: {
      ...prefix.diagnostics,
      ...stationAccess,
      destinationWalkKm: path.distanceKm,
      destinationStreetPathVerified: legs.at(-1)?.stationAccessStatus !== 'unverified',
    },
  }, preferredWalkKm, alternativeWalkKm, waypoint)
}

function materializeNationalLongWalkAccessAlternative(plan, path, request, centerMinutes, preferredWalkKm, alternativeWalkKm, waypoint) {
  if (plan?.status !== 'ready' || plan.travelMode !== 'transit' || !path?.coordinates?.length || !Number.isFinite(path.distanceKm)) return null
  const walkDurationMinutes = secondsToMinutes(walkSeconds(path.distanceKm))
  const accessEndMinutes = Number((centerMinutes + walkDurationMinutes).toFixed(3))
  const transitLegs = (plan.legs ?? []).map(leg => ({ ...leg }))
  while (transitLegs[0]?.type === 'walk' && numeric(transitLegs[0]?.durationMinutes, 0) <= 0.01) transitLegs.shift()
  const legs = [{
    type: 'walk',
    travelMode: 'walk',
    walkSource: 'osm',
    fromName: request.origin.label,
    toStopId: waypoint.stopId,
    toName: waypoint.name,
    startMinutes: centerMinutes,
    endMinutes: accessEndMinutes,
    durationMinutes: walkDurationMinutes,
    distanceKm: path.distanceKm,
    stopCount: 0,
    coordinates: path.coordinates,
  }, ...transitLegs]
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  if (!rideLegs.length) return null
  const arriveMinutes = numeric(plan.arriveMinutes)
  const durationMinutes = Number((arriveMinutes - centerMinutes).toFixed(3))
  if (!Number.isFinite(arriveMinutes) || durationMinutes < 0) return null
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  const stationAccess = annotateStationAccess(legs, {
    exactStationEgress: plan.destination?.source === 'stop' && plan.destination.stopId === legs.at(-1)?.fromStopId,
  })
  return {
    ...plan,
    id: stablePlanId('national-long-walk-access', { sourcePlanId: plan.id, origin: request.origin, centerMinutes, legs }),
    maxWalkKm: alternativeWalkKm,
    choiceLabel: 'Longer walk',
    recommended: false,
    title: boardingSummary.title || plan.title,
    detail: routeTimingDetail(durationMinutes, { ...plan.diagnostics, ...stationAccess }, plan.diagnostics?.bridgedUntimedGapCount),
    departMinutes: centerMinutes,
    durationMinutes,
    waitMinutes: Number(Math.max(0, durationMinutes - walkMinutes - rideMinutes).toFixed(3)),
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    transfers: boardingSummary.transfers,
    origin: request.origin,
    legs: normalizeNationalLegs(legs),
    diagnostics: {
      ...plan.diagnostics,
      ...stationAccess,
      originWalkKm: path.distanceKm,
      originStreetPathVerified: legs[0]?.stationAccessStatus !== 'unverified',
      searchProfile: 'pareto',
      searchStrategy: 'exact_constrained_access',
      optimality: 'distinct_station_access_alternative',
      alternativeStrategy: 'long_walk_access',
      longerWalkAlternative: true,
      preferredMaxWalkKm: preferredWalkKm,
      alternativeMaxWalkKm: alternativeWalkKm,
      alternativeWaypointStopId: waypoint.stopId,
      alternativeWaypointName: waypoint.name,
    },
  }
}

function routeNationalGtfsParetoAlternatives(storePath, request, centerMinutes, requestedCount = 5) {
  const preferredWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
  const alternativeWalkKm = Math.max(preferredWalkKm, Math.min(5, numeric(request.alternativeMaxWalkKm, preferredWalkKm)))
  if (
    request.timePreference === 'arrive'
    || !request.streetStorePath
  ) return { plans: [], routeSearches: 0, walkSearches: 0, waypointGroups: 0 }

  const directWalkAlternative = request.__skipDirectWalkAlternative === true
    ? { plan: null, walkSearches: 0 }
    : directWalkAlternativePlan(
        { ...request, timePreference: 'depart', departMinutes: centerMinutes },
        preferredWalkKm,
        alternativeWalkKm,
      )
  const plans = directWalkAlternative.plan ? [directWalkAlternative.plan] : []
  if (alternativeWalkKm <= preferredWalkKm + 0.01) {
    return {
      plans,
      routeSearches: 0,
      walkSearches: directWalkAlternative.walkSearches,
      waypointGroups: 0,
      originWaypointGroups: 0,
      destinationWaypointGroups: 0,
    }
  }

  const store = openNationalStore(storePath)
  const candidateLimit = Math.max(2, Math.min(6, Math.floor(numeric(requestedCount, 5)) + 2))
  let routeSearches = 0
  const originWaypointGroups = request.origin?.source === 'map'
    ? selectNationalAlternativeWaypointGroups(nearestStops(
        store,
        request.origin.coordinate,
        alternativeWalkKm,
        alternativeStreetAccessAnchorLimit,
      ), {
        preferredWalkKm,
        alternativeWalkKm,
        includeInsidePreferred: true,
        limit: Math.min(24, candidateLimit + 12),
      })
    : []
  for (const group of originWaypointGroups) {
    const selectedCandidate = group.candidate
    if (!selectedCandidate) continue
    const selectedCoordinate = [selectedCandidate.lon, selectedCandidate.lat]
    const path = streetPathBetween(
      request.streetStorePath,
      request.origin.coordinate,
      selectedCoordinate,
      alternativeWalkKm,
    )
    if (!path || path.distanceKm <= preferredWalkKm + 0.01 || path.distanceKm > alternativeWalkKm + 1e-9) continue
    const waypoint = {
      stopId: selectedCandidate.stop_id,
      name: selectedCandidate.name || group.name,
      point: {
        coordinate: selectedCoordinate,
        label: selectedCandidate.name || group.name,
        source: 'stop',
        stopId: selectedCandidate.stop_id,
      },
    }
    const walkDurationMinutes = secondsToMinutes(walkSeconds(path.distanceKm))
    const routed = routeNationalGtfsStore(storePath, {
      ...request,
      origin: waypoint.point,
      timePreference: 'depart',
      departMinutes: Number((centerMinutes + walkDurationMinutes).toFixed(3)),
      __allowSubMinuteTimes: true,
      departureWindowMinutes: 0,
      maxWalkKm: preferredWalkKm,
      __disableDirectWalkDominance: true,
      __originAccessStopIds: undefined,
      __destinationAccessStopIds: undefined,
    })
    routeSearches += 1
    const alternative = materializeNationalLongWalkAccessAlternative(
      routed,
      path,
      request,
      centerMinutes,
      preferredWalkKm,
      alternativeWalkKm,
      waypoint,
    )
    if (alternative) plans.push(alternative)
    if (plans.length >= candidateLimit) break
  }

  // Candidate discovery is geometric and cheap. Exact OSM proof is deferred to
  // the single long-walk finalist; routing all 32 distant access anchors through
  // the street graph made alternatives slower than the transit search itself.
  const alternativeDestinationStops = request.destination?.source === 'map'
    ? nearestStops(store, request.destination.coordinate, alternativeWalkKm, alternativeStreetAccessAnchorLimit)
    : []
  const waypointGroups = selectNationalAlternativeWaypointGroups(alternativeDestinationStops, {
    preferredWalkKm,
    alternativeWalkKm,
    limit: candidateLimit,
  })

  const longWalkCandidates = []
  for (const group of waypointGroups) {
    const selectedCandidate = group.candidate
    if (!selectedCandidate) continue
    const selectedPoint = {
      coordinate: [selectedCandidate.lon, selectedCandidate.lat],
      label: selectedCandidate.name || group.name,
      source: 'stop',
      stopId: selectedCandidate.stop_id,
    }
    const routedPrefix = routeNationalGtfsStore(storePath, {
      ...request,
      destination: selectedPoint,
      timePreference: 'depart',
      departMinutes: centerMinutes,
      departureWindowMinutes: 0,
      maxWalkKm: preferredWalkKm,
      __disableDirectWalkDominance: true,
      __originAccessStopIds: undefined,
      __destinationAccessStopIds: undefined,
    })
    routeSearches += 1
    if (routedPrefix.status !== 'ready' || routedPrefix.travelMode !== 'transit') continue
    const snappedStopId = String(routedPrefix.snappedDestination?.id ?? '')
    const waypoint = {
      stopId: snappedStopId || selectedCandidate.stop_id,
      name: routedPrefix.snappedDestination?.name || selectedCandidate.name || group.name,
      streetCoordinate: selectedPoint.coordinate,
      point: {
        coordinate: [numeric(routedPrefix.snappedDestination?.lon, selectedCandidate.lon), numeric(routedPrefix.snappedDestination?.lat, selectedCandidate.lat)],
        label: routedPrefix.snappedDestination?.name || selectedCandidate.name || group.name,
        source: 'stop',
        stopId: snappedStopId || selectedCandidate.stop_id,
      },
    }
    const prefix = nationalPlanBeforeFinalEgress(routedPrefix, waypoint, request)
    if (!prefix) continue
    longWalkCandidates.push({
      prefix,
      waypoint,
      estimate: prefix.durationMinutes + group.distanceKm / walkingSpeedKph * 60 * accessPaddingFactor,
    })
    const continuation = routeNationalGtfsStore(storePath, {
      ...request,
      origin: waypoint.point,
      destination: request.destination,
      timePreference: 'depart',
      departMinutes: prefix.arriveMinutes,
      __allowSubMinuteTimes: true,
      departureWindowMinutes: 0,
      maxWalkKm: preferredWalkKm,
      __disableDirectWalkDominance: true,
      __originAccessStopIds: undefined,
      __destinationAccessStopIds: undefined,
    })
    routeSearches += 1
    const stitched = stitchNationalAlternativePlans(prefix, continuation, {
      origin: request.origin,
      destination: request.destination,
      preferredWalkKm,
      waypoint,
    })
    if (stitched) plans.push(stitched)
  }
  longWalkCandidates.sort((left, right) => (
    numeric(left.prefix.transfers) - numeric(right.prefix.transfers)
    || left.estimate - right.estimate
  ))
  for (const candidate of longWalkCandidates) {
    const path = streetPathBetween(
      request.streetStorePath,
      candidate.waypoint.streetCoordinate,
      request.destination.coordinate,
      alternativeWalkKm,
    )
    if (!path || path.distanceKm <= preferredWalkKm + 0.01 || path.distanceKm > alternativeWalkKm + 1e-9) continue
    const longWalk = materializeNationalLongWalkAlternative(
      candidate.prefix,
      path,
      request,
      preferredWalkKm,
      alternativeWalkKm,
      candidate.waypoint,
    )
    if (longWalk) plans.push(longWalk)
    break
  }
  return {
    plans,
    routeSearches,
    walkSearches: directWalkAlternative.walkSearches,
    waypointGroups: originWaypointGroups.length + waypointGroups.length,
    originWaypointGroups: originWaypointGroups.length,
    destinationWaypointGroups: waypointGroups.length,
  }
}

export function routeNationalGtfsDepartureWindow(storePath, request) {
  validateTransitRideRequirement(request)
  validateMaximumTransfers(request.maxTransfers)
  request = withResolvedServiceDay(request)
  const windowStartedAt = performance.now()
  const centerMinutes = integralRoutingMinute(request.departMinutes, 'departMinutes')
  const windowMinutes = integralRoutingMinute(
    request.departureWindowMinutes,
    'departureWindowMinutes',
    10,
    30,
  )
  const forwardWindow = request.departureWindowDirection === 'forward'
  const beforeMinutes = forwardWindow ? 0 : windowMinutes
  const afterMinutes = windowMinutes
  const stepMinutes = Math.max(0.25, numeric(request.stepMinutes, 1))
  const startMinutes = Math.max(0, centerMinutes - beforeMinutes)
  const endMinutes = centerMinutes + afterMinutes
  const sampleMinutes = []
  for (let minute = startMinutes; minute <= endMinutes + 1e-9; minute += stepMinutes) sampleMinutes.push(Number(minute.toFixed(3)))
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
  let store = openNationalStore(storePath)
  if (currentStaticTopologySourceStorageIdentity(store) !== store.sourceStorageIdentity) {
    invalidateNationalStore(storePath)
    store = openNationalStore(storePath)
    if (currentStaticTopologySourceStorageIdentity(store) !== store.sourceStorageIdentity) {
      throw new Error('Routing store changed repeatedly while a departure window was being prepared.')
    }
  }
  if (store.blockingRoutingFeatures.length) {
    const blocked = routeNationalGtfsStore(storePath, {
      ...request,
      timePreference: 'depart',
      departMinutes: centerMinutes,
      departureWindowMinutes: 0,
    })
    const plans = sampleMinutes.map((sampleMinute) => ({
      ...blocked,
      id: stablePlanId('national-blocked-window', {
        sourceFingerprint: store.sourceFingerprint,
        departMinutes: sampleMinute,
        serviceDate: request.serviceDate,
        origin: request.origin,
        destination: request.destination,
        blockingFeatures: store.blockingRoutingFeatures.map((feature) => feature.code),
      }),
      departMinutes: sampleMinute,
      recommended: false,
    }))
    const departureWindow = {
      centerMinutes,
      beforeMinutes,
      afterMinutes,
      sampleCount: sampleMinutes.length,
      routeSearches: 0,
      gateChecks: 1,
      alternativeFilteringMs: 0,
      windowQueryMs: Number((performance.now() - windowStartedAt).toFixed(3)),
    }
    const plan = {
      ...blocked,
      recommended: true,
      diagnostics: { ...blocked.diagnostics, departureWindow },
    }
    return {
      plan,
      choices: [plan],
      profile: {
        ...departureWindow,
        startMinutes,
        endMinutes,
        stepMinutes,
        readyCount: 0,
        plans,
      },
    }
  }
  const directWalk = dominantDirectWalkPlan({ ...request, timePreference: 'depart', departMinutes: centerMinutes }, maxWalkKm)
  if (directWalk) {
    const plans = sampleMinutes.map((sampleMinute) => materializeDirectWalkPlan(directWalk, sampleMinute))
    const departureWindow = {
      centerMinutes,
      beforeMinutes,
      afterMinutes,
      sampleCount: sampleMinutes.length,
      routeSearches: 0,
      alternativeFilteringMs: 0,
      windowQueryMs: Number((performance.now() - windowStartedAt).toFixed(3)),
    }
    const centerPlan = materializeDirectWalkPlan(directWalk, centerMinutes)
    const plan = {
      ...centerPlan,
      recommended: true,
      diagnostics: { ...centerPlan.diagnostics, departureWindow },
    }
    return {
      plan,
      choices: [plan],
      profile: {
        ...departureWindow,
        startMinutes,
        endMinutes,
        stepMinutes,
        readyCount: plans.length,
        plans,
      },
    }
  }
  const departureWindowStreetStorageIdentity = currentStreetStoreStorageIdentity(
    request.streetStorePath,
  )
  const departureWindowCoordinateAccess = prepareRequestLocalNativeCoordinateAccessPair(
    request,
    store,
    request.origin,
    request.destination,
    maxWalkKm,
    request.streetStorePath,
    departureWindowStreetStorageIdentity,
  )
  const preparedDepartureWindowCoordinateAccess =
    departureWindowCoordinateAccess.prepared
  const plans = []
  const tradeoffPlans = []
  let routeSearches = 0
  let directWalkSampleReuses = 0
  let index = 0
  while (index < sampleMinutes.length) {
    const sampleMinute = sampleMinutes[index]
    const sampleRequest = attachPreparedNativeCoordinateAccessPair({
      ...request,
      timePreference: 'depart',
      departMinutes: sampleMinute,
      __allowSubMinuteTimes: true,
      departureWindowMinutes: 0,
    }, preparedDepartureWindowCoordinateAccess)
    const sampleAlternatives = []
    sampleRequest[departureWindowAlternativePlans] = sampleAlternatives
    const plan = routeNationalGtfsStore(storePath, sampleRequest)
    routeSearches += 1
    for (const alternative of sampleAlternatives) {
      const firstRideIndex = alternative.legs.findIndex((leg) => leg.type === 'ride')
      const preRideMinutes = alternative.legs.slice(0, firstRideIndex)
        .reduce((sum, leg) => sum + leg.durationMinutes, 0)
      const latestCatchMinutes = alternative.legs[firstRideIndex].startMinutes - preRideMinutes
      // Keep the selected-time witness when boardable; otherwise show the
      // latest departure in this window that can catch this journey.
      const choiceMinutes = centerMinutes >= sampleMinute && centerMinutes <= latestCatchMinutes
        ? centerMinutes : Math.min(endMinutes, latestCatchMinutes)
      tradeoffPlans.push(materializeWindowPlan(alternative, choiceMinutes, centerMinutes, latestCatchMinutes))
    }
    if (plan.status !== 'ready') {
      plans.push(plan)
      index += 1
      continue
    }
    const firstRideIndex = plan.legs.findIndex((leg) => leg.type === 'ride')
    if (firstRideIndex < 0) {
      plans.push(plan)
      index += 1
      const staticWalkDominance = (
        plan.diagnostics?.optimality
        === 'direct_walk_strictly_dominates_complete_endpoint_access_lower_bound'
      )
      const walkDominanceUntil = staticWalkDominance ? endMinutes
        : numeric(plan.diagnostics?.directWalkComparison?.dominatesThroughDepartureMinutes, sampleMinute)
      while (index < sampleMinutes.length && sampleMinutes[index] <= walkDominanceUntil) {
        plans.push(materializeDirectWalkPlan(plan, sampleMinutes[index]))
        index += 1
        directWalkSampleReuses += 1
      }
      continue
    }
    const preRideMinutes = plan.legs
      .slice(0, firstRideIndex)
      .reduce((sum, leg) => sum + leg.durationMinutes, 0)
    const latestCatchMinutes = plan.legs[firstRideIndex].startMinutes - preRideMinutes
    let filled = 0
    while (index < sampleMinutes.length && sampleMinutes[index] <= latestCatchMinutes + 1e-9) {
      plans.push(materializeWindowPlan(
        plan,
        sampleMinutes[index],
        centerMinutes,
        latestCatchMinutes,
      ))
      index += 1
      filled += 1
    }
    if (!filled) {
      plans.push(plan)
      index += 1
    }
  }

  const alternativeWalkKm = Math.max(maxWalkKm, Math.min(5, numeric(request.alternativeMaxWalkKm, maxWalkKm)))
  // A complete A-to-B walk is a peer mode choice, not merely an access leg.
  // Prove it once before filling the five slots so it cannot be hidden by five
  // transit-only chains. The crow-flight guard inside the helper makes long
  // regional and national ODs a zero-query fast path.
  const directWalkAlternative = directWalkAlternativePlan(
    { ...request, timePreference: 'depart', departMinutes: centerMinutes },
    maxWalkKm,
    alternativeWalkKm,
  )
  const initialCandidates = directWalkAlternative.plan
    ? [...plans, ...tradeoffPlans, directWalkAlternative.plan]
    : [...plans, ...tradeoffPlans]
  let alternativeFilteringMs = 0
  const initialFilteringStartedAt = performance.now()
  const initialChoices = selectNationalDepartureWindowChoices(initialCandidates, { centerMinutes, limit: 5 })
  alternativeFilteringMs += performance.now() - initialFilteringStartedAt
  // Waypoint synthesis can launch many additional full A-to-B searches and may
  // produce choices unrelated to the requested departure profile. Normal
  // routing returns naturally distinct timetable journeys only. A caller opts
  // into the bounded search either with the explicit flag or by supplying an
  // alternative walking envelope that is wider than the preferred envelope.
  // The desktop sends neither, so it avoids these extra waypoint searches.
  const expandedWalkAlternativesRequested = Object.hasOwn(request, 'alternativeMaxWalkKm')
    && alternativeWalkKm > maxWalkKm + 0.01
  const syntheticAlternativesEnabled = request.includeSyntheticAlternatives === true
    || expandedWalkAlternativesRequested
  const alternatives = syntheticAlternativesEnabled && initialChoices.length < 5
    ? routeNationalGtfsParetoAlternatives(
        storePath,
        { ...request, __skipDirectWalkAlternative: true },
        centerMinutes,
        5 - initialChoices.length,
      )
    : { plans: [], routeSearches: 0, walkSearches: 0, waypointGroups: 0 }
  routeSearches += alternatives.routeSearches
  const departureWindow = {
    centerMinutes,
    beforeMinutes,
    afterMinutes,
    sampleCount: sampleMinutes.length,
    routeSearches,
    timetableRouteSearches: routeSearches - alternatives.routeSearches,
    directWalkSampleReuses,
    alternativeRouteSearches: alternatives.routeSearches,
    alternativeWalkSearches: directWalkAlternative.walkSearches + alternatives.walkSearches,
    alternativeWaypointGroups: alternatives.waypointGroups,
    expandedWalkAlternativesRequested,
    syntheticAlternativesEnabled,
    coordinateAccessFrontierPreparations:
      departureWindowCoordinateAccess.preparedHere ? 1 : 0,
    coordinateAccessFrontierReuses:
      preparedDepartureWindowCoordinateAccess?.reuseCount ?? 0,
    coordinateAccessFrontierPreparationMs:
      departureWindowCoordinateAccess.preparedHere
        ? departureWindowCoordinateAccess.requestMs
        : 0,
    coordinateAccessFrontierInherited:
      departureWindowCoordinateAccess.inherited,
    coordinateAccessFrontierIdentity:
      preparedDepartureWindowCoordinateAccess
        ? 'gtfs-store-object+gtfs-storage+street-path+street-storage+coordinates+walk-envelope'
        : 'not-applicable',
  }
  const finalFilteringStartedAt = performance.now()
  const selectedChoices = alternatives.plans.length
    ? selectNationalDepartureWindowChoices(
        [...initialCandidates, ...alternatives.plans],
        { centerMinutes, limit: 5 },
      )
    : initialChoices
  alternativeFilteringMs += performance.now() - finalFilteringStartedAt
  const completedDepartureWindow = {
    ...departureWindow,
    alternativeFilteringMs: Number(alternativeFilteringMs.toFixed(3)),
    windowQueryMs: Number((performance.now() - windowStartedAt).toFixed(3)),
  }
  const choices = selectedChoices.map((plan) => ({
    ...plan,
    diagnostics: { ...plan.diagnostics, departureWindow: completedDepartureWindow },
  }))
  return {
    plan: choices[0] ?? plans.find((plan) => Math.abs(plan.departMinutes - centerMinutes) < 1e-6) ?? plans[0],
    choices,
    profile: {
      ...completedDepartureWindow,
      startMinutes,
      endMinutes,
      stepMinutes,
      readyCount: plans.filter((plan) => plan.status === 'ready').length,
      plans,
    },
  }
}

function accessFailureFromAvailability(accessAvailability) {
  const statuses = Object.values(accessAvailability ?? {})
    .map((hint) => hint?.status)
    .filter(Boolean)
  if (!statuses.length) return null
  if (statuses.every((status) => status === 'outside_selected_budget')) {
    return {
      code: 'access_budget_exceeded',
      category: 'access',
      retryable: false,
      message: 'A graph-verified station access path exists beyond the selected walking budget.',
    }
  }
  if (
    statuses.includes('street_access_unverified')
    && statuses.every((status) => [
      'street_access_unverified',
      'outside_selected_budget',
    ].includes(status))
  ) {
    return {
      code: 'street_access_unverified',
      category: 'access',
      retryable: false,
      message: 'Nearby transit stops exist, but the imported street graph does not verify pedestrian access to every required endpoint.',
    }
  }
  return null
}

function routingFailure(title, detail, stats = {}) {
  if (stats.failure) return { message: detail, retryable: false, ...stats.failure }
  if (title === 'No reachable station') {
    const accessFailure = accessFailureFromAvailability(stats.accessAvailability)
    if (accessFailure) return accessFailure
  }
  const failureByTitle = {
    'No reachable station': { code: 'access_unreachable', category: 'access', retryable: false },
    'No active service': { code: 'service_inactive', category: 'service', retryable: false },
    'Incomplete timetable coverage': { code: 'coverage_incomplete', category: 'data_coverage', retryable: false },
    'No scheduled path': { code: 'no_path', category: 'routing', retryable: false },
    'Unsupported GTFS feature': { code: 'unsupported_gtfs_feature', category: 'unsupported_feature', retryable: false },
  }
  return { ...(failureByTitle[title] ?? { code: 'routing_blocked', category: 'routing', retryable: false }), message: detail }
}

function blockedPlan(request, departureMinutes, maxWalkKm, title, detail, stats = {}, serviceDateResolution = null) {
  const resolution = serviceDateResolution ?? {
    requestedServiceDate: request.serviceDate,
    resolvedServiceDate: request.serviceDate,
    serviceDateFallbackApplied: false,
    requestedServiceScopeCount: 0,
    resolvedServiceScopeCount: 0,
    availableServiceScopeCount: 0,
  }
  const failure = routingFailure(title, detail, stats)
  return {
    id: stablePlanId('national-blocked', {
      failure: failure.code,
      serviceDate: resolution.resolvedServiceDate,
      departureMinutes,
      maxWalkKm,
      origin: request.origin,
      destination: request.destination,
    }), status: 'blocked', travelMode: 'transit', timePreference: request.timePreference === 'arrive' ? 'arrive' : 'depart', maxWalkKm,
    choiceLabel: 'No exact itinerary', recommended: true, title, detail, departMinutes: departureMinutes,
    durationMinutes: 0, waitMinutes: 0, walkMinutes: 0, rideMinutes: 0, transfers: 0,
    origin: request.origin, destination: request.destination, legs: [],
    diagnostics: {
      scannedDepartures: stats.scanned ?? 0, relaxedStops: stats.relaxed ?? 0, serviceDay: request.serviceDay ?? 'weekday', ...serviceDateDiagnostics(resolution),
      scheduleMode: 'none', walkingNetwork: request.streetStorePath ? 'osm' : 'direct', walkingSpeedKph, searchProfile: 'fastest', searchStrategy: 'not_run',
      walkingAccessPermission: request.streetStorePath ? nativeStreetAccessPermission(request.streetStorePath) : 'public',
      algorithm: 'resident_timetable_kernel', optimality: 'not_applicable',
      walkingPolicyId: nationalRoutingAccessPolicy.id,
      accessDurationModel: nationalRoutingAccessPolicy.durationModel,
      accessPaddingFactor,
      accessOverheadSeconds,
      methodState: failure.category === 'unsupported_feature' ? 'unsupported' : 'failed',
      failureCode: failure.code,
      failureCategory: failure.category,
      failure,
      originStopCandidates: stats.originStops ?? 0, destinationStopCandidates: stats.destinationStops ?? 0, destinationLabels: 0,
      ...(stats.accessAvailability ? { accessAvailability: stats.accessAvailability } : {}),
      searchStats: {},
    },
  }
}

function routingResultStatus(plan) {
  if (plan?.status === 'ready') return 'ready'
  const failureCode = String(plan?.diagnostics?.failure?.code ?? plan?.diagnostics?.failureCode ?? '')
  const failureCategory = String(plan?.diagnostics?.failure?.category ?? plan?.diagnostics?.failureCategory ?? '')
  if (failureCode.includes('stale') || failureCode.includes('artifact')) return 'stale'
  if (failureCode.includes('cancel')) return 'cancelled'
  if (failureCategory === 'unsupported_feature' || failureCode.includes('unsupported')) return 'unsupported'
  return 'blocked'
}

function emptyNationalPreview(routeCount, stopCount) {
  return {
    routes: [],
    stops: [],
    stopPairs: [],
    coverage: {
      rawRouteRows: routeCount,
      publicRouteIdentities: routeCount,
      tripsIndexed: 0,
      stopTimesScanned: 0,
      stopsIndexed: 0,
      stopPairsIndexed: 0,
      capped: routeCount > 0 || stopCount > 0,
      timetableDeferred: false,
      previewStrategy: 'sqlite-spatial-stop-sequence-v1',
      tripCountStrategy: 'none',
    },
  }
}

function routeCatalogRows(db, { sourceScope = '', routeLimit, orderByTrips = false }) {
  const catalogLabelOrder = `route_type,
    LOWER(COALESCE(NULLIF(TRIM(short_name), ''), NULLIF(TRIM(long_name), ''), route_id)),
    route_id`
  return db.prepare(`
    SELECT representative_route_id AS route_id, short_name, long_name,
      route_type, color, variant_count, trip_count
    FROM route_services
    ${sourceScope ? 'WHERE source_scope=?' : ''}
    ORDER BY ${orderByTrips ? `trip_count DESC, ${catalogLabelOrder}` : catalogLabelOrder}
    LIMIT ?
  `).all(...(sourceScope ? [sourceScope, routeLimit] : [routeLimit]))
}

export function readNationalGtfsRouteCatalog(storePath, options = {}) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const routeLimit = Math.max(1, Math.min(nationalRouteCatalogLimit, Number(options.routeLimit) || nationalRouteCatalogLimit))
    const sourceScope = String(options.sourceScope || '').trim()
    const catalogRows = routeCatalogRows(db, { sourceScope, routeLimit })
    return catalogRows.map((route, index) => ({
      id: route.route_id,
      routeId: route.route_id,
      patternId: route.route_id,
      routeType: Number(route.route_type ?? 3),
      shortName: route.short_name || route.long_name || route.route_id,
      longName: route.long_name || route.route_id,
      color: routePreviewColor(route.color, route.route_id),
      tripCount: Number(route.trip_count) || 0,
      serviceVariantCount: Number(route.variant_count) || 1,
      stopCount: 0,
      headwayMinutes: 0,
      spanHours: 0,
      serviceHours: 0,
      serviceShare: 0,
      frequencyClass: 'low',
      patternRank: index + 1,
      geometrySource: 'stop_sequence',
      status: 'baseline',
      coordinates: [],
      points: [],
      stopIds: [],
    }))
  } finally {
    db.close()
  }
}

export function readNationalGtfsPreview(storePath, options = {}) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const metadata = Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map((row) => [row.key, JSON.parse(row.value)]))
    const routeCount = Number(options.routeCount ?? metadata.routeCount ?? 0)
    const stopCount = Number(options.stopCount ?? metadata.stopCount ?? 0)
    const tripCount = Number(options.tripCount ?? metadata.tripCount ?? 0)
    const routeLimit = Math.max(1, Math.min(nationalPreviewRouteLimit, Number(options.routeLimit) || nationalPreviewRouteLimit))
    const sourceScope = String(options.sourceScope || '').trim()
    const representativeTrips = new Map()
    const requestedRepresentativeRouteIds = Array.isArray(options.representativeRouteIds)
      ? [...new Set(options.representativeRouteIds.map((routeId) => String(routeId ?? '')).filter(Boolean))].slice(0, routeLimit)
      : []
    const serviceRoutes = requestedRepresentativeRouteIds.length
      ? requestedRepresentativeRouteIds.map((routeId) => ({ route_id: routeId }))
      : routeCatalogRows(db, { sourceScope, routeLimit, orderByTrips: true })
    if (serviceRoutes.length) {
      const serviceRouteIds = serviceRoutes.map((route) => route.route_id)
      const serviceRoutePlaceholders = serviceRouteIds.map(() => '?').join(',')
      const serviceTripRows = db.prepare(`
        SELECT route_id, MIN(trip_id) AS trip_id, COUNT(*) AS sampled_trip_count
        FROM trips INDEXED BY trips_route
        WHERE route_id IN (${serviceRoutePlaceholders})
        GROUP BY route_id
      `).all(...serviceRouteIds)
      for (const candidate of serviceTripRows) {
        representativeTrips.set(candidate.route_id, {
          tripId: candidate.trip_id,
          sampledTripCount: Math.max(1, Number(candidate.sampled_trip_count) || 1),
        })
      }
    }
    if (!representativeTrips.size) return emptyNationalPreview(routeCount, stopCount)

    const routeIds = [...representativeTrips.keys()]
    const placeholders = routeIds.map(() => '?').join(',')
    const routeMetadata = new Map(db.prepare(`
      SELECT route_id, short_name, long_name, route_type, color
      FROM routes
      WHERE route_id IN (${placeholders})
    `).all(...routeIds).map((route) => [route.route_id, route]))
    const tripCountStrategy = 'exact-indexed'
    const routeTripCounts = new Map(db.prepare(`
      SELECT route_id, COUNT(*) AS trip_count
      FROM trips INDEXED BY trips_route
      WHERE route_id IN (${placeholders})
      GROUP BY route_id
    `).all(...routeIds).map((route) => [route.route_id, Number(route.trip_count)]))
    const representativeConnections = db.prepare(`
      SELECT c.departure, c.arrival, c.direction_id, c.stop_sequence,
        source.stop_id AS from_stop_id, source.name AS from_name, source.lat AS from_lat, source.lon AS from_lon,
        source.parent_station AS from_parent_station, source.location_type AS from_location_type, source.platform_code AS from_platform_code,
        target.stop_id AS to_stop_id, target.name AS to_name, target.lat AS to_lat, target.lon AS to_lon,
        target.parent_station AS to_parent_station, target.location_type AS to_location_type, target.platform_code AS to_platform_code
      FROM connections c
      JOIN stops source ON source.stop_id=c.from_stop_id
      JOIN stops target ON target.stop_id=c.to_stop_id
      WHERE c.trip_id=?
        AND source.lat BETWEEN -90 AND 90 AND source.lon BETWEEN -180 AND 180
        AND target.lat BETWEEN -90 AND 90 AND target.lon BETWEEN -180 AND 180
      ORDER BY c.stop_sequence, c.from_stop_id, c.to_stop_id
      LIMIT ?
    `)

    const routeSeeds = []
    let stopTimesScanned = 0
    let truncatedTrips = 0
    for (const [routeId, representative] of representativeTrips) {
      const rows = representativeConnections.all(representative.tripId, nationalPreviewConnectionsPerRoute)
      stopTimesScanned += rows.length
      if (rows.length === nationalPreviewConnectionsPerRoute) truncatedTrips += 1
      const pathStops = []
      const appendStop = (record) => {
        const longitude = Number(record.lon)
        const latitude = Number(record.lat)
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return
        if (pathStops.at(-1)?.id === record.id) return
        pathStops.push({ ...record, lon: longitude, lat: latitude })
      }
      for (const row of rows) {
        appendStop({
          id: row.from_stop_id, name: row.from_name || row.from_stop_id, lat: row.from_lat, lon: row.from_lon,
          parentStationId: row.from_parent_station || undefined, locationType: row.from_location_type ?? 0, platformCode: row.from_platform_code || undefined,
        })
        appendStop({
          id: row.to_stop_id, name: row.to_name || row.to_stop_id, lat: row.to_lat, lon: row.to_lon,
          parentStationId: row.to_parent_station || undefined, locationType: row.to_location_type ?? 0, platformCode: row.to_platform_code || undefined,
        })
      }
      const coordinates = pathStops.map((stop) => [stop.lon, stop.lat])
      const hasDistinctCoordinate = coordinates.slice(1).some((coordinate) => coordinate[0] !== coordinates[0]?.[0] || coordinate[1] !== coordinates[0]?.[1])
      const exactTripCount = routeTripCounts.get(routeId) ?? 0
      if (coordinates.length < 2 || !hasDistinctCoordinate || exactTripCount < 1) continue
      const metadataRow = routeMetadata.get(routeId) ?? {}
      const firstDepartureSeconds = Number(rows[0]?.departure)
      const lastArrivalSeconds = Number(rows.at(-1)?.arrival)
      const runtimeSeconds = Number.isFinite(firstDepartureSeconds) && Number.isFinite(lastArrivalSeconds)
        ? Math.max(0, lastArrivalSeconds - firstDepartureSeconds)
        : 0
      let distanceKm = 0
      for (let index = 1; index < coordinates.length; index += 1) distanceKm += haversineKm(coordinates[index - 1], coordinates[index])
      routeSeeds.push({
        id: routeId,
        routeId,
        patternId: routeId,
        directionId: rows[0]?.direction_id ?? undefined,
        routeType: Number(metadataRow.route_type ?? 3),
        shortName: metadataRow.short_name || metadataRow.long_name || routeId,
        longName: routeDisplayLongName(
          metadataRow.short_name,
          metadataRow.long_name,
          pathStops,
          routeId,
        ),
        color: routePreviewColor(metadataRow.color, routeId),
        tripCount: exactTripCount,
        stopCount: pathStops.length,
        headwayMinutes: 0,
        spanHours: 0,
        serviceHours: 0,
        serviceShare: tripCount > 0 ? exactTripCount / tripCount : 0,
        frequencyClass: 'low',
        geometrySource: 'stop_sequence',
        distanceKm: Number(distanceKm.toFixed(2)),
        scheduledSpeedKph: runtimeSeconds > 0 ? Number((distanceKm / (runtimeSeconds / 3600)).toFixed(1)) : 0,
        firstDepartureMinutes: Number.isFinite(firstDepartureSeconds) ? Number((firstDepartureSeconds / 60).toFixed(3)) : undefined,
        lastArrivalMinutes: Number.isFinite(lastArrivalSeconds) ? Number((lastArrivalSeconds / 60).toFixed(3)) : undefined,
        stopPairCount: Math.max(0, pathStops.length - 1),
        segmentCount: Math.max(0, pathStops.length - 1),
        status: 'baseline',
        coordinates,
        points: [],
        stopIds: pathStops.map((stop) => stop.id),
        pathStops,
      })
    }

    routeSeeds.sort((left, right) => right.tripCount - left.tripCount || left.routeId.localeCompare(right.routeId))
    const highestTripCount = routeSeeds[0]?.tripCount ?? 0
    const stopMap = new Map()
    const routes = []
    for (const seed of routeSeeds) {
      const newStopCount = new Set(seed.pathStops.filter((stop) => !stopMap.has(stop.id)).map((stop) => stop.id)).size
      if (stopMap.size + newStopCount > nationalPreviewStopLimit) continue
      const { pathStops, ...route } = seed
      route.patternRank = routes.length + 1
      route.frequencyClass = highestTripCount > 0 && route.tripCount / highestTripCount >= 0.5
        ? 'high'
        : highestTripCount > 0 && route.tripCount / highestTripCount >= 0.2 ? 'medium' : 'low'
      routes.push(route)
      for (const pathStop of pathStops) {
        const stop = stopMap.get(pathStop.id) ?? {
          ...pathStop,
          x: 0,
          y: 0,
          routes: [],
          tripCount: 0,
          transferScore: 0,
        }
        if (!stop.routes.includes(route.id)) {
          stop.routes.push(route.id)
          stop.tripCount += route.tripCount
        }
        stopMap.set(stop.id, stop)
      }
    }
    const stops = [...stopMap.values()]
      .map((stop) => ({
        ...stop,
        transferScore: Math.min(100, stop.routes.length * 24 + Math.log10(Math.max(1, stop.tripCount)) * 18),
      }))
      .sort((left, right) => right.transferScore - left.transferScore || right.tripCount - left.tripCount || left.id.localeCompare(right.id))
    const indexedTrips = routes.reduce((sum, route) => sum + route.tripCount, 0)

    return {
      routes,
      stops,
      stopPairs: [],
      coverage: {
        rawRouteRows: routeCount,
        publicRouteIdentities: routeCount,
        tripsIndexed: indexedTrips,
        stopTimesScanned,
        stopsIndexed: stops.length,
        stopPairsIndexed: 0,
        capped: routes.length < routeCount || stops.length < stopCount || truncatedTrips > 0,
        timetableDeferred: false,
        previewStrategy: 'sqlite-spatial-stop-sequence-v1',
        tripCountStrategy,
        sourceScope: sourceScope || undefined,
        routeLimit,
        connectionsPerRouteLimit: nationalPreviewConnectionsPerRoute,
      },
    }
  } finally {
    db.close()
  }
}

export function nationalFeedSummary(storePath, importResult, feedId) {
  const mapPreview = readNationalGtfsPreview(storePath, importResult)
  const previewByRoute = new Map(mapPreview.routes.map((route) => [route.routeId || route.id, route]))
  const routes = readNationalGtfsRouteCatalog(storePath, importResult).map((route) => {
    const previewRoute = previewByRoute.get(route.routeId)
    return previewRoute
      ? { ...route, ...previewRoute, tripCount: route.tripCount, serviceVariantCount: route.serviceVariantCount }
      : route
  })
  const stops = mapPreview.stops
  const blockingRoutingFeatures = importResult.blockingRoutingFeatures ?? []
  const routingLimitations = importResult.routingLimitations ?? []
  return {
    id: feedId,
    name: path.basename(importResult.sourceFile).replace(/\.zip$/i, '') || 'National GTFS',
    provider: 'Local GTFS', versionLabel: importResult.builtAt.slice(0, 10), importedAt: importResult.builtAt,
    source: 'local-file', fileName: importResult.sourceFile, fileSize: importResult.sourceBytes, hash: importResult.storeId,
    qualityScore: 100, routeCount: importResult.routeCount, stopCount: importResult.stopCount, tripCount: importResult.tripCount,
    transferCandidates: importResult.transferCount, requiredTables: { 'agency.txt': true, 'stops.txt': true, 'routes.txt': true, 'trips.txt': true, 'stop_times.txt': true },
    optionalTables: { 'calendar.txt': true, 'calendar_dates.txt': importResult.calendarDateCount > 0, 'transfers.txt': importResult.transferCount > 0, 'frequencies.txt': importResult.frequencyCount > 0, 'pathways.txt': Number(importResult.featureInventory?.pathwayCount ?? 0) > 0 },
    tableProfiles: (importResult.tableProfiles ?? []).map((profile) => ({ ...profile, role: ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'].includes(profile.name) ? 'required' : 'optional', fieldCount: profile.fields.length, issueCount: 0 })),
    warnings: [
      ...blockingRoutingFeatures.map((feature) => ({
        id: `routing-${feature.code}`,
        severity: 'error',
        table: 'routing',
        message: feature.detail,
        rows: [],
      })),
      ...routingLimitations.map((feature) => ({
        id: `routing-${feature.code}`,
        severity: 'warning',
        table: 'routing',
        message: feature.detail,
        rows: [],
      })),
    ], routeMetrics: routes, stopMetrics: stops, mapPreview,
    routingStore: {
      schemaVersion: storeSchemaVersion,
      status: 'ready',
      routingEligibility: blockingRoutingFeatures.length ? 'unsupported' : routingLimitations.length ? 'qualified' : 'exact',
      fileName: path.basename(storePath),
      bytes: importResult.bytes,
      connectionCount: importResult.connectionCount,
      builtAt: importResult.builtAt,
      sourceFingerprint: importResult.sourceFingerprint,
      blockingRoutingFeatures,
      routingLimitations,
    },
  }
}
