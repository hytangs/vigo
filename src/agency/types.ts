import type { NetworkDiagnosis, NetworkNarrative, BriefingPreferences, BriefingInvestigation } from './networkAssessmentTypes'

export type WorkspaceSelectionInput = { routeId?: string; stopId?: string }
export type WorkspaceSelection = {
  route?: { id: string; name: string; description?: string }
  stop?: { id: string; name: string; coordinate: [number, number] }
}

export type Evidence = {
  // Earlier scheduled member; predictions can reverse the pair's order.
  leadingVehicleId?: string
  leadingTripStartTime?: string
  predictedOrderReversed?: boolean
  comparisonBasis?: 'reordered-predictions'
  scheduledPairSeparationSeconds?: number
  interveningTrips?: Array<{ tripId: string; basis: 'prediction' | 'position'; predictedTime?: number; vehicleId?: string; stopSequence?: number }>
  alertReason?: string
  tripStartTime?: string
  scheduledTime?: number
  predictedTime?: number
  delaySeconds?: number
  scheduledHeadwaySeconds?: number
  observedHeadwaySeconds?: number
  headwayRatio?: number
  feedAgeSeconds?: number
  referenceStopId?: string
  comparisonWindow?: [number, number]
  expectedDepartures?: number
  reportingTrips?: number
  tripIds?: string[]
  reason?: string
  alertHeader?: string
  alertDescription?: string
  alertCause?: string
  alertEffect?: string
  alertUrl?: string
  activePeriods?: Array<{ start?: number; end?: number }>
}

export type OperationalEvent = {
  scopeDescription?: string
  id: string
  type: 'delay' | 'bunching' | 'service-gap' | 'cancellation' | 'skipped-stop' | 'stale-data' | 'service-alert' | 'headway-review'
  severity: 'info' | 'warning' | 'critical'
  title: string
  routeId?: string
  routeIds?: string[]
  routeName?: string
  stopName?: string
  stopCoordinate?: [number, number]
  directionId?: string
  tripId?: string
  vehicleId?: string
  stopId?: string
  stopIds?: string[]
  observedAt: string
  serviceDate?: string
  evidence: Evidence
  sourceRefs: string[]
}

export type FeedState = {
  sourceUrl: string
  kind: string
  feedTimestamp?: number
  fetchedAt?: string
  ageSeconds: number | null
  status: 'fresh' | 'stale' | 'unknown' | 'error'
  error?: string
}

export type Coverage = {
  valid: boolean
  timezone: string | null
  serviceDate: string | null
  firstDate: string | null
  lastDate: string | null
  activeServices: number
  message: string
}

export type AgencyRoute = {
  id: string
  name: string
  longName: string
  color: string
  mode: number
  trips: number
  reportingTrips: number
  maxDelaySeconds: number | null
  events: number
  alerts: number
  serviceChanges?: number
  headway: 'unknown' | 'changed' | 'matches-schedule'
  comparedPairs?: number
  widestInterval?: { directionId?: number | string; predictedSeconds: number; scheduledSeconds: number; stopId: string; stopName: string } | null
}

export type AgencyState = {
  mapOperationalEvents?: OperationalEvent[]
  scheduleIdentity?: string
  selection?: WorkspaceSelection
  generatedAt: string
  observedAt: string | null
  cityName: string
  filteredEventCount?: number
  eventCount?: number
  stopNames?: Record<string, string>
  stopLocations?: Record<string, { label: string; coordinate: [number, number] }>
  connected: boolean
  provider: ProviderState
  coverage: Coverage
  counts: { routes: number; stops: number; vehicles: number; trips: number; matchedTrips: number; unresolvedTrips: number; alerts: number }
  feeds: FeedState[]
  routes: AgencyRoute[]
  events: OperationalEvent[]
  history: OperationalEvent[]
  tripHistory: Record<string, Array<{ at: string; delaySeconds: number }>>
  warnings: string[]
  policy: { freshnessSeconds: number; windowMinutes: number; historyMinutes: number }
}

export type ToolResult = {
  ok: boolean
  data: unknown
  provenance: string[]
  generatedAt: string
  warnings: string[]
  presentation?: { routeIds?: string[]; stopIds?: string[]; location?: { id: string; label: string; coordinate: [number, number] } }
}

export type QueryAnswer = {
  synthesis?: { method?: string; unavailable?: boolean }
  investigation?: BriefingInvestigation
  briefingPreferences?: BriefingPreferences
  diagnosis?: NetworkDiagnosis
  narrative?: NetworkNarrative
  scheduleIdentity?: string
  selection?: WorkspaceSelection
  timezone?: string | null
  runtime?: {
    capturedAt: string
    modelConnection: { model: string | null; protocol: string | null; endpoint: string | null; transport: string | null; endpointLocation: 'loopback' | 'other' | 'unknown'; inferenceLocation: 'unverified'; externalModelApi: 'not-configured-directly' | 'unverified' | 'unknown' }
    networkTools: Array<{ tool: string; label: string; endpoint: string | null }>
    networkToolCalls: Array<{ tool: string; completed: boolean }>
    limits: string
  }
  timing?: { totalMs: number; modelCalls: number; modelMs: number; toolMs: number; inputTokens: number | null; outputTokens: number | null; firstResponseMs?: number | null; loadMs?: number | null; promptMs?: number | null; generationMs?: number | null }
  entryId?: number
  responseBasis?: 'computed' | 'model_with_sources' | 'model_only'
  aiGenerated?: boolean
  model?: string
  citations?: number[]
  scopeNote?: string
  report?: { title: string; method: string; inputs: Record<string, unknown>; rows: Record<string, unknown>[] }
  answer: string
  trace: Array<{ tool: string; arguments: Record<string, unknown>; result: ToolResult }>
  evidenceRefs: string[]
  generatedAt: string
  warnings: string[]
  providerAvailable: boolean
}

export type RiderDraft = {
  headline: string
  body: string
  recommendedAction: string
  affectedRoutes: string[]
  affectedStops: string[]
  evidenceRefs: string[]
  reviewRequired: true
  generatedBy: 'template' | 'model'
  channel: 'app' | 'signage' | 'service-alert' | 'social'
  language: string
}

export interface ProviderState {
  web?: { provider: 'off' | 'duckduckgo' | 'wikipedia' | 'brave' | 'searxng'; baseUrl: string; hasKey: boolean; searchAvailable: boolean; readAvailable: boolean }
  available: boolean
  model: string | null
  baseUrl?: string
  protocol?: 'openai' | 'ollama'
  contextTokens?: number
  reasoningEffort?: string
  hasKey?: boolean
  source?: string
  testedAt?: string | null
}
