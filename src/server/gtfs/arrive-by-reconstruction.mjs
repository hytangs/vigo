// A failed presentation of the reverse optimum is not proof that an earlier
// departure is optimal. Reconstruct at that same boundary or expose the
// inconsistency. An independently verified direct walk can dominate it.
export function recoverNativeArriveByBoundary({
  latestDepartureSeconds,
  prepareCompleteAccess,
  materializeAtBoundary,
  dominatingDirectWalk,
}) {
  prepareCompleteAccess()
  const plan = materializeAtBoundary(latestDepartureSeconds)
  if (plan) {
    return {
      plan,
      departureSeconds: latestDepartureSeconds,
      recovery: {
        status: 'passed',
        trigger: 'native_reverse_boundary_failed_initial_forward_materialization',
        exactness: 'same_reverse_boundary_verified_by_forward_materialization',
        nativeLatestDepartureSeconds: latestDepartureSeconds,
        recoveredCandidateSeconds: latestDepartureSeconds,
        outcome: 'same_boundary_forward_witness',
      },
    }
  }
  const walk = dominatingDirectWalk?.()
  if (walk && walk.departureSeconds >= latestDepartureSeconds - 1e-9) {
    return {
      plan: walk.plan,
      departureSeconds: walk.departureSeconds,
      recovery: {
        status: 'passed',
        trigger: 'native_reverse_boundary_failed_initial_forward_materialization',
        exactness: 'independent_direct_walk_dominates_reverse_transit_upper_bound',
        nativeLatestDepartureSeconds: latestDepartureSeconds,
        recoveredCandidateSeconds: walk.departureSeconds,
        directWalkDepartureSeconds: walk.departureSeconds,
        outcome: 'direct_walk_dominates_scalar_transit_upper_bound',
      },
    }
  }
  const error = new Error('The latest reverse departure could not be reconstructed by a forward witness.')
  error.code = 'native_arrive_by_materialization_mismatch'
  error.nativeLatestDeparture = latestDepartureSeconds
  throw error
}
