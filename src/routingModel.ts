import type { LngLat, ServiceDay, StopMetric } from './domain'

export type RoutingPoint = {
  coordinate: LngLat
  label: string
  stopId?: string
  source: 'map' | 'stop' | 'search'
}

export type RoutingTravelMode = 'transit' | 'walk' | 'drive'
export type RoutingTimePreference = 'depart' | 'arrive'
export type RoutingSearchProfile = 'balanced' | 'fastest' | 'pareto'
export type RoutingSearchStrategy =
  | 'exact'
  | 'exact_constrained_access'
  | 'exact_constrained_egress'
  | 'exact_waypoint_composition'
  | 'not_run'
export type RoutingScheduleMode = 'exact' | 'interpolated-stop-time-gap' | 'realtime-adjusted' | 'none'
export type RoutingWalkSource = 'osm' | 'direct' | 'transfer' | 'estimated' | 'station-selection'
export type RoutingTimingPrecision = 'exact' | 'degraded' | 'source-equal-time'
export type RoutingExecutionStatus = 'ready' | 'blocked' | 'unsupported' | 'stale' | 'cancelled' | 'error'

export type RoutingAccessAvailabilityHint = {
  role: 'origin' | 'destination'
  status: 'outside_selected_budget' | 'none_within_probe' | 'street_access_unverified' | 'diagnostic_unavailable'
  selectedWalkKm: number
  probeWalkKm: number
  requiredWalkKm?: number
  requiredWalkMinutes?: number
  suggestedMaxWalkKm?: number
  nearestStop?: {
    id: string
    name: string
    distanceKm: number
    walkMinutes: number
  }
  strategy?: string
  detail?: string
}

export type RoutingLeg = {
  type: 'walk' | 'ride' | 'drive'
  travelMode?: RoutingTravelMode
  scheduleMode?: Exclude<RoutingScheduleMode, 'none'>
  walkSource?: RoutingWalkSource
  transferSource?: 'gtfs_transfer' | 'gtfs_pathway' | 'schedule_transfer' | 'schedule_pathway' | 'osm_certified_radial' | 'parent_station_fallback'
  streetPathVerified?: boolean
  streetSegmentVerified?: boolean
  stationAccessStatus?: 'source_path' | 'unverified'
  stationAccessStopIds?: string[]
  fromStopId?: string
  toStopId?: string
  fromStationGroupId?: string
  toStationGroupId?: string
  fromName: string
  toName: string
  routeFeatureId?: string
  routeId?: string
  routeType?: number
  routeShortName?: string
  routeColor?: string
  tripId?: string
  directionId?: string
  transferAction?: 'interchange' | 'same-route-change' | 'platform-change'
  connectingRouteShortName?: string
  geometrySource?: 'shape' | 'stop_sequence' | 'osm-rust-selected-transfer' | 'stop-coordinate-fallback' | 'station-transfer-schematic'
  shapeId?: string
  startMinutes: number
  endMinutes: number
  durationMinutes: number
  distanceKm: number
  stopCount: number
  stopIds?: string[]
  coordinates: LngLat[]
  bridgedUntimedGapCount?: number
  sourceEqualTime?: boolean
  sourceEqualTimeConnectionCount?: number
  sourceTimestampQuality?: 'equal-whole-minute' | 'equal-time'
  orderedSegmentIndex?: number
}

