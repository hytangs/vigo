import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Papa from 'papaparse'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSsrTestServer } from './helpers/ssr-test-server.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-result-export-'))
const server = await createSsrTestServer({ configFile: false, cacheDir: path.join(directory, 'cache') })
try {
  const { exportJourney, exportJourneys, exportReachResults, reachGeometryAvailable, journeyGeometryAvailable } = await server.ssrLoadModule('/src/app/resultExports.ts')
  const { reachResultDifference, reachResultMetrics, reachScenarioDifference } = await server.ssrLoadModule('/src/app/resultSummary.ts')
  const { scenarioImprovedPixels, scenarioWorsenedPixels } = await server.ssrLoadModule('/src/reach.ts')
  const { ResultExportActions } = await server.ssrLoadModule('/src/components/ResultExportActions.tsx')
  const pending = renderToStaticMarkup(createElement(ResultExportActions, { label: 'Save Reach results', disabled: true, onExport: () => assert.fail('A pending export must not run') }))
  assert.equal((pending.match(/disabled=""/g) ?? []).length, 1, 'Prevent saving partial Reach while the computation is running.')
  const plan = { id: 'overnight', title: 'Overnight ride', status: 'ready', travelMode: 'transit', timePreference: 'depart',
    origin: { label: 'Origin / "A"', coordinate: [-77.05, 38.9] }, destination: { label: 'Destination B', coordinate: [-77.04, 38.91] },
    departMinutes: 1450.5, arriveMinutes: 1470, durationMinutes: 19.5, transfers: 0, walkMinutes: 0, waitMinutes: 0, rideMinutes: 19.5,
    diagnostics: { serviceDate: '2026-07-15', departureWindow: { centerMinutes: 1440 }, routingDataProvenance: { timeZone: 'America/New_York' } },
    legs: [{ type: 'ride', fromName: 'Station, "A"', toName: 'Station\nB', routeId: 'route', tripId: 'night',
      startMinutes: 1450.5, endMinutes: 1470, durationMinutes: 19.5, distanceKm: 5,
      coordinates: [[-77.05, 38.9], [-77.04, 38.91]], geometrySource: 'shape' }] }
  const original = JSON.stringify(plan)
  const json = JSON.parse(exportJourney(plan, 'json').text)
  assert.deepEqual(json.plan, plan)
  assert.equal(json.summary.initialWaitMinutes, 10.5)
  assert.equal(json.summary.totalElapsedMinutes, 30)
  assert.equal(json.summary.journeyMinutes, 19.5)
  assert.match(exportJourney(plan, 'json').name, /^vigo-journey-2026-07-15-Origin-A-Destination-B-overnight-[\dTZ]+\.json$/)
  const international = exportJourney({ ...plan, id: '東京'.repeat(50), origin: { ...plan.origin, label: '東京駅'.repeat(50) },
    destination: { ...plan.destination, label: '𐐀'.repeat(50) } }, 'json').name
  assert(Buffer.byteLength(international) < 220, 'International place names must fit a portable filename byte budget.')
  assert(!international.includes('\ufffd'), 'Do not split a Unicode character in a filename.')
  const itinerary = exportJourney(plan, 'md').text
  assert.match(itinerary, /24:10:30–24:30:00/)
  assert.match(itinerary, /Total from requested departure: 30 min · journey: 19.5 min · initial wait: 10.5 min/)
  assert.match(itinerary, /America\/New_York/)
  assert.doesNotMatch(exportJourney({ ...plan, timePreference: 'arrive' }, 'md').text, /Total from requested departure/, 'Arrive-by targets are not departure clocks.')
  const geometry = JSON.parse(exportJourney(plan, 'geojson').text)
  assert.deepEqual(geometry.features[0].geometry.coordinates, plan.legs[0].coordinates)
  assert.equal(geometry.features[0].properties.startMinutes, 1450.5, 'Exports must retain overnight service clocks.')
  const rows = Papa.parse(exportJourney(plan, 'csv').text, { header: true, skipEmptyLines: true })
  assert.deepEqual(rows.errors, [])
  assert.equal(rows.data[0].from, plan.legs[0].fromName)
  assert.equal(rows.data[0].to, plan.legs[0].toName)
  assert.equal(rows.data[0].trip_id, 'night')
  assert.equal(rows.data[0].time_zone, 'America/New_York')
  assert.equal(JSON.stringify(plan), original, 'Saving must not mutate the route being inspected.')
  const missingPath = { ...plan, legs: [{ ...plan.legs[0], coordinates: [] }] }
  assert.equal(journeyGeometryAvailable(missingPath), false)
  assert.throws(() => exportJourney(missingPath, 'geojson'), /Complete path geometry/, 'Do not silently save an empty or partial journey map.')
  assert.equal(journeyGeometryAvailable({ ...plan, legs: [...plan.legs, { ...plan.legs[0], coordinates: [[NaN, 0], [1, 1]] }] }), false)
  assert.throws(() => exportJourney({ ...plan, status: 'blocked' }, 'json'), /completed journeys/)
  const alternatives = Array.from({ length: 7 }, (_, index) => ({ ...plan, id: `option-${index}` }))
  const savedOptions = JSON.parse(exportJourneys(alternatives, 'json', 'option-6').text)
  assert.deepEqual(savedOptions.plans, alternatives)
  assert.equal(savedOptions.selectedJourneyId, 'option-6')
  const optionRows = Papa.parse(exportJourneys(alternatives, 'csv', 'option-6').text, { header: true, skipEmptyLines: true }).data
  assert.equal(optionRows.length, 7, 'Export every completed option, beyond the five visible cards.')
  assert.equal(optionRows[6].selected, 'true')
  assert.equal(optionRows[0].initial_wait_minutes, '10.5')
  assert.equal(optionRows[0].total_elapsed_minutes, '30')

  const encode = values => { const bytes = Buffer.alloc(values.length * 2); values.forEach((value, i) => bytes.writeUInt16LE(value, i * 2)); return bytes.toString('base64') }
  const result = { request: { origin: { coordinate: [-77, 39] }, serviceDate: '2026-07-15', departMinutes: 480,
    scenario: { name: 'Case' }, maxWalkKm: 1.2, cutoffsMinutes: [15] }, summary: { maximumCutoffMinutes: 45, improvedPixels: 2, transitStopSeeds: 1 },
    diagnostics: { totalMs: 200 }, surface: { raster: { width: 4, height: 1, bounds: [-77, 39, -76.9, 39.1], scale: 10, nodata: 65535,
      baseline: encode([100, 200, 300, 65535]), scenario: encode([90, 400, 65535, 200]) },
      areas: { baseline: { features: [{ type: 'Feature', properties: { cutoffMinutes: 15 }, geometry: { type: 'MultiPolygon', coordinates: [] } }] },
        scenario: { features: [{ type: 'Feature', properties: { cutoffMinutes: 15 }, geometry: { type: 'MultiPolygon', coordinates: [] } }] } } } }
  assert.equal(scenarioImprovedPixels(result, 15), 1, 'A short cutoff must not reuse the full-window improvement count.')
  assert.equal(scenarioImprovedPixels(result, 30), 2)
  assert.equal(scenarioWorsenedPixels(result, 15), 0)
  assert.equal(scenarioWorsenedPixels(result, 30), 2, 'Count slower and lost baseline cells, including a scenario beyond the cutoff.')
  const precise = { ...result, summary: { ...result.summary, changeCountsByCutoff: [{ cutoffMinutes: 15, improvedPixels: 3, worsenedPixels: 2 }] } }
  assert.equal(scenarioImprovedPixels(precise, 15), 3, 'Prefer raw backend counts to the quantized display raster.')
  assert.equal(scenarioWorsenedPixels(precise, 15), 2)
  const entries = [{ name: 'Case, "saved"', result }]
  assert.equal(reachGeometryAvailable(entries, 15), true)
  assert.equal(reachGeometryAvailable(entries, 30), false, 'A displayed cutoff must not imply that its exact geometry was retained.')
  const missingGeometry = renderToStaticMarkup(createElement(ResultExportActions, { label: 'Save Reach results', formats: ['geojson', 'json', 'csv'], unavailable: { geojson: 'Update Reach' }, onExport: () => assert.fail() }))
  assert.equal((missingGeometry.match(/disabled=""/g) ?? []).length, 0, 'A missing geometry leaves Save available for the other formats; the menu disables only GeoJSON.')
  assert.deepEqual(JSON.parse(exportReachResults(entries, 'json', 15).text).entries, entries)
  const reachRows = Papa.parse(exportReachResults(entries, 'csv', 15).text, { header: true, skipEmptyLines: true }).data
  assert.equal(reachRows[1].faster_or_newly_reached_cells, '1')
  assert.equal(reachRows[1].slower_or_lost_cells, '0')
  assert.equal(reachRows[1].cutoff_minutes, '15')
  assert.equal(JSON.parse(exportReachResults(entries, 'geojson', 15).text).features[0].properties.surface, 'baseline')
  assert.throws(() => exportReachResults(entries, 'geojson', 30), /retain geometry/)
  const withoutScenarioPath = { ...result, surface: { ...result.surface, areas: { ...result.surface.areas, scenario: { features: [] } } } }
  assert.equal(reachGeometryAvailable([{ name: 'Partial', result: withoutScenarioPath }], 15), false, 'An empty vector with reached cells is missing geometry, not an empty reach.')
  assert.throws(() => exportReachResults([{ name: 'Partial', result: { ...result, diagnostics: { ...result.diagnostics, preliminary: true } } }], 'json', 15), /complete Reach/)
  assert.throws(() => exportReachResults(entries, 'csv', 60), /selected time budget/)
  const metricResult = (areaKm2, stops) => ({ ...result, summary: { ...result.summary, transitStopsByCutoff: [{ cutoffMinutes: 15, stops }] },
    surface: { ...result.surface, areaMetrics: { baseline: { byCutoff: [{ cutoffMinutes: 15, areaKm2, reachablePixels: 1 }] } } } })
  const reference = metricResult(10, 3), candidate = metricResult(12.5, 5)
  const cityEntries = [{ name: 'Reference', feedId: 'first', result: reference }, { name: 'Candidate', feedId: 'second', result: candidate }]
  assert.deepEqual(reachResultDifference(reference, candidate, 15), { areaKm2: 2.5, transitStops: 2 })
  const cityRows = Papa.parse(exportReachResults(cityEntries, 'csv', 15).text, { header: true, skipEmptyLines: true }).data
  assert.equal(cityRows.length, 2, 'Independent Cities export one baseline row each, without a duplicate scenario.')
  assert.equal(cityRows[1].reference_feed_id, 'first')
  assert.equal(cityRows[1].area_delta_km2, '2.5')
  assert.equal(cityRows[1].transit_stop_delta, '2')
  assert.equal(cityRows[1].max_walk_km, '1.2')
  assert.equal(cityRows[1].walk_speed_kph, '4.8')
  assert.equal(JSON.parse(exportReachResults(cityEntries, 'geojson', 15).text).features.length, 2)
  assert.equal(JSON.parse(exportReachResults(cityEntries, 'json', 15).text).selectedSummary[1].differenceFromReference.areaKm2, 2.5)
  assert.equal(reachResultDifference(reference, { ...candidate, request: { ...candidate.request, departMinutes: 481 } }, 15), null, 'Different departure snapshots cannot establish a comparison.')
  const edited = { ...reference, summary: { ...reference.summary, scenarioTransitStopsByCutoff: [{ cutoffMinutes: 15, stops: 1 }] },
    surface: { ...reference.surface, areaMetrics: { ...reference.surface.areaMetrics, scenario: { byCutoff: [{ cutoffMinutes: 15, reachablePixels: 1, areaKm2: 7.5 }] } } } }
  assert.deepEqual(reachScenarioDifference(edited, 15), { areaKm2: -2.5, transitStops: -2 })
  const scenarioExport = JSON.parse(exportReachResults([{ name: 'Edited', result: edited }], 'json', 15).text)
  assert.equal(scenarioExport.selectedSummary[1].differenceFromBaseline.areaKm2, -2.5)
  const editedRows = Papa.parse(exportReachResults([{ name: 'Edited', result: edited }], 'csv', 15).text, { header: true, skipEmptyLines: true }).data
  assert.equal(editedRows[1].area_delta_km2, '-2.5')
  assert.equal(editedRows[1].transit_stop_delta, '-2')
  assert.equal(editedRows[1].reference_surface, 'baseline')
  assert.equal(reachResultDifference(reference, candidate, 46), null, 'A longer-than-computed cutoff cannot establish a comparison.')
  assert.equal(reachResultMetrics(result, 'baseline', 15).transitStops, null)
  assert.equal(reachResultMetrics({ ...result, diagnostics: { totalMs: null } }, 'baseline', 15).totalProcessingMs, null)
  assert.equal(reachResultMetrics({ ...result, diagnostics: { totalMs: 0 } }, 'baseline', 15).totalProcessingMs, 0)
  console.log('Saved journey and Reach files preserve clocks, geometry, CSV labels, complete result records, cutoff-specific gains/losses, and unavailable query timing.')
} finally { await server.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
