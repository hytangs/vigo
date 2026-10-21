// Studio opts in only while its walking control has not been explicitly changed.
export async function withStudioWalkingAlternatives(request, route, signal) {
  const ordinary = await route(request)
  if (request.autoExpandWalking !== true || request.mode !== 'transit' || request.wheelchair
      || request.waypoints?.length || request.maxWalkKm >= 2.4) return ordinary
  let wider
  try {
    wider = await route({ ...request, autoExpandWalking: false, maxWalkKm: 2.4, requireTransitRide: true, allowLongWalk: false })
  } catch (error) {
    if (signal?.aborted) throw error
    return ordinary
  }
  const valid = plan => plan?.status === 'ready'
  const baseline = [...new Map([ordinary.plan, ...(ordinary.choices ?? [])].filter(valid).map(plan => [plan.id, plan])).values()]
  const bestArrival = Math.min(...baseline.map(plan => plan.arriveMinutes))
  const bestDuration = Math.min(...baseline.map(plan => plan.durationMinutes))
  const seen = new Set(baseline.map(plan => plan.id))
  const extra = [wider.plan, ...(wider.choices ?? [])].filter(valid).filter(plan => {
    if (seen.has(plan.id) || !plan.legs.some(leg => leg.type === 'ride')) return false
    seen.add(plan.id)
    return plan.arriveMinutes < bestArrival || plan.durationMinutes < bestDuration
  }).map(plan => ({ ...plan, recommended: false,
    diagnostics: { ...plan.diagnostics, expandedWalkingLimitKm: 2.4 } }))
  if (!extra.length) return ordinary
  const choices = [...baseline, ...extra].sort((a, b) => a.arriveMinutes - b.arriveMinutes || a.durationMinutes - b.durationMinutes)
  return { ...ordinary, plan: choices[0], choices }
}
