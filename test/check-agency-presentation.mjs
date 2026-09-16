import assert from 'node:assert/strict'
import { feedHealth, feedAgeLabel, scheduleDeviation } from '../src/agency/presentation.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

assert.equal(feedHealth([]).label, 'Timetable only')
assert.equal(feedHealth([{ status: 'fresh' }]).status, 'fresh')
assert.equal(feedHealth([{ status: 'fresh' }, { status: 'error' }]).label, 'Partial live data')
assert.equal(feedHealth([{ status: 'stale' }, { status: 'unknown' }]).label, 'Live data unavailable')
assert.equal(feedHealth([{ status: 'fresh' }], true).label, 'Refresh failed', 'Retained freshness never hides a failed response')
assert.equal(feedAgeLabel({ ageSeconds: null }), 'Time unknown')
assert.equal(feedAgeLabel({ ageSeconds: -20 }), 'Clock ahead 20s')
assert.equal(scheduleDeviation(1000, -20), '17 min early')
assert.equal(scheduleDeviation(1000, 1960), '16 min late')
assert.equal(scheduleDeviation(1000, 999), '1 sec early', 'Rounding must not label an early prediction on time')
assert.equal(scheduleDeviation(1000, 1000), 'Matches schedule')
assert.equal(scheduleDeviation(null, 1000), null, 'Missing schedule is not zero delay')
assert.equal(scheduleDeviation(1000, null), null)

