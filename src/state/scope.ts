import { filterPreviewByStatus } from '../app/mapPresentation'
import { isActiveTask, isPreparationJob, preparationTasks, type PreparationTask } from '../app/preparation'
import { bundleFeedId, emptyCityProject, hasOperationsData, scopedFeedAndPreview } from '../app/projectState'
import { memoizeLast } from '../app/store'
import type { RoutingScopeStatus } from '../components/PathfinderPanel'
import type { FeedSummary, JobRecord, VigoProject } from '../domain'
import { city } from './city'
import { shell } from './shell'

// Derived City scope. Each getter reads the current stores and caches by
// input identity, so actions and every subscribed component share one value.

const selectedProjectOf = memoizeLast((projects: VigoProject[], projectId: string, storageRoot: string | undefined) => (
  projects.find((project) => project.id === projectId) ?? projects[0] ?? emptyCityProject(storageRoot)
))

export function selectedProject() {
  const { projects, selectedProjectId } = city.get()
  return selectedProjectOf(projects, selectedProjectId, shell.get().health?.storageRoot)
}

const activeScopeOf = memoizeLast(scopedFeedAndPreview)
const activeScope = () => activeScopeOf(selectedProject(), city.get().activeFeedId)
export const activeFeed = () => activeScope().feed
export const preview = () => activeScope().preview

const visiblePreviewOf = memoizeLast(filterPreviewByStatus)
export const visiblePreview = () => visiblePreviewOf(preview(), city.get().statusFilter)

const routingScopeOf = memoizeLast((project: VigoProject, activeFeedId: string, feed: FeedSummary) => {
  const scopedRoutingFeeds = activeFeedId === bundleFeedId
    ? project.feeds
    : feed.id === bundleFeedId
      ? []
      : [feed]
  const projectRoutingFeed = activeFeedId === bundleFeedId && project.routingStore?.status === 'ready'
    ? { ...feed, id: '__project__', routingStore: project.routingStore }
    : null
  const nationalRoutingFeed = projectRoutingFeed ?? (scopedRoutingFeeds.length === 1 && scopedRoutingFeeds[0]?.routingStore?.status === 'ready'
    ? scopedRoutingFeeds[0]
    : null)
  const readyBundleFeedCount = project.feeds.filter((entry) => entry.routingStore?.status === 'ready').length
  const routingScopeStatus: RoutingScopeStatus = nationalRoutingFeed
    ? 'ready'
    : activeFeedId === bundleFeedId && project.routingStore?.status === 'failed'
      ? 'failed'
      : activeFeedId === bundleFeedId && (
          project.routingStore?.status === 'building'
          || readyBundleFeedCount > 1
        )
        ? 'building'
        : 'missing'
  const routingStoreFeedCount = scopedRoutingFeeds.length
  const metadataReadyFeedCount = scopedRoutingFeeds.filter((entry) => entry.routingStore?.status === 'ready').length
  const routingStoreStoredFeedCount = nationalRoutingFeed
    ? Math.max(1, routingStoreFeedCount)
    : metadataReadyFeedCount
  return {
    nationalRoutingFeed,
    nationalRoutingStoreKey: nationalRoutingFeed
      ? `${project.id}:${nationalRoutingFeed.id}:${nationalRoutingFeed.routingStore?.builtAt ?? ''}`
      : '',
    readyBundleFeedCount,
    routingScopeStatus,
    routingStoreFeedCount,
    routingStoreStoredFeedCount,
    routingStoreStored: routingStoreFeedCount > 0 && routingStoreStoredFeedCount === routingStoreFeedCount,
    routingStoreTripCount: scopedRoutingFeeds.reduce((sum, entry) => sum + Number(entry.tripCount ?? 0), 0),
    routingStoreConnectionCount: Number(
      projectRoutingFeed?.routingStore?.connectionCount
        ?? scopedRoutingFeeds.reduce((sum, entry) => sum + Number(entry.routingStore?.connectionCount ?? 0), 0),
    ),
    routingMergeSourceIdentity: project.feeds
      .filter((entry) => entry.routingStore?.status === 'ready')
      .map((entry) => `${entry.id}:${entry.routingStore?.builtAt ?? ''}`)
      .sort()
      .join('|'),
  }
})

