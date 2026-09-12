import type { RouteMetric, StopMetric } from '../domain'

export function gtfsDirectionLabel(directionId?: string) {
  return directionId === undefined || directionId.trim() === '' ? 'Direction not provided' : `Direction ${directionId}`
}

export function orderedGtfsPatterns(routes: RouteMetric[]) {
  return [...routes].sort((left, right) => (
    (left.patternRank ?? Number.MAX_SAFE_INTEGER) - (right.patternRank ?? Number.MAX_SAFE_INTEGER)
    || right.tripCount - left.tripCount
    || left.id.localeCompare(right.id, undefined, { numeric: true })
  ))
}

export function gtfsPatternStops(route: RouteMetric, stops: StopMetric[] | Map<string, StopMetric>) {
  const byId = stops instanceof Map ? stops : new Map(stops.map((stop) => [stop.id, stop]))
  // Preserve repeated stops: a loop may visit the same stop more than once.
  return route.stopIds.map((id, index) => ({
    id,
    order: index + 1,
    name: byId.get(id)?.name || id,
    platform: byId.get(id)?.platformCode,
  }))
}

export function gtfsServiceClock(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes))
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`
}

export function gtfsPatternTimetable(route: RouteMetric) {
  const dated = Boolean(route.analysisServiceDate && Array.isArray(route.scheduledTrips))
  const starts = dated
    ? route.scheduledTrips!.map((trip) => trip.firstDepartureMinutes).filter(Number.isFinite)
    : [route.firstDepartureMinutes].filter((value): value is number => Number.isFinite(value))
  const ends = dated
    ? route.scheduledTrips!.map((trip) => trip.lastArrivalMinutes).filter(Number.isFinite)
    : [route.lastArrivalMinutes].filter((value): value is number => Number.isFinite(value))
  const startMinutes = starts.length ? Math.min(...starts) : undefined
  const endMinutes = ends.length ? Math.max(...ends) : undefined
  return {
    dated,
    tripCount: dated ? route.scheduledTrips!.length : route.tripCount,
    startMinutes,
    endMinutes,
    spanLabel: startMinutes !== undefined && endMinutes !== undefined
      ? `${gtfsServiceClock(startMinutes)}–${gtfsServiceClock(endMinutes)}`
      : dated && !route.scheduledTrips!.length ? 'No trips on this date' : 'Times unavailable',
  }
}
