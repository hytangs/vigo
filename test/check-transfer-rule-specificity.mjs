import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-transfer-rules-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
  let built = 0
  const build = async files => {
    const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
    for (const [name, contents] of Object.entries(files)) zip.file(name, contents)
    const feed = path.join(folder, `feed-${++built}.zip`), city = path.join(folder, `city-${built}`)
    fs.writeFileSync(feed, await zip.generateAsync({ type: 'nodebuffer' }))
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', feed, '--osm', osmPath, '--output', city], { cwd: root, stdio: 'pipe' })
    return city
  }
  const route = (city, request = {}) => {
    const started = performance.now()
    const result = JSON.parse(execFileSync(standaloneBinary, ['route', '--city', city, '--request', '-'], { cwd: root, encoding: 'utf8',
      input: JSON.stringify({ origin: { stopId: 'A' }, destination: { stopId: 'B' }, time: '07:55', serviceDate: '2026-07-15', requireTransitRide: true, ...request }) }))
    return { ...result, ms: performance.now() - started }
  }
  // X is a platform of station XS. T1 reaches X at 08:10; T2 leaves at 08:15
  // and T3 at 08:25, so the governing minimum decides which one is caught.
  const network = {
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,38.900,-77.050,0,\nXS,Transfer station,38.905,-77.040,1,\nX,Transfer,38.905,-77.040,0,XS\nB,Bravo,38.910,-77.030,0,\n',
    'trips.txt': 'route_id,service_id,trip_id,direction_id\nR1,WKD,T1,0\nR2,WKD,T2,0\nR2,WKD,T3,0\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,X,2\n'
      + 'T2,08:15:00,08:15:00,X,1\nT2,08:30:00,08:30:00,B,2\nT3,08:25:00,08:25:00,X,1\nT3,08:40:00,08:40:00,B,2\n',
  }
  const transfers = rows => ({ 'transfers.txt': ['from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time', ...rows].join('\n') + '\n' })
  for (const [station, platform, arrival] of [[120, 600, '08:40:00'], [600, 120, '08:30:00']]) {
    const city = await build({ ...network, ...transfers([`XS,XS,,,,,2,${station}`, `X,X,,,,,2,${platform}`]) })
    const result = route(city)
    assert.equal(result.status, 'ok', JSON.stringify(result).slice(0, 600))
    assert.equal(result.journey.arrivalTime, arrival, `The ${platform} s platform rule overrides the ${station} s station rule`)
  }
  // A station rule applies to its platforms; a platform's own forbidden rule
  // removes the transfer there.
  assert.equal(route(await build({ ...network, ...transfers(['XS,XS,,,,,2,600']) })).journey.arrivalTime, '08:40:00')
  const forbidden = route(await build({ ...network, ...transfers(['XS,XS,,,,,2,60', 'X,X,,,,,3,']) }))
  assert.notEqual(forbidden.status, 'ok', JSON.stringify(forbidden).slice(0, 400))
  // Route- and trip-scoped rules are not applied: the stop-level minimum governs.
  const scoped = route(await build({ ...network, ...transfers(['X,X,,,,,2,60', 'X,X,R1,R2,,,2,1200', 'X,X,,,T1,T2,3,']) }))
  assert.equal(scoped.journey.arrivalTime, '08:30:00')
  console.log('Transfer rule specificity: platform rules override station rules and forbid their own transfers; route- and trip-scoped rules are not applied.')
} finally { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
