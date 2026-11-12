import fsSync from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  disposeNativeRoutingKernel,
  buildNativeStreetCchIndex,
  prepareNativeDriveKernel,
  normalizeDriveTrafficSnapshot,
  prepareNativeRoutingKernel,
  routeNativeDriveCoordinates,
  normalizeNativeMilliseconds,
} from './native-routing-kernel.mjs'
import { validateArrivalBuffer } from './arrival-reserve.mjs'
import { timingMilliseconds } from './number-utils.mjs'
import { runCityCompiler, runCityCompilerSync } from './runtime/city-compiler.mjs'
import { readerBusyTimeoutMs } from './sqlite-readers.mjs'

// Keep the published v6 layout readable. Corrected walking permissions and
// connected platform boundaries apply to newly prepared graphs; existing
// Cities retain their original graph until explicitly rebuilt.
const streetStoreSchemaVersion = 'vigo.street.store.v6'
// A store is admitted by version, source model, and the objects the runtime
// actually queries. Column-by-column and index-SQL checks duplicated SQLite's
// schema and made harmless builder changes look like corrupt stores.
const streetStoreTableNames = Object.freeze(['metadata', 'walk_nodes', 'edges'])
const streetStoreIndexTables = Object.freeze({
  walk_nodes_lat_lon: 'walk_nodes',
  edges_from: 'edges',
})
const drivingStoreTableNames = Object.freeze(['drive_nodes', 'drive_edges'])
const drivingStoreIndexTables = Object.freeze({ drive_edges_from: 'drive_edges' })
// The `vigo` compiler writes the pedestrian and driving snapshots; this module
// reads them and never rebuilds a graph.
const streetAcceleratorSnapshotMagic = 'vigo.street.accelerator'
// v7 removes the runtime-unused OSM node-id copy and stores reverse-edge
// indices instead of duplicating every edge distance. The public graph and
// all route distances remain unchanged.
const streetAcceleratorSnapshotVersion = 7
const streetAcceleratorSnapshotHeaderBytes = 4096
const streetAcceleratorSnapshotSuffix = `.street-accelerator-v${streetAcceleratorSnapshotVersion}.bin`
const runtimeStreetStoreStorageLayout = 'runtime-snapshots-v1'
const readOnlySqliteMmapBytes = Math.max(
  0,
  Math.min(
    2 * 1024 * 1024 * 1024,
    Math.floor(Number(process.env.VIGO_READONLY_SQLITE_MMAP_BYTES ?? 256 * 1024 * 1024) || 0),
  ),
)
const readOnlySqliteCacheKiB = Math.max(
  4 * 1024,
  Math.min(256 * 1024, Math.floor(Number(process.env.VIGO_READONLY_SQLITE_CACHE_KIB ?? 32 * 1024) || 0)),
)
// Driving vertices include the shared pedestrian nodes, so this matches the
// pedestrian accelerator's scale: Switzerland has 16.3 million.
const driveAcceleratorMaximumNodes = Math.max(100_000, Number(process.env.VIGO_DRIVE_ACCELERATOR_MAX_NODES) || 40_000_000)
const driveAcceleratorMaximumEdges = Math.max(250_000, Number(process.env.VIGO_DRIVE_ACCELERATOR_MAX_EDGES) || 20_000_000)
const driveAcceleratorSnapshotMagic = 'vigo.drive.accelerator'
// v2 is a runtime-only drive graph: node ids are implicit array indices and
// edge weights are persisted in the same fixed-point units already consumed
// by the Rust kernel. The source SQLite graph is therefore not retained after
// preprocessing, and no float-to-fixed conversion is needed on cold load.
const driveAcceleratorSnapshotVersion = 2
const driveAcceleratorSnapshotHeaderBytes = 4096
const driveAcceleratorSnapshotSuffix = `.drive-accelerator-v${driveAcceleratorSnapshotVersion}.bin`
// A driving endpoint may walk this far, straight, to its nearest drivable road.
const defaultDriveAccessWalkKm = 1.2
// Endpoints attached farther than this past their nearest road had to skip a
// road detached from the main network.
const driveAttachmentRecoveryKm = 0.025
const streetStoreCacheMaximumEntries = Math.max(1, Math.min(16, Math.floor(Number(process.env.VIGO_STREET_STORE_CACHE_MAX_ENTRIES ?? 4) || 4)))

// Street stores are compiled by the `vigo` executable; this keeps the
// published entry point for Studio, scripts and checks.
export async function buildNationalOsmStore({
  pbfPath,
  outputPath,
  onProgress,
  buildDrivingProfile = process.env.VIGO_BUILD_DRIVE_ACCELERATOR === '1',
  includeDriving = true,
  includeBiking = false,
  wheelchair = false,
  wheelchairStreets = 'inferred',
  flexDriving = false,
}) {
  invalidateStreetStore(outputPath)
  return runCityCompiler('_build-street-store', [
    `--osm=${path.resolve(pbfPath)}`, `--output-store=${path.resolve(outputPath)}`,
    `--street-modes=${['walk', ...(includeDriving ? ['drive'] : []), ...(includeBiking ? ['bike'] : [])].join(',')}`,
    ...(wheelchair ? ['--wheelchair', `--wheelchair-streets=${wheelchairStreets}`] : []),
    ...(flexDriving ? ['--flex-driving'] : []), ...(buildDrivingProfile ? ['--drive-profile'] : []),
    '--progress=json',
  ], { label: 'OSM compiler', onProgress })
}

function driveAcceleratorEligibility(metadata) {
  if (metadata.schemaVersion !== streetStoreSchemaVersion) {
    return { eligible: false, reason: 'driving_profile_unavailable', nodeCount: 0, edgeCount: 0 }
  }
  const nodeCount = Math.max(0, Number(metadata.driveNodeCount ?? 0))
  const edgeCount = Math.max(0, Number(metadata.driveEdgeCount ?? 0))
  if (!nodeCount || !edgeCount) return { eligible: false, reason: 'driving_profile_empty', nodeCount, edgeCount }
  if (nodeCount > driveAcceleratorMaximumNodes) return { eligible: false, reason: 'node_budget', nodeCount, edgeCount }
  if (edgeCount > driveAcceleratorMaximumEdges) return { eligible: false, reason: 'edge_budget', nodeCount, edgeCount }
  return { eligible: true, reason: 'eligible', nodeCount, edgeCount }
}

function streetAcceleratorSnapshotPath(storePath) {
  return `${storePath}${streetAcceleratorSnapshotSuffix}`
}

