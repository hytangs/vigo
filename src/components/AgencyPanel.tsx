import { AgencyCoverageNotes } from './AgencyCoverageNotes'
import { downloadText } from '../agency/exports'
import { NetworkSelection } from './NetworkSelection'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { apiJson } from '../app/api'
import { startPolling } from '../app/polling'
import { realtimeRefreshMs } from '../app/realtime'
import type { RealtimeInspectRequest } from '../app/realtime'
import type { RealtimeSnapshot } from '../domain'
import type { AgencyState, OperationalEvent, WorkspaceSelectionInput } from '../agency/types'
import { AgencyEvidence } from './AgencyEvidence'
import { AgencyFeedHealth } from './AgencyFeedHealth'
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

export function AgencyPanel({ mapLayers, staticFeeds, onOperationalEvents, projectId, snapshot, realtimeRequest, realtimeMessage, realtimeLoading, onConnect, onDisconnect, onLocate, onOpenData, mapOpen, onToggleMap, selection = {}, timetable, onClearSelection, onBrowseRoute, browseRequest = 0, tripTarget, onOpenTrip }: {
  mapLayers?: ReactNode
  staticFeeds: Array<{ id: string; name: string }>
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
  onOpenData: () => void
}) {
  const [mode, setMode] = useState<AgencyMode>(() => { const saved = sessionStorage.getItem(`agency-mode-${projectId}`); return ['live', 'overview'].includes(saved || '') ? saved as AgencyMode : 'overview' })
  const [state, setState] = useState<AgencyState | null>(null)
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
  const [selectedEvent, setSelectedEvent] = useState<OperationalEvent | null>(null)
  const eventReturnMode = useRef<AgencyMode>('overview')
  const refreshGeneration = useRef(0)
  const observationPolling = useRef<ReturnType<typeof startPolling> | null>(null)
  const hasSnapshot = Boolean(snapshot)
  const scrollRef = useRef<HTMLDivElement>(null)
  const feedSettingsCloseRef = useRef<HTMLButtonElement>(null)
  const feedSettingsVisible = feedsOpen && Boolean(state)
  useEffect(() => {
    if (!feedSettingsVisible) return
    scrollRef.current?.scrollTo({ top: 0 })
    feedSettingsCloseRef.current?.focus()
  }, [feedSettingsVisible])
  const routeReturn = useRef<{ id: string; top: number } | null>(null)
  useEffect(() => { onOperationalEvents?.([]); return () => onOperationalEvents?.([]) }, [projectId, onOperationalEvents])
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/agency`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++refreshGeneration.current
    try { const next = await apiJson<AgencyState>(`${endpoint}?${new URLSearchParams({ routeId, stopId, eventType: eventFilter })}`, { signal }); if (generation === refreshGeneration.current && !signal?.aborted) { setState(next); onOperationalEvents?.(next.mapOperationalEvents || []); setLoadedSelection(selectionKey); setLoadedEventFilter(eventFilter); setObservationError('') } }
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
  useEffect(() => {
    if (!state?.connected || snapshot) return
    const controller = new AbortController()
    void apiJson<{ request: RealtimeInspectRequest | null }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'connection' }), signal: controller.signal }).then(({ request }) => { if (request && !controller.signal.aborted) onConnect(request) }).catch(() => {})
    return () => controller.abort()
  }, [state?.connected, snapshot, endpoint])
  useEffect(() => { sessionStorage.setItem(`agency-mode-${projectId}`, mode) }, [mode, projectId])
  function scrollToContent(selector: string) {
    const container = scrollRef.current
    const item = container?.querySelector<HTMLElement>(selector)
    if (container && item) container.scrollTo({ top: container.scrollTop + item.getBoundingClientRect().top - container.getBoundingClientRect().top })
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

  function locate(routeIds: string[], stopIds: string[], saved?: { label: string; coordinate: [number, number] }) {
    const point = saved || state?.stopLocations?.[stopIds[0]]
    onLocate(routeIds, stopIds, point ? { ...point, id: stopIds[0] } : undefined)
  }

  function selectEvent(event: OperationalEvent) {
    eventReturnMode.current = mode
    setSelectedEvent(event)
    setMode('live')
    setEventFilter(event.type)
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
    setMode(eventReturnMode.current); setRouteView('updates')
    requestAnimationFrame(() => {
      scrollToContent('.agency-service-events')
      const updates = scrollRef.current?.querySelector<HTMLDetailsElement>('.agency-service-events')
      if (updates) { updates.open = true; updates.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true }) }
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

  return <section className="agency-panel" aria-label="Network workspace" data-map-occluder="">
    <AgencyNavigation mode={mode} onChange={next => {
      setMode(next); setSelectedEvent(null); setFeedsOpen(false)
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }))
    }} health={<AgencyFeedHealth feeds={state?.feeds ?? []} refreshFailed={Boolean(observationError)} />} mapOpen={mapOpen} onToggleMap={onToggleMap} onRefresh={() => void observationPolling.current?.refresh()} onFeeds={openFeeds} onExport={state && eventsReady ? () => exportObservation(state) : undefined} onExportReport={state && eventsReady ? () => downloadText('agency-observation.md', observationReportMarkdown(state, { eventFilter, refreshFailed: Boolean(observationError) })) : undefined} />
    <div className="agency-scroll" ref={scrollRef}>
      {mapLayers}
      {observationError ? <div className="agency-error" role="alert"><strong>Could not refresh observations</strong><p>{observationError}</p>{hasSelection ? <button className="agency-text-button" onClick={onClearSelection}>Return to all routes <ArrowRight size={13} /></button> : null}{observationError ? <button className="agency-text-button" onClick={() => void observationPolling.current?.refresh()}>Retry refresh <ArrowRight size={13} /></button> : null}{!state || !state.coverage.valid ? <button className="agency-text-button" onClick={onOpenData}>Open City data <ArrowRight size={13} /></button> : null}</div> : null}
      {loading && !state ? <div className="agency-loading" role="status" aria-live="polite">
        <p><span className="signal-loader" aria-hidden="true" /><span>Reading the timetable and service calendar</span></p>
        <div className="agency-loading-metrics" aria-hidden="true">{[0, 1, 2].map(index => <span className="skeleton" key={index} />)}</div>
        <span className="skeleton agency-loading-bar" aria-hidden="true" />
        <div className="agency-loading-rows" aria-hidden="true">{[0, 1, 2, 3].map(index => <span key={index}><span className="skeleton" /><span className="skeleton" /></span>)}</div>
      </div> : null}
      {state ? <>
        {feedsOpen ? <div className="agency-connect"><button ref={feedSettingsCloseRef} className="agency-icon-button agency-connect-close" aria-label="Close feed settings" onClick={() => { setFeedsOpen(false); document.querySelector<HTMLElement>('.agency-more > summary')?.focus() }}><X size={15} /></button><RealtimePanel staticFeeds={staticFeeds} snapshot={snapshot} request={realtimeRequest} message={realtimeMessage} loading={realtimeLoading} onConnect={onConnect} onDisconnect={onDisconnect} /></div> : null}
        {hasSelection && mode === 'live' && !selectedEvent ? <NetworkSelection selection={selectionReady ? state.selection : undefined} route={selectionReady ? state.routes.find(route => route.id === state.selection?.route?.id) : undefined} loading={!selectionReady && !observationError} onClear={clearSelection} /> : null}
        {!state.coverage.valid ? <div className="agency-notice"><strong>Timetable needs attention</strong><p>{state.coverage.message}</p><button className="agency-text-button" onClick={onOpenData}>Update City data <ArrowRight size={13} /></button></div> : null}
        {mode === 'live' ? <div id="agency-live" role="tabpanel" aria-labelledby="agency-tab-live">
          <div hidden={Boolean(selectedEvent) || hasSelection}><AgencyRouteBrowser state={state} initialFilter={routeFilter} onFilterChange={setRouteFilter} refreshFailed={Boolean(observationError)} onSelect={id => openRoute(id, true)} /></div>
          {selectedEvent ? <AgencyEvidence key={`${selectedEvent.id}/${selectedEvent.observedAt}`} event={selectedEvent} onUpdate={setSelectedEvent} state={state} onBack={returnFromEvent} onLocate={() => locate(selectedEvent.routeIds ?? (selectedEvent.routeId ? [selectedEvent.routeId] : []), selectedEvent.stopId ? [selectedEvent.stopId] : [], selectedEvent.stopCoordinate ? { coordinate: selectedEvent.stopCoordinate, label: selectedEvent.stopName || 'Reference stop' } : undefined)} /> : hasSelection ? <>
            {stopId ? <StopArrivalBoard onOpenTrip={onOpenTrip} key={`${projectId}/${stopId}`} projectId={projectId} stopId={stopId} showHeading={!selectionReady} /> : null}
            {!stopId && routeId ? <>
              <div className="agency-route-sections" role="group" aria-label="Route details">{([['trips', 'Trip times'], ['stops', 'Stops'], ['updates', 'Updates']] as const).map(([id, label]) => <button key={id} aria-pressed={routeView === id} onClick={() => setRouteView(id)}>{label}</button>)}</div>
              {routeView === 'trips' ? <AgencyTripTimetable key={`${projectId}/${routeId}/${browseRequest}`} projectId={projectId} routeId={routeId} initialTripId={tripTarget?.routeId === routeId ? tripTarget.tripId : undefined} initialServiceDate={tripTarget?.routeId === routeId ? tripTarget.serviceDate : undefined} /> : null}
            </> : null}
            {selectionReady && timetable ? stopId ? <details className="studio-disclosure agency-secondary-section"><summary>Stop &amp; timetable details</summary><div className="network-timetable">{timetable}</div></details> : routeView === 'stops' ? <div className="network-timetable">{timetable}</div> : null : null}
            {stopId || routeView === 'updates' ? <AgencyServiceEvents key={selectionKey} state={state} ready={eventsReady} filter={eventFilter} onFilter={setEventFilter} onSelect={event => selectEvent(event)} /> : null}
            {focusedRoute && !stopId ? <AgencyRouteCoverage state={state} route={focusedRoute} refreshFailed={Boolean(observationError)} /> : null}
          </> : null}
        </div> : mode === 'overview' ? <div id="agency-overview" role="tabpanel" aria-labelledby="agency-tab-overview">
          <AgencyOverview state={state} refreshFailed={Boolean(observationError)} onBrowse={browseRoutes} onRoute={id => openRoute(id)} onFeeds={openFeeds} />
          {hasSelection ? <p className="agency-caption">Service updates for the selected route or stop. <button className="agency-text-button" onClick={onClearSelection}>Show all updates</button></p> : null}
          <AgencyServiceEvents defaultOpen={false} state={state} ready={eventsReady} filter={eventFilter} onFilter={setEventFilter} onSelect={event => selectEvent(event)} />
          {state.warnings.length ? <details className="agency-source-details"><summary>Coverage notes</summary><AgencyCoverageNotes warnings={state.warnings} /></details> : null}
        </div> : null}
      </> : null}
    </div>
  </section>
}
