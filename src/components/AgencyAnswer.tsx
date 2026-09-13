import { useState } from 'react'
import { ArrowRight, Check, ChevronRight, LoaderCircle } from 'lucide-react'
import type { ApiProgress } from '../app/api'
import type { OperationalEvent, QueryAnswer, ToolResult } from '../agency/types'
import type { RoutingPlan } from '../routingModel'
import { downloadText } from './AgencyNotebook'
import { SourceLinks } from './AgencyEvidence'

const clockMinutes = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`
const toolNames: Record<string, string> = { network_overview: 'Network and feed status', resolve_entities: 'Stop and route lookup', gtfs_query: 'Timetable query', realtime_status: 'Current service reports', anomaly_scan: 'Departure comparisons', service_alerts: 'Agency alerts', route_plan: 'Journey calculation', reach: 'Reachable area', draft_rider_message: 'Rider message', service_profile: 'Scheduled service profile' }
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

function ServiceProfileChart({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.every((row) => typeof row.service_hour === 'number' && typeof row.scheduled_trip_starts === 'number')) return null
  const values = rows as Array<{ service_hour: number; scheduled_trip_starts: number }>
  const first = Math.min(...values.map((row) => row.service_hour)), last = Math.max(...values.map((row) => row.service_hour))
  const peak = Math.max(1, ...values.map((row) => row.scheduled_trip_starts)), width = 480 / (last - first + 1)
  return <figure className="agency-profile-chart"><figcaption>Scheduled trip starts by service hour</figcaption><svg viewBox="0 0 540 180" role="img" aria-label={`Scheduled trip starts from service hour ${first} to ${last}. Largest hourly count: ${peak}.`}><text x="4" y="20">{peak}</text><text x="21" y="147">0</text><line x1="42" x2="530" y1="143" y2="143" />{values.map((row) => <g key={row.service_hour}><rect x={44 + (row.service_hour - first) * width} y={143 - row.scheduled_trip_starts / peak * 125} width={Math.max(1, width - 4)} height={row.scheduled_trip_starts / peak * 125}><title>{row.service_hour}:00 · {row.scheduled_trip_starts} scheduled trip starts</title></rect><text x={44 + (row.service_hour - first) * width + (width - 4) / 2} y="163" textAnchor="middle">{row.service_hour}</text></g>)}</svg><p className="agency-caption">Service hours above 23 continue the same GTFS service day.</p></figure>
}

function AgencyJourney({ plan }: { plan: RoutingPlan }) {
  const rides = plan.legs.filter((leg) => leg.type === 'ride').length
  return <div className="agency-journey"><strong>{Number(plan.durationMinutes.toFixed(1))} min · {rides} transit {rides === 1 ? 'leg' : 'legs'}</strong>{plan.legs.flatMap((leg, index) => {
    const previousEnd = index ? plan.legs[index - 1].endMinutes : leg.startMinutes
    const wait = leg.startMinutes - previousEnd
    const items = wait > 0 ? [<div key={`wait-${index}`}><time>{clockMinutes(previousEnd)}</time><span>Wait at {leg.fromName}</span><small>{wait < 1 ? '<1' : Number(wait.toFixed(1))} min</small></div>] : []
    if (leg.type !== 'walk' || leg.durationMinutes !== 0 || leg.fromName !== leg.toName) items.push(<div key={`leg-${index}`}><time>{clockMinutes(leg.startMinutes)}</time><span><b>{leg.type === 'ride' ? leg.routeShortName || leg.routeId : leg.type === 'walk' ? 'Walk' : 'Drive'}</b> {leg.fromName === leg.toName ? `within ${leg.fromName}` : <>{leg.fromName}<ArrowRight size={12} />{leg.toName}</>}</span><small>{leg.durationMinutes > 0 && leg.durationMinutes < 1 ? '<1' : Number(leg.durationMinutes.toFixed(1))} min</small></div>)
    return items
  })}</div>
}

export function AgencyToolOutput({ result, onSelectEvent }: { result: ToolResult; onSelectEvent?: (event: OperationalEvent) => void }) {
  const data = result.data as { rows?: Record<string, unknown>[]; matches?: Array<{ kind: string; id: string; name: string }>; plan?: RoutingPlan; events?: Array<OperationalEvent & { routeName?: string; stopName?: string }>; counts?: Record<string, number>; summary?: { maximumCutoffMinutes: number; transitStatus?: { reachedStops: number } } }
  if (data?.plan?.legs?.length) return <AgencyJourney plan={data.plan} />
  if (data?.rows?.length) {
    const columns = Object.keys(data.rows[0])
    return <><ServiceProfileChart rows={data.rows} /><div className="agency-query-table"><table><thead><tr>{columns.map((key) => <th key={key}>{humanField(key)}</th>)}</tr></thead><tbody>{data.rows.slice(0, 40).map((row, i) => <tr key={i}>{columns.map((key) => <td key={key}>{row[key] == null ? '—' : typeof row[key] === 'number' ? row[key].toLocaleString() : String(row[key])}</td>)}</tr>)}</tbody></table>{data.rows.length > 40 ? <p className="agency-caption">Showing 40 of {data.rows.length} rows. The full result is in the activity details.</p> : null}</div></>
  }
  if (data?.matches) return <div className="agency-entity-results">{data.matches.map((item) => <div key={`${item.kind}/${item.id}`}><strong>{item.name}</strong><span>{item.kind} · {item.id}</span></div>)}</div>
  if (data?.events) return <div className="agency-answer-events">{data.events.slice(0, 8).map((event) => <button key={event.id} onClick={() => onSelectEvent?.(event)}><div><strong>{event.routeName ? `${event.routeName} · ` : ''}{event.title}</strong><span>{event.stopName || (event.type === 'service-alert' ? 'Published by the agency' : 'Current service report')}</span>{event.evidence.observedHeadwaySeconds != null ? <p><b>{Number((event.evidence.observedHeadwaySeconds / 60).toFixed(1))} min apart</b><span>Scheduled: {Number(((event.evidence.scheduledHeadwaySeconds ?? 0) / 60).toFixed(1))} min</span></p> : event.evidence.delaySeconds != null ? <p>{Number((event.evidence.delaySeconds / 60).toFixed(1))} min later than scheduled</p> : null}</div><ArrowRight size={15} /></button>)}</div>
  if (data?.summary?.transitStatus) return <dl className="agency-facts"><div><dt>Travel time budget</dt><dd>{data.summary.maximumCutoffMinutes} min</dd></div><div><dt>Transit stops reached</dt><dd>{data.summary.transitStatus.reachedStops}</dd></div></dl>
  if (data?.counts) return <dl className="agency-facts">{Object.entries(data.counts).map(([key, value]) => <div key={key}><dt>{humanField(key)}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>
  return null
}

export function AgencyAnswer({ answer, onResult, onSelectEvent }: { answer: QueryAnswer; onResult: (result: ToolResult) => void; onSelectEvent: (event: OperationalEvent) => void }) {
  const citedComparison = answer.aiGenerated ? answer.trace.find((call, index) => answer.citations?.includes(index + 1) && (call.result.data as { events?: OperationalEvent[] }).events?.some((event) => event.evidence.observedHeadwaySeconds != null)) : null
  const result = citedComparison?.result ?? answer.trace.filter((call) => call.result.ok).at(-1)?.result
  return <section className="agency-answer" aria-label="Answer">
    {answer.aiGenerated ? <div className="agency-ai-label">AI summary · {answer.model}</div> : null}
    <p className="agency-answer-text">{answer.answer}</p>
    {answer.report ? <div className="agency-research-output"><div className="agency-section-heading"><div><h2>Evidence table</h2><span>{answer.report.rows.length} rows · retained with this note</span></div>{answer.report.rows.length ? <button className="agency-text-button" onClick={() => { const rows = answer.report!.rows; const columns = Object.keys(rows[0]); const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`; downloadText('agency-evidence.csv', [columns.map(cell).join(','), ...rows.map((row) => columns.map((key) => cell(row[key])).join(','))].join('\n'), 'text/csv') }}>Export CSV</button> : null}</div><AgencyToolOutput result={{ ok: true, data: { rows: answer.report.rows }, provenance: [], generatedAt: answer.generatedAt, warnings: [] }} /><details className="agency-source-details"><summary>Research question, method & limits</summary><div className="agency-method-text">{answer.report.method}</div></details></div> : null}
    {result && !answer.report ? <AgencyToolOutput result={result} onSelectEvent={onSelectEvent} /> : null}
    {Boolean(result?.presentation?.routeIds?.length === 1 || result?.presentation?.stopIds?.length === 1 || (result?.data as { plan?: unknown; surface?: unknown })?.plan || (result?.data as { surface?: unknown })?.surface) ? <button className="agency-text-button" onClick={() => result && onResult(result)}>Show on map <ArrowRight size={13} /></button> : null}
    {!result && answer.warnings.length ? <p className="agency-error" role="alert">{answer.warnings[0]}</p> : null}
    {answer.warnings.length ? <details className="agency-source-details"><summary>What this answer covers</summary>{answer.warnings.map((warning) => <p className="agency-caption" key={warning}>{warning}</p>)}</details> : null}
    {answer.aiGenerated ? <details className="agency-source-details"><summary>Sources cited in the summary</summary>{answer.trace.map((call, index) => <div key={index}><strong>[{index + 1}] {toolNames[call.tool] || humanField(call.tool)}</strong><SourceLinks refs={call.result.provenance} /></div>)}</details> : null}
    {answer.evidenceRefs.length ? <details className="agency-source-details"><summary>Sources · {answer.evidenceRefs.length}</summary><SourceLinks refs={answer.evidenceRefs} /></details> : null}
    <footer className="agency-answer-footer">As of {new Date(answer.generatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</footer>
  </section>
}
