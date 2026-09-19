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
function matchesPairMember(vehicle: RealtimeVehicle, event: OperationalEvent, leading = false) {
  const tripId = leading ? event.evidence.tripIds?.[0] : event.tripId
  return Boolean(tripId && vehicle.tripId && vehicle.startDate && vehicle.routeId
    && vehicle.id === (leading ? event.evidence.leadingVehicleId : event.vehicleId)
    && raw(vehicle.tripId) === raw(tripId) && raw(vehicle.routeId) === raw(event.routeId)
    && vehicle.startDate.replaceAll('-', '') === event.serviceDate?.replaceAll('-', '')
    && vehicle.startTime === (leading ? event.evidence.leadingTripStartTime : event.evidence.tripStartTime))
}
// Match the reported vehicle AND trip instance, never a route number alone.
export function vehicleAlert(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, events: OperationalEvent[], kind: 'spacing' | 'delay' = 'spacing', now = Date.now() / 1000) {
  if (!vehicleReportFresh(vehicle, snapshot, now)) return undefined
  if (!vehicle.tripId || !vehicle.startDate || !vehicle.routeId) return undefined
  const peers = snapshot.vehicles.filter(item => raw(item.tripId) === raw(vehicle.tripId) && item.startDate === vehicle.startDate && item.startTime === vehicle.startTime)
  if (peers.length !== 1) return undefined
  return events.filter(event => (kind === 'delay' ? event.type === 'delay' : ['service-gap', 'bunching'].includes(event.type))
    && (matchesPairMember(vehicle, event) || event.type === 'bunching' && matchesPairMember(vehicle, event, true))
    && Number.isFinite(Date.parse(event.observedAt)) && Math.abs(now - Date.parse(event.observedAt) / 1000) <= 180)
    .sort((a, b) => ({ critical: 2, warning: 1, info: 0 }[b.severity] - { critical: 2, warning: 1, info: 0 }[a.severity]) || Math.abs((b.evidence.observedHeadwaySeconds ?? 0) - (b.evidence.scheduledHeadwaySeconds ?? 0) || b.evidence.delaySeconds || 0) - Math.abs((a.evidence.observedHeadwaySeconds ?? 0) - (a.evidence.scheduledHeadwaySeconds ?? 0) || a.evidence.delaySeconds || 0))[0]
}

export function vehicleGap(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, events: OperationalEvent[], now = Date.now() / 1000) {
  return vehicleAlert(vehicle, snapshot, events, 'spacing', now)
}

export function bunchingPartner(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, event?: OperationalEvent, now = Date.now() / 1000) {
  if (event?.type !== 'bunching' || event.severity === 'info' || !event.evidence.leadingVehicleId || !event.evidence.tripIds?.[0]) return undefined
  const following = matchesPairMember(vehicle, event)
  if (!following && !matchesPairMember(vehicle, event, true)) return undefined
  const candidates = snapshot.vehicles.filter(item => matchesPairMember(item, event, following) && vehicleReportFresh(item, snapshot, now))
  return candidates.length === 1 ? candidates[0] : undefined
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
