import type { Basemap, NetworkLens } from '../domain'
import type { RoutingTimePreference } from '../routingModel'

export type RoutingDepartureWindowMinutes = 0 | 20

export const schedulePresets = [
  { label: 'AM', minutes: 8 * 60 },
  { label: 'Mid', minutes: 12 * 60 },
  { label: 'PM', minutes: 17 * 60 },
  { label: 'Eve', minutes: 20 * 60 },
]

export const networkLensOptions: NetworkLens[] = ['network', 'shape', 'service', 'transfer', 'risk']
export const basemapOptions: Basemap[] = ['offline', 'none', 'minimal', 'streets', 'dark', 'terrain']

export const routingTimeOptions: Array<{ label: string; value: RoutingTimePreference }> = [
  { label: 'Depart', value: 'depart' },
  { label: 'Arrive', value: 'arrive' },
]

export const routingMaxWalkOptions = [0.4, 0.8, 1.2, 1.8, 2.4]
