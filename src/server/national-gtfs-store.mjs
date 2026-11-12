import { importFlexCatalog, copyFlexCatalogs } from './gtfs/flex.mjs'
import { stationHierarchyMembers } from './gtfs/station-hierarchy.mjs'
import { compileNativeGtfsConnections } from './native-routing-kernel.mjs'
import { wheelchairProfile, wheelchairDescriptionFor, wheelchairBoardingValues, wheelchairPathwayCost } from './wheelchair-policy.mjs'
import { estimatedPathwaySeconds } from './gtfs/pathway-cost.mjs'
import { prepareServiceTransfers } from './gtfs/transfer-paths.mjs'
import { readServiceTimetable } from './gtfs/service-timetable.mjs'
import { boundedInteger, defaultTimetableBudgetBytes, timetableBudgetBytes } from './runtime/resource-limits.mjs'
import {
  nativeCoordinateAccessProfile,
  nativeStopTransferProfile,
  osmStopTransferStreetIdentity,
  pruneRoutingSnapshotCache,
} from './gtfs/coordinate-access.mjs'

import {
  nationalRoutingAccessPolicy,
  nationalRoutingAccessPolicyIdentity,
  osmTransferGraphSchemaVersion,
  osmTransferLowerBoundSpeedKph,
  osmTransferMaximumNeighbors,
  osmTransferMaximumWalkM,
  requiredServiceCoverageIncomplete,
  transferDurationSeconds,
  stationTransferDurationSeconds,
  walkSeconds,
  walkingSpeedKph,
} from './gtfs/routing-policy.mjs'
import {
  completeServiceDateSuggestions,
  resolveServiceDate,
  serviceDateDiagnostics,
  servicesForDate,
} from './gtfs/service-calendar.mjs'
import {
  buildStopAccessIndex,
  deferredStopAccessIndex,
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
  staticTopologySourceFingerprint,
  staticTopologySourceIdentity,
  staticTopologySourceIdentityVersion,
  staticTopologySourceMatches,
  staticTopologySourceStorageIdentity,
  staticTopologySourceStorageSnapshot,
  stopAccessRoleIndexVersion,
  storeSchemaVersion,
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
  clearServiceAccessAnchors,
} from './gtfs/walking-plans.mjs'
import { boundedCacheGet } from './weighted-lru-cache.mjs'
export { nationalFeedSummary,readNationalGtfsPreview,readNationalGtfsRouteCatalog } from './gtfs/network-preview.mjs'
export { readNationalGtfsStoreMetadata } from './gtfs/store-metadata.mjs'

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { haversineKm } from './geometry-utils.mjs'
import { copyGtfsFareCatalogs, readGtfsFareCatalog, writeGtfsFareCatalog } from './gtfs-fare-store.mjs'
import { createGtfsZipImportBudget, gtfsTableEntry, inspectGtfsZip, streamGtfsZipCsv } from './gtfs-zip-reader.mjs'
import { readNationalOsmStoreMetadata } from './national-osm-store.mjs'
import {
  buildNativeStopTransferGraph,
  prepareNativeTimetableKernel,
} from './native-routing-kernel.mjs'
import { numeric, timingMilliseconds } from './number-utils.mjs'
import { loadPreparedAccessContext, persistPreparedAccessContext } from './prepared-access-context.mjs'
import { stableKeySuffix } from './routing-plan-identity.mjs'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from './routing-snapshot.mjs'
import { resolveServiceDay } from './service-day.mjs'
import { stationFallbackSeconds } from './station-access.mjs'
import { WeightedLruCache } from './weighted-lru-cache.mjs'

const staticTopologySchemaVersion = 'vigo.routing.static-topology.v4'
const staticTopologyMinimumFreeBytes = 2 * 1024 * 1024 * 1024
const staticTopologyReserveFloorBytes = 128 * 1024 * 1024
const staticTopologyTransientWorkspaceBytes = 64 * 1024 * 1024
const staticTopologySourceGrowthFactor = 2
const nearbyTransferMaxDistanceKm = 0.25
const nearbyTransferCellDegrees = 0.01
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

// Segment limits remain optional. A finite, host-aware byte budget checks
// timetable size before native allocation and checks retained size afterward.
const activeServiceKernelMaxSegments = optionalPositiveLimit('VIGO_ACTIVE_KERNEL_MAX_SEGMENTS')
const activeServiceKernelMaxSourceConnections = optionalPositiveLimit('VIGO_ACTIVE_KERNEL_MAX_SOURCE_CONNECTIONS')
  || activeServiceKernelMaxSegments
const activeServiceKernelMaxEstimatedBytes = timetableBudgetBytes
// A malformed/oversized persisted snapshot is a cache miss, never a routing
// capability failure: the active timetable is rebuilt from the authoritative
// GTFS SQLite source, subject to the same timetable memory budget.
const activeServiceKernelMaxSnapshotBytes = optionalPositiveLimit('VIGO_ACTIVE_KERNEL_MAX_SNAPSHOT_BYTES')
  || 512 * 1024 * 1024
