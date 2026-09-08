import type { LngLat, MapPreview, RouteMetric, ScheduledTrip } from './domain'
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
  return formatServiceTime(normalized)
}

// GTFS time is elapsed from the selected service date. 25:30 and 01:30
// belong to different instants, even though their wall-clock labels match.
export function formatServiceTime(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes))
  const hours = Math.floor(rounded / 60)
  const minute = rounded % 60
  return `${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function hasScheduleForDate(route: RouteMetric, serviceDate: string) {
  return Boolean(serviceDate) && route.analysisServiceDate === serviceDate && Array.isArray(route.scheduledTrips)
}

function projectionCacheKey(clockMinutes: number, serviceDate: string) {
  return [
    Math.round(clockMinutes * 60),
    serviceDate,
  ].join(':')
}

export function scheduledServiceEndMinutes(preview: MapPreview, serviceDate: string) {
  let end = 1439
  for (const route of preview.routes) {
    if (!hasScheduleForDate(route, serviceDate)) continue
    for (const trip of route.scheduledTrips ?? []) end = Math.max(end, Math.ceil(trip.lastArrivalMinutes))
  }
  return end
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

function* activeTripsAtTime(route: RouteMetric, serviceTime: number) {
  const { trips, maximumRuntimeMinutes } = scheduledTripIndex(route)
  const start = firstTripAtOrAfter(trips, serviceTime - maximumRuntimeMinutes)
  const end = firstTripAfter(trips, serviceTime)
  for (let index = start; index < end; index += 1) {
    if (trips[index].lastArrivalMinutes >= serviceTime) yield trips[index]
  }
}

export function scheduledVehiclesAtTime(
  preview: MapPreview,
  clockMinutes: number,
  serviceDate: string,
): ScheduledVehicle[] {
  const key = projectionCacheKey(clockMinutes, serviceDate)
  const cached = scheduledProjectionCache.get(preview)
  if (cached?.key === key) return cached.vehicles

  const vehicles: ScheduledVehicle[] = []

  for (const route of preview.routes) {
    // The server has already applied calendar.txt and calendar_dates.txt for
    // this exact date. A second weekday filter can only contradict it. A
    // stale or compact route must wait for its dated analysis to load.
    if (!hasScheduleForDate(route, serviceDate) || !hasTrustworthyVehiclePath(route)) continue
    for (const trip of activeTripsAtTime(route, clockMinutes)) {
      const vehicle = exactScheduledVehicleForTrip(route, trip, clockMinutes)
      if (vehicle) vehicles.push(vehicle)
    }
  }

  scheduledProjectionCache.set(preview, { key, vehicles })
  return vehicles
}

export function scheduledVehicleDiagnostics(
  preview: MapPreview,
  vehicles: ScheduledVehicle[],
  clockMinutes: number,
  serviceDate: string,
): ScheduledVehicleDiagnostics {
  const datedRoutes = preview.routes.filter((route) => hasScheduleForDate(route, serviceDate))
  const missingRoutes = preview.routes.length - datedRoutes.length
  const clock = `${serviceDate} ${formatServiceTime(clockMinutes)}`

  if (!preview.routes.length) {
    return {
      tone: 'empty',
      title: 'No routes in scope',
      detail: 'Select a feed or route with indexed GTFS geometry.',
    }
  }

  if (!datedRoutes.length) {
    return {
      tone: 'watch',
      title: 'Schedule details not loaded',
      detail: `Trip schedules for ${serviceDate} are not loaded in this view. Select a route to load its service for this date.`,
    }
  }

  if (vehicles.length) {
    return {
      tone: missingRoutes ? 'watch' : 'good',
      title: `${vehicles.length.toLocaleString()} scheduled vehicle${vehicles.length === 1 ? '' : 's'}`,
      detail: `${vehicles.length.toLocaleString()} GTFS trip${vehicles.length === 1 ? '' : 's'} projected on published shapes at ${clock}.${missingRoutes ? ` ${missingRoutes} patterns still have no schedule loaded for this date.` : ''}`,
    }
  }

  if (missingRoutes) {
    return {
      tone: 'watch',
      title: 'Schedule details not loaded',
      detail: `${missingRoutes} patterns have no schedule loaded for ${serviceDate}; the loaded patterns have no vehicle to display at ${formatServiceTime(clockMinutes)}.`,
    }
  }

  if (!datedRoutes.some((route) => route.scheduledTrips?.length)) {
    return {
      tone: 'empty',
      title: 'No service on this date',
      detail: `The GTFS calendar and date exceptions contain no trips for these routes on ${serviceDate}.`,
    }
  }

  if (!datedRoutes.some((route) => !activeTripsAtTime(route, clockMinutes).next().done)) {
    return {
      tone: 'empty',
      title: 'No scheduled trips at this time',
      detail: `No trip in the loaded ${serviceDate} timetable spans ${formatServiceTime(clockMinutes)}.`,
    }
  }

  return {
    tone: 'watch',
    title: 'Scheduled trips have no vehicle path',
    detail: `Trips are active at ${clock}, but their published shape or timed stop positions cannot be projected.`,
  }
}
