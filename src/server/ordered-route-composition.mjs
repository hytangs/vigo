import { numeric as finiteNumber } from './number-utils.mjs'

const maximumOrderedRoutingPoints = 8

function validCoordinate(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every((coordinate) => Number.isFinite(Number(coordinate)))
}

function sameCoordinate(left, right) {
  return validCoordinate(left)
    && validCoordinate(right)
    && Number(left[0]) === Number(right[0])
    && Number(left[1]) === Number(right[1])
}

function routingPointLabel(point, fallback) {
  const label = String(point?.label ?? '').trim()
  return label || fallback
}

function orderedTransitRideRequired(request) {
  return request?.mode === 'transit'
}

function hasTransitRide(plan) {
  return (plan?.legs ?? []).some((leg) => leg?.type === 'ride')
}

function enforceOrderedSegmentMode(plan, request) {
  if (
    !orderedTransitRideRequired(request)
    || plan?.status !== 'ready'
    || hasTransitRide(plan)
  ) return plan

  const message = 'This leg resolved to walking only; an ordered Transit route requires at least one scheduled ride on every leg.'
  return {
    ...plan,
    status: 'blocked',
    travelMode: 'transit',
    title: 'No transit ride',
    detail: message,
    diagnostics: {
      ...(plan?.diagnostics ?? {}),
      fallbackReason: plan?.diagnostics?.algorithm ?? 'walk_only_component',
      failureCode: 'ordered_transit_ride_required',
      failureCategory: 'routing',
      failure: {
        code: 'ordered_transit_ride_required',
        category: 'routing',
        message,
        retryable: true,
      },
      orderedTransitRideRequired: true,
      walkOnlyCandidate: {
        planId: plan?.id ?? null,
        durationMinutes: finiteNumber(plan?.durationMinutes),
        distanceKm: (plan?.legs ?? [])
          .filter((leg) => leg?.type === 'walk')
          .reduce((sum, leg) => sum + Math.max(0, finiteNumber(leg?.distanceKm)), 0),
        algorithm: plan?.diagnostics?.algorithm ?? null,
      },
    },
  }
}

export function validateOrderedRoutingPoints(origin, waypoints, destination) {
  const points = [origin, ...(Array.isArray(waypoints) ? waypoints : []), destination]
  if (points.length < 2 || points.length > maximumOrderedRoutingPoints) {
    const error = new Error(`Ordered routing requires 2-${maximumOrderedRoutingPoints} points.`)
    error.code = 'VIGO_ORDERED_POINT_COUNT'
    error.statusCode = 400
    throw error
  }
  for (const [index, point] of points.entries()) {
    if (!point || !validCoordinate(point.coordinate)) {
      const error = new Error(`Routing point ${index + 1} has invalid coordinates.`)
      error.code = 'VIGO_ORDERED_POINT_COORDINATE'
      error.statusCode = 400
      throw error
    }
    if (index > 0 && sameCoordinate(points[index - 1].coordinate, point.coordinate)) {
      const error = new Error(`Routing points ${index} and ${index + 1} are duplicates.`)
      error.code = 'VIGO_DUPLICATE_CONSECUTIVE_POINT'
      error.statusCode = 400
      throw error
    }
  }
  return points
}

function appendDistinctCoordinates(left = [], right = []) {
  const coordinates = [...left]
  for (const coordinate of right) {
    const previous = coordinates.at(-1)
    if (
      !previous
      || Number(previous[0]) !== Number(coordinate?.[0])
      || Number(previous[1]) !== Number(coordinate?.[1])
    ) {
      coordinates.push(coordinate)
    }
  }
  return coordinates
}

function mergeThroughRide(left, right) {
  if (
    left?.type !== 'ride'
    || right?.type !== 'ride'
    || !left.tripId
    || left.tripId !== right.tripId
    || left.toStopId !== right.fromStopId
    || Math.abs(finiteNumber(left.endMinutes) - finiteNumber(right.startMinutes)) > 0.01
  ) {
    return null
  }
  return {
    ...left,
    toStopId: right.toStopId,
    toStationGroupId: right.toStationGroupId,
    toName: right.toName,
    endMinutes: right.endMinutes,
    durationMinutes: Math.max(0, finiteNumber(right.endMinutes) - finiteNumber(left.startMinutes)),
    distanceKm: Math.max(0, finiteNumber(left.distanceKm)) + Math.max(0, finiteNumber(right.distanceKm)),
    stopCount: Math.max(0, finiteNumber(left.stopCount)) + Math.max(0, finiteNumber(right.stopCount)),
    stopIds: Array.isArray(left.stopIds) && Array.isArray(right.stopIds)
      ? [...left.stopIds, ...right.stopIds.slice(1)] : undefined,
    coordinates: appendDistinctCoordinates(left.coordinates, right.coordinates),
    bridgedUntimedGapCount:
      finiteNumber(left.bridgedUntimedGapCount)
      + finiteNumber(right.bridgedUntimedGapCount)
      || undefined,
    sourceEqualTimeConnectionCount:
      finiteNumber(left.sourceEqualTimeConnectionCount)
      + finiteNumber(right.sourceEqualTimeConnectionCount)
      || undefined,
  }
}

