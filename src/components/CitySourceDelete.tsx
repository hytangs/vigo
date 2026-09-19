import { Trash2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { apiJson } from '../app/api'
import type { VigoProject } from '../domain'

export function CitySourceDelete({ projectId, kind, name, feedId, disabled, onDeleted }: {
  projectId: string
  kind: 'gtfs' | 'osm'
  name: string
  feedId?: string
  disabled: boolean
  onDeleted: (city: VigoProject) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await apiJson<{ city: VigoProject }>(`/api/projects/${encodeURIComponent(projectId)}/city-source`, {
        method: 'DELETE',
        body: JSON.stringify({ kind, feedId, confirmation: kind === 'gtfs' ? feedId : name }),
      })
      dialog.current?.close()
      onDeleted(result.city)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this source.')
    } finally {
      setBusy(false)
    }
  }
  return <>
    <button type="button" className="city-source-delete" aria-label={`Delete ${kind.toUpperCase()} source ${name}`} title={`Delete ${name}`} disabled={disabled || busy}
      onClick={() => { setError(''); dialog.current?.showModal() }}><Trash2 size={16} aria-hidden="true" /></button>
    <dialog ref={dialog} className="city-source-dialog" aria-labelledby={titleId} onCancel={(event) => { if (busy) event.preventDefault() }}>
      <h2 id={titleId}>Delete {kind === 'gtfs' ? 'GTFS feed' : 'OSM streets'}?</h2>
      <p><strong>{name}</strong></p>
      <p>{kind === 'gtfs' ? 'This removes its timetable from this City. Remaining feeds will be kept.' : 'This removes street routing and OSM walking transfers. Your GTFS timetables will be kept.'} You can import the source again.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="city-source-dialog-actions">
        <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="city-source-confirm" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete source'}</button>
      </div>
    </dialog>
  </>
}
