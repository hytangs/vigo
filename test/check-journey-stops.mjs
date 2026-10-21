import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import electronPath from 'electron'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createViteTestServer } from './helpers/vite-test-server.mjs'
import { studioRouteResponse } from '../src/server/studio-route-plans.mjs'

const origin = { label: 'Origin', coordinate: [0, 0], source: 'stop', stopId: 'O' }
const destination = { label: 'Destination', coordinate: [0.02, 0], source: 'stop', stopId: 'D' }
const body = { origin, destination, mode: 'transit', timePreference: 'depart', departMinutes: 480, serviceDate: '2026-07-15', maxWalkKm: 1.2 }
const stops = [{ stopId: 'A', name: 'Market Street' }, { stopId: 'B', name: 'Library' }, { stopId: 'A', name: 'Market Street' }]
const raw = { status: 'ready', departureMinutes: 480, arrivalMinutes: 500, legs: [{ kind: 'ride', fromStopId: 'O', toStopId: 'D',
  from: { name: 'Origin' }, to: { name: 'Destination' }, routeId: 'R', tripId: 'T',
  departure: 28800, arrival: 30000, departureMinutes: 480, arrivalMinutes: 500,
  stopCount: 4, intermediateStops: stops, coordinates: [[0, 0], [0.02, 0]] }] }
const plan = studioRouteResponse(raw, body).choices[0]
assert.deepEqual(plan.legs[0].intermediateStops, stops, 'Keep every stop call in order, including revisits')
plan.sharedLegAlternatives = { options: [], frequencies: [{ legIndex: 0, departureCount: 4, uniqueDepartureCount: 3,
  status: 'complete', windowStartSeconds: 28800, windowEndSeconds: 30600, meanHeadwaySeconds: 600 }] }
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-journey-stops-'))
let previewHtml = '', farePreviewHtml = ''
const server = await createViteTestServer({ configFile: false, cacheDir: path.join(directory, 'cache'),
  plugins: [{ name: 'journey-preview', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (!['/journey-check', '/fare-check'].includes(request.url)) return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(`<html><head><meta charset="utf-8"></head><body><main class="app-shell page-project appearance-light">${request.url === '/fare-check' ? farePreviewHtml : previewHtml}</main><script type="module">import '/src/index.css'; import '/src/App.css'; import '/src/styles/routing-fares.css';</script></body></html>`)
    })
  } }], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
