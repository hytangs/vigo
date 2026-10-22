import { useEffect } from 'react'
import { Check, Undo2, X } from 'lucide-react'
import { useStore } from '../../app/store'
import { useStudio } from '../../state/hooks'
import { activeScenarioStopPlacement, finishScenarioDrawing, scenarioEditor, undoScenarioStop } from '../../state/scenarioEditor'
import { activeScenarioChange } from '../../state/scenarios'
import { scenarioChangeKind } from './presentation'

/**
 * The map's drawing state while placing stops or zone corners. Enter or Esc
 * finish, Backspace undoes the last point; the panel keeps the full editor.
 */
export function ScenarioDrawingBar() {
  const change = useStudio(activeScenarioChange)
  const placement = useStudio(activeScenarioStopPlacement)
  const drawing = useStore(scenarioEditor, (state) => state.drawing)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        finishScenarioDrawing()
      } else if (event.key === 'Backspace' && scenarioEditor.get().drawing) {
        event.preventDefault()
        undoScenarioStop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!change || !placement) return null
  const zone = change.kind === 'flex-zone'
  const count = change.stops.length
  const kind = scenarioChangeKind(change.kind)
  const instruction = !drawing
    ? placement.mode === 'insert' ? `Click to insert stop ${placement.index + 1}` : `Click to move stop ${placement.index + 1}`
    : zone
      ? count < 3 ? `Click to place corner ${count + 1}` : 'Click to add a corner · click the first corner to close'
      : count < 2 ? `Click the map or a stop to place stop ${count + 1}` : 'Keep clicking to extend · click the last stop to finish'
  return <div className="scenario-drawing-bar" role="status" aria-live="polite">
    <span className="scenario-drawing-dot" aria-hidden="true" />
    <span className="scenario-drawing-text">
      <strong>{change.name || kind.label}</strong>
      <small>{instruction}</small>
    </span>
    {drawing && count ? <button type="button" className="kit-icon-button" onClick={undoScenarioStop} aria-label="Undo last point" title="Undo (Backspace)"><Undo2 size={15} aria-hidden="true" /></button> : null}
    <button type="button" className="kit-button is-primary" onClick={finishScenarioDrawing} title="Finish (Enter)">
      {drawing ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}{drawing ? 'Done' : 'Cancel'}
    </button>
  </div>
}
