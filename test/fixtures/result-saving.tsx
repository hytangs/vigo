import { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { RoutingDetailPanel } from '../../src/components/JourneyItinerary'
import { PathfinderRouteList } from '../../src/components/PathfinderPanel'
import { AnalyzePanelView } from '../../src/components/AnalyzePanel'
import { ResultExportActions } from '../../src/components/ResultExportActions'
import '../../src/App.css'
import '../../src/index.css'

const origin = { label: 'Harvard / "Yard"', coordinate: [-71.116, 42.374], source: 'map' }
const destination = { label: 'Central Square', coordinate: [-71.104, 42.365], source: 'stop', stopId: 'central' }
const plan = {
  id: 'overnight-choice', status: 'ready', travelMode: 'transit', timePreference: 'depart', maxWalkKm: 1.2,
  title: 'Red Line', choiceLabel: 'Earliest arrival', recommended: true, detail: 'Fixture journey',
  origin, destination, waypoints: [{ ...origin, label: 'Harvard station', source: 'stop' }],
  departMinutes: 1450.5, arriveMinutes: 1470.125, durationMinutes: 19.625, transfers: 0,
  walkMinutes: 0, rideMinutes: 19.625, waitMinutes: 0,
  legs: [{ type: 'ride', fromName: 'Harvard, "Station"', toName: 'Central\nSquare', routeId: 'Red', routeShortName: 'Red',
    routeColor: 'da291c', tripId: 'overnight-trip', startMinutes: 1450.5, endMinutes: 1470.125,
    durationMinutes: 19.625, distanceKm: 1.4, stopCount: 1, geometrySource: 'shape',
    coordinates: [origin.coordinate, destination.coordinate] }],
  diagnostics: { serviceDate: '2026-07-15', serviceDay: 'wednesday', routingDataMode: 'scheduled',
    departureWindow: { centerMinutes: 1440 }, searchStats: { queryMs: 1.25 },
    routingDataProvenance: { timeZone: 'America/New_York' } },
}
const plans = Array.from({ length: 7 }, (_, i) => ({ ...plan, id: i ? `alternative-${i}` : plan.id,
  recommended: !i, choiceLabel: i ? 'Another journey' : plan.choiceLabel,
  arriveMinutes: plan.arriveMinutes + i, durationMinutes: plan.durationMinutes + i }))
const encode = (values: number[]) => {
  const bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer)
  values.forEach((value, i) => view.setUint16(i * 2, value, true))
  return btoa(String.fromCharCode(...bytes))
}
const geometry = { type: 'MultiPolygon', coordinates: [[[[-71.12, 42.36], [-71.1, 42.36], [-71.1, 42.38], [-71.12, 42.38], [-71.12, 42.36]]]] }
const collection = { type: 'FeatureCollection', features: [15, 30].map(cutoffMinutes => ({ type: 'Feature', properties: { cutoffMinutes }, geometry })) }
const baselineArea = { byCutoff: [{ cutoffMinutes: 15, reachablePixels: 1, areaKm2: 10 }, { cutoffMinutes: 30, reachablePixels: 3, areaKm2: 20 }] }
const result = {
  schemaVersion: 'vigo.result.reach.v1',
  request: { baselineIdentity: 'synthetic-city', origin, departMinutes: 1440, serviceDate: '2026-07-15', serviceDay: 'wednesday',
    mode: 'transit', surfaceSampling: 'street', maxWalkKm: 1.2, walkSpeedKph: 4.8, radiusKm: 5, rasterSize: 4,
    cutoffsMinutes: [15, 30], scenario: { id: 'case-a', name: 'Case, "new service"', serviceCount: 1 } },
  summary: { pixels: 4, maximumCutoffMinutes: 30, baselineReachablePixels: 3, scenarioReachablePixels: 3,
    improvedPixels: 2, transitStopSeeds: 6,
    changeCountsByCutoff: [{ cutoffMinutes: 15, improvedPixels: 1, worsenedPixels: 0 }, { cutoffMinutes: 30, improvedPixels: 2, worsenedPixels: 2 }],
    transitStopsByCutoff: [{ cutoffMinutes: 15, stops: 3 }, { cutoffMinutes: 30, stops: 6 }],
    scenarioTransitStopsByCutoff: [{ cutoffMinutes: 15, stops: 5 }, { cutoffMinutes: 30, stops: 4 }] },
  surface: { raster: { width: 4, height: 1, bounds: [-71.12, 42.36, -71.1, 42.38], scale: 10, nodata: 65535,
    baseline: encode([100, 200, 300, 65535]), scenario: encode([90, 210, 65535, 200]) },
    areaMetrics: { baseline: baselineArea, scenario: { byCutoff: [
      { cutoffMinutes: 15, reachablePixels: 1, areaKm2: 12.5 }, { cutoffMinutes: 30, reachablePixels: 3, areaKm2: 18.5 },
    ] } },
    areas: { baseline: collection, scenario: collection }, contours: { baseline: collection, scenario: collection } },
  scenario: { id: 'case-a', name: 'New service', routes: { type: 'FeatureCollection', features: [] } },
  limitations: [], diagnostics: { totalMs: 31.25, raster: {} },
}
const candidate = { ...result, request: { ...result.request, baselineIdentity: 'other-city' },
  summary: { ...result.summary, transitStopsByCutoff: result.summary.scenarioTransitStopsByCutoff },
  surface: { ...result.surface, areaMetrics: { ...result.surface.areaMetrics, baseline: { byCutoff: [
    { cutoffMinutes: 15, reachablePixels: 1, areaKm2: 12.5 }, { cutoffMinutes: 30, reachablePixels: 3, areaKm2: 18.5 },
  ] } } } }
