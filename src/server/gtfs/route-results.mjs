import {
  accessOverheadSeconds,
  accessPaddingFactor,
  nationalRoutingAccessPolicy,
  routingHorizonMinutes,
  transitRideRequired,
  walkSeconds,
  walkingSpeedKph,
} from './routing-policy.mjs'

import { appendDistinctCoordinates } from '../geometry-utils.mjs'
import { nationalRideBoardingSummary } from '../national-route-choices.mjs'
import { nativeStreetAccessPermission } from '../native-routing-kernel.mjs'
import { numeric, timingMilliseconds } from '../number-utils.mjs'
import { stablePlanId } from '../routing-plan-identity.mjs'
import { annotateStationAccess } from '../station-access.mjs'
import { serviceDateDiagnostics } from './service-calendar.mjs'

export function incompleteServiceCoveragePlan(request, departureMinutes, maxWalkKm, resolution) {
  return blockedPlan(
    request,
    departureMinutes,
    maxWalkKm,
    'Incomplete timetable coverage',
    `Only ${resolution.resolvedServiceScopeCount} of ${resolution.availableServiceScopeCount} required feed scopes have service on ${resolution.resolvedServiceDate}. Choose a fully covered date; nearest-date fallback remains opt-in.`,
    { originStops: 0, destinationStops: 0 },
    resolution,
  )
}

function timetableDetail(durationMinutes, resolution) {
  if (resolution?.scheduleMode === 'realtime-adjusted') return `${Math.round(durationMinutes)} min / live predictions and scheduled times`
  if (resolution?.serviceDateTemplateApplied) return `${Math.round(durationMinutes)} min / representative timetable template`
  if (!resolution?.serviceDateFallbackApplied) return `${Math.round(durationMinutes)} min / exact local timetable`
  return `${Math.round(durationMinutes)} min / timetable for ${resolution.resolvedServiceDate} (fallback from ${resolution.requestedServiceDate})`
}

export function routeTimingDetail(
  durationMinutes,
  resolution,
  bridgedUntimedGapCount = 0,
  sourceEqualTimeRideCount = numeric(resolution?.sourceEqualTimeRideCount, 0),
) {
  const stationDetail = resolution?.unverifiedStationAccessLegs > 0 ? ' / station access unverified' : ''
  if (!bridgedUntimedGapCount) {
    const detail = timetableDetail(durationMinutes, resolution) + stationDetail
    if (!sourceEqualTimeRideCount) return detail
    const rideLabel = sourceEqualTimeRideCount === 1 ? 'ride' : 'rides'
    return `${detail} / ${sourceEqualTimeRideCount} ${rideLabel} published within one timestamp`
  }
  const serviceDate = resolution?.serviceDateFallbackApplied
    ? ` for ${resolution.resolvedServiceDate} (fallback from ${resolution.requestedServiceDate})`
    : ''
  return `${Math.round(durationMinutes)} min / interpolated stop-time gap${serviceDate} / degraded timing precision${stationDetail}`
}

