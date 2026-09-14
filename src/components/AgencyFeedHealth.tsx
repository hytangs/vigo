import type { FeedState } from '../agency/types'
import { feedAgeLabel, feedHealth } from '../agency/presentation'
import { ChevronDown } from 'lucide-react'

export function AgencyFeedHealth({ feeds, refreshFailed = false }: { feeds: FeedState[]; refreshFailed?: boolean }) {
  const health = feedHealth(feeds, refreshFailed)
  return <details className="agency-feed-health" data-health={health.status}>
    <summary><i aria-hidden="true" />{health.label}<ChevronDown size={11} aria-hidden="true" /></summary>
    <ul aria-label="Feed freshness">{feeds.map((feed, index) => <li key={`${feed.sourceUrl}/${index}`}>
      <strong>{feed.kind === 'tripUpdates' ? 'Predictions' : feed.kind === 'vehicles' ? 'Vehicle positions' : feed.kind === 'alerts' ? 'Alerts' : 'Feed'}</strong>
      <span>{feed.status === 'fresh' ? 'Current' : feed.status === 'stale' ? 'Stale' : feed.status === 'error' ? 'Refresh failed' : 'Time unknown'} · {feedAgeLabel(feed)}</span>
    </li>)}{!feeds.length ? <li>No live feed timestamps are available.</li> : null}{refreshFailed ? <li>Last successful response shown. Feed ages above were recorded with that response.</li> : null}</ul>
  </details>
}