function noOpWalk(leg) {
  return leg?.type === 'walk'
    && Math.max(0, finiteNumber(leg.durationMinutes)) <= 0.01
    && Math.max(0, finiteNumber(leg.distanceKm)) <= 0.000001
}

function combinedLegs(plans) {
  const legs = []
  for (const [segmentIndex, plan] of plans.entries()) {
    for (const leg of plan.legs ?? []) {
      if (noOpWalk(leg)) continue
      const throughRide = mergeThroughRide(legs.at(-1), leg)
      if (throughRide) {
        legs[legs.length - 1] = throughRide
      } else {
        legs.push({ ...leg, orderedSegmentIndex: segmentIndex })
      }
    }
  }
  return legs
}

function boardingCount(legs) {
  return legs.filter((leg) => leg.type === 'ride').length
}

function searchTime(plans, key) {
  return Number(plans
    .reduce((sum, plan) => sum + Math.max(0, finiteNumber(plan.diagnostics?.searchStats?.[key])), 0)
    .toFixed(3))
}

function timingPrecision(plans) {
  if (plans.some((plan) => plan.diagnostics?.timingPrecision === 'degraded')) return 'degraded'
  if (plans.some((plan) => plan.diagnostics?.timingPrecision === 'source-equal-time')) return 'source-equal-time'
  return 'exact'
}

function orderedRouteId(plans, points, request) {
  const pointKey = points
    .map((point) => `${Number(point.coordinate[0])},${Number(point.coordinate[1])}`)
    .join(';')
  return [
    'ordered',
    request.mode,
    request.timePreference,
    ...plans.map((plan) => plan.id),
    pointKey,
  ].join('|')
}

function orderedRouteTitle(mode, waypointCount) {
  if (mode === 'drive') return waypointCount === 1 ? 'Drive via 1 stop' : `Drive via ${waypointCount} stops`
  if (mode === 'walk') return waypointCount === 1 ? 'Walk via 1 stop' : `Walk via ${waypointCount} stops`
  return waypointCount === 1 ? 'Transit via 1 stop' : `Transit via ${waypointCount} stops`
}

export function composeOrderedRoutingFailure(failedPlan, failedIndex, points, componentPlans = []) {
  return {
    ...failedPlan,
    id: `ordered-blocked-${failedIndex + 1}-${failedPlan?.id ?? 'unknown'}`,
    origin: points[0],
    waypoints: points.slice(1, -1),
    destination: points.at(-1),
    title: `No route for leg ${failedIndex + 1}`,
    detail: `${routingPointLabel(points[failedIndex], `Point ${failedIndex + 1}`)} to ${routingPointLabel(points[failedIndex + 1], `Point ${failedIndex + 2}`)}: ${failedPlan?.detail ?? 'No route was found.'}`,
    diagnostics: {
      ...(failedPlan?.diagnostics ?? {}),
      searchStrategy: 'exact_waypoint_composition',
      algorithm: 'ordered_waypoint_composition',
      optimality: 'blocked_component_leg',
      failedOrderedSegmentIndex: failedIndex,
      componentPlanIds: componentPlans.filter(Boolean).map((plan) => plan.id),
    },
  }
}

