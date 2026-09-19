import { tripInstance } from './serviceWindow.mjs'

// Shared directed GTFS connections provide a transferable geographic unit.
// No inferred neighborhood boundaries, distance radius, or incident cause.
export function serviceConcentrations(context, departures) {
  const bySegment = new Map()
  for (const departure of departures) {
    if (!(departure.delaySeconds > 0)) continue
    const from = context.stopIndex.get(departure.stopId), to = context.stopIndex.get(departure.toStopId)
    if (!from || !to || from.stop_id === to.stop_id) continue
    const key = JSON.stringify([from.stop_id, to.stop_id])
    if (!bySegment.has(key)) bySegment.set(key, { from, to, reports: [] })
    bySegment.get(key).reports.push(departure)
  }
  const candidates = []
  for (const { from, to, reports } of bySegment.values()) {
    // Merge overlapping scheduled-to-predicted departure windows at this exact
    // segment. Two issues hours apart cannot become the same local pattern.
    reports.sort((a, b) => a.scheduledTime - b.scheduledTime)
    let group = [], end = -Infinity
    const retain = () => {
      const routeIds = [...new Set(group.map(row => row.routeId))].sort()
      if (routeIds.length < 2) return
      const byTrip = new Map()
      for (const row of group) {
        const key = tripInstance(row)
        if (!byTrip.has(key) || row.delaySeconds > byTrip.get(key).delaySeconds) byTrip.set(key, { ...row })
      }
      candidates.push({ stops: [from, to], segments: [JSON.stringify([from.stop_id, to.stop_id])], reports: [...byTrip.values()], routeIds,
        fromTime: Math.min(...group.map(row => row.scheduledTime)), toTime: end })
    }
    for (const report of reports) {
      if (report.scheduledTime > end && group.length) { retain(); group = []; end = -Infinity }
      group.push(report); end = Math.max(end, report.predictedTime)
    }
    if (group.length) retain()
  }
  // Adjacent segments with the same routes, at least one shared trip, and
  // overlapping windows form one corridor observation. Deduplicate each trip.
  const parent = candidates.map((_, index) => index)
  const root = index => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index] } return index }
  const byStop = new Map()
  for (const [index, candidate] of candidates.entries()) {
    const trips = new Set(candidate.reports.map(tripInstance))
    for (const stop of candidate.stops) {
      const key = JSON.stringify([candidate.routeIds, stop.stop_id])
      const neighbors = byStop.get(key) ?? []
      for (const other of neighbors) {
        const prior = candidates[other]
        if (prior.fromTime <= candidate.toTime && candidate.fromTime <= prior.toTime
          && prior.reports.some(row => trips.has(tripInstance(row)))) parent[root(index)] = root(other)
      }
      neighbors.push(index); byStop.set(key, neighbors)
    }
  }
  const groups = new Map()
  for (const [index, candidate] of candidates.entries()) {
    const key = root(index)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(candidate)
  }
  const corridors = [...groups.values()].map(group => {
    // Choose a reproducible label at the largest measured delay in the group.
    group.sort((a, b) => Math.max(...b.reports.map(row => row.delaySeconds)) - Math.max(...a.reports.map(row => row.delaySeconds)) || a.segments[0].localeCompare(b.segments[0]))
    const reports = new Map()
    for (const row of group.flatMap(item => item.reports)) {
      const key = tripInstance(row)
      if (!reports.has(key) || reports.get(key).delaySeconds < row.delaySeconds) reports.set(key, row)
    }
    return { routeIds: group[0].routeIds, stops: [...new Map(group.flatMap(item => item.stops).map(stop => [stop.stop_id, stop])).values()],
      segments: group.flatMap(item => item.segments), reports: [...reports.values()].sort((a,b) => tripInstance(a).localeCompare(tripInstance(b))),
      fromTime: Math.min(...group.map(item => item.fromTime)), toTime: Math.max(...group.map(item => item.toTime)) }
  })
  return corridors.map(item => ({
    name: new Set(item.segments).size === 1 ? `${item.stops[0].name} → ${item.stops[1].name}` : `Around ${item.stops[0].name}`,
    routeIds: item.routeIds, stopIds: item.stops.map(stop => stop.stop_id), segmentCount: new Set(item.segments).size,
    tripCount: item.reports.length, delaySeconds: item.reports.reduce((sum, row) => sum + row.delaySeconds, 0),
    maxDelaySeconds: Math.max(...item.reports.map(row => row.delaySeconds)),
    fromTime: item.fromTime, toTime: item.toTime,
    sourceRefs: [...new Set(item.reports.map(row => row.sourceRef))],
    // Keep distinct directions attached to their routes, never compare the
    // meaning of direction_id=0 across different GTFS routes.
    directions: [...new Map(item.reports.map(row => [JSON.stringify([row.routeId, row.directionId]), { routeId: row.routeId, directionId: row.directionId }])).values()],
  })).sort((a, b) => b.delaySeconds - a.delaySeconds || a.name.localeCompare(b.name))
    .map((item, index) => ({ ...item, id: `corridor-${index + 1}` }))
}
