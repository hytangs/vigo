import assert from 'node:assert/strict'
import { importTestModules } from './helpers/import-test-modules.mjs'
const [routing, { city, resetCity }, { emptyCityProject }] = await importTestModules('state/route.ts', 'state/city.ts', 'app/projectState.ts')
const { route, runRoutingSearch, routingDisplayPoints, clearRouting, resetRoute } = routing
const original = globalThis.fetch
const requests = []
globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ url, signal: options.signal, reply: places => resolve(Response.json({ places })) }))
const settle = () => new Promise(resolve => setImmediate(resolve))
try {
  assert.equal(route.get().routingMinimumTransferBufferMinutes, 1, 'Studio starts with a boarding reserve between different services')
  routing.setRoutingMinimumTransferBuffer(0)
  assert.equal(route.get().routingMinimumTransferBufferMinutes, 0, 'Explicit timetable-only selection remains available')
  resetRoute()
  assert.equal(route.get().routingMinimumTransferBufferMinutes, 1, 'Reset restores the transfer reserve')
  city.set({ projects: ['one', 'two'].map(id => ({ ...emptyCityProject(), id })), selectedProjectId: 'one' })
  assert(runRoutingSearch('42.30,-71.00 to 42.30,-71.10'))
  const initial = route.get()
  assert.deepEqual(initial.routingOrigin.coordinate, [-71, 42.3], 'Place lookup must not delay coordinates')
  assert.deepEqual(initial.routingDestination.coordinate, [-71.1, 42.3])
  assert(requests[0].url.includes('points=-71,42.3;-71.1,42.3'))
  requests[0].reply([{ label: 'First Street' }, { label: 'Second Street' }])
  await settle()
  assert.equal(routingDisplayPoints().routingOrigin.label, 'First Street')
  assert.equal(routingDisplayPoints().routingDestination.label, 'Second Street')
  for (const key of ['routingOrigin', 'routingWaypoints', 'routingDestination', 'engine']) {
    assert.equal(route.get()[key], initial[key], `Naming must not replace the ${key} routing input or rerun the engine`)
  }

  assert(runRoutingSearch('41,11 to 41.1,11.1 to 41.2,11.2'))
  const stale = requests.at(-1)
  assert(runRoutingSearch('52,4 to 52.1,4.1 to 52.2,4.2'))
  assert(stale.signal.aborted)
  requests.at(-1).reply([{ label: 'Canal Street' }, { label: 'Bridge' }, { label: 'Market Square' }])
  await settle()
  stale.reply([{ label: 'Old address' }, { label: 'Old via' }, { label: 'Old destination' }])
  await settle()
  const shown = routingDisplayPoints()
  assert.deepEqual([shown.routingOrigin, ...shown.routingWaypoints, shown.routingDestination].map(point => point.label), ['Canal Street', 'Bridge', 'Market Square'])
  assert.deepEqual(route.get().routingOrigin.coordinate, [4, 52])
  assert(!runRoutingSearch('41,11 to 41,11'))
  assert.match(route.get().routingPointError, /same coordinates/, 'Identical endpoints must explain why no new journey is accepted')

  assert(runRoutingSearch('40,10 to 40.1,10.1'))
  const cleared = requests.at(-1)
  clearRouting()
  cleared.reply([{ label: 'Cleared address' }, { label: 'Cleared destination' }])
  await settle()
  assert.deepEqual(route.get().routingPointNames, {})
  assert.equal(route.get().routingOrigin, null)

  assert(runRoutingSearch('42,12 to 42.1,12.1'))
  requests.at(-1).reply([null, { label: { invalid: true } }])
  await settle()
  assert(!routingDisplayPoints().routingOrigin.named)
  assert(!routingDisplayPoints().routingDestination.named)
  assert.deepEqual(route.get().routingOrigin.coordinate, [12, 42], 'Missing local names retain exact input coordinates')

  assert(runRoutingSearch('43,13 to 43.1,13.1'))
  const previousCity = requests.at(-1)
  city.set({ selectedProjectId: 'two' })
  previousCity.reply([{ label: 'Wrong City' }])
  await settle()
  assert.deepEqual(route.get().routingPointNames, {})
  console.log('Coordinate searches: immediate locations, batched names, unchanged routing inputs, waypoints, latest-request ownership, reset/City cancellation and missing-name fallback passed.')
} finally { resetRoute(); resetCity(); globalThis.fetch = original }
