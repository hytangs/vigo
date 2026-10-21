import type { Basemap } from '../domain'
import type { RoutingTimePreference } from '../routingModel'

export type RoutingDepartureWindowMinutes = 0 | 20
export const basemapOptions: Basemap[] = ['offline', 'none', 'minimal', 'streets', 'dark', 'terrain']

export const routingTimeOptions: Array<{ label: string; value: RoutingTimePreference }> = [
  { label: 'Depart', value: 'depart' },
  { label: 'Arrive', value: 'arrive' },
]
