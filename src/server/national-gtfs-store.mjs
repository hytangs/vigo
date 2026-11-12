import { stationHierarchyMembers } from './gtfs/station-hierarchy.mjs'
import { wheelchairProfile } from './wheelchair-policy.mjs'
import { prepareServiceTransfers } from './gtfs/transfer-paths.mjs'
import { readServiceTimetable } from './gtfs/service-timetable.mjs'
import { boundedInteger, defaultTimetableBudgetBytes, timetableBudgetBytes } from './runtime/resource-limits.mjs'
import {
  nativeCoordinateAccessProfile,
  pruneRoutingSnapshotCache
} from './gtfs/coordinate-access.mjs'

import {
  nationalRoutingAccessPolicyIdentity,
  requiredServiceCoverageIncomplete,
  transferDurationSeconds,
  stationTransferDurationSeconds,
  walkSeconds
  } from './gtfs/routing-policy.mjs'
import {
  completeServiceDateSuggestions,
  resolveServiceDate,
  serviceDateDiagnostics,
  servicesForDate
} from './gtfs/service-calendar.mjs'
import {
  buildStopAccessIndex,
  deferredStopAccessIndex,
  stopAccessIndexDiagnostics
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
  staticTopologySourceMatches,
  staticTopologySourceStorageIdentity,
  staticTopologySourceStorageSnapshot,
  transferSemanticsVersion
} from './gtfs/store-metadata.mjs'
import { prepareTimetableIndexes } from './gtfs/timetable-preparation.mjs'
import {
  clearServiceAccessAnchors
} from './gtfs/walking-plans.mjs'
import { boundedCacheGet } from './weighted-lru-cache.mjs'
export { nationalFeedSummary,readNationalGtfsPreview,readNationalGtfsRouteCatalog } from './gtfs/network-preview.mjs'
export { readNationalGtfsStoreMetadata } from './gtfs/store-metadata.mjs'

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  prepareNativeTimetableKernel
} from './native-routing-kernel.mjs'
import { numeric, timingMilliseconds } from './number-utils.mjs'
import { loadPreparedAccessContext, persistPreparedAccessContext } from './prepared-access-context.mjs'
import { stableKeySuffix } from './routing-plan-identity.mjs'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from './routing-snapshot.mjs'
import { resolveServiceDay } from './service-day.mjs'
import { WeightedLruCache } from './weighted-lru-cache.mjs'
import { runCityCompiler, runCityCompilerSync } from './runtime/city-compiler.mjs'
import { readerBusyTimeoutMs } from './sqlite-readers.mjs'

const staticTopologySchemaVersion = 'vigo.routing.static-topology.v4'
const staticTopologyMinimumFreeBytes = 2 * 1024 * 1024 * 1024
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
  )
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

// City data is compiled by the `vigo` executable. These keep the published
// JavaScript entry points for Studio, scripts and checks; each returns the
// compiler's JSON result.
function wheelchairArguments({ wheelchair = false, wheelchairStreets = 'inferred' } = {}) {
  return wheelchair ? ['--wheelchair', `--wheelchair-streets=${wheelchairStreets}`] : []
}

