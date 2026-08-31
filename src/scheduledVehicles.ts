import type { LngLat, MapPreview, RouteMetric, ScheduledTrip, ServiceDay } from './domain'
import { coordinateDistanceKm, toDegrees, toRadians } from './app/geometry'

export type ScheduledVehicle = {
  id: string
  label: string
  routeFeatureId: string
  routeId: string
  routeShortName: string
  routeColor: string
  tripId: string
  directionId?: string
  nextStopId?: string
  nextStopArrivalMinutes?: number
  destinationStopId?: string
  coordinate: LngLat
  bearing: number
  elapsedMinutes: number
  runtimeMinutes: number
  progress: number
  scheduleTimeMinutes: number
}

export type ScheduledVehicleDiagnostics = {
  tone: 'good' | 'watch' | 'empty'
  title: string
  detail: string
}

type IndexedPath = {
  coordinates: LngLat[]
  segmentBearings: number[]
  segmentLengths: number[]
  cumulativeDistances: number[]
  totalDistance: number
}

const indexedPathCache = new WeakMap<LngLat[], IndexedPath>()
const trustedPathCache = new WeakMap<LngLat[], boolean>()
const scheduledTripIndexCache = new WeakMap<RouteMetric, { trips: ScheduledTrip[]; maximumRuntimeMinutes: number }>()
const scheduledProjectionCache = new WeakMap<MapPreview, { key: string; vehicles: ScheduledVehicle[] }>()
const maxTrustedShapeVehicleJumpKm = 55

function coordinateBearing(a: LngLat, b: LngLat) {
  const lat1 = toRadians(a[1])
  const lat2 = toRadians(b[1])
  const dLon = toRadians(b[0] - a[0])
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (toDegrees(Math.atan2(y, x)) + 360) % 360
}

function interpolateCoordinate(a: LngLat, b: LngLat, progress: number): LngLat {
  return [
    a[0] + (b[0] - a[0]) * progress,
    a[1] + (b[1] - a[1]) * progress,
  ]
}

function indexedPath(coordinates: LngLat[]) {
  const cached = indexedPathCache.get(coordinates)
  if (cached) return cached

  const segmentLengths: number[] = []
  const segmentBearings: number[] = []
  const cumulativeDistances = [0]
  let totalDistance = 0

  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1]
    const to = coordinates[index]
    const distance = coordinateDistanceKm(from, to)
    segmentLengths.push(distance)
    segmentBearings.push(coordinateBearing(from, to))
    totalDistance += distance
    cumulativeDistances.push(totalDistance)
  }

  const next = { coordinates, segmentBearings, segmentLengths, cumulativeDistances, totalDistance }
  indexedPathCache.set(coordinates, next)
  return next
}

function normalizeServiceTime(lastArrivalMinutes: number | undefined, clockMinutes: number) {
  const lastArrival = lastArrivalMinutes ?? 24 * 60
  if (lastArrival > 24 * 60 && clockMinutes < 4 * 60) return clockMinutes + 24 * 60
  return clockMinutes
}

function coordinateAtProgress(coordinates: LngLat[], progress: number) {
  const clampedProgress = Math.max(0, Math.min(1, progress))
  if (coordinates.length < 2) return null

  const { segmentBearings, segmentLengths, cumulativeDistances, totalDistance } = indexedPath(coordinates)
  if (totalDistance <= 0) {
    return {
      coordinate: coordinates[0],
      bearing: segmentBearings[0] ?? coordinateBearing(coordinates[0], coordinates[1]),
    }
  }

  const targetDistance = totalDistance * clampedProgress
  let low = 0
  let high = segmentLengths.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (cumulativeDistances[middle + 1] >= targetDistance) high = middle
    else low = middle + 1
  }

  const segmentDistance = segmentLengths[low]
  const segmentProgress = segmentDistance > 0
    ? (targetDistance - cumulativeDistances[low]) / segmentDistance
    : 0
  const from = coordinates[low]
  const to = coordinates[low + 1]
  return {
    coordinate: interpolateCoordinate(from, to, segmentProgress),
    bearing: segmentBearings[low] ?? coordinateBearing(from, to),
  }
}

function hasTrustworthyVehiclePath(route: RouteMetric) {
  const coordinates = route.coordinates
  if (!coordinates || coordinates.length < 2) return false
  if (route.geometrySource !== 'shape') return false
  const cached = trustedPathCache.get(coordinates)
  if (cached !== undefined) return cached
  const { segmentLengths, totalDistance } = indexedPath(coordinates)
  const trustworthy = totalDistance > 0 && segmentLengths.every((distance) => distance <= maxTrustedShapeVehicleJumpKm)
  trustedPathCache.set(coordinates, trustworthy)
  return trustworthy
}

