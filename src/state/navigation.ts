import { apiJson } from '../app/api'
import { requestDesktopHomeFolder } from '../app/desktopBridge'
import { rememberProject, rememberSearchResult } from '../app/navigationMemory'
import { bundleFeedId, hasOperationsData, mergeProjectLists, preferredProjectId } from '../app/projectState'
import type { HealthResponse, ProjectDraft, SetupDraft, VigoRuntimeConfig } from '../app/runtimeConfig'
import type { SearchResult } from '../features/search/searchModel'
import type { VigoProject } from '../domain'
import { clearAnalysisState, invalidateAnalyzeResult } from './analyze'
import { cancelProjectDetail, city, replaceProject, routingMerge, startCitySelection } from './city'
import {
  applyNetworkMapDefaults,
  browseAgencyEntities,
  cancelRouteAnalysis,
  clearAgencyMap,
  clearRealtimeConnection,
  network,
  selectRoute,
  selectStop,
} from './network'
import { clearRouting, route, routeDateAlignment, runRoutingSearch } from './route'
import { hasActiveOperationsData, isProjectEmpty, preview, selectedProject } from './scope'
import { applyRuntimeConfig, navigation, setApiError, shell } from './shell'

/** Reset the workspaces for a newly selected City. */
export function applyCitySelection(projectId: string) {
  cancelRouteAnalysis()
  if (city.get().selectedProjectId !== projectId) {
    clearRouting()
    clearAnalysisState()
    clearAgencyMap()
  }
  city.set({ selectedProjectId: projectId, activeFeedId: bundleFeedId, statusFilter: 'all' })
  network.set({
    selectedRouteId: navigation.memory.lastRouteByProject[projectId] ?? '',
    routeRenderMode: 'service',
    selectedStopId: '',
  })
  shell.set({ query: '', apiError: '' })
  navigation.memory = rememberProject(projectId)
}

export function beginCitySelection(projectId: string) {
  startCitySelection(projectId, applyCitySelection, setApiError)
}

let projectsLoadSequence = 0

export async function loadProjects() {
  const sequence = ++projectsLoadSequence
  city.set({ projectsLoadState: 'loading' })
  try {
    const [healthResult, projectsResult] = await Promise.all([
      apiJson<HealthResponse>('/api/health'),
      apiJson<{ projects: VigoProject[] }>('/api/projects'),
    ])
    if (sequence !== projectsLoadSequence) return
    city.set({ projectsLoadState: 'ready' })
    const config = healthResult.config ?? null
    shell.set({ health: healthResult, runtimeConfig: config })

    if (config) shell.set({ appearance: config.appearance, accent: config.accent, basemap: config.basemap })

    if (config?.setupRequired) {
      city.set({ projects: [], selectedProjectId: '' })
      shell.set({ page: 'projects', setupOpen: true, apiError: '' })
      return
    }

    const { projects, selectedProjectId } = city.get()
    const nextProjects = mergeProjectLists(projects, projectsResult.projects)
    const rememberedProjectId = navigation.memory.lastProjectId
    const currentSelectedId = nextProjects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : nextProjects.some((project) => project.id === rememberedProjectId)
        ? rememberedProjectId
        : ''
    const nextSelectedId = preferredProjectId(nextProjects, currentSelectedId)
    city.set({ projects: nextProjects })
    applyNetworkMapDefaults()
    setApiError('')
    if (nextSelectedId) city.set({ selectedProjectId: nextSelectedId })
  } catch (error) {
    if (sequence !== projectsLoadSequence) return
    city.set({ projectsLoadState: 'failed' })
    setApiError(error instanceof Error ? error.message : 'Local API unavailable')
    try {
      const configResult = await apiJson<{ config: VigoRuntimeConfig }>('/api/config')
      if (sequence === projectsLoadSequence) shell.set({ runtimeConfig: configResult.config })
    } catch {
      // If the local runtime never started there is no frontend surface to recover from.
    }
  }
}

/** Apply a City whose sources were removed or reset by the engine. */
export function applyCityReset(cleanedProject: VigoProject) {
  cancelProjectDetail(cleanedProject.id)
  city.set(({ projects }) => ({ projects: projects.map((project) => project.id === cleanedProject.id ? cleanedProject : project) }))
  if (city.get().selectedProjectId !== cleanedProject.id) return
  city.set({ openedNetworkProjectId: '' })

  cancelRouteAnalysis()
  invalidateAnalyzeResult()
  clearRouting()
  network.set({ selectedRouteId: '', selectedStopId: '' })
  city.set({ activeFeedId: bundleFeedId, statusFilter: 'all' })
  shell.set({ query: '' })
  clearRealtimeConnection()
  city.set({ osmStreetMessage: '', importMessage: '' })
}

