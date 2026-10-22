import { Ban, GitBranchPlus, TrainTrack, X } from 'lucide-react'
import { maximumScenarioChanges } from '../../app/scenarioLibrary'
import { useStudio } from '../../state/hooks'
import { addScenarioChange, dismissPickedRoute, pickedScenarioRoute } from '../../state/scenarioEditor'
import { activeScenario } from '../../state/scenarios'

/** Dark text on light route colors, white on dark ones. */
function readableOn(color: string | undefined) {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color ?? '')?.[1]
  if (!hex) return '#ffffff'
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#101418' : '#ffffff'
}

/** A published line clicked on the Scenarios map, and what to do with it. */
export function ScenarioLineCard() {
  const route = useStudio(pickedScenarioRoute)
  const full = useStudio(() => (activeScenario()?.interventions.length ?? 0) >= maximumScenarioChanges)
  if (!route) return null
  const actions = [
    ['change-line', 'Reroute', GitBranchPlus],
    ['enhance-line', 'Add service', TrainTrack],
    ['remove-line', 'Remove', Ban],
  ] as const
  return <div className="scenario-line-card" role="dialog" aria-label={`Line ${route.shortName || route.longName}`}>
    <header>
      <span className="scenario-line-badge" style={{ background: route.color || 'var(--fill-3)', color: readableOn(route.color) }}>{route.shortName || '•'}</span>
      <span className="scenario-line-name">
        <strong>{route.longName || route.shortName}</strong>
        <small>{route.stopCount} stops · {route.tripCount} trips</small>
      </span>
      <button type="button" className="kit-icon-button" onClick={dismissPickedRoute} aria-label="Close" title="Close"><X size={14} aria-hidden="true" /></button>
    </header>
    <div className="scenario-line-actions">
      {actions.map(([kind, label, Icon]) => <button key={kind} type="button" className="kit-button" disabled={full} onClick={() => addScenarioChange(kind, route.id)}>
        <Icon size={14} aria-hidden="true" />{label}
      </button>)}
    </div>
  </div>
}
