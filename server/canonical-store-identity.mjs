import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const metadataIdentityCache = new Map()
const metadataIdentityCacheMaxEntries = 32
const metadataIdentityMaxRows = 512
const metadataIdentityMaxBytes = 2 * 1024 * 1024

function parseMetadataValue(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function storageGeneration(stats) {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].map(String).join(':')
}

function readMetadataIdentity(filePath, kind) {
  const database = new DatabaseSync(filePath, { readOnly: true })
  try {
    const rows = database.prepare(`
      SELECT key, value,
        length(CAST(key AS BLOB)) AS key_bytes,
        length(CAST(value AS BLOB)) AS value_bytes
      FROM metadata
      ORDER BY key
      LIMIT ?
    `).all(metadataIdentityMaxRows + 1)
    if (rows.length > metadataIdentityMaxRows) {
      throw new Error(`${kind} store metadata exceeds ${metadataIdentityMaxRows} rows`)
    }
    const metadataBytes = rows.reduce(
      (total, row) => total + Number(row.key_bytes ?? 0) + Number(row.value_bytes ?? 0),
      0,
    )
    if (metadataBytes > metadataIdentityMaxBytes) {
      throw new Error(`${kind} store metadata exceeds ${metadataIdentityMaxBytes} bytes`)
    }
    const metadata = Object.fromEntries(
      rows.map(({ key, value }) => [String(key), parseMetadataValue(String(value))]),
    )
    const schemaVersion = String(metadata.schemaVersion ?? '')
    const expectedPrefix = kind === 'street'
      ? 'vigo.street.store.'
      : 'vigo.routing.store.'
    if (!schemaVersion.startsWith(expectedPrefix)) {
      throw new Error(
        `${kind} store has ${schemaVersion || 'no schema version'}; expected ${expectedPrefix}*`,
      )
    }
    const contentFingerprint = String(metadata.sourceFingerprint ?? '')
    if (!/^[a-f0-9]{64}$/.test(contentFingerprint)) {
      throw new Error(`${kind} store is missing its canonical SHA-256 source fingerprint`)
    }
    const metadataGeneration = crypto.createHash('sha256')
      .update(JSON.stringify(rows.map(({ key, value }) => [String(key), String(value)])))
      .digest('hex')
    return {
      schemaVersion,
      contentFingerprint,
      metadataGeneration,
    }
  } finally {
    database.close()
  }
}

function retainMetadataIdentity(cacheKey, identity) {
  metadataIdentityCache.delete(cacheKey)
  metadataIdentityCache.set(cacheKey, identity)
  while (metadataIdentityCache.size > metadataIdentityCacheMaxEntries) {
    metadataIdentityCache.delete(metadataIdentityCache.keys().next().value)
  }
}

export async function canonicalStoreArtifactIdentity(filePath, { kind = 'routing' } = {}) {
  if (!['routing', 'street'].includes(kind)) {
    throw new TypeError(`Unsupported canonical store kind: ${kind}`)
  }
  const resolvedPath = path.resolve(filePath)
  const stats = await fs.stat(resolvedPath, { bigint: true })
  if (!stats.isFile()) throw new Error(`Canonical ${kind} store is not a file: ${resolvedPath}`)
  const generation = storageGeneration(stats)
  const cacheKey = `${kind}\u0000${resolvedPath}\u0000${generation}`
  let metadataIdentity = metadataIdentityCache.get(cacheKey)
  if (metadataIdentity) {
    metadataIdentityCache.delete(cacheKey)
    metadataIdentityCache.set(cacheKey, metadataIdentity)
  } else {
    metadataIdentity = readMetadataIdentity(resolvedPath, kind)
    retainMetadataIdentity(cacheKey, metadataIdentity)
  }
  return {
    path: resolvedPath,
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    storageGeneration: generation,
    ...metadataIdentity,
  }
}