export type RoutingPlan = {
  id: string
  status: 'ready' | 'blocked'
  travelMode: RoutingTravelMode
  timePreference: RoutingTimePreference
  maxWalkKm: number
  choiceLabel?: string
  recommended?: boolean
  title: string
  detail: string
  departMinutes: number
  arriveMinutes?: number
  durationMinutes: number
  waitMinutes: number
  walkMinutes: number
  rideMinutes: number
  transfers: number
  origin: RoutingPoint
  waypoints?: RoutingPoint[]
  destination: RoutingPoint
  snappedOrigin?: StopMetric
  snappedDestination?: StopMetric
  legs: RoutingLeg[]
  diagnostics: {
    originWalkKm?: number
    destinationWalkKm?: number
    scannedDepartures: number
    relaxedStops: number
    serviceDay: ServiceDay
    serviceDate?: string
    scheduleMode: RoutingScheduleMode
    roadMetricMode?: 'free-flow' | 'traffic-adjusted'
    timingPrecision?: RoutingTimingPrecision
    sourceEqualTimeRideCount?: number
    sourceEqualTimeConnectionCount?: number
    routingHorizonMinutes?: number
    walkingNetwork: RoutingWalkSource
    walkingSpeedKph: number
    osmWalkEdges?: number
    generalizedCost?: number
    searchProfile?: RoutingSearchProfile
    searchStrategy?: RoutingSearchStrategy
    algorithm?: string
    optimality?: string
    methodState?: 'complete' | 'failed' | 'unsupported' | 'partial' | string
    methodRequested?: string
    methodUsed?: string | string[]
    fallbackReason?: string
    failureCode?: string
    failureCategory?: string
    routingStatus?: RoutingExecutionStatus
    routingStatusSchemaVersion?: 'vigo.routing.status.v1'
    failure?: {
      code: string
      category: string
      message: string
      retryable?: boolean
      features?: Array<{ code: string; count?: number; detail?: string }>
    }
    dataSemantics?: {
      blockingFeatures?: Array<{ code: string; count?: number; detail?: string }>
      limitations?: Array<{ code: string; count?: number; exactness?: string; detail?: string }>
      transferGeneration?: Record<string, unknown> | null
    }
    paretoCertification?: Record<string, unknown>
    traffic?: {
      status?: 'applied' | 'stale_fallback' | 'no_matches' | 'free_flow_equivalent' | 'native_fallback'
      source?: string
      observedAt?: string
      expiresAt?: string
      matchedObservations?: number
      matchedEdges?: number
      unmatchedObservations?: number
      closedEdges?: number
      customizationMs?: number
      metricReused?: boolean
    }
    pruning?: Record<string, unknown>
    calendarWarning?: string
    walkingPolicyId?: string
    walkingAccessPermission?: 'public' | 'authorized_endpoints'
    originStopCandidates?: number
    destinationStopCandidates?: number
    accessAvailability?: {
      origin?: RoutingAccessAvailabilityHint | null
      destination?: RoutingAccessAvailabilityHint | null
    }
    destinationLabels?: number
    selectedTimeChoice?: boolean
    choiceSupport?: {
      objective:
        | 'elapsed_plus_weighted_transfers_plus_weighted_walking'
        | 'elapsed_plus_journey_plus_weighted_transfers_plus_weighted_walking'
      elapsedWeight: 1
      journeyWeight?: number
      transferPenaltyMinutesPerTransfer: number
      walkingReluctance: number
      nonnegativeWeightFeasibility: 'exact_half_plane_intersection'
    }
    scannedRouteKeys?: string[]
    searchStats?: Record<string, unknown>
    timing?: Record<string, number | boolean>
    departureWindow?: {
      centerMinutes: number
      beforeMinutes: number
      afterMinutes: number
      sampleCount: number
      desktopDirection?: 'forward'
    }
    departurePresentation?: {
      requestedDepartMinutes: number
      displayedDepartMinutes: number
      deferredInitialWaitMinutes: number
      strategy: 'just-in-time-initial-walk'
    }
    [key: string]: unknown
  }
}

export type NetworkSearchHit = {
  id: string
  kind: 'route' | 'stop'
  title: string
  subtitle: string
  score: number
  routeId?: string
  stopId?: string
  coordinate?: LngLat
}

export type RoutingCommand = {
  originText: string
  waypointTexts: string[]
  destinationText: string
  locationTexts: string[]
  departMinutes?: number
  timePreference?: RoutingTimePreference
  maxWalkKm?: number
  maxTransfers?: number
  mode?: RoutingTravelMode
}
