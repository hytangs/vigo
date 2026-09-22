import { readServiceTimetable } from './gtfs/service-timetable.mjs'
import {
  nativeCoordinateAccessProfile,
  nativeStopTransferProfile,
  osmStopTransferStreetIdentity,
  pruneRoutingSnapshotCache,
  stopSupportsStationAccessRole,
} from './gtfs/coordinate-access.mjs'

import { attachRoutingDataProvenance, realtimeTimetableForRequest, withRealtimeQueryContext } from './gtfs/realtime-timetable.mjs'
import {
  blockedPlan,
  incompleteServiceCoveragePlan,
  materializeDirectWalkCandidate,
  materializeDirectWalkPlan,
  materializeNationalLongWalkAccessAlternative,
  materializeNationalLongWalkAlternative,
  materializeWindowPlan,
  nationalPlanBeforeFinalEgress,
  normalizeNationalLegs,
  routeTimingDetail,
  routingResultStatus,
  secondsToMinutes,
  stitchNationalAlternativePlans,
} from './gtfs/route-results.mjs'
import {
  accessOverheadSeconds,
  accessPaddingFactor,
  accessWalkSeconds,
  directWalkEndToEndLimitKm,
  explicitRoutingStopId,
  nationalRoutingAccessPolicy,
  nationalRoutingAccessPolicyIdentity,
  osmTransferGraphSchemaVersion,
  osmTransferLowerBoundSpeedKph,
  osmTransferMaximumNeighbors,
  osmTransferMaximumWalkM,
  requestedAccessStopIds,
  requiredServiceCoverageIncomplete,
  routingHorizonMinutes,
  transferDurationSeconds,
  transitRideRequired,
  validateMaximumTransfers,
  validateTransitRideRequirement,
  walkSeconds,
  walkingSpeedKph,
} from './gtfs/routing-policy.mjs'
import {
  completeServiceDateSuggestions,
  resolveServiceDate,
  serviceDateDiagnostics,
  servicesForDate,
  yyyymmdd,
} from './gtfs/service-calendar.mjs'
import {
  buildStopAccessIndex,
  deferredStopAccessIndex,
  nearestStopsFromIndex,
  sampledAnchorServiceProfile,
  stopAccessIndexDiagnostics,
} from './gtfs/stop-access-index.mjs'
import {
  admitCurrentTransferSemantics,
  admitNationalRoutingStore,
  currentStreetStoreStorageIdentity,
  metadataRecord,
  readNationalGtfsStoreMetadata,
  routingSemanticsFromMetadata,
  routingStoreAdmissionError,
  sqliteStoreGeneration,
  sqliteStoreStatSignature,
  staticTopologySourceFingerprint,
  staticTopologySourceIdentity,
  staticTopologySourceIdentityVersion,
  staticTopologySourceMatches,
  staticTopologySourceStorageIdentity,
  staticTopologySourceStorageSnapshot,
  stopAccessRoleIndexVersion,
  storeSchemaVersion,
  supportedScheduledCoreCoverage,
  transferSemanticsVersion,
} from './gtfs/store-metadata.mjs'
import {
  assertNoBrokenGtfsReferences,
  createRoutingStoreIndexes,
  createRoutingStoreSchema,
  ensureNationalGtfsRawSqlDepartureIndex,
  rebuildStopAccessRoles,
} from './gtfs/store-schema.mjs'
import { prepareTimetableIndexes } from './gtfs/timetable-preparation.mjs'
import {
  accessFrontierDirectWalkProbe,
  accessFrontierDirectWalkProbeFromNative,
  clearServiceAccessAnchors,
  directWalkAfterBlockedTransitPlan,
  directWalkAlternativePlan,
  directWalkEnvelopeDiagnostics,
  dominantDirectWalkPlan,
  lightweightServiceAnchorDirectWalkProbe,
  transitDominatingDirectWalkPlan,
} from './gtfs/walking-plans.mjs'
import { boundedCacheGet, boundedCacheSet } from './weighted-lru-cache.mjs'
export { nationalFeedSummary,readNationalGtfsPreview,readNationalGtfsRouteCatalog } from './gtfs/network-preview.mjs'
export { stitchNationalAlternativePlans } from './gtfs/route-results.mjs'
export { readNationalGtfsStoreMetadata } from './gtfs/store-metadata.mjs'

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { journeyContinuityIssue } from '../journeyIntegrity.mjs'
import { haversineKm } from './geometry-utils.mjs'
import { addGtfsFares, copyGtfsFareCatalogs, readGtfsFareCatalog, writeGtfsFareCatalog } from './gtfs-fare-store.mjs'
import { createGtfsZipImportBudget, gtfsTableEntry, inspectGtfsZip, streamGtfsZipCsv } from './gtfs-zip-reader.mjs'
import { assertMatrixSize } from './matrix-size.mjs'
import { readNationalOsmStoreMetadata, routeNationalStreetMatrix, streetPathBetween } from './national-osm-store.mjs'
import {
  nationalRideBoardingSummary,
  nationalRoutingReturnedRideCycle,
  selectNationalAlternativeWaypointGroups,
  selectNationalDepartureWindowChoices,
} from './national-route-choices.mjs'
import { nationalRideGeometry } from './national-route-geometry.mjs'
import {
  buildNativeStopTransferGraph,
  materializeNativeCoordinateEndpointCandidates,
  materializeNativeStreetPath,
  nativeStreetAccessPermission,
  normalizeNativeMilliseconds,
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
} from './native-routing-kernel.mjs'
import { integralNumber, numeric, timingMilliseconds } from './number-utils.mjs'
import { loadPreparedAccessContext, persistPreparedAccessContext } from './prepared-access-context.mjs'
import { normalizeRoutingDataRequest, normalizeScheduledAnalysisRequest } from './routing-data-mode.mjs'
import { stableKeySuffix, stableNationalTransitPlanId, stablePlanId } from './routing-plan-identity.mjs'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from './routing-snapshot.mjs'
import { resolveServiceDay } from './service-day.mjs'
import { annotateStationAccess, stationAccessTiming, stationFallbackSeconds } from './station-access.mjs'
import { WeightedLruCache } from './weighted-lru-cache.mjs'

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
selectNationalDepartureWindowChoices
} from './national-route-choices.mjs'
export { WeightedLruCache } from './weighted-lru-cache.mjs'
const staticTopologySchemaVersion = 'vigo.routing.static-topology.v4'
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
const nationalStoreCache = new Map()
const nationalStoreCacheMaxEntries = Math.max(1, Math.min(32, Math.floor(Number(process.env.VIGO_STORE_CACHE_MAX_ENTRIES ?? 8) || 8)))
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
  clearServiceAccessAnchors(resolvedPath)
}