/** The routing store that serves the scoped feeds, and how far its preparation is. */
export const routingScope = () => routingScopeOf(selectedProject(), city.get().activeFeedId, activeFeed())

export function hasActiveOperationsData() {
  const project = selectedProject()
  return city.get().openedNetworkProjectId === project.id
    && hasOperationsData(project)
    && (activeFeed().routeCount > 0 || preview().routes.length > 0)
}

export function isProjectEmpty() {
  const { page, activeRouteTool } = shell.get()
  const project = selectedProject()
  return page === 'project'
    && activeRouteTool !== 'data'
    && (!hasOperationsData(project) || city.get().openedNetworkProjectId !== project.id)
}

export function storageRecoveryRequired() {
  const { runtimeConfig } = shell.get()
  return Boolean(runtimeConfig && !runtimeConfig.setupRequired && !runtimeConfig.offline.storageWritable)
}

const preparationJobsOf = memoizeLast((jobs: JobRecord[], updates: Record<string, JobRecord>) => (
  jobs.map((job) => updates[job.id] ?? job)
))

/** The selected City's jobs with their latest polled status. */
export const preparationJobs = () => preparationJobsOf(selectedProject().jobs, city.get().preparationJobUpdates)

const latestJobOf = (jobs: JobRecord[], kind: string) => [...jobs]
  .filter((job) => job.kind === kind)
  .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]

const importJobsOf = memoizeLast((jobs: JobRecord[], gtfsImportJobId: string, osmImportJobId: string) => ({
  gtfsImportJob: jobs.find((job) => job.id === gtfsImportJobId) ?? latestJobOf(jobs, 'national-gtfs-import'),
  osmImportJob: jobs.find((job) => job.id === osmImportJobId) ?? latestJobOf(jobs, 'national-osm-import'),
  latestActiveGtfsJob: jobs.find((job) => job.kind === 'national-gtfs-import' && ['queued', 'running'].includes(job.status)),
  latestActiveOsmJob: jobs.find((job) => job.kind === 'national-osm-import' && ['queued', 'running'].includes(job.status)),
}))

export const importJobs = () => importJobsOf(preparationJobs(), city.get().gtfsImportJobId, city.get().osmImportJobId)

const visiblePreparationTasksOf = memoizeLast((
  jobs: JobRecord[],
  projectId: string,
  projectName: string,
  pendingPreparations: Record<string, PreparationTask>,
  loadingProjectId: string,
  streetTask: PreparationTask | null,
  errors: Record<string, string>,
) => preparationTasks(jobs,
  [
    ...Object.entries(pendingPreparations).filter(([key]) => key.startsWith(`${projectId}:`)).map(([, task]) => task),
    ...(loadingProjectId === projectId ? [{ id: `${projectId}:loading`, kind: 'city-data-load', label: projectName, status: 'running' as const, phase: 'Loading transit feeds and map data', createdAt: '' }] : []),
    ...(streetTask ? [streetTask] : []),
  ],
  errors))

/** Background tasks shown for the selected City. */
export function visiblePreparationTasks() {
  const project = selectedProject()
  const state = city.get()
  return visiblePreparationTasksOf(
    preparationJobs(),
    project.id,
    project.name,
    state.pendingPreparations,
    state.cityPreviewLoadingProjectId,
    state.streetPreparation.task,
    state.preparationErrors,
  )
}

export const activePreparationJobIds = () => preparationJobs()
  .filter((job) => isPreparationJob(job) && isActiveTask(job))
  .map((job) => job.id)
  .sort()
  .join('|')

export function sourceDeletionDisabled() {
  const { isImporting, isOsmImporting } = city.get()
  return isImporting || isOsmImporting || preparationJobs().some((job) => isPreparationJob(job) && isActiveTask(job))
}
