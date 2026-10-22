import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-flex-limits-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
  const source = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  const original = Object.fromEntries(await Promise.all(['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'].map(async name => [name, await source.file(name).async('string')])))
  const zone = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'ZONE', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-77.06, 38.89], [-77.02, 38.89], [-77.02, 38.92], [-77.06, 38.92], [-77.06, 38.89]]] } }] }
  const columns = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,location_id,location_group_id,start_pickup_drop_off_window,end_pickup_drop_off_window,pickup_type,drop_off_type'
  const fixed = original['stop_times.txt'].trimEnd().split('\n').slice(1).map(row => `${row},,,,,0,0`)
  const clock = seconds => [3600, 60, 1].map(unit => String(Math.floor(seconds / unit) % (unit === 3600 ? 100 : 60)).padStart(2, '0')).join(':')
  let built = 0
  const build = async files => {
    const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
    for (const [name, contents] of Object.entries(files)) zip.file(name, contents)
    const feed = path.join(folder, `feed-${++built}.zip`), city = path.join(folder, `city-${built}`)
    fs.writeFileSync(feed, await zip.generateAsync({ type: 'nodebuffer' }))
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', feed, '--osm', osmPath, '--output', city], { cwd: root, stdio: 'pipe' })
    return city
  }
  const query = (city, kind, request) => JSON.parse(execFileSync(standaloneBinary, [kind, '--city', city, '--request', '-'], { cwd: root, input: JSON.stringify({ ...request, diagnostics: 'trace' }), encoding: 'utf8' }))
  const base = { origin: { coordinate: [-77.05, 38.9] }, destination: { coordinate: [-77.03, 38.91] }, time: '08:00', serviceDate: '2026-07-15', requireTransitRide: true, flex: { durationFactor: 1, durationOffsetSeconds: 0 } }
  const conditional = result => [result.trace, ...(result.trace?.choices ?? [])].some(plan => plan?.legs?.some(leg => leg.flexEstimate))

  // Route-wide continuous stopping copies every trip into the optional catalog.
  // Past its budget the build must keep scheduled service and on-demand trips.
  let stops = original['stops.txt']
  for (let i = 0; i < 60; i++) stops += `S${i},S${i},${(38.9 + i * 0.0002).toFixed(5)},${(-77.05 + i * 0.0003).toFixed(5)}\n`
  const trips = ['route_id,service_id,trip_id,direction_id,shape_id', ...original['trips.txt'].trimEnd().split('\n').slice(1).map(row => `${row},`), 'R2,WKD,F,0,']
  const calls = [...fixed, 'F,,,,1,ZONE,,08:00:00,10:00:00,2,1', 'F,,,,2,ZONE,,08:00:00,10:00:00,1,2']
  for (let t = 0; t < 3000; t++) {
    trips.push(`R1,WKD,C${t},0,SH`)
    for (let s = 0; s < 60; s++) calls.push(`C${t},${clock(18000 + (t % 600) * 60 + s * 60)},${clock(18000 + (t % 600) * 60 + s * 60)},S${s},${s + 1},,,,,0,0`)
  }
  const shape = ['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', ...Array.from({ length: 60 }, (_, i) => `SH,${(38.9 + i * 0.0002).toFixed(5)},${(-77.05 + i * 0.0003).toFixed(5)},${i}`)]
  const routes = original['routes.txt'].trimEnd().split('\n').map((row, i) => row + (i === 0 ? ',continuous_pickup' : row.startsWith('R1,') ? ',0' : ',')).join('\n') + '\n'
  const large = await build({ 'stops.txt': stops, 'routes.txt': routes, 'trips.txt': trips.join('\n') + '\n', 'stop_times.txt': [columns, ...calls].join('\n') + '\n', 'shapes.txt': shape.join('\n') + '\n', 'locations.geojson': JSON.stringify(zone) })
  const db = new DatabaseSync(path.join(large, 'routing/project.sqlite'), { readOnly: true })
  const stored = db.prepare('SELECT data FROM flex_catalog').all()
  const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, JSON.parse(row.value)]))
  db.close()
  assert.equal(stored.length, 1)
  assert(Buffer.byteLength(stored[0].data) <= 32 * 1024 * 1024)
  assert.deepEqual(Object.keys(JSON.parse(stored[0].data).trips), ['F'], 'Fixed-route conditional trips leave the catalog before on-demand trips')
  const limit = metadata.routingLimitations.find(issue => issue.code === 'flex_catalog_limit')
  assert(limit && limit.count >= 3000, JSON.stringify(metadata.routingLimitations))
  assert.equal(metadata.featureInventory.flexTripCount, 1)
  assert.equal(query(large, 'route', { ...base, origin: { stopId: 'S0' }, destination: { stopId: 'S59' }, time: '05:00', flex: undefined, requireTransitRide: false }).status, 'ok', 'Omitted trips keep their scheduled service')
  assert(conditional(query(large, 'route', base)), 'Retained on-demand trips stay routable')

  // A location group yields every walkable board/alight pair. Exceeding the
  // per-search bound returns the scheduled journey and a warning, not an error.
  const cluster = (name, [lon, lat]) => Array.from({ length: 70 }, (_, i) => `${name}${i},${name}${i},${(lat + (i % 10) * 0.0001).toFixed(5)},${(lon + Math.floor(i / 10) * 0.0001).toFixed(5)}`)
  // 70 members near each endpoint: 4900 walkable pairs on one service day.
  const pairs = async (board, alight) => {
    const rows = [...cluster('P', board), ...cluster('D', alight)]
    const extra = rows.join('\n') + '\n', members = rows.map(row => `G,${row.split(',')[0]}`).join('\n') + '\n'
    return build({ 'stops.txt': original['stops.txt'] + extra, 'trips.txt': original['trips.txt'] + 'R1,WKD,F,0\n',
      'stop_times.txt': [columns, ...fixed, 'F,,,,1,,G,08:00:00,10:00:00,2,1', 'F,,,,2,,G,08:00:00,10:00:00,1,2'].join('\n') + '\n',
      'location_groups.txt': 'location_group_id,location_group_name\nG,Group\n', 'location_group_stops.txt': 'location_group_id,stop_id\n' + members })
  }
  const near = await pairs(base.origin.coordinate, base.destination.coordinate)
  const truncated = query(near, 'route', base)
  assert.equal(truncated.status, 'ok', JSON.stringify(truncated).slice(0, 1000))
  assert(conditional(truncated), 'Journeys found before the bound are kept')
  // A two-hour offset leaves no pair inside the window: every pair is still
  // evaluated, and the scheduled journey is returned rather than an error.
  const infeasible = query(near, 'route', { ...base, flex: { durationFactor: 1, durationOffsetSeconds: 7200 } })
  assert.deepEqual(infeasible.journey.legs, query(near, 'route', { ...base, flex: undefined }).journey.legs, 'The scheduled journey survives a bounded Flex search')
  assert(infeasible.trace.warnings.some(warning => warning.code === 'flex_search_truncated'))
  assert(truncated.trace.warnings.some(warning => warning.code === 'flex_search_truncated'), JSON.stringify(truncated.trace.warnings))
  const { origin, destination, ...options } = base
  const matrix = query(near, 'matrix', { ...options, origins: [origin], destinations: [destination] })
  assert.equal(typeof matrix.trace.durationsMinutes[0][0], 'number')
  assert(matrix.trace.warnings.some(warning => warning.code === 'flex_search_truncated'))
  // Members beyond walking range cannot form a journey and do not consume the bound.
  const far = query(await pairs([-77.05, 39.0], [-77.03, 39.01]), 'route', base)
  assert.equal(far.status, 'ok')
  assert(!(far.trace.warnings ?? []).some(warning => warning.code === 'flex_search_truncated'), JSON.stringify(far.trace.warnings))
  console.log('Flex limits: oversized catalogs keep scheduled and on-demand service; bounded pair searches warn instead of failing.')
} finally { fs.rmSync(folder, { recursive: true, force: true }) }
