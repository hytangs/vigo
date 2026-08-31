import type { FeedSummary, VigoProject } from '../domain'

export function emptyWorkspaceProject(storageRoot = 'Vigo Projects'): VigoProject {
  const createdAt = new Date().toISOString()
  return {
    schemaVersion: 'vigo.project.v1',
    id: '__empty_workspace__',
    name: 'No workspaces yet',
    region: 'Create a workspace to isolate GTFS feeds',
    createdAt,
    updatedAt: createdAt,
    storagePath: storageRoot,
    summary: { feeds: 0, routes: 0, stops: 0, transferCandidates: 0, qualityScore: 0 },
    feeds: [],
    jobs: [],
    artifacts: [],
  }
}

export function hasOperationsData(project: VigoProject) {
  const feedCount = Math.max(project.summary.feeds, project.feeds.length)
  return feedCount > 0 && (
    project.summary.routes > 0
    || project.feeds.some((feed) => feed.routeCount > 0 || Boolean(feed.mapPreview?.routes.length))
  )
}

export function hasReadyWorkspaceSources(project: VigoProject) {
  return hasOperationsData(project)
    && project.feeds.length > 0
    && project.feeds.every((feed) => feed.routingStore?.status === 'ready')
    && project.osmStreetIndex?.status === 'ready'
}

function hasDetailedProjectData(project: VigoProject) {
  return project.feeds.some((feed) =>
    Boolean(feed.mapPreview?.routes.length || feed.mapPreview?.stops.length || feed.routeMetrics?.length || feed.stopMetrics?.length),
  )
}

export function needsProjectDetail(project: VigoProject) {
  return !project.id.startsWith('__') && hasReadyWorkspaceSources(project) && !hasDetailedProjectData(project)
}

function projectSummaryFromFeeds(feeds: FeedSummary[], fallback: VigoProject['summary']): VigoProject['summary'] {
  if (!feeds.length) return fallback

  return {
    feeds: feeds.length,
    routes: feeds.reduce((sum, feed) => sum + Number(feed.routeCount ?? 0), 0),
    stops: feeds.reduce((sum, feed) => sum + Number(feed.stopCount ?? 0), 0),
    transferCandidates: feeds.reduce((sum, feed) => sum + Number(feed.transferCandidates ?? 0), 0),
    qualityScore: Math.round(feeds.reduce((sum, feed) => sum + Number(feed.qualityScore ?? 0), 0) / feeds.length),
  }
}

function mergeById<T extends { id: string }>(primary: T[] = [], secondary: T[] = []) {
  const seen = new Set<string>()
  return [...primary, ...secondary].filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function feedHasDetailedData(feed: FeedSummary) {
  return Boolean(
    feed.mapPreview?.routes.length
      || feed.mapPreview?.stops.length
      || feed.routeMetrics?.length
      || feed.stopMetrics?.length,
  )
}

function mergeFeedState(existing: FeedSummary | undefined, incoming: FeedSummary): FeedSummary {
  if (!existing || feedHasDetailedData(incoming)) return incoming
  if (!feedHasDetailedData(existing)) return incoming

  return {
    ...existing,
    ...incoming,
    routeMetrics: existing.routeMetrics,
    stopMetrics: existing.stopMetrics,
    mapPreview: existing.mapPreview,
  }
}

function mergeFeedsById(incoming: FeedSummary[] = [], existing: FeedSummary[] = []) {
  const existingById = new Map(existing.map((feed) => [feed.id, feed]))
  const seen = new Set<string>()
  const merged = incoming.map((feed) => {
    seen.add(feed.id)
    return mergeFeedState(existingById.get(feed.id), feed)
  })

  return [...merged, ...existing.filter((feed) => !seen.has(feed.id))]
}

export function mergeProjectState(existing: VigoProject | undefined, incoming: VigoProject): VigoProject {
  const feeds = mergeFeedsById(incoming.feeds ?? [], existing?.feeds ?? [])
  const jobs = mergeById(incoming.jobs ?? [], existing?.jobs ?? [])
  const artifacts = mergeById(incoming.artifacts ?? [], existing?.artifacts ?? [])

  return {
    ...(existing ?? incoming),
    ...incoming,
    feeds,
    jobs,
    artifacts,
    summary: projectSummaryFromFeeds(feeds, incoming.summary),
  }
}

export function mergeProjectLists(existing: VigoProject[], incoming: VigoProject[]) {
  const existingById = new Map(existing.map((project) => [project.id, project]))
  const incomingIds = new Set(incoming.map((project) => project.id))
  const localOnly = existing.filter((project) => project.id.startsWith('local-') && !incomingIds.has(project.id))

  return [
    ...incoming.map((project) => mergeProjectState(existingById.get(project.id), project)),
    ...localOnly,
  ]
}

export function mergeProjectDetail(existing: VigoProject[], incoming: VigoProject) {
  const index = existing.findIndex((project) => project.id === incoming.id)
  if (index < 0) return [...existing, incoming]
  const next = [...existing]
  next[index] = mergeProjectState(existing[index], incoming)
  return next
}

export function preferredProjectId(projects: VigoProject[], currentId: string) {
  const current = projects.find((project) => project.id === currentId)
  if (current && hasOperationsData(current)) return current.id
  const mostRecentOperationalProject = projects.find(hasOperationsData)
  return mostRecentOperationalProject?.id ?? current?.id ?? projects[0]?.id ?? ''
}

export function orderedProjects(projects: VigoProject[]) {
  return [...projects].sort((left, right) => {
    const operationRank = Number(hasOperationsData(right)) - Number(hasOperationsData(left))
    if (operationRank) return operationRank
    return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
  })
}
