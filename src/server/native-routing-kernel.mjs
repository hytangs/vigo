import packageJson from '../../package.json' with { type: 'json' }
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const nativeKernelCandidates = [...new Set([
  String(process.env.VIGO_NATIVE_ROUTING_KERNEL ?? '').trim(),
  path.join(moduleDirectory, 'vigo-routing-kernel.node'),
  path.resolve(moduleDirectory, '..', 'crates', 'vigo-runtime', 'vigo-routing-kernel.node'),
  path.resolve(moduleDirectory, '..', '..', 'crates', 'vigo-runtime', 'vigo-routing-kernel.node'),
].filter(Boolean))]
const nativeKernelCache = new Map()
const nativeTimetableKernelCache = new WeakMap()
const nativeDriveKernelCache = new WeakMap()
const nativeEndpointWorkspaceReservationM = Math.max(
  100,
  Math.min(5_000, Number(process.env.VIGO_NATIVE_ENDPOINT_WORKSPACE_M) || 1_600),
)
const nativeStreetCchFormat = 'street-cch-v2-u10000'
const nativeDriveCchFormat = 'drive-cch-v2-t100-d100'
const nativeCchManifestSchema = 'vigo.native-cch-manifest.v1'
let nativeBinding
let nativeBindingError

export { normalizeNativeMilliseconds } from './native-timing.mjs'
import { normalizeNativeMilliseconds } from './native-timing.mjs'

function cchHeaderCounts(structurePath) {
  const header = Buffer.alloc(32)
  const handle = fs.openSync(structurePath, 'r')
  try {
    if (fs.readSync(handle, header, 0, header.length, 0) !== header.length) {
      throw new Error('Native CCH structure header is truncated.')
    }
  } finally {
    fs.closeSync(handle)
  }
  const nodeCount = Number(header.readBigUInt64LE(16))
  const cchArcCount = Number(header.readBigUInt64LE(24))
  if (!Number.isSafeInteger(nodeCount) || !Number.isSafeInteger(cchArcCount)) {
    throw new Error('Native CCH structure counts exceed the JavaScript integer domain.')
  }
  return { nodeCount, cchArcCount }
}

function fileIdentity(filePath) {
  const stats = fs.statSync(filePath, { bigint: true })
  return {
    file: path.basename(filePath),
    bytes: stats.size.toString(),
  }
}

function snapshotIdentity(filePath) {
  const handle = fs.openSync(filePath, 'r')
  const header = Buffer.alloc(4096)
  try {
    const bytesRead = fs.readSync(handle, header, 0, header.length, 0)
    if (bytesRead < header.length) return null
  } finally {
    fs.closeSync(handle)
  }
  try {
    const value = JSON.parse(header.toString('utf8').trim())
    if (!value?.magic || !Number.isInteger(value?.version)) return null
    return {
      magic: value.magic,
      version: value.version,
      identity: value.identity ?? null,
      nodeCount: Number(value.nodeCount ?? -1),
      edgeCount: Number(value.edgeCount ?? -1),
      byteLength: Number(value.byteLength ?? -1),
    }
  } catch {
    return null
  }
}

function writeCchManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.${process.pid}.next`
  let handle
  try {
    handle = fs.openSync(temporaryPath, 'w')
    fs.writeFileSync(handle, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    fs.renameSync(temporaryPath, manifestPath)
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}

export function publishCchManifest({ kind, format, sourcePath, manifestPath, structurePath, metrics, edgeCount }) {
  const counts = cchHeaderCounts(structurePath)
  const manifest = {
    schemaVersion: nativeCchManifestSchema,
    kind,
    format,
    builderVersion: packageJson.version,
    source: fileIdentity(sourcePath),
    sourceSnapshot: snapshotIdentity(sourcePath),
    structure: fileIdentity(structurePath),
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([name, metricPath]) => [name, fileIdentity(metricPath)]),
    ),
    nodeCount: counts.nodeCount,
    edgeCount,
    cchArcCount: counts.cchArcCount,
  }
  writeCchManifest(manifestPath, manifest)
  return manifest
}

export function validateCchManifest({ kind, format, sourcePath, manifestPath, structurePath, metrics, nodeCount, edgeCount }) {
  const manifestStat = fs.statSync(manifestPath)
  if (manifestStat.size <= 0 || manifestStat.size > 64 * 1024) {
    throw new Error('Native CCH manifest exceeds its 64 KiB admission limit.')
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    throw new Error(`Native CCH manifest is invalid: ${cause.message}`)
  }
  const counts = cchHeaderCounts(structurePath)
  const activeSourceSnapshot = snapshotIdentity(sourcePath)
  const expectedFiles = {
    source: sourcePath,
    structure: structurePath,
    ...Object.fromEntries(Object.entries(metrics).map(([name, metricPath]) => [`metric:${name}`, metricPath])),
  }
  const records = {
    source: manifest.source,
    structure: manifest.structure,
    ...Object.fromEntries(Object.keys(metrics).map((name) => [`metric:${name}`, manifest.metrics?.[name]])),
  }
  if (
    manifest.schemaVersion !== nativeCchManifestSchema
    || manifest.kind !== kind
    || manifest.format !== format
    || manifest.nodeCount !== counts.nodeCount
    || manifest.cchArcCount !== counts.cchArcCount
    || (Number.isSafeInteger(nodeCount) && manifest.nodeCount !== nodeCount)
    || (Number.isSafeInteger(edgeCount) && manifest.edgeCount !== edgeCount)
    || (manifest.sourceSnapshot !== undefined
      && JSON.stringify(manifest.sourceSnapshot) !== JSON.stringify(activeSourceSnapshot))
  ) {
    throw new Error('Native CCH manifest metadata does not match the active graph.')
  }
  for (const [label, filePath] of Object.entries(expectedFiles)) {
    const record = records[label]
    const identity = fileIdentity(filePath)
    if (
      record?.file !== identity.file
      || String(record?.bytes ?? '') !== identity.bytes
    ) {
      throw new Error(`Native CCH manifest file identity mismatch for ${label}.`)
    }
  }
  return manifest
}

function loadNativeBinding() {
  if (nativeBinding) return nativeBinding
  if (nativeBindingError) throw nativeBindingError
  const attempted = []
  for (const candidate of nativeKernelCandidates) {
    const resolved = path.resolve(candidate)
    attempted.push(resolved)
    if (!fs.existsSync(resolved)) continue
    try {
      nativeBinding = require(resolved)
      return nativeBinding
    } catch (error) {
      nativeBindingError = new Error(
        `Unable to load the Rust routing kernel at ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
      nativeBindingError.code = 'VIGO_NATIVE_ROUTING_KERNEL_LOAD_FAILED'
      throw nativeBindingError
    }
  }
  nativeBindingError = new Error(
    `Rust routing kernel is missing. Run npm run build:rust-routing-kernel. Searched: ${attempted.join(', ')}`,
  )
  nativeBindingError.code = 'VIGO_NATIVE_ROUTING_KERNEL_MISSING'
  throw nativeBindingError
}

/** Load the required result geometry binding while the selected City opens. */
export function prepareNativeResultRendering() {
  loadNativeBinding()
}

export function nativeStableKeySuffix(value) {
  return loadNativeBinding().stableKeySuffix(value)
}

// One offline basemap tile (MVT bytes), rendered on the libuv pool so tile
// bursts never block the API's event loop. Empty means nothing to draw.
export function renderNativeLocalBasemapTile(storePath, z, x, y) {
  const binding = loadNativeBinding()
  if (typeof binding.localBasemapTile !== 'function') throw new Error('Rust routing binding lacks offline basemap tiles. Rebuild the native kernel.')
  return binding.localBasemapTile(path.resolve(storePath), z, x, y)
}

function transitNetworkBinding() {
  const binding = loadNativeBinding()
  if (typeof binding.transitNetworkTile !== 'function') throw new Error('Rust routing binding lacks transit network tiles. Rebuild the native kernel.')
  return binding
}

// The transit network as vector tiles. The server registers a City's route
// and stop overview once per revision; indexing and every tile run on the
// libuv pool. Resolves to [routes, stops] the registered network draws.
export function registerNativeTransitNetwork(key, networkJson) {
  return transitNetworkBinding().registerTransitNetwork(key, networkJson)
}

export function releaseNativeTransitNetwork(key) {
  return transitNetworkBinding().releaseTransitNetwork(key)
}

/** MVT bytes for one tile; rejects with TRANSIT_NETWORK_NOT_REGISTERED after a release. */
export function renderNativeTransitNetworkTile(key, z, x, y) {
  return transitNetworkBinding().transitNetworkTile(key, z, x, y)
}

function snapshotPathForStore(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  const candidate = `${resolvedStorePath}.street-accelerator-v7.bin`
  if (fs.existsSync(candidate)) return candidate
  const error = new Error(
    `Rust coordinate routing requires a current v7 persisted street accelerator snapshot for ${resolvedStorePath}.`,
  )
  error.code = 'VIGO_NATIVE_STREET_SNAPSHOT_REQUIRED'
  throw error
}

