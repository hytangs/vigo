import type { AgencyState, FeedState, OperationalEvent } from './types'

export type ObservationReportOptions = {
  exportedAt?: string
  eventFilter?: string
  refreshFailed?: boolean
}

const eventLimit = 500
const eventNames: Record<OperationalEvent['type'], string> = {
  delay: 'Predicted delay', bunching: 'Short predicted interval', 'service-gap': 'Long predicted interval',
  cancellation: 'Reported cancellation', 'skipped-stop': 'Reported skipped stop', 'stale-data': 'Data freshness',
  'service-alert': 'Agency alert', 'headway-review': 'Departure interval review',
}
const feedNames: Record<string, string> = { tripUpdates: 'Trip updates', vehicles: 'Vehicle positions', alerts: 'Alerts' }
const text = (value: unknown) => String(value ?? 'Unknown').replace(/[\r\n\t]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_\[\]|]/g, '\\$&')
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const count = (value: unknown) => finite(value) && value >= 0 ? String(value) : 'Unknown'
const seconds = (value: unknown) => finite(value) ? `${value} s` : 'Unknown'
const timestamp = (value: unknown) => typeof value === 'string' && value ? text(value) : 'Unknown'
const epochTime = (value: unknown) => finite(value) && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : 'Unknown'

function sourceReference(ref: string) {
  try {
    const url = new URL(ref)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const destination = url.href.replace(/[<>"\\]/g, character => encodeURIComponent(character))
      return `[${text(ref)}](<${destination}>)`
    }
  } catch { /* Non-URL identifiers remain readable provenance. */ }
  return text(ref)
}

function feedAtExport(feed: FeedState, exportedSeconds: number, freshnessSeconds: number, refreshFailed: boolean) {
  const age = finite(feed.feedTimestamp) && finite(exportedSeconds) ? exportedSeconds - feed.feedTimestamp : null
  const ageLabel = finite(age) ? age < 0 ? `Clock ahead ${Math.abs(Math.round(age))} s` : `${Math.round(age)} s` : 'Unknown'
  if (refreshFailed) return `${ageLabel}; observation refresh failed`
  if (feed.status === 'error') return `${ageLabel}; feed refresh failed`
  if (!finite(age) || !finite(freshnessSeconds) || freshnessSeconds < 0 || age < -freshnessSeconds) return `${ageLabel}; freshness unknown`
  return `${ageLabel}; ${age > freshnessSeconds ? 'outside' : 'within'} freshness policy by timestamp`
}

function eventMeasurement(event: OperationalEvent) {
  const evidence = event.evidence
  if (finite(evidence.scheduledHeadwaySeconds) && finite(evidence.observedHeadwaySeconds)) {
    return `Predicted ${seconds(evidence.observedHeadwaySeconds)} / scheduled ${seconds(evidence.scheduledHeadwaySeconds)}${finite(evidence.reportingTrips) && finite(evidence.expectedDepartures) ? `; ${evidence.reportingTrips}/${evidence.expectedDepartures} expected departures report at the reference stop` : ''}`
  }
  if (finite(evidence.delaySeconds)) return `Departure deviation ${evidence.delaySeconds > 0 ? '+' : ''}${seconds(evidence.delaySeconds)}`
  return evidence.alertDescription || evidence.reason || 'See source record'
}

/** Formats the supplied response only. It never refreshes feeds or calls a model. */
export function observationReportMarkdown(state: AgencyState, options: ObservationReportOptions = {}): string {
  const exportedAt = options.exportedAt ?? new Date().toISOString()
  const exportedSeconds = Date.parse(exportedAt) / 1000
  const filters = (state as AgencyState & { filters?: { routeId?: string; stopId?: string; eventType?: string } }).filters
  const eventFilter = options.eventFilter ?? filters?.eventType ?? 'Not recorded'
  const route = state.selection?.route
  const stop = state.selection?.stop
  const routeScope = route ? `${route.name} (${route.id})` : filters?.routeId ? `Requested route ${filters.routeId}; identity unresolved` : 'All routes'
  const stopScope = stop ? `${stop.name} (${stop.id})` : filters?.stopId ? `Requested stop ${filters.stopId}; identity unresolved` : 'All stops'
  const events = state.events.slice(0, eventLimit)
  const sources = [...new Set([...state.feeds.map(feed => feed.sourceUrl), ...events.flatMap(event => event.sourceRefs)])]
  const sourceNumbers = new Map(sources.map((ref, index) => [ref, index + 1]))
  const matchingTotal = finite(state.filteredEventCount) ? state.filteredEventCount : null
  const returnedRecords = `${state.events.length} ${state.events.length === 1 ? 'record was' : 'records were'} returned in this response`
  const eventCompleteness = matchingTotal === null
    ? `${events.length} events included from ${state.events.length} returned records. The matching total was not supplied; completeness is unknown.`
    : `${events.length} of ${matchingTotal} matching events included; ${returnedRecords}.${matchingTotal > events.length ? ' This is a partial event listing.' : ''}`
  const rows = [
    ['Indexed routes', state.counts.routes, 'Routes in the selected City timetable.'],
    ['Indexed stops', state.counts.stops, 'Stops in the selected City timetable.'],
    ['Fresh vehicle position records', state.counts.vehicles, 'Records meeting the feed and vehicle timestamp policy when this response was computed; not a count of vehicles in service.'],
    ['Received trip-update records', state.counts.trips, 'TripUpdate records considered, including unresolved records.'],
    ['Resolved trip-update records', state.counts.matchedTrips, 'Records matched to a scheduled trip instance with usable freshness; includes reported cancellations and deleted trips.'],
    ['Unresolved trip-update records', state.counts.unresolvedTrips, 'Received records whose identity, timetable coverage or freshness could not be resolved; not a count of missing scheduled trips.'],
    ['Active agency alerts', state.counts.alerts, 'Alerts with a fresh source that apply at the response time; some selectors may remain unresolved.'],
  ] as const
  const lines = [
    `# ${text(state.cityName)} — observation report`, '',
    'A retained snapshot of computed timetable and feed observations. Counts and event evidence describe the response time below; exporting does not refresh them.', '',
    '## Scope and time', '',
    `- City: ${text(state.cityName)}`,
    `- GTFS service date: ${text(state.coverage.serviceDate)}`,
    `- Agency timezone: ${text(state.coverage.timezone)}`,
    `- Response computed at: ${timestamp(state.generatedAt)}`,
    `- Realtime snapshot fetched at: ${timestamp(state.observedAt)}`,
    `- Exported at: ${timestamp(exportedAt)}`,
    `- Schedule identity: ${text(state.scheduleIdentity || 'Not recorded')}`,
    `- Route selection: ${text(routeScope)}`,
    `- Stop selection: ${text(stopScope)}`,
    `- Event filter: ${text(eventFilter === 'all' ? 'All event types' : eventFilter)}`,
    `- Realtime snapshot: ${state.connected ? 'Available in this response' : 'Not connected'}`,
    ...(options.refreshFailed ? ['- Refresh status: Observation refresh failed. The last successful response is retained.'] : []),
    '', 'Absolute timestamps retain their recorded offsets. The GTFS service date can differ from the civil date after midnight. City-wide counts below do not narrow with the route, stop or event selection.', '',
    '## City-wide counts at response time', '',
    '| Measure | Count | Definition |', '| --- | ---: | --- |',
    ...rows.map(([label, value, definition]) => `| ${label} | ${count(value)} | ${definition} |`),
    '', '## Timetable and reporting coverage', '',
    `- Timetable coverage: ${state.coverage.valid ? 'Valid at response time' : 'Needs attention'}`,
    `- Coverage note: ${text(state.coverage.message)}`,
    `- Published coverage dates: ${text(state.coverage.firstDate)} to ${text(state.coverage.lastDate)}`,
    `- Active service IDs: ${count(state.coverage.activeServices)}`,
    `- Freshness policy: ${seconds(state.policy.freshnessSeconds)}`,
    `- Departure comparison window: ${count(state.policy.windowMinutes)} minutes`,
    `- Retained observation history window: ${count(state.policy.historyMinutes)} minutes`,
    '', 'Unreported scheduled trips are not quantified by this response. The received-record counts do not provide a scheduled-trip reporting percentage. Missing or unusable reports leave service conditions unknown.', '',
    '## Feed timestamps and freshness', '',
    'Captured status and age were computed with this response. Age at export is recalculated from the supplied feed timestamp; it is not a new feed check.', '',
    '| Feed | Captured status | Feed timestamp (UTC) | Fetched at | Captured age | Age and status at export | Source |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...state.feeds.map(feed => `| ${text(feedNames[feed.kind] || feed.kind)} | ${text(feed.status)} | ${epochTime(feed.feedTimestamp)} | ${timestamp(feed.fetchedAt)} | ${seconds(feed.ageSeconds)} | ${text(feedAtExport(feed, exportedSeconds, state.policy.freshnessSeconds, Boolean(options.refreshFailed)))} | ${sourceNumbers.get(feed.sourceUrl)} |`),
    ...(!state.feeds.length ? ['', 'No individual feed timestamps were supplied. Live freshness is unknown.'] : []),
    ...state.feeds.filter(feed => feed.error).map(feed => `\nFeed error (source ${sourceNumbers.get(feed.sourceUrl)}): ${text(feed.error)}`),
    '', '## Selected event evidence', '',
    eventCompleteness,
    `City-wide event total before selection: ${count(state.eventCount)}. Events can share trips and sources; their count is not a count of affected vehicles or riders.`, '',
    '| Type | Title | Route / stop | Evidence time | Measurement or source description | Sources |',
    '| --- | --- | --- | --- | --- | --- |',
    ...events.map(event => {
      const routeIds = event.routeIds?.length ? event.routeIds : event.routeId ? [event.routeId] : []
      const stopIds = event.stopIds?.length ? event.stopIds : event.stopId ? [event.stopId] : []
      const location = [routeIds.map(id => state.routes.find(item => item.id === id)?.name || id).join(', '), stopIds.map(id => state.stopNames?.[id] || id).join(', ')].filter(Boolean).join(' / ') || event.scopeDescription || 'Network'
      return `| ${text(eventNames[event.type] || event.type)} | ${text(event.title)} | ${text(location)} | ${timestamp(event.observedAt)} | ${text(eventMeasurement(event))} | ${event.sourceRefs.map(ref => sourceNumbers.get(ref)).join(', ')} |`
    }),
    ...(!events.length ? ['', 'No events were returned for this selection. This does not establish normal service or complete reporting.'] : []),
    '', '## Limits', '',
    `- The live response and this report each list at most ${eventLimit} events. Filtering and truncation affect the event list; City-wide counts retain their full scope.`,
    '- Predicted departure spacing is not measured vehicle passage or route-wide headway performance. Forecast changes are not proof of actual vehicle progression.',
    '- Reporting coverage is not service reliability. No passenger impact, demand, intervention outcome or causal effect is established by these counts.',
    '- This report contains computed observations and agency-provided descriptions. It contains no AI-generated explanation and does not evaluate a dispatch action.',
    '- The report does not include every raw feed field or retained history record. Keep the JSON observation export for the supplied structured response; source URLs may later serve newer data.',
    ...state.warnings.map(warning => `- ${text(warning)}`),
    '', '## Sources', '',
    ...sources.map((ref, index) => `${index + 1}. ${sourceReference(ref)}`),
    ...(!sources.length ? ['No source references were supplied.'] : []), '',
  ]
  return lines.join('\n')
}
