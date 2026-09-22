import { useState } from 'react'
import { ArrowLeft, Check, ChevronRight, Clipboard, FileText, MapPin, Radio, X } from 'lucide-react'
import { apiJson } from '../app/api'
import type { AgencyState, OperationalEvent, RiderDraft, ToolResult } from '../agency/types'

export const minutes = (seconds: number) => `${Number((seconds / 60).toFixed(1))} min`
export const shortId = (id: string) => id.split('\u001f').at(-1) || id
const timeLabel = (value: string | number | null | undefined, timezone?: string | null) => value == null ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(typeof value === 'number' ? value * 1000 : value))

function EvidenceComparison({ event }: { event: OperationalEvent }) {
  const e = event.evidence
  const isHeadway = e.scheduledHeadwaySeconds !== undefined && e.observedHeadwaySeconds !== undefined
  if (!isHeadway && e.delaySeconds === undefined) return null
  const scheduled = isHeadway ? e.scheduledHeadwaySeconds! : 0
  const predicted = isHeadway ? e.observedHeadwaySeconds! : e.delaySeconds!
  const max = Math.max(scheduled, predicted, 1)
  return <figure className="agency-comparison">
    <figcaption>{isHeadway ? 'Departure interval at the same stop' : 'Departure deviation from schedule'}</figcaption>
    {isHeadway ? <div className="agency-measure"><span>{e.comparisonBasis ? 'Local scheduled interval' : 'Scheduled'}</span><div><i style={{ width: `${scheduled / max * 100}%` }} /></div><strong>{minutes(scheduled)}</strong></div> : null}
    <div className="agency-measure is-predicted"><span>{isHeadway ? 'Predicted' : 'Later by'}</span><div><i style={{ width: `${predicted / max * 100}%` }} /></div><strong>{minutes(predicted)}</strong></div>
    <p>{isHeadway ? e.comparisonBasis ? `Running order has changed. The reference is the smallest scheduled interval between these trips; their own scheduled separation is ${minutes(e.scheduledPairSeparationSeconds!)}. Intervening trips are accounted for by fresh predictions or positions beyond this stop.` : `${e.reportingTrips} of ${e.expectedDepartures} expected departures report at this stop.` : 'Computed from the stop departure prediction and its indexed scheduled departure.'}</p>
  </figure>
}

function DelayHistory({ points }: { points: Array<{ at: string; delaySeconds: number }> }) {
  if (points.length < 2) return <p className="agency-caption">Delay history builds with each new observation.</p>
  const first = Date.parse(points[0].at)
  const width = Math.max(1, Date.parse(points.at(-1)!.at) - first)
  const low = Math.min(0, ...points.map((point) => point.delaySeconds))
  const high = Math.max(1, ...points.map((point) => point.delaySeconds))
  const line = points.map((point) => `${8 + (Date.parse(point.at) - first) / width * 304},${64 - (point.delaySeconds - low) / (high - low) * 52}`).join(' ')
  return <figure className="agency-history-chart"><figcaption>Trip’s next departure · delay history · {points.length} observations</figcaption><svg viewBox="0 0 320 76" role="img" aria-label={`Delay changed from ${minutes(points[0].delaySeconds)} to ${minutes(points.at(-1)!.delaySeconds)}`}><path d="M8 64H312" className="agency-chart-axis" /><polyline points={line} fill="none" className="agency-chart-line" /></svg><div><span>{minutes(points[0].delaySeconds)}</span><span>{minutes(points.at(-1)!.delaySeconds)}</span></div></figure>
}

