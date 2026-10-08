import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Map } from '../../src/app/mapRuntime'
import { initialLayers } from '../../src/domain'
import { useReachInspection } from '../../src/app/useReachInspection'
import { reachPointSample, reachPointRouteRequest, reachInspectionSources } from '../../src/app/reachInspection'
import { RouteSurface } from '../../src/components/studio/RouteSurface'
import { ReachPointInspector } from '../../src/components/ReachPointInspector'
import '../../src/index.css'
import '../../src/App.css'

const empty = { type: 'FeatureCollection', features: [] }
const rasterBytes = new Uint8Array(32)
const rasterView = new DataView(rasterBytes.buffer)
for (let i = 0; i < 16; i++) rasterView.setUint16(i * 2, i === 15 ? 65535 : i * 10, true)
const encoded = btoa(String.fromCharCode(...rasterBytes))
const origin = { coordinate: [-71.11, 42.35], label: 'Starting point', source: 'map' }
const result = { schemaVersion: 'vigo.result.reach.v1', request: { baselineIdentity: 'fixture', feedIds: ['bus', 'rail'], mode: 'transit',
  origin, departMinutes: 480, serviceDate: '2026-07-20', serviceDay: 'weekday', maxWalkKm: .35, maxTransfers: 0,
  walkSpeedKph: 4.65, cutoffsMinutes: [37.25], scenario: { id: 'baseline', name: 'Baseline', serviceCount: 0 } },
  surface: { raster: { width: 4, height: 4, bounds: [-71.12, 42.34, -71.08, 42.38], encoding: 'uint16-tenths-minutes-le-base64', scale: 10, nodata: 65535, baseline: encoded, scenario: encoded },
    contours: { baseline: empty, scenario: empty }, areas: { baseline: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { cutoffMinutes: 37.25 }, geometry: { type: 'Polygon', coordinates: [[[-71.118,42.342],[-71.084,42.35],[-71.082,42.372],[-71.108,42.378],[-71.118,42.342]]] } }] }, scenario: empty } },
  scenario: { id: 'baseline', name: 'Baseline', routes: empty }, summary: { maximumCutoffMinutes: 37.25 }, diagnostics: {} }
const preview = { routes: [], stops: [{ id: 'should-be-hidden', name: 'Hidden map stop', lat: 42.36, lon: -71.1, x: 0, y: 0, routes: [], tripCount: 1, transferScore: 1 }], stopPairs: [] }
const noop = () => {}
const requests = []
const originalAddControl = Map.prototype.addControl
Map.prototype.addControl = function(...args) { window.inspectionMap = this; return originalAddControl.apply(this, args) }

