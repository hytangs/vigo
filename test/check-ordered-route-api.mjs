import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'
import { buildNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-ordered-api-'))
const metadata = path.join(root, 'cities', 'fixture', '.vigo')
const store = path.join(metadata, 'routing', 'feed.sqlite'), street = path.join(metadata, 'osm', 'street-index.sqlite')
const points = [[-77.05, 38.9], [-77.04, 38.905], [-77.03, 38.91]].map((coordinate, i) => ({ label: `Point ${i}`, coordinate, source: 'map' }))
let api
try {
  const inputs = await writeCliFixtureInputs(root)
  await buildNationalGtfsStore({ zipPath: inputs.gtfsPath, outputPath: store })
  await buildNationalOsmStore({ pbfPath: inputs.osmPath, outputPath: street })
  compactNationalOsmRuntimeStore(street); buildNativeStreetCchIndex(street)
  disposeNationalOsmStore(street); disposeAllNationalGtfsStores()
  await fs.writeFile(path.join(metadata, 'project.json'), JSON.stringify({ id: 'fixture', name: 'Fixture',
    routingStore: { status: 'ready', fileName: 'feed.sqlite' }, feeds: [{ id: 'feed', routingStore: { status: 'ready', fileName: 'feed.sqlite' } }],
    jobs: [], artifacts: [], osmStreetIndex: { status: 'ready', cch: { ready: true } },
  }))
  api = await startInMemoryVigoApi({ repositoryRoot: path.resolve(import.meta.dirname, '..'),
    environment: { VIGO_PROJECTS_DIR: path.join(root, 'cities'), VIGO_CONFIG_DIR: path.join(root, 'config'), VIGO_ROUTE_PROJECT_PREWARM: '0' } })
  const post = async body => {
    const result = await api.requestJson('/api/projects/fixture/national-route', { method: 'POST', body })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return result.body.choices
  }
  const base = { mode: 'transit', serviceDate: '2026-09-14', serviceDay: 'weekday', routingDataMode: 'scheduled',
    departMinutes: 535, arriveMinutes: 580, maxWalkKm: 1.2, allowLongWalk: true, maxStreetKm: 50,
    objective: 'earliest_arrival', departureWindowMinutes: 20, departureWindowDirection: 'forward',
  }
  for (const ordered of [points, [points[1], points[0], points[2]]]) {
    for (const timePreference of ['depart', 'arrive']) {
      const request = { ...base, timePreference, origin: ordered[0], waypoints: [ordered[1]], destination: ordered[2] }
      const [plan] = await post(request), [walk] = await post({ ...request, mode: 'walk' })
      assert.equal(plan.status, 'ready'); assert.equal(plan.travelMode, 'walk')
      assert.deepEqual(plan.legs.map(leg => leg.coordinates), walk.legs.map(leg => leg.coordinates), 'Transit walking fallback must retain the exact directed street path')
      assert(Math.abs(plan.departMinutes - walk.departMinutes) < 0.003)
      assert(Math.abs(plan.arriveMinutes - walk.arriveMinutes) < 0.003)
      assert.equal(plan.legs.length, 2); assert.equal(plan.legs[0].orderedSegmentIndex, 0); assert.equal(plan.legs[1].orderedSegmentIndex, 1)
      assert(Math.abs(plan.legs[0].endMinutes - plan.legs[1].startMinutes) < 0.003, 'No rounded-minute gap at the waypoint')
    }
  }
  const mixed = await post({ ...base, departMinutes: 479, origin: points[0], waypoints: [points[1]], destination: points[2] })
  assert(mixed.some(plan => plan.legs.some(leg => leg.type === 'walk')), 'Do not force all ordered legs to board a vehicle')
  for (const arriveMinutes of [470, 5]) {
    const request = { ...base, timePreference: 'arrive', departMinutes: arriveMinutes, arriveMinutes,
      origin: points[0], waypoints: [points[1]], destination: points[2] }
    const [plan] = await post(request), [walk] = await post({ ...request, mode: 'walk' })
    assert.equal(plan.travelMode, 'walk')
    assert(Math.abs(plan.departMinutes - walk.departMinutes) < 0.003, 'Previous-day components must share the original requested clock')
    assert(Math.abs(plan.arriveMinutes - arriveMinutes) < 0.003)
    assert.equal(plan.diagnostics.routingDataProvenance.serviceDate, base.serviceDate)
  }
  const boundedWalk = await post({ ...base, origin: points[0], waypoints: [points[1]], destination: points[2], allowLongWalk: false, maxWalkKm: 0.2 })
  assert(!boundedWalk.some(plan => plan.status === 'ready' && plan.travelMode === 'walk'), 'A waypoint must not bypass the caller walking limit')
  const pairs = await Promise.all(Array.from({ length: 4 }, () => post({ ...base, origin: points[0], waypoints: [points[1]], destination: points[2] })))
  for (const choices of pairs) assert.deepEqual(choices[0].legs, pairs[0][0].legs, 'Concurrent requests must return the same itinerary')
  console.log('Ordered API: both waypoint orders, depart/arrive, exact walking geometry, fractional clocks, mixed-mode and concurrent requests passed.')
} finally {
  await api?.stop(); disposeAllNationalGtfsStores(); disposeNationalOsmStore(street)
  await fs.rm(root, { recursive: true, force: true })
}
