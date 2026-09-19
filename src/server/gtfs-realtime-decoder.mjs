import { PbfReader } from 'pbf'

// VIGO only inspects the standardized GTFS-Realtime fields below. Using the
// existing PBF runtime directly avoids shipping protobufjs-cli and its build
// toolchain in the production desktop application.
export const gtfsRealtimeEnums = Object.freeze({
  FeedHeader: Object.freeze({
    Incrementality: Object.freeze({ FULL_DATASET: 0, DIFFERENTIAL: 1 }),
  }),
  TripDescriptor: Object.freeze({
    ScheduleRelationship: Object.freeze({
      SCHEDULED: 0,
      ADDED: 1,
      UNSCHEDULED: 2,
      CANCELED: 3,
      REPLACEMENT: 5,
      DUPLICATED: 6,
      DELETED: 7,
      NEW: 8,
    }),
  }),
  StopTimeUpdate: Object.freeze({
    ScheduleRelationship: Object.freeze({
      SCHEDULED: 0,
      SKIPPED: 1,
      NO_DATA: 2,
      UNSCHEDULED: 3,
    }),
  }),
  VehiclePosition: Object.freeze({
    VehicleStopStatus: Object.freeze({
      INCOMING_AT: 0,
      STOPPED_AT: 1,
      IN_TRANSIT_TO: 2,
    }),
    CongestionLevel: Object.freeze({
      UNKNOWN_CONGESTION_LEVEL: 0,
      RUNNING_SMOOTHLY: 1,
      STOP_AND_GO: 2,
      CONGESTION: 3,
      SEVERE_CONGESTION: 4,
    }),
    OccupancyStatus: Object.freeze({
      EMPTY: 0,
      MANY_SEATS_AVAILABLE: 1,
      FEW_SEATS_AVAILABLE: 2,
      STANDING_ROOM_ONLY: 3,
      CRUSHED_STANDING_ROOM_ONLY: 4,
      FULL: 5,
      NOT_ACCEPTING_PASSENGERS: 6,
      NO_DATA_AVAILABLE: 7,
      NOT_BOARDABLE: 8,
    }),
  }),
  Alert: Object.freeze({
    Cause: Object.freeze({
      UNKNOWN_CAUSE: 1,
      OTHER_CAUSE: 2,
      TECHNICAL_PROBLEM: 3,
      STRIKE: 4,
      DEMONSTRATION: 5,
      ACCIDENT: 6,
      HOLIDAY: 7,
      WEATHER: 8,
      MAINTENANCE: 9,
      CONSTRUCTION: 10,
      POLICE_ACTIVITY: 11,
      MEDICAL_EMERGENCY: 12,
    }),
    Effect: Object.freeze({
      NO_SERVICE: 1,
      REDUCED_SERVICE: 2,
      SIGNIFICANT_DELAYS: 3,
      DETOUR: 4,
      ADDITIONAL_SERVICE: 5,
      MODIFIED_SERVICE: 6,
      OTHER_EFFECT: 7,
      UNKNOWN_EFFECT: 8,
      STOP_MOVED: 9,
      NO_EFFECT: 10,
      ACCESSIBILITY_ISSUE: 11,
    }),
    SeverityLevel: Object.freeze({
      UNKNOWN_SEVERITY: 1,
      INFO: 2,
      WARNING: 3,
      SEVERE: 4,
    }),
  }),
})

function message(pbf, reader, initial) {
  return pbf.readMessage(reader, initial)
}

function readTranslation(tag, result, pbf) {
  if (tag === 1) result.text = pbf.readString()
  else if (tag === 2) result.language = pbf.readString()
}

function readTranslatedString(tag, result, pbf) {
  if (tag === 1) result.translation.push(message(pbf, readTranslation, {}))
}

function translatedString(pbf) {
  return message(pbf, readTranslatedString, { translation: [] })
}

function readTimeRange(tag, result, pbf) {
  if (tag === 1) result.start = pbf.readVarint()
  else if (tag === 2) result.end = pbf.readVarint()
}

function readTripDescriptor(tag, result, pbf) {
  if (tag === 1) result.tripId = pbf.readString()
  else if (tag === 5) result.routeId = pbf.readString()
  else if (tag === 6) result.directionId = pbf.readVarint()
  else if (tag === 2) result.startTime = pbf.readString()
  else if (tag === 3) result.startDate = pbf.readString()
  else if (tag === 4) result.scheduleRelationship = pbf.readVarint()
}

function tripDescriptor(pbf) {
  return message(pbf, readTripDescriptor, {})
}

function readVehicleDescriptor(tag, result, pbf) {
  if (tag === 1) result.id = pbf.readString()
  else if (tag === 2) result.label = pbf.readString()
  else if (tag === 3) result.licensePlate = pbf.readString()
  else if (tag === 4) result.wheelchairAccessible = pbf.readVarint()
}

function vehicleDescriptor(pbf) {
  return message(pbf, readVehicleDescriptor, {})
}

function readPosition(tag, result, pbf) {
  if (tag === 1) result.latitude = pbf.readFloat()
  else if (tag === 2) result.longitude = pbf.readFloat()
  else if (tag === 3) result.bearing = pbf.readFloat()
  else if (tag === 4) result.odometer = pbf.readDouble()
  else if (tag === 5) result.speed = pbf.readFloat()
}