function cchPrefix(snapshotPath, format) {
  // Admit one immutable hierarchy for file-linked scenario street bases.
  if (fs.existsSync(snapshotPath)) snapshotPath = fs.realpathSync(snapshotPath)
  const source = snapshotIdentity(snapshotPath)
  const fingerprint = source?.identity?.sourceFingerprint
  const generation = /^[a-f0-9]{64}$/u.test(fingerprint ?? '') ? fingerprint.slice(0, 16) : 'prepared'
  const canonical = `${snapshotPath}.${format}.${generation}`
  if (fs.existsSync(`${canonical}.manifest.json`)) return canonical

  // Resolve a packaged generation by its embedded source identity. Copying or
  // extracting a City may change every filesystem timestamp, but not its graph.
  const directory = path.dirname(snapshotPath)
  const basename = `${path.basename(snapshotPath)}.${format}.`
  const identity = fileIdentity(snapshotPath)
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.startsWith(basename) || !name.endsWith('.manifest.json')) continue
    const manifestPath = path.join(directory, name)
    const size = fs.statSync(manifestPath).size
    if (size <= 0 || size > 64 * 1024) continue
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (source && manifest.source?.file === identity.file
      && manifest.source?.bytes === identity.bytes
      && JSON.stringify(manifest.sourceSnapshot) === JSON.stringify(source)) {
      return manifestPath.slice(0, -'.manifest.json'.length)
    }
  }
  return canonical
}

function streetCchPaths(snapshotPath) {
  const prefix = cchPrefix(snapshotPath, nativeStreetCchFormat)
  return {
    structurePath: `${prefix}.structure`,
    metricPath: `${prefix}.metric`,
    manifestPath: `${prefix}.manifest.json`,
  }
}

function driveCchPaths(accelerator, persist = true) {
  if (!persist) return {}
  const snapshotPath = String(accelerator?.snapshotPath ?? '').trim()
  if (!snapshotPath || !fs.existsSync(snapshotPath)) return {}
  const prefix = cchPrefix(snapshotPath, nativeDriveCchFormat)
  return {
    cchStructurePath: `${prefix}.structure`,
    cchTimeMetricPath: `${prefix}.time.metric`,
    cchDistanceMetricPath: `${prefix}.distance.metric`,
    cchManifestPath: `${prefix}.manifest.json`,
  }
}

function kernelRecord(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  const snapshotPath = snapshotPathForStore(resolvedStorePath)
  const snapshotStat = fs.statSync(snapshotPath, { bigint: true })
  const terminalAccessPath = `${resolvedStorePath}.terminal-access-v1.json`
  const terminalStat = fs.existsSync(terminalAccessPath) ? fs.statSync(terminalAccessPath, { bigint: true }) : null
  const identity = `${snapshotStat.dev}:${snapshotStat.ino}:${snapshotStat.size}:${snapshotStat.mtimeNs}|${terminalStat ? `${terminalStat.size}:${terminalStat.mtimeNs}` : 'public'}`
  const cached = nativeKernelCache.get(resolvedStorePath)
  if (cached?.identity === identity) return cached
  const { CoordinateKernel } = loadNativeBinding()
  const startedAt = performance.now()
  const cchPaths = streetCchPaths(snapshotPath)
  const structureExists = fs.existsSync(cchPaths.structurePath)
  const metricExists = fs.existsSync(cchPaths.metricPath)
  const manifestExists = fs.existsSync(cchPaths.manifestPath)
  if ([structureExists, metricExists, manifestExists].some(Boolean)
    && ![structureExists, metricExists, manifestExists].every(Boolean)) {
    const error = new Error(
      `Native street CCH index is incomplete for ${snapshotPath}; rebuild both immutable files.`,
    )
    error.code = 'VIGO_NATIVE_STREET_CCH_INCOMPLETE'
    throw error
  }
  const kernel = structureExists
    ? CoordinateKernel.openPrepared(snapshotPath, {
        structurePath: cchPaths.structurePath,
        metricPath: cchPaths.metricPath,
      })
    : new CoordinateKernel(snapshotPath)
  if (terminalStat) {
    if (typeof kernel.configureTerminalAccess !== 'function') throw new Error('This City requires a native kernel with authorized endpoint access support; rebuild the runtime.')
    kernel.configureTerminalAccess(terminalAccessPath)
  }
  const diagnostics = kernel.diagnostics()
  if (manifestExists) {
    validateCchManifest({
      kind: 'street',
      format: nativeStreetCchFormat,
      sourcePath: snapshotPath,
      ...cchPaths,
      metrics: { walk: cchPaths.metricPath },
      nodeCount: diagnostics.nodeCount,
      edgeCount: diagnostics.edgeCount,
    })
  }
  const streetCch = kernel.streetCchLoadDiagnostics()
  const record = {
    kernel,
    identity,
    snapshotPath,
    terminalAccess: terminalStat ? 'authorized_endpoints' : 'public',
    loadMs: performance.now() - startedAt,
    profileKey: '',
    profileMembers: null,
    profileMemberLons: null,
    profileMemberLats: null,
    profileMemberStreetAccessStopIds: null,
    profileCandidateBases: null,
    profileStopIds: null,
    profileStops: null,
    profileMemberIndicesByStopId: new Map(),
    workspaceReservation: null,
    diagnostics,
    cchPaths,
    streetCch,
  }
  nativeKernelCache.set(resolvedStorePath, record)
  return record
}

