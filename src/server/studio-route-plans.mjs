import crypto from 'node:crypto'
import { haversineKm } from './geometry-utils.mjs'
import { directWalkEndToEndLimitKm, nationalRoutingAccessPolicy, routingHorizonMinutes } from './gtfs/routing-policy.mjs'

// Studio's Route tool asks the native runtime and presents its detailed Result
// in Studio's journey shape. Every choice, clock and label comes from the
// runtime; this module translates field names and writes display text only.

const minutes = value => Number(Number(value).toFixed(3))
const walkingSpeedKph = 4.8
const studioPointFields = ['stopId', 'coordinate', 'id', 'name', 'label', 'source', 'editStatus', 'baselineStopId', 'baselineStopIndex']
const expandedWalkKm = 2.4

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function planId(prefix, payload) {
  const digest = crypto.createHash('sha256').update(stableJson(payload)).digest()
  return `${prefix}-${digest.readBigUInt64BE(0).toString(36)}`
}

function routePoint(point) {
  return Object.fromEntries(studioPointFields.filter(key => point?.[key] !== undefined).map(key => [key, point[key]]))
}

/**
 * The public route request for a Studio Route body. `context` supplies what
 * the project decides: the City case's source scopes, the wheelchair City,
 * and the compiled scenario overlay.
 */
export function nativeRouteRequest(body, context = {}) {
  const mode = ['walk', 'drive'].includes(body.mode) ? body.mode : 'transit'
  const arrive = body.timePreference === 'arrive'
  const waypoints = Array.isArray(body.waypoints) ? body.waypoints : []
  const transit = mode === 'transit'
  const window = transit && !waypoints.length ? Number(body.departureWindowMinutes ?? 0) : 0
  const departNow = transit && body.departNow === true
  const request = {
    kind: 'route',
    mode,
    origin: routePoint(body.origin),
    destination: routePoint(body.destination),
    ...(waypoints.length ? { via: waypoints.map(routePoint) } : {}),
    ...(departNow ? { departNow: true } : {
      serviceDate: body.serviceDate,
      timeMinutes: Number(arrive ? body.arriveMinutes ?? body.departMinutes : body.departMinutes),
      timePreference: arrive ? 'arrive_by' : 'depart_at',
    }),
    ...Object.fromEntries(['maxWalkKm', 'maxStreetKm', 'maxTransfers', 'allowLongWalk', 'allowStreetTransfers',
      'minimumTransferBufferMinutes', 'horizonMinutes']
      .filter(key => body[key] !== undefined && body[key] !== null).map(key => [key, body[key]])),
  }
  if (transit) {
    Object.assign(request, {
      requireTransitRide: body.requireTransitRide === true,
      requireCompleteServiceCoverage: true,
      // Without a snapshot, a realtime request runs on the schedule.
      routingDataMode: body.routingDataMode === 'realtime' && body.realtimeSnapshot ? 'realtime' : 'scheduled',
      ...(body.realtimeSnapshot ? { realtimeSnapshot: body.realtimeSnapshot } : {}),
      ...(context.sourceScopes ? { sourceScopes: context.sourceScopes } : {}),
      ...(context.wheelchair ? { wheelchair: true } : {}),
      ...(context.scenario ? { scenario: context.scenario } : {}),
      ...(body.sharedLegs === true && !waypoints.length ? { sharedLegs: true } : {}),
      ...(body.includeEarliestTransit === true && !waypoints.length ? { includeEarliestTransit: true } : {}),
    })
    if (arrive && window > 0) {
      // Earlier arrivals: the latest departure for each earlier deadline.
      request.windowMinutes = window
    } else if (window > 0 || waypoints.length) {
      Object.assign(request, { ...(window > 0 ? { windowMinutes: window } : {}), windowChoices: 'supported' })
      if (body.includeRankedAlternatives === true) {
        Object.assign(request, { alternatives: 9, alternativeRanking: 'ranked', alternativeSlackMinutes: 15 })
      }
    }
    if (body.autoExpandWalking === true && !context.wheelchair && !waypoints.length
      && Number(body.maxWalkKm ?? 1.2) < expandedWalkKm) {
      request.expandedWalkKm = expandedWalkKm
    }
  }
  // Street waypoints are composed segment by segment like transit ones.
  if (!transit && waypoints.length) request.windowChoices = 'supported'
  if (!transit && body.walkSpeedKph !== undefined) request.walkSpeedKph = body.walkSpeedKph
  if (mode === 'drive') {
    const traffic = body.routingDataMode === 'realtime' ? body.traffic : undefined
    request.routingDataMode = traffic ? 'realtime' : 'scheduled'
    if (traffic) request.traffic = traffic
  }
  return request
}

function boardingSummary(legs) {
  const rides = legs.filter(leg => leg.type === 'ride')
  const labels = rides.map(leg => String(leg.routeShortName || leg.routeId || '').trim()).filter(Boolean)
  const boardings = rides.filter(leg => leg.inSeatSeconds == null).length
  return { boardings, transfers: Math.max(0, boardings - 1), title: labels.join(' -> ') }
}

