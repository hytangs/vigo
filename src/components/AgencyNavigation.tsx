import { useEffect, useRef, type ReactNode } from 'react'
import { BookOpen, CheckSquare, Download, Map, MessageSquare, MoreHorizontal, Radio, RefreshCw, Route } from 'lucide-react'

export type AgencyMode = 'live' | 'briefing' | 'ask' | 'skills' | 'operations'
const views = [
  { id: 'live', label: 'Routes', icon: Route },
  { id: 'briefing', label: 'Briefing', icon: Radio },
  { id: 'ask', label: 'Ask', icon: MessageSquare },
] as const

export function AgencyNavigation({ mode, onChange, health, mapOpen, onToggleMap, onRefresh, onExport }: {
  mode: AgencyMode
  onChange: (mode: AgencyMode) => void
  health: ReactNode
  mapOpen: boolean
  onToggleMap: () => void
  onRefresh: () => void
  onExport?: () => void
}) {
  const more = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!more.current?.contains(event.target as Node) && more.current) more.current.open = false }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  function choose(next: AgencyMode) {
    if (more.current) more.current.open = false
    onChange(next)
  }
  return <nav className="agency-navigation" aria-label="Network navigation">
    <div className="agency-tabs" role="tablist" aria-label="Network views">{views.map(({ id, label, icon: Icon }, index) => <button
      key={id} role="tab" id={`agency-tab-${id}`} aria-selected={mode === id} aria-controls={`agency-${id}`}
      tabIndex={mode === id || (!views.some(view => view.id === mode) && index === 0) ? 0 : -1}
      onClick={() => choose(id)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length
        choose(views[next].id)
        document.getElementById(`agency-tab-${views[next].id}`)?.focus()
      }}><Icon size={15} />{label}</button>)}</div>
    <div className="agency-navigation-tools">
      <div className="agency-live-indicator">{health}</div>
      <button className="agency-icon-button agency-mobile-map-toggle" aria-label={mapOpen ? 'Hide map' : 'Show map'} aria-pressed={mapOpen} onClick={onToggleMap}><Map size={16} /></button>
      <details className="agency-more" ref={more} onKeyDown={event => { if (event.key === 'Escape' && more.current) { more.current.open = false; more.current.querySelector('summary')?.focus() } }}>
        <summary className="agency-icon-button" aria-label="Network tools" title="Network tools"><MoreHorizontal size={18} /></summary>
        <div className="agency-more-options">
          <button onClick={() => choose('skills')}><BookOpen size={15} />Research</button>
          <button onClick={() => choose('operations')}><CheckSquare size={15} />Service desk</button>
          <button onClick={() => { if (more.current) more.current.open = false; onRefresh() }}><RefreshCw size={15} />Refresh observations</button>
          {onExport ? <button onClick={() => { if (more.current) more.current.open = false; onExport() }}><Download size={15} />Export observations</button> : null}
        </div>
      </details>
    </div>
  </nav>
}
