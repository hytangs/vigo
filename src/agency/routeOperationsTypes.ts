import type { FeedState } from './types'

export type VehicleTiming = {
  key: string
  id: string
  label: string
  routeId: string | null
  routeName: string | null
  tripId: string | null
  directionId: string | null
  serviceDate: string | null
  timezone: string | null
  observedAt: number | null
  predictionAt: number | null
  fresh: boolean
  destination: string | null
  stop: { id: string; stopId: string; name: string } | null
  callIndex: number | null
  patternId: string | null
  status: string | null
  arrival: { scheduled: number | null; current: number | null }
  departure: { scheduled: number | null; current: number | null }
  delaySeconds: number | null
  delayKind: 'arrival' | 'departure' | null
  nextPrediction?: {
    stop: { id: string; stopId: string; name: string }
    callIndex: number
    arrival: { scheduled: number | null; current: number | null }
    departure: { scheduled: number | null; current: number | null }
    delayKind: 'arrival' | 'departure' | null
    delaySeconds: number | null
  }
  occupancy: string | null
  warnings: string[]
}

export type RoutePattern = {
  id: string
  directionId: string | null
  stops: Array<{ id: string; name: string }>
  trips: number
}

export type RouteOperations = {
  serviceDates?: string[]
  routeId: string
  name: string
  color: string
  serviceDate: string | null
  timezone: string | null
  generatedAt: string
  observedAt: string | null
  patterns: RoutePattern[]
  vehicles: VehicleTiming[]
  warnings: string[]
}

export type StopBoardRow = {
  key: string
  tripId: string
  serviceDate: string
  routeId: string
  routeName: string
  color: string
  directionId: string | null
  destination: string
  stopId: string
  stopName: string
  platform: string | null
  vehicleId: string | null
  vehicleLabel: string | null
  vehicleSourceUrl: string | null
  atStop: boolean
  kind: 'arrival' | 'departure'
  expected: number
  arrival: VehicleTiming['arrival']
  departure: VehicleTiming['departure']
  status: 'live' | 'scheduled' | 'stale' | 'unresolved' | 'cancelled' | 'skipped'
  predictionAt: number | null
  stopSequence: number | null
  timingIssue: string | null
  source: {
    url: string
    entityId: string
    stopSequence: number | null
    arrival: { time?: number; delay?: number; uncertainty?: number } | null
    departure: { time?: number; delay?: number; uncertainty?: number } | null
  } | null
}

export type StopBoard = {
  vehicle?: { id: string | null; label: string; tripId: string | null; serviceDate: string | null; routeId: string | null; routeName: string | null; observedAt: number | null; issue: string | null }
  stop: { id: string; name: string }
  timezone: string | null
  generatedAt: string
  until: number
  windowMinutes?: number
  nextPerRoute?: boolean
  routeCount?: number
  feeds: FeedState[]
  rows: StopBoardRow[]
  total: number
  warnings: string[]
}
