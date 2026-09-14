export const toolNames: Record<string, string> = { reference_lookup: 'Public reference lookup', web_search: 'Public web search', web_read: 'Public source page', network_overview: 'Network and feed status', recall_notebook: 'Saved work and staff notes', resolve_entities: 'Stop and route lookup', place_search: 'Online place search', find_walk: 'Plan a walk with visits', walk_compare: 'Compare walks', walk_route: 'Walking route', gtfs_query: 'Timetable query', realtime_status: 'Current service reports', anomaly_scan: 'Departure comparisons', service_alerts: 'Agency alerts', route_plan: 'Journey calculation', reach: 'Reachable area', draft_rider_message: 'Rider message', service_profile: 'Scheduled service profile' }
const fieldNames: Record<string, string> = { routes: 'Routes', stops: 'Stops', trips: 'Scheduled trips', vehicles: 'Recent vehicle locations', matchedTrips: 'Matched trip reports', unresolvedTrips: 'Unmatched trip reports', alerts: 'Active service alerts' }
export const humanField = (value: string) => fieldNames[value] || value.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
import type { FeedState } from './types'

export function feedHealth(feeds: FeedState[], refreshFailed = false) {
  const current = feeds.filter(feed => feed.status === 'fresh').length
  if (refreshFailed) return { status: 'unavailable', label: 'Refresh failed' }
  if (!feeds.length) return { status: 'unavailable', label: 'Timetable only' }
  if (current === feeds.length) return { status: 'fresh', label: 'Feeds current' }
  return { status: current ? 'partial' : 'unavailable', label: current ? 'Partial live data' : 'Live data unavailable' }
}

export function feedAgeLabel(feed: FeedState) {
  if (feed.ageSeconds === null) return 'Time unknown'
  if (feed.ageSeconds < 0) return `Clock ahead ${Math.ceil(-feed.ageSeconds)}s`
  return `${Math.floor(feed.ageSeconds)}s old`
}

export function scheduleDeviation(scheduled: number | null, current: number | null) {
  if (scheduled === null || current === null) return null
  const delta = current - scheduled
  if (delta === 0) return 'Matches schedule'
  const amount = Math.abs(delta) < 60 ? `${Math.abs(delta)} sec` : `${(Math.abs(delta) / 60).toFixed(1).replace(/\.0$/, '')} min`
  return `${amount} ${delta < 0 ? 'early' : 'late'}`
}
