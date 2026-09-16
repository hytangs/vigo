import type { FeedState } from '../agency/types'
import { feedAgeLabel, feedHealth } from '../agency/presentation'
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef } from 'react'

export function AgencyFeedHealth({ feeds, refreshFailed = false }: { feeds: FeedState[]; refreshFailed?: boolean }) {
  const health = feedHealth(feeds, refreshFailed)
  const disclosure = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: PointerEvent) => { if (disclosure.current && !disclosure.current.contains(event.target as Node)) disclosure.current.open = false }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  return <details ref={disclosure} className="agency-feed-health" data-health={health.status} onKeyDown={event => { if (event.key === 'Escape' && disclosure.current) { disclosure.current.open = false; disclosure.current.querySelector('summary')?.focus() } }}>
    <summary><i aria-hidden="true" />{health.label}<ChevronDown size={11} aria-hidden="true" /></summary>
    <ul aria-label="Feed freshness">{feeds.map((feed, index) => <li key={`${feed.sourceUrl}/${index}`}>
      <strong>{feed.kind === 'tripUpdates' ? 'Predictions' : feed.kind === 'vehicles' ? 'Vehicle positions' : feed.kind === 'alerts' ? 'Alerts' : 'Feed'}</strong>
      <span>{feed.status === 'fresh' ? 'Current' : feed.status === 'stale' ? 'Stale' : feed.status === 'error' ? 'Refresh failed' : 'Time unknown'} · {feedAgeLabel(feed)}</span>
    </li>)}{!feeds.length ? <li>No live feed timestamps are available.</li> : null}{refreshFailed ? <li>Last successful response shown. Feed ages above were recorded with that response.</li> : null}</ul>
  </details>
}
