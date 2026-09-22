import { numeric } from '../number-utils.mjs'
import { stableJson } from '../routing-plan-identity.mjs'

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
  schemaVersion: 'vigo.routing.access-policy.v3',
  id: customWalkingParametersEnabled
    ? 'vigo-national-configured-access'
    : 'vigo-national-regular-access',
  durationModel: 'osm-distance-at-configured-walking-speed',
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

export const accessPaddingFactor = nationalRoutingAccessPolicy.accessPaddingFactor

export const accessOverheadSeconds = nationalRoutingAccessPolicy.accessOverheadSeconds

// A free coordinate must pay access overhead before boarding and egress
// overhead after alighting. Scheduled, transfer, and walking transitions are
// nonnegative, so this is the only process-wide transit-duration lower bound
// available before the timetable is searched. At the product default of zero
// overhead there is no valid direct-walk early exit.
export const directWalkTransitEndpointLowerBoundMinutes = (
  2 * Math.ceil(accessOverheadSeconds) / 60
)

export const osmTransferGraphSchemaVersion = 'vigo.routing.osm-stop-transfers.v3'

export const osmTransferMaximumWalkM = Math.max(
  50,
  Math.min(1_200, numeric(process.env.VIGO_ROUTING_TRANSFER_RADIUS_M, 500)),
)

export const osmTransferMaximumNeighbors = Math.max(
  0,
  Math.min(4_096, Math.floor(numeric(process.env.VIGO_ROUTING_TRANSFER_MAX_NEIGHBORS, 0))),
)

// Stored transfer seconds are a topology lower bound. The resident store
// replaces them with the configured walking policy using path_distance_m.
export const osmTransferLowerBoundSpeedKph = 8

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
  if (transfer?.provenance === 'gtfs_pathway' && transfer.min_transfer_time == null) {
    return walkSeconds(numeric(transfer.path_distance_m, 0) / 1000)
  }
  return Math.max(0, numeric(transfer?.min_transfer_time, 0))
}

export function accessWalkSeconds(stop) {
  if (stop?.exactStopAccess) return 0
  const explicit = numeric(stop?.accessSeconds, NaN)
  return Number.isFinite(explicit) ? Math.max(0, explicit) : walkSeconds(stop?.distanceKm ?? 0)
}

export function explicitRoutingStopId(point) {
  // `source: map` is the authoritative free-coordinate contract. Ignore a
  // stale stopId from older desktop payloads so a map A/B can never collapse
  // to one station before access candidates are searched.
  return point?.source === 'map' ? '' : String(point?.stopId ?? '').trim()
}

export function requestedAccessStopIds(request, field) {
  const values = request?.[field]
  if (!Array.isArray(values) || !values.length) return null
  const stopIds = new Set()
  for (const value of values) {
    const stopId = String(value ?? '').trim()
    if (stopId) stopIds.add(stopId)
  }
  return stopIds.size ? stopIds : null
}

export function validateMaximumTransfers(value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 31)) {
    throw new Error('maxTransfers must be an integer between 0 and 31; omit it for no additional limit.')
  }
}

export function routingHorizonMinutes(request) {
  const minutes = Number(request.horizonMinutes)
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.min(2_880, minutes)) : 480
}

export function transitRideRequired(request) {
  return request?.requireTransitRide !== false || request?.__disableDirectWalkDominance === true
}

export function validateTransitRideRequirement(request) {
  if (request.requireTransitRide != null && typeof request.requireTransitRide !== 'boolean') {
    throw new Error('requireTransitRide must be a boolean.')
  }
}