// Walks between two rides: an interchange, or a change between vehicles of one line.
function transferSemantics(legs) {
  return legs.map((leg, index) => {
    if (leg.type !== 'walk' || leg.walkSource !== 'transfer') return leg
    const previous = legs.slice(0, index).findLast(candidate => candidate.type === 'ride')
    const next = legs.slice(index + 1).find(candidate => candidate.type === 'ride')
    if (!previous || !next) return leg
    const previousLabel = String(previous.routeShortName || previous.routeId || '').trim()
    const nextLabel = String(next.routeShortName || next.routeId || '').trim()
    return {
      ...leg,
      transferAction: previousLabel && previousLabel === nextLabel ? 'same-route-change' : 'interchange',
      connectingRouteShortName: nextLabel || undefined,
    }
  })
}

function timingDetail(durationMinutes, { scheduleMode, unverifiedStationAccessLegs, bridgedUntimedGapCount, sourceEqualTimeRideCount }) {
  const station = unverifiedStationAccessLegs > 0 ? ' / station access unverified' : ''
  if (bridgedUntimedGapCount) {
    return `${Math.round(durationMinutes)} min / interpolated stop-time gap / degraded timing precision${station}`
  }
  const timetable = scheduleMode === 'realtime-adjusted'
    ? `${Math.round(durationMinutes)} min / live predictions and scheduled times`
    : `${Math.round(durationMinutes)} min / exact local timetable`
  if (!sourceEqualTimeRideCount) return timetable + station
  return `${timetable}${station} / ${sourceEqualTimeRideCount} ${sourceEqualTimeRideCount === 1 ? 'ride' : 'rides'} published within one timestamp`
}

function walkSource(leg, index, count) {
  if (leg.geometrySource === 'coordinate-snap') return 'direct'
  if (leg.geometrySource === 'station_selection') return 'station-selection'
  if (leg.transferSource || (leg.fromStopId && leg.toStopId)) return 'transfer'
  return index === 0 || index === count - 1 ? 'osm-rust' : 'transfer'
}

function studioLeg(leg, index, count, body) {
  const startMinutes = minutes(leg.departureMinutes)
  const endMinutes = minutes(leg.arrivalMinutes)
  const shared = {
    from: leg.from, to: leg.to, departure: leg.departure, arrival: leg.arrival,
    fromName: leg.from?.name ?? (index === 0 ? body.origin?.label : leg.fromStopId) ?? '',
    toName: leg.to?.name ?? (index === count - 1 ? body.destination?.label : leg.toStopId) ?? '',
    startMinutes,
    endMinutes,
    durationMinutes: minutes(leg.arrivalMinutes - leg.departureMinutes),
    distanceKm: Number.isFinite(leg.distanceMeters) ? leg.distanceMeters / 1000 : 0,
    coordinates: leg.coordinates ?? [],
    ...(leg.geometrySource ? { geometrySource: leg.geometrySource } : {}),
    ...(Number.isInteger(leg.orderedSegmentIndex) ? { orderedSegmentIndex: leg.orderedSegmentIndex } : {}),
  }
  if (leg.kind === 'drive') {
    return { type: 'drive', travelMode: 'drive', ...shared, stopCount: 0, streetPathVerified: true }
  }
  if (leg.kind !== 'ride') {
    const connector = leg.endpointConnector?.coordinates
    const source = walkSource(leg, index, count)
    return {
      type: 'walk', travelMode: 'walk', walkSource: source,
      ...(leg.fromStopId ? { fromStopId: leg.fromStopId } : {}),
      ...(leg.toStopId ? { toStopId: leg.toStopId } : {}),
      ...shared, stopCount: 0,
      ...Object.fromEntries(['transferSource', 'streetPathVerified', 'streetSegmentVerified', 'stationAccessStatus',
        'stationAccessStopIds', 'stationPathSources', 'accessCost', 'stationGeometryStatus', 'stationDistanceStatus']
        .filter(key => leg[key] !== undefined && leg[key] !== null).map(key => [key, leg[key]])),
      ...(connector?.length === 2 ? { endpointConnector: { source: 'coordinate-snap', streetPathVerified: false,
        coordinates: connector, distanceKm: haversineKm(connector[0], connector[1]) } } : {}),
    }
  }
  const route = leg.route ?? {}
  const calls = [{ stopId: leg.fromStopId, departure: leg.departure }, ...(leg.intermediateStops ?? []),
    { stopId: leg.toStopId, arrival: leg.arrival }]
  const sourceEqualTimeConnectionCount = calls.slice(1).filter((call, previous) => (
    call.arrival === calls[previous].departure && call.stopId !== calls[previous].stopId)).length
  return {
    type: 'ride', travelMode: 'transit',
    scheduleMode: leg.realtimeTrip ? 'realtime-adjusted' : leg.bridgedUntimedGapCount ? 'interpolated-stop-time-gap' : 'exact',
    fromStopId: leg.fromStopId, toStopId: leg.toStopId,
    ...(leg.fromStationGroupId ? { fromStationGroupId: leg.fromStationGroupId } : {}),
    ...(leg.toStationGroupId ? { toStationGroupId: leg.toStationGroupId } : {}),
    route: leg.route, serviceId: leg.serviceId, serviceDate: leg.serviceDate, tripShortName: leg.tripShortName,
    routeFeatureId: leg.routeId, routeId: leg.routeId, routeType: route.type ?? undefined,
    routeShortName: route.shortName || route.longName || leg.routeId, routeColor: route.color || undefined,
    tripId: leg.tripId, directionId: leg.directionId ?? undefined,
    headsign: leg.headsign ?? undefined,
    ...(leg.inSeatSeconds != null ? { inSeatSeconds: leg.inSeatSeconds } : {}),
    ...shared, stopIds: leg.stopIds, stopCount: leg.stopCount,
    ...(leg.intermediateStops ? { intermediateStops: leg.intermediateStops } : {}),
    ...(leg.shapeId ? { shapeId: leg.shapeId } : {}),
    ...(leg.bridgedUntimedGapCount ? { bridgedUntimedGapCount: leg.bridgedUntimedGapCount } : {}),
    ...(sourceEqualTimeConnectionCount ? { sourceEqualTimeConnectionCount } : {}),
    ...(leg.sourceEqualTime === true ? {
      sourceEqualTime: true,
      sourceTimestampQuality: leg.departure % 60 === 0 && leg.arrival % 60 === 0 ? 'equal-whole-minute' : 'equal-time',
    } : {}),
    ...(leg.scenarioService ? { scenarioService: leg.scenarioService, geometrySource: 'scenario_plan' } : {}),
    ...(leg.realtimeTrip ? { realtimeTrip: true } : {}),
    ...(leg.alerts ? { alerts: leg.alerts } : {}),
    ...(leg.fare ? { fare: leg.fare } : {}),
  }
}

