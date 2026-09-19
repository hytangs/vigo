export type NetworkNarrative = {
  overview: string
  sections: Array<{ id: string; title: string; routeIds: string[]; text: string }>
  elsewhere: string
  coverage: string
}
export type NetworkDiagnosis = {
  version: number; generatedAt: string; window: { from: number; to: number; minutes: number }; status: string
  serviceContext: null | {
    clock: { date: string; time: string; timezone: string; zoneLabel: string }
    referenceHours: number; windowRoutes: number; referenceRoutes: number; referenceComplete: boolean; activeTrips: number; complete: boolean
    phase: 'between_runs' | 'scheduled_service' | 'incomplete'; nextScheduledTripAt: string | null
  }
  coverage: {
    scheduledTrips: number; reportingScheduledTrips: number; unknownTrips: number
    measuredRoutes: number; scheduledRoutes: number; indexedRoutes: number
    scheduledVehicleMinutes: number; reportingVehicleMinutes: number; reportingShare: number | null
    additionalReportingTrips: number; excludedFrequencyTemplates: number
    feeds: Array<{ kind: string; sourceUrl: string; status: string }>
  }
  concentrations?: Array<{ id: string; name: string; stopIds: string[] }>
  routes: Array<{
    id: string; name: string; scheduledTrips: number; reportingScheduledTrips: number; measuredTrips: number
    laterTrips: number; earlierTrips: number; matchingTrips: number; cancelledTrips: number
    widest?: { stopId: string; stopName: string; maxIncreaseSeconds: number; predictedSeconds: number; scheduledSeconds: number } | null
    medianDeviationSeconds: number | null; measuredPairs: number; widerPairs: number; closerPairs: number
  }>
  limits: string[]
}
export type BriefingPreferences = { intervalMinutes: 15 | 30 | 60; automatic: boolean }
export type BriefingInvestigation = {
  plan?: { focusId: string }
  focusTitle?: string
  explanation?: { hypothesis: string; status: string; text: string; evidenceIds: number[] }
  watchNext?: string; assessment?: string; incomplete?: boolean
  checks: Array<{ aspect: string; completed: boolean }>
}
