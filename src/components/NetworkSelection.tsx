import { ArrowLeft } from 'lucide-react'
import type { WorkspaceSelection } from '../agency/types'

export function NetworkSelection({ selection, loading, onClear }: {
  selection?: WorkspaceSelection
  loading: boolean
  onClear: () => void
}) {
  const title = loading ? 'Opening selection…' : selection?.stop?.name || selection?.route?.name || 'Selection unavailable'
  return <section className="network-selection" aria-label="Selected network context">
    <button className="agency-text-button" onClick={onClear}><ArrowLeft size={14} />All routes</button>
    <div><div className="network-selection-name">
      <h1>{title}</h1>
    </div>{selection?.route && (selection.stop || selection.route.description !== selection.route.name) ? <p>{selection.stop ? selection.route.name : selection.route.description}</p> : null}</div>
  </section>
}