const activeServiceKernelCacheBudgetBytes = boundedInteger(
  process.env.VIGO_ACTIVE_KERNEL_CACHE_BUDGET_BYTES,
  Math.min(1280 * 1024 * 1024, Math.floor(defaultTimetableBudgetBytes / 2)),
  16 * 1024 * 1024, 4 * 1024 * 1024 * 1024,
)
const activeServiceKernelSnapshotCacheBudgetBytes = boundedInteger(
  process.env.VIGO_ACTIVE_KERNEL_SNAPSHOT_CACHE_BUDGET_BYTES,
  Math.min(512 * 1024 * 1024, Math.floor(defaultTimetableBudgetBytes / 4)),
  8 * 1024 * 1024, 2 * 1024 * 1024 * 1024,
)
const activeServiceKernelSchemaVersion = 'vigo.routing.active-service-kernel.v15-portable'
const activeServiceTransferProjectionVersion = 'single_edge_service_ingress.v7-station-chain'
const activeServiceKernelContextCacheMaxEntries = Math.max(
  1,
  Math.min(8, Math.floor(Number(process.env.VIGO_ACTIVE_KERNEL_CONTEXT_CACHE_MAX_ENTRIES ?? 4) || 0)),
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
    process.env.VIGO_ACTIVE_KERNEL_SNAPSHOT_CACHE_MAX_BYTES ?? activeServiceKernelSnapshotCacheBudgetBytes,
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
    try { cached.nativeShapeSource?.close() } catch {}
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

async function discardRoutingBuildDatabase(tempPath) {
  // The native compiler uses a rollback journal. Retire both unpublished files
  // after an interrupted build before creating a new database at this path.
  await fsp.rm(tempPath, { force: true })
  await fsp.rm(`${tempPath}-journal`, { force: true })
}

async function cleanupFailedRoutingStoreBuild(databases, tempPath, outputPath, extraPaths = []) {
  for (const db of databases) {
    try { db.close() } catch {}
  }
  await Promise.all([
    tempPath,
    `${tempPath}-journal`,
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

export async function buildNationalGtfsStore({ zipPath, outputPath, onProgress, forCity = false, wheelchair = false, wheelchairStreets = 'inferred' }) {
  return importGtfsFeed({ zipPath, outputPath, onProgress, forCity, wheelchair, wheelchairStreets })
}

// City feeds share the final database. Namespace references at the CSV boundary
// so the same validation and connection compiler serve both build paths.
async function importGtfsFeed({ zipPath, outputPath, onProgress, forCity = false, sharedDatabase = null, scope = '', wheelchair = false, wheelchairStreets = 'inferred' }) {
  const startedAt = performance.now()
  const archive = await inspectGtfsZip(zipPath)
  const sourceFingerprint = await sha256File(zipPath)
  const prefix = scope ? `${scope}\u001f` : ''
  const streamTable = (entry, onRow, options) => streamGtfsZipCsv(archive, entry, prefix
    ? (row) => {
        for (const field of ['stop_id', 'route_id', 'trip_id', 'service_id', 'shape_id', 'block_id', 'from_stop_id', 'to_stop_id', 'from_trip_id', 'to_trip_id', 'from_route_id', 'to_route_id', 'location_id', 'location_group_id', 'booking_rule_id', 'pickup_booking_rule_id', 'drop_off_booking_rule_id', 'prior_notice_service_id']) {
          if (String(row[field] ?? '').trim()) row[field] = prefix + row[field]
        }
        if (row.parent_station) row.parent_station = prefix + row.parent_station
        return onRow(row)
      }
    : onRow, options)
  for (const required of ['routes.txt', 'trips.txt', 'stop_times.txt', ...(gtfsTableEntry(archive, 'locations.geojson') ? [] : ['stops.txt'])]) {
    if (!gtfsTableEntry(archive, required)) throw new Error(`GTFS is missing ${required}.`)
  }
  if (!gtfsTableEntry(archive, 'calendar.txt') && !gtfsTableEntry(archive, 'calendar_dates.txt')) {
    throw new Error('GTFS requires calendar.txt, calendar_dates.txt, or both to define active service.')
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.building`
  const stagePath = `${outputPath}.stop-times-building`
  await fsp.rm(stagePath, { force: true })
  if (!sharedDatabase) await discardRoutingBuildDatabase(tempPath)
  let db = sharedDatabase?.current ?? new DatabaseSync(tempPath)
  let stage = new DatabaseSync(stagePath)
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
    driverCoordinatedStopTimeCount: 0,
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
  const wheelchairStops = new Map()
  let boardingAccessibility = new Map()
  if (wheelchair) db.exec(`
    CREATE TABLE IF NOT EXISTS wheelchair_stops(stop_id TEXT PRIMARY KEY, boarding INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wheelchair_transfer_minimum(from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, min_transfer_time INTEGER NOT NULL, PRIMARY KEY(from_stop_id,to_stop_id));
  `)
  const excludedTripIds = new Set()
  const flexTripIds = new Set(), bookingTripIds = new Set(), flexTripModels = new Map()
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
      }, { budget: zipImportBudget, onProgress: (work) => onProgress?.({
        phase: `Reading ${name}`, progress, work,
        detail: `${work.rows.toLocaleString()} rows`, memory: process.memoryUsage().rss,
      }) })
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
        if (!String(row.stop_id ?? '').slice(prefix.length).trim()) {
          throw new Error('GTFS stops.txt requires a non-empty stop_id.')
        }
        const locationType = numeric(row.location_type, 0)
        const wheelchairBoarding = String(row.wheelchair_boarding ?? '').trim()
        if (wheelchairBoarding && numeric(wheelchairBoarding, 0) !== 0) {
          featureInventory.stopWheelchairBoardingRuleCount += 1
        }
        if (wheelchair) wheelchairStops.set(row.stop_id, { parent: row.parent_station, level: String(row.level_id ?? '').trim(),
          boarding: requiredGtfsEnum(row.wheelchair_boarding, [0, 1, 2], 'wheelchair_boarding', row.stop_id, 0) })
        if (locationType === 2) featureInventory.stationEntranceCount += 1
        if (String(row.level_id ?? '').trim()) featureInventory.stationLevelRuleCount += 1
        const latitude = String(row.stop_lat ?? '').trim() ? numeric(row.stop_lat, null) : null
        const longitude = String(row.stop_lon ?? '').trim() ? numeric(row.stop_lon, null) : null
        return [row.stop_id, row.stop_name ?? '', latitude, longitude, row.parent_station || null, locationType, row.platform_code || null]
      })
    if (wheelchair) {
      boardingAccessibility = wheelchairBoardingValues(wheelchairStops)
      const insert = db.prepare('INSERT INTO wheelchair_stops VALUES(?,?)')
      runTransaction(db, () => { for (const [id, boarding] of boardingAccessibility) insert.run(id, boarding) })
    }
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
    const insertTripOperations = db.prepare('INSERT INTO trip_operations VALUES(?,?,?)')
    const insertTripDetails = db.prepare('INSERT INTO trip_details VALUES(?,?,?)')
    await importTable('trips.txt', 0.14,
      'INSERT INTO trips VALUES(?,?,?,?)',
      (row) => {
        const factor = row.safe_duration_factor ? Number(row.safe_duration_factor) : null
        const offset = row.safe_duration_offset ? Number(row.safe_duration_offset) : null
        if ((factor !== null && (!Number.isFinite(factor) || factor < 0)) || (offset !== null && (!Number.isFinite(offset) || offset < 0))) throw new Error('Invalid GTFS safe duration model')
        if (wheelchair || factor !== null || offset !== null) flexTripModels.set(row.trip_id, { factor, offset, wheelchair: requiredGtfsEnum(row.wheelchair_accessible, [0, 1, 2], 'wheelchair_accessible', row.trip_id, 0) })
        insertTripOperations.run(row.trip_id, String(row.block_id ?? '').trim() || null, requiredGtfsEnum(row.bikes_allowed, [0, 1, 2], 'bikes_allowed', row.trip_id, 0))
        insertTripDetails.run(row.trip_id, row.trip_headsign || null, row.trip_short_name || null)
        if (String(row.block_id ?? '').trim()) featureInventory.blockTripCount += 1
        const wheelchairAccessible = String(row.wheelchair_accessible ?? '').trim()
        if (wheelchair && requiredGtfsEnum(row.wheelchair_accessible, [0, 1, 2], 'wheelchair_accessible', row.trip_id, 0) !== 1) {
          excludedTripIds.add(row.trip_id)
          featureInventory.wheelchairExcludedTripCount = (featureInventory.wheelchairExcludedTripCount ?? 0) + 1
        }
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
    const insertTransferRule = db.prepare('INSERT INTO transfer_rules VALUES(?,?,?,?,?,?,?,?)')
    const insertTripLink = db.prepare('INSERT INTO trip_links VALUES(?,?,?)')
    await importTable('transfers.txt', 0.27,
      'INSERT OR REPLACE INTO transfers VALUES(?,?,?,?)',
      (row) => {
        const routeSpecific = Boolean(String(row.from_route_id ?? '').trim() || String(row.to_route_id ?? '').trim())
        const tripSpecific = Boolean(String(row.from_trip_id ?? '').trim() || String(row.to_trip_id ?? '').trim())
        const transferContext = `${row.from_stop_id || '(missing from_stop_id)'} -> ${row.to_stop_id || '(missing to_stop_id)'}`
        const transferType = requiredGtfsEnum(row.transfer_type, [0, 1, 2, 3, 4, 5], 'transfer_type', transferContext, 0)
        const minimumTransferTimeText = String(row.min_transfer_time ?? '').trim()
        const minimumTransferTime = minimumTransferTimeText ? Number(minimumTransferTimeText) : 0
        if (!Number.isInteger(minimumTransferTime) || minimumTransferTime < 0) {
          throw new Error(`Invalid GTFS min_transfer_time for ${transferContext}: ${minimumTransferTimeText || '(missing)'}.`)
        }
        if (transferType < 4 && (!String(row.from_stop_id ?? '').trim() || !String(row.to_stop_id ?? '').trim())) throw new Error('GTFS ordinary transfers require both stop selectors.')
        insertTransferRule.run(...['from_stop_id','to_stop_id','from_route_id','to_route_id','from_trip_id','to_trip_id'].map(key => String(row[key] ?? '').trim() || null), transferType, minimumTransferTime)
        if (transferType === 1) featureInventory.timedTransferCount += 1
        if (transferType === 4 || transferType === 5) {
          featureInventory.inSeatTransferCount += 1
          if (!String(row.from_trip_id ?? '').trim() || !String(row.to_trip_id ?? '').trim()) {
            throw new Error('GTFS linked trips require both from_trip_id and to_trip_id.')
          }
          insertTripLink.run(row.from_trip_id, row.to_trip_id, transferType)
          return null
        }
        if (routeSpecific) featureInventory.routeSpecificTransferCount += 1
        if (tripSpecific) featureInventory.tripSpecificTransferCount += 1
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
    if (wheelchair) db.exec(`INSERT OR IGNORE INTO wheelchair_transfer_minimum SELECT from_stop_id,to_stop_id,min_transfer_time FROM transfers WHERE transfer_type=2`)
    await importTable('frequencies.txt', 0.29,
      'INSERT INTO frequencies VALUES(?,?,?,?,?)',
      (row) => {
        const startTime = gtfsSeconds(row.start_time)
        const endTime = gtfsSeconds(row.end_time)
        const headwaySecs = numeric(row.headway_secs, 0)
        const exactTimes = requiredGtfsEnum(row.exact_times, [0, 1], 'exact_times', row.trip_id, 0)
        if (startTime === null || endTime === null || endTime <= startTime || !Number.isInteger(headwaySecs) || headwaySecs <= 0) {
          throw new Error(`Invalid GTFS frequency window for trip ${row.trip_id || '(missing trip_id)'}.`)
        }
        if (exactTimes === 1) featureInventory.exactFrequencyCount += 1
        else {
          featureInventory.inexactFrequencyCount += 1
        }
        return [row.trip_id, startTime, endTime, headwaySecs, exactTimes]
      })
    await importTable('shapes.txt', 0.3,
      'INSERT INTO shape_points VALUES(?,?,?,?)',
      (row) => [row.shape_id, numeric(row.shape_pt_sequence), numeric(row.shape_pt_lat), numeric(row.shape_pt_lon)])
    await importTable('stop_times.txt', 0.32,
      'INSERT INTO stop_times VALUES(?,?,?,?,?,?,?,?,?)',
      (row) => {
        if (row.location_id || row.location_group_id || row.start_pickup_drop_off_window || row.end_pickup_drop_off_window) {
          flexTripIds.add(row.trip_id)
          return null
        }
        const context = `trip ${row.trip_id || '(missing trip_id)'} stop_sequence ${row.stop_sequence || '(missing sequence)'}`
        const pickupType = requiredGtfsEnum(row.pickup_type, [0, 1, 2, 3], 'pickup_type', context, 0)
        const dropOffType = requiredGtfsEnum(row.drop_off_type, [0, 1, 2, 3], 'drop_off_type', context, 0)
        // Type 3 is a fixed flag stop: the rider signals the driver.
        // Type 2 requires advance agency coordination and remains unavailable.
        if (pickupType === 2 || dropOffType === 2) bookingTripIds.add(row.trip_id)
        const restrictedPickup = pickupType === 1 || pickupType === 2
        const restrictedDropOff = dropOffType === 1 || dropOffType === 2
        const continuousPickup = Boolean(String(row.continuous_pickup ?? '').trim()) && numeric(row.continuous_pickup, 1) !== 1
        const continuousDropOff = Boolean(String(row.continuous_drop_off ?? '').trim()) && numeric(row.continuous_drop_off, 1) !== 1
        if (restrictedPickup) featureInventory.restrictedPickupStopTimeCount += 1
        if (restrictedDropOff) featureInventory.restrictedDropOffStopTimeCount += 1
        if (pickupType === 2) featureInventory.onDemandPickupStopTimeCount += 1
        if (dropOffType === 2) featureInventory.onDemandDropOffStopTimeCount += 1
        if (pickupType === 3 || dropOffType === 3) featureInventory.driverCoordinatedStopTimeCount += 1
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

        return [
          row.trip_id,
          stopSequence,
          row.stop_id,
          arrival,
          departure,
          restrictedPickup || (wheelchair && boardingAccessibility.get(row.stop_id) !== 1) ? 0 : 1,
          restrictedDropOff || (wheelchair && boardingAccessibility.get(row.stop_id) !== 1) ? 0 : 1,
          pickupType,
          dropOffType,
        ]
      })
    const continuousPresent = featureInventory.routeContinuousRuleCount + featureInventory.continuousPickupStopTimeCount + featureInventory.continuousDropOffStopTimeCount > 0
    if (flexTripIds.size || bookingTripIds.size || continuousPresent) {
      const flex = await importFlexCatalog({ archive, streamTable, db, prefix, budget: zipImportBudget, windows: new Set([...flexTripIds, ...bookingTripIds]), onDemandTrips: flexTripIds, tripModels: flexTripModels, continuousPresent })
      const remove = stage.prepare('DELETE FROM stop_times WHERE trip_id=?')
      runTransaction(stage, () => { for (const id of flexTripIds) remove.run(id) })
      featureInventory.flexTripCount = flexTripIds.size - flex.omittedOnDemandTripCount
      featureInventory.flexCatalogOmittedTripCount = flex.omittedFixedTripCount + flex.omittedOnDemandTripCount
    }
    featureInventory.excludedTripCount = excludedTripIds.size

    const pathwaysEntry = gtfsTableEntry(archive, 'pathways.txt')
    if (pathwaysEntry) {
      report(onProgress, 'Reading pathways.txt', 0.31)
      const insertPathway = db.prepare('INSERT OR IGNORE INTO transfers VALUES(?,?,0,?)')
      const insertPathwayProvenance = db.prepare('INSERT OR IGNORE INTO transfer_provenance VALUES(?,?,?,NULL,?)')
      const existingPathway = db.prepare(`SELECT min_transfer_time,transfer_type,provenance,path_distance_m FROM transfers
        JOIN transfer_provenance USING(from_stop_id,to_stop_id) WHERE from_stop_id=? AND to_stop_id=?`)
      const wheelchairMinimum = wheelchair ? db.prepare('SELECT min_transfer_time FROM wheelchair_transfer_minimum WHERE from_stop_id=? AND to_stop_id=?') : null
      const replacePathway = db.prepare('INSERT OR REPLACE INTO transfers VALUES(?,?,0,?)')
      const replacePathwayProvenance = db.prepare('INSERT OR REPLACE INTO transfer_provenance VALUES(?,?,?,NULL,?)')
      const pathwayStop = db.prepare('SELECT lon, lat FROM stops WHERE stop_id=?')
      let pathwayBatch = 0
      db.exec('BEGIN IMMEDIATE')
      try {
        const pathwayProfile = await streamTable(pathwaysEntry, (row) => {
          const optionalCost = (value, field) => {
            if (!String(value ?? '').trim()) return null
            const cost = Number(value)
            if (!Number.isFinite(cost) || cost < 0) throw new Error(`Invalid GTFS pathway ${field}: ${row.pathway_id}`)
            return cost
          }
          const publishedSeconds = optionalCost(row.traversal_time, 'traversal_time')
          const estimatedSeconds = publishedSeconds == null ? estimatedPathwaySeconds(row) : null
          const wheelchairCost = wheelchair ? wheelchairPathwayCost(row, {
            accessibleEndpoints: boardingAccessibility.get(row.from_stop_id) === 1
              && boardingAccessibility.get(row.to_stop_id) === 1,
            sameLevel: Boolean(wheelchairStops.get(row.from_stop_id)?.level)
              && wheelchairStops.get(row.from_stop_id).level === wheelchairStops.get(row.to_stop_id)?.level,
          }) : null
          const seconds = wheelchair ? wheelchairCost?.seconds ?? null : publishedSeconds ?? estimatedSeconds
          if (wheelchair && seconds == null) featureInventory.wheelchairExcludedPathwayCount = (featureInventory.wheelchairExcludedPathwayCount ?? 0) + 1
          const provenance = wheelchair ? wheelchairCost?.provenance ?? 'gtfs_pathway'
            : estimatedSeconds == null ? 'gtfs_pathway' : 'gtfs_pathway_estimated'
          const from = pathwayStop.get(row.from_stop_id)
          const to = pathwayStop.get(row.to_stop_id)
          const chord = from && to && [from.lon, from.lat, to.lon, to.lat].every(Number.isFinite)
            ? haversineKm([from.lon, from.lat], [to.lon, to.lat]) * 1000 : null
          // Co-located station levels do not establish a zero-time connection.
          const distanceM = wheelchair && seconds == null ? null
            : (wheelchair ? optionalCost(row.wheelchair_length, 'wheelchair_length') || null : null)
              ?? optionalCost(row.length, 'length') ?? (chord > 0 ? chord : null)
          if (seconds == null && distanceM == null) {
            featureInventory.unpricedPathwayCount = (featureInventory.unpricedPathwayCount ?? 0) + 1
          }
          const addPathway = (fromId, toId) => {
            if (wheelchair) {
              const existing = existingPathway.get(fromId, toId)
              if (existing?.transfer_type === 3) return
              const minimum = wheelchairMinimum.get(fromId, toId)?.min_transfer_time ?? 0
              const duration = seconds == null ? null : Math.max(seconds, minimum ?? 0)
              // Parallel stairs must not erase an elevator, regardless of row order.
              if (['gtfs_pathway', 'gtfs_pathway_estimated'].includes(existing?.provenance) && existing.min_transfer_time != null
                && (duration == null || existing.min_transfer_time <= duration)) return
              replacePathway.run(fromId, toId, duration)
              replacePathwayProvenance.run(fromId, toId, provenance, distanceM)
            } else {
              const existing = existingPathway.get(fromId, toId)
              const candidate = { min_transfer_time: seconds, provenance, path_distance_m: distanceM }
              const duration = transferDurationSeconds(candidate)
              if (['gtfs_pathway', 'gtfs_pathway_estimated'].includes(existing?.provenance)
                && duration != null && (transferDurationSeconds(existing) == null || duration < transferDurationSeconds(existing))) {
                replacePathway.run(fromId, toId, seconds)
                replacePathwayProvenance.run(fromId, toId, provenance, distanceM)
                return
              }
              const inserted = insertPathway.run(fromId, toId, seconds)
              if (Number(inserted.changes ?? 0)) insertPathwayProvenance.run(fromId, toId, provenance, distanceM)
            }
          }
          addPathway(row.from_stop_id, row.to_stop_id)
          if (numeric(row.is_bidirectional, 0) === 1) addPathway(row.to_stop_id, row.from_stop_id)
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
    if (wheelchair) {
      // Generic transfer rows are timing rules, not wheelchair path evidence.
      // Retain their minima separately, then free the pair for an independently
      // proved street connection. Keeping an unproved row here would make the
      // OSM compiler's INSERT OR IGNORE discard that physical evidence.
      db.exec(`
        DELETE FROM transfers WHERE transfer_type!=3 AND from_stop_id!=to_stop_id
          AND EXISTS(SELECT 1 FROM transfer_provenance AS p
            WHERE p.from_stop_id=transfers.from_stop_id AND p.to_stop_id=transfers.to_stop_id
              AND p.provenance='gtfs_transfer');
        DELETE FROM transfer_provenance WHERE NOT EXISTS(SELECT 1 FROM transfers AS t
          WHERE t.from_stop_id=transfer_provenance.from_stop_id AND t.to_stop_id=transfer_provenance.to_stop_id);
      `)
    }
    report(onProgress, 'Ordering stop times', 0.72)
    stage.exec('CREATE INDEX stop_times_trip_sequence ON stop_times(trip_id, stop_sequence);')
    report(onProgress, 'Compiling transit connections', 0.72)
    const compilationStarted = performance.now()
    let compiled
    // SQLite implementations must never share open handles during a write.
    // Transfer ownership only after all admission transactions have committed.
    stage.close()
    stage = null
    db.close()
    if (sharedDatabase) sharedDatabase.current = null
    try {
      compiled = compileNativeGtfsConnections({ storePath: tempPath, stopTimesPath: stagePath,
        excludedTripIds: [...excludedTripIds], invalidTimePolicy: 'repair', cacheKib: buildSqliteCacheKiB })
    } finally {
      db = new DatabaseSync(tempPath)
      if (sharedDatabase) sharedDatabase.current = db
      configureBuildDatabase(db)
    }

    const { connectionCount, bridgedUntimedGapCount, exactFrequencyExpandedTripCount, exactFrequencyExpandedConnectionCount } = compiled
    onProgress?.({ phase: 'Compiled transit connections', progress: 0.89, compiler: {
      backend: 'rust', durationMs: performance.now() - compilationStarted, connectionCount,
    } })
    counts.connections = connectionCount

    if (!sharedDatabase) report(onProgress, 'Linking nearby interchanges', 0.895)
    const nearbyTransfers = sharedDatabase ? { candidateCount: 0, inferredTransferCount: 0 } : linkNearbyTransferStops(db)
    counts.inferredTransfers = nearbyTransfers.inferredTransferCount

    if (!sharedDatabase) report(onProgress, 'Building routing indexes', 0.9)
    if (!sharedDatabase) createRoutingStoreIndexes(db, { forCity })
    const quarantinedTimeTripCount = Number(compiled.quarantinedTimeTripCount ?? 0)
    featureInventory.quarantinedTimeTripCount = quarantinedTimeTripCount
    featureInventory.quarantinedTimeTripSamples = compiled.quarantinedTimeTripSamples ?? []
    if (quarantinedTimeTripCount) report(onProgress, 'Timetable warning', 0.9, `${quarantinedTimeTripCount} trip(s) with backward times excluded; source times preserved.`)
    const repairedTimeTripCount = Number(compiled.repairedTimeTripCount ?? 0)
    featureInventory.repairedTimeTripCount = repairedTimeTripCount
    featureInventory.repairedTimeTripSamples = compiled.repairedTimeTripSamples ?? []
    if (repairedTimeTripCount) report(onProgress, 'Timetable warning', 0.9, `${repairedTimeTripCount} trip(s) with backward times repaired by delaying events at most 600 seconds; source times preserved.`)
    const blockingRoutingFeatures = []
    const routingLimitations = []
    const blockFeature = (code, count, detail) => {
      if (count > 0) blockingRoutingFeatures.push({ code, count, detail })
    }
    const limitFeature = (code, count, detail) => {
      if (count > 0) routingLimitations.push({ code, count, exactness: 'unsupported', detail })
    }
    if (repairedTimeTripCount) routingLimitations.push({ code: 'repaired_trip_times', count: repairedTimeTripCount,
      exactness: 'approximate', detail: 'Backward times were clamped to the preceding event, delaying each event by at most 600 seconds. All stops and permissions are retained; source ZIPs are unchanged.' })
    limitFeature('backward_trip_times', quarantinedTimeTripCount,
      'Trips requiring time corrections greater than 600 seconds are excluded in full. Source times are preserved; no partial trip is routed.')
    blockFeature('multiple_agency_timezones', Math.max(0, agencyTimezones.size - 1),
      'A single routing store cannot yet resolve service-day coordinates across multiple agency timezones.')
    featureInventory.exactFrequencyExpandedTripCount = exactFrequencyExpandedTripCount
    featureInventory.exactFrequencyExpandedConnectionCount = exactFrequencyExpandedConnectionCount
    if (featureInventory.inexactFrequencyCount) routingLimitations.push({code:'frequency_based_service',count:featureInventory.inexactFrequencyCount,exactness:'approximate',detail:"Frequency-based trips (GTFS exact_times=0) depart every headway from each window's start. Actual departures may differ; times are estimates."})
    if (featureInventory.flexTripCount) routingLimitations.push({code: 'flex_service', count: featureInventory.flexTripCount, exactness: 'conditional', detail: 'Flex service requires an explicit flex request and OSM driving estimates. Booking and vehicle availability are not confirmed.'})
    if (featureInventory.flexCatalogOmittedTripCount) routingLimitations.push({ code: 'flex_catalog_limit', count: featureInventory.flexCatalogOmittedTripCount, exactness: 'unsupported',
      detail: 'Conditional trip details exceed the 32 MiB Flex catalog. Fixed-route continuous-stopping and booking trips are omitted first, then on-demand trips; scheduled service is unaffected.' })
    limitFeature('on_demand_boarding_or_alighting', featureInventory.onDemandPickupStopTimeCount + featureInventory.onDemandDropOffStopTimeCount,
      'pickup_type/drop_off_type value 2 requires booking. Omitted by default; flex requests may return conditional journeys with booking instructions.')
    if (featureInventory.driverCoordinatedStopTimeCount) routingLimitations.push({
      code: 'driver_coordinated_stops', count: featureInventory.driverCoordinatedStopTimeCount,
      exactness: 'conditional', detail: 'Fixed-stop pickup_type/drop_off_type=3 is routable. Riders must signal or notify the driver to board or alight; service assumes this coordination.',
    })
    limitFeature('continuous_pickup_or_drop_off', featureInventory.routeContinuousRuleCount + featureInventory.tripContinuousRuleCount + featureInventory.continuousPickupStopTimeCount + featureInventory.continuousDropOffStopTimeCount,
      'Fixed-stop service is retained. Opt-in Flex requests support continuous stopping on directed GTFS shapes with interpolated clocks and source permission overrides.')

    limitFeature('block_interlining', featureInventory.blockTripCount,
      'Rust infers consecutive same-terminal block continuations within one service_id and service day. Different-terminal, cross-service and ambiguous block continuations still require explicit linked trips.')
    limitFeature('timed_transfer_guarantee', featureInventory.timedTransferCount,
      'Timed transfers waive the default transfer buffer in Rust. Vehicle holding after a missed scheduled connection is not predicted.')
    limitFeature('pathway_accessibility', wheelchair ? 0 : featureInventory.pathwayAccessibilityRuleCount,
      'Pathway direction and traversal time are used, but accessibility attributes are not query constraints.')
    limitFeature('unpriced_pathways', featureInventory.unpricedPathwayCount ?? 0,
      'Pathways without traversal time, length, or distinct located endpoints are excluded. Their declared station connectivity still suppresses inferred shortcuts.')
    limitFeature('wheelchair_accessibility', wheelchair ? 0 : featureInventory.stopWheelchairBoardingRuleCount + featureInventory.tripWheelchairAccessibleRuleCount,
      'Stop wheelchair_boarding and trip wheelchair_accessible values require a separately prepared wheelchair City to constrain routing.')
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
      // Streets are prepared separately; the description records their evidence.
      ...(wheelchair ? { accessibility: wheelchairDescriptionFor(wheelchairStreets) } : {}),
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
      ...serviceTimeBounds(db),
      boardingAlightingModel: 'sparse-connection-permissions-v1',
      departureIndexState: forCity ? 'deferred' : 'ready',
      stopAccessRoleIndexVersion,
      stopAccessRoleCount: countFeedRows('stop_access_roles', 'stop_id'),
      calendarDateCount: counts['calendar_dates.txt'] ?? 0,
      transferCount: countFeedRows('transfers', 'from_stop_id'),
      frequencyCount: counts['frequencies.txt'] ?? 0,
      frequencyRoutingModel: featureInventory.inexactFrequencyCount > 0 ? 'inexact_frequency_departures_every_headway' : exactFrequencyExpandedTripCount > 0 ? 'exact_times_1_expanded_fixed_departures' : 'none',
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
    stage?.close()
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
      try { stage?.close() } catch {}
      await fsp.rm(stagePath, { force: true })
    } else {
      await cleanupFailedRoutingStoreBuild([db, stage], tempPath, outputPath, [stagePath])
    }
    throw error
  }
}

export async function buildNationalGtfsCityStore({ feeds, outputPath, onProgress, wheelchair = false, wheelchairStreets = 'inferred' }) {
  if (!Array.isArray(feeds) || !feeds.length) throw new Error('At least one GTFS feed is required.')
  const descriptors = feeds.map((feed) => ({ scope: String(feed.scope ?? '').trim(), zipPath: path.resolve(feed.path) }))
    .sort((left, right) => left.scope.localeCompare(right.scope))
  if (descriptors.some((feed) => !feed.scope) || new Set(descriptors.map((feed) => feed.scope)).size !== descriptors.length) {
    throw new Error('GTFS scopes must be non-empty and unique.')
  }
  if (descriptors.length === 1) {
    return buildNationalGtfsStore({ zipPath: descriptors[0].zipPath, outputPath, onProgress, forCity: true, wheelchair, wheelchairStreets })
  }
  const started = performance.now()
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.building`
  await discardRoutingBuildDatabase(tempPath)
  const sharedDatabase = { current: new DatabaseSync(tempPath) }
  configureBuildDatabase(sharedDatabase.current)
  createRoutingStoreSchema(sharedDatabase.current)
  try {
    const metadataByStore = []
    for (const feed of descriptors) {
      metadataByStore.push(await importGtfsFeed({
        zipPath: feed.zipPath, outputPath, sharedDatabase, scope: feed.scope, forCity: true, wheelchair, wheelchairStreets,
        onProgress: onProgress ? (event) => onProgress({ ...event, phase: `${feed.scope}: ${event.phase}` }) : undefined,
      }))
    }
    const db = sharedDatabase.current
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
    await cleanupFailedRoutingStoreBuild([sharedDatabase.current], tempPath, outputPath)
    throw error
  }
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Frequency templates are relative shapes: availability extends to the end of
// their service windows, including tails after midnight.
function serviceTimeBounds(db) {
  const row = db.prepare(`
    SELECT COALESCE(MIN(first), 0) AS first, COALESCE(MAX(last), 0) AS last
    FROM (
      SELECT MIN(departure) AS first, MAX(arrival) AS last FROM connections
      UNION ALL
      SELECT f.start_time AS first, f.end_time + h.duration AS last
      FROM frequencies f
      JOIN (
        SELECT trip_id, MAX(arrival) - MIN(departure) AS duration
        FROM headway_connections GROUP BY trip_id
      ) h ON h.trip_id = f.trip_id
      WHERE f.exact_times = 0
    )
  `).get()
  return { minimumServiceTimeSeconds: Number(row.first), maximumServiceTimeSeconds: Number(row.last) }
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
    ...(metadataByStore[0].accessibility ? { accessibility: metadataByStore[0].accessibility } : {}),
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
    ...serviceTimeBounds(db),
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
    if (metadata.accessibility) throw new Error('Build wheelchair Cities from the original GTFS feeds; merging prepared wheelchair stores is unsupported.')
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
        copyFlexCatalogs(db, alias, prefix)
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
          INSERT INTO trip_details
            SELECT ${prefixSql} || trip_id, headsign, short_name FROM ${alias}.trip_details;
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
        if (db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE name='trip_origins'`).get()) db.exec(`INSERT INTO trip_origins SELECT ${prefixSql} || trip_id,${prefixSql} || source_trip_id FROM ${alias}.trip_origins`)
        if (db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE name='headway_connections'`).get()) {
          db.exec(`INSERT INTO headway_connections SELECT departure,arrival,${prefixSql} || trip_id,${prefixSql} || route_id,${prefixSql} || service_id,direction_id,${prefixSql} || from_stop_id,${prefixSql} || to_stop_id,stop_sequence FROM ${alias}.headway_connections`)
        }
        if (db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE type='table' AND name='transfer_rules'`).get()) {
          db.exec(`INSERT INTO transfer_rules SELECT ${['from_stop_id','to_stop_id','from_route_id','to_route_id','from_trip_id','to_trip_id'].map(key => `CASE WHEN ${key} IS NULL THEN NULL ELSE ${prefixSql} || ${key} END`).join(',')}, transfer_type,min_transfer_time FROM ${alias}.transfer_rules`)
        }
        if (db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE type='table' AND name='trip_links'`).get()) {
          db.exec(`INSERT INTO trip_links SELECT ${prefixSql} || from_trip_id,
            ${prefixSql} || to_trip_id, transfer_type FROM ${alias}.trip_links`)
        }
        if (db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE type='table' AND name='trip_operations'`).get()) {
          db.exec(`INSERT INTO trip_operations SELECT ${prefixSql} || trip_id,
            CASE WHEN block_id IS NULL THEN NULL ELSE ${prefixSql} || block_id END,
            bikes_allowed FROM ${alias}.trip_operations`)
        }
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
    const duration = transferDurationSeconds(transfer)
    if (duration == null) continue
    insertEdge.run(
      transfer.from_stop_id,
      transfer.to_stop_id,
      duration,
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

export function expandParentStationTransfers(rawTransfers, stopRecords, stationMembers, wheelchair = false) {
  const parentMinimumRules = []
  const declaredPathwayStops = new Set()
  const targetMaps = new Map()
  let rawTransferCount = 0
  const add = (transfer) => {
    if (!stopRecords.has(transfer.from_stop_id) || !stopRecords.has(transfer.to_stop_id)) return
    const targets = targetMaps.get(transfer.from_stop_id) ?? new Map()
    const current = targets.get(transfer.to_stop_id)
    const duration = stationTransferDurationSeconds(transfer,
      stopRecords.get(transfer.from_stop_id), stopRecords.get(transfer.to_stop_id))
    if (duration == null) return
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
    if (['gtfs_pathway', 'gtfs_pathway_estimated'].includes(rawTransfer.provenance)) {
      declaredPathwayStops.add(rawTransfer.from_stop_id)
      declaredPathwayStops.add(rawTransfer.to_stop_id)
    }
    if (rawTransfer.provenance === 'gtfs_transfer'
      && Number(rawTransfer.transfer_type) === 2
      && (numeric(stopRecords.get(rawTransfer.from_stop_id)?.location_type, 0) === 1
        || numeric(stopRecords.get(rawTransfer.to_stop_id)?.location_type, 0) === 1)) {
      parentMinimumRules.push(rawTransfer)
    }
    if (wheelchair && rawTransfer.provenance === 'gtfs_transfer' && Number(rawTransfer.transfer_type) !== 3
      && rawTransfer.from_stop_id !== rawTransfer.to_stop_id) continue
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

  // A published parent-station type-2 rule is a boarding minimum for
  // every covered platform pair, including faster generated walking edges.
  // Retain only these source rules: the database iterator is consumed once.
  for (const rule of parentMinimumRules) {
    const minimum = transferDurationSeconds(rule)
    for (const from of serviceMembers(rule.from_stop_id)) {
      for (const to of serviceMembers(rule.to_stop_id)) {
        const edge = targetMaps.get(from)?.get(to)
        if (!edge || edge.min_transfer_time >= minimum) continue
        targetMaps.get(from).set(to, {
          ...edge,
          min_transfer_time: minimum,
          parentStationMinimumSeconds: minimum,
          parentStationMinimumFrom: rule.from_stop_id,
          parentStationMinimumTo: rule.to_stop_id,
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
  return { transfers, rawTransferCount, resolvedTransferCount, declaredPathwayStops }
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
  const stopRecords = new Map()
  const wheelchair = store.metadata.accessibility?.profile === wheelchairProfile
  const accessibility = wheelchair ? new Map(db.prepare('SELECT stop_id,boarding FROM wheelchair_stops').all().map(row => [row.stop_id, row.boarding])) : null
  for (const stop of db.prepare('SELECT stop_id, name, lat, lon, parent_station, location_type FROM stops ORDER BY stop_id').all()) {
    if (wheelchair) stop.wheelchair_boarding = accessibility.get(stop.stop_id) ?? 0
    stopRecords.set(stop.stop_id, stop)
  }
  const stationMembers = stationHierarchyMembers(stopRecords)
  const {
    transfers,
    rawTransferCount,
    resolvedTransferCount,
    declaredPathwayStops,
  } = expandParentStationTransfers(
    db.prepare(`${transferSelect} WHERE transfer.transfer_type != 3`).iterate(),
    stopRecords,
    stationMembers, wheelchair,
  )
  // Never invent connections or snap through a station interior in this profile.
  if (wheelchair) for (const stop of stopRecords.values()) declaredPathwayStops.add(stop.stop_id)
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
  const transferMinimums = wheelchair ? expandParentStationTransfers(
    db.prepare("SELECT from_stop_id,to_stop_id,min_transfer_time,2 AS transfer_type,'gtfs_transfer' AS provenance FROM wheelchair_transfer_minimum").iterate(),
    stopRecords, stationMembers,
  ).transfers : new Map()
  for (const [from, minima] of transferMinimums) for (const rule of minima) {
    const edge = transfers.get(from)?.find(edge => edge.to_stop_id === rule.to_stop_id)
    if (edge) edge.min_transfer_time = Math.max(edge.min_transfer_time, rule.min_transfer_time)
  }
  const materialized = {
    transfers,
    declaredPathwayStops,
    forbiddenTransferPairs,
    rawTransferCount,
    rawForbiddenTransferCount: forbiddenTransferExpansion.rawTransferCount,
    resolvedTransferCount,
    stationMembers,
    stopRecords,
    stopAccessIndex,
  }
  materialized.transferShortcuts = prepareServiceTransfers({ ...materialized, transferMinimums })
  return materialized
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
    tripDetailsLookup: db.prepare('SELECT headsign, short_name FROM trip_details WHERE trip_id=?'),
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
    // Street transfers connect public entrances; timetable propagation then
    // follows the declared station pathways. Restore the expanded endpoint
    // profile before the worker begins serving point queries.
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

function activateServices(store, serviceDate, serviceDay = 'weekday') {
  const serviceCalendarKey = `${serviceDate}|${serviceDay}|`
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

function activeServiceKernelMemoryDelta(before, after) {
  return {
    rssBytes: after.rss - before.rss,
    heapUsedBytes: after.heapUsed - before.heapUsed,
    externalBytes: after.external - before.external,
    arrayBufferBytes: after.arrayBuffers - before.arrayBuffers,
  }
}

// Loaded snapshots and freshly compiled slices have one readiness contract.
// Persistence and read failures are added by the branch that owns that work.
function activeServiceKernelReadyStatus(store, kernel, services, nativeTimetableKernel) {
  return {
    ready: true,
    reason: 'ready',
    schemaVersion: kernel.schemaVersion,
    sourceStorageIdentity: kernel.sourceStorageIdentity,
    accessPolicyIdentity: nationalRoutingAccessPolicyIdentity,
    serviceKey: kernel.serviceKey,
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
        ? activeServiceKernelMaxEstimatedBytes - kernel.estimatedBytes : null,
    },
    compileMs: kernel.compileMs,
    buildMs: kernel.buildMs,
    memoryDelta: kernel.memoryDelta,
    nativeTimetableKernel,
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
    kernel.memoryDelta = activeServiceKernelMemoryDelta(memoryBefore, memoryAfter)
    store.activeServiceKernel = kernel
    store.activeServiceKernelStatus = {
      ...activeServiceKernelReadyStatus(store, kernel, services, nativeTimetableKernel),
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
    // Count the active slice before native allocation so the byte guard can
    // reject oversized inputs without constructing the timetable.
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
      tripIds, routeIds, serviceIds, directionIds, tripServiceDates, runCount, stopCount,
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
      tripServiceDates,
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
    kernel.memoryDelta = activeServiceKernelMemoryDelta(memoryBefore, memoryAfter)
    store.activeServiceKernel = kernel
    store.activeServiceKernelStatus = {
      ...activeServiceKernelReadyStatus(store, kernel, services, nativeTimetableKernel),
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

