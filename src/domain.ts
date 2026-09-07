export type Appearance = 'light' | 'dark'

export type Severity = 'info' | 'warning' | 'error'

export type Point = {
  x: number
  y: number
}

export type LngLat = [number, number]

export type FrequencyClass = 'high' | 'medium' | 'low'

export type GeometrySource = 'shape' | 'stop_sequence' | 'osm_drive'
export type ServiceDay = 'weekday' | 'saturday' | 'sunday'

export type ValidationIssue = {
  id: string
  severity: Severity
  table: string
  message: string
  rows: string[]
}

export type TableProfile = {
  name: string
  role: 'required' | 'optional'
  present: boolean
  rowCount: number
  fieldCount: number
  fields: string[]
  issueCount: number
}

export type TidesTableRole = 'event' | 'summary' | 'supporting'

export type TidesTableSummary = {
  name: string
  title: string
  role: TidesTableRole
  present: boolean
  rowCount: number
  fieldCount: number
  fields: string[]
  path?: string
}

export type TidesSummary = {
  schemaVersion: 'tides.v1'
  detected: boolean
  datapackage: boolean
  packageName?: string
  packageProfile?: string
  tableCount: number
  eventTableCount: number
  summaryTableCount: number
  supportingTableCount: number
  rowCount: number
  observedServiceDates: number
  performedTripCount: number
  stopVisitCount: number
  passengerEventCount: number
  vehicleLocationCount: number
  fareTransactionCount: number
  stationActivityCount: number
  vehicleCount: number
  deviceCount: number
  totalBoardings: number
  totalAlightings: number
  totalEntries: number
  totalExits: number
  totalFareTransactions: number
  totalFareRevenue: number
  maxDepartureLoad: number
  averageDwellSeconds?: number
  averageScheduleDeviationSeconds?: number
  scheduledTripRefs: number
  scheduledTripMatches: number
  scheduledTripUnmatched: number
  stopRefs: number
  stopMatches: number
  stopUnmatched: number
  linkScore: number
  tables: TidesTableSummary[]
  signals: string[]
}

export type StopMetric = {
  id: string
  name: string
  x: number
  y: number
  lat?: number
  lon?: number
  routes: string[]
  tripCount: number
  transferScore: number
  parentStationId?: string
  parentStationName?: string
  locationType?: number
  platformCode?: string
  wheelchairBoarding?: number
}

export type ScheduledTransferRule = {
  fromStopId: string
  toStopId: string
  transferType?: number
  minTransferTimeSeconds?: number
  fromRouteId?: string
  toRouteId?: string
  fromTripId?: string
  toTripId?: string
}

export type ScheduledPathway = {
  id: string
  fromStopId: string
  toStopId: string
  pathwayMode?: number
  isBidirectional?: boolean
  traversalTimeSeconds?: number
  lengthMeters?: number
  stairCount?: number
}

export type ScheduledTripStop = {
  stopId: string
  sequence: number
  arrivalMinutes?: number
  departureMinutes?: number
  progress: number
  shapeIndex?: number
  shapeDistanceKm?: number
}

export type ScheduledServiceCalendar = {
  startDate?: string
  endDate?: string
  weekdays?: number[]
  addedDates?: string[]
  removedDates?: string[]
  calendarDatesOnly?: boolean
}

export type ScheduledTrip = {
  tripId: string
  serviceId?: string
  serviceDays?: ServiceDay[]
  serviceCalendar?: ScheduledServiceCalendar
  routeId: string
  patternId?: string
  directionId?: string
  firstDepartureMinutes: number
  lastArrivalMinutes: number
  stopTimes: ScheduledTripStop[]
}

export type RouteMetric = {
  id: string
  routeId?: string
  routeType?: number
  patternId?: string
  directionId?: string
  shapeId?: string
  shortName: string
  longName: string
  color: string
  tripCount: number
  stopCount: number
  headwayMinutes: number
  spanHours: number
  serviceHours: number
  serviceShare?: number
  frequencyClass?: FrequencyClass
  patternRank?: number
  serviceVariantCount?: number
  analysisSource?: 'atlas' | 'focused'
  analysisServiceDate?: string
  geometrySource?: GeometrySource
  distanceKm?: number
  scheduledSpeedKph?: number
  firstDepartureMinutes?: number
  lastArrivalMinutes?: number
  stopPairCount?: number
  segmentCount?: number
  status: 'baseline' | 'added' | 'changed' | 'removed' | 'unchanged'
  coordinates?: LngLat[]
  points: Point[]
  stopIds: string[]
  scheduledTrips?: ScheduledTrip[]
}

