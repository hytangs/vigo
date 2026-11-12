export function routingResultStatus(plan) {
  if (plan?.status === 'ready') return 'ready'
  const failureCode = String(plan?.diagnostics?.failure?.code ?? plan?.diagnostics?.failureCode ?? '')
  const failureCategory = String(plan?.diagnostics?.failure?.category ?? plan?.diagnostics?.failureCategory ?? '')
  if (failureCode.includes('stale') || failureCode.includes('artifact')) return 'stale'
  if (failureCode.includes('cancel')) return 'cancelled'
  if (failureCategory === 'unsupported_feature' || failureCode.includes('unsupported')) return 'unsupported'
  return 'blocked'
}
