import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowRight, ChevronRight, CircleHelp, Clock3, Download, Layers3, MessageSquare, Radio, RefreshCw, Map, Search, Send, Square, Workflow, X } from 'lucide-react'
import { apiJson, apiProgressJson, type ApiProgress } from '../app/api'
import type { RealtimeInspectRequest } from '../app/realtime'
import type { RealtimeSnapshot } from '../domain'
import type { AgencySkill, AgencyState, OperationalEvent, QueryAnswer, ToolResult } from '../agency/types'
import { AgencyEvidence, minutes, shortId, timeLabel } from './AgencyEvidence'
import { AgencyProviderSettings } from './AgencyProviderSettings'
import { AgencyActivity, AgencyAnswer } from './AgencyAnswer'
import { RealtimePanel } from './RealtimePanel'

type Mode = 'live' | 'ask' | 'skills'
const modes: Array<{ id: Mode; label: string; icon: typeof Radio }> = [{ id: 'live', label: 'Live', icon: Radio }, { id: 'ask', label: 'Ask', icon: MessageSquare }, { id: 'skills', label: 'Skills', icon: Workflow }]
const eventLabel: Record<OperationalEvent['type'], string> = { delay: 'Delay', bunching: 'Compressed interval', 'service-gap': 'Wider interval', cancellation: 'Cancellation', 'skipped-stop': 'Skipped stop', 'stale-data': 'Data freshness', 'service-alert': 'Service alert' }

