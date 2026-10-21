import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { nativeRouteRequest, onServiceDate } from '../src/server/studio-route-plans.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

// Arrive-by "Earlier arrivals": the latest departure for each deadline in the
// 20 minutes before the requested arrival, answered by the native runtime.

// A service day starts at local noon minus 12 hours, so it lasts 23 or 25
// hours across a daylight-saving change.
const shifted = (from, to, zone) => onServiceDate({ serviceDate: from, departureMinutes: 1500, legs: [{ arrivalMinutes: 1530 }] }, to, zone)
assert.equal(shifted('2026-10-20', '2026-10-21', 'America/New_York').departureMinutes, 60)
assert.equal(shifted('2026-10-31', '2026-11-01', 'America/New_York').departureMinutes, 0, 'The day clocks fall back is 25 hours')
assert.equal(shifted('2026-03-07', '2026-03-08', 'America/New_York').departureMinutes, 120, 'The day clocks spring forward is 23 hours')
assert.equal(shifted('2026-10-31', '2026-11-01', 'America/New_York').legs[0].arrivalMinutes, 30)
assert.equal(shifted('2026-10-31', '2026-11-01').departureMinutes, 60, 'Without a zone the clock moves by whole days')

// Arrival windows use the public earlier-deadline search; depart-at keeps supported choices.
const body = { mode: 'transit', timePreference: 'arrive', arriveMinutes: 510, departMinutes: 510, serviceDate: '2026-07-15',
  origin: { coordinate: [-77.0501, 38.9001] }, destination: { coordinate: [-77.0299, 38.9099] }, departureWindowMinutes: 20 }
assert.equal(nativeRouteRequest(body).windowMinutes, 20)
assert.equal(nativeRouteRequest(body).windowChoices, undefined)
assert.equal(nativeRouteRequest({ ...body, departureWindowMinutes: 0 }).windowMinutes, undefined)
assert.equal(nativeRouteRequest({ ...body, timePreference: 'depart' }).windowChoices, 'supported')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-earlier-arrivals-'))
const meta = path.join(root, 'cities', 'fixture', '.vigo')
const store = path.join(meta, 'routing', 'feed.sqlite'), street = path.join(meta, 'osm', 'street-index.sqlite')
let api
try {
  const inputs = await writeCliFixtureInputs(root)
  await buildNationalGtfsStore({ zipPath: inputs.gtfsPath, outputPath: store })
  await buildNationalOsmStore({ pbfPath: inputs.osmPath, outputPath: street })
  compactNationalOsmRuntimeStore(street, { requireDrive: true }); buildNativeStreetCchIndex(street)
  disposeNationalOsmStore(street); disposeAllNationalGtfsStores()
  await fs.writeFile(path.join(meta, 'project.json'), JSON.stringify({ schemaVersion: 'vigo.project.v1', id: 'fixture', name: 'Fixture',
    routingStore: { status: 'ready', fileName: 'feed.sqlite' }, feeds: [{ id: 'feed', routingStore: { status: 'ready', fileName: 'feed.sqlite' } }],
    jobs: [], artifacts: [], osmStreetIndex: { status: 'ready', cch: { ready: true } } }))
  api = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'),
    environment: { VIGO_PROJECTS_DIR: path.join(root, 'cities'), VIGO_CONFIG_DIR: path.join(root, 'config') } })
  const post = async (action, request) => {
    const response = await api.requestJson(`/api/projects/fixture/${action}`, { method: 'POST', body: request })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body
  }
  const route = { ...body, feedId: 'feed', serviceDay: 'weekday', routingDataMode: 'scheduled', waypoints: [],
    maxWalkKm: 1.2, allowLongWalk: true, allowStreetTransfers: true, minimumTransferBufferMinutes: 0,
    sharedLegs: true, includeEarliestTransit: true, objective: 'earliest_arrival' }

  // Choosing Arrive by opens the preceding service day's timetable too.
  await post('national-ready', { feedId: 'feed', mode: 'transit', routingDataMode: 'scheduled', serviceDate: '2026-07-15',
    serviceDay: 'weekday', allowStreetTransfers: true, minimumTransferBufferMinutes: 0, timePreference: 'arrive' })

  const exact = await post('national-route', { ...route, departureWindowMinutes: 0 })
  const window = await post('national-route', route)
  const options = window.choices
  assert(options.length > 1, 'Earlier arrivals offers more than the exact deadline')
  assert(options.every(plan => plan.diagnostics.runtime === 'rust'))
  assert(options.every(plan => plan.timePreference === 'arrive' && plan.arriveMinutes <= 510 + 1e-6), 'Every option arrives by the deadline')
  assert(options.every(plan => plan.departMinutes >= 0), 'Options stay on the requested day')
  assert(options.every(plan => plan.diagnostics.arrivalWindow?.windowMinutes === 20 && plan.diagnostics.arrivalWindow.deadlineMinutes === 510))
  assert(options.every(plan => plan.diagnostics.departureWindow === undefined), 'An arrival window is not a departure window')
  assert.equal(window.selectedPlanId, options[0].id)
  assert.deepEqual(options.map(plan => plan.recommended), options.map((_, index) => index === 0))
  assert.equal(options[0].departMinutes, Math.max(...options.map(plan => plan.departMinutes)), 'The latest departure leads')
  assert(options.some(plan => plan.travelMode === 'transit' && plan.choiceLabel !== undefined))
  assert.equal(new Set(options.map(plan => plan.id)).size, options.length)
  const transit = options.find(plan => plan.travelMode === 'transit')
  assert.equal(transit.departMinutes, exact.choices.find(plan => plan.travelMode === 'transit')?.departMinutes ?? transit.departMinutes)

  // A deadline within the search horizon of midnight runs on the preceding
  // service day's clock; Studio presents the same options on the asked day.
  const early = await post('national-route', { ...route, horizonMinutes: 600 })
  const clock = plan => [plan.choiceLabel, plan.travelMode, Number(plan.departMinutes.toFixed(6)), Number(plan.arriveMinutes.toFixed(6)),
    plan.legs.map(leg => [leg.type, leg.tripId ?? null, Number(leg.startMinutes.toFixed(6)), Number(leg.endMinutes.toFixed(6))])]
  assert.deepEqual(early.choices.map(clock), options.map(clock))
  console.log('Earlier arrivals: native options by the deadline, latest departure first, preceding-day clock and daylight-saving service days passed.')
} finally {
  await api?.stop(); disposeAllNationalGtfsStores(); disposeNationalOsmStore(street)
  await fs.rm(root, { recursive: true, force: true })
}
