import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  buildNativeStreetCchIndex,
  disposeNativeRoutingKernel,
  normalizeNativeMilliseconds,
  prepareNativeRoutingKernel,
} from '../src/server/native-routing-kernel.mjs'
import { readProjectRoutingIdentity } from './lib/project-routing-store.mjs'

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

async function atomicWriteJson(filePath, value) {
  const nextPath = `${filePath}.next`
  await fs.writeFile(nextPath, `${JSON.stringify(value, null, 2)}\n`)
  await fs.rename(nextPath, filePath)
}

const projectId = argValue('project')
if (!projectId) throw new Error('--project=<project-id> is required.')
const force = argValue('force', 'false') === 'true'
const identity = readProjectRoutingIdentity(projectId)
const startedAt = performance.now()
const prepared = prepareNativeRoutingKernel(identity.streetStorePath)
if (!prepared.ready) throw new Error(`Native street kernel is unavailable for ${projectId}.`)
const result = buildNativeStreetCchIndex(identity.streetStorePath, { force })
const loaded = result.loaded ?? result
if (Number(loaded.distanceUnitsPerMeter) !== 10_000) {
  throw new Error(`Unexpected CCH distance scale ${loaded.distanceUnitsPerMeter}.`)
}
const cch = {
  ready: true,
  format: result.format,
  orderStrategy: result.orderStrategy ?? 'inertial',
  nodeCount: Number(result.nodeCount ?? loaded.nodeCount),
  edgeCount: Number(result.edgeCount ?? identity.project.osmStreetIndex?.edgeCount ?? 0),
  cchArcCount: Number(result.cchArcCount ?? loaded.cchArcCount),
  distanceUnitsPerMeter: Number(loaded.distanceUnitsPerMeter),
  structureFile: path.basename(result.structurePath),
  metricFile: path.basename(result.metricPath),
  manifestFile: path.basename(result.manifestPath),
  orderMs: normalizeNativeMilliseconds(result.orderNs),
  buildMs: normalizeNativeMilliseconds(result.structureNs),
  customizeMs: normalizeNativeMilliseconds(result.customizationNs),
  persistMs: normalizeNativeMilliseconds(result.persistenceNs),
}
const updatedAt = new Date().toISOString()
const project = {
  ...identity.project,
  updatedAt,
  osmStreetIndex: {
    ...identity.project.osmStreetIndex,
    cch,
  },
}
await atomicWriteJson(identity.metadataPath, project)
const manifestPath = path.join(
  identity.projectRoot,
  '.vigo',
  `street-cch-${updatedAt.replace(/[:.]/gu, '-')}.json`,
)
await atomicWriteJson(manifestPath, {
  schemaVersion: 'vigo.project.street-cch.v1',
  builtAt: updatedAt,
  projectId,
  streetStorePath: identity.streetStorePath,
  sourceFingerprint: identity.project.osmStreetIndex?.sourceFingerprint ?? null,
  cch,
  built: result.built === true,
  cacheHit: result.cacheHit === true,
  elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
})
disposeNativeRoutingKernel(identity.streetStorePath)
console.log(JSON.stringify({
  projectId,
  metadataPath: identity.metadataPath,
  manifestPath,
  built: result.built === true,
  cacheHit: result.cacheHit === true,
  cch,
  elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
}, null, 2))
