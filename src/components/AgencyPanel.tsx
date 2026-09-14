import { NetworkSelection } from './NetworkSelection'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, CheckSquare, ArrowRight, ChevronRight, CircleHelp, Clock3, Download, Layers3, MessageSquare, Radio, RefreshCw, Map, Search, Send, Square, Workflow, X, History, Plus } from 'lucide-react'
import { apiJson, apiProgressJson, type ApiProgress } from '../app/api'
import type { RealtimeInspectRequest } from '../app/realtime'
import type { RealtimeSnapshot } from '../domain'
import type { AgencySkill, AgencyState, OperationalEvent, QueryAnswer, ToolResult, WorkspaceSelectionInput } from '../agency/types'
import { AgencyEvidence, minutes, shortId, timeLabel } from './AgencyEvidence'
import { AgencyFeedHealth } from './AgencyFeedHealth'
import { AgencyProviderSettings } from './AgencyProviderSettings'
import { AgencyAnswer } from './AgencyAnswer'
import { AgencyActivity } from './AgencyActivity'
import { AgencyOperations } from './AgencyOperations'
import { AgencyBriefing } from './AgencyBriefing'
import { AgencySkills } from './AgencySkills'
import { AgencyNotebook, AgencyNoteEditor, type NotebookEntry } from './AgencyNotebook'
import { RealtimePanel } from './RealtimePanel'

type Mode = 'live' | 'ask' | 'skills' | 'operations'
const modes: Array<{ id: Mode; label: string; icon: typeof Radio }> = [{ id: 'live', label: 'Overview', icon: Radio }, { id: 'ask', label: 'Ask', icon: MessageSquare }, { id: 'skills', label: 'Skills', icon: Workflow }, { id: 'operations', label: 'Operations', icon: CheckSquare }]
const eventLabel: Record<OperationalEvent['type'], string> = { delay: 'Delay', bunching: 'Compressed interval', 'service-gap': 'Wider interval', cancellation: 'Cancellation', 'skipped-stop': 'Skipped stop', 'stale-data': 'Data freshness', 'service-alert': 'Service alert' }