function realtimeRouting(realtime) {
  if (!realtime || typeof realtime !== 'object') return undefined
  return {
    ...realtime,
    coverage: realtime.coverage ? { inputUpdates: realtime.feedTripUpdates ?? 0, prunedUpdates: 0, ...realtime.coverage } : undefined,
  }
}

// A realtime request with no snapshot to apply runs on the schedule.
const scheduledFallback = {
  mode: 'full-snapshot', status: 'scheduled_fallback', fallbackReason: 'realtime_snapshot_unavailable',
  appliedTrips: 0, canceledTrips: 0,
  coverage: { inputUpdates: 0, appliedUpdates: 0, rejectedUpdates: 0, prunedUpdates: 0, complete: false },
}

// The data and settings a journey depends on, with a key that changes
// whenever any of them would.
function provenance(trace, body, context, { serviceDate, requested, realtime, arrive }) {
  const record = {
    schemaVersion: 'vigo.routing.data-provenance.v1',
    mode: requested ? 'realtime' : 'scheduled',
    engineVersion: 'vigo.routing.timetable.v1',
    staticTimetableIdentity: context.staticTimetableIdentity ?? null,
    streetIdentity: context.streetIdentity ?? null,
    serviceDate,
    timeZone: context.timeZone ?? trace.timeZone ?? 'UTC',
    serviceDay: body.serviceDay,
    timePreference: arrive ? 'arrive' : 'depart',
    requestedTimeMinutes: arrive ? body.arriveMinutes ?? body.departMinutes : body.departMinutes,
    walkingPolicy: { ...nationalRoutingAccessPolicy },
    searchParameters: {
      travelMode: body.mode ?? 'transit',
      objective: 'earliest_arrival',
      maxWalkKm: body.maxWalkKm,
      directWalkLimitKm: directWalkEndToEndLimitKm(body),
      requireTransitRide: body.requireTransitRide === true,
      maxTransfers: body.maxTransfers ?? null,
      allowStreetTransfers: body.allowStreetTransfers !== false,
      minimumTransferBufferMinutes: body.minimumTransferBufferMinutes ?? 0,
      horizonMinutes: routingHorizonMinutes(body),
      serviceDateFallbackAllowed: body.allowServiceDateFallback === true,
      requireCompleteServiceCoverage: true,
      transferSemanticsVersion: context.dataSemantics?.transferSemanticsVersion ?? null,
    },
    realtimeApplied: realtime,
    cityRevision: trace.cityRevision ?? null,
  }
  return { ...record, reproducibilityKey: crypto.createHash('sha256')
    .update(stableJson({ provenance: record, origin: body.origin, destination: body.destination })).digest('hex') }
}

// What every plan of one Result shares: its service date, data and timing.
function resultDiagnostics(trace, body, context) {
  const arrive = body.timePreference === 'arrive'
  const serviceDate = trace.serviceDate ?? body.serviceDate ?? null
  const realtime = trace.dataMode === 'realtime'
  const requested = realtime || body.routingDataMode === 'realtime'
  return {
    serviceDay: body.serviceDay ?? 'weekday',
    serviceDate,
    requestedServiceDate: serviceDate,
    resolvedServiceDate: serviceDate,
    serviceDateFallbackApplied: false,
    walkingNetwork: 'osm',
    ...(trace.walkingAccessPermission ? { walkingAccessPermission: trace.walkingAccessPermission } : {}),
    walkingSpeedKph,
    routingDataMode: requested ? 'realtime' : 'scheduled',
    ...(realtime ? { realtimeRouting: realtimeRouting(trace.diagnostics?.realtime) }
      : requested ? { realtimeRouting: scheduledFallback } : {}),
    routingDataProvenance: provenance(trace, body, context, { serviceDate, requested, realtime, arrive }),
    dataSemantics: context.dataSemantics ?? {},
    searchStats: {
      queryMs: Number(Number(trace.timing?.totalMs ?? 0).toFixed(3)),
      ...(Number.isFinite(trace.diagnostics?.native?.queryNs)
        ? { engineQueryMs: Number((trace.diagnostics.native.queryNs / 1e6).toFixed(3)) } : {}),
    },
    routingStatus: 'ready',
    routingStatusSchemaVersion: 'vigo.routing.status.v1',
    methodState: 'complete',
    runtime: 'rust',
  }
}

