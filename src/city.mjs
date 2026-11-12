import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readNationalGtfsStoreMetadata, inspectNationalStaticTopologySidecar } from './server/national-gtfs-store.mjs'
import { readNationalOsmStoreMetadata } from './server/national-osm-store.mjs'

// The engine's `vigo build` publishes Cities. A query opening a City finishes
// what a crashed publication left: working directories beside a City name
// their owner, so a later run can tell abandoned work from a live build,
// including one on another host sharing the disk.
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

function syncDirectory(directory) {
  // Windows has no flushable directory handle.
  if (process.platform !== 'win32') flush(directory, 'r')
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
