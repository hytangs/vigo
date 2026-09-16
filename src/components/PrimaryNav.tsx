import { Navigation2, Radar, Route, Settings } from 'lucide-react'

export type RouteToolKey = 'data' | 'pathfinder' | 'analyze' | 'agency'

export function PrimaryNav({ page, activeRouteTool, hasActiveData, onOpenNetwork, onOpenRouting, onOpenAnalyze, onOpenSettings }: {
  page: 'projects' | 'project'
  activeRouteTool: RouteToolKey
  hasActiveData: boolean
  onOpenNetwork: () => void
  onOpenRouting: () => void
  onOpenAnalyze: () => void
  onOpenSettings: () => void
}) {
  const destinations = [
    { id: 'agency', label: 'Network', shortcut: '1', icon: Route, open: onOpenNetwork },
    { id: 'pathfinder', label: 'Route', shortcut: '2', icon: Navigation2, open: onOpenRouting },
    { id: 'analyze', label: 'Analyze', shortcut: '3', icon: Radar, open: onOpenAnalyze },
    { id: 'data', label: 'City', shortcut: '5', icon: Settings, open: onOpenSettings },
  ] as const
  return <nav className="sidebar-rail" aria-label="VIGO Agency">{destinations.map(({ id, label, shortcut, icon: Icon, open }) => <button
    key={id} type="button" className="sidebar-rail-button" onClick={open}
    disabled={id !== 'data' && (page !== 'project' || !hasActiveData)}
    title={`${label} (${shortcut})`} aria-label={label} aria-keyshortcuts={shortcut}
    aria-current={page === 'project' && activeRouteTool === id ? 'page' : undefined}
  ><span className="sidebar-rail-icon"><Icon size={19} aria-hidden="true" /></span></button>)}</nav>
}
