import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  publishCchManifest,
  validateCchManifest,
} from '../server/native-routing-kernel.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-cch-manifest-'))
const sourcePath = path.join(directory, 'street.snapshot')
const structurePath = path.join(directory, 'street.structure')
const metricPath = path.join(directory, 'street.metric')
const manifestPath = path.join(directory, 'street.manifest.json')
try {
  await fs.writeFile(sourcePath, 'source snapshot fixture')
  const structure = Buffer.alloc(40)
  structure.writeBigUInt64LE(2n, 16)
  structure.writeBigUInt64LE(3n, 24)
  await fs.writeFile(structurePath, structure)
  await fs.writeFile(metricPath, 'metric fixture')

  publishCchManifest({
    kind: 'street',
    format: 'street-cch-v1-u10000',
    sourcePath,
    manifestPath,
    structurePath,
    metrics: { walk: metricPath },
    edgeCount: 4,
  })
  const manifest = validateCchManifest({
    kind: 'street',
    format: 'street-cch-v1-u10000',
    sourcePath,
    manifestPath,
    structurePath,
    metrics: { walk: metricPath },
    nodeCount: 2,
    edgeCount: 4,
  })
  assert.match(manifest.source.sha256, /^[0-9a-f]{64}$/u)
  assert.equal(manifest.cchArcCount, 3)

  await fs.appendFile(metricPath, 'substitution')
  assert.throws(
    () => validateCchManifest({
      kind: 'street',
      format: 'street-cch-v1-u10000',
      sourcePath,
      manifestPath,
      structurePath,
      metrics: { walk: metricPath },
      nodeCount: 2,
      edgeCount: 4,
    }),
    /digest mismatch/,
  )
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}

console.log('CCH generation manifest and substituted-metric rejection checks passed.')
