import { apiJson } from '../app/api'
import { readNavigationMemory } from '../app/navigationMemory'
import type { AppAccent, HealthResponse, ProjectDialogState, VigoRuntimeConfig } from '../app/runtimeConfig'
import { createStore } from '../app/store'
import type { DataSection } from '../components/CityPanel'
import type { RouteToolKey } from '../components/PrimaryNav'
import type { Appearance, Basemap } from '../domain'

/** Shell and navigation: preferences, the active page and workspace, search, dialogs. */
export type ShellState = {
  appearance: Appearance
  accent: AppAccent
  basemap: Basemap
  health: HealthResponse | null
  runtimeConfig: VigoRuntimeConfig | null
  setupOpen: boolean
  setupBusy: boolean
  setupError: string
  apiError: string
  page: 'projects' | 'project'
  activeRouteTool: RouteToolKey
  dataSection: DataSection
  backgroundTasksOpen: boolean
  query: string
  recentSearchIds: string[]
  projectDialog: ProjectDialogState | null
  projectDialogBusy: boolean
  projectDialogError: string
}

export const routeToolStorageKey = 'vigo-agency-view'

function savedRouteTool(): RouteToolKey {
  try {
    const saved = sessionStorage.getItem(routeToolStorageKey)
    return ['data', 'pathfinder', 'analyze', 'scenarios', 'agency'].includes(saved || '') ? saved as RouteToolKey : 'agency'
  } catch {
    return 'agency'
  }
}

/** Last City, last route per City and recent search results, kept in a cookie. */
export const navigation = { memory: readNavigationMemory() }

const initialShellState = (): ShellState => ({
  appearance: 'dark',
  accent: 'blue',
  basemap: 'offline',
  health: null,
  runtimeConfig: null,
  setupOpen: false,
  setupBusy: false,
  setupError: '',
  apiError: '',
  page: 'projects',
  activeRouteTool: savedRouteTool(),
  dataSection: 'feeds',
  backgroundTasksOpen: false,
  query: '',
  recentSearchIds: navigation.memory.recentSearchIds,
  projectDialog: null,
  projectDialogBusy: false,
  projectDialogError: '',
})

export const shell = createStore<ShellState>(initialShellState())

export function resetShell() {
  navigation.memory = readNavigationMemory()
  shell.set(initialShellState())
}

export const setApiError = (apiError: string) => shell.set({ apiError })
export const setQuery = (query: string) => shell.set({ query })
export const setActiveRouteTool = (activeRouteTool: RouteToolKey) => shell.set({ activeRouteTool })
export const setDataSection = (dataSection: DataSection) => shell.set({ dataSection })
export const setBackgroundTasksOpen = (backgroundTasksOpen: boolean) => shell.set({ backgroundTasksOpen })

export function applyRuntimeConfig(config: VigoRuntimeConfig) {
  shell.set(({ health }) => ({
    runtimeConfig: config,
    health: health ? { ...health, storageRoot: config.storageRoot, config, offline: config.offline } : health,
  }))
}

let preferenceSave: Promise<void> = Promise.resolve()

async function persistRuntimePreferences(next: Partial<Pick<VigoRuntimeConfig, 'appearance' | 'basemap' | 'accent'>>) {
  if (!shell.get().runtimeConfig) return
  // Serialize partial changes so rapid theme/map choices cannot overwrite
  // each other or restore an earlier library folder.
  const save = preferenceSave.then(async () => {
    const result = await apiJson<{ config: VigoRuntimeConfig }>('/api/config', {
      method: 'PATCH',
      body: JSON.stringify(next),
    })
    applyRuntimeConfig(result.config)
  }).catch((error) => {
    setApiError(error instanceof Error ? `Could not save the setting: ${error.message}` : 'Could not save the setting.')
  })
  preferenceSave = save
  await save
}

export function changeAppearance(appearance: Appearance) {
  shell.set({ appearance })
  void persistRuntimePreferences({ appearance })
}

export function changeBasemap(basemap: Basemap) {
  shell.set({ basemap })
  void persistRuntimePreferences({ basemap })
}
