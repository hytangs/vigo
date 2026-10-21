import { Eye, EyeOff, Layers } from 'lucide-react'
import type { LayerState } from '../domain'

type DisplayLayer = 'routes' | 'stops' | 'vehicles'
const overlays: { key: DisplayLayer; title: string; mark: string }[] = [
  { key: 'routes', title: 'Lines', mark: '━' },
  { key: 'stops', title: 'Stops', mark: '●' },
  { key: 'vehicles', title: 'Vehicles', mark: '▲' },
]

export function NetworkLayers({ layers, onChange, feeds, selectedFeed, onSelectFeed, modes, mode, onModeChange }: {
  modes: { id: number; name: string }[]; mode: number | null; onModeChange: (mode: number | null) => void
  layers: LayerState; onChange: (key: DisplayLayer, enabled: boolean) => void
  feeds: { id: string; name: string }[]; selectedFeed: string; onSelectFeed: (id: string) => void
}) {
  return <section className="network-layers" aria-label="Map display">
    <header><Layers size={15} aria-hidden="true" /><strong>Map display</strong></header>
    <label className="network-display-source"><span>Network</span>
      <select aria-label="Displayed network" value={selectedFeed} onChange={event => onSelectFeed(event.currentTarget.value)}>
        <option value="__bundle__">All networks</option>
        {feeds.map(feed => <option key={feed.id} value={feed.id}>{feed.name}</option>)}
      </select>
    </label>
    <label className="network-display-source"><span>Mode</span>
      <select aria-label="Displayed transport mode" value={mode ?? ''} onChange={event => onModeChange(event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}>
        <option value="">All modes</option>
        {modes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <div className="network-layer-grid" role="group" aria-label="Visible map features">
      {overlays.map(layer => {
        const visible = layer.key === 'vehicles' ? layers.vehicles ?? layers.routes : layers[layer.key]
        return <button type="button" key={layer.key} aria-pressed={visible} aria-label={layer.title}
          onClick={() => onChange(layer.key, !visible)}>
          <span className="network-layer-mark" aria-hidden="true">{layer.mark}</span><span>{layer.title}</span>
          {visible ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
        </button>
      })}
    </div>
  </section>
}
