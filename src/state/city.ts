import { apiJson } from '../app/api'
import type { PreparationTask } from '../app/preparation'
import { bundleFeedId, mergeProjectDetail, mergeProjectState, needsProjectDetail } from '../app/projectState'
import { createStore } from '../app/store'
import type { GtfsRouteStatusFilter, JobRecord, VigoProject } from '../domain'

export type StreetPreparationState = {
  task: PreparationTask | null
  walkReady: boolean
  ready: boolean
  error: string
}

/** City data: the library, the selected City, its feed scope and data preparation. */
export type CityState = {
  projects: VigoProject[]
  projectsLoadState: 'loading' | 'ready' | 'failed'
  selectedProjectId: string
  openedNetworkProjectId: string
  /** The City whose transit feeds and map data are being loaded. */
  cityPreviewLoadingProjectId: string
  activeFeedId: string
  statusFilter: GtfsRouteStatusFilter
  osmStreetMessage: string
  importMessage: string
  isImporting: boolean
  isOsmImporting: boolean
  gtfsImportJobId: string
  osmImportJobId: string
  pendingPreparations: Record<string, PreparationTask>
  preparationErrors: Record<string, string>
  /** Frequent job ticks, kept apart from the feeds used to build the map. */
  preparationJobUpdates: Record<string, JobRecord>
  streetPreparation: StreetPreparationState
  routingMergeRetryNonce: number
}

const initialCityState = (): CityState => ({
  projects: [],
  projectsLoadState: 'loading',
  selectedProjectId: '',
  openedNetworkProjectId: '',
  cityPreviewLoadingProjectId: '',
  activeFeedId: bundleFeedId,
  statusFilter: 'all',
  osmStreetMessage: '',
  importMessage: '',
  isImporting: false,
  isOsmImporting: false,
  gtfsImportJobId: '',
  osmImportJobId: '',
  pendingPreparations: {},
  preparationErrors: {},
  preparationJobUpdates: {},
  streetPreparation: { task: null, walkReady: false, ready: false, error: '' },
  routingMergeRetryNonce: 0,
})

export const city = createStore<CityState>(initialCityState())

/** The combined routing build last requested for a City and its ready feeds. */
export const routingMerge = { requestKey: '' }

export const setActiveFeedId = (activeFeedId: string) => city.set({ activeFeedId })
export const setImportMessage = (importMessage: string) => city.set({ importMessage })
export const setOsmStreetMessage = (osmStreetMessage: string) => city.set({ osmStreetMessage })

export function updateProjects(change: (projects: VigoProject[]) => VigoProject[]) {
  city.set(({ projects }) => ({ projects: change(projects) }))
}

export function updatePendingPreparations(change: (tasks: Record<string, PreparationTask>) => Record<string, PreparationTask>) {
  city.set(({ pendingPreparations }) => ({ pendingPreparations: change(pendingPreparations) }))
}

// Project detail hydration. A City opens from its metadata; the full feed
// detail streams in once, and a later selection cancels an unfinished load.
type ProjectDetailRequest = {
  controller: AbortController
  promise: Promise<VigoProject | undefined>
}

const projectDetailRequests = new Map<string, ProjectDetailRequest>()
let citySelectionVersion = 0
let activeCityProjectId = ''

export function ensureProjectDetail(projectId: string): Promise<VigoProject | undefined> {
  const existing = city.get().projects.find((project) => project.id === projectId)
  if (!existing || !needsProjectDetail(existing)) return Promise.resolve(existing)

  const pending = projectDetailRequests.get(projectId)
  if (pending) return pending.promise

  const controller = new AbortController()
  const promise = apiJson<{ project: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}`, {
    signal: controller.signal,
  }).then((result) => {
    if (controller.signal.aborted) return undefined
    updateProjects((current) => mergeProjectDetail(current, result.project))
    return result.project
  }).finally(() => {
    const current = projectDetailRequests.get(projectId)
    if (current?.controller === controller) projectDetailRequests.delete(projectId)
  })

  projectDetailRequests.set(projectId, { controller, promise })
  return promise
}

export function cancelProjectDetail(projectId: string) {
  projectDetailRequests.get(projectId)?.controller.abort()
  projectDetailRequests.delete(projectId)
  if (activeCityProjectId === projectId) {
    citySelectionVersion += 1
    city.set({ cityPreviewLoadingProjectId: '' })
  }
}

export function resetCity() {
  for (const request of projectDetailRequests.values()) request.controller.abort()
  projectDetailRequests.clear()
  // The selection version keeps counting so a late answer cannot match a new selection.
  activeCityProjectId = ''
  routingMerge.requestKey = ''
  city.set(initialCityState())
}

/**
 * Select a City and load its detail. `applySelection` resets the workspaces
 * for the City before the detail arrives.
 */
export function startCitySelection(projectId: string, applySelection: (projectId: string) => void, onError: (message: string) => void) {
  if (!projectId) return

  const previousProjectId = activeCityProjectId
  if (previousProjectId && previousProjectId !== projectId) cancelProjectDetail(previousProjectId)

  const selectionVersion = citySelectionVersion + 1
  citySelectionVersion = selectionVersion
  activeCityProjectId = projectId
  applySelection(projectId)
  city.set({ cityPreviewLoadingProjectId: projectId })

  const stillSelected = () => (
    citySelectionVersion === selectionVersion
    && activeCityProjectId === projectId
    && city.get().selectedProjectId === projectId
  )
  void ensureProjectDetail(projectId).then(() => {
    if (stillSelected()) city.set({ cityPreviewLoadingProjectId: '' })
  }).catch((error) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (!stillSelected()) return
    city.set({ cityPreviewLoadingProjectId: '' })
    onError(error instanceof Error ? error.message : 'Project detail unavailable')
  })
}

export function replaceProject(nextProject: VigoProject) {
  cancelProjectDetail(nextProject.id)
  city.set(({ projects }) => {
    const existingProject = projects.find((project) => project.id === nextProject.id)
    const mergedProject = mergeProjectState(existingProject, nextProject)
    return {
      projects: [mergedProject, ...projects.filter((project) => project.id !== nextProject.id)],
      selectedProjectId: nextProject.id,
    }
  })
}

export async function refreshImportedProject(projectId: string, hydrate = true) {
  const detail = hydrate ? '' : '?detail=metadata'
  const projectResult = await apiJson<{ project: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}${detail}`)
  replaceProject(projectResult.project)
  return projectResult.project
}
