import { AgencyCoverageNotes } from './AgencyCoverageNotes'
import { AgencyComposer } from './AgencyComposer'
import { downloadText } from '../agency/exports'
import { NetworkSelection } from './NetworkSelection'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Activity, ArrowRight, X, History, Plus } from 'lucide-react'
import { apiJson, apiProgressJson, type ApiProgress } from '../app/api'
import { startPolling } from '../app/polling'
import { realtimeRefreshMs } from '../app/realtime'
import type { RealtimeInspectRequest } from '../app/realtime'
import type { RealtimeSnapshot } from '../domain'
import type { AgencyState, OperationalEvent, QueryAnswer, ToolResult, WorkspaceSelectionInput } from '../agency/types'
import { AgencyEvidence } from './AgencyEvidence'
import { AgencyFeedHealth } from './AgencyFeedHealth'
import { AgencyProviderSettings } from './AgencyProviderSettings'
import { AgencyAnswer } from './AgencyAnswer'
import { AgencyActivity } from './AgencyActivity'
import { AgencyBriefing } from './AgencyBriefing'
import { AgencyNotebook, AgencyNoteEditor, type NotebookEntry } from './AgencyNotebook'
import { RealtimePanel } from './RealtimePanel'

import { AgencyNavigation, type AgencyMode } from './AgencyNavigation'
import { AgencyRouteCoverage } from './AgencyRouteCoverage'
import { AgencyRouteBrowser } from './AgencyRouteBrowser'
import { AgencyServiceEvents } from './AgencyServiceEvents'
import { StopArrivalBoard, type TripNavigation } from './StopArrivalBoard'
import { AgencyTripTimetable } from './AgencyTripTimetable'
import { AgencyOverview } from './AgencyOverview'
import { observationReportMarkdown } from '../agency/observationExport'

function exportObservation(state: AgencyState) {
  downloadText('agency-observation.json', JSON.stringify(state, null, 2), 'application/json')
}

