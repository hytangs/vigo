import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  buildRoutingStoreFromSchedules, disposeNationalGtfsStore, prepareNationalGtfsRoutingContext,
  routeNationalGtfsStore, routeNationalGtfsDepartureWindow, routeNationalGtfsMatrix,
  ensureNationalGtfsOsmStopTransfers, prepareNationalGtfsNativeCoordinateAccess,
} from '../src/server/national-gtfs-store.mjs'
import { buildNationalOsmWalkStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore,
  prepareNationalOsmNativeStore } from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { finalizeCurrentStreetFixture } from './helpers/street-fixture.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-transfer-selection-'))
const storePath = path.join(folder, 'routing.sqlite')
const schedulePath = path.join(folder, 'schedule.json')
const osmStorePath = path.join(folder, 'osm-transit.sqlite')
const bufferStorePath = path.join(folder, 'same-stop-buffer.sqlite')
const streetStorePath = path.join(folder, 'streets.sqlite')
const scope = 'selection'
const scoped = id => `${scope}\u001f${id}`
const stop = (id, lon, parentStationId, locationType = 0) => ({ id, name: id, lat: 0, lon, parentStationId, locationType })
const route = (id, calls) => ({ routeId: id, shortName: id, routeType: 1,
  scheduledTrips: [{ tripId: `${id}-trip`, serviceId: 'WK', serviceDays: ['weekday'],
    stopTimes: calls.map(([stopId, arrivalMinutes], sequence) => ({ stopId, sequence: sequence + 1, arrivalMinutes, departureMinutes: arrivalMinutes })) }] })
const point = (id, lon) => ({ coordinate: [lon, 0], label: id, source: 'stop', stopId: scoped(id) })
const request = {
  origin: point('O', 0), destination: point('D', .05), departMinutes: 590,
  serviceDate: '2026-07-15', serviceDay: 'weekday', maxWalkKm: .2, horizonMinutes: 120,
}
const rides = plan => plan.legs.filter(leg => leg.type === 'ride').map(leg => leg.routeShortName)
const selected = ['Red', 'Orange', 'Blue-later']
const shortcut = ['Red', 'Blue']
const schedule = {
  stops: [stop('O', 0), stop('A', .01, undefined, 1), stop('A1', .01, 'A'), stop('A2', .01, 'A'),
    stop('B', .014, undefined, 1), stop('B1', .014, 'B'), stop('B2', .014, 'B'), stop('D', .05)],
  transferRules: [
    { fromStopId: 'A1', toStopId: 'B1', transferType: 2, minTransferTimeSeconds: 120 },
    { fromStopId: 'A1', toStopId: 'A2', transferType: 2, minTransferTimeSeconds: 60 },
    { fromStopId: 'B2', toStopId: 'B1', transferType: 2, minTransferTimeSeconds: 60 },
  ],
  routes: [route('Red', [['O', 600], ['A1', 608]]), route('Blue', [['B1', 611], ['D', 620]]),
    route('Orange', [['A2', 612], ['B2', 622]]), route('Blue-later', [['B1', 626], ['D', 636]])],
}

