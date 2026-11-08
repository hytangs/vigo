import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readNationalGtfsStoreMetadata, inspectNationalStaticTopologySidecar } from './server/national-gtfs-store.mjs'
import { readNationalOsmStoreMetadata } from './server/national-osm-store.mjs'

// Working directories beside a City name their owner, so a later run can tell
// abandoned work from a live build, including one on another host sharing the disk.
const hostTag = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8)

function uniqueSibling(directory, role) {
  const parent = path.dirname(directory)
  const name = path.basename(directory)
  return path.join(parent, `.${name}.vigo-${role}-${hostTag}-${process.pid}-${Date.now()}`)
}

// Some network and FUSE filesystems cannot flush a given handle. Real write
// failures still throw.
const unsupportedFlush = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])

function flush(target, flags) {
  const handle = fs.openSync(target, flags)
  try {
    fs.fsyncSync(handle)
  } catch (error) {
    if (!unsupportedFlush.has(error.code)) throw error
  } finally {
    fs.closeSync(handle)
  }
}

export function syncDirectory(directory) {
  // Windows has no flushable directory handle.
  if (process.platform !== 'win32') flush(directory, 'r')
}

// City stores are written with synchronous=OFF. Flushing the finished tree before
// the publishing rename stops a power loss from exposing a City with missing data.
export function syncDirectoryTree(directory, flushed = new Set()) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) syncDirectoryTree(entryPath, flushed)
    else if (entry.isFile()) {
      const { dev, ino } = fs.statSync(entryPath, { bigint: true })
      const identity = `${dev}:${ino}` // Hard-linked street files need one flush.
      if (flushed.has(identity)) continue
      flushed.add(identity)
      flush(entryPath, process.platform === 'win32' ? 'r+' : 'r')
    }
  }
  syncDirectory(directory)
}

export function createCityStagingDirectory(outputDirectory) {
  const resolved = path.resolve(outputDirectory)
  const parent = path.dirname(resolved)
  const firstCreated = fs.mkdirSync(parent, { recursive: true })
  if (firstCreated) {
    for (let directory = parent; directory.startsWith(firstCreated); directory = path.dirname(directory)) syncDirectory(directory)
    syncDirectory(path.dirname(firstCreated))
  }
  const stagingDirectory = uniqueSibling(resolved, 'building')
  fs.mkdirSync(stagingDirectory, { recursive: false })
  return stagingDirectory
}

export function validateCityDirectory(directory) {
  const resolved = path.resolve(directory)
  for (const relativePath of [
    'network.json',
    path.join('routing', 'project.sqlite'),
    path.join('osm', 'street-index.sqlite'),
  ]) {
    const artifact = path.join(resolved, relativePath)
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      throw new Error(`The City is incomplete: ${relativePath} is missing.`)
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'network.json'), 'utf8'))
  if (manifest?.schemaVersion !== 'vigo.city.v1') {
    throw new Error(`Unsupported City format ${JSON.stringify(manifest?.schemaVersion)}; expected vigo.city.v1. Rebuild from the original GTFS and OSM into a new directory.`)
  }
  const routingPath = path.join(resolved, 'routing', 'project.sqlite')
  const routing = readNationalGtfsStoreMetadata(routingPath)
  const topology = inspectNationalStaticTopologySidecar(routingPath)
  if (!topology.ready) throw new Error(`The City routing topology must be rebuilt: ${topology.reason}.`)
  const street = readNationalOsmStoreMetadata(path.join(resolved, 'osm', 'street-index.sqlite'))
  const profiles = [manifest, routing, street].map(value => value.accessibility?.profile ?? null)
  if (new Set(profiles).size !== 1 || (profiles[0] !== null && profiles[0] !== 'wheelchair-strict-v1')) {
    throw new Error('City accessibility profiles do not match; rebuild the complete City.')
  }
  if (street.storageLayout !== 'runtime-snapshots-v1') {
    throw new Error('The City street index must be rebuilt into sealed runtime snapshots.')
  }
  return manifest
}