// Admit the store here so callers receive the published admission errors.
export function compactNationalGtfsRuntimeStore(storePath) {
  const resolvedPath = path.resolve(storePath)
  invalidateNationalStore(resolvedPath)
  return runCityCompilerSync('_compact-gtfs-store', [`--store=${resolvedPath}`], { label: 'GTFS compaction' })
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

export function nationalStaticTopologySidecarPath(storePath) {
  return `${path.resolve(storePath)}.static-topology.sqlite`
}

function routingArtifactSourceIdentity(storePath, sourceMetadata) {
  return `${staticTopologySourceIdentity(sourceMetadata)}\n${sqliteStoreGeneration(storePath)}`
}

async function refreshNationalGtfsDerivedArtifacts(storePath, options = {}) {
  const resolvedStorePath = path.resolve(storePath)
  if (options.sidecarPath && path.resolve(options.sidecarPath) !== nationalStaticTopologySidecarPath(resolvedStorePath)) {
    throw new Error('Derived artifacts are refreshed at the store\'s own sidecar path.')
  }
  disposeNationalGtfsStore(resolvedStorePath)
  try {
    return await runCityCompiler('_refresh-topology', [`--store=${resolvedStorePath}`, '--progress=json'], {
      label: 'Derived artifact refresh', onProgress: options.onProgress,
    })
  } finally {
    disposeNationalGtfsStore(resolvedStorePath)
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

export async function ensureNationalGtfsStopAccessRoles(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  readNationalGtfsStoreMetadata(resolvedStorePath)
  const result = await runCityCompiler('_stop-access-roles', [`--store=${resolvedStorePath}`], { label: 'Stop access roles' })
  // A current index leaves the store and its open context untouched.
  if (result.built) invalidateNationalStore(resolvedStorePath)
  return result
}

export async function buildNationalGtfsStore({ zipPath, outputPath, onProgress, forCity = false, wheelchair = false, wheelchairStreets = 'inferred' }) {
  invalidateNationalStore(outputPath)
  return runCityCompiler('_build-gtfs-store', [
    ...(forCity ? ['--city', '--gtfs-scope=feed'] : []), `--gtfs=${path.resolve(zipPath)}`,
    `--output-store=${path.resolve(outputPath)}`, ...wheelchairArguments({ wheelchair, wheelchairStreets }), '--progress=json',
  ], { label: 'GTFS compiler', onProgress })
}

export async function buildNationalGtfsCityStore({ feeds, outputPath, onProgress, wheelchair = false, wheelchairStreets = 'inferred' }) {
  if (!Array.isArray(feeds) || !feeds.length) throw new Error('At least one GTFS feed is required.')
  invalidateNationalStore(outputPath)
  return runCityCompiler('_build-gtfs-store', [
    '--city', ...feeds.flatMap(feed => [`--gtfs=${path.resolve(feed.path)}`, `--gtfs-scope=${String(feed.scope ?? '')}`]),
    `--output-store=${path.resolve(outputPath)}`, ...wheelchairArguments({ wheelchair, wheelchairStreets }), '--progress=json',
  ], { label: 'GTFS compiler', onProgress })
}

export async function mergeNationalGtfsStores({ stores, outputPath, onProgress, removeSourcesAfterMerge = false, forCity = false }) {
  if (!Array.isArray(stores) || stores.length < 2) throw new Error('At least two exact-date routing stores are required.')
  invalidateNationalStore(outputPath)
  const result = await runCityCompiler('_build-gtfs-store', [
    ...stores.map((store, index) => `--merge-store=${String(store.scope || `feed-${index + 1}`)}=${path.resolve(store.storePath)}`),
    ...(forCity ? ['--city'] : []), `--output-store=${path.resolve(outputPath)}`, '--progress=json',
  ], { label: 'GTFS merge', onProgress })
  if (removeSourcesAfterMerge) {
    const cleanupWarnings = []
    for (const store of stores) {
      try {
        await fsp.rm(path.resolve(store.storePath), { force: true })
      } catch (error) {
        cleanupWarnings.push({ storePath: path.resolve(store.storePath), reason: error instanceof Error ? error.message : String(error) })
      }
    }
    result.cleanupWarnings = cleanupWarnings
  }
  return result
}

function inspectNationalStaticTopology(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true, timeout: readerBusyTimeoutMs })
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
  const sourceDb = new DatabaseSync(storePath, { readOnly: true, timeout: readerBusyTimeoutMs })
  const sidecarDb = new DatabaseSync(resolvedSidecarPath, { readOnly: true, timeout: readerBusyTimeoutMs })
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

export async function buildNationalStaticTopologySidecar({ storePath, outputPath, onProgress, minimumFreeBytes, force = false }) {
  return runCityCompiler('_build-static-topology', [
    `--store=${path.resolve(storePath)}`, `--output=${path.resolve(outputPath)}`,
    ...(force === true ? ['--force'] : []),
    ...(minimumFreeBytes === undefined ? [] : [`--minimum-free-bytes=${numeric(minimumFreeBytes, staticTopologyMinimumFreeBytes)}`]),
    '--progress=json',
  ], { label: 'Static topology compiler', onProgress })
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
      db = new DatabaseSync(resolvedStorePath, { readOnly: true, timeout: readerBusyTimeoutMs })
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

export async function removeNationalGtfsOsmStopTransfers(storePath) {
  const resolvedPath = path.resolve(storePath)
  invalidateNationalStore(resolvedPath)
  try {
    // The compiler also rebuilds topology and timetable snapshots before any
    // query can reuse transfers whose street evidence the user has removed.
    const { removed } = await runCityCompiler('_remove-stop-transfers', [`--routing-store=${resolvedPath}`], {
      label: 'Stop transfer removal',
    })
    return { removed }
  } finally {
    invalidateNationalStore(resolvedPath)
  }
}

export async function ensureNationalGtfsOsmStopTransfers(storePath, streetStorePath, options = {}) {
  const resolvedStorePath = path.resolve(storePath)
  invalidateNationalStore(resolvedStorePath)
  try {
    return await runCityCompiler('_prepare-transfers', [
      `--routing-store=${resolvedStorePath}`, `--street-store=${path.resolve(streetStorePath)}`, '--progress=json',
    ], { label: 'Stop transfer compiler', onProgress: options.onProgress })
  } finally {
    invalidateNationalStore(resolvedStorePath)
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
      builder = new DatabaseSync(store.storePath, { readOnly: true, timeout: readerBusyTimeoutMs })
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

