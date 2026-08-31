import type { LngLat, MapPreview, RealtimeSnapshot, RouteMetric, ScheduledTrip, StopMetric } from './domain'
import { scopedRouteServiceKey } from './routeServices'
import { formatScheduleClock, type ScheduledVehicle } from './scheduledVehicles'

export type ServiceVehicleMode = 'live' | 'schedule'

export type ServiceVehicleCard = {
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
  stops: Map<string, StopMetric>
  trips: Map<string, ScheduledTrip>
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

export function serviceKeyForRoute(route: RouteMetric) {
  return scopedRouteServiceKey(route)
}

function previewVehicleIndex(preview: MapPreview) {
  const cached = previewIndexCache.get(preview)
  if (cached) return cached

  const routes = new Map<string, RouteMetric>()
  const stops = new Map<string, StopMetric>()
  const trips = new Map<string, ScheduledTrip>()

  for (const route of preview.routes) {
    const serviceKey = serviceKeyForRoute(route)
    indexValue(routes, [route.id, route.patternId, route.routeId, route.shortName], route)
    for (const trip of route.scheduledTrips ?? []) {
      const tripKey = unscopedId(trip.tripId)
      indexValue(trips, [trip.tripId, `${serviceKey}:${tripKey}`], trip)
    }
  }
  for (const stop of preview.stops) indexValue(stops, [stop.id], stop)

  const index = { routes, stops, trips }
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

function tripFor(index: PreviewVehicleIndex, route: RouteMetric | undefined, tripId: string) {
  if (!tripId) return undefined
  const tripKey = unscopedId(tripId)
  return index.trips.get(`${route ? serviceKeyForRoute(route) : ''}:${tripKey}`)
    ?? index.trips.get(tripId)
    ?? index.trips.get(tripKey)
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

function realtimeVehicles(snapshot: RealtimeSnapshot | null, preview: MapPreview): ServiceVehicle[] {
  if (!snapshot) return []
  const index = previewVehicleIndex(preview)
  const tripUpdates = new Map<string, RealtimeSnapshot['tripUpdates'][number]>()
  for (const update of snapshot.tripUpdates) indexValue(tripUpdates, [update.tripId], update)

  return snapshot.vehicles.flatMap((vehicle) => {
    if (typeof vehicle.lon !== 'number' || !Number.isFinite(vehicle.lon) || Math.abs(vehicle.lon) > 180) return []
    if (typeof vehicle.lat !== 'number' || !Number.isFinite(vehicle.lat) || Math.abs(vehicle.lat) > 90) return []

    const routeId = vehicle.routeId ?? ''
    const tripId = vehicle.tripId ?? ''
    const route = index.routes.get(routeId) ?? index.routes.get(unscopedId(routeId))
    const tripUpdate = tripUpdates.get(tripId) ?? tripUpdates.get(unscopedId(tripId))
    const scheduledTrip = tripFor(index, route, tripId)
    const nextStopId = tripUpdate?.nextStopId || vehicle.stopId || scheduledTrip?.stopTimes[0]?.stopId
    const nextStopUpdate = tripUpdate?.stopTimeUpdates?.find((update) => (
      unscopedId(update.stopId ?? '') === unscopedId(nextStopId ?? '')
      || update.stopSequence === tripUpdate.nextStopSequence
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
    const routeShortName = route?.shortName || routeId || 'Unassigned'

    return [{
      id: vehicle.id,
      source: 'live' as const,
      coordinate: [vehicle.lon, vehicle.lat] as LngLat,
      bearing: typeof vehicle.bearing === 'number' && Number.isFinite(vehicle.bearing) ? vehicle.bearing : undefined,
      serviceKey: route ? serviceKeyForRoute(route) : routeId,
      routeFeatureId: route?.id,
      routeId,
      routeShortName,
      routeColor: route?.color ?? '#6af3ee',
      tripId,
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
          { value: codeLabel(vehicle.occupancyStatus), label: 'occupancy' },
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
        eyebrow: 'Scheduled vehicle',
        title: vehicle.routeShortName,
        subtitle: `Trip ${unscopedId(vehicle.tripId)} · ${formatScheduleClock(vehicle.scheduleTimeMinutes)} schedule`,
        journey: {
          destination: stopName(index, vehicle.destinationStopId),
          nextStop: stopName(index, vehicle.nextStopId),
          arrival: vehicle.nextStopArrivalMinutes === undefined
            ? 'Not encoded'
            : formatScheduleClock(vehicle.nextStopArrivalMinutes),
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
}: {
  mode: ServiceVehicleMode
  preview: MapPreview
  realtimeSnapshot: RealtimeSnapshot | null
  scheduledVehicles: ScheduledVehicle[]
}): ServiceVehicleFrame {
  return {
    mode,
    vehicles: mode === 'live'
      ? realtimeVehicles(realtimeSnapshot, preview)
      : scheduledServiceVehicles(scheduledVehicles, preview),
    fetchedAt: mode === 'live' ? realtimeSnapshot?.fetchedAt : undefined,
    tripUpdateCount: mode === 'live' ? realtimeSnapshot?.counts.tripUpdates ?? 0 : 0,
    alertCount: mode === 'live' ? realtimeSnapshot?.counts.alerts ?? 0 : 0,
    freshness: mode === 'live' ? realtimeSnapshot?.freshness : undefined,
  }
}

export function serviceVehicleCount(frame: ServiceVehicleFrame, route?: RouteMetric) {
  if (!route) return frame.vehicles.length
  const serviceKey = serviceKeyForRoute(route)
  return frame.vehicles.filter((vehicle) => vehicle.serviceKey === serviceKey).length
}
