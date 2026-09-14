import { Activity, ChevronRight } from 'lucide-react'
import type { AgencyState, OperationalEvent } from '../agency/types'
import { minutes, shortId } from './AgencyEvidence'

const labels: Record<Exclude<OperationalEvent['type'], 'headway-review'>, string> = { delay: 'Delays', bunching: 'Short gaps', 'service-gap': 'Long gaps', cancellation: 'Cancellations', 'skipped-stop': 'Skipped stops', 'stale-data': 'Data freshness', 'service-alert': 'Alerts' }

export function AgencyServiceEvents({ state, ready, filter, onFilter, onSelect }: {
  state: AgencyState
  ready: boolean
  filter: string
  onFilter: (filter: string) => void
  onSelect: (event: OperationalEvent) => void
}) {
  const events = ready ? state.events : []
  return <details className="agency-service-events">
    <summary>Service updates <span>{ready ? events.length : '…'}</span></summary>
    <div className="agency-section-heading"><span>Current predictions and agency alerts</span><select aria-label="Filter event type" value={filter} onChange={event => onFilter(event.target.value)}><option value="all">All updates</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="agency-event-list">{events.slice(0, 40).map(event => <button key={event.id} className={`agency-event is-${event.severity}`} data-severity={event.severity} onClick={() => onSelect(event)}>
      <span className="agency-event-mark"><Activity size={15} /></span><span><strong>{event.title}</strong><small>{event.routeId ? state.routes.find(route => route.id === event.routeId)?.name || shortId(event.routeId) : 'Network'}{event.stopId ? ` · ${state.stopNames?.[event.stopId] || shortId(event.stopId)}` : ''}{event.evidence.delaySeconds != null ? ` · +${minutes(event.evidence.delaySeconds)}` : event.evidence.observedHeadwaySeconds != null ? ` · ${minutes(event.evidence.observedHeadwaySeconds)} apart / ${minutes(event.evidence.scheduledHeadwaySeconds!)} scheduled` : ''}</small></span><ChevronRight size={15} />
    </button>)}</div>
    {!ready ? <p className="agency-caption" role="status">Loading updates…</p> : !events.length ? <p className="agency-caption">{state.connected ? 'No updates in this view. Unreported service is unknown.' : 'Connect a feed to see live updates.'}</p> : null}
    {events.length > 40 ? <p className="agency-caption">Showing 40 updates. Select a route or update type to narrow the list.</p> : null}
  </details>
}