// `previous` always holds a complete City. Renaming it to `removing` first means
// recovery can never restore a copy that is already partly deleted.
function discardPreviousCity(directory, output) {
  try {
    const removing = uniqueSibling(output, 'removing')
    fs.renameSync(directory, removing)
    removeWorkingDirectory(removing)
    return true
  } catch (error) {
    console.warn(`VIGO left an old copy beside ${output}; the next build retries removing it: ${error.message}`)
    return false
  }
}

function removeWorkingDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

function ownerIsGone(host, pid) {
  if (host && host !== hostTag) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function abandonedSiblings(output) {
  const parent = path.dirname(output)
  const prefix = `.${path.basename(output)}.vigo-`
  let names
  try {
    names = fs.readdirSync(parent)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return []
    throw error
  }
  return names.flatMap((name) => {
    if (!name.startsWith(prefix)) return []
    // Older builds wrote these names without a host tag.
    const match = /^(building|previous|removing)-(?:([0-9a-f]{8})-)?(\d+)-(\d+)$/.exec(name.slice(prefix.length))
    if (!match || !ownerIsGone(match[2], Number(match[3]))) return []
    return [{ role: match[1], directory: path.join(parent, name), createdAt: Number(match[4]) }]
  }).sort((a, b) => b.createdAt - a.createdAt)
}

function isValidCity(directory) {
  try {
    validateCityDirectory(directory)
    return true
  } catch {
    return false
  }
}

/**
 * Finishes what a crashed publication left beside `outputDirectory`. A City that
 * lost its path mid-replacement is restored; an old copy is deleted only once a
 * valid City holds the path. Directories owned by a live process are untouched.
 */
export function recoverCityPublication(outputDirectory) {
  const output = path.resolve(outputDirectory)
  const abandoned = abandonedSiblings(output)
  const result = { restored: false, removed: 0, kept: 0 }
  for (const { role, directory } of abandoned) {
    if (role !== 'previous') continue
    if (!fs.existsSync(output)) {
      fs.renameSync(directory, output)
      syncDirectory(path.dirname(output))
      result.restored = true
      console.warn(`VIGO restored ${output} after an interrupted replacement.`)
    } else if (isValidCity(output) && discardPreviousCity(directory, output)) {
      result.removed += 1
    } else {
      result.kept += 1
      console.warn(`VIGO kept an old copy of the City at ${directory} because ${output} is not a valid City.`)
    }
  }
  for (const { role, directory } of abandoned) {
    if (role === 'previous') continue
    try {
      removeWorkingDirectory(directory)
      result.removed += 1
    } catch (error) {
      result.kept += 1
      console.warn(`VIGO could not remove abandoned build files at ${directory}: ${error.message}`)
    }
  }
  return result
}

export function publishCity(stagingDirectory, outputDirectory, { replace = false, durable = true } = {}) {
  const staged = path.resolve(stagingDirectory)
  const output = path.resolve(outputDirectory)
  if (path.dirname(staged) !== path.dirname(output)) {
    throw new Error('The staged and published network directories must share one parent.')
  }
  if (!fs.statSync(staged).isDirectory()) {
    throw new Error('The staged network package is not a directory.')
  }
  validateCityDirectory(staged)
  const existing = fs.existsSync(output)
  if (existing && !replace) {
    throw new Error(`City already exists; pass --replace to replace it: ${output}`)
  }
  if (durable) syncDirectoryTree(staged)

  const backup = uniqueSibling(output, 'previous')
  let previousMoved = false
  try {
    if (existing) {
      fs.renameSync(output, backup)
      previousMoved = true
    }
    fs.renameSync(staged, output)
  } catch (error) {
    if (previousMoved && !fs.existsSync(output) && fs.existsSync(backup)) {
      fs.renameSync(backup, output)
    }
    throw error
  }

  // The old City goes only after the new path is on disk.
  if (durable) syncDirectory(path.dirname(output))
  if (previousMoved) discardPreviousCity(backup, output)
}
