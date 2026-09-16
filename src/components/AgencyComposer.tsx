import { Send, Square } from 'lucide-react'

export function AgencyComposer({ question, busy, providerAvailable = true, onChange, onSubmit, onStop }: {
  question: string
  busy: boolean
  providerAvailable?: boolean
  onChange: (question: string) => void
  onSubmit: () => void
  onStop: () => void
}) {
  return <form className="agency-question-form" onSubmit={event => { event.preventDefault(); onSubmit() }}>
    <label className="agency-visually-hidden" htmlFor="agency-question">Your question</label>
    <textarea id="agency-question" placeholder="Ask about service, departures or a rider update…" value={question} onChange={event => onChange(event.target.value)} maxLength={2000} rows={2} onKeyDown={event => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onSubmit() }
    }} />
    <footer><span>{question.length > 1800 ? `${question.length.toLocaleString()} / 2,000 characters` : providerAvailable ? '⌘ / Ctrl + Enter to ask' : 'A model connection is required'}</span>{busy ? <button type="button" className="agency-button" onClick={onStop}><Square size={13} /> Stop</button> : <button className="agency-button is-primary" disabled={providerAvailable && !question.trim()} type="submit"><Send size={14} />{providerAvailable ? 'Ask' : 'Connect AI'}</button>}</footer>
  </form>
}
