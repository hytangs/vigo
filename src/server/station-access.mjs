import { haversineKm } from './geometry-utils.mjs'

const isPathway = source => source === 'gtfs_pathway' || source === 'schedule_pathway'

// A street path to a platform coordinate does not establish the station's
// interior connection. Keep that evidence boundary on the selected legs;
// missing station data does not supply a defensible additional travel time.
export function annotateStationAccess(legs, {
  exactStationAccess = false, exactStationEgress = false,
} = {}) {
  const stationStops = new Set()
  for (const leg of legs) {
    if (leg.type !== 'ride') continue
    const subway = [1, 401, 402].includes(Number(leg.routeType))
    for (const [id, stationId] of [[leg.fromStopId, leg.fromStationGroupId], [leg.toStopId, leg.toStationGroupId]]) {
      if (id && (subway || (stationId && stationId !== id))) stationStops.add(id)
    }
  }
  for (const [index, leg] of legs.entries()) {
    if (leg.type !== 'walk' || leg.stationAccessStatus
      || (index === 0 && exactStationAccess)
      || (index === legs.length - 1 && exactStationEgress)
      || (leg.fromStopId && leg.fromStopId === leg.toStopId)) continue
    const stopIds = [...new Set([leg.fromStopId, leg.toStopId].filter(id => stationStops.has(id)))]
    if (!stopIds.length) continue
    const sources = leg.stationPathSources ?? [leg.transferSource]
    const sourcePath = sources.length > 0 && sources.every(isPathway)
    leg.stationAccessStatus = sourcePath ? 'source_path' : 'unverified'
    leg.stationAccessStopIds = stopIds
    if (!sourcePath) {
      // Preserve the narrower street-segment result, while withdrawing the
      // whole-leg claim when the entrance/platform connection is unknown.
      leg.streetSegmentVerified = leg.streetPathVerified === true
      leg.streetPathVerified = false
    }
  }
  const stationAccessLegs = legs.filter(leg => leg.stationAccessStatus).length
  const unverifiedStationAccessLegs = legs.filter(leg => leg.stationAccessStatus === 'unverified').length
  return {
    stationAccessStatus: unverifiedStationAccessLegs ? 'unverified' : stationAccessLegs ? 'source_path' : 'not_required',
    stationAccessLegs,
    unverifiedStationAccessLegs,
  }
}

export function stationFallbackSeconds(from, to, walkingSpeedKph = 4.8) {
  const distanceKm = haversineKm([from.lon, from.lat], [to.lon, to.lat])
  return Math.max(120, Math.ceil(distanceKm / walkingSpeedKph * 3600))
}

// Compile the directed station walking graph once. Retain every nondominated
// time/distance path: a faster path can exceed an endpoint's remaining budget.
// OSM transfers already belong to the complete native street frontier.
export function stationAccessPaths(store, stops, walkingSpeedKph = 4.8) {
  const indices = new Map(stops.map((stop, index) => [stop.stop_id, index]))
  const outgoing = stops.map(() => new Map())
  const add = (fromId, toId, seconds, source, distanceM) => {
    const from = indices.get(fromId), to = indices.get(toId)
    if (from === undefined || to === undefined || from === to
      || store.forbiddenTransferPairs.has(`${fromId}\u0000${toId}`)) return
    const current = outgoing[from].get(to)
    if (current && current.seconds <= seconds) return
    outgoing[from].set(to, {
      to, seconds,
      distanceM: distanceM ?? haversineKm([stops[from].lon, stops[from].lat], [stops[to].lon, stops[to].lat]) * 1000,
      source,
    })
  }
  for (const [fromId, transfers] of store.transfers) {
    for (const transfer of transfers) {
      if (transfer.provenance === 'osm_certified_radial') continue
      add(fromId, transfer.to_stop_id, Math.max(0, Number(transfer.min_transfer_time) || 0),
        transfer.provenance, transfer.path_distance_m)
    }
  }
  for (const ids of store.stationMembers.values()) {
    // A declared station graph owns its connectivity and direction. A generic
    // platform shortcut must not bypass a long or one-way declared pathway.
    if (ids.some(id => store.transfers.get(id)?.some(link => link.provenance === 'gtfs_pathway'))) continue
    const members = ids.filter(id => indices.has(id) && Number(stops[indices.get(id)].location_type || 0) === 0)
    for (const from of members) for (const to of members) {
      if (!store.transfers.get(from)?.some(link => link.to_stop_id === to)) {
        const a = stops[indices.get(from)], b = stops[indices.get(to)]
        const distanceM = haversineKm([a.lon, a.lat], [b.lon, b.lat]) * 1000
        add(from, to, stationFallbackSeconds(a, b, walkingSpeedKph), 'parent_station_fallback', distanceM)
      }
    }
  }
  const paths = []
  const dominates = (left, right) => left.seconds <= right.seconds && left.distanceM <= right.distanceM
  for (let from = 0; from < stops.length; from += 1) {
    if (!outgoing[from].size) continue
    const initial = { to: from, seconds: 0, distanceM: 0, stops: [from], sources: [] }
    const labels = new Map([[from, [initial]]]), queue = [initial]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const label = queue[cursor]
      if (!labels.get(label.to).includes(label)) continue
      for (const edge of outgoing[label.to].values()) {
        const candidate = {
          to: edge.to, seconds: label.seconds + edge.seconds,
          distanceM: label.distanceM + edge.distanceM,
          stops: [...label.stops, edge.to], sources: [...label.sources, edge.source],
        }
        const retained = labels.get(edge.to) ?? []
        if (retained.some(current => dominates(current, candidate))) continue
        labels.set(edge.to, [...retained.filter(current => !dominates(candidate, current)), candidate])
        queue.push(candidate)
      }
    }
    for (const [to, retained] of labels) if (to !== from) {
      for (const label of retained) paths.push({ from, ...label })
    }
  }
  return paths
}
