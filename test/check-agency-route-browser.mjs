import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSsrTestServer as createServer } from './helpers/ssr-test-server.mjs'
import react from '@vitejs/plugin-react'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { browseRoutes, routeBrowserFreshness, routeDelayLabel, routeHasAttention } from '../src/agency/routeBrowser.ts'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate } from './fixtures/agency.mjs'

const now = observationTime * 1000
const feed = (kind, status = 'fresh', ageSeconds = 0) => ({ kind, status, sourceUrl: `https://example.org/${kind}`, ageSeconds, feedTimestamp: observationTime - ageSeconds })
const route = (id, changes = {}) => ({ id, name: id, longName: 'River service', color: '#007D77', mode: 3, trips: 20, reportingTrips: 0, maxDelaySeconds: null, events: 0, alerts: 0, headway: 'unknown', widestInterval: null, ...changes })
const routes = [
  route('10', { reportingTrips: 2, maxDelaySeconds: 300 }),
  route('2'),
  route('Blue', { reportingTrips: 1, maxDelaySeconds: -30 }),
  route('1', { reportingTrips: 3, maxDelaySeconds: 0 }),
  route('Alert', { alerts: 2 }),
  route('Spacing', { reportingTrips: 2, headway: 'changed' }),
  route('Cancelled', { reportingTrips: 1 }),
  route('Info', { events: 900 }),
]
const state = {
  generatedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), connected: true, cityName: 'Synthetic City',
  coverage: { valid: true }, policy: { freshnessSeconds: 180 }, feeds: [feed('tripUpdates'), feed('alerts')], routes,
  events: [{ type: 'cancellation', routeId: 'Cancelled', severity: 'warning' }],
}
const fresh = routeBrowserFreshness(state, now)
const ids = (options = {}) => browseRoutes(routes, { freshness: fresh, ...options }).map(item => item.id)
assert.deepEqual(ids(), ['1', '2', '10', 'Alert', 'Blue', 'Cancelled', 'Info', 'Spacing'], 'Names use natural route-number order')
assert.equal(routes[0].id, '10', 'Sorting must preserve the source array')
assert.deepEqual(ids({ search: ' RIVER 10  ' }), ['10'], 'Search accepts whitespace and tokens across route name and destination')
assert.deepEqual(ids({ filter: 'reporting' }), ['1', '10', 'Blue', 'Cancelled', 'Spacing'])
assert.deepEqual(ids({ filter: 'attention', sort: 'attention' }), ['Alert', 'Cancelled', '10', 'Spacing'])
assert.deepEqual(ids({ sort: 'delay' }).slice(0, 3), ['10', '1', 'Blue'], 'Unknown predictions must sort after measured negative and zero deviations')
assert.equal(routeHasAttention(routes.at(-1), fresh), false, 'An arbitrary information-event count is not an incident priority')
assert.equal(routeHasAttention(routes[3], fresh), false, 'An exactly matching predicted departure is not a delay')
assert.equal(routeDelayLabel(route('Late', { reportingTrips: 1, maxDelaySeconds: 1 }), fresh), 'Up to 1 sec late', 'Small positive delay never rounds to zero minutes')
assert.equal(routeDelayLabel(routes[3], fresh), null, 'Zero delay must not become a route-wide healthy badge')
assert.equal(routeDelayLabel(routes[2], fresh), null)
const aggregateRoutes = routes.map(route => ({ ...route, serviceChanges: route.id === 'Cancelled' ? 1 : 0 }))
const aggregated = { ...state, routes: aggregateRoutes, events: [] }
const aggregateAttention = snapshot => browseRoutes(snapshot.routes, { filter: 'attention', freshness: routeBrowserFreshness(snapshot, now) }).map(route => route.id)
assert.deepEqual(aggregateAttention(aggregated), ['10', 'Alert', 'Cancelled', 'Spacing'], 'Route aggregates preserve cancellations after selected events are filtered away')
assert.deepEqual(aggregateAttention({ ...aggregated, events: Array.from({ length: 500 }, (_, index) => ({ type: 'delay', routeId: `Other-${index}` })) }), aggregateAttention(aggregated), 'A full 500-event page must not change City-wide route attention')
assert.equal(routeBrowserFreshness({ ...aggregated, events: [{ type: 'skipped-stop', routeId: 'Info' }] }, now).attentionRouteIds.has('Info'), false, 'Explicit route aggregates are authoritative over unrelated event selection')

