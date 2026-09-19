// Compare IDs, never display names: distinct platforms may share a name.
// Times are rounded to .001 minutes when a route is materialized.
export function journeyContinuityIssue(plan) {
  let previous = null
  for (const leg of plan?.legs ?? []) {
    if (previous?.toStopId && leg.fromStopId && previous.toStopId !== leg.fromStopId) {
      return 'The journey contains disconnected stops. Calculate it again before using these directions.'
    }
    const earliest = previous?.endMinutes ?? plan.departMinutes
    if ((Number.isFinite(earliest) && Number.isFinite(leg.startMinutes) && leg.startMinutes < earliest - .002)
      || (Number.isFinite(leg.endMinutes) && Number.isFinite(leg.startMinutes) && leg.endMinutes < leg.startMinutes - .002)) {
      return 'The journey contains conflicting times. Calculate it again before using these directions.'
    }
    previous = leg
  }
  return null
}
