import { useEffect, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import { apiJson, apiProgressJson } from '../app/api'
import type { AgencyState, QueryAnswer } from '../agency/types'
import type { NotebookEntry } from './AgencyNotebook'

export function AgencyBriefing({ endpoint, state, onOpen, onConfigure }: { endpoint: string; state: AgencyState; onOpen: (id: number) => void; onConfigure: () => void }) {
  const [briefing, setBriefing] = useState<QueryAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  async function generate() {
    if (request.current) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('')
    try { setBriefing(await apiProgressJson<QueryAnswer>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'briefing' }), signal: controller.signal }, () => {})) }
    catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not write the briefing.') }
    finally { request.current = null; setBusy(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void apiJson<{ entry: NotebookEntry | null }>(endpoint, { method: 'POST', body: JSON.stringify({ action: 'briefing-latest' }), signal: controller.signal }).then(({ entry }) => { if (controller.signal.aborted) return; if (entry) setBriefing({ ...entry.answer, entryId: entry.id }); else if (state.connected && state.provider.available) void generate() }).catch(() => {})
    return () => { controller.abort(); request.current?.abort() }
  }, [endpoint, state.connected, state.provider.available])
  return <section className="agency-briefing" aria-label="Network briefing">
    <header>
      <span><Sparkles size={15} />Service briefing</span>
      {briefing ? <button className="agency-icon-button" aria-label="Update network briefing" disabled={busy} onClick={() => void generate()}><RefreshCw size={14} /></button> : null}
    </header>
    {busy ? <p className="agency-briefing-progress" role="status"><LoaderCircle size={16} className="agency-spinner" />Reading current service and writing the briefing…</p> : null}
    {briefing ? <>
      <p className="agency-briefing-text">{briefing.answer.replace(/\s\[\d+\]/g, '')}</p>
      {briefing.scopeNote ? <p className="agency-briefing-scope">{briefing.scopeNote}</p> : null}
      <footer>
        <span>{briefing.aiGenerated ? 'AI-assisted · ' : ''}As of {new Date(briefing.generatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: state.coverage.timezone || undefined })} · saved in notebook</span>
        <button className="agency-text-button" onClick={() => briefing.entryId && onOpen(briefing.entryId)}>Open evidence <ArrowRight size={13} /></button>
      </footer>
    </> : !busy ? <>
      <p>See where departures differ from schedule and which published disruptions need a closer look.</p>
      <button className="agency-text-button" onClick={state.provider.available ? () => void generate() : onConfigure}>{state.provider.available ? 'Write network briefing' : 'Connect AI for a briefing'}<ArrowRight size={13} /></button>
    </> : null}
    {error ? <p className="agency-error" role="alert">{error}</p> : null}
  </section>
}
