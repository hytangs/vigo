import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { compileReachScenario } from '../src/server/reach.mjs'
import { nativeReachRangeRequest } from '../src/server/studio-reach-ranges.mjs'
const root=path.resolve(import.meta.dirname,'..')
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'vigo-planned-flex-'))
try {
 const {gtfsPath,osmPath}=await writeCliFixtureInputs(folder)
 const zip=await JSZip.loadAsync(fs.readFileSync(gtfsPath))
 zip.file('stops.txt','stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,38.900,-77.050\nB,Bravo,38.910,-77.030\nC,Flex pickup,38.910,-77.028\n')
 zip.file('trips.txt','route_id,service_id,trip_id,direction_id\nR1,WKD,T,0\nR1,WKD,SHORT,0\n')
 zip.file('stop_times.txt','trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:30:00,08:30:00,A,1\nT,08:40:00,08:40:00,B,2\nSHORT,08:41:00,08:41:00,B,1\nSHORT,08:42:00,08:42:00,C,2\n')
 zip.file('transfers.txt','from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,C,2,120\n')
 fs.writeFileSync(gtfsPath,await zip.generateAsync({type:'nodebuffer'}))
 const city=path.join(folder,'city')
 execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',gtfsPath,'--osm',osmPath,'--output',city],{cwd:root,stdio:'pipe'})
 const zone=(id,west,east)=>({id,name:id,geometry:{type:'Polygon',coordinates:[[[west,38.895],[east,38.895],[east,38.915],[west,38.915],[west,38.895]]]},startMinutes:480,endMinutes:600,averageSpeedKph:30,waitMinutes:2})
 const flexZones=[zone('West',-77.051,-77.045),zone('East',-77.035,-77.029)]
 const origin={coordinate:[-77.047,38.9015]},destination={coordinate:[-77.033,38.9085]}
 const base={serviceDate:'2026-07-15',timeMinutes:480,maxWalkKm:0.05,allowLongWalk:false,requireTransitRide:true,minimumTransferBufferMinutes:1,scenario:{services:[],flexZones}}
 const query=(kind,q)=>JSON.parse(execFileSync(standaloneBinary,[kind,'--city',city,'--request','-'],{input:JSON.stringify({...q,diagnostics:'trace'}),encoding:'utf8',maxBuffer:16*1024*1024}))
 const rides=r=>r.trace.legs.filter(l=>l.kind==='ride')
 const forward=query('route',{...base,origin,destination})
 assert.equal(forward.status,'ok',JSON.stringify(forward))
 assert.deepEqual(rides(forward).map(l=>l.tripId),['planned-flex:West','T','planned-flex:East'])
 assert.equal(forward.journey.boardings,3)
 assert(rides(forward).filter(l=>l.flexEstimate?.assumption==='planned_zone_distance_and_wait').length===2)
 const reverse=query('route',{...base,origin,destination,timeMinutes:540,timePreference:'arrive_by'})
 assert.deepEqual(rides(reverse).map(l=>l.tripId),['planned-flex:West','T','planned-flex:East'])
 assert(reverse.trace.departureMinutes>forward.trace.departureMinutes)
 assert.equal(query('route',{...base,origin,destination,maxTransfers:1}).status,'not_found')
 assert.equal(query('route',{...base,origin,destination,timeMinutes:650}).status,'not_found')
 const direct=query('route',{...base,origin,destination:{coordinate:[-77.046,38.902]},maxTransfers:0})
 assert.deepEqual(rides(direct).map(l=>l.tripId),['planned-flex:West'])
 // A short scheduled ride must not be required just to enter a zone when a
 // valid transfer walk reaches its pickup stop. The boarding cap proves the
 // walk is part of routing, not a hidden presentation-only deletion.
 const pickup={...base,origin:{stopId:'A'},destination:{coordinate:[-77.028,38.911]},
   scenario:{services:[],flexZones:[zone('Pickup',-77.0285,-77.0275)]},maxTransfers:1}
 for(const reverse of [false,true]) {
   const result=query('route',{...pickup,timeMinutes:reverse?540:480,timePreference:reverse?'arrive_by':'depart_at'})
   assert.equal(result.status,'ok',JSON.stringify(result))
   assert.deepEqual(rides(result).map(l=>l.tripId),['T','planned-flex:Pickup'])
   assert(result.trace.legs.some(l=>l.kind==='walk'&&l.fromStopId==='B'&&l.toStopId==='C'))
   assert.equal(rides(result).at(-1).from.name,'Flex pickup')
 }
 assert.deepEqual(query('route',{...pickup,horizonMinutes:60}).trace.legs,query('route',pickup).trace.legs,
   'Static zone clocks match the exact many-stop scan when opening hours cover the query horizon')
 const sampled=query('route',{...pickup,timeMinutes:495,windowMinutes:20,windowChoices:'supported'})
 assert(sampled.trace.plannedFlex.reusedSamples>0,'Reuse certified fixed-first Flex journeys before the same first vehicle')
 const exactChoices=[]
 for(let time=495;time<=515;time++) {
   const result=query('route',{...pickup,timeMinutes:time})
   if(result.status==='ok')exactChoices.push(result.trace)
 }
 assert.equal(sampled.trace.arrivalMinutes,Math.min(...exactChoices.map(p=>p.arrivalMinutes)),
   'Reusing catchable departures preserves the exhaustive minute-sample earliest arrival')
 const reverseWindow=query('route',{...base,origin,destination:{stopId:'B'},timeMinutes:540,timePreference:'arrive_by',windowMinutes:20})
 assert(reverseWindow.trace.plannedFlex.reusedSamples>0,'Reuse latest-departure witnesses that still meet earlier deadlines')
 const reverseExact=query('route',{...base,origin,destination:{stopId:'B'},timeMinutes:540,timePreference:'arrive_by'})
 assert.equal(reverseWindow.trace.departureMinutes,reverseExact.trace.departureMinutes)
 const pickupBounds=[-77.031,38.909,-77.027,38.913],pickupSize=32,px=23,py=15
 const pickupTarget={coordinate:[pickupBounds[0]+(px+.5)/pickupSize*(pickupBounds[2]-pickupBounds[0]),
   pickupBounds[3]-(py+.5)/pickupSize*(pickupBounds[3]-pickupBounds[1])]}
 const pickupReach=query('reach',{...pickup,destination:undefined,allowLongWalk:undefined,requireTransitRide:undefined,
   bounds:pickupBounds,rasterSize:pickupSize,cutoffsMinutes:[60],reachFormat:'surface'})
 const pickupRoute=query('route',{...pickup,destination:pickupTarget})
 assert.equal(pickupRoute.status,'ok')
 assert(Number.isFinite(pickupReach.trace.surface.values[py*pickupSize+px]),'Reach includes the transfer walk into Flex with two boardings')
 assert(Math.abs(pickupReach.trace.surface.values[py*pickupSize+px]-(pickupRoute.trace.arrivalMinutes-480))<0.02,
   'Reach and Route agree after walking into the planned zone')
 // A replaced line and an added stop use the same view as the Flex hops.
 const planned={...base,scenario:{flexZones,excludedRouteIds:['R1'],services:[{id:'line',name:'Planned connector',stops:[{stopId:'A'},{coordinate:[-77.031,38.9095],id:'new-stop',label:'New stop'}],startMinutes:510,endMinutes:520,headwayMinutes:10,averageSpeedKph:30,timeModel:'estimate-distance'}]}}
 assert.equal(query('route',{...planned,origin,destination}).status,'ok')
 const earlyScenario={...planned.scenario,flexZones:flexZones.map(z=>({...z,startMinutes:360,endMinutes:480})),services:planned.scenario.services.map(s=>({...s,startMinutes:390,endMinutes:400}))}
 const earlyReverse=query('route',{...base,scenario:earlyScenario,origin,destination,timeMinutes:420,timePreference:'arrive_by'})
 assert.equal(earlyReverse.status,'ok','Rebased early-arrival clocks retain planned line and zone hours')
 assert.equal(rides(earlyReverse).length,3)
 const bounds=[-77.05,38.9,-77.03,38.91],size=32,x=27,y=5
 const target={coordinate:[bounds[0]+(x+0.5)/size*(bounds[2]-bounds[0]),bounds[3]-(y+0.5)/size*(bounds[3]-bounds[1])]}
 for(const reverse of [false,true]) {
   const reach=query('reach',{...base,allowLongWalk:undefined,requireTransitRide:undefined,timeMinutes:reverse?540:480,timePreference:reverse?'arrive_by':'depart_at',...(reverse?{destination:origin}:{origin}),bounds,rasterSize:size,cutoffsMinutes:[60],reachFormat:'surface'})
   assert.equal(reach.status,'ok',JSON.stringify(reach).slice(0,1600))
   // Direct-zone reach must be positive in both directions, with hours obeyed.
   const near=query('route',{...base,origin:reverse?{coordinate:[-77.046,38.902]}:origin,destination:reverse?origin:{coordinate:[-77.046,38.902]},timeMinutes:reverse?540:480,timePreference:reverse?'arrive_by':'depart_at'})
   assert.equal(near.status,'ok')
   if(!reverse) {
     const route=query('route',{...base,origin,destination:target})
     const values=reach.trace.surface.values
     assert(Number.isFinite(values[y*size+x]),'Flex egress reaches raster cell')
     assert(Math.abs(values[y*size+x]-(route.trace.arrivalMinutes-480))<0.02,`Reach/Route disagree: ${values[y*size+x]} vs ${route.trace.arrivalMinutes-480}`)
   }
 }
 const westPixel={x:4,y:25}
 const westTarget={coordinate:[bounds[0]+(westPixel.x+0.5)/size*(bounds[2]-bounds[0]),bounds[3]-(westPixel.y+0.5)/size*(bounds[3]-bounds[1])]}
 const reverseReach=query('reach',{...base,allowLongWalk:undefined,requireTransitRide:undefined,destination,timeMinutes:540,timePreference:'arrive_by',bounds,rasterSize:size,cutoffsMinutes:[60],reachFormat:'surface'})
 const reversePoint=query('route',{...base,origin:westTarget,destination,timeMinutes:540,timePreference:'arrive_by'})
 assert.equal(reversePoint.status,'ok')
 const reverseMinutes=reverseReach.trace.surface.values[westPixel.y*size+westPixel.x]
 assert(Math.abs(reverseMinutes-(540-reversePoint.trace.departureMinutes))<0.02,`Reverse Reach/Route mismatch ${reverseMinutes}`)
 const directReach=query('reach',{...base,allowLongWalk:undefined,requireTransitRide:undefined,origin,maxTransfers:0,bounds,rasterSize:size,cutoffsMinutes:[5],reachFormat:'surface'})
 assert(directReach.trace.stops.some(s=>s.stopId==='A'),'Reach counts stops reached directly by Flex, even with no fixed ride')
 const limited=query('reach',{...base,allowLongWalk:undefined,requireTransitRide:undefined,origin,maxTransfers:1,bounds,rasterSize:size,cutoffsMinutes:[60],reachFormat:'surface'})
 assert.equal(limited.trace.surface.values[y*size+x],null,'Reach reserves both Flex boardings')
 const closed=query('reach',{...base,allowLongWalk:undefined,requireTransitRide:undefined,origin,timeMinutes:650,bounds,rasterSize:size,cutoffsMinutes:[60],reachFormat:'surface'})
 assert.equal(closed.trace.surface.values[y*size+x],null,'Closed zones do not expand Reach')
 const compiled=compileReachScenario({services:[],flexZones}).scenario
 assert.deepEqual(compiled.flexZones,flexZones)
 const native=nativeReachRangeRequest({stage:'scenario-range',origin,serviceDate:base.serviceDate,departMinutes:480,maxWalkKm:0.05,walkSpeedKph:4.8,cutoffMinutes:60,scenarioFlexZones:compiled.flexZones,surface:{width:32,height:32,bounds}})
 assert.deepEqual(native.scenario.flexZones,flexZones)
 console.log('Planned Flex: direct, fixed-service integration, added stop, reverse, hours, boarding budget, Reach parity, and Studio forwarding passed.')
} finally { if(!process.env.VIGO_KEEP_TEST_OUTPUT) fs.rmSync(folder,{recursive:true,force:true}); else console.log(folder) }
