// Public OSM fixtures: bicycle endpoints must use connected pedestrian ways.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync,spawnSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {writeCliFixtureInputs} from './helpers/cli-fixture-inputs.mjs'
import {standaloneBinary as binary} from './helpers/standalone-runtime.mjs'
import {disposeNationalOsmStore} from '../src/server/national-osm-store.mjs'
const root=path.resolve(import.meta.dirname,'..')
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vigo-bike-walk-'))
const stores=[]
const destination=[-77.03,38.91], ordinaryOrigin=[-77.054,38.9]
const request={mode:'bike',origin:ordinaryOrigin,destination,time:'08:00',maxWalkKm:.9,maxStreetKm:10,bike:{profile:'fast'},diagnostics:'trace'}
function query(city,q,kind='route') {
  const r=spawnSync(binary,[kind,'--city',city,'--request','-'],{input:JSON.stringify(q),encoding:'utf8'})
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)
}
try {
  for (const variant of ['disconnected','connected','directed','coincident']) {
    const dir=path.join(directory,variant);fs.mkdirSync(dir)
    const connected=['connected','directed'].includes(variant)
    const input=await writeCliFixtureInputs(dir,{terminalAccess:true,
      terminalWayTags:connected?{12:{access:'yes',highway:'footway'},13:{foot:'yes',...(variant==='directed'?{'oneway:foot':'yes'}:{})}}:{},
      terminalNodeCoordinates:variant==='coincident'?{4:[-77.05,38.9],5:[-77.05,38.9002]}:connected?{5:[-77.054,38.902],6:[-77.05,38.902]}:{}})
    const city=path.join(dir,'city'),store=path.join(city,'osm/street-index.sqlite');stores.push(store)
    execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${input.gtfsPath}`,`--osm=${input.osmPath}`,
      '--street-modes=walk,bike',`--output=${city}`],{cwd:root,stdio:['ignore','ignore','pipe']})
    const db=new DatabaseSync(store,{readOnly:true})
    assert(db.prepare("SELECT value FROM metadata WHERE key='bikeWalkAccess'").get())
    assert.equal(db.prepare('SELECT count(*) n FROM bike_walk_nodes WHERE bike_node=4').get().n,0,'A coincident foot node is not a bicycle node')
    db.close()
    const origin=variant==='coincident'?[-77.05,38.9002]:ordinaryOrigin
    for (const reverse of [false,true]) {
      const q={...request,origin:reverse?destination:origin,destination:reverse?origin:destination}
      const actual=query(city,q)
      const permitted=connected&&!(variant==='directed'&&reverse)
      assert.equal(actual.status,permitted?'ok':'not_found',variant+' '+reverse)
      if (!permitted) continue
      assert(actual.journey.legs.some(l=>l.type==='walk'&&l.distanceMeters>750),'Charge the full network walk')
      assert(actual.trace.legs.some(l=>l.geometrySource==='osm'&&l.streetPathVerified&&l.kind==='walk'),'Expose the pedestrian path witness')
      assert.equal(query(city,{...q,maxWalkKm:.5}).status,'not_found','Apply the walking budget to the actual network path')
      for (const timePreference of ['depart_at','arrive_by']) {
        const dated={...q,timePreference,serviceDate:'2026-07-15'}
        const route=query(city,dated)
        assert.equal(route.status,'ok')
        const matrix=query(city,{...dated,origin:undefined,destination:undefined,origins:[q.origin],destinations:[q.destination]},'matrix')
        assert(Math.abs(matrix.durationsSeconds[0][0]-route.journey.durationSeconds)<=1)
      }
    }
    if (variant==='connected') {
      for (const profile of ['fast','quiet']) for (const arrive of [false,true]) {
        const q={...request,serviceDate:'2026-07-15',timePreference:arrive?'arrive_by':'depart_at',bike:{profile},
          destination:arrive?ordinaryOrigin:undefined,maxStreetKm:undefined,origin:arrive?undefined:ordinaryOrigin,bounds:[-77.055,38.898,-77.027,38.914],rasterSize:16,
          reachFormat:'surface',surfaceSampling:'grid',cutoffsMinutes:[30],includeStreetEdges:false,includeNodes:false}
        const reach=query(city,q,'reach');assert.equal(reach.status,'ok')
        const size=q.rasterSize
        const points=Array.from({length:size*size},(_,i)=>[q.bounds[0]+(i%size+.5)/size*(q.bounds[2]-q.bounds[0]),q.bounds[3]-(Math.floor(i/size)+.5)/size*(q.bounds[3]-q.bounds[1])])
        const matrix=query(city,{...request,serviceDate:q.serviceDate,timePreference:q.timePreference,bike:q.bike,
          origin:undefined,destination:undefined,origins:arrive?points:[ordinaryOrigin],destinations:arrive?[ordinaryOrigin]:points},'matrix')
        const values=arrive?matrix.durationsSeconds.map(r=>r[0]):matrix.durationsSeconds[0]
        assert.deepEqual(reach.surface.valuesSeconds,values.map(v=>v!=null&&v<=1800?v:null),profile+' '+arrive)
      }
      for (const mutation of ['version','identity','node','duplicate-dense','duplicate-sparse']) {
        const copy=path.join(dir,'bad-'+mutation);fs.cpSync(city,copy,{recursive:true})
        const corrupt=new DatabaseSync(path.join(copy,'osm/street-index.sqlite'))
        if (mutation==='node') corrupt.exec('UPDATE bike_walk_nodes SET walk_node=4294967295 WHERE bike_node=1')
        else if (mutation.startsWith('duplicate-')) {
          // Coincident coordinates still represent distinct source identities.
          // Exercise both dense and sparse readers without relying on row order.
          if (mutation==='duplicate-sparse') corrupt.exec('DELETE FROM bike_walk_nodes WHERE bike_node NOT IN (SELECT bike_node FROM bike_walk_nodes ORDER BY bike_node LIMIT 2)')
          const first=corrupt.prepare('SELECT bike_node,walk_node FROM bike_walk_nodes ORDER BY bike_node LIMIT 1').get()
          const coordinate=corrupt.prepare('SELECT lon_e7,lat_e7 FROM bike_nodes WHERE node_id=?').get(first.bike_node)
          corrupt.prepare('UPDATE bike_nodes SET lon_e7=?,lat_e7=? WHERE node_id IN (SELECT bike_node FROM bike_walk_nodes)').run(coordinate.lon_e7,coordinate.lat_e7)
          corrupt.prepare('UPDATE bike_walk_nodes SET walk_node=?').run(first.walk_node)
        }
        else {
          const metadata=JSON.parse(corrupt.prepare("SELECT value FROM metadata WHERE key='bikeWalkAccess'").get().value)
          if (mutation==='version') metadata.version=99
          else metadata.identity={unexpected:true}
          corrupt.prepare("UPDATE metadata SET value=? WHERE key='bikeWalkAccess'").run(JSON.stringify(metadata))
        }
        corrupt.close()
        const bad=spawnSync(binary,['route','--city',copy,'--request','-'],{input:JSON.stringify(request),encoding:'utf8'})
        assert.notEqual(bad.status,0,mutation);assert.match(bad.stderr,/bicycle walking|walking node/i)
      }
    }
    disposeNationalOsmStore(store)
  }
  console.log('Bicycle pedestrian connectors: disconnected and coincident nodes, verified network geometry, budgets, native/Node Route and Matrix, depart-at and arrive-by passed.')
} finally {for(const store of stores)disposeNationalOsmStore(store);fs.rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:50})}
