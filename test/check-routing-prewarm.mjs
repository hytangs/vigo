import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {writeCliFixtureInputs} from './helpers/cli-fixture-inputs.mjs'
import {buildNationalGtfsStore, disposeAllNationalGtfsStores} from '../src/server/national-gtfs-store.mjs'
import {buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore} from '../src/server/national-osm-store.mjs'
import {buildNativeStreetCchIndex} from '../src/server/native-routing-kernel.mjs'
import {startInMemoryVigoApi} from './helpers/in-memory-vigo-api.mjs'
import {resolveDepartNowRequest} from '../src/server/routing-depart-now.mjs'
const repositoryRoot=path.resolve(import.meta.dirname,'..')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'vigo-prewarm-'))
const meta=path.join(root,'cities','fixture','.vigo'), store=path.join(meta,'routing','feed.sqlite'),street=path.join(meta,'osm','street-index.sqlite')
let api
try {
 const inputs=await writeCliFixtureInputs(root)
 await buildNationalGtfsStore({zipPath:inputs.gtfsPath,outputPath:store})
 await buildNationalOsmStore({pbfPath:inputs.osmPath,outputPath:street})
 compactNationalOsmRuntimeStore(street,{requireDrive:true});buildNativeStreetCchIndex(street)
 disposeNationalOsmStore(street);disposeAllNationalGtfsStores()
 await fs.writeFile(path.join(meta,'project.json'),JSON.stringify({schemaVersion:'vigo.project.v1',id:'fixture',name:'Fixture',feeds:[{id:'feed',routingStore:{status:'ready',fileName:'feed.sqlite'}}],jobs:[],artifacts:[],osmStreetIndex:{status:'ready',cch:{ready:true}}}))
 api=await startInMemoryVigoApi({repositoryRoot,environment:{VIGO_PROJECTS_DIR:path.join(root,'cities'),VIGO_CONFIG_DIR:path.join(root,'config')}})
 const post=async(action,body)=>{const r=await api.requestJson('/api/projects/fixture/'+action,{method:'POST',body});assert.equal(r.status,200,JSON.stringify(r.body));return r.body}
 const context={feedId:'feed',serviceDate:'2026-09-14',serviceDay:'weekday',mode:'transit',routingDataMode:'scheduled'}
 const [lease]=await Promise.all([post('routing-residency',{...context,resident:true,leaseId:'test'}),post('national-ready',context)])
 assert.equal(lease.residency.reachPreparation.activeServiceKernel.ready,true)
 assert(lease.residency.reachPreparation.farePreparation, 'City preparation must initialize optional fare output before the first route')
 const health=await api.requestJson('/api/health')
 assert.equal(health.body.routingRuntime.routingAccessPrewarm.started,1,'City residency and Pathfinder must share one exact-context preparation')
 const request={...context,requireTransitRide:true,origin:{stopId:'A',coordinate:[-77.05,38.9]},destination:{stopId:'B',coordinate:[-77.03,38.91]},departMinutes:480,maxWalkKm:0.1}
 const first=await post('national-route',request),repeat=await post('national-route',request)
 assert.equal(first.plan.status,'ready');assert.equal(first.plan.arriveMinutes,510);assert.deepEqual(first.plan.legs,repeat.plan.legs)
 const live={...context,routingDataMode:'realtime',departNow:true,serviceDate:'1999-01-01',resident:true,leaseId:'test-live'}
 const before=Date.now(),current=await post('routing-residency',live),after=Date.now()
 const actual=current.residency.reachPreparation.serviceDateResolution.requestedServiceDate
 assert([before,after].some(instant=>resolveDepartNowRequest(live,['America/New_York'],instant).serviceDate===actual),'Depart-now residency must prepare the agency current date, not retained research controls')
 await post('routing-residency',{...live,resident:false})
 await post('routing-residency',{...context,resident:false,leaseId:'test'})
 console.log('First-route preparation: shared exact context, current-date residency, unchanged first/repeated journeys passed.')
} finally {await api?.stop();disposeAllNationalGtfsStores();disposeNationalOsmStore(street);await fs.rm(root,{recursive:true,force:true})}