function closeCity() {
  cancelProjectDetail(city.get().selectedProjectId)
  cancelRouteAnalysis()
  clearAnalysisState()
  clearRouting()
  clearAgencyMap()
  routeDateAlignment.storeKey = ''
  routingMerge.requestKey = ''
  network.set({ selectedRouteId: '', routeRenderMode: 'service', selectedStopId: '' })
  city.set({ activeFeedId: bundleFeedId })
  clearRealtimeConnection()
  route.set({ routingResidencyCoverage: null })
  city.set({ osmStreetMessage: '', statusFilter: 'all' })
  shell.set({ query: '', activeRouteTool: 'agency', sidebarCollapsed: false })
  applyNetworkMapDefaults()
}

export function showProjects() {
  closeCity()
  shell.set({ page: 'projects' })
}

export function openProject(projectId: string) {
  const { projects, selectedProjectId } = city.get()
  const project = projects.find((item) => item.id === projectId)
  city.set({ openedNetworkProjectId: project && hasOperationsData(project) ? projectId : '' })
  if (selectedProjectId && selectedProjectId !== projectId) clearRealtimeConnection()
  beginCitySelection(projectId)
  shell.set({ page: 'project', activeRouteTool: 'agency' })
  applyNetworkMapDefaults()
}

/** Open a City straight into its data sources from the City library. */
export function openProjectData(projectId: string) {
  applyCitySelection(projectId)
  shell.set({ page: 'project', dataSection: 'feeds', activeRouteTool: 'data' })
}

export function selectFeed(feedId: string) {
  cancelRouteAnalysis()
  if (feedId !== city.get().activeFeedId) clearRealtimeConnection()
  city.set({ activeFeedId: feedId, statusFilter: 'all' })
  shell.set({ query: '', dataSection: 'feeds', activeRouteTool: 'data' })
}

export function openNetworkView() {
  const project = selectedProject()
  if (!hasOperationsData(project)) return
  city.set({ openedNetworkProjectId: project.id })
  shell.set({ activeRouteTool: 'agency', sidebarCollapsed: false })
  route.set({ routingEnabled: false })
}

export function openPathfinderView() {
  const project = selectedProject()
  if (!hasOperationsData(project)) return
  city.set({ openedNetworkProjectId: project.id })
  shell.set({ activeRouteTool: 'pathfinder' })
  network.set({ mapScope: 'route' })
  route.set({ routingEnabled: false })
}

export function openAnalyzeView() {
  const project = selectedProject()
  if (!hasOperationsData(project)) return
  city.set({ openedNetworkProjectId: project.id })
  shell.set({ activeRouteTool: 'analyze' })
  network.set({ mapScope: 'network' })
  route.set({ routingEnabled: false })
}

export function openDataView() {
  // Opening City data retries a combined routing build that may have failed.
  routingMerge.requestKey = ''
  city.set(({ routingMergeRetryNonce }) => ({ routingMergeRetryNonce: routingMergeRetryNonce + 1 }))
  shell.set({ dataSection: 'feeds', activeRouteTool: 'data' })
}

export function openSettingsView() {
  const { projects, selectedProjectId } = city.get()
  const nextProjectId = selectedProjectId || preferredProjectId(projects, navigation.memory.lastProjectId)
  if (nextProjectId && (shell.get().page !== 'project' || selectedProjectId !== nextProjectId)) {
    applyCitySelection(nextProjectId)
  }
  shell.set({ page: 'project', dataSection: 'preferences', activeRouteTool: 'data' })
}