export function materializeDirectWalkCandidate(request, maxWalkKm, path, diagnostics = {}) {
  const origin = request.origin
  const destination = request.destination
  const durationMinutes = path.distanceKm / walkingSpeedKph * 60
  const timePreference = request.timePreference === 'arrive' ? 'arrive' : 'depart'
  const selectedMinutes = numeric(
    timePreference === 'arrive'
      ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
      : request.departMinutes,
    8 * 60,
  )
  const departMinutes = timePreference === 'arrive'
    ? Math.max(0, selectedMinutes - durationMinutes)
    : selectedMinutes
  const arriveMinutes = timePreference === 'arrive' ? selectedMinutes : departMinutes + durationMinutes
  const requestedServiceDate = String(request.serviceDate ?? '')
  const roundedDurationMinutes = Number(durationMinutes.toFixed(3))
  const roundedDepartMinutes = Number(departMinutes.toFixed(3))
  const roundedArriveMinutes = Number(arriveMinutes.toFixed(3))

  return {
    id: stablePlanId('national-walk', {
      serviceDate: requestedServiceDate,
      timePreference,
      departMinutes: roundedDepartMinutes,
      arriveMinutes: roundedArriveMinutes,
      origin,
      destination,
      distanceKm: Number(path.distanceKm.toFixed(6)),
      coordinates: path.coordinates,
    }),
    status: 'ready',
    travelMode: 'walk',
    timePreference,
    maxWalkKm,
    scheduleMode: 'none',
    choiceLabel: diagnostics.choiceLabel ?? 'Walk instead',
    recommended: diagnostics.recommended ?? true,
    title: diagnostics.title ?? 'Walk instead',
    detail: `${Math.max(1, Math.round(durationMinutes))} min / direct OSM walk`,
    departMinutes: roundedDepartMinutes,
    arriveMinutes: roundedArriveMinutes,
    durationMinutes: roundedDurationMinutes,
    waitMinutes: 0,
    walkMinutes: roundedDurationMinutes,
    rideMinutes: 0,
    transfers: 0,
    origin,
    destination,
    legs: [{
      type: 'walk',
      travelMode: 'walk',
      walkSource: 'osm',
      fromName: origin.label,
      toName: destination.label,
      startMinutes: roundedDepartMinutes,
      endMinutes: roundedArriveMinutes,
      durationMinutes: roundedDurationMinutes,
      distanceKm: path.distanceKm,
      stopCount: 0,
      coordinates: path.coordinates,
    }],
    diagnostics: {
      scannedDepartures: 0,
      relaxedStops: 0,
      serviceDay: request.serviceDay ?? 'weekday',
      serviceDate: requestedServiceDate,
      requestedServiceDate,
      resolvedServiceDate: requestedServiceDate,
      serviceDateFallbackApplied: false,
      requestedServiceScopeCount: 0,
      resolvedServiceScopeCount: 0,
      availableServiceScopeCount: 0,
      scheduleMode: 'none',
      walkingNetwork: 'osm',
      walkingAccessPermission: nativeStreetAccessPermission(request.streetStorePath),
      walkingSpeedKph,
      originStreetPathVerified: true,
      destinationStreetPathVerified: true,
      searchProfile: diagnostics.searchProfile ?? 'fastest',
      searchStrategy: diagnostics.searchStrategy ?? 'exact',
      algorithm: diagnostics.algorithm ?? 'osm_direct_walk_dominance',
      optimality: diagnostics.optimality ?? 'direct_walk_strictly_dominates_transit_lower_bound',
      walkingPolicyId: 'vigo-national-direct-physical-walk',
      accessDurationModel: 'osm-distance-at-declared-walking-speed',
      accessPaddingFactor: 1,
      accessOverheadSeconds: 0,
      directWalkDistanceKm: path.distanceKm,
      transitLowerBoundMinutes: Object.hasOwn(diagnostics, 'transitLowerBoundMinutes')
        ? diagnostics.transitLowerBoundMinutes
        : undefined,
      transitAlternativeMinutes: diagnostics.transitAlternativeMinutes,
      originStopCandidates: 0,
      destinationStopCandidates: 0,
      destinationLabels: 0,
    },
  }
}

export function materializeDirectWalkPlan(plan, departMinutes) {
  const arriveMinutes = Number((departMinutes + plan.durationMinutes).toFixed(3))
  return {
    ...plan,
    id: `${plan.id}-window-${Number(departMinutes).toFixed(3)}`,
    departMinutes,
    arriveMinutes,
    recommended: false,
    legs: plan.legs.map((leg) => ({
      ...leg,
      startMinutes: departMinutes,
      endMinutes: arriveMinutes,
    })),
  }
}

