import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-vehicle-details-'))
const server = await createServer({ configFile: false, plugins: [react()], cacheDir: path.join(directory, 'cache'), server: { middlewareMode: true }, appType: 'custom' })
try {
  const { VehicleDetailsView, VehicleOperationalWarnings } = await server.ssrLoadModule('/src/components/AgencyVehicleDetails.tsx')
  const warnings = renderToStaticMarkup(createElement(VehicleOperationalWarnings, { vehicle: { card: { metrics: [
    { value: '0 min spacing · scheduled 7 min', label: 'Predicted at Central · vehicles 1823 ↔ 1889' },
    { value: 'Seats available', label: 'reported occupancy' },
  ] } } }))
  assert.match(warnings, /0 min spacing · scheduled 7 min/)
  assert.match(warnings, /vehicles 1823 ↔ 1889/)
  assert.doesNotMatch(warnings, /Seats available/, 'Shared warnings do not duplicate vehicle details')
  assert.equal(renderToStaticMarkup(createElement(VehicleOperationalWarnings, {})), '', 'No matched live vehicle means no operational warning')
  const epoch = Date.parse('2026-09-16T02:45:00Z') / 1000
  const vehicle = {
    id: 'y1826', label: '1826', routeName: '1', tripId: 'trip-1', serviceDate: '2026-09-15', timezone: 'America/New_York',
    destination: 'Terminal', stop: { id: 'A', stopId: 'A', name: 'Reported stop' }, status: 'STOPPED_AT',
    arrival: { scheduled: epoch, current: null }, departure: { scheduled: epoch, current: null },
    delayKind: null, delaySeconds: null, occupancy: null, fresh: true, observedAt: epoch + 720, predictionAt: epoch + 715,
    warnings: ['No prediction is supplied for this reported stop.'],
  }
  const nextPrediction = {
    stop: { id: 'C', stopId: 'C', name: 'Later stop' }, callIndex: 3,
    arrival: { scheduled: epoch + 120, current: epoch + 840 }, departure: { scheduled: epoch + 180, current: null },
    delayKind: 'arrival', delaySeconds: 720,
  }
  const navigation = patch => renderToStaticMarkup(createElement(VehicleDetailsView, { vehicle: { ...vehicle, routeId: 'R', ...patch }, onOpenTrip() {} }))
  assert.doesNotMatch(navigation({}), /Open line/)
  assert.match(navigation({}), /Open trip/)
  assert.doesNotMatch(navigation({ tripId: null }), /Open trip/)
  assert.doesNotMatch(navigation({ serviceDate: null }), /Open trip/)
  assert.doesNotMatch(navigation({ routeId: null }), /Open line|Open trip/)
  const render = patch => renderToStaticMarkup(createElement(VehicleDetailsView, { vehicle: { ...vehicle, ...patch } }))
  assert.doesNotMatch(render({ occupancy: 'FULL' }).replace(/<[^>]*>/g, ''), /Reported occupancy|Full/, 'Occupancy is a compact glyph; its description stays accessible and in the tooltip')
  assert.match(render({ occupancy: 'FULL' }), /Reported occupancy · Full/)
  assert.match(render({ occupancy: null }), /Occupancy unknown/)
  assert.match(render({ occupancy: 'FULL', fresh: false }), /Not current/)
  const carriages = [{ label: '1462', carriageSequence: 1, occupancyStatus: 'FEW_SEATS_AVAILABLE' }, { label: '1463', carriageSequence: 2 }]
  const trainHtml = render({ carriages })
  assert.match(trainHtml, /Reported crowding by car/)
  assert.match(trainHtml, /1\/2 cars reporting/)
  assert.match(trainHtml, /1462.*Few seats/)
  assert.match(trainHtml, /1463.*Occupancy unknown/)
  assert.match(render({ carriages, fresh: false }), /Crowding · Not current/)
  let html = render({})
  assert.match(html, /1826 <small>Route 1<\/small>/, 'Copied vehicle and route identifiers stay distinct')
  assert.match(html, /Updated/)
  assert.doesNotMatch(html, /Prediction updated|Next prediction/)
  assert.match(html, /No prediction is supplied for this reported stop/)
  assert.equal((html.match(/<td>—<\/td>/g) ?? []).length, 2, 'A fresh trip update cannot invent current-stop times')

  html = render({ nextPrediction })
  assert.match(html, /At Reported stop/)
  assert.match(html, /Next prediction<\/span><strong>Later stop/)
  assert.ok(html.indexOf('No prediction is supplied') < html.indexOf('Next prediction'), 'Missing-stop warning belongs to the reported position, before the next prediction')
  assert.match(html, /aria-label="Scheduled and predicted times at Later stop"/)
  assert.match(html, /10:59 PM/)
  assert.match(html, /12 min later/)
  assert.equal((html.match(/<table/g) ?? []).length, 1, 'Show one clearly located prediction table')
  assert.doesNotMatch(html, /At next stop|10:45 PM/, 'A downstream forecast may skip stops and must use its own schedule')
  assert.equal((html.match(/<td>—<\/td>/g) ?? []).length, 1, 'A missing departure remains missing when only arrival is supplied')

  html = render({ nextPrediction, departure: { scheduled: epoch, current: epoch + 720 }, delayKind: 'departure', delaySeconds: 720, warnings: [] })
  assert.match(html, /aria-label="Scheduled and predicted times at Reported stop"/)
  assert.match(html, /At this stop/)
  assert.match(html, /10:57 PM/)
  assert.doesNotMatch(html, /Next prediction|Later stop|10:59 PM/, 'Any valid current-stop timing takes priority over downstream timing')

  html = render({ fresh: false, predictionAt: null, warnings: ['The vehicle position is stale.'] })
  assert.match(html, /Not current/)
  assert.doesNotMatch(html, /Updated|Next prediction/)
} finally {
  await server.close()
  await fs.rm(directory, { recursive: true, force: true })
}
console.log('Vehicle details: separate route identity, missing current-stop timing, explicit downstream prediction, partial events and current-stop priority passed.')
