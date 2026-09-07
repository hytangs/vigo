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
  path.resolve(moduleDirectory, '..', 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node'),
  path.resolve(moduleDirectory, '..', '..', 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node'),
].filter(Boolean))]
const nativeKernelCache = new Map()
const nativeTimetableKernelCache = new WeakMap()
const nativeCoordinateTimetableProjectionCache = new WeakMap()
const nativeDriveKernelCache = new WeakMap()
const nativeEndpointWorkspaceReservationM = Math.max(
  100,
  Math.min(5_000, Number(process.env.VIGO_NATIVE_ENDPOINT_WORKSPACE_M) || 1_600),
)
const nativeStreetCchFormat = 'street-cch-v1-u10000'
const nativeDriveCchFormat = 'drive-cch-v1-t100-d100'
const nativeCchManifestSchema = 'vigo.native-cch-manifest.v1'
let nativeBinding
let nativeBindingError

// Native bindings expose nanosecond counters. Keep all adapter-facing timing
// fields finite and in milliseconds even when an older or malformed binding
// omits a counter or returns a non-numeric value. Timing is diagnostic metadata
// and must never make an otherwise valid route throw from `.toFixed()` later.
export function normalizeNativeMilliseconds(value) {
  if (typeof value === 'boolean') return 0
  let nanoseconds
  try {
    nanoseconds = Number(value)
  } catch {
    return 0
  }
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return 0
  return Number((nanoseconds / 1e6).toFixed(3))
}

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
    builderVersion: '0.3.0',
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

function streetCchPaths(snapshotPath, snapshotStat) {
  const sourceIdentity = `${snapshotStat.size}-${snapshotStat.mtimeNs}`
  const prefix = `${snapshotPath}.${nativeStreetCchFormat}.${sourceIdentity}`
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
  const snapshotStat = fs.statSync(snapshotPath, { bigint: true })
  const sourceIdentity = `${snapshotStat.size}-${snapshotStat.mtimeNs}`
  const prefix = `${snapshotPath}.${nativeDriveCchFormat}.${sourceIdentity}`
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
  const kernel = new CoordinateKernel(snapshotPath)
  if (terminalStat) {
    if (typeof kernel.configureTerminalAccess !== 'function') throw new Error('This City requires a native kernel with authorized endpoint access support; rebuild the runtime.')
    kernel.configureTerminalAccess(terminalAccessPath)
  }
  const diagnostics = kernel.diagnostics()
  const cchPaths = streetCchPaths(snapshotPath, snapshotStat)
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
  const streetCch = structureExists ? kernel.loadStreetCchIndex({
    structurePath: cchPaths.structurePath,
    metricPath: cchPaths.metricPath,
  }) : null
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

function queryAccessTiming(request) {
  return {
    ...(Number.isFinite(Number(request?.walkingSpeedKph))
      ? { walkingSpeedKph: Number(request.walkingSpeedKph) }
      : {}),
    ...(Number.isFinite(Number(request?.accessPaddingFactor))
      ? { accessPaddingFactor: Number(request.accessPaddingFactor) }
      : {}),
    ...(Number.isFinite(Number(request?.accessOverheadSeconds))
      ? { accessOverheadSeconds: Number(request.accessOverheadSeconds) }
      : {}),
  }
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
  })
  const record = {
    kernel: nativeKernel,
    configureMs: Number((performance.now() - startedAt).toFixed(3)),
    diagnostics: nativeKernel.diagnostics(),
  }
  nativeTimetableKernelCache.set(kernel, record)
  return record
}

export function routeNativeTimetableScalar(kernel, request) {
  const record = prepareNativeTimetableKernel(kernel)
  const query = {
    ...timetableEndpointQuery(request),
    departure: request.departure,
    horizon: request.horizon,
  }
  const result = record.kernel.routeScalarCsa(query)
  return Object.assign(result, {
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    configureMs: record.configureMs,
    kernelDiagnostics: record.diagnostics,
  })
}

function timetableEndpointQuery(request) {
  return {
    originStops: request.originSeeds.map((seed) => seed.stop),
    originWalkSeconds: request.originSeeds.map((seed) => seed.walkSeconds),
    originCandidateIndices: request.originSeeds.map((seed) => seed.candidateIndex),
    destinationStops: request.destinationSeeds.map((seed) => seed.stop),
    destinationWalkSeconds: request.destinationSeeds.map((seed) => seed.walkSeconds),
    destinationCandidateIndices: request.destinationSeeds.map((seed) => seed.candidateIndex),
    maximumBoardings: request.maxTransfers === undefined ? undefined : request.maxTransfers + 1,
    allowPreRideTransfers: request.allowPreRideTransfers === true,
    allowPostRideTransfers: request.allowPostRideTransfers !== false,
  }
}

function coordinateTimetableProjection(record, kernel) {
  let retained = nativeCoordinateTimetableProjectionCache.get(kernel)
  if (!retained) {
    retained = new Map()
    nativeCoordinateTimetableProjectionCache.set(kernel, retained)
  }
  const key = `${record.identity}|${record.profileKey}`
  const cached = retained.get(key)
  if (cached) return cached
  const projection = new Uint32Array(record.profileMembers.length)
  projection.fill(0xffff_ffff)
  for (let member = 0; member < record.profileMembers.length; member += 1) {
    const stop = kernel.stopIndex.get(record.profileMembers[member].stop_id)
    if (stop !== undefined) projection[member] = stop
  }
  retained.set(key, projection)
  return projection
}