function coalesceContinuousWalkLegs(legs) {
  const result = []
  for (let index = 0; index < legs.length;) {
    const leg = legs[index]
    if (leg.type !== 'walk') {
      result.push(leg)
      index += 1
      continue
    }
    let end = index + 1
    while (end < legs.length && legs[end].type === 'walk') end += 1
    const group = legs.slice(index, end)
    if (group.length === 1 || group.some((candidate) => candidate.walkSource !== 'transfer')) {
      result.push(...group)
      index = end
      continue
    }
    const coordinates = []
    for (const candidate of group) {
      for (const coordinate of candidate.coordinates ?? []) {
        const previous = coordinates.at(-1)
        if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate)
      }
    }
    const last = group.at(-1)
    result.push({
      type: 'walk',
      travelMode: 'walk',
      walkSource: 'transfer',
      transferSource: group.every((candidate) => candidate.transferSource === leg.transferSource)
        ? leg.transferSource : undefined,
      geometrySource: group.every((candidate) => candidate.geometrySource === leg.geometrySource)
        ? leg.geometrySource : undefined,
      streetPathVerified: group.every((candidate) => candidate.streetPathVerified === true),
      streetSegmentVerified: group.every((candidate) => (candidate.streetSegmentVerified ?? candidate.streetPathVerified) === true),
      stationAccessStatus: group.some((candidate) => candidate.stationAccessStatus === 'unverified')
        ? 'unverified' : group.find((candidate) => candidate.stationAccessStatus)?.stationAccessStatus,
      stationAccessStopIds: [...new Set(group.flatMap((candidate) => candidate.stationAccessStopIds ?? []))],
      fromStopId: leg.fromStopId,
      toStopId: last.toStopId,
      fromName: leg.fromName,
      toName: last.toName,
      startMinutes: leg.startMinutes,
      endMinutes: last.endMinutes,
      durationMinutes: Math.max(0, last.endMinutes - leg.startMinutes),
      distanceKm: group.reduce((sum, candidate) => sum + Math.max(0, numeric(candidate.distanceKm, 0)), 0),
      stopCount: 0,
      coordinates,
    })
    index = end
  }
  return result
}

function annotateNationalTransferSemantics(legs) {
  return legs.map((leg, index) => {
    if (leg?.type !== 'walk' || leg.walkSource !== 'transfer') return leg
    const previousRide = [...legs.slice(0, index)].reverse().find((candidate) => candidate?.type === 'ride')
    const nextRide = legs.slice(index + 1).find((candidate) => candidate?.type === 'ride')
    if (!previousRide || !nextRide) return leg
    const previousLabel = String(previousRide.routeShortName || previousRide.routeId || '').trim()
    const nextLabel = String(nextRide.routeShortName || nextRide.routeId || '').trim()
    const samePublicLine = Boolean(previousLabel && nextLabel && previousLabel === nextLabel)
    return {
      ...leg,
      transferAction: samePublicLine ? 'same-route-change' : 'interchange',
      connectingRouteShortName: nextLabel || undefined,
    }
  })
}

export function normalizeNationalLegs(legs) {
  if (!legs.some((leg) => leg?.walkSource === 'transfer')) return legs
  return annotateNationalTransferSemantics(coalesceContinuousWalkLegs(legs))
}

export function secondsToMinutes(seconds) {
  return Number((seconds / 60).toFixed(3))
}

export function materializeWindowPlan(plan, departMinutes, centerMinutes, latestCatchMinutes = null) {
  const delta = departMinutes - plan.departMinutes
  const firstRideIndex = plan.legs.findIndex((leg) => leg.type === 'ride')
  const legs = plan.legs.map((leg, index) => index >= 0 && index < firstRideIndex
    ? { ...leg, startMinutes: leg.startMinutes + delta, endMinutes: leg.endMinutes + delta }
    : leg)
  const durationMinutes = Number((plan.arriveMinutes - departMinutes).toFixed(3))
  const waitMinutes = Number(Math.max(0, plan.waitMinutes - delta).toFixed(3))
  return {
    ...plan,
    id: `${plan.id}-window-sample-${departMinutes}`,
    departMinutes,
    durationMinutes,
    waitMinutes,
    detail: routeTimingDetail(durationMinutes, plan.diagnostics, plan.diagnostics?.bridgedUntimedGapCount),
    diagnostics: {
      ...plan.diagnostics,
      windowSample: {
        sourceSearchMinutes: plan.departMinutes,
        sampleMinutes: departMinutes,
        reused: Math.abs(departMinutes - plan.departMinutes) > 1e-9,
        latestCatchMinutes: Number.isFinite(latestCatchMinutes) ? latestCatchMinutes : null,
      },
    },
    legs,
    recommended: false,
    choiceLabel: departMinutes === centerMinutes
      ? 'Exact selected time'
      : `${Math.abs(Math.round(departMinutes - centerMinutes))} min ${departMinutes < centerMinutes ? 'earlier' : 'later'}`,
  }
}

