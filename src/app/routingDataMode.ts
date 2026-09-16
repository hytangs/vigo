import type { RoutingDataMode } from '../routingModel'

export const routingDataModeStorageKey = 'vigo-agency-routing-data-mode'

export function readRoutingDataModePreference(): RoutingDataMode {
  try {
    return window.localStorage.getItem(routingDataModeStorageKey) === 'scheduled' ? 'scheduled' : 'realtime'
  } catch {
    return 'realtime'
  }
}

export function saveRoutingDataModePreference(mode: RoutingDataMode) {
  try { window.localStorage.setItem(routingDataModeStorageKey, mode) } catch { /* Storage may be unavailable. */ }
}
