import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import {
  buildNationalOsmStore,
  compactNationalOsmRuntimeStore,
  prepareNationalOsmNativeStore,
} from './national-osm-store.mjs'
import {
  buildNativeStreetCchIndex,
  normalizeNativeMilliseconds,
} from './native-routing-kernel.mjs'

let lastPublishedProgress = 0

function publishProgress(update) {
  const rawProgress = Number(update?.progress ?? 0)
  const publicationPhase = (
    update?.phase === 'Sealing runtime street snapshots'
    || update?.phase === 'Building Rust pedestrian CCH'
  )
  const progress = Math.max(
    lastPublishedProgress,
    publicationPhase
      ? Math.min(0.99, Math.max(0, rawProgress))
      : Math.min(0.96, Math.max(0, rawProgress) * 0.96),
  )
  lastPublishedProgress = progress
  parentPort?.postMessage({
    type: 'progress',
    progress: {
      ...update,
      // The source graph build is followed by publication-only sealing and
      // CCH work. Keep the visible progress monotone across those phases.
      progress,
    },
  })
}

function compactCch(result) {
  const loaded = result.loaded ?? result
  return {
    ready: loaded?.ready === true || Number(loaded?.cchArcCount ?? result?.cchArcCount ?? 0) > 0,
    format: result.format,
    orderStrategy: result.orderStrategy ?? 'inertial',
    nodeCount: Number(result.nodeCount ?? loaded?.nodeCount ?? 0),
    edgeCount: Number(result.edgeCount ?? loaded?.edgeCount ?? 0),
    cchArcCount: Number(result.cchArcCount ?? loaded?.cchArcCount ?? 0),
    distanceUnitsPerMeter: Number(loaded?.distanceUnitsPerMeter ?? result.distanceUnitsPerMeter ?? 0),
    ...(result.structurePath ? { structureFile: path.basename(result.structurePath) } : {}),
    ...(result.metricPath ? { metricFile: path.basename(result.metricPath) } : {}),
    orderMs: normalizeNativeMilliseconds(result.orderNs),
    buildMs: normalizeNativeMilliseconds(result.structureNs),
    customizeMs: normalizeNativeMilliseconds(result.customizationNs),
    persistMs: normalizeNativeMilliseconds(result.persistenceNs),
  }
}

try {
  const result = await buildNationalOsmStore({
    ...workerData,
    // A project street import is an interactive prerequisite for both walk
    // access and route-edit geometry. Persist the compact drive snapshot now
    // so the first route query does not pay the profile-build cost.
    buildDrivingProfile: workerData.buildDrivingProfile !== false,
    onProgress: publishProgress,
  })
  publishProgress({
    phase: 'Sealing runtime street snapshots',
    progress: 0.975,
    detail: 'Removing compiler-only street tables before publication',
  })
  const runtimeCompaction = compactNationalOsmRuntimeStore(workerData.outputPath, { requireDrive: true })
  if (!runtimeCompaction.ready) {
    throw new Error(`The OSM street store could not be sealed: ${runtimeCompaction.reason ?? 'unknown reason'}`)
  }

  const native = prepareNationalOsmNativeStore(workerData.outputPath)
  if (!native.ready || !native.accelerated) {
    throw new Error(`The sealed OSM street snapshot is unavailable: ${native.error ?? native.reason ?? 'unknown reason'}`)
  }
  publishProgress({
    phase: 'Building Rust pedestrian CCH',
    progress: 0.99,
    detail: 'Preparing exact directed walking access for routing',
  })
  const cch = compactCch(buildNativeStreetCchIndex(workerData.outputPath))
  if (!cch.ready) throw new Error('The Rust pedestrian CCH did not load after it was built.')

  parentPort?.postMessage({
    type: 'complete',
    result: {
      ...result,
      bytes: runtimeCompaction.afterBytes,
      storageLayout: runtimeCompaction.storageLayout,
      runtimeCompaction,
      driveSnapshot: runtimeCompaction.drive,
      cch,
    },
  })
} catch (error) {
  parentPort?.postMessage({ type: 'failed', error: error instanceof Error ? error.stack || error.message : String(error) })
}
