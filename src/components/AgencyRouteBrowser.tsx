import { useMemo, useState, type CSSProperties } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'
import type { AgencyState } from '../agency/types'

export function AgencyRouteBrowser({ state, onSelect }: { state: AgencyState; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(50)
  const routes = useMemo(() => state.routes.filter(route => `${route.name} ${route.longName}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id)), [state.routes, search])
  return <section className="agency-route-browser" aria-label="Route browser">
    <label className="agency-route-search"><Search size={16} /><input aria-label="Find a route" placeholder="Find a route" value={search} onChange={event => { setSearch(event.target.value); setLimit(50) }} />{search ? <button aria-label="Clear route search" onClick={() => { setSearch(''); setLimit(50) }}><X size={14} /></button> : null}</label>
    <p className="agency-caption">{search.trim() ? `${routes.length} matching routes` : `${state.routes.length} routes`} · {state.cityName}</p>
    <div className="agency-route-list">{routes.slice(0, limit).map(route => <button key={route.id} onClick={() => onSelect(route.id)}>
      <span className="agency-route-label" style={{ '--line-color': route.color } as CSSProperties}>{route.name}</span>
      <span className="agency-route-list-detail">{route.longName && route.longName !== route.name ? <span>{route.longName}</span> : null}<small>{state.connected ? `${route.reportingTrips} ${route.reportingTrips === 1 ? 'trip report' : 'trip reports'}${route.alerts ? ` · ${route.alerts} ${route.alerts === 1 ? 'alert' : 'alerts'}` : ''}` : 'Timetable'}</small></span>
      <ChevronRight size={15} />
    </button>)}</div>
    {!routes.length ? <p className="agency-quiet">No routes match “{search}”.</p> : null}
    {routes.length > limit ? <button className="agency-text-button agency-show-more" onClick={() => setLimit(value => value + 50)}>More routes <ChevronRight size={13} /></button> : null}
  </section>
}
