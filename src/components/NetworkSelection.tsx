import { ArrowLeft, MessageSquare, X } from 'lucide-react'
import type { WorkspaceSelection } from '../agency/types'

export function NetworkSelection({ selection, loading, asking, onClear, onAsk }: {
  selection?: WorkspaceSelection
  loading: boolean
  asking: boolean
  onClear: () => void
  onAsk: () => void
}) {
  const title = loading ? 'Opening selection…' : selection?.stop?.name || selection?.route?.name || 'Selection unavailable'
  return <section className={`network-selection ${asking ? 'is-asking' : ''}`} aria-label="Selected network context">
    <button className="agency-text-button" onClick={onClear}>{asking ? <X size={14} /> : <ArrowLeft size={14} />}{asking ? 'Clear context' : 'All routes'}</button>
    <div><div className="network-selection-name">
      {asking ? <strong>{title}</strong> : <h1>{title}</h1>}
      {!asking ? <button className="agency-text-button" onClick={onAsk}><MessageSquare size={14} /> Ask</button> : null}
    </div>{selection?.route && (selection.stop || selection.route.description !== selection.route.name) ? <p>{selection.stop ? selection.route.name : selection.route.description}</p> : null}</div>
  </section>
}