export function activateSearchResult(result: SearchResult) {
  if (result.routingQuery) {
    shell.set({ page: 'project' })
    runRoutingSearch(result.routingQuery)
    return
  }
  const nextMemory = rememberSearchResult(result.id)
  navigation.memory = nextMemory
  shell.set({ recentSearchIds: nextMemory.recentSearchIds, query: '' })

  if (result.kind === 'city') {
    openProject(result.id.slice('city:'.length))
    return
  }
  if (result.kind === 'route') {
    shell.set({ page: 'project' })
    selectRoute(result.id.slice('route:'.length))
    return
  }
  if (result.kind === 'stop') {
    shell.set({ page: 'project' })
    const stopId = result.id.slice('stop:'.length)
    const stop = preview().stops.find((item) => item.id === stopId)
    if (shell.get().activeRouteTool === 'agency') browseAgencyEntities([], [stopId], stop && typeof stop.lon === 'number' && typeof stop.lat === 'number' ? { id: stopId, label: stop.name, coordinate: [stop.lon, stop.lat] } : undefined)
    else selectStop(stopId)
    network.set(({ layers }) => ({ mapScope: 'network', layers: { ...layers, routes: true, stops: true, transfers: true } }))
    return
  }

  if (result.id === 'command:cities') {
    showProjects()
    return
  }
  shell.set({ page: 'project' })
  if (result.id === 'command:pathfinder') openPathfinderView()
  else if (result.id === 'command:analyze') openAnalyzeView()
  else if (result.id === 'command:data') openDataView()
  else if (result.id === 'command:preferences') openSettingsView()
  else openNetworkView()
}

/** Enter in the search field runs a typed journey. */
export function runCommandCenter() {
  const commandText = shell.get().query.trim()
  if (!commandText) return
  runRoutingSearch(commandText)
}

export function handleDesktopCommand(command: 'toggleSidebar' | 'navigateBack' | 'navigateForward') {
  const { page } = shell.get()
  if (command === 'toggleSidebar' && page === 'project' && !isProjectEmpty()) {
    shell.set(({ sidebarCollapsed }) => ({ sidebarCollapsed: !sidebarCollapsed }))
    return
  }
  if (command === 'navigateBack' && page === 'project') {
    showProjects()
    return
  }
  const projectId = selectedProject().id
  if (command === 'navigateForward' && page === 'projects' && city.get().projects.some((project) => project.id === projectId)) {
    openProject(projectId)
  }
}

/** Number keys switch workspaces: 1 Network, 2 Route, 3 Analyze, 5 Settings. */
export function handleCityShortcut(event: KeyboardEvent) {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  if (shell.get().page !== 'project' && event.code !== 'Digit5') return
  const target = event.target
  if (
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
  ) return

  const activeData = hasActiveOperationsData()
  let action: (() => void) | null = null
  switch (event.code) {
    case 'Digit1':
      action = activeData ? openNetworkView : null
      break
    case 'Digit2':
      action = activeData ? openPathfinderView : null
      break
    case 'Digit3':
      action = activeData ? openAnalyzeView : null
      break
    case 'Digit4':
      action = activeData ? openNetworkView : null
      break
    case 'Digit5':
      action = openSettingsView
      break
    default:
      return
  }
  if (!action) return
  event.preventDefault()
  action()
}

// City library dialogs.
export function openCreateProjectDialog() {
  shell.set({ projectDialogError: '', projectDialog: { mode: 'create', name: '' } })
}

export function openRenameProjectDialog(projectId: string) {
  const project = city.get().projects.find((item) => item.id === projectId)
  if (!project) return
  shell.set({ projectDialogError: '', projectDialog: { mode: 'rename', projectId, name: project.name } })
}

export function closeProjectDialog() {
  if (shell.get().projectDialogBusy) return
  shell.set({ projectDialog: null, projectDialogError: '' })
}

export async function submitProjectDialog(draft: ProjectDraft) {
  const { projectDialog, projectDialogBusy } = shell.get()
  if (!projectDialog || projectDialogBusy) return

  if (projectDialog.mode === 'delete') {
    if (draft.name !== projectDialog.name) return
    shell.set({ projectDialogBusy: true, projectDialogError: '' })
    try {
      if (await deleteProject(projectDialog.projectId, { confirm: false })) shell.set({ projectDialog: null })
    } finally {
      shell.set({ projectDialogBusy: false })
    }
    return
  }

  const name = draft.name.trim()

  if (!name) {
    shell.set({ projectDialogError: 'City name is required.' })
    return
  }

  shell.set({ projectDialogBusy: true, projectDialogError: '' })

  if (projectDialog.mode === 'create') {
    await createProject(name)
  } else {
    await renameProject(projectDialog.projectId, name)
  }
}