const earlierArrivals = trace => trace.window?.direction === 'earlier_arrival_deadlines'

function windowDiagnostics(trace, plan) {
  const window = trace.window
  return {
    ...(window && !earlierArrivals(trace)
      ? { departureWindow: { centerMinutes: window.startMinutes, beforeMinutes: 0, afterMinutes: window.minutes } }
      : {}),
    ...(plan.windowSample ? { windowSample: plan.windowSample } : {}),
    ...(plan.choiceSupport ? { choiceSupport: plan.choiceSupport } : {}),
    ...(plan.selectedTimeChoice !== undefined ? { selectedTimeChoice: plan.selectedTimeChoice } : {}),
    ...(plan.returnedStationCycle ? { returnedStationCycle: plan.returnedStationCycle } : {}),
    ...(plan.expandedWalkingLimitKm ? { expandedWalkingLimitKm: plan.expandedWalkingLimitKm } : {}),
  }
}

function streetPlan(raw, trace, body, context) {
  if (!raw.legs?.length) return null
  const mode = raw.mode === 'drive' ? 'drive' : 'walk'
  const timePreference = body.timePreference === 'arrive' ? 'arrive' : 'depart'
  const departMinutes = minutes(raw.departureMinutes)
  const arriveMinutes = minutes(raw.arrivalMinutes)
  const durationMinutes = minutes(raw.arrivalMinutes - raw.departureMinutes)
  const legs = raw.legs.map((leg, index) => ({
    ...studioLeg(leg, index, raw.legs.length, body),
    ...(leg.kind === 'walk' ? { walkSource: leg.streetPathVerified === true ? 'osm' : 'direct' } : {}),
  }))
  const distanceKm = legs.reduce((sum, leg) => sum + leg.distanceKm, 0)
  const walkMinutes = minutes(legs.filter(leg => leg.type === 'walk').reduce((sum, leg) => sum + leg.durationMinutes, 0))
  const driveMinutes = minutes(legs.filter(leg => leg.type === 'drive').reduce((sum, leg) => sum + leg.durationMinutes, 0))
  const toName = String(body.destination?.label ?? 'Destination')
  const streetMode = body.mode === 'walk' || body.mode === 'drive'
  const trafficApplied = mode === 'drive' && raw.diagnostics?.traffic?.status === 'applied'
  // A street-mode request names its own route; a transit request reports a winning walk.
  const [label, title, detail] = streetMode
    ? [mode === 'drive' ? (trafficApplied ? 'Fastest drive · live traffic' : 'Fastest drive') : 'Direct walk',
      `${mode === 'drive' ? 'Drive' : 'Walk'} to ${toName}`,
      `${distanceKm.toFixed(distanceKm < 10 ? 2 : 1)} km · ${Math.max(1, Math.round(durationMinutes))} min`]
    : [raw.alternativeStrategy ? 'Walk only' : 'Walk instead', raw.alternativeStrategy ? 'Walk only' : 'Walk instead',
      `${Math.max(1, Math.round(durationMinutes))} min / direct OSM walk`]
  return {
    id: planId(`national-${mode}`, { serviceDate: body.serviceDate ?? '', timePreference, departMinutes, arriveMinutes,
      origin: body.origin, destination: body.destination, coordinates: legs.map(leg => leg.coordinates) }),
    status: 'ready', travelMode: mode, timePreference, maxWalkKm: streetMode && mode === 'walk' ? body.maxStreetKm ?? body.maxWalkKm : body.maxWalkKm,
    scheduleMode: 'none', choiceLabel: raw.choiceLabel ?? label, recommended: raw.recommended ?? true, title, detail,
    departMinutes, arriveMinutes, durationMinutes, waitMinutes: 0,
    walkMinutes, rideMinutes: driveMinutes, transfers: 0,
    origin: body.origin, destination: body.destination, legs,
    diagnostics: {
      ...resultDiagnostics(trace, body, context),
      ...windowDiagnostics(trace, raw),
      scheduleMode: 'none', searchProfile: 'fastest', searchStrategy: 'exact',
      ...(mode === 'walk' ? { walkingPolicyId: 'vigo-national-direct-physical-walk' } : {}),
      algorithm: mode === 'drive' ? 'rust_exact_drive_search' : 'rust_direct_walk',
      optimality: mode === 'drive' ? 'exact_drive_time' : 'graph_verified_direct_walk',
      originStreetPathVerified: legs[0].streetPathVerified === true,
      destinationStreetPathVerified: legs.at(-1).streetPathVerified === true,
      ...(mode === 'walk' ? { directWalkDistanceKm: distanceKm } : {}),
      ...(mode === 'drive' ? { roadMetricMode: trafficApplied ? 'traffic-adjusted' : 'free-flow',
        ...(raw.diagnostics?.traffic ? { traffic: raw.diagnostics.traffic } : {}) } : {}),
    },
  }
}