function readCarriage(tag, result, pbf) {
  if (tag === 1) result.id = pbf.readString()
  else if (tag === 2) result.label = pbf.readString()
  else if (tag === 3) result.occupancyStatus = pbf.readVarint()
  else if (tag === 4) result.occupancyPercentage = pbf.readVarint(true)
  else if (tag === 5) result.carriageSequence = pbf.readVarint()
}

function readVehiclePosition(tag, result, pbf) {
  if (tag === 1) result.trip = tripDescriptor(pbf)
  else if (tag === 8) result.vehicle = vehicleDescriptor(pbf)
  else if (tag === 2) result.position = message(pbf, readPosition, {})
  else if (tag === 3) result.currentStopSequence = pbf.readVarint()
  else if (tag === 7) result.stopId = pbf.readString()
  else if (tag === 4) result.currentStatus = pbf.readVarint()
  else if (tag === 5) result.timestamp = pbf.readVarint()
  else if (tag === 6) result.congestionLevel = pbf.readVarint()
  else if (tag === 9) result.occupancyStatus = pbf.readVarint()
  else if (tag === 10) result.occupancyPercentage = pbf.readVarint()
  else if (tag === 11) (result.multiCarriageDetails ??= []).push(message(pbf, readCarriage, {}))
}

function readStopTimeEvent(tag, result, pbf) {
  if (tag === 1) result.delay = pbf.readVarint(true)
  else if (tag === 2) result.time = pbf.readVarint(true)
  else if (tag === 3) result.uncertainty = pbf.readVarint(true)
  else if (tag === 4) result.scheduledTime = pbf.readVarint(true)
}

function readStopTimeUpdate(tag, result, pbf) {
  if (tag === 1) result.stopSequence = pbf.readVarint()
  else if (tag === 2) result.arrival = message(pbf, readStopTimeEvent, {})
  else if (tag === 3) result.departure = message(pbf, readStopTimeEvent, {})
  else if (tag === 4) result.stopId = pbf.readString()
  else if (tag === 5) result.scheduleRelationship = pbf.readVarint()
}

function readTripUpdate(tag, result, pbf) {
  if (tag === 1) result.trip = tripDescriptor(pbf)
  else if (tag === 2) result.stopTimeUpdate.push(message(pbf, readStopTimeUpdate, {}))
  else if (tag === 3) result.vehicle = vehicleDescriptor(pbf)
  else if (tag === 4) result.timestamp = pbf.readVarint()
  else if (tag === 5) result.delay = pbf.readVarint(true)
}

function readEntitySelector(tag, result, pbf) {
  if (tag === 1) result.agencyId = pbf.readString()
  else if (tag === 2) result.routeId = pbf.readString()
  else if (tag === 3) result.routeType = pbf.readVarint(true)
  else if (tag === 4) result.trip = tripDescriptor(pbf)
  else if (tag === 5) result.stopId = pbf.readString()
  else if (tag === 6) result.directionId = pbf.readVarint()
}

function readAlert(tag, result, pbf) {
  if (tag === 1) result.activePeriod.push(message(pbf, readTimeRange, {}))
  else if (tag === 5) result.informedEntity.push(message(pbf, readEntitySelector, {}))
  else if (tag === 6) result.cause = pbf.readVarint()
  else if (tag === 7) result.effect = pbf.readVarint()
  else if (tag === 8) result.url = translatedString(pbf)
  else if (tag === 10) result.headerText = translatedString(pbf)
  else if (tag === 11) result.descriptionText = translatedString(pbf)
  else if (tag === 14) result.severityLevel = pbf.readVarint()
}

function readFeedEntity(tag, result, pbf) {
  if (tag === 1) result.id = pbf.readString()
  else if (tag === 2) result.isDeleted = pbf.readBoolean()
  else if (tag === 3) result.tripUpdate = message(pbf, readTripUpdate, { stopTimeUpdate: [] })
  else if (tag === 4) result.vehicle = message(pbf, readVehiclePosition, {})
  else if (tag === 5) result.alert = message(pbf, readAlert, { activePeriod: [], informedEntity: [] })
}

function readFeedHeader(tag, result, pbf) {
  if (tag === 1) result.gtfsRealtimeVersion = pbf.readString()
  else if (tag === 2) result.incrementality = pbf.readVarint()
  else if (tag === 3) result.timestamp = pbf.readVarint()
  else if (tag === 4) result.feedVersion = pbf.readString()
}

function readFeedMessage(tag, result, pbf) {
  if (tag === 1) result.header = message(pbf, readFeedHeader, {})
  else if (tag === 2) result.entity.push(message(pbf, readFeedEntity, {}))
}

export function decodeGtfsRealtimeFeed(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const feed = new PbfReader(input).readFields(readFeedMessage, { entity: [] })
  if (!feed.header?.gtfsRealtimeVersion) {
    throw new Error('missing required FeedHeader.gtfs_realtime_version')
  }
  if (feed.header.incrementality === gtfsRealtimeEnums.FeedHeader.Incrementality.DIFFERENTIAL) {
    throw new Error('unsupported GTFS-Realtime DIFFERENTIAL incrementality; configure a FULL_DATASET feed')
  }
  return feed
}