for (const unavailable of [
  { ...state, connected: false },
  { ...state, feeds: [feed('vehicles')] },
  { ...state, feeds: [feed('tripUpdates', 'stale'), feed('alerts', 'unknown')] },
  { ...state, feeds: [feed('tripUpdates', 'error')] },
  { ...state, generatedAt: new Date(now - 181_000).toISOString() },
  { ...state, generatedAt: new Date(now + 181_000).toISOString() },
  { ...state, feeds: [feed('tripUpdates', 'fresh', -181)] },
  { ...state, feeds: [feed('tripUpdates', 'fresh', 181)] },
]) {
  const unavailableFreshness = routeBrowserFreshness(unavailable, now)
  assert.equal(unavailableFreshness.predictions, false)
  assert.deepEqual(ids({ filter: 'reporting', freshness: unavailableFreshness }), [])
  assert.equal(routeDelayLabel(routes[0], unavailableFreshness), null)
}
const failed = routeBrowserFreshness(state, now, true)
assert.equal(failed.label, 'Refresh failed')
assert.deepEqual(ids({ filter: 'attention', freshness: failed }), [])
assert.equal(routeBrowserFreshness({ ...state, feeds: [feed('tripUpdates', 'fresh', 170)] }, now + 20_000).predictions, false, 'A retained fresh status ages out without another response')
assert.equal(routeBrowserFreshness({ ...state, feeds: [feed('tripUpdates'), feed('tripUpdates', 'stale', 181)] }, now).predictions, true, 'Stale feeds excluded by the backend do not hide available fresh reports')
assert.equal(routeBrowserFreshness({ ...state, feeds: [feed('tripUpdates'), feed('tripUpdates', 'fresh', 170)] }, now + 20_000).predictions, false, 'Partly expired aggregates need reassessment because route rows have no per-source counts')
const alertsOnly = routeBrowserFreshness({ ...state, feeds: [feed('tripUpdates', 'stale'), feed('alerts')] }, now)
assert.equal(alertsOnly.label, 'Service alerts available')
assert.equal(alertsOnly.predictions, false)
assert.equal(alertsOnly.alerts, true)
assert.deepEqual(ids({ filter: 'attention', freshness: alertsOnly }), ['Alert'], 'Current alerts remain useful independently of prediction feeds')
const unaligned = routeBrowserFreshness({ ...state, coverage: { valid: false } }, now)
assert.equal(unaligned.predictions, false)
assert.equal(unaligned.alerts, true)
assert.equal(routeBrowserFreshness({ ...state, feeds: [feed('tripUpdates'), feed('alerts', 'stale')] }, now).predictions, true)

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-route-browser-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const context = new AgencyContext(file, 'Synthetic City')
try {
  const derive = snapshot => deriveOperationalState(context, snapshot, observationTime)
  const cancelled = derive(realtimeFixture([tripUpdate('T1', 0, { scheduleRelationship: 'CANCELED' })]))
  assert.equal(cancelled.routes[0].reportingTrips, 1)
  assert.equal(cancelled.routes[0].maxDelaySeconds, null)
  assert.equal(cancelled.routes[0].serviceChanges, 1)
  assert.equal(routeHasAttention(cancelled.routes[0], routeBrowserFreshness(cancelled, now)), true, 'Backend cancellation reports count as reporting and warrant review without fabricated delay')
  const deleted = derive(realtimeFixture([tripUpdate('T1', 0, { scheduleRelationship: 'DELETED' })]))
  assert.equal(deleted.routes[0].serviceChanges, 0)
  assert.equal(routeHasAttention(deleted.routes[0], routeBrowserFreshness(deleted, now)), false, 'Deleted report semantics must not be converted into a cancellation')
  const changed = derive(realtimeFixture([tripUpdate('T1', 300), tripUpdate('T2')]))
  assert.equal(changed.routes[0].serviceChanges, 0, 'Spacing and delay comparisons do not inflate explicit service-change counts')
  assert.equal(routeHasAttention(changed.routes[0], routeBrowserFreshness(changed, now)), true)
  const normal = derive(realtimeFixture())
  assert.equal(routeHasAttention(normal.routes[0], routeBrowserFreshness(normal, now)), false)
  const outdated = deriveOperationalState(context, realtimeFixture(), observationTime + 181)
  assert.equal(outdated.routes[0].reportingTrips, 0)
  assert.equal(routeBrowserFreshness(outdated, now + 181_000).predictions, false)
} finally {
  context.close()
  await fs.rm(directory, { recursive: true, force: true })
}

const cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-route-browser-vite-'))
const server = await createServer({ cacheDir: cacheDirectory, configFile: false, plugins: [react()], server: { middlewareMode: true }, appType: 'custom' })
const originalNow = Date.now
try {
  Date.now = () => now
  const { AgencyRouteBrowser } = await server.ssrLoadModule('/src/components/AgencyRouteBrowser.tsx')
  const render = (changes = {}, props = {}) => renderToStaticMarkup(createElement(AgencyRouteBrowser, { state: { ...state, ...changes }, onSelect: () => {}, ...props }))
  const gapRoute = route('R', { reportingTrips: 2, comparedPairs: 4, widestInterval: { predictedSeconds: 1800, scheduledSeconds: 600, stopName: 'River', directionId: '0' } })
  assert.doesNotMatch(render({ routes: [gapRoute] }), /Worst predicted gap|Headway coverage unknown/, 'Route browsing stays compact; detailed comparisons belong to route coverage')
  const { AgencyRouteCoverage } = await server.ssrLoadModule('/src/components/AgencyRouteCoverage.tsx')
  const renderCoverage = refreshFailed => renderToStaticMarkup(createElement(AgencyRouteCoverage, { state, route: gapRoute, refreshFailed }))
  const gapHtml = renderCoverage(false)
  assert.doesNotMatch(renderCoverage(true), /Worst predicted gap/, 'Unavailable feeds cannot retain a current-looking gap in route coverage')
  assert.match(gapHtml, /Worst predicted gap: 30 min \/ 10 min scheduled/)
  assert.match(gapHtml, /River · direction 0 · 4 stop-pair comparisons/)
  const html = render()
  assert.match(html, /aria-label="Find a route"/)
  assert.match(html, /role="group" aria-label="Filter routes"/)
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /<select aria-label="Sort routes"/)
  assert.match(html, /No current trip reports/)
  assert.match(html, /Up to 5 min late/)
  assert.doesNotMatch(html, /0 trip reports|On time|Healthy/, 'Missing and zero-valued reports never become a healthy route claim')
  assert.match(render({}, { refreshFailed: true }), /Refresh failed/)
  assert.doesNotMatch(render({}, { refreshFailed: true }), /Up to 5 min late|Spacing changed|2 alerts/, 'A failed refresh must not retain current-looking route signals')
  assert.match(render({ connected: false }, { initialFilter: 'reporting' }), /Reset filters/)
  const longList = Array.from({ length: 125 }, (_, index) => route(String(index + 1)))
  const paged = render({ routes: longList })
  assert.match(paged, /50 of 125/)
  assert.match(paged, /75 remaining/)
  assert.equal((paged.match(/class="agency-route-list-detail"/g) ?? []).length, 50, 'The first page is bounded but every remaining route is reachable')

  const { AgencyOverview } = await server.ssrLoadModule('/src/components/AgencyOverview.tsx')
  const overviewState = { ...state, generatedAt: '2026-09-14T04:10:00.000Z', coverage: { valid: true, timezone: 'America/New_York', serviceDate: '2026-09-13' } }
  const renderOverview = (changes = {}) => renderToStaticMarkup(createElement(AgencyOverview, { state: { ...overviewState, ...changes }, refreshFailed: true, onBrowse() {}, onRoute() {}, onFeeds() {} }))
  const overview = renderOverview()
  const localDateTime = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(Date.parse(overviewState.generatedAt))
  assert.ok(overview.includes(`Last successful snapshot ${localDateTime}`), 'A retained snapshot includes its full agency-local calendar date and time')
  assert.match(overview, /America\/New_York/)
  assert.match(overview, /Service date 2026-09-13/, 'After midnight, the GTFS service date remains distinct from the snapshot calendar date')
  const unknownTimezone = renderOverview({ coverage: { valid: false, timezone: null, serviceDate: null } })
  assert.match(unknownTimezone, /UTC · agency timezone unknown/, 'A missing agency timezone must not silently use the browser timezone')
  assert.match(unknownTimezone, /Service date unknown/)
} finally {
  Date.now = originalNow
  await server.close()
  await fs.rm(cacheDirectory, { recursive: true, force: true })
}
console.log('Route browser: source-aware filters, independent alerts, retained-source expiry, cancellation semantics, natural/attention/delay sorting, accessible controls and visible pagination passed.')