function transitPlan(raw, trace, body, context, substitute = false) {
  if (!Array.isArray(raw.legs) || !raw.legs.some(leg => leg.kind === 'ride')) return null
  const arrive = body.timePreference === 'arrive'
  const legs = transferSemantics(raw.legs.map((leg, index) => studioLeg(leg, index, raw.legs.length, body)))
  const rides = legs.filter(leg => leg.type === 'ride')
  const walkMinutes = minutes(legs.filter(leg => leg.type === 'walk').reduce((sum, leg) => sum + leg.durationMinutes, 0))
  const rideMinutes = minutes(rides.reduce((sum, leg) => sum + leg.durationMinutes + (leg.inSeatSeconds ?? 0) / 60, 0))
  const departMinutes = Number(raw.departureMinutes)
  // The journey starts at its exact departure clock, as the plan does.
  if (Math.abs(legs[0].startMinutes - departMinutes) < 0.001) legs[0] = { ...legs[0], startMinutes: departMinutes }
  const arriveMinutes = minutes(raw.arrivalMinutes)
  const durationMinutes = minutes(raw.arrivalMinutes - raw.departureMinutes)
  const waitMinutes = Math.max(0, minutes(durationMinutes - walkMinutes - rideMinutes))
  const bridgedUntimedGapCount = rides.reduce((sum, leg) => sum + (leg.bridgedUntimedGapCount ?? 0), 0)
  const sourceEqualTimeRideCount = rides.filter(leg => leg.sourceEqualTime).length
  const scheduleMode = rides.some(leg => leg.realtimeTrip) ? 'realtime-adjusted'
    : bridgedUntimedGapCount ? 'interpolated-stop-time-gap' : 'exact'
  const stationAccessLegs = legs.filter(leg => leg.stationAccessStatus).length
  const unverifiedStationAccessLegs = legs.filter(leg => leg.stationAccessStatus === 'unverified').length
  const summary = boardingSummary(legs)
  const objective = arrive ? 'latest_departure' : 'earliest_arrival'
  return {
    id: planId('national-rust', {
      serviceDate: trace.serviceDate ?? body.serviceDate, timePreference: arrive ? 'arrive' : 'depart',
      departMinutes, arriveMinutes, origin: body.origin, destination: body.destination,
      legs: legs.map(leg => [leg.type, leg.walkSource ?? '', leg.tripId ?? '', leg.fromStopId ?? '', leg.toStopId ?? '',
        leg.startMinutes, leg.endMinutes]),
    }),
    status: 'ready', travelMode: 'transit', timePreference: arrive ? 'arrive' : 'depart',
    maxWalkKm: raw.expandedWalkingLimitKm ?? body.maxWalkKm, scheduleMode,
    choiceLabel: raw.choiceLabel ?? (substitute ? 'Shared-leg service' : arrive ? 'Latest departure' : 'Earliest arrival'),
    recommended: raw.recommended ?? !substitute,
    title: summary.title || 'Transit',
    detail: timingDetail(durationMinutes, { scheduleMode, unverifiedStationAccessLegs, bridgedUntimedGapCount, sourceEqualTimeRideCount }),
    departMinutes, arriveMinutes, durationMinutes, waitMinutes, walkMinutes, rideMinutes,
    transfers: summary.transfers, origin: body.origin, destination: body.destination,
    ...(Array.isArray(body.waypoints) && body.waypoints.length ? { waypoints: body.waypoints } : {}),
    legs,
    ...(raw.sharedLegAlternatives ? { sharedLegAlternatives: {
      ...raw.sharedLegAlternatives,
      options: (raw.sharedLegAlternatives.options ?? []).flatMap(option => {
        const plan = transitPlan(option.plan, trace, body, context, true)
        return plan ? [{ ...option, plan }] : []
      }),
    } } : {}),
    diagnostics: {
      walkingPolicyId: nationalRoutingAccessPolicy.id,
      stationAccessStatus: unverifiedStationAccessLegs ? 'unverified' : stationAccessLegs ? 'source_path' : 'not_required',
      stationAccessLegs,
      unverifiedStationAccessLegs,
      ...(legs[0].type === 'walk' ? { originWalkKm: legs[0].distanceKm } : {}),
      ...(legs.at(-1).type === 'walk' ? { destinationWalkKm: legs.at(-1).distanceKm } : {}),
      scannedDepartures: trace.diagnostics?.native?.scannedDepartures ?? 0,
      relaxedStops: trace.diagnostics?.native?.relaxedStops ?? 0,
      ...resultDiagnostics(trace, body, context),
      ...windowDiagnostics(trace, raw),
      scheduleMode,
      timingPrecision: bridgedUntimedGapCount ? 'degraded' : sourceEqualTimeRideCount ? 'source-equal-time' : 'exact',
      sourceEqualTimeRideCount,
      bridgedUntimedGapCount,
      originStreetPathVerified: legs[0].type !== 'walk' || legs[0].walkSource === 'station-selection' || legs[0].streetPathVerified === true,
      destinationStreetPathVerified: legs.at(-1).type !== 'walk' || legs.at(-1).walkSource === 'station-selection'
        || legs.at(-1).streetPathVerified === true,
      searchProfile: raw.windowSample ? 'pareto' : 'fastest', searchStrategy: 'exact',
      algorithm: 'rust_standalone_connection_scan',
      optimality: substitute ? 'feasible_shared_leg_substitution'
        : `lexicographic_${objective}_then_boardings_then_walking_within_active_service_and_access_model`,
      methodRequested: 'rust_standalone_runtime',
      methodUsed: 'rust_standalone_runtime',
    },
  }
}

