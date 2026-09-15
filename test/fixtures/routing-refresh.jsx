import React from 'react'
import { createRoot } from 'react-dom/client'
import { useNationalRouting } from '../../src/app/useNationalRouting'

const root = createRoot(document.getElementById('root'))
const requests = [], errors = []
let state
const snapshot = revision => ({ sourceUrl: 'https://example.org/rt', fetchedAt: new Date(revision * 1000).toISOString(), feedTimestamp: revision, tripUpdates: [] })
let options = {
  active: true, projectId: 'city-x', feedId: 'feed', storeKey: 'timetable-1', streetKey: 'streets-1',
  origin: { id: 'A', label: 'Origin', source: 'map', coordinate: [0, 0] }, waypoints: [],
  destination: { id: 'B', label: 'Destination', source: 'map', coordinate: [1, 1] },
  mode: 'transit', departMinutes: 480, timePreference: 'depart', serviceDay: 'weekday', serviceDate: '2026-09-15',
  maxWalkKm: 1, maxTransfers: 2, allowLongWalk: false, departureWindowMinutes: 0,
  realtimeSnapshot: snapshot(1), routeAllowed: true, onError: error => errors.push(error),
}
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
const originalFetch = window.fetch
window.fetch = async (url, init) => {
  if (url.endsWith('/national-ready')) return response({ routing: { ready: true } })
  if (!url.endsWith('/national-route')) return originalFetch(url, init)
  return new Promise(resolve => requests.push({ body: JSON.parse(init.body), signal: init.signal, resolve }))
}
function Harness(props) {
  state = useNationalRouting(props)
  return <output>{state.loading ? 'Calculating' : state.choices.map(choice => choice.id).join(',')}</output>
}
const check = (condition, message) => { if (!condition) throw Error(message) }
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
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
  await render()
  await wait(() => requests.length === 1)
  for (let revision = 2; revision <= 6; revision++) await render({ realtimeSnapshot: snapshot(revision) })
  check(requests.length === 1 && !requests[0].signal.aborted, 'Feed refresh must not cancel or restart a pending route')
  check(requests[0].body.realtimeSnapshot.feedTimestamp === 1, 'A journey uses the observation at request time')
  complete(0)
  await wait(() => state.choices[0]?.id === 'route-0')
  await render({ realtimeSnapshot: snapshot(7) })
  check(requests.length === 1 && state.choices[0]?.id === 'route-0', 'Refresh must not clear completed choices')
  await render({ active: false })
  await render({ realtimeSnapshot: snapshot(8), routeAllowed: false })
  await render({ active: true })
  await render({ routeAllowed: true })
  check(requests.length === 1 && state.choices[0]?.id === 'route-0', 'Navigation/readiness checks must retain the completed journey')

  // The existing Run action resets and supplies new point objects.
  state.reset()
  await render({ origin: { ...options.origin } })
  await wait(() => requests.length === 2)
  check(requests[1].body.realtimeSnapshot.feedTimestamp === 8, 'Explicit rerun captures the latest observation')
  await render({ departMinutes: 490 })
  await wait(() => requests.length === 3)
  check(requests[1].signal.aborted, 'Changing departure time cancels superseded work')
  complete(2)
  await wait(() => state.choices[0]?.id === 'route-2')
  complete(1, 'late-obsolete-route')
  await settle()
  check(state.choices[0]?.id === 'route-2', 'Late obsolete responses must not overwrite a newer journey')

  for (const patch of [{ serviceDate: '2026-09-16' }, { storeKey: 'timetable-rebuilt' }]) {
    const count = requests.length
    await render(patch)
    await wait(() => requests.length === count + 1)
    check(!state.choices.length, 'A changed service date or timetable invalidates the old journey')
    complete(count)
    await wait(() => !state.loading)
  }

  for (const mode of ['walk', 'drive']) {
    await render({ mode })
    const count = requests.length
    check(!requests.at(-1).body.realtimeSnapshot, `${mode} must not send realtime data`)
    await render({ realtimeSnapshot: snapshot(9) })
    check(requests.length === count && !requests.at(-1).signal.aborted, `${mode} must ignore dashboard refreshes`)
    complete(count - 1)
    await wait(() => !state.loading)
  }
  let count = requests.length
  await render({ active: false, streetKey: 'streets-2' })
  check(!state.choices.length && requests.length === count, 'Changed streets invalidate results without routing in the background')
  count++
  await render({ active: true })
  await wait(() => requests.length === count)
  complete(count - 1)
  await wait(() => !state.loading)
  await render({ active: false, projectId: 'city-y', storeKey: 'timetable-2' })
  check(!state.choices.length, 'A new City cannot display the previous City journey')
  await render({ active: true, mode: 'transit' })
  await wait(() => requests.length === count + 1)
  const last = requests.at(-1)
  root.unmount()
  check(last.signal.aborted, 'Unmount aborts pending route work')
  complete(requests.length - 1, 'after-unmount')
  await settle()
  check(errors.length === 0, 'Cancellation is not a route error: ' + errors)
  return { feedRefreshIsolation: true, retainedNavigation: true, explicitRerun: true, latestResponseWins: true, streetModes: true, cityAndStreetInvalidation: true, unmountCancellation: true }
}