export function AgencyPanel({ onOperationalEvents, projectId, snapshot, realtimeRequest, realtimeMessage, realtimeLoading, onConnect, onDisconnect, onLocate, onResult, onOpenData, mapOpen, onToggleMap, selection = {}, timetable, onClearSelection, onBrowseRoute, browseRequest = 0, tripTarget, onOpenTrip }: {
  onOpenTrip?: TripNavigation
  tripTarget?: { routeId: string; tripId: string; serviceDate: string }
  browseRequest?: number
  selection?: WorkspaceSelectionInput
  timetable?: ReactNode
  onClearSelection: () => void
  onBrowseRoute: (id: string) => void
  mapOpen: boolean
  onToggleMap: () => void
  onOperationalEvents?: (events: OperationalEvent[]) => void
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
  const [mode, setMode] = useState<AgencyMode>(() => { const saved = sessionStorage.getItem(`agency-mode-${projectId}`); return ['live', 'briefing', 'ask'].includes(saved || '') ? saved as AgencyMode : 'briefing' })
  const [state, setState] = useState<AgencyState | null>(null)
  const [error, setError] = useState('')
  const [errorMode, setErrorMode] = useState<AgencyMode>('ask')
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
  const [loadedEventFilter, setLoadedEventFilter] = useState('')
  const eventsReady = selectionReady && loadedEventFilter === eventFilter
  const [routeView, setRouteView] = useState<'trips' | 'stops' | 'updates'>('trips')
  useEffect(() => { setRouteView('trips') }, [routeId])
  const [routeFilter, setRouteFilter] = useState<'all' | 'attention' | 'reporting'>('all')
  const [historicalEvent, setHistoricalEvent] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<OperationalEvent | null>(null)
  const eventReturnMode = useRef<AgencyMode>('briefing')
  const [question, setQuestion] = useState(() => sessionStorage.getItem(`agency-question-${projectId}`) || '')
  const [activities, setActivities] = useState<ApiProgress[]>([])
  const [asked, setAsked] = useState('')
  const [answer, setAnswer] = useState<QueryAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const [notebookOpen, setNotebookOpen] = useState(false)
  const [turns, setTurns] = useState<NotebookEntry[]>([])
  const [parentId, setParentId] = useState<number | null>(null)
  const refreshGeneration = useRef(0)
  const observationPolling = useRef<ReturnType<typeof startPolling> | null>(null)
  const hasSnapshot = Boolean(snapshot)
  const scrollRef = useRef<HTMLDivElement>(null)
  const routeReturn = useRef<{ id: string; top: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const entryAbortRef = useRef<AbortController | null>(null)
  useEffect(() => { onOperationalEvents?.([]); return () => onOperationalEvents?.([]) }, [projectId, onOperationalEvents])
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/agency`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++refreshGeneration.current
    try { const next = await apiJson<AgencyState>(`${endpoint}?${new URLSearchParams({ routeId, stopId, eventType: eventFilter })}`, { signal }); if (generation === refreshGeneration.current && !signal?.aborted) { setState(next); onOperationalEvents?.(next.mapOperationalEvents || next.mapGapEvents || []); setLoadedSelection(selectionKey); setLoadedEventFilter(eventFilter); setObservationError('') } }
    catch (reason) { if (generation === refreshGeneration.current && !signal?.aborted) { onOperationalEvents?.([]); setObservationError(reason instanceof Error ? reason.message : 'Observation unavailable.') } }
    finally { if (generation === refreshGeneration.current && !signal?.aborted) setLoading(false) }
  }, [endpoint, routeId, stopId, selectionKey, eventFilter, onOperationalEvents])
  useEffect(() => {
    // The server owns feed ingestion. Read its state on one cadence; a map
    // snapshot update must not launch another assessment or cancel this one.
    const polling = startPolling(refresh, realtimeRefreshMs)
    observationPolling.current = polling
    return () => { polling.stop(); observationPolling.current = null }
  }, [refresh, hasSnapshot])
  useEffect(() => () => { abortRef.current?.abort(); entryAbortRef.current?.abort() }, [endpoint])
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
    } catch (error) { if (!controller.signal.aborted) { setErrorMode(mode); setError(error instanceof Error ? error.message : 'Could not open this conversation.') } }
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
  const handledBrowseRequest = useRef(browseRequest)
  // Locating evidence on the map must preserve the reader's place. Explicit
  // browse actions reset scroll in their own handlers.
  useEffect(() => { setEventFilter('all') }, [selectionKey])
  useEffect(() => {
    if (browseRequest === handledBrowseRequest.current) return
    handledBrowseRequest.current = browseRequest
    setMode('live'); setSelectedEvent(null); setRouteView('trips')
    scrollRef.current?.scrollTo({ top: 0 })
  }, [browseRequest])
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
    setActivities((items) => [...items, { phase: 'stopped', progress: 1, detail: 'Stopped. Completed checks are in History.' }])
  }

  async function ask(nextQuestion = question) {
    if (busy || abortRef.current) return
    if (!state?.provider.available) {
      document.querySelector<HTMLButtonElement>('.agency-ai-connection button[aria-expanded="false"]')?.click()
      requestAnimationFrame(() => { scrollToContent('.agency-ai-form'); document.querySelector<HTMLInputElement>('.agency-ai-form input[type="url"]')?.focus() })
      return
    }
    if (!nextQuestion.trim()) return
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
    } catch (reason) {
      setQuestion(current => current.trim() ? current : nextQuestion)
      if (!controller.signal.aborted) { setErrorMode('ask'); setError(reason instanceof Error ? reason.message : 'Question failed. Your question is ready to retry.') }
    }
    finally { setBusy(false); abortRef.current = null }
  }

  function locate(routeIds: string[], stopIds: string[], saved?: { label: string; coordinate: [number, number] }) {
    const point = saved || state?.stopLocations?.[stopIds[0]]
    onLocate(routeIds, stopIds, point ? { ...point, id: stopIds[0] } : undefined)
  }

  function selectEvent(event: OperationalEvent, historical = true) {
    eventReturnMode.current = mode
    setSelectedEvent(event); setHistoricalEvent(historical)
    setMode('live')
    if (!historical) setEventFilter(event.type)
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0 })
      scrollRef.current?.querySelector<HTMLButtonElement>('.agency-evidence > button')?.focus({ preventScroll: true })
    })
    locate(event.routeIds ?? (event.routeId ? [event.routeId] : []), event.stopId ? [event.stopId] : event.stopIds ?? [], event.stopCoordinate ? { coordinate: event.stopCoordinate, label: event.stopName || 'Reference stop' } : undefined)
  }

  function browseRoutes(filter: 'all' | 'attention' | 'reporting') {
    routeReturn.current = null
    setRouteFilter(filter); setMode('live'); setSelectedEvent(null); onClearSelection()
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0 })
      scrollRef.current?.querySelector<HTMLInputElement>('.agency-route-search input')?.focus({ preventScroll: true })
    })
  }

  function returnFromEvent() {
    setSelectedEvent(null)
    setMode(historicalEvent ? 'ask' : eventReturnMode.current); setRouteView('updates')
    requestAnimationFrame(() => {
      scrollToContent(historicalEvent ? '.agency-turn:last-of-type' : '.agency-service-events')
      if (!historicalEvent) { const updates = scrollRef.current?.querySelector<HTMLDetailsElement>('.agency-service-events'); if (updates) { updates.open = true; updates.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true }) } }
    })
  }

  function openRoute(id: string, rememberList = false) {
    routeReturn.current = rememberList ? { id, top: scrollRef.current?.scrollTop ?? 0 } : null
    setMode('live'); setSelectedEvent(null); onBrowseRoute(id)
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0 })
      scrollRef.current?.querySelector<HTMLButtonElement>('.network-selection > button')?.focus({ preventScroll: true })
    })
  }

  function openFeeds() {
    setFeedsOpen(true)
    requestAnimationFrame(() => { scrollRef.current?.scrollTo({ top: 0 }); document.querySelector<HTMLButtonElement>('.agency-connect-close')?.focus() })
  }

  function clearSelection() {
    setSelectedEvent(null); onClearSelection()
    if (mode !== 'live') return
    requestAnimationFrame(() => {
      const previous = routeReturn.current
      scrollRef.current?.scrollTo({ top: previous?.top ?? 0 })
      const row = previous ? Array.from(scrollRef.current?.querySelectorAll<HTMLButtonElement>('[data-route-id]') ?? []).find(button => button.dataset.routeId === previous.id) : undefined
      const target = row ?? scrollRef.current?.querySelector<HTMLInputElement>('.agency-route-search input')
      target?.focus({ preventScroll: true })
    })
  }

  return <section className={`agency-panel ${state && mode === 'ask' && !notebookOpen ? 'has-composer' : ''}`} aria-label="Network workspace">
    <AgencyNavigation mode={mode} onChange={next => {
      setMode(next); setSelectedEvent(null); setFeedsOpen(false)
      requestAnimationFrame(() => { if (next === 'ask' && turns.length) scrollToContent('.agency-turn:last-of-type'); else scrollRef.current?.scrollTo({ top: 0 }) })
    }} health={<AgencyFeedHealth feeds={state?.feeds ?? []} refreshFailed={Boolean(observationError)} />} mapOpen={mapOpen} onToggleMap={onToggleMap} onRefresh={() => void observationPolling.current?.refresh()} onFeeds={openFeeds} onExport={state && eventsReady ? () => exportObservation(state) : undefined} onExportReport={state && eventsReady ? () => downloadText('agency-observation.md', observationReportMarkdown(state, { eventFilter, refreshFailed: Boolean(observationError) })) : undefined} />
    <div className="agency-scroll" ref={scrollRef}>
      {(mode === errorMode && error) || observationError ? <div className="agency-error" role="alert"><strong>{observationError ? 'Could not refresh observations' : 'Could not complete the request'}</strong><p>{observationError || error}</p>{observationError ? <button className="agency-text-button" onClick={() => void observationPolling.current?.refresh()}>Retry refresh <ArrowRight size={13} /></button> : null}{!state || !state.coverage.valid ? <button className="agency-text-button" onClick={onOpenData}>Open City data <ArrowRight size={13} /></button> : null}</div> : null}
      {loading && !state ? <div className="agency-empty"><Activity size={24} /><h2>Reading the City</h2><p>Checking the indexed timetable and service calendar.</p></div> : null}
      {state ? <>
        {feedsOpen ? <div className="agency-connect"><button className="agency-icon-button agency-connect-close" aria-label="Close feed settings" onClick={() => { setFeedsOpen(false); document.querySelector<HTMLElement>('.agency-more > summary')?.focus() }}><X size={15} /></button><RealtimePanel snapshot={snapshot} request={realtimeRequest} message={realtimeMessage} loading={realtimeLoading} onConnect={onConnect} onDisconnect={onDisconnect} /></div> : null}
        {hasSelection && mode === 'live' && !selectedEvent ? <NetworkSelection selection={selectionReady ? state.selection : undefined} loading={!selectionReady && !observationError} onClear={clearSelection} onAsk={() => { setMode('ask'); requestAnimationFrame(() => document.getElementById('agency-question')?.focus()) }} asking={false} /> : null}
        {!state.coverage.valid ? <div className="agency-notice"><strong>Timetable needs attention</strong><p>{state.coverage.message}</p><button className="agency-text-button" onClick={onOpenData}>Update City data <ArrowRight size={13} /></button></div> : null}
        {mode === 'live' ? <div id="agency-live" role="tabpanel" aria-labelledby="agency-tab-live">
          <div hidden={Boolean(selectedEvent) || hasSelection}><AgencyRouteBrowser state={state} initialFilter={routeFilter} onFilterChange={setRouteFilter} refreshFailed={Boolean(observationError)} onSelect={id => openRoute(id, true)} /></div>
          {selectedEvent ? <AgencyEvidence key={`${selectedEvent.id}/${selectedEvent.observedAt}`} historical={historicalEvent} event={selectedEvent} onUpdate={setSelectedEvent} state={state} projectId={projectId} onBack={returnFromEvent} onLocate={() => locate(selectedEvent.routeIds ?? (selectedEvent.routeId ? [selectedEvent.routeId] : []), selectedEvent.stopId ? [selectedEvent.stopId] : [], selectedEvent.stopCoordinate ? { coordinate: selectedEvent.stopCoordinate, label: selectedEvent.stopName || 'Reference stop' } : undefined)} /> : hasSelection ? <>
            {stopId ? <StopArrivalBoard onOpenTrip={onOpenTrip} key={`${projectId}/${stopId}`} projectId={projectId} stopId={stopId} showHeading={!selectionReady} /> : null}
            {!stopId && routeId ? <>
              <div className="agency-route-sections" role="group" aria-label="Route details">{([['trips', 'Trip times'], ['stops', 'Stops'], ['updates', 'Updates']] as const).map(([id, label]) => <button key={id} aria-pressed={routeView === id} onClick={() => setRouteView(id)}>{label}</button>)}</div>
              {routeView === 'trips' ? <AgencyTripTimetable key={`${projectId}/${routeId}/${browseRequest}`} projectId={projectId} routeId={routeId} initialTripId={tripTarget?.routeId === routeId ? tripTarget.tripId : undefined} initialServiceDate={tripTarget?.routeId === routeId ? tripTarget.serviceDate : undefined} /> : null}
            </> : null}
            {selectionReady && timetable ? stopId ? <details className="agency-secondary-section"><summary>Stop &amp; timetable details</summary><div className="network-timetable">{timetable}</div></details> : routeView === 'stops' ? <div className="network-timetable">{timetable}</div> : null : null}
            {stopId || routeView === 'updates' ? <AgencyServiceEvents key={selectionKey} state={state} ready={eventsReady} filter={eventFilter} onFilter={setEventFilter} onSelect={event => selectEvent(event, false)} /> : null}
            {focusedRoute && !stopId ? <AgencyRouteCoverage state={state} route={focusedRoute} refreshFailed={Boolean(observationError)} /> : null}
          </> : null}
        </div> : mode === 'briefing' ? <div id="agency-briefing" role="tabpanel" aria-labelledby="agency-tab-briefing">
          <AgencyOverview state={state} refreshFailed={Boolean(observationError)} onBrowse={browseRoutes} onRoute={id => openRoute(id)} onFeeds={openFeeds} />
          <details className="agency-secondary-section"><summary>Service briefing</summary><AgencyBriefing onLocateStop={stopId => locate([], [stopId])} endpoint={endpoint} state={state} onOpen={id => void openEntry(id)} /></details>
          {hasSelection ? <p className="agency-caption">Service updates for the selected route or stop. <button className="agency-text-button" onClick={onClearSelection}>Show all updates</button></p> : null}
          <AgencyServiceEvents defaultOpen={false} state={state} ready={eventsReady} filter={eventFilter} onFilter={setEventFilter} onSelect={event => selectEvent(event, false)} />
          {state.warnings.length ? <details className="agency-source-details"><summary>Coverage notes</summary><AgencyCoverageNotes warnings={state.warnings} /></details> : null}
        </div> : mode === 'ask' ? <div id="agency-ask" role="tabpanel" aria-labelledby="agency-tab-ask">
          {notebookOpen ? <AgencyNotebook endpoint={endpoint} onOpen={(id) => void openEntry(id)} onBack={() => setNotebookOpen(false)} /> : <>
          <header className="agency-page-heading"><h1>Ask</h1>{!turns.length && !answer && !busy ? <p>Ask about routes, journeys, or service changes.</p> : null}</header>
          <AgencyProviderSettings endpoint={endpoint} provider={state.provider} onChange={() => void observationPolling.current?.refresh()} actions={
            <div className="agency-conversation-toolbar"><button className="agency-text-button" onClick={() => setNotebookOpen(true)} disabled={busy}><History size={14} /> History</button><button className="agency-text-button" disabled={busy} onClick={() => { entryAbortRef.current?.abort(); setTurns([]); setParentId(null); setAnswer(null); setAsked(''); setActivities([]); sessionStorage.removeItem(`agency-entry-${projectId}`) }}><Plus size={14} /> New chat</button></div>
          } />
          {hasSelection ? <NetworkSelection selection={selectionReady ? state.selection : undefined} loading={!selectionReady && !observationError} onClear={clearSelection} onAsk={() => {}} asking /> : null}
          {!turns.length && !answer && !busy ? <div className="agency-ask-start">{!state.provider.available ? <div className="agency-ask-setup"><strong>Connect AI to ask a question.</strong><p>Routes and live evidence are ready to explore.</p><button className="agency-text-button" onClick={() => { setMode('briefing'); scrollRef.current?.scrollTo({ top: 0 }) }}>Explore the network <ArrowRight size={13} /></button></div> : null}<div className="agency-suggestions" aria-label="Suggested investigations">{(hasSelection ? ['Summarize service here.', 'Which alerts apply here?', stopId ? 'When are the next departures?' : 'Draft a rider update for this route.'] : ['Which routes need attention now?', 'Summarize current service alerts.', 'What service runs after 22:00 today?']).map(suggestion => <button key={suggestion} onClick={() => { setQuestion(suggestion); document.getElementById('agency-question')?.focus() }}><span>{suggestion}</span><ArrowRight size={15} /></button>)}</div></div> : null}
          {turns.map((entry) => <article className="agency-turn" key={entry.id}><div className="agency-question-echo">{entry.title}</div><AgencyAnswer answer={entry.answer} onResult={onResult} onSelectEvent={selectEvent} onOpenEntry={(id) => void openEntry(id)} /><AgencyActivity activities={entry.activities} busy={false} trace={entry.answer.trace} /><>{entry.notes ? <p className="agency-saved-note"><strong>Note</strong>{entry.notes.length > 300 ? `${entry.notes.slice(0, 300)}…` : entry.notes}</p> : null}<AgencyNoteEditor endpoint={endpoint} entry={entry} onSave={(notes) => setTurns((items) => items.map((item) => item.id === entry.id ? { ...item, notes } : item))} /></></article>)}
          {busy || answer ? <div className="agency-question-echo agency-pending-question">{asked}</div> : null}
          <AgencyActivity activities={activities} busy={busy} trace={answer?.trace ?? []} />
          {answer ? <AgencyAnswer answer={answer} onResult={onResult} onSelectEvent={selectEvent} onOpenEntry={(id) => void openEntry(id)} /> : null}

          </>}
        </div> : null}
      </> : null}
    </div>
    {state && mode === 'ask' && !notebookOpen ? <div className="agency-composer-dock"><AgencyComposer question={question} busy={busy} providerAvailable={state.provider.available} onChange={setQuestion} onSubmit={() => void ask()} onStop={stopInvestigation} /></div> : null}
  </section>
}
