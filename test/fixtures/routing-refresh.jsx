import React from 'react'
import { createRoot } from 'react-dom/client'
import { useNationalRouting } from '../../src/app/useNationalRouting'
import { readRoutingDataModePreference, saveRoutingDataModePreference, routingDataModeStorageKey } from '../../src/app/routingDataMode'

const root = createRoot(document.getElementById('root'))
const requests = [], readinessRequests = [], errors = []
let state
const snapshot = revision => ({ sourceUrl: 'https://example.org/rt', fetchedAt: new Date(revision * 1000).toISOString(), feedTimestamp: revision, tripUpdates: [] })
let options = {
  active: true, projectId: 'city-x', feedId: 'feed', storeKey: 'timetable-1', streetKey: 'streets-1',
  origin: { id: 'A', label: 'Origin', source: 'map', coordinate: [0, 0] }, waypoints: [],
  destination: { id: 'B', label: 'Destination', source: 'map', coordinate: [1, 1] },
  mode: 'transit', routingDataMode: 'realtime', departMinutes: 480, timePreference: 'arrive', serviceDay: 'weekday', serviceDate: '2026-09-15',
  maxWalkKm: 1, maxTransfers: 2, allowLongWalk: false, departureWindowMinutes: 0,
  realtimeSnapshot: snapshot(1), routeAllowed: true, onError: error => errors.push(error),
}
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
const originalFetch = window.fetch
const realSetTimeout = window.setTimeout.bind(window)
window.fetch = async (url, init) => {
  if (url.endsWith('/national-ready')) {
    readinessRequests.push(JSON.parse(init.body))
    return response({ routing: { ready: true } })
  }
  if (!url.endsWith('/national-route')) return originalFetch(url, init)
  return new Promise(resolve => requests.push({ body: JSON.parse(init.body), signal: init.signal, resolve }))
}
function Harness(props) {
  state = useNationalRouting(props)
  return <output>{state.loading ? 'Calculating' : state.choices.map(choice => choice.id).join(',')}</output>
}
const check = (condition, message) => { if (!condition) throw Error(message) }
const settle = () => new Promise(resolve => realSetTimeout(resolve, 30))
const wait = async predicate => {
  const end = performance.now() + 5000
  while (!predicate()) { if (performance.now() > end) throw Error('Timed out: ' + predicate); await settle() }
}
async function render(patch = {}) {
  options = { ...options, ...patch }
  root.render(<Harness {...options} />)
  await settle()
}
function complete(index, id = `route-${index}`) {
  requests[index].resolve(response({ plan: {
    id, status: 'ready', travelMode: requests[index].body.mode, timePreference: 'depart',
    departMinutes: 480, arriveMinutes: 500, durationMinutes: 20, diagnostics: {},
    legs: [{ type: 'ride', startMinutes: 480, endMinutes: 500, durationMinutes: 20 }],
  } }))
}
window.runTests = async () => {
  localStorage.removeItem(routingDataModeStorageKey)
  check(readRoutingDataModePreference() === 'realtime', 'Realtime is the default')
  saveRoutingDataModePreference('scheduled')
  check(readRoutingDataModePreference() === 'scheduled', 'Research preference persists')
  localStorage.removeItem(routingDataModeStorageKey)

  await render()
  await wait(() => requests.length === 1)
  check(requests[0].body.departNow === true && requests[0].body.timePreference === 'depart', 'Realtime uses the server departure clock')
  for (const field of ['serviceDate', 'serviceDay', 'departMinutes', 'arriveMinutes']) {
    check(!(field in requests[0].body) && !(field in readinessRequests[0]), `Realtime omits research ${field}`)
  }
  check(readinessRequests[0].departNow === true, 'Readiness uses the server clock')
  for (let revision = 2; revision <= 5; revision++) await render({ realtimeSnapshot: snapshot(revision) })
  check(requests.length === 1 && !requests[0].signal.aborted, 'Live polls cannot restart a pending journey')
  check(requests[0].body.realtimeSnapshot.feedTimestamp === 1, 'The pending request retains its captured observation')
  complete(0)
  await wait(() => state.choices[0]?.id === 'route-0')
  for (let revision = 6; revision <= 9; revision++) await render({ realtimeSnapshot: snapshot(revision) })
  check(requests.length === 1 && state.choices[0]?.id === 'route-0', 'Live polls leave the completed journey visible')
  await render({ realtimeSnapshot: { ...snapshot(9), fetchedAt: snapshot(10).fetchedAt } })
  check(requests.length === 1, 'Poll receipt time cannot reroute')

  // Crossing many feed/entity expiry boundaries must not schedule reroutes.
  const originalNow = Date.now
  const originalSetTimeout = window.setTimeout
  let expiryTimers = 0
  window.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) >= 1000) expiryTimers++
    return originalSetTimeout.call(window, callback, delay, ...args)
  }
  try {
    const now = originalNow()
    const fresh = { ...snapshot(Math.floor(now / 1000)), tripUpdates: Array.from({ length: 180 }, (_, index) => ({
      tripId: `trip-${index}`, timestamp: Math.floor(now / 1000) - index,
    })) }
    await render({ realtimeSnapshot: fresh })
    state.reset()
    await settle()
    await wait(() => requests.length === 2)
    complete(1, 'captured-live-route')
    await wait(() => state.choices[0]?.id === 'captured-live-route')
    for (const elapsed of [1000, 60_000, 180_001, 3_600_000]) {
      Date.now = () => now + elapsed
      await render()
    }
    check(requests.length === 2 && expiryTimers === 0 && state.choices[0]?.id === 'captured-live-route', 'Observation expiry cannot trigger repeated route requests')
  } finally {
    Date.now = originalNow
    window.setTimeout = originalSetTimeout
  }
  await render({ active: false, realtimeSnapshot: snapshot(20) })
  await render({ active: true })
  check(requests.length === 2 && state.choices[0]?.id === 'captured-live-route', 'Navigation retains a completed journey')
  state.reset()
  await settle()
  await wait(() => requests.length === 3)
  check(requests[2].body.realtimeSnapshot.feedTimestamp === 20, 'Explicit Run captures the latest snapshot without requiring new point objects')
  await render({ maxWalkKm: 1.2, realtimeSnapshot: snapshot(21) })
  await wait(() => requests.length === 4)
  check(requests[2].signal.aborted && requests[3].body.realtimeSnapshot.feedTimestamp === 21, 'Changed route inputs cancel old work and use current observations')
  complete(3)
  await wait(() => state.choices[0]?.id === 'route-3')
  complete(2, 'late-obsolete-route')
  await settle()
  check(state.choices[0]?.id === 'route-3', 'Late responses cannot replace the current journey')
  await render({ departMinutes: 490, serviceDate: '2026-09-16' })
  check(requests.length === 4, 'Hidden research clock changes cannot reroute realtime')

  await render({ routingDataMode: 'scheduled' })
  await wait(() => requests.length === 5)
  const research = requests[4].body
  check(!research.realtimeSnapshot && !research.departNow && research.serviceDate === '2026-09-16' && research.arriveMinutes === 490 && research.timePreference === 'arrive', 'Research restores the retained date/time without live data')
  await render({ realtimeSnapshot: snapshot(22) })
  check(requests.length === 5 && !requests[4].signal.aborted, 'Research ignores live polls')
  complete(4)
  await wait(() => !state.loading)
  await render({ routingDataMode: 'realtime' })
  await wait(() => requests.length === 6)
  check(requests[5].body.realtimeSnapshot.feedTimestamp === 22 && !state.choices.length, 'Mode switch captures the latest observation')
  complete(5)
  await wait(() => !state.loading)

  for (const mode of ['walk', 'drive']) {
    const before = requests.length
    await render({ mode })
    await wait(() => requests.length === before + 1)
    check(!requests.at(-1).body.realtimeSnapshot, `${mode} excludes live observations`)
    await render({ realtimeSnapshot: snapshot(23) })
    check(requests.length === before + 1, `${mode} ignores polling`)
    complete(before)
    await wait(() => !state.loading)
  }
  let beforeVia = requests.length
  await render({ mode: 'transit', maxTransfers: 1, waypoints: [{ id: 'via', label: 'Via', source: 'map', coordinate: [0.5, 0.5] }] })
  await wait(() => requests.length === beforeVia + 1)
  check(requests.at(-1).body.maxTransfers === undefined, 'Via-point requests omit the unsupported transfer cap')
  requests.at(-1).resolve(new Response(JSON.stringify({ error: 'Routing fixture failure' }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
  await wait(() => state.error === 'Routing fixture failure')
  check(errors.length === 0, 'Routing errors stay in the route panel instead of a persistent global banner')
  state.reset()
  await wait(() => requests.length === beforeVia + 2)
  check(!state.error, 'Retry clears the routing error')
  complete(requests.length - 1)
  await wait(() => !state.loading)
  await render({ waypoints: [] })
  await wait(() => requests.length === beforeVia + 3)
  check(requests.at(-1).body.maxTransfers === 1, 'Removing via points restores the chosen transfer cap')
  complete(requests.length - 1)
  await wait(() => !state.loading)
  let count = requests.length
  await render({ active: false, streetKey: 'streets-2' })
  check(!state.choices.length && requests.length === count, 'Street changes invalidate without background routing')
  await render({ active: true })
  await wait(() => requests.length === count + 1)
  complete(count)
  await wait(() => !state.loading)
  count = requests.length
  await render({ active: false, projectId: 'city-y', storeKey: 'timetable-2' })
  check(!state.choices.length, 'A new City cannot retain the previous journey')
  await render({ active: true, mode: 'transit' })
  await wait(() => requests.length === count + 1)
  const last = requests.at(-1)
  root.unmount()
  check(last.signal.aborted, 'Unmount aborts pending work')
  complete(requests.length - 1, 'after-unmount')
  await settle()
  check(errors.length === 0, 'No unexpected route errors: ' + errors)
  return { waypointTransferControls: true, routeErrorRecovery: true, stableLiveJourney: true, noExpiryLoop: true, explicitRerun: true, latestSnapshotOnInputChange: true, latestResponseWins: true, researchIsolation: true, streetIsolation: true, navigationRetention: true, cityInvalidation: true }
}
