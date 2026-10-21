import { ChevronRight } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import type { AgencyRoute } from '../agency/types'

const modeLabels: Record<number, string> = {
  0: 'Tram', 1: 'Subway', 2: 'Rail', 3: 'Bus', 4: 'Ferry', 5: 'Cable car', 6: 'Gondola', 7: 'Funicular', 11: 'Trolleybus', 12: 'Monorail',
}

export function routeModeLabel(mode: number | undefined) {
  return mode === undefined ? '' : modeLabels[mode] ?? 'Transit'
}

/** Black or white ink, whichever reads better on the route's own color. */
function routeInk(color: string) {
  const match = /^#?([0-9a-f]{6})$/iu.exec(color.trim())
  if (!match) return '#ffffff'
  const channel = (offset: number) => {
    const value = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  return luminance > 0.36 ? '#08101b' : '#ffffff'
}

/** A route as riders see it on signs: its own color, its short name, its mode. */
export function AgencyRouteBadge({ name, color, mode, showMode = false }: {
  name: string
  color: string
  mode?: number
  showMode?: boolean
}) {
  const style = { '--line-color': color || '#8b95a4', '--line-ink': routeInk(color || '#8b95a4') } as CSSProperties
  return (
    <span className="agency-route-label" style={style}>
      <b>{name}</b>
      {showMode && mode !== undefined ? <small>{routeModeLabel(mode)}</small> : null}
    </span>
  )
}

/**
 * A route as one compact row: its sign, what it serves (or its mode when the
 * sign already names it), and its current state underneath.
 */
export function AgencyRouteRow({ route, severity, detailClassName, onSelect, children }: {
  route: Pick<AgencyRoute, 'id' | 'name' | 'longName' | 'color' | 'mode'>
  severity?: string
  detailClassName: string
  onSelect: () => void
  children: ReactNode
}) {
  const named = Boolean(route.longName && route.longName !== route.name)
  return (
    <button type="button" className="agency-route-row" data-route-id={route.id} data-severity={severity} onClick={onSelect}>
      <span className="agency-route-row-head">
        <AgencyRouteBadge name={route.name} color={route.color} />
        <span className={named ? 'agency-route-row-title' : 'agency-route-row-title is-mode'}>{named ? route.longName : routeModeLabel(route.mode)}</span>
      </span>
      <span className={detailClassName}>{children}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  )
}
