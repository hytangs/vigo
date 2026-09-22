import { nativeStableKeySuffix } from './native-routing-kernel.mjs'
import { numeric } from './number-utils.mjs'

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const volatilePlanIdentityKeys = new Set(['nativeStreetQueryMs'])

// Plan IDs are display and selection keys, not security primitives. A small
// deterministic 64-bit suffix keeps them compact without making every route
// identity pay for a cryptographic digest.
export function stableKeySuffix(value) {
  return nativeStableKeySuffix(String(value))
}

function stablePlanIdentityJson(value) {
  if (Array.isArray(value)) return `[${value.map(stablePlanIdentityJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => !volatilePlanIdentityKeys.has(key))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stablePlanIdentityJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function stablePlanId(prefix, payload) {
  return `${prefix}-${stableKeySuffix(stablePlanIdentityJson(payload))}`
}

function routingPointIdentity(point) {
  return [
    numeric(point?.coordinate?.[0], null),
    numeric(point?.coordinate?.[1], null),
    String(point?.stopId ?? ''),
    String(point?.source ?? ''),
    String(point?.label ?? ''),
  ]
}

function nationalTransitLegIdentity(leg) {
  if (leg.type === 'ride') {
    return [
      'ride', leg.tripId ?? '', leg.routeId ?? '', leg.fromStopId ?? '',
      leg.toStopId ?? '', leg.startMinutes, leg.endMinutes, leg.stopCount,
      leg.shapeId ?? '', leg.geometrySource ?? '', leg.scheduleMode ?? '',
      numeric(leg.bridgedUntimedGapCount, 0),
    ]
  }
  return [
    'walk', leg.walkSource ?? '', leg.fromStopId ?? '', leg.toStopId ?? '',
    leg.startMinutes, leg.endMinutes, leg.durationMinutes, leg.distanceKm,
    leg.geometrySource ?? '', leg.streetPathVerified === true,
    leg.transferAction ?? '', leg.connectingRouteShortName ?? '',
  ]
}

export function stableNationalTransitPlanId({
  store,
  streetStorageIdentity,
  serviceDate,
  departMinutes,
  arriveMinutes,
  origin,
  destination,
  legs,
}) {
  const transitSourceIdentity = {
    sourceFingerprint: store.sourceFingerprint ?? null,
    transferSemanticsVersion: store.transferSemanticsVersion ?? null,
    transferGeneration: store.transferGeneration ?? null,
  }
  const identity = JSON.stringify([
    'vigo.national-plan-identity.v3',
    transitSourceIdentity,
    streetStorageIdentity,
    serviceDate,
    departMinutes,
    arriveMinutes,
    routingPointIdentity(origin),
    routingPointIdentity(destination),
    legs.map(nationalTransitLegIdentity),
  ])
  return `national-${stableKeySuffix(identity)}`
}