function preparedKernelRecord(storePath) {
  const resolvedStorePath = path.resolve(storePath)
  return nativeKernelCache.get(resolvedStorePath) ?? kernelRecord(resolvedStorePath)
}

export function validateNativeStationPaths(input) {
  const binding = loadNativeBinding()
  if (typeof binding.validateStationPaths !== 'function') throw new Error('Rust routing binding lacks station path validation. Rebuild the native kernel.')
  return binding.validateStationPaths(input)
}

export function compileNativeStationPaths(input) {
  const binding = loadNativeBinding()
  if (typeof binding.compileStationPaths !== 'function') throw new Error('Rust routing binding lacks station path compilation. Rebuild the native kernel.')
  return binding.compileStationPaths(input)
}

export function encodeNativeRoutingSnapshot(metadataJson, arrays) {
  const binding = loadNativeBinding()
  if (typeof binding.encodeRoutingSnapshot !== 'function') throw new Error('Rust routing binding lacks snapshot encoding. Rebuild the native kernel.')
  return binding.encodeRoutingSnapshot(metadataJson, arrays)
}

export function readNativeServiceTimetable(input) {
  const binding = loadNativeBinding()
  if (typeof binding.readServiceTimetable !== 'function') throw new Error('Rust routing binding lacks service timetable compilation. Rebuild the native kernel.')
  return binding.readServiceTimetable(input)
}

export function prepareNativeTimetableIndexes(input) {
  const binding = loadNativeBinding()
  if (typeof binding.prepareTimetableIndexes !== 'function') {
    throw new Error('Rust routing binding lacks timetable preparation. Rebuild the native kernel.')
  }
  return binding.prepareTimetableIndexes(input)
}

export function compileNativeTransferPaths(input) {
  const binding = loadNativeBinding()
  if (typeof binding.compileTransferPaths !== 'function') throw new Error('Rust routing binding lacks transfer path compilation. Rebuild the native kernel.')
  return binding.compileTransferPaths(input)
}

export function prepareNativeTimetableKernel(kernel) {
  const retained = nativeTimetableKernelCache.get(kernel)
  if (retained) return retained
  const { TimetableKernel } = loadNativeBinding()
  if (typeof TimetableKernel !== 'function') {
    const error = new Error('Rust routing binding does not expose TimetableKernel.')
    error.code = 'VIGO_NATIVE_TIMETABLE_KERNEL_MISSING'
    throw error
  }
  const startedAt = performance.now()
  const nativeKernel = new TimetableKernel({
    stopCount: kernel.stopIds.length,
    runCount: kernel.runCount,
    departureSeconds: kernel.departureSeconds,
    arrivalSeconds: kernel.arrivalSeconds,
    fromStop: kernel.fromStop,
    toStop: kernel.toStop,
    sequence: kernel.sequence,
    segmentTrip: kernel.segmentTrip,
    segmentRun: kernel.segmentRun,
    continuityBreak: kernel.continuityBreak,
    canBoard: kernel.canBoard,
    canAlight: kernel.canAlight,
    tripStart: kernel.tripStart,
    departureOffset: kernel.departureOffset,
    departureOrder: kernel.departureOrder,
    transferOffset: kernel.transferOffset,
    transferTo: kernel.transferTo,
    transferDuration: kernel.transferDuration,
    forbiddenSameStop: kernel.forbiddenSameStop,
    sameStopTransferMinimum: kernel.sameStopTransferMinimum,
    minimumTransferBufferSeconds: kernel.minimumTransferBufferSeconds ?? 0,
  })
  const diagnostics = nativeKernel.diagnostics()
  if ((kernel.minimumTransferBufferSeconds ?? 0) !== (diagnostics.transferBoardSlackSeconds ?? 0)) {
    throw new Error('Rust routing binding lacks the requested transfer buffer. Rebuild the native kernel.')
  }
  const record = {
    kernel: nativeKernel,
    configureMs: Number((performance.now() - startedAt).toFixed(3)),
    diagnostics,
  }
  nativeTimetableKernelCache.set(kernel, record)
  return record
}