function mergeNationalThroughRide(left, right) {
  if (
    left?.type !== 'ride'
    || right?.type !== 'ride'
    || !left.tripId
    || left.tripId !== right.tripId
    || String(left.routeId || left.routeFeatureId || '') !== String(right.routeId || right.routeFeatureId || '')
    || left.toStopId !== right.fromStopId
    || Math.abs(numeric(left.endMinutes) - numeric(right.startMinutes)) > 0.01
  ) return null
  const durationMinutes = Math.max(0, numeric(right.endMinutes) - numeric(left.startMinutes))
  const sourceEqualTime = durationMinutes === 0 && left.fromStopId !== right.toStopId
  return {
    ...left,
    toStopId: right.toStopId,
    toStationGroupId: right.toStationGroupId,
    toName: right.toName,
    endMinutes: right.endMinutes,
    durationMinutes,
    distanceKm: Math.max(0, numeric(left.distanceKm, 0)) + Math.max(0, numeric(right.distanceKm, 0)),
    stopCount: Math.max(0, numeric(left.stopCount, 0)) + Math.max(0, numeric(right.stopCount, 0)),
    stopIds: Array.isArray(left.stopIds) && Array.isArray(right.stopIds)
      ? [...left.stopIds, ...right.stopIds.slice(1)] : undefined,
    coordinates: appendDistinctCoordinates(left.coordinates, right.coordinates),
    bridgedUntimedGapCount: numeric(left.bridgedUntimedGapCount, 0) + numeric(right.bridgedUntimedGapCount, 0) || undefined,
    sourceEqualTime: sourceEqualTime || undefined,
    sourceEqualTimeConnectionCount:
      numeric(left.sourceEqualTimeConnectionCount, 0)
      + numeric(right.sourceEqualTimeConnectionCount, 0)
      || undefined,
    sourceTimestampQuality: sourceEqualTime
      ? left.sourceTimestampQuality === 'equal-whole-minute'
        && right.sourceTimestampQuality === 'equal-whole-minute'
        ? 'equal-whole-minute'
        : 'equal-time'
      : undefined,
  }
}

function compactNationalAlternativeLegs(firstLegs, secondLegs) {
  const first = [...(firstLegs ?? [])]
  const second = [...(secondLegs ?? [])]
  while (first.at(-1)?.type === 'walk' && numeric(first.at(-1)?.durationMinutes, 0) <= 0.01) first.pop()
  while (second[0]?.type === 'walk' && numeric(second[0]?.durationMinutes, 0) <= 0.01) second.shift()
  const combined = [...first, ...second]
  const compacted = []
  for (const leg of combined) {
    const throughRide = mergeNationalThroughRide(compacted.at(-1), leg)
    if (throughRide) compacted[compacted.length - 1] = throughRide
    else compacted.push(leg)
  }
  return normalizeNationalLegs(compacted)
}

