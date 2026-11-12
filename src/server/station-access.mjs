import { boardingAreaLinks } from './gtfs/station-hierarchy.mjs'
import { compileNativeStationPaths } from './native-routing-kernel.mjs'
import { haversineKm } from './geometry-utils.mjs'
import { stationTransferDurationSeconds } from './gtfs/routing-policy.mjs'

export function stationFallbackSeconds(from, to, walkingSpeedKph = 4.8) {
  const distanceKm = haversineKm([from.lon, from.lat], [to.lon, to.lat])
  return Math.max(120, Math.ceil(distanceKm / walkingSpeedKph * 3600))
}

// Resolve feed identities once; Rust owns graph compilation, Pareto search and
// packed witnesses. Declared pathways outside this stop subset still suppress
// invented parent-station links for the entire station.
export function prepareStationAccessPaths(store, stops, walkingSpeedKph = 4.8) {
  const indices = new Map(stops.map((stop, index) => [stop.stop_id, index]))
  const sources = ['parent_station_fallback'], sourceIndices = new Map([[sources[0], 0]])
  const edges = [], groups = [], forbiddenFrom = [], forbiddenTo = []
  const { links, terminals } = boardingAreaLinks(store.stopRecords ?? new Map(stops.map(stop => [stop.stop_id, stop])))
  const graph = new Map([...store.transfers].map(([id, rows]) => [id, [...rows]]))
  for (const link of links) graph.set(link.from_stop_id, [...(graph.get(link.from_stop_id) ?? []), link])
  for (const [id, transfers] of graph) {
    const from = indices.get(id)
    if (from === undefined) continue
    for (const transfer of transfers) {
      const to = indices.get(transfer.to_stop_id)
      if (to === undefined) continue
      const seconds = stationTransferDurationSeconds(transfer, stops[from], stops[to], walkingSpeedKph)
      if (seconds == null) continue
      const source = transfer.provenance
      if (!sourceIndices.has(source)) { sourceIndices.set(source, sources.length); sources.push(source) }
      const located = [stops[from].lon, stops[from].lat, stops[to].lon, stops[to].lat].every(Number.isFinite)
      edges.push({ from, to, seconds,
        // Zero is only a distance lower bound for a timed but unlocated link.
        // Its source coordinates and incomplete-geometry flag remain missing;
        // packed coordinate placeholders must never become a measured chord.
        distance: transfer.path_distance_m ?? (located ? undefined : 0),
        source: sourceIndices.get(source), street: source === 'osm_certified_radial' })
    }
  }
  for (const ids of store.stationMembers.values()) groups.push({
    members: ids.filter(id => indices.has(id)).map(id => indices.get(id)),
    declared: ids.some(id => store.declaredPathwayStops?.has(id)
      || store.transfers.get(id)?.some(link => ['gtfs_pathway', 'gtfs_pathway_estimated'].includes(link.provenance))),
  })
  for (const pair of store.forbiddenTransferPairs) {
    const [a, b] = pair.split('\u0000'), from = indices.get(a), to = indices.get(b)
    if (from !== undefined && to !== undefined) { forbiddenFrom.push(from); forbiddenTo.push(to) }
  }
  const { sourceIds, ...packed } = compileNativeStationPaths({
    coordinates: Float64Array.from(stops.flatMap(stop => [Number(stop.lon), Number(stop.lat)])),
    platforms: Uint8Array.from(stops, stop => Number(stop.location_type || 0) === 0 ? 1 : 0),
    terminalOnly: Uint8Array.from(stops, stop => Number(terminals.has(stop.stop_id))),
    edges, groups, forbiddenFrom: Uint32Array.from(forbiddenFrom), forbiddenTo: Uint32Array.from(forbiddenTo),
    fallbackSource: 0, walkingSpeedKph,
  })
  const retainedSources = Array.from(sourceIds, index => sources[index])
  if (retainedSources.some(source => typeof source !== 'string')) throw new Error('Prepared station paths have invalid sources.')
  return { stopIds: stops.map(stop => stop.stop_id), sources: retainedSources, ...packed }
}
