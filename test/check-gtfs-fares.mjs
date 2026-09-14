import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { quoteBoardingFare, farePriceLabel } from '../src/fares.mjs'
import { compactResult } from '../src/agency/queryAgent.mjs'
import { addGtfsFares } from '../src/server/gtfs-fare-store.mjs'
import { buildNationalGtfsStore, buildNationalGtfsCityStore, mergeNationalGtfsStores, addNationalGtfsFares, routeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'

const catalog = () => ({ version: 1, source: 'fixture.zip', tables: {
  agency: [{ agency_id: 'A', agency_timezone: 'America/New_York', agency_fare_url: 'https://example.com/fares' }],
  routes: [{ route_id: 'R', agency_id: 'A', network_id: 'N' }],
  stops: [{ stop_id: 'S', parent_station: 'P' }, { stop_id: 'P' }, { stop_id: 'T' }],
  stop_areas: [{ stop_id: 'P', area_id: 'origin' }, { stop_id: 'T', area_id: 'destination' }],
  fare_products: [{ fare_product_id: 'adult', fare_product_name: 'Single ride', amount: '2.40', currency: 'USD', fare_media_id: 'card' },
    { fare_product_id: 'free', fare_product_name: 'Transfer', amount: '0.00', currency: 'USD' }],
  fare_media: [{ fare_media_id: 'card', fare_media_name: 'Transit card' }],
  fare_leg_rules: [{ network_id: 'N', from_area_id: '', to_area_id: '', fare_product_id: 'adult' },
    { network_id: 'N', from_area_id: '', to_area_id: '', fare_product_id: 'free', transfer_only: '1' }],
} })
const ride = { type: 'ride', routeId: 'R', fromStopId: 'S', toStopId: 'T', startMinutes: 480, endMinutes: 490 }
const quote = (c, leg = ride, date = '2026-09-14') => quoteBoardingFare(c, leg, date)
assert.equal(farePriceLabel(quote(catalog()).options), '$2.40')
assert.equal(quote(catalog()).options.length, 1, 'A free transfer is not a free boarding.')
assert.equal(quote(catalog()).agencyUrl, 'https://example.com/fares')
assert.equal(quote(catalog(), { ...ride, routeId: 'missing' }).status, 'unavailable')
assert.equal(quote(catalog(), { ...ride, toStopId: 'missing' }).status, 'unavailable')
for (const amount of ['', '-1', 'NaN', 'Infinity', '1e4', 'bad', '2.499']) {
  const c = catalog(); c.tables.fare_products[0].amount = amount
  assert.equal(quote(c).status, 'unavailable', amount)
}
{
  const c = catalog(); c.tables.fare_products[0].amount = '0.00'
  assert.equal(farePriceLabel(quote(c).options), '$0.00', 'A published zero price remains zero.')
  c.tables.agency[0].agency_fare_url = 'javascript:alert(1)'
  assert.equal(quote(c).agencyUrl, undefined)
}
{
  const c = catalog()
  c.tables.fare_products.push({ fare_product_id: 'adult', amount: '3.00', currency: 'USD', fare_media_id: 'cash' })
  assert.equal(farePriceLabel(quote(c).options), '$2.40–$3.00')
  c.tables.fare_products[0].rider_category_id = 'child'
  c.tables.rider_categories = [{ rider_category_id: 'child', is_default_fare_category: '0' }]
  assert.equal(farePriceLabel(quote(c).options), '$3.00', 'Do not advertise a concession as the default.')
}
{
  const c = catalog()
  c.tables.fare_leg_rules[0].from_area_id = 'origin'
  c.tables.fare_leg_rules[0].to_area_id = 'destination'
  assert.equal(quote(c).status, 'published', 'A platform inherits station area membership.')
  assert.equal(quote(c, { ...ride, fromStopId: 'T', toStopId: 'S' }).status, 'unavailable')
  c.tables.fare_leg_rules.push({ network_id: '', from_area_id: '', to_area_id: '', fare_product_id: 'free' })
  assert.equal(farePriceLabel(quote(c).options), '$2.40', 'An empty network is not a universal free fare.')
}
{
  const c = catalog()
  c.tables.fare_leg_rules = [{ network_id: '', fare_product_id: 'free', rule_priority: '0' }, { network_id: 'N', fare_product_id: 'adult', rule_priority: '2' }]
  assert.equal(farePriceLabel(quote(c).options), '$2.40')
}
{
  const c = catalog()
  c.tables.fare_leg_rules[0].from_timeframe_group_id = 'peak'
  c.tables.timeframes = [{ timeframe_group_id: 'peak', service_id: 'fare', start_time: '00:00:00', end_time: '01:00:00' }]
  c.tables.calendar_dates = [{ service_id: 'fare', date: '20260915', exception_type: '1' }]
  assert.equal(quote(c).status, 'unavailable')
  assert.equal(quote(c, { ...ride, startMinutes: 1470, endMinutes: 1480 }).status, 'published', 'After-midnight fares use the next civil day.')
  assert.equal(quote(c, { ...ride, startMinutes: 1500, endMinutes: 1510 }).status, 'unavailable', 'Timeframe ends are exclusive.')
  assert.equal(quote(c, { ...ride, startMinutes: 1470, scheduleMode: 'realtime-adjusted' }).status, 'unavailable', 'Prediction time cannot substitute for scheduled fare validation time.')
  c.tables.stops[1].stop_timezone = 'America/Chicago'
  assert.equal(quote(c, { ...ride, startMinutes: 1470 }).status, 'unavailable', 'A platform also inherits the station timezone.')
}
{
  const c = catalog(); delete c.tables.fare_products
  c.tables.fare_attributes = [{ fare_id: 'flat', agency_id: 'A', price: '1.25', currency_type: 'USD', payment_method: '0', transfers: '0' }]
  c.tables.fare_rules = [{ fare_id: 'flat', route_id: 'R' }]
  assert.equal(farePriceLabel(quote(c).options), '$1.25')
  c.tables.fare_rules[0].contains_id = 'zone'
  assert.equal(quote(c).status, 'unavailable', 'Unimplemented zone traversal must not become a flat price.')
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-fares-'))
try {
  const zip = new JSZip()
  const c = catalog()
  c.tables.stops = [
    { stop_id: 'S', stop_name: 'Start', stop_lat: '42.35', stop_lon: '-71.06' },
    { stop_id: 'T', stop_name: 'End', stop_lat: '42.4', stop_lon: '-71.01' },
  ]
  c.tables.routes[0] = { ...c.tables.routes[0], route_type: '3', route_short_name: 'R' }
  c.tables.agency[0] = { ...c.tables.agency[0], agency_name: 'Fixture', agency_url: 'https://example.com' }
  c.tables.trips = [{ trip_id: 'TR', route_id: 'R', service_id: 'WKD' }]
  c.tables.stop_times = [
    { trip_id: 'TR', stop_id: 'S', stop_sequence: '1', arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 'TR', stop_id: 'T', stop_sequence: '2', arrival_time: '08:10:00', departure_time: '08:10:00' },
  ]
  c.tables.calendar_dates = [{ service_id: 'WKD', date: '20260914', exception_type: '1' }]
  for (const [name, rows] of Object.entries(c.tables)) {
    const headers = [...new Set(rows.flatMap(Object.keys))]
    zip.file(`${name}.txt`, [headers.join(','), ...rows.map(row => headers.map(key => row[key] ?? '').join(','))].join('\n') + '\n')
  }
  const zipPath = path.join(root, 'fare.zip'), storePath = path.join(root, 'fare.sqlite')
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const metadata = await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  assert.equal(metadata.fareData.standard, 'GTFS Fares v2')
  const request = { mode: 'transit', serviceDate: '2026-09-14', departMinutes: 479, maxWalkKm: 0.2,
    origin: { stopId: 'S', coordinate: [-71.06, 42.35], label: 'Start', source: 'stop' },
    destination: { stopId: 'T', coordinate: [-71.01, 42.4], label: 'End', source: 'stop' } }
  const plan = routeNationalGtfsStore(storePath, request)
  assert.equal(plan.status, 'ready')
  const annotated = addNationalGtfsFares(storePath, plan)
  assert.equal(farePriceLabel(annotated.legs.find(leg => leg.type === 'ride').fare.options), '$2.40')
  assert.equal(plan.legs.find(leg => leg.type === 'ride').fare, undefined, 'Fare annotation leaves the routed plan untouched.')
  const context = JSON.parse(compactResult({ ok: true, data: { plan: annotated }, warnings: [] }, 'route_plan'))
  assert.equal(context.data.plan.fares.boardings[0].options[0].amount, 2.4, 'Ask receives fare evidence, not just the UI.')
  assert.match(context.data.plan.fares.basis, /Do not sum/)
  const dbSchedule = new DatabaseSync(':memory:')
  dbSchedule.exec("CREATE TABLE connections(trip_id TEXT, stop_sequence INTEGER, departure INTEGER, arrival INTEGER, from_stop_id TEXT, to_stop_id TEXT); INSERT INTO connections VALUES('TR',1,28800,29400,'S','T'); CREATE TABLE fare_catalogs(scope TEXT, data TEXT)")
  const timed = catalog()
  timed.tables.fare_leg_rules[0].from_timeframe_group_id = 'am'
  timed.tables.timeframes = [{ timeframe_group_id: 'am', service_id: 'WKD', start_time: '08:00:00', end_time: '08:05:00' }]
  timed.tables.calendar_dates = c.tables.calendar_dates
  dbSchedule.prepare('INSERT INTO fare_catalogs VALUES(?,?)').run('', JSON.stringify(timed))
  const delayed = { ...ride, tripId: 'TR', scheduleMode: 'realtime-adjusted', stopIds: ['S', 'T'], startMinutes: 495, endMinutes: 505 }
  assert.equal(addGtfsFares(dbSchedule, { ...plan, legs: [delayed] }).legs[0].fare.status, 'published', 'Timed fares use the uniquely matched scheduled sequence, not delayed predictions.')
  dbSchedule.close()
  for (const build of ['merge', 'city']) {
    const outputPath = path.join(root, `${build}.sqlite`)
    if (build === 'merge') await mergeNationalGtfsStores({ stores: ['one', 'two'].map(scope => ({ scope, storePath })), outputPath })
    else await buildNationalGtfsCityStore({ feeds: ['one', 'two'].map(scope => ({ scope, path: zipPath })), outputPath })
    const db = new DatabaseSync(outputPath, { readOnly: true })
    try {
      for (const scope of ['one', 'two']) {
        const leg = { ...ride, routeId: `${scope}\u001fR`, fromStopId: `${scope}\u001fS`, toStopId: `${scope}\u001fT` }
        assert.equal(farePriceLabel(addGtfsFares(db, { ...plan, legs: [leg] }).legs[0].fare.options), '$2.40')
      }
      assert.equal(addGtfsFares(db, { ...plan, legs: [ride] }).legs[0].fare.status, 'unavailable', 'Never match an unscoped route to a different feed.')
    } finally { db.close() }
  }
  const legacy = new DatabaseSync(':memory:')
  assert.equal(addGtfsFares(legacy, { ...plan, legs: [ride] }).legs[0].fare.status, 'unavailable')
  legacy.close()
} finally { await fs.rm(root, { recursive: true, force: true }) }
console.log('GTFS fare matching, import, merged-feed scoping and routing annotation passed.')
