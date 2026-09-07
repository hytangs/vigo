import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  buildNationalOsmStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  nationalOsmStoreDiagnostics,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import {
  ensureNationalGtfsOsmStopTransfers,
  readNationalGtfsStoreMetadata,
} from '../src/server/national-gtfs-store.mjs'
import {
  buildNativeStreetCchIndex,
  normalizeNativeMilliseconds,
} from '../src/server/native-routing-kernel.mjs'
import { atomicWriteJson } from './lib/atomic-json.mjs'
import { argValue } from './lib/cli-args.mjs'
import { readProjectRoutingIdentity } from './lib/project-routing-store.mjs'

let lastProgressPhase = ''
let lastProgressPercent = -1
function progress(update) {
  const percent = Math.round(Number(update.progress ?? 0) * 100)
  if (update.phase === lastProgressPhase && percent === lastProgressPercent && percent < 100) return
  lastProgressPhase = update.phase
  lastProgressPercent = percent
  process.stdout.write(`[street-rebuild] ${percent}% ${update.phase}${update.detail ? ` / ${update.detail}` : ''}\n`)
}

function compactCch(result) {
  return {
    ready: result.loaded?.ready === true || Number(result.loaded?.cchArcCount ?? 0) > 0,
    format: result.format,
    orderStrategy: result.orderStrategy ?? 'inertial',
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount,
    cchArcCount: result.cchArcCount,
    distanceUnitsPerMeter: result.loaded?.distanceUnitsPerMeter ?? result.distanceUnitsPerMeter,
    orderMs: normalizeNativeMilliseconds(result.orderNs),
    buildMs: normalizeNativeMilliseconds(result.structureNs),
    customizeMs: normalizeNativeMilliseconds(result.customizationNs),
    persistMs: normalizeNativeMilliseconds(result.persistenceNs),
    structureFile: path.basename(result.structurePath),
    metricFile: path.basename(result.metricPath),
  }
}

function projectStreetMetadata(result, pbfPath, cch) {
  return {
    schemaVersion: result.schemaVersion,
    status: 'ready',
    fileName: path.basename(pbfPath),
    sourceModel: result.sourceModel,
    sourceBytes: result.sourceBytes,
    sourceFingerprint: result.sourceFingerprint,
    bytes: result.bytes,
    storageLayout: result.storageLayout,
    runtimeCompaction: result.runtimeCompaction,
    nodeCount: result.nodeCount,
    walkNodeCount: result.walkNodeCount,
    edgeCount: result.edgeCount,
    wayCount: result.wayCount,
    driveNodeCount: result.driveNodeCount,
    driveEdgeCount: result.driveEdgeCount,
    driveWayCount: result.driveWayCount,
    drivingWeightModel: result.drivingWeightModel,
    walkAccelerator: result.walkAccelerator,
    driveAccelerator: result.driveAccelerator,
    driveSnapshot: result.driveSnapshot,
    directionRestrictedWayCount: result.directionRestrictedWayCount,
    directionExcludedWayCount: result.directionExcludedWayCount,
    uncertainConveyingWayCount: result.uncertainConveyingWayCount,
    cch,
    builtAt: result.builtAt,
  }
}

const projectId = argValue('project')
const pbfArgument = argValue('osm')
if (!projectId) throw new Error('--project=<project-id> is required.')
if (!pbfArgument) throw new Error('--osm=/absolute/path/source.osm.pbf is required.')

const pbfPath = path.resolve(pbfArgument)
const pbfStats = await fsp.stat(pbfPath).catch(() => null)
if (!pbfStats?.isFile()) throw new Error(`OSM PBF source is missing: ${pbfPath}`)

const identity = readProjectRoutingIdentity(projectId)
const project = identity.project
const osmDirectory = path.dirname(identity.streetStorePath)
const rebuildId = new Date().toISOString().replace(/[:.]/gu, '-')
const stagingDirectory = `${osmDirectory}.rebuild-${rebuildId}`
const backupDirectory = `${osmDirectory}.pre-${rebuildId}`
const failedDirectory = `${osmDirectory}.failed-${rebuildId}`
const stagingStreetPath = path.join(stagingDirectory, 'street-index.sqlite')
const manifestPath = path.join(identity.projectRoot, '.vigo', `street-rebuild-${rebuildId}.json`)
const startedAt = performance.now()
let published = false

