import { ArrowLeft, MessageSquare } from 'lucide-react'
import type { WorkspaceSelection } from '../agency/types'

export function NetworkSelection({ selection, loading, asking, onClear, onAsk }: {
  selection?: WorkspaceSelection
  loading: boolean
  asking: boolean
  onClear: () => void
  onAsk: () => void
}) {
  return <section className={`network-selection ${asking ? 'is-asking' : ''}`} aria-label="Selected network context">
    <button className="agency-text-button" onClick={onClear}><ArrowLeft size={14} />{asking ? 'Clear selection' : 'All routes'}</button>
    <div><div className="network-selection-name">
      <strong>{loading ? 'Opening selection…' : selection?.stop?.name || selection?.route?.name || 'Selection unavailable'}</strong>
      {!asking ? <button className="agency-text-button" onClick={onAsk}><MessageSquare size={14} /> Ask</button> : null}
    </div>{selection?.route && (selection.stop || selection.route.description !== selection.route.name) ? <p>{selection.stop ? selection.route.name : selection.route.description}</p> : null}</div>
  </section>
}
