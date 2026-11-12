import { pathwayCostModel } from './pathway-cost.mjs'
import { numeric } from '../number-utils.mjs'
import { stableJson } from '../routing-plan-identity.mjs'
import { haversineKm } from '../geometry-utils.mjs'

// The desktop uses an ordinary walking pace without hidden reliability
// padding. Deployments may tune each term explicitly through the environment;
// one immutable walking model is bound to each worker process.
const customWalkingParametersEnabled = [
  'VIGO_ROUTING_WALK_SPEED_KPH',
  'VIGO_ROUTING_WALK_PADDING_FACTOR',
  'VIGO_ROUTING_WALK_OVERHEAD_SECONDS',
].some((key) => String(process.env[key] ?? '').trim() !== '')

const configuredWalkingSpeedKph = Math.max(
  1.5,
  Math.min(
    8,
    numeric(
      process.env.VIGO_ROUTING_WALK_SPEED_KPH,
      4.8,
    ),
  ),
)

const configuredAccessPaddingFactor = Math.max(
  0.75,
  Math.min(
    3,
    numeric(
      process.env.VIGO_ROUTING_WALK_PADDING_FACTOR,
      1,
    ),
  ),
)

const configuredAccessOverheadSeconds = Math.max(
  0,
  Math.min(
    900,
    numeric(
      process.env.VIGO_ROUTING_WALK_OVERHEAD_SECONDS,
      0,
    ),
  ),
)

export const nationalRoutingAccessPolicy = Object.freeze({
  schemaVersion: 'vigo.routing.access-policy.v9',
  id: customWalkingParametersEnabled
    ? 'vigo-national-configured-access'
    : 'vigo-national-regular-access',
  durationModel: 'osm-distance-at-configured-walking-speed',
  parentStationTransferMinimums: 'published-type-2-floors-v1',
  sameStopTransferProhibitionScope: 'direct-reboarding-only',
  transferWalkingTimeFloor: 'distance-at-configured-speed-v1',
  unpricedPathways: 'typed-estimates-otherwise-excluded-v2',
  pathwayCostModel,
  streetAttachment: 'nearest-vertex-or-reciprocal-edge-v3',
  stationStreetAnchors: 'declared-entrances-v1',
  stationStreetTransfers: 'entrance-pathway-chain-v1',
  stationPathDistance: 'source-or-located-chord-v1',
  walkingSpeedKph: configuredWalkingSpeedKph,
  accessPaddingFactor: configuredAccessPaddingFactor,
  accessOverheadSeconds: configuredAccessOverheadSeconds,
  physicalLimitScope: 'per-endpoint',
  customOverride: customWalkingParametersEnabled,
  configuration: customWalkingParametersEnabled
    ? 'environment'
    : 'product-default',
})

export const nationalRoutingAccessPolicyIdentity = stableJson(nationalRoutingAccessPolicy)

export const walkingSpeedKph = nationalRoutingAccessPolicy.walkingSpeedKph

const accessPaddingFactor = nationalRoutingAccessPolicy.accessPaddingFactor

const accessOverheadSeconds = nationalRoutingAccessPolicy.accessOverheadSeconds

export const osmTransferMaximumWalkM = Math.max(
  50,
  Math.min(1_200, numeric(process.env.VIGO_ROUTING_TRANSFER_RADIUS_M, 500)),
)

export function requiredServiceCoverageIncomplete(request, resolution) {
  return request.requireCompleteServiceCoverage === true
    && resolution.availableServiceScopeCount > 1
    && resolution.resolvedServiceScopeCount < resolution.availableServiceScopeCount
}

export function directWalkEndToEndLimitKm(request) {
  const distance = request?.allowLongWalk === false
    ? Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
    : Math.max(0.05, Math.min(100, Number(request.maxStreetKm) || 50))
  const minutes = request.timePreference === 'arrive'
    ? Math.min(routingHorizonMinutes(request), Math.max(0, numeric(request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes, 480)))
    : routingHorizonMinutes(request)
  return Math.min(distance, minutes / 60 * walkingSpeedKph)
}

export function walkSeconds(distanceKm) {
  return Math.ceil(distanceKm / walkingSpeedKph * 3600 * accessPaddingFactor + accessOverheadSeconds)
}

export function transferDurationSeconds(transfer) {
  if (transfer?.provenance === 'gtfs_pathway_estimated') {
    return Math.max(Number(transfer.min_transfer_time),
      transfer.path_distance_m == null ? 0 : walkSeconds(transfer.path_distance_m / 1000))
  }
  if (transfer?.provenance === 'gtfs_pathway' && transfer.min_transfer_time == null) {
    if (transfer.path_distance_m == null) return null
    return walkSeconds(numeric(transfer.path_distance_m, 0) / 1000)
  }
  return Math.max(0, numeric(transfer?.min_transfer_time, 0))
}

// A transfers.txt minimum constrains boarding; it is not a pathway traversal
// time or permission to walk faster than the configured pace. Apply this to
// each expanded platform pair before searching, including station access.
// Explicit pathway traversal times retain their source meaning (e.g. lifts).
export function stationTransferDurationSeconds(transfer, from, to, speedKph = walkingSpeedKph) {
  const minimum = transferDurationSeconds(transfer)
  if (transfer?.provenance !== 'gtfs_transfer'
    || Number(transfer.transfer_type) === 3 || !from || !to) return minimum
  const coordinates = [from.lon, from.lat, to.lon, to.lat]
  if (!coordinates.every(Number.isFinite)) return minimum
  const distanceKm = Math.max(
    haversineKm(coordinates.slice(0, 2), coordinates.slice(2)),
    numeric(transfer.path_distance_m, 0) / 1000,
  )
  return Math.max(minimum, Math.ceil(distanceKm / speedKph * 3600))
}

export function routingHorizonMinutes(request) {
  const minutes = Number(request.horizonMinutes)
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.min(2_880, minutes)) : 480
}
