import { AgencyComposer } from './AgencyComposer'
import { NetworkSelection } from './NetworkSelection'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Activity, ArrowLeft, ArrowRight, ChevronRight, Radio, X, History, Plus } from 'lucide-react'
import { apiJson, apiProgressJson, type ApiProgress } from '../app/api'
import type { RealtimeInspectRequest } from '../app/realtime'
import type { RealtimeSnapshot } from '../domain'
import type { AgencySkill, AgencyState, OperationalEvent, QueryAnswer, ToolResult, WorkspaceSelectionInput } from '../agency/types'
import { AgencyEvidence, minutes, timeLabel } from './AgencyEvidence'
import { AgencyFeedHealth } from './AgencyFeedHealth'
import { AgencyProviderSettings } from './AgencyProviderSettings'
import { AgencyAnswer } from './AgencyAnswer'
import { AgencyActivity } from './AgencyActivity'
import { AgencyOperations } from './AgencyOperations'
import { AgencyBriefing } from './AgencyBriefing'
import { AgencySkills } from './AgencySkills'
import { AgencyNotebook, AgencyNoteEditor, type NotebookEntry } from './AgencyNotebook'
import { RealtimePanel } from './RealtimePanel'

import { AgencyNavigation, type AgencyMode } from './AgencyNavigation'
import { AgencyRouteBrowser } from './AgencyRouteBrowser'
import { AgencyServiceEvents } from './AgencyServiceEvents'
import { StopArrivalBoard } from './StopArrivalBoard'

