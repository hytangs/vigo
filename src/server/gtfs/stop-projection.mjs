// Neither a retired street record nor a retired timetable should be retained
// by a projection. Only the current access profile of each pair is reusable.
const projections = new WeakMap()

export function projectAccessProfileToTimetable(record, kernel) {
  let byRecord = projections.get(kernel)
  if (!byRecord) {
    byRecord = new WeakMap()
    projections.set(kernel, byRecord)
  }
  const cached = byRecord.get(record)
  if (cached?.profileKey === record.profileKey) return cached.projection
  const projection = new Uint32Array(record.profileMembers.length)
  projection.fill(0xffff_ffff)
  for (let member = 0; member < record.profileMembers.length; member += 1) {
    const stop = kernel.stopIndex.get(record.profileMembers[member].stop_id)
    if (stop !== undefined) projection[member] = stop
  }
  byRecord.set(record, { profileKey: record.profileKey, projection })
  return projection
}
