import type { RoutingBikeOptions } from '../routingModel'

export function BikeRoutingSettings({ value, onChange, arrive = false }: {
  value: RoutingBikeOptions; onChange?: (value: RoutingBikeOptions) => void; arrive?: boolean
}) {
  return <div className="routing-preference-section">
    <div className="routing-setup-columns">
      <label className="routing-setup-select"><span>Bike preference</span>
        <select aria-label="Bike preference" value={value.profile} onChange={event => onChange?.({...value,profile:event.currentTarget.value as typeof value.profile})}>
          <option value="balanced">Balanced</option><option value="fast">Fast</option><option value="quiet">Quiet</option>
        </select>
      </label>
      <label className="routing-setup-input"><span>Cycling speed (km/h)</span>
        <input aria-label="Cycling speed" type="number" min={5} max={40} step={1} value={value.speedKph}
          onChange={event => onChange?.({...value,speedKph:event.currentTarget.valueAsNumber})} />
      </label>
    </div>
    <label className="routing-setup-select"><span>Maximum traffic stress</span>
      <select aria-label="Maximum bicycle traffic stress" value={value.maxLts ?? ''}
        onChange={event => onChange?.({...value,maxLts:event.currentTarget.value ? Number(event.currentTarget.value) as 1|2|3|4 : undefined})}>
        <option value="">No limit</option><option value="1">LTS 1 · Lowest</option><option value="2">LTS 2 · Low</option>
        <option value="3">LTS 3 · Moderate</option><option value="4">LTS 4 · All levels</option>
      </select>
    </label>
    <p className="routing-setup-note">Estimated from OSM. Links above the limit are walked where permitted.</p>
    {arrive ? <p className="routing-setup-note">Arrive-by keeps timed access restrictions conservative.</p> : null}
  </div>
}