function exportObservation(state: AgencyState) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'agency-observation.json'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AgencyPanel({ projectId, snapshot, realtimeRequest, realtimeMessage, realtimeLoading, onConnect, onDisconnect, onLocate, onResult, onOpenData, mapOpen, onToggleMap }: {
  mapOpen: boolean
  onToggleMap: () => void
  projectId: string
  snapshot: RealtimeSnapshot | null
  realtimeRequest: RealtimeInspectRequest | null
  realtimeMessage: string
  realtimeLoading: boolean
  onConnect: (request: RealtimeInspectRequest) => void
  onDisconnect: () => void
  onLocate: (routeIds: string[], stopIds: string[]) => void
  onResult: (result: ToolResult) => void
  onOpenData: () => void
}) {
  const [mode, setMode] = useState<Mode>('live')
  const [state, setState] = useState<AgencyState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [feedsOpen, setFeedsOpen] = useState(false)
  const [routeFilter, setRouteFilter] = useState('')
  const [search, setSearch] = useState('')
  const [eventFilter, setEventFilter] = useState('all')
  const [selectedEvent, setSelectedEvent] = useState<OperationalEvent | null>(null)
  const [question, setQuestion] = useState('')
  const [activities, setActivities] = useState<ApiProgress[]>([])
  const [asked, setAsked] = useState('')
  const [answer, setAnswer] = useState<QueryAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const [skills, setSkills] = useState<AgencySkill[]>([])
  const [skillRoute, setSkillRoute] = useState('')
  const [showAllRoutes, setShowAllRoutes] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/agency`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const next = await apiJson<AgencyState>(endpoint, { signal }); setState(next); setError('') }
    catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : 'Observation unavailable.') }
    finally { if (!signal?.aborted) setLoading(false) }
  }, [endpoint])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 10_000)
    void apiJson<{ skills: AgencySkill[] }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'skills' }), signal: controller.signal }).then((result) => setSkills(result.skills)).catch(() => {})
    return () => { controller.abort(); clearInterval(timer); abortRef.current?.abort() }
  }, [endpoint, refresh])
  useEffect(() => { if (snapshot) { setFeedsOpen(false); void refresh() } }, [snapshot, refresh])
  useEffect(() => {
    if (!state?.connected || snapshot) return
    const controller = new AbortController()
    void apiJson<{ request: RealtimeInspectRequest | null }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'connection' }), signal: controller.signal }).then(({ request }) => { if (request && !controller.signal.aborted) onConnect(request) }).catch(() => {})
    return () => controller.abort()
  }, [state?.connected, snapshot, endpoint])
  const filteredRoutes = useMemo(() => (state?.routes ?? []).filter((route) => `${route.name} ${route.longName}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => b.events - a.events || b.reportingTrips - a.reportingTrips || a.name.localeCompare(b.name, undefined, { numeric: true })), [state, search])
  const events = useMemo(() => (state?.events ?? []).filter((event) => (!routeFilter || event.routeId === routeFilter || event.routeIds?.includes(routeFilter)) && (eventFilter === 'all' || event.type === eventFilter)), [state, routeFilter, eventFilter])

  async function ask(nextQuestion = question) {
    if (busy || !nextQuestion.trim()) return
    if (!state?.provider.available) { document.querySelector<HTMLButtonElement>('.agency-ai-connection button[aria-expanded="false"]')?.click(); return }
    setAsked(nextQuestion); setQuestion(''); setBusy(true); setAnswer(null); setActivities([]); setError('')
    const controller = new AbortController(); abortRef.current = controller
    try {
      const result = await apiProgressJson<QueryAnswer>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'ask', question: nextQuestion }), signal: controller.signal }, (progress) => setActivities((items) => items.some((item) => item.phase === progress.phase) ? items.map((item) => item.phase === progress.phase ? progress : item) : [...items, progress]))
      setAnswer(result)
      if (!result.trace.some((call) => call.result.ok)) setQuestion(nextQuestion)
      const last = result.trace.filter((call) => call.result.ok).at(-1)?.result
      if (last) onResult(last)
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Question failed.') }
    finally { setBusy(false); abortRef.current = null }
  }

  async function runSkill(skill: AgencySkill) {
    if (skill.id === 'rider-communication') { setMode('live'); setSelectedEvent(null); return }
    setBusy(true); setError(''); setActivities([])
    try {
      const result = await apiJson<{ results: Array<{ tool: string; result: ToolResult }> }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'run-skill', id: skill.id, inputs: skill.id === 'disruption-triage' ? { routeId: skillRoute } : {} }) })
      setAsked(skill.name); setAnswer({ answer: `${skill.name} completed. Inspect the computed evidence below.`, trace: result.results.map((item) => ({ ...item, arguments: skill.id === 'disruption-triage' ? { routeId: skillRoute } : {} })), evidenceRefs: [...new Set(result.results.flatMap((item) => item.result.provenance))], generatedAt: state?.generatedAt ?? new Date().toISOString(), warnings: [...new Set(result.results.flatMap((item) => item.result.warnings))], providerAvailable: state?.provider.available ?? false }); setMode('ask')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Workflow unavailable.') }
    finally { setBusy(false) }
  }

  async function toggleSkill(skill: AgencySkill) {
    try { await apiJson(endpoint, { method: 'POST', body: JSON.stringify({ action: 'skill-enabled', id: skill.id, enabled: !skill.enabled }) }); setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, enabled: !item.enabled } : item)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Setting could not be saved.') }
  }

  function selectEvent(event: OperationalEvent) {
    setSelectedEvent(event)
    onLocate(event.routeIds ?? (event.routeId ? [event.routeId] : []), event.stopId ? [event.stopId] : event.stopIds ?? [])
  }

  return <section className="agency-panel" aria-label="Agency workspace">
    <header className="agency-header"><div><div className="agency-kicker"><span className="agency-wordmark">AGENCY</span><span>{state?.cityName || 'City operations'}</span></div><h1>{mode === 'live' ? 'Network operations' : mode === 'ask' ? 'Ask your network' : 'Transit workflows'}</h1></div><div className="agency-header-actions"><button className="agency-icon-button agency-mobile-map-toggle" aria-label={mapOpen ? "Hide map" : "Show map"} aria-pressed={mapOpen} onClick={onToggleMap}><Map size={16} /></button><button className="agency-icon-button" title="Refresh observation" aria-label="Refresh observation" onClick={() => void refresh()}><RefreshCw size={16} /></button>{state ? <button className="agency-icon-button" title="Export observation" aria-label="Export observation" onClick={() => exportObservation(state)}><Download size={16} /></button> : null}</div></header>
    <div className="agency-tabs" role="tablist" aria-label="Agency modes">{modes.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={mode === id} aria-controls={`agency-${id}`} id={`agency-tab-${id}`} tabIndex={mode === id ? 0 : -1} onClick={() => setMode(id)} onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = modes.findIndex((item) => item.id === id); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3; setMode(modes[next].id); document.getElementById(`agency-tab-${modes[next].id}`)?.focus() }}><Icon size={15} />{label}</button>)}<span className={`agency-live-indicator ${state?.connected ? 'is-connected' : ''}`}><i />{state?.connected ? 'Observing' : 'Not connected'}</span></div>
    <div className="agency-scroll">
      {error ? <div className="agency-error" role="alert">{error}{!state || !state.coverage.valid ? <button className="agency-text-button" onClick={onOpenData}>Open City data <ArrowRight size={13} /></button> : null}</div> : null}
      {loading && !state ? <div className="agency-empty"><Activity size={24} /><h2>Reading the City</h2><p>Checking the indexed timetable and service calendar.</p></div> : null}
      {state ? <>
        {!state.coverage.valid ? <div className="agency-notice"><strong>Timetable needs attention</strong><p>{state.coverage.message}</p><button className="agency-text-button" onClick={onOpenData}>Update City data <ArrowRight size={13} /></button></div> : null}
        {mode === 'live' ? <div id="agency-live" role="tabpanel" aria-labelledby="agency-tab-live">
          {selectedEvent ? <AgencyEvidence key={selectedEvent.id} event={state.events.find((event) => event.id === selectedEvent.id) ?? selectedEvent} state={state} projectId={projectId} onBack={() => setSelectedEvent(null)} onLocate={() => onLocate(selectedEvent.routeIds ?? (selectedEvent.routeId ? [selectedEvent.routeId] : []), selectedEvent.stopId ? [selectedEvent.stopId] : [])} /> : <>
            <div className="agency-metrics">{[{ label: 'Fresh vehicles', value: state.counts.vehicles, note: 'Timestamp verified' }, { label: 'Aligned trips', value: state.counts.matchedTrips, note: `${state.counts.unresolvedTrips} unresolved` }, { label: 'Active alerts', value: state.counts.alerts, note: 'Published by agency' }, { label: 'Service events', value: state.eventCount ?? state.events.length, note: 'Evidence attached' }].map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{state.connected ? metric.value.toLocaleString() : '—'}</strong><small>{metric.note}</small></div>)}</div>
            <section className="agency-observation-strip"><div><Radio size={14} /><span>{state.connected ? `Received ${timeLabel(state.observedAt, state.coverage.timezone)}` : 'Connect a realtime source'}</span></div><button className="agency-text-button" onClick={() => setFeedsOpen((open) => !open)}>{state.connected ? 'Manage feeds' : 'Connect feeds'}<ChevronRight size={13} /></button></section>
            {state.feeds.length ? <div className="agency-feed-status">{state.feeds.map((feed) => <span key={feed.sourceUrl} title={`${feed.sourceUrl}\n${feed.error || feed.status}`} className={`is-${feed.status}`} data-freshness={feed.status}><i />{feed.kind === 'tripUpdates' ? 'Trip updates' : feed.kind === 'vehicles' ? 'Vehicles' : feed.kind === 'alerts' ? 'Alerts' : 'Feed'}<b>{feed.ageSeconds == null ? 'Unknown age' : `${Math.round(feed.ageSeconds)}s`}</b></span>)}</div> : null}
            {feedsOpen ? <div className="agency-connect"><button className="agency-icon-button agency-connect-close" aria-label="Close feed settings" onClick={() => setFeedsOpen(false)}><X size={15} /></button><RealtimePanel snapshot={snapshot} request={realtimeRequest} message={realtimeMessage} loading={realtimeLoading} onConnect={onConnect} onDisconnect={onDisconnect} /></div> : null}
            {!state.connected ? <div className="agency-welcome"><div className="agency-welcome-icon"><Layers3 size={24} /></div><div><h2>The timetable is ready.</h2><p>Connect your agency’s feeds to compare departure predictions with scheduled service. Every finding opens to its evidence.</p><p className="agency-caption">{state.coverage.firstDate} — {state.coverage.lastDate} · {state.coverage.timezone}</p></div></div> : null}
            <div className="agency-section-heading"><div><h2>Routes</h2><span>{state.counts.routes} indexed · departure evidence</span></div><label className="agency-search"><Search size={14} /><input aria-label="Find a route" placeholder="Find a route" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
            <div className="agency-route-table"><table><thead><tr><th>Route</th><th>Reporting</th><th>Max delay</th><th>Intervals</th><th>Alerts</th></tr></thead><tbody>{filteredRoutes.slice(0, showAllRoutes ? 200 : 7).map((route) => <tr key={route.id} className={routeFilter === route.id ? 'is-selected' : ''}><td><button onClick={() => { setRouteFilter(routeFilter === route.id ? '' : route.id); onLocate([route.id], []) }} title={route.longName}><span className="agency-route-label" style={{ '--line-color': route.color } as React.CSSProperties}>{route.name}</span><span className="agency-route-description">{route.longName !== route.name ? route.longName : shortId(route.id)}</span></button></td><td>{state.connected ? route.reportingTrips : '—'}</td><td>{route.maxDelaySeconds == null ? '—' : minutes(Math.max(0, route.maxDelaySeconds))}</td><td><span className={`agency-interval-state is-${route.headway}`} data-headway={route.headway}>{route.headway === 'changed' ? 'Changed' : route.headway === 'matches-schedule' ? 'Measured' : 'Unknown'}</span></td><td>{state.connected ? route.alerts : '—'}</td></tr>)}</tbody></table></div>
            {filteredRoutes.length > 7 ? <button className="agency-text-button agency-show-more" onClick={() => setShowAllRoutes((value) => !value)}>{showAllRoutes ? 'Show fewer routes' : `Browse ${filteredRoutes.length} routes`}<ChevronRight size={13} /></button> : null}
            <div className="agency-section-heading"><div><h2>Observed service events</h2><span>{events.length} in view</span></div><select aria-label="Filter event type" value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}><option value="all">All event types</option>{Object.entries(eventLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            {routeFilter ? <button className="agency-filter-chip" onClick={() => setRouteFilter('')}>{state.routes.find((route) => route.id === routeFilter)?.name || routeFilter}<X size={12} /> Clear route filter</button> : null}
            <div className="agency-event-list">{events.slice(0, 40).map((event) => <button key={event.id} className={`agency-event is-${event.severity}`} data-severity={event.severity} onClick={() => selectEvent(event)}><span className="agency-event-mark"><Activity size={15} /></span><span><strong>{event.title}</strong><small>{event.routeId ? state.routes.find((route) => route.id === event.routeId)?.name || shortId(event.routeId) : 'Network'}{event.stopId ? ` · ${state.stopNames?.[event.stopId] || shortId(event.stopId)}` : ''}{event.evidence.delaySeconds != null ? ` · +${minutes(event.evidence.delaySeconds)}` : event.evidence.observedHeadwaySeconds != null ? ` · ${minutes(event.evidence.observedHeadwaySeconds)} predicted / ${minutes(event.evidence.scheduledHeadwaySeconds!)} scheduled` : ''}</small></span><ChevronRight size={15} /></button>)}</div>
            {!events.length ? <div className="agency-quiet"><CircleHelp size={19} /><div><strong>{state.connected ? 'No events established in this view' : 'Waiting for observations'}</strong><p>{state.connected ? 'A lack of events is not proof of regular service. Check reporting coverage and source freshness.' : 'Live observations will appear here after the feeds connect.'}</p></div></div> : null}
            {events.length > 40 ? <p className="agency-caption">First 40 events shown. Use the route and event filters to narrow the view.</p> : null}
            {state.warnings.length ? <details className="agency-source-details"><summary>Coverage notes · {state.warnings.length}</summary>{state.warnings.map((warning) => <p className="agency-caption" key={warning}>{warning}</p>)}</details> : null}
            <p className="agency-method-note"><Clock3 size={13} /> Predicted departure intervals · {state.policy.windowMinutes} minute window. “Measured” describes reporting intervals, not route-wide regularity.</p>
          </>}
        </div> : mode === 'ask' ? <div id="agency-ask" role="tabpanel" aria-labelledby="agency-tab-ask">
          <p className="agency-intro">Investigate service with the timetable, current observations, and VIGO’s routing tools.</p>
          <AgencyProviderSettings endpoint={endpoint} provider={state.provider} onChange={() => void refresh()} />
          <form className="agency-question-form" onSubmit={(event) => { event.preventDefault(); void ask() }}><label htmlFor="agency-question">Your question</label><textarea id="agency-question" placeholder="Which routes have the widest departure intervals right now?" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} rows={4} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void ask() } }} /><footer><span>Timetable · Realtime · Routing</span>{busy ? <button type="button" className="agency-button" onClick={() => abortRef.current?.abort()}><Square size={13} /> Stop</button> : <button className="agency-button is-primary" disabled={!question.trim()} type="submit"><Send size={14} /> Ask</button>}</footer></form>
          {!answer && !busy ? <div className="agency-suggestions">{['Which routes have the widest departure intervals?', 'Summarize network health and data freshness.', 'What service runs after 22:00 today?'].map((suggestion) => <button key={suggestion} onClick={() => { setQuestion(suggestion); document.getElementById('agency-question')?.focus() }}>{suggestion}<ArrowRight size={14} /></button>)}</div> : null}
          {busy || answer ? <div className="agency-question-echo">{asked}</div> : null}
          <AgencyActivity activities={activities} busy={busy} trace={answer?.trace ?? []} />
          {answer ? <AgencyAnswer answer={answer} onResult={onResult} onSelectEvent={(event) => { setMode('live'); selectEvent(event) }} /> : null}
        </div> : <div id="agency-skills" role="tabpanel" aria-labelledby="agency-tab-skills"><p className="agency-intro">Small, explicit workflows over the same operational evidence. Inspect their inputs and tools before running.</p><div className="agency-skill-list">{skills.map((skill) => <article key={skill.id} className={`agency-skill ${skill.status === 'unavailable' ? 'is-unavailable' : ''}`}><header><div className="agency-skill-icon"><Workflow size={20} /></div><div><h2>{skill.name}</h2><span>{skill.source === 'external' ? 'External integration' : 'VIGO'} · v{skill.version}</span></div><label className="agency-switch"><input type="checkbox" aria-label={`Enable ${skill.name}`} checked={skill.enabled} disabled={skill.status !== 'ready'} onChange={() => void toggleSkill(skill)} /><span /></label></header><p>{skill.description}</p><details><summary>Inputs and tools</summary><dl className="agency-facts"><div><dt>Inputs</dt><dd>{skill.requiredInputs.join(', ') || 'Current City observation'}</dd></div><div><dt>Tools</dt><dd>{skill.tools.join(' → ') || 'No model installed'}</dd></div><div><dt>Output</dt><dd>{skill.outputType}</dd></div></dl></details>{skill.id === 'disruption-triage' ? <select aria-label="Route for disruption triage" value={skillRoute} onChange={(event) => setSkillRoute(event.target.value)}><option value="">Choose a route</option>{state.routes.map((route) => <option key={route.id} value={route.id}>{route.name} · {route.longName}</option>)}</select> : null}<footer><span>{skill.status === 'unavailable' ? 'Not installed' : skill.enabled ? 'Ready' : 'Disabled'}</span><button className="agency-button" disabled={busy || !skill.enabled || skill.status !== 'ready' || skill.id === 'disruption-triage' && !skillRoute} onClick={() => void runSkill(skill)}>{skill.id === 'rider-communication' ? 'Select an event' : 'Run workflow'}<ArrowRight size={13} /></button></footer></article>)}</div><p className="agency-caption">Skill settings and observation history stay in this session. Rider outputs are draft previews.</p></div>}
      </> : null}
    </div>
    <footer className="agency-panel-footer"><span>VIGO Agency</span><span>{state?.coverage.timezone || 'Source timezone unavailable'}</span></footer>
  </section>
}
