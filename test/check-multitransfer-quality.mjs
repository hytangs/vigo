import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { buildNationalGtfsStore, routeNationalGtfsStore, routeNationalGtfsMatrix, addNationalGtfsFares, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'

// Raw GTFS corridors have one fast chain and a slower direct fallback. Every
// intermediate change has a published minimum and exactly meets that minimum.
// Stop spacing prevents inferred walking from bypassing a required boarding.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-multitransfer-'))
let routes = 0, replayedRides = 0, matrixCells = 0
try {
 for (const depth of [2,4,6,8,12,16]) for (const base of [480,1500]) {
  const trips = Array.from({length:depth},(_,i)=>({id:`T${i}`,from:i,to:i+1,departure:base+i*6,arrival:base+i*6+5}))
  trips.push({id:'SLOW',from:0,to:depth,departure:base,arrival:base+depth*6+60})
  const zip = new JSZip(), table=(name,header,rows)=>zip.file(name,header+'\n'+rows.join('\n')+'\n')
  const time=m=>`${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}:00`
  table('agency.txt','agency_name,agency_url,agency_timezone',['Test,https://example.test,America/New_York'])
  table('stops.txt','stop_id,stop_name,stop_lat,stop_lon',Array.from({length:depth+1},(_,i)=>`S${i},Stop ${i},38,${-77+i*0.05}`))
  table('routes.txt','route_id,route_short_name,route_type',['R,Test,3'])
  table('trips.txt','route_id,service_id,trip_id',trips.map(t=>`R,ACTIVE,${t.id}`))
  table('calendar_dates.txt','service_id,date,exception_type',['ACTIVE,20260715,1'])
  table('transfers.txt','from_stop_id,to_stop_id,transfer_type,min_transfer_time',Array.from({length:depth-1},(_,i)=>`S${i+1},S${i+1},2,60`))
  table('stop_times.txt','trip_id,stop_id,stop_sequence,arrival_time,departure_time',trips.flatMap(t=>[
   `${t.id},S${t.from},1,${time(t.departure)},${time(t.departure)}`,`${t.id},S${t.to},2,${time(t.arrival)},${time(t.arrival)}`]))
  const zipPath=path.join(root,`${depth}-${base}.zip`),storePath=path.join(root,`${depth}-${base}.sqlite`)
  await fs.writeFile(zipPath,await zip.generateAsync({type:'nodebuffer'}));await buildNationalGtfsStore({zipPath,outputPath:storePath})
  const point=i=>({stopId:`S${i}`,source:'stop',coordinate:[-77+i*0.05,38]})
  const query={origin:point(0),destination:point(depth),serviceDate:'2026-07-15',serviceDay:'weekday',departMinutes:base,horizonMinutes:240,maxWalkKm:0.1,routingPreference:'fastest',returnedStationCyclePolicy:'represented'}
  for (const budget of [depth,1,depth-1,depth]) {
   const request={...query,maxTransfers:budget-1},expected=budget>=depth ? base+(depth-1)*6+5 : base+depth*6+60
   const result=routeNationalGtfsStore(storePath,request)
   assert.equal(result.status,'ready',`${depth} boardings / budget ${budget}`)
   assert.equal(result.arriveMinutes,expected)
   const rides=result.legs.filter(l=>l.type==='ride')
   assert.equal(rides.length,budget>=depth?depth:1)
   assert.equal(result.transfers,rides.length-1)
   let stop='S0',end=base
   for(const leg of result.legs) {
    assert(leg.startMinutes>=end-0.001,'Legs must be chronological')
    assert(leg.endMinutes>=leg.startMinutes,'Negative leg duration')
    end=leg.endMinutes
    if(leg.type!=='ride') continue
    const raw=trips.find(t=>t.id===leg.tripId)
    assert(raw,'Every ride must identify a source trip')
    assert.equal(leg.fromStopId,stop);assert.equal(leg.toStopId,`S${raw.to}`)
    assert.equal(leg.startMinutes,raw.departure);assert.equal(leg.endMinutes,raw.arrival)
    assert.deepEqual(leg.stopIds,[`S${raw.from}`,`S${raw.to}`])
    stop=leg.toStopId;replayedRides++
   }
   assert.equal(stop,`S${depth}`)
   assert.equal(end,result.arriveMinutes)
   const annotated=addNationalGtfsFares(storePath,result)
   assert(annotated.legs.filter(l=>l.type==='ride').every(l=>l.fare.status==='unavailable'))
   assert.equal(annotated.arriveMinutes,expected)
   const repeat=routeNationalGtfsStore(storePath,request)
   assert.deepEqual(repeat.legs,result.legs,'Resident reuse must preserve output')
   const matrix=routeNationalGtfsMatrix(storePath,{...request,origins:[point(0)],destinations:[point(depth)]})
   assert.equal(matrix.rows[0].arriveMinutes,expected);matrixCells++
   const reverse=routeNationalGtfsStore(storePath,{...request,timePreference:'arrive',arriveMinutes:base+(depth-1)*6+5})
   assert.equal(reverse.status,budget>=depth?'ready':'blocked')
   if(reverse.status==='ready') {assert.equal(reverse.departMinutes,base);assert.deepEqual(reverse.legs.filter(l=>l.type==='ride').map(l=>l.tripId),rides.map(l=>l.tripId))}
   routes+=3
  }
 }
 console.log(JSON.stringify({status:'passed',routes,replayedRides,matrixCells,depths:[2,4,6,8,12,16],overnight:true,publishedTransferMinimumSeconds:60},null,2))
} finally {disposeAllNationalGtfsStores();await fs.rm(root,{recursive:true,force:true})}
