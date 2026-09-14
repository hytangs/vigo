import { ArrowLeft, MessageSquare } from 'lucide-react'
import type { WorkspaceSelection } from '../agency/types'

export function NetworkSelection({ selection, loading, asking, onClear, onAsk }: {
  selection?: WorkspaceSelection
  loading: boolean
  asking: boolean
  onClear: () => void
  onAsk: () => void
}) {
  return <section className="network-selection" aria-label="Selected network context">
    <button className="agency-text-button" onClick={onClear}><ArrowLeft size={14} /> All network</button>
    <div><div className="network-selection-name">
      <strong>{loading ? 'Opening selection…' : selection?.stop?.name || selection?.route?.name || 'Selection unavailable'}</strong>
      {!asking ? <button className="agency-text-button" onClick={onAsk}><MessageSquare size={14} /> Ask about this</button> : null}
    </div>{selection ? <p>{asking ? 'Ask context · ' : ''}{selection.route ? `Route ${selection.route.name}${selection.route.description && selection.route.description !== selection.route.name ? ` · ${selection.route.description}` : ''}` : 'Station'}{selection.stop && selection.route ? ` · ${selection.stop.name}` : ''}</p> : null}</div>
  </section>
}