await fsp.mkdir(stagingDirectory, { recursive: true })
try {
  const streetResult = await buildNationalOsmStore({
    pbfPath,
    outputPath: stagingStreetPath,
    onProgress: progress,
  })
  const diagnostics = nationalOsmStoreDiagnostics(stagingStreetPath)
  if (diagnostics.storeAdmission?.schemaVersion !== 'vigo.street.store.v4') {
    throw new Error(
      `Rebuilt street store has unexpected schema ${diagnostics.storeAdmission?.schemaVersion}.`,
    )
  }
  if (diagnostics.sourceFingerprint !== streetResult.sourceFingerprint) {
    throw new Error('Rebuilt street-store source fingerprint changed during validation.')
  }
  const runtimeCompaction = compactNationalOsmRuntimeStore(stagingStreetPath, { requireDrive: true })
  const sealedDiagnostics = nationalOsmStoreDiagnostics(stagingStreetPath)
  if (sealedDiagnostics.storeAdmission?.storageLayout !== 'runtime-snapshots-v1') {
    throw new Error('Rebuilt street store was not sealed into the runtime snapshot layout.')
  }
  const native = prepareNationalOsmNativeStore(stagingStreetPath)
  if (!native.ready) throw new Error(`Native street snapshot is unavailable: ${native.error ?? native.reason}`)
  progress({ phase: 'Building CCH street index', progress: 0.99 })
  const cchResult = buildNativeStreetCchIndex(stagingStreetPath)
  const cch = compactCch(cchResult)
  if (!cch.ready) throw new Error('CCH street index did not load after it was built.')
  const sealedStreetResult = {
    ...streetResult,
    bytes: runtimeCompaction.afterBytes,
    storageLayout: runtimeCompaction.storageLayout,
    runtimeCompaction,
    driveSnapshot: runtimeCompaction.drive,
  }
  disposeNationalOsmStore(stagingStreetPath)

  disposeNationalOsmStore(identity.streetStorePath)
  await fsp.rename(osmDirectory, backupDirectory)
  try {
    await fsp.rename(stagingDirectory, osmDirectory)
    published = true
    progress({ phase: 'Refreshing graph-certified GTFS transfers', progress: 0.995 })
    const osmStopTransfers = await ensureNationalGtfsOsmStopTransfers(
      identity.storePath,
      identity.streetStorePath,
      { onProgress: progress },
    )
    const routingMetadata = readNationalGtfsStoreMetadata(identity.storePath)
    const routingStats = fs.statSync(identity.storePath)
    const routingStore = {
      ...project.routingStore,
      bytes: routingStats.size,
      sourceFingerprint: routingMetadata.sourceFingerprint,
      osmStopTransfers: {
        schemaVersion: osmStopTransfers.schemaVersion,
        fingerprint: osmStopTransfers.fingerprint,
        built: osmStopTransfers.built,
        edgeCount: osmStopTransfers.edgeCount,
        maximumWalkM: osmStopTransfers.maximumWalkM,
        maximumNeighbors: osmStopTransfers.maximumNeighbors,
      },
    }
    const feeds = (project.feeds ?? []).map((feed) => {
      if (path.basename(feed.routingStore?.fileName ?? '') !== path.basename(identity.storePath)) return feed
      const feedRoutingStore = { ...feed.routingStore, ...routingStore }
      return { ...feed, routingStore: feedRoutingStore }
    })
    const updatedProject = {
      ...project,
      updatedAt: new Date().toISOString(),
      routingStore,
      feeds,
      osmStreetIndex: projectStreetMetadata(
        sealedStreetResult,
        pbfPath,
        cch,
      ),
    }
    await atomicWriteJson(identity.metadataPath, updatedProject)
    const manifest = {
      schemaVersion: 'vigo.project.street-rebuild.v1',
      rebuildId,
      builtAt: updatedProject.updatedAt,
      projectId,
      source: {
        path: pbfPath,
        bytes: pbfStats.size,
        sourceFingerprint: sealedStreetResult.sourceFingerprint,
      },
      previousStreetStore: project.osmStreetIndex,
      streetStore: updatedProject.osmStreetIndex,
      runtimeCompaction,
      osmStopTransfers: routingStore.osmStopTransfers,
      backupDirectory,
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    }
    await atomicWriteJson(manifestPath, manifest)
    console.log(JSON.stringify({
      projectId,
      projectRoot: identity.projectRoot,
      streetStorePath: identity.streetStorePath,
      backupDirectory,
      manifestPath,
      schemaVersion: sealedStreetResult.schemaVersion,
      sourceFingerprint: sealedStreetResult.sourceFingerprint,
      storageLayout: sealedStreetResult.storageLayout,
      bytes: sealedStreetResult.bytes,
      walkNodeCount: sealedStreetResult.walkNodeCount,
      edgeCount: sealedStreetResult.edgeCount,
      runtimeCompaction,
      cch,
      osmStopTransfers: routingStore.osmStopTransfers,
      elapsedMs: manifest.elapsedMs,
    }, null, 2))
  } catch (error) {
    disposeNationalOsmStore(identity.streetStorePath)
    if (published && fs.existsSync(osmDirectory)) await fsp.rename(osmDirectory, failedDirectory)
    if (fs.existsSync(backupDirectory)) await fsp.rename(backupDirectory, osmDirectory)
    throw error
  }
} catch (error) {
  if (!published) await fsp.rm(stagingDirectory, { recursive: true, force: true })
  throw error
}
