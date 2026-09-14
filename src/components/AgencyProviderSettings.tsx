import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, LoaderCircle, Settings2, Unplug } from 'lucide-react'
import { apiJson } from '../app/api'
import type { ProviderState } from '../agency/types'
import { AgencyWebSettings } from './AgencyWebSettings'

export function AgencyProviderSettings({ endpoint, provider, onChange }: { endpoint: string; provider: ProviderState; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || '')
  const [model, setModel] = useState(provider.model || '')
  const [reasoningEffort, setReasoningEffort] = useState(provider.reasoningEffort || '')
  const [protocol, setProtocol] = useState<'openai' | 'ollama'>(provider.protocol || 'openai')
  const [contextTokens, setContextTokens] = useState(provider.contextTokens || 8192)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  function show() { setProtocol(provider.protocol || 'openai'); setContextTokens(provider.contextTokens || 8192); setBaseUrl(provider.baseUrl || 'https://api.openai.com/v1'); setModel(provider.model || ''); setReasoningEffort(provider.reasoningEffort || ''); setApiKey(''); setModels([]); setError(''); setMessage(''); setOpen(true) }
  function preset(url: string, effort = '', protocol: 'openai' | 'ollama' = 'openai') { setProtocol(protocol); setContextTokens(8192); setReasoningEffort(effort); setBaseUrl(url); setModels([]); setModel(''); setApiKey(''); setError(''); setMessage('') }
  async function submit(action: 'models' | 'connect' | 'disconnect') {
    if (busy) return
    const controller = new AbortController(); abort.current = controller
    setBusy(action); setError(''); setMessage('')
    try {
      const result = await apiJson<ProviderState & { models?: string[] }>(endpoint, { method: 'POST', signal: controller.signal, body: JSON.stringify({ action: `provider-${action}`, connection: { baseUrl, model, apiKey, reasoningEffort, protocol, contextTokens } }) })
      if (action === 'models') { setModels(result.models || []); setMessage(result.models?.length ? `${result.models.length} ${result.models.length === 1 ? 'model' : 'models'} found. Choose one with function calling.` : 'No models were listed. You can enter a model name directly.') }
      else { setApiKey(''); onChange(); setMessage(action === 'connect' ? 'Connected. The model successfully called the test tool.' : 'Disconnected. The session key has been cleared.'); if (action === 'disconnect') { setModel(''); setBaseUrl(''); setModels([]) } }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Connection failed.') }
    finally { setBusy(''); abort.current = null }
  }

  return <section className={`agency-ai-connection ${open ? 'is-open' : ''}`} aria-label="AI connection">
    <div className="agency-provider-note"><button className="agency-provider-toggle" onClick={open ? () => { if (!busy) { setOpen(false); setApiKey('') } } : show} aria-expanded={open} aria-controls="agency-ai-settings" aria-label={open ? 'Close AI settings' : provider.available ? 'Edit AI connection' : 'Connect AI provider'}><Settings2 size={14} /><span>{provider.available ? provider.model : 'Connect AI'}</span><ChevronDown size={13} /></button></div>
    {open ? <form id="agency-ai-settings" className="agency-ai-form" onSubmit={(event) => { event.preventDefault(); void submit('connect') }}>
      <p className="agency-caption">{provider.available ? `${provider.testedAt ? 'Function calling verified' : 'Configured on server'} · ${provider.source === 'session' ? 'This app session' : 'Environment settings'}` : 'Use your AI provider or a model running on this computer.'}</p>
      <div className="agency-ai-presets" aria-label="Provider shortcuts"><button type="button" onClick={() => preset('https://api.openai.com/v1')} disabled={!!busy}>OpenAI</button><button type="button" onClick={() => preset('http://localhost:11434', '', 'ollama')} disabled={!!busy}>Ollama</button><button type="button" onClick={() => preset('http://localhost:1234/v1')} disabled={!!busy}>LM Studio</button><button type="button" onClick={() => preset('')} disabled={!!busy}>Custom</button></div>
      <label>Connection type<select value={protocol} disabled={!!busy} onChange={(event) => { setProtocol(event.target.value as 'openai' | 'ollama'); setReasoningEffort('') }}><option value="openai">OpenAI-compatible</option><option value="ollama">Ollama</option></select></label>
      {protocol === 'ollama' ? <label>Local context window<input type="number" min={2048} max={131072} step={1024} value={contextTokens} disabled={!!busy} onChange={(event) => setContextTokens(Number(event.target.value))} /><span className="agency-caption">More context retains longer investigations and uses more memory.</span></label> : null}
      <label>API base URL<input type="url" required placeholder="https://your-provider.example/v1" value={baseUrl} disabled={!!busy} onChange={(event) => { setBaseUrl(event.target.value); setModels([]); setMessage('') }} autoComplete="off" spellCheck={false} /></label>
      <label>API key <span className="agency-caption">{provider.hasKey && baseUrl === provider.baseUrl ? 'Saved for this session · leave blank to keep' : 'Optional for local models'}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider.hasKey && baseUrl === provider.baseUrl ? '••••••••' : 'Paste your key'} disabled={!!busy} autoComplete="off" spellCheck={false} /></label>
      <div className="agency-ai-model"><label>Model<input list="agency-model-options" required placeholder="Choose or enter a model" value={model} onChange={(event) => setModel(event.target.value)} disabled={!!busy} autoComplete="off" spellCheck={false} /><datalist id="agency-model-options">{models.map((id) => <option key={id} value={id}>{id}</option>)}</datalist></label><button type="button" className="agency-button" disabled={!!busy || !baseUrl.trim()} onClick={() => void submit('models')}>{busy === 'models' ? <LoaderCircle size={14} className="agency-spinner" /> : <ChevronDown size={14} />} Find models</button></div>
      <label>Reasoning effort<select value={reasoningEffort} disabled={!!busy} onChange={(event) => setReasoningEffort(event.target.value)}><option value="">Provider default</option><option value="none">Off (if supported)</option>{protocol === 'ollama' ? <option value="on">On</option> : null}<option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <p className="agency-caption">The key stays in server memory until the app closes. Questions and selected tool results are sent to this provider. Connecting sends a small function-calling test.</p>
      {error ? <p className="agency-error" role="alert">{error}</p> : null}
      {message ? <p className="agency-ai-result" role="status"><Check size={14} />{message}</p> : null}
      <footer>{provider.available ? <button type="button" className="agency-text-button" disabled={!!busy} onClick={() => void submit('disconnect')}><Unplug size={14} /> Disconnect</button> : <span className="agency-caption">OpenAI-compatible API</span>}<button type="submit" className="agency-button is-primary" disabled={!!busy || !baseUrl.trim() || !model.trim()}>{busy === 'connect' ? <><LoaderCircle className="agency-spinner" size={14} /> Testing connection…</> : <>Connect model<ArrowRight size={14} /></>}</button></footer>
    </form> : null}
    {open && provider.web ? <AgencyWebSettings endpoint={endpoint} state={provider.web} onChange={onChange} /> : null}
  </section>
}
