import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const modules = new Map()
function moduleUrl(path) {
  if (modules.has(path)) return modules.get(path)
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: path,
  }).outputText.replace(/from ['"]([^'"]+)['"]/g, (_match, specifier) => {
    if (!specifier.startsWith('.')) return `from '${import.meta.resolve(specifier)}'`
    const absolute = resolve(dirname(path), specifier)
    const dependency = [absolute, `${absolute}.ts`, `${absolute}.tsx`].find(existsSync)
    assert(dependency, `Cannot resolve ${specifier} from ${path}`)
    return `from '${moduleUrl(dependency)}'`
  })
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
  modules.set(path, url)
  return url
}

const presentation = await import(moduleUrl(resolve(root, 'src/app/gtfsPresentation.ts')))
const analysis = await import(moduleUrl(resolve(root, 'src/app/gtfsAnalysis.ts')))
const { NetworkTimetable } = await import(moduleUrl(resolve(root, 'src/components/NetworkTimetable.tsx')))
const stops = [
  { id: 'a', name: 'Harvard', platformCode: '1' },
  { id: 'b', name: 'Central' },
  { id: 'c', name: 'Branch terminus' },
]
const route = {
  id: 'outbound', routeId: '1', directionId: '0', patternRank: 1,
  shortName: '1', longName: 'Harvard–Central', color: '#d59100',
  tripCount: 200, headwayMinutes: 15, spanHours: 23, serviceHours: 90,
  stopCount: 2, stopIds: ['a', 'b'], coordinates: [[-71.12, 42.37], [-71.1, 42.36]], points: [],
  status: 'baseline', geometrySource: 'shape', shapeId: 'shape-1',
  analysisSource: 'focused', analysisServiceDate: '2026-09-12', serviceVariantCount: 1,
  firstDepartureMinutes: 60, lastArrivalMinutes: 1440,
  scheduledTrips: [
    { tripId: 'late-1', firstDepartureMinutes: 1430, lastArrivalMinutes: 1460 },
    { tripId: 'late-2', firstDepartureMinutes: 1450, lastArrivalMinutes: 1480 },
  ],
}
const loop = {
  ...route, id: 'loop', directionId: undefined, patternRank: 2,
  stopIds: ['a', 'b', 'a'], geometrySource: 'stop_sequence', scheduledTrips: [],
}
assert.equal(presentation.gtfsDirectionLabel(undefined), 'Direction not provided')
assert.equal(presentation.gtfsDirectionLabel(''), 'Direction not provided')
assert.equal(presentation.gtfsDirectionLabel('0'), 'Direction 0')
assert.deepEqual(presentation.orderedGtfsPatterns([loop, route]).map((item) => item.id), ['outbound', 'loop'])
assert.deepEqual(presentation.gtfsPatternStops(loop, stops).map((stop) => [stop.order, stop.name]), [
  [1, 'Harvard'], [2, 'Central'], [3, 'Harvard'],
], 'Loop stop revisits must remain separate ordered occurrences.')
assert.equal(presentation.gtfsPatternStops({ ...route, stopIds: ['unknown'] }, stops)[0].name, 'unknown')
assert.equal(presentation.gtfsServiceClock(1440), '24:00')
assert.equal(presentation.gtfsServiceClock(1800), '30:00')
assert.equal(presentation.gtfsPatternTimetable(route).tripCount, 2, 'A selected service date must not display the feed-wide trip total as daily trips.')
assert.equal(presentation.gtfsPatternTimetable(route).spanLabel, '23:50–24:40')
assert.deepEqual(presentation.gtfsPatternTimetable(loop), {
  dated: true, tripCount: 0, startMinutes: undefined, endMinutes: undefined, spanLabel: 'No trips on this date',
}, 'An inactive branch must not retain a misleading all-calendar service band.')
assert.equal(presentation.gtfsPatternTimetable({ ...route, analysisServiceDate: undefined }).tripCount, 200)
assert.equal(presentation.gtfsPatternTimetable({ ...route, scheduledTrips: undefined, firstDepartureMinutes: undefined, lastArrivalMinutes: undefined }).spanLabel, 'Times unavailable')

const scopedRoute = { ...route, id: 'feed-a::outbound' }
assert.equal(analysis.routeHasCompleteGtfsAnalysis(scopedRoute, {
  routes: [scopedRoute, { ...route, id: 'feed-b::outbound' }],
}), true, 'A route_id reused by another feed must not trigger endless focused-analysis refetches.')
assert.equal(analysis.routeHasCompleteGtfsAnalysis({ ...scopedRoute, spanHours: 0, firstDepartureMinutes: 0, lastArrivalMinutes: 0, scheduledTrips: [] }, {
  routes: [scopedRoute],
}), true, 'An explicit focused zero-span analysis is complete.')
const merged = analysis.mergeGtfsRouteAnalysis({ feeds: [{
  id: 'feed-a', routeMetrics: [route, { ...route, id: 'stale-branch' }], stopMetrics: [],
  mapPreview: { routes: [route, { ...route, id: 'stale-branch' }], stops: [], stopPairs: [
    { id: 'old-pair', patternId: 'stale-branch' },
    { id: 'unrelated-pair', patternId: 'other-route' },
  ] },
}] }, 'feed-a', { routes: [route], stops: [], stopPairs: [{ id: 'new-pair', patternId: route.id }] })
assert.deepEqual(merged.feeds[0].mapPreview.stopPairs.map((pair) => pair.id), ['unrelated-pair', 'new-pair'], 'Replacing focused branches must also remove stop pairs belonging to retired patterns.')

const render = (mode) => renderToStaticMarkup(createElement(NetworkTimetable, {
  serviceDate: '2026-09-14', onServiceDateChange: () => {},
  feed: { name: 'Fixture GTFS' }, preview: { routes: [loop, route], stops }, selectedRoute: loop,
  analysisLoading: false, analysisError: '', routeRenderMode: mode,
  onRouteRenderModeChange() {}, onSelectPattern() {}, onOpenSources() {}, onClearSelection() {},
}))
const patternHtml = render('pattern')
assert.match(patternHtml, /Show P1, Direction 0, from Harvard to Central, 2 stops/)
assert.match(patternHtml, /Show P2, Direction not provided, from Harvard to Harvard, 3 stops/)
assert.match(patternHtml, /P2 · Stops/)
assert.match(patternHtml, /shape_id=shape-1/)
assert.match(patternHtml, /No trips on this date/)
assert.match(patternHtml, /30:00/)
assert.match(patternHtml, /Stop connections · exact path unavailable/)
assert.doesNotMatch(patternHtml, /Primary/)
assert.match(render('service'), /<button[^>]+aria-label="Direction 0, select main pattern, 2 scheduled trips, 23:50–24:40"/)
console.log('GTFS inspector checks passed: branch identities, ordered loops, dated bands, overnight clocks, focused-analysis scope, and rendered controls.')
