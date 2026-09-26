import { realtimeSources, type RealtimeSource } from '../shared/realtime-sources.mjs'
export { realtimeSources, maximumRealtimeSources, type RealtimeSource } from '../shared/realtime-sources.mjs'

export type RealtimeInspectRequest =
  | { sources: RealtimeSource[] }
  | { url: string }
  | { urls: { vehicles?: string; tripUpdates?: string; alerts?: string } }

export const realtimeRefreshMs = 60_000
export const mbtaRealtimeSources: RealtimeSource[] = [
  { kind: 'vehicles', url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb' },
  { kind: 'tripUpdates', url: 'https://cdn.mbta.com/realtime/TripUpdates.pb' },
  { kind: 'alerts', url: 'https://cdn.mbta.com/realtime/Alerts.pb' },
]

export function realtimeRequestFromSources(sources: RealtimeSource[]): RealtimeInspectRequest {
  return { sources: realtimeSources({ sources }) }
}
