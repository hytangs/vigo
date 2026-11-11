import { buildScheduleFixture } from './helpers/schedule-fixture.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { disposeNationalGtfsStore, prepareNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { nationalRoutingAccessPolicy, nationalRoutingAccessPolicyIdentity, stationTransferDurationSeconds } from '../src/server/gtfs/routing-policy.mjs'
import { stableJson } from '../src/server/routing-plan-identity.mjs'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from '../src/server/routing-snapshot.mjs'
import { haversineKm } from '../src/server/geometry-utils.mjs'
import { prepareStationAccessPaths } from '../src/server/station-access.mjs'

const stops = [ { stop_id: 'A', lon: 0, lat: 0 }, { stop_id: 'B', lon: .003, lat: 0 } ]
const floor = Math.ceil(haversineKm([0, 0], [.003, 0]) / 4.8 * 3600)
assert.equal(floor, 251)
assert.equal(stationTransferDurationSeconds({ provenance: 'gtfs_transfer', min_transfer_time: 90 },
  { lon: null, lat: null }, { lon: 77, lat: 39 }), 90, 'Missing coordinates cannot become a fictitious walk from zero longitude/latitude.')
const store = { stationMembers: new Map(), forbiddenTransferPairs: new Set(), transfers: new Map([
  ['A', [{ to_stop_id: 'B', provenance: 'gtfs_transfer', transfer_type: 2, min_transfer_time: 90 }]],
]) }
const paths = prepareStationAccessPaths(store, stops)
assert.equal(paths.seconds[0], 251, 'The station-access graph must enforce the walking floor before selecting a platform.')
const pathway = prepareStationAccessPaths({ ...store, transfers: new Map([
  ['A', [{ to_stop_id: 'B', provenance: 'gtfs_pathway', min_transfer_time: 90, path_distance_m: 400 }]],
]) }, stops)
assert.equal(pathway.seconds[0], 90, 'A published pathway traversal time is distinct from a transfer minimum.')

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-transfer-floor-'))
const storePath = path.join(folder, 'routing.sqlite'), schedulePath = path.join(folder, 'schedule.json')
const scope = 'walking-floor', id = s => `${scope}\u001f${s}`
const coords = { O: [-.01, 0], A: [0, 0], B: [.003, 0], D: [.02, 0] }
const runs = [ ['EARLIER', 'O', 'A', 475, 476], ['FEED', 'O', 'A', 479, 480],
  ['TIGHT', 'B', 'D', 482, 486], ['LATER', 'B', 'D', 485, 490] ]
try {
  const schedule = { stops: Object.entries(coords).map(([id, [lon, lat]]) => ({ id, name: id, lon, lat })),
    transferRules: [{ fromStopId: 'A', toStopId: 'B', transferType: 2, minTransferTimeSeconds: 90 }],
    routes: runs.map(([tripId, from, to, departure, arrival]) => ({ routeId: tripId, shortName: tripId, routeType: 3,
      scheduledTrips: [{ tripId, serviceId: 'WK', serviceDays: ['weekday'], stopTimes: [
        { stopId: from, sequence: 1, arrivalMinutes: departure, departureMinutes: departure },
        { stopId: to, sequence: 2, arrivalMinutes: arrival, departureMinutes: arrival },
      ] }] })) }
  await fs.writeFile(schedulePath, JSON.stringify(schedule))
  await buildScheduleFixture({ schedules: [{ feedId: scope, schedulePath }], outputPath: storePath })
  const check = () => {
    for (const [timePreference, departure, arrival, trips] of [
      ['depart', 478, 490, ['FEED', 'LATER']], ['arrive', 475, 486, ['EARLIER', 'TIGHT']],
    ]) {
    }
    prepareNationalGtfsStore(storePath)
  }
  check()
  disposeNationalGtfsStore(storePath)
  // Simulate the former v4 cache. It must not be reused after the code fix.
  const oldPolicy = { ...nationalRoutingAccessPolicy, schemaVersion: 'vigo.routing.access-policy.v4' }
  delete oldPolicy.transferWalkingTimeFloor
  for (const name of (await fs.readdir(folder)).filter(n => n.endsWith('.access-context.bin') || n.includes('.active-service-kernel.'))) {
    const file = path.join(folder, name), { metadata, arrays } = decodeRoutingSnapshot(await fs.readFile(file))
    if (metadata.materialized) {
      metadata.accessPolicyIdentity = stableJson(oldPolicy)
      for (const [from, edges] of metadata.materialized.transfers) for (const e of edges)
        if (from === id('A') && e.to_stop_id === id('B')) e.min_transfer_time = 90
    } else metadata.kernel.accessPolicyIdentity = stableJson(oldPolicy)
    await fs.writeFile(file, encodeRoutingSnapshot(metadata, arrays))
  }
  check()
  const saved = decodeRoutingSnapshot(await fs.readFile(`${storePath}.access-context.bin`))
  assert.equal(saved.metadata.accessPolicyIdentity, nationalRoutingAccessPolicyIdentity)
  console.log('Transfer walking floor: forward, arrive-by, scalar/journey matrices and stale v4 cache rejection passed.')
} finally {
  disposeNationalGtfsStore(storePath)
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