export function prepareNativeDriveKernel(accelerator, options = {}) {
  const retained = nativeDriveKernelCache.get(accelerator)
  if (retained) return retained
  const { DriveKernel } = loadNativeBinding()
  if (typeof DriveKernel !== 'function') {
    const error = new Error('Rust routing binding does not expose DriveKernel.')
    error.code = 'VIGO_NATIVE_DRIVE_KERNEL_MISSING'
    throw error
  }
  const startedAt = performance.now()
  const cchPaths = driveCchPaths(accelerator, options.persistCch !== false)
  const cchArtifactPaths = [
    cchPaths.cchStructurePath,
    cchPaths.cchTimeMetricPath,
    cchPaths.cchDistanceMetricPath,
    cchPaths.cchManifestPath,
  ].filter(Boolean)
  const cchArtifactsExist = cchArtifactPaths.map((filePath) => fs.existsSync(filePath))
  if (options.requirePrepared && (cchArtifactPaths.length !== 4 || !cchArtifactsExist.every(Boolean))) {
    throw new Error('Prepared Drive CCH artifacts are missing; restore the complete City or rebuild it from source.')
  }
  if (cchArtifactsExist.some(Boolean) && !cchArtifactsExist.every(Boolean)) {
    throw new Error('Native Drive CCH generation is incomplete; rebuild all artifacts together.')
  }
  if (cchPaths.cchManifestPath && cchArtifactsExist.every(Boolean)) {
    validateCchManifest({
      kind: 'drive',
      format: nativeDriveCchFormat,
      sourcePath: accelerator.snapshotPath,
      manifestPath: cchPaths.cchManifestPath,
      structurePath: cchPaths.cchStructurePath,
      metrics: {
        time: cchPaths.cchTimeMetricPath,
        distance: cchPaths.cchDistanceMetricPath,
      },
      nodeCount: Number(accelerator.nodeCount),
      edgeCount: Number(accelerator.edgeTargets.length),
    })
  }
  const kernelInput = {
    nodeCount: accelerator.nodeCount,
    nodeLats: accelerator.nodeLats,
    nodeLons: accelerator.nodeLons,
    edgeOffsets: accelerator.edgeOffsets,
    edgeTargets: accelerator.edgeTargets,
    ...(accelerator.edgeDistanceUnits
      ? {
          edgeDistanceUnits: accelerator.edgeDistanceUnits,
          edgeTimeUnits: accelerator.edgeTimeUnits,
        }
      : {
          edgeDistances: accelerator.edgeDistances,
          edgeTravelTimes: accelerator.edgeTravelTimes,
        }),
    ...Object.fromEntries(Object.entries(cchPaths).filter(([name]) => name !== 'cchManifestPath')),
  }
  const kernel = new DriveKernel(kernelInput)
  if (cchPaths.cchManifestPath && !fs.existsSync(cchPaths.cchManifestPath)) {
    publishCchManifest({
      kind: 'drive',
      format: nativeDriveCchFormat,
      sourcePath: accelerator.snapshotPath,
      manifestPath: cchPaths.cchManifestPath,
      structurePath: cchPaths.cchStructurePath,
      metrics: {
        time: cchPaths.cchTimeMetricPath,
        distance: cchPaths.cchDistanceMetricPath,
      },
      edgeCount: Number(accelerator.edgeTargets.length),
    })
  }
  const record = {
    kernel,
    configureMs: Number((performance.now() - startedAt).toFixed(3)),
    diagnostics: kernel.diagnostics(),
  }
  nativeDriveKernelCache.set(accelerator, record)
  return record
}

// Traffic normalization, geometry matching and expiry belong to Rust.
export function normalizeDriveTrafficSnapshot(accelerator, value, streetSourceFingerprint) {
  if (value === null || value === undefined) return null
  try {
    const record = prepareNativeDriveKernel(accelerator)
    return JSON.parse(record.kernel.normalizeTrafficJson(
      JSON.stringify(value), String(streetSourceFingerprint ?? ''),
      accelerator.nodeLons, accelerator.nodeLats, Date.now(),
    ))
  } catch (cause) {
    const error = new Error(`Invalid drive traffic snapshot: ${cause.message}`, { cause })
    error.code = 'VIGO_INVALID_TRAFFIC_SNAPSHOT'
    throw error
  }
}

// Drive between two free coordinates. The kernel attaches each endpoint to its
// nearest drivable road by segment projection; the gap is a straight walk,
// and a gap longer than the walking limit blocks the trip.
export function routeNativeDriveCoordinates(accelerator, request) {
  const record = prepareNativeDriveKernel(accelerator)
  const result = record.kernel.routeCoordinates({
    originLon: request.origin[0],
    originLat: request.origin[1],
    destinationLon: request.destination[0],
    destinationLat: request.destination[1],
    maximumWalkMeters: request.maximumWalkKm * 1_000,
    walkingSpeedKph: request.walkingSpeedKph,
    maximumDistanceMeters: request.maximumDistanceKm * 1_000,
    ...(request.traffic ? { traffic: request.traffic } : {}),
    ...(request.nearestRoadOnly ? { nearestRoadOnly: true } : {}),
  })
  return {
    ...result,
    queryMs: normalizeNativeMilliseconds(result.search?.queryNs ?? 0),
    configureMs: record.configureMs,
  }
}

// Validates the shared alternatives contract; null when alternatives are off.
export function routeAlternativeRequest(request) {
  return loadNativeBinding().routeAlternativeRequest(JSON.stringify(request)) ?? null
}

