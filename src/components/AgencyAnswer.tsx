import { useState } from 'react'
import { ArrowRight, Check, ChevronRight, LoaderCircle } from 'lucide-react'
import type { ApiProgress } from '../app/api'
import type { OperationalEvent, QueryAnswer, ToolResult } from '../agency/types'
import type { RoutingPlan } from '../routingModel'
import { SourceLinks, timeLabel } from './AgencyEvidence'

const clockMinutes = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`
const toolNames: Record<string, string> = { network_overview: 'Network and feed status', resolve_entities: 'Stop and route lookup', gtfs_query: 'Timetable query', realtime_status: 'Current service reports', anomaly_scan: 'Departure comparisons', service_alerts: 'Agency alerts', route_plan: 'Journey calculation', reach: 'Reachable area', draft_rider_message: 'Rider message' }
const fieldNames: Record<string, string> = { routes: 'Routes', stops: 'Stops', trips: 'Scheduled trips', vehicles: 'Recent vehicle locations', matchedTrips: 'Matched trip reports', unresolvedTrips: 'Unmatched trip reports', alerts: 'Active service alerts' }
const humanField = (value: string) => fieldNames[value] || value.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2')

function ToolDetails({ call }: { call: QueryAnswer['trace'][number] }) {
  const [open, setOpen] = useState(false)
  return <details className="agency-raw-data" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>View query and source response</summary>{open ? <pre>{JSON.stringify({ tool: call.tool, arguments: call.arguments, result: call.result }, null, 2)}</pre> : null}</details>
}

export function AgencyActivity({ activities, busy, trace }: { activities: ApiProgress[]; busy: boolean; trace: QueryAnswer['trace'] }) {
  if (!busy && !activities.length && !trace.length) return null
  return <details className="agency-activity" open={busy}>
    <summary>{busy ? <LoaderCircle size={14} className="agency-spinner" /> : <Check size={14} />}<span>{busy ? 'Working through your question' : `${trace.length} ${trace.length === 1 ? 'check' : 'checks'} completed`}</span><ChevronRight size={14} /></summary>
    <ol aria-live="polite">{activities.filter((item) => item.phase !== 'planning' || !trace.length && activities.length === 1).map((item) => <li key={item.phase}><span className={`agency-activity-mark ${item.progress === 1 ? 'is-done' : ''}`} />{item.detail}</li>)}</ol>
    {trace.map((call, index) => <div className="agency-activity-detail" key={index}><strong>{toolNames[call.tool] || humanField(call.tool)}</strong><span>{call.result.ok ? 'Complete' : 'Could not complete'}</span><ToolDetails call={call} /></div>)}
  </details>
}

export function AgencyToolOutput({ result, onSelectEvent }: { result: ToolResult; onSelectEvent?: (event: OperationalEvent) => void }) {
  const data = result.data as { rows?: Record<string, unknown>[]; matches?: Array<{ kind: string; id: string; name: string }>; plan?: RoutingPlan; events?: Array<OperationalEvent & { routeName?: string; stopName?: string }>; counts?: Record<string, number>; summary?: { maximumCutoffMinutes: number; transitStatus?: { reachedStops: number } } }
  if (data?.plan?.legs?.length) return <div className="agency-journey"><strong>{Number(data.plan.durationMinutes.toFixed(1))} min · {data.plan.legs.filter((leg) => leg.type === 'ride').length} transit legs</strong>{data.plan.legs.map((leg, index) => <div key={index}><time>{clockMinutes(leg.startMinutes)}</time><span><b>{leg.type === 'ride' ? leg.routeShortName || leg.routeId : leg.type === 'walk' ? 'Walk' : 'Drive'}</b> {leg.fromName}<ArrowRight size={12} />{leg.toName}</span><small>{Number(leg.durationMinutes.toFixed(1))} min</small></div>)}</div>
  if (data?.rows?.length) {
    const columns = Object.keys(data.rows[0])
    return <div className="agency-query-table"><table><thead><tr>{columns.map((key) => <th key={key}>{humanField(key)}</th>)}</tr></thead><tbody>{data.rows.slice(0, 40).map((row, i) => <tr key={i}>{columns.map((key) => <td key={key}>{row[key] == null ? '—' : typeof row[key] === 'number' ? row[key].toLocaleString() : String(row[key])}</td>)}</tr>)}</tbody></table>{data.rows.length > 40 ? <p className="agency-caption">Showing 40 of {data.rows.length} rows. The full result is in the activity details.</p> : null}</div>
  }
  if (data?.matches) return <div className="agency-entity-results">{data.matches.map((item) => <div key={`${item.kind}/${item.id}`}><strong>{item.name}</strong><span>{item.kind} · {item.id}</span></div>)}</div>
  if (data?.events) return <div className="agency-answer-events">{data.events.slice(0, 8).map((event) => <button key={event.id} onClick={() => onSelectEvent?.(event)}><div><strong>{event.routeName ? `${event.routeName} · ` : ''}{event.title}</strong><span>{event.stopName || (event.type === 'service-alert' ? 'Published by the agency' : 'Current service report')}</span>{event.evidence.observedHeadwaySeconds != null ? <p><b>{Number((event.evidence.observedHeadwaySeconds / 60).toFixed(1))} min apart</b><span>Scheduled: {Number(((event.evidence.scheduledHeadwaySeconds ?? 0) / 60).toFixed(1))} min</span></p> : event.evidence.delaySeconds != null ? <p>{Number((event.evidence.delaySeconds / 60).toFixed(1))} min later than scheduled</p> : null}</div><ArrowRight size={15} /></button>)}</div>
  if (data?.summary?.transitStatus) return <dl className="agency-facts"><div><dt>Travel time budget</dt><dd>{data.summary.maximumCutoffMinutes} min</dd></div><div><dt>Transit stops reached</dt><dd>{data.summary.transitStatus.reachedStops}</dd></div></dl>
  if (data?.counts) return <dl className="agency-facts">{Object.entries(data.counts).map(([key, value]) => <div key={key}><dt>{humanField(key)}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>
  return null
}

export function AgencyAnswer({ answer, onResult, onSelectEvent }: { answer: QueryAnswer; onResult: (result: ToolResult) => void; onSelectEvent: (event: OperationalEvent) => void }) {
  const result = answer.trace.filter((call) => call.result.ok).at(-1)?.result
  return <section className="agency-answer" aria-label="Answer">
    <p className="agency-answer-text">{answer.answer}</p>
    {result ? <AgencyToolOutput result={result} onSelectEvent={onSelectEvent} /> : null}
    {Boolean(result?.presentation?.routeIds?.length || result?.presentation?.stopIds?.length || (result?.data as { plan?: unknown; surface?: unknown })?.plan || (result?.data as { surface?: unknown })?.surface) ? <button className="agency-text-button" onClick={() => result && onResult(result)}>Show on map <ArrowRight size={13} /></button> : null}
    {!result && answer.warnings.length ? <p className="agency-error" role="alert">{answer.warnings[0]}</p> : null}
    {answer.warnings.length ? <details className="agency-source-details"><summary>What this answer covers</summary>{answer.warnings.map((warning) => <p className="agency-caption" key={warning}>{warning}</p>)}</details> : null}
    {answer.evidenceRefs.length ? <details className="agency-source-details"><summary>Sources · {answer.evidenceRefs.length}</summary><SourceLinks refs={answer.evidenceRefs} /></details> : null}
    <footer className="agency-answer-footer">As of {timeLabel(answer.generatedAt)}</footer>
  </section>
}
