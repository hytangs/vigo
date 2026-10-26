import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import JSZip from 'jszip'
import {writeCliFixtureInputs} from './helpers/cli-fixture-inputs.mjs'
import {standaloneBinary} from './helpers/standalone-runtime.mjs'
const root=path.resolve(import.meta.dirname,'..')
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vigo-linked-trips-'))
const children=[]
let checks=0
try {
 for(const variant of ['linked','block','different-terminal','zero','forbidden','missing','chain','split','overlap','no-boarding']) {
  const type=variant==='forbidden'?5:['missing','block'].includes(variant)?null:4
  const inputDir=path.join(dir,variant);fs.mkdirSync(inputDir)
  const input=await writeCliFixtureInputs(inputDir)
  const zip=await JSZip.loadAsync(fs.readFileSync(input.gtfsPath))
  zip.file('trips.txt','route_id,service_id,trip_id,direction_id,trip_headsign,block_id\nR1,WKD,T1,0,First destination,SAME\nR2,WKD,T2,1,Second destination,SAME\n')
  if(variant==='missing') zip.file('trips.txt',(await zip.file('trips.txt').async('string')).replaceAll(',SAME',','))
  if(type!==null) zip.file('transfers.txt',`from_trip_id,to_trip_id,transfer_type\nT1,T2,${type}\n`)
  if(variant==='different-terminal') {
   zip.file('stops.txt',(await zip.file('stops.txt').async('string'))+'Y,Other terminal,38.91,-77.01\n')
   zip.file('stop_times.txt',(await zip.file('stop_times.txt').async('string')).replace('08:15:00,08:15:00,X','08:15:00,08:15:00,Y'))
  }
  if(variant==='zero') zip.file('stop_times.txt',(await zip.file('stop_times.txt').async('string')).replaceAll('08:15:00','08:10:00'))
  if(variant==='overlap') zip.file('stop_times.txt',(await zip.file('stop_times.txt').async('string')).replaceAll('08:15:00','08:09:00'))
  if(variant==='no-boarding') zip.file('stop_times.txt','trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT1,08:00:00,08:00:00,A,1,0,0\nT1,08:10:00,08:10:00,X,2,1,1\nT2,08:15:00,08:15:00,X,1,1,1\nT2,08:30:00,08:30:00,B,2,0,0\n')
  if(['chain','split'].includes(variant)) {
   zip.file('stops.txt',(await zip.file('stops.txt').async('string'))+'C,Charlie,38.92,-77.02\n')
   zip.file('trips.txt',(await zip.file('trips.txt').async('string'))+'R2,WKD,T3,0,Third destination,SAME\n')
   const from=variant==='chain'?'B':'X', departure=variant==='chain'?'08:32:00':'08:15:00'
   zip.file('stop_times.txt',(await zip.file('stop_times.txt').async('string'))+`T3,${departure},${departure},${from},1\nT3,08:40:00,08:40:00,C,2\n`)
   zip.file('transfers.txt',(await zip.file('transfers.txt').async('string'))+`${variant==='chain'?'T2':'T1'},T3,4\n`)
  }
  fs.writeFileSync(input.gtfsPath,await zip.generateAsync({type:'nodebuffer'}))
  const city=path.join(inputDir,'city')
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${input.gtfsPath}`,`--osm=${input.osmPath}`,`--output=${city}`],{cwd:root,stdio:'pipe'})
  const child=spawn(standaloneBinary,['stream','--city',city],{env:{...process.env,VIGO_TIMETABLE_CACHE_BYTES:'0'}});children.push(child)
  let stderr='';child.stderr.on('data',c=>stderr+=c)
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]()
  const run=async q=>{child.stdin.write(JSON.stringify(q)+'\n');const line=await lines.next();assert(!line.done,stderr);const r=JSON.parse(line.value);assert.notEqual(r.status,'error',JSON.stringify(r));return r}
  const base={kind:'route',origin:{stopId:'A'},destination:{stopId:'B'},serviceDate:'2026-07-15',timeMinutes:480,maxWalkKm:.01,maxTransfers:0,requireTransitRide:true,includeGeometry:true,diagnostics:'trace'}
  // Rebuild each date independently: immutable adjacency must not retain a
  // previous day's service, nor change the result of a fresh-process query.
  if(['linked','block'].includes(variant)) {
   for(const serviceDate of ['2026-07-15','2026-07-16','2026-07-19','2026-07-15']) {
    const q={...base,serviceDate,diagnostics:undefined}
    const reused=await run(q)
    const fresh=JSON.parse(execFileSync(standaloneBinary,['stream','--city',city],{
     input:JSON.stringify(q)+'\n',encoding:'utf8',env:{...process.env,VIGO_TIMETABLE_CACHE_BYTES:'0'}
    }).trim())
    assert.deepEqual({status:reused.status,journey:reused.journey},{status:fresh.status,journey:fresh.journey})
    checks++
   }
  }
  for(const reverse of [false,true]) {
   const r=await run({...base,...(reverse?{timePreference:'arrive_by',timeMinutes:510}:{})})
   if((type!==4 && variant!=='block') || variant==='overlap') {assert.equal(r.status,'not_found',JSON.stringify(r));checks++;continue}
   assert.equal(r.status,'ok',JSON.stringify(r))
   assert.equal(r.journey.transfers,0);assert.equal(r.journey.boardings,1)
   const rides=r.journey.legs.filter(l=>l.type==='transit')
   assert.deepEqual(rides.map(l=>l.trip.id),['T1','T2'])
   assert.deepEqual(rides.map(l=>l.route.id.id),['R1','R2'])
   assert.deepEqual(rides.map(l=>l.headsign),['First destination','Second destination'])
   assert.deepEqual(rides[1].continuation,{type:'stay_aboard',durationSeconds:variant==='zero'?0:300})
   assert.equal(r.journey.ridingSeconds,1800)
   assert.equal(r.journey.waitingSeconds,0)
   assert.equal(r.journey.arrivalTime,'08:30:00')
   if(variant==='different-terminal') {
    assert.equal(rides[0].to.stop.id,'X')
    assert.equal(rides[1].from.stop.id,'Y')
   }
   checks++
  }
  if((type===4 || variant==='block') && variant!=='overlap') {
   const r=await run({...base,kind:'matrix',includeJourneys:true,origins:[base.origin],destinations:[base.destination],origin:undefined,destination:undefined})
   assert.deepEqual(r.durationsSeconds,[[1800]])
   assert.equal(r.journeys[0][0].boardings,1)
   assert.equal(r.journeys[0][0].legs.filter(l=>l.type==='transit')[1].continuation.durationSeconds,variant==='zero'?0:300)
   const scalar=await run({...base,kind:'matrix',includeGeometry:false,origins:[base.origin],destinations:[base.destination],origin:undefined,destination:undefined})
   assert.deepEqual(scalar.durationsSeconds,[[1800]])
   if(variant==='linked') {
    const requestPath=path.join(inputDir,'request.json');fs.writeFileSync(requestPath,JSON.stringify(base))
    const cli=JSON.parse(execFileSync(process.execPath,['public/vigo.mjs','route',`--city=${city}`,`--request=${requestPath}`],{cwd:root,encoding:'utf8'}))
    assert.equal(cli.journey.boardings,1)
    assert.deepEqual(cli.journey.legs.filter(l=>l.type==='transit')[1].continuation,{type:'stay_aboard',durationSeconds:300})
    checks++
   }
   const choices=await run({...base,alternatives:5,maxTransfers:3})
   assert.equal(choices.journey.transfers,0)
   const now=Math.floor(Date.now()/1000)
   const delayed=await run({...base,routingDataMode:'realtime',realtimeSnapshot:{feedTimestamp:now,tripUpdates:[{tripId:'T2',delaySeconds:120}]}})
   assert.equal(delayed.journey.arrivalTime,'08:32:00')
   assert.equal(delayed.journey.legs.filter(l=>l.type==='transit')[1].continuation.durationSeconds,variant==='zero'?120:420)
   if(variant==='linked') {
    const replacement={feedTimestamp:now,tripUpdates:[{tripId:'T2',scheduleRelationship:'REPLACEMENT',stopTimeUpdates:[
     {stopId:'A',stopSequence:1,arrival:{time:Date.parse('2026-07-15T08:15:00-04:00')/1000},departure:{time:Date.parse('2026-07-15T08:15:00-04:00')/1000}},
     {stopId:'B',stopSequence:2,arrival:{time:Date.parse('2026-07-15T08:35:00-04:00')/1000},departure:{time:Date.parse('2026-07-15T08:35:00-04:00')/1000}}
    ]}]}
    const changed=await run({...base,routingDataMode:'realtime',realtimeSnapshot:replacement})
    assert.equal(changed.status,'ok')
    assert.equal(changed.journey.arrivalTime,'08:35:00')
    const oldBoarding=await run({...base,origin:{stopId:'X'},timeMinutes:495,routingDataMode:'realtime',realtimeSnapshot:replacement})
    assert.equal(oldBoarding.status,'not_found')
    const restored=await run(base)
    assert.equal(restored.journey.arrivalTime,'08:30:00')
    checks+=3
   }
   const canceled=await run({...base,routingDataMode:'realtime',realtimeSnapshot:{feedTimestamp:now,tripUpdates:[{tripId:'T2',scheduleRelationship:'CANCELED'}]}})
   assert.equal(canceled.status,'not_found')
   const reach=await run({kind:'reach',origin:base.origin,serviceDate:base.serviceDate,timeMinutes:480,maxWalkKm:.01,maxTransfers:0,cutoffsMinutes:[45],extentRadiusKm:3,rasterSize:16,reachFormat:'surface',diagnostics:'trace'})
   assert.equal(reach.status,'ok')
   assert.equal(reach.trace.stops.find(s=>s.stopId==='B').durationMinutes,30)
   checks+=6
   const partial=await run({...base,origin:{stopId:variant==='different-terminal'?'Y':'X'},timeMinutes:495})
   if(variant==='no-boarding' || variant==='zero') assert.equal(partial.status,'not_found')
   else {
    assert.equal(partial.journey.legs.filter(l=>l.type==='transit').length,1)
    assert.equal(partial.journey.legs.find(l=>l.type==='transit').continuation,undefined)
   }
   if(['chain','split'].includes(variant)) {
    const through=await run({...base,destination:{stopId:'C'}})
    assert.equal(through.journey.transfers,0)
    assert.deepEqual(through.journey.legs.filter(l=>l.type==='transit').map(l=>l.trip.id),variant==='chain'?['T1','T2','T3']:['T1','T3'])
    if(variant==='chain') {
     const shortened=await run({...base,scenario:{id:'shortened',excludedTripIds:['T3']}})
     assert.equal(shortened.journey.transfers,0)
     assert.equal(shortened.journey.arrivalTime,'08:30:00')
     for(const arrive of [false,true]) {
      const reach=await run({kind:'reach',...(arrive?{destination:{stopId:'B'}}:{origin:base.origin}),serviceDate:base.serviceDate,timeMinutes:arrive?510:480,timePreference:arrive?'arrive_by':'depart_at',maxWalkKm:.01,maxTransfers:0,cutoffsMinutes:[45],extentRadiusKm:3,rasterSize:16,reachFormat:'surface',diagnostics:'trace',scenario:{id:'shortened',excludedTripIds:['T3']}})
      assert.equal(reach.status,'ok')
      assert.equal(reach.trace.stops.find(s=>s.stopId===(arrive?'A':'B')).durationMinutes,30)
     }
     const cut=await run({...base,destination:{stopId:'C'},scenario:{id:'cut',excludedTripIds:['T2']}})
     assert.equal(cut.status,'not_found')
     const remaining=await run({...base,origin:{stopId:'X'},destination:{stopId:'C'},timeMinutes:495,scenario:{id:'head-removed',excludedTripIds:['T1']}})
     assert.equal(remaining.journey.transfers,0)
     assert.deepEqual(remaining.journey.legs.filter(l=>l.type==='transit').map(l=>l.trip.id),['T2','T3'])
    }
    checks++
   }
   checks++
  }
 }
 console.log(JSON.stringify({status:'passed',checks}))
} finally {for(const child of children)child.kill();fs.rmSync(dir,{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 })}