function streetAcceleratorStoreIdentity(state) {
  return {
    identityVersion: 'source-metadata-v1',
    ...(state.metadata.accessibility ? { accessibility: state.metadata.accessibility.profile } : {}),
    schemaVersion: state.metadata.schemaVersion ?? null,
    sourceFingerprint: state.metadata.sourceFingerprint ?? null,
    sourceBytes: state.metadata.sourceBytes ?? null,
    metadataNodeCount: state.metadata.nodeCount ?? null,
    metadataEdgeCount: state.metadata.edgeCount ?? null,
  }
}

function streetAcceleratorIdentityMatches(headerIdentity, state) {
  const expected = streetAcceleratorStoreIdentity(state)
  return Object.entries(expected).every(([key, value]) => headerIdentity?.[key] === value)
}

function snapshotTypedArray(buffer, descriptor, Type) {
  if (!descriptor || descriptor.type !== Type.name || !Number.isInteger(descriptor.offset) || !Number.isInteger(descriptor.length)) {
    throw new Error(`Street accelerator snapshot has an invalid ${Type.name} descriptor.`)
  }
  const byteLength = descriptor.length * Type.BYTES_PER_ELEMENT
  if (descriptor.offset < streetAcceleratorSnapshotHeaderBytes || descriptor.offset + byteLength > buffer.byteLength) {
    throw new Error('Street accelerator snapshot array exceeds the file boundary.')
  }
  const byteOffset = buffer.byteOffset + descriptor.offset
  if (byteOffset % Type.BYTES_PER_ELEMENT) throw new Error('Street accelerator snapshot array is misaligned.')
  return new Type(buffer.buffer, byteOffset, descriptor.length)
}

const driveAcceleratorSnapshotArrays = [
  ['nodeLats', Float64Array],
  ['nodeLons', Float64Array],
  ['edgeOffsets', Uint32Array],
  ['edgeTargets', Uint32Array],
  ['edgeDistanceUnits', Uint32Array],
  ['edgeTimeUnits', Uint32Array],
  ['spatialOffsets', Uint32Array],
  ['spatialNodeIndices', Uint32Array],
]

function driveAcceleratorSnapshotPath(storePath) {
  return `${storePath}${driveAcceleratorSnapshotSuffix}`
}

function driveAcceleratorStoreIdentity(state) {
  return {
    identityVersion: 'source-metadata-v1',
    schemaVersion: state.metadata.schemaVersion ?? null,
    sourceFingerprint: state.metadata.sourceFingerprint ?? null,
    driveNodeCount: state.metadata.driveNodeCount ?? null,
    driveEdgeCount: state.metadata.driveEdgeCount ?? null,
    drivingWeightModel: state.metadata.drivingWeightModel ?? null,
  }
}

function createRuntimeDriveAccelerator(data, diagnostics = {}) {
  // The shared node table includes walk-only vertices. Driving snaps must
  // touch a drive edge; retain incoming-only endpoints of one-way roads too.
  const driveNodeMask = new Uint8Array(data.nodeCount)
  for (let index = 0; index < data.nodeCount; index += 1) {
    if (data.edgeOffsets[index] < data.edgeOffsets[index + 1]) driveNodeMask[index] = 1
  }
  for (const target of data.edgeTargets) driveNodeMask[target] = 1
  return {
    ...data,
    driveNodeMask,
    buildMs: diagnostics.buildMs ?? 0,
    loadMs: diagnostics.loadMs ?? 0,
    snapshotWriteMs: diagnostics.snapshotWriteMs ?? 0,
    source: diagnostics.source ?? 'built',
    snapshotPath: diagnostics.snapshotPath,
    snapshotBuffer: diagnostics.snapshotBuffer,
    queryCount: 0,
    queryMs: 0,
    settledNodes: 0,
    relaxedEdges: 0,
  }
}

function loadDriveAcceleratorSnapshot(state) {
  const startedAt = performance.now()
  const snapshotPath = driveAcceleratorSnapshotPath(state.storePath)
  try {
    const snapshotBuffer = fsSync.readFileSync(snapshotPath)
    if (snapshotBuffer.byteLength < driveAcceleratorSnapshotHeaderBytes) throw new Error('Drive accelerator snapshot is truncated.')
    const header = JSON.parse(snapshotBuffer.subarray(0, driveAcceleratorSnapshotHeaderBytes).toString('utf8').trim())
    if (header.magic !== driveAcceleratorSnapshotMagic || header.version !== driveAcceleratorSnapshotVersion) {
      throw new Error('Drive accelerator snapshot version is unsupported.')
    }
    if (JSON.stringify(header.identity) !== JSON.stringify(driveAcceleratorStoreIdentity(state))) {
      state.driveAcceleratorSnapshotStatus = 'stale'
      return null
    }
    if (header.byteLength !== snapshotBuffer.byteLength) throw new Error('Drive accelerator snapshot length does not match its header.')
    const data = {
      nodeCount: Number(header.nodeCount),
      edgeCount: Number(header.edgeCount),
      spatialMinLat: Number(header.spatialMinLat),
      spatialMinLon: Number(header.spatialMinLon),
      spatialCellDegrees: Number(header.spatialCellDegrees),
      spatialRows: Number(header.spatialRows),
      spatialColumns: Number(header.spatialColumns),
    }
    for (const [name, Type] of driveAcceleratorSnapshotArrays) {
      data[name] = snapshotTypedArray(snapshotBuffer, header.arrays?.[name], Type)
    }
    if (
      data.nodeLats.length !== data.nodeCount
      || data.nodeLons.length !== data.nodeCount
      || data.edgeOffsets.length !== data.nodeCount + 1
      || data.edgeTargets.length !== data.edgeCount
      || data.edgeDistanceUnits.length !== data.edgeCount
      || data.edgeTimeUnits.length !== data.edgeCount
      || data.spatialNodeIndices.length !== data.nodeCount
      || data.spatialOffsets.length !== data.spatialRows * data.spatialColumns + 1
      || data.edgeOffsets[data.nodeCount] !== data.edgeCount
      || data.spatialOffsets[data.spatialOffsets.length - 1] !== data.nodeCount
    ) throw new Error('Drive accelerator snapshot topology is inconsistent.')
    const loadMs = Number((performance.now() - startedAt).toFixed(3))
    state.driveAcceleratorSnapshotStatus = 'loaded'
    state.driveAcceleratorSnapshotError = ''
    state.driveAccelerator = createRuntimeDriveAccelerator(data, {
      source: 'snapshot',
      loadMs,
      snapshotPath,
      snapshotBuffer,
    })
    return state.driveAccelerator
  } catch (error) {
    if (error?.code === 'ENOENT') {
      state.driveAcceleratorSnapshotStatus = 'missing'
      state.driveAcceleratorSnapshotError = ''
    } else {
      state.driveAcceleratorSnapshotStatus = 'load_error'
      state.driveAcceleratorSnapshotError = error instanceof Error ? error.message : String(error)
    }
    return null
  }
}