export function nativeRoutingAccessProfilePrepared(storePath, profileKey) {
  const record = nativeKernelCache.get(path.resolve(storePath))
  return Boolean(
    record?.profileMembers
    && record.profileKey === String(profileKey ?? ''),
  )
}

export function prepareNativeRoutingKernel(storePath) {
  const record = kernelRecord(storePath)
  return {
    ready: true,
    accelerated: true,
    source: 'rust_mmap_node_api',
    snapshotPath: record.snapshotPath,
    terminalAccess: record.terminalAccess,
    loadMs: Number(record.loadMs.toFixed(3)),
    nodeCount: record.diagnostics.nodeCount,
    edgeCount: record.diagnostics.edgeCount,
    reverseEdgeCount: record.diagnostics.reverseEdgeCount,
    snapshotBytes: record.diagnostics.snapshotBytes,
    nativeResidentBytes: record.diagnostics.nativeResidentBytes,
    streetCch: record.streetCch
      ? {
          ready: true,
          format: nativeStreetCchFormat,
          structurePath: record.cchPaths.structurePath,
          metricPath: record.cchPaths.metricPath,
          manifestPath: record.cchPaths.manifestPath,
          ...record.streetCch,
        }
      : {
          ready: false,
          format: nativeStreetCchFormat,
          structurePath: record.cchPaths.structurePath,
          metricPath: record.cchPaths.metricPath,
          manifestPath: record.cchPaths.manifestPath,
        },
  }
}

export function buildNativeStreetCchIndex(storePath, options = {}) {
  const record = preparedKernelRecord(storePath)
  if (record.streetCch && options.force !== true) {
    return {
      built: false,
      cacheHit: true,
      format: nativeStreetCchFormat,
      ...record.cchPaths,
      ...record.streetCch,
    }
  }
  const built = record.kernel.buildStreetCchIndex({
    structurePath: record.cchPaths.structurePath,
    metricPath: record.cchPaths.metricPath,
    orderStrategy: String(options.orderStrategy ?? 'balanced'),
  })
  publishCchManifest({
    kind: 'street',
    format: nativeStreetCchFormat,
    sourcePath: record.snapshotPath,
    ...record.cchPaths,
    metrics: { walk: record.cchPaths.metricPath },
    edgeCount: Number(built.edgeCount),
  })
  record.streetCch = record.kernel.loadStreetCchIndex({
    structurePath: record.cchPaths.structurePath,
    metricPath: record.cchPaths.metricPath,
  })
  return {
    built: true,
    cacheHit: false,
    format: nativeStreetCchFormat,
    ...record.cchPaths,
    ...built,
    orderStrategy: String(options.orderStrategy ?? 'balanced'),
    loaded: record.streetCch,
  }
}

