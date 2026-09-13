export type Evidence = {
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
}

export type OperationalEvent = {
  id: string
  type: 'delay' | 'bunching' | 'service-gap' | 'cancellation' | 'skipped-stop' | 'stale-data' | 'service-alert'
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
  headway: 'unknown' | 'changed' | 'matches-schedule'
}

export type AgencyState = {
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
  presentation?: { routeIds?: string[]; stopIds?: string[] }
}

export type QueryAnswer = {
  entryId?: number
  aiGenerated?: boolean
  model?: string
  citations?: number[]
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

export type AgencySkill = {
  id: string
  name: string
  description: string
  version: string
  source: 'vigo' | 'external'
  status: 'ready' | 'unavailable'
  requiredInputs: string[]
  outputType: string
  enabled: boolean
  tools: string[]
  instructions: string
  inputs: Array<{ key: string; label: string; type: 'route' | 'date' | 'stop' | 'time' | 'minutes'; required: boolean }>
  steps: Array<{ tool: string; arguments?: Record<string, unknown>; label?: string }>
}

export interface ProviderState {
  available: boolean
  model: string | null
  baseUrl?: string
  reasoningEffort?: string
  hasKey?: boolean
  source?: string
  testedAt?: string | null
}
