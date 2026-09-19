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
  const { ReachMetricCards, ReachTransitStatusNotice } = await server.ssrLoadModule('/src/components/AnalyzePanel.tsx')
  const area = { bounds: [-72, 41, -70, 43], width: 1, height: 1, pixelAreaKm2: 1, byCutoff: [{ cutoffMinutes: 45, reachablePixels: 1, areaKm2: 1234.56 }, { cutoffMinutes: 46, reachablePixels: 1, areaKm2: 1250 }, { cutoffMinutes: 90, reachablePixels: 1, areaKm2: 2345.67 }] }
  const result = {
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
  const cards = (analysis = result, cutoffMinutes = 45, surface = 'baseline') => renderToStaticMarkup(createElement(ReachMetricCards, { analysis, cutoffMinutes, surface, walkBudgetKm: 1.2 }))
  const notice = (analysis = result, cutoffMinutes = 45, surface = 'baseline') => renderToStaticMarkup(createElement(ReachTransitStatusNotice, { analysis, cutoffMinutes, surface }))
  const metricHtml = cards()
  assert.match(metricHtml, /3,602/)
  assert.match(metricHtml, /stops reached by 45 min/)
  assert.match(metricHtml, /34,323\.2 km/)
  assert.match(metricHtml, /OSM streets · full 90 min window/, 'Street length remains explicitly scoped to its full computation horizon')
  assert.match(metricHtml, /1,234\.56 km²/)
  assert.match(notice(), /3,602 transit stops are reachable within the selected 45-minute cutoff/)
  assert.doesNotMatch(notice(), /6928|6,928|selected window/, 'Backend full-window detail must not masquerade as a selected-cutoff count')
  assert.match(notice(result, 90), /6,928 transit stops are reachable within the selected 90-minute cutoff/)
  assert.match(notice(result, 45, 'scenario'), /4,200 transit stops/, 'Scenario presentation uses its own cutoff table')

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
  assert.match(cards(missingNetwork), /Unavailable/)
  assert.doesNotMatch(cards(missingNetwork), /0\.0 km/, 'Missing street diagnostics must not fabricate zero reached network length')
  const preliminary = { ...zeroAtCutoff, diagnostics: { ...result.diagnostics, preliminary: true }, summary: { ...zeroAtCutoff.summary, transitStatus: { status: 'preliminary', detail: 'Walking preview; transit has not been computed.' } } }
  assert.match(cards(preliminary), /Unavailable/)
  assert.match(notice(preliminary), /transit has not been computed/)
  assert.doesNotMatch(notice(preliminary), /0 transit stops/)
  console.log('Reach cutoff presentation: 45/90-minute scopes, formatted full-window street length, scenario counts, later transit reach, exact custom cutoff and missing/preliminary evidence passed.')
} finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
