import { stablePlanId } from './routing-plan-identity.mjs'
import { numeric as finiteNumber } from './number-utils.mjs'
import { validateArrivalBuffer } from './arrival-reserve.mjs'

const maximumOrderedRoutingPoints = 8
const maximumOrderedCandidates = 8

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
    // Extending the endpoints invalidates a boarding quote for the shorter leg.
    fare: undefined,
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
  return stablePlanId('ordered', {
    mode: request.mode, timePreference: request.timePreference,
    components: plans.map(plan => plan.id),
    points: points.map(point => point.coordinate.map(Number)),
  })
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

function orderedMetrics(plan, arriveBy) {
  return [arriveBy ? -plan.departMinutes : plan.arriveMinutes,
    boardingCount(plan.legs), plan.walkMinutes]
}

function compareOrdered(left, right, arriveBy) {
  const a = orderedMetrics(left.plan, arriveBy), b = orderedMetrics(right.plan, arriveBy)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    || left.plan.durationMinutes - right.plan.durationMinutes
    || left.plan.id.localeCompare(right.plan.id)
}

function orderedBoundary(plan, arriveBy) {
  const leg = arriveBy ? plan.legs[0] : plan.legs.at(-1)
  // On-board continuity can change the next boarding count. Do not discard
  // such a state merely because a different trip reaches this point earlier.
  return leg?.type === 'ride' ? `${leg.tripId}|${arriveBy ? leg.fromStopId : leg.toStopId}` : ''
}

function orderedFamily(plan) {
  return JSON.stringify(plan.legs.map(leg => [leg.orderedSegmentIndex, leg.type,
    leg.routeId, leg.fromStopId, leg.toStopId]))
}

function orderedFrontier(candidates, arriveBy, final) {
  const ranked = candidates.sort((a, b) => compareOrdered(a, b, arriveBy))
  const distinct = [...new Map(ranked.map(candidate => [candidate.plan.id, candidate])).values()]
  const frontier = distinct.filter((candidate, index) => !distinct.some((other, otherIndex) => {
    if (index === otherIndex || (!final && orderedBoundary(candidate.plan, arriveBy) !== orderedBoundary(other.plan, arriveBy))) return false
    const a = orderedMetrics(other.plan, arriveBy), b = orderedMetrics(candidate.plan, arriveBy)
    return a.every((value, i) => value <= b[i])
      && (a.some((value, i) => value < b[i]) || otherIndex < index)
  }))
  const limit = final ? 5 : maximumOrderedCandidates
  const selected = []
  const add = candidate => {
    if (candidate && !selected.includes(candidate) && selected.length < limit
      && (!final || !selected.some(other => orderedFamily(other.plan) === orderedFamily(candidate.plan)))) selected.push(candidate)
  }
  // Always preserve the earliest-arrival/latest-departure witness. Secondary
  // extrema keep a later walk available when it catches the same onward ride.
  add(frontier[0])
  for (const metric of [1, 2]) add([...frontier].sort((a, b) =>
    orderedMetrics(a.plan, arriveBy)[metric] - orderedMetrics(b.plan, arriveBy)[metric]
      || compareOrdered(a, b, arriveBy))[0])
  for (const candidate of frontier) add(candidate)
  return selected.sort((a, b) => compareOrdered(a, b, arriveBy))
}

