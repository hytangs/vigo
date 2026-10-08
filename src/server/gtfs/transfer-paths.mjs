import { compileNativeTransferPaths } from '../native-routing-kernel.mjs'

// Keep original source edges for endpoint access and physical evidence. Only
// the service projection receives shortcuts; materialization expands them back
// to these same directed edges, including their individual walking times.
export function prepareServiceTransfers(store) {
  const ids = [...store.stopRecords.keys()], index = new Map(ids.map((id, i) => [id, i]))
  const edges = [...store.transfers.values()].flat()
  const forbidden = [...store.forbiddenTransferPairs].map(pair => pair.split('\0'))
    .filter(([a, b]) => index.has(a) && index.has(b))
  const paths = compileNativeTransferPaths({
    eligible: Uint8Array.from(ids, id => store.stopAccessIndex.directServiceStopIds.has(id) ? 1 : 0),
    from: Uint32Array.from(edges, e => index.get(e.from_stop_id)),
    to: Uint32Array.from(edges, e => index.get(e.to_stop_id)),
    seconds: Uint32Array.from(edges, e => e.min_transfer_time),
    pathway: Uint8Array.from(edges, e => ['gtfs_pathway', 'gtfs_pathway_estimated', 'schedule_pathway'].includes(e.provenance) ? 1 : 0),
    forbiddenFrom: Uint32Array.from(forbidden, ([a]) => index.get(a)),
    forbiddenTo: Uint32Array.from(forbidden, ([, b]) => index.get(b)),
  })
  // Only shortcuts are persisted; ordinary transfer rows remain shared.
  const shortcuts = new Map()
  for (let i = 0; i < paths.from.length; i++) {
    const from = ids[paths.from[i]], to = ids[paths.to[i]]
    const direct = store.transfers.get(from)?.find(e => e.to_stop_id === to)
    const minimum = store.transferMinimums?.get(from)?.find(e => e.to_stop_id === to)?.min_transfer_time
      ?? direct?.parentStationMinimumSeconds
      ?? (['gtfs_transfer', 'schedule_transfer'].includes(direct?.provenance) ? direct.min_transfer_time : 0)
    const seconds = Math.max(paths.seconds[i], Math.trunc(minimum || 0))
    if (direct && Math.trunc(direct.min_transfer_time) <= seconds) continue
    const steps = Array.from(paths.pathEdges.subarray(paths.pathOffsets[i], paths.pathOffsets[i + 1]), edge => ({
      from_stop_id: edges[edge].from_stop_id, to_stop_id: edges[edge].to_stop_id,
      min_transfer_time: Math.trunc(edges[edge].min_transfer_time),
    }))
    steps[steps.length - 1].min_transfer_time += seconds - paths.seconds[i]
    const rows = shortcuts.get(from) ?? []
    rows.push({ from_stop_id: from, to_stop_id: to, min_transfer_time: seconds, steps })
    shortcuts.set(from, rows)
  }
  return shortcuts
}

export function* serviceTransferRows(store) {
  for (const [from, edges] of store.transfers) {
    const shortcuts = store.transferShortcuts?.get(from)
    yield [from, shortcuts ? edges.concat(shortcuts) : edges]
  }
  for (const [from, edges] of store.transferShortcuts ?? []) if (!store.transfers.has(from)) yield [from, edges]
}

export function expandTransferSteps(store, chain) {
  return chain.flatMap(step => {
    if (step.kind !== 'transfer') return [step]
    const shortcut = store.transferShortcuts?.get(step.fromStopId)?.find(e => e.to_stop_id === step.toStopId
      && e.min_transfer_time === step.duration)
    if (!shortcut) return [step]
    let arrival = step.arrival - step.duration
    return shortcut.steps.map(edge => ({ ...step, fromStopId: edge.from_stop_id, toStopId: edge.to_stop_id,
      duration: edge.min_transfer_time, arrival: arrival += edge.min_transfer_time }))
  })
}
