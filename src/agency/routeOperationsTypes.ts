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
