// A platform with boarding areas is a service endpoint, never an indoor
// walking junction. Rust stops expansion through these logical endpoints.
export function boardingAreaLinks(stopRecords) {
  const links = [], terminals = new Set()
  for (const stop of stopRecords.values()) {
    if (Number(stop.location_type) !== 4) continue
    const parent = stopRecords.get(stop.parent_station)
    if (!parent || Number(parent.location_type || 0) !== 0) throw new Error(`Invalid boarding-area parent: ${stop.stop_id}`)
    terminals.add(parent.stop_id)
    if (stop.wheelchair_boarding !== undefined && stop.wheelchair_boarding !== 1) continue
    for (const [from, to] of [[stop.stop_id, parent.stop_id], [parent.stop_id, stop.stop_id]]) {
      links.push({ from_stop_id: from, to_stop_id: to, min_transfer_time: 0,
        path_distance_m: 0, provenance: 'gtfs_boarding_area' })
    }
  }
  return { links, terminals }
}

export function stationHierarchyMembers(stopRecords) {
  const groups = new Map()
  for (const stop of stopRecords.values()) {
    const seen = new Set([stop.stop_id])
    let parent = stop.parent_station
    while (parent) {
      if (seen.has(parent)) throw new Error(`Cyclic GTFS station hierarchy: ${stop.stop_id}`)
      seen.add(parent)
      const record = stopRecords.get(parent)
      if (!record) throw new Error(`Missing GTFS parent: ${parent}`)
      const members = groups.get(parent) ?? [parent]
      members.push(stop.stop_id)
      groups.set(parent, members)
      parent = record.parent_station
    }
  }
  return groups
}
