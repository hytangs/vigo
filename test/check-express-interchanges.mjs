import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-express-interchanges-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  const zip = await JSZip.loadAsync(await fs.readFile(gtfsPath))
  const stops = ['O', 'X', 'A', 'B', 'Z', 'D']
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\n' + stops.map((id, i) => `${id},${id},38.9,${-77.05 + i * .02}`).join('\n') + '\n')
  zip.file('routes.txt', 'route_id,route_short_name,route_type\nE,Express,1\nL,Local,1\n')
  zip.file('trips.txt', 'route_id,service_id,trip_id\nE,WKD,express\nL,WKD,local\nE,WKD,express-late\nL,WKD,local-late\n')
  const trips = [['express', ['O', 'X', 'Z'], ['08:00:00', '08:10:00', '08:35:00']],
    ['local', ['X', 'A', 'B', 'Z', 'D'], ['08:12:00', '08:20:00', '08:30:00', '08:40:00', '08:50:00']],
    ['express-late', ['O', 'X', 'Z'], ['08:05:00', '08:15:00', '08:41:00']],
    ['local-late', ['X', 'A', 'B', 'Z', 'D'], ['08:18:00', '08:25:00', '08:35:00', '08:44:00', '08:54:00']]]
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' + trips.flatMap(([trip, calls, times]) => calls.map((stop, i) => `${trip},${times[i]},${times[i]},${stop},${i + 1}`)).join('\n') + '\n')
  zip.remove('transfers.txt'); zip.remove('shapes.txt')
  await fs.writeFile(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const city = path.join(directory, 'city')
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city], { stdio: 'pipe' })
  const query = { kind: 'route', origin: { stopId: 'O' }, destination: { stopId: 'D' }, time: '08:00',
    serviceDate: '2026-07-15', requireTransitRide: true, maxWalkKm: .001, allowStreetTransfers: false, minimumTransferBufferMinutes: 1 }
  const queries = [query, { ...query, windowMinutes: 10 }, { ...query, time: '08:50', timePreference: 'arrive_by' },
    { ...query, kind: 'matrix', origins: [query.origin], destinations: [query.destination], origin: undefined, destination: undefined, includeJourneys: true },
    { ...query, windowMinutes: 10, windowChoices: 'supported', alternatives: 9, alternativeRanking: 'ranked' }]
  const run = (binary, prefix = []) => execFileSync(binary, [...prefix, 'stream', '--city', city],
    { input: queries.map(q => JSON.stringify(prefix.length && q.windowMinutes ? { ...q, windowMinutes: undefined, departureWindowMinutes: q.windowMinutes } : q)).join('\n') + '\n', encoding: 'utf8' }).trim().split('\n').map(JSON.parse)
  const native = run(standaloneBinary), cli = run(process.execPath, ['public/vigo.mjs'])
  for (const rows of [native, cli]) for (const row of rows) {
    assert.equal(row.status, 'ok', JSON.stringify(row))
    const trace = row
    const journey = trace.journeys?.[0]?.[0] ?? trace.choices?.[0]?.journey ?? trace.journey ?? trace
    assert(journey.legs, JSON.stringify(row))
    const rides = journey.legs.filter(l => l.type === 'transit')
    assert.equal(rides.length, 2, JSON.stringify(journey.legs))
    assert.equal(rides[0].to?.stop?.id, 'Z', 'Stay on the express until the later shared platform')
    assert.equal(rides[1].from?.stop?.id, 'Z')
    assert.equal(rides[0].trip.id, 'express'); assert.equal(rides[1].trip.id, 'local')
    assert.equal(rides[1].arrivalTime, '08:50:00', 'Preserve arrival on the same local train')
    assert.equal(rides[1].departureTime, '08:40:00'); assert.equal(rides[0].arrivalTime, '08:35:00')
  }
  for (const rows of [native, cli]) {
    const journeys = [rows.at(-1).journey, ...rows.at(-1).alternatives.map(choice => choice.journey ?? choice)]
    const later = journeys.find(journey => journey.legs.some(leg => leg.trip?.id === 'express-late'))
    assert(later, 'Retain the later, shorter departure after refining the earlier interchange')
    const rides = later.legs.filter(leg => leg.type === 'transit')
    assert.equal(rides[0].departureTime, '08:05:00')
    assert.equal(rides[0].to.stop.id, 'Z')
    assert.equal(rides[1].trip.id, 'local-late')
    assert.equal(rides[1].arrivalTime, '08:54:00')
  }
  console.log('Express interchanges: native and CLI Route, departure window, arrive-by and detailed Matrix retain vehicles, arrival and transfer buffer.')
} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