try {
  await fs.writeFile(schedulePath, JSON.stringify(schedule))
  await buildRoutingStoreFromSchedules({ schedules: [{ feedId: scope, schedulePath }], outputPath: storePath })
  const defaultPlan = routeNationalGtfsStore(storePath, request)
  assert.equal(defaultPlan.status, 'ready')
  assert.deepEqual(rides(defaultPlan), shortcut)
  assert.equal(defaultPlan.arriveMinutes, 620)
  const stationOnly = { ...request, allowStreetTransfers: false }
  for (const routingPreference of ['fastest', 'balanced']) {
    const plan = routeNationalGtfsStore(storePath, { ...stationOnly, routingPreference })
    assert.equal(plan.status, 'ready', plan.detail)
    assert.deepEqual(rides(plan), selected, 'Search must find the slower route through station connections instead of hiding the shortcut after selection.')
    assert.equal(plan.arriveMinutes, 636)
    assert.equal(plan.diagnostics.routingDataProvenance.searchParameters.allowStreetTransfers, false)
    assert(plan.legs.some(leg => leg.stationAccessStatus === 'unverified'), 'The choice must not certify assumed station paths.')
    assert.notEqual(plan.diagnostics.routingDataProvenance.reproducibilityKey,
      defaultPlan.diagnostics.routingDataProvenance.reproducibilityKey)
  }
  const reopened = routeNationalGtfsStore(storePath, { ...request, allowStreetTransfers: true })
  assert.deepEqual(rides(reopened), shortcut, 'Restricted requests cannot mutate the resident source timetable.')

  const window = routeNationalGtfsDepartureWindow(storePath, { ...stationOnly, departureWindowMinutes: 10, departureWindowDirection: 'forward' })
  assert(window.choices.length > 0)
  for (const plan of window.choices.filter(plan => plan.status === 'ready')) assert.deepEqual(rides(plan), selected)
  const arrive = routeNationalGtfsStore(storePath, { ...stationOnly, timePreference: 'arrive', arriveMinutes: 640 })
  assert.equal(arrive.status, 'ready', arrive.detail)
  assert.deepEqual(rides(arrive), selected)
  const missedDeadline = routeNationalGtfsStore(storePath, { ...stationOnly, timePreference: 'arrive', arriveMinutes: 625 })
  assert.equal(missedDeadline.status, 'blocked', 'An unavailable restricted itinerary must remain blocked.')
  assert.deepEqual(rides(routeNationalGtfsStore(storePath, { ...request, timePreference: 'arrive', arriveMinutes: 625 })), shortcut)

  const realtimeSnapshot = { feedTimestamp: Math.floor(Date.now() / 1000),
    tripUpdates: [{ tripId: 'Red-trip', startDate: '20260715', delaySeconds: 30 }] }
  const live = routeNationalGtfsStore(storePath, { ...stationOnly, realtimeSnapshot })
  assert.equal(live.status, 'ready', live.detail)
  assert.deepEqual(rides(live), selected)
  assert.equal(live.diagnostics.realtimeRouting.appliedTrips, 1)
  assert.deepEqual(rides(routeNationalGtfsStore(storePath, { ...request, realtimeSnapshot })), shortcut)
  const liveArrive = routeNationalGtfsStore(storePath, { ...stationOnly, realtimeSnapshot, timePreference: 'arrive', arriveMinutes: 640 })
  assert.equal(liveArrive.status, 'ready', liveArrive.detail)
  assert.deepEqual(rides(liveArrive), selected)

  for (const allowStreetTransfers of [false, true, false]) {
    const matrix = routeNationalGtfsMatrix(storePath, { ...request, origins: [request.origin], destinations: [request.destination], allowStreetTransfers })
    assert.equal(matrix.rows[0].status, 'ready')
    assert.equal(matrix.rows[0].arriveMinutes, allowStreetTransfers ? 620 : 636)
  }
  assert.throws(() => routeNationalGtfsStore(storePath, { ...request, allowStreetTransfers: 'false' }), /allowStreetTransfers must be a boolean/)
  for (const minimumTransferBufferMinutes of [2, 3]) {
    const buffered = { ...stationOnly, minimumTransferBufferMinutes }
    for (const routingPreference of ['fastest', 'balanced']) {
      const plan = routeNationalGtfsStore(storePath, { ...buffered, routingPreference })
      assert.equal(plan.status, 'ready', plan.detail)
      assert.deepEqual(rides(plan), selected, 'Exact buffer equality must remain boardable.')
      assert.equal(plan.diagnostics.routingDataProvenance.searchParameters.minimumTransferBufferMinutes, minimumTransferBufferMinutes)
    }
    const reverse = routeNationalGtfsStore(storePath, { ...buffered, timePreference: 'arrive', arriveMinutes: 640 })
    assert.equal(reverse.status, 'ready', reverse.detail)
    assert.deepEqual(rides(reverse), selected)
    for (const timePreference of ['depart', 'arrive']) {
      for (const includeJourneys of [false, true]) {
        const matrix = routeNationalGtfsMatrix(storePath, { ...buffered, timePreference, arriveMinutes: 640,
          origins: [request.origin], destinations: [request.destination], includeJourneys })
        assert.equal(matrix.rows[0].status, 'ready')
        assert.equal(matrix.rows[0].arriveMinutes, timePreference === 'arrive' ? 640 : 636)
      }
    }
  }
  const missBuffer = { ...stationOnly, minimumTransferBufferMinutes: 4 }
  for (const timePreference of ['depart', 'arrive']) {
    assert.equal(routeNationalGtfsStore(storePath, { ...missBuffer, timePreference, arriveMinutes: 640 }).status, 'blocked')
    const matrix = routeNationalGtfsMatrix(storePath, { ...missBuffer, timePreference, arriveMinutes: 640,
      origins: [request.origin], destinations: [request.destination] })
    assert.equal(matrix.rows[0].status, 'blocked')
  }
  const streetBuffer = routeNationalGtfsStore(storePath, { ...request, minimumTransferBufferMinutes: 2 })
  assert.deepEqual(rides(streetBuffer), ['Red', 'Blue-later'], 'The buffer must be additional to the transfer walk, not a floor on its duration.')
  const bufferWindow = routeNationalGtfsDepartureWindow(storePath, { ...missBuffer, departureWindowMinutes: 10, departureWindowDirection: 'forward' })
  assert(bufferWindow.choices.every(plan => plan.status !== 'ready'))
  const delayedBuffer = routeNationalGtfsStore(storePath, { ...stationOnly, minimumTransferBufferMinutes: 3, realtimeSnapshot })
  assert.equal(delayedBuffer.status, 'blocked', 'A realtime delay can consume the remaining transfer buffer.')
  assert.deepEqual(rides(routeNationalGtfsStore(storePath, request)), shortcut, 'Buffer settings cannot mutate the default kernel.')
  for (const minimumTransferBufferMinutes of [-1, 1.5, '2', 61]) {
    assert.throws(() => routeNationalGtfsStore(storePath, { ...request, minimumTransferBufferMinutes }), /minimumTransferBufferMinutes must be an integer/)
  }


  // Reload from the immutable timetable snapshot and alternate choices again.
  disposeNationalGtfsStore(storePath)
  assert.equal(prepareNationalGtfsRoutingContext(storePath, request).activeServiceKernel.ready, true)
  assert.deepEqual(rides(routeNationalGtfsStore(storePath, stationOnly)), selected)
  assert.deepEqual(rides(routeNationalGtfsStore(storePath, request)), shortcut)


  // Keep source same-stop minimum, passenger-selected slack and onboard
  // continuation separate. A 60-minute buffer still permits first boarding.
  const sameStopSchedule = {
    stops: [stop('O', 0), stop('X', .1), stop('D', .2)],
    transferRules: [{ fromStopId: 'X', toStopId: 'X', transferType: 2, minTransferTimeSeconds: 60 }],
    routes: [route('Through', [['O', 600], ['X', 604], ['D', 630]]),
      route('Early', [['X', 606], ['D', 610]]), route('Exact', [['X', 607], ['D', 615]])],
  }
  await fs.writeFile(schedulePath, JSON.stringify(sameStopSchedule))
  await buildRoutingStoreFromSchedules({ schedules: [{ feedId: scope, schedulePath }], outputPath: bufferStorePath })
  const sameStopRequest = { ...request, departMinutes: 600, destination: point('D', .2) }
  for (const [minimumTransferBufferMinutes, expectedRides, arrival] of [
    [0, ['Through', 'Early'], 610], [2, ['Through', 'Exact'], 615],
    [3, ['Through'], 630], [60, ['Through'], 630],
  ]) {
    for (const routingPreference of ['fastest', 'balanced']) {
      const plan = routeNationalGtfsStore(bufferStorePath, { ...sameStopRequest, minimumTransferBufferMinutes, routingPreference })
      assert.equal(plan.status, 'ready', plan.detail)
      assert.deepEqual(rides(plan), expectedRides)
      assert.equal(plan.arriveMinutes, arrival)
    }
    const reverse = routeNationalGtfsStore(bufferStorePath, { ...sameStopRequest, minimumTransferBufferMinutes,
      timePreference: 'arrive', arriveMinutes: arrival })
    assert.equal(reverse.status, 'ready', reverse.detail)
    assert.deepEqual(rides(reverse), expectedRides)
    assert.equal(reverse.departMinutes, 600)
  }
  assert.equal(routeNationalGtfsStore(bufferStorePath, { ...sameStopRequest, destination: point('X', .1),
    minimumTransferBufferMinutes: 60 }).arriveMinutes, 604)

  const osmSchedule = structuredClone(schedule)
  osmSchedule.transferRules.shift()
  osmSchedule.routes[1] = route('Blue', [['B1', 617], ['D', 626]])
  await fs.writeFile(schedulePath, JSON.stringify(osmSchedule))
  await buildRoutingStoreFromSchedules({ schedules: [{ feedId: scope, schedulePath }], outputPath: osmStorePath })
  const street = new DatabaseSync(streetStorePath)
  street.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v4"'), ('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES (1,0,0), (2,0,.0001), (3,0,.01), (4,0,.014), (5,0,.05), (6,0,.0501);
    INSERT INTO edges VALUES (1,2,11,1), (2,1,11,1), (3,4,445,2), (4,3,445,2), (5,6,11,3), (6,5,11,3);
  `)
  finalizeCurrentStreetFixture(street)
  street.close()
  assert.equal(buildNationalOsmWalkStore(streetStorePath, { force: true, persist: true }).ready, true)
  compactNationalOsmRuntimeStore(streetStorePath)
  disposeNationalOsmStore(streetStorePath)
  assert.equal(prepareNationalOsmNativeStore(streetStorePath).ready, true)
  buildNativeStreetCchIndex(streetStorePath)
  const graph = await ensureNationalGtfsOsmStopTransfers(osmStorePath, streetStorePath)
  assert(graph.edgeCount > 0, 'The fixture must generate street transfer edges, not rely on a published cross-station rule.')
  prepareNationalGtfsRoutingContext(osmStorePath, request)
  prepareNationalGtfsNativeCoordinateAccess(osmStorePath, streetStorePath)
  const mapRequest = { ...request, streetStorePath,
    origin: { coordinate: [.00001, 0], label: 'Origin', source: 'map' },
    destination: { coordinate: [.05001, 0], label: 'Destination', source: 'map' } }
  for (const allowStreetTransfers of [true, false, true]) {
    const plan = routeNationalGtfsStore(osmStorePath, { ...mapRequest, allowStreetTransfers })
    assert.equal(plan.status, 'ready', plan.detail)
    assert.deepEqual(rides(plan), allowStreetTransfers ? shortcut : selected,
      'Fused map-point queries must apply the same selection to generated street connections.')
  }
  const mapArrive = routeNationalGtfsStore(osmStorePath, { ...mapRequest, allowStreetTransfers: false,
    timePreference: 'arrive', arriveMinutes: 640 })
  assert.equal(mapArrive.status, 'ready', mapArrive.detail)
  assert.deepEqual(rides(mapArrive), selected)
  const mapBuffered = { ...mapRequest, allowStreetTransfers: false, minimumTransferBufferMinutes: 3 }
  assert.deepEqual(rides(routeNationalGtfsStore(osmStorePath, mapBuffered)), selected)
  assert.equal(routeNationalGtfsStore(osmStorePath, { ...mapBuffered, minimumTransferBufferMinutes: 4 }).status, 'blocked')
  const mapBufferArrive = routeNationalGtfsStore(osmStorePath, { ...mapBuffered, timePreference: 'arrive', arriveMinutes: 640 })
  assert.equal(mapBufferArrive.status, 'ready', mapBufferArrive.detail)
  assert.deepEqual(rides(mapBufferArrive), selected)
  for (const timePreference of ['depart', 'arrive']) {
    for (const minimumTransferBufferMinutes of [3, 4]) {
      const matrix = routeNationalGtfsMatrix(osmStorePath, { ...mapBuffered, timePreference, arriveMinutes: 640,
        minimumTransferBufferMinutes, origins: [mapRequest.origin], destinations: [mapRequest.destination] })
      assert.equal(matrix.rows[0].status, minimumTransferBufferMinutes === 3 ? 'ready' : 'blocked')
    }
  }

  console.log('Street transfer selection and minimum buffer passed: alternative search, toggling, provenance, windows, arrive-by, realtime, matrices, persisted reload and fused map-point routing with generated street transfers.')
} finally {
  disposeNationalGtfsStore(storePath)
  disposeNationalGtfsStore(osmStorePath)
  disposeNationalGtfsStore(bufferStorePath)
  disposeNationalOsmStore(streetStorePath)
  await fs.rm(folder, { recursive: true, force: true })
}
