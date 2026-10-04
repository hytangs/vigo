import { validateNativeStationPaths } from './native-routing-kernel.mjs'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from './routing-snapshot.mjs'

const schemaVersion = 'vigo.routing.access-context.v1'
const maximumBytes = 512 * 1024 * 1024
const mapFields = ['transfers', 'stationMembers', 'stopRecords']
const indexMaps = ['cells', 'profilesByStop', 'directProfilesByStop']
const indexSets = ['directServiceStopIds', 'departureServiceStopIds', 'arrivalServiceStopIds']

export function loadPreparedAccessContext(store, accessPolicyIdentity) {
  const snapshotPath = `${store.storePath}.access-context.bin`
  try {
    const stat = fs.statSync(snapshotPath)
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Prepared access context exceeds its size limit.')
    const { metadata, arrays } = decodeRoutingSnapshot(fs.readFileSync(snapshotPath))
    if (metadata.schemaVersion !== schemaVersion
      || metadata.sourceArtifactIdentity !== store.sourceArtifactIdentity
      || metadata.accessPolicyIdentity !== accessPolicyIdentity) throw new Error('Prepared access context is stale.')
    const saved = metadata.materialized
    const value = {
      rawTransferCount: saved.rawTransferCount,
      rawForbiddenTransferCount: saved.rawForbiddenTransferCount,
      resolvedTransferCount: saved.resolvedTransferCount,
      forbiddenTransferPairs: new Set(saved.forbiddenTransferPairs),
      declaredPathwayStops: new Set(saved.declaredPathwayStops),
      stopAccessIndex: saved.stopAccessIndex,
    }
    for (const name of mapFields) value[name] = new Map(saved[name])
    const index = value.stopAccessIndex
    for (const name of indexMaps) index[name] = new Map(index[name])
    for (const name of indexSets) index[name] = new Set(index[name])
    if (value.stopRecords.size !== Number(store.metadata.stopCount) || index.ready !== true
      || index.anchorCount !== index.anchors.length || index.cellCount !== index.cells.size) {
      throw new Error('Prepared access context dimensions are invalid.')
    }
    index.buildMs = 0
    index.queryCount = 0
    index.queryMs = 0
    const stationPaths = metadata.stationPaths ? { ...metadata.stationPaths, ...arrays } : null
    if (stationPaths) validateStationPaths(stationPaths)
    return { materialized: value, stationPaths, persistenceState: 'loaded', snapshotPath }
  } catch (error) {
    return { persistenceState: error.code === 'ENOENT' ? 'not_found' : 'rejected', snapshotPath,
      ...(error.code === 'ENOENT' ? {} : { persistenceError: error.message }) }
  }
}

export function persistPreparedAccessContext(store, accessPolicyIdentity) {
  const snapshotPath = `${store.storePath}.access-context.bin`
  const temporaryPath = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const materialized = Object.fromEntries(mapFields.map(name => [name, [...store[name]]]))
    Object.assign(materialized, {
      forbiddenTransferPairs: [...store.forbiddenTransferPairs],
      declaredPathwayStops: [...(store.declaredPathwayStops ?? [])],
      rawTransferCount: store.rawTransferCount,
      rawForbiddenTransferCount: store.rawForbiddenTransferCount,
      resolvedTransferCount: store.resolvedTransferCount,
      stopAccessIndex: { ...store.stopAccessIndex },
    })
    for (const name of indexMaps) materialized.stopAccessIndex[name] = [...store.stopAccessIndex[name]]
    for (const name of indexSets) materialized.stopAccessIndex[name] = [...store.stopAccessIndex[name]]
    const { stopIds, sources, ...arrays } = store.preparedStationPaths ?? {}
    const bytes = encodeRoutingSnapshot({ schemaVersion, sourceArtifactIdentity: store.sourceArtifactIdentity,
      accessPolicyIdentity, materialized, stationPaths: stopIds ? { stopIds, sources } : null }, arrays)
    if (bytes.length > maximumBytes) throw new Error('Prepared access context exceeds its size limit.')
    fs.writeFileSync(temporaryPath, bytes, { mode: 0o600 })
    fs.renameSync(temporaryPath, snapshotPath)
    return { persistenceState: 'written', snapshotPath, snapshotBytes: bytes.length }
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }) } catch {}
    return { persistenceState: 'write_error', snapshotPath, persistenceError: error.message }
  }
}

function validateStationPaths(paths) {
  const { stopIds, sources } = paths
  if (!Array.isArray(stopIds) || !stopIds.every(id => typeof id === 'string')
    || !Array.isArray(sources) || !sources.every(source => typeof source === 'string')) {
    throw new Error('Prepared station paths have invalid identities.')
  }
  validateNativeStationPaths({ ...paths, stopCount: stopIds.length, sourceCount: sources.length })
}

export function stationPathLookup(paths, stops, transfers) {
  return { get(key) {
    const [from, to, seconds] = key.split(':').map(Number)
    if (!Number.isInteger(from) || from < 0 || from >= stops.length) return undefined
    for (let i = paths.offsets[from]; i < paths.offsets[from + 1]; i += 1) {
      if (paths.to[i] !== to || paths.seconds[i] !== seconds) continue
      const start = paths.pathOffsets[i], end = paths.pathOffsets[i + 1]
      const members = Array.from(paths.pathStops.subarray(start, end), index => stops[index])
      const distanceIncomplete = transfers && members.slice(1).some((to, j) => {
        const from = members[j]
        return ![from.lon, from.lat, to.lon, to.lat].every(Number.isFinite)
          && transfers.get(from.stop_id)?.find(edge => edge.to_stop_id === to.stop_id)?.path_distance_m == null
      })
      return {
        ...(distanceIncomplete ? { distanceIncomplete: true } : {}),
        stopIds: Array.from(paths.pathStops.subarray(start, end), index => stops[index].stop_id),
        coordinates: Array.from(paths.pathStops.subarray(start, end), index => [stops[index].lon, stops[index].lat]),
        ...(Array.from(paths.pathStops.subarray(start, end)).some(index => !Number.isFinite(stops[index].lon) || !Number.isFinite(stops[index].lat))
          ? { geometryIncomplete: true } : {}),
        sources: Array.from(paths.pathSources.subarray(start - i, end - i - 1), index => paths.sources[index]),
      }
    }
    return undefined
  } }
}
