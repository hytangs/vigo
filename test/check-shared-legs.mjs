import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import JSZip from 'jszip'
import { execFileSync } from 'node:child_process'
import { buildNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-shared-legs-'))
const stops = ['O', 'A', 'B', 'D']
const coordinate = id => [-77.05 + stops.indexOf(id) * .01, 38.9 + stops.indexOf(id) * .005]
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
table('stops', 'stop_id,stop_name,stop_lat,stop_lon', stops.map(id => `${id},${id},${coordinate(id)[1]},${coordinate(id)[0]}`))
table('routes', 'route_id,route_short_name,route_type', trips.filter(t=>!t[3]).map(([id]) => `${id},${['E','M'].includes(id) ? 'Branch' : id},3`))
table('trips', 'route_id,service_id,trip_id,shape_id', trips.map(([id,,,route]) => `${route ?? id},${id === 'inactive' ? 'OFF' : 'ON'},${id},${id}`))
table('calendar_dates', 'service_id,date,exception_type', ['ON,20260715,1','OFF,20260716,1'])
table('stop_times', 'trip_id,stop_id,stop_sequence,arrival_time,departure_time,pickup_type,drop_off_type', trips.flatMap(([id, calls, times]) => calls.map((stop,i) =>
  `${id},${stop},${i+1},${clock(times[i])},${clock(times[i])},${id === 'no_board' && i === 0 ? 1 : 0},${id === 'no_alight' && stop === 'B' ? 1 : 0}`)))
table('shapes', 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', trips.flatMap(([id,calls]) => {
  const coords = calls.map(coordinate)
  if (id === 'detour') coords.splice(1,0,[-77.045,38.91])
  return coords.map(([lon,lat],i) => `${id},${lat},${lon},${i+1}`)
}))
const zipPath = path.join(root,'fixture.zip'), storePath = path.join(root,'routing.sqlite')
try {
  const { osmPath } = await writeCliFixtureInputs(root)
  await fs.writeFile(zipPath, await zip.generateAsync({type:'nodebuffer'}))
  await buildNationalGtfsStore({zipPath,outputPath:storePath})
  const snapshot = changes => ({ sourceUrl:'https://example.test/trip-updates.pb',feedTimestamp:Math.floor(Date.now()/1000),
    tripUpdates:[{tripId:'E',startDate:'20260715',delaySeconds:0,...changes}] })
  const publicRequest={origin:{stopId:'O'},destination:{stopId:'B'},time:'08:00',serviceDate:'2026-07-15',sharedLegs:true,requireTransitRide:true}
  if(process.argv.includes('--standalone')) {
    const city=path.join(root,'city')
    execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',zipPath,'--osm',osmPath,'--output',city],{stdio:'pipe'})
    const run=q=>JSON.parse(execFileSync(standaloneBinary,['route','--city',city,'--request','-'],{input:JSON.stringify(q),encoding:'utf8'}))
    const native=run(publicRequest)
    const node=JSON.parse(execFileSync(process.execPath,['public/vigo.mjs','route','--city',city,'--request','-'],{input:JSON.stringify(publicRequest),encoding:'utf8'}))
    assert.deepEqual(node.journey.sharedLegAlternatives.options,native.journey.sharedLegAlternatives.options,'Both production CLI transports preserve shared-leg options')
    assert.deepEqual(node.journey.sharedLegAlternatives.frequencies,native.journey.sharedLegAlternatives.frequencies)
    for (const request of [publicRequest,
      {...publicRequest,timePreference:'arrive_by',time:'08:13'},
      {...publicRequest,time:'00:00',serviceDate:'2026-07-16'}]) {
      const policy=run({...request,journeyPolicy:'alternatives-v1'})
      assert(!JSON.stringify(policy).includes('deferredSharedLegs'),'Internal deferred markers never escape')
      const plain=run({...request,journeyPolicy:'alternatives-v1',sharedLegs:false})
      const core=journey=>({...journey,sharedLegAlternatives:undefined})
      assert.deepEqual(core(policy.journey),core(plain.journey),'Shared service enrichment preserves the selected journey')
      assert.deepEqual(policy.alternatives?.map(core),plain.alternatives?.map(core),'Shared service enrichment preserves alternative order')
      const eager=run(request)
      if (policy.journey.arrivalTime===eager.journey.arrivalTime && policy.journey.departureTime===eager.journey.departureTime)
        assert.deepEqual(policy.journey.sharedLegAlternatives,eager.journey.sharedLegAlternatives,'Deferred enrichment retains full shared-service evidence')
    }
    const free=run({...publicRequest,time:'07:59',journeyPolicy:'alternatives-v1',includeGeometry:true,
      origin:{coordinate:[-77.04998,38.9001]},destination:{coordinate:[-77.03002,38.9101]}})
    const endpointWalks=free.journey.legs.filter(leg=>leg.endpointConnector)
    assert.equal(endpointWalks.length,2,'Both free endpoints have connector witnesses')
    assert(free.journey.sharedLegAlternatives.options.length>0,'Fixture exercises deferred shared journeys')
    for (const option of free.journey.sharedLegAlternatives.options) {
      const connectors=option.journey.legs.filter(leg=>leg.endpointConnector).map(leg=>leg.endpointConnector)
      assert.deepEqual(connectors,endpointWalks.map(leg=>leg.endpointConnector),'Deferred alternatives preserve their selected endpoint witnesses')
    }
    const nativeTransfer=run({...publicRequest,destination:{stopId:'D'}})
    assert.deepEqual(nativeTransfer.journey.sharedLegAlternatives.options.map(o=>o.journey.legs[o.legIndex].route.id.id),['E'])
    assert.deepEqual(run({...publicRequest,windowMinutes:5}).journey.sharedLegAlternatives.options,native.journey.sharedLegAlternatives.options,'Window pruning preserves the bundle')
    const nativeCanceled=run({...publicRequest,realtimeSnapshot:snapshot({scheduleRelationship:'CANCELED'})})
    assert.deepEqual(nativeCanceled.journey.sharedLegAlternatives.options.map(o=>o.journey.legs[o.legIndex].route.id.id),['M'])
    const nativeArrive=run({...publicRequest,timePreference:'arrive_by',time:'08:13'})
    assert(nativeArrive.journey.sharedLegAlternatives.options.every(o=>o.journey.arrivalTime<='08:13:00'))
  }
} finally { disposeAllNationalGtfsStores(); await fs.rm(root,{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