try {
  const { RoutingItinerary, RoutingDetailPanel } = await server.ssrLoadModule('/src/components/JourneyItinerary.tsx')
  const { ReachPointInspector } = await server.ssrLoadModule('/src/components/ReachPointInspector.tsx')
  const result = { request: { ...body, cutoffsMinutes: [30], scenario: { serviceCount: 0 } },
    surface: { raster: { width: 1, height: 1, bounds: [-1, -1, 1, 1], scale: 10, nodata: 65535, baseline: 'AAA=' } } }
  const routeHtml = renderToStaticMarkup(createElement(RoutingItinerary, { plan }))
  const reachHtml = renderToStaticMarkup(createElement(ReachPointInspector, { inspection: {
    point: destination, source: { id: 'fixture', result }, plan, loading: false, error: '', close() {}, retry() {},
  } }))
  for (const html of [routeHtml, reachHtml]) {
    assert.match(html, /Stops along the way · 3/)
    assert.match(html, /Market Street<\/li><li[^>]*>Library<\/li><li[^>]*>Market Street/)
    assert.match(html, /<summary>4 departures<\/summary>/)
    assert.doesNotMatch(html, /distinct times|Mean gap/)
  }
  const { RoutingFare } = await server.ssrLoadModule('/src/components/RoutingFare.tsx')
  const option = (name, amount, media, currency = 'USD') => ({ productId: name, name, amount, currency, media })
  const fare = { status: 'published', standard: 'GTFS Fares v2', source: 'Fixture.zip', agencyUrl: 'https://example.org/fares',
    options: [option('Subway Quick Ticket', 2.4, 'CharlieTicket'), option('Subway one-way fare', 2.4, 'CharlieCard'), option('Subway one-way fare', 2.4, 'Contactless payment')] }
  const farePlan = { ...plan, legs: [
    { ...plan.legs[0], routeShortName: 'E', fare },
    { ...plan.legs[0], routeShortName: 'D', fare: { ...fare, options: [...fare.options].reverse() } },
    { ...plan.legs[0], routeShortName: '60', fare: { ...fare, options: [option('Local Bus one-way fare', 1.7, 'Cash'), fare.options[0]] } },
  ] }
  const fareHtml = renderToStaticMarkup(createElement(RoutingFare, { plan: farePlan }))
  assert.equal((fareHtml.match(/class="routing-fare-group"/g) ?? []).length, 2, 'Equivalent fares should share a route row')
  assert.match(fareHtml, /E, D/)
  assert.match(fareHtml, /Transfers not calculated/)
  assert.equal((fareHtml.match(/Fixture.zip/g) ?? []).length, 1, 'Source metadata should appear once')
  assert.doesNotMatch(fareHtml, /Fares by boarding/)
  assert.match(fareHtml, /CharlieCard, Contactless payment/)
  const mixed = { ...farePlan, legs: [...farePlan.legs, { ...plan.legs[0], routeShortName: 'X', fare: undefined }] }
  assert.match(renderToStaticMarkup(createElement(RoutingFare, { plan: mixed })), /Fare data is unavailable for this service/)
  const currencies = { ...plan, legs: [{ ...plan.legs[0], fare: { ...fare, options: [option('Ticket', 2.4, 'Card'), option('Ticket', 2.4, 'Card', 'EUR')] } }] }
  const currencyHtml = renderToStaticMarkup(createElement(RoutingFare, { plan: currencies }))
  assert.equal((currencyHtml.match(/class="routing-fare-products"/g) ?? []).length, 2, 'Different currencies must stay separate')
  farePreviewHtml = `<section style="width:360px;max-width:100%;padding:24px">${fareHtml}</section>`
  const panelHtml = renderToStaticMarkup(createElement(RoutingDetailPanel, { plan, onClose() {} }))
  previewHtml = panelHtml
  const screenshot = path.join(directory, 'journey-stops.png')
  const main = path.join(directory, 'main.cjs')
  await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async()=>{try{
const w=new BrowserWindow({width:620,height:760,show:true,webPreferences:{sandbox:true,contextIsolation:true}});
await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/journey-check`)});
await w.webContents.executeJavaScript(\`document.querySelector('.journey-stops summary').click(); document.querySelector('.journey-shared-services summary').click();\`);
const open=await w.webContents.executeJavaScript(\`document.querySelector('.journey-stops').open && document.querySelectorAll('.journey-stops li').length===3\`);
if(!open)throw Error('Stop list did not expand');
await new Promise(r=>setTimeout(r,500));
require('node:fs').writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());
await w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.httpServer.address().port}/fare-check`)});
await w.webContents.executeJavaScript(\`document.querySelector('.routing-fares > summary').click();\`);
const fareCheck=await w.webContents.executeJavaScript(\`document.querySelectorAll('.routing-fare-group').length===2 && [...document.querySelectorAll('.routing-fare-options')].every(d=>!d.open) && document.querySelector('.routing-fare-note').textContent.includes('Transfers not calculated')\`);
if(!fareCheck)throw Error('Fare summary or collapsed details incorrect');
await new Promise(r=>setTimeout(r,500));
const styled=await w.webContents.executeJavaScript(\`getComputedStyle(document.querySelector('.routing-fare-price')).display==='flex'\`);
if(!styled)throw Error('Fare styles did not load');
require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'fare-summary.png'))},(await w.webContents.capturePage()).toPNG());
await w.webContents.executeJavaScript(\`document.querySelector('.routing-fare-options > summary').click();\`);
const paymentOpen=await w.webContents.executeJavaScript(\`document.querySelector('.routing-fare-options').open && document.querySelector('.routing-fare-options').textContent.includes('CharlieTicket')\`);
if(!paymentOpen)throw Error('Payment details cannot be expanded');
app.exit(0)}catch(error){console.error(error);app.exit(1)}});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), main], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 30000)
  try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }), 0) }
  finally { clearTimeout(timeout) }
  console.log(`Screenshots: ${screenshot}, ${path.join(directory, "fare-summary.png")}`)
  plan.sharedLegAlternatives.frequencies[0].status = 'incomplete'
  assert.match(renderToStaticMarkup(createElement(RoutingItinerary, { plan })), /At least 4 departures/)
  delete plan.legs[0].intermediateStops
  assert.doesNotMatch(renderToStaticMarkup(createElement(RoutingItinerary, { plan })), /Stops along the way/)
  console.log('Route and Reach retain ordered stop calls, expose stop disclosures, and use plain departure counts.')
} finally { await server.close(); await Promise.all(['cache', 'profile'].map(name => fs.rm(path.join(directory, name), { recursive: true, force: true }))) }
