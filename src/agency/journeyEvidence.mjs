import { boardingFareEvidence } from '../fares.mjs'
import { journeyBreakdown } from './journeyResults.mjs'
import { journeyContinuityIssue } from '../journeyIntegrity.mjs'

// Keep the selected itinerary, including transfer provenance, available to
// follow-up questions. Geometry and network-wide overlay IDs stay in the
// technical record: neither helps explain this passenger's connection.
const seconds = minutes => Number.isFinite(minutes) ? Math.round(minutes * 60) : undefined
export function journeyClock(minutes) {
  const value = seconds(minutes)
  if (value === undefined || value < 0) return undefined
  const pad = n => String(n).padStart(2, '0')
  return `${pad(Math.floor(value / 3600))}:${pad(Math.floor(value / 60) % 60)}${value % 60 ? `:${pad(value % 60)}` : ''}`
}

export function journeyRealtimeEvidence(realtime) {
  if (!realtime) return realtime
  return { suppliedTripUpdates: realtime.suppliedTripUpdates, applied: realtime.applied,
    ...(realtime.routingDataMode ? { routingDataMode: realtime.routingDataMode } : {}),
    ...(realtime.inputCoverage ? { inputCoverage: realtime.inputCoverage } : {}),
    ...((realtime.diagnostics ?? []).some(item => item.coverage) ? { coverage: [...new Map(realtime.diagnostics.filter(item => item.coverage).map(item => [JSON.stringify(item.coverage), item.coverage])).values()] } : {}),
    statuses: [...new Set((realtime.diagnostics ?? []).map(item => item.status).filter(Boolean))] }
}

export function journeyPlanEvidence(plan) {
  if (!plan) return plan
  const issue = journeyContinuityIssue(plan)
  if (issue) return { status: 'blocked', travelMode: plan.travelMode, detail: issue,
    coverage: 'The saved itinerary failed a consistency check and cannot support directions or travel-time claims. Calculate a new journey.' }
  let previousEnd = seconds(plan.departMinutes)
  const legs = plan.legs?.map(leg => {
    const start = seconds(leg.startMinutes), end = seconds(leg.endMinutes)
    const gapBeforeSeconds = start !== undefined && previousEnd !== undefined ? start - previousEnd : undefined
    previousEnd = end
    return { type: leg.type, routeType: leg.routeType, routeId: leg.routeId, routeShortName: leg.routeShortName, tripId: leg.tripId,
      fromName: leg.fromName, toName: leg.toName, fromStopId: leg.fromStopId, toStopId: leg.toStopId,
      startTime: journeyClock(leg.startMinutes), endTime: journeyClock(leg.endMinutes),
      durationSeconds: start !== undefined && end !== undefined ? end - start : seconds(leg.durationMinutes), gapBeforeSeconds,
      distanceKm: leg.distanceKm, scheduleMode: leg.scheduleMode,
      ...(leg.type === 'walk' ? { walkSource: leg.walkSource, transferSource: leg.transferSource,
        streetPathVerified: leg.streetPathVerified, streetSegmentVerified: leg.streetSegmentVerified,
        stationAccessStatus: leg.stationAccessStatus } : {}),
    }
  })
  return { status: plan.status, detail: plan.detail, travelMode: plan.travelMode,
    coverage: plan.status === 'ready' ? 'Selected itinerary for the recorded request only. Different times, places, modes or transfer limits have not been evaluated by this result.' : 'No itinerary established for the recorded request; this does not establish unavailability for different requests.',
    durationMinutes: plan.durationMinutes, departTime: journeyClock(plan.departMinutes), arriveTime: journeyClock(plan.arriveMinutes),
    timeBreakdown: journeyBreakdown(plan), transfers: plan.transfers, fares: boardingFareEvidence(plan), legs }
}
