const stationGroups = new WeakMap()
const stationOnlyKernels = new WeakMap()
const selectedKernels = new WeakMap()

export function validateTransferSelection(request) {
  if (request.allowStreetTransfers !== undefined && typeof request.allowStreetTransfers !== 'boolean') {
    throw new Error('allowStreetTransfers must be a boolean.')
  }
  if (request.minimumTransferBufferMinutes !== undefined
    && (!Number.isInteger(request.minimumTransferBufferMinutes)
      || request.minimumTransferBufferMinutes < 0 || request.minimumTransferBufferMinutes > 60)) {
    throw new Error('minimumTransferBufferMinutes must be an integer from 0 to 60.')
  }
}

// This is a choice about walking between separate stops/stations, not a
// certificate of station-interior connectivity or fare-transfer eligibility.
// Keep the source kernel immutable so changing the choice cannot leak into
// another request, realtime view, or persisted timetable snapshot.
export function timetableForTransferSelection(store, kernel, request) {
  if (!kernel) return kernel
  const allowStreetTransfers = request.allowStreetTransfers !== false
  const minimumTransferBufferSeconds = (request.minimumTransferBufferMinutes ?? 0) * 60
  if (allowStreetTransfers && minimumTransferBufferSeconds === 0) return kernel
  let views = selectedKernels.get(kernel)
  if (!views) {
    views = new Map()
    selectedKernels.set(kernel, views)
  }
  const key = `${allowStreetTransfers}:${minimumTransferBufferSeconds}`
  const retained = views.get(key)
  if (retained) {
    views.delete(key)
    views.set(key, retained)
    return retained
  }
  const walking = allowStreetTransfers ? kernel : stationOnlyTimetable(store, kernel)
  const selected = walking === kernel && minimumTransferBufferSeconds === 0 ? kernel
    : { ...walking, allowStreetTransfers, minimumTransferBufferSeconds }
  if (selected !== kernel) clearNativeIndexes(selected)
  // Keep selection changes from retaining an unbounded number of native
  // indexes. Timetable source arrays remain shared across these immutable views.
  if (views.size >= 4) views.delete(views.keys().next().value)
  views.set(key, selected)
  return selected
}

function clearNativeIndexes(kernel) {
  for (const field of ['nativeTimetableKernel', 'sourceTypedArrayBytes', 'nativeIndexBytes',
    'nativeWorkspaceBytes', 'typedArrayBytes', 'estimatedBytes']) delete kernel[field]
}

function stationOnlyTimetable(store, kernel) {
  if (kernel.allowStreetTransfers === false) return kernel
  const retained = stationOnlyKernels.get(kernel)
  if (retained) return retained
  let groups = stationGroups.get(store)
  if (!groups) {
    const parents = new Map(Array.from(
      store.db.prepare('SELECT stop_id, parent_station FROM stops').iterate(),
      row => [row.stop_id, String(row.parent_station ?? '').trim()],
    ))
    groups = new Map()
    for (const id of parents.keys()) {
      let group = id
      const visited = new Set([id])
      while (parents.get(group) && !visited.has(parents.get(group))) {
        group = parents.get(group)
        visited.add(group)
      }
      groups.set(id, group)
    }
    stationGroups.set(store, groups)
  }
  const keys = kernel.stopIds.map(id => groups.get(id) ?? id)
  const offsets = new Uint32Array(kernel.stopIds.length + 1)
  for (let from = 0; from < keys.length; from++) {
    let count = 0
    for (let edge = kernel.transferOffset[from]; edge < kernel.transferOffset[from + 1]; edge++) {
      if (keys[from] === keys[kernel.transferTo[edge]]) count++
    }
    offsets[from + 1] = offsets[from] + count
  }
  if (offsets.at(-1) === kernel.transferTo.length) {
    stationOnlyKernels.set(kernel, kernel)
    return kernel
  }
  const to = new Uint32Array(offsets.at(-1))
  const duration = new Uint32Array(to.length)
  let index = 0
  for (let from = 0; from < keys.length; from++) {
    for (let edge = kernel.transferOffset[from]; edge < kernel.transferOffset[from + 1]; edge++) {
      if (keys[from] !== keys[kernel.transferTo[edge]]) continue
      to[index] = kernel.transferTo[edge]
      duration[index++] = kernel.transferDuration[edge]
    }
  }
  const selected = { ...kernel, transferOffset: offsets, transferTo: to,
    transferDuration: duration, transferCount: to.length, allowStreetTransfers: false }
  clearNativeIndexes(selected)
  stationOnlyKernels.set(kernel, selected)
  return selected
}
