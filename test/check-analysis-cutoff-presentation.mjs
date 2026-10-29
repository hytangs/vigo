import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSsrTestServer as createServer } from './helpers/ssr-test-server.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'vigo-cutoff-presentation-'))
const server = await createServer({ configFile: false, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 } })
try {
  // Initializing Vite also prepares component-imported CSS for SSR.
  const { AnalyzePanelView, ReachMetricCards, ReachTransitStatusNotice } = await server.ssrLoadModule('/src/components/AnalyzePanel.tsx')
  const area = { bounds: [-72, 41, -70, 43], width: 1, height: 1, pixelAreaKm2: 1, byCutoff: [{ cutoffMinutes: 45, reachablePixels: 1, areaKm2: 1234.56 }, { cutoffMinutes: 46, reachablePixels: 1, areaKm2: 1250 }, { cutoffMinutes: 90, reachablePixels: 1, areaKm2: 2345.67 }] }
  const result = {
    request: { mode: 'transit' },
    summary: {
      maximumCutoffMinutes: 90,
      transitStopSeeds: 6928,
      transitStopsByCutoff: [{ cutoffMinutes: 45, stops: 3602 }, { cutoffMinutes: 90, stops: 6928 }],
      scenarioTransitStopsByCutoff: [{ cutoffMinutes: 45, stops: 4200 }, { cutoffMinutes: 90, stops: 8100 }],
      transitStatus: { status: 'reached', detail: '6928 transit stops are reachable within the selected window.', reachedStops: 6928 },
      scenarioTransitStatus: { status: 'reached', detail: '8100 transit stops are reachable within the selected window.', reachedStops: 8100 },
    },
    surface: {
      areaMetrics: { baseline: area, scenario: area },
      raster: { width: 1, height: 1, bounds: [-72, 41, -70, 43], scale: 10, nodata: 65535, baseline: Buffer.from(new Uint16Array([300]).buffer).toString('base64'), scenario: Buffer.from(new Uint16Array([300]).buffer).toString('base64') },
    },
    diagnostics: { raster: { baselineNetwork: { reachedEdgeLengthKm: 34323.2 }, scenarioNetwork: { reachedEdgeLengthKm: 45678.9 } } },
  }
  const cards = (analysis = result, cutoffMinutes = 45, surface = 'baseline') => renderToStaticMarkup(createElement(ReachMetricCards, { analysis, cutoffMinutes, surface }))
  const notice = (analysis = result, cutoffMinutes = 45, surface = 'baseline') => renderToStaticMarkup(createElement(ReachTransitStatusNotice, { analysis, cutoffMinutes, surface }))
  const metricHtml = cards()
  assert.match(metricHtml, /3,602/)
  assert.match(metricHtml, /stops reached by 45 min/)
  assert.doesNotMatch(metricHtml, /Network details|OSM streets/, 'Reach metrics stay to area and stops')
  assert.match(metricHtml, /1,234\.56 km²/)
  assert.equal(notice(), '', 'A reached cutoff needs no notice: its stop count is a metric')
  assert.doesNotMatch(metricHtml, /6928|6,928|selected window/, 'Backend full-window detail must not masquerade as a selected-cutoff count')
  assert.match(cards(result, 90), /6,928/)
  assert.match(cards(result, 45, 'scenario'), /4,200/, 'Scenario presentation uses its own cutoff table')

  const zeroAtCutoff = { ...result, summary: { ...result.summary, transitStopsByCutoff: [{ cutoffMinutes: 45, stops: 0 }, { cutoffMinutes: 90, stops: 6928 }] } }
  const zeroNotice = notice(zeroAtCutoff)
  assert.match(zeroNotice, /0 transit stops are reachable within the selected 45-minute cutoff/)
  assert.match(zeroNotice, /Transit reaches 6,928 stops within the full 90-minute computed window/)
  assert.doesNotMatch(zeroNotice, /is-error|No scheduled transit|only the origin|No transit stop is counted for this exact date/, 'Zero at an earlier cutoff does not mean no service or no later reach')
  assert.match(notice(result, 46), /unavailable for the selected 46-minute cutoff/)
  assert.match(notice(result, 46), /Update Reach to compute this cutoff/)
  assert.doesNotMatch(notice(result, 46), /3,602|6,928/, 'A nearest earlier cutoff or full-window seed count cannot establish an exact custom cutoff')
  assert.match(cards(result, 46), /Unavailable/)
  const legacy = { ...result, summary: { ...result.summary, transitStopsByCutoff: undefined, scenarioTransitStopsByCutoff: undefined } }
  assert.match(notice(legacy), /unavailable/)
  assert.doesNotMatch(notice(legacy), /6,928/)
  const missingNetwork = { ...result, diagnostics: { raster: {} } }
  assert.doesNotMatch(cards(missingNetwork), /0\.0 km/, 'Missing street diagnostics must not fabricate zero reached network length')
  const preliminary = { ...zeroAtCutoff, diagnostics: { ...result.diagnostics, preliminary: true }, summary: { ...zeroAtCutoff.summary, transitStatus: { status: 'preliminary', detail: 'Walking preview; transit has not been computed.' } } }
  assert.match(cards(preliminary), /Unavailable/)
  assert.match(notice(preliminary), /transit has not been computed/)
  assert.doesNotMatch(notice(preliminary), /0 transit stops/)
  const change = { id: 'edit', name: 'Add a stop', kind: 'change-line', stops: [],
    headwayMinutes: 10, startMinutes: 300, endMinutes: 1500, averageSpeedKph: 25, bidirectional: true }
  const { ScenarioChangeEditor } = await server.ssrLoadModule('/src/components/scenarios/ScenarioChangeEditor.tsx')
  const panel = (intervention) => renderToStaticMarkup(createElement(ScenarioChangeEditor, { change: { ...intervention, routeId: 'fixture-route' } }))
  const preservedPanel = panel(change)
  assert.match(preservedPanel, /value="preserve-trips" selected=""/)
  assert.match(preservedPanel, /Keep scheduled departures/)
  assert.doesNotMatch(preservedPanel, /<span>Every<|<span>From<|<span>Until<|<strong>Add reverse service</,
    'Existing and legacy line edits must hide frequency, span and reverse-service settings by default.')
  const frequencyPanel = panel({ ...change, scheduleMode: 'frequency' })
  for (const text of ['Every', 'From', 'Until', 'Add reverse service']) assert(frequencyPanel.includes(text))
  assert.match(panel({ ...change, kind: 'add-line' }), /<span>Every</, 'New lines still expose their departure schedule.')
  console.log('Scenario controls default to the original timetable, including saved drafts; explicit frequency mode exposes schedule settings.')

  // Arrive-by: values are minutes before the deadline a traveler must leave.
  const arriving = { ...result, request: { mode: 'transit', timePreference: 'arrive', departMinutes: 510 } }
  assert.match(cards(arriving), /sampled area to leave ≤ 45 min before/)
  assert.match(cards(arriving), /stops to board ≤ 45 min before/)
  assert.doesNotMatch(cards(arriving), /reached by 45 min/)
  const arrivingZero = { ...zeroAtCutoff, request: arriving.request }
  assert.match(notice(arrivingZero), /0 transit stops reach the destination within the selected 45-minute cutoff/)
  assert.match(notice(arrivingZero), /6,928 stops reach it within the full 90-minute computed window/)
  const timed = (timePreference) => renderToStaticMarkup(createElement(AnalyzePanelView, {
    mode: 'single', origin: { coordinate: [-71.06, 42.36], label: 'Downtown', source: 'map' }, serviceDate: '2026-07-20', departMinutes: 510,
    timePreference, onTimePreferenceChange: () => {}, maxWalkKm: 1.2, walkSpeedKph: 4.8, cutoffMinutes: 45, renderMode: 'area',
    cases: [], routes: [], stops: [], feeds: [], comparisonFeedIds: [], preparationTasks: [], loading: false,
    routingStoreAvailable: true, streetGraphAvailable: true, onSetOrigin: () => {},
  }))
  const departPanel = timed('depart'), arrivePanel = timed('arrive')
  assert.match(departPanel, /<button type="button" aria-pressed="true">Leave at<\/button><button type="button" aria-pressed="false">Arrive by<\/button>/)
  assert.match(arrivePanel, /aria-pressed="false">Leave at<\/button><button type="button" aria-pressed="true">Arrive by</)
  assert.match(departPanel, /Origin<span/)
  assert.match(departPanel, /<span>Departs<\/span>/)
  assert.match(arrivePanel, /reach-origin-row is-destination/)
  assert.match(arrivePanel, /Destination<span/)
  assert.match(arrivePanel, /<span>Deadline<\/span>/, 'An arrive-by clock is labelled as the deadline')
  assert.match(arrivePanel, /Change destination/)
  assert.match(arrivePanel, /First walk limit/, 'Arrive-by walks first, to transit')
  assert.doesNotMatch(arrivePanel, /Final walk limit|Choose origin|Change origin/)
  // A clicked point is explained by the arrive-by journey from it to the destination.
  const { reachPointRouteRequest, reachInspectionSources } = await server.ssrLoadModule('/src/app/reachInspection.ts')
  const { ReachPointInspector } = await server.ssrLoadModule('/src/components/ReachPointInspector.tsx')
  const destination = { coordinate: [-71.06, 42.36], label: 'Park Street', source: 'stop', stopId: 'place-pktrm' }
  const start = { coordinate: [-71.07, 42.35], label: 'Museum Rd', source: 'map', named: true }
  const arriveResult = { ...result, request: { baselineIdentity: 'fixture', mode: 'transit', timePreference: 'arrive', destination, departMinutes: 540,
    serviceDate: '2026-07-20', serviceDay: 'weekday', maxWalkKm: 1.2, walkSpeedKph: 4.8, cutoffsMinutes: [45], scenario: { id: 'baseline', name: 'Baseline', serviceCount: 0 } } }
  const source = reachInspectionSources(arriveResult)[0]
  const routeBody = reachPointRouteRequest(source, start, '__project__')
  assert.deepEqual([routeBody.origin, routeBody.destination, routeBody.timePreference, routeBody.departMinutes, routeBody.arriveMinutes],
    [start, destination, 'arrive', 540, 540], 'Arrive-by inspection routes from the point to the destination by the deadline')
  const departSource = { ...source, result: { ...arriveResult, request: { ...arriveResult.request, timePreference: undefined, destination: undefined, origin: destination } } }
  const departBody = reachPointRouteRequest(departSource, start, '__project__')
  assert.deepEqual([departBody.origin, departBody.destination, departBody.timePreference, 'arriveMinutes' in departBody], [destination, start, 'depart', false])
  const plan = { status: 'ready', travelMode: 'transit', timePreference: 'arrive', departMinutes: 517, arriveMinutes: 537, durationMinutes: 20,
    legs: [], origin: start, destination, diagnostics: {} }
  const inspector = renderToStaticMarkup(createElement(ReachPointInspector, { inspection: { point: start, source, plan, loading: false, error: '', close: () => {}, retry: () => {} } }))
  assert.match(inspector, /aria-label="Travel time from selected point"/)
  assert.match(inspector, /<span>Start<\/span>/)
  assert.match(inspector, /<strong>23 min<\/strong>/, 'Elapsed time runs from leaving the point to the deadline')
  assert.match(inspector, /Leave 08:37 · arrive by 09:00/)
  const flexSource = { ...source, result: { ...arriveResult, request: { ...arriveResult.request,
    scenario: { id: 'flex', name: 'Planned Flex', serviceCount: 0, flexZoneCount: 1 } } } }
  const flexInspector = renderToStaticMarkup(createElement(ReachPointInspector, { inspection: { point: start, source: flexSource, plan, loading: false, error: '', close: () => {}, retry: () => {} } }))
  assert.match(flexInspector, /Scheduled journey/)
  assert.match(flexInspector, /Planned Flex/)
  assert.match(flexInspector, /The journey below uses scheduled service/, 'A Flex-only comparison must distinguish the baseline journey from the scenario map')
  console.log('Arrive-by Reach: Leave at / Arrive by toggle, destination and deadline labels, first-walk limit, minutes-before metrics, and point journeys passed.')
  console.log('Reach cutoff presentation: 45/90-minute scopes, scenario counts, later transit reach, exact custom cutoff and missing/preliminary evidence passed.')
} finally { await server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
