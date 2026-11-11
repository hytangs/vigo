// Synthetic, publicly reproducible end-to-end checks. No private benchmark inputs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
import { routeNationalStreetStore, routeNationalStreetMatrix, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { computeReachResult } from '../src/server/reach.mjs'
import { nativeReachRangeRequest, studioReachRange } from '../src/server/studio-reach-ranges.mjs'
import { serviceEpochSeconds } from '../src/server/gtfs/service-clock.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-bike-'))
const city = path.join(directory, 'city')
const stores = new Set()
function streetStore(target) {
  const file = path.join(target, 'osm/street-index.sqlite')
  stores.add(file)
  return file
}
const store = streetStore(city)
const query = { mode: 'bike', origin: [-77.05,38.9], destination: [-77.03,38.91], time: '08:00', maxStreetKm: 10, maxWalkKm: 0.001 }
let server, serverClosed
function run(kind, request, targetCity = city) {
  const child = spawnSync(binary, [kind, '--city', targetCity, '--request', '-'], { input: JSON.stringify(request), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout)
}
try {
  const inputs = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`,
    '--street-modes=walk,bike', `--output=${city}`], { cwd: root, stdio: ['ignore','ignore','pipe'] })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(city,'network.json'),'utf8')).modes, ['transit','walk','bike'])
  const db = new DatabaseSync(store, { readOnly: true })
  assert(db.prepare('SELECT count(*) AS n FROM bike_edges').get().n > 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='edges'").get().n, 0, 'Bike survives ordinary source-graph compaction')
  db.close()
  const preparation = run('native', { operation: 'bike.prepare' }).result
  assert.equal(preparation.ready, true)
  assert.equal(preparation.journeys, undefined)
  const route = run('route', query)
  assert.equal(route.status, 'ok')
  assert(route.journey.legs.some(l => l.type === 'bike'))
  assert(route.journey.cyclingSeconds > 0)
  assert.equal(route.journey.waitingSeconds, 0)
  const reverse = run('route', { ...query, origin: query.destination, destination: query.origin })
  assert.equal(reverse.status, 'ok')
  const arrive = run('route', { ...query, timePreference: 'arrive_by', time: '09:00' })
  assert.equal(arrive.journey.arrivalTime, '09:00:00')
  assert.equal(arrive.journey.durationSeconds, route.journey.durationSeconds)
  const matrix = run('matrix', { mode: 'bike', origins: [query.origin], destinations: [query.destination], time: '08:00' })
  assert.equal(matrix.status, 'ok')
  const ordered = run('route', { ...query, via:[[-77.04,38.905]] })
  assert.equal(ordered.status,'ok'); assert(ordered.journey.cyclingSeconds > 0)
  const residentRequests = [{kind:'info'}, {...query,kind:'route'}, {kind:'info'},
    {...query,kind:'route',bike:{profile:'quiet'}}, {kind:'info'}]
  const resident = spawnSync(binary,['stream','--city',city],{input:residentRequests.map(q=>JSON.stringify(q)).join('\n')+'\n',encoding:'utf8',
    env:{...process.env,VIGO_PREPARE:'none'}})
  assert.equal(resident.status,0,resident.stderr)
  const replies=resident.stdout.trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(replies[0].memory.ledger.bike,null,'Without preparation, bike must remain unloaded before its first query')
  assert(replies[2].memory.ledger.bike.networkHeapBytes > 0)
  assert.equal(replies[4].memory.ledger.bike.networkHeapBytes,replies[2].memory.ledger.bike.networkHeapBytes,'Profiles share one graph')
  // A resident stream prepares bike on opening; its answers are those of an on-demand open.
  const answer = reply => { const { sequence, meta, ...rest } = reply; const { computeUs, requestId, ...kept } = meta ?? {}; return JSON.stringify({ ...rest, meta: kept }) }
  const preparing = spawn(binary,['stream','--city',city],{stdio:['pipe','pipe','pipe']})
  const preparedReplies = []
  let pendingLine = ''
  const nextReply = () => new Promise((resolve, reject) => {
    const take = () => { const newline = pendingLine.indexOf('\n'); if (newline < 0) return false; const line = pendingLine.slice(0, newline); pendingLine = pendingLine.slice(newline + 1); resolve(JSON.parse(line)); return true }
    if (take()) return
    const timer = setTimeout(() => reject(new Error('Prepared stream did not answer')), 30000)
    preparing.stdout.on('data', function data(chunk) { pendingLine += chunk; if (take()) { clearTimeout(timer); preparing.stdout.off('data', data) } })
  })
  let ledger = null
  for (let attempt = 0; attempt < 200 && !ledger; attempt++) {
    preparing.stdin.write(JSON.stringify({kind:'info'}) + '\n')
    ledger = (await nextReply()).memory.ledger.bike
    if (!ledger) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert(ledger?.networkHeapBytes > 0, 'A resident stream must open bike before its first bike query')
  assert(ledger.hierarchyHeapBytes > 0, 'A resident stream must prepare the default bike hierarchy before its first bike query')
  for (const request of residentRequests.filter(q => q.kind === 'route')) {
    preparing.stdin.write(JSON.stringify(request) + '\n')
    preparedReplies.push(await nextReply())
  }
  preparing.stdin.end()
  assert.equal(await new Promise(resolve => preparing.once('close', resolve)), 0)
  assert.deepEqual(preparedReplies.map(answer), [replies[1], replies[3]].map(answer), 'Preparation must not change bike answers')
  const invalid = spawnSync(binary,['stream','--city',city],{input:'',encoding:'utf8',env:{...process.env,VIGO_PREPARE:'yes'}})
  assert.notEqual(invalid.status,0); assert.match(invalid.stderr,/VIGO_PREPARE must be all, none, or a comma-separated list/)
  const requestPath = path.join(directory,'query.json'); fs.writeFileSync(requestPath,JSON.stringify(query))
  const cli = JSON.parse(execFileSync(process.execPath,['public/vigo.mjs','route',`--city=${city}`,`--request=${requestPath}`],{cwd:root,encoding:'utf8'}))
  assert.equal(cli.status,'ok')
  assert.equal(cli.journey.durationSeconds, route.journey.durationSeconds)
  fs.writeFileSync(requestPath,JSON.stringify({ mode:'bike',origins:[query.origin],destinations:[query.destination],time:'08:00' }))
  const cliMatrix = JSON.parse(execFileSync(process.execPath,['public/vigo.mjs','matrix',`--city=${city}`,`--request=${requestPath}`],{cwd:root,encoding:'utf8'}))
  assert.equal(cliMatrix.status,'ok')
  const body = { mode:'bike', origin:{coordinate:query.origin,label:'A'},destination:{coordinate:query.destination,label:'B'},maxWalkKm:0.001,departMinutes:480 }
  const plan = routeNationalStreetStore(store,body)
  assert.equal(plan.travelMode,'bike'); assert(plan.legs.some(l=>l.type==='bike'))
  assert(Math.abs(plan.durationMinutes*60-route.journey.durationSeconds)<1)
  const nodeMatrix = routeNationalStreetMatrix(store,{ ...body,origins:[body.origin],destinations:[body.destination] })
  assert.equal(nodeMatrix.rows[0].status,'ready')
  for (const patch of [{bike:{speedKph:0}},{bike:{profile:'invented'}},{bike:{unknown:true}},{traffic:{}}]) {
    const r=spawnSync(binary,['route','--city',city,'--request','-'],{input:JSON.stringify({...query,...patch}),encoding:'utf8'})
    assert.notEqual(r.status,0,JSON.stringify(patch))
  }
  // Facility direction survives PBF import, final junction propagation, and
  // native/Node route queries. Pushing is prohibited to expose LTS filtering.
  for (const [name,tags,lowDirection] of [
    ['contraflow',{oneway:'yes','cycleway:left':'track','cycleway:left:oneway':'-1'},'backward'],
    ['reverse-contraflow',{oneway:'-1','cycleway:right':'lane','cycleway:right:oneway':'yes'},'forward'],
    ['opposite-track',{oneway:'yes',cycleway:'opposite_track'},'backward'],
  ]) {
    const dir=path.join(directory,name);fs.mkdirSync(dir)
    const fixture=await writeCliFixtureInputs(dir,{terminalAccess:true,terminalWayTags:{10:{highway:'primary',foot:'no',...tags}}})
    const target=path.join(dir,'city')
    execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${fixture.gtfsPath}`,`--osm=${fixture.osmPath}`,
      '--street-modes=walk,bike',`--output=${target}`],{cwd:root,stdio:['ignore','ignore','pipe']})
    for (const direction of ['forward','backward']) {
      const request={...query,maxWalkKm:0,bike:{maxLts:3},
        ...(direction==='backward'?{origin:query.destination,destination:query.origin}:{})}
      assert.equal(run('route',request,target).status,direction===lowDirection?'ok':'not_found',name+direction)
      assert.equal(run('route',{...request,bike:{}},target).status,'ok',name+direction+' access')
      const node=routeNationalStreetStore(streetStore(target),{...body,
        origin:{coordinate:request.origin},destination:{coordinate:request.destination},maxWalkKm:0,bike:request.bike})
      assert.equal(node.status==='ready',direction===lowDirection,name+direction+' Node LTS')
    }
  }
  {
    const dir=path.join(directory,'timed-facility');fs.mkdirSync(dir)
    const fixture=await writeCliFixtureInputs(dir,{terminalAccess:true,terminalWayTags:{10:{highway:'primary',foot:'no',oneway:'yes',
      'oneway:bicycle':'no',cycleway:'lane','oneway:conditional':'-1 @ (We 08:00-09:00)'}}})
    const target=path.join(dir,'city')
    execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${fixture.gtfsPath}`,`--osm=${fixture.osmPath}`,
      '--street-modes=walk,bike',`--output=${target}`],{cwd:root,stdio:['ignore','ignore','pipe']})
    for (const time of ['07:00','08:00']) for (const backward of [false,true]) {
      const request={...query,time,serviceDate:'2026-07-15',maxWalkKm:0,bike:{profile:'fast',maxLts:3},
        ...(backward?{origin:query.destination,destination:query.origin}:{})}
      const result=run('route',request,target)
      assert.equal(result.status,'ok')
      const waits=backward!==(time==='08:00')
      assert.equal(result.journey.waitingSeconds>3000,waits)
      if (!waits) assert.equal(result.journey.waitingSeconds,0)
      const matrix=run('matrix',{...request,origin:undefined,destination:undefined,
        origins:[request.origin],destinations:[request.destination]},target)
      assert(Math.abs(matrix.durationsSeconds[0][0]-result.journey.durationSeconds)<=1)
    }
  }
  const timedInputs = path.join(directory,'timed-inputs'); fs.mkdirSync(timedInputs)
  const timedCity = path.join(directory,'timed-city')
  const timed = await writeCliFixtureInputs(timedInputs,{bikeConditionalTurn:true})
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${timed.gtfsPath}`,`--osm=${timed.osmPath}`,
    '--street-modes=walk,bike',`--output=${timedCity}`],{cwd:root,stdio:['ignore','ignore','pipe']})
  const timedStore = streetStore(timedCity)
  const timedDb = new DatabaseSync(timedStore,{readOnly:true})
  assert.equal(timedDb.prepare('SELECT count(*) n FROM bike_turn_windows').get().n,5)
  timedDb.close()
  const dated = {...query,serviceDate:'2026-07-15',maxWalkKm:0,bike:{profile:'fast'}}
  const before = run('route',{...dated,time:'07:00'},timedCity)
  const waiting = run('route',{...dated,time:'08:00'},timedCity)
  assert.equal(waiting.status,'ok')
  assert(waiting.journey.waitingSeconds > 3000 && waiting.journey.waitingSeconds < 3600)
  assert(Math.abs(waiting.journey.cyclingSeconds-before.journey.cyclingSeconds)<=1,'Splitting legs can change whole-second rounding by one second')
  assert.equal(waiting.journey.legs.length,2)
  assert.equal(waiting.journey.legs[1].departureTime,'09:00:00')
  assert(run('route',{...dated,time:'07:59'},timedCity).journey.waitingSeconds>0,'Restriction starts after departure but before the turn')
  assert.equal(run('route',{...dated,serviceDate:'2026-07-18'},timedCity).journey.waitingSeconds,0)
  assert.equal(run('route',query,timedCity).status,'not_found','Undated turns remain conservative')
  const timedArrival=run('route',{...dated,timePreference:'arrive_by',time:'10:00',diagnostics:'trace'},timedCity)
  assert.equal(timedArrival.status,'ok','Arrival after the timed restriction has ended must use the legal turn')
  assert.equal(timedArrival.journey.arrivalTime,'10:00:00')
  assert.equal(timedArrival.journey.waitingSeconds,0)
  assert.equal(timedArrival.trace.diagnostics.timingPolicy,'dated_arrive_by_verified')
  assert(Math.abs(timedArrival.journey.durationSeconds-before.journey.durationSeconds)<=1)
  const timedArrivalMatrix=run('matrix',{...dated,timePreference:'arrive_by',time:'10:00',
    origin:undefined,destination:undefined,origins:[dated.origin],destinations:[dated.destination]},timedCity)
  assert(Math.abs(timedArrivalMatrix.durationsSeconds[0][0]-timedArrival.journey.durationSeconds)<1)
  const timedMatrix = run('matrix',{...dated,origin:undefined,destination:undefined,origins:[dated.origin],destinations:[dated.destination]},timedCity)
  assert(Math.abs(timedMatrix.durationsSeconds[0][0]-waiting.journey.durationSeconds)<1)
  const via = run('route',{...dated,via:[[-77.035,38.9075]]},timedCity)
  assert.equal(via.status,'ok')
  assert(Math.abs(via.journey.durationSeconds-waiting.journey.durationSeconds)<=1)
  const nodeDated = { ...body,serviceDate:'2026-07-15',timeZone:'America/New_York',maxWalkKm:0,bike:{profile:'fast'} }
  const timedPlan = routeNationalStreetStore(timedStore,nodeDated)
  assert(Math.abs(timedPlan.durationMinutes*60-waiting.journey.durationSeconds)<1)
  assert(Math.abs(timedPlan.waitMinutes*60-waiting.journey.waitingSeconds)<1)
  const timedNodeMatrix = routeNationalStreetMatrix(timedStore,{...nodeDated,origins:[nodeDated.origin],destinations:[nodeDated.destination]})
  assert(Math.abs(timedNodeMatrix.rows[0].durationMinutes*60-waiting.journey.durationSeconds)<1)
  const arrivalNode={...nodeDated,timePreference:'arrive',arriveMinutes:600}
  const arrivalNodePlan=routeNationalStreetStore(timedStore,arrivalNode)
  assert(Math.abs(arrivalNodePlan.durationMinutes*60-timedArrival.journey.durationSeconds)<1)
  assert.equal(arrivalNodePlan.arriveMinutes,600)
  const arrivalNodeMatrix=routeNationalStreetMatrix(timedStore,{...arrivalNode,origins:[arrivalNode.origin],destinations:[arrivalNode.destination]})
  assert(Math.abs(arrivalNodeMatrix.rows[0].durationMinutes*60-timedArrival.journey.durationSeconds)<1)
  // A closed turn can require arriving early. Route shows actual travel;
  // Matrix measures departure-to-deadline, including the terminal slack.
  const early=run('route',{...dated,timePreference:'arrive_by',time:'08:30',diagnostics:'trace'},timedCity)
  assert.equal(early.status,'ok')
  assert.equal(early.trace.diagnostics.timingPolicy,'dated_arrive_by_verified')
  assert(early.trace.diagnostics.earlyArrivalSeconds > 1000)
  assert(early.journey.arrivalTime < '08:30:00')
  assert.equal(early.journey.waitingSeconds,0)
  assert(Math.abs(early.journey.durationSeconds-before.journey.durationSeconds)<=1)
  const earlyMatrix=run('matrix',{...dated,timePreference:'arrive_by',time:'08:30',
    origin:undefined,destination:undefined,origins:[dated.origin],destinations:[dated.destination]},timedCity)
  assert(Math.abs(earlyMatrix.durationsSeconds[0][0]-early.journey.durationSeconds-early.trace.diagnostics.earlyArrivalSeconds)<2)
  const earlyNode={...nodeDated,timePreference:'arrive',arriveMinutes:510}
  const earlyPlan=routeNationalStreetStore(timedStore,earlyNode)
  assert(earlyPlan.arriveMinutes < 510)
  assert(Math.abs(earlyPlan.durationMinutes*60-early.journey.durationSeconds)<1)
  const earlyNodeMatrix=routeNationalStreetMatrix(timedStore,{...earlyNode,origins:[earlyNode.origin],destinations:[earlyNode.destination]})
  assert(Math.abs(earlyNodeMatrix.rows[0].durationMinutes*60-earlyMatrix.durationsSeconds[0][0])<1)
  disposeNationalOsmStore(timedStore)
  const roadInputs=path.join(directory,'road-inputs');fs.mkdirSync(roadInputs)
  const roadCity=path.join(directory,'road-city')
  const road=await writeCliFixtureInputs(roadInputs,{terminalWayTags:{10:{'bicycle:conditional':'no @ (Mo-Fr 08:00-09:00)'}}})
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${road.gtfsPath}`,`--osm=${road.osmPath}`,
    '--street-modes=walk,bike',`--output=${roadCity}`],{cwd:root,stdio:['ignore','ignore','pipe']})
  const roadStore=streetStore(roadCity)
  const roadDb=new DatabaseSync(roadStore,{readOnly:true})
  assert.equal(roadDb.prepare('SELECT count(*) n FROM bike_edges').get().n,0)
  assert.equal(roadDb.prepare('SELECT count(*) n FROM bike_timed_edges').get().n,4)
  roadDb.close()
  const roadOpen=run('route',{...dated,time:'09:00'},roadCity)
  const roadWait=run('route',dated,roadCity)
  assert.equal(roadWait.status,'ok')
  assert.equal(roadWait.journey.waitingSeconds,3600)
  assert.equal(roadWait.journey.departureTime,'08:00:00')
  assert.equal(roadWait.journey.legs[0].departureTime,'09:00:00')
  assert.equal(roadWait.journey.durationSeconds,roadOpen.journey.durationSeconds+3600)
  assert.equal(run('route',query,roadCity).status,'not_found')
  const roadArrival=run('route',{...dated,timePreference:'arrive_by',time:'10:00',diagnostics:'trace'},roadCity)
  assert.equal(roadArrival.status,'ok')
  assert.equal(roadArrival.journey.arrivalTime,'10:00:00')
  assert.equal(roadArrival.journey.durationSeconds,roadOpen.journey.durationSeconds)
  assert.equal(roadArrival.trace.diagnostics.timingPolicy,'dated_arrive_by_verified')
  assert.equal(run('route',{...dated,serviceDate:'2026-07-18'},roadCity).journey.waitingSeconds,0)
  const roadMatrix=run('matrix',{...dated,origin:undefined,destination:undefined,origins:[dated.origin],destinations:[dated.destination]},roadCity)
  assert(Math.abs(roadMatrix.durationsSeconds[0][0]-roadWait.journey.durationSeconds)<1)
  const roadPlan=routeNationalStreetStore(roadStore,nodeDated)
  assert.equal(roadPlan.waitMinutes,60)
  assert(Math.abs(roadPlan.durationMinutes*60-roadWait.journey.durationSeconds)<1)
  const roadVia=run('route',{...dated,via:[[-77.04,38.905]]},roadCity)
  assert.equal(roadVia.journey.durationSeconds,roadWait.journey.durationSeconds)
  disposeNationalOsmStore(roadStore)
  const viaInputs=path.join(directory,'via-inputs');fs.mkdirSync(viaInputs)
  const viaCity=path.join(directory,'via-city')
  const viaFiles=await writeCliFixtureInputs(viaInputs,{bikeConditionalTurn:'via'})
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${viaFiles.gtfsPath}`,`--osm=${viaFiles.osmPath}`,
    '--street-modes=walk,bike',`--output=${viaCity}`],{cwd:root,stdio:['ignore','ignore','pipe']})
  const viaStore=streetStore(viaCity)
  const viaDb=new DatabaseSync(viaStore,{readOnly:true})
  assert.equal(viaDb.prepare('SELECT count(*) n FROM bike_way_turns').get().n,1)
  assert(viaDb.prepare('SELECT count(*) n FROM bike_turn_windows WHERE turn_table=1').get().n>0)
  viaDb.close()
  const viaWait=run('route',{...dated,diagnostics:'trace'},viaCity)
  assert.equal(viaWait.status,'ok');assert.equal(viaWait.trace.diagnostics.timingPolicy,'dated_turns')
  assert(viaWait.journey.waitingSeconds>2500)
  assert(viaWait.journey.waitingSeconds<waiting.journey.waitingSeconds,'Via-way no-turn waits at the final movement')
  assert.equal(run('route',query,viaCity).status,'not_found')
  const viaArrival=run('route',{...dated,timePreference:'arrive_by',time:'10:00',diagnostics:'trace'},viaCity)
  assert.equal(viaArrival.status,'ok')
  assert.equal(viaArrival.journey.arrivalTime,'10:00:00')
  assert.equal(viaArrival.journey.waitingSeconds,0)
  assert.equal(viaArrival.trace.diagnostics.timingPolicy,'dated_arrive_by_verified')
  assert.equal(run('route',{...dated,serviceDate:'2026-07-18'},viaCity).journey.waitingSeconds,0)
  const viaMatrix=run('matrix',{...dated,origin:undefined,destination:undefined,origins:[dated.origin],destinations:[dated.destination]},viaCity)
  assert(Math.abs(viaMatrix.durationsSeconds[0][0]-viaWait.journey.durationSeconds)<1)
  const viaPlan=routeNationalStreetStore(viaStore,nodeDated)
  assert(Math.abs(viaPlan.durationMinutes*60-viaWait.journey.durationSeconds)<1)
  assert(Math.abs(viaPlan.waitMinutes*60-viaWait.journey.waitingSeconds)<1)
  for (const via of [[[-77.04,38.905]], [[-77.035,38.9075]], [[-77.0375,38.90625]],
    [[-77.04,38.905],[-77.04,38.905],[-77.035,38.9075]]]) {
    const ordered = run('route',{...dated,via},viaCity)
    assert.equal(ordered.status,'ok')
    assert(Math.abs(ordered.journey.durationSeconds-viaWait.journey.durationSeconds)<2)
    assert(Math.abs(ordered.journey.waitingSeconds-viaWait.journey.waitingSeconds)<2)
    assert.equal(run('route',{...query,via},viaCity).status,'not_found')
    assert.equal(run('route',{...dated,via,timePreference:'arrive_by',time:'10:00'},viaCity).status,'not_found')
    const plan=routeNationalStreetStore(viaStore,{...nodeDated,waypoints:via.map(coordinate=>({coordinate}))})
    assert.equal(plan.status,'ready')
    assert(plan.title.startsWith('Bike via'))
    assert.equal(plan.diagnostics.optimality,'sequential_segment_choices')
    assert.equal(plan.legs[0].orderedSegmentIndex,0)
    assert.equal(plan.legs.at(-1).orderedSegmentIndex,via.length)
    assert(Math.abs(plan.durationMinutes*60-viaWait.journey.durationSeconds)<2)
    assert(Math.abs(plan.waitMinutes*60-viaWait.journey.waitingSeconds)<2)
  }
  const nodeVia=run('route',{...dated,via:[[-77.04,38.905]]},timedCity)
  assert.equal(nodeVia.journey.durationSeconds,waiting.journey.durationSeconds)
  disposeNationalOsmStore(viaStore)
  const stressInputs=path.join(directory,'stress-inputs');fs.mkdirSync(stressInputs)
  const stressCity=path.join(directory,'stress-city')
  const stressFiles=await writeCliFixtureInputs(stressInputs,{terminalWayTags:{10:{lts:'4'}}})
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${stressFiles.gtfsPath}`,`--osm=${stressFiles.osmPath}`,
    '--street-modes=walk,bike',`--output=${stressCity}`],{cwd:root,stdio:['ignore','ignore','pipe']})
  const stressStore=streetStore(stressCity)
  const stressDb=new DatabaseSync(stressStore,{readOnly:true})
  assert.equal(stressDb.prepare("SELECT value FROM metadata WHERE key='bikeStressVersion'").get().value,'1')
  assert(stressDb.prepare('SELECT stress FROM bike_edges').all().every(row=>row.stress===12))
  stressDb.close()
  const stressRequest={...query,maxWalkKm:0,bike:{profile:'fast',maxLts:1},diagnostics:'trace'}
  const stressRoute=run('route',stressRequest,stressCity)
  assert.equal(stressRoute.status,'ok')
  assert.equal(stressRoute.journey.cyclingSeconds,undefined)
  assert(stressRoute.journey.walkingSeconds>1500)
  assert(stressRoute.trace.legs.every(leg=>leg.geometrySource==='osm-low-stress'))
  assert.equal(stressRoute.trace.diagnostics.trafficStress.maximumCyclingLevel,1)
  const stressMatrix=run('matrix',{...stressRequest,origin:undefined,destination:undefined,
    origins:[query.origin],destinations:[query.destination]},stressCity)
  assert(Math.abs(stressMatrix.durationsSeconds[0][0]-stressRoute.journey.durationSeconds)<1)
  const stressNodeRequest={...body,maxWalkKm:0,bike:{profile:'fast',maxLts:1}}
  const stressPlan=routeNationalStreetStore(stressStore,stressNodeRequest)
  assert.equal(stressPlan.status,'ready')
  assert(stressPlan.legs.every(leg=>leg.type==='walk'&&leg.geometrySource==='osm-low-stress'))
  assert(Math.abs(stressPlan.durationMinutes*60-stressRoute.journey.durationSeconds)<1)
  const stressVia=run('route',{...stressRequest,via:[[-77.04,38.905]]},stressCity)
  assert.equal(stressVia.journey.durationSeconds,stressRoute.journey.durationSeconds)
  const stressAll=run('route',{...query,bike:{profile:'fast',maxLts:4}},stressCity)
  assert(stressAll.journey.cyclingSeconds>0)
  assert.equal(stressAll.journey.durationSeconds,run('route',{...query,bike:{profile:'fast'}},stressCity).journey.durationSeconds)
  disposeNationalOsmStore(stressStore)
  const deniedInputs=path.join(directory,'stress-denied-inputs');fs.mkdirSync(deniedInputs)
  const deniedCity=path.join(directory,'stress-denied-city')
  const deniedFiles=await writeCliFixtureInputs(deniedInputs,{terminalAccess:true,terminalWayTags:{10:{lts:'4',foot:'no'}}})
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${deniedFiles.gtfsPath}`,`--osm=${deniedFiles.osmPath}`,
    '--street-modes=walk,bike',`--output=${deniedCity}`],{cwd:root,stdio:['ignore','ignore','pipe']})
  assert.equal(run('route',stressRequest,deniedCity).status,'not_found')
  assert.equal(run('route',query,deniedCity).status,'ok')
  const bounds=[-77.051,38.899,-77.029,38.911], size=16
  const studio = await computeReachResult({ mode:'bike', origin:{coordinate:query.origin}, departMinutes:480,
    serviceDate:'2026-07-15', maxWalkKm:.3, rasterSize:48, radiusKm:2, cutoffsMinutes:[15,60],
    bike:{profile:'quiet',speedKph:23,maxLts:1}, includePreliminary:false }, {
    runReach: async range => {
      const nativeRequest=nativeReachRangeRequest(range)
      const child=spawnSync(binary,['stream','--stream-output=detailed','--city',stressCity],
        {input:JSON.stringify(nativeRequest)+'\n',encoding:'utf8'})
      assert.equal(child.status,0,child.stderr)
      const raw=JSON.parse(child.stdout)
      assert.equal(raw.status,'ok',JSON.stringify(raw))
      return studioReachRange(raw.trace,range)
    },
  })
  assert.deepEqual(studio.request.bike,{profile:'quiet',speedKph:23,maxLts:1})
  assert.equal(studio.surface.raster.width,48)
  assert(studio.surface.areaMetrics.baseline.byCutoff.at(-1).reachablePixels>0)
  const cells=Array.from({length:size*size},(_,i)=>[bounds[0]+((i%size)+.5)/size*(bounds[2]-bounds[0]),
    bounds[3]-(Math.floor(i/size)+.5)/size*(bounds[3]-bounds[1])])
  for(const [reachCity,profile,maxLts,arrive,clockTime,serviceDate] of [[stressCity,'fast',1,false],[stressCity,'quiet',4,false],
    [viaCity,'balanced',undefined,false],[viaCity,'quiet',undefined,true],
    [timedCity,'balanced',undefined,false],[roadCity,'quiet',undefined,false],
    [stressCity,'balanced',1,true],[roadCity,'balanced',undefined,true,'08:30'],
    [roadCity,'balanced',undefined,true,'00:00'],
    [roadCity,'balanced',undefined,true,'00:15','2026-03-08'],
    [roadCity,'balanced',undefined,true,'00:15','2026-03-09'],
    [roadCity,'balanced',undefined,true,'00:15','2026-11-01'],
    [roadCity,'balanced',undefined,true,'00:15','2026-11-02']]) {
    const parameters={mode:'bike',time:clockTime??'08:00',serviceDate:serviceDate??'2026-07-15',maxWalkKm:.3,
      timePreference:arrive?'arrive_by':'depart_at',bike:{profile,maxLts}}
    const reach=run('reach',{...parameters,...(arrive?{destination:query.destination}:{origin:query.origin}),
      cutoffsMinutes:[15,60],rasterSize:size,bounds,reachFormat:'surface',diagnostics:'trace'},reachCity)
    assert.equal(reach.status,'ok');assert.equal(reach.mode,'bike')
    assert.equal(reach.trace.surface.sampling,'cell-center')
    assert.equal(reach.trace.diagnostics.bike.algorithm,'bike_movement_cch_surface')
    const matrix=run('matrix',{...parameters,maxStreetKm:750,
      origins:arrive?cells:[query.origin],destinations:arrive?[query.destination]:cells},reachCity)
    const expected=arrive?matrix.durationsSeconds.map(row=>row[0]):matrix.durationsSeconds[0]
    if (clockTime?.startsWith('00:')) {
      const prior=new Date(`${parameters.serviceDate}T12:00:00Z`)
      prior.setUTCDate(prior.getUTCDate()-1)
      const clockDate=prior.toISOString().slice(0,10)
      assert.equal(reach.trace.clockDate,clockDate)
      const i=expected.findIndex(seconds=>seconds!==null&&seconds<=3600)
      assert(i>=0)
      const route=run('route',{...parameters,origin:cells[i],destination:query.destination,
        maxStreetKm:750,diagnostics:'trace'},reachCity)
      assert.equal(route.status,'ok')
      assert.equal(route.trace.clockDate,clockDate)
      assert(Math.abs(route.journey.durationSeconds-expected[i])<1)
      const requested=serviceEpochSeconds(parameters.serviceDate,'America/New_York')+Number(clockTime.slice(3))*60
      const actual=serviceEpochSeconds(clockDate,'America/New_York')+route.trace.arrivalMinutes*60
      assert(Math.abs(requested-actual)<.001,'Rebasing must preserve the absolute deadline across DST')
      const nodeRequest={mode:'bike',serviceDate:parameters.serviceDate,timeZone:'America/New_York',
        timePreference:'arrive',arriveMinutes:Number(clockTime.slice(3)),maxWalkKm:.3,maxStreetKm:750,
        bike:parameters.bike,origin:{coordinate:cells[i]},destination:{coordinate:query.destination}}
      const plan=routeNationalStreetStore(roadStore,nodeRequest)
      assert.equal(plan.status,'ready')
      assert.equal(plan.arriveMinutes,nodeRequest.arriveMinutes)
      assert(Math.abs(plan.durationMinutes*60-expected[i])<1)
      const nodeMatrix=routeNationalStreetMatrix(roadStore,{...nodeRequest,
        origins:[nodeRequest.origin],destinations:[nodeRequest.destination]})
      assert(Math.abs(nodeMatrix.rows[0].durationMinutes*60-expected[i])<1)
      disposeNationalOsmStore(roadStore)
    }
    for(const [i,seconds] of expected.entries()) {
      const value=reach.surface.valuesSeconds[i]
      if(seconds===null||seconds>3600) assert.equal(value,null,`Reach cell ${i}`)
      else assert(Math.abs(value-seconds)<.061,`Reach cell ${i}: ${value} vs ${seconds}`)
    }
    assert(reach.surface.valuesSeconds.some(v=>v!==null))
    assert.equal(reach.trace.surface.edges,null)
  }
  // A preferred detour can exceed the displayed cutoff while a more stressful
  // route fits. The cutoff must not silently change the preference optimum.
  const detourInputs=path.join(directory,'detour-inputs');fs.mkdirSync(detourInputs)
  const detourCity=path.join(directory,'detour-city')
  const detour=await writeCliFixtureInputs(detourInputs,{bikePreferenceDetour:true})
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${detour.gtfsPath}`,`--osm=${detour.osmPath}`,
    '--street-modes=walk,bike',`--output=${detourCity}`],{cwd:root,stdio:['ignore','ignore','pipe']})
  const detourBounds=[-77.051,38.899,-77.019,38.931]
  const detourCells=Array.from({length:256},(_,i)=>[detourBounds[0]+((i%16)+.5)/16*(detourBounds[2]-detourBounds[0]),
    detourBounds[3]-(Math.floor(i/16)+.5)/16*(detourBounds[3]-detourBounds[1])])
  const detourStore=streetStore(detourCity)
  for (const profile of ['quiet','balanced','fast']) for (const time of ['01:00','08:00']) {
    const preferences={mode:'bike',serviceDate:'2026-07-15',time,timePreference:'arrive_by',
      maxWalkKm:0,bike:{profile},destination:[-76.95,38.9]}
    const detourRoute=run('route',{...preferences,origin:detourCells[240],diagnostics:'trace'},detourCity)
    assert.equal(detourRoute.status,'ok')
    if (profile==='fast') assert(detourRoute.journey.durationSeconds<2700)
    else assert(detourRoute.journey.durationSeconds>3600,'Comfort preferences choose the longer cycleway')
    const nodeRequest={...preferences,timePreference:'arrive',arriveMinutes:time==='01:00'?60:480,
      timeZone:'America/New_York',origin:{coordinate:detourCells[240]},destination:{coordinate:preferences.destination}}
    const nodePlan=routeNationalStreetStore(detourStore,nodeRequest)
    assert.equal(nodePlan.status,'ready')
    assert(Math.abs(nodePlan.durationMinutes*60-detourRoute.journey.durationSeconds)<1)
    const detourMatrix=run('matrix',{...preferences,destination:undefined,origins:detourCells,
      destinations:[preferences.destination],maxStreetKm:750},detourCity)
    for (const cutoff of [45,120]) {
      const detourReach=run('reach',{...preferences,cutoffsMinutes:[cutoff],rasterSize:16,bounds:detourBounds,
        reachFormat:'surface',diagnostics:'trace'},detourCity)
      for(const [i,row] of detourMatrix.durationsSeconds.entries()) {
        const expected=row[0]===null||row[0]>cutoff*60?null:row[0]
        assert.equal(detourReach.surface.valuesSeconds[i],expected,`Preference/cutoff cell ${i}: ${profile}, ${time}, ${cutoff}`)
      }
      assert.equal(detourReach.trace.clockDate,detourRoute.trace.clockDate,
        'A display cutoff must not change the default point search clock')
    }
  }
  disposeNationalOsmStore(detourStore)
  // Preserve long source segments without introducing synthetic graph nodes.
  for (const timed of [false,true,'bike-only']) {
    const input=path.join(directory,`long-inputs-${timed}`);fs.mkdirSync(input)
    const target=path.join(directory,`long-city-${timed}`)
    const files=await writeCliFixtureInputs(input,{bikePreferenceDetour:'sparse',terminalWayTags:{50:{
      highway:timed==='bike-only'?'cycleway':'secondary',cycleway:'track',maxspeed:'40',
      ...(timed==='bike-only'?{foot:'no'}:{}),
      ...(timed?{'bicycle:conditional':'no @ (Mo-Fr 08:00-09:00)'}:{})}}})
    execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${files.gtfsPath}`,`--osm=${files.osmPath}`,
      '--street-modes=walk,drive,bike',`--output=${target}`],{cwd:root,stdio:['ignore','ignore','pipe']})
    const targetStore=streetStore(target)
    const db=new DatabaseSync(targetStore,{readOnly:true})
    const edges=db.prepare(`SELECT * FROM ${timed?'bike_timed_edges':'bike_edges'} WHERE way_id=50`).all()
    assert.equal(edges.length,2)
    assert(edges.every(edge=>edge.distance_cm>1_000_000))
    assert.equal(db.prepare('SELECT count(*) n FROM bike_nodes').get().n,5,'Keep original OSM nodes')
    db.close()
    const base={serviceDate:'2026-07-15',time:'09:00',origin:query.origin,destination:[-77,39.03],maxStreetKm:50,maxWalkKm:0}
    for (const mode of timed==='bike-only'?['bike']:['walk','drive','bike']) {
      const forward=run('route',{...base,mode},target)
      assert.equal(forward.status,'ok',`${mode} must preserve the long road`)
      assert(forward.journey.legs.some(leg=>leg.distanceMeters>10_000))
      const reverse=run('route',{...base,mode,origin:base.destination,destination:base.origin},target)
      assert.equal(reverse.status,mode==='walk'?'ok':'not_found','Preserve each mode\'s directions')
      if(mode!=='walk') {
        const middle=run('route',{...base,mode,origin:[-77.025,38.965]},target)
        assert.equal(middle.status,'ok')
        assert(Math.abs(middle.journey.durationSeconds*2-forward.journey.durationSeconds)<2,'Project onto the long segment interior')
      }
      if (mode==='bike'&&timed) {
        const waiting=run('route',{...base,mode,time:'08:30'},target)
        assert.equal(waiting.status,'ok');assert.equal(waiting.journey.waitingSeconds,1800)
        const node=routeNationalStreetStore(targetStore,{mode,serviceDate:base.serviceDate,timeZone:'America/New_York',
          departMinutes:510,origin:{coordinate:base.origin},destination:{coordinate:base.destination},maxStreetKm:50,maxWalkKm:0})
        assert.equal(node.status,'ready');assert(Math.abs(node.durationMinutes*60-waiting.journey.durationSeconds)<1)
      }
    }
    disposeNationalOsmStore(targetStore)
  }
  for(const [httpCity,expectedWait,maxLts] of [[timedCity,waiting.journey.waitingSeconds],[roadCity,roadWait.journey.waitingSeconds],[viaCity,viaWait.journey.waitingSeconds],[stressCity,0,1]]) {
  server=spawn(binary,['serve','--city',httpCity,'--port','0'],{env:{PATH:'',VIGO_API_TOKEN:'bike-fixture-token',RAYON_NUM_THREADS:'2'}})
  serverClosed=new Promise(resolve=>server.once('close',resolve))
  const port=await new Promise((resolve,reject)=>{
    let text=''
    const timer=setTimeout(()=>reject(new Error('Bike HTTP startup timed out')),15000)
    server.stderr.on('data',data=>{text+=data;const match=text.match(/listening on 127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]))}})
    server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Bike HTTP exited ${code}: ${text}`))})
  })
  for(const [kind,request] of [['route',query],['matrix',{mode:'bike',origins:[query.origin],destinations:[query.destination],time:'08:00'}],
    ['reach',{mode:'bike',origin:query.origin,time:'08:00',bounds,rasterSize:16,cutoffsMinutes:[60],reachFormat:'surface'}]]) {
    const response=await fetch(`http://127.0.0.1:${port}/v1/${kind}`,{method:'POST',headers:{authorization:'Bearer bike-fixture-token','content-type':'application/json'},body:JSON.stringify({...request,serviceDate:'2026-07-15',maxWalkKm:0,bike:{profile:'fast',maxLts}}),signal:AbortSignal.timeout(10000)})
    assert.equal(response.status,200)
    const result=await response.json();assert.equal(result.status,'ok');assert.equal(result.mode,'bike')
    if(kind==='reach') assert.equal(result.surface.valuesSeconds.length,256)
    if(kind==='route'){assert((result.journey.cyclingSeconds??result.journey.walkingSeconds)>0);assert.equal(result.journey.waitingSeconds,expectedWait)}
    if(kind==='route') {
      const orderedResponse=await fetch(`http://127.0.0.1:${port}/v1/route`,{method:'POST',
        headers:{authorization:'Bearer bike-fixture-token','content-type':'application/json'},
        body:JSON.stringify({...dated,bike:{profile:'fast',maxLts},via:[[-77.04,38.905]]}),signal:AbortSignal.timeout(10000)})
      assert.equal(orderedResponse.status,200)
      const orderedResult=await orderedResponse.json()
      assert.equal(orderedResult.status,'ok')
      assert.equal(orderedResult.journey.waitingSeconds,expectedWait)
    }
  }
  if (maxLts === 1) for (const invalid of [null,0,5,1.5,'2']) for (const kind of ['route','reach']) {
    const response=await fetch(`http://127.0.0.1:${port}/v1/${kind}`,{method:'POST',
      headers:{authorization:'Bearer bike-fixture-token','content-type':'application/json'},
      body:JSON.stringify({...query,bike:{maxLts:invalid}}),signal:AbortSignal.timeout(10000)})
    assert.equal(response.status,400,`Invalid bike.maxLts=${JSON.stringify(invalid)}`)
  }
  server.kill();await serverClosed;server=undefined
  }
} finally {
  if(server){if(server.exitCode===null&&server.signalCode===null)server.kill();await serverClosed}
  // Every fixture opened through the Node adapter owns a cached SQLite reader.
  // Windows cannot remove the City until all readers have been disposed.
  for(const file of stores)disposeNationalOsmStore(file)
  fs.rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:50})
}
console.log('Bike import, compaction, native/Node/HTTP Route, Matrix and Reach, 6,400 grid/point comparisons including midnight/DST clocks and preference/cutoff trade-offs, ordered/arrive-by routes, lazy shared graph and validation passed.')