async function createProject(name: string) {
  try {
    const result = await apiJson<{ project: VigoProject }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    replaceProject(result.project)
    openProject(result.project.id)
    shell.set({ projectDialog: null, projectDialogError: '', apiError: '' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local API unavailable'
    shell.set({ projectDialogError: `City was not saved: ${message}`, apiError: `City was not saved: ${message}` })
  } finally {
    shell.set({ projectDialogBusy: false })
  }
}

async function renameProject(projectId: string, name: string) {
  const project = city.get().projects.find((item) => item.id === projectId)
  if (!project) {
    shell.set({ projectDialogBusy: false })
    return
  }

  try {
    const result = await apiJson<{ project: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    replaceProject(result.project)
    shell.set({ projectDialog: null, projectDialogError: '', apiError: '' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local API unavailable'
    shell.set({ projectDialogError: `City rename was not saved: ${message}`, apiError: `City rename was not saved: ${message}` })
  } finally {
    shell.set({ projectDialogBusy: false })
  }
}

export async function deleteProject(projectId: string, options: { confirm?: boolean } = {}): Promise<boolean> {
  const project = city.get().projects.find((item) => item.id === projectId)
  if (!project) return false

  if (options.confirm !== false) {
    shell.set({ projectDialogError: '', projectDialog: { mode: 'delete', projectId, name: project.name } })
    return false
  }

  const selectedProjectId = city.get().selectedProjectId
  const applyDeletion = (nextProjects: VigoProject[]) => {
    city.set({ projects: nextProjects })
    const nextSelectedId = preferredProjectId(nextProjects, selectedProjectId === projectId ? '' : selectedProjectId)
    cancelProjectDetail(projectId)
    if (nextSelectedId) beginCitySelection(nextSelectedId)
    else {
      clearRouting()
      city.set({ selectedProjectId: '', activeFeedId: bundleFeedId, statusFilter: 'all' })
      shell.set({ query: '' })
    }
    if (!nextProjects.length || selectedProjectId === projectId) shell.set({ page: 'projects' })
  }

  try {
    const result = await apiJson<{ ok: boolean; projects: VigoProject[] }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    })
    applyDeletion(result.projects)
    setApiError('')
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local API unavailable'
    shell.set({ apiError: `City was not deleted: ${message}`, projectDialogError: `City was not deleted: ${message}` })
    return false
  }
}

export const removeProject = (projectId: string) => deleteProject(projectId, { confirm: false })
export const confirmDeleteProject = (projectId: string) => { void deleteProject(projectId) }

// First-run setup and library recovery.
export async function submitSetup(draft: SetupDraft) {
  const storageRoot = draft.storageRoot.trim()
  if (!storageRoot) {
    shell.set({ setupError: 'Choose a VIGO home folder.' })
    return
  }

  shell.set({ setupBusy: true, setupError: '' })

  try {
    const result = await apiJson<{ config: VigoRuntimeConfig }>('/api/config', {
      method: 'PATCH',
      body: JSON.stringify(draft),
    })
    applyRuntimeConfig(result.config)
    shell.set({
      appearance: result.config.appearance,
      accent: result.config.accent,
      basemap: result.config.basemap,
      setupOpen: false,
      apiError: '',
      page: 'projects',
    })
    await loadProjects()
  } catch (error) {
    shell.set({ setupError: error instanceof Error ? error.message : 'Setup failed.' })
  } finally {
    shell.set({ setupBusy: false })
  }
}

export async function recoverStorageRoot(storageRoot: string) {
  const { runtimeConfig, appearance, accent, basemap } = shell.get()
  if (!runtimeConfig) return
  shell.set({ setupBusy: true, setupError: '' })
  try {
    const result = await apiJson<{ config: VigoRuntimeConfig }>('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({ storageRoot, appearance, accent, basemap }),
    })
    applyRuntimeConfig(result.config)
    shell.set({ apiError: '', page: 'projects' })
    await loadProjects()
  } catch (error) {
    shell.set({ setupError: error instanceof Error ? error.message : 'The City library is still unavailable.' })
  } finally {
    shell.set({ setupBusy: false })
  }
}

export function chooseRecoveryFolder() {
  const openedDesktop = requestDesktopHomeFolder((path) => {
    void recoverStorageRoot(path)
  })
  if (!openedDesktop) shell.set({ setupOpen: true })
}

export function chooseDataFolder() {
  shell.set({ setupError: '' })
  const openedDesktop = requestDesktopHomeFolder((path) => {
    void recoverStorageRoot(path)
  })
  if (!openedDesktop) shell.set({ setupError: 'Folder selection is available in VIGO Studio.' })
}

export function recoverDefaultStorageRoot() {
  const { runtimeConfig } = shell.get()
  if (runtimeConfig) void recoverStorageRoot(runtimeConfig.defaultStorageRoot)
}

export function closeSetup() {
  if (!shell.get().runtimeConfig?.setupRequired) shell.set({ setupOpen: false })
}