function stopArrivalMinutes(stop: NonNullable<RouteMetric['scheduledTrips']>[number]['stopTimes'][number]) {
  return stop.arrivalMinutes ?? stop.departureMinutes ?? null
}

function stopDepartureMinutes(stop: NonNullable<RouteMetric['scheduledTrips']>[number]['stopTimes'][number]) {
  return stop.departureMinutes ?? stop.arrivalMinutes ?? null
}

function exactScheduledVehicleForTrip(
  route: RouteMetric,
  trip: NonNullable<RouteMetric['scheduledTrips']>[number],
  serviceTime: number,
): ScheduledVehicle | null {
  const coordinates = route.coordinates
  if (!coordinates || coordinates.length < 2 || !hasTrustworthyVehiclePath(route)) return null
  if (serviceTime < trip.firstDepartureMinutes || serviceTime > trip.lastArrivalMinutes) return null

  const stopTimes = trip.stopTimes
  let progress: number | null = null
  let nextStopId: string | undefined
  let nextStopArrivalMinutes: number | undefined
  const destinationStop = stopTimes.at(-1)
  const destinationStopId = destinationStop?.stopId

  for (let index = 0; index < stopTimes.length; index += 1) {
    const stopTime = stopTimes[index]
    const arrival = stopArrivalMinutes(stopTime)
    const departure = stopDepartureMinutes(stopTime)
    if (arrival !== null && departure !== null && serviceTime >= arrival && serviceTime <= departure) {
      progress = stopTime.progress
      const upcomingStop = stopTimes[Math.min(index + 1, stopTimes.length - 1)]
      nextStopId = upcomingStop?.stopId
      nextStopArrivalMinutes = upcomingStop ? stopArrivalMinutes(upcomingStop) ?? undefined : undefined
      break
    }
  }

  if (progress === null) {
    for (let index = 0; index < stopTimes.length - 1; index += 1) {
      const from = stopTimes[index]
      const to = stopTimes[index + 1]
      const departure = stopDepartureMinutes(from)
      const arrival = stopArrivalMinutes(to)
      if (departure === null || arrival === null) continue
      if (serviceTime < departure || serviceTime > arrival) continue
      const segmentRatio = arrival > departure ? (serviceTime - departure) / (arrival - departure) : 0
      progress = from.progress + (to.progress - from.progress) * segmentRatio
      nextStopId = to.stopId
      nextStopArrivalMinutes = arrival
      break
    }
  }

  if (progress === null) return null
  const position = coordinateAtProgress(coordinates, progress)
  if (!position) return null

  return {
    id: `${route.id}:${trip.tripId}`,
    label: `${route.shortName}-${formatScheduleClock(trip.firstDepartureMinutes)}`,
    routeFeatureId: route.id,
    routeId: route.routeId ?? route.id,
    routeShortName: route.shortName,
    routeColor: route.color,
    tripId: trip.tripId,
    directionId: trip.directionId ?? route.directionId,
    nextStopId,
    nextStopArrivalMinutes,
    destinationStopId,
    coordinate: position.coordinate,
    bearing: position.bearing,
    elapsedMinutes: Math.max(0, serviceTime - trip.firstDepartureMinutes),
    runtimeMinutes: Math.max(1, trip.lastArrivalMinutes - trip.firstDepartureMinutes),
    progress: Math.max(0, Math.min(1, progress)),
    scheduleTimeMinutes: serviceTime,
  }
}

export function formatScheduleClock(minutes: number) {
  const normalized = ((Math.round(minutes) % (24 * 60)) + 24 * 60) % (24 * 60)
  const hours = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function isTripActiveOnServiceDay(trip: NonNullable<RouteMetric['scheduledTrips']>[number], serviceDay: ServiceDay) {
  return !trip.serviceDays?.length || trip.serviceDays.includes(serviceDay)
}

function projectionCacheKey(clockMinutes: number, serviceDay: ServiceDay) {
  return [
    Math.round(clockMinutes * 60),
    serviceDay,
  ].join(':')
}

function routeActiveAtServiceTime(route: RouteMetric, serviceTime: number) {
  if (route.firstDepartureMinutes === undefined || route.lastArrivalMinutes === undefined) return true
  return serviceTime >= route.firstDepartureMinutes && serviceTime <= route.lastArrivalMinutes
}

function scheduledTripIndex(route: RouteMetric) {
  const cached = scheduledTripIndexCache.get(route)
  if (cached) return cached
  const sourceTrips = route.scheduledTrips ?? []
  const alreadyOrdered = sourceTrips.every((trip, index) => (
    index === 0 || sourceTrips[index - 1].firstDepartureMinutes <= trip.firstDepartureMinutes
  ))
  const trips = alreadyOrdered ? sourceTrips : [...sourceTrips].sort((left, right) => (
    left.firstDepartureMinutes - right.firstDepartureMinutes
    || left.lastArrivalMinutes - right.lastArrivalMinutes
    || left.tripId.localeCompare(right.tripId)
  ))
  const maximumRuntimeMinutes = trips.reduce((maximum, trip) => (
    Math.max(maximum, Math.max(0, trip.lastArrivalMinutes - trip.firstDepartureMinutes))
  ), 0)
  const index = { trips, maximumRuntimeMinutes }
  scheduledTripIndexCache.set(route, index)
  return index
}

function firstTripAtOrAfter(trips: ScheduledTrip[], departureMinutes: number) {
  let low = 0
  let high = trips.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (trips[middle].firstDepartureMinutes < departureMinutes) low = middle + 1
    else high = middle
  }
  return low
}

