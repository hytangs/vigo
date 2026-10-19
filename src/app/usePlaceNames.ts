import { useCallback, useEffect, useRef } from 'react'
import type { RoutingPoint } from '../routingModel'

function placeNameUrl(projectId: string, point?: RoutingPoint) {
  const query = point ? `?points=${point.coordinate[0].toFixed(6)},${point.coordinate[1].toFixed(6)}` : ''
  return `/api/projects/${encodeURIComponent(projectId)}/place${query}`
}

/** Preserve click order, bound waiting, and discard results from a previous City. */
export function createPlaceNameQueue(projectId: string, waitMs = 250) {
  let queue = Promise.resolve()
  let disposed = false
  const controllers = new Set<AbortController>()
  return {
    dispose() { disposed = true; for (const controller of controllers) controller.abort() },
    name(point: RoutingPoint, apply: (point: RoutingPoint) => void) {
      if (disposed) return
      const controller = new AbortController()
      controllers.add(controller)
      let timer: ReturnType<typeof setTimeout>
      const lookup = point.source === 'map' && !point.named && projectId
        ? fetch(placeNameUrl(projectId, point), { signal: controller.signal })
          .then((response) => response.ok ? response.json() : undefined)
          .then((body) => body?.places?.[0]?.label)
        : Promise.resolve(undefined)
      const label = Promise.race([lookup, new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined) }, waitMs)
      })]).catch(() => undefined).finally(() => { clearTimeout(timer); controllers.delete(controller) })
      queue = queue.then(() => label).then((name: unknown) => {
        if (!disposed) apply(typeof name === 'string' && name.trim() && name.length <= 500
          ? { ...point, label: name, named: true } : point)
      }).catch(() => undefined)
    },
  }
}

export function usePlaceNames(projectId: string, active: boolean) {
  const currentProject = useRef(active ? projectId : '')
  currentProject.current = active ? projectId : ''
  const state = useRef<{ projectId: string; queue: ReturnType<typeof createPlaceNameQueue> } | null>(null)
  useEffect(() => {
    const queue = createPlaceNameQueue(projectId)
    state.current = { projectId, queue }
    const controller = new AbortController()
    if (active && projectId) void fetch(placeNameUrl(projectId), { signal: controller.signal }).catch(() => undefined)
    return () => { queue.dispose(); controller.abort(); state.current = null }
  }, [active, projectId])
  return useCallback((point: RoutingPoint, apply: (point: RoutingPoint) => void) => {
    if (active && state.current?.projectId === projectId) state.current.queue.name(point, (named) => { if (currentProject.current === projectId) apply(named) })
  }, [active, projectId])
}