function exportObservation(state: AgencyState) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'agency-observation.json'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AgencyPanel({ projectId, snapshot, realtimeRequest, realtimeMessage, realtimeLoading, onConnect, onDisconnect, onLocate, onResult, onOpenData, mapOpen, onToggleMap, selection = {}, timetable, onClearSelection, onBrowseRoute }: {
  selection?: WorkspaceSelectionInput
  timetable?: ReactNode
  onClearSelection: () => void
  onBrowseRoute: (id: string) => void
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
  const [mode, setMode] = useState<AgencyMode>(() => { const saved = sessionStorage.getItem(`agency-mode-${projectId}`); return ['live', 'briefing', 'ask', 'skills', 'operations'].includes(saved || '') ? saved as AgencyMode : 'live' })
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
  function scrollToContent(selector: string) {
    const container = scrollRef.current
    const item = container?.querySelector<HTMLElement>(selector)
    if (container && item) container.scrollTo({ top: container.scrollTop + item.getBoundingClientRect().top - container.getBoundingClientRect().top })
  }

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
      if (navigate) requestAnimationFrame(() => scrollToContent('.agency-turn:last-of-type'))
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
    requestAnimationFrame(() => scrollToContent('.agency-turn:last-of-type'))
  }
  const focusedRoute = selectionReady ? state?.routes.find(route => route.id === state.selection?.route?.id) : undefined
  useEffect(() => { setEventFilter('all'); scrollRef.current?.scrollTo({ top: 0 }) }, [selectionKey])
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
    requestAnimationFrame(() => scrollToContent('.agency-pending-question'))
    const controller = new AbortController(); abortRef.current = controller
    try {
      const result = await apiProgressJson<QueryAnswer>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'ask', question: nextQuestion, parentId, selection }), signal: controller.signal }, (progress) => setActivities((items) => items.some((item) => item.phase === progress.phase) ? items.map((item) => item.phase === progress.phase ? progress : item) : [...items, progress]))
      if (controller.signal.aborted) return
      await retainAnswer(result, controller.signal)
      if (controller.signal.aborted) return
      requestAnimationFrame(() => scrollToContent('.agency-pending-question'))
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
    requestAnimationFrame(() => scrollToContent('.agency-pending-question'))
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

  return <section className={`agency-panel ${state && mode === 'ask' && !notebookOpen ? 'has-composer' : ''}`} aria-label="Network workspace">
    <AgencyNavigation mode={mode} onChange={next => {
      setMode(next); setSelectedEvent(null)
      requestAnimationFrame(() => { if (next === 'ask' && turns.length) scrollToContent('.agency-turn:last-of-type'); else scrollRef.current?.scrollTo({ top: 0 }) })
    }} health={<AgencyFeedHealth feeds={state?.feeds ?? []} refreshFailed={Boolean(observationError)} />} mapOpen={mapOpen} onToggleMap={onToggleMap} onRefresh={() => void refresh()} onExport={state ? () => exportObservation(state) : undefined} />
    <div className="agency-scroll" ref={scrollRef}>
      {error || observationError ? <div className="agency-error" role="alert">{error || observationError}{!state || !state.coverage.valid ? <button className="agency-text-button" onClick={onOpenData}>Open City data <ArrowRight size={13} /></button> : null}</div> : null}
      {loading && !state ? <div className="agency-empty"><Activity size={24} /><h2>Reading the City</h2><p>Checking the indexed timetable and service calendar.</p></div> : null}
      {state ? <>
        {hasSelection && (mode === 'live' || mode === 'ask') ? <NetworkSelection selection={selectionReady ? state.selection : undefined} loading={!selectionReady && !observationError} onClear={() => { setSelectedEvent(null); onClearSelection() }} onAsk={() => { setMode('ask'); requestAnimationFrame(() => document.getElementById('agency-question')?.focus()) }} asking={mode === 'ask'} /> : null}
        {!state.coverage.valid ? <div className="agency-notice"><strong>Timetable needs attention</strong><p>{state.coverage.message}</p><button className="agency-text-button" onClick={onOpenData}>Update City data <ArrowRight size={13} /></button></div> : null}
        {mode === 'live' ? <div id="agency-live" role="tabpanel" aria-labelledby="agency-tab-live">
          <div hidden={Boolean(selectedEvent) || hasSelection}><AgencyRouteBrowser state={state} onSelect={id => { onBrowseRoute(id); scrollRef.current?.scrollTo({ top: 0 }) }} /></div>
          {selectedEvent ? <AgencyEvidence key={`${selectedEvent.id}/${selectedEvent.observedAt}`} historical={historicalEvent} event={selectedEvent} onUpdate={setSelectedEvent} state={state} projectId={projectId} onBack={() => { setSelectedEvent(null); if (historicalEvent) { setMode('ask'); requestAnimationFrame(() => scrollToContent('.agency-turn:last-of-type')) } }} onLocate={() => locate(selectedEvent.routeIds ?? (selectedEvent.routeId ? [selectedEvent.routeId] : []), selectedEvent.stopId ? [selectedEvent.stopId] : [], selectedEvent.stopCoordinate ? { coordinate: selectedEvent.stopCoordinate, label: selectedEvent.stopName || 'Reference stop' } : undefined)} /> : hasSelection ? <>
            {focusedRoute && !stopId ? <div className="agency-route-summary">
              <span>{state.connected ? `${focusedRoute.reportingTrips} trip reports` : 'Timetable only'}</span>
              {focusedRoute.maxDelaySeconds != null ? <span>Max delay {minutes(Math.max(0, focusedRoute.maxDelaySeconds))}</span> : null}
              {state.connected && focusedRoute.alerts ? <span>{focusedRoute.alerts} alerts</span> : null}
            </div> : null}
            {selectionReady && stopId ? <StopArrivalBoard projectId={projectId} stopId={stopId} showHeading={false} /> : null}
            {selectionReady && timetable ? <div className="network-timetable">{timetable}</div> : null}
            <AgencyServiceEvents state={state} ready={selectionReady} filter={eventFilter} onFilter={setEventFilter} onSelect={event => selectEvent(event, false)} />
          </> : null}
        </div> : mode === 'briefing' ? <div id="agency-briefing" role="tabpanel" aria-labelledby="agency-tab-briefing">
          <AgencyBriefing endpoint={endpoint} state={state} onOpen={id => void openEntry(id)} />
          <section className="agency-observation-strip"><div><Radio size={14} /><span>{state.connected ? `Received ${timeLabel(state.observedAt, state.coverage.timezone)}` : 'Timetable only'}</span></div><button className="agency-text-button" onClick={() => setFeedsOpen(open => !open)}>{state.connected ? 'Feed settings' : 'Connect feeds'}<ChevronRight size={13} /></button></section>
          {feedsOpen ? <div className="agency-connect"><button className="agency-icon-button agency-connect-close" aria-label="Close feed settings" onClick={() => setFeedsOpen(false)}><X size={15} /></button><RealtimePanel snapshot={snapshot} request={realtimeRequest} message={realtimeMessage} loading={realtimeLoading} onConnect={onConnect} onDisconnect={onDisconnect} /></div> : null}
          {hasSelection ? <p className="agency-caption">Service updates for the selected route or stop. <button className="agency-text-button" onClick={onClearSelection}>Show all updates</button></p> : null}
          <AgencyServiceEvents state={state} ready={selectionReady} filter={eventFilter} onFilter={setEventFilter} onSelect={event => selectEvent(event, false)} />
          {state.warnings.length ? <details className="agency-source-details"><summary>Coverage notes</summary>{state.warnings.map(warning => <p className="agency-caption" key={warning}>{warning}</p>)}</details> : null}
        </div> : mode === 'ask' ? <div id="agency-ask" role="tabpanel" aria-labelledby="agency-tab-ask">
          <AgencyProviderSettings endpoint={endpoint} provider={state.provider} onChange={() => void refresh()} />

          {notebookOpen ? <AgencyNotebook endpoint={endpoint} onOpen={(id) => void openEntry(id)} onBack={() => setNotebookOpen(false)} /> : <>
          <div className="agency-conversation-toolbar"><button className="agency-text-button" onClick={() => setNotebookOpen(true)} disabled={busy}><History size={14} /> History</button><button className="agency-text-button" disabled={busy} onClick={() => { entryAbortRef.current?.abort(); setTurns([]); setParentId(null); setAnswer(null); setAsked(''); setActivities([]); sessionStorage.removeItem(`agency-entry-${projectId}`) }}><Plus size={14} /> New chat</button></div>
          {!turns.length && !answer && !busy ? <div className="agency-suggestions">{(hasSelection ? ['How is service here?', 'Which alerts apply here?', 'When are the next departures?'] : ['How is service running?', 'Which routes need attention?', 'What service runs after 22:00 today?']).map((suggestion) => <button key={suggestion} onClick={() => { setQuestion(suggestion); document.getElementById('agency-question')?.focus() }}>{suggestion}<ArrowRight size={14} /></button>)}</div> : null}
          {turns.map((entry) => <article className="agency-turn" key={entry.id}><div className="agency-question-echo">{entry.title}</div><AgencyActivity activities={entry.activities} busy={false} trace={entry.answer.trace} /><AgencyAnswer answer={entry.answer} onResult={onResult} onSelectEvent={selectEvent} onOpenEntry={(id) => void openEntry(id)} /><>{entry.notes ? <p className="agency-saved-note"><strong>Note</strong>{entry.notes.length > 300 ? `${entry.notes.slice(0, 300)}…` : entry.notes}</p> : null}<AgencyNoteEditor endpoint={endpoint} entry={entry} onSave={(notes) => setTurns((items) => items.map((item) => item.id === entry.id ? { ...item, notes } : item))} /></></article>)}
          {busy || answer ? <div className="agency-question-echo agency-pending-question">{asked}</div> : null}
          <AgencyActivity activities={activities} busy={busy} trace={answer?.trace ?? []} />
          {answer ? <AgencyAnswer answer={answer} onResult={onResult} onSelectEvent={selectEvent} onOpenEntry={(id) => void openEntry(id)} /> : null}

          </>}
        </div> : mode === 'operations' ? <section id="agency-operations" aria-label="Service desk"><div className="agency-tool-heading"><button className="agency-text-button" onClick={() => setMode('live')}><ArrowLeft size={14} />Routes</button><h2>Service desk</h2></div><AgencyOperations endpoint={endpoint} state={state} onEvidence={selectEvent} /></section> : <section id="agency-skills" aria-label="Research"><div className="agency-tool-heading"><button className="agency-text-button" onClick={() => setMode('live')}><ArrowLeft size={14} />Routes</button><h2>Research</h2></div><AgencySkills skills={skills} state={state} endpoint={endpoint} busy={busy} onInstall={setSkills} onRun={(skill, input) => void runSkill(skill, input)} /></section>}
      </> : null}
    </div>
    {state && mode === 'ask' && !notebookOpen ? <div className="agency-composer-dock"><AgencyComposer question={question} busy={busy} onChange={setQuestion} onSubmit={() => void ask()} onStop={stopInvestigation} /></div> : null}
  </section>
}
