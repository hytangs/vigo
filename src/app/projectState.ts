import type { FeedSummary, MapPreview, TableProfile, TidesSummary, VigoProject } from '../domain'
import { scopePreviewToFeed } from '../networkTruth'

export const bundleFeedId = '__bundle__'
export const requiredTableNames = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']
const optionalTableNames = ['shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'transfers.txt', 'pathways.txt', 'feed_info.txt']

function sumBy<T>(items: readonly T[], value: (item: T) => number) {
  return items.reduce((sum, item) => sum + value(item), 0)
}

export function emptyCityProject(storageRoot = 'Vigo Cities'): VigoProject {
  const createdAt = new Date().toISOString()
  return {
    schemaVersion: 'vigo.project.v1',
    id: '__empty_city__',
    name: 'No Cities yet',
    region: 'Build a City from GTFS and OSM',
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

function hasDetailedProjectData(project: VigoProject) {
  return project.feeds.some((feed) =>
    Boolean(feed.mapPreview?.routes.length || feed.mapPreview?.stops.length || feed.routeMetrics?.length || feed.stopMetrics?.length),
  )
}

export function needsProjectDetail(project: VigoProject) {
  return !project.id.startsWith('__') && hasOperationsData(project) && !hasDetailedProjectData(project)
}

function projectSummaryFromFeeds(feeds: FeedSummary[], fallback: VigoProject['summary']): VigoProject['summary'] {
  if (!feeds.length) return fallback

  return {
    feeds: feeds.length,
    routes: sumBy(feeds, (feed) => Number(feed.routeCount ?? 0)),
    stops: sumBy(feeds, (feed) => Number(feed.stopCount ?? 0)),
    transferCandidates: sumBy(feeds, (feed) => Number(feed.transferCandidates ?? 0)),
    qualityScore: Math.round(sumBy(feeds, (feed) => Number(feed.qualityScore ?? 0)) / feeds.length),
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

function mergeTidesSummaries(feeds: FeedSummary[]): TidesSummary | undefined {
  const summaries = feeds
    .map((feed) => feed.tides)
    .filter((summary): summary is TidesSummary => Boolean(summary?.detected))
  if (!summaries.length) return undefined

  const tableNames = [...new Set(summaries.flatMap((summary) => summary.tables.map((table) => table.name)))]
  const tables = tableNames.map((name) => {
    const matching = summaries.flatMap((summary) => summary.tables.filter((table) => table.name === name))
    return {
      ...matching[0],
      present: matching.some((table) => table.present),
      rowCount: sumBy(matching, (table) => table.rowCount),
      fieldCount: Math.max(0, ...matching.map((table) => table.fieldCount)),
      fields: [...new Set(matching.flatMap((table) => table.fields))].slice(0, 8),
      path: undefined,
    }
  })
  const presentTables = tables.filter((table) => table.present)
  const scheduledTripRefs = sumBy(summaries, (summary) => summary.scheduledTripRefs)
  const scheduledTripMatches = sumBy(summaries, (summary) => summary.scheduledTripMatches)
  const stopRefs = sumBy(summaries, (summary) => summary.stopRefs)
  const stopMatches = sumBy(summaries, (summary) => summary.stopMatches)
  const linkRefs = scheduledTripRefs + stopRefs

  return {
    schemaVersion: 'tides.v1',
    detected: true,
    datapackage: summaries.some((summary) => summary.datapackage),
    packageName: `${summaries.length} observed-operations package${summaries.length === 1 ? '' : 's'}`,
    packageProfile: summaries.find((summary) => summary.packageProfile)?.packageProfile,
    tableCount: presentTables.length,
    eventTableCount: presentTables.filter((table) => table.role === 'event').length,
    summaryTableCount: presentTables.filter((table) => table.role === 'summary').length,
    supportingTableCount: presentTables.filter((table) => table.role === 'supporting').length,
    rowCount: sumBy(summaries, (summary) => summary.rowCount),
    observedServiceDates: sumBy(summaries, (summary) => summary.observedServiceDates),
    performedTripCount: sumBy(summaries, (summary) => summary.performedTripCount),
    stopVisitCount: sumBy(summaries, (summary) => summary.stopVisitCount),
    passengerEventCount: sumBy(summaries, (summary) => summary.passengerEventCount),
    vehicleLocationCount: sumBy(summaries, (summary) => summary.vehicleLocationCount),
    fareTransactionCount: sumBy(summaries, (summary) => summary.fareTransactionCount),
    stationActivityCount: sumBy(summaries, (summary) => summary.stationActivityCount),
    vehicleCount: sumBy(summaries, (summary) => summary.vehicleCount),
    deviceCount: sumBy(summaries, (summary) => summary.deviceCount),
    totalBoardings: sumBy(summaries, (summary) => summary.totalBoardings),
    totalAlightings: sumBy(summaries, (summary) => summary.totalAlightings),
    totalEntries: sumBy(summaries, (summary) => summary.totalEntries),
    totalExits: sumBy(summaries, (summary) => summary.totalExits),
    totalFareTransactions: sumBy(summaries, (summary) => summary.totalFareTransactions),
    totalFareRevenue: sumBy(summaries, (summary) => summary.totalFareRevenue),
    maxDepartureLoad: Math.max(0, ...summaries.map((summary) => summary.maxDepartureLoad)),
    averageDwellSeconds: undefined,
    averageScheduleDeviationSeconds: undefined,
    scheduledTripRefs,
    scheduledTripMatches,
    scheduledTripUnmatched: sumBy(summaries, (summary) => summary.scheduledTripUnmatched),
    stopRefs,
    stopMatches,
    stopUnmatched: sumBy(summaries, (summary) => summary.stopUnmatched),
    linkScore: linkRefs ? Math.round(((scheduledTripMatches + stopMatches) / linkRefs) * 100) : 0,
    tables,
    signals: [...new Set(summaries.flatMap((summary) => summary.signals))].slice(0, 7),
  }
}

function emptyPreview(): MapPreview {
  return { routes: [], stops: [], stopPairs: [] }
}

function emptyProjectFeed(project: VigoProject): FeedSummary {
  return {
    id: bundleFeedId,
    name: `${project.name} Bundle`,
    provider: project.region,
    versionLabel: 'No feeds',
    importedAt: project.updatedAt,
    source: 'bundle',
    fileName: 'No GTFS',
    fileSize: 0,
    qualityScore: 0,
    routeCount: 0,
    stopCount: 0,
    tripCount: 0,
    transferCandidates: 0,
    requiredTables: Object.fromEntries(requiredTableNames.map((name) => [name, false])),
    optionalTables: Object.fromEntries(optionalTableNames.map((name) => [name, false])),
    tableProfiles: [],
    warnings: [],
    routeMetrics: [],
    stopMetrics: [],
    mapPreview: emptyPreview(),
  }
}

function feedPreview(feed: FeedSummary): MapPreview {
  return feed.mapPreview ?? emptyPreview()
}

function mergeTableState(feeds: FeedSummary[], tableNames: string[], required: boolean) {
  return Object.fromEntries(tableNames.map((name) => [
    name,
    feeds.every((feed) => Boolean(feed[required ? 'requiredTables' : 'optionalTables']?.[name])),
  ]))
}

export function getTableProfiles(feed: FeedSummary): TableProfile[] {
  if (feed.tableProfiles?.length) return feed.tableProfiles

  const issueCounts = new Map<string, number>()
  for (const warning of feed.warnings) {
    issueCounts.set(warning.table, (issueCounts.get(warning.table) ?? 0) + 1)
  }
  const tableProfile = (role: 'required' | 'optional') => ([name, present]: [string, boolean]) => ({
    name,
    role,
    present,
    rowCount: present ? 1 : 0,
    fieldCount: 0,
    fields: [],
    issueCount: issueCounts.get(name) ?? 0,
  })

  return [
    ...Object.entries(feed.requiredTables ?? {}).map(tableProfile('required')),
    ...Object.entries(feed.optionalTables ?? {}).map(tableProfile('optional')),
  ]
}

function bundlePreviewFromFeeds(feeds: FeedSummary[]): MapPreview {
  const bundle = emptyPreview()
  for (const feed of feeds) {
    const preview = scopePreviewToFeed(feed, feedPreview(feed))
    bundle.routes.push(...preview.routes)
    bundle.stops.push(...preview.stops)
    bundle.stopPairs!.push(...preview.stopPairs ?? [])
    if (preview.coverage) {
      bundle.coverage = {
        rawRouteRows: (bundle.coverage?.rawRouteRows ?? 0) + preview.coverage.rawRouteRows,
        publicRouteIdentities: (bundle.coverage?.publicRouteIdentities ?? 0) + preview.coverage.publicRouteIdentities,
        tripsIndexed: (bundle.coverage?.tripsIndexed ?? 0) + preview.coverage.tripsIndexed,
        stopTimesScanned: (bundle.coverage?.stopTimesScanned ?? 0) + preview.coverage.stopTimesScanned,
        stopsIndexed: (bundle.coverage?.stopsIndexed ?? 0) + preview.coverage.stopsIndexed,
        stopPairsIndexed: (bundle.coverage?.stopPairsIndexed ?? 0) + preview.coverage.stopPairsIndexed,
        capped: Boolean(bundle.coverage?.capped || preview.coverage.capped),
        timetableDeferred: Boolean(bundle.coverage?.timetableDeferred || preview.coverage.timetableDeferred),
      }
    }
  }
  return bundle
}

export function bundleFeed(project: VigoProject): FeedSummary {
  const feeds = project.feeds
  if (!feeds.length) return emptyProjectFeed(project)
  const preview = bundlePreviewFromFeeds(feeds)

  return {
    id: bundleFeedId,
    name: `${project.name} Bundle`,
    provider: project.region,
    versionLabel: `${feeds.length} GTFS`,
    importedAt: project.updatedAt,
    source: 'bundle',
    fileName: `${feeds.length} feeds`,
    fileSize: sumBy(feeds, (feed) => feed.fileSize),
    qualityScore: Math.round(sumBy(feeds, (feed) => feed.qualityScore) / feeds.length),
    routeCount: sumBy(feeds, (feed) => feed.routeCount),
    stopCount: sumBy(feeds, (feed) => feed.stopCount),
    tripCount: sumBy(feeds, (feed) => feed.tripCount),
    transferCandidates: sumBy(feeds, (feed) => feed.transferCandidates),
    requiredTables: mergeTableState(feeds, requiredTableNames, true),
    optionalTables: mergeTableState(feeds, optionalTableNames, false),
    tableProfiles: feeds.flatMap((feed) => getTableProfiles(feed).map((profile) => ({
      ...profile,
      name: `${feed.name} / ${profile.name}`,
    }))),
    warnings: feeds.flatMap((feed) => feed.warnings.map((warning) => ({
      ...warning,
      id: `${feed.id}-${warning.id}`,
      table: `${feed.name} / ${warning.table}`,
    }))),
    routeMetrics: preview.routes,
    stopMetrics: preview.stops,
    tides: mergeTidesSummaries(feeds),
    mapPreview: preview,
  }
}

export function scopedFeedAndPreview(project: VigoProject, feedId: string) {
  const feed = feedId === bundleFeedId
    ? bundleFeed(project)
    : project.feeds.find((item) => item.id === feedId) ?? bundleFeed(project)
  return { feed, preview: feedPreview(feed) }
}
