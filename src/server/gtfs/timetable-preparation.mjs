import { prepareNativeTimetableIndexes } from '../native-routing-kernel.mjs'
import { numeric } from '../number-utils.mjs'
import { walkingSpeedKph } from './routing-policy.mjs'

// Resolve source identities here; native preparation owns ordering, transfer
// deduplication, station expansion, and packing. No JS algorithm fallback.
export function prepareTimetableIndexes(store, stopIds, stopIndex, retainedStops, departures) {
  const coordinates = new Float64Array(stopIds.length * 2)
  for (let i = 0; i < stopIds.length; i++) {
    const stop = store.stopRecords.get(stopIds[i])
    coordinates[i * 2] = Number(stop?.lon)
    coordinates[i * 2 + 1] = Number(stop?.lat)
  }
  let count = 0
  for (const edges of store.transfers.values()) count += edges.length
  const transferFrom = new Uint32Array(count), transferTo = new Uint32Array(count)
  const transferSeconds = new Float64Array(count)
  let index = 0
  for (const [from, edges] of store.transfers) for (const edge of edges) {
    // Unknown IDs cannot be represented in the native forbidden-pair set.
    if (store.forbiddenTransferPairs.has(`${from}\u0000${edge.to_stop_id}`)) continue
    transferFrom[index] = stopIndex.get(from) ?? 0xffffffff
    transferTo[index] = stopIndex.get(edge.to_stop_id) ?? 0xffffffff
    transferSeconds[index++] = numeric(edge.min_transfer_time, 0)
  }
  const forbiddenFrom = [], forbiddenTo = []
  for (const pair of store.forbiddenTransferPairs) {
    const separator = pair.indexOf('\u0000')
    const from = stopIndex.get(pair.slice(0, separator)), to = stopIndex.get(pair.slice(separator + 1))
    if (from !== undefined && to !== undefined) { forbiddenFrom.push(from); forbiddenTo.push(to) }
  }
  const stationOffset = [0], stationMembers = []
  for (const ids of store.stationMembers.values()) {
    for (const id of ids) {
      const stop = stopIndex.get(id)
      if (stop !== undefined) stationMembers.push(stop)
    }
    stationOffset.push(stationMembers.length)
  }
  return prepareNativeTimetableIndexes({
    ...departures, retainedStops, coordinates, walkingSpeedKph,
    transferFrom: transferFrom.subarray(0, index), transferTo: transferTo.subarray(0, index),
    transferSeconds: transferSeconds.subarray(0, index),
    forbiddenFrom: Uint32Array.from(forbiddenFrom), forbiddenTo: Uint32Array.from(forbiddenTo),
    stationOffset: Uint32Array.from(stationOffset), stationMembers: Uint32Array.from(stationMembers),
  })
}