export async function routeOrderedRoutingSegments(points, request, routeSegment) {
  if (!Array.isArray(points) || points.length < 2 || typeof routeSegment !== 'function') {
    throw new Error('Ordered segment routing requires points and a route callback.')
  }
  if (points.length > 2 && request?.mode !== 'walk' && request?.mode !== 'drive' && request?.maxTransfers !== undefined) {
    throw new Error('maxTransfers with ordered transit waypoints is not supported; omit the waypoints or the cap.')
  }
  const componentPlans = new Array(points.length - 1)
  if (request?.timePreference === 'arrive') {
    let nextArriveMinutes = Number(request?.arriveMinutes ?? request?.departMinutes ?? 8 * 60)
    for (let index = points.length - 2; index >= 0; index -= 1) {
      const segmentRequest = {
        ...request,
        origin: points[index],
        destination: points[index + 1],
        timePreference: 'arrive',
        arriveMinutes: nextArriveMinutes,
        departMinutes: nextArriveMinutes,
        departureWindowMinutes: 0,
      }
      const plan = enforceOrderedSegmentMode(
        await routeSegment(segmentRequest, index),
        segmentRequest,
      )
      componentPlans[index] = plan
      if (plan?.status !== 'ready') {
        return { componentPlans, failedIndex: index, failedPlan: plan }
      }
      nextArriveMinutes = Number(plan.departMinutes)
    }
  } else {
    let nextDepartMinutes = Number(request?.departMinutes ?? 8 * 60)
    for (let index = 0; index < points.length - 1; index += 1) {
      const segmentRequest = {
        ...request,
        origin: points[index],
        destination: points[index + 1],
        timePreference: 'depart',
        departMinutes: nextDepartMinutes,
        arriveMinutes: nextDepartMinutes,
        departureWindowMinutes: index === 0 ? request?.departureWindowMinutes : 0,
      }
      const plan = enforceOrderedSegmentMode(
        await routeSegment(segmentRequest, index),
        segmentRequest,
      )
      componentPlans[index] = plan
      if (plan?.status !== 'ready') {
        return { componentPlans, failedIndex: index, failedPlan: plan }
      }
      nextDepartMinutes = Number(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)
    }
  }
  return { componentPlans, failedIndex: -1, failedPlan: null }
}

export function composeOrderedRoutingPlans(plans, points, request = {}) {
  if (!Array.isArray(plans) || plans.length !== points.length - 1) {
    throw new Error('Ordered route composition requires one plan per adjacent point pair.')
  }
  const failedIndex = plans.findIndex((plan) => (
    plan?.status !== 'ready'
    || (orderedTransitRideRequired(request) && !hasTransitRide(plan))
  ))
  if (failedIndex >= 0) {
    return composeOrderedRoutingFailure(
      enforceOrderedSegmentMode(plans[failedIndex], request),
      failedIndex,
      points,
      plans,
    )
  }

  const legs = combinedLegs(plans)
  const first = plans[0]
  const last = plans.at(-1)
  const departMinutes = finiteNumber(first.departMinutes)
  const arriveMinutes = finiteNumber(last.arriveMinutes, finiteNumber(last.departMinutes) + finiteNumber(last.durationMinutes))
  const durationMinutes = Number(Math.max(0, arriveMinutes - departMinutes).toFixed(3))
  const walkMinutes = Number(legs
    .filter((leg) => leg.type === 'walk')
    .reduce((sum, leg) => sum + Math.max(0, finiteNumber(leg.durationMinutes)), 0)
    .toFixed(3))
  const rideMinutes = Number(legs
    .filter((leg) => leg.type !== 'walk')
    .reduce((sum, leg) => sum + Math.max(0, finiteNumber(leg.durationMinutes)), 0)
    .toFixed(3))
  const waitMinutes = Number(Math.max(0, durationMinutes - walkMinutes - rideMinutes).toFixed(3))
  const transfers = Math.max(0, boardingCount(legs) - 1)
  const waypointCount = points.length - 2
  const queryMs = searchTime(plans, 'queryMs')
  const engineQueryMs = searchTime(plans, 'engineQueryMs')
  const routeLabels = points.map((point, index) => routingPointLabel(point, `Point ${index + 1}`))

  return {
    ...first,
    id: orderedRouteId(plans, points, request),
    status: 'ready',
    travelMode: request.mode ?? first.travelMode,
    timePreference: request.timePreference ?? first.timePreference,
    choiceLabel: `Ordered ${points.length}-point route`,
    recommended: true,
    title: orderedRouteTitle(request.mode ?? first.travelMode, waypointCount),
    detail: routeLabels.join(' → '),
    departMinutes,
    arriveMinutes,
    durationMinutes,
    waitMinutes,
    walkMinutes,
    rideMinutes,
    transfers,
    origin: points[0],
    waypoints: points.slice(1, -1),
    destination: points.at(-1),
    snappedOrigin: first.snappedOrigin,
    snappedDestination: last.snappedDestination,
    legs,
    diagnostics: {
      ...last.diagnostics,
      originWalkKm: first.diagnostics?.originWalkKm,
      destinationWalkKm: last.diagnostics?.destinationWalkKm,
      timingPrecision: timingPrecision(plans),
      searchStrategy: 'exact_waypoint_composition',
      algorithm: 'ordered_waypoint_composition',
      optimality: 'exact_per_leg_for_fixed_user_order',
      sequenceOptimization: 'user_order_preserved',
      orderedPointCount: points.length,
      waypointCount,
      componentPlanIds: plans.map((plan) => plan.id),
      componentSearches: plans.length,
      searchStats: {
        ...(last.diagnostics?.searchStats ?? {}),
        queryMs,
        ...(engineQueryMs > 0 ? { engineQueryMs } : {}),
        componentSearches: plans.length,
      },
    },
  }
}
