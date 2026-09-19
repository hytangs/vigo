import assert from 'node:assert/strict'
import { PbfWriter } from 'pbf'
import { decodeGtfsRealtimeFeed, gtfsRealtimeEnums } from '../src/server/gtfs-realtime-decoder.mjs'

function writeHeader(value, pbf) {
  pbf.writeStringField(1, value.version)
  pbf.writeVarintField(2, value.incrementality)
  pbf.writeVarintField(3, value.timestamp)
  pbf.writeStringField(4, value.feedVersion)
}

function writeTrip(value, pbf) {
  pbf.writeStringField(1, value.tripId)
  pbf.writeStringField(5, value.routeId)
  pbf.writeVarintField(4, value.scheduleRelationship)
}

function writeVehicleDescriptor(value, pbf) {
  pbf.writeStringField(1, value.id)
  pbf.writeStringField(2, value.label)
}

function writePosition(value, pbf) {
  pbf.writeFloatField(1, value.latitude)
  pbf.writeFloatField(2, value.longitude)
  pbf.writeFloatField(3, value.bearing)
  pbf.writeFloatField(5, value.speed)
}

function writeVehicle(value, pbf) {
  pbf.writeMessage(1, writeTrip, value.trip)
  pbf.writeMessage(2, writePosition, value.position)
  pbf.writeVarintField(4, value.currentStatus)
  pbf.writeVarintField(5, value.timestamp)
  pbf.writeStringField(7, value.stopId)
  pbf.writeMessage(8, writeVehicleDescriptor, value.vehicle)
  pbf.writeVarintField(9, value.occupancyStatus)
  pbf.writeVarintField(10, value.occupancyPercentage)
  pbf.writeMessage(11, (_, car) => {
    car.writeStringField(2, '1462')
    car.writeVarintField(3, 2)
    car.writeVarintField(4, -1)
    car.writeVarintField(5, 1)
  }, {})
}

function writeStopTimeEvent(value, pbf) {
  pbf.writeVarintField(1, value.delay)
  pbf.writeVarintField(2, value.time)
}

function writeStopTimeUpdate(value, pbf) {
  pbf.writeVarintField(1, value.stopSequence)
  pbf.writeMessage(2, writeStopTimeEvent, value.arrival)
  pbf.writeMessage(3, writeStopTimeEvent, value.departure)
  pbf.writeStringField(4, value.stopId)
  pbf.writeVarintField(5, value.scheduleRelationship)
}

function writeTripUpdate(value, pbf) {
  pbf.writeMessage(1, writeTrip, value.trip)
  pbf.writeMessage(2, writeStopTimeUpdate, value.stopTimeUpdate)
  pbf.writeVarintField(4, value.timestamp)
  pbf.writeVarintField(5, value.delay)
}

function writeTranslation(value, pbf) {
  pbf.writeStringField(1, value.text)
  pbf.writeStringField(2, value.language)
}

function writeTranslatedString(value, pbf) {
  pbf.writeMessage(1, writeTranslation, value)
}

function writeTimeRange(value, pbf) {
  pbf.writeVarintField(1, value.start)
  pbf.writeVarintField(2, value.end)
}

function writeSelector(value, pbf) {
  pbf.writeStringField(2, value.routeId)
  pbf.writeStringField(5, value.stopId)
}

function writeAlert(value, pbf) {
  pbf.writeMessage(1, writeTimeRange, value.activePeriod)
  pbf.writeMessage(5, writeSelector, value.selector)
  pbf.writeVarintField(6, value.cause)
  pbf.writeVarintField(7, value.effect)
  pbf.writeMessage(10, writeTranslatedString, value.header)
  pbf.writeMessage(11, writeTranslatedString, value.description)
  pbf.writeVarintField(14, value.severity)
}

function writeEntity(value, pbf) {
  pbf.writeStringField(1, value.id)
  if (value.tripUpdate) pbf.writeMessage(3, writeTripUpdate, value.tripUpdate)
  if (value.vehicle) pbf.writeMessage(4, writeVehicle, value.vehicle)
  if (value.alert) pbf.writeMessage(5, writeAlert, value.alert)
}

