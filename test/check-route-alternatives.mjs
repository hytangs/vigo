import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {
  buildNationalGtfsStore,
  disposeNationalGtfsStore,
  routeNationalGtfsDepartureWindow,
  routeNationalGtfsStore,
  routeNationalGtfsMatrix,
} from '../src/server/national-gtfs-store.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-route-alternatives-'))
const point = (stop) => ({ stopId: stop, source: 'stop', label: stop,
  coordinate: [-77 + ['O', 'A', 'B', 'X', 'D'].indexOf(stop) * 0.05, 38] })
const request = { origin: point('O'), destination: point('D'), departMinutes: 480,
  serviceDate: '2026-07-15', serviceDay: 'weekday', routingPreference: 'fastest', maxWalkKm: 0.2 }
const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`

// Enumerate complete raw rides independently of the native scan and its
// pruning. All fixture transfers are same-stop and all endpoints are exact.
function expectedFrontier(trips, maximumArrival, rideHorizon = Infinity) {
  const terminal = []
  const visit = (stop, time, boardings) => {
    if (stop === 'D') {
      terminal.push([time, boardings - 1])
      return
    }
    if (boardings === 3) return
    for (const trip of trips) {
      if (trip.from === stop && trip.depart >= time && trip.depart <= rideHorizon
        && trip.arrive <= rideHorizon && trip.arrive <= maximumArrival) {
        visit(trip.to, trip.arrive, boardings + 1)
      }
    }
  }
  visit('O', 480, 0)
  return [...new Map(terminal.filter(([arrival, transfers]) => !terminal.some(([a, t]) =>
    a <= arrival && t <= transfers && (a < arrival || t < transfers)))
    .map((metrics) => [metrics.join(','), metrics])).values()].sort((a, b) => a[0] - b[0])
}

try {
  for (const [directArrival, horizonMinutes] of [[514], [525], [526], [520, 40], [525, 40]]) {
    const trips = [
      { id: 'R1', from: 'O', to: 'A', depart: 480, arrive: 490 },
      { id: 'R2', from: 'A', to: 'B', depart: 491, arrive: 500 },
      { id: 'R3', from: 'B', to: 'D', depart: 501, arrive: 510 },
      { id: 'M1', from: 'O', to: 'X', depart: 480, arrive: 492 },
      { id: 'M2', from: 'X', to: 'D', depart: 493, arrive: 511 },
      { id: 'DIRECT', from: 'O', to: 'D', depart: 480, arrive: directArrival },
      { id: 'DUPLICATE', from: 'O', to: 'D', depart: 480, arrive: directArrival + 1 },
    ]
    if (horizonMinutes) trips.push({ id: 'OUTSIDE', from: 'O', to: 'D', depart: 521, arrive: 524 })
    const zip = new JSZip()
    const table = (name, header, rows) => zip.file(name, `${header}\n${rows.join('\n')}\n`)
    table('agency.txt', 'agency_name,agency_url,agency_timezone', ['Quality Fixture,https://example.test,America/New_York'])
    table('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon', ['O', 'A', 'B', 'X', 'D']
      .map((stop) => `${stop},${stop},38,${point(stop).coordinate[0]}`))
    table('routes.txt', 'route_id,route_short_name,route_type', trips.map((trip) => `${trip.id},${trip.id},3`))
    table('trips.txt', 'route_id,service_id,trip_id', trips.map((trip) => `${trip.id},ACTIVE,${trip.id}`))
    table('calendar_dates.txt', 'service_id,date,exception_type', ['ACTIVE,20260715,1'])
    table('stop_times.txt', 'trip_id,stop_id,stop_sequence,arrival_time,departure_time', trips.flatMap((trip) => [
      `${trip.id},${trip.from},1,${clock(trip.depart)},${clock(trip.depart)}`,
      `${trip.id},${trip.to},2,${clock(trip.arrive)},${clock(trip.arrive)}`,
    ]))
    const zipPath = path.join(folder, `${directArrival}-${horizonMinutes ?? 'default'}.zip`)
    const storePath = path.join(folder, `${directArrival}-${horizonMinutes ?? 'default'}.sqlite`)
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
    await buildNationalGtfsStore({ zipPath, outputPath: storePath })
    try {
      const query = { ...request, ...(horizonMinutes ? { horizonMinutes } : {}) }
      const fastest = routeNationalGtfsStore(storePath, query)
      assert.deepEqual([fastest.arriveMinutes, fastest.transfers], [510, 2])
      for (const departureWindowDirection of ['forward', 'centered']) {
        const window = routeNationalGtfsDepartureWindow(storePath, {
          ...query, departureWindowMinutes: horizonMinutes ? 0 : 10, departureWindowDirection,
        })
        assert.deepEqual(window.choices.map((plan) => [plan.arriveMinutes, plan.transfers]),
          expectedFrontier(trips, fastest.arriveMinutes + 15, horizonMinutes ? 480 + horizonMinutes : Infinity),
          `Arrival/transfer choices must match whole-ride enumeration: ${directArrival}, ${departureWindowDirection}`)
        assert.equal(window.plan.arriveMinutes, fastest.arriveMinutes)
        assert.equal(window.choices.filter((plan) => plan.recommended).length, 1)
        assert.equal(window.choices[0].choiceLabel, 'Fastest')
        assert.equal(window.choices.at(-1).choiceLabel, 'Fewest transfers')
        for (const plan of window.choices) {
          assert.equal(plan.departMinutes, request.departMinutes)
          assert.equal(plan.walkMinutes, 0)
          assert.equal(plan.transfers, plan.legs.filter((leg) => leg.type === 'ride').length - 1)
          if (horizonMinutes) {
            assert(plan.legs.filter((leg) => leg.type === 'ride')
              .every((leg) => leg.endMinutes <= request.departMinutes + horizonMinutes),
            'Alternative slack must not extend the admitted ride horizon; equality is admitted.')
          }
          assert(!plan.legs.some((leg) => leg.routeShortName === 'DUPLICATE'))
        }
      }
      if (!horizonMinutes) {
        for (const maxTransfers of [0, 1, 2, undefined]) {
          const cap = maxTransfers ?? Infinity
          const candidates = expectedFrontier(trips, Infinity).filter(([, transfers]) => transfers <= cap)
          const capped = routeNationalGtfsStore(storePath, { ...query, maxTransfers })
          assert.deepEqual([capped.arriveMinutes, capped.transfers], candidates[0])
          const cappedChoices = routeNationalGtfsDepartureWindow(storePath, {
            ...query, maxTransfers, departureWindowMinutes: 0,
          })
          assert(cappedChoices.choices.every((plan) => plan.transfers <= cap))
          for (const arriveMinutes of [510, 511, directArrival]) {
            const expected = candidates.filter(([arrival]) => arrival <= arriveMinutes)
              .sort((a, b) => a[1] - b[1] || a[0] - b[0])[0]
            const arriveRequest = { ...query, maxTransfers, timePreference: 'arrive', arriveMinutes }
            const arrive = routeNationalGtfsStore(storePath, arriveRequest)
            const matrix = routeNationalGtfsMatrix(storePath, { ...arriveRequest,
              origins: [query.origin], destinations: [query.destination],
            })
            assert.equal(arrive.status, expected ? 'ready' : 'blocked')
            assert.equal(matrix.rows[0].status, arrive.status)
            if (expected) {
              assert.deepEqual([arrive.arriveMinutes, arrive.transfers], expected)
              assert.equal(arrive.departMinutes, 480)
              assert.equal(matrix.rows[0].departMinutes, arrive.departMinutes)
            }
          }
        }
        for (const maxTransfers of [-1, 0.5, 32, '1', null]) {
          assert.throws(() => routeNationalGtfsStore(storePath, { ...query, maxTransfers }), /maxTransfers/)
          assert.throws(() => routeNationalGtfsMatrix(storePath, {
            ...query, maxTransfers, origins: [query.origin], destinations: [query.destination],
          }), /maxTransfers/)
        }
      }
      const unavailable = routeNationalGtfsDepartureWindow(storePath, {
        ...request, serviceDate: '2026-07-16', departureWindowMinutes: 1,
      })
      assert.equal(unavailable.plan.status, 'blocked')
      assert(!unavailable.choices.some((plan) => plan.status === 'ready'))
    } finally {
      disposeNationalGtfsStore(storePath)
    }
  }
  console.log('Journey alternatives match independent arrival/transfer enumeration, including direct services and the arrival-window boundary.')
} finally {
  await fs.rm(folder, { recursive: true, force: true })
}
