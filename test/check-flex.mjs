import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-flex-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  const stops = await zip.file('stops.txt').async('string')
  zip.file('trips.txt', (await zip.file('trips.txt').async('string')) + 'R1,WKD,F,0\n')
  zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string')).trimEnd().split('\n').map((s,i) => s + (i===0 ? ',location_id,start_pickup_drop_off_window,end_pickup_drop_off_window,pickup_type,drop_off_type,pickup_booking_rule_id' : ',,,,,,')).join('\n')
    + '\nF,,,,1,ZONE,08:00:00,10:00:00,2,1,BOOK\nF,,,,2,ZONE,08:00:00,10:00:00,1,2,\n')
  zip.file('booking_rules.txt', 'booking_rule_id,booking_type,prior_notice_duration_min,message,phone_number\nBOOK,1,60,Call at least one hour ahead,555-0100\n')
  zip.file('locations.geojson', JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'ZONE',properties:{stop_name:'Zone'},geometry:{type:'Polygon',coordinates:[[[-77.06,38.89],[-77.02,38.89],[-77.02,38.92],[-77.06,38.92],[-77.06,38.89]]]}}]}))
  fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const city = path.join(folder,'city')
  execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',gtfsPath,'--osm',osmPath,'--output',city],{cwd:root,stdio:'pipe'})
  const db = new DatabaseSync(path.join(city,'routing/project.sqlite'),{readOnly:true})
  assert.equal(db.prepare("SELECT COUNT(*) n FROM connections WHERE trip_id='F'").get().n,0,'Flex must not fabricate scheduled departures')
  const catalog=JSON.parse(db.prepare('SELECT data FROM flex_catalog').get().data)
  assert.equal(catalog.trips.F.calls.length,2); db.close()
  const query=(kind,q)=>JSON.parse(execFileSync(standaloneBinary,[kind,'--city',city,'--request','-'],{cwd:root,input:JSON.stringify({...q,diagnostics:'trace'}),encoding:'utf8'}))
  const base={origin:{coordinate:[-77.05,38.9]},destination:{coordinate:[-77.03,38.91]},time:'08:00',serviceDate:'2026-07-15',requireTransitRide:true,flex:{durationFactor:1,durationOffsetSeconds:0}}
  const route=query('route',base)
  const plans=[route.trace,...(route.trace.choices??[])]
  const flexible=plans.find(p=>p.legs?.some(l=>l.flexEstimate))
  assert(flexible,JSON.stringify(route).slice(0,2000))
  const ride=flexible.legs.find(l=>l.flexEstimate)
  assert.equal(ride.flexEstimate.bookingStatus,'required')
  assert.equal(ride.flexEstimate.bookingRequirements[0].phone_number,'555-0100')
  assert(ride.departureMinutes>=480 && ride.arrivalMinutes<=600)
  const late=query('route',{...base,time:'11:00'})
  assert(![late.trace,...(late.trace.choices??[])].some(p=>p.legs?.some(l=>l.flexEstimate)))
  const {origin,destination,...options}=base
  const matrix=query('matrix',{...options,origins:[origin],destinations:[destination],includeJourneys:true})
  assert.equal(matrix.trace.durationsMinutes[0][0],route.trace.arrivalMinutes-480)
  for (const [origins,destinations] of [[[],[destination]],[[origin],[]]]) {
    assert.throws(()=>query('matrix',{...options,origins,destinations}),/1\.\.4096/)
  }
  const reverse=query('route',{...base,time:'09:00',timePreference:'arrive_by'})
  assert.equal(reverse.trace.status,'ready')
  assert(reverse.trace.arrivalMinutes<=540)
  assert([reverse.trace,...(reverse.trace.choices??[])].some(p=>p.legs?.some(l=>l.flexEstimate)))
  const drive=query('route',{...base,flex:undefined,mode:'drive',requireTransitRide:false})
  assert.equal(Math.round(ride.durationMinutes*60),Math.ceil(drive.trace.durationMinutes*60),'Flex factor 1 / offset 0 uses the independent native Drive duration')
  assert(route.journey.legs.some(l=>l.quality?.flex?.bookingStatus==='required'),'Public output must retain booking requirements')
  const nodeResult=JSON.parse(execFileSync(process.execPath,['public/vigo.mjs','route','--city',city,'--request','-','--service-date',base.serviceDate,'--time',base.time],{cwd:root,input:JSON.stringify({...base,diagnostics:'trace'}),encoding:'utf8'}))
  assert(nodeResult.journey?.legs.some(l=>l.quality?.flex?.bookingStatus==='required'),JSON.stringify(nodeResult).slice(0,4000))
  const server=spawn(standaloneBinary,['serve','--city',city,'--port','0'],{env:{...process.env,VIGO_API_TOKEN:'synthetic-flex-test'}})
  try {
    const port=await new Promise((resolve,reject)=>{
      let log=''
      const timer=setTimeout(()=>reject(new Error('Flex HTTP startup timed out')),15000)
      server.stderr.on('data',data=>{log+=data;const match=log.match(/listening on 127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]))}})
      server.once('error',error=>{clearTimeout(timer);reject(error)})
      server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Flex HTTP exited ${code}: ${log}`))})
    })
    const response=await fetch(`http://127.0.0.1:${port}/v1/route`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-flex-test'},body:JSON.stringify(base),signal:AbortSignal.timeout(15000)})
    assert.equal(response.status,200)
    assert.deepEqual((await response.json()).journey,route.journey,'HTTP preserves conditional journey semantics')
  } finally {
    if(server.exitCode===null){const closed=once(server,'exit');server.kill();await closed}
  }
  const confirmed=query('route',{...base,flex:{...base.flex,bookingConfirmed:true}})
  assert(confirmed.journey.legs.some(l=>l.quality?.flex?.bookingStatus==='caller_confirmed'))
  const duplicate=query('matrix',{...options,origins:[origin,origin],destinations:[destination,destination],includeJourneys:true})
  assert.deepEqual(duplicate.trace.durationsMinutes,[[matrix.trace.durationsMinutes[0][0],matrix.trace.durationsMinutes[0][0]],[matrix.trace.durationsMinutes[0][0],matrix.trace.durationsMinutes[0][0]]])
  assert(duplicate.journeys[1][1].legs.some(l=>l.quality?.flex),'Duplicate cells keep the selected conditional journey')
  const outside=query('route',{...base,origin:{coordinate:[-77.07,38.9]}})
  assert(![outside.trace,...(outside.trace.choices??[])].some(p=>p.legs?.some(l=>l.flexEstimate)),'Zones cannot be boarded outside their polygon')
  // Fixed-stop advance booking retains the published train/bus clocks and is
  // unavailable unless the caller explicitly includes conditional service.
  zip.file('trips.txt','route_id,service_id,trip_id,direction_id\nR1,WKD,BOOKED,0\n')
  zip.file('stop_times.txt','trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,pickup_booking_rule_id\nBOOKED,08:00:00,08:00:00,A,1,2,1,BOOK\nBOOKED,08:20:00,08:20:00,B,2,1,2,\n')
  fs.writeFileSync(gtfsPath, await zip.generateAsync({type:'nodebuffer'}))
  const bookedCity=path.join(folder,'booked')
  execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',gtfsPath,'--osm',osmPath,'--output',bookedCity],{cwd:root,stdio:'pipe'})
  const booked=q=>JSON.parse(execFileSync(standaloneBinary,['route','--city',bookedCity,'--request','-'],{input:JSON.stringify({...q,diagnostics:'trace'}),encoding:'utf8'}))
  const bookedRequest={...base,origin:{stopId:'A'},destination:{stopId:'B'},maxWalkKm:0,time:'07:59'}
  assert.equal(booked({...bookedRequest,flex:undefined}).status,'not_found')
  const allowed=booked(bookedRequest)
  assert.equal(allowed.journey.departureTime,'08:00:00'); assert.equal(allowed.journey.arrivalTime,'08:20:00')
  assert.equal(allowed.journey.legs[0].quality.schedule,'timetable')
  assert.equal(allowed.journey.legs[0].quality.flex.bookingStatus,'required')
  // A zone-only feed need not invent stops.txt or scheduled connections.
  zip.remove('stops.txt')
  zip.file('trips.txt','route_id,service_id,trip_id,direction_id\nR1,WKD,F,0\n')
  zip.file('stop_times.txt','trip_id,stop_sequence,location_id,start_pickup_drop_off_window,end_pickup_drop_off_window,pickup_type,drop_off_type,pickup_booking_rule_id\nF,1,ZONE,08:00:00,10:00:00,2,1,BOOK\nF,2,ZONE,08:00:00,10:00:00,1,2,\n')
  fs.writeFileSync(gtfsPath, await zip.generateAsync({type:'nodebuffer'}))
  const flexCity=path.join(folder,'flex-only')
  execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',gtfsPath,'--osm',osmPath,'--output',flexCity],{cwd:root,stdio:'pipe'})
  const pure=JSON.parse(execFileSync(standaloneBinary,['route','--city',flexCity,'--request','-'],{input:JSON.stringify(base),encoding:'utf8'}))
  assert.equal(pure.status,'ok')
  assert.equal(pure.journey.legs.find(l=>l.type==='transit').quality.schedule,'flex_estimate')
  const pureQuery=(kind,q)=>JSON.parse(execFileSync(standaloneBinary,[kind,'--city',flexCity,'--request','-'],{input:JSON.stringify({...q,diagnostics:'trace'}),encoding:'utf8'}))
  for (const allowLongWalk of [false,true]) {
    const walking={...base,time:'11:00',requireTransitRide:false,allowLongWalk,maxWalkKm:0}
    const route=pureQuery('route',walking)
    const matrix=pureQuery('matrix',{...walking,origin:undefined,destination:undefined,origins:[origin],destinations:[destination],includeJourneys:true})
    assert.equal(route.status,allowLongWalk?'ok':'not_found')
    if (allowLongWalk) assert(Math.abs(matrix.trace.durationsMinutes[0][0]-route.trace.durationMinutes)<1e-8)
    else assert.equal(matrix.trace.durationsMinutes[0][0],null)
  }
  zip.file('stops.txt',stops)
  zip.remove('locations.geojson')
  zip.file('location_groups.txt','location_group_id,location_group_name\nGROUP,Any eligible stop\n')
  zip.file('location_group_stops.txt','location_group_id,stop_id\nGROUP,A\nGROUP,B\n')
  zip.file('stop_times.txt','trip_id,stop_sequence,location_group_id,start_pickup_drop_off_window,end_pickup_drop_off_window,pickup_type,drop_off_type,pickup_booking_rule_id\nF,1,GROUP,08:00:00,10:00:00,2,1,BOOK\nF,2,GROUP,08:00:00,10:00:00,1,2,\n')
  fs.writeFileSync(gtfsPath,await zip.generateAsync({type:'nodebuffer'}))
  const groupCity=path.join(folder,'groups')
  execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',gtfsPath,'--osm',osmPath,'--output',groupCity],{cwd:root,stdio:'pipe'})
  const grouped=JSON.parse(execFileSync(standaloneBinary,['route','--city',groupCity,'--request','-'],{input:JSON.stringify(base),encoding:'utf8'}))
  assert.equal(grouped.status,'ok')
  assert(grouped.journey.legs.some(l=>l.quality?.flex))
  for (const [name,contents] of [['booking_rules.txt','booking_rule_id,booking_type,prior_notice_duration_min\nBOOK,1,invalid\n'],['locations.geojson','{']]) {
    const old=zip.file(name)?await zip.file(name).async('string'):null
    zip.file(name,contents)
    fs.writeFileSync(gtfsPath,await zip.generateAsync({type:'nodebuffer'}))
    const invalidCity=path.join(folder,`invalid-${name}`)
    assert.throws(()=>execFileSync(process.execPath,['public/vigo.mjs','build','--gtfs',gtfsPath,'--osm',osmPath,'--output',invalidCity],{cwd:root,stdio:'pipe'}),'Malformed Flex source must fail before publication')
    assert(!fs.existsSync(path.join(invalidCity,'city.json')))
    if(old===null)zip.remove(name);else zip.file(name,old)
  }
  console.log('Flex: source preservation, no fabricated timetable, conditional bookings, windows, arrive-by and Matrix/Route agreement passed.')
} finally { fs.rmSync(folder,{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