export function routeNativeCoordinateTimetableScalar(storePath, kernel, request) {
  const record = preparedKernelRecord(storePath)
  if (!record.profileMembers || !record.profileKey) {
    throw new Error('Rust routing access profile must be configured before fused routing.')
  }
  const timetable = prepareNativeTimetableKernel(kernel)
  const startedAt = performance.now()
  const result = record.kernel.routeEndpointsTimetableScalar(timetable.kernel, {
    originLon: request.origin[0],
    originLat: request.origin[1],
    destinationLon: request.destination[0],
    destinationLat: request.destination[1],
    maximumWalkM: request.maximumWalkM,
    ...queryAccessTiming(request),
    memberTimetableStops: coordinateTimetableProjection(record, kernel),
    departure: request.departure,
    horizon: request.horizon,
    ...(Number.isFinite(request.arriveByEarliest) ? {
      arriveByEarliest: request.arriveByEarliest,
    } : {}),
    ...(Number.isFinite(request.arriveByDeadline) ? {
      arriveByDeadline: request.arriveByDeadline,
    } : {}),
    maximumBoardings: request.maxTransfers === undefined ? undefined : request.maxTransfers + 1,
    allowPreRideTransfers: request.allowPreRideTransfers === true,
    retainFullFrontier: request.retainFullFrontier === true,
    enableDirectWalkDominance: request.enableDirectWalkDominance !== false,
    disableCache: request.disableCache === true,
  })
  const nodeApiWallMs = performance.now() - startedAt
  const arriveBy = result.arriveBy
    ? {
        ...result.arriveBy,
        queryMs: normalizeNativeMilliseconds(result.arriveBy.queryNs),
        engineQueryMs: normalizeNativeMilliseconds(result.arriveBy.engineQueryNs),
      }
    : null
  const timetableResult = result.timetable
    ? {
        ...result.timetable,
        queryMs: normalizeNativeMilliseconds(result.timetable.queryNs),
      }
    : null
  const endpoints = result.endpoints ?? result.compactEndpoints
  if (!endpoints) {
    throw new Error('Rust fused routing returned no endpoint frontier.')
  }
  const directWalkPath = result.directWalkPath?.found
    ? normalizeNativeStreetPathResult(
        result.directWalkPath,
        request.origin,
        request.destination,
      )
    : null
  const diagnostics = {
    kernel: 'rust_node_api_coordinate_timetable_scalar_v1',
    queryToken: endpoints.queryToken,
    cacheHit: endpoints.cacheHit,
    originCacheHit: endpoints.originCacheHit,
    destinationCacheHit: endpoints.destinationCacheHit,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    accessMs: normalizeNativeMilliseconds(result.accessNs),
    timetableMs: normalizeNativeMilliseconds(result.timetableNs),
    arriveByMs: normalizeNativeMilliseconds(result.arriveByNs),
    forwardTimetableMs: normalizeNativeMilliseconds(result.forwardTimetableNs),
    directWalkCchChecked: result.directWalkCchChecked,
    directWalkDistanceKm: Number.isFinite(result.directWalkDistanceM)
      ? result.directWalkDistanceM / 1_000
      : null,
    directWalkQueryMs: normalizeNativeMilliseconds(result.directWalkQueryNs),
    directWalkPathChecked: result.directWalkPathChecked,
    directWalkPathQueryMs: normalizeNativeMilliseconds(result.directWalkPathQueryNs),
    directWalkAccessDominates: result.directWalkAccessDominates,
    coordinateQueryMs: normalizeNativeMilliseconds(endpoints.queryNs),
    accessReductionMs: normalizeNativeMilliseconds(endpoints.accessReductionNs),
    originAccessReductionMs: normalizeNativeMilliseconds(endpoints.originAccessReductionNs),
    destinationAccessReductionMs: normalizeNativeMilliseconds(endpoints.destinationAccessReductionNs),
    snapMs: normalizeNativeMilliseconds(endpoints.snapNs),
    originSearchMs: normalizeNativeMilliseconds(endpoints.originSearchNs),
    destinationSearchMs: normalizeNativeMilliseconds(endpoints.destinationSearchNs),
    compactFrontier: result.compactFrontier,
    originCandidates: result.originCandidateCount,
    destinationCandidates: result.destinationCandidateCount,
    originRawCandidates: endpoints.originRawCandidates,
    destinationRawCandidates: endpoints.destinationRawCandidates,
    originLinkedStations: endpoints.originLinkedStations,
    destinationLinkedStations: endpoints.destinationLinkedStations,
    originCchAccelerated: endpoints.originCchAccelerated,
    destinationCchAccelerated: endpoints.destinationCchAccelerated,
    cchAccelerated: endpoints.originCchAccelerated && endpoints.destinationCchAccelerated,
    accessReducer: 'rust_exact_station_transfer_frontier_v1',
    directedEgress: true,
    nodeApiCalls: 1,
    nodeApiWallMs,
    candidateAssemblyMs: 0,
    adapterWallMs: nodeApiWallMs,
  }
  return Object.assign(result, {
    arriveBy,
    timetable: timetableResult,
    endpoints,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    accessMs: normalizeNativeMilliseconds(result.accessNs),
    timetableMs: normalizeNativeMilliseconds(result.timetableNs),
    arriveByMs: normalizeNativeMilliseconds(result.arriveByNs),
    forwardTimetableMs: normalizeNativeMilliseconds(result.forwardTimetableNs),
    directWalkCchChecked: result.directWalkCchChecked,
    directWalkDistanceKm: Number.isFinite(result.directWalkDistanceM)
      ? result.directWalkDistanceM / 1_000
      : null,
    directWalkQueryMs: normalizeNativeMilliseconds(result.directWalkQueryNs),
    directWalkPathChecked: result.directWalkPathChecked,
    directWalkPath,
    directWalkPathQueryMs: normalizeNativeMilliseconds(result.directWalkPathQueryNs),
    directWalkAccessDominates: result.directWalkAccessDominates,
    nodeApiWallMs,
    configureMs: timetable.configureMs,
    kernelDiagnostics: timetable.diagnostics,
    diagnostics,
  })
}

export function routeNativeCoordinateTimetableMany(storePath, kernel, request) {
  const record = preparedKernelRecord(storePath)
  if (!record.profileMembers || !record.profileKey) {
    throw new Error('Rust routing access profile must be configured before fused routing.')
  }
  const timetable = prepareNativeTimetableKernel(kernel)
  const targetTimetableStops = request.targetTimetableStops instanceof Uint32Array
    ? request.targetTimetableStops
    : Uint32Array.from(request.targetTimetableStops ?? [])
  const excludedTrips = request.excludedTrips instanceof Uint32Array
    ? request.excludedTrips
    : Uint32Array.from(request.excludedTrips ?? [])
  const startedAt = performance.now()
  const result = record.kernel.routeEndpointTimetableMany(timetable.kernel, {
    originLon: request.origin[0],
    originLat: request.origin[1],
    maximumWalkM: request.maximumWalkM,
    ...queryAccessTiming(request),
    memberTimetableStops: coordinateTimetableProjection(record, kernel),
    targetTimetableStops,
    excludedTrips,
    departure: request.departure,
    horizon: request.horizon,
    maximumBoardings: request.maxTransfers === undefined ? undefined : request.maxTransfers + 1,
    allowPreRideTransfers: request.allowPreRideTransfers === true,
    disableCache: request.disableCache === true,
  })
  const nodeApiWallMs = performance.now() - startedAt
  const access = result.access
  const diagnostics = {
    owner: 'rust_resident_timetable_kernel',
    kernel: 'rust_node_api_coordinate_timetable_one_to_many_v1',
    algorithm: result.timetable.algorithm,
    queryToken: access.queryToken,
    cacheHit: access.cacheHit,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    accessMs: normalizeNativeMilliseconds(result.accessNs),
    timetableMs: normalizeNativeMilliseconds(result.timetableNs),
    coordinateQueryMs: normalizeNativeMilliseconds(access.queryNs),
    accessReductionMs: normalizeNativeMilliseconds(access.accessReductionNs),
    snapMs: normalizeNativeMilliseconds(access.snapNs),
    originSearchMs: normalizeNativeMilliseconds(access.searchNs),
    originCandidates: result.originCandidateCount,
    projectedOriginCandidates: result.projectedOriginCount,
    originRawCandidates: access.rawCandidates,
    originLinkedStations: access.linkedStations,
    originCchAccelerated: access.cchAccelerated,
    targetCount: result.targetCount,
    scannedDepartures: result.timetable.scannedDepartures,
    excludedDepartures: result.timetable.excludedDepartures,
    relaxedStops: result.timetable.relaxedStops,
    expandedTripRuns: result.timetable.expandedTripRuns,
    nodeApiCalls: 1,
    nodeApiWallMs,
    candidateAssemblyMs: 0,
    directedAccess: true,
  }
  return Object.assign(result, {
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    accessMs: normalizeNativeMilliseconds(result.accessNs),
    timetableMs: normalizeNativeMilliseconds(result.timetableNs),
    nodeApiWallMs,
    configureMs: timetable.configureMs,
    kernelDiagnostics: timetable.diagnostics,
    diagnostics,
  })
}

function endpointArraysFromNativeResult(endpoints, role) {
  const prefix = role === 'destination' ? 'destination' : 'origin'
  return {
    memberIndices: endpoints[`${prefix}MemberIndices`],
    pathMemberIndices: endpoints[`${prefix}PathMemberIndices`],
    distancesM: endpoints[`${prefix}DistancesM`],
    accessSeconds: endpoints[`${prefix}AccessSeconds`],
    candidateKinds: endpoints[`${prefix}CandidateKinds`],
    linkFromStopKeys: endpoints[`${prefix}LinkFromStopKeys`],
    linkToStopKeys: endpoints[`${prefix}LinkToStopKeys`],
    linkDurations: endpoints[`${prefix}LinkDurations`],
    linkPathDistancesM: endpoints[`${prefix}LinkPathDistancesM`],
    linkStreetVerified: endpoints[`${prefix}LinkStreetVerified`],
  }
}

/**
 * Convert a native endpoint frontier to product candidates. When indices are
 * supplied, the returned array retains the full candidate-index domain but
 * materializes only those witnesses selected by the timetable search.
 */