/** Why a store has no usable driving snapshot, and what to do about it. */
function driveSnapshotUnavailable(state) {
  const eligibility = state.driveAcceleratorEligibility
  if (!eligibility.eligible) return { reason: eligibility.reason }
  const status = state.driveAcceleratorSnapshotStatus
  const reason = status === 'stale' ? 'drive_snapshot_stale'
    : status === 'missing' ? 'drive_snapshot_missing'
      : 'drive_snapshot_unreadable'
  const detail = state.driveAcceleratorSnapshotError ? ` (${state.driveAcceleratorSnapshotError})` : ''
  return {
    reason,
    error: `The driving snapshot is ${reason.slice('drive_snapshot_'.length)}${detail}. Rebuild the streets from the source OSM PBF.`,
  }
}

/** The pedestrian snapshot's header: present, stale for this store, missing or unreadable. */
function inspectStreetAcceleratorSnapshot(state) {
  const snapshotPath = streetAcceleratorSnapshotPath(state.storePath)
  let fd
  try {
    fd = fsSync.openSync(snapshotPath, 'r')
    const bytes = Buffer.alloc(streetAcceleratorSnapshotHeaderBytes)
    fsSync.readSync(fd, bytes, 0, bytes.length, 0)
    const header = JSON.parse(bytes.toString('utf8').trim())
    if (header.magic !== streetAcceleratorSnapshotMagic || header.version !== streetAcceleratorSnapshotVersion) {
      return { status: 'unsupported', snapshotPath }
    }
    if (!streetAcceleratorIdentityMatches(header.identity, state)) return { status: 'stale', snapshotPath }
    return { status: 'present', snapshotPath, nodeCount: Number(header.nodeCount), edgeCount: Number(header.edgeCount) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', snapshotPath }
    return { status: 'unreadable', snapshotPath, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (fd !== undefined) fsSync.closeSync(fd)
  }
}

function prepareNationalOsmDriveProfile(state, storePath, options, startedAt) {
  if (!state.drivingProfileAvailable) {
    return {
      ready: false,
      accelerated: false,
      reason: 'driving_profile_unavailable',
      prepareMs: Number((performance.now() - startedAt).toFixed(3)),
      nodeCount: 0,
      edgeCount: 0,
    }
  }
  if (!state.driveAccelerator && state.driveAcceleratorSnapshotStatus === 'not_checked') {
    loadDriveAcceleratorSnapshot(state)
  }
  const accelerator = state.driveAccelerator
  const unavailable = accelerator ? null : driveSnapshotUnavailable(state)
  const nativeDriveKernel = accelerator && options.prepareNative !== false
    ? prepareNativeDriveKernel(accelerator, {
        persistCch: state.metadata.driveCchPersistence !== 'ephemeral',
        requirePrepared: options.prepareCch !== true && state.runtimeSnapshotOnly && state.metadata.driveCchPersistence === 'persisted',
      })
    : null
  return {
    ready: Boolean(accelerator),
    accelerated: Boolean(accelerator),
    reason: accelerator ? 'ready' : unavailable.reason,
    prepareMs: Number((performance.now() - startedAt).toFixed(3)),
    loadMs: accelerator?.loadMs ?? 0,
    nativeConfigureMs: timingMilliseconds(nativeDriveKernel?.configureMs),
    nativeCch: nativeDriveKernel?.diagnostics,
    source: accelerator?.source,
    snapshotStatus: state.driveAcceleratorSnapshotStatus,
    snapshotPath: driveAcceleratorSnapshotPath(storePath),
    nodeCount: accelerator?.nodeCount ?? state.driveAcceleratorEligibility.nodeCount,
    edgeCount: accelerator?.edgeCount ?? state.driveAcceleratorEligibility.edgeCount,
    error: unavailable?.error,
  }
}

/** Open the sealed drive snapshot and its prepared native hierarchy. */
export function prepareNationalOsmDriveStore(storePath, options = {}) {
  const startedAt = performance.now()
  const state = openRuntimeStreetStore(storePath)
  return prepareNationalOsmDriveProfile(state, storePath, options, startedAt)
}

/**
 * Admit the authoritative SQLite store without hydrating the JavaScript graph,
 * then memory-map its immutable accelerator in the Rust Node-API kernel.
 * Coordinate transit workers use this path so the same street snapshot is not
 * retained once by V8 and again by native code.
 */
export function prepareNationalOsmNativeStore(storePath, options = {}) {
  const startedAt = performance.now()
  const resolvedPath = path.resolve(storePath)
  let db
  try {
    db = new DatabaseSync(resolvedPath, { readOnly: true, timeout: readerBusyTimeoutMs })
    const metadata = readStreetStoreMetadata(db, resolvedPath)
    admitStreetStoreVersion(resolvedPath, metadata)
    if (metadata.storageLayout !== runtimeStreetStoreStorageLayout) {
      throw streetStoreAdmissionError(
        resolvedPath,
        'runtime_layout_required',
        `Native routing preparation requires the sealed ${runtimeStreetStoreStorageLayout} layout.`,
      )
    }
    const { admission } = admitRuntimeSnapshotStore(db, resolvedPath, metadata, startedAt)
    let native = prepareNativeRoutingKernel(resolvedPath)
    if (options.prepareCch === true && !native.streetCch?.ready) {
      buildNativeStreetCchIndex(resolvedPath)
      native = prepareNativeRoutingKernel(resolvedPath)
    }
    return {
      ...native,
      reason: 'ready',
      prepareMs: Number((performance.now() - startedAt).toFixed(3)),
      storeAdmission: admission,
      storeBytes: fsSync.statSync(resolvedPath).size,
    }
  } catch (error) {
    if (error?.code === 'VIGO_STREET_STORE_ADMISSION_FAILED') throw error
    return {
      ready: false,
      accelerated: false,
      reason: error?.code === 'VIGO_NATIVE_STREET_SNAPSHOT_REQUIRED'
        ? 'native_snapshot_required'
        : 'native_kernel_unavailable',
      prepareMs: Number((performance.now() - startedAt).toFixed(3)),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try { db?.close() } catch {}
  }
}

export function nationalOsmStoreDiagnostics(storePath) {
  const state = openDiagnosticStreetStore(storePath)
  const walk = inspectStreetAcceleratorSnapshot(state)
  const driveAccelerator = state.driveAccelerator
  return {
    sourceModel: state.sourceModel,
    storeAdmission: state.admission,
    sourceFingerprint: state.metadata.sourceFingerprint ?? null,
    directionMetadataPresent: [
      'directionRestrictedWayCount',
      'directionExcludedWayCount',
      'uncertainConveyingWayCount',
    ].every((key) => Object.hasOwn(state.metadata, key)),
    directionRestrictedWayCount: Number(state.metadata.directionRestrictedWayCount ?? 0),
    directionExcludedWayCount: Number(state.metadata.directionExcludedWayCount ?? 0),
    uncertainConveyingWayCount: Number(state.metadata.uncertainConveyingWayCount ?? 0),
    // The pedestrian graph is searched by the native kernel, which maps this snapshot.
    reason: walk.status === 'present' ? 'ready' : `walk_snapshot_${walk.status}`,
    accelerated: walk.status === 'present',
    error: walk.error,
    storeBytes: fsSync.statSync(state.storePath).size,
    nodeCount: walk.nodeCount ?? 0,
    edgeCount: walk.edgeCount ?? Math.max(0, Number(state.metadata.edgeCount ?? 0)),
    snapshotStatus: walk.status,
    snapshotPath: walk.snapshotPath,
    driveAccelerator: {
      eligible: state.driveAcceleratorEligibility.eligible,
      reason: driveAccelerator ? 'ready' : state.driveAcceleratorEligibility.reason,
      accelerated: Boolean(driveAccelerator),
      nodeCount: driveAccelerator?.nodeCount ?? state.driveAcceleratorEligibility.nodeCount,
      edgeCount: driveAccelerator?.edgeCount ?? state.driveAcceleratorEligibility.edgeCount,
      loadMs: driveAccelerator?.loadMs ?? 0,
      source: driveAccelerator?.source,
      snapshotStatus: state.driveAcceleratorSnapshotStatus,
      snapshotError: state.driveAcceleratorSnapshotError || undefined,
      snapshotPath: driveAcceleratorSnapshotPath(storePath),
      queryCount: driveAccelerator?.queryCount ?? 0,
      queryMs: timingMilliseconds(driveAccelerator?.queryMs),
      settledNodes: driveAccelerator?.settledNodes ?? 0,
      relaxedEdges: driveAccelerator?.relaxedEdges ?? 0,
    },
    openStoreCache: {
      entries: streetStoreCache.size,
      maxEntries: streetStoreCacheMaximumEntries,
    },
  }
}

const streetStoreCache = new Map()

function invalidateStreetStore(storePath) {
  const resolvedPath = path.resolve(storePath)
  const cached = streetStoreCache.get(resolvedPath)
  if (!cached) return
  try { cached.db.close() } catch {}
  cached.driveAccelerator = null
  streetStoreCache.delete(resolvedPath)
}

export function disposeNationalOsmStore(storePath) {
  disposeNativeRoutingKernel(storePath)
  invalidateStreetStore(storePath)
}

/**
 * Seal a built OSM graph into the runtime representation. The importer and
 * all graph-dependent preprocessing run against the normalized SQLite graph;
 * the published workspace retains metadata, snapshots and native hierarchies.
 * Drive CCH preparation belongs to this build phase, not query startup.
 */
export function compactNationalOsmRuntimeStore(storePath, options = {}) {
  const resolvedPath = path.resolve(storePath)
  disposeNationalOsmStore(resolvedPath)
  return runCityCompilerSync('_compact-street-store', [
    `--street-store=${resolvedPath}`, ...(options.requireDrive === false ? ['--require-drive=false'] : []),
  ], { label: 'Street compaction' })
}

function streetStoreAdmissionError(storePath, reason, detail) {
  const error = new Error([
    `Street store admission failed for ${storePath}: ${detail}`,
    `Expected the current ${streetStoreSchemaVersion} SQLite street store with sourceModel="pbf".`,
    'Rebuild the street index from the source OSM PBF instead of modifying it in place.',
  ].join(' '))
  error.code = 'VIGO_STREET_STORE_ADMISSION_FAILED'
  error.reason = reason
  error.storePath = storePath
  return error
}

function validateStoreObjects(db, storePath, tableNames, indexTables, detail = 'store') {
  const indexNames = Object.keys(indexTables)
  const objectNames = [...tableNames, ...indexNames]
  const schemaRows = db.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_schema
    WHERE name IN (${objectNames.map(() => '?').join(',')})
  `).all(...objectNames)
  const schemaByName = new Map(schemaRows.map((row) => [String(row.name), row]))
  for (const tableName of tableNames) {
    const object = schemaByName.get(tableName)
    if (!object || object.type !== 'table' || object.tbl_name !== tableName) {
      throw streetStoreAdmissionError(
        storePath,
        'required_table_missing',
        `Required ${detail} table "${tableName}" is missing.`,
      )
    }
  }
  for (const [indexName, tableName] of Object.entries(indexTables)) {
    const object = schemaByName.get(indexName)
    if (!object || object.type !== 'index' || object.tbl_name !== tableName) {
      throw streetStoreAdmissionError(
        storePath,
        'required_index_missing',
        `Required ${detail} index "${indexName}" is missing.`,
      )
    }
  }
}

function readStreetStoreMetadata(db, storePath) {
  try {
    return Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map((row) => {
      try {
        return [row.key, JSON.parse(row.value)]
      } catch {
        return [row.key, row.value]
      }
    }))
  } catch (error) {
    if (error?.code === 'VIGO_STREET_STORE_ADMISSION_FAILED') throw error
    throw streetStoreAdmissionError(
      storePath,
      'metadata_unreadable',
      `SQLite could not read metadata (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
}

export function readNationalOsmStoreMetadata(storePath) {
  const resolvedPath = path.resolve(storePath)
  const database = new DatabaseSync(resolvedPath, { readOnly: true, timeout: readerBusyTimeoutMs })
  try {
    const metadata = readStreetStoreMetadata(database, resolvedPath)
    admitStreetStoreVersion(resolvedPath, metadata)
    return metadata
  } finally {
    database.close()
  }
}

function admitStreetStoreVersion(storePath, metadata) {
  if (metadata.schemaVersion !== streetStoreSchemaVersion) {
    throw streetStoreAdmissionError(
      storePath,
      'schema_version_mismatch',
      `metadata.schemaVersion is ${JSON.stringify(metadata.schemaVersion)}.`,
    )
  }
  if (metadata.sourceModel !== 'pbf') {
    throw streetStoreAdmissionError(
      storePath,
      'source_model_mismatch',
      `metadata.sourceModel is ${JSON.stringify(metadata.sourceModel)}.`,
    )
  }
}

function admitRuntimeSnapshotStore(db, storePath, metadata, startedAt) {
  validateStoreObjects(db, storePath, ['metadata'], {}, 'runtime')
  admitStreetStoreVersion(storePath, metadata)
  const walkSnapshotPath = streetAcceleratorSnapshotPath(storePath)
  if (!fsSync.existsSync(walkSnapshotPath)) {
    throw streetStoreAdmissionError(
      storePath,
      'walk_snapshot_missing',
      `The runtime layout requires ${walkSnapshotPath}.`,
    )
  }
  const driveSnapshotRequired = Number(metadata.driveNodeCount ?? 0) > 0 && Number(metadata.driveEdgeCount ?? 0) > 0
  if (driveSnapshotRequired && !fsSync.existsSync(driveAcceleratorSnapshotPath(storePath))) {
    throw streetStoreAdmissionError(
      storePath,
      'drive_snapshot_missing',
      `The runtime layout requires ${driveAcceleratorSnapshotPath(storePath)} for drive and Reach queries.`,
    )
  }
  return {
    metadata,
    admission: Object.freeze({
      status: 'admitted',
      schemaVersion: metadata.schemaVersion,
      sourceModel: 'pbf',
      storageLayout: runtimeStreetStoreStorageLayout,
      runtimeSnapshotOnly: true,
      requiredTableCount: 1,
      requiredIndexCount: 0,
      metadataRows: Object.keys(metadata).length,
      admissionMs: Number((performance.now() - startedAt).toFixed(3)),
      integrityScan: 'not_run_on_open',
      authoritativeConnection: 'read_only',
    }),
  }
}

function admitSourceStreetStore(db, storePath, metadata, startedAt) {
  admitStreetStoreVersion(storePath, metadata)
  if (metadata.storageLayout !== 'walk-drive-role-tables-v2') {
    throw streetStoreAdmissionError(
      storePath,
      'storage_layout_mismatch',
      `metadata.storageLayout must be "walk-drive-role-tables-v2" before runtime compaction.`,
    )
  }
  const deferredDriveIndexes = metadata.driveIndexState === 'deferred'
  const tableNames = streetStoreTableNames
  const indexTables = deferredDriveIndexes
    ? streetStoreIndexTables
    : { ...streetStoreIndexTables, ...drivingStoreIndexTables }
  validateStoreObjects(db, storePath, [
    ...tableNames,
    ...drivingStoreTableNames,
  ], indexTables)

  return {
    metadata,
    admission: Object.freeze({
      status: 'admitted',
      schemaVersion: metadata.schemaVersion,
      sourceModel: 'pbf',
      requiredTableCount: tableNames.length + drivingStoreTableNames.length,
      requiredIndexCount: Object.keys(indexTables).length,
      metadataRows: Object.keys(metadata).length,
      admissionMs: Number((performance.now() - startedAt).toFixed(3)),
      integrityScan: 'not_run_on_open',
      authoritativeConnection: 'read_only',
    }),
  }
}

function admitDiagnosticStreetStore(db, storePath) {
  const startedAt = performance.now()
  const metadata = readStreetStoreMetadata(db, storePath)
  return metadata.storageLayout === runtimeStreetStoreStorageLayout
    ? admitRuntimeSnapshotStore(db, storePath, metadata, startedAt)
    : admitSourceStreetStore(db, storePath, metadata, startedAt)
}

function streetStoreStorageIdentity(storePath) {
  const stat = fsSync.statSync(storePath, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
}

function openStreetStoreWithAdmission(storePath, admissionFunction, requiredLayout = 'diagnostic') {
  const resolvedPath = path.resolve(storePath)
  let storageIdentity
  try {
    storageIdentity = streetStoreStorageIdentity(resolvedPath)
  } catch (error) {
    throw streetStoreAdmissionError(
      resolvedPath,
      'sqlite_open_failed',
      `SQLite could not stat the authoritative file (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  const cached = streetStoreCache.get(resolvedPath)
  if (cached?.storageIdentity === storageIdentity) {
    if (requiredLayout === 'runtime' && !cached.runtimeSnapshotOnly) {
      throw runtimeStreetStoreError(resolvedPath, 'Runtime street-store access')
    }
    streetStoreCache.delete(resolvedPath)
    streetStoreCache.set(resolvedPath, cached)
    return cached
  }
  if (cached) invalidateStreetStore(resolvedPath)
  let db
  try {
    try {
      db = new DatabaseSync(resolvedPath, { readOnly: true, timeout: readerBusyTimeoutMs })
    } catch (error) {
      throw streetStoreAdmissionError(
        resolvedPath,
        'sqlite_open_failed',
        `SQLite could not open the authoritative file read-only (${error instanceof Error ? error.message : String(error)}).`,
      )
    }
    const { metadata, admission } = admissionFunction(db, resolvedPath)
    db.exec(`PRAGMA mmap_size=${readOnlySqliteMmapBytes}; PRAGMA cache_size=-${readOnlySqliteCacheKiB};`)
    const runtimeSnapshotOnly = metadata.storageLayout === runtimeStreetStoreStorageLayout
    const drivingProfileAvailable = metadata.schemaVersion === streetStoreSchemaVersion
      && (!runtimeSnapshotOnly || fsSync.existsSync(driveAcceleratorSnapshotPath(resolvedPath)))
    const state = {
      db,
      storePath: resolvedPath,
      storageIdentity,
      metadata,
      admission,
      sourceModel: 'pbf',
      drivingProfileAvailable,
      runtimeSnapshotOnly,
      driveAccelerator: null,
      driveAcceleratorSnapshotStatus: 'not_checked',
      driveAcceleratorSnapshotError: '',
      driveAcceleratorEligibility: driveAcceleratorEligibility(metadata),
    }
    // Drive is a separate, optional profile. Do not fault its snapshot into a
    // transit/walk worker merely because the authoritative store contains
    // driving rows; the first drive request materializes it below.
    while (streetStoreCache.size >= streetStoreCacheMaximumEntries) {
      const oldestStorePath = streetStoreCache.keys().next().value
      if (oldestStorePath === undefined) break
      invalidateStreetStore(oldestStorePath)
    }
    streetStoreCache.set(resolvedPath, state)
    return state
  } catch (error) {
    try { db.close() } catch {}
    if (error?.code === 'VIGO_STREET_STORE_ADMISSION_FAILED') throw error
    throw streetStoreAdmissionError(
      resolvedPath,
      'schema_unreadable',
      `SQLite could not prepare the current street schema (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
}

function openRuntimeStreetStore(storePath) {
  return openStreetStoreWithAdmission(
    storePath,
    (db, resolvedPath) => {
      const startedAt = performance.now()
      const metadata = readStreetStoreMetadata(db, resolvedPath)
      if (metadata.storageLayout !== runtimeStreetStoreStorageLayout) {
        throw runtimeStreetStoreError(resolvedPath, 'Runtime street-store access')
      }
      return admitRuntimeSnapshotStore(db, resolvedPath, metadata, startedAt)
    },
    'runtime',
  )
}

function openDiagnosticStreetStore(storePath) {
  return openStreetStoreWithAdmission(storePath, admitDiagnosticStreetStore)
}

function runtimeStreetStoreError(storePath, operation) {
  const error = new Error(
    `${operation} requires the sealed ${runtimeStreetStoreStorageLayout} street store at ${path.resolve(storePath)}. Rebuild the OpenStreetMap street index from the source PBF.`,
  )
  error.code = 'VIGO_RUNTIME_STREET_STORE_REQUIRED'
  error.reason = 'runtime_layout_required'
  error.storePath = path.resolve(storePath)
  return error
}

// Drive between two free coordinates. The native kernel attaches each endpoint
// to its nearest drivable road by segment projection; the gap is a straight
// walk, and a gap longer than the walking limit blocks the trip.
function drivePathBetween(state, fromCoordinate, toCoordinate, maxDistanceKm, traffic, options = {}) {
  const startedAt = performance.now()
  const accelerator = state.driveAccelerator
  // Scenario traces join consecutive legs at one road point and publish
  // only the road geometry, without the walks to it.
  const roadGeometryOnly = options.roadGeometryOnly === true
  const result = routeNativeDriveCoordinates(accelerator, {
    origin: fromCoordinate,
    destination: toCoordinate,
    maximumWalkKm: options.maximumWalkKm,
    walkingSpeedKph: options.walkingSpeedKph,
    maximumDistanceKm: maxDistanceKm,
    traffic: traffic?.nativeInput,
    nearestRoadOnly: roadGeometryOnly || options.originAtRoadNode === true,
  })
  const search = result.search ?? {}
  accelerator.queryCount += 1
  accelerator.queryMs = timingMilliseconds(accelerator.queryMs) + result.queryMs
  accelerator.settledNodes += search.settledLabels ?? 0
  accelerator.relaxedEdges += search.relaxedEdges ?? 0
  const ready = result.status === 'ready'
  const roads = []
  for (let index = 0; index + 1 < result.driveCoordinates.length; index += 2) {
    roads.push([result.driveCoordinates[index], result.driveCoordinates[index + 1]])
  }
  const walk = (meters, seconds, from, to) => ({ distanceKm: meters / 1_000, durationSeconds: seconds, coordinates: [from, to] })
  const path = !ready
    ? null
    : roadGeometryOnly
      ? {
          distanceKm: result.driveMeters / 1_000,
          durationSeconds: result.driveSeconds,
          coordinates: roads,
          originSnapDistanceKm: result.originWalkMeters / 1_000,
          destinationSnapDistanceKm: result.destinationWalkMeters / 1_000,
        }
      : {
          distanceKm: result.distanceMeters / 1_000,
          durationSeconds: result.durationSeconds,
          driveDistanceKm: result.driveMeters / 1_000,
          driveSeconds: result.driveSeconds,
          coordinates: roads,
          originWalk: walk(result.originWalkMeters, result.originWalkSeconds, fromCoordinate, roads[0]),
          destinationWalk: walk(result.destinationWalkMeters, result.destinationWalkSeconds, roads.at(-1), toCoordinate),
          originSnapDistanceKm: result.originWalkMeters / 1_000,
          destinationSnapDistanceKm: result.destinationWalkMeters / 1_000,
        }
  const recovered = (walkMeters, roadMeters) => walkMeters / 1_000 > (roadMeters ?? 0) / 1_000 + driveAttachmentRecoveryKm
  return {
    path,
    settledNodes: search.settledLabels ?? 0,
    relaxedEdges: search.relaxedEdges ?? 0,
    searchMs: result.queryMs,
    failureCode: ready ? null : result.reason ?? 'no_path',
    originRoadKm: result.originRoadMeters == null ? null : result.originRoadMeters / 1_000,
    destinationRoadKm: result.destinationRoadMeters == null ? null : result.destinationRoadMeters / 1_000,
    snapRecovery: ready && !roadGeometryOnly && (recovered(result.originWalkMeters, result.originRoadMeters)
      || recovered(result.destinationWalkMeters, result.destinationRoadMeters)),
    accelerated: true,
    acceleratorSource: accelerator.source,
    algorithm: search.algorithm,
    cchAccelerated: search.cchAccelerated === true,
    cchSource: search.cchSource,
    cchCandidateQueries: Number(search.cchCandidateQueries ?? 0),
    trafficApplied: search.trafficApplied === true,
    trafficSnapshotKey: search.trafficSnapshotKey,
    trafficUpdatedEdges: search.trafficUpdatedEdges,
    trafficCustomizationMs: normalizeNativeMilliseconds(search.trafficCustomizationNs ?? 0),
    trafficMetricReused: search.trafficMetricReused === true,
    fastPathMs: normalizeNativeMilliseconds(search.fastPathQueryNs ?? 0),
    distancePathMs: normalizeNativeMilliseconds(search.distancePathQueryNs ?? 0),
    fallbackMs: normalizeNativeMilliseconds(search.fallbackQueryNs ?? 0),
    fallbackUsed: search.fallbackUsed === true,
    generatedLabels: search.generatedLabels ?? 0,
    dominatedLabels: search.dominatedLabels ?? 0,
    queryMs: Number((performance.now() - startedAt).toFixed(3)),
  }
}

function streetRouteSearchDiagnostics(queryMs, search, mode) {
  const normalizedQueryMs = timingMilliseconds(queryMs)
  return {
    queryMs: normalizedQueryMs,
    searchMs: timingMilliseconds(search?.searchMs, normalizedQueryMs),
    settledNodes: search?.settledNodes ?? null,
    relaxedEdges: search?.relaxedEdges ?? null,
    profile: mode,
    accelerated: search?.accelerated === true,
    acceleratorSource: search?.acceleratorSource,
    snapRecovery: search?.snapRecovery === true,
    geometryReversed: search?.geometryReversed === true,
    algorithm: search?.algorithm,
    cchAccelerated: search?.cchAccelerated === true,
    cchSource: search?.cchSource,
    cchCandidateQueries: search?.cchCandidateQueries,
    trafficApplied: search?.trafficApplied === true,
    trafficSnapshotKey: search?.trafficSnapshotKey,
    trafficUpdatedEdges: search?.trafficUpdatedEdges,
    trafficCustomizationMs: timingMilliseconds(search?.trafficCustomizationMs),
    trafficMetricReused: search?.trafficMetricReused === true,
    fastPathMs: timingMilliseconds(search?.fastPathMs),
    distancePathMs: timingMilliseconds(search?.distancePathMs),
    fallbackMs: timingMilliseconds(search?.fallbackMs),
    fallbackUsed: search?.fallbackUsed === true,
  }
}

function blockedStreetRoute(request, failureCode, detail, diagnostics = {}) {
  const mode = request.mode === 'drive' ? 'drive' : 'walk'
  const walkAlgorithm = 'rust_cch_walk_exact'
  return {
    id: `street-${mode}-blocked`,
    status: 'blocked',
    travelMode: mode,
    timePreference: request.timePreference,
    maxWalkKm: mode === 'walk' ? Number(request.maxStreetKm ?? request.maxWalkKm ?? 50) : 0,
    origin: request.origin,
    destination: request.destination,
    title: mode === 'drive' ? 'Driving route unavailable' : 'Walking route unavailable',
    detail,
    departMinutes: request.departMinutes,
    arriveMinutes: null,
    durationMinutes: null,
    waitMinutes: 0,
    walkMinutes: 0,
    rideMinutes: 0,
    transfers: 0,
    legs: [],
    diagnostics: {
      scannedDepartures: 0,
      relaxedStops: 0,
      serviceDay: request.serviceDay ?? 'weekday',
      scheduleMode: 'none',
      walkingNetwork: mode === 'walk' ? 'osm' : 'direct',
      walkingSpeedKph: mode === 'walk' ? Number(request.walkingSpeedKph ?? 4.8) : 0,
      algorithm: mode === 'drive' ? 'rust_cch_drive_certified' : walkAlgorithm,
      weightModel: mode === 'drive' ? 'free_flow_seconds' : 'distance_meters',
      failureCode,
      ...diagnostics,
    },
  }
}

/**
 * Route one first-class walking or driving request over the sealed OSM snapshot.
 * Results are exact for the stored directed graph and selected metric. Driving
 * uses free-flow weights unless a fresh normalized traffic snapshot customizes
 * the resident CCH time metric; turn restrictions remain outside this graph.
 */
export function routeNationalStreetStore(storePath, request) {
  validateArrivalBuffer(request, false)
  // Studio's road-following scenario geometry is the only JavaScript street
  // route; walk, bike and drive journeys run in the vigo runtime.
  if (request?.mode !== 'drive') throw new Error('JavaScript street routing supports road geometry for drive mode only.')
  const startedAt = performance.now()
  const mode = 'drive'
  const timePreference = request?.timePreference === 'arrive' ? 'arrive' : 'depart'
  const requestedMinutes = Number(timePreference === 'arrive'
    ? request.arriveMinutes ?? request.departMinutes ?? 8 * 60
    : request?.departMinutes ?? 8 * 60)
  // Ordered arrive-by legs can start on the preceding day. Street weights
  // are static for this query, so signed service-day minutes preserve that
  // chronology without reversing the directed path or wrapping its clock.
  if (!Number.isFinite(requestedMinutes) || Math.abs(requestedMinutes) > 2_880) {
    throw new Error('Street routing time must be a finite minute in [-2880, 2880].')
  }
  let state = openRuntimeStreetStore(storePath)
  const originCoordinate = request?.origin?.coordinate?.map(Number)
  const destinationCoordinate = request?.destination?.coordinate?.map(Number)
  const normalizedRequest = {
    ...request,
    mode,
    timePreference,
    departMinutes: requestedMinutes,
  }
  if (
    originCoordinate?.length !== 2
    || destinationCoordinate?.length !== 2
    || !originCoordinate.every(Number.isFinite)
    || !destinationCoordinate.every(Number.isFinite)
  ) {
    return blockedStreetRoute(normalizedRequest, 'invalid_coordinates', 'Choose valid origin and destination points.')
  }
  if (!state.driveAccelerator) {
    const preparedDrive = prepareNationalOsmDriveStore(storePath)
    if (preparedDrive.ready) state = openRuntimeStreetStore(storePath)
  }
  if (!state.driveAccelerator) {
    return blockedStreetRoute(
      normalizedRequest,
      'street_accelerator_unavailable',
      `The accelerated ${mode} profile is unavailable. Prepare or rebuild the OpenStreetMap street index.`,
      {
        searchStats: streetRouteSearchDiagnostics(performance.now() - startedAt, null, mode),
      },
    )
  }
  const traffic = normalizeDriveTrafficSnapshot(
    state.driveAccelerator,
    request.trafficSnapshot,
    state.metadata.sourceFingerprint,
  )
  const trafficDiagnostics = traffic
    ? Object.fromEntries(Object.entries(traffic).filter(([key]) => !['nativeInput', 'cacheKey'].includes(key)))
    : null
  normalizedRequest.trafficCacheKey = traffic?.cacheKey ?? 'free-flow'

  const maxStreetKm = Math.max(0.25, Math.min(1_500, Number(request.maxStreetKm) || 750))
  normalizedRequest.maxStreetKm = maxStreetKm
  const walkingSpeedKph = Math.max(1, Math.min(12, Number(request.walkingSpeedKph) || 4.8))
  const driveAccessWalkKm = Math.max(0, Math.min(100, Number(request.maxWalkKm ?? defaultDriveAccessWalkKm)))
  const search = drivePathBetween(state, originCoordinate, destinationCoordinate, maxStreetKm, traffic, {
    roadGeometryOnly: request.roadGeometryOnly === true,
    originAtRoadNode: request.originAtRoadNode === true,
    maximumWalkKm: driveAccessWalkKm,
    walkingSpeedKph,
  })
  const pathResult = search.path
  if (!pathResult) {
    const failureCode = search?.failureCode ?? 'no_path'
    const blockedTrafficApplied = traffic?.status === 'applied'
      && search?.trafficApplied === true
    return blockedStreetRoute(
      normalizedRequest,
      failureCode,
      failureCode === 'street_snap_failed'
        ? `The ${mode} graph does not reach one of these points.`
        : failureCode === 'no_drivable_road_within_walk'
          ? `No drivable road lies within ${driveAccessWalkKm.toFixed(1)} km of the ${search?.originRoadKm == null ? 'origin' : 'destination'}.`
          : `No ${mode} path was found within ${maxStreetKm.toFixed(1)} km.`,
      {
        searchStats: streetRouteSearchDiagnostics(performance.now() - startedAt, search, mode),
        scheduleMode: 'none',
        roadMetricMode: blockedTrafficApplied ? 'traffic-adjusted' : 'free-flow',
        weightModel: blockedTrafficApplied ? 'snapshot_customized_traffic_seconds' : 'free_flow_seconds',
        limitations: [
          ...(blockedTrafficApplied ? [] : ['no_live_traffic']),
          'no_turn_restriction_relations',
          'no_signal_delay',
        ],
        ...(trafficDiagnostics ? {
          traffic: {
            ...trafficDiagnostics,
            ...(traffic?.status === 'applied' ? {
              status: blockedTrafficApplied ? 'applied' : 'native_fallback',
              customizationMs: search?.trafficCustomizationMs,
              metricReused: search?.trafficMetricReused === true,
            } : {}),
          },
        } : {}),
      },
    )
  }
  const durationMinutes = pathResult.durationSeconds / 60
  const distanceKm = pathResult.distanceKm
  const arriveMinutes = timePreference === 'arrive' ? requestedMinutes : requestedMinutes + durationMinutes
  const departMinutes = timePreference === 'arrive' ? requestedMinutes - durationMinutes : requestedMinutes
  const fromName = String(request.origin?.label ?? 'Origin')
  const toName = String(request.destination?.label ?? 'Destination')
  const trafficApplied = traffic?.status === 'applied' && search?.trafficApplied === true
  // A drive walks straight between each free endpoint and its road. Gaps
  // below a meter are rounding, not walks; their seconds stay in the drive.
  const legs = []
  let clock = departMinutes
  const pushLeg = (type, minutes, legDistanceKm, coordinates, extra = {}) => {
    legs.push({
      type,
      travelMode: type,
      fromName: legs.length ? 'Road' : fromName,
      toName: 'Road',
      startMinutes: clock,
      endMinutes: clock + minutes,
      durationMinutes: minutes,
      distanceKm: legDistanceKm,
      stopCount: 0,
      coordinates,
      ...extra,
    })
    clock += minutes
  }
  const walks = pathResult.originWalk
    ? [pathResult.originWalk, pathResult.destinationWalk].map((walk) => walk.distanceKm >= 0.0005 ? walk : null)
    : [null, null]
  const connector = (walk) => pushLeg('walk', walk.durationSeconds / 60, walk.distanceKm, walk.coordinates,
    { walkSource: 'direct', streetPathVerified: false })
  if (walks[0]) connector(walks[0])
  const walkMinutes = walks.reduce((sum, walk) => sum + (walk ? walk.durationSeconds / 60 : 0), 0)
  pushLeg(mode, durationMinutes - walkMinutes,
    distanceKm - walks.reduce((sum, walk) => sum + (walk?.distanceKm ?? 0), 0), pathResult.coordinates)
  if (walks[1]) connector(walks[1])
  legs.at(-1).toName = toName
  legs.at(-1).endMinutes = arriveMinutes
  const plan = {
    id: `street-${mode}`,
    status: 'ready',
    travelMode: mode,
    timePreference,
    maxWalkKm: 0,
    choiceLabel: trafficApplied ? 'Fastest drive · live traffic' : 'Fastest drive',
    recommended: true,
    origin: request.origin,
    destination: request.destination,
    title: `Drive to ${toName}`,
    detail: `${distanceKm.toFixed(distanceKm < 10 ? 2 : 1)} km · ${Math.max(1, Math.round(durationMinutes))} min`,
    departMinutes,
    arriveMinutes,
    durationMinutes,
    waitMinutes: 0,
    walkMinutes,
    rideMinutes: durationMinutes - walkMinutes,
    transfers: 0,
    legs,
    diagnostics: {
      scannedDepartures: 0,
      relaxedStops: 0,
      serviceDay: request.serviceDay ?? 'weekday',
      scheduleMode: 'none',
      roadMetricMode: trafficApplied ? 'traffic-adjusted' : 'free-flow',
      walkingNetwork: 'direct',
      walkingSpeedKph,
      driveAccessWalkKm,
      algorithm: 'rust_cch_drive_certified',
      weightModel: trafficApplied ? 'snapshot_customized_traffic_seconds' : 'free_flow_seconds',
      optimality: trafficApplied
        ? 'exact_on_stored_directed_graph_for_normalized_traffic_snapshot'
        : 'exact_on_stored_directed_graph',
      limitations: [
        ...(trafficApplied ? [] : ['no_live_traffic']),
        'no_turn_restriction_relations',
        'no_signal_delay',
      ],
      ...(trafficDiagnostics ? {
        traffic: {
          ...trafficDiagnostics,
          ...(traffic?.status === 'applied' ? {
            status: trafficApplied ? 'applied' : 'native_fallback',
            customizationMs: search?.trafficCustomizationMs,
            metricReused: search?.trafficMetricReused === true,
          } : {}),
        },
      } : {}),
      snapRecovery: search?.snapRecovery === true,
      originSnapDistanceM: Number(((pathResult.originSnapDistanceKm ?? 0) * 1_000).toFixed(3)),
      destinationSnapDistanceM: Number(((pathResult.destinationSnapDistanceKm ?? 0) * 1_000).toFixed(3)),
      searchStats: streetRouteSearchDiagnostics(performance.now() - startedAt, search, mode),
    },
  }
  return plan
}
