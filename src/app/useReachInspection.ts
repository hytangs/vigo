import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReachComparisonResult, ReachResult } from '../reach'
import type { RoutingPlan, RoutingPoint } from '../routingModel'
import { apiJson } from './api'
import { normalizeReceivedRoutingPlan } from './routingPlan'
import { reachInspectionSources, reachPointRouteRequest } from './reachInspection'

export function useReachInspection({ active, projectId, feedId, result, comparison }: {
  active: boolean; projectId: string; feedId: string; result: ReachResult | null; comparison: ReachComparisonResult[] | null
}) {
  const sources = useMemo(() => reachInspectionSources(result, comparison), [result, comparison])
  const context = useMemo(() => ({ projectId, feedId, sources, active }), [projectId, feedId, sources, active])
  const [selection, setSelection] = useState<{ context: typeof context; point: RoutingPoint; sourceId: string } | null>(null)
  const [response, setResponse] = useState<{ selection: typeof selection; plan: RoutingPlan | null; error: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const current = active && selection?.context === context ? selection : null
  const source = sources.find(item => item.id === current?.sourceId) ?? sources[0]
  useEffect(() => {
    if (!current || !source) {
      setResponse(null)
      if (selection) setSelection(null)
      return
    }
    const controller = new AbortController()
    void apiJson<{ choices: RoutingPlan[] }>(`/api/projects/${encodeURIComponent(projectId)}/national-route`, {
      method: 'POST', signal: controller.signal,
      body: JSON.stringify(reachPointRouteRequest(source, current.point, feedId)),
    }).then(result => {
      if (controller.signal.aborted) return
      const plan = result.choices[0] ? normalizeReceivedRoutingPlan(result.choices[0]) : null
      setResponse({ selection: current, plan, error: plan ? '' : 'The router returned no journey. Try again.' })
    }).catch(error => {
      if (!controller.signal.aborted) setResponse({ selection: current, plan: null, error: error instanceof Error ? error.message : 'Could not check this point.' })
    })
    return () => controller.abort()
  }, [current, source, projectId, feedId, retry, selection])
  const inspect = useCallback((point: RoutingPoint) => {
    if (active && sources.length) setSelection({ context, point: { ...point, label: `${point.coordinate[1].toFixed(5)}, ${point.coordinate[0].toFixed(5)}` }, sourceId: sources[0].id })
  }, [active, context, sources])
  const accepted = response?.selection === current ? response : null
  return {
    inspect, point: current?.point ?? null, source, sources,
    plan: accepted?.plan ?? null, error: accepted?.error ?? '', loading: Boolean(current && !accepted),
    close: () => setSelection(null),
    selectSource: (sourceId: string) => { if (current) setSelection({ ...current, sourceId }) },
    retry: () => { setResponse(null); setRetry(value => value + 1) },
  }
}
