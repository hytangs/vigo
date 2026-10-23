import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import JSZip from 'jszip'
import { execFileSync } from 'node:child_process'
import { buildNationalGtfsStore, disposeAllNationalGtfsStores, routeNationalGtfsStore, routeNationalGtfsDepartureWindow, addNationalGtfsFares } from '../src/server/national-gtfs-store.mjs'
import { publicResult } from '../src/cli/presentation.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { compileRouteScenario } from '../src/server/reach.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-shared-legs-'))
const stops = ['O', 'A', 'B', 'D']
const coordinate = id => [-77 + stops.indexOf(id) * .02, 38]
const point = id => ({ stopId: id, label: id, coordinate: coordinate(id), source: 'stop' })
const clock = minutes => {
  const seconds = Math.round((480 + minutes) * 60)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n=>String(n).padStart(2,'0')).join(':')
}
const trips = [
  ['F', ['O', 'A', 'B'], [0, 5, 10]],
  ['E', ['O', 'A', 'B'], [2, 7, 12]],
  ['M', ['O', 'A', 'B'], [4, 9, 14]],
  ['short', ['O', 'A'], [2, 7]],
  ['express', ['O', 'B'], [3, 11]],
  ['reverse', ['B', 'A', 'O'], [0, 5, 10]],
  ['detour', ['O', 'A', 'B'], [3, 8, 13]],
  ['no_board', ['O', 'A', 'B'], [1, 6, 11]],
  ['no_alight', ['O', 'A', 'B'], [1, 6, 11]],
  ['inactive', ['O', 'A', 'B'], [1, 6, 11]],
  ['onward', ['B', 'D'], [13, 20]],
  ['F-repeat', ['O', 'A', 'B'], [10, 15, 20], 'F'],
  ['F-simultaneous', ['O', 'A', 'B'], [10, 15, 20], 'F'],
  ['F-boundary', ['O', 'A', 'B'], [30, 35, 40], 'F'],
  ['fractional', ['O', 'A', 'B'], [31+1/6,36+1/6,41+1/6]],
  ['night', ['O', 'A', 'B'], [961,966,971]],
]
const zip = new JSZip()
const table = (name, header, rows) => zip.file(name + '.txt', header + '\n' + rows.join('\n') + '\n')
table('agency', 'agency_name,agency_url,agency_timezone', ['Shared Services,https://example.test,America/New_York'])
table('stops', 'stop_id,stop_name,stop_lat,stop_lon', stops.map(id => `${id},${id},38,${coordinate(id)[0]}`))
table('routes', 'route_id,route_short_name,route_type', trips.filter(t=>!t[3]).map(([id]) => `${id},${['E','M'].includes(id) ? 'Branch' : id},3`))
table('trips', 'route_id,service_id,trip_id,shape_id', trips.map(([id,,,route]) => `${route ?? id},${id === 'inactive' ? 'OFF' : 'ON'},${id},${id}`))
table('calendar_dates', 'service_id,date,exception_type', ['ON,20260715,1','OFF,20260716,1'])
table('stop_times', 'trip_id,stop_id,stop_sequence,arrival_time,departure_time,pickup_type,drop_off_type', trips.flatMap(([id, calls, times]) => calls.map((stop,i) =>
  `${id},${stop},${i+1},${clock(times[i])},${clock(times[i])},${id === 'no_board' && i === 0 ? 1 : 0},${id === 'no_alight' && stop === 'B' ? 1 : 0}`)))
table('shapes', 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', trips.flatMap(([id,calls]) => {
  const coords = calls.map(coordinate)
  if (id === 'detour') coords.splice(1,0,[-76.99,38.01])
  return coords.map(([lon,lat],i) => `${id},${lat},${lon},${i+1}`)
}))
const zipPath = path.join(root,'fixture.zip'), storePath = path.join(root,'routing.sqlite')
const query = { origin: point('O'), destination: point('B'), departMinutes: 480, serviceDate:'2026-07-15',
  serviceDay:'weekday', routingPreference:'fastest', maxWalkKm:.2, requireTransitRide:true }
