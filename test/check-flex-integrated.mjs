import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-flex-integrated-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  // One road A–X–B. The free endpoints lie on it, too far from any stop to
  // walk, so only zone service can reach them.
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,38.900,-77.050\nX,Middle,38.905,-77.040\nB,Bravo,38.910,-77.030\n')
  const box = (west, east) => [[[west, 38.895], [east, 38.895], [east, 38.915], [west, 38.915], [west, 38.895]]]
  zip.file('locations.geojson', JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'Z1', properties: {}, geometry: { type: 'Polygon', coordinates: box(-77.051, -77.045) } },
    { type: 'Feature', id: 'Z2', properties: {}, geometry: { type: 'Polygon', coordinates: box(-77.035, -77.029) } },
  ] }))
  const columns = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,location_id,start_pickup_drop_off_window,end_pickup_drop_off_window,pickup_type,drop_off_type'
  let built = 0
  const build = async (trips, calls) => {
    zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\n' + trips.join('\n') + '\n')
    zip.file('stop_times.txt', [columns, ...calls].join('\n') + '\n')
    const feed = path.join(folder, `feed-${++built}.zip`), city = path.join(folder, `city-${built}`)
    fs.writeFileSync(feed, await zip.generateAsync({ type: 'nodebuffer' }))
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', feed, '--osm', osmPath, '--output', city], { cwd: root, stdio: 'pipe' })
    return (kind, request) => JSON.parse(execFileSync(standaloneBinary, [kind, '--city', city, '--request', '-'], { cwd: root, input: JSON.stringify({ ...request, diagnostics: 'trace' }), encoding: 'utf8' }))
  }
  const zone = (trip, location, start, end, pickup, dropoff, sequence) => `${trip},,,,${sequence},${location},${start},${end},${pickup},${dropoff}`
  const fixed = (trip, stop, time, sequence, pickup = 0, dropoff = 0) => `${trip},${time},${time},${stop},${sequence},,,,${pickup},${dropoff}`
  const origin = { coordinate: [-77.047, 38.9015] }, destination = { coordinate: [-77.033, 38.9085] }
  const base = { origin, destination, serviceDate: '2026-07-15', time: '08:00', maxWalkKm: 0.05, requireTransitRide: true, flex: { durationFactor: 1, durationOffsetSeconds: 0 } }
  const rides = result => result.trace.legs.filter(leg => leg.kind === 'ride').map(leg => leg.tripId)
  const clock = minutes => minutes * 60

  // Flex reaches fixed service, rides it, and leaves it again by Flex: one
  // timetable search with time-dependent access and egress on both ends.
  const zones = (window = ['08:00:00', '10:00:00']) => [
    zone('F1', 'Z1', ...window, 2, 1, 1), zone('F1', 'Z1', ...window, 1, 2, 2),
    zone('F2', 'Z2', ...window, 2, 1, 1), zone('F2', 'Z2', ...window, 1, 2, 2),
  ]
  const scheduled = [fixed('T', 'A', '08:30:00', 1, 0, 1), fixed('T', 'B', '08:40:00', 2, 1, 0)]
  const trips = ['R1,WKD,F1,0', 'R1,WKD,F2,0', 'R2,WKD,T,0']
  let query = await build(trips, [...zones(), ...scheduled])
  assert.equal(query('route', { ...base, flex: undefined }).status, 'not_found')
  const both = query('route', base)
  assert.equal(both.status, 'ok', JSON.stringify(both).slice(0, 1500))
  assert.deepEqual(rides(both), ['F1', 'T', 'F2'])
  const [access, , egress] = both.trace.legs.filter(leg => leg.kind === 'ride')
  assert(access.arrivalMinutes <= 510 && egress.departureMinutes >= 520, 'Flex legs meet the fixed departure and arrival')
  assert.equal(both.trace.transfers, 2)
  assert(both.journey.legs.filter(leg => leg.quality?.flex).length === 2, 'Both conditional legs keep their public estimate')
  const reverse = query('route', { ...base, time: '09:00', timePreference: 'arrive_by' })
  assert.deepEqual(rides(reverse), ['F1', 'T', 'F2'])
  assert(reverse.trace.legs.find(leg => leg.tripId === 'F1').arrivalMinutes <= 510)
  assert(reverse.trace.departureMinutes > both.trace.departureMinutes, 'Arrive-by departs as late as the fixed ride allows')
  const { origin: o, destination: d, ...options } = base
  const matrix = query('matrix', { ...options, origins: [o], destinations: [d], includeJourneys: true })
  assert.equal(matrix.trace.durationsMinutes[0][0], both.trace.arrivalMinutes - 480, 'Matrix and Route share the integrated search')
  assert.equal(query('route', { ...base, maxTransfers: 1 }).status, 'not_found', 'Each Flex ride counts as a boarding')

  // A later egress window makes the rider wait at the interchange: the
  // egress clock depends on the transit arrival, not a static duration.
  query = await build(trips, [...zones().slice(0, 2), zone('F2', 'Z2', '08:50:00', '10:00:00', 2, 1, 1), zone('F2', 'Z2', '08:50:00', '10:00:00', 1, 2, 2), ...scheduled])
  const waiting = query('route', base)
  assert.deepEqual(rides(waiting), ['F1', 'T', 'F2'])
  assert.equal(waiting.trace.legs.find(leg => leg.tripId === 'F2').departureMinutes, 530)
  query = await build(trips, [...zones().slice(0, 2), zone('F2', 'Z2', '08:00:00', '08:35:00', 2, 1, 1), zone('F2', 'Z2', '08:00:00', '08:35:00', 1, 2, 2), ...scheduled])
  assert.equal(query('route', base).status, 'not_found', 'An egress window that closes before the transit arrival cannot be used')

  // A deviated route still serves its fixed stop on time. Riding through it
  // from one zone to another is anchored to that stop's published clock.
  query = await build(['R1,WKD,DV,0'], [zone('DV', 'Z1', '08:00:00', '09:00:00', 2, 1, 1), fixed('DV', 'X', '08:20:00', 2), zone('DV', 'Z2', '08:00:00', '09:00:00', 1, 2, 3)])
  const deviated = query('route', base)
  assert.equal(deviated.status, 'ok', JSON.stringify(deviated).slice(0, 1500))
  const ride = deviated.trace.legs.find(leg => leg.kind === 'ride')
  assert.equal(ride.tripId, 'DV')
  assert.equal(ride.flexEstimate.assumption, 'deviated_route')
  assert(ride.departureMinutes < 500 && ride.arrivalMinutes > 500 && ride.arrivalMinutes < 510, JSON.stringify(ride))
  const late = query('route', { ...base, time: '08:19' })
  assert.equal(late.status, 'not_found', 'A rider ready after the vehicle must leave for its fixed stop cannot board')
  assert(clock(ride.arrivalMinutes) > clock(500))
  console.log('Flex integrated: Flex–transit–Flex both directions, Matrix parity, boarding limits, egress windows and deviated routes passed.')
} finally { fs.rmSync(folder, { recursive: true, force: true }) }
