import type { Appearance, Basemap } from '../domain'

export type AppAccent = 'teal' | 'blue' | 'graphite'

type OfflineStatus = {
  localServer: boolean
  bundledApp: boolean
  storageWritable: boolean
  storageError?: string
  gtfsImport: boolean
  offlineBasemap: boolean
  remoteFeedUrlsRequireNetwork: boolean
  realtimeUrlsRequireNetwork: boolean
}

export type VigoRuntimeConfig = {
  schemaVersion: string
  configured: boolean
  setupRequired: boolean
  storageRoot: string
  defaultStorageRoot: string
  configFile: string
  canChangeStorageRoot: boolean
  appearance: Appearance
  accent: AppAccent
  basemap: Basemap
  offline: OfflineStatus
}

export type HealthResponse = {
  ok: boolean
  storageRoot: string
  version: string
  config?: VigoRuntimeConfig
  offline?: OfflineStatus
}

export type SetupDraft = {
  storageRoot: string
  appearance: Appearance
  accent: AppAccent
  basemap: Basemap
}

export type ProjectDialogState =
  | { mode: 'create'; name: string; region: string }
  | { mode: 'rename'; projectId: string; name: string; region: string }

export type ProjectDraft = {
  name: string
  region: string
}
