import type { RealtimeSnapshot, RealtimeVehicle } from '../domain'
import type { OperationalEvent } from './types'

export function occupancyIndicator(status?: string) {
  const labels: Record<string, string> = { EMPTY: 'Empty', MANY_SEATS_AVAILABLE: 'Seats available', FEW_SEATS_AVAILABLE: 'Few seats', STANDING_ROOM_ONLY: 'Standing room', CRUSHED_STANDING_ROOM_ONLY: 'Crowded', FULL: 'Full', NOT_ACCEPTING_PASSENGERS: 'Not accepting passengers', NOT_BOARDABLE: 'Not boardable' }
  return { label: labels[status || ''] || 'Occupancy unknown', crowded: ['CRUSHED_STANDING_ROOM_ONLY', 'FULL', 'NOT_ACCEPTING_PASSENGERS'].includes(status || '') }
}
export function vehicleReportFresh(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, now = Date.now() / 1000) {
  const feed = snapshot.feeds?.find(item => item.sourceUrl === vehicle.sourceUrl)
  const timestamp = vehicle.sourceFeedTimestamp ?? feed?.feedTimestamp
  return Boolean(vehicle.timestamp && Math.abs(now - vehicle.timestamp) <= 180 && timestamp && Math.abs(now - timestamp) <= 180 && !feed?.error)
}
const raw = (id?: string) => id?.split('\u001f').at(-1)
const sameId = (a?: string, b?: string) => Boolean(a && b && (a.includes('\u001f') && b.includes('\u001f') ? a === b : raw(a) === raw(b)))
function eventFresh(event: OperationalEvent, now: number) {
  const observed = Date.parse(event.observedAt) / 1000
  return Number.isFinite(observed) && Math.abs(now - observed) <= 180
}
function alertDifference(event: OperationalEvent) {
  const e = event.evidence
  return Math.abs((e.observedHeadwaySeconds ?? 0) - (e.scheduledHeadwaySeconds ?? 0) || e.delaySeconds || 0)
}
const severityRank = { critical: 2, warning: 1, info: 0 }
function matchesPairMember(vehicle: RealtimeVehicle, event: OperationalEvent, leading = false) {
  const tripId = leading ? event.evidence.tripIds?.[0] : event.tripId
  return Boolean(tripId && vehicle.tripId && vehicle.startDate && vehicle.routeId
    && vehicle.id === (leading ? event.evidence.leadingVehicleId : event.vehicleId)
    && sameId(vehicle.tripId, tripId) && sameId(vehicle.routeId, event.routeId)
    && vehicle.startDate.replaceAll('-', '') === event.serviceDate?.replaceAll('-', '')
    && vehicle.startTime === (leading ? event.evidence.leadingTripStartTime : event.evidence.tripStartTime))
}
// Match the reported vehicle AND trip instance, never a route number alone.
function uniqueCurrentVehicle(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, now: number) {
  if (!vehicleReportFresh(vehicle, snapshot, now) || !vehicle.tripId || !vehicle.startDate || !vehicle.routeId) return false
  return snapshot.vehicles.filter(item => sameId(item.tripId, vehicle.tripId) && sameId(item.routeId, vehicle.routeId)
    && item.startDate?.replaceAll('-', '') === vehicle.startDate?.replaceAll('-', '') && item.startTime === vehicle.startTime).length === 1
}
export function vehicleAlerts(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, events: OperationalEvent[], kind: 'spacing' | 'delay' = 'spacing', now = Date.now() / 1000) {
  if (!uniqueCurrentVehicle(vehicle, snapshot, now)) return []
  return events.filter(event => (kind === 'delay' ? event.type === 'delay' : ['service-gap', 'bunching'].includes(event.type))
    && (matchesPairMember(vehicle, event) || event.type === 'bunching' && matchesPairMember(vehicle, event, true))
    && eventFresh(event, now))
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || alertDifference(b) - alertDifference(a))
}
export function vehicleAlert(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, events: OperationalEvent[], kind: 'spacing' | 'delay' = 'spacing', now = Date.now() / 1000) {
  return vehicleAlerts(vehicle, snapshot, events, kind, now)[0]
}

export function vehicleGap(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, events: OperationalEvent[], now = Date.now() / 1000) {
  return vehicleAlert(vehicle, snapshot, events, 'spacing', now)
}

export function bunchingPartner(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, event?: OperationalEvent, now = Date.now() / 1000) {
  if (event?.type !== 'bunching' || event.severity === 'info' || !event.evidence.leadingVehicleId || !event.evidence.tripIds?.[0]) return undefined
  if (!uniqueCurrentVehicle(vehicle, snapshot, now) || !eventFresh(event, now)) return undefined
  const following = matchesPairMember(vehicle, event)
  if (!following && !matchesPairMember(vehicle, event, true)) return undefined
  const candidates = snapshot.vehicles.filter(item => matchesPairMember(item, event, following) && vehicleReportFresh(item, snapshot, now))
  return candidates.length === 1 && candidates[0].id !== vehicle.id && uniqueCurrentVehicle(candidates[0], snapshot, now) ? candidates[0] : undefined
}

// Carriage reports are not a whole-train occupancy estimate.
export function vehicleOccupancyIndicator(status?: string, carriages: NonNullable<RealtimeVehicle['carriages']> = []) {
  const overall = occupancyIndicator(status)
  if (overall.label !== 'Occupancy unknown') return overall
  const reported = carriages.filter(car => occupancyIndicator(car.occupancyStatus).label !== 'Occupancy unknown')
  if (!reported.length) return overall
  const crowded = reported.filter(car => occupancyIndicator(car.occupancyStatus).crowded).length
  return { label: `${reported.length}/${carriages.length} cars reporting${crowded ? ` · ${crowded} crowded` : ''}`, crowded: crowded > 0 }
}
