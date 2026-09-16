import type { RoutingPlan } from '../routingModel'

export function formatRoutingMinutes(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes))
  if (rounded < 60) return `${rounded}m`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export function formatRoutingLegDuration(leg: RoutingPlan['legs'][number]) {
  if (leg.type === 'ride' && leg.sourceEqualTime === true && leg.durationMinutes === 0) {
    return 'same minute'
  }
  return formatRoutingMinutes(leg.durationMinutes)
}

function formatDistanceKm(distanceKm: number) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return '0 m'
  if (distanceKm < 1) return `${Math.round(distanceKm * 1000)} m`
  return `${distanceKm.toFixed(distanceKm >= 10 ? 0 : 1)} km`
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

export function isSameStationTransfer(leg: RoutingPlan['legs'][number]) {
  if (leg.type !== 'walk' || leg.walkSource !== 'transfer') return false
  if (leg.transferSource === 'parent_station_fallback') return true
  if (leg.fromStopId && leg.toStopId && leg.fromStopId === leg.toStopId) return true
  const fromName = leg.fromName.trim().toLocaleLowerCase()
  const toName = leg.toName.trim().toLocaleLowerCase()
  return Boolean(fromName && fromName === toName)
}

export function routingLegPrimaryLabel(leg: RoutingPlan['legs'][number]) {
  if (leg.type === 'ride') return leg.routeShortName || leg.routeId || 'Transit'
  if (leg.type === 'drive') return 'Drive'
  if (isSameStationTransfer(leg)) {
    if (leg.transferAction === 'same-route-change' && leg.connectingRouteShortName) {
      return `Change to another ${leg.connectingRouteShortName} at ${leg.toName}`
    }
    if (leg.transferAction === 'platform-change') return `Platform change at ${leg.toName}`
    return `Change at ${leg.toName}`
  }
  return leg.walkSource === 'osm' ? 'Walk' : leg.walkSource === 'transfer' ? 'Transfer' : 'Walk'
}

export function routingLegDetail(leg: RoutingPlan['legs'][number]) {
  if (leg.stationAccessStatus === 'unverified') {
    return `${formatRoutingMinutes(leg.durationMinutes)} walk · station entrance/platform path unverified`
  }
  if (leg.transferSource === 'parent_station_fallback') {
    return `${formatRoutingMinutes(leg.durationMinutes)} station connection · assumed transfer time`
  }
  if (leg.type === 'ride') {
    const scheduleDetail = leg.stopCount > 0
      ? `${leg.stopCount} scheduled stop${leg.stopCount === 1 ? '' : 's'}`
      : 'Scheduled ride'
    const timingDetail = leg.sourceEqualTime === true
      ? leg.sourceTimestampQuality === 'equal-whole-minute'
        ? 'published in the same minute; sub-minute runtime not distinguished'
        : 'published with equal stop timestamps; runtime not distinguished'
      : ''
    const geometryDetail = leg.geometrySource === 'shape'
      ? ''
      : 'map line inferred from stops'
    return [scheduleDetail, timingDetail, geometryDetail].filter(Boolean).join(' · ')
  }
  if (leg.type === 'drive') {
    return `${formatDistanceKm(leg.distanceKm)} drive · OSM free-flow street route`
  }

  if (isSameStationTransfer(leg)) {
    const connection = leg.transferAction === 'same-route-change'
      ? 'new vehicle on the same public line'
      : leg.transferAction === 'platform-change'
        ? 'platform change'
        : 'station connection'
    return `${formatRoutingMinutes(leg.durationMinutes)} ${connection} · same station`
  }

  const source = leg.walkSource === 'transfer' ? 'station transfer' : 'OSM street route'
  return `${formatDistanceKm(leg.distanceKm)} walk · ${source}`
}

export function routingPlanRouteSequence(plan: RoutingPlan) {
  const rideLabels = plan.legs
    .filter((leg) => leg.type === 'ride')
    .map((leg) => leg.routeShortName || leg.routeId)
    .filter((label): label is string => Boolean(label))
    .filter((label, index, labels) => labels.indexOf(label) === index)
  if (rideLabels.length) return rideLabels.join(' -> ')
  return plan.travelMode === 'transit' ? 'No scheduled ride' : routingLegPrimaryLabel(plan.legs[0] ?? {
    type: plan.travelMode === 'drive' ? 'drive' : 'walk',
    fromName: plan.origin.label,
    toName: plan.destination.label,
    startMinutes: plan.departMinutes,
    endMinutes: plan.arriveMinutes ?? plan.departMinutes,
    durationMinutes: plan.durationMinutes,
    distanceKm: 0,
    stopCount: 0,
    coordinates: [],
  })
}

export function routingDataModeLabel(plan: RoutingPlan) {
  const mode = plan.diagnostics?.routingDataMode ?? plan.diagnostics?.routingDataProvenance?.mode
  return mode === 'scheduled' ? 'Scheduled · Research' : mode === 'realtime' ? 'Realtime' : ''
}

export function routingRealtimeDetail(plan: RoutingPlan) {
  const modeLabel = routingDataModeLabel(plan)
  if (modeLabel === 'Scheduled · Research') return `${modeLabel} · Published timetable`
  const realtime = plan.diagnostics?.realtimeRouting
  const rides = plan.legs.filter(leg => leg.type === 'ride')
  const predicted = rides.filter(leg => leg.scheduleMode === 'realtime-adjusted').length
  const applied = (realtime?.appliedTrips ?? 0) + (realtime?.canceledTrips ?? 0)
  let detail = predicted
    ? predicted === rides.length ? 'Live predictions' : 'Live predictions and scheduled times'
    : realtime?.canceledTrips && applied > 0
      ? 'Live cancellations applied; journey times scheduled'
      : applied > 0
        ? 'Realtime updates applied; journey times scheduled'
        : realtime?.status === 'stale_fallback'
          ? 'Scheduled times; realtime snapshot stale or invalid'
          : 'Scheduled times; no realtime updates applied'
  const coverage = realtime?.coverage
  if (coverage && coverage.inputUpdates > 0) {
    detail += ` · ${coverage.appliedUpdates} of ${coverage.inputUpdates} supplied updates used`
    if (coverage.rejectedUpdates > 0) detail += `; ${coverage.rejectedUpdates} excluded`
    if (coverage.prunedUpdates > 0) detail += `; ${coverage.prunedUpdates} omitted`
  }
  return modeLabel ? `${modeLabel} · ${detail}` : detail
}
