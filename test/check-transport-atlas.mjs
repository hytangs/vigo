import assert from 'node:assert/strict'
import { allocateProjectTransportAtlasBudgets, compactTransportPreview, transportAtlasBudgets } from '../src/server/transport-atlas.mjs'

const routes = Array.from({ length: 420 }, (_, patternIndex) => {
  const publicRouteIndex = patternIndex % 131
  return {
    id: `pattern-${patternIndex}`,
    patternId: `pattern-${patternIndex}`,
    routeId: `route-${publicRouteIndex}`,
    shortName: `${publicRouteIndex}`,
    longName: `Public route ${publicRouteIndex}`,
    tripCount: patternIndex === 419 ? 1_000_000 : 420 - patternIndex,
    stopIds: [`stop-${patternIndex % 7_645}`, `stop-${(patternIndex + 1) % 7_645}`],
    coordinates: Array.from({ length: 700 }, (_, pointIndex) => [
      -77.2 + pointIndex / 10_000,
      38.7 + patternIndex / 100_000,
    ]),
  }
})
const stops = Array.from({ length: 7_645 }, (_, index) => ({
  id: `stop-${index}`,
  name: `Stop ${index}`,
  lat: 38.7 + (index % 100) / 1_000,
  lon: -77.2 + Math.floor(index / 100) / 1_000,
  routes: [`route-${index % 131}`, `route-${(index + 130) % 131}`],
}))
const stopPairs = Array.from({ length: 4_000 }, (_, index) => ({
  id: `pair-${index}`,
  patternId: `pattern-${index % 420}`,
  fromStopId: `stop-${index}`,
  toStopId: `stop-${index + 1}`,
}))

const source = {
  routes,
  stops,
  stopPairs,
  coverage: { capped: false, stopPairsIndexed: stopPairs.length },
}
const compact = compactTransportPreview(source, { routingReady: true })
const publicRouteIds = compact.routes.map((route) => route.routeId)
const shapePoints = compact.routes.reduce((sum, route) => sum + route.coordinates.length, 0)

assert(compact.routes.length <= transportAtlasBudgets.routes)
assert.equal(new Set(publicRouteIds).size, compact.routes.length, 'Initial atlas must carry one representative pattern per public route.')
assert(compact.stops.length <= transportAtlasBudgets.stops)
assert.equal(compact.stopPairs.length, 0, 'Segments are hidden on first paint, so stop-pair payload must be deferred.')
assert(shapePoints <= transportAtlasBudgets.shapePoints)
assert(publicRouteIds.includes('route-26'), 'The highest-service representative must survive the public-route LOD.')
for (const route of compact.routes) {
  const original = routes.find((candidate) => candidate.id === route.id)
  assert.deepEqual(route.coordinates[0], original.coordinates[0])
  assert.deepEqual(route.coordinates.at(-1), original.coordinates.at(-1))
}
assert.equal(compact.coverage.capped, true)
assert.equal(compact.coverage.stopPairsIndexed, stopPairs.length)
assert.equal(compact.coverage.transportLod.stopPairsDeferred, stopPairs.length)
const visiblePublicRouteIds = new Set(compact.routes.map((route) => route.routeId))
assert(compact.stops.every((stop) => stop.routes.every((routeId) => visiblePublicRouteIds.has(routeId))), 'Sampled stops must not reference route metadata deferred from the initial atlas.')
assert(compact.stops.every((stop) => stop.routes.length > 0), 'Every first-paint stop must belong to a visible representative route.')
assert(Buffer.byteLength(JSON.stringify(compact)) < 2_000_000, 'Synthetic DC-scale first-paint atlas must stay below 2 MB.')

const untouched = compactTransportPreview(source, { routingReady: false })
assert.strictEqual(untouched, source, 'Small/local feeds without a routing store must retain their existing transport contract.')

const projectBudgets = allocateProjectTransportAtlasBudgets([
  { id: 'bus', mapPreview: { routes: Array.from({ length: 125 }, (_, index) => ({ id: `bus-${index}`, routeId: `bus-${index}` })), stops: Array(7_520).fill({}) } },
  { id: 'rail', mapPreview: { routes: Array.from({ length: 6 }, (_, index) => ({ id: `rail-${index}`, routeId: `rail-${index}` })), stops: Array(125).fill({}) } },
])
assert.equal(projectBudgets.get('rail').routes, 6, 'Every small rail identity must survive project-wide LOD allocation.')
assert.equal(projectBudgets.get('bus').routes, 125, 'Every public bus identity must survive project-wide atlas allocation.')
assert.equal(projectBudgets.get('rail').stops, 125)
assert.equal(projectBudgets.get('bus').stops, 7_520)
assert.equal([...projectBudgets.values()].reduce((sum, budget) => sum + budget.routes, 0), 131)
assert.equal([...projectBudgets.values()].reduce((sum, budget) => sum + budget.stops, 0), 7_645)
assert.equal([...projectBudgets.values()].reduce((sum, budget) => sum + budget.shapePoints, 0), 200_000)

const duplicateNameAtlas = compactTransportPreview({
  routes: [
    { id: 'branch-a', routeId: 'agency-a-1', shortName: '1', longName: 'Alpha → Bravo', tripCount: 10, stopIds: [], coordinates: [[0, 0], [1, 1]] },
    { id: 'branch-b', routeId: 'agency-b-1', shortName: '1', longName: 'Charlie → Delta', tripCount: 9, stopIds: [], coordinates: [[2, 2], [3, 3]] },
  ],
  stops: [],
  stopPairs: [],
}, {
  routingReady: true,
  budgets: { routes: 2, stops: 0, shapePoints: 4, stopPairs: 0 },
})
assert.deepEqual(
  duplicateNameAtlas.routes.map((route) => route.routeId).sort(),
  ['agency-a-1', 'agency-b-1'],
  'Atlas compaction must preserve distinct GTFS route IDs that share one public name.',
)

console.log(`Transport atlas behavior passed (${compact.routes.length} routes, ${compact.stops.length} stops, ${shapePoints} shape points).`)
