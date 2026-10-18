import { ArrowLeft } from 'lucide-react'
import type { AgencyRoute, WorkspaceSelection } from '../agency/types'
import { AgencyRouteBadge } from './AgencyRouteBadge'

export function NetworkSelection({ selection, route, loading, onClear }: {
  selection?: WorkspaceSelection
  /** The catalog entry for the selected route, for its badge. */
  route?: AgencyRoute
  loading: boolean
  onClear: () => void
}) {
  const title = loading ? 'Opening selection…' : selection?.stop?.name || selection?.route?.name || 'Selection unavailable'
  // A badge replaces the visible route title only when a destination line can take its place.
  const badged = Boolean(route && !selection?.stop && !loading && selection?.route?.description && selection.route.description !== selection.route.name)
  return <section className="network-selection" aria-label="Selected network context">
    <button className="agency-text-button" onClick={onClear}><ArrowLeft size={14} />All routes</button>
    <div className={badged ? 'has-badge' : undefined}>{badged && route ? <AgencyRouteBadge name={route.name} color={route.color} mode={route.mode} showMode /> : null}<div className="network-selection-name">
      <h1>{title}</h1>
    </div>{selection?.route && (selection.stop || selection.route.description !== selection.route.name) ? <p>{selection.stop ? selection.route.name : selection.route.description}</p> : null}</div>
  </section>
}