export function stitchNationalAlternativePlans(firstPlan, secondPlan, options = {}) {
  if (firstPlan?.status !== 'ready' || secondPlan?.status !== 'ready') return null
  const legs = compactNationalAlternativeLegs(firstPlan.legs, secondPlan.legs).map(leg => ({ ...leg }))
  const stationAccess = annotateStationAccess(legs, {
    exactStationAccess: firstPlan.origin?.source === 'stop' && firstPlan.origin.stopId === legs[0]?.toStopId,
    exactStationEgress: secondPlan.destination?.source === 'stop' && secondPlan.destination.stopId === legs.at(-1)?.fromStopId,
  })
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  if (!rideLegs.length) return null
  const departMinutes = numeric(firstPlan.departMinutes)
  const arriveMinutes = numeric(secondPlan.arriveMinutes)
  if (!Number.isFinite(departMinutes) || !Number.isFinite(arriveMinutes) || arriveMinutes < departMinutes) return null
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const durationMinutes = Number((arriveMinutes - departMinutes).toFixed(3))
  const waitMinutes = Number(Math.max(0, durationMinutes - walkMinutes - rideMinutes).toFixed(3))
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  const bridgedUntimedGapCount = rideLegs.reduce((sum, leg) => sum + numeric(leg.bridgedUntimedGapCount, 0), 0)
  const sourceEqualTimeRideCount = rideLegs.filter((leg) => leg.sourceEqualTime === true).length
  const sourceEqualTimeConnectionCount = rideLegs.reduce(
    (sum, leg) => sum + numeric(leg.sourceEqualTimeConnectionCount, 0),
    0,
  )
  const preferredWalkKm = Math.max(0.2, numeric(options.preferredWalkKm, firstPlan.maxWalkKm ?? secondPlan.maxWalkKm ?? 1.6))
  return {
    ...firstPlan,
    id: stablePlanId('national-alternative', { departMinutes, arriveMinutes, legs }),
    status: 'ready',
    travelMode: 'transit',
    timePreference: 'depart',
    maxWalkKm: preferredWalkKm,
    scheduleMode: bridgedUntimedGapCount ? 'interpolated-stop-time-gap' : 'exact',
    choiceLabel: 'Alternate',
    recommended: false,
    title: boardingSummary.title || firstPlan.title || secondPlan.title || 'Transit',
    detail: routeTimingDetail(
      durationMinutes,
      { ...firstPlan.diagnostics, ...stationAccess },
      bridgedUntimedGapCount,
      sourceEqualTimeRideCount,
    ),
    departMinutes,
    arriveMinutes,
    durationMinutes,
    waitMinutes,
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    transfers: boardingSummary.transfers,
    origin: options.origin ?? firstPlan.origin,
    destination: options.destination ?? secondPlan.destination,
    snappedOrigin: firstPlan.snappedOrigin,
    snappedDestination: secondPlan.snappedDestination,
    legs,
    diagnostics: {
      ...secondPlan.diagnostics,
      ...stationAccess,
      originWalkKm: firstPlan.diagnostics?.originWalkKm,
      destinationWalkKm: secondPlan.diagnostics?.destinationWalkKm,
      searchProfile: 'pareto',
      searchStrategy: 'exact_waypoint_composition',
      optimality: 'nondominated_station_waypoint_alternative',
      alternativeStrategy: 'station_pareto_waypoint',
      alternativeWaypointStopId: options.waypoint?.stopId,
      alternativeWaypointName: options.waypoint?.name,
      preferredMaxWalkKm: preferredWalkKm,
      bridgedUntimedGapCount,
      sourceEqualTimeRideCount,
      sourceEqualTimeConnectionCount,
      timingPrecision: bridgedUntimedGapCount
        ? 'degraded'
        : sourceEqualTimeRideCount
          ? 'source-equal-time'
          : 'exact',
      searchStats: {
        ...secondPlan.diagnostics?.searchStats,
        queryMs: timingMilliseconds(
          timingMilliseconds(firstPlan.diagnostics?.searchStats?.queryMs)
          + timingMilliseconds(secondPlan.diagnostics?.searchStats?.queryMs),
        ),
        componentSearches: 2,
      },
    },
  }
}

export function nationalPlanBeforeFinalEgress(plan, waypoint, request) {
  if (plan?.status !== 'ready') return null
  const legs = [...(plan.legs ?? [])]
  const egress = legs.at(-1)
  if (
    egress?.type !== 'walk'
    || egress.fromStopId !== waypoint.stopId
    || Math.abs(numeric(egress.endMinutes) - numeric(plan.arriveMinutes)) > 0.01
  ) return null
  legs.pop()
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  if (!rideLegs.length) return null
  const arriveMinutes = numeric(egress.startMinutes)
  const departMinutes = numeric(plan.departMinutes)
  const durationMinutes = Number((arriveMinutes - departMinutes).toFixed(3))
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  return {
    ...plan,
    id: stablePlanId('national-waypoint-prefix', { sourcePlanId: plan.id, waypointStopId: waypoint.stopId, arriveMinutes, legs }),
    maxWalkKm: Math.max(0.2, numeric(request.maxWalkKm, plan.maxWalkKm ?? 1.6)),
    destination: waypoint.point,
    snappedDestination: plan.snappedDestination,
    legs,
    title: boardingSummary.title,
    arriveMinutes,
    durationMinutes,
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    waitMinutes: Number(Math.max(0, durationMinutes - walkMinutes - rideMinutes).toFixed(3)),
    transfers: boardingSummary.transfers,
    diagnostics: {
      ...plan.diagnostics,
      destinationWalkKm: 0,
      alternativeStrategy: 'station_waypoint_prefix',
    },
  }
}