const comparison = [{ feedId: 'reference', feedName: 'Reference timetable', result },
  { feedId: 'candidate', feedName: 'Candidate timetable', result: candidate }]
const feeds = comparison.map(entry => ({ id: entry.feedId, name: entry.feedName, routeCount: 10, stopCount: 30, tripCount: 60 }))
const cases = [{ id: 'case-a', name: 'Case, "new service"', interventions: [{ id: 'remove', name: 'Remove line',
  kind: 'remove-line', routeId: 'Red', routeScope: 'route', stops: [], headwayMinutes: 10,
  averageSpeedKph: 25, startMinutes: 300, endMinutes: 1500, bidirectional: true }] }]

function Fixture() {
  const [mode, setMode] = useState('journey'), [variant, setVariant] = useState('complete')
  const [cutoff, setCutoff] = useState(15), [selected, setSelected] = useState(plan.id), [dark, setDark] = useState(false)
  window.showResult = (value, state = 'complete') => flushSync(() => { setMode(value); setVariant(state); setCutoff(15) })
  window.changeCutoff = value => flushSync(() => setCutoff(value))
  window.changeTheme = value => flushSync(() => setDark(value))
  useLayoutEffect(() => {
    document.documentElement.dataset.appearance = dark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  const analysis = variant === 'preliminary' ? { ...result, diagnostics: { ...result.diagnostics, preliminary: true } }
    : variant === 'missing-geometry' ? { ...result, surface: { ...result.surface, areas: undefined, contours: { baseline: { features: [] }, scenario: { features: [] } } } }
    : result
  return <main className={`app-shell page-project appearance-${dark ? 'dark' : 'light'}`}>
    <header className="topbar"><strong>VIGO · Results</strong></header>
    <div className="app-frame"><div className="shell-body">
      <aside className="app-sidebar">
        <nav className="sidebar-rail"><button className="sidebar-rail-button" aria-current="page">◎</button></nav>
        <section className={`sidebar-panel${mode === 'journey' ? '' : ' is-analyze'}`}>
          {mode === 'journey' ? <PathfinderRouteList plans={plans} selectedPlanId={selected}
            alternativesLoading={variant === 'loading'} onSelect={setSelected} />
            : mode === 'error' ? <ResultExportActions label="Save failure example" onExport={() => { throw Error('Could not prepare this result. Try again.') }} />
            : <AnalyzePanelView mode={mode === 'city' ? 'compare' : 'single'} origin={origin}
              serviceDate={result.request.serviceDate} departMinutes={1440} maxWalkKm={1.2} walkSpeedKph={4.8}
              cutoffMinutes={cutoff} surfaceSampling="street" renderMode="area" onRenderModeChange={() => {}}
              cases={mode === 'reach' ? cases : []} activeCaseId="case-a" activeInterventionId="remove" view="comparison"
              feeds={feeds} comparisonFeedIds={['reference', 'candidate']} routes={[]} stops={[]}
              analysis={mode === 'reach' ? analysis : null} comparison={mode === 'city' ? comparison : null}
              loading={variant === 'loading'} preparationTasks={[]} routingStoreAvailable streetGraphAvailable
              onCutoffChange={setCutoff} onModeChange={() => {}} onServiceDateChange={() => {}} onDepartMinutesChange={() => {}}
              onRun={() => {}} onRunComparison={() => {}} onRunServiceDecomposition={() => {}} />}
        </section>
      </aside>
      <section className="app-frame" style={{ position: 'relative', minWidth: 0, background: 'var(--panel-soft)' }}>
        {mode === 'journey' ? <RoutingDetailPanel plan={plans.find(entry => entry.id === selected)} onClose={() => {}} /> : null}
      </section>
    </div></div>
  </main>
}
flushSync(() => createRoot(document.getElementById('root')).render(<Fixture />))

function assert(condition, message) { if (!condition) throw Error(message) }
function group(label) {
  const element = document.querySelector(`[role="group"][aria-label="${label}"]`)
  assert(element, 'Missing save control: ' + label)
  return element
}
window.saveResult = (label, format) => {
  const element = group(label), picker = element.querySelector('select')
  picker.value = format
  flushSync(() => picker.dispatchEvent(new Event('change', { bubbles: true })))
  flushSync(() => element.querySelector('button').click())
  return element.querySelector('[role="status"],[role="alert"]')?.textContent
}
window.prepareSave = (label, format) => {
  const element = group(label), picker = element.querySelector('select')
  picker.value = format
  flushSync(() => picker.dispatchEvent(new Event('change', { bubbles: true })))
  const button = element.querySelector('button')
  button.scrollIntoView({ block: 'center' })
  const bounds = button.getBoundingClientRect(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  const hit = document.elementFromPoint(x, y)
  assert(!button.disabled && (hit === button || button.contains(hit)), 'Save is not reachable by pointer')
  return { x, y }
}
window.downloadFeedback = label => group(label).querySelector('[role="status"],[role="alert"]')?.textContent
window.checkResultState = () => {
  window.showResult('city')
  assert(document.querySelector('.reach-reference-label').textContent === 'Reference', 'Reference feed is missing')
  assert(document.querySelector('.reach-comparison-difference').textContent === '+2.50 km² · +2 reached stops', 'Positive differences disagree with exact cutoff')
  window.changeCutoff(30)
  assert(document.querySelector('.reach-comparison-difference').textContent === '-1.50 km² · -2 reached stops', 'Negative differences lost at the longer cutoff')
  window.showResult('reach')
  assert(document.querySelector('.reach-scenario-difference').textContent === '+2.50 km² · +2 reached stops from baseline', 'Scenario gains disagree with exact cutoff')
  window.changeCutoff(30)
  assert(document.querySelector('.reach-scenario-difference').textContent === '-1.50 km² · -2 reached stops from baseline', 'Scenario losses disagree with exact cutoff')
  window.showResult('reach', 'loading')
  assert(group('Save Reach results').querySelector('button').disabled, 'Running results can be saved')
  window.showResult('reach', 'preliminary')
  assert(group('Save Reach results').querySelector('button').disabled, 'Preliminary results can be saved')
  window.showResult('reach', 'missing-geometry')
  window.saveResult('Save Reach results', 'geojson')
  assert(group('Save Reach results').querySelector('button').disabled && group('Save Reach results').textContent.includes('retain geometry'), 'Missing geometry is not explained')
  window.showResult('error')
  window.saveResult('Save failure example', 'json')
  assert(group('Save failure example').querySelector('[role="alert"]').textContent.includes('Try again'), 'Formatting failure is not visible')
  window.showResult('journey', 'loading')
  assert(group('Save all 7 journeys').querySelector('button').disabled, 'An incomplete alternative collection can be saved')
  assert(!group('Save journey').querySelector('button').disabled, 'A completed selected journey should remain savable')
  return { positiveAndNegativeDifferences: true, cutoffSpecific: true, partialResultsBlocked: true, errorsVisible: true }
}
window.checkDownloadFeedback = label => {
  assert(group(label).querySelector('[role="status"]')?.textContent.startsWith('Download started:'), 'Download has no feedback')
  const before = URL.createObjectURL
  URL.createObjectURL = () => { throw Error('Could not start this download. Try again.') }
  try { window.saveResult(label, 'json') } finally { URL.createObjectURL = before }
  assert(group(label).querySelector('[role="alert"]').textContent.includes('Could not start this download'), 'Browser download failure is not visible')
}
window.checkFeedbackReset = () => {
  window.changeCutoff(30)
  assert(!group('Save Reach results').querySelector('[role="status"],[role="alert"]'), 'A changed cutoff retains a success/error for the old result')
}
window.checkResultLayout = (mode, dark) => {
  window.showResult(mode); window.changeTheme(dark)
  const expand = document.querySelector('.reach-expand')
  if (expand?.getAttribute('aria-expanded') === 'false') flushSync(() => expand.click())
  const controls = [...document.querySelectorAll('.result-export-actions')]
  for (const control of controls) {
    control.scrollIntoView({ block: 'center' })
    const r = control.getBoundingClientRect()
    assert(r.left >= -1 && r.right <= innerWidth + 1 && control.scrollWidth <= control.clientWidth + 1, 'Save control overflows')
    for (const button of control.querySelectorAll('select,button')) {
      assert(button.clientHeight >= 30, 'Save control is too short')
    }
  }
  const panel = document.querySelector(mode === 'journey' ? '.routing-detail-scroll' : '.reach-surface')
  assert(panel.scrollWidth <= panel.clientWidth + 1, 'Result panel overflows horizontally')
  if (mode === 'city') {
    const rows = [...document.querySelectorAll('.reach-comparison-result')]
    for (const row of rows) assert(row.scrollWidth <= row.clientWidth + 1, 'Comparison row overflows')
    rows.at(-1).scrollIntoView({ block: 'end' })
  } else if (mode === 'reach') {
    document.querySelector('.reach-scenario-difference').scrollIntoView({ block: 'end' })
  }
  return { width: innerWidth, mode, dark, controls: controls.length }
}
window.expectedPlan = plan