const accessFailures = {
  access_budget_exceeded: ['Walking limit exceeded',
    'A station access candidate exists beyond the selected walking limit. Increasing the limit may allow a journey; a complete transit itinerary has not been verified.'],
  street_access_unverified: ['Street access unverified',
    'Nearby transit stops exist, but no pedestrian access path was verified within the diagnostic search limit. A longer path or missing street connections may explain this result.'],
  access_unreachable: ['No access within search limits',
    'At least one endpoint has no station access candidate within the bounded diagnostic search. This does not establish that no longer path exists.'],
}

// The runtime's endpoint probe, as Studio's access hints report it.
const availabilityStatus = {
  outside_selected_budget: 'outside_selected_budget',
  street_access_unverified: 'street_access_unverified',
}

function accessAvailability(trace, body) {
  return ['origin', 'destination'].flatMap(role => {
    const access = trace.access?.[role]
    if (!access || access.code === 'available') return []
    return [{
      role, status: availabilityStatus[access.code] ?? 'none_within_probe',
      selectedWalkKm: Number(body.maxWalkKm ?? 1.2),
      probeWalkKm: Number(access.probeWalkMeters ?? access.maximumWalkMeters ?? 0) / 1000,
      ...(Number.isFinite(access.suggestedWalkMeters) ? {
        requiredWalkKm: access.suggestedWalkMeters / 1000,
        suggestedMaxWalkKm: Math.min(5, Math.ceil(access.suggestedWalkMeters / 100) / 10),
      } : {}),
      ...(access.nearestStop ? { nearestStop: access.nearestStop } : {}),
      strategy: access.nearestStop ? 'stop-index-plus-street-frontier' : 'osm-street-frontier-probe',
    }]
  })
}

/** Which access failure the endpoints' probes establish, if any. */
function accessFailure(availability) {
  const statuses = availability.map(hint => hint.status)
  if (!statuses.length) return null
  if (statuses.every(status => status === 'outside_selected_budget')) return 'access_budget_exceeded'
  if (statuses.includes('street_access_unverified')
    && statuses.every(status => ['street_access_unverified', 'outside_selected_budget'].includes(status))) {
    return 'street_access_unverified'
  }
  return 'access_unreachable'
}

/** A Studio plan for a Result without a journey, explaining why. */
function blockedPlan(raw, trace, body, context, failure) {
  const availability = accessAvailability(trace, body)
  const access = accessFailure(availability) ?? (raw.reason === 'no_access' ? 'access_unreachable' : null)
  const [code, title, detail] = failure ?? (access ? [access, ...accessFailures[access]]
    : ['no_path', 'No scheduled path', 'No exact itinerary was found within the selected search limits.'])
  const arrive = body.timePreference === 'arrive'
  // An arrive-by failure reports the start of its search horizon.
  const departMinutes = arrive
    ? Math.max(0, Number(body.arriveMinutes ?? body.departMinutes ?? 0) - Number(body.horizonMinutes ?? 480))
    : Number(raw.departureMinutes ?? body.departMinutes ?? 0)
  const category = code === 'no_path' ? 'routing' : code === 'coverage_incomplete' ? 'data_coverage'
    : code === 'service_inactive' ? 'service' : code === 'unsupported_mode' ? 'unsupported_feature' : 'access'
  return {
    id: planId('national-blocked', { failure: code, serviceDate: body.serviceDate, departMinutes,
      maxWalkKm: body.maxWalkKm, origin: body.origin, destination: body.destination }),
    status: 'blocked', travelMode: ['walk', 'drive'].includes(body.mode) ? body.mode : 'transit',
    timePreference: body.timePreference === 'arrive' ? 'arrive' : 'depart', maxWalkKm: body.maxWalkKm,
    choiceLabel: arrive ? 'No arrive-by itinerary' : 'No exact itinerary', recommended: true, title, detail, departMinutes,
    durationMinutes: 0, waitMinutes: 0, walkMinutes: 0, rideMinutes: 0, transfers: 0,
    origin: body.origin, destination: body.destination, legs: [],
    diagnostics: {
      ...resultDiagnostics(trace, body, context),
      ...windowDiagnostics(trace, raw),
      scannedDepartures: 0, relaxedStops: 0, scheduleMode: 'none', searchProfile: 'fastest', searchStrategy: 'not_run',
      algorithm: 'rust_standalone_connection_scan', optimality: 'not_applicable',
      routingStatus: category === 'unsupported_feature' ? 'unsupported' : 'blocked',
      methodState: category === 'unsupported_feature' ? 'unsupported' : 'failed',
      failureCode: code, failureCategory: category,
      failure: { code, category, retryable: false, message: detail },
      ...(availability.length ? { accessAvailability: availability } : {}),
    },
  }
}