const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true }, appType: 'custom' })
try {
  const { StopArrivalBoardView } = await server.ssrLoadModule('/src/components/StopArrivalBoard.tsx')
  const epoch = Date.parse('2026-09-14T04:00:00Z') / 1000
  const data = {
    stop: { id: 'P', name: 'Station' }, timezone: 'America/New_York', generatedAt: '2026-09-14T03:50:00Z', total: 1, warnings: [],
    feeds: [{ status: 'fresh', sourceUrl: 'https://example.org/feed', kind: 'tripUpdates', ageSeconds: 8 }],
    rows: [{ key: 'T/S/P', tripId: 'T', serviceDate: '2026-09-13', routeId: 'R', routeName: 'R', destination: 'Terminal', stopId: 'P', stopName: 'Station', stopSequence: 30,
      kind: 'arrival', expected: epoch + 300, status: 'live', atStop: false, timingIssue: null, source: null,
      arrival: { scheduled: epoch + 1320, current: epoch + 300 }, departure: { scheduled: epoch + 1380, current: epoch + 360 } }],
  }
  const render = (refreshError = '') => renderToStaticMarkup(createElement(StopArrivalBoardView, { data, refreshError }))
  let html = render()
  assert.match(html, /17 min early/)
  assert.match(html, /Sep 14, 12:05/, 'A prediction after civil midnight carries the next calendar date')
  assert.match(html, /2026-09-13/, 'The GTFS service date stays separate from the calendar date')
  assert.match(html, /EDT/, 'Source times use the agency timezone, not the browser or server zone')
  html = render('Offline')
  assert.match(html, /Refresh failed/)
  assert.match(html, /Last successful observation/)
  assert.match(html, /Recorded prediction/)
  assert.doesNotMatch(html, /<strong>15 min<\/strong>|<strong>Due<\/strong>|<strong>At stop<\/strong>/, 'A retained response is not a current countdown or vehicle position')
  assert.match(html, /12:05/, 'A failed refresh preserves the last known absolute time')
  const { AgencyToolOutput, AgencyAnswerText } = await server.ssrLoadModule('/src/components/AgencyAnswer.tsx')
  const structuredAnswer = renderToStaticMarkup(createElement(AgencyAnswerText, { text: '### Service to check\n\nStart with these reports.\n\n- **C** — 23.3 min predicted, 9 min scheduled.\n- **23** — 25.9 min predicted, 14 min scheduled.\n\n93 scheduled trips remain unknown. [1]' }))
  assert.equal((structuredAnswer.match(/<li>/g) || []).length, 2, 'Route priorities render as separate semantic list items')
  assert.equal((structuredAnswer.match(/<p(?: |>)/g) || []).length, 3, 'Headings, findings and missing coverage remain separate blocks')
  assert.match(structuredAnswer, /<strong>C<\/strong>/)
  assert.doesNotMatch(structuredAnswer, /###|\*\*|<p[^>]*>[^<]*<ul/)
  const untrustedAnswer = renderToStaticMarkup(createElement(AgencyAnswerText, { text: '<script>bad()</script>\n\n1. **First**\n2. Second' }))
  assert.doesNotMatch(untrustedAnswer, /<script>/, 'Answer formatting never inserts source text as HTML')
  assert.match(untrustedAnswer, /<ol>/)
  const journey = {
    status: 'ready', travelMode: 'transit', departMinutes: 480, arriveMinutes: 510, durationMinutes: 30,
    origin: { label: 'Museum' }, destination: { label: 'Restaurant' },
    legs: [
      { type: 'walk', fromName: 'Museum', toName: 'Station A', toStopId: 'A', startMinutes: 480, endMinutes: 485, durationMinutes: 5 },
      { type: 'ride', routeShortName: '450', routeColor: 'FFC72C', fromName: 'Station A', toName: 'Station B', fromStopId: 'A', toStopId: 'B', startMinutes: 490, endMinutes: 510, durationMinutes: 20 },
    ],
  }
  const renderJourney = plan => renderToStaticMarkup(createElement(AgencyToolOutput, {
    result: { ok: true, data: { plan }, warnings: [], provenance: [] }, onResult: () => {},
  }))
  const validJourney = renderJourney(journey)
  assert.match(validJourney, /Direct transit/)
  assert.match(validJourney, /5 min walking · 5 min waiting · 20 min riding/)
  assert.match(validJourney, /Step-by-step directions/)
  assert.doesNotMatch(validJourney, /<details[^>]* open/)
  const scheduledJourney = renderJourney({ ...journey, diagnostics: { routingDataMode: 'scheduled' } })
  assert.match(scheduledJourney, /Scheduled · Research/)
  assert.match(scheduledJourney, /Published timetable/)
  assert.doesNotMatch(scheduledJourney, /no realtime updates|snapshot stale|unavailable live/,
    'Deliberate research mode must not appear as a failed realtime journey')
  const realtimeJourney = renderJourney({ ...journey, diagnostics: { routingDataMode: 'realtime' } })
  assert.match(realtimeJourney, /Realtime/)
  assert.match(realtimeJourney, /Scheduled times; no realtime updates applied/)

  const { SidebarPathfinderBox } = await server.ssrLoadModule('/src/components/PathfinderPanel.tsx')
  const pathfinderProps = {
    routingEnabled: false, routingOrigin: null, routingWaypoints: [], routingDestination: null,
    routingPlan: null, routingChoices: [], routingScopeStatus: 'ready', routingStoreReady: true,
    routingTimePreference: 'depart', routingMode: 'transit', routingDataMode: 'scheduled',
    routingDepartureWindowMinutes: 0, routingMaxWalkKm: 1.6, routingAllowLongWalk: false,
    routingActivity: { kind: 'idle', title: '', detail: '' }, routingAlternativesLoading: false,
    routingServiceDate: '2026-09-15', routingServiceCoverage: null,
    routingServiceDateAvailability: 'inside', routingServiceDateOptions: [],
    storeBackedRouting: true, scheduleTimeMinutes: 480, routingPickIndex: null,
  }
  const renderPathfinder = patch => renderToStaticMarkup(createElement(SidebarPathfinderBox, { ...pathfinderProps, ...patch }))
  const researchControls = renderPathfinder()
  assert.match(researchControls, /aria-label="Transit data mode"/)
  assert.match(researchControls, /aria-pressed="true"[^>]*>Scheduled · Research/)
  assert.match(researchControls, /Live feed refreshes do not change the result/)
  assert.match(researchControls, /aria-label="Routing service date"[^>]*value="2026-09-15"/)
  const liveControls = renderPathfinder({ routingDataMode: 'realtime' })
  assert.match(liveControls, /aria-pressed="true"[^>]*>Realtime/)
  assert.match(liveControls, /Fresh predictions and cancellations/)
  assert.doesNotMatch(renderPathfinder({ routingMode: 'walk' }), /Transit data mode/)
  const disconnected = renderJourney({ ...journey, legs: [journey.legs[0], { ...journey.legs[1], fromStopId: 'Unrelated stop' }] })
  assert.match(disconnected, /disconnected stops/)
  assert.doesNotMatch(disconnected, /Show on map|Journey directions/)
  const conflicting = renderJourney({ ...journey, legs: [journey.legs[0], { ...journey.legs[1], startMinutes: 482 }] })
  assert.match(conflicting, /conflicting times/)
  assert.doesNotMatch(conflicting, /Show on map|Journey directions/)
  html = renderToStaticMarkup(createElement(AgencyToolOutput, { result: { ok: true, data: { board: data }, provenance: [], warnings: [] } }))
  assert.match(html, /Recorded arrivals/)
  assert.match(html, /Saved with this answer/)
  assert.match(html, /Recorded prediction/)
  assert.doesNotMatch(html, /Feeds current|<strong>15 min<\/strong>|\[object Object\]/, 'Saved Ask boards reuse station UI without pretending to be a current countdown or a raw JSON table')
} finally { await server.close() }
console.log('Agency presentation: partial/failed/unknown feeds, deviations, rendered midnight dates, service dates, timezone and last-known refresh failure passed.')
