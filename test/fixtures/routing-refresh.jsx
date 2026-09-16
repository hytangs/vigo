import React from 'react'
import { createRoot } from 'react-dom/client'
import { useNationalRouting } from '../../src/app/useNationalRouting'
import { readRoutingDataModePreference, saveRoutingDataModePreference, routingDataModeStorageKey, routingObservationValidity } from '../../src/app/routingDataMode'

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
  check(readRoutingDataModePreference() === 'realtime', 'Realtime is the default mode')
  saveRoutingDataModePreference('scheduled')
  check(readRoutingDataModePreference() === 'scheduled', 'Research mode survives preference reload')
  localStorage.setItem(routingDataModeStorageKey, 'unknown')
  check(readRoutingDataModePreference() === 'realtime', 'Unknown saved values use the explicit default')
  localStorage.removeItem(routingDataModeStorageKey)

  await render()
  await wait(() => requests.length === 1)
  check(requests[0].body.routingDataMode === 'realtime', 'The API receives the explicit realtime mode')
  check(requests[0].body.departNow === true && requests[0].body.timePreference === 'depart', 'Realtime overrides retained arrive-by with a server-clock departure')
  for (const field of ['serviceDate', 'serviceDay', 'departMinutes', 'arriveMinutes']) {
    check(!(field in requests[0].body), `Realtime must not send the retained research ${field}`)
    check(!(field in readinessRequests[0]), `Realtime readiness must not prepare the retained research ${field}`)
  }
  check(readinessRequests[0].departNow === true, 'Readiness resolves the same agency-clock departure policy')
  check(readinessRequests[0].mode === 'transit' && readinessRequests[0].routingDataMode === 'realtime', 'Readiness identifies the explicit transit realtime mode')
  check(state.serviceDateAvailability === 'unknown' && state.serviceDateOptions.length === 0, 'Saved research coverage cannot prevent a current-time route')
  await render({ realtimeSnapshot: snapshot(1) })
  check(requests.length === 1 && !requests[0].signal.aborted, 'An identical observation must not restart a route')
  check(requests[0].body.realtimeSnapshot.feedTimestamp === 1, 'A journey uses the observation at request time')
  complete(0)
  await wait(() => state.choices[0]?.id === 'route-0')

  await render({ realtimeSnapshot: snapshot(2) })
  await wait(() => requests.length === 2)
  check(!state.choices.length, 'A new realtime observation invalidates the old result')
  await render({ realtimeSnapshot: snapshot(3) })
  await wait(() => requests.length === 3)
  check(requests[1].signal.aborted, 'A newer realtime observation cancels superseded work')
  complete(2)
  await wait(() => state.choices[0]?.id === 'route-2')
  complete(1, 'late-obsolete-realtime')
  await settle()
  check(state.choices[0]?.id === 'route-2', 'Obsolete feed responses cannot overwrite the newer observation')
  await render({ realtimeSnapshot: { ...snapshot(3), fetchedAt: snapshot(4).fetchedAt } })
  await wait(() => requests.length === 4)
  check(requests[3].body.realtimeSnapshot.feedTimestamp === 3, 'An unchanged feed is rechecked when a later poll can change freshness')

  await render({ routingDataMode: 'scheduled' })
  await wait(() => requests.length === 5)
  check(requests[3].signal.aborted && !state.choices.length, 'Switching to research cancels live work and clears old-mode results')
  const researchRequest = requests[4]
  check(researchRequest.body.routingDataMode === 'scheduled' && !('realtimeSnapshot' in researchRequest.body), 'Research requests must not contain a realtime snapshot')
  check(researchRequest.body.serviceDate === '2026-09-15' && researchRequest.body.departMinutes === 480 && researchRequest.body.allowServiceDateFallback === false, 'Research uses the selected date and time with no fallback')
  check(researchRequest.body.timePreference === 'arrive' && researchRequest.body.arriveMinutes === 480 && !('departNow' in researchRequest.body), 'Switching to research restores arrive-by and its unchanged selected clock')
  for (let revision = 5; revision <= 7; revision++) await render({ realtimeSnapshot: snapshot(revision) })
  check(requests.length === 5 && !researchRequest.signal.aborted, 'Feed polling cannot cancel or restart pending research')
  complete(4, 'research-result')
  await wait(() => state.choices[0]?.id === 'research-result')
  complete(3, 'late-live-after-mode-switch')
  await settle()
  check(state.choices[0]?.id === 'research-result', 'Late live responses cannot repopulate research mode')
  await render({ realtimeSnapshot: snapshot(8) })
  check(requests.length === 5 && state.choices[0]?.id === 'research-result', 'Feed polling leaves a completed research result unchanged')
  await render({ active: false })
  await render({ realtimeSnapshot: snapshot(9), routeAllowed: false })
  await render({ active: true })
  await render({ routeAllowed: true })
  check(requests.length === 5 && state.choices[0]?.id === 'research-result', 'Navigation/readiness checks retain completed research')

  await render({ routingDataMode: 'realtime' })
  await wait(() => requests.length === 6)
  check(!state.choices.length && requests[5].body.realtimeSnapshot.feedTimestamp === 9, 'Returning to realtime captures the latest observation and clears research results')
  complete(5)
  await wait(() => state.choices[0]?.id === 'route-5')

  // The existing Run action resets and supplies new point objects.
  state.reset()
  await render({ origin: { ...options.origin } })
  await wait(() => requests.length === 7)
  check(requests[6].body.realtimeSnapshot.feedTimestamp === 9, 'Explicit rerun captures the latest observation')
  check(requests[6].body.departNow === true, 'Explicit rerun asks the server for the current departure again')
  await render({ departMinutes: 490 })
  check(requests.length === 7 && !requests[6].signal.aborted, 'Hidden research clock changes cannot alter a realtime request')
  await render({ maxWalkKm: 1.2 })
  await wait(() => requests.length === 8)
  check(requests[6].signal.aborted, 'Changing the walking limit cancels superseded work')
  complete(7)
  await wait(() => state.choices[0]?.id === 'route-7')
  complete(6, 'late-obsolete-route')
  await settle()
  check(state.choices[0]?.id === 'route-7', 'Late obsolete responses must not overwrite a newer journey')

  await render({ serviceDate: '2026-09-16' })
  check(requests.length === 8 && state.choices[0]?.id === 'route-7', 'Hidden research date changes cannot replace a Depart now result')
  for (const patch of [{ storeKey: 'timetable-rebuilt' }]) {
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
    await render({ realtimeSnapshot: snapshot(10) })
    check(requests.length === count && !requests.at(-1).signal.aborted, `${mode} must ignore dashboard refreshes`)
    complete(count - 1)
    await wait(() => !state.loading)
  }

  // Failed polls leave the snapshot object unchanged. Advance only a fake
  // wall clock and the hook's long timers; React and fixture settling retain
  // real short timers, so this proves expiration without sleeping 3 minutes.
  const originalNow = Date.now
  const originalSetTimeout = window.setTimeout
  const originalClearTimeout = window.clearTimeout
  let fakeNow = 2_000_000_000_000
  let timerId = 1_000_000
  const timers = new Map()
  Date.now = () => fakeNow
  window.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) < 1000) return originalSetTimeout.call(window, callback, delay, ...args)
    const id = timerId++
    timers.set(id, { callback, at: fakeNow + Number(delay), args })
    return id
  }
  window.clearTimeout = id => {
    if (!timers.delete(id)) originalClearTimeout.call(window, id)
  }
  const advance = async milliseconds => {
    const destination = fakeNow + milliseconds
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= destination).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      timers.delete(id)
      fakeNow = timer.at
      timer.callback(...timer.args)
      await settle()
    }
    fakeNow = destination
    await settle()
  }
  try {
    const fresh = {
      ...snapshot(fakeNow / 1000),
      tripUpdates: Array.from({ length: 2000 }, (_, index) => ({
        tripId: `trip-${index}`, sourceFeedTimestamp: fakeNow / 1000, timestamp: fakeNow / 1000,
      })),
    }
    check(routingObservationValidity(fresh, fakeNow).nextChangeAt === fakeNow + 180_001, 'Freshness expires after the inclusive 180-second boundary')
    const mixed = { ...fresh, tripUpdates: [{ sourceFeedTimestamp: fakeNow / 1000 - 100, timestamp: fakeNow / 1000 - 150 }] }
    check(routingObservationValidity(mixed, fakeNow).nextChangeAt === fakeNow + 30_001, 'An older entity timestamp expires before its source feed')
    check(routingObservationValidity(mixed, fakeNow + 30_001).nextChangeAt === fakeNow + 80_001, 'The single timer advances to the next source boundary')
    check(routingObservationValidity({ ...fresh, feedTimestamp: undefined, tripUpdates: [] }, fakeNow).nextChangeAt === null, 'Missing timestamps cannot create a retry loop')
    let before = requests.length
    await render({ mode: 'transit', routingDataMode: 'realtime', realtimeSnapshot: fresh })
    await wait(() => requests.length === before + 1)
    check(timers.size === 1, 'Thousands of live records share one expiration timer')
    const originalObservation = JSON.stringify(requests.at(-1).body.realtimeSnapshot)
    complete(before, 'live-before-expiry')
    await wait(() => state.choices[0]?.id === 'live-before-expiry')
    before = requests.length
    await advance(180_000)
    check(requests.length === before && state.choices[0]?.id === 'live-before-expiry', 'The inclusive freshness boundary does not reroute early')
    await advance(1)
    await wait(() => requests.length === before + 1)
    check(!state.choices.length, 'Expiration clears the old live result even when every new poll failed')
    check(JSON.stringify(requests.at(-1).body.realtimeSnapshot) === originalObservation, 'Expiry requery preserves the original feed and fetch timestamps')
    complete(before, 'scheduled-fallback-after-expiry')
    await wait(() => state.choices[0]?.id === 'scheduled-fallback-after-expiry')
    before = requests.length
    await advance(3_600_000)
    check(requests.length === before && timers.size === 0, 'An expired snapshot reroutes once and creates no repeat polling loop')

    await render({ routingDataMode: 'scheduled', realtimeSnapshot: snapshot(Math.floor(fakeNow / 1000)) })
    await wait(() => requests.length === before + 1)
    check(timers.size === 0, 'Research mode installs no observation timer')
    complete(before, 'research-with-expiring-dashboard')
    await wait(() => state.choices[0]?.id === 'research-with-expiring-dashboard')
    before = requests.length
    await advance(180_001)
    check(requests.length === before && state.choices[0]?.id === 'research-with-expiring-dashboard', 'Clock expiration never reroutes scheduled research')

    const futureTimestamp = Math.ceil(fakeNow / 1000) + 120
    const future = snapshot(futureTimestamp)
    const acceptedAt = futureTimestamp * 1000 - 60_000
    check(routingObservationValidity(future, fakeNow).nextChangeAt === acceptedAt, 'A future feed has an exact first eligible instant')
    await render({ routingDataMode: 'realtime', realtimeSnapshot: future })
    await wait(() => requests.length === before + 1)
    check(timers.size === 1, 'A currently future feed schedules one eligibility check')
    complete(before, 'future-feed-fallback')
    await wait(() => state.choices[0]?.id === 'future-feed-fallback')
    before = requests.length
    await advance(acceptedAt - fakeNow - 1)
    check(requests.length === before, 'Future observations are not enabled prematurely')
    await advance(1)
    await wait(() => requests.length === before + 1)
    check(requests.at(-1).body.realtimeSnapshot.feedTimestamp === futureTimestamp, 'Becoming eligible never rewrites the source timestamp')
    complete(before, 'future-feed-now-eligible')
    await wait(() => state.choices[0]?.id === 'future-feed-now-eligible')

    before = requests.length
    await advance(60_000)
    await wait(() => requests.length === before + 1)
    check(requests.at(-1).body.realtimeSnapshot.feedTimestamp === futureTimestamp, 'Reaching the source clock rechecks past-stop eligibility without changing the observation')
    complete(before, 'future-feed-now-observed')
    await wait(() => state.choices[0]?.id === 'future-feed-now-observed')

    before = requests.length
    await render({ active: false })
    check(timers.size === 0, 'A hidden route cancels its freshness timer')
    await advance(240_001)
    check(requests.length === before, 'Hidden routing does no expiration work')
    await render({ active: true })
    await wait(() => requests.length === before + 1)
    check(!state.choices.length, 'Returning after expiry rechecks a retained live result')
    complete(before, 'expired-while-hidden')
    await wait(() => state.choices[0]?.id === 'expired-while-hidden')
    before = requests.length
    await render({ routingDataMode: 'scheduled' })
    await wait(() => requests.length === before + 1)
    complete(before, 'research-after-expiry-tests')
    await wait(() => !state.loading)
    check(timers.size === 0, 'Leaving realtime removes its timers')
  } finally {
    Date.now = originalNow
    window.setTimeout = originalSetTimeout
    window.clearTimeout = originalClearTimeout
    timers.clear()
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
  return { departNowContract: true, retainedResearchClock: true, explicitDataModes: true, persistedMode: true, realtimeRefresh: true, unchangedFeedExpiryCheck: true, failedPollExpiry: true, singleSnapshotTimer: true, futureTimestampBoundary: true, hiddenExpiryCatchup: true, researchTimerIsolation: true, researchFeedIsolation: true, modeSwitchCancellation: true, retainedNavigation: true, explicitRerun: true, latestResponseWins: true, streetModes: true, cityAndStreetInvalidation: true, unmountCancellation: true }
}
