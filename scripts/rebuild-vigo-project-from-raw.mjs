import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import {
  buildNationalGtfsStore,
  compactNationalGtfsRuntimeStore,
  disposeAllNationalGtfsStores,
  ensureNationalGtfsOsmStopTransfers,
  inspectNationalStaticTopologySidecar,
  mergeNationalGtfsStores,
  nationalFeedSummary,
  nationalStaticTopologySidecarPath,
  prepareNationalGtfsNativeCoordinateAccess,
  readNationalGtfsStoreMetadata,
} from '../src/server/national-gtfs-store.mjs'
import {
  buildNationalOsmStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  nationalOsmStoreDiagnostics,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import {
  buildNativeStreetCchIndex,
  normalizeNativeMilliseconds,
} from '../src/server/native-routing-kernel.mjs'
import { atomicWriteJson } from './lib/atomic-json.mjs'
import { argValue, argValues } from './lib/cli-args.mjs'

function feedDescriptor(value) {
  const separator = value.indexOf(':')
  if (separator <= 0) throw new Error(`--gtfs must be scope:/absolute/path.zip, received ${value}`)
  return {
    scope: value.slice(0, separator),
    zipPath: path.resolve(value.slice(separator + 1)),
  }
}

function progress(prefix) {
  let lastPhase = ''
  let lastPercent = -1
  return (update) => {
    const percent = Math.round(Number(update.progress ?? 0) * 100)
    if (update.phase === lastPhase && percent === lastPercent && percent < 100) return
    lastPhase = update.phase
    lastPercent = percent
    process.stdout.write(`[${prefix}] ${update.phase} ${percent}%${update.detail ? ` / ${update.detail}` : ''}\n`)
  }
}

function startRawOsmBuild({ pbfPath, outputPath, onProgress, buildDrivingProfile = false }) {
  const worker = new Worker(new URL('./lib/raw-osm-build-worker.mjs', import.meta.url), {
    workerData: { pbfPath, outputPath, buildDrivingProfile },
  })
  let settled = false
  const promise = new Promise((resolve) => {
    worker.on('message', (message) => {
      if (message?.type === 'progress') {
        onProgress?.(message.update)
        return
      }
      if (message?.type === 'result') {
        settled = true
        resolve({ result: message.result })
        return
      }
      if (message?.type === 'error') {
        settled = true
        const error = new Error(message.message)
        if (message.stack) error.stack = message.stack
        resolve({ error })
      }
    })
    worker.once('error', (error) => {
      if (!settled) resolve({ error })
      settled = true
    })
    worker.once('exit', (code) => {
      if (!settled) {
        resolve({ error: new Error(`Raw OSM build worker exited before returning a result (${code}).`) })
      }
      settled = true
    })
  })
  return { worker, promise }
}

function compactFeedMetadata(feed, routingStore) {
  return {
    id: feed.id,
    name: feed.name,
    provider: feed.provider,
    versionLabel: feed.versionLabel,
    importedAt: feed.importedAt,
    source: feed.source,
    fileName: feed.fileName,
    fileSize: feed.fileSize,
    hash: feed.hash,
    qualityScore: feed.qualityScore,
    routeCount: feed.routeCount,
    stopCount: feed.stopCount,
    tripCount: feed.tripCount,
    transferCandidates: feed.transferCandidates,
    requiredTables: feed.requiredTables,
    optionalTables: feed.optionalTables,
    tableProfiles: feed.tableProfiles,
    warnings: feed.warnings ?? [],
    routingStore,
  }
}

function projectSummary(feeds) {
  return {
    feeds: feeds.length,
    routes: feeds.reduce((sum, feed) => sum + Number(feed.routeCount ?? 0), 0),
    stops: feeds.reduce((sum, feed) => sum + Number(feed.stopCount ?? 0), 0),
    transferCandidates: feeds.reduce((sum, feed) => sum + Number(feed.transferCandidates ?? 0), 0),
    qualityScore: feeds.length
      ? Math.round(feeds.reduce((sum, feed) => sum + Number(feed.qualityScore ?? 0), 0) / feeds.length)
      : 0,
  }
}

function sourceVersionLabel(fileName, fallback) {
  const versions = [...path.basename(fileName).matchAll(/(?:^|\D)(20\d{6})(?=\D|$)/g)]
  return versions.at(-1)?.[1] || fallback
}

function visibleManifest(project) {
  return {
    schemaVersion: 'vigo.project.visible_manifest.v1',
    generatedAt: project.updatedAt,
    project: {
      id: project.id,
      name: project.name,
      region: project.region,
      storagePath: project.storagePath,
    },
    summary: project.summary,
    feeds: project.feeds.map((feed) => ({
      id: feed.id,
      name: feed.name,
      fileName: feed.fileName,
      provider: feed.provider,
      routeCount: Number(feed.routeCount ?? 0),
      stopCount: Number(feed.stopCount ?? 0),
      tripCount: Number(feed.tripCount ?? 0),
      routingStore: {
        status: feed.routingStore.status,
        routingEligibility: feed.routingStore.routingEligibility,
        connectionCount: Number(feed.routingStore.connectionCount ?? 0),
        bytes: Number(feed.routingStore.bytes ?? 0),
        storedAt: `.vigo/routing/${project.routingStore.fileName}`,
      },
    })),
    osmStreetIndex: {
      fileName: project.osmStreetIndex.fileName,
      sourceFingerprint: project.osmStreetIndex.sourceFingerprint,
      nodeCount: Number(project.osmStreetIndex.nodeCount ?? 0),
      edgeCount: Number(project.osmStreetIndex.edgeCount ?? 0),
      bytes: Number(project.osmStreetIndex.bytes ?? 0),
      storedAt: '.vigo/osm/street-index.sqlite',
    },
    storageLayout: {
      implementationDirectory: '.vigo',
      routingStore: `.vigo/routing/${project.routingStore.fileName}`,
      staticTopology: `.vigo/routing/${project.routingStore.fileName}.static-topology.sqlite`,
      osmStreetIndex: '.vigo/osm/street-index.sqlite',
      rebuildManifest: '.vigo/rebuild-manifest.json',
    },
  }
}

async function writeVisibleProjectFiles(projectRoot, project) {
  const manifest = visibleManifest(project)
  const feedLines = manifest.feeds.map((feed) => (
    `- ${feed.name ?? feed.id}: ${feed.routeCount.toLocaleString()} routes, `
    + `${feed.stopCount.toLocaleString()} stops, ${feed.tripCount.toLocaleString()} trips, `
    + `${feed.routingStore.routingEligibility} SQLite routing at \`${feed.routingStore.storedAt}\`.`
  )).join('\n')
  await Promise.all([
    atomicWriteJson(path.join(projectRoot, 'DATA_MANIFEST.json'), manifest),
    fsp.writeFile(path.join(projectRoot, 'README.md'), `# ${project.name}

This VIGO project was rebuilt atomically from raw GTFS and OSM PBF sources.
The complete generated data plane is SQLite-only; no legacy transport or street
JSON is retained.

${feedLines}

OSM street index: \`.vigo/osm/street-index.sqlite\`.
`),
  ])
}

async function rebuildLockOwnerIsAlive(lockPath) {
  let raw
  try {
    raw = await fsp.readFile(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let owner
  try {
    owner = JSON.parse(raw)
  } catch {
    throw new Error(`Cannot safely recover malformed rebuild lock: ${lockPath}`)
  }
  const pid = Number(owner?.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cannot safely recover rebuild lock without a valid owner PID: ${lockPath}`)
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'ESRCH' ? false : true
  }
}

async function acquireLock(lockPath) {
  while (true) {
    let handle
    try {
      handle = await fsp.open(lockPath, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const ownerAlive = await rebuildLockOwnerIsAlive(lockPath)
      if (ownerAlive === null) continue
      if (ownerAlive) throw new Error(`Another rebuild is already active: ${lockPath}`)
      await fsp.rm(lockPath, { force: true })
      continue
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
      return handle
    } catch (error) {
      await handle.close().catch(() => {})
      await fsp.rm(lockPath, { force: true }).catch(() => {})
      throw error
    }
  }
}

function assertSqliteHealthy(filePath, label) {
  const database = new DatabaseSync(filePath, { readOnly: true })
  try {
    const rows = database.prepare('PRAGMA quick_check(1)').all()
    const result = rows.map((row) => String(Object.values(row)[0]))
    if (result.length !== 1 || result[0] !== 'ok') {
      throw new Error(`${label} SQLite quick_check failed: ${JSON.stringify(result)}`)
    }
  } finally {
    database.close()
  }
}

function validateBuiltStores({ routingPath, streetPath, inputRecords, feeds: feedInputs }) {
  assertSqliteHealthy(routingPath, 'Routing store')
  assertSqliteHealthy(streetPath, 'Street store')

  const routingMetadata = readNationalGtfsStoreMetadata(routingPath)
  const routingInput = inputRecords.find((input) => input.kind === 'gtfs')
  if (feedInputs.length === 1 && routingMetadata.sourceFingerprint !== routingInput?.sourceFingerprint) {
    throw new Error(
      `Routing source identity mismatch: expected ${routingInput?.sourceFingerprint}, `
      + `received ${routingMetadata.sourceFingerprint}`,
    )
  }
  if ((routingMetadata.blockingRoutingFeatures ?? []).length) {
    throw new Error(
      `Rebuilt routing store is globally unsupported: `
      + `${JSON.stringify(routingMetadata.blockingRoutingFeatures)}`,
    )
  }
  const sidecar = inspectNationalStaticTopologySidecar(routingPath)
  if (!sidecar.ready) {
    throw new Error(`Static-topology sidecar is not ready: ${JSON.stringify(sidecar)}`)
  }

  const streetMetadata = nationalOsmStoreDiagnostics(streetPath)
  disposeNationalOsmStore(streetPath)
  const streetInput = inputRecords.find((input) => input.kind === 'osm-pbf')
  if (streetMetadata.sourceModel !== 'pbf') {
    throw new Error(`Street store is not PBF-derived: ${streetMetadata.sourceModel ?? 'missing sourceModel'}`)
  }
  if (streetMetadata.sourceFingerprint !== streetInput?.sourceFingerprint) {
    throw new Error(
      `Street source identity mismatch: expected ${streetInput?.sourceFingerprint}, `
      + `received ${streetMetadata.sourceFingerprint}`,
    )
  }
  if (streetMetadata.directionMetadataPresent !== true) {
    throw new Error('Rebuilt street store is missing explicit direction provenance metadata.')
  }
  for (const key of [
    'directionRestrictedWayCount',
    'directionExcludedWayCount',
    'uncertainConveyingWayCount',
  ]) {
    if (!Number.isInteger(streetMetadata[key]) || streetMetadata[key] < 0) {
      throw new Error(`Rebuilt street store is missing explicit direction provenance ${key}.`)
    }
  }
}

const projectsRoot = path.resolve(
  process.env.VIGO_PROJECTS_ROOT
  || process.env.VIGO_PROJECTS_DIR
  || path.join(os.homedir(), 'Documents', 'Vigo Projects'),
)
const projectId = argValue('project')
const feeds = argValues('gtfs').map(feedDescriptor)
const osmArgument = argValue('osm')
const osmPath = osmArgument ? path.resolve(osmArgument) : ''
const keepBackup = process.argv.includes('--keep-backup')
const requestedParallelRawBuild = process.argv.includes('--parallel-raw-build')
const requestedSequentialRawBuild = process.argv.includes('--sequential-raw-build')
if (requestedParallelRawBuild && requestedSequentialRawBuild) {
  throw new Error('--parallel-raw-build and --sequential-raw-build are mutually exclusive')
}
if (!projectId) throw new Error('--project is required.')
if (!feeds.length) throw new Error('At least one --gtfs=scope:/path/feed.zip is required.')
if (!osmPath) throw new Error('--osm=/path/extract.osm.pbf is required.')

let gtfsInputBytes = 0
for (const feed of feeds) {
  const stats = await fsp.stat(feed.zipPath).catch(() => null)
  if (!stats?.isFile()) throw new Error(`GTFS source is missing: ${feed.zipPath}`)
  gtfsInputBytes += stats.size
}
const osmStats = await fsp.stat(osmPath).catch(() => null)
if (!osmStats?.isFile()) throw new Error(`OSM PBF source is missing: ${osmPath}`)

await fsp.mkdir(projectsRoot, { recursive: true })
const projectRoot = path.join(projectsRoot, projectId)
const existingProjectPath = path.join(projectRoot, '.vigo', 'project.json')
const existingProject = await fsp.readFile(existingProjectPath, 'utf8')
  .then((value) => JSON.parse(value))
  .catch(() => null)
const rebuildId = new Date().toISOString().replace(/[:.]/g, '-')
const stagingRoot = path.join(projectsRoot, `.${projectId}.rebuild-${rebuildId}`)
const streetPath = path.join(stagingRoot, '.vigo', 'osm', 'street-index.sqlite')
const backupRoot = path.join(projectsRoot, `.${projectId}.pre-${rebuildId}`)
const lockPath = path.join(projectsRoot, `.${projectId}.rebuild.lock`)
const lock = await acquireLock(lockPath)
const phaseWallMs = {}
const preprocessingStarted = performance.now()
const coldHostAtStart = {
  capturedAt: new Date().toISOString(),
  loadAverage: os.loadavg(),
  freeMemoryBytes: os.freemem(),
  totalMemoryBytes: os.totalmem(),
  cpus: os.cpus().length,
  node: process.version,
}
let peakResidentBytesSampled = process.memoryUsage().rss
const memorySampleIntervalMs = 50
const rawOsmParallelWorkingSetMultiplier = 80
const rawGtfsParallelWorkingSetMultiplier = 20
const rawParallelFixedWorkingSetBytes = 256 * 1024 * 1024
const memorySampler = setInterval(() => {
  peakResidentBytesSampled = Math.max(peakResidentBytesSampled, process.memoryUsage().rss)
}, memorySampleIntervalMs)
memorySampler.unref()

async function timedPhase(id, action) {
  const started = performance.now()
  try {
    return await action()
  } finally {
    phaseWallMs[id] = Number((performance.now() - started).toFixed(3))
    peakResidentBytesSampled = Math.max(peakResidentBytesSampled, process.memoryUsage().rss)
  }
}

let published = false
let oldProjectMoved = false
let rawOsmBuild = null
try {
  await fsp.rm(stagingRoot, { recursive: true, force: true })
  const metadataRoot = path.join(stagingRoot, '.vigo')
  const routingDirectory = path.join(metadataRoot, 'routing')
  const osmDirectory = path.join(metadataRoot, 'osm')
  const componentDirectory = path.join(metadataRoot, 'components')
  await Promise.all([
    fsp.mkdir(routingDirectory, { recursive: true }),
    fsp.mkdir(osmDirectory, { recursive: true }),
    fsp.mkdir(componentDirectory, { recursive: true }),
  ])
  // Compressed input bytes substantially understate the importer working set:
  // the OSM pass retains decoded node/topology arrays while SQLite and the
  // accelerator are emitted. This intentionally conservative estimate keeps
  // GTFS/OSM overlap enabled for city extracts without risking national OOMs.
  const parallelRawBuildEstimatedBytes = (
    rawParallelFixedWorkingSetBytes
    + osmStats.size * rawOsmParallelWorkingSetMultiplier
    + gtfsInputBytes * rawGtfsParallelWorkingSetMultiplier
  )
  const parallelRawBuildMemoryGuardBytes = os.totalmem() * 0.55
  // Total physical memory is not enough on a shared desktop or CI runner:
  // starting both importers while the host is already under pressure turns a
  // nominally parallel build into swap/throttle time. Preserve parallelism
  // when there is real headroom, otherwise use the bounded sequential path.
  const parallelRawBuildFreeMemoryGuardBytes = Math.min(
    parallelRawBuildEstimatedBytes * 0.75,
    os.totalmem() * 0.02,
  )
  const freeMemoryAtBuildStartBytes = os.freemem()
  const loadAverageAtBuildStart = os.loadavg()
  const parallelRawBuildLoadGuard = loadAverageAtBuildStart[1]
    <= Math.max(1, os.cpus().length * 2)
  // Sequential compilation is the safe default. Parallelism is an explicit
  // opt-in and still has to pass every host-memory/load guard below.
  const parallelRawBuild = (
    requestedParallelRawBuild
    && os.cpus().length >= 4
    && os.totalmem() >= 8 * 1024 * 1024 * 1024
    && parallelRawBuildEstimatedBytes <= parallelRawBuildMemoryGuardBytes
    && freeMemoryAtBuildStartBytes >= parallelRawBuildFreeMemoryGuardBytes
    && parallelRawBuildLoadGuard
  )
  let streetBuildOutcome = null
  if (parallelRawBuild) {
    rawOsmBuild = startRawOsmBuild({
      pbfPath: osmPath,
      outputPath: streetPath,
      // Build the compact drive snapshot while the OSM importer already owns
      // the decoded graph. This overlaps its cost with GTFS compilation and
      // lets the later compaction phase load rather than rebuild it.
      buildDrivingProfile: true,
      onProgress: progress('osm'),
    })
    streetBuildOutcome = timedPhase('osm_build', async () => {
      const outcome = await rawOsmBuild.promise
      if (outcome.error) throw outcome.error
      return outcome.result
    }).then((result) => ({ result }), (error) => ({ error }))
  }

  const componentStores = []
  for (const feed of feeds) {
    const outputPath = path.join(componentDirectory, `${feed.scope}.sqlite`)
    const result = await timedPhase(`gtfs_build:${feed.scope}`, () => buildNationalGtfsStore({
      zipPath: feed.zipPath,
      outputPath,
      onProgress: progress(feed.scope),
    }))
    componentStores.push({ scope: feed.scope, storePath: outputPath, result })
  }

  const routingPath = path.join(routingDirectory, 'project.sqlite')
  let routingResult
  if (componentStores.length === 1) {
    const [component] = componentStores
    routingResult = await timedPhase('routing_store_finalize', async () => {
      await fsp.rename(component.storePath, routingPath)
      await fsp.rename(
        nationalStaticTopologySidecarPath(component.storePath),
        nationalStaticTopologySidecarPath(routingPath),
      )
      return {
        ...component.result,
        sourceFile: path.basename(feeds[0].zipPath),
        path: routingPath,
        bytes: (await fsp.stat(routingPath)).size,
      }
    })
  } else {
    routingResult = await timedPhase('routing_store_merge', () => mergeNationalGtfsStores({
      stores: componentStores,
      outputPath: routingPath,
      onProgress: progress('merge'),
      removeSourcesAfterMerge: true,
    }))
  }
  await fsp.rm(componentDirectory, { recursive: true, force: true })

  let streetResult
  if (streetBuildOutcome) {
    const outcome = await streetBuildOutcome
    if (outcome.error) throw outcome.error
    streetResult = outcome.result
    // The worker has already flushed the authoritative SQLite store and all
    // runtime snapshots. Release its importer heap before native CCH and
    // coordinate-access preparation so the peak reflects one build phase at a
    // time rather than a retained OSM worker plus the native builders.
    await rawOsmBuild.worker.terminate().catch(() => {})
    rawOsmBuild = null
  } else {
    streetResult = await timedPhase('osm_build', () => buildNationalOsmStore({
      pbfPath: osmPath,
      outputPath: streetPath,
      buildDrivingProfile: true,
      onProgress: progress('osm'),
    }))
  }
  // Both importers hash their raw streams while establishing the durable
  // source identity. Reuse those freshly computed digests here instead of
  // reading every multi-gigabyte input a second time before preprocessing.
  const inputRecords = await timedPhase('input_identity', async () => [
    ...componentStores.map((component, index) => ({
      kind: 'gtfs',
      scope: feeds[index].scope,
      path: feeds[index].zipPath,
      bytes: component.result.sourceBytes,
      sourceFingerprint: component.result.sourceFingerprint,
    })),
    {
      kind: 'osm-pbf',
      path: osmPath,
      bytes: streetResult.sourceBytes,
      sourceFingerprint: streetResult.sourceFingerprint,
    },
  ])
  const osmRuntimeCompaction = await timedPhase(
    'osm_runtime_compaction',
    () => compactNationalOsmRuntimeStore(streetPath, { requireDrive: true }),
  )
  const runtimeDriveSnapshot = osmRuntimeCompaction.drive?.snapshotPath
    ? {
        ...osmRuntimeCompaction.drive,
        // The published project is renamed out of its staging directory after
        // this point. Keep a portable artifact name in the manifest instead
        // of leaking the temporary absolute path.
        snapshotPath: path.basename(osmRuntimeCompaction.drive.snapshotPath),
      }
    : osmRuntimeCompaction.drive
  streetResult = {
    ...streetResult,
    bytes: osmRuntimeCompaction.afterBytes,
    storageLayout: osmRuntimeCompaction.storageLayout,
    driveSnapshot: runtimeDriveSnapshot,
  }
  const nativeStreet = prepareNationalOsmNativeStore(streetPath)
  if (!nativeStreet.ready) {
    throw new Error(`Native street snapshot is unavailable: ${nativeStreet.error ?? nativeStreet.reason}`)
  }
  const streetCchResult = await timedPhase(
    'osm_cch_build',
    () => buildNativeStreetCchIndex(streetPath),
  )
  const streetCch = {
    ready: Number(streetCchResult.loaded?.cchArcCount ?? streetCchResult.cchArcCount ?? 0) > 0,
    format: streetCchResult.format,
    orderStrategy: streetCchResult.orderStrategy ?? 'inertial',
    nodeCount: streetCchResult.nodeCount,
    edgeCount: streetCchResult.edgeCount,
    cchArcCount: streetCchResult.cchArcCount,
    distanceUnitsPerMeter: streetCchResult.loaded?.distanceUnitsPerMeter
      ?? streetCchResult.distanceUnitsPerMeter,
    orderMs: normalizeNativeMilliseconds(streetCchResult.orderNs),
    buildMs: normalizeNativeMilliseconds(streetCchResult.structureNs),
    customizeMs: normalizeNativeMilliseconds(streetCchResult.customizationNs),
    persistMs: normalizeNativeMilliseconds(streetCchResult.persistenceNs),
    structureFile: path.basename(streetCchResult.structurePath),
    metricFile: path.basename(streetCchResult.metricPath),
  }
  if (!streetCch.ready) throw new Error('Native street CCH did not load after it was built.')
  // Compaction changes SQLite's generation. Finish it before transfer-aware
  // topology and coordinate-access snapshots are sealed against this store.
  const gtfsRuntimeCompaction = await timedPhase(
    'gtfs_runtime_compaction',
    () => compactNationalGtfsRuntimeStore(routingPath),
  )
  const osmStopTransfers = await timedPhase(
    'osm_stop_transfers',
    () => ensureNationalGtfsOsmStopTransfers(routingPath, streetPath, {
      onProgress: progress('transfers'),
    }),
  )
  const nativeCoordinateAccess = await timedPhase(
    'native_coordinate_access_build',
    () => prepareNationalGtfsNativeCoordinateAccess(routingPath, streetPath),
  )
  if (!nativeCoordinateAccess.ready) {
    throw new Error('Native coordinate access profile did not prepare after sealed compilation.')
  }
  routingResult = {
    ...routingResult,
    ...readNationalGtfsStoreMetadata(routingPath),
    path: routingPath,
    bytes: (await fsp.stat(routingPath)).size,
    departureIndexState: gtfsRuntimeCompaction.state,
  }
  await timedPhase('store_validation', async () => validateBuiltStores({
    routingPath,
    streetPath,
    inputRecords,
    feeds,
  }))
  const feedId = `feed_${String(routingResult.storeId).slice(0, 10)}`
  const feedSummary = nationalFeedSummary(routingPath, routingResult, feedId)
  if (feeds.length === 1) {
    feedSummary.versionLabel = sourceVersionLabel(feeds[0].zipPath, feedSummary.versionLabel)
  }
  const routingStore = {
    ...feedSummary.routingStore,
    fileName: 'project.sqlite',
    departureIndexState: routingResult.departureIndexState,
    osmStopTransfers: {
      schemaVersion: osmStopTransfers.schemaVersion,
      fingerprint: osmStopTransfers.fingerprint,
      built: osmStopTransfers.built,
      edgeCount: osmStopTransfers.edgeCount,
      candidateEdgeCount: osmStopTransfers.candidateEdgeCount,
      maximumWalkM: osmStopTransfers.maximumWalkM,
      maximumNeighbors: osmStopTransfers.maximumNeighbors,
    },
    nativeCoordinateAccess: {
      profileKey: nativeCoordinateAccess.profileKey,
      mode: 'exact-local-graph-frontier',
      persistenceState: nativeCoordinateAccess.persistenceState,
      snapshotBytes: nativeCoordinateAccess.snapshotBytes,
      prepareMs: nativeCoordinateAccess.prepareMs,
    },
  }
  const compactFeed = compactFeedMetadata(feedSummary, routingStore)
  const now = new Date().toISOString()
  const project = {
    schemaVersion: 'vigo.project.v1',
    id: projectId,
    name: argValue('name', existingProject?.name || projectId),
    region: argValue('region', existingProject?.region || ''),
    createdAt: existingProject?.createdAt || now,
    updatedAt: now,
    storagePath: projectRoot,
    summary: projectSummary([compactFeed]),
    feeds: [compactFeed],
    jobs: [],
    artifacts: [],
    routingStore,
    osmStreetIndex: {
      schemaVersion: streetResult.schemaVersion,
      status: 'ready',
      sourceModel: streetResult.sourceModel,
      fileName: streetResult.sourceFile,
      sourceBytes: streetResult.sourceBytes,
      sourceFingerprint: streetResult.sourceFingerprint,
      bytes: streetResult.bytes,
      storageLayout: streetResult.storageLayout,
      driveSnapshot: streetResult.driveSnapshot,
      nodeCount: streetResult.nodeCount,
      walkNodeCount: streetResult.walkNodeCount,
      edgeCount: streetResult.edgeCount,
      wayCount: streetResult.wayCount,
      driveNodeCount: streetResult.driveNodeCount,
      driveEdgeCount: streetResult.driveEdgeCount,
      driveWayCount: streetResult.driveWayCount,
      drivingWeightModel: streetResult.drivingWeightModel,
      directionRestrictedWayCount: streetResult.directionRestrictedWayCount,
      directionExcludedWayCount: streetResult.directionExcludedWayCount,
      uncertainConveyingWayCount: streetResult.uncertainConveyingWayCount,
      cch: streetCch,
      builtAt: streetResult.builtAt,
    },
  }
  const manifest = {
    schemaVersion: 'vigo.project.raw_rebuild.v3',
    rebuildId,
    projectId,
    builtAt: now,
    inputs: inputRecords,
    routingStore,
    osmStreetIndex: project.osmStreetIndex,
    coldPreprocessing: {
      timingBoundary: 'Wall time begins immediately after acquiring the rebuild lock, includes staging, sequential-by-default or explicitly requested memory-gated parallel GTFS and OSM compilation, exact street CCH construction, stop-transfer preparation, and persisted native coordinate-access construction, and ends after generated stores pass integrity, feature, and topology validation; atomic publication and console serialization are excluded.',
      phaseWallMs,
      rawCompilerConcurrency: {
        requestedParallelRawBuild,
        gtfsAndOsmParallel: parallelRawBuild,
        parallelFallback: requestedParallelRawBuild && !parallelRawBuild ? 'memory_or_load_guard' : null,
        estimatedPeakWorkingBytes: parallelRawBuildEstimatedBytes,
        hostMemoryGuardBytes: parallelRawBuildMemoryGuardBytes,
        freeMemoryAtBuildStartBytes,
        freeMemoryGuardBytes: parallelRawBuildFreeMemoryGuardBytes,
        loadAverageAtBuildStart,
        loadAverageGuard: Math.max(1, os.cpus().length * 2),
        loadAverageGuardPassed: parallelRawBuildLoadGuard,
        osmInputMultiplier: rawOsmParallelWorkingSetMultiplier,
        gtfsInputMultiplier: rawGtfsParallelWorkingSetMultiplier,
        fixedWorkingSetBytes: rawParallelFixedWorkingSetBytes,
      },
      totalToValidatedStoresMs: Number((performance.now() - preprocessingStarted).toFixed(3)),
      memorySampling: {
        intervalMs: memorySampleIntervalMs,
        peakResidentBytesSampled,
        scope: 'VIGO rebuild Node process including its OSM Worker thread; filesystem cache state is not inferred.',
      },
      hostAtStart: coldHostAtStart,
      hostAtEnd: {
        capturedAt: new Date().toISOString(),
        loadAverage: os.loadavg(),
        freeMemoryBytes: os.freemem(),
      },
    },
  }
  await Promise.all([
    atomicWriteJson(path.join(metadataRoot, 'project.json'), project),
    atomicWriteJson(path.join(metadataRoot, 'rebuild-manifest.json'), manifest),
    writeVisibleProjectFiles(stagingRoot, project),
  ])

  if (!fs.existsSync(nationalStaticTopologySidecarPath(routingPath))) {
    throw new Error(`Rebuilt routing store is missing ${nationalStaticTopologySidecarPath(routingPath)}`)
  }
  // Windows cannot publish a directory while the compiler still holds SQLite
  // connections inside it. All preparation and validation are complete here.
  disposeAllNationalGtfsStores()
  disposeNationalOsmStore(streetPath)
  if (fs.existsSync(projectRoot)) {
    await fsp.rename(projectRoot, backupRoot)
    oldProjectMoved = true
  }
  await fsp.rename(stagingRoot, projectRoot)
  published = true
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)

  if (!keepBackup && oldProjectMoved) {
    try {
      await fsp.rm(backupRoot, { recursive: true, force: true })
      oldProjectMoved = false
    } catch (error) {
      process.stderr.write(
        `Published the new project, but could not remove the old backup at ${backupRoot}: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
} catch (error) {
  if (rawOsmBuild) {
    await rawOsmBuild.worker.terminate().catch(() => {})
    rawOsmBuild = null
  }
  disposeAllNationalGtfsStores()
  disposeNationalOsmStore(streetPath)
  if (published) {
    await fsp.rm(projectRoot, { recursive: true, force: true }).catch(() => {})
    published = false
  }
  if (oldProjectMoved && fs.existsSync(backupRoot)) {
    await fsp.rename(backupRoot, projectRoot).catch(() => {})
    oldProjectMoved = false
  }
  await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  throw error
} finally {
  if (rawOsmBuild) await rawOsmBuild.worker.terminate().catch(() => {})
  clearInterval(memorySampler)
  await lock.close().catch(() => {})
  await fsp.rm(lockPath, { force: true }).catch(() => {})
}
