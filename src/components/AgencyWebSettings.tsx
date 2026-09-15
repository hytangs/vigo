import { useEffect, useRef, useState } from 'react'
import { apiJson } from '../app/api'
import type { ProviderState } from '../agency/types'

export function AgencyWebSettings({ endpoint, state, onChange }: { endpoint: string; state: NonNullable<ProviderState['web']>; onChange: () => void }) {
  const [provider, setProvider] = useState(state.provider)
  const [baseUrl, setBaseUrl] = useState(state.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  async function save() {
    if (busy) return
    const controller = new AbortController(); abort.current = controller
    setBusy(true); setMessage('')
    try {
      await apiJson(endpoint, { method: 'POST', signal: controller.signal, body: JSON.stringify({ action: 'web-connect', connection: { provider, baseUrl, apiKey } }) })
      setApiKey(''); onChange(); setMessage(provider === 'off' ? 'Web search is off.' : provider === 'wikipedia' ? 'Wikipedia connected. General web search is not connected.' : 'Search connection verified.')
    } catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Search connection failed.') }
    finally { setBusy(false); abort.current = null }
  }
  return <details className="agency-web-settings"><summary>Web sources · {state.provider === 'duckduckgo' ? 'DuckDuckGo' : state.provider === 'wikipedia' ? 'Wikipedia only' : state.searchAvailable ? 'Search connected' : 'Search not connected'}</summary>
    <form className="agency-ai-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <p className="agency-caption">Search finds business addresses, news and official sources independently of your model. DuckDuckGo needs no key. Brave Search and SearXNG are alternatives for regular use.</p>
      <label>Web search<select value={provider} disabled={busy} onChange={event => { setProvider(event.target.value as typeof provider); setApiKey(''); setMessage('') }}><option value="duckduckgo">DuckDuckGo · no key needed</option><option value="brave">Brave Search</option><option value="searxng">SearXNG · private server</option><option value="wikipedia">Wikipedia only</option><option value="off">Off</option></select></label>
      {provider === 'searxng' ? <label>Search endpoint<input type="url" required value={baseUrl} placeholder="https://search.example.org/search" disabled={busy} onChange={event => setBaseUrl(event.target.value)} /></label> : null}
      {['brave', 'searxng'].includes(provider) ? <label>Search API key <span className="agency-caption">{state.hasKey && provider === state.provider && (provider !== 'searxng' || baseUrl === state.baseUrl) ? 'Leave blank to keep the current key' : provider === 'searxng' ? 'Optional for your server' : 'Separate from the model API key'}</span><input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} /></label> : null}
      <p className="agency-caption">Search sends the requested query to this provider. Reading a link contacts that website. Keys stay in server memory; the connection lasts for this app session.</p>
      {message ? <p className="agency-caption" role="status">{message}</p> : null}
      <button type="submit" className="agency-button" disabled={busy}>{busy ? 'Checking search…' : provider === 'off' ? 'Save search setting' : 'Connect search'}</button>
    </form>
  </details>
}
