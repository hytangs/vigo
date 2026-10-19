type RenderCountWindow = Window & { __vigoRenderCounts?: Record<string, number> }

/**
 * Count renders in development so a state change can be checked to stay
 * local: `window.__vigoRenderCounts` holds one counter per named component.
 */
export function countRender(name: string) {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  const counts = ((window as RenderCountWindow).__vigoRenderCounts ??= {})
  counts[name] = (counts[name] ?? 0) + 1
}
