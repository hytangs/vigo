import { Activity, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgencyState, OperationalEvent } from '../agency/types'
import { minutes, shortId } from './AgencyEvidence'

const labels: Record<OperationalEvent['type'], string> = { delay: 'Delays', bunching: 'Short gaps', 'service-gap': 'Long gaps', cancellation: 'Cancellations', 'skipped-stop': 'Skipped stops', 'stale-data': 'Data freshness', 'service-alert': 'Alerts', 'headway-review': 'Departure spacing' }

export function AgencyServiceEvents({ state, ready, filter, onFilter, onSelect, defaultOpen = true }: {
  defaultOpen?: boolean
  state: AgencyState
  ready: boolean
  filter: string
  onFilter: (filter: string) => void
  onSelect: (event: OperationalEvent) => void
}) {
  const [limit, setLimit] = useState(40)
  useEffect(() => setLimit(40), [filter, state.selection?.route?.id, state.selection?.stop?.id])
  const events = ready ? state.events : []
  const total = state.filteredEventCount ?? events.length
  return <details className="agency-service-events" open={defaultOpen}>
    <summary>Service updates <span>{ready ? total.toLocaleString() : '…'}</span></summary>
    <div className="agency-section-heading"><select aria-label="Filter event type" value={filter} onChange={event => onFilter(event.target.value)}><option value="all">All updates</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="agency-event-list">{events.slice(0, limit).map(event => <button key={event.id} className={`agency-event is-${event.severity}`} data-severity={event.severity} onClick={() => onSelect(event)}>
      <span className="agency-event-mark"><Activity size={15} aria-label={event.severity} /></span><span><strong>{event.severity !== 'info' ? `${event.severity === 'critical' ? 'Severe' : 'Warning'} · ` : ''}{event.title}</strong><small>{event.routeId ? state.routes.find(route => route.id === event.routeId)?.name || shortId(event.routeId) : 'Network'}{event.stopId ? ` · ${state.stopNames?.[event.stopId] || shortId(event.stopId)}` : ''}{event.evidence.delaySeconds != null ? ` · ${event.evidence.delaySeconds > 0 ? '+' : ''}${minutes(event.evidence.delaySeconds)} predicted` : event.evidence.observedHeadwaySeconds != null ? ` · ${minutes(event.evidence.observedHeadwaySeconds)} apart / ${minutes(event.evidence.scheduledHeadwaySeconds!)} scheduled` : ''}</small>{event.evidence.alertReason ? <small>{event.evidence.alertReason}</small> : null}</span><ChevronRight size={15} />
    </button>)}</div>
    {!ready ? <p className="agency-caption" role="status">Loading updates…</p> : !events.length ? <p className="agency-caption">{state.connected ? 'No updates in this view. Unreported service is unknown.' : 'Connect a feed to see live updates.'}</p> : null}
    {ready && events.length ? <footer className="agency-event-pagination"><span>Showing {Math.min(limit, events.length).toLocaleString()} of {total.toLocaleString()} updates</span>{events.length > limit ? <button className="agency-text-button" onClick={() => setLimit(value => value + 40)}>More updates <ChevronRight size={13} /></button> : null}</footer> : null}
    {ready && total > events.length ? <p className="agency-caption">This snapshot includes the first {events.length.toLocaleString()} matching updates. Select a route or update type to see a narrower set.</p> : null}
  </details>
}