export function disposeNationalGtfsStore(storePath) {
  const resolvedPath = path.resolve(storePath)
  invalidateNationalStore(resolvedPath)
}

export function disposeAllNationalGtfsStores() {
  for (const storePath of [...nationalStoreCache.keys()]) invalidateNationalStore(storePath)
  clearServiceAccessAnchors()
}

function gtfsSeconds(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (minutes > 59 || seconds > 59) return null
  return Number(match[1]) * 3600 + minutes * 60 + seconds
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

function stopParticipatesInScheduledService(store, stopId) {
  return store.stopAccessIndex.directServiceStopIds?.has(stopId) === true
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

export async function removeNationalGtfsOsmStopTransfers(storePath) {
  const resolvedPath = path.resolve(storePath)
  const metadata = readNationalGtfsStoreMetadata(resolvedPath)
  invalidateNationalStore(resolvedPath)
  const database = new DatabaseSync(resolvedPath)
  let removed = 0
  try {
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;')
    removed = Number(database.prepare(`
      DELETE FROM transfers WHERE EXISTS (
        SELECT 1 FROM transfer_provenance AS p
        WHERE p.from_stop_id=transfers.from_stop_id AND p.to_stop_id=transfers.to_stop_id
          AND p.provenance='osm_certified_radial'
      )
    `).run().changes)
    database.exec("DELETE FROM transfer_provenance WHERE provenance='osm_certified_radial'; DELETE FROM metadata WHERE key='osmStopTransferGraph';")
    const generation = { ...metadata.transferGeneration }
    for (const key of Object.keys(generation)) if (key.startsWith('osm')) delete generation[key]
    generation.strategy = 'source_literal_only'
    const setMetadata = database.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)')
    setMetadata.run('transferGeneration', JSON.stringify(generation))
    setMetadata.run('transferCount', JSON.stringify(Number(database.prepare('SELECT COUNT(*) AS count FROM transfers').get().count)))
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);')
  } catch (error) {
    try { database.exec('ROLLBACK;') } catch {}
    throw error
  } finally {
    database.close()
    invalidateNationalStore(resolvedPath)
  }
  // Rebuild both topology and active-service artifacts before any query can
  // reuse transfers whose street evidence the user has removed.
  await refreshNationalGtfsDerivedArtifacts(resolvedPath)
  return { removed }
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
  disableCache = false,
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
    disableCache,
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
  disableCache = false,
) {
  const native = prepareNativeCoordinateAccessRole(
    store,
    point,
    maxWalkKm,
    streetStorePath,
    streetStorageIdentity,
    accessRole,
    disableCache,
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
  disableCache = false,
) {
  if (currentCandidates.length || explicitRoutingStopId(point)) return null
  const probeWalkKm = Math.min(
    5,
    Math.max(selectedMaxWalkKm + 0.5, selectedMaxWalkKm * 2),
  )
  let candidates
  let strategy
  let diagnosticError = null
  let probeDiagnostics = null
  try {
    const native = prepareNativeCoordinateAccessRole(
      store, point, probeWalkKm, streetStorePath, streetStorageIdentity, accessRole, disableCache,
    )
    probeDiagnostics = native?.diagnostics ?? null
    candidates = restrictAccessStops(
      native?.candidates ?? prepareAccessStops(
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
  const probe = {
    role: accessRole,
    selectedWalkKm: selectedMaxWalkKm,
    probeWalkKm,
    // These searches explain a blocked result; they never change its limits.
    probeComplete: !diagnosticError,
    cacheDisabled: disableCache,
    cacheHit: probeDiagnostics?.cacheHit ?? null,
  }
  // A failed diagnostic is not evidence of an unreachable endpoint, even
  // when the independent spatial index can find a nearby stop.
  if (diagnosticError) {
    return { ...probe, status: 'diagnostic_unavailable', detail: diagnosticError }
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
        return {
          ...probe,
          status: 'street_access_unverified',
          nearestStop: {
            id: nearestPhysical.stop_id,
            name: nearestPhysical.name || nearestPhysical.stop_id,
            distanceKm: Number(distanceKm.toFixed(3)),
            distanceKind: 'straight_line',
          },
          strategy: 'stop-index-plus-street-frontier',
          detail: diagnosticError,
        }
      }
    } catch (error) {
      diagnosticError ??= error instanceof Error ? error.message : String(error)
    }
  }
  const nearest = candidates.reduce((best, candidate) => (
    !best || candidate.distanceKm < best.distanceKm ? candidate : best
  ), null)
  if (!nearest) {
    if (diagnosticError) {
      return {
        ...probe,
        probeComplete: false,
        status: 'diagnostic_unavailable',
        detail: diagnosticError,
      }
    }
    return {
      ...probe,
      status: 'none_within_probe',
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
    ...probe,
    status: 'outside_selected_budget',
    streetPathVerified: nearest.streetPathVerified === true,
    requiredWalkKm: Number(requiredWalkKm.toFixed(3)),
    requiredWalkMinutes: Number((requiredWalkSeconds / 60).toFixed(1)),
    suggestedMaxWalkKm,
    nearestStop: {
      id: nearest.stop_id,
      name: nearest.name || nearest.stop_id,
      distanceKm: Number(requiredWalkKm.toFixed(3)),
      distanceKind: streetStorePath ? 'access_path' : 'straight_line',
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
      options.disableCache === true,
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
    let activeSegmentCount = null
    // Only configured admission guards require a count before allocating.
    // Otherwise Rust streams the service slice once and reports its length.
    if (activeServiceKernelMaxSegments > 0 || activeServiceKernelMaxEstimatedBytes > 0) {
      builder = new DatabaseSync(store.storePath, { readOnly: true })
      builder.exec('PRAGMA mmap_size=0; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; CREATE TEMP TABLE active_kernel_services(service_id TEXT PRIMARY KEY) WITHOUT ROWID;')
      const insertService = builder.prepare('INSERT INTO active_kernel_services VALUES(?)')
      runTemporaryTransaction(builder, () => { for (const serviceId of services) insertService.run(serviceId) })
      activeSegmentCount = Number(builder.prepare(`
        SELECT COUNT(*) AS count
        FROM connections c JOIN active_kernel_services a ON a.service_id=c.service_id
      `).get().count)
      builder.close()
      builder = null
    }
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
    if (activeSegmentCount === 0) return skipped('no_active_segments', 'The active services contain no routable connections.')
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

    const {
      stopIds, stopIndex, departureSeconds, arrivalSeconds, fromStop, toStop, sequence,
      segmentTrip, segmentRun, continuityBreak, canBoard, canAlight, tripStart,
      tripIds, routeIds, serviceIds, directionIds, runCount, stopCount,
    } = readServiceTimetable(store, services, activeSegmentCount)
    activeSegmentCount = departureSeconds.length
    if (activeSegmentCount === 0) return skipped('no_active_segments', 'The active services contain no routable connections.')
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
    const {
      departureOffset, departureOrder, transferOffset, transferTo, transferDuration,
      sourceExpandedTransferEdges, excludedNonServiceTransferEdges, excludedNonServiceStationMembers,
    } = prepareTimetableIndexes(store, stopIds, stopIndex, routableTransferStopMask, {
      departureSeconds, fromStop, canBoard,
    })
    const transferCount = transferTo.length
    const forbiddenSameStop = new Uint8Array(stopCount)
    const sameStopTransferMinimum = new Uint32Array(stopCount)
    for (let stop = 0; stop < stopCount; stop += 1) {
      if (isForbiddenTransfer(store, stopIds[stop], stopIds[stop])) forbiddenSameStop[stop] = 1
      const rule = store.transfers.get(stopIds[stop])?.find((transfer) => transfer.to_stop_id === stopIds[stop])
      if (rule) sameStopTransferMinimum[stop] = transferDurationSeconds(rule)
    }

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
      realtimeAdjusted: kernel.realtimeTripIndices?.has(tripOrCandidate) === true,
      tripId: kernel.tripIds[tripOrCandidate],
      boardingStopSequence: raw.chainBoardSequences[index],
      alightingStopSequence: raw.chainAlightSequences[index],
    }
  })
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
    realtimeTimetable = null,
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
      ...(realtimeTimetable ? {
        realtimeRouting: {
          ...realtimeTimetable.diagnostics,
          mode: 'full-snapshot',
          status: realtimeTimetable.status,
          appliedTripIds: realtimeTimetable.trips.map((trip) => trip.feedTripId ?? trip.tripId),
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
        ...(realtimeTimetable ? {
          realtimeRouting: {
            ...realtimeTimetable.diagnostics,
            status: realtimeTimetable.status,
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
    || request.maxTransfers !== undefined
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
    nativeCoordinateAccess = null, realtimeTimetable = null,
  } = context
  const stopLookup = store.stopLookup
  const routeLookup = store.routeLookup
  const chain = search.chain
  const paretoCertifier = search.paretoFrontier === true
  const lexicographicCertifier = paretoCertifier || search.lexicographicCertified === true
    || request.maxTransfers !== undefined
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
    ...stationAccessTiming(firstAccessStop),
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
    const connections = activeKernelTripConnections(kernel, step)
    tripConnectionMaterializationMs += performance.now() - tripConnectionStartedAt
    const first = connections[0]
    const last = connections.at(-1)
    if (!first || !last) return null
    if (first.from_stop_id !== step.fromStopId || last.to_stop_id !== step.toStopId) {
      throw new Error('The routing engine returned mismatched trip stops. Calculate the journey again.')
    }
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
    ...stationAccessTiming(bestStop),
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
  const continuityIssue = journeyContinuityIssue({ legs, departMinutes: departureMinutes })
  if (continuityIssue) throw new Error(continuityIssue)
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
    choiceLabel: balancedRequest
      ? search.balancedGeneralizedSelection
        ? 'Best balance'
        : balancedSelectedRole === 'earliest_arrival'
          ? 'Balanced · Fastest'
          : 'Balanced · Lower burden'
      : 'Earliest arrival',
    recommended: true, title: routeTitle || 'Transit',
    detail: routeTimingDetail(
      durationMinutes,
      { ...serviceDateResolution, ...stationAccess, scheduleMode },
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
      optimality: bridgedUntimedGapCount
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
      ...(realtimeTimetable ? {
        realtimeRouting: {
          ...realtimeTimetable.diagnostics,
          mode: 'full-snapshot',
          status: realtimeTimetable.status,
          appliedTripIds: realtimeTimetable.trips.map((trip) => trip.feedTripId ?? trip.tripId),
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
        ...(realtimeTimetable ? { realtimeRouting: { ...realtimeTimetable.diagnostics, status: realtimeTimetable.status } } : {}),
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
  request = normalizeScheduledAnalysisRequest(request, 'Reach')
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

export function routeNationalGtfsMatrix(storePath, request) {
  request = normalizeScheduledAnalysisRequest(request, 'Matrix')
  request = { ...request, __disableNativeStreetPathCache: request.__disableNativeStreetPathCache === true || request.disableCache === true }
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
  const { directWalk: sharedWalk, ...result } = routeNationalGtfsTransitMatrix(storePath, request)
  if (!request.streetStorePath || transitRideRequired(request)
    || result.diagnostics.failure?.code === 'unsupported_gtfs_feature') return result

  const horizonMinutes = routingHorizonMinutes(request)
  const walks = sharedWalk ? null : routeNationalStreetMatrix(request.streetStorePath, {
    origins: request.origins,
    destinations: request.destinations,
    mode: 'walk',
    disableCache: request.__disableNativeStreetPathCache,
    walkingSpeedKph,
    maxDistanceKm: Math.min(directWalkEndToEndLimitKm(request), horizonMinutes / 60 * walkingSpeedKph),
  })
  let selectedWalkPairs = 0
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index]
    const sharedCell = sharedWalk ? sharedWalk.originIndexes[row.originIndex] * sharedWalk.destinationCount
      + sharedWalk.destinationIndexes[row.destinationIndex] : -1
    const distanceKm = sharedWalk ? sharedWalk.distancesM[sharedCell] / 1000 : walks.rows[index].distanceKm
    const walkMinutes = sharedWalk ? distanceKm / walkingSpeedKph * 60 : walks.rows[index].durationMinutes
    const walkReady = sharedWalk ? Number.isFinite(walkMinutes) : walks.rows[index].status === 'ready'
    // A selected stop is a distinct transit endpoint contract: preserve a
    // blocked exact-stop result, just as the scalar Route fallback does.
    if (row.status !== 'ready' && (
      explicitRoutingStopId(request.origins[row.originIndex])
      || explicitRoutingStopId(request.destinations[row.destinationIndex])
    )) continue
    if (!walkReady || walkMinutes > horizonMinutes + 1e-9
      || (request.timePreference === 'arrive' && walkMinutes > row.arriveMinutes)
      || (row.status === 'ready' && row.durationMinutes <= walkMinutes)) continue
    row.status = 'ready'
    if (request.timePreference === 'arrive') {
      row.departMinutes = minuteCoordinate((row.arriveMinutes - walkMinutes) * 60)
    } else {
      row.arriveMinutes = minuteCoordinate((row.departMinutes + walkMinutes) * 60)
    }
    row.durationMinutes = secondsToMinutes(walkMinutes * 60)
    if (request.includeJourneys === true) {
      row.journey = { departMinutes: row.departMinutes, arriveMinutes: row.arriveMinutes,
        durationMinutes: row.durationMinutes, transfers: 0, walkMinutes: row.durationMinutes,
        rideMinutes: 0, waitMinutes: 0, legs: [{ type: 'walk', startMinutes: row.departMinutes,
          endMinutes: row.arriveMinutes, durationMinutes: row.durationMinutes, distanceKm }] }
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
    matrixEngine: sharedWalk?.algorithm ?? walks.diagnostics.matrixEngine,
    selectedPairs: selectedWalkPairs,
    maximumDistanceKm: sharedWalk?.maximumDistanceKm ?? walks.diagnostics.maximumDistanceKm,
    queryMs: sharedWalk?.queryMs ?? walks.diagnostics.queryMs,
    reusedEndpointSnaps: sharedWalk?.reusedEndpointSnaps ?? 0,
    execution: sharedWalk ? 'rust_fused_matrix' : 'street_matrix',
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
    maxWalkKm, request.streetStorePath, streetStorageIdentity, request.__disableNativeStreetPathCache === true)
  const originStops = pair?.origin ?? preparePointAccessStops(store, request.origin, maxWalkKm,
    request.streetStorePath, streetStorageIdentity, 'origin', request.__disableNativeStreetPathCache === true)
  const destinationStops = pair?.destination ?? preparePointAccessStops(store, request.destination, maxWalkKm,
    request.streetStorePath, streetStorageIdentity, 'destination', request.__disableNativeStreetPathCache === true)
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
  const disableCache = request.__disableNativeStreetPathCache === true
  const directWalkMaximumKm = Math.max(0.05, Math.min(100, directWalkEndToEndLimitKm(request), matrixHorizonMinutes / 60 * walkingSpeedKph))
  const coordinateOnly = request.streetStorePath
    && uniqueOrigins.every((point) => !explicitRoutingStopId(point))
    && uniqueDestinations.every((point) => !explicitRoutingStopId(point))
  if (coordinateOnly) {
    nativeCoordinateAccessProfile(store, request.streetStorePath, streetStorageIdentity)
    search = routeNativeCoordinateTimetableMatrix(request.streetStorePath, activeKernel, {
      origins: uniqueOrigins, destinations: uniqueDestinations, maximumWalkM: maxWalkKm * 1000,
      disableCache, directWalkMaximumM: transitRideRequired(request) ? undefined : directWalkMaximumKm * 1000,
      departure, horizon, arriveBy, maxTransfers: request.maxTransfers, includeJourneys: request.includeJourneys,
    })
  } else {
    const destinationSeedSets = uniqueDestinations.map((point) => activeServiceKernelAccessSeeds(activeKernel,
      preparePointAccessStops(store, point, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'destination', disableCache)))
    const originSeedSets = uniqueOrigins.map((point) => activeServiceKernelAccessSeeds(activeKernel,
      preparePointAccessStops(store, point, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'origin', disableCache)))
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
    directWalk: search.directWalk ? { ...search.directWalk, originIndexes, destinationIndexes,
      destinationCount: uniqueDestinations.length, maximumDistanceKm: directWalkMaximumKm } : null,
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
      nativeStreetPathCacheDisabled: disableCache,
      ...(coordinateOnly ? { originAccessCacheHits: search.originCacheHits, destinationAccessCacheHits: search.destinationCacheHits } : {}),
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
  const realtimeTimetable = realtimeTimetableForRequest(store, activeKernel, request, serviceDateResolution)
  const kernel = realtimeTimetable?.kernel ?? activeKernel
  if (kernel.activeSegmentCount === 0) {
    const blocked = blockedPlan(request, earliest / 60, maxWalkKm, 'No available service',
      'No trips remain available in the realtime timetable.', { originStops: 0, destinationStops: 0 }, serviceDateResolution)
    return { ...blocked, timePreference: 'arrive', choiceLabel: 'No arrive-by itinerary',
      diagnostics: { ...blocked.diagnostics, realtimeRouting: realtimeTimetable?.diagnostics } }
  }
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
      ?? preparePointAccessStops(store, request.origin, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'origin', request.__disableNativeStreetPathCache === true)
    destinationStops = nativeCoordinateAccess?.destination
      ?? preparePointAccessStops(store, request.destination, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'destination', request.__disableNativeStreetPathCache === true)
  }
  const arriveByCoordinateAccessReuseStart =
    preparedArriveByCoordinateAccess?.reuseCount ?? 0
  const fallbackRetryWithPreparedCoordinateAccess = () => {
    if (realtimeTimetable?.ready) return null
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
        null,
        request.__disableNativeStreetPathCache === true,
      ),
      destination: accessAvailabilityHint(
        store,
        request.destination,
        destinationStops,
        maxWalkKm,
        request.streetStorePath,
        streetStorageIdentity,
        'destination',
        null,
        request.__disableNativeStreetPathCache === true,
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
      realtimeTimetable,
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
      ...(realtimeTimetable ? { realtimeRouting: realtimeTimetable.diagnostics } : {}),
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
      ...(realtimeTimetable ? { realtimeRouting: realtimeTimetable.diagnostics } : {}),
    },
  }
}

export function addNationalGtfsFares(storePath, plan) {
  if (plan?.status !== 'ready' || !plan.legs?.some(leg => leg.type === 'ride')) return plan
  return addGtfsFares(openNationalStore(storePath).db, plan)
}

export function routeNationalGtfsStore(storePath, request) {
  request = normalizeRoutingDataRequest(request)
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
  request = withRealtimeQueryContext(request)
  const resolvedStorePath = path.resolve(storePath)
  if (!request.routingDataMode && !nationalStoreCache.has(resolvedStorePath)) {
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
    plan = attachRoutingDataProvenance(plan, store, request)
    const resultStatus = routingResultStatus(plan)
    const transitResult = plan?.travelMode === 'transit'
      || plan?.legs?.some((leg) => leg.type === 'ride')
      || plan?.status === 'blocked'
    const coreScope = plan?.diagnostics?.realtimeRouting?.coverage?.appliedUpdates > 0
      ? 'supported_realtime_timetable' : 'supported_scheduled_core'
    const coreOptimality = !routingCoverage.complete && transitResult
      ? plan?.status === 'ready'
        ? `${request.timePreference === 'arrive' ? 'latest_departure' : 'earliest_arrival'}_within_${coreScope}`
        : plan?.diagnostics?.failureCode === 'no_path'
          ? `no_path_within_${coreScope}`
          : `search_limited_to_${coreScope}`
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
    const residentRealtimeTimetable = residentFusedKernel
      ? realtimeTimetableForRequest(store, residentFusedKernel, request, serviceDateResolution) : null
    const residentQueryKernel = residentRealtimeTimetable?.kernel ?? residentFusedKernel
    const fusedCoordinateEligible = Boolean(
      residentQueryKernel?.activeSegmentCount > 0
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
        residentQueryKernel,
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
        activeKernel: residentQueryKernel,
        realtimeTimetable: residentRealtimeTimetable,
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
          ?? preparePointAccessStops(store, origin, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'origin', request.__disableNativeStreetPathCache === true),
        originAccessStopIds,
      )
      destinationStops = restrictAccessStops(
        nativeCoordinateAccess?.destination
          ?? preparePointAccessStops(store, destination, maxWalkKm, request.streetStorePath, streetStorageIdentity, 'destination', request.__disableNativeStreetPathCache === true),
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
          request.__disableNativeStreetPathCache === true,
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
          request.__disableNativeStreetPathCache === true,
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
      let realtimeTimetable = null
      try {
        const allowPreRideTransfers = (
          !request.streetStorePath || Boolean(explicitRoutingStopId(origin))
        )
        realtimeTimetable = fusedCoordinateTimetable?.realtimeTimetable
          ?? realtimeTimetableForRequest(store, activeKernel, request, serviceDateResolution)
        if (realtimeTimetable) activeKernel = realtimeTimetable.kernel
        const kernelSearch = activeKernel.activeSegmentCount === 0
          ? { supported: true, status: 'blocked', chain: [], queryMs: 0,
              scannedDepartures: 0, relaxedStops: 0, explicitTransferChecks: 0 }
          : fusedCoordinateTimetable
            ? activeServiceKernelSearchFromNativeScalar(
                activeKernel, fusedCoordinateTimetable.timetable, fusedCoordinateTimetable,
              )
            : searchActiveServiceKernelNativeScalar(
                activeKernel, originStops, destinationStops, departure, horizon,
                allowPreRideTransfers, request.maxTransfers,
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
        const collectAlternatives = Array.isArray(request[departureWindowAlternativePlans])
        const balancedTransferPreference = request.routingPreference === 'balanced'
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
        const requiresParetoCertification = kernelSearch.status === 'ready' && kernelCandidateBoardings > 0
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
                diagnostics: realtimeTimetable ? { realtimeRouting: realtimeTimetable.diagnostics } : {},
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
              ...(realtimeTimetable ? { realtimeRouting: realtimeTimetable.diagnostics } : {}),
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
          realtimeTimetable,
        }
        if (selectedKernelSearch.status === 'blocked') {
          const serviceDateRetry = realtimeTimetable?.ready ? null : fallbackRetryRequest(store, request)
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
  request = normalizeRoutingDataRequest(request)
  validateTransitRideRequirement(request)
  validateMaximumTransfers(request.maxTransfers)
  request = withResolvedServiceDay(request)
  request = withRealtimeQueryContext(request)
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
    attachRoutingDataProvenance(directWalk, store, request)
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
    // Moving the departure also moves the ride horizon. Reuse is sound only
    // when the whole arrival envelope was already inside the original horizon:
    // a newly admitted ride could otherwise improve this plan or add a tradeoff.
    // Include one display-precision unit because plan arrival is rounded.
    const reuseArrivalBound = (plan.arriveMinutes + 0.001) * 60 + alternativeArrivalSlackSeconds
    const sampleRideHorizon = Math.round(sampleMinute * 60) + routingHorizonMinutes(request) * 60
    // A generalized-cost winner need not retain its scalar anchor when the
    // departure moves, so its catchability alone cannot certify reuse.
    const canReuseLaterSamples = request.routingPreference !== 'balanced'
      && reuseArrivalBound <= sampleRideHorizon
    let filled = 0
    while (index < sampleMinutes.length && sampleMinutes[index] <= latestCatchMinutes + 1e-9
      && (filled === 0 || canReuseLaterSamples)) {
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