function exportObservation(state: AgencyState) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'agency-observation.json'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AgencyPanel({ projectId, snapshot, realtimeRequest, realtimeMessage, realtimeLoading, onConnect, onDisconnect, onLocate, onResult, onOpenData, mapOpen, onToggleMap, selection = {}, timetable, onClearSelection }: {
  selection?: WorkspaceSelectionInput
  timetable?: ReactNode
  onClearSelection: () => void
  mapOpen: boolean
  onToggleMap: () => void
  projectId: string
  snapshot: RealtimeSnapshot | null
  realtimeRequest: RealtimeInspectRequest | null
  realtimeMessage: string
  realtimeLoading: boolean
  onConnect: (request: RealtimeInspectRequest) => void
  onDisconnect: () => void
  onLocate: (routeIds: string[], stopIds: string[], location?: { id: string; label: string; coordinate: [number, number] }) => void
  onResult: (result: ToolResult) => void
  onOpenData: () => void
}) {
  const [mode, setMode] = useState<Mode>(() => { const saved = sessionStorage.getItem(`agency-mode-${projectId}`); return modes.some(item => item.id === saved) ? saved as Mode : 'live' })
  const [state, setState] = useState<AgencyState | null>(null)
  const [error, setError] = useState('')
  const [observationError, setObservationError] = useState('')
  const [loading, setLoading] = useState(true)
  const [feedsOpen, setFeedsOpen] = useState(false)
  const routeId = selection.routeId || ''
  const stopId = selection.stopId || ''
  const selectionKey = JSON.stringify([routeId, stopId])
  const [loadedSelection, setLoadedSelection] = useState('')
  const evidenceSelectionKey = useRef('')
  const selectionReady = loadedSelection === selectionKey
  const hasSelection = Boolean(routeId || stopId)
  const [search, setSearch] = useState('')
  const [eventFilter, setEventFilter] = useState('all')
  const [historicalEvent, setHistoricalEvent] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<OperationalEvent | null>(null)
  const [question, setQuestion] = useState(() => sessionStorage.getItem(`agency-question-${projectId}`) || '')
  const [activities, setActivities] = useState<ApiProgress[]>([])
  const [asked, setAsked] = useState('')
  const [answer, setAnswer] = useState<QueryAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const [skills, setSkills] = useState<AgencySkill[]>([])
  const [notebookOpen, setNotebookOpen] = useState(false)
  const [turns, setTurns] = useState<NotebookEntry[]>([])
  const [parentId, setParentId] = useState<number | null>(null)
  const refreshGeneration = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showAllRoutes, setShowAllRoutes] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const entryAbortRef = useRef<AbortController | null>(null)
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/agency`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++refreshGeneration.current
    try { const next = await apiJson<AgencyState>(`${endpoint}?${new URLSearchParams({ routeId, stopId, eventType: eventFilter })}`, { signal }); if (generation === refreshGeneration.current && !signal?.aborted) { setState(next); setLoadedSelection(selectionKey); setObservationError('') } }
    catch (reason) { if (generation === refreshGeneration.current && !signal?.aborted) setObservationError(reason instanceof Error ? reason.message : 'Observation unavailable.') }
    finally { if (generation === refreshGeneration.current && !signal?.aborted) setLoading(false) }
  }, [endpoint, routeId, stopId, selectionKey, eventFilter])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 10_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    void apiJson<{ skills: AgencySkill[] }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'skills' }), signal: controller.signal }).then((result) => setSkills(result.skills)).catch(() => {})
    return () => controller.abort()
  }, [endpoint])
  useEffect(() => () => { abortRef.current?.abort(); entryAbortRef.current?.abort() }, [endpoint])
  useEffect(() => { if (snapshot) { setFeedsOpen(false); void refresh() } }, [snapshot, refresh])
  useEffect(() => {
    if (!state?.connected || snapshot) return
    const controller = new AbortController()
    void apiJson<{ request: RealtimeInspectRequest | null }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'connection' }), signal: controller.signal }).then(({ request }) => { if (request && !controller.signal.aborted) onConnect(request) }).catch(() => {})
    return () => controller.abort()
  }, [state?.connected, snapshot, endpoint])
  useEffect(() => { sessionStorage.setItem(`agency-mode-${projectId}`, mode) }, [mode, projectId])
  useEffect(() => { sessionStorage.setItem(`agency-question-${projectId}`, question) }, [question, projectId])
  async function openEntry(id: number, navigate = true) {
    if (busy || abortRef.current) return
    entryAbortRef.current?.abort()
    const controller = new AbortController(); entryAbortRef.current = controller
    try {
      const result = await apiJson<{ entries: NotebookEntry[] }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'notebook-entry', id }), signal: controller.signal })
      if (controller.signal.aborted) return
      if (navigate) {
        const saved = result.entries.at(-1)?.answer
        if (saved?.selection?.route || saved?.selection?.stop) onLocate(saved.selection.route ? [saved.selection.route.id] : [], saved.selection.stop ? [saved.selection.stop.id] : [])
        else { const last = saved?.trace.filter(call => call.result.ok).at(-1)?.result; if (last) onResult(last) }
      }
      setTurns(result.entries); setParentId(id); setAnswer(null); setAsked(''); setActivities([]); setNotebookOpen(false); if (navigate) setMode('ask')
      sessionStorage.setItem(`agency-entry-${projectId}`, String(id))
      if (navigate) requestAnimationFrame(() => document.querySelector('.agency-turn:last-of-type')?.scrollIntoView({ block: 'start' }))
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not open this conversation.') }
    finally { if (entryAbortRef.current === controller) entryAbortRef.current = null }
  }
  useEffect(() => { const id = Number(sessionStorage.getItem(`agency-entry-${projectId}`)); if (id) void openEntry(id, false) }, [endpoint])
  async function retainAnswer(result: QueryAnswer, signal: AbortSignal) {
    setAnswer(result) // Keep the completed answer visible if notebook readback fails.
    if (result.entryId) {
      const saved = await apiJson<{ entries: NotebookEntry[] }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'notebook-entry', id: result.entryId }), signal })
      if (signal.aborted) return
      setAnswer(null); setTurns(saved.entries); setParentId(result.entryId); sessionStorage.setItem(`agency-entry-${projectId}`, String(result.entryId))
    }
    setAsked(''); setActivities([])
    requestAnimationFrame(() => document.querySelector('.agency-turn:last-of-type')?.scrollIntoView({ block: 'start' }))
  }
  const filteredRoutes = useMemo(() => (state?.routes ?? []).filter((route) => `${route.name} ${route.longName}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => b.events - a.events || b.reportingTrips - a.reportingTrips || a.name.localeCompare(b.name, undefined, { numeric: true })), [state, search])
  const events = selectionReady ? state?.events ?? [] : []
  const focusedRoute = selectionReady ? state?.routes.find(route => route.id === state.selection?.route?.id) : undefined
  useEffect(() => { setEventFilter('all') }, [selectionKey])
  useEffect(() => {
    if (!selectionReady || evidenceSelectionKey.current === selectionKey) return
    evidenceSelectionKey.current = selectionKey
    if (!selectedEvent) return
    const current = state?.selection
    const routeMatches = !current?.route || selectedEvent.routeId === current.route.id || selectedEvent.routeIds?.includes(current.route.id)
    const stopMatches = !current?.stop || selectedEvent.stopId === current.stop.id || selectedEvent.stopIds?.includes(current.stop.id) || state?.events.some(event => event.id === selectedEvent.id)
    if (!hasSelection || !routeMatches || !stopMatches) setSelectedEvent(null)
  }, [selectionReady, selectionKey, state, selectedEvent, hasSelection])

  function stopInvestigation() {
    abortRef.current?.abort()
    setActivities((items) => [...items, { phase: 'stopped', progress: 1, detail: 'Stopped. Open Saved work to return to completed checks.' }])
  }

  async function ask(nextQuestion = question) {
    if (busy || abortRef.current || !nextQuestion.trim()) return
    if (!state?.provider.available) { document.querySelector<HTMLButtonElement>('.agency-ai-connection button[aria-expanded="false"]')?.click(); return }
    entryAbortRef.current?.abort()
    setAsked(nextQuestion); setQuestion(''); setBusy(true); setAnswer(null); setActivities([]); setError('')
    requestAnimationFrame(() => document.querySelector('.agency-pending-question')?.scrollIntoView({ block: 'start' }))
    const controller = new AbortController(); abortRef.current = controller
    try {
      const result = await apiProgressJson<QueryAnswer>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'ask', question: nextQuestion, parentId, selection }), signal: controller.signal }, (progress) => setActivities((items) => items.some((item) => item.phase === progress.phase) ? items.map((item) => item.phase === progress.phase ? progress : item) : [...items, progress]))
      if (controller.signal.aborted) return
      await retainAnswer(result, controller.signal)
      if (controller.signal.aborted) return
      requestAnimationFrame(() => document.querySelector('.agency-pending-question')?.scrollIntoView({ block: 'start' }))
      if (!result.aiGenerated && !result.trace.some((call) => call.result.ok)) setQuestion(nextQuestion)
      // Results remain available through their explicit Show on map action.
      // A background answer must not move the staff member's current view.
    } catch (reason) { if (controller.signal.aborted) setQuestion(nextQuestion); else setError(reason instanceof Error ? reason.message : 'Question failed.') }
    finally { setBusy(false); abortRef.current = null }
  }

  async function runSkill(skill: AgencySkill, inputs: Record<string, unknown>) {
    if (busy || abortRef.current) return
    entryAbortRef.current?.abort()
    onLocate([], []); setTurns([]); setParentId(null); setBusy(true); setError(''); setActivities([]); setAsked(skill.name); setMode('ask'); setNotebookOpen(false); setAnswer(null)
    requestAnimationFrame(() => document.querySelector('.agency-pending-question')?.scrollIntoView({ block: 'start' }))
    const controller = new AbortController(); abortRef.current = controller
    try {
      const result = await apiProgressJson<QueryAnswer>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'run-skill', id: skill.id, inputs }), signal: controller.signal }, (progress) => setActivities((items) => items.some((item) => item.phase === progress.phase) ? items.map((item) => item.phase === progress.phase ? progress : item) : [...items, progress]))
      if (controller.signal.aborted) return
      await retainAnswer(result, controller.signal)
      if (controller.signal.aborted) return
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Research unavailable.') }
    finally { setBusy(false); abortRef.current = null }
  }

  function locate(routeIds: string[], stopIds: string[], saved?: { label: string; coordinate: [number, number] }) {
    const point = saved || state?.stopLocations?.[stopIds[0]]
    onLocate(routeIds, stopIds, point ? { ...point, id: stopIds[0] } : undefined)
  }

  function selectEvent(event: OperationalEvent, historical = true) {
    setSelectedEvent(event); setHistoricalEvent(historical)
    setMode('live')
    if (!historical) setEventFilter(event.type)
    requestAnimationFrame(() => document.querySelector('.agency-scroll')?.scrollTo({ top: 0 }))
    locate(event.routeIds ?? (event.routeId ? [event.routeId] : []), event.stopId ? [event.stopId] : event.stopIds ?? [], event.stopCoordinate ? { coordinate: event.stopCoordinate, label: event.stopName || 'Reference stop' } : undefined)
  }

  return <section className="agency-panel" aria-label="Network workspace">
    <header className="agency-header"><div><div className="agency-kicker"><span className="agency-wordmark">AGENCY</span><span>{state?.cityName || 'City operations'}</span></div><h1>{mode === 'live' ? 'Network' : mode === 'ask' ? 'Ask your network' : mode === 'operations' ? 'Service decisions' : 'Research skills'}</h1></div><div className="agency-header-actions"><button className="agency-icon-button" aria-label="Open saved work" disabled={busy} onClick={() => { setMode('ask'); setNotebookOpen(true); scrollRef.current?.scrollTo({ top: 0 }) }}><History size={16} /></button><button className="agency-icon-button agency-mobile-map-toggle" aria-label={mapOpen ? "Hide map" : "Show map"} aria-pressed={mapOpen} onClick={onToggleMap}><Map size={16} /></button><button className="agency-icon-button" title="Refresh observation" aria-label="Refresh observation" onClick={() => void refresh()}><RefreshCw size={16} /></button>{state ? <button className="agency-icon-button" title="Export observation" aria-label="Export observation" onClick={() => exportObservation(state)}><Download size={16} /></button> : null}</div></header>
    <div className="agency-tabs" role="tablist" aria-label="Network views">{modes.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={mode === id} aria-controls={`agency-${id}`} id={`agency-tab-${id}`} tabIndex={mode === id ? 0 : -1} onClick={() => { setMode(id); if (id === 'live') setSelectedEvent(null); requestAnimationFrame(() => { if (id === 'ask' && turns.length) document.querySelector('.agency-turn:last-of-type')?.scrollIntoView({ block: 'start' }); else scrollRef.current?.scrollTo({ top: 0 }) }) }} onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = modes.findIndex((item) => item.id === id); const next = event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length; setMode(modes[next].id); document.querySelector('.agency-scroll')?.scrollTo({ top: 0 }); document.getElementById(`agency-tab-${modes[next].id}`)?.focus() }}><Icon size={15} />{label}</button>)}<div className="agency-live-indicator"><AgencyFeedHealth feeds={state?.feeds ?? []} refreshFailed={Boolean(observationError)} /></div></div>
    <div className="agency-scroll" ref={scrollRef}>
      {error || observationError ? <div className="agency-error" role="alert">{error || observationError}{!state || !state.coverage.valid ? <button className="agency-text-button" onClick={onOpenData}>Open City data <ArrowRight size={13} /></button> : null}</div> : null}
      {loading && !state ? <div className="agency-empty"><Activity size={24} /><h2>Reading the City</h2><p>Checking the indexed timetable and service calendar.</p></div> : null}
      {state ? <>
        {hasSelection ? <NetworkSelection selection={selectionReady ? state.selection : undefined} loading={!selectionReady && !observationError} onClear={() => { setSelectedEvent(null); onClearSelection() }} onAsk={() => { setMode('ask'); requestAnimationFrame(() => document.getElementById('agency-question')?.focus()) }} asking={mode === 'ask'} /> : null}
        {!state.coverage.valid ? <div className="agency-notice"><strong>Timetable needs attention</strong><p>{state.coverage.message}</p><button className="agency-text-button" onClick={onOpenData}>Update City data <ArrowRight size={13} /></button></div> : null}
        {mode === 'live' ? <div id="agency-live" role="tabpanel" aria-labelledby="agency-tab-live">
          {selectedEvent ? <AgencyEvidence key={`${selectedEvent.id}/${selectedEvent.observedAt}`} historical={historicalEvent} event={selectedEvent} onUpdate={setSelectedEvent} state={state} projectId={projectId} onBack={() => { setSelectedEvent(null); if (historicalEvent) { setMode('ask'); requestAnimationFrame(() => document.querySelector('.agency-turn:last-of-type')?.scrollIntoView({ block: 'start' })) } }} onLocate={() => locate(selectedEvent.routeIds ?? (selectedEvent.routeId ? [selectedEvent.routeId] : []), selectedEvent.stopId ? [selectedEvent.stopId] : [], selectedEvent.stopCoordinate ? { coordinate: selectedEvent.stopCoordinate, label: selectedEvent.stopName || 'Reference stop' } : undefined)} /> : <>
            {!hasSelection ? <>
            <AgencyBriefing endpoint={endpoint} state={state} onOpen={(id) => void openEntry(id)} onConfigure={() => setMode('ask')} />
            <div className="agency-metrics">{[{ label: 'Fresh vehicles', value: state.counts.vehicles, note: 'Timestamp verified' }, { label: 'Aligned trips', value: state.counts.matchedTrips, note: `${state.counts.unresolvedTrips} unresolved` }, { label: 'Active alerts', value: state.counts.alerts, note: 'Published by agency' }, { label: 'Service events', value: state.eventCount ?? state.events.length, note: 'Evidence attached' }].map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{state.connected ? metric.value.toLocaleString() : '—'}</strong><small>{metric.note}</small></div>)}</div>
            <section className="agency-observation-strip"><div><Radio size={14} /><span>{state.connected ? `Received ${timeLabel(state.observedAt, state.coverage.timezone)}` : 'Connect a realtime source'}</span></div><button className="agency-text-button" onClick={() => setFeedsOpen((open) => !open)}>{state.connected ? 'Manage feeds' : 'Connect feeds'}<ChevronRight size={13} /></button></section>
            {state.feeds.length ? <div className="agency-feed-status">{state.feeds.map((feed, index) => <span key={`${feed.kind}:${feed.sourceUrl}:${index}`} title={`${feed.sourceUrl}\n${feed.error || feed.status}`} className={`is-${feed.status}`} data-freshness={feed.status}><i />{feed.kind === 'tripUpdates' ? 'Trip updates' : feed.kind === 'vehicles' ? 'Vehicles' : feed.kind === 'alerts' ? 'Alerts' : 'Feed'}<b>{feed.ageSeconds == null ? 'Unknown age' : `${Math.round(feed.ageSeconds)}s`}</b></span>)}</div> : null}
            {feedsOpen ? <div className="agency-connect"><button className="agency-icon-button agency-connect-close" aria-label="Close feed settings" onClick={() => setFeedsOpen(false)}><X size={15} /></button><RealtimePanel snapshot={snapshot} request={realtimeRequest} message={realtimeMessage} loading={realtimeLoading} onConnect={onConnect} onDisconnect={onDisconnect} /></div> : null}
            {!state.connected ? <div className="agency-welcome"><div className="agency-welcome-icon"><Layers3 size={24} /></div><div><h2>The timetable is ready.</h2><p>Connect your agency’s feeds to compare departure predictions with scheduled service. Every finding opens to its evidence.</p><p className="agency-caption">{state.coverage.firstDate} — {state.coverage.lastDate} · {state.coverage.timezone}</p></div></div> : null}
            </> : null}
            {!hasSelection ? <>
            <div className="agency-section-heading"><div><h2>Routes</h2><span>{state.counts.routes} routes in the timetable</span></div><label className="agency-search"><Search size={14} /><input aria-label="Find a route" placeholder="Find a route" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
            <div className="agency-route-table"><table><thead><tr><th>Route</th><th>Trip reports</th><th>Max delay</th><th>Longest gap</th><th>Alerts</th></tr></thead><tbody>{filteredRoutes.slice(0, showAllRoutes ? filteredRoutes.length : 7).map((route) => <tr key={route.id}><td><button onClick={() => { setSelectedEvent(null); locate([route.id], []) }} title={route.longName}><span className="agency-route-label" style={{ '--line-color': route.color } as React.CSSProperties}>{route.name}</span>{route.longName && route.longName !== route.name ? <span className="agency-route-description">{route.longName}</span> : null}</button></td><td>{state.connected ? route.reportingTrips : '—'}</td><td>{route.maxDelaySeconds == null ? '—' : minutes(Math.max(0, route.maxDelaySeconds))}</td><td><span className="agency-interval-state" title={route.widestInterval ? `At ${route.widestInterval.stopName}. Both consecutive trips report a departure prediction.` : 'No consecutive departure pair can be compared.'}>{route.widestInterval ? <><strong>{minutes(route.widestInterval.predictedSeconds)}</strong><small>{minutes(route.widestInterval.scheduledSeconds)} scheduled</small></> : 'No paired reports'}</span></td><td>{state.connected ? route.alerts : '—'}</td></tr>)}</tbody></table></div>
            {filteredRoutes.length > 7 ? <button className="agency-text-button agency-show-more" onClick={() => setShowAllRoutes((value) => !value)}>{showAllRoutes ? 'Show fewer routes' : `Browse ${filteredRoutes.length} routes`}<ChevronRight size={13} /></button> : null}
            </> : <>
              {focusedRoute && stopId ? <p className="agency-caption">Route {focusedRoute.name} · current reports across the route</p> : null}
              {focusedRoute ? <div className="agency-metrics">{[
                { label: 'Trip reports', value: state.connected ? focusedRoute.reportingTrips : '—', note: 'Matched to timetable' },
                { label: 'Max delay', value: focusedRoute.maxDelaySeconds == null ? '—' : minutes(Math.max(0, focusedRoute.maxDelaySeconds)), note: 'Reported departures' },
                { label: 'Longest gap', value: focusedRoute.widestInterval ? minutes(focusedRoute.widestInterval.predictedSeconds) : '—', note: focusedRoute.widestInterval ? `${minutes(focusedRoute.widestInterval.scheduledSeconds)} scheduled` : 'No paired predictions' },
                { label: 'Alerts', value: state.connected ? focusedRoute.alerts : '—', note: 'Published for this route' },
              ].map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.note}</small></div>)}</div> : null}
              {timetable && routeId ? <details className="network-timetable"><summary>Timetable & patterns</summary>{timetable}</details> : null}
            </>}
            <div className="agency-section-heading"><div><h2>Observed service events</h2><span>{events.length} in view</span></div><select aria-label="Filter event type" value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}><option value="all">All event types</option>{Object.entries(eventLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="agency-event-list">{events.slice(0, 40).map((event) => <button key={event.id} className={`agency-event is-${event.severity}`} data-severity={event.severity} onClick={() => selectEvent(event, false)}><span className="agency-event-mark"><Activity size={15} /></span><span><strong>{event.title}</strong><small>{event.routeId ? state.routes.find((route) => route.id === event.routeId)?.name || shortId(event.routeId) : 'Network'}{event.stopId ? ` · ${state.stopNames?.[event.stopId] || shortId(event.stopId)}` : ''}{event.evidence.delaySeconds != null ? ` · +${minutes(event.evidence.delaySeconds)}` : event.evidence.observedHeadwaySeconds != null ? ` · ${minutes(event.evidence.observedHeadwaySeconds)} predicted / ${minutes(event.evidence.scheduledHeadwaySeconds!)} scheduled` : ''}</small></span><ChevronRight size={15} /></button>)}</div>
            {!selectionReady ? <p className="agency-caption" role="status">Loading service for this selection…</p> : !events.length ? <div className="agency-quiet"><CircleHelp size={19} /><div><strong>{state.connected ? 'No events established in this view' : 'Waiting for observations'}</strong><p>{state.connected ? 'A lack of events is not proof of regular service. Check reporting coverage and source freshness.' : 'Live observations will appear here after the feeds connect.'}</p></div></div> : null}
            {events.length > 40 ? <p className="agency-caption">First 40 events shown. Use the route and event filters to narrow the view.</p> : null}
            {state.warnings.length ? <details className="agency-source-details"><summary>Coverage notes · {state.warnings.length}</summary>{state.warnings.map((warning) => <p className="agency-caption" key={warning}>{warning}</p>)}</details> : null}
            <p className="agency-method-note"><Clock3 size={13} /> Longest predicted gap at a stop within {state.policy.windowMinutes} minutes, compared with the same two trips in the timetable. Trip reports are not vehicle counts.</p>
          </>}
        </div> : mode === 'ask' ? <div id="agency-ask" role="tabpanel" aria-labelledby="agency-tab-ask">
          <p className="agency-intro">Investigate service with the timetable, current observations, and VIGO’s routing tools.</p>
          <AgencyProviderSettings endpoint={endpoint} provider={state.provider} onChange={() => void refresh()} />

          {notebookOpen ? <AgencyNotebook endpoint={endpoint} onOpen={(id) => void openEntry(id)} onBack={() => setNotebookOpen(false)} /> : <>
          <div className="agency-conversation-toolbar"><button className="agency-text-button" onClick={() => setNotebookOpen(true)} disabled={busy}><History size={14} /> Saved work</button><button className="agency-text-button" disabled={busy} onClick={() => { entryAbortRef.current?.abort(); setTurns([]); setParentId(null); setAnswer(null); setAsked(''); setActivities([]); sessionStorage.removeItem(`agency-entry-${projectId}`) }}><Plus size={14} /> New conversation</button></div>
          {!turns.length && !answer && !busy ? <div className="agency-suggestions">{(hasSelection ? ['What is happening here now?', 'Which alerts apply here?', 'Explain the timetable for this selection.'] : ['Which routes have the widest departure intervals?', 'Summarize network health and data freshness.', 'What service runs after 22:00 today?']).map((suggestion) => <button key={suggestion} onClick={() => { setQuestion(suggestion); document.getElementById('agency-question')?.focus() }}>{suggestion}<ArrowRight size={14} /></button>)}</div> : null}
          {turns.map((entry) => <article className="agency-turn" key={entry.id}><div className="agency-question-echo">{entry.title}</div><AgencyActivity activities={entry.activities} busy={false} trace={entry.answer.trace} /><AgencyAnswer answer={entry.answer} onResult={onResult} onSelectEvent={selectEvent} onOpenEntry={(id) => void openEntry(id)} /><>{entry.notes ? <p className="agency-saved-note"><strong>Note</strong>{entry.notes.length > 300 ? `${entry.notes.slice(0, 300)}…` : entry.notes}</p> : null}<AgencyNoteEditor endpoint={endpoint} entry={entry} onSave={(notes) => setTurns((items) => items.map((item) => item.id === entry.id ? { ...item, notes } : item))} /></></article>)}
          {busy || answer ? <div className="agency-question-echo agency-pending-question">{asked}</div> : null}
          <AgencyActivity activities={activities} busy={busy} trace={answer?.trace ?? []} />
          {answer ? <AgencyAnswer answer={answer} onResult={onResult} onSelectEvent={selectEvent} onOpenEntry={(id) => void openEntry(id)} /> : null}
          <form className="agency-question-form" onSubmit={(event) => { event.preventDefault(); void ask() }}><label htmlFor="agency-question">{parentId ? 'Continue the conversation' : 'Your question'}</label><textarea id="agency-question" placeholder="Which routes have the widest departure intervals right now?" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void ask() } }} /><footer><span>Timetable · Realtime · Places · Routing</span>{busy ? <button type="button" className="agency-button" onClick={stopInvestigation}><Square size={13} /> Stop</button> : <button className="agency-button is-primary" disabled={!question.trim()} type="submit"><Send size={14} /> Ask</button>}</footer></form>
          </>}
        </div> : mode === 'operations' ? <div id="agency-operations" role="tabpanel" aria-labelledby="agency-tab-operations"><AgencyOperations endpoint={endpoint} state={state} onEvidence={selectEvent} /></div> : <div id="agency-skills" role="tabpanel" aria-labelledby="agency-tab-skills"><AgencySkills skills={skills} state={state} endpoint={endpoint} busy={busy} onInstall={setSkills} onRun={(skill, input) => void runSkill(skill, input)} /></div>}
      </> : null}
    </div>
  </section>
}
