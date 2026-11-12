import { buildScheduleFixture } from './helpers/schedule-fixture.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { disposeNationalGtfsStore, expandParentStationTransfers, prepareNationalGtfsRoutingContext, prepareNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { decodeRoutingSnapshot,encodeRoutingSnapshot } from '../src/server/routing-snapshot.mjs'
import { nationalRoutingAccessPolicy,nationalRoutingAccessPolicyIdentity,walkSeconds } from '../src/server/gtfs/routing-policy.mjs'
import { stableJson } from '../src/server/routing-plan-identity.mjs'

const stops=new Map([['P',{location_type:1}],['Q',{location_type:1}],['A',{location_type:0,parent_station:'P'}],['B',{location_type:0,parent_station:'Q'}]])
const members=new Map([['P',['P','A']],['Q',['Q','B']]])
const parent=(seconds,provenance='gtfs_transfer')=>({from_stop_id:'P',to_stop_id:'Q',transfer_type:2,min_transfer_time:seconds,provenance})
const osm=(from='A',to='B')=>({from_stop_id:from,to_stop_id:to,transfer_type:2,min_transfer_time:1,provenance:'osm_certified_radial',path_distance_m:29.466})
const edge=(rows,from='A',to='B')=>expandParentStationTransfers(rows,stops,members).transfers.get(from).find(e=>e.to_stop_id===to)
for(const provenance of ['gtfs_transfer','gtfs_transfer'])for(const rows of [[parent(180,provenance),osm()],[osm(),parent(180,provenance)]]) {
  const e=edge(rows.values())
  assert.equal(e.min_transfer_time,180,'Parent minimum survives faster OSM in either order and with a one-use iterator')
  assert.equal(e.parentStationMinimumSeconds,180)
  assert.equal(e.provenance,'osm_certified_radial','The walking path witness remains attached')
}
const override={...parent(420),from_stop_id:'A'}
for(const rows of [[parent(300),override,osm()],[osm(),override,parent(300)]])assert.equal(edge(rows).min_transfer_time,420,'Every overlapping applicable minimum is respected')
assert.equal(edge([parent(180),osm('B','A')],'B','A').min_transfer_time,walkSeconds(0.029466),'Directedness is preserved')
assert.equal(edge([osm()]).min_transfer_time,walkSeconds(0.029466),'Uncovered walking costs are unchanged')
assert.equal(edge([parent(0),osm()]).min_transfer_time,0)

const folder=await fs.mkdtemp(path.join(os.tmpdir(),'vigo-parent-minimum-'))
const storePath=path.join(folder,'routing.sqlite'), schedulePath=path.join(folder,'schedule.json'),scope='minimum-fixture'
const id=s=>`${scope}\u001f${s}`
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const trips=[['EARLY','O','A',478,478.5],['FEED','O','A',480,481],['TIGHT','B','D',481.5,485],['LATE','B','D',484,488]]
try {
  const schedule={stops:[{id:'O',name:'Origin',lat:0,lon:0},{id:'P',name:'First parent',lat:0,lon:0.01,locationType:1},
    {id:'A',name:'First platform',lat:0,lon:0.01,parentStationId:'P'}, {id:'Q',name:'Second parent',lat:0,lon:0.011,locationType:1},
    {id:'B',name:'Second platform',lat:0,lon:0.011,parentStationId:'Q'},{id:'D',name:'Destination',lat:0,lon:0.03}],
    transferRules:[{fromStopId:'P',toStopId:'Q',transferType:2,minTransferTimeSeconds:180},
      {fromStopId:'B',toStopId:'B',transferType:3}],
    routes:trips.map(([tripId,from,to,departure,arrival])=>({routeId:tripId,shortName:tripId,routeType:3,scheduledTrips:[{
      tripId,serviceId:'WK',serviceDays:['weekday'],stopTimes:[{stopId:from,sequence:1,arrivalMinutes:departure,departureMinutes:departure},
        {stopId:to,sequence:2,arrivalMinutes:arrival,departureMinutes:arrival}]}]}))}
  await fs.writeFile(schedulePath,JSON.stringify(schedule)+'\n')
  await buildScheduleFixture({schedules:[{feedId:scope,schedulePath}],outputPath:storePath})
  const db=new DatabaseSync(storePath)
  try {
    db.prepare('INSERT INTO transfers VALUES(?,?,2,1)').run(id('A'),id('B'))
    db.prepare("INSERT INTO transfer_provenance VALUES(?,?,'osm_certified_radial','synthetic-regression-evidence',29.466)").run(id('A'),id('B'))
    db.prepare("UPDATE metadata SET value=(SELECT COUNT(*) FROM transfers) WHERE key='transferCount'").run()
  }finally{db.close()}
  const originalHash=hash(await fs.readFile(storePath))
  // Activating the service date persists the active-service kernel snapshot
  // next to the access context, as routing did before it moved to the runtime.
  const check=()=>{
    assert.equal(prepareNationalGtfsRoutingContext(storePath,{serviceDate:'2026-07-15',serviceDay:'weekday'}).activeServiceKernel.ready,true)
    prepareNationalGtfsStore(storePath)
  }
  check()
  disposeNationalGtfsStore(storePath)
  // A pre-fix access/active-kernel snapshot must be rejected by the semantic
  // identity, even when its authoritative SQLite identity still matches.
  const oldPolicy={...nationalRoutingAccessPolicy,schemaVersion:'vigo.routing.access-policy.v3'}
  delete oldPolicy.parentStationTransferMinimums
  delete oldPolicy.sameStopTransferProhibitionScope
  const snapshotNames=(await fs.readdir(folder)).filter(name=>name.endsWith('.access-context.bin')||name.includes('.active-service-kernel.'))
  assert.equal(snapshotNames.length,2)
  for(const name of snapshotNames) {
    const p=path.join(folder,name),saved=decodeRoutingSnapshot(await fs.readFile(p))
    if(saved.metadata.materialized) {
      saved.metadata.accessPolicyIdentity=stableJson(oldPolicy)
      for(const [from,edges]of saved.metadata.materialized.transfers)for(const e of edges)if(from===id('A')&&e.to_stop_id===id('B'))e.min_transfer_time=23
    }else{
      saved.metadata.kernel.accessPolicyIdentity=stableJson(oldPolicy)
      const ids=saved.metadata.kernel.stopIds,from=ids.indexOf(id('A')),to=ids.indexOf(id('B')),a=saved.arrays
      for(let i=a.transferOffset[from];i<a.transferOffset[from+1];i++)if(a.transferTo[i]===to)a.transferDuration[i]=23
    }
    await fs.writeFile(p,encodeRoutingSnapshot(saved.metadata,saved.arrays))
  }
  check()
  disposeNationalGtfsStore(storePath)
  for(const name of snapshotNames) {
    const saved=decodeRoutingSnapshot(await fs.readFile(path.join(folder,name)))
    assert.equal(saved.metadata.accessPolicyIdentity??saved.metadata.kernel.accessPolicyIdentity,nationalRoutingAccessPolicyIdentity)
  }
  assert.equal(hash(await fs.readFile(storePath)),originalHash,'Routing and semantic snapshot refresh preserve authoritative source data')
  console.log('Parent minimum floors, overlapping/directed rules and stale snapshot rejection passed.')
}finally{
  disposeNationalGtfsStore(storePath)
  await fs.rm(folder,{ recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