export type StopPairMetric = {
  id: string
  routeId: string
  patternId: string
  directionId?: string
  fromStopId: string
  toStopId: string
  fromStopName: string
  toStopName: string
  sequence: number
  tripCount: number
  headwayMinutes: number
  medianRuntimeMinutes: number
  distanceKm: number
  speedKph: number
  coordinates?: LngLat[]
}

export type MapPreviewCoverage = {
  rawRouteRows: number
  publicRouteIdentities: number
  tripsIndexed: number
  stopTimesScanned: number
  stopsIndexed: number
  stopPairsIndexed: number
  capped: boolean
  timetableDeferred: boolean
  previewStrategy?: string
  tripCountStrategy?: string
  sourceScope?: string
  routeLimit?: number
  connectionsPerRouteLimit?: number
  routeGeometryIndexed?: number
  routeGeometryComplete?: boolean
  shapeGeometryIndexed?: number
  transportLod?: {
    publicRoutes: number
    stops: number
    shapePoints: number
    stopPairsDeferred: number
  }
}

export type MapPreview = {
  routes: RouteMetric[]
  stops: StopMetric[]
  stopPairs?: StopPairMetric[]
  transferRules?: ScheduledTransferRule[]
  pathways?: ScheduledPathway[]
  coverage?: MapPreviewCoverage
}

export type RealtimeVehicle = {
  id: string
  label?: string
  licensePlate?: string
  routeId?: string
  tripId?: string
  startDate?: string
  startTime?: string
  stopId?: string
  currentStatus?: string
  congestionLevel?: string
  occupancyStatus?: string
  occupancyPercentage?: number
  timestamp?: number
  lat?: number
  lon?: number
  bearing?: number
  speed?: number
}

export type RealtimeTripUpdate = {
  id: string
  routeId?: string
  tripId?: string
  startDate?: string
  startTime?: string
  scheduleRelationship?: string
  timestamp?: number
  delaySeconds?: number
  stopUpdateCount: number
  nextStopId?: string
  nextStopSequence?: number
  stopTimeUpdates?: Array<{
    stopSequence?: number
    stopId?: string
    scheduleRelationship?: string
    arrival?: {
      delay?: number
      time?: number
      uncertainty?: number
      scheduledTime?: number
    }
    departure?: {
      delay?: number
      time?: number
      uncertainty?: number
      scheduledTime?: number
    }
  }>
}

export type RealtimeAlert = {
  id: string
  cause?: string
  effect?: string
  severity?: string
  header?: string
  description?: string
  url?: string
  routeIds: string[]
  stopIds: string[]
  activePeriods: Array<{ start?: number; end?: number }>
}

export type RealtimeSnapshot = {
  sourceUrl?: string
  sourceUrls?: string[]
  fetchedAt: string
  feedTimestamp?: number
  freshness?: {
    status: 'fresh' | 'stale' | 'unknown'
    ageSeconds?: number
    thresholdSeconds: number
  }
  feedVersion?: string
  gtfsRealtimeVersion?: string
  incrementality?: string
  contentType?: string
  entityCount: number
  counts: {
    vehicles: number
    tripUpdates: number
    alerts: number
    other: number
  }
  vehicles: RealtimeVehicle[]
  tripUpdates: RealtimeTripUpdate[]
  alerts: RealtimeAlert[]
}

export type FeedSummary = {
  id: string
  name: string
  provider: string
  versionLabel: string
  importedAt: string
  source: 'local-file' | 'url' | 'bundle'
  fileName: string
  fileSize: number
  qualityScore: number
  routeCount: number
  stopCount: number
  tripCount: number
  transferCandidates: number
  requiredTables: Record<string, boolean>
  optionalTables: Record<string, boolean>
  tableProfiles?: TableProfile[]
  warnings: ValidationIssue[]
  routeMetrics: RouteMetric[]
  stopMetrics: StopMetric[]
  mapPreview?: MapPreview
  routingStore?: {
    schemaVersion: 'vigo.routing.store.v1'
    status: 'building' | 'ready' | 'failed'
    routingEligibility?: 'exact' | 'qualified' | 'unsupported'
    fileName: string
    bytes: number
    connectionCount: number
    builtAt: string
    blockingRoutingFeatures?: Array<{ code: string; count: number; detail: string }>
    routingLimitations?: Array<{ code: string; count?: number; exactness?: string; detail: string }>
  }
  tides?: TidesSummary
}

