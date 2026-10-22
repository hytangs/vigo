import { useId } from 'react'
import { Layers, PenTool } from 'lucide-react'
import { useStudio } from '../../state/hooks'
import { openScenarioCase } from '../../state/scenarioEditor'
import { scenarioLibrary } from '../../state/scenarios'
import { plural, scenarioFlexZoneCount, scenarioSummary } from './presentation'

/**
 * Which network a Route or Reach runs on: the City as published, or a saved
 * scenario. Scenarios are edited in their own workspace; this only chooses.
 */
export function ScenarioNetworkPicker({ label, ariaLabel, value, baselineLabel, options, onChange }: {
  label: string
  ariaLabel: string
  value: string
  /** Shown for an empty value; omit when every option is a scenario. */
  baselineLabel?: string
  options: Array<{ id: string; name: string }>
  onChange: (id: string) => void
}) {
  const id = useId()
  const library = useStudio(scenarioLibrary)
  const scenario = library.scenarioDrafts.find((entry) => entry.id === value)
  const zones = scenarioFlexZoneCount(scenario)
  const detail = scenario ? scenarioSummary(scenario, library.grouping.value.groups)
    : value.startsWith('feed:') ? 'One timetable as published' : 'Every timetable as published'
  return <div className="scenario-picker">
    <label className="scenario-picker-row" htmlFor={id}>
      <Layers size={14} aria-hidden="true" />
      <span>{label}</span>
      <select id={id} value={value} aria-label={ariaLabel} onChange={(event) => onChange(event.currentTarget.value)}>
        {baselineLabel !== undefined ? <option value="">{baselineLabel}</option> : null}
        {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </label>
    <div className="scenario-picker-meta">
      <small>{detail}{zones ? ` · ${plural(zones, 'Flex zone')} not routed yet` : ''}</small>
      {scenario ? <button type="button" className="kit-text-button" onClick={() => openScenarioCase(scenario.id)}><PenTool size={12} aria-hidden="true" />Edit</button> : null}
    </div>
  </div>
}
