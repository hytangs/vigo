import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {TimetableKernel}=require(process.env.VIGO_NATIVE_ROUTING_KERNEL??'../native/vigo-routing-kernel/vigo-routing-kernel.node')
const coverage={arrivalTiesWithDifferentBoardings:0,arrivalBoardingTiesWithDifferentWalking:0,deadlineBoardingTiesWithDifferentWalking:0}
let seed=0x43cafe
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/4294967296*n)}
const less=(a,b)=>!b||a.some((v,i)=>v!==b[i]&&a.slice(0,i).every((x,j)=>x===b[j])&&v<b[i])
function make(){
 const n=6,trips=[]
 for(let t=0;t<10;t++){
  const trip=[],length=2+rand(3);let time=rand(16)*5,stop=rand(n)
  for(let k=0;k<length;k++){trip.push({stop,time,pickup:rand(6)!==0,dropoff:rand(6)!==0});time+=rand(4)*5;stop=rand(n)}
  trips.push(trip)
 }
 const transfers=Array.from({length:n},(_,i)=>rand(2)?[{to:(i+1)%n,time:rand(3)*5}]:[])
 const minimums=Array.from({length:n},()=>rand(3)*5)
 // Distance and time vary independently. Candidate feasibility is applied
 // independently before either solver sees the allowed attachment set.
 const candidates=()=>Array.from({length:3},(_,i)=>({stop:rand(n),time:rand(4)*5,distance:rand(4)*100,id:i})).filter(x=>x.distance<=200)
 return {n,trips,transfers,minimums,origins:candidates(),destinations:candidates()}
}
function compile(f){
 const rows=[],tripStart=[0]
 f.trips.forEach((trip,t)=>{for(let i=1;i<trip.length;i++)rows.push({from:trip[i-1].stop,to:trip[i].stop,departure:trip[i-1].time,arrival:trip[i].time,trip:t,sequence:i,first:i===1,board:trip[i-1].pickup,alight:trip[i].dropoff});tripStart.push(rows.length)})
 const order=rows.map((_,i)=>i).filter(i=>rows[i].board).sort((a,b)=>rows[a].from-rows[b].from||rows[a].departure-rows[b].departure||a-b),offsets=[0],to=[],duration=[],transferOffset=[0]
 for(let i=0;i<f.n;i++){offsets.push(offsets.at(-1)+rows.filter(x=>x.from===i&&x.board).length);for(const e of f.transfers[i]){to.push(e.to);duration.push(e.time)}transferOffset.push(to.length)}
 const col=k=>new Uint32Array(rows.map(r=>r[k]));return {stopCount:f.n,runCount:f.trips.length,departureSeconds:col('departure'),arrivalSeconds:col('arrival'),fromStop:col('from'),toStop:col('to'),sequence:col('sequence'),segmentTrip:col('trip'),segmentRun:col('trip'),continuityBreak:new Uint8Array(rows.map(r=>+r.first)),canBoard:new Uint8Array(rows.map(r=>+r.board)),canAlight:new Uint8Array(rows.map(r=>+r.alight)),tripStart:new Uint32Array(tripStart),departureOffset:new Uint32Array(offsets),departureOrder:new Uint32Array(order),transferOffset:new Uint32Array(transferOffset),transferTo:new Uint32Array(to),transferDuration:new Uint32Array(duration),forbiddenSameStop:new Uint8Array(f.n),sameStopTransferMinimum:new Uint32Array(f.minimums)}
}
// Exhaustively enumerate legal WHOLE rides from raw trips. No dominance,
// production scan, production bounds or compiled connection arrays are used.
function oracle(f,departure,horizon,cap,deadline=Infinity){
 let best=null,visits=0
 function walk(stop,time,b,w){
  if(b){for(const d of f.destinations)if(d.stop===stop&&time+d.time<=deadline){const tuple=[time+d.time,b,w+d.time];if(best&&tuple[0]===best[0]){if(tuple[1]!==best[1])coverage.arrivalTiesWithDifferentBoardings++;else if(tuple[2]!==best[2])coverage.arrivalBoardingTiesWithDifferentWalking++}if(less(tuple,best))best=tuple}}
  if(b===cap)return
  const starts=[{stop,time:time+(b?f.minimums[stop]:0),w}]
  if(b)for(const e of f.transfers[stop])starts.push({stop:e.to,time:time+e.time,w:w+e.time})
  for(const start of starts)for(const trip of f.trips)for(let i=0;i<trip.length-1;i++){
   const board=trip[i];if(board.stop!==start.stop||!board.pickup||board.time<start.time||board.time>horizon)continue
   for(let j=i+1;j<trip.length;j++){const end=trip[j];if(!end.dropoff||end.time>horizon)continue;visits++;walk(end.stop,end.time,b+1,start.w)}
  }
 }
 for(const o of f.origins)walk(o.stop,departure+o.time,0,o.time)
 return {best,visits}
}
function exhaustive(f,departure,horizon,cap,deadline=null){
 if(deadline===null)return oracle(f,departure,horizon,cap)
 let best=null,visits=0
 const starts=[...new Set(f.origins.flatMap(o=>f.trips.flatMap(trip=>trip.slice(0,-1).filter(x=>x.stop===o.stop&&x.pickup).map(x=>x.time-o.time))))].filter(x=>x>=departure&&x<=deadline)
 // For each candidate departure enumerate all feasible complete journeys,
 // optimizing boardings/walking/arrival rather than earliest arrival.
 for(const d of starts){
  const alt=oracleDeadline(f,d,horizon,cap,deadline);visits+=alt.visits
  if(alt.best){const tuple=[-d,...alt.best];if(less(tuple,best))best=tuple}
 }
 return {best,visits}
}
function oracleDeadline(f,departure,horizon,cap,deadline){
 // Same raw exhaustive transitions, with a different terminal ordering.
 let best=null,visits=0
 function visit(stop,time,b,w){
  if(b)for(const d of f.destinations)if(d.stop===stop&&time+d.time<=deadline){const tuple=[b,w+d.time,time+d.time];if(best&&tuple[0]===best[0]&&tuple[1]!==best[1])coverage.deadlineBoardingTiesWithDifferentWalking++;if(less(tuple,best))best=tuple}
  if(b===cap)return
  const starts=[{stop,time:time+(b?f.minimums[stop]:0),w}];if(b)for(const e of f.transfers[stop])starts.push({stop:e.to,time:time+e.time,w:w+e.time})
  for(const x of starts)for(const trip of f.trips)for(let i=0;i<trip.length-1;i++){const a=trip[i];if(a.stop!==x.stop||!a.pickup||a.time<x.time||a.time>horizon)continue;for(let j=i+1;j<trip.length;j++){const z=trip[j];if(!z.dropoff||z.time>horizon)continue;visits++;visit(z.stop,z.time,b+1,x.w)}}
 }
 for(const o of f.origins)visit(o.stop,departure+o.time,0,o.time)
 return {best,visits}
}
let comparisons=0,blocked=0,visits=0
for(let fixture=0;fixture<150;fixture++){
 const f=make(),data=compile(f)
 for(const cap of [1,2,3,4])for(const departure of [0,25]){
  const q={originStops:f.origins.map(x=>x.stop),originWalkSeconds:f.origins.map(x=>x.time),originCandidateIndices:f.origins.map(x=>x.id),destinationStops:f.destinations.map(x=>x.stop),destinationWalkSeconds:f.destinations.map(x=>x.time),destinationCandidateIndices:f.destinations.map(x=>x.id),departure,horizon:90,allowPreRideTransfers:false,allowPostRideTransfers:false,maximumBoardings:cap}
  const k=new TimetableKernel(data),truth=exhaustive(f,departure,90,cap);visits+=truth.visits
  const result=k.routeScalarCsa(q)
  const w=result.chainDurations?.reduce((v,t,i)=>v+([1,3].includes(result.chainKinds[i])?t:0),0)+(f.destinations.find(x=>x.id===result.bestDestinationIndex)?.time??0)
  const actual=result.status==='ready'?[result.bestArrival,result.bestBoardings,w]:null
  try{assert.deepEqual(actual,truth.best)}catch(e){console.error(JSON.stringify({fixture,cap,departure,direction:'depart',f,actual,expected:truth.best}));throw e}comparisons++;if(!truth.best)blocked++
  const direct=new TimetableKernel(data).routeParetoRoundCsa({...q,earliestArrival:q.horizon+Math.max(0,...q.destinationWalkSeconds),boardingUpperBound:cap,candidateDestinationIndex:0,candidateWalkingSeconds:Number.MAX_VALUE,arrivalSlackSeconds:0,transferPenaltySeconds:0,walkReluctance:0,restrictionMode:'anchor-only'})
  assert.deepEqual(direct.improvedCandidate?[direct.bestArrival,direct.bestBoardings,direct.bestWalkingSeconds]:null,truth.best,`direct fixture ${fixture} cap ${cap}`)

  const expected=exhaustive(f,departure,90,cap,90);visits+=expected.visits
  const reverse=k.routeArriveByCsa({...q,earliest:departure,deadline:90})
  let tuple=null
  if(Number.isFinite(reverse.latestDeparture)){
   const d=reverse.latestDeparture,base=k.routeScalarCsa({...q,departure:d})
   const r=k.routeParetoRoundCsa({...q,departure:d,earliestArrival:base.bestArrival,boardingUpperBound:cap,candidateDestinationIndex:0,candidateWalkingSeconds:Number.MAX_VALUE,arrivalSlackSeconds:90-base.bestArrival,transferPenaltySeconds:0,walkReluctance:0,deadlineObjective:true})
   if(r.improvedCandidate)tuple=[-d,r.bestBoardings,r.bestWalkingSeconds,r.bestArrival]
  }
  try{assert.deepEqual(tuple,expected.best)}catch(e){console.error(JSON.stringify({fixture,cap,departure,direction:'arrive',f,actual:tuple,expected:expected.best}));throw e}comparisons++;if(!expected.best)blocked++
 }
}
assert(Object.values(coverage).every(x=>x>0), 'Generated corpus must exercise secondary-objective ties')
console.log(JSON.stringify({passed:true,coverage,fixtures:150,comparisons,directComparisons:1200,blocked,enumeratedRideExtensions:visits,seed:'0x43cafe',criteria:'depart (arrival,boardings,modeled walking); arrive (-departure,boardings,modeled walking,arrival)',features:['pickup/dropoff','directed transfers','same-stop minima','zero duration/equal time','repeated run positions','boarding limits','infeasible queries','independent endpoint time/distance filtering']}))