function planFor(body, kind = 'transit') {
  const a = body.origin.coordinate, b = body.destination.coordinate
  const at = f => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
  const base = { id: `journey-${b.join('-')}`, status: 'ready', travelMode: kind, timePreference: 'depart', maxWalkKm: .35,
    title: 'Journey', detail: '', departMinutes: 485, arriveMinutes: 505, durationMinutes: 20, waitMinutes: 5, walkMinutes: 4, rideMinutes: 16, transfers: 0,
    origin: body.origin, destination: body.destination,
    diagnostics: { serviceDay: 'weekday', serviceDate: '2026-07-20', walkingSpeedKph: 4.8, scheduleMode: 'exact', routingDataMode: 'scheduled',
      departurePresentation: { requestedDepartMinutes: 480 } },
    legs: [
      { type: 'walk', fromName: 'Starting point', toName: 'First Street', startMinutes: 485, endMinutes: 487, durationMinutes: 2, distanceKm: .16, walkSource: 'osm', coordinates: [a, at(.2)] },
      { type: 'ride', routeId: 'R', routeShortName: 'R', routeColor: '#da291c', fromName: 'First Street', toName: 'Second Street', startMinutes: 487, endMinutes: 503, durationMinutes: 16, distanceKm: 2, stopCount: 5, geometrySource: 'shape', tripId: 'T', coordinates: [at(.2), at(.8)] },
      { type: 'walk', fromName: 'Second Street', toName: body.destination.label, startMinutes: 503, endMinutes: 505, durationMinutes: 2, distanceKm: .16, walkSource: 'osm', coordinates: [at(.8), b] },
    ] }
  if (kind === 'walk') base.legs = [{ ...base.legs[0], coordinates: [a,b], toName: body.destination.label, endMinutes: 505, durationMinutes: 20, distanceKm: 1.6 }]
  if (kind === 'blocked') return { ...base, status: 'blocked', travelMode: 'transit', arriveMinutes: undefined, legs: [], detail: 'No route meets the walking and ride limits.' }
  return base
}
window.fetch = (input, options = {}) => {
  if (!String(input).endsWith('/national-route')) return Promise.resolve(Response.json({ error: 'Unused fixture request' }, { status: 404 }))
  return new Promise(resolve => requests.push({
    body: JSON.parse(options.body), signal: options.signal,
    respond(kind) {
      resolve(kind === 'error' ? Response.json({ error: 'Temporary route failure' }, { status: 503 })
        : Response.json({ choices: [planFor(JSON.parse(options.body), kind)] }))
    },
  }))
}
function Fixture() {
  const [analysis, setAnalysis] = useState(null), [comparison, setComparison] = useState(null)
  const [view, setView] = useState(new URL(location.href).searchParams.get('view') || 'analysis')
  const [showOrigin, setShowOrigin] = useState(false), [journey, setJourney] = useState(null)
  const [dark, setDark] = useState(false), [active, setActive] = useState(true)
  window.inspectionSetResult = setAnalysis; window.inspectionSetComparison = setComparison
  window.inspectionSetTheme = setDark; window.inspectionSetActive = setActive
  window.inspectionSetView = setView; window.inspectionSetOrigin = setShowOrigin; window.inspectionSetJourney = setJourney
  const analysisFocus = view === 'analysis'
  const inspection = useReachInspection({ projectId: 'fixture', feedId: '__project__', result: analysis, comparison, active: active && analysisFocus })
  window.inspection = inspection
  return <main className={`app-shell page-project appearance-${dark ? 'dark' : 'light'}`}>
    <header className="topbar"><strong>VIGO</strong><span>{analysisFocus ? 'Accessibility' : 'Route'}</span></header>
    <div className="shell-body"><aside className="app-sidebar"><nav aria-label="Workspace"><button aria-label="Route">↗</button><button aria-label="Accessibility">◎</button></nav></aside>
      <div className="app-frame"><div className="workbench project-workbench route-investigation-shell">
        <RouteSurface projectId="fixture" feed={{ name: 'Fixture' }} focusedPreview={preview} visiblePreview={preview}
          mapScope="network" networkLens="network" layers={initialLayers} appearance={dark ? 'dark' : 'light'} basemap="none"
          localBasemapAvailable={false} selectedRouteId="" selectedStopId="" realtimeSnapshot={null}
          vehicleMode="schedule" scheduleTimeMinutes={480} scheduleServiceDate="2026-07-20" routingEnabled={!analysisFocus}
          routingOrigin={showOrigin ? origin : null} routingWaypoints={[]} routingDestination={inspection.point ?? journey?.destination} routingPlan={inspection.plan ?? journey}
          routingFocus={!analysisFocus} agencyFocus={false} analysisFocus={analysisFocus} reachResult={analysis} reachComparison={comparison} serviceDecomposition={null}
          scenarioView="baseline" scenarioRenderMode="area" scenarioCutoffMinutes={37.25} scenarioSketchStops={[]} scenarioSketchGeometry={[]}
          scenarioPointPicking={false} cityPreviewLoading={false} routingActivity={{ kind: 'idle', title: '', detail: '', status: 'idle' }}
          onInspectReachPoint={inspection.inspect} analysisInspector={<ReachPointInspector inspection={inspection} />}
          onMapScopeChange={noop} onVehicleModeChange={noop} onScheduleTimeChange={noop} onScheduleServiceDateChange={noop}
          onSelectRoute={noop} onSelectStop={() => { throw Error('Hidden stops must not intercept destination selection') }} />
      </div></div>
    </div>
  </main>
}
flushSync(() => createRoot(document.getElementById('root')).render(<Fixture />))
const assert = (value, message) => { if (!value) throw Error(message) }
const until = async read => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await read()) return; await new Promise(r => setTimeout(r, 20)) }; throw Error('Inspection fixture timed out: '+read.toString()) }
const click = coordinate => {
  const map = window.inspectionMap
  flushSync(() => map.fire('click', { lngLat: { lng: coordinate[0], lat: coordinate[1] }, point: map.project(coordinate), originalEvent: new MouseEvent('click') }))
}
window.checkQuietMaps = async () => {
  await until(()=>window.inspectionMap?.loaded())
  const map=window.inspectionMap
  const backgroundSources=['vigo-routes','vigo-segments','vigo-stops','vigo-access','vigo-service-vehicles']
  const checks=[]
  const check=async label=>{
    await until(async()=> (await Promise.all(backgroundSources.map(async id=>(await map.getSource(id).getData()).features.length))).every(n=>n===0))
    const layers=map.getStyle().layers.filter(layer=>backgroundSources.includes(layer.source))
    assert(layers.every(layer=>layer.layout?.visibility==='none'),label+': a background transit layer is visible')
    assert(!document.querySelector('.map-live-card'),label+': stale network stop details are visible')
    checks.push(label)
  }
  await check('initial load')
  for(const view of ['routing','analysis']) for(const dark of [false,true]) {
    flushSync(()=>{window.inspectionSetView(view);window.inspectionSetTheme(dark);window.inspectionSetResult(null);window.inspectionSetOrigin(false);window.inspectionSetJourney(null)})
    await check(view+' empty '+(dark?'dark':'light'))
    flushSync(()=>window.inspectionSetOrigin(true))
    await until(async()=> (await map.getSource('vigo-routing-pins').getData()).features.length===1)
    await check(view+' origin '+(dark?'dark':'light'))
    flushSync(()=>window.inspectionSetJourney(planFor({origin,destination:{coordinate:[-71.092,42.363],label:'Destination',source:'map'}})))
    await until(async()=> (await map.getSource('vigo-routing').getData()).features.filter(feature=>feature.geometry.type==='LineString').length===3)
    assert(map.getLayoutProperty('vigo-routing-ride','visibility')==='visible','Hiding the network also hid the requested journey')
    await check(view+' journey '+(dark?'dark':'light'))
  }
  flushSync(()=>{window.inspectionSetView('analysis');window.inspectionSetResult(result);window.inspectionSetOrigin(true);window.inspectionSetJourney(null)})
  await until(async()=> (await map.getSource('vigo-scenario-area').getData()).features.length>0)
  assert(map.getLayoutProperty('vigo-scenario-area','visibility')==='visible','Reachable area is hidden')
  await check('reachable area')
  return checks
}
window.checkReachInspection = async () => {
  flushSync(()=>{window.inspectionSetView('analysis');window.inspectionSetResult(result);window.inspectionSetOrigin(true)})
  // Every raster cell and the edge cases have an independently computed value.
  for (let y=0;y<4;y++) for(let x=0;x<4;x++) {
    const sample=reachPointSample(result,[-71.12+(x+.5)/4*.04,42.38-(y+.5)/4*.04],'baseline')
    assert(y*4+x===15 ? sample.status==='unsampled' : sample.minutes===y*4+x, 'Raster cell lookup shifted or decoded the wrong bytes')
  }
  assert(reachPointSample(result,[-71.13,42.36],'baseline').status==='outside','Outside bounds must be distinct from unreachable')
  assert(reachPointSample(result,[-71.08,42.34],'baseline').status==='unsampled','Southeast boundary must use final cell')
  const zero=reachPointSample(result,[-71.12,42.38],'baseline');assert(zero.minutes===0,'Zero-minute cell lost')
  const blockBytes=new Uint8Array(32);blockBytes.fill(255);new DataView(blockBytes.buffer).setUint16(30,93,true)
  const blockResult={...result,surface:{...result.surface,blockEstimates:{baseline:{...result.surface.raster,values:btoa(String.fromCharCode(...blockBytes))}}}}
  const blockSample=reachPointSample(blockResult,[-71.08,42.34],'baseline')
  assert(blockSample.status==='sampled'&&blockSample.minutes===9.3&&blockSample.estimatedBlock,'Missing street sample did not use the labelled block estimate')
  assert(!reachPointSample(blockResult,[-71.12,42.38],'baseline').estimatedBlock,'Block estimate replaced a routed street sample')
  await until(()=>window.inspectionMap?.loaded())
  const map=window.inspectionMap
  assert((await map.getSource('vigo-stops').getData()).features.length===0,'Accessibility retained a hidden stop collection')
  for(const id of ['vigo-overview-stops','vigo-network-stops','vigo-stops']) if(map.getLayer(id)) assert(map.getLayoutProperty(id,'visibility')==='none','Stop dots remain on accessibility map')
  const a=[-71.09654321,42.36123456],b=[-71.092,42.363]
  click(a);await until(()=>requests.length===1)
  assert(JSON.stringify(requests[0].body.destination.coordinate)===JSON.stringify(a),'Click precision was lost')
  assert(JSON.stringify(requests[0].body.feedIds)==='["bus","rail"]','Route did not retain timetable group')
  assert(requests[0].body.maxTransfers===0&&requests[0].body.maxWalkKm===.35&&requests[0].body.departMinutes===480,'Analysis limits or time changed')
  assert(requests[0].body.allowLongWalk===true&&requests[0].body.requireTransitRide===false,'Final-walk cap incorrectly excluded direct walking from the journey comparison')
  click(b);await until(()=>requests.length===2)
  assert(requests[0].signal.aborted,'Superseded query was not cancelled')
  requests[1].respond('transit');await until(()=>window.inspection.plan?.status==='ready')
  requests[0].respond('transit');await new Promise(r=>setTimeout(r,40))
  assert(window.inspection.plan.destination.coordinate[0]===b[0],'Stale response overwrote new destination')
  assert(document.querySelector('.reach-point-time strong').textContent==='25 min','Elapsed time excluded the initial wait')
  assert(document.querySelector('.reach-point-note').textContent.includes('4.8'),'Different route walking speed was hidden')
  await until(async()=> (await map.getSource('vigo-routing').getData()).features.length>0)
  document.querySelector('.reach-point-journey').open=true
  assert(document.querySelectorAll('.journey-leg').length===3,'Full walking and transit itinerary is missing')
  const branch={...result,request:{...result.request,feedIds:undefined}}
  flushSync(()=>window.inspectionSetComparison([{feedId:'first',feedName:'First timetable',result:branch},{feedId:'second',feedName:'Second timetable',result:branch}]))
  assert(!document.querySelector('.reach-point-inspector'),'Old destination survived a changed analysis')
  click(a);await until(()=>requests.length===3);assert(requests[2].body.feedId==='first','First comparator feed not selected')
  const select=document.querySelector('.reach-point-inspector select');select.value='second';flushSync(()=>select.dispatchEvent(new Event('change',{bubbles:true})))
  await until(()=>requests.length===4);assert(requests[3].body.feedId==='second'&&requests[2].signal.aborted,'Feed switch reused previous journey')
  requests[3].respond('blocked');await until(()=>document.querySelector('.reach-point-time strong')?.textContent==='No journey found')
  flushSync(()=>window.inspection.retry());await until(()=>requests.length===5);requests[4].respond('error')
  await until(()=>document.querySelector('.reach-point-time strong')?.textContent==='Could not check journey')
  flushSync(()=>document.querySelector('.reach-point-inspector .button').click());await until(()=>requests.length===6);requests[5].respond('walk')
  await until(()=>window.inspection.plan?.travelMode==='walk')
  assert(window.inspection.plan.status==='ready','Walking journey rejected')
  assert(document.querySelector('.reach-point-scroll').textContent.includes('exceeds the map’s 0.35 km final-walk limit'),'Longer direct walk was presented as matching the map walking limit')
  flushSync(()=>window.inspection.close());assert(!document.querySelector('.reach-point-inspector'),'Close left inspector open')
  map.getCanvas().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
  await until(()=>requests.length===7);requests[6].respond('transit');await until(()=>window.inspection.plan?.status==='ready')
  const changed={...result,request:{...result.request,scenario:{id:'edit',name:'Proposed service',serviceCount:1}}}
  const changedRequest=reachPointRouteRequest(reachInspectionSources(changed,null)[0],{coordinate:a,label:'A',source:'map'},'__project__')
  assert(!('scenario' in changedRequest)&&!('walkSpeedKph' in changedRequest),'Unsupported scenario or walking speed silently sent to baseline router')
  flushSync(()=>{window.inspectionSetComparison(null);window.inspectionSetResult(changed)})
  click(a);await until(()=>requests.length===8);requests[7].respond('transit');await until(()=>window.inspection.plan?.status==='ready')
  assert(document.querySelector('.reach-point-scroll').textContent.includes('journey below uses scheduled service'),'Scenario route presented as a planned-service journey')
  flushSync(()=>window.inspectionSetResult(blockResult))
  click([-71.08,42.34]);await until(()=>requests.length===9);requests[8].respond('transit');await until(()=>window.inspection.plan?.status==='ready')
  assert(document.querySelector('.reach-point-estimates').textContent.includes('9.3 min · block estimate'),'Displayed block value was presented as a routed street sample')
  assert(document.querySelector('.reach-point-scroll').textContent.includes('checks your selected point separately'),'Block shading was presented as verified interior access')
  return { rasterCells:16, preciseClick:true, exactRequest:true, routeGeometry:true, staleCancellation:true, comparisonFeeds:true, walking:true, blockedAndRetry:true, keyboard:true, stopsRemoved:true }
}
window.checkInspectionLayout = async dark => {
  flushSync(()=>window.inspectionSetTheme(dark));document.documentElement.dataset.appearance=dark?'dark':'light'
  window.inspectionMap.resize();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
  const panel=document.querySelector('.reach-point-inspector'),scroll=document.querySelector('.reach-point-scroll')
  document.querySelector('.reach-point-journey').open=true
  const rect=panel.getBoundingClientRect();assert(rect.right<=innerWidth+1&&rect.bottom<=innerHeight&&panel.scrollWidth<=panel.clientWidth+1,'Destination inspector overflows viewport')
  const zoom=document.querySelector('.maplibregl-ctrl-zoom-in'),zr=zoom.getBoundingClientRect(),hit=document.elementFromPoint(zr.x+zr.width/2,zr.y+zr.height/2)
  assert(zoom===hit||zoom.contains(hit),'Destination inspector blocks zoom')
  scroll.scrollTop=scroll.scrollHeight;assert(scroll.scrollTop>0||scroll.scrollHeight<=scroll.clientHeight+1,'Itinerary cannot scroll')
  scroll.scrollTop=0
  return {width:innerWidth,dark,scrollable:scroll.scrollHeight>scroll.clientHeight}
}