const pointLabel = (point, index) => String(point?.label ?? '').trim() || `Point ${index + 1}`

function orderedTitle(mode, waypointCount) {
  const noun = mode === 'drive' ? 'Drive' : mode === 'walk' ? 'Walk' : 'Transit'
  return `${noun} via ${waypointCount} ${waypointCount === 1 ? 'stop' : 'stops'}`
}

/** A journey through the user's ordered waypoints, composed by the runtime. */
function orderedPlan(raw, trace, body, context) {
  const points = [body.origin, ...body.waypoints, body.destination]
  const mode = raw.mode === 'transit' ? 'transit' : raw.mode
  const base = mode === 'transit'
    ? transitPlan(raw, trace, body, context)
    : streetPlan(raw, trace, body, context)
  if (!base) return blockedPlan(raw, trace, body, context)
  return {
    ...base,
    id: planId('ordered', { mode, timePreference: base.timePreference, legs: base.legs.map(leg => [leg.type,
      leg.tripId ?? '', leg.fromStopId ?? '', leg.toStopId ?? '', leg.startMinutes, leg.endMinutes]),
    points: points.map(point => point.coordinate) }),
    choiceLabel: raw.choiceLabel ?? `Ordered ${points.length}-point route`,
    recommended: raw.recommended ?? true,
    title: orderedTitle(mode, body.waypoints.length),
    detail: points.map(pointLabel).join(' → '),
    waypoints: body.waypoints,
    diagnostics: {
      ...base.diagnostics,
      departureWindow: undefined,
      searchStrategy: 'exact_waypoint_composition',
      algorithm: 'ordered_waypoint_composition',
      optimality: 'best_objective_within_bounded_waypoint_frontier',
      sequenceOptimization: 'user_order_preserved',
      orderedPointCount: points.length,
      waypointCount: body.waypoints.length,
      ...(trace.diagnostics?.orderedSearch ? { orderedSearch: trace.diagnostics.orderedSearch } : {}),
    },
  }
}

/** The blocked waypoint segment, named by its two points. */
function orderedFailure(raw, body, context) {
  const points = [body.origin, ...body.waypoints, body.destination]
  const index = Number(raw.legIndex ?? 0)
  const segmentBody = { ...body, origin: points[index], destination: points[index + 1], waypoints: [] }
  const failed = blockedPlan(raw.leg ?? {}, raw.leg ?? {}, segmentBody, context)
  return {
    ...failed,
    id: `ordered-blocked-${index + 1}-${failed.id}`,
    origin: body.origin, waypoints: body.waypoints, destination: body.destination,
    title: `No route for leg ${index + 1}`,
    detail: `${pointLabel(points[index], index)} to ${pointLabel(points[index + 1], index + 1)}: ${failed.detail}`,
    diagnostics: { ...failed.diagnostics, searchStrategy: 'exact_waypoint_composition',
      algorithm: 'ordered_waypoint_composition', optimality: 'blocked_component_leg', failedOrderedSegmentIndex: index },
  }
}

/** A walk or drive request without a street path. */
function streetFailure(raw, trace, body, context) {
  const mode = body.mode === 'drive' ? 'drive' : 'walk'
  const maxStreetKm = mode === 'drive'
    ? Math.max(0.25, Math.min(1_500, Number(body.maxStreetKm) || 750))
    : Math.max(0.05, Math.min(100, Number(body.maxStreetKm) || 50))
  const failureCode = raw.reason === 'no_path' || !raw.reason ? 'no_path' : String(raw.reason)
  return {
    id: `street-${mode}-blocked`,
    status: 'blocked', travelMode: mode, timePreference: body.timePreference === 'arrive' ? 'arrive' : 'depart',
    maxWalkKm: mode === 'walk' ? Number(body.maxStreetKm ?? body.maxWalkKm ?? 50) : 0,
    origin: body.origin, destination: body.destination,
    title: mode === 'drive' ? 'Driving route unavailable' : 'Walking route unavailable',
    detail: failureCode === 'no_path'
      ? `No ${mode} path was found within ${maxStreetKm.toFixed(1)} km.`
      : `The ${mode} graph does not reach one of these points.`,
    departMinutes: body.departMinutes, arriveMinutes: null, durationMinutes: null,
    waitMinutes: 0, walkMinutes: 0, rideMinutes: 0, transfers: 0, legs: [],
    diagnostics: {
      ...resultDiagnostics(trace, body, context),
      scannedDepartures: 0, relaxedStops: 0, scheduleMode: 'none',
      walkingNetwork: mode === 'walk' ? 'osm' : 'direct',
      algorithm: mode === 'drive' ? 'rust_exact_drive_search' : 'rust_cch_walk_exact',
      routingStatus: 'blocked', failureCode,
    },
  }
}

function studioPlan(raw, trace, body, context) {
  if ((body.mode === 'walk' || body.mode === 'drive') && raw?.status !== 'ready' && !body.waypoints?.length) {
    return streetFailure(raw ?? {}, trace, body, context)
  }
  if (Array.isArray(body.waypoints) && body.waypoints.length) {
    if (raw?.reason === 'via_leg_blocked') return orderedFailure(raw, body, context)
    if (raw?.status === 'ready') return orderedPlan(raw, trace, body, context)
  }
  if (raw?.status !== 'ready') return blockedPlan(raw ?? {}, trace, body, context)
  if (raw.mode === 'walk' || raw.mode === 'drive') return streetPlan(raw, trace, body, context)
  return transitPlan(raw, trace, body, context) ?? blockedPlan(raw, trace, body, context)
}

