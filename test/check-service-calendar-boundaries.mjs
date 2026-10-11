import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-calendar-'))
const children = []
try {
  const inputs = await writeCliFixtureInputs(dir)
  const zip = await JSZip.loadAsync(fs.readFileSync(inputs.gtfsPath))
  zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nf,Fixture,https://example.test,America/New_York\n')
  zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,f,R,3\n')
  zip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\nSA,0,0,0,0,0,1,0,20260101,20261231\nSU,0,0,0,0,0,0,1,20260101,20261231\n')
  zip.file('calendar_dates.txt', 'service_id,date,exception_type\nWK,20260703,2\nSU,20260703,1\n')
  const trips = [['weekday','WK','10:00:00','10:20:00'],['late','WK','23:55:00','24:10:00'],['after','WK','25:00:00','25:20:00'],['saturday','SA','10:10:00','10:30:00'],['sunday','SU','10:20:00','10:40:00'],['fold','SU','01:30:00','01:50:00']]
  zip.file('trips.txt', 'route_id,service_id,trip_id\n' + trips.map(([id,day])=>`R,${day},${id}\n`).join(''))
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' + trips.map(([id,_,a,b])=>`${id},${a},${a},A,1\n${id},${b},${b},B,2\n`).join(''))
  fs.writeFileSync(inputs.gtfsPath, await zip.generateAsync({type:'nodebuffer'}))
  const city = path.join(dir,'city')
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${inputs.gtfsPath}`,`--osm=${inputs.osmPath}`,'--street-modes=walk',`--output=${city}`],{cwd:root,stdio:['ignore','ignore','pipe']})
  function resident(exe,args,env={}) {
    const child=spawn(exe,args,{cwd:root,env:{...process.env,...env}}); children.push(child)
    let errors=''; child.stderr.on('data',b=>{errors+=b})
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]()
    return async q=>{child.stdin.write(JSON.stringify(q)+'\n'); let timer
      const line=await Promise.race([lines.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(errors)),30000)})]).finally(()=>clearTimeout(timer))
      assert(!line.done,errors); return JSON.parse(line.value)
    }
  }
  const server=spawn(standaloneBinary,['serve','--city',city,'--port','0']);children.push(server)
  const port=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error(text)),10000)
    server.stderr.on('data',bytes=>{text+=bytes;const match=text.match(/listening on 127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(match[1])}})})
  const http=async q=>{const r=await fetch(`http://127.0.0.1:${port}/v1/route`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q)});return r.json()}
  const native=resident(standaloneBinary,['stream','--city',city])
  const node=resident(process.execPath,['public/vigo.mjs','stream','--city',city,'--service-date=2026-07-02'])
  const cases=[
    ['2026-07-02','09:50','depart_at','weekday','10:20:00'],
    ['2026-07-03','09:50','depart_at','sunday','10:40:00'],
    ['2026-07-04','09:50','depart_at','saturday','10:30:00'],
    ['2026-07-05','09:50','depart_at','sunday','10:40:00'],
    ['2026-07-10','23:50','depart_at','late','24:10:00'],
    ['2026-07-11','00:50','depart_at','after','01:20:00'],
    ['2026-07-11','00:15','arrive_by','late','24:10:00'],
    ['2026-11-01','01:20','depart_at','fold','01:50:00'],
  ]
  for(const [serviceDate,time,timePreference,trip,arrival] of cases) {
    const q={kind:'route',origin:{stopId:'A'},destination:{stopId:'B'},serviceDate,time,timePreference,horizonMinutes:90,maxWalkKm:0,requireTransitRide:true}
    const rust=await native(q)
    assert.equal(rust.status,'ok',JSON.stringify({q,rust}))
    assert.equal(rust.journey.legs.find(l=>l.type==='transit').trip.id,trip)
    assert.equal(rust.journey.arrivalTime,arrival)
    const js=await node(q)
    assert.equal(js.status,'ok',JSON.stringify({q,js}))
    assert.equal(js.journey.arrivalTime,arrival)
    assert.equal(js.journey.legs.find(l=>l.type==='transit').trip.id,trip)
    assert.equal(js.journey.clockDate,rust.journey.clockDate)
    assert.deepEqual((await http(q)).journey,rust.journey)
    const cli=JSON.parse(execFileSync(standaloneBinary,['route','--city',city,'--request','-'],{input:JSON.stringify(q),encoding:'utf8'}))
    assert.deepEqual(cli.journey,rust.journey)
  }
  // Revisit dates with different calendars, holiday exceptions, overnight tails
  // and DST. Each cache hit must match a runtime that reconstructs the schedule.
  const cached=resident(standaloneBinary,['stream','--city',city],{VIGO_TIMETABLE_CACHE_BYTES:String(128*1024*1024)})
  const uncached=resident(standaloneBinary,['stream','--city',city],{VIGO_TIMETABLE_CACHE_BYTES:'0'})
  const dates=cases.map(([serviceDate,time,timePreference])=>({kind:'route',origin:{stopId:'A'},destination:{stopId:'B'},serviceDate,time,timePreference,horizonMinutes:90,maxWalkKm:0,requireTransitRide:true}))
  for(const q of dates) assert.deepEqual((await cached(q)).journey,(await uncached(q)).journey)
  const prepared=(await cached({kind:'info'})).memory.timetablePreparations
  for(const q of [...dates].reverse().concat(dates)) {
    assert.deepEqual((await cached(q)).journey,(await uncached(q)).journey,'Date reuse must preserve complete journeys')
  }
  const retained=(await cached({kind:'info'})).memory
  assert.equal(retained.timetablePreparations,prepared,'Resident dates must not be prepared again')
  assert(retained.timetableCache.hits>0)
  assert(retained.timetableCache.retainedBytes<=retained.timetableCache.budgetBytes)
  assert(retained.ledger.inactiveTimetableHeapBytes>0)
  assert(retained.calendarIndexBytes>0, 'Calendar rules are indexed once per City')
  assert(retained.timetableSharedColumns.uniqueBytes>0)
  assert(retained.timetableSharedColumns.references>retained.timetableSharedColumns.uniqueBlocks,
    'Retained service dates share equal immutable columns')
  assert.equal((await uncached({kind:'info'})).memory.timetableSharedColumns.uniqueBlocks,0,
    'Retention-disabled queries keep the contiguous source layout')
  assert.equal((await uncached({kind:'info'})).memory.timetableCache.entries,0)
  // Transfer policies are part of identity, even on the same date.
  for(const q of [dates[0],{...dates[0],allowStreetTransfers:false},{...dates[0],minimumTransferBufferMinutes:5},dates[0]]) {
    assert.deepEqual((await cached(q)).journey,(await uncached(q)).journey)
  }
  // A tiny budget must bypass retention without changing routing.
  const tiny=resident(standaloneBinary,['stream','--city',city],{VIGO_TIMETABLE_CACHE_BYTES:'1'})
  for(const q of [dates[0],dates[1],dates[0]]) assert.deepEqual((await tiny(q)).journey,(await uncached(q)).journey)
  const bypass=(await tiny({kind:'info'})).memory
  assert.equal(bypass.timetableCache.entries,0)
  assert.equal(bypass.timetablePreparations,3)
  // A budget sized for one weekday timetable evicts by bytes before the entry limit.
  const probe=resident(standaloneBinary,['stream','--city',city],{VIGO_TIMETABLE_CACHE_BYTES:String(128*1024*1024)})
  const weekdays=[14,15,16].map(day=>({...dates[0],serviceDate:`2026-07-${day}`}))
  await probe(weekdays[0]); await probe(weekdays[1])
  const oneDayBytes=(await probe({kind:'info'})).memory.timetableCache.retainedBytes
  assert(oneDayBytes>0)
  const bounded=resident(standaloneBinary,['stream','--city',city],{VIGO_TIMETABLE_CACHE_BYTES:String(oneDayBytes)})
  for(const q of weekdays) assert.deepEqual((await bounded(q)).journey,(await uncached(q)).journey)
  const byteEviction=(await bounded({kind:'info'})).memory
  assert.equal(byteEviction.timetableCache.entries,1)
  assert.equal(byteEviction.timetableCache.evictions,1)
  assert(byteEviction.timetableCache.retainedBytes<=oneDayBytes)
  assert.deepEqual((await bounded(weekdays[0])).journey,(await uncached(weekdays[0])).journey)
  assert.equal((await bounded({kind:'info'})).memory.timetablePreparations,4)
  // More than eight inactive dates evicts the least recently used timetable.
  for(let day=14;day<=23;day++) await cached({...dates[0],serviceDate:`2026-07-${day}`})
  const evicted=(await cached({kind:'info'})).memory
  assert.equal(evicted.timetableCache.entries,8)
  assert(evicted.timetableCache.evictions>0)
  const oldest={...dates[0],serviceDate:'2026-07-14'}
  assert.deepEqual((await cached(oldest)).journey,(await uncached(oldest)).journey)
  assert.equal((await cached({kind:'info'})).memory.timetablePreparations,evicted.timetablePreparations+1)
  // Broad and narrow windows on one day must share the same loaded prefix.
  // Compare complete journeys against fresh standalone processes at every step.
  const cacheBase={kind:'route',origin:{stopId:'A'},destination:{stopId:'B'},serviceDate:'2026-07-10',
    horizonMinutes:480,maxWalkKm:0,requireTransitRide:true};
  for (const time of ['09:00','17:00','09:00','23:50','09:00']) {
    const q={...cacheBase,time,requireCompleteServiceCoverage:time==='17:00'};
    const fresh=JSON.parse(execFileSync(standaloneBinary,['route','--city',city,'--request','-'],{input:JSON.stringify(q),encoding:'utf8'}));
    const shared=await native(q);
    assert.deepEqual(shared.journey,fresh.journey,'Cached service-window supersets must preserve complete journeys');
  }
  const loaded=(await native({kind:'info'})).memory;
  for (const time of ['09:00','17:00','23:50','09:00']) await native({...cacheBase,time});
  const reused=(await native({kind:'info'})).memory;
  assert.equal(reused.timetablePreparations,loaded.timetablePreparations,'Varying clocks and coverage validation must not rebuild the same service prefix');
  assert(reused.timetableCoverageEndSeconds >= 36*3600);
  const fresh=Math.floor(Date.now()/1000)
  const longReverse = { kind:'route', origin:{stopId:'A'}, destination:{stopId:'B'}, serviceDate:'2026-07-11',
    time:'00:10', timePreference:'arrive_by', horizonMinutes:2880, arrivalBufferMinutes:60,
    windowMinutes:240, windowStepMinutes:60, requireTransitRide:true, maxWalkKm:0 }
  for (const query of [native,http]) {
    const result=await query(longReverse)
    assert.equal(result.status,'ok',JSON.stringify(result))
    assert.equal(result.journey.clockDate,'2026-07-08')
    assert.equal(result.alternativeSearch.searches,5,'All shifted arrival deadlines must be searched')
    const invalid=await query({...longReverse,serviceDay:'weekday'})
    assert.equal(invalid.status,'error')
    assert.match(invalid.error.message,/serviceDay disagrees/)
  }
  for(const [serviceDate,time,update,arrival] of [
    ['2026-07-11','00:50',{tripId:'after',startDate:'20260710',delaySeconds:300},'01:25:00'],
    ['2026-11-01','01:20',{tripId:'fold',startDate:'20261101',stopTimeUpdates:[
      {stopId:'A',stopSequence:1,departure:{time:Date.parse('2026-11-01T06:35:00Z')/1000}},
      {stopId:'B',stopSequence:2,arrival:{time:Date.parse('2026-11-01T06:55:00Z')/1000}},
    ]},'01:55:00'],
  ]) {
    const q={kind:'route',origin:{stopId:'A'},destination:{stopId:'B'},serviceDate,time,horizonMinutes:90,
      requireTransitRide:true,maxWalkKm:0,routingDataMode:'realtime',realtimeSnapshot:{feedTimestamp:fresh,tripUpdates:[update]}}
    for(const query of [native,node,http]) {
      const result=await query(q); assert.equal(result.status,'ok',JSON.stringify(result))
      assert.equal(result.journey.arrivalTime,arrival)
    }
  }
  console.log('Calendar boundaries passed: weekday/weekend/holiday, previous service day, overnight depart/arrive, DST absolute realtime, prior-service realtime, native CLI/HTTP/stream and Node parity.')
} finally {for(const child of children) if(child.exitCode===null) {child.kill(); await once(child,'exit')} fs.rmSync(dir,{recursive:true,force:true})}
