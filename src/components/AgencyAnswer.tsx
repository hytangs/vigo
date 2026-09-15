import { LampStudyResult, type LampStudyData } from './LampStudyResult'
import { ArrowRight } from 'lucide-react'
import type { OperationalEvent, QueryAnswer, ToolResult } from '../agency/types'
import type { RoutingPlan } from '../routingModel'
import { AgencyJourneys } from './AgencyJourney'
import { downloadText } from '../agency/exports'
import { humanField, toolNames } from '../agency/presentation'
import { SourceLinks } from './AgencyEvidence'
import { AgencyRuntimeFacts } from './AgencyRuntimeFacts'
import { NetworkAssessment } from './NetworkAssessment'
import { AgencyWalkingAssessment, AgencyWalkingComparisons, type WalkingOutput } from './AgencyWalking'
import { StopArrivalBoardView } from './StopArrivalBoard'
import type { StopBoard } from '../agency/routeOperationsTypes'
import { publicReply } from '../agency/publicReply.mjs'

function answerText(text: string) {
  return publicReply(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part: string, index: number) => (
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part
  ))
}
function ServiceProfileChart({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.every((row) => typeof row.service_hour === 'number' && typeof row.scheduled_trip_starts === 'number')) return null
  const values = rows as Array<{ service_hour: number; scheduled_trip_starts: number }>
  const first = Math.min(...values.map((row) => row.service_hour)), last = Math.max(...values.map((row) => row.service_hour))
  const peak = Math.max(1, ...values.map((row) => row.scheduled_trip_starts)), width = 480 / (last - first + 1)
  return <figure className="agency-profile-chart"><figcaption>Scheduled trip starts by service hour</figcaption><svg viewBox="0 0 540 180" role="img" aria-label={`Scheduled trip starts from service hour ${first} to ${last}. Largest hourly count: ${peak}.`}><text x="4" y="20">{peak}</text><text x="21" y="147">0</text><line x1="42" x2="530" y1="143" y2="143" />{values.map((row) => <g key={row.service_hour}><rect x={44 + (row.service_hour - first) * width} y={143 - row.scheduled_trip_starts / peak * 125} width={Math.max(1, width - 4)} height={row.scheduled_trip_starts / peak * 125}><title>{row.service_hour}:00 · {row.scheduled_trip_starts} scheduled trip starts</title></rect><text x={44 + (row.service_hour - first) * width + (width - 4) / 2} y="163" textAnchor="middle">{row.service_hour}</text></g>)}</svg><p className="agency-caption">Service hours above 23 continue the same GTFS service day.</p></figure>
}


