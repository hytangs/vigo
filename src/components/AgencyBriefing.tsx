import { useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle, RefreshCw, Radio } from 'lucide-react'
import { apiJson, apiProgressJson } from '../app/api'
import type { AgencyState, QueryAnswer } from '../agency/types'
import type { BriefingPreferences } from '../agency/networkAssessmentTypes'
import { briefingRefreshAt } from '../agency/briefingSchedule.mjs'
import type { NotebookEntry } from './AgencyNotebook'
import { NetworkAssessment } from './NetworkAssessment'

const defaults: BriefingPreferences = { intervalMinutes: 15, automatic: true }

export function AgencyBriefing({ endpoint, state, onOpen }: { endpoint: string; state: AgencyState; onOpen: (id: number) => void }) {
  const generateLabelId = useId()
  const [briefing, setBriefing] = useState<QueryAnswer | null>(null)
  const [preferences, setPreferences] = useState<BriefingPreferences>(defaults)
  const [ready, setReady] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [activity, setActivity] = useState('Assessing current service…')
  const [wallClock, setWallClock] = useState(Date.now)
  const request = useRef<AbortController | null>(null)
  const retryAfter = useRef(0)
  const latestEndpoint = useRef(endpoint); latestEndpoint.current = endpoint
  const now = Math.max(Date.parse(state.generatedAt), wallClock)
  const assessed = Date.parse(briefing?.generatedAt ?? '')
  const refreshAt = briefingRefreshAt(briefing, preferences)
  const due = briefing?.diagnosis?.version !== 2 || Boolean(briefing.aiGenerated && !briefing.synthesis?.method) || Boolean(state.scheduleIdentity && briefing.scheduleIdentity !== state.scheduleIdentity) || refreshAt === null || now >= refreshAt
  const sourceUnavailable = briefing?.diagnosis?.coverage.feeds.some(feed => feed.kind === 'tripUpdates' && feed.status === 'fresh'
    && !state.feeds.some(current => current.sourceUrl === feed.sourceUrl && current.status === 'fresh')) || !state.coverage.valid
  const current = briefing?.diagnosis && !due && !sourceUnavailable

  useEffect(() => {
    if (refreshAt === null) return
    const refreshClock = () => setWallClock(Date.now())
    const timer = window.setTimeout(refreshClock, Math.max(0, refreshAt - Date.now()) + 50)
    window.addEventListener('focus', refreshClock)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refreshClock) }
  }, [refreshAt])

  async function generate(force = false) {
    if (request.current) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setActivity('Assessing current service…')
    try {
      const answer = await apiProgressJson<QueryAnswer>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'briefing', force }), signal: controller.signal }, progress => setActivity(progress.detail), preliminary => { if (!controller.signal.aborted && latestEndpoint.current === endpoint) setBriefing(preliminary) })
      if (!controller.signal.aborted && latestEndpoint.current === endpoint) { setBriefing(answer); retryAfter.current = 0; if (answer.briefingPreferences) setPreferences(answer.briefingPreferences) }
    } catch (error) {
      if (!controller.signal.aborted && latestEndpoint.current === endpoint) { setError(error instanceof Error ? error.message : 'Could not prepare the assessment.'); retryAfter.current = now + preferences.intervalMinutes * 60000 }
    } finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  useEffect(() => {
    const controller = new AbortController()
    setReady(false); setBriefing(null); setError(''); retryAfter.current = 0
    void apiJson<{ entry: NotebookEntry | null; preferences: BriefingPreferences; current: boolean }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'briefing-latest' }), signal: controller.signal })
      .then(({ entry, preferences, current }) => {
        if (controller.signal.aborted) return
        setPreferences(preferences); setBriefing(entry ? { ...entry.answer, entryId: entry.id, ...(!current ? { diagnosis: undefined } : {}) } : null); setReady(true)
      }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => { controller.abort(); request.current?.abort() }
  }, [endpoint, loadAttempt])
  // The existing live state clock drives this check. Refresh only at the chosen
  // interval while visible; the server shares its cached assessment across tabs.
  useEffect(() => {
    if (ready && due && preferences.automatic && state.connected && !busy && now >= retryAfter.current) void generate()
  }, [ready, due, preferences.automatic, state.connected, busy, now])

  async function savePreferences(value: string) {
    const next = value === 'manual' ? { ...preferences, automatic: false } : { intervalMinutes: Number(value) as BriefingPreferences['intervalMinutes'], automatic: true }
    setSaving(true); setError('')
    try {
      const result = await apiJson<{ preferences: BriefingPreferences }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'briefing-settings', preferences: next }) })
      if (latestEndpoint.current === endpoint) setPreferences(result.preferences)
    } catch (error) { if (latestEndpoint.current === endpoint) setError(error instanceof Error ? error.message : 'Could not save the refresh interval.') }
    finally { setSaving(false) }
  }
  const time = (date: number) => new Date(date).toLocaleString([], { hour: 'numeric', minute: '2-digit', timeZone: state.coverage.timezone || undefined })
  return <section className="agency-briefing" aria-label="Network briefing">
    <header><span><Radio size={15} />Service briefing</span><div className="network-assessment-controls">
      <details className="agency-briefing-settings">
        <summary>Settings</summary>
        <label>Refresh
          <select aria-label="Briefing refresh interval" value={preferences.automatic ? String(preferences.intervalMinutes) : 'manual'} disabled={!ready || saving} onChange={event => void savePreferences(event.target.value)}>
            <option value="15">Every 15 min</option><option value="30">Every 30 min</option><option value="60">Every hour</option><option value="manual">Manual</option>
          </select>
        </label>
      </details>
      {current && briefing.narrative ? <button className="agency-icon-button" aria-label="Update network briefing" disabled={!ready || busy} onClick={() => void generate(true)}><RefreshCw size={14} /></button> : null}
    </div></header>
    {busy ? <p className="agency-briefing-progress" role="status"><LoaderCircle size={16} className="agency-spinner" />{activity}</p> : null}
    {current && briefing.narrative ? <>
      <p className="agency-briefing-scope">Assessment at {time(assessed)} · next {briefing.diagnosis!.window.minutes} minutes · {preferences.automatic ? `next update ${time(refreshAt!)}` : `manual update · expires ${time(refreshAt!)}`}</p>
      <NetworkAssessment narrative={briefing.narrative} diagnosis={briefing.diagnosis!} investigation={briefing.investigation} aiNarrative={briefing.aiGenerated} />
    </> : <>
      {briefing && !busy ? <p>{sourceUnavailable ? 'Service data is no longer current.' : 'Briefing expired.'}</p> : null}
      <button className="agency-button" aria-label="Update network briefing" aria-labelledby={generateLabelId} disabled={!ready || busy} onClick={() => void generate(true)}><span id={generateLabelId}>{briefing ? 'Update briefing' : 'Generate briefing'}</span> <RefreshCw size={14} /></button>
    </>}
    {briefing?.entryId ? <footer><span>{current ? briefing.aiGenerated ? `AI briefing · ${briefing.model || 'connected model'}` : 'Computed snapshot · AI briefing unavailable' : 'Previous assessment retained'}</span><button className="agency-text-button" onClick={() => onOpen(briefing.entryId!)}>Open evidence <ArrowRight size={13} /></button></footer> : null}
    {error ? <div className="agency-error" role="alert"><p>{error}</p>{!ready ? <button className="agency-text-button" onClick={() => setLoadAttempt(value => value + 1)}>Retry briefing <RefreshCw size={13} /></button> : null}</div> : null}
  </section>
}