function firstTripAfter(trips: ScheduledTrip[], departureMinutes: number) {
  let low = 0
  let high = trips.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (trips[middle].firstDepartureMinutes <= departureMinutes) low = middle + 1
    else high = middle
  }
  return low
}

export function scheduledVehiclesAtTime(
  preview: MapPreview,
  clockMinutes: number,
  serviceDay: ServiceDay = 'weekday',
): ScheduledVehicle[] {
  const key = projectionCacheKey(clockMinutes, serviceDay)
  const cached = scheduledProjectionCache.get(preview)
  if (cached?.key === key) return cached.vehicles

  const vehicles: ScheduledVehicle[] = []

  for (const route of preview.routes) {
    const coordinates = route.coordinates
    if (!coordinates || coordinates.length < 2 || !hasTrustworthyVehiclePath(route)) continue

    const serviceTime = normalizeServiceTime(route.lastArrivalMinutes, clockMinutes)
    if (!routeActiveAtServiceTime(route, serviceTime)) continue
    if (route.scheduledTrips?.length) {
      const { trips, maximumRuntimeMinutes } = scheduledTripIndex(route)
      const start = firstTripAtOrAfter(trips, serviceTime - maximumRuntimeMinutes)
      const end = firstTripAfter(trips, serviceTime)
      for (let index = start; index < end; index += 1) {
        const trip = trips[index]
        if (trip.lastArrivalMinutes < serviceTime || !isTripActiveOnServiceDay(trip, serviceDay)) continue
        const vehicle = exactScheduledVehicleForTrip(route, trip, serviceTime)
        if (vehicle) vehicles.push(vehicle)
      }
      continue
    }
  }

  scheduledProjectionCache.set(preview, { key, vehicles })
  return vehicles
}

export function scheduledVehicleDiagnostics(
  preview: MapPreview,
  vehicles: ScheduledVehicle[],
  clockMinutes: number,
  serviceDay: ServiceDay = 'weekday',
): ScheduledVehicleDiagnostics {
  const trustedRoutes = preview.routes.filter(hasTrustworthyVehiclePath)
  const activeRoutes = trustedRoutes.filter((route) => {
    const serviceTime = normalizeServiceTime(route.lastArrivalMinutes, clockMinutes)
    return routeActiveAtServiceTime(route, serviceTime)
  })
  const clock = formatScheduleClock(clockMinutes)

  if (!preview.routes.length) {
    return {
      tone: 'empty',
      title: 'No routes in scope',
      detail: 'Select a feed or route with indexed GTFS geometry.',
    }
  }

  if (!trustedRoutes.length) {
    return {
      tone: 'empty',
      title: 'No vehicle path',
      detail: 'Vehicle projection requires published shapes.txt geometry. Stop-order chords are never used as simulated vehicle paths.',
    }
  }

  if (!activeRoutes.length) {
    return {
      tone: 'empty',
      title: 'No active service',
      detail: `No trusted routes are active at ${clock} on ${serviceDay}. Scrub time or change service day.`,
    }
  }

  if (!vehicles.length) {
    return {
      tone: 'watch',
      title: 'No scheduled trips at this time',
      detail: `${activeRoutes.length} trusted route${activeRoutes.length === 1 ? '' : 's'} are active at ${clock}, but the static GTFS has no trip between stops at this instant.`,
    }
  }

  return {
    tone: 'good',
    title: `${vehicles.length.toLocaleString()} scheduled vehicle${vehicles.length === 1 ? '' : 's'}`,
    detail: `${vehicles.length.toLocaleString()} exact GTFS trip${vehicles.length === 1 ? '' : 's'} projected on published shapes at ${clock}; no inferred headway vehicles are added.`,
  }
}