/** Studio's route response for a detailed native Result. */
const minuteClocks = new Set(['departureMinutes', 'arrivalMinutes', 'departMinutes', 'arriveMinutes', 'firstBoardingMinutes'])
const secondClocks = new Set(['departure', 'arrival'])
const clockFree = new Set(['diagnostics', 'timing', 'meta', 'query', 'access', 'window', 'fare', 'route'])

function shiftClocks(value, minutes) {
  if (Array.isArray(value)) return value.map(item => shiftClocks(item, minutes))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    typeof item === 'number' && minuteClocks.has(key) ? item + minutes
      : typeof item === 'number' && secondClocks.has(key) ? item + minutes * 60
        : clockFree.has(key) ? item : shiftClocks(item, minutes)]))
}

// Unix seconds at a service date's clock origin, local noon minus 12 hours:
// a daylight-saving change makes that service day 23 or 25 hours long.
function serviceClockOrigin(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number)
  const format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  const noon = Date.UTC(year, month - 1, day, 12)
  let instant = noon
  for (let pass = 0; pass < 2; pass += 1) {
    const part = Object.fromEntries(format.formatToParts(instant).map(({ type, value }) => [type, Number(value)]))
    instant += noon - Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second)
  }
  return instant / 1000 - 43_200
}

/**
 * The Result with its clocks counted on `serviceDate`'s service day. Arriving
 * early in the day, the engine searches the previous service day; Studio
 * keeps showing the day the person asked for.
 */
export function onServiceDate(trace, serviceDate, timeZone = 'UTC') {
  // A window reports the day its clock ran on as `clockDate`.
  const executed = trace.clockDate ?? trace.serviceDate
  if (!executed || !serviceDate || executed === serviceDate) return trace
  const minutes = (serviceClockOrigin(executed, timeZone) - serviceClockOrigin(serviceDate, timeZone)) / 60
  return { ...shiftClocks(trace, minutes), serviceDate }
}

const rideCount = plan => plan.legs.filter(leg => leg.type === 'ride').length

/**
 * Earlier arrivals in Studio's journey order (latest departure, then fewer
 * boardings, then less walking), labelled by what each is best at. Journeys
 * that would leave before the requested day stay with the exact search.
 */
function arrivalWindowChoices(plans, trace, body) {
  const ready = plans.filter(plan => plan.status === 'ready')
  const sameDay = ready.filter(plan => plan.departMinutes >= 0)
  const ordered = (sameDay.length ? sameDay : ready).sort((left, right) => right.departMinutes - left.departMinutes
    || rideCount(left) - rideCount(right) || left.walkMinutes - right.walkMinutes || left.durationMinutes - right.durationMinutes)
  if (!ordered.length) return plans
  const best = score => ordered.reduce((winner, plan) => score(plan) < score(winner) ? plan : winner, ordered[0])
  const labels = new Map([[ordered[0], 'Latest departure']])
  for (const [label, score] of [['Shortest journey', plan => plan.durationMinutes],
    ['Fewest transfers', plan => plan.travelMode === 'walk' ? -1 : plan.transfers], ['Least walking', plan => plan.walkMinutes]]) {
    const plan = best(score)
    if (!labels.has(plan)) labels.set(plan, label)
  }
  const arrivalWindow = { deadlineMinutes: Number(body.arriveMinutes ?? body.departMinutes),
    windowMinutes: trace.window.minutes, stepMinutes: trace.window.stepMinutes ?? 1,
    searches: trace.window.searches ?? null, coverage: trace.window.coverage ?? 'sampled' }
  let alternate = 0
  return ordered.map((plan, index) => ({
    ...plan,
    recommended: index === 0,
    choiceLabel: plan.travelMode === 'walk' ? index === 0 ? 'Walk instead' : 'Walk only'
      : labels.get(plan) ?? (++alternate === 1 ? 'Earlier option' : `Earlier option ${alternate}`),
    diagnostics: { ...plan.diagnostics, arrivalWindow },
  }))
}

export function studioRouteResponse(trace, body, context = {}) {
  const raws = Array.isArray(trace.choices) && trace.choices.length ? trace.choices : [trace]
  const studio = raws.map(raw => studioPlan(raw, trace, body, context)).filter(Boolean)
  const choices = earlierArrivals(trace) ? arrivalWindowChoices(studio, trace, body) : studio
  const selected = earlierArrivals(trace) ? choices[0] : choices[Number(trace.selectedChoice ?? 0)] ?? choices[0]
  return {
    choices,
    selectedPlanId: selected?.id,
    ...(trace.earliestTransit ? { earliestTransit: trace.earliestTransit } : {}),
  }
}

/** Studio's response when the runtime rejects a coverage-gated date. */
export function studioBlockedResponse(body, context, failure) {
  const plan = blockedPlan({}, {}, body, context, failure)
  return { choices: [plan], selectedPlanId: plan.id }
}
