import assert from 'node:assert/strict'
import { feedHealth, feedAgeLabel, scheduleDeviation } from '../src/agency/presentation.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSsrTestServer as createServer } from './helpers/ssr-test-server.mjs'
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
  const { AgencyCoverageNotes } = await server.ssrLoadModule('/src/components/AgencyCoverageNotes.tsx')
  const coverageHtml = renderToStaticMarkup(createElement(AgencyCoverageNotes, { warnings: [
    'Alert 1: unresolved scope (stop; source feed).',
    'Alert 2: unresolved scope (stop).',
    'Alert 2: unresolved scope (stop).',
    '1131 intervals cannot be compared because reporting is incomplete or predicted trip order differs from the timetable.',
    'Another coverage limitation.',
  ] }))
  assert.match(coverageHtml, /2 alerts with unresolved scope/)
  assert.match(coverageHtml, /Stop could not be matched uniquely · 2/)
  assert.match(coverageHtml, /Alert IDs: 1, 2/)
  assert.match(coverageHtml, /not confirmed disruptions/)
  assert.match(coverageHtml, /Another coverage limitation/)
  assert.doesNotMatch(coverageHtml, /Alert 2: unresolved/)
  const { AgencyRouteLine } = await server.ssrLoadModule('/src/components/AgencyRouteLine.tsx')
  const initialLine = renderToStaticMarkup(createElement(AgencyRouteLine, { projectId: 'city', routeId: 'R', preview: {
    routes: [{ id: 'R', directionId: '0', shortName: 'R', color: '#abcdef', stopIds: ['A', 'B'], tripCount: 2 }],
    stops: [{ id: 'A', name: 'Alpha station' }, { id: 'B', name: 'Beta station' }],
  } }))
  assert.match(initialLine, /Alpha station/)
  assert.match(initialLine, /Beta station/)
  assert.match(initialLine, /Live positions pending/)
  assert.doesNotMatch(initialLine, /Reading the route|0 reported vehicles/, 'Render known stops before any API response without implying zero live vehicles')
  const { AgencyServiceEvents } = await server.ssrLoadModule('/src/components/AgencyServiceEvents.tsx')
  const alertHtml = renderToStaticMarkup(createElement(AgencyServiceEvents, { state: { routes: [], events: [{ id: 'delay', type: 'delay', severity: 'warning', title: 'Departure later than scheduled', evidence: { delaySeconds: 600, alertReason: 'Predicted departure is at least 5 minutes late.' } }] }, ready: true, filter: 'all', onFilter() {}, onSelect() {} }))
  assert.match(alertHtml, /Warning · Departure later than scheduled/)
  assert.match(alertHtml, /Predicted departure is at least 5 minutes late/)
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
  assert.match(researchControls, /aria-label="Departure time"/)
  assert.match(researchControls, /aria-pressed="true"[^>]*>Depart at/)
  assert.match(researchControls, /Published timetable for this date and time/)
  assert.match(researchControls, /aria-label="Routing service date"[^>]*value="2026-09-15"/)
  const liveControls = renderPathfinder({ routingDataMode: 'realtime' })
  assert.match(liveControls, /aria-pressed="true"[^>]*>Now/)
  assert.match(liveControls, /live updates where available/)
  assert.doesNotMatch(liveControls, /aria-label="Routing service date"/, 'Now has no timetable date to choose')
  assert.doesNotMatch(renderPathfinder({ routingMode: 'walk' }), /Departure time/)
} finally { await server.close() }
console.log('Agency presentation: partial/failed/unknown feeds, deviations, rendered midnight dates, service dates, timezone and last-known refresh failure passed.')
