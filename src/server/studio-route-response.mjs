// Studio needs journey evidence, not the kernel's repeated cache inventories.
// Apply this projection before worker transfer as well as at the API boundary.
export function compactStudioRoutingPlan(plan) {
  if (!plan?.diagnostics) return plan
  const { searchStats, dataSemantics, departureWindow, ...diagnostics } = plan.diagnostics
  const select = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
  return { ...plan, diagnostics: {
    ...diagnostics,
    ...(searchStats ? { searchStats: select(searchStats, ['queryMs', 'engineQueryMs']) } : {}),
    ...(dataSemantics ? { dataSemantics: select(dataSemantics, ['blockingFeatures', 'limitations', 'sourceFingerprint', 'transferSemanticsVersion']) } : {}),
    ...(departureWindow ? { departureWindow: select(departureWindow, ['centerMinutes', 'beforeMinutes', 'afterMinutes']) } : {}),
  } }
}

export function compactStudioRoutingResponse(result) {
  // Departure-window searches retain the blocked primary result separately
  // when there are no feasible alternatives. Keep its explanation in Studio.
  const choices = result.choices.length ? result.choices : result.plan ? [result.plan] : []
  return {
    choices: choices.map(compactStudioRoutingPlan),
    selectedPlanId: result.plan?.id ?? choices[0]?.id,
    ...(result.earliestTransit ? { earliestTransit: result.earliestTransit } : {}),
  }
}
