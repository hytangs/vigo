import { occupancyIndicator, vehicleGap, vehicleAlert, vehicleReportFresh } from './agency/vehicleIndicators'
import type { OperationalEvent } from './agency/types'
import type { LngLat, MapPreview, RealtimeSnapshot, RouteMetric, ScheduledTrip, StopMetric } from './domain'
import { scopedRouteServiceKey } from './routeServices'
import { formatScheduleClock, formatServiceTime, type ScheduledVehicle } from './scheduledVehicles'

export type ServiceVehicleMode = 'live' | 'schedule'

type ServiceVehicleCard = {
  eyebrow: string
  title: string
  subtitle: string
  journey: {
    destination: string
    nextStop: string
    arrival: string
    arrivalLabel: string
  }
  metrics: Array<{ value: string; label: string }>
}

export type ServiceVehicle = {
  id: string
  sourceUrl?: string
  source: ServiceVehicleMode
  coordinate: LngLat
  bearing?: number
  serviceKey: string
  routeFeatureId?: string
  routeId: string
  routeShortName: string
  routeColor: string
  tripId: string
  nextStopFeatureId?: string
  delaySeverity?: string
  gapSeverity?: string
  indicatorLabel?: string
  crowded?: boolean
  card: ServiceVehicleCard
}

export type ServiceVehicleFrame = {
  mode: ServiceVehicleMode
  vehicles: ServiceVehicle[]
  fetchedAt?: string
  tripUpdateCount: number
  alertCount: number
  freshness?: RealtimeSnapshot['freshness']
}

type PreviewVehicleIndex = {
  routes: Map<string, RouteMetric>
  routeCandidates: Map<string, Map<string, RouteMetric>>
  stops: Map<string, StopMetric>
  trips: Map<string, Map<string, { trip: ScheduledTrip; route: RouteMetric }>>
}

const previewIndexCache = new WeakMap<MapPreview, PreviewVehicleIndex>()

function unscopedId(value: string) {
  return value.split('::').at(-1) ?? value
}

function indexValue<T>(index: Map<string, T>, keys: Array<string | undefined>, value: T) {
  for (const key of keys) {
    if (!key) continue
    if (!index.has(key)) index.set(key, value)
    const unscoped = unscopedId(key)
    if (!index.has(unscoped)) index.set(unscoped, value)
  }
}

function indexCandidate<T>(index: Map<string, Map<string, T>>, key: string, identity: string, value: T) {
  if (!key) return
  const candidates = index.get(key) ?? new Map<string, T>()
  candidates.set(identity, value)
  index.set(key, candidates)
}

function uniqueCandidate<T>(candidates: Map<string, T> | undefined) {
  return candidates?.size === 1 ? candidates.values().next().value as T : undefined
}

export function serviceKeyForRoute(route: RouteMetric) {
  return scopedRouteServiceKey(route)
}

function previewVehicleIndex(preview: MapPreview) {
  const cached = previewIndexCache.get(preview)
  if (cached) return cached

  const routes = new Map<string, RouteMetric>()
  const routeCandidates: PreviewVehicleIndex['routeCandidates'] = new Map()
  const stops = new Map<string, StopMetric>()
  const trips: PreviewVehicleIndex['trips'] = new Map()

  for (const route of preview.routes) {
    const serviceKey = serviceKeyForRoute(route)
    indexValue(routes, [route.id, route.patternId, route.routeId, route.shortName], route)
    for (const alias of [route.id, route.patternId, route.routeId, route.shortName]) {
      if (!alias) continue
      indexCandidate(routeCandidates, alias, serviceKey, route)
      indexCandidate(routeCandidates, unscopedId(alias), serviceKey, route)
    }
    for (const trip of route.scheduledTrips ?? []) {
      const tripKey = unscopedId(trip.tripId)
      const assignment = { trip, route }
      const identity = `${route.id}:${trip.tripId}`
      const scope = route.id.includes('::') ? route.id.slice(0, route.id.indexOf('::')) : ''
      for (const alias of [trip.tripId, tripKey, `${serviceKey}:${tripKey}`, scope ? `${scope}::${tripKey}` : '']) {
        indexCandidate(trips, alias, identity, assignment)
      }
    }
  }
  for (const stop of preview.stops) indexValue(stops, [stop.id], stop)

  const index = { routes, routeCandidates, stops, trips }
  previewIndexCache.set(preview, index)
  return index
}

