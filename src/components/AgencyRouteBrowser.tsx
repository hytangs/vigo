import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'
import type { AgencyState } from '../agency/types'
import { browseRoutes, routeBrowserFreshness, routeDelayLabel, routeHasAttention, type RouteBrowserFilter, type RouteBrowserSort } from '../agency/routeBrowser'

const filters: Array<{ value: RouteBrowserFilter; label: string }> = [
  { value: 'all', label: 'All routes' }, { value: 'attention', label: 'Needs attention' }, { value: 'reporting', label: 'Reporting' },
]

export function AgencyRouteBrowser({ state, onSelect, initialFilter = 'all', onFilterChange, refreshFailed = false }: {
  state: AgencyState
  onSelect: (id: string) => void
  initialFilter?: RouteBrowserFilter
  onFilterChange?: (filter: RouteBrowserFilter) => void
  refreshFailed?: boolean
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<RouteBrowserFilter>(initialFilter)
  const [sort, setSort] = useState<RouteBrowserSort>(initialFilter === 'attention' ? 'attention' : 'name')
  const [limit, setLimit] = useState(50)
  const [now, setNow] = useState(Date.now)
  const searchRef = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [state.generatedAt])
  const freshness = useMemo(() => routeBrowserFreshness(state, now, refreshFailed), [state, now, refreshFailed])
  const routes = useMemo(() => browseRoutes(state.routes, { search, filter, sort, freshness }), [state.routes, search, filter, sort, freshness])
  const counts = useMemo(() => ({
    all: state.routes.length,
    attention: state.routes.filter(route => routeHasAttention(route, freshness)).length,
    reporting: freshness.predictions ? state.routes.filter(route => route.reportingTrips > 0).length : 0,
  }), [state.routes, freshness])
  const visible = routes.slice(0, limit)
  const chooseFilter = (next: RouteBrowserFilter) => { setFilter(next); setLimit(50); onFilterChange?.(next) }
  const reset = () => { setSearch(''); chooseFilter('all'); setSort('name'); searchRef.current?.focus() }
  const hasFilters = Boolean(search.trim() || filter !== 'all')

  return <section className="agency-route-browser" aria-label="Route browser">
    <header className="agency-page-heading"><h1>Routes</h1></header>
    <div className="agency-route-search"><Search size={16} aria-hidden="true" /><input ref={searchRef} aria-label="Find a route" placeholder="Find a route" value={search} onChange={event => { setSearch(event.target.value); setLimit(50) }} />{search ? <button type="button" aria-label="Clear route search" onClick={() => { setSearch(''); setLimit(50); searchRef.current?.focus() }}><X size={14} aria-hidden="true" /></button> : null}</div>
    <div className="agency-route-filters" role="group" aria-label="Filter routes">{filters.map(item => <button type="button" key={item.value} aria-pressed={filter === item.value} onClick={() => chooseFilter(item.value)}><span>{item.label}</span><span className="agency-route-filter-count">{counts[item.value].toLocaleString()}</span></button>)}</div>
    <div className="agency-route-toolbar">
      <p id={`${id}-results`} className="agency-caption" role="status">{visible.length < routes.length ? `${visible.length} of ${routes.length}` : `${routes.length}`} {hasFilters ? 'matching ' : ''}{routes.length === 1 ? 'route' : 'routes'}</p>
      <label className="agency-route-sort"><span>Sort</span><select aria-label="Sort routes" value={sort} onChange={event => { setSort(event.target.value as RouteBrowserSort); setLimit(50) }}><option value="name">Route name</option><option value="attention">Needs attention first</option><option value="delay">Largest predicted delay</option></select></label>
    </div>
    {!freshness.predictions ? <p className="agency-route-status" role="status">{freshness.label}. Unreported service is unknown.</p> : null}

    <div className="agency-route-list" aria-describedby={`${id}-results`}>{visible.map(route => {
      const delay = routeDelayLabel(route, freshness)
      const reporting = freshness.predictions && route.reportingTrips > 0
      const alertCount = freshness.alerts ? route.alerts : 0
      return <button type="button" key={route.id} data-route-id={route.id} onClick={() => onSelect(route.id)}>
        <span className="agency-route-label" style={{ '--line-color': route.color } as CSSProperties}>{route.name}</span>
        <span className="agency-route-list-detail">
          {route.longName && route.longName !== route.name ? <span>{route.longName}</span> : null}
          <small>{reporting ? `${route.reportingTrips} ${route.reportingTrips === 1 ? 'trip report' : 'trip reports'}` : freshness.predictions ? 'No current trip reports' : 'Timetable'}{alertCount ? ` · ${alertCount} ${alertCount === 1 ? 'alert' : 'alerts'}` : ''}</small>
          {delay || (reporting && route.headway === 'changed') || freshness.attentionRouteIds.has(route.id) ? <span className="agency-route-indicators">
            {delay ? <span className="agency-route-indicator" title="Largest predicted delay among reporting trips’ next departures in the assessment window.">{delay} predicted</span> : null}
            {reporting && route.headway === 'changed' ? <span className="agency-route-indicator" title="At least one fully reporting departure pair has different predicted spacing from the timetable.">Spacing changed</span> : null}
            {freshness.attentionRouteIds.has(route.id) ? <span className="agency-route-indicator">Service change reported</span> : null}
          </span> : null}

        </span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    })}</div>
    {!routes.length ? <div className="agency-route-empty"><Search size={22} aria-hidden="true" /><strong>{search.trim() ? `No routes match “${search.trim()}”.` : filter === 'reporting' ? 'No current trip reports' : filter === 'attention' ? 'No routes in this review list' : 'No routes in this City'}</strong><p>{filter === 'attention' || filter === 'reporting' ? 'Missing reports do not establish normal service. Browse all routes or check the live sources.' : state.routes.length ? 'Try a route number, destination or a broader search.' : 'Import a timetable to explore its routes.'}</p>{hasFilters ? <button type="button" className="agency-text-button" onClick={reset}>Reset filters <ChevronRight size={13} aria-hidden="true" /></button> : null}</div> : null}
    <details className="agency-route-source"><summary>Data &amp; coverage</summary><p>{freshness.detail}</p>{filter === 'attention' ? <p>Review includes predicted delays, changed spacing, cancellations, skipped stops and alerts. Sorted by alerts, service changes, then delay; this does not rank rider impact.</p> : null}</details>
    {routes.length > limit ? <button type="button" className="agency-text-button agency-show-more" onClick={() => setLimit(value => value + 50)}>More routes <span>({routes.length - limit} remaining)</span><ChevronRight size={13} aria-hidden="true" /></button> : null}
  </section>
}