function markNationalLongWalkAlternative(plan, preferredWalkKm, alternativeWalkKm, waypoint) {
  if (plan?.status !== 'ready') return plan
  return {
    ...plan,
    recommended: false,
    choiceLabel: 'Longer walk',
    diagnostics: {
      ...plan.diagnostics,
      searchProfile: 'pareto',
      searchStrategy: 'exact_constrained_egress',
      optimality: 'nondominated_extended_egress_alternative',
      alternativeStrategy: 'long_walk_egress',
      longerWalkAlternative: true,
      preferredMaxWalkKm: preferredWalkKm,
      alternativeMaxWalkKm: alternativeWalkKm,
      alternativeWaypointStopId: waypoint.stopId,
      alternativeWaypointName: waypoint.name,
    },
  }
}

export function materializeNationalLongWalkAlternative(prefix, path, request, preferredWalkKm, alternativeWalkKm, waypoint) {
  if (prefix?.status !== 'ready' || !path?.coordinates?.length || !Number.isFinite(path.distanceKm)) return null
  const startMinutes = numeric(prefix.arriveMinutes)
  const durationMinutes = secondsToMinutes(walkSeconds(path.distanceKm))
  const endMinutes = Number((startMinutes + durationMinutes).toFixed(3))
  const legs = [...(prefix.legs ?? []).map(leg => ({ ...leg })), {
    type: 'walk',
    travelMode: 'walk',
    walkSource: 'osm',
    fromStopId: waypoint.stopId,
    fromName: prefix.snappedDestination?.name || waypoint.name,
    toName: request.destination.label,
    startMinutes,
    endMinutes,
    durationMinutes,
    distanceKm: path.distanceKm,
    stopCount: 0,
    coordinates: path.coordinates,
  }]
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const departMinutes = numeric(prefix.departMinutes)
  const totalMinutes = Number((endMinutes - departMinutes).toFixed(3))
  const stationAccess = annotateStationAccess(legs, {
    exactStationAccess: prefix.origin?.source === 'stop' && prefix.origin.stopId === legs[0]?.toStopId,
  })
  return markNationalLongWalkAlternative({
    ...prefix,
    id: stablePlanId('national-long-walk', { sourcePlanId: prefix.id, destination: request.destination, endMinutes, legs }),
    maxWalkKm: alternativeWalkKm,
    destination: request.destination,
    legs,
    title: boardingSummary.title,
    arriveMinutes: endMinutes,
    durationMinutes: totalMinutes,
    detail: routeTimingDetail(totalMinutes, { ...prefix.diagnostics, ...stationAccess }, prefix.diagnostics?.bridgedUntimedGapCount),
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    waitMinutes: Number(Math.max(0, totalMinutes - walkMinutes - rideMinutes).toFixed(3)),
    transfers: boardingSummary.transfers,
    diagnostics: {
      ...prefix.diagnostics,
      ...stationAccess,
      destinationWalkKm: path.distanceKm,
      destinationStreetPathVerified: legs.at(-1)?.stationAccessStatus !== 'unverified',
    },
  }, preferredWalkKm, alternativeWalkKm, waypoint)
}

