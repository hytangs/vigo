import { useEffect, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle, RefreshCw, Radio } from 'lucide-react'
import { apiJson, apiProgressJson } from '../app/api'
import type { AgencyState, QueryAnswer } from '../agency/types'
import type { BriefingPreferences } from '../agency/networkAssessmentTypes'
import type { NotebookEntry } from './AgencyNotebook'
import { NetworkAssessment } from './NetworkAssessment'

const defaults: BriefingPreferences = { intervalMinutes: 15, automatic: true }

export function AgencyBriefing({ endpoint, state, onOpen }: { endpoint: string; state: AgencyState; onOpen: (id: number) => void }) {
  const [briefing, setBriefing] = useState<QueryAnswer | null>(null)
  const [preferences, setPreferences] = useState<BriefingPreferences>(defaults)
  const [ready, setReady] = useState(false)
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
  const due = !briefing?.diagnosis || Boolean(state.scheduleIdentity && briefing.scheduleIdentity !== state.scheduleIdentity) || now >= assessed + preferences.intervalMinutes * 60000
  const sourceUnavailable = briefing?.diagnosis?.coverage.feeds.some(feed => feed.kind === 'tripUpdates' && feed.status === 'fresh'
    && !state.feeds.some(current => current.sourceUrl === feed.sourceUrl && current.status === 'fresh')) || !state.coverage.valid
  const current = briefing?.diagnosis && !due && !sourceUnavailable

  useEffect(() => {
    if (!Number.isFinite(assessed)) return
    const refreshClock = () => setWallClock(Date.now())
    const timer = window.setTimeout(refreshClock, Math.max(0, assessed + preferences.intervalMinutes * 60000 - Date.now()) + 50)
    window.addEventListener('focus', refreshClock)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refreshClock) }
  }, [assessed, preferences.intervalMinutes])

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
  }, [endpoint])
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
    <header><span><Radio size={15} />Network service briefing</span><div className="network-assessment-controls">
      <select aria-label="Briefing refresh interval" value={preferences.automatic ? String(preferences.intervalMinutes) : 'manual'} disabled={!ready || saving} onChange={event => void savePreferences(event.target.value)}>
        <option value="15">Every 15 min</option><option value="30">Every 30 min</option><option value="60">Every hour</option><option value="manual">Manual</option>
      </select>
      <button className="agency-icon-button" aria-label="Update network briefing" disabled={busy} onClick={() => void generate(true)}><RefreshCw size={14} /></button>
    </div></header>
    {busy ? <p className="agency-briefing-progress" role="status"><LoaderCircle size={16} className="agency-spinner" />{activity}</p> : null}
    {current && briefing.narrative ? <>
      <p className="agency-briefing-scope">Assessment at {time(assessed)} · next {briefing.diagnosis!.window.minutes} minutes · {preferences.automatic ? `next update ${time(assessed + preferences.intervalMinutes * 60000)}` : `manual update · expires ${time(assessed + preferences.intervalMinutes * 60000)}`}</p>
      <NetworkAssessment narrative={briefing.narrative} diagnosis={briefing.diagnosis!} investigation={briefing.investigation} />
    </> : !busy ? <p>{briefing ? sourceUnavailable ? 'Live predictions are no longer current. The previous briefing is saved in the notebook.' : 'The previous briefing has expired. Update it for a current assessment.' : 'Assess network conditions from the timetable and currently reporting service.'}</p> : null}
    {briefing?.entryId ? <footer><span>{current ? briefing.aiGenerated ? 'AI assessment · evidence checked' : 'Computed from the shared service observation' : 'Previous assessment retained'}</span><button className="agency-text-button" onClick={() => onOpen(briefing.entryId!)}>Open evidence <ArrowRight size={13} /></button></footer> : null}
    {error ? <p className="agency-error" role="alert">{error}</p> : null}
  </section>
}
