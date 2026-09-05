import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import JSZip from 'jszip'
import { nativeGridFixture, loadGridStreetIndex } from './helpers/native-grid-fixture.mjs'
import { buildNationalGtfsStore, routeNationalGtfsStore, routeNationalGtfsMatrix } from '../src/server/national-gtfs-store.mjs'

// The parent owns cleanup so Windows never unlinks a live native memory map.
if (process.argv[2] !== '--worker') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-routing-accuracy-'))
  try {
    execFileSync(process.execPath, [import.meta.filename, '--worker', directory], {
      stdio: 'inherit', env: process.env,
    })
    fs.rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    console.error(`Accuracy fixtures retained for reproduction: ${directory}`)
    throw error
  }
} else {
  await checkAccuracy(process.argv[3])
}

function randomGenerator(seed) {
  let value = seed >>> 0
  return (limit) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return Math.floor(value / 4294967296 * limit)
  }
}

// Independent all-pairs dynamic programming. It does not call VIGO's graph
// search, contraction code, path unpacker, or query caches.
function floydWarshall(nodeCount, offsets, targets, weights) {
  const distances = Array.from({ length: nodeCount }, (_, from) =>
    Array.from({ length: nodeCount }, (_, to) => from === to ? 0 : Infinity))
  for (let from = 0; from < nodeCount; from += 1) {
    for (let edge = offsets[from]; edge < offsets[from + 1]; edge += 1) {
      distances[from][targets[edge]] = Math.min(distances[from][targets[edge]], weights[edge])
    }
  }
  for (let via = 0; via < nodeCount; via += 1) {
    for (let from = 0; from < nodeCount; from += 1) {
      for (let to = 0; to < nodeCount; to += 1) {
        distances[from][to] = Math.min(distances[from][to], distances[from][via] + distances[via][to])
      }
    }
  }
  return distances
}

// Independent itinerary enumeration: board a raw trip at any legal stop and
// alight at any later legal stop. This enumerates whole rides, rather than
// reproducing the engine's connection scan or compiled transfer graph.
function enumerateArrival(trips, origin, destination, departure, count) {
  return enumerateArrivals(trips, origin, departure, count)[destination]
}

function enumerateArrivals(trips, origin, departure, count) {
  const best = new Array(count).fill(Infinity)
  const queue = [{ stop: origin, time: departure, initial: true }]
  while (queue.length) {
    queue.sort((left, right) => right.time - left.time)
    const current = queue.pop()
    if (!current.initial && current.time !== best[current.stop]) continue
    for (const trip of trips) {
      for (let board = 0; board < trip.length - 1; board += 1) {
        const ready = current.time + (current.initial ? 0 : 3)
        if (trip[board].stop !== current.stop || !trip[board].pickup || trip[board].departure < ready) continue
        for (let alight = board + 1; alight < trip.length; alight += 1) {
          const stop = trip[alight]
          if (!stop.dropoff || stop.arrival >= best[stop.stop]) continue
          best[stop.stop] = stop.arrival
          queue.push({ stop: stop.stop, time: stop.arrival, initial: false })
        }
      }
    }
  }
  // A transit exact-stop query must contain a ride, including O == D.
  return best
}

function enumerateDeparture(trips, origin, destination, deadline, count) {
  const candidates = [...new Set(trips.flatMap((trip) => trip.slice(0, -1)
    .filter((stop) => stop.stop === origin && stop.pickup && stop.departure <= deadline)
    .map((stop) => stop.departure)))].sort((a, b) => b - a)
  return candidates.find((departure) => enumerateArrival(trips, origin, destination, departure, count) <= deadline)
    ?? -Infinity
}