export async function routeOrderedRoutingSegments(points, request, routeSegment) {
  validateArrivalBuffer(request, points?.length === 2)
  if (!Array.isArray(points) || points.length < 2 || typeof routeSegment !== 'function') {
    throw new Error('Ordered segment routing requires points and a route callback.')
  }
  if (points.length > 2 && request?.mode !== 'walk' && request?.mode !== 'drive' && request?.maxTransfers !== undefined) {
    throw new Error('maxTransfers with ordered transit waypoints is not supported; omit the waypoints or the cap.')
  }
  if (points.length > 2 && request?.mode !== 'walk' && request?.mode !== 'drive' && request?.minimumTransferBufferMinutes > 0) {
    throw new Error('minimumTransferBufferMinutes with ordered transit waypoints is not supported; omit the waypoints or set the buffer to zero.')
  }
  const arriveBy = request?.timePreference === 'arrive'
  const initialClock = Number(arriveBy ? request.arriveMinutes ?? request.departMinutes ?? 480 : request.departMinutes ?? 480)
  const indices = Array.from({ length: points.length - 1 }, (_, index) => index)
  if (arriveBy) indices.reverse()
  let states = [{ components: [], plan: null }]
  let segmentQueries = 0, peakCandidates = 1
  for (const index of indices) {
    const queryCache = new Map()
    const candidates = []
    let failure
    for (const state of states) {
      const clock = state.plan
        ? arriveBy ? state.plan.departMinutes : state.plan.arriveMinutes
        : initialClock
      const segmentRequest = {
        ...request,
        origin: points[index],
        destination: points[index + 1],
        timePreference: arriveBy ? 'arrive' : 'depart',
        departMinutes: clock,
        arriveMinutes: clock,
        departureWindowMinutes: 0,
        includeEarliestTransit: false,
        __allowSubMinuteTimes: state.components.length > 0,
      }
      if (!queryCache.has(clock)) {
        queryCache.set(clock, await routeSegment(segmentRequest, index))
        segmentQueries += 1
      }
      const response = queryCache.get(clock)
      const preferred = response?.plan ?? response
      const choices = response?.choices?.length ? response.choices : [preferred]
      failure ??= { componentPlans: state.components, failedIndex: index, failedPlan: preferred }
      for (const plan of choices) {
        if (plan?.status !== 'ready') continue
        if (!Number.isFinite(plan.departMinutes) || !Number.isFinite(plan.arriveMinutes)
          || plan.arriveMinutes < plan.departMinutes
          || (arriveBy ? plan.arriveMinutes > clock + 0.001 : plan.departMinutes < clock - 0.001)) {
          throw new Error('Ordered route component violates its waypoint clock.')
        }
        const components = arriveBy ? [plan, ...state.components] : [...state.components, plan]
        const coveredPoints = arriveBy ? points.slice(index) : points.slice(0, index + 2)
        candidates.push({ components, plan: composeOrderedRoutingPlans(components, coveredPoints, request) })
      }
    }
    if (!candidates.length) return failure
    const final = index === indices.at(-1)
    states = orderedFrontier(candidates, arriveBy, final)
    peakCandidates = Math.max(peakCandidates, states.length)
  }
  const choices = states.map(({ plan }, index) => ({
    ...plan, recommended: index === 0,
    choiceLabel: plan.travelMode === 'walk' ? 'Walk only'
      : index === 0 ? arriveBy ? 'Latest departure' : 'Earliest arrival' : 'Alternative journey',
    diagnostics: { ...plan.diagnostics, orderedSearch: {
      segmentQueries, peakCandidates, candidateLimit: maximumOrderedCandidates,
      alternatives: 'bounded_waypoint_frontier',
    } },
  }))
  return { componentPlans: states[0].components, choices, failedIndex: -1, failedPlan: null }
}

export function composeOrderedRoutingPlans(plans, points, request = {}) {
  if (!Array.isArray(plans) || plans.length !== points.length - 1) {
    throw new Error('Ordered route composition requires one plan per adjacent point pair.')
  }
  const failedIndex = plans.findIndex(plan => plan?.status !== 'ready')
  if (failedIndex >= 0) {
    return composeOrderedRoutingFailure(
      plans[failedIndex],
      failedIndex,
      points,
      plans,
    )
  }

  const dataSources = plans.map(plan => plan.diagnostics?.routingDataProvenance)
  const commonClock = request.serviceDate && plans.every(plan => plan.diagnostics?.orderedClockDate === request.serviceDate)
  if (dataSources.some(Boolean)) {
    const identities = dataSources.map(data => JSON.stringify(data && [
      data.mode, data.staticTimetableIdentity, data.streetIdentity,
      commonClock ? request.serviceDate : data.serviceDate, data.timeZone, data.snapshotId ?? null,
    ]))
    if (identities.some(identity => identity !== identities[0])) {
      const error = new Error('Routing data changed between journey legs. Calculate the complete journey again.')
      error.code = 'routing_snapshot_changed'
      error.statusCode = 409
      throw error
    }
  }
  const combinedData = dataSources[0] ? {
    ...dataSources[0],
    ...(commonClock ? { serviceDate: request.serviceDate, componentServiceDates: dataSources.map(data => data.serviceDate) } : {}),
    requestedTimeMinutes: request.timePreference === 'arrive'
      ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes : request.departMinutes,
    componentReproducibilityKeys: dataSources.map(data => data.reproducibilityKey),
    reproducibilityKey: stablePlanId('ordered-data', { points,
      components: dataSources.map(data => data.reproducibilityKey) }),
  } : null
  const legs = combinedLegs(plans)
  const travelMode = legs.some(leg => leg.type === 'ride') ? 'transit'
    : legs.some(leg => leg.type === 'drive') ? 'drive' : 'walk'
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
    travelMode,
    timePreference: request.timePreference ?? first.timePreference,
    choiceLabel: `Ordered ${points.length}-point route`,
    recommended: true,
    title: orderedRouteTitle(travelMode, waypointCount),
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
      departureWindow: undefined,
      departurePresentation: first.diagnostics?.departurePresentation,
      ...(combinedData ? { routingDataProvenance: combinedData } : {}),
      originWalkKm: first.diagnostics?.originWalkKm,
      destinationWalkKm: last.diagnostics?.destinationWalkKm,
      timingPrecision: timingPrecision(plans),
      searchStrategy: 'exact_waypoint_composition',
      algorithm: 'ordered_waypoint_composition',
      optimality: 'best_objective_within_bounded_waypoint_frontier',
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