export function materializeNationalLongWalkAccessAlternative(plan, path, request, centerMinutes, preferredWalkKm, alternativeWalkKm, waypoint) {
  if (plan?.status !== 'ready' || plan.travelMode !== 'transit' || !path?.coordinates?.length || !Number.isFinite(path.distanceKm)) return null
  const walkDurationMinutes = secondsToMinutes(walkSeconds(path.distanceKm))
  const accessEndMinutes = Number((centerMinutes + walkDurationMinutes).toFixed(3))
  const transitLegs = (plan.legs ?? []).map(leg => ({ ...leg }))
  while (transitLegs[0]?.type === 'walk' && numeric(transitLegs[0]?.durationMinutes, 0) <= 0.01) transitLegs.shift()
  const legs = [{
    type: 'walk',
    travelMode: 'walk',
    walkSource: 'osm',
    fromName: request.origin.label,
    toStopId: waypoint.stopId,
    toName: waypoint.name,
    startMinutes: centerMinutes,
    endMinutes: accessEndMinutes,
    durationMinutes: walkDurationMinutes,
    distanceKm: path.distanceKm,
    stopCount: 0,
    coordinates: path.coordinates,
  }, ...transitLegs]
  const rideLegs = legs.filter((leg) => leg.type === 'ride')
  if (!rideLegs.length) return null
  const arriveMinutes = numeric(plan.arriveMinutes)
  const durationMinutes = Number((arriveMinutes - centerMinutes).toFixed(3))
  if (!Number.isFinite(arriveMinutes) || durationMinutes < 0) return null
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const rideMinutes = rideLegs.reduce((sum, leg) => sum + Math.max(0, numeric(leg.durationMinutes, 0)), 0)
  const boardingSummary = nationalRideBoardingSummary(rideLegs)
  const stationAccess = annotateStationAccess(legs, {
    exactStationEgress: plan.destination?.source === 'stop' && plan.destination.stopId === legs.at(-1)?.fromStopId,
  })
  return {
    ...plan,
    id: stablePlanId('national-long-walk-access', { sourcePlanId: plan.id, origin: request.origin, centerMinutes, legs }),
    maxWalkKm: alternativeWalkKm,
    choiceLabel: 'Longer walk',
    recommended: false,
    title: boardingSummary.title || plan.title,
    detail: routeTimingDetail(durationMinutes, { ...plan.diagnostics, ...stationAccess }, plan.diagnostics?.bridgedUntimedGapCount),
    departMinutes: centerMinutes,
    durationMinutes,
    waitMinutes: Number(Math.max(0, durationMinutes - walkMinutes - rideMinutes).toFixed(3)),
    walkMinutes: Number(walkMinutes.toFixed(3)),
    rideMinutes: Number(rideMinutes.toFixed(3)),
    transfers: boardingSummary.transfers,
    origin: request.origin,
    legs: normalizeNationalLegs(legs),
    diagnostics: {
      ...plan.diagnostics,
      ...stationAccess,
      originWalkKm: path.distanceKm,
      originStreetPathVerified: legs[0]?.stationAccessStatus !== 'unverified',
      searchProfile: 'pareto',
      searchStrategy: 'exact_constrained_access',
      optimality: 'distinct_station_access_alternative',
      alternativeStrategy: 'long_walk_access',
      longerWalkAlternative: true,
      preferredMaxWalkKm: preferredWalkKm,
      alternativeMaxWalkKm: alternativeWalkKm,
      alternativeWaypointStopId: waypoint.stopId,
      alternativeWaypointName: waypoint.name,
    },
  }
}

function accessFailureFromAvailability(accessAvailability) {
  const statuses = Object.values(accessAvailability ?? {})
    .map((hint) => hint?.status)
    .filter(Boolean)
  if (!statuses.length) return null
  if (statuses.includes('diagnostic_unavailable')) {
    return {
      code: 'access_diagnostic_unavailable',
      category: 'diagnostic',
      retryable: true,
      message: 'No access candidate was found within the selected walking limit, and the wider diagnostic search could not complete.',
    }
  }
  if (statuses.every((status) => status === 'outside_selected_budget')) {
    return {
      code: 'access_budget_exceeded',
      category: 'access',
      retryable: false,
      message: 'A station access candidate exists beyond the selected walking limit. Increasing the limit may allow a journey; a complete transit itinerary has not been verified.',
    }
  }
  if (
    statuses.includes('street_access_unverified')
    && statuses.every((status) => [
      'street_access_unverified',
      'outside_selected_budget',
    ].includes(status))
  ) {
    return {
      code: 'street_access_unverified',
      category: 'access',
      retryable: false,
      message: 'Nearby transit stops exist, but no pedestrian access path was verified within the diagnostic search limit. A longer path or missing street connections may explain this result.',
    }
  }
  return {
    code: 'access_unreachable',
    category: 'access',
    retryable: false,
    message: 'At least one endpoint has no station access candidate within the bounded diagnostic search. This does not establish that no longer path exists.',
  }
}

