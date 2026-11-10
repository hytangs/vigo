// Matrix shares search work; its oracle must remain independent point Route.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
import { routeNationalStreetMatrix, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-bike-matrix-'))
const stores = []
let pairs = 0
let reachPairs = 0
function stream(city, requests) {
  const child = spawnSync(binary, ['stream', '--city', city], {
    input: requests.map(q => JSON.stringify(q)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(child.status, 0, child.stderr)
  const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(replies.length, requests.length)
  return replies
}
function close(actual, expected, label) {
  if (expected == null) assert.equal(actual, null, label)
  else assert(actual != null && Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`)
}
try {
  for (const variant of ['ordinary', 'timed', 'footpath', 'access', 'access-timed', 'access-blocked']) {
    const dir = path.join(directory, variant); fs.mkdirSync(dir)
    const fixture = await writeCliFixtureInputs(dir, variant.startsWith('access') ? { bikeAccessDetour: variant.slice(7) || 'static' }
      : variant === 'timed' ? { bikeConditionalTurn: true }
      : variant === 'footpath' ? { terminalAccess: true,
        terminalWayTags: { 12: { access: 'yes', highway: 'footway' }, 13: { foot: 'yes' } },
        terminalNodeCoordinates: { 5: [-77.054, 38.902], 6: [-77.05, 38.902] } } : {})
    const city = path.join(dir, 'city'), store = path.join(city, 'osm/street-index.sqlite'); stores.push(store)
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${fixture.gtfsPath}`, `--osm=${fixture.osmPath}`,
      '--street-modes=walk,bike', `--output=${city}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
    const fixed = variant === 'footpath' ? [-77.054, 38.9]
      : variant.startsWith('access') ? [-77.049, 38.9005] : [-77.05, 38.9]
    if (variant === 'ordinary') {
      // Node's existing public limit is 100,000 pairs; standalone has its own
      // smaller protocol cap. Native batching must not narrow the Node limit.
      const large = routeNationalStreetMatrix(store, { mode: 'bike',
        origins: Array(257).fill(fixed), destinations: Array(256).fill([-77.03, 38.91]) })
      assert.equal(large.rows.length, 65792)
      assert.equal(large.diagnostics.pointQueries, 1)
      assert(large.rows.every(row => row.status === 'ready'))
      const via = [-77.04, 38.905], end = [-77.03, 38.91]
      const ordered = routeNationalStreetMatrix(store, { mode: 'bike', origins: [fixed], destinations: [end], via: [via] })
      const first = routeNationalStreetMatrix(store, { mode: 'bike', origins: [fixed], destinations: [via] })
      const second = routeNationalStreetMatrix(store, { mode: 'bike', origins: [via], destinations: [end] })
      assert.equal(ordered.rows[0].status, 'ready')
      close(ordered.rows[0].distanceKm, first.rows[0].distanceKm + second.rows[0].distanceKm,
        'Ordered Matrix retains the sum of segment distances')
    }
    const targets = variant.startsWith('access')
      ? Array.from({ length: 128 }, (_, i) => {
        const t = .1 + (i % 64) / 64 * .8
        // The first road needs no destination permission. The second grants a
        // different restricted component, never the shortcut between 2 and 3.
        return i < 64 ? [-77.03 + t * .01, 38.91 + t * .005]
          : [-77.02 + t * .01, 38.915 - t * .005]
      })
      : Array.from({ length: 64 }, (_, i) => [-77.039 + i / 64 * .008, 38.9055 + i / 64 * .004])
    targets.push(targets[3], [-78, 39])
    for (const profile of ['fast', 'balanced', 'quiet']) for (const arrive of [false, true]) {
      const origins = arrive ? targets : [fixed, fixed]
      const destinations = arrive ? [fixed, fixed] : targets
      const common = { mode: 'bike', bike: { profile }, time: '08:30', timePreference: arrive ? 'arrive_by' : 'depart_at',
        serviceDate: '2026-07-15', maxWalkKm: variant === 'footpath' ? .9 : .001, maxStreetKm: 10, diagnostics: 'trace' }
      const pointRequests = origins.flatMap(origin => destinations.map(destination => ({ ...common, kind: 'route', origin, destination })))
      const [before, ...rest] = stream(city, [{ kind: 'info' }, ...pointRequests,
        { kind: 'info' }, { ...common, kind: 'matrix', origins, destinations }, { kind: 'info' }])
      assert.equal(before.memory.ledger.bike, null)
      const routes = rest.slice(0, pointRequests.length)
      const loaded = rest.at(-3), matrix = rest.at(-2), after = rest.at(-1)
      assert.equal(matrix.status, 'ok', JSON.stringify(matrix))
      assert.equal(matrix.trace.diagnostics.sharedFields, 1)
      if (variant === 'access-blocked') {
        assert(routes.every(route => route.status === 'not_found'), 'Unauthorized shortcuts cannot connect blocked destinations')
      }
      assert.equal(matrix.trace.diagnostics[arrive ? 'uniqueDestinations' : 'uniqueOrigins'], 1)
      assert.equal(after.memory.ledger.bike.networkHeapBytes, loaded.memory.ledger.bike.networkHeapBytes,
        'Matrix must not retain an additional graph or endpoint cache')
      const nodeRequest = { ...common, origins, destinations, departMinutes: 510, arriveMinutes: 510, timeZone: 'America/New_York' }
      const node = routeNationalStreetMatrix(store, nodeRequest)
      assert.equal(node.diagnostics.sharedFields, 1)
      routes.forEach((route, index) => {
        assert(['ok', 'not_found'].includes(route.status), JSON.stringify(route))
        const i = Math.floor(index / destinations.length), j = index % destinations.length
        const seconds = route.status === 'ok' ? route.trace.durationMinutes * 60 + (arrive ? route.trace.diagnostics.earlyArrivalSeconds ?? 0 : 0) : null
        const meters = route.status === 'ok' ? route.trace.distanceMeters : null
        const label = `${variant} ${profile} ${arrive} ${i},${j}`
        close(matrix.trace.durationsMinutes[i][j] == null ? null : matrix.trace.durationsMinutes[i][j] * 60, seconds, label + ' native seconds')
        close(matrix.distancesMeters[i][j], meters, label + ' native meters')
        close(node.rows[index].durationMinutes == null ? null : node.rows[index].durationMinutes * 60, seconds, label + ' Node seconds')
        close(node.rows[index].distanceKm == null ? null : node.rows[index].distanceKm * 1000, meters, label + ' Node meters')
        assert.equal(node.rows[index].originIndex, i); assert.equal(node.rows[index].destinationIndex, j)
        pairs++
      })
      // Supplying cancellation retains the point path and its interruption checks.
      const cancellable = routeNationalStreetMatrix(store, { ...nodeRequest, origins: origins.slice(0, 2), destinations: destinations.slice(0, 2) }, { isCancelled: () => false })
      cancellable.rows.forEach(row => {
        const index = row.originIndex * destinations.length + row.destinationIndex
        close(row.durationMinutes, node.rows[index].durationMinutes, 'cancellation path')
        close(row.distanceKm, node.rows[index].distanceKm, 'cancellation distance')
      })
      assert.throws(() => routeNationalStreetMatrix(store, nodeRequest, { isCancelled: () => true }), /cancel|abort/i)
      if (variant === 'access' && profile === 'fast' && !arrive) {
        const bounds = [-77.0290001, 38.9104999, -77.0289999, 38.9105001], size = 16
        const cells = Array.from({ length: size * size }, (_, i) => [
          bounds[0] + (i % size + .5) / size * (bounds[2] - bounds[0]),
          bounds[3] - (Math.floor(i / size) + .5) / size * (bounds[3] - bounds[1]),
        ])
        const [reach, ...pointRoutes] = stream(city, [
          { ...common, maxStreetKm: undefined, kind: 'reach', origin: fixed, bounds, rasterSize: size,
            cutoffsMinutes: [120], reachFormat: 'surface', includeStreetEdges: false, includeNodes: false },
          ...cells.map(destination => ({ ...common, kind: 'route', origin: fixed, destination })),
        ])
        assert.equal(reach.status, 'ok')
        assert.equal(reach.trace.diagnostics.bike.algorithm, 'bike_movement_cch_surface')
        // Empty permission sets need no component keys in the shared frontier.
        assert(reach.trace.diagnostics.bike.accessGroupKeyBytes >= 0)
        assert(reach.trace.diagnostics.bike.accessGroupKeyBytes <= 512 * 1024)
        pointRoutes.forEach((route, i) => {
          assert.equal(route.status, 'ok')
          assert.equal(reach.surface.valuesSeconds[i], route.journey.durationSeconds)
          reachPairs++
        })
        const capped = stream(city, [{ ...common, kind: 'matrix', origins: [fixed], destinations: targets, maxStreetKm: 1 }])[0]
        assert.equal(capped.status, 'ok')
        assert(capped.durationsSeconds[0].every(v => v === null), 'No legal detour fits the distance cap')
        assert(capped.trace.diagnostics.pointQueries > 0, 'Distance caps still require point verification')
      }
    }
    disposeNationalOsmStore(store)
  }
  console.log(`Bike Matrix: ${pairs} independent Route pairs matched in native and Node time/distance; ${reachPairs} additional Reach cells matched point Route. Three profiles, both directions, timed turns, footpaths, restricted shortcuts and detours, distance caps, duplicates, blocked endpoints and resident graph size passed.`)
} finally {
  for (const store of stores) disposeNationalOsmStore(store)
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
