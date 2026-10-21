import { CircleDot, Navigation2, Spline } from 'lucide-react'
import type { LayerState } from '../domain'

type DisplayLayer = 'routes' | 'stops' | 'vehicles'
const overlays = [
  { key: 'routes', title: 'Lines', icon: Spline },
  { key: 'stops', title: 'Stops', icon: CircleDot },
  { key: 'vehicles', title: 'Vehicles', icon: Navigation2 },
] as const

/** One line of map filters: which network, which mode, and which features are drawn. */
export function NetworkLayers({ layers, onChange, feeds, selectedFeed, onSelectFeed, modes, mode, onModeChange }: {
  modes: { id: number; name: string }[]; mode: number | null; onModeChange: (mode: number | null) => void
  layers: LayerState; onChange: (key: DisplayLayer, enabled: boolean) => void
  feeds: { id: string; name: string }[]; selectedFeed: string; onSelectFeed: (id: string) => void
}) {
  return <section className="network-layers" aria-label="Map display">
    {feeds.length > 1 ? <select aria-label="Displayed network" value={selectedFeed} onChange={event => onSelectFeed(event.currentTarget.value)}>
      <option value="__bundle__">All networks</option>
      {feeds.map(feed => <option key={feed.id} value={feed.id}>{feed.name}</option>)}
    </select> : null}
    {modes.length > 1 || mode !== null ? <select aria-label="Displayed transport mode" value={mode ?? ''} onChange={event => onModeChange(event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}>
      <option value="">All modes</option>
      {modes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select> : null}
    <div className="network-layer-toggles" role="group" aria-label="Visible map features">
      {overlays.map(({ key, title, icon: Icon }) => {
        const visible = key === 'vehicles' ? layers.vehicles ?? layers.routes : layers[key]
        return <button type="button" key={key} className="kit-icon-button" aria-pressed={visible} aria-label={title}
          title={`${visible ? 'Hide' : 'Show'} ${title.toLowerCase()}`} onClick={() => onChange(key, !visible)}>
          <Icon size={15} aria-hidden="true" />
        </button>
      })}
    </div>
  </section>
}
