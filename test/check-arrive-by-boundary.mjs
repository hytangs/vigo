import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildRoutingStoreFromSchedules, disposeNationalGtfsStore, routeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { recoverNativeArriveByBoundary } from '../src/server/gtfs/arrive-by-reconstruction.mjs'

const { TimetableKernel } = createRequire(import.meta.url)('../native/vigo-routing-kernel/vigo-routing-kernel.node')
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-arrive-boundary-'))
const storePath = path.join(folder, 'routing.sqlite'), schedulePath = path.join(folder, 'schedule.json')
const point = (stopId, coordinate) => ({ source: 'stop', stopId: `boundary\u001f${stopId}`, label: stopId, coordinate })
const query = {
  origin: point('O', [0, 0]), destination: point('D', [0.03, 0]),
  serviceDate: '2026-07-15', serviceDay: 'weekday', timePreference: 'arrive',
  arriveMinutes: 490, horizonMinutes: 30, maxWalkKm: 0.2, maxTransfers: 1,
  requireTransitRide: true, disableCache: true,
}
const trips = [['EARLY', 480, 485], ['LATEST', 485, 490]]
const originalScalar = TimetableKernel.prototype.routeScalarCsa
let failures = 0
const calls = []
try {
  await fs.writeFile(schedulePath, JSON.stringify({
    stops: [{ id: 'O', name: 'O', lat: 0, lon: 0 }, { id: 'D', name: 'D', lat: 0, lon: 0.03 }],
    routes: trips.map(([tripId, departure, arrival]) => ({
      routeId: tripId, shortName: tripId, routeType: 3, scheduledTrips: [{
        tripId, serviceId: 'WK', serviceDays: ['weekday'], stopTimes: [
          { stopId: 'O', sequence: 1, arrivalMinutes: departure, departureMinutes: departure },
          { stopId: 'D', sequence: 2, arrivalMinutes: arrival, departureMinutes: arrival },
        ],
      }],
    })),
  }) + '\n')
  await buildRoutingStoreFromSchedules({ schedules: [{ feedId: 'boundary', schedulePath }], outputPath: storePath })
  const forward = routeNationalGtfsStore(storePath, { ...query, timePreference: 'depart', departMinutes: 485 })
  assert.equal(forward.arriveMinutes, 490, 'Independent forward witness proves the later departure feasible')
  assert.equal(routeNationalGtfsStore(storePath, query).departMinutes, 485)
  // QA-only native presentation rejection. Reverse scanning runs inside Rust
  // and is unaffected by this JavaScript forward-result injection.
  TimetableKernel.prototype.routeScalarCsa = function (input) {
    calls.push(input.departure)
    const result = originalScalar.call(this, input)
    if (failures > 0) {
      failures -= 1
      result.status = 'blocked'
      result.bestArrival = undefined
    }
    return result
  }
  failures = 1
  const recovered = routeNationalGtfsStore(storePath, query)
  assert.equal(recovered.departMinutes, 485, 'A presentation failure must not downgrade latest departure to 480')
  assert.deepEqual(recovered.legs.filter(leg => leg.type === 'ride').map(leg => leg.tripId), ['boundary\u001fLATEST'])
  assert.equal(recovered.diagnostics.searchStats.arriveByForwardParityRecovery.outcome, 'same_boundary_forward_witness')
  assert.deepEqual(calls, [485 * 60, 485 * 60], 'Both materializations retain the exact reverse boundary')
  calls.length = 0
  failures = 2
  assert.throws(() => routeNationalGtfsStore(storePath, query), error => (
    error.code === 'native_arrive_by_materialization_mismatch' && error.nativeLatestDeparture === 485 * 60
  ), 'Persistent inconsistency must be exposed instead of returning an earlier certified departure')
  assert.deepEqual(calls, [485 * 60, 485 * 60])

  // A direct walk has its own exact deadline-relative witness. It may only
  // replace the rejected transit witness when its departure is at least as late.
  for (const departureSeconds of [485 * 60, 486 * 60]) {
    const walk = { departureSeconds, plan: { travelMode: 'walk' } }
    const result = recoverNativeArriveByBoundary({ latestDepartureSeconds: 485 * 60,
      prepareCompleteAccess() {}, materializeAtBoundary: () => null, dominatingDirectWalk: () => walk })
    assert.equal(result.departureSeconds, departureSeconds)
    assert.equal(result.plan.travelMode, 'walk')
  }
  assert.throws(() => recoverNativeArriveByBoundary({ latestDepartureSeconds: 485 * 60,
    prepareCompleteAccess() {}, materializeAtBoundary: () => null,
    dominatingDirectWalk: () => ({ departureSeconds: 484 * 60, plan: { travelMode: 'walk' } }),
  }), error => error.code === 'native_arrive_by_materialization_mismatch')
  console.log('Arrive-by same-boundary reconstruction, persistent-error guard and independent direct-walk bound passed.')
} finally {
  TimetableKernel.prototype.routeScalarCsa = originalScalar
  disposeNationalGtfsStore(storePath)
  await fs.rm(folder, { recursive: true, force: true })
}