export function SourceLinks({ refs }: { refs: string[] }) {
  return <ul className="agency-sources">{refs.map((ref) => <li key={ref}>{/^https?:\/\//i.test(ref) ? <a href={ref} target="_blank" rel="noreferrer">{ref}</a> : <code>{ref}</code>}</li>)}</ul>
}

export function AgencyEvidence({ historical = false, event, state, projectId, onBack, onLocate, onUpdate }: { historical?: boolean; event: OperationalEvent; state: AgencyState; projectId: string; onBack: () => void; onLocate: () => void; onUpdate: (event: OperationalEvent) => void }) {
  const [channel, setChannel] = useState<RiderDraft['channel']>('app')
  const [draft, setDraft] = useState<RiderDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const route = state.routes.find((item) => item.id === event.routeId)
  const latest = state.events.find((item) => item.id === event.id)
  const stillCurrent = Boolean(latest)
  const hasNewerReport = latest && (latest.observedAt !== event.observedAt || JSON.stringify(latest.evidence) !== JSON.stringify(event.evidence))
  async function generate() {
    setBusy(true); setError(''); setCopied(false)
    try {
      const result = await apiJson<ToolResult>(`/api/projects/${encodeURIComponent(projectId)}/agency`, { method: 'POST', body: JSON.stringify({ action: 'tool', name: 'draft_rider_message', arguments: { eventId: event.id, channel, language: 'en', accessibilityMode: true } }) })
      setDraft(result.data as RiderDraft)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Draft unavailable.') }
    finally { setBusy(false) }
  }
  return <section className="agency-evidence" aria-label="Operational evidence">
    <button className="agency-text-button" onClick={onBack}><ArrowLeft size={15} /> {historical ? 'Back to conversation' : 'Back to service updates'}</button>
    <div className="agency-section-label"><Radio size={13} /> Operational evidence <span>{event.severity}</span></div>
    <h2>{event.title}</h2>
    <div className="agency-evidence-context">{route ? <span className="agency-route-label" style={{ '--line-color': route.color } as React.CSSProperties}>{route.name}</span> : null}<span>{event.stopId ? event.stopName || state.stopNames?.[event.stopId] || shortId(event.stopId) : 'Network observation'}</span>{event.directionId != null ? <span>Direction {event.directionId}</span> : null}</div>
    <p className="agency-caption">{historical ? 'Saved evidence from this answer.' : 'Evidence held at the selected observation.'} The map and line view show the latest available feed reports.</p>
    {!historical && hasNewerReport ? <div className="agency-notice">A newer report is available. <button className="agency-text-button" onClick={() => onUpdate(latest)}>Update evidence</button></div> : null}
    {!historical && !stillCurrent ? <div className="agency-notice">This event is no longer among the current observations. Its retained evidence is shown below.</div> : null}
    <EvidenceComparison event={event} />
    {event.evidence.alertDescription ? <p className="agency-alert-description">{event.evidence.alertDescription}</p> : null}
    <dl className="agency-facts">
      <div><dt>Observed</dt><dd>{timeLabel(event.observedAt, state.coverage.timezone)} · {state.coverage.timezone || 'Timezone unknown'}</dd></div>
      {event.serviceDate ? <div><dt>Service date</dt><dd>{event.serviceDate}</dd></div> : null}
      {event.tripId ? <div><dt>Trip</dt><dd>{shortId(event.tripId)}</dd></div> : null}
      {event.vehicleId ? <div><dt>Vehicle</dt><dd>{event.vehicleId}</dd></div> : null}
      {event.evidence.scheduledTime != null ? <div><dt>Scheduled departure</dt><dd>{timeLabel(event.evidence.scheduledTime, state.coverage.timezone)}</dd></div> : null}
      {event.evidence.predictedTime != null ? <div><dt>Predicted departure</dt><dd>{timeLabel(event.evidence.predictedTime, state.coverage.timezone)}</dd></div> : null}
      {event.evidence.comparisonWindow ? <div><dt>Compared interval</dt><dd>{event.evidence.comparisonWindow.map((time) => timeLabel(time, state.coverage.timezone)).join(' – ')}</dd></div> : null}
      {event.evidence.tripIds ? <div><dt>Compared trips</dt><dd>{event.evidence.tripIds.map(shortId).join(' → ')}</dd></div> : null}
      {event.evidence.feedAgeSeconds != null ? <div><dt>Source age</dt><dd>{Math.round(event.evidence.feedAgeSeconds)} seconds</dd></div> : null}
    </dl>
    {event.evidence.reason ? <p className="agency-caption">{event.evidence.reason}</p> : null}
    {!historical && event.tripId ? <DelayHistory points={state.tripHistory[`${event.tripId}/${event.serviceDate}`] ?? []} /> : null}
    <div className="agency-evidence-actions"><button className="agency-button" onClick={onLocate}><MapPin size={14} /> Locate on map</button>{!historical ? <button className="agency-button is-primary" onClick={() => void generate()} disabled={busy || !stillCurrent}><FileText size={14} />{busy ? 'Preparing draft…' : 'Draft from latest report'}<ChevronRight size={14} /></button> : null}</div>
    {!historical ? <fieldset className="agency-channel-picker"><legend>Communication channel</legend>{(['app', 'signage', 'service-alert', 'social'] as const).map((item) => <label key={item}><input type="radio" name="draft-channel" checked={channel === item} onChange={() => { setChannel(item); setDraft(null) }} />{item === 'service-alert' ? 'Service alert' : item === 'app' ? 'Agency app' : item === 'signage' ? 'Digital sign' : 'Social'}</label>)}</fieldset> : null}
    {error ? <p role="alert" className="agency-error">{error}</p> : null}
    {draft ? <section className={`agency-draft is-${draft.channel}`} data-channel={draft.channel} aria-label="Rider information draft"><div className="agency-draft-label"><span>Draft · Human review required</span><button className="agency-icon-button" aria-label="Close draft" onClick={() => setDraft(null)}><X size={14} /></button></div><h3>{draft.headline}</h3><p>{draft.body}</p><p className="agency-caption">{draft.recommendedAction}</p><footer><span>{draft.generatedBy === 'model' ? 'AI-assisted draft' : 'Draft from source evidence'}</span><button className="agency-text-button" onClick={() => void navigator.clipboard.writeText(`DRAFT · HUMAN REVIEW REQUIRED\n${draft.headline}\n\n${draft.body}\n\n${draft.recommendedAction}`).then(() => setCopied(true)).catch(() => setError('Clipboard unavailable. Select and copy the draft text.'))}>{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? 'Copied' : 'Copy draft'}</button></footer></section> : null}
    <details className="agency-source-details" open><summary>Sources · {event.sourceRefs.length}</summary><SourceLinks refs={event.sourceRefs} /></details>
  </section>
}