const trip = {
  tripId: 'trip-7',
  routeId: 'route-A',
  scheduleRelationship: gtfsRealtimeEnums.TripDescriptor.ScheduleRelationship.SCHEDULED,
}
const writer = new PbfWriter()
writer.writeMessage(1, writeHeader, {
  version: '2.0',
  incrementality: gtfsRealtimeEnums.FeedHeader.Incrementality.FULL_DATASET,
  timestamp: 1_700_000_000,
  feedVersion: 'fixture-1',
})
writer.writeMessage(2, writeEntity, {
  id: 'vehicle-entity',
  vehicle: {
    trip,
    position: { latitude: 42.355, longitude: -71.06, bearing: 90, speed: 8.5 },
    currentStatus: gtfsRealtimeEnums.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO,
    timestamp: 1_700_000_010,
    stopId: 'place-dwnxg',
    vehicle: { id: 'vehicle-7', label: '1707' },
    occupancyStatus: gtfsRealtimeEnums.VehiclePosition.OccupancyStatus.MANY_SEATS_AVAILABLE,
    occupancyPercentage: 24,
  },
})
writer.writeMessage(2, writeEntity, {
  id: 'trip-update-entity',
  tripUpdate: {
    trip,
    timestamp: 1_700_000_011,
    delay: -45,
    stopTimeUpdate: {
      stopSequence: 8,
      stopId: 'place-pktrm',
      arrival: { delay: 75 },
      departure: { time: 1_700_001_311 },
      scheduleRelationship: gtfsRealtimeEnums.StopTimeUpdate.ScheduleRelationship.SCHEDULED,
    },
  },
})
writer.writeMessage(2, writeEntity, {
  id: 'alert-entity',
  alert: {
    activePeriod: { start: 1_700_000_000, end: 1_700_003_600 },
    selector: { routeId: 'route-A', stopId: 'place-dwnxg' },
    cause: gtfsRealtimeEnums.Alert.Cause.MAINTENANCE,
    effect: gtfsRealtimeEnums.Alert.Effect.REDUCED_SERVICE,
    severity: gtfsRealtimeEnums.Alert.SeverityLevel.WARNING,
    header: { text: 'Service change', language: 'en' },
    description: { text: 'Use the adjacent platform.', language: 'en' },
  },
})

const feed = decodeGtfsRealtimeFeed(writer.finish())
assert.equal(feed.header.gtfsRealtimeVersion, '2.0')
assert.equal(feed.header.feedVersion, 'fixture-1')
assert.equal(feed.entity.length, 3)
assert.equal(feed.entity[0].vehicle.vehicle.id, 'vehicle-7')
assert.equal(feed.entity[0].vehicle.position.latitude.toFixed(3), '42.355')
assert.equal(feed.entity[1].tripUpdate.delay, -45)
assert.equal(feed.entity[1].tripUpdate.stopTimeUpdate[0].arrival.delay, 75)
assert.equal(feed.entity[1].tripUpdate.stopTimeUpdate[0].departure.time, 1_700_001_311)
assert.equal(
  feed.entity[1].tripUpdate.stopTimeUpdate[0].scheduleRelationship,
  gtfsRealtimeEnums.StopTimeUpdate.ScheduleRelationship.SCHEDULED,
)
assert.equal(feed.entity[2].alert.headerText.translation[0].text, 'Service change')
assert.deepEqual(feed.entity[2].alert.informedEntity[0], {
  routeId: 'route-A',
  stopId: 'place-dwnxg',
})
assert.throws(
  () => decodeGtfsRealtimeFeed(new Uint8Array()),
  /missing required FeedHeader/,
)

const differentialWriter = new PbfWriter()
differentialWriter.writeMessage(1, writeHeader, {
  version: '2.0',
  incrementality: gtfsRealtimeEnums.FeedHeader.Incrementality.DIFFERENTIAL,
  timestamp: 1_700_000_000,
  feedVersion: 'fixture-differential',
})
assert.throws(
  () => decodeGtfsRealtimeFeed(differentialWriter.finish()),
  /unsupported GTFS-Realtime DIFFERENTIAL/,
)

console.log('GTFS-Realtime decoder check passed (full-dataset vehicle, trip update, alert, signed delay, required header, and differential rejection).')

assert.deepEqual(feed.entity.find(entity => entity.vehicle).vehicle.multiCarriageDetails, [{ label: '1462', occupancyStatus: 2, occupancyPercentage: -1, carriageSequence: 1 }])
