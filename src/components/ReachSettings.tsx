import { useId, useState } from 'react'

/** Keep incomplete edits local; only valid values enter a routing request. */
export function AnalysisNumberField({ label, value, min, max, unit, integer = false, optional = false, disabled = false, help, onChange }: {
  label: string; value: number | undefined; min: number; max: number; unit?: string
  integer?: boolean; optional?: boolean; disabled?: boolean; help?: string
  onChange: (value: number | undefined) => void
}) {
  const id = useId()
  const [edit, setEdit] = useState({ value, draft: value === undefined ? '' : String(value) })
  // Synchronize slider/parent changes during rendering so a delayed effect cannot
  // overwrite a newer keystroke or display the previous budget for another frame.
  if (!Object.is(edit.value, value)) setEdit({ value, draft: value === undefined ? '' : String(value) })
  return <div className="reach-number-field">
    <label className="reach-field reach-setting-row" htmlFor={id}>
      <span>{label}</span>
      <span className="reach-number-input">
        <input id={id} type="number" inputMode={integer ? 'numeric' : 'decimal'}
          value={edit.draft} min={min} max={max} step={integer ? 1 : 'any'} required={!optional}
          placeholder={optional ? 'Automatic' : undefined} disabled={disabled}
          aria-describedby={help ? `${id}-help` : undefined}
          onChange={event => {
            const raw = event.currentTarget.value
            setEdit({ value, draft: raw })
            if (!raw.trim()) { if (optional && !event.currentTarget.validity.badInput) onChange(undefined); return }
            const number = Number(raw)
            if (Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number)) && number !== value) onChange(number)
          }}
          onBlur={event => {
            if (!event.currentTarget.validity.valid) setEdit({ value, draft: value === undefined ? '' : String(value) })
          }} />
        {unit ? <span aria-hidden="true">{unit}</span> : null}
      </span>
    </label>
    {help ? <small id={`${id}-help`}>{help}</small> : null}
  </div>
}

export function ReachSettings({ cutoffMinutes, maxWalkKm, walkSpeedKph, maxTransfers, surfaceSampling, hasScenarioChanges,
  onCutoffChange, onMaxWalkKmChange, onWalkSpeedChange, onMaxTransfersChange, onSurfaceSamplingChange }: {
  cutoffMinutes: number; maxWalkKm: number; walkSpeedKph: number; maxTransfers?: number
  surfaceSampling: 'street' | 'cell-center'; hasScenarioChanges: boolean
  onCutoffChange: (value: number) => void; onMaxWalkKmChange: (value: number) => void
  onWalkSpeedChange: (value: number) => void; onMaxTransfersChange?: (value: number | undefined) => void
  onSurfaceSamplingChange?: (value: 'street' | 'cell-center') => void
}) {
  return <section className="reach-settings-list" aria-label="Travel limits">
    <div className="reach-time-budget">
      <AnalysisNumberField label="Time budget" value={cutoffMinutes} min={1} max={240} unit="min"
        onChange={value => { if (value !== undefined) onCutoffChange(value) }} />
      <input className="reach-budget-slider" type="range" min={1} max={240} step={0.25} value={cutoffMinutes}
        aria-label="Adjust time budget" aria-valuetext={`${cutoffMinutes} minutes`}
        onChange={event => onCutoffChange(Number(event.currentTarget.value))} />
      <div className="reach-budget-scale" aria-hidden="true"><span>1 min</span><span>4 hours</span></div>
    </div>
    {onMaxTransfersChange ? <AnalysisNumberField label="Maximum transit rides" value={maxTransfers === undefined ? undefined : maxTransfers + 1}
      min={1} max={32} integer optional help="1 ride means no transfers. Leave empty for automatic."
      onChange={value => onMaxTransfersChange(value === undefined ? undefined : value - 1)} /> : null}
    <details className="studio-disclosure reach-advanced">
      <summary><span>Walking & map</span><b>{maxWalkKm} km final walk</b></summary>
      <div className="reach-walking-settings">
        <AnalysisNumberField label="Final walk limit" value={maxWalkKm} min={0.2} max={5} unit="km"
          onChange={value => { if (value !== undefined) onMaxWalkKmChange(value) }} />
        <AnalysisNumberField label="Walking speed" value={walkSpeedKph} min={1} max={8} unit="km/h" disabled={surfaceSampling === 'cell-center'}
          onChange={value => { if (value !== undefined) onWalkSpeedChange(value) }} />
        {onSurfaceSamplingChange ? <label className="reach-field reach-setting-method">
          <span>Area calculation</span>
          <select value={surfaceSampling} onChange={event => onSurfaceSamplingChange(event.currentTarget.value as 'street' | 'cell-center')}>
            <option value="street">Reachable streets</option>
            <option value="cell-center" disabled={hasScenarioChanges}>Routes to grid points</option>
          </select>
          <small>{surfaceSampling === 'cell-center' ? 'Samples routes at grid points, walking at 4.8 km/h.' : 'Follows the streets you can reach, including service changes.'}</small>
        </label> : null}
      </div>
    </details>
  </section>
}
