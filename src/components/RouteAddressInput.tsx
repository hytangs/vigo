import { MapPin, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { apiJson } from '../app/api'
import { useStore } from '../app/store'
import { city } from '../state/city'
import type { RoutingPoint } from '../routingModel'

type Address = { label: string; detail: string; coordinate: [number, number] }
type Suggestions = { results: Address[]; attribution: string }
const recentSearches = new Map<string, { at: number; value: Suggestions }>()
const searchKey = (projectId: string, query: string) => `${projectId}:${query.trim().toLowerCase()}`
function cachedSuggestions(key: string) {
  const saved = recentSearches.get(key)
  return saved && Date.now() - saved.at < 300_000 ? saved.value : undefined
}

/** Suggest places after a short typing pause; edits cancel obsolete lookups. */
export function RouteAddressInput({ point, label, disabled, onChoose, onPick, onRemove }: {
  point: RoutingPoint | null; label: string; disabled?: boolean
  onChoose: (point: RoutingPoint) => void; onPick: () => void; onRemove?: () => void
}) {
  const projectId = useStore(city, s => s.selectedProjectId)
  const id = useId()
  const [query, setQuery] = useState(point?.label ?? '')
  const [results, setResults] = useState<Address[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(-1)
  const [attribution, setAttribution] = useState('© OpenStreetMap contributors')
  const request = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composing = useRef(false)
  function cancel() {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    request.current?.abort(); request.current = null
  }
  function dismiss() {
    cancel(); setResults([]); setStatus(''); setBusy(false); setActive(-1)
  }
  function showSuggestions(value: Suggestions) {
    setResults(value.results); setAttribution(value.attribution); setActive(value.results.length ? 0 : -1); setBusy(false)
    setStatus(value.results.length ? '' : 'No matching places. Try a street, landmark, or pick on the map.')
  }
  useEffect(() => {
    dismiss(); setQuery(point?.label ?? '')
    return cancel
  }, [point, projectId, disabled])
  function edit(value: string) {
    dismiss(); setQuery(value)
    if (!composing.current && !disabled && value.trim().length >= 3 && value !== point?.label) {
      const saved = cachedSuggestions(searchKey(projectId, value))
      if (saved) { showSuggestions(saved); return }
      // Keep already-relevant suggestions on screen while refining the text.
      const tokens = value.toLowerCase().trim().split(/\s+/)
      const matching = results.filter(result => tokens.every((token, index) => `${result.label} ${result.detail}`.toLowerCase().split(/\W+/)
        .some(word => tokens.length > 1 && index === 0 && /^\d+[a-z]?$/.test(token) ? word === token : word.startsWith(token))))
      setResults(matching); setActive(matching.length ? 0 : -1)
      timer.current = setTimeout(() => void search(value), 150)
    }
  }
  async function search(value: string) {
    cancel()
    if (value.trim().length < 3 || disabled || composing.current || value === point?.label) return
    const key = searchKey(projectId, value), saved = cachedSuggestions(key)
    if (saved) { showSuggestions(saved); return }
    const controller = new AbortController(); request.current = controller
    setBusy(true); setStatus('Searching addresses…')
    try {
      const result = await apiJson<Suggestions>(`/api/projects/${encodeURIComponent(projectId)}/address-search`, {
        method: 'POST', body: JSON.stringify({ query: value.trim() }), signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (recentSearches.size >= 80) recentSearches.delete(recentSearches.keys().next().value!)
      recentSearches.set(key, { at: Date.now(), value: result })
      showSuggestions(result)
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Address search is unavailable. You can still pick on the map.')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  function choose(result: Address) {
    dismiss(); setQuery(result.label)
    onChoose({ coordinate: result.coordinate, label: result.label, source: 'map', named: true })
  }
  return <div className="route-address">
    <label htmlFor={id}>{label}</label>
    <div className="route-address-entry">
      <input id={id} value={query} placeholder="Address or place" disabled={disabled} autoComplete="off" enterKeyHint="search" maxLength={160}
        role="combobox" aria-autocomplete="list" aria-busy={busy} aria-expanded={results.length > 0} aria-controls={results.length ? `${id}-results` : undefined}
        aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined} aria-describedby={status ? `${id}-status` : undefined}
        onChange={event => edit(event.target.value)}
        onCompositionStart={() => { composing.current = true; dismiss() }}
        onCompositionEnd={event => { composing.current = false; edit(event.currentTarget.value) }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); if (active >= 0 && results[active]) choose(results[active]); else void search(query) }
          if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setActive((active + 1) % results.length) }
          if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setActive((active - 1 + results.length) % results.length) }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
        }} />
      {onRemove ? <button type="button" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => { dismiss(); onRemove() }}><X size={13} /></button> : null}
      <button type="button" disabled={disabled} aria-label={`Pick ${label.toLowerCase()} on map`} onClick={() => { dismiss(); onPick() }}><MapPin size={18} /></button>
    </div>
    {status ? <small id={`${id}-status`} role="status">{status}</small> : null}
    {results.length ? <ul id={`${id}-results`} role="listbox" aria-label={`${label} addresses`}>
      {results.map((result, index) => <li id={`${id}-${index}`} key={`${result.coordinate}:${index}`} role="option" aria-selected={index === active}>
        <button type="button" tabIndex={-1} onClick={() => choose(result)}><strong>{result.label}</strong><small>{result.detail}</small></button>
      </li>)}
      <li role="presentation" className="address-attribution">{attribution}</li>
    </ul> : null}
  </div>
}