const routes = plan => plan.sharedLegAlternatives.options.map(({legIndex,plan}) => plan.legs[legIndex].routeId).sort()
try {
  const { osmPath } = await writeCliFixtureInputs(root)
  await fs.writeFile(zipPath, await zip.generateAsync({type:'nodebuffer'}))
  await buildNationalGtfsStore({zipPath,outputPath:storePath})
  const baseline = routeNationalGtfsStore(storePath,query)
  const plan = routeNationalGtfsStore(storePath,{...query,sharedLegs:true})
  assert.equal(plan.status,'ready')
  assert.deepEqual(plan.legs,baseline.legs,'Enrichment never changes the recommended journey')
  assert.deepEqual(routes(plan),['E','M'],'Different and duplicate route names both preserve their route IDs')
  assert.equal(plan.sharedLegAlternatives.frequency,'active_departures')
  const frequency = p => p.sharedLegAlternatives.frequencies[0]
  assert.deepEqual(frequency(plan).departureSeconds,[28800,28920,29040,29400])
  assert.equal(frequency(plan).departureCount,5)
  assert.equal(frequency(plan).departuresPerHour,10)
  assert.equal(frequency(plan).meanHeadwaySeconds,200)
  assert.equal(frequency(plan).uniqueDepartureCount,4,'Simultaneous vehicles do not shorten the observed gaps')
  assert.equal(frequency(plan).minHeadwaySeconds,120)
  assert.equal(frequency(plan).maxHeadwaySeconds,360)
  assert.equal(frequency(routeNationalGtfsStore(storePath,{...query,sharedLegs:true,excludedTripIds:['F-repeat']})).departureCount,4)
  const holiday = routeNationalGtfsStore(storePath,{...query,serviceDate:'2026-07-16',sharedLegs:true})
  assert.equal(frequency(holiday).departureCount,1,'Calendar exceptions control the active departure population')
  assert.equal(frequency(holiday).meanHeadwaySeconds,null)
  const fractional=routeNationalGtfsStore(storePath,{...query,departMinutes:511,sharedLegs:true})
  assert.deepEqual(frequency(fractional).departureSeconds,[30670],'Use original seconds rather than rounded display minutes')
  assert.equal(frequency(fractional).windowStartSeconds,30670)
  const overnight=routeNationalGtfsStore(storePath,{...query,serviceDate:'2026-07-16',departMinutes:0,sharedLegs:true})
  assert.deepEqual(frequency(overnight).departureSeconds,[60],'Previous-day service instances use the query clock date')
  for(const option of plan.sharedLegAlternatives.options) {
    const ride=option.plan.legs[option.legIndex]
    assert.deepEqual(ride.stopIds,['O','A','B'])
    assert.equal(option.plan.arriveMinutes,ride.routeId==='E'?492:494)
    assert.equal(option.plan.recommended,false)
    assert.equal(option.plan.sharedLegAlternatives,undefined,'Alternatives do not recursively enumerate')
  }
  const transfer = routeNationalGtfsStore(storePath,{...query,destination:point('D'),sharedLegs:true})
  assert.deepEqual(routes(transfer),['E'],'M cannot catch the onward service; exclude it')
  assert.deepEqual(frequency(transfer).departureSeconds,frequency(plan).departureSeconds,'Segment frequency is independent of the onward connection')
  const buffered = routeNationalGtfsStore(storePath,{...query,destination:point('D'),minimumTransferBufferMinutes:2,sharedLegs:true})
  assert.deepEqual(routes(buffered),[],'Replacement must retain the requested interchange buffer')
  const short = routeNationalGtfsStore(storePath,{...query,destination:point('A'),sharedLegs:true})
  assert(routes(short).includes('short'),'A short-turn branch serves only its actual shared segment')
  assert.throws(()=>routeNationalGtfsStore(storePath,{...query,sharedLegs:'true'}),/boolean/)
  assert.deepEqual(routes(routeNationalGtfsStore(storePath,{...query,sharedLegs:true,excludedRouteIds:['E']})),['M'])
  assert.deepEqual(routes(routeNationalGtfsStore(storePath,{...query,sharedLegs:true,excludedTripIds:['M']})),['E'])
  const snapshot = changes => ({ sourceUrl:'https://example.test/trip-updates.pb',feedTimestamp:Math.floor(Date.now()/1000),
    tripUpdates:[{tripId:'E',startDate:'20260715',delaySeconds:0,...changes}] })
  const canceled=routeNationalGtfsStore(storePath,{...query,sharedLegs:true,realtimeSnapshot:snapshot({scheduleRelationship:'CANCELED'})})
  assert.deepEqual(routes(canceled),['M'],'Canceled services cannot reappear in the bundle')
  assert.deepEqual(frequency(canceled).departureSeconds,[28800,29040,29400])
  const delayed=routeNationalGtfsStore(storePath,{...query,destination:point('D'),sharedLegs:true,realtimeSnapshot:snapshot({delaySeconds:180})})
  assert.deepEqual(routes(delayed),[],'Live delay makes the shared service miss its onward connection')
  assert.deepEqual(frequency(delayed).departureSeconds,[28800,29040,29100,29400],'Live delays move the actual departures before gaps are calculated')
  const window=routeNationalGtfsDepartureWindow(storePath,{...query,sharedLegs:true,departureWindowMinutes:5,departureWindowDirection:'forward'})
  assert.deepEqual(routes(window.plan),['E','M'],'Choice pruning retains shared services on the recommendation')
  const arrive=routeNationalGtfsStore(storePath,{...query,sharedLegs:true,timePreference:'arrive',arriveMinutes:493})
  assert(arrive.sharedLegAlternatives.options.every(o=>o.plan.arriveMinutes<=493),'Every arrive-by substitution meets the deadline')
  const scenarioPlan=compileRouteScenario({id:'planned',name:'Planned branches',excludedRouteIds:['M'],services:[{
    id:'P',name:'Green P',operation:'add',headwayMinutes:30,startMinutes:482,endMinutes:510,
    averageSpeedKph:20,bidirectional:false,stops:['O','A','B'].map(id=>({...point(id),id})),
  }]})
  const planned=routeNationalGtfsStore(storePath,{...query,sharedLegs:true,scenarioPlan})
  assert(!routes(planned).includes('M'),'Scenario cuts must not return as shared services')
  assert(planned.sharedLegAlternatives.options.some(o=>o.plan.legs[o.legIndex].scenarioService?.name==='Green P'),'Planned routes retain their names and proven geometry in the bundle')
  const samples=[],baselineSamples=[]
  for(let i=0;i<50;i++){
    let t=performance.now();routeNationalGtfsStore(storePath,query);baselineSamples.push(performance.now()-t)
    t=performance.now();routeNationalGtfsStore(storePath,{...query,sharedLegs:true});samples.push(performance.now()-t)
  }
  const sorted=samples.sort((a,b)=>a-b)
  assert(sorted[47]<100,`Small-fixture shared-leg p95 exceeded 100 ms: ${sorted[47]}`)
  const publicRequest={origin:{stopId:'O'},destination:{stopId:'B'},time:'08:00',serviceDate:'2026-07-15',sharedLegs:true,requireTransitRide:true}
  const projected=publicResult(addNationalGtfsFares(storePath,plan),publicRequest)
  assert.deepEqual(projected.journey.sharedLegAlternatives.options.map(o=>o.journey.legs[o.legIndex].route.id.id).sort(),['E','M'])
  if(process.argv.includes('--standalone')) {
    const city=path.join(root,'city')
    execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',zipPath,'--osm',osmPath,'--output',city],{stdio:'pipe'})
    const run=q=>JSON.parse(execFileSync(standaloneBinary,['route','--city',city,'--request','-'],{input:JSON.stringify(q),encoding:'utf8'}))
    const native=run(publicRequest)
    assert.deepEqual(native.journey.sharedLegAlternatives.options,projected.journey.sharedLegAlternatives.options,'Node and standalone publish the same full timed alternatives')
    assert.deepEqual(native.journey.sharedLegAlternatives.frequencies,projected.journey.sharedLegAlternatives.frequencies)
    const node=JSON.parse(execFileSync(process.execPath,['public/vigo.mjs','route','--city',city,'--request','-'],{input:JSON.stringify(publicRequest),encoding:'utf8'}))
    assert.deepEqual(node.journey.sharedLegAlternatives.options,native.journey.sharedLegAlternatives.options,'Both production CLI transports preserve shared-leg options')
    assert.deepEqual(node.journey.sharedLegAlternatives.frequencies,native.journey.sharedLegAlternatives.frequencies)
    const nativeTransfer=run({...publicRequest,destination:{stopId:'D'}})
    assert.deepEqual(nativeTransfer.journey.sharedLegAlternatives.options.map(o=>o.journey.legs[o.legIndex].route.id.id),['E'])
    assert.deepEqual(run({...publicRequest,windowMinutes:5}).journey.sharedLegAlternatives.options,native.journey.sharedLegAlternatives.options,'Window pruning preserves the bundle')
    const nativeCanceled=run({...publicRequest,realtimeSnapshot:snapshot({scheduleRelationship:'CANCELED'})})
    assert.deepEqual(nativeCanceled.journey.sharedLegAlternatives.options.map(o=>o.journey.legs[o.legIndex].route.id.id),['M'])
    const nativeArrive=run({...publicRequest,timePreference:'arrive_by',time:'08:13'})
    assert.deepEqual(nativeArrive.journey.sharedLegAlternatives.frequencies,arrive.sharedLegAlternatives.frequencies,'Arrive-by frequency windows agree across runtimes')
    assert.deepEqual(run({...publicRequest,time:'08:31'}).journey.sharedLegAlternatives.frequencies,fractional.sharedLegAlternatives.frequencies)
    assert.deepEqual(run({...publicRequest,time:'00:00',serviceDate:'2026-07-16'}).journey.sharedLegAlternatives.frequencies,overnight.sharedLegAlternatives.frequencies)
    assert(nativeArrive.journey.sharedLegAlternatives.options.every(o=>o.journey.arrivalTime<='08:13:00'))
  }
  console.log(JSON.stringify({passed:true,alternatives:routes(plan),transfer:routes(transfer),fixtureWarmBaselineP95Ms:baselineSamples.sort((a,b)=>a-b)[47],fixtureWarmSharedP95Ms:sorted[47],checks:'route IDs, duplicate names, short turns, stopping pattern, direction, paths, permissions, active service, realtime, scenarios, windows, transfers, buffers, public projection'}))
} finally { disposeAllNationalGtfsStores(); await fs.rm(root,{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