async function checkAccuracy(directory) {
  const seeds = Number(process.env.VIGO_ACCURACY_SEEDS ?? 8)
  assert(Number.isInteger(seeds) && seeds >= 1 && seeds <= 100)
  const binding = createRequire(import.meta.url)('../native/vigo-routing-kernel/vigo-routing-kernel.node')
  const counts = { streetDistances: 0, driveDurations: 0, driveWitnesses: 0, transitDepart: 0, transitArrive: 0, transitMatrix: 0, exhaustiveMatrixCells: 0, transitWitnesses: 0, calendarChecks: 0, blockedTransit: 0 }
  for (let iteration = 0; iteration < seeds; iteration += 1) {
    const seed = 20260904 + iteration
    const random = randomGenerator(seed)
    const fixtureDirectory = path.join(directory, String(seed))
    fs.mkdirSync(fixtureDirectory)
    const grid = nativeGridFixture(fixtureDirectory, 8)
    const { edgeOffsets, edgeTargets, edgeDistances } = grid.values
    for (let edge = 0; edge < edgeDistances.length; edge += 1) edgeDistances[edge] = 100 + random(900)
    // Update the synthetic input snapshot, before any native kernel opens it.
    const snapshot = fs.readFileSync(grid.snapshotPath)
    const header = JSON.parse(snapshot.subarray(0, 4096).toString().trim())
    Buffer.from(edgeDistances.buffer).copy(snapshot, header.arrays.edgeDistances.offset)
    fs.writeFileSync(grid.snapshotPath, snapshot)
    const street = loadGridStreetIndex(binding, grid, fixtureDirectory)
    const expectedDistances = floydWarshall(grid.nodeCount, edgeOffsets, edgeTargets, edgeDistances)
    const targets = Array.from({ length: grid.nodeCount }, (_, i) => i)
    for (let source = 0; source < grid.nodeCount; source += 1) {
      const actual = street.probeStreetCch({ sourceNodes: [source], sourceDistancesM: [0], targetNodes: targets })
      assert.deepEqual(actual.distancesM, expectedDistances[source], `Walk oracle seed=${seed} source=${source}`)
      counts.streetDistances += targets.length
    }
    const travelTimes = Float64Array.from(edgeDistances, () => 1 + random(120))
    const drive = new binding.DriveKernel({ ...grid.driveInput, edgeTravelTimes: travelTimes })
    const expectedTimes = floydWarshall(grid.nodeCount, edgeOffsets, edgeTargets, travelTimes)
    const matrix = drive.routeMatrix({
      originOffsets: targets.concat(targets.length), originNodes: targets,
      originSnapMeters: targets.map(() => 0), targetOffsets: targets.concat(targets.length),
      targetNodes: targets, targetSnapMeters: targets.map(() => 0), maximumDistanceMeters: 1_000_000,
    })
    assert.deepEqual(matrix.durationsS, expectedTimes.flat(), `Drive matrix oracle seed=${seed}`)
    counts.driveDurations += targets.length ** 2
    for (let sample = 0; sample < 32; sample += 1) {
      const source = random(grid.nodeCount), target = random(grid.nodeCount)
      const routed = drive.routeExact({
        originNodes: [source], originSnapMeters: [0], targetNodes: [target],
        targetSnapMeters: [0], maximumDistanceMeters: 1_000_000,
      })
      assert.equal(routed.status, 'ready')
      assert.equal(routed.durationSeconds, expectedTimes[source][target], `Drive oracle seed=${seed} ${source}->${target}`)
      let seconds = 0, meters = 0
      for (let i = 1; i < routed.nodeIndices.length; i += 1) {
        const from = routed.nodeIndices[i - 1], to = routed.nodeIndices[i]
        let edge = edgeOffsets[from]
        while (edge < edgeOffsets[from + 1] && edgeTargets[edge] !== to) edge += 1
        assert(edge < edgeOffsets[from + 1], 'Materialized path must use a directed input edge')
        seconds += travelTimes[edge]
        meters += edgeDistances[edge]
      }
      assert.equal(seconds, routed.durationSeconds)
      assert.equal(meters, routed.distanceMeters)
      counts.driveWitnesses += 1
    }

    const stopCount = 10
    const baseMinutes = iteration % 2 ? 24 * 60 : 8 * 60
    const trips = Array.from({ length: 28 }, () => {
      let minutes = baseMinutes + random(100)
      const selected = []
      const trip = []
      const length = 2 + random(4)
      for (let index = 0; index < length; index += 1) {
        let stop = random(stopCount)
        while (selected.includes(stop)) stop = random(stopCount)
        selected.push(stop)
        const arrival = minutes
        minutes += random(3)
        trip.push({ stop, arrival, departure: minutes, pickup: random(5) !== 0, dropoff: random(5) !== 0 })
        minutes += 2 + random(12)
      }
      return trip
    })
    // Explicit cases guarantee coverage of staying aboard a stop at which
    // neither boarding nor alighting is permitted, and a transfer that misses
    // the engine's declared three-minute boarding buffer.
    trips.push([
      { stop: 0, arrival: baseMinutes, departure: baseMinutes, pickup: true, dropoff: true },
      { stop: 1, arrival: baseMinutes + 1, departure: baseMinutes + 1, pickup: false, dropoff: false },
      { stop: 2, arrival: baseMinutes + 2, departure: baseMinutes + 2, pickup: true, dropoff: true },
    ], [
      { stop: 2, arrival: baseMinutes + 2, departure: baseMinutes + 2, pickup: true, dropoff: true },
      { stop: 3, arrival: baseMinutes + 3, departure: baseMinutes + 3, pickup: true, dropoff: true },
    ])
    const zip = new JSZip()
    const table = (name, header, rows) => zip.file(name, `${header}\n${rows.join('\n')}\n`, { date: new Date('2026-01-01T00:00:00Z') })
    const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`
    table('agency.txt', 'agency_name,agency_url,agency_timezone', ['Oracle Fixture,https://example.test,America/New_York'])
    // Stops are far apart so the compiler cannot add implicit nearby transfers.
    table('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon', Array.from({ length: stopCount }, (_, i) => `S${i},Stop ${i},38,${-77 + i * 0.05}`))
    table('routes.txt', 'route_id,route_short_name,route_type', trips.map((_, i) => `R${i},R${i},3`))
    table('trips.txt', 'route_id,service_id,trip_id', trips.map((_, i) => `R${i},ACTIVE,T${i}`))
    table('calendar_dates.txt', 'service_id,date,exception_type', ['ACTIVE,20260715,1'])
    table('stop_times.txt', 'trip_id,stop_id,stop_sequence,arrival_time,departure_time,pickup_type,drop_off_type',
      trips.flatMap((trip, i) => trip.map((stop, j) => `T${i},S${stop.stop},${j + 1},${clock(stop.arrival)},${clock(stop.departure)},${stop.pickup ? 0 : 1},${stop.dropoff ? 0 : 1}`)))
    const gtfsPath = path.join(fixtureDirectory, 'oracle.zip'), storePath = path.join(fixtureDirectory, 'routing.sqlite')
    fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    fs.writeFileSync(path.join(fixtureDirectory, 'oracle-trips.json'), JSON.stringify(trips))
    await buildNationalGtfsStore({ zipPath: gtfsPath, outputPath: storePath })
    const point = (i) => ({ stopId: `S${i}`, source: 'stop', label: `Stop ${i}`, coordinate: [-77 + i * 0.05, 38] })
    const request = { serviceDate: '2026-07-15', serviceDay: 'weekday', maxWalkKm: 0.2,
      routingPreference: 'fastest', returnedStationCyclePolicy: 'represented', horizonMinutes: 480 }
    for (let sample = 0; sample < 24; sample += 1) {
      const from = sample === 0 ? 0 : random(stopCount), to = sample === 0 ? 3 : random(stopCount)
      if (from === to) continue
      const departure = baseMinutes + (sample === 0 ? 0 : random(160))
      const expected = enumerateArrival(trips, from, to, departure, stopCount)
      const query = { ...request, origin: point(from), destination: point(to), departMinutes: departure }
      const routed = routeNationalGtfsStore(storePath, query)
      assert.equal(routed.status, Number.isFinite(expected) ? 'ready' : 'blocked', `Transit status seed=${seed} sample=${sample}`)
      if (Number.isFinite(expected)) {
        assert.equal(routed.arriveMinutes, expected, `Transit arrival seed=${seed} sample=${sample}`)
        assert.equal(routed.diagnostics.searchStats.nativeTimetableKernel.scalar.diagnostics.transferBoardSlackSeconds, 180,
          'Independent oracle and engine must declare the same boarding buffer')
        let previousRide = null
        for (const ride of routed.legs.filter((leg) => leg.type === 'ride')) {
          const rawTrip = trips[Number(ride.tripId.slice(1))]
          const board = rawTrip.findIndex((stop) => `S${stop.stop}` === ride.fromStopId)
          const alight = rawTrip.findIndex((stop) => `S${stop.stop}` === ride.toStopId)
          assert(board >= 0 && alight > board, 'Ride must follow the raw trip stop order')
          assert(rawTrip[board].pickup && rawTrip[alight].dropoff, 'Ride must respect raw pickup/drop-off permissions')
          assert.equal(ride.startMinutes, rawTrip[board].departure)
          assert.equal(ride.endMinutes, rawTrip[alight].arrival)
          if (previousRide) assert(ride.startMinutes >= previousRide.endMinutes + 3)
          previousRide = ride
          counts.transitWitnesses += 1
        }
      }
      else counts.blockedTransit += 1
      counts.transitDepart += 1
      {
        const matrixResult = routeNationalGtfsMatrix(storePath, { ...request, departMinutes: departure,
          origins: [point(from)], destinations: [point(to)] })
        assert.equal(matrixResult.rows[0].status, routed.status, `Matrix status seed=${seed} sample=${sample}`)
        assert.equal(matrixResult.rows[0].arriveMinutes, Number.isFinite(expected) ? expected : null,
          `Matrix arrival seed=${seed} sample=${sample}`)
        counts.transitMatrix += 1
      }
      const deadline = baseMinutes + random(165)
      const expectedDeparture = enumerateDeparture(trips, from, to, deadline, stopCount)
      const arriveBy = routeNationalGtfsStore(storePath, { ...query, timePreference: 'arrive', arriveMinutes: deadline })
      assert.equal(arriveBy.status, Number.isFinite(expectedDeparture) ? 'ready' : 'blocked', `Arrive-by status seed=${seed} sample=${sample}`)
      if (Number.isFinite(expectedDeparture)) {
        assert.equal(arriveBy.departMinutes, expectedDeparture, `Arrive-by departure seed=${seed} sample=${sample}`)
        assert(arriveBy.arriveMinutes <= deadline)
      }
      counts.transitArrive += 1
    }
    for (const [origins, destinations] of [
      [[0, 1, 2], [3, 4, 5]], [[2, 0, 1, 0], [5, 3, 4, 3]],
    ]) {
      const batch = routeNationalGtfsMatrix(storePath, { ...request, departMinutes: baseMinutes + 35,
        origins: origins.map(point), destinations: destinations.map(point) })
      for (const row of batch.rows) {
        const expected = enumerateArrival(trips, origins[row.originIndex], destinations[row.destinationIndex], baseMinutes + 35, stopCount)
        assert.equal(row.arriveMinutes, Number.isFinite(expected) ? expected : null, `Permuted Matrix seed=${seed}`)
        counts.transitMatrix += 1
      }
    }
    // Enumerate every stop-to-stop OD, including cycles, at every departure
    // discontinuity. With exact-stop endpoints these times cover the distinct
    // earliest-arrival outcomes between scheduled boarding events.
    const criticalDepartures = [...new Set([baseMinutes, ...trips.flatMap((trip) => trip
      .filter((stop) => stop.pickup)
      .flatMap((stop) => [stop.departure, stop.departure + 1]))])].sort((a, b) => a - b)
    const allPoints = Array.from({ length: stopCount }, (_, i) => point(i))
    for (const departure of criticalDepartures) {
      const expected = allPoints.map((_, origin) => enumerateArrivals(trips, origin, departure, stopCount))
      const batch = routeNationalGtfsMatrix(storePath, { ...request, departMinutes: departure,
        origins: allPoints, destinations: allPoints })
      for (const row of batch.rows) {
        const arrival = expected[row.originIndex][row.destinationIndex]
        assert.equal(row.arriveMinutes, Number.isFinite(arrival) ? arrival : null,
          `All-OD oracle seed=${seed} time=${departure} ${row.originIndex}->${row.destinationIndex}`)
        counts.exhaustiveMatrixCells += 1
      }
    }
    for (const serviceDate of ['2026-07-16', '2026-07-15', '2026-07-16']) {
      const plan = routeNationalGtfsStore(storePath, { ...request, origin: point(0), destination: point(2),
        departMinutes: baseMinutes, serviceDate })
      assert.equal(plan.status, serviceDate === '2026-07-15' ? 'ready' : 'blocked')
      if (plan.status === 'ready') assert.equal(plan.arriveMinutes, baseMinutes + 2,
        'Passengers must remain aboard through a stop with no pickup or drop-off')
      counts.calendarChecks += 1
    }
  }
  const report = { status: 'passed', seedStart: 20260904, seeds, counts,
    oracles: ['independent Floyd-Warshall on directed distances and travel times', 'whole-trip boarding/alighting enumeration from generated raw GTFS with declared boarding buffer'],
    transitPolicy: { transferBoardSlackSeconds: 180, explicitStopEndpoints: true, requiresTransitRide: true },
    limitations: ['synthetic networks', 'no coordinate snapping oracle', 'no explicit transfer-rule oracle', 'no live provider or delivered-service validation'] }
  if (process.env.VIGO_ACCURACY_REPORT) fs.writeFileSync(process.env.VIGO_ACCURACY_REPORT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report, null, 2))
}
