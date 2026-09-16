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
// Match the reported vehicle AND trip instance, never a route number alone.
export function vehicleAlert(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, events: OperationalEvent[], kind: 'spacing' | 'delay' = 'spacing', now = Date.now() / 1000) {
  if (!vehicleReportFresh(vehicle, snapshot, now)) return undefined
  if (!vehicle.tripId || !vehicle.startDate || !vehicle.routeId) return undefined
  const peers = snapshot.vehicles.filter(item => raw(item.tripId) === raw(vehicle.tripId) && item.startDate === vehicle.startDate && item.startTime === vehicle.startTime)
  if (peers.length !== 1) return undefined
  return events.filter(event => (kind === 'delay' ? event.type === 'delay' : ['service-gap', 'bunching'].includes(event.type)) && event.vehicleId === vehicle.id && raw(event.tripId) === raw(vehicle.tripId)
    && raw(event.routeId) === raw(vehicle.routeId) && event.serviceDate?.replaceAll('-', '') === vehicle.startDate?.replaceAll('-', '')
    && event.evidence.tripStartTime === vehicle.startTime
    && Number.isFinite(Date.parse(event.observedAt)) && Math.abs(now - Date.parse(event.observedAt) / 1000) <= 180)
    .sort((a, b) => ({ critical: 2, warning: 1, info: 0 }[b.severity] - { critical: 2, warning: 1, info: 0 }[a.severity]) || Math.abs((b.evidence.observedHeadwaySeconds ?? 0) - (b.evidence.scheduledHeadwaySeconds ?? 0) || b.evidence.delaySeconds || 0) - Math.abs((a.evidence.observedHeadwaySeconds ?? 0) - (a.evidence.scheduledHeadwaySeconds ?? 0) || a.evidence.delaySeconds || 0))[0]
}

export function vehicleGap(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, events: OperationalEvent[], now = Date.now() / 1000) {
  return vehicleAlert(vehicle, snapshot, events, 'spacing', now)
}

export function bunchingPartner(vehicle: RealtimeVehicle, snapshot: RealtimeSnapshot, event?: OperationalEvent, now = Date.now() / 1000) {
  if (event?.type !== 'bunching' || event.severity === 'info' || !event.evidence.leadingVehicleId || !event.evidence.tripIds?.[0]) return undefined
  const candidates = snapshot.vehicles.filter(item => item.id === event.evidence.leadingVehicleId && raw(item.tripId) === raw(event.evidence.tripIds?.[0])
    && raw(item.routeId) === raw(vehicle.routeId) && item.startDate?.replaceAll('-', '') === event.serviceDate?.replaceAll('-', '')
    && item.startTime === event.evidence.leadingTripStartTime && vehicleReportFresh(item, snapshot, now))
  return candidates.length === 1 ? candidates[0] : undefined
}