export function materializeNativeCoordinateEndpointCandidates(
  storePath,
  endpoints,
  role,
  indices = null,
) {
  const record = preparedKernelRecord(storePath)
  const compactValues = role === 'destination'
    ? endpoints.destinationValues
    : endpoints.originValues
  if (compactValues) {
    if (
      compactValues.length !== 10
      || (indices !== null && (
        indices.length !== 1
        || Number(indices[0]) !== 0
      ))
    ) {
      throw new Error(`Rust timetable returned an invalid compact ${role} candidate.`)
    }
    const candidate = candidateFromNativeValues(
      record,
      role,
      endpoints.queryToken,
      ...compactValues,
    )
    const flatPath = role === 'destination'
      ? endpoints.destinationPathCoordinates
      : endpoints.originPathCoordinates
    // This is the fresh witness produced by the current fused native call,
    // not an endpoint or path cache entry.
    if (flatPath?.length) {
      candidate.nativeStreetPathCoordinates = orientNativeStreetPathCoordinates(
        coordinatePairsFromFlat(flatPath),
        role,
      )
    }
    return [candidate]
  }
  const arrays = endpointArraysFromNativeResult(endpoints, role)
  if (indices === null) {
    return candidatesFromNative(record, arrays, role, endpoints.queryToken)
  }
  if (arrays.memberIndices.length === 1 && indices.length === 1 && Number(indices[0]) === 0) {
    return candidatesFromNative(record, arrays, role, endpoints.queryToken)
  }
  const selectedIndices = [...new Set(indices.map(Number))]
  for (const index of selectedIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= arrays.memberIndices.length) {
      throw new Error(`Rust timetable selected an invalid ${role} candidate index ${index}.`)
    }
  }
  const selectedArrays = Object.fromEntries(Object.entries(arrays).map(([key, values]) => [
    key,
    selectedIndices.map((index) => values[index]),
  ]))
  const selectedCandidates = candidatesFromNative(
    record,
    selectedArrays,
    role,
    endpoints.queryToken,
  )
  const sparseCandidates = new Array(arrays.memberIndices.length)
  for (let index = 0; index < selectedIndices.length; index += 1) {
    sparseCandidates[selectedIndices[index]] = selectedCandidates[index]
  }
  return sparseCandidates
}

export function routeNativeTimetableArriveBy(kernel, request) {
  const record = prepareNativeTimetableKernel(kernel)
  const result = record.kernel.routeArriveByCsa({
    ...timetableEndpointQuery(request),
    earliest: request.earliest,
    deadline: request.deadline,
  })
  return {
    ...result,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    engineQueryMs: normalizeNativeMilliseconds(result.engineQueryNs),
    configureMs: record.configureMs,
    kernelDiagnostics: record.diagnostics,
  }
}

function flattenTimetableSeedSets(seedSets) {
  const offsets = [0]
  const stops = []
  const walkSeconds = []
  for (const seeds of seedSets) {
    for (const seed of seeds) {
      stops.push(seed.stop)
      walkSeconds.push(seed.walkSeconds)
    }
    offsets.push(stops.length)
  }
  return { offsets, stops, walkSeconds }
}

export function routeNativeCoordinateTimetableMatrix(storePath, kernel, request) {
  const record = preparedKernelRecord(storePath)
  if (!record.profileMembers || !record.profileKey) throw new Error('Rust coordinate access profile is required.')
  const timetable = prepareNativeTimetableKernel(kernel)
  const result = record.kernel.routeEndpointsTimetableMatrix(timetable.kernel, {
    originCoordinates: request.origins.flatMap((point) => point.coordinate),
    destinationCoordinates: request.destinations.flatMap((point) => point.coordinate),
    memberTimetableStops: coordinateTimetableProjection(record, kernel),
    maximumWalkM: request.maximumWalkM,
    ...queryAccessTiming(request),
    departure: request.departure, horizon: request.horizon, arriveBy: request.arriveBy,
    maximumBoardings: request.maxTransfers === undefined ? undefined : request.maxTransfers + 1,
    disableCache: request.disableCache === true,
  })
  return { ...result.timetable, queryMs: normalizeNativeMilliseconds(result.timetable.queryNs),
    accessMs: normalizeNativeMilliseconds(result.accessNs),
    coordinateMatrixMs: normalizeNativeMilliseconds(result.queryNs) }
}

export function routeNativeTimetableMatrix(kernel, request) {
  const record = prepareNativeTimetableKernel(kernel)
  const origins = flattenTimetableSeedSets(request.originSeedSets)
  const destinations = flattenTimetableSeedSets(request.destinationSeedSets)
  const result = record.kernel.routeMatrixCsa({
    originOffsets: origins.offsets,
    originStops: origins.stops,
    originWalkSeconds: origins.walkSeconds,
    destinationOffsets: destinations.offsets,
    destinationStops: destinations.stops,
    destinationWalkSeconds: destinations.walkSeconds,
    maximumBoardings: request.maxTransfers === undefined ? undefined : request.maxTransfers + 1,
    allowPreRideTransfers: request.allowPreRideTransfers,
    allowPostRideTransfers: request.allowPostRideTransfers,
    departure: request.departure,
    horizon: request.horizon,
    arriveBy: request.arriveBy,
  })
  return {
    ...result,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    configureMs: record.configureMs,
    kernelDiagnostics: record.diagnostics,
  }
}

export function routeNativeTimetableMany(kernel, request) {
  const record = prepareNativeTimetableKernel(kernel)
  const destinationSeedSets = request.destinationSeedSets
  let destinationSeedCount = 0
  for (const seeds of destinationSeedSets) destinationSeedCount += seeds.length
  const destinationOffsets = new Array(destinationSeedSets.length + 1)
  const destinationStops = new Array(destinationSeedCount)
  const destinationWalkSeconds = new Array(destinationSeedCount)
  let destinationSeed = 0
  destinationOffsets[0] = 0
  for (let set = 0; set < destinationSeedSets.length; set += 1) {
    const seeds = destinationSeedSets[set]
    for (const seed of seeds) {
      destinationStops[destinationSeed] = seed.stop
      destinationWalkSeconds[destinationSeed] = seed.walkSeconds
      destinationSeed += 1
    }
    destinationOffsets[set + 1] = destinationSeed
  }
  const originSeeds = request.originSeeds
  const originStops = new Array(originSeeds.length)
  const originWalkSeconds = new Array(originSeeds.length)
  for (let index = 0; index < originSeeds.length; index += 1) {
    originStops[index] = originSeeds[index].stop
    originWalkSeconds[index] = originSeeds[index].walkSeconds
  }
  const result = record.kernel.routeManyCsa({
    originStops,
    originWalkSeconds,
    destinationOffsets,
    destinationStops,
    destinationWalkSeconds,
    excludedTrips: request.excludedTrips ?? [],
    departure: request.departure,
    horizon: request.horizon,
    maximumBoardings: request.maxTransfers === undefined ? undefined : request.maxTransfers + 1,
    allowPreRideTransfers: request.allowPreRideTransfers === true,
    allowPostRideTransfers: request.allowPostRideTransfers,
  })
  return {
    ...result,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    configureMs: record.configureMs,
    kernelDiagnostics: record.diagnostics,
  }
}