export function configureNativeRoutingAccessProfile(storePath, profile, options = {}) {
  const record = kernelRecord(storePath)
  const snapshotPath = String(options.snapshotPath ?? '').trim()
    ? path.resolve(options.snapshotPath)
    : ''
  if (!record.workspaceReservation) {
    record.workspaceReservation = record.kernel.reserveEndpointWorkspaces(
      nativeEndpointWorkspaceReservationM,
    )
  }
  if (record.profileKey === profile.profileKey) {
    let snapshotBytes = null
    let snapshotWriteMs = null
    let persistenceError = null
    if (snapshotPath) {
      try {
        if (fs.existsSync(snapshotPath)) {
          snapshotBytes = fs.statSync(snapshotPath).size
        } else {
          const written = record.kernel.persistAccessProfileSnapshot(snapshotPath)
          snapshotBytes = written.snapshotBytes
          snapshotWriteMs = normalizeNativeMilliseconds(written.elapsedNs)
        }
      } catch (error) {
        persistenceError = error instanceof Error ? error.message : String(error)
      }
    }
    return {
      configured: true,
      cacheHit: true,
      profileKey: record.profileKey,
      persistenceState: 'memory',
      ...(persistenceError ? { persistenceError } : {}),
      snapshotPath: snapshotPath || null,
      snapshotBytes,
      snapshotWriteMs,
      workspaceReservation: record.workspaceReservation,
      ...record.kernel.profileDiagnostics(),
    }
  }
  const startedAt = performance.now()
  let diagnostics
  let persistenceState = snapshotPath ? 'not_found' : 'disabled'
  let persistenceError = null
  let snapshotBytes = null
  let snapshotLoadMs = null
  let snapshotWriteMs = null
  if (snapshotPath && fs.existsSync(snapshotPath)) {
    try {
      const loaded = record.kernel.loadAccessProfileSnapshot(
        snapshotPath,
        profile.profileKey,
      )
      diagnostics = record.kernel.profileDiagnostics()
      if (
        Number(diagnostics.anchorCount) !== profile.anchorLons.length
        || Number(diagnostics.memberCount) !== profile.memberLons.length
      ) {
        throw new Error('Persisted native access profile dimensions do not match the active city package.')
      }
      persistenceState = 'loaded'
      snapshotBytes = loaded.snapshotBytes
      snapshotLoadMs = normalizeNativeMilliseconds(loaded.elapsedNs)
    } catch (error) {
      persistenceState = 'rejected'
      persistenceError = error instanceof Error ? error.message : String(error)
      fs.rmSync(snapshotPath, { force: true })
    }
  }
  if (!diagnostics) {
    diagnostics = record.kernel.setAccessProfile({
      profileKey: profile.profileKey,
      anchorLons: profile.anchorLons,
      anchorLats: profile.anchorLats,
      anchorMemberOffsets: profile.anchorMemberOffsets,
      anchorMemberIndices: profile.anchorMemberIndices,
      memberLons: profile.memberLons,
      memberLats: profile.memberLats,
      memberOriginEligible: profile.memberOriginEligible,
      memberDestinationEligible: profile.memberDestinationEligible,
      memberOriginExpansionEligible: profile.memberOriginExpansionEligible,
      memberDestinationExpansionEligible: profile.memberDestinationExpansionEligible,
      memberStopKeys: profile.memberStopKeys,
      memberStationKeys: profile.memberStationKeys,
      stopLons: profile.stopLons,
      stopLats: profile.stopLats,
      transferFromStopKeys: profile.transferFromStopKeys && Array.from(profile.transferFromStopKeys),
      transferToStopKeys: profile.transferToStopKeys && Array.from(profile.transferToStopKeys),
      transferToStationKeys: profile.transferToStationKeys && Array.from(profile.transferToStationKeys),
      transferMinDurations: profile.transferMinDurations && Array.from(profile.transferMinDurations),
      transferOsmCertified: profile.transferOsmCertified && Array.from(profile.transferOsmCertified),
      transferPathDistancesM: profile.transferPathDistancesM && Array.from(profile.transferPathDistancesM),
      walkingSpeedKph: profile.walkingSpeedKph,
      accessPaddingFactor: profile.accessPaddingFactor,
      accessOverheadSeconds: profile.accessOverheadSeconds,
    })
    if (snapshotPath) {
      try {
        const written = record.kernel.persistAccessProfileSnapshot(snapshotPath)
        persistenceState = 'written'
        snapshotBytes = written.snapshotBytes
        snapshotWriteMs = normalizeNativeMilliseconds(written.elapsedNs)
      } catch (error) {
        persistenceState = 'write_error'
        persistenceError = error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (snapshotPath && fs.existsSync(snapshotPath)) {
    try { fs.chmodSync(snapshotPath, 0o600) } catch {}
  }
  record.profileKey = profile.profileKey
  record.profileMembers = profile.members
  record.profileMemberLons = profile.memberLons
  record.profileMemberLats = profile.memberLats
  record.profileMemberStreetAccessStopIds = profile.memberStreetAccessStopIds
  record.profileStopIds = profile.stopIds
  record.profileStops = profile.stops
  record.profileTransferPaths = profile.transferPaths
  record.profileCandidateBases = profile.members.map((stop, index) => {
    const streetAccessLon = profile.memberLons[index]
    const streetAccessLat = profile.memberLats[index]
    return Object.freeze({
      ...stop,
      streetAccessStopId: profile.memberStreetAccessStopIds?.[index] ?? stop.stop_id,
      streetAccessCoordinate: [streetAccessLon, streetAccessLat],
      ...(
        stop.lon === streetAccessLon && stop.lat === streetAccessLat
          ? {}
          : { accessTransferCoordinate: [stop.lon, stop.lat] }
      ),
    })
  })
  record.profileMemberIndicesByStopId = new Map()
  for (let index = 0; index < profile.members.length; index += 1) {
    const member = profile.members[index]
    for (const stopId of new Set([
      String(member?.stop_id ?? '').trim(),
      String(profile.memberStreetAccessStopIds?.[index] ?? member?.stop_id ?? '').trim(),
    ])) {
      if (!stopId) continue
      const current = record.profileMemberIndicesByStopId.get(stopId)
      if (current === undefined) {
        record.profileMemberIndicesByStopId.set(stopId, index)
      } else if (Array.isArray(current)) {
        current.push(index)
      } else {
        record.profileMemberIndicesByStopId.set(stopId, [current, index])
      }
    }
  }
  return {
    configured: true,
    cacheHit: false,
    profileKey: record.profileKey,
    configureMs: Number((performance.now() - startedAt).toFixed(3)),
    persistenceState,
    persistenceError,
    snapshotPath: snapshotPath || null,
    snapshotBytes,
    snapshotLoadMs,
    snapshotWriteMs,
    workspaceReservation: record.workspaceReservation,
    ...diagnostics,
  }
}

// The fare engine shared with the Rust standalone runtime, for one saved catalog.
export function createNativeFareCatalog(json) {
  return new (loadNativeBinding().FareCatalog)(json)
}

export function disposeNativeRoutingKernel(storePath) {
  const resolvedPath = path.resolve(storePath)
  nativeKernelCache.delete(resolvedPath)
  nativeBinding?.disposeLocalBasemapStore(resolvedPath)
}

// One versioned projection is implemented in Rust for every public transport.
export function formatPublicResult(kind, request, result) {
  return JSON.parse(serializePublicResult(kind, request, result))
}

// Keep the shared Rust projection, but do not round-trip the lossless trace
// through serde and then parse/stringify the complete reply again for NDJSON.
export function serializePublicResult(kind, request, result) {
  const binding = loadNativeBinding()
  if (typeof binding.formatPublicResult !== 'function') throw new Error('Native kernel needs rebuilding for the public result schema')
  if (request?.diagnostics === 'trace' && ['route', 'matrix', 'reach', 'isochrone'].includes(kind)) {
    const raw = JSON.stringify(result)
    const projection = binding.formatPublicResult(`{"kind":${JSON.stringify(kind)},"request":${JSON.stringify({ ...request, diagnostics: 'profile' })},"result":${raw}}`)
    return `${projection.slice(0, -1)},"trace":${raw}}`
  }
  if (kind === 'route' && (request?.diagnostics ?? 'none') === 'none' && result?.result) {
    // The default route projection consumes these four diagnostic fields.
    // Keep its public metadata while avoiding serialization and native parsing
    // of the much larger search/kernel trace. Never mutate the retained plan.
    const projectPlan = plan => {
      if (!plan?.diagnostics) return plan
      const { realtime, realtimeRouting, timeReserves, clockDate } = plan.diagnostics
      return { ...plan, diagnostics: { realtime, realtimeRouting, timeReserves, clockDate } }
    }
    result = {
      ...result,
      result: projectPlan(result.result),
      ...(Array.isArray(result.choices) ? { choices: result.choices.map(projectPlan) } : {}),
    }
  }
  return binding.formatPublicResult(JSON.stringify({ kind, request, result }))
}

export function renderPublicText(result) {
  return loadNativeBinding().renderPublicText(JSON.stringify(result))
}

// Keep detailed Python choices in the same order and bounds as public Route.
export function selectDetailedRouteChoices(request, result) {
  return JSON.parse(loadNativeBinding().selectDetailedRouteChoices(JSON.stringify({ request, result })))
}

export function describeNativePlaces(streetStorePath, routingStorePath, coordinates) {
  const binding = loadNativeBinding()
  if (typeof binding.describePlaces !== 'function') throw new Error('Rust routing binding lacks place descriptions. Rebuild the native kernel.')
  return binding.describePlaces(streetStorePath ?? '', routingStorePath ?? '', coordinates.flatMap(([lon, lat]) => [Number(lon), Number(lat)]))
}

// Geometry executes inside the existing Reach worker/CLI. No JS fallback: a
// stale addon must fail explicitly instead of silently restoring old topology.
export function nativeRasterAreas(values, width, height, bounds, cutoffs, surface, cells = false) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height !== values.length || values.length > 1_048_576) {
    throw new Error('Invalid Reach raster dimensions')
  }
  if (typeof SharedArrayBuffer !== 'undefined' && values.buffer instanceof SharedArrayBuffer) throw new Error('Reach boundaries require an owned raster buffer')
  const raster = values instanceof Float64Array ? values : Float64Array.from(values, value => Number.isFinite(value) ? value : Infinity)
  const binding = loadNativeBinding()
  if (typeof binding.reachBoundaryAreas !== 'function') throw new Error('Rust routing binding lacks Reach boundaries. Rebuild the native kernel.')
  return JSON.parse(binding.reachBoundaryAreas(raster, width, height, bounds, cutoffs, surface, cells))
}

// Each land cell within a straight walk of 100 m from a reached street takes
// its fastest such street plus that walk, never through mapped water. Without
// complete water coverage nothing is shaded.
export function nativeOffStreetEstimates(values, width, height, bounds, water, walkSpeedKph) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height !== values.length || values.length > 1_048_576) {
    throw new Error('Invalid Reach raster dimensions')
  }
  const raster = values instanceof Float64Array ? values : Float64Array.from(values, value => Number.isFinite(value) ? value : Infinity)
  const binding = loadNativeBinding()
  if (typeof binding.reachOffStreetEstimates !== 'function') throw new Error('Rust routing binding lacks Reach off-street shading. Rebuild the native kernel.')
  return binding.reachOffStreetEstimates(raster, width, height, bounds, water ? JSON.stringify(water) : undefined, walkSpeedKph)
}

export function nativeNetworkOverview(storePath, sourceScope) {
  const binding = loadNativeBinding()
  if (typeof binding.networkOverview !== 'function') throw new Error('Rust routing binding lacks City overviews. Rebuild the native kernel.')
  return binding.networkOverview(storePath, sourceScope)
}
