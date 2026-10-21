import { ChevronRight } from 'lucide-react'
import type { AgencyRoute, AgencyState } from '../agency/types'
import { browseRoutes, routeBrowserFreshness, routeDelayLabel, routeHasAttention } from '../agency/routeBrowser'
import { classNames } from '../domain'
import { AgencyRouteRow } from './AgencyRouteBadge'

/** Delay thresholds match the live vehicle legend: warning ≥5 min, severe ≥15 min. */
export function routeDelaySeverity(route: AgencyRoute) {
  const delay = route.maxDelaySeconds ?? 0
  return delay >= 900 ? 'alert' : delay >= 300 ? 'watch' : 'info'
}

export function AgencyOverview({ state, refreshFailed, onBrowse, onRoute, onFeeds }: {
  state: AgencyState
  refreshFailed: boolean
  onBrowse: (filter: 'all' | 'attention' | 'reporting') => void
  onRoute: (id: string) => void
  onFeeds: () => void
}) {
  const freshness = routeBrowserFreshness(state, Date.now(), refreshFailed)
  const attention = browseRoutes(state.routes, { search: '', filter: 'attention', sort: 'attention', freshness })
  const attentionIds = new Set(attention.map(route => route.id))
  const reporting = freshness.predictions ? state.routes.filter(route => route.reportingTrips > 0).length : null
  // Disjoint shares for the status bar. Reporting without a flag is not proof
  // of normal service, and a route without reports is unknown, not on time.
  const reportingClear = freshness.predictions ? state.routes.filter(route => route.reportingTrips > 0 && !attentionIds.has(route.id)).length : 0
  const unreported = Math.max(0, state.routes.length - attention.length - reportingClear)
  const timestamp = Date.parse(state.generatedAt)
  const time = Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: state.coverage.timezone || 'UTC' }).format(timestamp) : 'Time unavailable'
  const shortTime = Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: state.coverage.timezone || 'UTC' }).format(timestamp) : 'Time unavailable'
  const count = (value: number) => value.toLocaleString()
  const live = freshness.predictions && !refreshFailed
  return <section className="agency-overview" aria-label="Network overview">
    <header className="agency-pulse">
      <span className={classNames('agency-pulse-state', live ? 'is-live' : refreshFailed ? 'is-stale' : 'is-timetable')}><i aria-hidden="true" />{live ? 'Live' : refreshFailed ? 'Stale' : 'Timetable'}</span>
      <span className="agency-pulse-time">{refreshFailed ? 'Last updated' : 'Updated'} {shortTime}</span>
    </header>
    <div className="agency-overview-metrics kit-stats" aria-label="Network snapshot measures">
      <button onClick={() => onBrowse('all')}><strong>{count(state.routes.length)}</strong><span>Routes</span></button>
      <button onClick={() => reporting === null ? onFeeds() : onBrowse('reporting')}><strong>{reporting === null ? '—' : count(reporting)}</strong><span>Reporting</span></button>
      <button className={attention.length ? 'has-attention' : ''} onClick={() => onBrowse('attention')}><strong>{freshness.predictions || freshness.alerts ? count(attention.length) : '—'}</strong><span>To review</span></button>
    </div>
    {state.routes.length && (freshness.predictions || freshness.alerts) ? <figure className="agency-health" aria-label="Route status">
      <div className="agency-health-bar" aria-hidden="true">
        {attention.length ? <span className="is-review" style={{ flexGrow: attention.length }} /> : null}
        {reportingClear ? <span className="is-clear" style={{ flexGrow: reportingClear }} /> : null}
        {unreported ? <span className="is-unreported" style={{ flexGrow: unreported }} /> : null}
      </div>
      <figcaption>
        <span className="is-review"><i aria-hidden="true" />{count(attention.length)} to review</span>
        {freshness.predictions ? <span className="is-clear"><i aria-hidden="true" />{count(reportingClear)} reporting, nothing flagged</span> : null}
        <span className="is-unreported"><i aria-hidden="true" />{count(unreported)} without reports</span>
      </figcaption>
    </figure> : null}
    {!freshness.predictions ? <p className="agency-overview-basis">{freshness.label}. Unreported service is unknown.</p> : null}

    {attention.length ? <section className="agency-priority" aria-label="Routes to review">
      <header className="kit-section-title"><h2>Routes to review</h2><button type="button" onClick={() => onBrowse('attention')}>View all<ChevronRight size={13} aria-hidden="true" /></button></header>
      <div className="agency-route-rows kit-group">{attention.slice(0, 5).map(route => <AgencyRouteRow key={route.id} route={route} severity={routeDelaySeverity(route)} detailClassName="agency-priority-description" onSelect={() => onRoute(route.id)}>{[
          freshness.alerts && route.alerts ? `${route.alerts} ${route.alerts === 1 ? 'alert' : 'alerts'}` : '',
          routeDelayLabel(route, freshness) ? `${routeDelayLabel(route, freshness)} predicted` : '',
          freshness.predictions && route.headway === 'changed' ? 'Changed departure spacing' : '',
        ].filter(Boolean).slice(0, 2).join(' · ') || (routeHasAttention(route, freshness) ? 'Service change reported' : 'Open route evidence')}</AgencyRouteRow>)}</div>
    </section> : null}
    <details className="studio-disclosure agency-overview-details"><summary><span>Data &amp; coverage</span></summary><p>{refreshFailed ? 'Last successful snapshot' : 'Snapshot'} {time} · {state.coverage.timezone || 'UTC · agency timezone unknown'}</p><p>Service date {state.coverage.serviceDate || 'unknown'} · {state.cityName}</p><p>{freshness.detail}</p><p>Reporting counts routes with current trip reports. Review includes alerts and predicted service changes, ordered by alerts, service changes, then delay.</p></details>
  </section>
}