export function routeNativeTimetableOverlayMany(kernel, request) {
  const record = prepareNativeTimetableKernel(kernel)
  const destinationOffsets = [0]
  const destinationStops = []
  const destinationWalkSeconds = []
  const destinationCandidateIndices = []
  for (const seeds of request.destinationSeedSets) {
    for (const seed of seeds) {
      destinationStops.push(seed.stop)
      destinationWalkSeconds.push(seed.walkSeconds)
      destinationCandidateIndices.push(seed.candidateIndex ?? destinationCandidateIndices.length)
    }
    destinationOffsets.push(destinationStops.length)
  }
  const overlay = request.overlay ?? {}
  const result = record.kernel.routeOverlayManyCsa({
    originStops: request.originSeeds.map((seed) => seed.stop),
    originWalkSeconds: request.originSeeds.map((seed) => seed.walkSeconds),
    originCandidateIndices: request.originSeeds.map((seed, index) => seed.candidateIndex ?? index),
    destinationOffsets,
    destinationStops,
    destinationWalkSeconds,
    destinationCandidateIndices,
    excludedTrips: request.excludedTrips ?? [],
    departure: request.departure,
    horizon: request.horizon,
    maximumBoardings: request.maxTransfers === undefined ? undefined : request.maxTransfers + 1,
    allowPreRideTransfers: request.allowPreRideTransfers === true,
    allowPostRideTransfers: request.allowPostRideTransfers,
    overlayStopCount: overlay.stopCount ?? 0,
    directionOffsets: overlay.directionOffsets ?? [0],
    directionStops: overlay.directionStops ?? [],
    directionStopOffsetsSeconds: overlay.directionStopOffsetsSeconds ?? [],
    serviceStartSeconds: overlay.serviceStartSeconds ?? [],
    serviceEndSeconds: overlay.serviceEndSeconds ?? [],
    serviceHeadwaySeconds: overlay.serviceHeadwaySeconds ?? [],
    supplementalTransferOffsets: overlay.supplementalTransferOffsets ?? [],
    supplementalTransferTo: overlay.supplementalTransferTo ?? [],
    supplementalTransferDuration: overlay.supplementalTransferDuration ?? [],
    directionCanBoard: overlay.directionCanBoard,
    directionCanAlight: overlay.directionCanAlight,
  })
  return {
    ...result.timetable,
    overlayConnections: result.overlayConnections,
    overlayRuns: result.overlayRuns,
    supplementalTransferEdges: result.supplementalTransferEdges,
    compileMs: normalizeNativeMilliseconds(result.compileNs),
    scanMs: normalizeNativeMilliseconds(result.scanNs),
    transientBytes: result.transientBytes,
    workspaceBytes: result.workspaceBytes,
    queryMs: normalizeNativeMilliseconds(result.timetable.queryNs),
    configureMs: record.configureMs,
    kernelDiagnostics: record.diagnostics,
  }
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

export function routeNativeDriveExact(accelerator, request) {
  const record = prepareNativeDriveKernel(accelerator)
  const result = record.kernel.routeExact({
    originNodes: request.origins.map((candidate) => candidate.nodeIndex),
    originSnapMeters: request.origins.map((candidate) => candidate.distanceKm * 1_000),
    targetNodes: request.targets.map((candidate) => candidate.nodeIndex),
    targetSnapMeters: request.targets.map((candidate) => candidate.distanceKm * 1_000),
    maximumDistanceMeters: request.maximumDistanceKm * 1_000,
    ...(request.traffic ? { traffic: request.traffic } : {}),
  })
  return {
    ...result,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    configureMs: record.configureMs,
  }
}

export function routeNativeTimetablePareto(kernel, request) {
  const record = prepareNativeTimetableKernel(kernel)
  const result = record.kernel.routeParetoRoundCsa({
    ...timetableEndpointQuery(request),
    departure: request.departure,
    horizon: request.horizon,
    earliestArrival: request.earliestArrival,
    boardingUpperBound: request.boardingUpperBound,
    candidateDestinationIndex: request.candidateDestinationIndex,
    candidateWalkingSeconds: request.candidateWalkingSeconds,
    arrivalSlackSeconds: request.arrivalSlackSeconds,
    transferPenaltySeconds: request.transferPenaltySeconds,
    walkReluctance: request.walkReluctance,
    ...(request.collectAlternatives ? { collectAlternatives: true } : {}),
    deadlineObjective: request.deadlineObjective === true,
    ...(request.restrictionMode ? { restrictionMode: request.restrictionMode } : {}),
  })
  return {
    ...result,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    corridorMs: normalizeNativeMilliseconds(result.corridorNs),
    forwardMs: normalizeNativeMilliseconds(result.forwardNs),
    reverseMs: normalizeNativeMilliseconds(result.reverseNs),
    roundMs: normalizeNativeMilliseconds(result.roundNs),
    configureMs: record.configureMs,
    kernelDiagnostics: record.diagnostics,
  }
}

export function nativeStreetCchPrepared(storePath) {
  return Boolean(nativeKernelCache.get(path.resolve(storePath))?.streetCch)
}

export function nativeRoutingAccessProfilePrepared(storePath, profileKey) {
  const record = nativeKernelCache.get(path.resolve(storePath))
  return Boolean(
    record?.profileMembers
    && record.profileKey === String(profileKey ?? ''),
  )
}

export function nativePublicAccessComponents(storePath) {
  return preparedKernelRecord(storePath).kernel.publicAccessComponents()
}

export function nativeStreetAccessPermission(storePath) {
  return nativeKernelCache.get(path.resolve(storePath))?.terminalAccess ?? 'public'
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
    orderStrategy: String(options.orderStrategy ?? 'inertial'),
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
      transferFromStopKeys: profile.transferFromStopKeys,
      transferToStopKeys: profile.transferToStopKeys,
      transferToStationKeys: profile.transferToStationKeys,
      transferMinDurations: profile.transferMinDurations,
      transferOsmCertified: profile.transferOsmCertified,
      transferPathDistancesM: profile.transferPathDistancesM,
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

function candidateFromNativeValues(
  record,
  role,
  queryToken,
  memberIndex,
  pathMemberIndex,
  distanceM,
  accessSeconds,
  candidateKind,
  linkFromStopKey,
  linkToStopKey,
  linkDuration,
  linkPathDistanceM,
  linkStreetVerified,
) {
  if (!record.profileMembers) throw new Error('Rust routing access profile is not configured.')
  const target = record.profileMembers[memberIndex]
  const source = record.profileCandidateBases?.[pathMemberIndex]
  if (!target || !source) {
    throw new Error(
      `Rust routing kernel returned unknown service/path member ${memberIndex}/${pathMemberIndex}.`,
    )
  }
  const linked = candidateKind === 1
  const exact = candidateKind === 2
  const candidate = {
    stop_id: target.stop_id,
    name: target.name,
    lat: target.lat,
    lon: target.lon,
    parent_station: target.parent_station,
    location_type: target.location_type,
    distanceKm: distanceM / 1000,
    accessSeconds,
    exactStopAccess: exact,
    walkSource: exact ? 'coordinate-colocation' : 'osm-rust',
    streetPathVerified: !linked || linkStreetVerified !== 0,
    streetAccessStopId: linked ? source.stop_id : source.streetAccessStopId,
    streetAccessCoordinate: linked
      ? [source.lon, source.lat]
      : source.streetAccessCoordinate,
    ...(!linked && source.accessTransferCoordinate
      ? { accessTransferCoordinate: source.accessTransferCoordinate }
      : {}),
    nativeStreetPath: {
      queryToken,
      role,
      memberIndex: pathMemberIndex,
    },
    accessRole: role,
    accessCandidateClass: exact
      ? 'exact-coordinate-colocation'
      : linked
        ? 'transfer-linked-station-access'
        : 'complete-native-directed-frontier',
    accessSearchComplete: true,
  }
  if (linked) {
    const fromStopId = record.profileStopIds?.[linkFromStopKey]
    const toStopId = record.profileStopIds?.[linkToStopKey]
    const transferredStop = record.profileStops?.[linkToStopKey]
    if (!fromStopId || !toStopId || !transferredStop) {
      throw new Error('Rust linked-access frontier returned unknown transfer stop keys.')
    }
    const transferCoordinate = [transferredStop.lon, transferredStop.lat]
    const reverse = role === 'destination'
    const path = record.profileTransferPaths?.get(reverse
      ? `${linkToStopKey}:${linkFromStopKey}:${linkDuration}`
      : `${linkFromStopKey}:${linkToStopKey}:${linkDuration}`)
    Object.assign(candidate, {
      ...(path ? {
        accessTransferCoordinates: reverse ? [...path.coordinates].reverse() : path.coordinates,
        accessTransferSources: path.sources,
      } : {}),
      accessTransferFromStopId: fromStopId,
      accessTransferToStopId: toStopId,
      accessTransferSeconds: linkDuration,
      accessTransferCoordinate: transferCoordinate,
      ...(linkPathDistanceM >= 0
        ? { accessTransferPathDistanceKm: linkPathDistanceM / 1000 }
        : {}),
      accessTransferStreetPathVerified: linkStreetVerified !== 0,
      ...(
        target.lon !== transferCoordinate[0]
        || target.lat !== transferCoordinate[1]
          ? { accessServiceCoordinate: [target.lon, target.lat] }
          : {}
      ),
    })
  }
  return candidate
}

function candidatesFromNative(record, arrays, role, queryToken) {
  if (!record.profileMembers) throw new Error('Rust routing access profile is not configured.')
  const {
    memberIndices,
    pathMemberIndices,
    distancesM,
    accessSeconds,
    candidateKinds,
    linkFromStopKeys,
    linkToStopKeys,
    linkDurations,
    linkPathDistancesM,
    linkStreetVerified,
  } = arrays
  const lengths = [
    pathMemberIndices,
    distancesM,
    accessSeconds,
    candidateKinds,
    linkFromStopKeys,
    linkToStopKeys,
    linkDurations,
    linkPathDistancesM,
    linkStreetVerified,
  ].map((values) => values?.length)
  if (lengths.some((length) => length !== memberIndices.length)) {
    throw new Error('Rust routing access frontier returned inconsistent final-label arrays.')
  }
  const candidates = new Array(memberIndices.length)
  for (let index = 0; index < memberIndices.length; index += 1) {
    candidates[index] = candidateFromNativeValues(
      record,
      role,
      queryToken,
      memberIndices[index],
      pathMemberIndices[index],
      distancesM[index],
      accessSeconds[index],
      candidateKinds[index],
      linkFromStopKeys[index],
      linkToStopKeys[index],
      linkDurations[index],
      linkPathDistancesM[index],
      linkStreetVerified[index],
    )
  }
  return candidates
}

export function routeNativeCoordinateFrontier(storePath, request) {
  const record = kernelRecord(storePath)
  if (!record.profileMembers || !record.profileKey) {
    throw new Error('Rust routing access profile must be configured before coordinate routing.')
  }
  const result = record.kernel.routeEndpoint({
    longitude: request.coordinate[0],
    latitude: request.coordinate[1],
    maximumWalkM: request.maximumWalkM,
    ...queryAccessTiming(request),
    role: request.role,
    disableCache: request.disableCache === true,
  })
  return {
    candidates: candidatesFromNative(
      record,
      {
        memberIndices: result.memberIndices,
        pathMemberIndices: result.pathMemberIndices,
        distancesM: result.distancesM,
        accessSeconds: result.accessSeconds,
        candidateKinds: result.candidateKinds,
        linkFromStopKeys: result.linkFromStopKeys,
        linkToStopKeys: result.linkToStopKeys,
        linkDurations: result.linkDurations,
        linkPathDistancesM: result.linkPathDistancesM,
        linkStreetVerified: result.linkStreetVerified,
      },
      request.role,
      result.queryToken,
    ),
    diagnostics: {
      kernel: 'rust_node_api_coordinate_role_v1',
      queryToken: result.queryToken,
      role: request.role,
      cacheHit: result.cacheHit,
      queryMs: normalizeNativeMilliseconds(result.queryNs),
      accessReductionMs: normalizeNativeMilliseconds(result.accessReductionNs),
      snapMs: normalizeNativeMilliseconds(result.snapNs),
      searchMs: normalizeNativeMilliseconds(result.searchNs),
      settledNodes: result.settledNodes,
      relaxedEdges: result.relaxedEdges,
      candidates: result.memberIndices.length,
      rawCandidates: result.rawCandidates,
      linkedStations: result.linkedStations,
      accessReducer: 'rust_exact_station_transfer_frontier_v1',
      directedEgress: request.role === 'destination',
      nodeApiCalls: 1,
      cchAccelerated: result.cchAccelerated,
    },
  }
}

export function routeNativeCoordinateFrontiers(storePath, request) {
  const adapterStartedAt = performance.now()
  const record = kernelRecord(storePath)
  if (!record.profileMembers || !record.profileKey) {
    throw new Error('Rust routing access profile must be configured before coordinate routing.')
  }
  const nodeApiStartedAt = performance.now()
  const result = record.kernel.routeEndpoints({
    originLon: request.origin[0],
    originLat: request.origin[1],
    destinationLon: request.destination[0],
    destinationLat: request.destination[1],
    maximumWalkM: request.maximumWalkM,
    ...queryAccessTiming(request),
    disableCache: request.disableCache === true,
  })
  const nodeApiWallMs = performance.now() - nodeApiStartedAt
  const candidateAssemblyStartedAt = performance.now()
  const origin = candidatesFromNative(
    record,
    {
      memberIndices: result.originMemberIndices,
      pathMemberIndices: result.originPathMemberIndices,
      distancesM: result.originDistancesM,
      accessSeconds: result.originAccessSeconds,
      candidateKinds: result.originCandidateKinds,
      linkFromStopKeys: result.originLinkFromStopKeys,
      linkToStopKeys: result.originLinkToStopKeys,
      linkDurations: result.originLinkDurations,
      linkPathDistancesM: result.originLinkPathDistancesM,
      linkStreetVerified: result.originLinkStreetVerified,
    },
    'origin',
    result.queryToken,
  )
  const destination = candidatesFromNative(
    record,
    {
      memberIndices: result.destinationMemberIndices,
      pathMemberIndices: result.destinationPathMemberIndices,
      distancesM: result.destinationDistancesM,
      accessSeconds: result.destinationAccessSeconds,
      candidateKinds: result.destinationCandidateKinds,
      linkFromStopKeys: result.destinationLinkFromStopKeys,
      linkToStopKeys: result.destinationLinkToStopKeys,
      linkDurations: result.destinationLinkDurations,
      linkPathDistancesM: result.destinationLinkPathDistancesM,
      linkStreetVerified: result.destinationLinkStreetVerified,
    },
    'destination',
    result.queryToken,
  )
  const candidateAssemblyMs = performance.now() - candidateAssemblyStartedAt
  const diagnostics = {
    kernel: 'rust_node_api_coordinate_v1',
    queryToken: result.queryToken,
    cacheHit: result.cacheHit,
    originCacheHit: result.originCacheHit,
    destinationCacheHit: result.destinationCacheHit,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    accessReductionMs: normalizeNativeMilliseconds(result.accessReductionNs),
    originAccessReductionMs: normalizeNativeMilliseconds(result.originAccessReductionNs),
    destinationAccessReductionMs: normalizeNativeMilliseconds(result.destinationAccessReductionNs),
    snapMs: normalizeNativeMilliseconds(result.snapNs),
    originSearchMs: normalizeNativeMilliseconds(result.originSearchNs),
    destinationSearchMs: normalizeNativeMilliseconds(result.destinationSearchNs),
    originSettledNodes: result.originSettledNodes,
    destinationSettledNodes: result.destinationSettledNodes,
    originRelaxedEdges: result.originRelaxedEdges,
    destinationRelaxedEdges: result.destinationRelaxedEdges,
    originCandidates: result.originMemberIndices.length,
    destinationCandidates: result.destinationMemberIndices.length,
    originRawCandidates: result.originRawCandidates,
    destinationRawCandidates: result.destinationRawCandidates,
    originLinkedStations: result.originLinkedStations,
    destinationLinkedStations: result.destinationLinkedStations,
    originCchAccelerated: result.originCchAccelerated,
    destinationCchAccelerated: result.destinationCchAccelerated,
    cchAccelerated: result.originCchAccelerated && result.destinationCchAccelerated,
    accessReducer: 'rust_exact_station_transfer_frontier_v1',
    directedEgress: true,
    nodeApiCalls: 1,
    nodeApiWallMs,
    candidateAssemblyMs,
    adapterWallMs: 0,
  }
  diagnostics.adapterWallMs = performance.now() - adapterStartedAt
  return {
    origin,
    destination,
    diagnostics,
  }
}

export function clearNativeCoordinateEndpointCaches(storePath) {
  const record = kernelRecord(storePath)
  record.kernel.clearEndpointCaches()
  return {
    cleared: true,
    profileKey: record.profileKey || null,
  }
}

export function buildNativeStopTransferGraph(storePath, request = {}) {
  const record = kernelRecord(storePath)
  if (!record.profileMembers || !record.profileKey) {
    throw new Error('Rust routing access profile must be configured before building stop transfers.')
  }
  const result = record.kernel.buildStopTransferGraph({
    maximumWalkM: Number(request.maximumWalkM),
    maximumNeighbors: Math.max(0, Math.floor(Number(request.maximumNeighbors) || 0)),
  })
  if (
    result.fromMemberIndices.length !== result.toMemberIndices.length
    || result.fromMemberIndices.length !== result.distancesM.length
  ) {
    throw new Error('Rust stop-transfer graph returned inconsistent edge arrays.')
  }
  return {
    fromMemberIndices: result.fromMemberIndices,
    toMemberIndices: result.toMemberIndices,
    distancesM: result.distancesM,
    diagnostics: {
      kernel: 'rust_node_api_stop_transfer_graph_v1',
      profileKey: record.profileKey,
      edgeCount: result.fromMemberIndices.length,
      sourceSearches: result.sourceSearches,
      candidatePairs: result.candidatePairs,
      settledNodes: result.settledNodes,
      relaxedEdges: result.relaxedEdges,
      buildMs: normalizeNativeMilliseconds(result.buildNs),
    },
  }
}

export function orientNativeStreetPathCoordinates(coordinates, role) {
  return role === 'destination' ? [...coordinates].reverse() : coordinates
}

function coordinatePairsFromFlat(values) {
  const coordinates = []
  for (let index = 0; index + 1 < (values?.length ?? 0); index += 2) {
    coordinates.push([values[index], values[index + 1]])
  }
  return coordinates
}

/**
 * Materialize an endpoint frontier in point-to-access order. Rust stores the
 * destination frontier in the legal walking direction (access stop to clicked
 * destination); itinerary assembly starts from the clicked point and reverses
 * the completed egress leg later, so destination coordinates must be flipped
 * exactly once here.
 */
export function materializeNativeStreetPath(storePath, nativeStreetPath, maximumPoints = 160) {
  const record = preparedKernelRecord(storePath)
  const result = record.kernel.materializePath({
    queryToken: nativeStreetPath.queryToken,
    role: nativeStreetPath.role,
    memberIndex: nativeStreetPath.memberIndex,
    maximumPoints,
  })
  const coordinates = coordinatePairsFromFlat(result.coordinates)
  return orientNativeStreetPathCoordinates(coordinates, nativeStreetPath.role)
}

function coordinatesExactlyEqual(left, right) {
  return (
    Array.isArray(left)
    && Array.isArray(right)
    && left.length === 2
    && right.length === 2
    && left.every(Number.isFinite)
    && right.every(Number.isFinite)
    && left[0] === right[0]
    && left[1] === right[1]
  )
}

function normalizeNativeStreetPathResult(result, fromCoordinate, toCoordinate) {
  if (!result.found) return null
  const graphCoordinates = []
  for (let index = 0; index + 1 < result.coordinates.length; index += 2) {
    graphCoordinates.push([result.coordinates[index], result.coordinates[index + 1]])
  }
  // Native path reconstruction is directed and ordered. Reversing its nodes
  // by endpoint proximity can invent edges that are absent from the graph.
  const coordinates = []
  for (const coordinate of [fromCoordinate, ...graphCoordinates, toCoordinate]) {
    if (!coordinatesExactlyEqual(coordinates.at(-1), coordinate)) {
      coordinates.push(coordinate)
    }
  }
  return {
    distanceKm: result.distanceM / 1000,
    coordinates,
    originSnapDistanceKm: result.originSnapDistanceM / 1000,
    destinationSnapDistanceKm: result.destinationSnapDistanceM / 1000,
    nativeQueryMs: normalizeNativeMilliseconds(result.queryNs),
    nativeSettledNodes: result.settledNodes,
    nativeRelaxedEdges: result.relaxedEdges,
    nativeChainSkippedNodes: result.chainSkippedNodes,
    nativeContractedArcRelaxations: result.contractedArcRelaxations,
    nativeCchAccelerated: result.cchAccelerated === true,
    geometryReversed: false,
  }
}

function encodedNativeTypedArray(value, expectedConstructor) {
  if (!(value instanceof expectedConstructor)) return null
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
}

function packedNativeStreetEdges(result) {
  const nodes = result.edgeEvidenceNodes
  const endpoints = result.edgeEvidenceEndpoints
  const edgeIds = result.edgeEvidenceIds
  const durations = result.edgeEvidenceDurations
  const walkDistances = result.edgeEvidenceWalkDistances
  const transitArrivals = result.edgeEvidenceTransitArrivals
  if (
    !(nodes instanceof Float64Array)
    || !(endpoints instanceof Uint32Array)
    || !(edgeIds instanceof Uint32Array)
    || !(durations instanceof Float64Array)
    || !(walkDistances instanceof Float64Array)
    || !(transitArrivals instanceof Float64Array)
    || nodes.length % 2 !== 0
    || endpoints.length % 2 !== 0
    || edgeIds.length !== endpoints.length / 2
    || durations.length !== endpoints.length / 2
    || walkDistances.length !== durations.length
    || transitArrivals.length !== durations.length
  ) return null
  return {
    schemaVersion: 'vigo.street.edge-bundle.v1',
    encoding: 'indexed-f64-le',
    count: durations.length,
    nodeCount: nodes.length / 2,
    nodes: encodedNativeTypedArray(nodes, Float64Array),
    endpoints: encodedNativeTypedArray(endpoints, Uint32Array),
    edgeIds: encodedNativeTypedArray(edgeIds, Uint32Array),
    durationMinutes: encodedNativeTypedArray(durations, Float64Array),
    walkDistanceM: encodedNativeTypedArray(walkDistances, Float64Array),
    transitArrivalMinutes: encodedNativeTypedArray(transitArrivals, Float64Array),
  }
}

function materializeNativeStreetEdges(result) {
  const nodes = result.edgeEvidenceNodes
  const endpoints = result.edgeEvidenceEndpoints
  const edgeIds = result.edgeEvidenceIds
  const durations = result.edgeEvidenceDurations
  const walkDistances = result.edgeEvidenceWalkDistances
  const transitArrivals = result.edgeEvidenceTransitArrivals
  const packed = packedNativeStreetEdges(result)
  if (!packed || !(nodes instanceof Float64Array) || !(endpoints instanceof Uint32Array)) return []
  return Array.from({ length: packed.count }, (_, index) => {
    const fromNode = endpoints[index * 2] * 2
    const toNode = endpoints[index * 2 + 1] * 2
    return {
      coordinates: [
        [nodes[fromNode], nodes[fromNode + 1]],
        [nodes[toNode], nodes[toNode + 1]],
      ],
      ...(edgeIds instanceof Uint32Array ? { edgeId: edgeIds[index] } : {}),
      durationMinutes: durations[index],
      walkDistanceM: walkDistances[index],
      ...(transitArrivals[index] >= 0 ? { transitArrivalMinutes: transitArrivals[index] } : {}),
    }
  })
}

export function rasterNativeStreetSurface(storePath, value) {
  const startedAt = performance.now()
  const bounds = Array.isArray(value?.bounds) && value.bounds.length === 4
    ? value.bounds.map(Number)
    : []
  if (
    bounds.length !== 4
    || !bounds.every(Number.isFinite)
    || bounds[0] >= bounds[2]
    || bounds[1] >= bounds[3]
  ) throw new Error('Street surface requires valid [west,south,east,north] bounds.')
  const width = Math.max(1, Math.min(1024, Math.floor(Number(value?.width) || 0)))
  const height = Math.max(1, Math.min(1024, Math.floor(Number(value?.height) || 0)))
  const maxWalkKm = Math.max(0.05, Math.min(20, Number(value?.maxWalkKm) || 1.2))
  const walkSpeedKph = Math.max(1, Math.min(12, Number(value?.walkSpeedKph) || 4.8))
  const maximumDurationMinutes = Math.max(
    1,
    Math.min(24 * 60, Number(value?.maximumDurationMinutes) || 90),
  )
  const nodeDetailLimit = Math.max(1, Math.min(100_000, Math.floor(Number(value?.nodeDetailLimit) || 30_000)))
  const requestedEdgeDetailLimit = Number(value?.edgeDetailLimit)
  const edgeDetailLimit = requestedEdgeDetailLimit === 0
    ? 0
    : Math.max(1, Math.min(100_000, Math.floor(requestedEdgeDetailLimit) || 12_000))
  const seeds = (Array.isArray(value?.seeds) ? value.seeds : []).flatMap((seed) => {
    const coordinate = Array.isArray(seed?.coordinate) ? seed.coordinate.map(Number) : []
    const durationMinutes = Number(seed?.durationMinutes)
    return coordinate.length === 2
      && coordinate.every(Number.isFinite)
      && Number.isFinite(durationMinutes)
      && durationMinutes <= maximumDurationMinutes
      ? [{ coordinate, durationMinutes: Math.max(0, durationMinutes) }]
      : []
  })
  const record = kernelRecord(storePath)
  const result = record.kernel.streetSurface({
    bounds,
    width,
    height,
    seedCoordinates: seeds.flatMap((seed) => seed.coordinate),
    seedDurationsMinutes: seeds.map((seed) => seed.durationMinutes),
    maximumWalkM: maxWalkKm * 1_000,
    walkSpeedKph,
    maximumDurationMinutes,
    independentTerminalWalk: value?.independentTerminalWalk === true,
    includeNodes: value?.includeNodes === true,
    nodeEvidenceLimit: nodeDetailLimit,
    includeEdges: value?.includeEdges === true,
    edgeEvidenceLimit: edgeDetailLimit,
    expandBoundsToReachedEdges: value?.expandBoundsToReachedEdges === true,
  })
  const packedEdges = packedNativeStreetEdges(result)
  const edges = packedEdges && value?.compactEdges === true
    ? packedEdges
    : Array.isArray(result.edgeEvidence) && result.edgeEvidence.length
      ? result.edgeEvidence.flatMap((edge) => {
        const from = [Number(edge?.fromLongitude), Number(edge?.fromLatitude)]
        const to = [Number(edge?.toLongitude), Number(edge?.toLatitude)]
        const durationMinutes = Number(edge?.durationMinutes)
        const walkDistanceM = Number(edge?.walkDistanceM)
        const transitArrivalMinutes = Number(edge?.transitArrivalMinutes)
        return from.concat(to).concat([durationMinutes, walkDistanceM]).every(Number.isFinite)
          ? [{
              coordinates: [from, to],
              durationMinutes,
              walkDistanceM,
              ...(Number.isFinite(transitArrivalMinutes) ? { transitArrivalMinutes } : {}),
            }]
          : []
      })
      : materializeNativeStreetEdges(result)
  const edgeDetailCount = packedEdges?.count ?? (Array.isArray(result.edgeEvidence) ? result.edgeEvidence.length : 0)
  return {
    schemaVersion: 'vigo.street.network-raster.v1',
    values: Float64Array.from(result.values),
    fullValues: result.fullSurfaceValues
      ? Float64Array.from(result.fullSurfaceValues)
      : null,
    fullBounds: Array.isArray(result.fullSurfaceBounds)
      ? result.fullSurfaceBounds.map(Number)
      : null,
    width,
    height,
    bounds,
    nodes: Array.isArray(result.nodeEvidence)
      ? result.nodeEvidence.flatMap((node) => {
        const longitude = Number(node?.longitude)
        const latitude = Number(node?.latitude)
        const durationMinutes = Number(node?.durationMinutes)
        const walkDistanceM = Number(node?.walkDistanceM)
        return [longitude, latitude, durationMinutes, walkDistanceM].every(Number.isFinite)
          ? [{ coordinate: [longitude, latitude], durationMinutes, walkDistanceM }]
          : []
      })
      : [],
    edges,
    diagnostics: {
      accelerated: true,
      kernel: 'rust_mmap_street_surface_v1',
      surfaceModel: value?.independentTerminalWalk === true
        ? 'directed_osm_edge_independent_terminal_walk'
        : 'directed_osm_edge_interpolation',
      terminalWalkMode: value?.independentTerminalWalk === true
        ? 'independent-full-budget'
        : 'elapsed-total',
      seeds: seeds.length,
      snappedSeeds: result.snappedSeeds,
      settledLabels: result.settledLabels,
      relaxedEdges: result.relaxedEdges,
      retainedLabels: result.retainedLabels,
      reachedPixels: result.reachedPixels,
      reachedEdgeCount: result.reachedEdgeCount,
      reachedEdgeLengthKm: Number(result.reachedEdgeLengthM ?? 0) / 1_000,
      nodeDetailCount: Array.isArray(result.nodeEvidence) ? result.nodeEvidence.length : 0,
      nodeDetailTruncated: result.nodeEvidenceTruncated === true,
      nodeDetailLimit,
      edgeDetailCount,
      edgeDetailTruncated: result.edgeEvidenceTruncated === true,
      edgeDetailLimit,
      fullSurfaceBounds: Array.isArray(result.fullSurfaceBounds)
        ? result.fullSurfaceBounds.map(Number)
        : null,
      fullSurfaceRaster: Boolean(result.fullSurfaceValues),
      maxWalkKm,
      walkSpeedKph,
      nativeQueryMs: normalizeNativeMilliseconds(result.queryNs),
      queryMs: Number((performance.now() - startedAt).toFixed(3)),
    },
  }
}

export function routeNativeTimedConnectors(storePath, value) {
  const startedAt = performance.now()
  const walkSpeedKph = Math.max(1, Math.min(12, Number(value?.walkSpeedKph) || 4.8))
  const defaultMaximumWalkKm = Math.max(0, Math.min(20, Number(value?.maxWalkKm) || 1.2))
  const maximumDurationMinutes = Math.max(
    1,
    Math.min(24 * 60, Number(value?.maximumDurationMinutes) || 240),
  )
  const targets = (Array.isArray(value?.targets) ? value.targets : []).flatMap((target, index) => {
    const coordinate = Array.isArray(target?.coordinate) ? target.coordinate.map(Number) : []
    return coordinate.length === 2 && coordinate.every(Number.isFinite)
      ? [{
        id: String(target?.id ?? `target-${index + 1}`),
        sourceIndex: index,
        coordinate,
      }]
      : []
  })
  const seeds = (Array.isArray(value?.seeds) ? value.seeds : []).flatMap((seed, index) => {
    const coordinate = Array.isArray(seed?.coordinate) ? seed.coordinate.map(Number) : []
    const durationMinutes = Number(seed?.durationMinutes)
    const requestedMaximumWalkKm = Object.hasOwn(seed ?? {}, 'maxWalkKm')
      ? Number(seed.maxWalkKm)
      : defaultMaximumWalkKm
    return coordinate.length === 2
      && coordinate.every(Number.isFinite)
      && Number.isFinite(durationMinutes)
      && durationMinutes >= 0
      && durationMinutes <= maximumDurationMinutes
      && Number.isFinite(requestedMaximumWalkKm)
      ? [{
        coordinate,
        durationMinutes,
        maximumWalkM: Math.max(0, Math.min(20, requestedMaximumWalkKm)) * 1_000,
        seedIndex: index,
      }]
      : []
  })
  const includeTargetMatrix = value?.includeTargetMatrix === true
  if (includeTargetMatrix && targets.length > 256) {
    throw new Error('Directed street connector matrices are limited to 256 targets.')
  }
  const record = kernelRecord(storePath)
  const result = record.kernel.timedConnectors({
    seedCoordinates: seeds.flatMap((seed) => seed.coordinate),
    seedDurationsMinutes: seeds.map((seed) => seed.durationMinutes),
    seedMaximumWalkM: seeds.map((seed) => seed.maximumWalkM),
    seedIndices: seeds.map((seed) => seed.seedIndex),
    targetCoordinates: targets.flatMap((target) => target.coordinate),
    defaultMaximumWalkM: defaultMaximumWalkKm * 1_000,
    walkSpeedKph,
    maximumDurationMinutes,
    includeTargetMatrix,
  })
  const matrix = includeTargetMatrix
    ? {
      size: targets.length,
      durationsMinutes: Array.from(
        result.matrixDurationsMinutes,
        (duration) => Number.isFinite(duration) ? duration : null,
      ),
      distancesKm: Array.from(
        result.matrixWalkDistancesM,
        (distanceM) => Number.isFinite(distanceM) ? distanceM / 1_000 : null,
      ),
      readyPairs: result.matrixReadyPairs,
      blockedPairs: targets.length ** 2 - result.matrixReadyPairs,
      directed: true,
    }
    : null
  return {
    schemaVersion: 'vigo.street.timed-connectors.v1',
    arrivals: targets.map((target, targetIndex) => {
      const durationMinutes = result.durationsMinutes[targetIndex]
      const walkDistanceM = result.walkDistancesM[targetIndex]
      const seedIndex = result.seedIndices[targetIndex]
      return {
        id: target.id,
        sourceIndex: target.sourceIndex,
        status: Number.isFinite(durationMinutes) ? 'ready' : 'blocked',
        durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
        walkDistanceKm: Number.isFinite(walkDistanceM) ? walkDistanceM / 1_000 : null,
        seedIndex: seedIndex >= 0 ? seedIndex : null,
      }
    }),
    matrix,
    diagnostics: {
      accelerated: true,
      kernel: 'rust_mmap_timed_connectors_v1',
      directed: true,
      searches: result.searches,
      seeds: seeds.length,
      targets: targets.length,
      snappedTargets: result.snappedTargets,
      reachedTargets: result.reachedTargets,
      snappedSeeds: result.snappedSeeds,
      settledLabels: result.settledLabels,
      relaxedEdges: result.relaxedEdges,
      retainedLabels: result.retainedLabels,
      aggregateCchAccelerated: result.aggregateCchAccelerated === true,
      aggregateCchQueryMs: normalizeNativeMilliseconds(result.aggregateCchQueryNs),
      matrixCchAccelerated: result.matrixCchAccelerated === true,
      matrixCchQueryMs: normalizeNativeMilliseconds(result.matrixCchQueryNs),
      maxWalkKm: defaultMaximumWalkKm,
      perSeedWalkBudgets: true,
      walkSpeedKph,
      maximumDurationMinutes,
      nativeQueryMs: normalizeNativeMilliseconds(result.queryNs),
      queryMs: Number((performance.now() - startedAt).toFixed(3)),
    },
  }
}

export function routeNativeStreetPath(storePath, fromCoordinate, toCoordinate, maximumDistanceKm, maximumPoints = 160) {
  if (coordinatesExactlyEqual(fromCoordinate, toCoordinate)) {
    return {
      distanceKm: 0,
      coordinates: [fromCoordinate, toCoordinate],
      originSnapDistanceKm: 0,
      destinationSnapDistanceKm: 0,
      nativeQueryMs: 0,
      nativeSettledNodes: 0,
      nativeRelaxedEdges: 0,
      nativeCchAccelerated: false,
      geometryReversed: false,
      exactCoordinateIdentity: true,
    }
  }
  // The routing lifecycle explicitly disposes this resident kernel whenever
  // its immutable street snapshot changes. Avoid a synchronous stat on every
  // already-prepared path witness in the measured OD path.
  const record = preparedKernelRecord(storePath)
  const result = record.kernel.routePath({
    originLon: fromCoordinate[0],
    originLat: fromCoordinate[1],
    destinationLon: toCoordinate[0],
    destinationLat: toCoordinate[1],
    maximumDistanceM: maximumDistanceKm * 1000,
    maximumPoints,
  })
  return normalizeNativeStreetPathResult(result, fromCoordinate, toCoordinate)
}

export function routeNativeWalkMatrix(storePath, request) {
  const record = preparedKernelRecord(storePath)
  const startedAt = performance.now()
  const result = record.kernel.routeStreetMatrix({
    originCoordinates: Array.from(request.originCoordinates ?? [], Number),
    destinationCoordinates: Array.from(request.destinationCoordinates ?? [], Number),
    maximumDistanceM: request.maximumDistanceKm * 1_000,
  })
  const nodeApiWallMs = performance.now() - startedAt
  return {
    distancesM: Array.from(result.distancesM, Number),
    readyPairs: result.readyPairs,
    sourceCandidates: result.sourceCandidates,
    destinationCandidates: result.destinationCandidates,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    nodeApiWallMs,
    configureMs: record.loadMs,
    kernelDiagnostics: record.diagnostics,
    diagnostics: {
      owner: 'rust_resident_street_matrix_kernel',
      mode: 'walk',
      algorithm: result.algorithm,
      cchAccelerated: result.cchAccelerated === true,
      sourceCandidates: result.sourceCandidates,
      destinationCandidates: result.destinationCandidates,
      readyPairs: result.readyPairs,
      nativeQueryMs: normalizeNativeMilliseconds(result.queryNs),
      nodeApiWallMs,
    },
  }
}

export function routeNativeDriveMatrix(accelerator, request) {
  const record = prepareNativeDriveKernel(accelerator)
  const originOffsets = [0]
  const originNodes = []
  const originSnapMeters = []
  for (const candidates of request.originCandidateSets ?? []) {
    for (const candidate of candidates) {
      originNodes.push(candidate.nodeIndex)
      originSnapMeters.push(candidate.distanceKm * 1_000)
    }
    originOffsets.push(originNodes.length)
  }
  const targetOffsets = [0]
  const targetNodes = []
  const targetSnapMeters = []
  for (const candidates of request.destinationCandidateSets ?? []) {
    for (const candidate of candidates) {
      targetNodes.push(candidate.nodeIndex)
      targetSnapMeters.push(candidate.distanceKm * 1_000)
    }
    targetOffsets.push(targetNodes.length)
  }
  const startedAt = performance.now()
  const result = record.kernel.routeMatrix({
    originOffsets,
    originNodes,
    originSnapMeters,
    targetOffsets,
    targetNodes,
    targetSnapMeters,
    maximumDistanceMeters: request.maximumDistanceKm * 1_000,
    ...(request.traffic ? { traffic: request.traffic } : {}),
  })
  const nodeApiWallMs = performance.now() - startedAt
  return {
    distancesM: Array.from(result.distancesM, Number),
    durationsS: Array.from(result.durationsS, Number),
    readyPairs: result.readyPairs,
    cchCandidateQueries: result.cchCandidateQueries,
    pathQueries: result.pathQueries,
    queryMs: normalizeNativeMilliseconds(result.queryNs),
    nodeApiWallMs,
    configureMs: record.configureMs,
    kernelDiagnostics: record.diagnostics,
    diagnostics: {
      owner: 'rust_resident_street_matrix_kernel',
      mode: 'drive',
      algorithm: result.algorithm,
      cchAccelerated: result.cchAccelerated === true,
      cchCandidateQueries: result.cchCandidateQueries,
      pathQueries: result.pathQueries,
      trafficApplied: result.trafficApplied === true,
      trafficUpdatedEdges: result.trafficUpdatedEdges,
      trafficCustomizationMs: normalizeNativeMilliseconds(result.trafficCustomizationNs),
      trafficMetricReused: result.trafficMetricReused === true,
      readyPairs: result.readyPairs,
      nativeQueryMs: normalizeNativeMilliseconds(result.queryNs),
      nodeApiWallMs,
    },
  }
}

export function routeNativeAccessMemberPath(
  storePath,
  fromStopId,
  toStopId,
  fromCoordinate,
  toCoordinate,
  maximumDistanceKm,
  maximumPoints = 160,
  stopTransfer = false,
) {
  const record = preparedKernelRecord(storePath)
  if (!record.profileMembers || !record.profileKey) {
    throw new Error('Rust routing access profile must be configured before member path routing.')
  }
  const memberIndices = (stopId) => {
    const value = record.profileMemberIndicesByStopId.get(String(stopId ?? '').trim())
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  }
  const originIndices = memberIndices(fromStopId)
  const destinationIndices = memberIndices(toStopId)
  let best = null
  for (const originMemberIndex of originIndices) {
    for (const destinationMemberIndex of destinationIndices) {
      const result = record.kernel.routeAccessMemberPath({
        originMemberIndex,
        destinationMemberIndex,
        maximumDistanceM: maximumDistanceKm * 1000,
        maximumPoints,
        stopTransfer,
      })
      if (result.found && (!best || result.distanceM < best.distanceM)) best = result
    }
  }
  return best
    ? normalizeNativeStreetPathResult(best, fromCoordinate, toCoordinate)
    : null
}

export function disposeNativeRoutingKernel(storePath) {
  nativeKernelCache.delete(path.resolve(storePath))
}