function stopFor(index: PreviewVehicleIndex, stopId: string | undefined) {
  return stopId ? index.stops.get(stopId) ?? index.stops.get(unscopedId(stopId)) : undefined
}

function stopName(index: PreviewVehicleIndex, stopId: string | undefined) {
  if (!stopId) return 'Not encoded'
  return stopFor(index, stopId)?.name || unscopedId(stopId)
}

function tripFor(index: PreviewVehicleIndex, route: RouteMetric | undefined, tripId: string, routeId: string) {
  if (!tripId) return undefined
  const tripKey = unscopedId(tripId)
  const exact = uniqueCandidate(index.trips.get(tripId))
  if (route) {
    const serviceKey = serviceKeyForRoute(route)
    if (tripId.includes('::')) {
      if (exact && serviceKeyForRoute(exact.route) !== serviceKey) return undefined
      const routeScope = route.id.includes('::') ? route.id.slice(0, route.id.indexOf('::')) : ''
      if (routeScope && tripId.slice(0, tripId.indexOf('::')) !== routeScope) return undefined
    }
    return uniqueCandidate(index.trips.get(`${serviceKey}:${tripKey}`))
  }
  const candidate = exact ?? uniqueCandidate(index.trips.get(tripKey))
  if (!candidate) return undefined
  // A unique trip can disambiguate duplicate route IDs across feeds, but it
  // cannot override an explicitly contradictory route identity.
  if (routeId && !index.routeCandidates.get(routeId)?.has(serviceKeyForRoute(candidate.route))) return undefined
  return candidate
}