export function AgencyToolOutput({ result, onSelectEvent, onOpenEntry, onResult }: { result: ToolResult; onResult?: (result: ToolResult) => void; onSelectEvent?: (event: OperationalEvent) => void; onOpenEntry?: (id: number) => void }) {
  const board = (result.data as { board?: StopBoard })?.board
  if (board) return board.vehicle && !board.rows.length ? null : <StopArrivalBoardView data={board} recorded />
  const lamp = result.data as LampStudyData
  if (lamp?.dataset === 'MBTA LAMP subway performance') return <LampStudyResult study={lamp} />
  const walking = result.data as WalkingOutput
  const data = result.data as { entries?: Array<{ id: number; title: string; observedAt: string; excerpt: string; notes: string; shortened: boolean }>; rows?: Record<string, unknown>[]; matches?: Array<{ kind: string; id: string; name: string; address?: string; category?: { key: string; value: string }; url?: string; title?: string; excerpt?: string }>; plan?: RoutingPlan; resolved?: Array<{ label: string }>; events?: Array<OperationalEvent & { routeName?: string; stopName?: string }>; counts?: Record<string, number>; summary?: { maximumCutoffMinutes: number; transitStatus?: { reachedStops: number } } }
  if (data?.matches?.some(item => item.url)) return <details className="agency-source-details"><summary>Public sources · {data.matches.length}</summary><div className="agency-recalled-work">{data.matches.filter(item => item.url && /^https?:\/\//i.test(item.url)).map(item => <article key={item.url}><a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a><p>{item.excerpt}</p></article>)}</div></details>
  if (data?.entries) return <div className="agency-recalled-work">{data.entries.map((entry) => <article key={entry.id}>
    <strong>{entry.title}</strong>
    <small>Saved evidence · {new Date(entry.observedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small>
    <p>{entry.excerpt}</p>
    {entry.notes ? <p><b>Staff note</b> · {entry.notes}</p> : null}
    {entry.shortened ? <small>Excerpt shortened. The original retains the complete answer and notes.</small> : null}
    {onOpenEntry ? <button className="agency-text-button" onClick={() => onOpenEntry(entry.id)}>Open original <ArrowRight size={13} /></button> : null}
  </article>)}</div>
  if (walking.comparisons) return <AgencyWalkingComparisons rows={walking.comparisons} />
  if ((result.data as { journeys?: unknown[] })?.journeys?.length || data?.plan?.legs?.length) return <><AgencyJourneys result={result} onResult={onResult} /><AgencyWalkingAssessment assessment={walking.assessment} /></>
  if (data?.rows?.length) {
    const columns = Object.keys(data.rows[0])
    return <><ServiceProfileChart rows={data.rows} /><div className="agency-query-table"><table><thead><tr>{columns.map((key) => <th key={key}>{humanField(key)}</th>)}</tr></thead><tbody>{data.rows.slice(0, 40).map((row, i) => <tr key={i}>{columns.map((key) => <td key={key}>{row[key] == null ? '—' : typeof row[key] === 'number' ? row[key].toLocaleString() : String(row[key])}</td>)}</tr>)}</tbody></table>{data.rows.length > 40 ? <p className="agency-caption">Showing 40 of {data.rows.length} rows. Download the record for the full result.</p> : null}</div></>
  }
  if (data?.matches) return <div className="agency-entity-results">{data.matches.map((item) => <div key={`${item.kind}/${item.id}`}><strong>{item.name}</strong><span>{item.category ? `${humanField(item.category.value)} · ` : ''}{item.address || `${item.kind} · ${item.id}`}</span></div>)}</div>
  if (data?.events) return <div className="agency-answer-events">{data.events.slice(0, 8).map((event) => <button key={event.id} onClick={() => onSelectEvent?.(event)}><div><strong>{event.routeName ? `${event.routeName} · ` : ''}{event.title}</strong><span>{event.scopeDescription || event.stopName || (event.type === 'service-alert' ? 'Published by the agency' : 'Current service report')}</span>{event.evidence.observedHeadwaySeconds != null ? <p><b>{Number((event.evidence.observedHeadwaySeconds / 60).toFixed(1))} min apart</b><span>Scheduled: {Number(((event.evidence.scheduledHeadwaySeconds ?? 0) / 60).toFixed(1))} min</span></p> : event.evidence.delaySeconds != null ? <p>{Number((event.evidence.delaySeconds / 60).toFixed(1))} min later than scheduled</p> : null}</div><ArrowRight size={15} /></button>)}</div>
  if (data?.summary?.transitStatus) return <dl className="agency-facts"><div><dt>Travel time budget</dt><dd>{data.summary.maximumCutoffMinutes} min</dd></div><div><dt>Transit stops reached</dt><dd>{data.summary.transitStatus.reachedStops}</dd></div></dl>
  if (data?.counts) return <dl className="agency-facts">{Object.entries(data.counts).map(([key, value]) => <div key={key}><dt>{humanField(key)}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>
  return null
}

export function AgencyAnswer({ answer, onResult, onSelectEvent, onOpenEntry }: { answer: QueryAnswer; onResult: (result: ToolResult) => void; onSelectEvent: (event: OperationalEvent) => void; onOpenEntry?: (id: number) => void }) {
  const citedComparison = answer.aiGenerated ? answer.trace.find((call, index) => answer.citations?.includes(index + 1) && (call.result.data as { events?: OperationalEvent[] }).events?.some((event) => event.evidence.observedHeadwaySeconds != null)) : null
  const result = citedComparison?.result ?? answer.trace.filter((call) => call.result.ok).at(-1)?.result
  const lampResult = answer.trace.find(call => call.result.ok && (call.result.data as LampStudyData)?.dataset === 'MBTA LAMP subway performance')?.result
  const lampReport = Boolean(lampResult && answer.report)
  return <section className="agency-answer" aria-label="Answer">
    {answer.responseBasis && answer.responseBasis !== 'computed' ? <p className="agency-caption" title="Tool results and citations record the checks performed. They do not verify every claim written by the model.">{answer.responseBasis === 'model_only' ? 'AI response · no evidence checked in this turn' : 'AI interpretation · verify against the sources'}</p> : null}
    {answer.diagnosis && answer.narrative ? <><p className="agency-caption">Saved assessment · {new Date(answer.generatedAt).toLocaleString([], { timeZone: answer.timezone || undefined })}</p><NetworkAssessment diagnosis={answer.diagnosis} narrative={answer.narrative} investigation={answer.investigation} /></> : !lampReport ? <p className="agency-answer-text">{answerText(answer.answer)}</p> : null}
    {answer.scopeNote ? <p className="agency-caption">{answer.scopeNote}</p> : null}
    {answer.report?.rows.length && !lampResult ? <div className="agency-research-output"><div className="agency-section-heading"><div><h2>Evidence table</h2><span>{answer.report.rows.length} rows · retained with this note</span></div>{answer.report.rows.length ? <button className="agency-text-button" onClick={() => { const rows = answer.report!.rows; const columns = Object.keys(rows[0]); const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`; downloadText('agency-evidence.csv', [columns.map(cell).join(','), ...rows.map((row) => columns.map((key) => cell(row[key])).join(','))].join('\n'), 'text/csv') }}>Export CSV</button> : null}</div><AgencyToolOutput result={{ ok: true, data: { rows: answer.report.rows }, provenance: [], generatedAt: answer.generatedAt, warnings: [] }} /></div> : null}
    {lampResult ? <AgencyToolOutput result={lampResult} /> : null}
    {result && !lampResult && !answer.report?.rows.length ? <AgencyToolOutput result={result} onSelectEvent={onSelectEvent} onOpenEntry={onOpenEntry} onResult={onResult} /> : null}
    {!(result?.data as { journeys?: unknown[]; plan?: unknown })?.journeys?.length && !(result?.data as { plan?: RoutingPlan })?.plan?.legs?.length && Boolean(result?.presentation?.routeIds?.length === 1 || result?.presentation?.stopIds?.length === 1 || (result?.data as { plan?: unknown; surface?: unknown })?.plan || (result?.data as { surface?: unknown })?.surface) ? <button className="agency-text-button" onClick={() => result && onResult(result)}>Show on map <ArrowRight size={13} /></button> : null}
    {!result && answer.warnings.length ? <p className="agency-error" role="alert">{answer.warnings[0]}</p> : null}
    {answer.warnings.length || answer.evidenceRefs.length || answer.citations?.length || answer.runtime || answer.report || answer.selection?.route || answer.selection?.stop ? <details className="agency-source-details agency-answer-details" open={answer.trace.some(call => call.tool === 'runtime_status')}>
      <summary>Details{answer.citations?.length ? ` · ${answer.citations.length} ${answer.citations.length === 1 ? 'source' : 'sources'}` : ''}</summary>
    {answer.selection?.route || answer.selection?.stop ? <p className="agency-caption">Map selection at time of question: {answer.selection.stop?.name}{answer.selection.stop && answer.selection.route ? ' · ' : ''}{answer.selection.route ? `Route ${answer.selection.route.name}` : ''}</p> : null}
      {answer.warnings.length ? <div><h4>Coverage</h4>{answer.warnings.map(warning => <p className="agency-caption" key={warning}>{warning}</p>)}</div> : null}
      {answer.citations?.length ? <div><h4>Sources</h4>{answer.trace.map((call, index) => answer.citations?.includes(index + 1) ? <div key={index}><strong>[{index + 1}] {toolNames[call.tool] || humanField(call.tool)}</strong><SourceLinks refs={call.result.provenance} /></div> : null)}</div> : answer.evidenceRefs.length ? <SourceLinks refs={answer.evidenceRefs} /> : null}
      {answer.report ? <div><h4>Method</h4><div className="agency-method-text">{answer.report.method}</div></div> : null}
      {answer.runtime ? <AgencyRuntimeFacts runtime={answer.runtime} expanded={answer.trace.some(call => call.tool === 'runtime_status')} /> : null}
    </details> : null}
    <footer className="agency-answer-footer">{answer.aiGenerated ? 'AI-assisted · ' : ''}{answer.trace.length ? 'As of ' : ''}{new Date(answer.generatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(answer.timezone ? { timeZone: answer.timezone } : {}) })}</footer>
  </section>
}