export type RoutingStoreMetadata = NonNullable<FeedSummary['routingStore']>

export type JobRecord = {
  id: string
  kind: string
  label: string
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'
  progress: number
  createdAt: string
  phase?: string
  detail?: string
  error?: string
  failureCode?: string
  retryable?: boolean
  retryOf?: string
  sourceFile?: string
  preparation?: {
    schemaVersion: 'vigo.preparation.v1'
    totalMs: number
    phaseTimingsMs: Record<string, number>
    completedAt: string
  }
  phaseTimingsMs?: Record<string, number>
  finishedAt?: string
  output?: string
  result?: { feedId?: string; [key: string]: unknown }
}

export type ArtifactRecord = {
  id: string
  schemaVersion: string
  type: string
  title: string
  createdAt: string
  sourceFeedIds: string[]
}

export type VigoProject = {
  schemaVersion: string
  id: string
  name: string
  region: string
  createdAt: string
  updatedAt: string
  storagePath: string
  summary: {
    feeds: number
    routes: number
    stops: number
    transferCandidates: number
    qualityScore: number
  }
  feeds: FeedSummary[]
  jobs: JobRecord[]
  artifacts: ArtifactRecord[]
  routingStore?: RoutingStoreMetadata | null
  osmStreetIndex?: {
    schemaVersion: 'vigo.street.store.v4'
    status: 'building' | 'ready' | 'failed'
    fileName: string
    sourceBytes: number
    bytes: number
    storageLayout?: string
    runtimeCompaction?: {
      storageLayout?: string
      beforeBytes?: number
      afterBytes?: number
      bytesSaved?: number
    }
    nodeCount: number
    walkNodeCount?: number
    edgeCount: number
    wayCount: number
    driveNodeCount?: number
    driveEdgeCount?: number
    driveWayCount?: number
    drivingWeightModel?: string
    driveSnapshot?: Record<string, unknown>
    cch?: {
      ready?: boolean
      format?: string
      nodeCount?: number
      edgeCount?: number
      cchArcCount?: number
      distanceUnitsPerMeter?: number
      structureFile?: string
      metricFile?: string
    }
    directionRestrictedWayCount?: number
    directionExcludedWayCount?: number
    uncertainConveyingWayCount?: number
    builtAt: string
  } | null
}

export type LayerKey = 'routes' | 'segments' | 'stops' | 'transfers' | 'coverage' | 'scenario' | 'access'

export type LayerState = Record<LayerKey, boolean>

export type GtfsRouteStatusFilter = 'all' | 'baseline' | 'added' | 'changed' | 'removed' | 'unchanged'

export type Basemap = 'none' | 'offline' | 'minimal' | 'streets' | 'dark' | 'terrain'

export type NetworkLens = 'network' | 'shape' | 'service' | 'transfer' | 'risk'

export const basemapLabels: Record<Basemap, string> = {
  none: 'No basemap',
  offline: 'Local OSM streets',
  minimal: 'CARTO Positron',
  streets: 'OpenStreetMap Standard',
  dark: 'CARTO Dark Matter',
  terrain: 'CARTO Voyager',
}

export const basemapShortLabels: Record<Basemap, string> = {
  none: 'None',
  offline: 'Local',
  minimal: 'Light',
  streets: 'OSM',
  dark: 'Dark',
  terrain: 'Voyager',
}

export const basemapDescriptions: Record<Basemap, string> = {
  none: 'Clean analysis canvas with no geographic backdrop.',
  offline: 'Street geometry from this City’s imported OSM PBF; no labels or network tiles.',
  minimal: 'Quiet light OSM-derived context for route and stop review.',
  streets: 'Standard OpenStreetMap context; requires a network connection.',
  dark: 'Dark OSM-derived context for this City.',
  terrain: 'Modern, higher-contrast OSM-derived context with more place detail.',
}

export const networkLensLabels: Record<NetworkLens, string> = {
  network: 'Network',
  shape: 'Shape',
  service: 'Service',
  transfer: 'Transfers',
  risk: 'Risk',
}

export const initialLayers: LayerState = {
  routes: true,
  segments: false,
  stops: true,
  transfers: true,
  coverage: false,
  scenario: true,
  access: false,
}

const numberFormatter = new Intl.NumberFormat('en-US')

export function formatNumber(value: number) {
  return numberFormatter.format(Math.round(value))
}

export function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}
