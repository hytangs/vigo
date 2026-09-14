import { Send, Square } from 'lucide-react'

export function AgencyComposer({ question, busy, onChange, onSubmit, onStop }: {
  question: string
  busy: boolean
  onChange: (question: string) => void
  onSubmit: () => void
  onStop: () => void
}) {
  return <form className="agency-question-form" onSubmit={event => { event.preventDefault(); onSubmit() }}>
    <label className="agency-visually-hidden" htmlFor="agency-question">Your question</label>
    <textarea id="agency-question" placeholder="Ask about service, departures or a rider update…" value={question} onChange={event => onChange(event.target.value)} maxLength={2000} rows={2} onKeyDown={event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onSubmit() }
    }} />
    <footer><span>⌘ / Ctrl + Enter</span>{busy ? <button type="button" className="agency-button" onClick={onStop}><Square size={13} /> Stop</button> : <button className="agency-button is-primary" disabled={!question.trim()} type="submit"><Send size={14} /> Ask</button>}</footer>
  </form>
}
