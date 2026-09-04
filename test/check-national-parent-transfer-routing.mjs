import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildRoutingStoreFromSchedules,
  prepareNationalGtfsRoutingContext,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-parent-transfer-'))
const schedulePath = path.join(folder, 'schedule.json')
const storePath = path.join(folder, 'routing.sqlite')
const scope = 'parent-transfer'
const scoped = (id) => `${scope}\u001f${id}`

const schedule = {
  stops: [
    { id: 'O', name: 'Origin platform', lat: 0, lon: 0 },
    { id: 'RAIL', name: 'Central rail station', lat: 0, lon: 0.01, locationType: 1 },
    { id: 'RP1', name: 'Central rail station', lat: 0, lon: 0.01, parentStationId: 'RAIL' },
    { id: 'RP2', name: 'Central rail station', lat: 0, lon: 0.01, parentStationId: 'RAIL' },
    { id: 'BUS', name: 'Central station bus bays', lat: 0, lon: 0.013, locationType: 1 },
    { id: 'BP', name: 'Central station bus bays', lat: 0, lon: 0.013, parentStationId: 'BUS' },
    { id: 'NID', name: 'Downstream station', lat: 0, lon: 0.02, locationType: 1 },
    { id: 'NP', name: 'Downstream station', lat: 0, lon: 0.02, parentStationId: 'NID' },
    { id: 'NBP', name: 'Downstream station', lat: 0, lon: 0.02, parentStationId: 'NID' },
    { id: 'D', name: 'Destination', lat: 0, lon: 0.03 },
  ],
  transferRules: [
    { fromStopId: 'RAIL', toStopId: 'BUS', transferType: 2, minTransferTimeSeconds: 300 },
    { fromStopId: 'BUS', toStopId: 'RAIL', transferType: 2, minTransferTimeSeconds: 300 },
  ],
  routes: [{
    routeId: 'IC', shortName: 'IC', longName: 'Feeder train', routeType: 2,
    scheduledTrips: [{
      tripId: 'IC-trip', serviceId: 'WK', serviceDays: ['weekday'],
      stopTimes: [
        { stopId: 'O', sequence: 1, arrivalMinutes: 590, departureMinutes: 590 },
        { stopId: 'RP1', sequence: 2, arrivalMinutes: 600, departureMinutes: 600 },
      ],
    }],
  }, {
    routeId: 'S37', shortName: 'S37', longName: 'Downstream detour', routeType: 2,
    scheduledTrips: [{
      tripId: 'S37-trip', serviceId: 'WK', serviceDays: ['weekday'],
      stopTimes: [
        { stopId: 'RP2', sequence: 1, arrivalMinutes: 602, departureMinutes: 602 },
        { stopId: 'NP', sequence: 2, arrivalMinutes: 604, departureMinutes: 604 },
      ],
    }],
  }, {
    routeId: '6', shortName: '6', longName: 'Through bus', routeType: 3,
    scheduledTrips: [{
      tripId: '6-trip', serviceId: 'WK', serviceDays: ['weekday'],
      stopTimes: [
        { stopId: 'BP', sequence: 1, arrivalMinutes: 605, departureMinutes: 605 },
        { stopId: 'NBP', sequence: 2, arrivalMinutes: 610, departureMinutes: 610 },
        { stopId: 'D', sequence: 3, arrivalMinutes: 620, departureMinutes: 620 },
      ],
    }],
  }],
}

try {
  await fs.writeFile(schedulePath, `${JSON.stringify(schedule)}\n`)
  await buildRoutingStoreFromSchedules({
    schedules: [{ feedId: scope, schedulePath }],
    outputPath: storePath,
  })

  const plan = routeNationalGtfsStore(storePath, {
    origin: { coordinate: [0, 0], label: 'Origin', source: 'stop', stopId: scoped('O') },
    destination: { coordinate: [0.03, 0], label: 'Destination', source: 'stop', stopId: scoped('D') },
    departMinutes: 580,
    serviceDate: '2026-07-15',
    serviceDay: 'weekday',
    maxWalkKm: 1.2,
    horizonMinutes: 120,
  })

  assert.equal(plan.status, 'ready')
  const rides = plan.legs.filter((leg) => leg.type === 'ride')
  assert.deepEqual(rides.map((leg) => leg.routeShortName), ['IC', '6'],
    'A parent-station transfer must board route 6 at the first station instead of taking S37 downstream to chase the same trip.')
  assert.equal(rides[1].fromStopId, scoped('BP'))
  assert.equal(plan.transfers, 1)
  assert.equal(plan.arriveMinutes, 620)

  const prepared = prepareNationalGtfsRoutingContext(storePath, {
    serviceDate: '2026-07-15',
    serviceDay: 'weekday',
  })
  assert.equal(prepared.activeServiceKernel.ready, true)
  const activeKernelPlan = routeNationalGtfsStore(storePath, {
    origin: { coordinate: [0, 0], label: 'Origin', source: 'stop', stopId: scoped('O') },
    destination: { coordinate: [0.03, 0], label: 'Destination', source: 'stop', stopId: scoped('D') },
    departMinutes: 580,
    serviceDate: '2026-07-15',
    serviceDay: 'weekday',
    maxWalkKm: 1.2,
    horizonMinutes: 120,
  })
  const activeKernelRides = activeKernelPlan.legs.filter((leg) => leg.type === 'ride')
  assert.deepEqual(activeKernelRides.map((leg) => leg.routeShortName), ['IC', '6'],
    'Equal-arrival active-kernel labels must prefer the fewer-boarding direct transfer over a downstream catch-up detour.')
  assert.equal(activeKernelPlan.transfers, 1)

  console.log(JSON.stringify({
    schemaVersion: 'vigo.national.parent-transfer-routing.check.v1',
    status: 'passed',
    route: rides.map((leg) => leg.routeShortName),
    busBoardingStopId: rides[1].fromStopId,
    arriveMinutes: plan.arriveMinutes,
    transfers: plan.transfers,
    activeKernelRoute: activeKernelRides.map((leg) => leg.routeShortName),
  }, null, 2))
} finally {
  await fs.rm(folder, { recursive: true, force: true })
}
