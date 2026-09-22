import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import {
  buildNationalOsmStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import {
  buildNationalGtfsStore,
  disposeNationalGtfsStore,
  routeNationalGtfsDepartureWindow,
  routeNationalGtfsMatrix,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'

// Route's store orchestration over generated GTFS and the existing synthetic
// three-node OSM fixture. A timetable horizon bounds boarding and alighting;
// terminal walking after a legal exit may finish later. An arrival deadline,
// in contrast, bounds the complete journey including that final walk.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-route-horizon-'))
const streetStorePath = path.join(directory, 'street.sqlite')
const departureMinutes = 480
const horizonMinutes = 5
const timetableEnd = departureMinutes + horizonMinutes
const coordinates = {
  O: [-77.05, 38.9], X: [-77.08, 38.92], L: [-77.04, 38.905], D: [-77.03, 38.91],
}
const exactStop = (id) => ({ source: 'stop', stopId: id, label: id, coordinate: coordinates[id] })
const clock = (offsetSeconds) => {
  const seconds = departureMinutes * 60 + offsetSeconds
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0')).join(':')
}
const rides = (plan) => plan.legs.filter((leg) => leg.type === 'ride')
const tripIds = (plan) => rides(plan).map((leg) => leg.tripId)
const cases = []

function assertLegalExits(plan, upperBound, label) {
  assert.equal(plan.status, 'ready', label)
  assert(rides(plan).length > 0, `${label}: transit is required`)
  for (const ride of rides(plan)) {
    // Returned minute coordinates are rounded to three decimal places.
    assert(ride.startMinutes <= upperBound + 0.001, `${label}: boarded beyond the timetable horizon`)
    assert(ride.endMinutes <= upperBound + 0.001, `${label}: alighted beyond the timetable horizon`)
  }
}

async function createTimetable(directArrival, { terminalWalk = true } = {}) {
  const trips = [
    { id: 'LEG1', from: 'O', to: 'X', depart: 100, arrive: 150 },
    { id: 'LEG2', from: 'X', to: terminalWalk ? 'L' : 'D', depart: 160, arrive: 290 },
    ...(directArrival === null ? [] : [
      { id: 'DIRECT', from: 'O', to: 'D', depart: 100, arrive: directArrival },
    ]),
  ]
  const zip = new JSZip()
  const table = (name, header, rows) => zip.file(name, `${header}\n${rows.join('\n')}\n`, {
    date: new Date('2026-01-01T00:00:00Z'),
  })
  table('agency.txt', 'agency_name,agency_url,agency_timezone', ['Horizon Fixture,https://example.test,America/New_York'])
  table('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon',
    Object.entries(coordinates).map(([id, [lon, lat]]) => `${id},${id},${lat},${lon}`))
  table('routes.txt', 'route_id,route_short_name,route_type', trips.map(({ id }) => `${id},${id},3`))
  table('trips.txt', 'route_id,service_id,trip_id', trips.map(({ id }) => `${id},ACTIVE,${id}`))
  table('calendar_dates.txt', 'service_id,date,exception_type', ['ACTIVE,20260715,1'])
  table('stop_times.txt', 'trip_id,stop_id,stop_sequence,arrival_time,departure_time', trips.flatMap((trip) => [
    `${trip.id},${trip.from},1,${clock(trip.depart)},${clock(trip.depart)}`,
    `${trip.id},${trip.to},2,${clock(trip.arrive)},${clock(trip.arrive)}`,
  ]))
  const name = `${directArrival === null ? 'legal-only' : `direct-${directArrival}`}${terminalWalk ? '' : '-no-egress'}`
  const zipPath = path.join(directory, `${name}.zip`)
  const storePath = path.join(directory, `${name}.sqlite`)
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  return storePath
}

try {
  const { osmPath } = await writeCliFixtureInputs(directory)
  await buildNationalOsmStore({ pbfPath: osmPath, outputPath: streetStorePath })
  compactNationalOsmRuntimeStore(streetStorePath, { requireDrive: false })
  prepareNationalOsmNativeStore(streetStorePath)
  buildNativeStreetCchIndex(streetStorePath)
  const request = {
    origin: exactStop('O'),
    destination: { source: 'map', label: 'Destination', coordinate: coordinates.D },
    streetStorePath,
    serviceDate: '2026-07-15', serviceDay: 'weekday',
    departMinutes: departureMinutes, horizonMinutes, maxWalkKm: 1.2,
    requireTransitRide: true, routingPreference: 'fastest', disableCache: true,
  }
  let legalArrival
  for (const directArrival of [null, 300, 350, 390]) {
    const storePath = await createTimetable(directArrival)
    try {
      const directAdmitted = directArrival !== null && directArrival <= horizonMinutes * 60
      const expectedTrips = directAdmitted ? ['DIRECT'] : ['LEG1', 'LEG2']
      for (const maxTransfers of [undefined, 1]) {
        const query = { ...request, ...(maxTransfers === undefined ? {} : { maxTransfers }) }
        const label = `directArrival=${directArrival}, maxTransfers=${maxTransfers ?? 'unlimited'}`
        const fastest = routeNationalGtfsStore(storePath, query)
        assertLegalExits(fastest, timetableEnd, label)
        assert.deepEqual(tripIds(fastest), expectedTrips, `${label}: late alighting cannot replace a legal terminal walk`)
        if (!directAdmitted) {
          assert(fastest.arriveMinutes > timetableEnd, 'The final street walk may finish after the timetable horizon')
          const finalWalk = fastest.legs.at(-1)
          assert.equal(finalWalk.type, 'walk')
          assert(finalWalk.durationMinutes > 0 && finalWalk.distanceKm > 0)
          assert.equal(finalWalk.streetPathVerified, true, 'The permitted final walk must have an OSM path witness')
          legalArrival ??= fastest.arriveMinutes
          assert.equal(fastest.arriveMinutes, legalArrival, 'Adding inadmissible late rides must preserve the legal result')
        } else {
          assert.equal(fastest.arriveMinutes, timetableEnd, 'Alighting exactly at the horizon is permitted')
        }
        const matrix = routeNationalGtfsMatrix(storePath, {
          ...query, origins: [query.origin], destinations: [query.destination],
        })
        assert.equal(matrix.rows[0].status, 'ready')
        assert.equal(matrix.rows[0].arriveMinutes, fastest.arriveMinutes, `${label}: scalar Matrix and Route agree`)

        // A zero-width departure window invokes Route's alternative search
        // without changing the requested clock. Both presentation directions
        // must retain the same timetable boundary despite arrival slack.
        for (const departureWindowDirection of ['forward', 'centered']) {
          const window = routeNationalGtfsDepartureWindow(storePath, {
            ...query, departureWindowMinutes: 0, departureWindowDirection,
          })
          assert.equal(window.plan.arriveMinutes, fastest.arriveMinutes)
          assert.equal(window.choices.length, 1, 'Only the unique nondominated legal ride sequence remains')
          for (const choice of window.choices) {
            assertLegalExits(choice, timetableEnd, `${label}, alternatives ${departureWindowDirection}`)
            assert.deepEqual(tripIds(choice), expectedTrips)
          }
        }
        cases.push({ directArrival, maxTransfers: maxTransfers ?? null, arrival: fastest.arriveMinutes })
      }

      const noTransfer = routeNationalGtfsStore(storePath, { ...request, maxTransfers: 0 })
      assert.equal(noTransfer.status, directAdmitted ? 'ready' : 'blocked', 'A boarding cap cannot admit a late direct ride')

      // Moving the requested departure also moves the timetable horizon.
      // In DIRECT350, 08:01 can legally use a ride that 08:00 cannot, despite
      // both departures being early enough to catch the same first vehicle.
      for (const departureWindowDirection of ['forward', 'centered']) {
        const window = routeNationalGtfsDepartureWindow(storePath, {
          ...request, departureWindowMinutes: 1, departureWindowDirection,
        })
        assert(window.profile.plans.length > 1, 'This check needs distinct departure samples')
        for (const sample of window.profile.plans) {
          const expected = routeNationalGtfsStore(storePath, {
            ...request, departMinutes: sample.departMinutes,
          })
          const label = `directArrival=${directArrival}, ${departureWindowDirection} sample=${sample.departMinutes}`
          assert.equal(sample.status, expected.status, `${label}: each sample has its own horizon`)
          if (sample.status === 'ready') {
            assertLegalExits(sample, sample.departMinutes + horizonMinutes, label)
            assert.equal(sample.arriveMinutes, expected.arriveMinutes, `${label}: reused output must remain optimal`)
            assert.deepEqual(tripIds(sample), tripIds(expected), `${label}: sample parity`)
          }
        }
        for (const choice of window.choices.filter((plan) => plan.status === 'ready')) {
          assertLegalExits(choice, choice.departMinutes + horizonMinutes,
            `${departureWindowDirection}: a later sample cannot be relabeled to an earlier inadmissible horizon`)
        }
      }

      if (directArrival !== null) {
        const wider = routeNationalGtfsStore(storePath, { ...request, horizonMinutes: 10 })
        assert.deepEqual(tripIds(wider), ['DIRECT'], 'The same direct ride is legal under a wider timetable horizon')
        const restored = routeNationalGtfsStore(storePath, request)
        assert.deepEqual(tripIds(restored), expectedTrips, 'Restoring the horizon must not reuse the wider feasibility bound')
        const arriveBy = routeNationalGtfsStore(storePath, {
          ...request, timePreference: 'arrive', arriveMinutes: 488, horizonMinutes: 10, maxTransfers: 0,
        })
        assertLegalExits(arriveBy, 488, 'Arrival deadline')
        assert.deepEqual(tripIds(arriveBy), ['DIRECT'])
        assert(arriveBy.arriveMinutes <= 488, 'An arrive-by result must meet the complete-journey deadline')
      }
      const deadlineAtTimetableEnd = routeNationalGtfsStore(storePath, {
        ...request, timePreference: 'arrive', arriveMinutes: timetableEnd, horizonMinutes: 10,
      })
      assert.equal(deadlineAtTimetableEnd.status, directAdmitted ? 'ready' : 'blocked',
        'A legal 08:04:50 transit exit plus a late final walk cannot meet an 08:05 arrival deadline')
    } finally {
      disposeNationalGtfsStore(storePath)
    }
  }

  // Here the fastest journey already arrives inside the original horizon.
  // A later clock nevertheless admits a slower, lower-transfer alternative.
  // A reuse certificate based only on fastest arrival would lose that choice.
  const frontierStore = await createTimetable(350, { terminalWalk: false })
  try {
    const initial = routeNationalGtfsDepartureWindow(frontierStore, {
      ...request, departureWindowMinutes: 0,
    })
    assert(initial.plan.arriveMinutes < timetableEnd)
    assert.deepEqual(initial.choices.map(tripIds), [['LEG1', 'LEG2']])
    const shifted = routeNationalGtfsDepartureWindow(frontierStore, {
      ...request, departMinutes: 481, departureWindowMinutes: 0,
    })
    assert.deepEqual(shifted.choices.map(tripIds), [['LEG1', 'LEG2'], ['DIRECT']])
    for (const departureWindowDirection of ['forward', 'centered']) {
      const narrow = routeNationalGtfsDepartureWindow(frontierStore, {
        ...request, departureWindowMinutes: 1, departureWindowDirection,
      })
      assert(narrow.choices.some((plan) => tripIds(plan).join(',') === 'DIRECT'),
        `${departureWindowDirection}: moving the horizon must retain the newly legal lower-transfer alternative`)
      for (const choice of narrow.choices) {
        assertLegalExits(choice, choice.departMinutes + horizonMinutes,
          `${departureWindowDirection}: later alternatives retain a feasible physical departure`)
      }
      const wide = routeNationalGtfsDepartureWindow(frontierStore, {
        ...request, horizonMinutes: 30, departureWindowMinutes: 1, departureWindowDirection,
      })
      assert.equal(wide.profile.routeSearches, 1,
        'A horizon covering the entire arrival-slack envelope preserves one-search window reuse')
      assert(wide.profile.plans.some((plan) => plan.diagnostics?.windowSample?.reused === true))
      for (const sample of wide.profile.plans) {
        assert.equal(sample.arriveMinutes, initial.plan.arriveMinutes)
        assertLegalExits(sample, sample.departMinutes + 30, 'Certified wide-horizon reuse')
      }
    }
  } finally {
    disposeNationalGtfsStore(frontierStore)
  }
  console.log(JSON.stringify({ status: 'passed', cases, windowFrontierChecks: true, safeWindowReuse: true,
    scope: 'Route/Matrix store orchestration, generated GTFS and OSM, no private inputs' }))
} finally {
  disposeNationalOsmStore(streetStorePath)
  fs.rmSync(directory, { recursive: true, force: true })
}
