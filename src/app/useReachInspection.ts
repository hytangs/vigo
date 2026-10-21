import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReachResult } from '../reach'
import type { RoutingPlan, RoutingPoint } from '../routingModel'
import { apiJson } from './api'
import { lookupPlaceNames } from './usePlaceNames'
import { normalizeReceivedRoutingPlan } from './routingPlan'
import { reachInspectionSources, reachPointRouteRequest } from './reachInspection'

export function useReachInspection({ active, projectId, feedId, result }: {
  active: boolean; projectId: string; feedId: string; result: ReachResult | null
}) {
  const sources = useMemo(() => reachInspectionSources(result), [result])
  const context = useMemo(() => ({ projectId, feedId, sources, active }), [projectId, feedId, sources, active])
  const [selection, setSelection] = useState<{ context: typeof context; point: RoutingPoint } | null>(null)
  const [response, setResponse] = useState<{ selection: typeof selection; plan: RoutingPlan | null; error: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [placeName, setPlaceName] = useState<{ point: RoutingPoint; label: string } | null>(null)
  const current = active && selection?.context === context ? selection : null
  const source = sources[0]
  const currentPoint = current?.point
  // Name the pin from local place data without re-running its journey.
  useEffect(() => {
    if (!currentPoint || !projectId) return
    const controller = new AbortController()
    void lookupPlaceNames(projectId, [currentPoint], controller.signal)
      .then(([label]) => { if (label && !controller.signal.aborted) setPlaceName({ point: currentPoint, label }) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [currentPoint, projectId])
  const placeLabel = currentPoint && placeName?.point === currentPoint ? placeName.label : ''
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
    if (active && sources.length) setSelection({ context, point: { ...point, label: `${point.coordinate[1].toFixed(5)}, ${point.coordinate[0].toFixed(5)}` } })
  }, [active, context, sources])
  const accepted = response?.selection === current ? response : null
  return {
    inspect, source, sources,
    point: currentPoint ? placeLabel ? { ...currentPoint, label: placeLabel, named: true } : currentPoint : null,
    plan: accepted?.plan ?? null, error: accepted?.error ?? '', loading: Boolean(current && !accepted),
    close: () => setSelection(null),
    retry: () => { setResponse(null); setRetry(value => value + 1) },
  }
}