function realtimeClock(timestamp: number | undefined) {
  if (!timestamp) return '--'
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function codeLabel(value: string | undefined) {
  if (!value) return '--'
  return value.toLowerCase().split('_').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ')
}

function delayLabel(delaySeconds: number | undefined) {
  if (delaySeconds === undefined) return '--'
  if (Math.abs(delaySeconds) < 30) return 'On time'
  const minutes = Math.round(delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes}m`
}

function realtimeVehicles(snapshot: RealtimeSnapshot | null, preview: MapPreview, events: OperationalEvent[] = []): ServiceVehicle[] {
  if (!snapshot) return []
  const index = previewVehicleIndex(preview)
  const tripUpdates = new Map<string, RealtimeSnapshot['tripUpdates'][number]>()
  for (const update of snapshot.tripUpdates) indexValue(tripUpdates, [update.tripId], update)

  return snapshot.vehicles.flatMap((vehicle) => {
    if (typeof vehicle.lon !== 'number' || !Number.isFinite(vehicle.lon) || Math.abs(vehicle.lon) > 180) return []
    if (typeof vehicle.lat !== 'number' || !Number.isFinite(vehicle.lat) || Math.abs(vehicle.lat) > 90) return []

    const routeId = vehicle.routeId ?? ''
    const tripId = vehicle.tripId ?? ''
    const serviceRoute = uniqueCandidate(index.routeCandidates.get(routeId))
    const tripUpdate = tripUpdates.get(tripId) ?? tripUpdates.get(unscopedId(tripId))
    const assignment = tripFor(index, serviceRoute, tripId, routeId)
    const scheduledTrip = assignment?.trip
    const patternRoute = scheduledTrip?.patternId
      ? index.routes.get(scheduledTrip.patternId)
      : assignment?.route
    const exactPattern = patternRoute && assignment
      && serviceKeyForRoute(patternRoute) === serviceKeyForRoute(assignment.route)
      ? patternRoute
      : undefined
    const route = exactPattern ?? assignment?.route ?? serviceRoute
    const nextStopId = vehicle.stopId || tripUpdate?.nextStopId
    const nextStopUpdate = tripUpdate?.stopTimeUpdates?.find((update) => (
      Boolean(update.stopId && nextStopId && unscopedId(update.stopId) === unscopedId(nextStopId))
      || (tripUpdate.nextStopSequence !== undefined && update.stopSequence === tripUpdate.nextStopSequence)
    )) ?? tripUpdate?.stopTimeUpdates?.[0]
    const scheduledStopTime = scheduledTrip?.stopTimes.find((stopTime) => (
      unscopedId(stopTime.stopId) === unscopedId(nextStopId ?? '')
    ))
    const scheduledArrivalMinutes = scheduledStopTime?.arrivalMinutes ?? scheduledStopTime?.departureMinutes
    const realtimeArrivalTimestamp = nextStopUpdate?.arrival?.time ?? nextStopUpdate?.departure?.time
    const delaySeconds = tripUpdate?.delaySeconds
      ?? nextStopUpdate?.arrival?.delay
      ?? nextStopUpdate?.departure?.delay
    const destinationStopId = scheduledTrip?.stopTimes.at(-1)?.stopId
      ?? tripUpdate?.stopTimeUpdates?.at(-1)?.stopId
    const expectedArrival = realtimeArrivalTimestamp
      ? realtimeClock(realtimeArrivalTimestamp)
      : scheduledArrivalMinutes === undefined
        ? 'Not encoded'
        : formatScheduleClock(scheduledArrivalMinutes + Math.round((delaySeconds ?? 0) / 60))
    const stop = stopFor(index, nextStopId)
    const gap = vehicleGap(vehicle, snapshot, events)
    const delay = vehicleAlert(vehicle, snapshot, events, 'delay')
    const occupancy = occupancyIndicator(vehicle.occupancyStatus)
    const fresh = vehicleReportFresh(vehicle, snapshot)
    const gapLabel = gap ? `${Math.round((gap.evidence.observedHeadwaySeconds || 0) / 60)} min ${gap.type === 'bunching' ? 'spacing' : 'gap'} · scheduled ${Math.round((gap.evidence.scheduledHeadwaySeconds || 0) / 60)} min` : ''
    const routeShortName = route?.shortName || routeId || 'Unassigned'

    return [{
      id: vehicle.id,
      sourceUrl: vehicle.sourceUrl,
      source: 'live' as const,
      coordinate: [vehicle.lon, vehicle.lat] as LngLat,
      bearing: typeof vehicle.bearing === 'number' && Number.isFinite(vehicle.bearing) ? vehicle.bearing : undefined,
      serviceKey: route ? serviceKeyForRoute(route) : routeId,
      // A route_id identifies the whole service. Without trip membership,
      // selecting the first indexed pattern would invent a branch match.
      routeFeatureId: exactPattern?.id,
      routeId,
      routeShortName,
      routeColor: route?.color ?? '#6af3ee',
      tripId,
      delaySeverity: delay?.severity,
      gapSeverity: gap?.severity,
      crowded: fresh && occupancy.crowded,
      indicatorLabel: [gapLabel, delay && delay.severity !== 'info' ? `${Math.round((delay.evidence.delaySeconds || 0) / 60)} min late` : '', fresh && occupancy.label !== 'Occupancy unknown' ? occupancy.label : ''].filter(Boolean).join(' · '),
      nextStopFeatureId: stop?.id,
      card: {
        eyebrow: 'Live vehicle',
        title: vehicle.label ?? vehicle.id,
        subtitle: [routeShortName, tripId ? `Trip ${unscopedId(tripId)}` : '', codeLabel(vehicle.currentStatus)].filter(Boolean).join(' · '),
        journey: {
          destination: stopName(index, destinationStopId),
          nextStop: stopName(index, nextStopId),
          arrival: expectedArrival,
          arrivalLabel: realtimeArrivalTimestamp || delaySeconds !== undefined ? 'Expected arrival' : 'Scheduled arrival',
        },
        metrics: [
          { value: `${occupancy.label}${fresh ? '' : ' (not current)'}`, label: 'reported occupancy' },
          ...(delay && delay.severity !== 'info' ? [{ value: `${Math.round((delay.evidence.delaySeconds || 0) / 60)} min late`, label: `Predicted at ${delay.stopName || delay.stopId}; ${delay.evidence.alertReason}` }] : []),
          ...(gap ? [{ value: gapLabel, label: `Predicted at ${gap.stopName || gap.stopId}; direction ${gap.directionId ?? 'unknown'}${gap.evidence.alertReason ? `; ${gap.evidence.alertReason}` : ''}` }] : []),
          { value: delayLabel(delaySeconds), label: 'delay' },
          { value: realtimeClock(vehicle.timestamp), label: 'seen' },
        ],
      },
    }]
  })
}

function scheduledServiceVehicles(vehicles: ScheduledVehicle[], preview: MapPreview): ServiceVehicle[] {
  const index = previewVehicleIndex(preview)
  return vehicles.map((vehicle) => {
    const route = index.routes.get(vehicle.routeFeatureId)
      ?? index.routes.get(vehicle.routeId)
      ?? index.routes.get(vehicle.routeShortName)
    const stateLabel = vehicle.state === 'arrived'
      ? `Arrived at ${stopName(index, vehicle.currentStopId)}`
      : vehicle.state === 'dwelling'
        ? `At ${stopName(index, vehicle.currentStopId)}${vehicle.currentStopDepartureMinutes === undefined ? '' : ` · Departs ${formatServiceTime(vehicle.currentStopDepartureMinutes)}`}`
        : 'Between stops · Estimated position'
    return {
      id: vehicle.id,
      source: 'schedule' as const,
      coordinate: vehicle.coordinate,
      bearing: vehicle.bearing,
      serviceKey: route ? serviceKeyForRoute(route) : vehicle.routeId,
      routeFeatureId: route?.id ?? vehicle.routeFeatureId,
      routeId: vehicle.routeId,
      routeShortName: vehicle.routeShortName,
      routeColor: vehicle.routeColor,
      tripId: vehicle.tripId,
      nextStopFeatureId: stopFor(index, vehicle.nextStopId)?.id,
      card: {
        eyebrow: 'Schedule simulation',
        title: vehicle.routeShortName,
        subtitle: `Trip ${unscopedId(vehicle.tripId)} · ${vehicle.serviceDate} ${formatServiceTime(vehicle.scheduleTimeMinutes)} · ${stateLabel}`,
        journey: {
          destination: stopName(index, vehicle.destinationStopId),
          nextStop: stopName(index, vehicle.nextStopId),
          arrival: vehicle.nextStopArrivalMinutes === undefined
            ? 'Not encoded'
            : formatServiceTime(vehicle.nextStopArrivalMinutes),
          arrivalLabel: 'Scheduled arrival',
        },
        metrics: [
          { value: `${Math.round(vehicle.progress * 100)}%`, label: 'trip' },
          { value: `${Math.round(vehicle.elapsedMinutes)}m`, label: 'elapsed' },
          { value: `${Math.round(vehicle.runtimeMinutes)}m`, label: 'runtime' },
        ],
      },
    }
  })
}

export function buildServiceVehicleFrame({
  mode,
  preview,
  realtimeSnapshot,
  scheduledVehicles,
  operationalEvents = [],
}: {
  mode: ServiceVehicleMode
  preview: MapPreview
  realtimeSnapshot: RealtimeSnapshot | null
  operationalEvents?: OperationalEvent[]
  scheduledVehicles: ScheduledVehicle[]
}): ServiceVehicleFrame {
  return {
    mode,
    vehicles: mode === 'live'
      ? realtimeVehicles(realtimeSnapshot, preview, operationalEvents)
      : scheduledServiceVehicles(scheduledVehicles, preview),
    fetchedAt: mode === 'live' ? realtimeSnapshot?.fetchedAt : undefined,
    tripUpdateCount: mode === 'live' ? realtimeSnapshot?.counts.tripUpdates ?? 0 : 0,
    alertCount: mode === 'live' ? realtimeSnapshot?.counts.alerts ?? 0 : 0,
    freshness: mode === 'live' ? realtimeSnapshot?.freshness : undefined,
  }
}

export function serviceVehicleIsVisible(vehicle: ServiceVehicle, preview: MapPreview, selectedRouteId = '') {
  if (!selectedRouteId) return true
  const selectedRoute = preview.routes.find((route) => route.id === selectedRouteId || route.patternId === selectedRouteId)
  if (!selectedRoute) return false
  const serviceKey = serviceKeyForRoute(selectedRoute)
  if (vehicle.serviceKey !== serviceKey) return false
  const selectedPatterns = preview.routes.filter((route) => serviceKeyForRoute(route) === serviceKey)
  const patternOnly = selectedPatterns.length === 1 && (selectedRoute.serviceVariantCount ?? 1) > 1
  return !patternOnly || vehicle.routeFeatureId === selectedRoute.id
}

export function serviceVehicleCount(frame: ServiceVehicleFrame, route?: RouteMetric, preview?: MapPreview) {
  if (!route) return frame.vehicles.length
  if (preview) return frame.vehicles.filter((vehicle) => serviceVehicleIsVisible(vehicle, preview, route.id)).length
  const serviceKey = serviceKeyForRoute(route)
  return frame.vehicles.filter((vehicle) => vehicle.serviceKey === serviceKey).length
}
