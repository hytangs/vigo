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
  // An unrelated route-scoped rule enables trip-scoped service semantics.
  const unrelated = 'A,A,R1,R2,,,0,'
  for (const [station, platform, arrival] of [[120, 600, '08:40:00'], [600, 120, '08:30:00']]) {
    const city = await build({ ...network, ...transfers([`XS,XS,,,,,2,${station}`, `X,X,,,,,2,${platform}`, unrelated]) })
    const result = route(city)
    assert.equal(result.status, 'ok', JSON.stringify(result).slice(0, 600))
    assert.equal(result.journey.arrivalTime, arrival, `The ${platform} s platform rule overrides the ${station} s station rule`)
  }
  // A route selector still outranks a platform-level stop selector.
  const routed = route(await build({ ...network, ...transfers(['X,X,,,,,2,600', 'XS,XS,R1,R2,,,2,120']) }))
  assert.equal(routed.journey.arrivalTime, '08:30:00')

  // Trip-scoped rules resolve through the indexed trip identities: forbidding
  // T1 -> T2 leaves T3 even though the stop-level minimum would allow T2.
  const forbidden = route(await build({ ...network, ...transfers(['X,X,,,T1,T2,3,', unrelated]) }))
  assert.equal(forbidden.journey.arrivalTime, '08:40:00')

  // Neither rule loading nor transfer checks may scan every rule or trip.
  // Unindexed, 20,000 trips and 2,000 trip-scoped rules took about 3 s here.
  const clock = s => [3600, 60, 1].map(u => String(Math.floor(s / u) % (u === 3600 ? 100 : 60)).padStart(2, '0')).join(':')
  const trips = ['route_id,service_id,trip_id,direction_id'], times = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence']
  for (let t = 0; t < 20000; t++) {
    const departure = 18000 + Math.floor(t / 2) * 2
    trips.push(`R${t % 2 + 1},WKD,L${t},0`)
    times.push(...(t % 2 === 0
      ? [`L${t},${clock(departure)},${clock(departure)},A,1`, `L${t},${clock(departure + 600)},${clock(departure + 600)},X,2`]
      : [`L${t},${clock(departure + 900)},${clock(departure + 900)},X,1`, `L${t},${clock(departure + 1800)},${clock(departure + 1800)},B,2`]))
  }
  const large = { ...network, 'trips.txt': trips.join('\n') + '\n', 'stop_times.txt': times.join('\n') + '\n' }
  const rules = Array.from({ length: 2000 }, (_, i) => `X,X,,,L${2 * i},L${2 * i + 1},2,60`)
  const baseline = route(await build({ ...large, ...transfers([]) }), { time: '05:00' })
  const scoped = route(await build({ ...large, ...transfers(rules) }), { time: '05:00' })
  assert.equal(scoped.status, 'ok')
  assert(scoped.ms < baseline.ms * 5 + 750, `Trip-scoped rule activation took ${scoped.ms.toFixed(0)} ms (baseline ${baseline.ms.toFixed(0)} ms)`)
  console.log(`Transfer rule specificity: platform rules override station rules, route and trip selectors still rank first, trip-scoped rules resolve in ${scoped.ms.toFixed(0)} ms.`)
} finally { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