function routingFailure(title, detail, stats = {}) {
  if (stats.failure) return { message: detail, retryable: false, ...stats.failure }
  if (title === 'No reachable station') {
    const accessFailure = accessFailureFromAvailability(stats.accessAvailability)
    if (accessFailure) return accessFailure
  }
  const failureByTitle = {
    'No reachable station': { code: 'access_unreachable', category: 'access', retryable: false },
    'No active service': { code: 'service_inactive', category: 'service', retryable: false },
    'Incomplete timetable coverage': { code: 'coverage_incomplete', category: 'data_coverage', retryable: false },
    'No scheduled path': { code: 'no_path', category: 'routing', retryable: false },
    'Unsupported GTFS feature': { code: 'unsupported_gtfs_feature', category: 'unsupported_feature', retryable: false },
  }
  return { ...(failureByTitle[title] ?? { code: 'routing_blocked', category: 'routing', retryable: false }), message: detail }
}

export function blockedPlan(request, departureMinutes, maxWalkKm, title, detail, stats = {}, serviceDateResolution = null) {
  const resolution = serviceDateResolution ?? {
    requestedServiceDate: request.serviceDate,
    resolvedServiceDate: request.serviceDate,
    serviceDateFallbackApplied: false,
    requestedServiceScopeCount: 0,
    resolvedServiceScopeCount: 0,
    availableServiceScopeCount: 0,
  }
  const failure = routingFailure(title, detail, stats)
  if (title === 'No reachable station' && stats.accessAvailability) {
    title = ({
      access_budget_exceeded: 'Walking limit exceeded',
      street_access_unverified: 'Street access unverified',
      access_diagnostic_unavailable: 'Access diagnostic unavailable',
    })[failure.code] ?? 'No access within search limits'
    detail = failure.message
  }
  return {
    id: stablePlanId('national-blocked', {
      failure: failure.code,
      serviceDate: resolution.resolvedServiceDate,
      departureMinutes,
      maxWalkKm,
      origin: request.origin,
      destination: request.destination,
    }), status: 'blocked', travelMode: 'transit', timePreference: request.timePreference === 'arrive' ? 'arrive' : 'depart', maxWalkKm,
    choiceLabel: 'No exact itinerary', recommended: true, title, detail, departMinutes: departureMinutes,
    durationMinutes: 0, waitMinutes: 0, walkMinutes: 0, rideMinutes: 0, transfers: 0,
    origin: request.origin, destination: request.destination, legs: [],
    diagnostics: {
      scannedDepartures: stats.scanned ?? 0, relaxedStops: stats.relaxed ?? 0, serviceDay: request.serviceDay ?? 'weekday', ...serviceDateDiagnostics(resolution),
      scheduleMode: 'none', walkingNetwork: request.streetStorePath ? 'osm' : 'direct', walkingSpeedKph, searchProfile: 'fastest', searchStrategy: 'not_run',
      walkingAccessPermission: request.streetStorePath ? nativeStreetAccessPermission(request.streetStorePath) : 'public',
      algorithm: 'resident_timetable_kernel', optimality: 'not_applicable',
      walkingPolicyId: nationalRoutingAccessPolicy.id,
      accessDurationModel: nationalRoutingAccessPolicy.durationModel,
      accessPaddingFactor,
      accessOverheadSeconds,
      methodState: failure.category === 'unsupported_feature' ? 'unsupported' : 'failed',
      failureCode: failure.code,
      failureCategory: failure.category,
      failure,
      searchLimits: {
        maxWalkKm,
        walkingLimitScope: 'per_endpoint',
        horizonMinutes: routingHorizonMinutes(request),
        horizonScope: 'timetable_scan',
        maxTransfers: request.maxTransfers ?? null,
        requireTransitRide: transitRideRequired(request),
      },
      originStopCandidates: stats.originStops ?? 0, destinationStopCandidates: stats.destinationStops ?? 0, destinationLabels: 0,
      ...(stats.accessAvailability ? { accessAvailability: stats.accessAvailability } : {}),
      searchStats: {},
    },
  }
}

export function routingResultStatus(plan) {
  if (plan?.status === 'ready') return 'ready'
  const failureCode = String(plan?.diagnostics?.failure?.code ?? plan?.diagnostics?.failureCode ?? '')
  const failureCategory = String(plan?.diagnostics?.failure?.category ?? plan?.diagnostics?.failureCategory ?? '')
  if (failureCode.includes('stale') || failureCode.includes('artifact')) return 'stale'
  if (failureCode.includes('cancel')) return 'cancelled'
  if (failureCategory === 'unsupported_feature' || failureCode.includes('unsupported')) return 'unsupported'
  return 'blocked'
}
