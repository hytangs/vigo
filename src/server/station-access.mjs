import { compileNativeStationPaths } from './native-routing-kernel.mjs'
import { haversineKm } from './geometry-utils.mjs'

const isPathway = source => source === 'gtfs_pathway' || source === 'schedule_pathway'

// Declared station traversal time need not equal street walking time (for
// example, a moving walkway). Preserve both priced components and the directed
// stop witness so a consumer can check source timing independently.
export function stationAccessTiming(candidate) {
  const distanceKm = candidate.accessTransferPathDistanceKm
  const seconds = candidate.accessTransferSeconds
  if (!candidate.accessTransferStopIds || !Number.isFinite(distanceKm)
    || !Number.isFinite(seconds) || !Number.isFinite(candidate.accessSeconds)) return {}
  return { accessCost: {
    street: {
      distanceKm: Math.max(0, candidate.distanceKm - distanceKm),
      seconds: Math.max(0, candidate.accessSeconds - seconds),
    },
    station: {
      stopIds: candidate.accessTransferStopIds,
      sources: candidate.accessTransferSources,
      distanceKm,
      seconds,
    },
  } }
}

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

// Resolve feed identities once; Rust owns graph compilation, Pareto search and
// packed witnesses. Declared pathways outside this stop subset still suppress
// invented parent-station links for the entire station.
export function prepareStationAccessPaths(store, stops, walkingSpeedKph = 4.8) {
  const indices = new Map(stops.map((stop, index) => [stop.stop_id, index]))
  const sources = ['parent_station_fallback'], sourceIndices = new Map([[sources[0], 0]])
  const edges = [], groups = [], forbiddenFrom = [], forbiddenTo = []
  for (const [id, transfers] of store.transfers) {
    const from = indices.get(id)
    if (from === undefined) continue
    for (const transfer of transfers) {
      const to = indices.get(transfer.to_stop_id)
      if (to === undefined) continue
      const source = transfer.provenance
      if (!sourceIndices.has(source)) { sourceIndices.set(source, sources.length); sources.push(source) }
      edges.push({ from, to, seconds: Math.max(0, Number(transfer.min_transfer_time) || 0),
        distance: transfer.path_distance_m ?? undefined, source: sourceIndices.get(source), street: source === 'osm_certified_radial' })
    }
  }
  for (const ids of store.stationMembers.values()) groups.push({
    members: ids.filter(id => indices.has(id)).map(id => indices.get(id)),
    declared: ids.some(id => store.transfers.get(id)?.some(link => link.provenance === 'gtfs_pathway')),
  })
  for (const pair of store.forbiddenTransferPairs) {
    const [a, b] = pair.split('\u0000'), from = indices.get(a), to = indices.get(b)
    if (from !== undefined && to !== undefined) { forbiddenFrom.push(from); forbiddenTo.push(to) }
  }
  const { sourceIds, ...packed } = compileNativeStationPaths({
    coordinates: Float64Array.from(stops.flatMap(stop => [Number(stop.lon), Number(stop.lat)])),
    platforms: Uint8Array.from(stops, stop => Number(stop.location_type || 0) === 0 ? 1 : 0),
    edges, groups, forbiddenFrom: Uint32Array.from(forbiddenFrom), forbiddenTo: Uint32Array.from(forbiddenTo),
    fallbackSource: 0, walkingSpeedKph,
  })
  const retainedSources = Array.from(sourceIds, index => sources[index])
  if (retainedSources.some(source => typeof source !== 'string')) throw new Error('Prepared station paths have invalid sources.')
  return { stopIds: stops.map(stop => stop.stop_id), sources: retainedSources, ...packed }
}
