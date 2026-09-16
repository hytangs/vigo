import type { CSSProperties } from 'react'
import { ArrowRight } from 'lucide-react'
import type { AgencyState } from '../agency/types'
import { browseRoutes, routeBrowserFreshness, routeDelayLabel, routeHasAttention } from '../agency/routeBrowser'

export function AgencyOverview({ state, refreshFailed, onBrowse, onRoute, onFeeds }: {
  state: AgencyState
  refreshFailed: boolean
  onBrowse: (filter: 'all' | 'attention' | 'reporting') => void
  onRoute: (id: string) => void
  onFeeds: () => void
}) {
  const freshness = routeBrowserFreshness(state, Date.now(), refreshFailed)
  const attention = browseRoutes(state.routes, { search: '', filter: 'attention', sort: 'attention', freshness })
  const reporting = freshness.predictions ? state.routes.filter(route => route.reportingTrips > 0).length : null
  const timestamp = Date.parse(state.generatedAt)
  const time = Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: state.coverage.timezone || 'UTC' }).format(timestamp) : 'Time unavailable'
  const shortTime = Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: state.coverage.timezone || 'UTC' }).format(timestamp) : 'Time unavailable'
  const count = (value: number) => value.toLocaleString()
  return <section className="agency-overview" aria-label="Network overview">
    <header className="agency-page-heading">
      <h1>Network</h1>
      <p>{refreshFailed ? 'Last updated' : 'Updated'} {shortTime}</p>
    </header>
    <div className="agency-overview-metrics" aria-label="Network snapshot measures">
      <button onClick={() => onBrowse('all')}><span>Routes</span><strong>{count(state.routes.length)}</strong></button>
      <button onClick={() => reporting === null ? onFeeds() : onBrowse('reporting')}><span>Reporting routes</span><strong>{reporting === null ? '—' : count(reporting)}</strong></button>
      <button className={attention.length ? 'has-attention' : ''} onClick={() => onBrowse('attention')}><span>To review</span><strong>{freshness.predictions || freshness.alerts ? count(attention.length) : '—'}</strong></button>
    </div>
    {!freshness.predictions ? <p className="agency-overview-basis">{freshness.label}. Unreported service is unknown.</p> : null}

    {attention.length ? <section className="agency-priority" aria-label="Routes to review">
      <header><h2>Routes to review</h2><button className="agency-text-button" onClick={() => onBrowse('attention')}>View all <ArrowRight size={18} /></button></header>
      <div>{attention.slice(0, 3).map(route => <button className="agency-priority-route" key={route.id} onClick={() => onRoute(route.id)}>
        <span className="agency-route-label" style={{ '--line-color': route.color } as CSSProperties}>{route.name}</span>
        <span className="agency-priority-description">{route.longName && route.longName !== route.name ? <strong>{route.longName}</strong> : null}<small>{[
          freshness.alerts && route.alerts ? `${route.alerts} ${route.alerts === 1 ? 'alert' : 'alerts'}` : '',
          routeDelayLabel(route, freshness) ? `${routeDelayLabel(route, freshness)} predicted` : '',
          freshness.predictions && route.headway === 'changed' ? 'Changed departure spacing' : '',
        ].filter(Boolean).slice(0, 2).join(' · ') || (routeHasAttention(route, freshness) ? 'Service change reported' : 'Open route evidence')}</small></span>
        <ArrowRight size={18} aria-hidden="true" />
      </button>)}</div>
    </section> : null}
    <details className="agency-overview-details"><summary>Data &amp; coverage</summary><p>{refreshFailed ? 'Last successful snapshot' : 'Snapshot'} {time} · {state.coverage.timezone || 'UTC · agency timezone unknown'}</p><p>Service date {state.coverage.serviceDate || 'unknown'} · {state.cityName}</p><p>{freshness.detail}</p><p>Reporting counts routes with current trip reports. Review includes alerts and predicted service changes, ordered by alerts, service changes, then delay.</p></details>
  </section>
}
