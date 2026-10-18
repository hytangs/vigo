import type { CSSProperties } from 'react'

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
  return luminance > 0.36 ? '#0c0f13' : '#ffffff'
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
