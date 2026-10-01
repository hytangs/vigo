import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { TimetableKernel } = require('../native/vigo-routing-kernel/vigo-routing-kernel.node')

function input(trips, transfers = [], sameStop = Array(6).fill(0), forbidden = Array(6).fill(0)) {
  const rows = [], tripStart = [0]
  trips.forEach((trip, id) => {
    for (let i = 1; i < trip.length; i++) rows.push({ from:trip[i-1][0], to:trip[i][0], departure:trip[i-1][2] ?? trip[i-1][1],
      arrival:trip[i][1], trip:id, sequence:i, first:i===1 })
    tripStart.push(rows.length)
  })
  const stopCount = sameStop.length, order = rows.map((_, i) => i).sort((a,b) => rows[a].from-rows[b].from || rows[a].departure-rows[b].departure || a-b)
  const departureOffset = [0], transferOffset = [0], transferTo = [], transferDuration = []
  for (let stop=0;stop<stopCount;stop++) {
    departureOffset.push(departureOffset.at(-1)+rows.filter(r => r.from===stop).length)
    for (const [from,to,seconds] of transfers) if (from===stop) { transferTo.push(to);transferDuration.push(seconds) }
    transferOffset.push(transferTo.length)
  }
  const column = k => Uint32Array.from(rows.map(r => r[k]))
  return { stopCount,runCount:trips.length,departureSeconds:column('departure'),arrivalSeconds:column('arrival'),
    fromStop:column('from'),toStop:column('to'),sequence:column('sequence'),segmentTrip:column('trip'),segmentRun:column('trip'),
    continuityBreak:Uint8Array.from(rows.map(r => Number(r.first))),canBoard:new Uint8Array(rows.length).fill(1),canAlight:new Uint8Array(rows.length).fill(1),
    tripStart:Uint32Array.from(tripStart),departureOffset:Uint32Array.from(departureOffset),departureOrder:Uint32Array.from(order),
    transferOffset:Uint32Array.from(transferOffset),transferTo:Uint32Array.from(transferTo),transferDuration:Uint32Array.from(transferDuration),
    forbiddenSameStop:Uint8Array.from(forbidden),sameStopTransferMinimum:Uint32Array.from(sameStop) }
}

// Independent whole-ride enumeration. Each boarding may use at most one
// explicit transfer, and only a direct reboarding owes its same-stop minimum.
function enumerate(trips, transfers, sameStop, query, cap, forbidden = Array(sameStop.length).fill(0)) {
  const labels = new Map(), queue = [], results = []
  const offer = s => {
    if (s.time > query.horizon) return
    const key = [s.stop,s.boards,s.transferred].join(':')
    const old = labels.get(key) ?? []
    if (old.some(x => x.time<=s.time && x.walk<=s.walk)) return
    labels.set(key,[...old.filter(x => !(s.time<=x.time && s.walk<=x.walk)),s]);queue.push(s)
  }
  query.originStops.forEach((stop,i) => offer({stop,time:query.departure+query.originWalkSeconds[i],walk:query.originWalkSeconds[i],boards:0,transferred:false}))
  for (let head=0;head<queue.length;head++) {
    const s = queue[head]
    if (s.boards) query.destinationStops.forEach((stop,i) => {
      if (stop===s.stop) results.push([s.time+query.destinationWalkSeconds[i],s.boards,s.walk+query.destinationWalkSeconds[i]])
    })
    if (!s.transferred && (s.boards || query.allowPreRideTransfers)) for (const [from,to,duration] of transfers) {
      if (from===s.stop) offer({...s,stop:to,time:s.time+duration,walk:s.walk+duration,transferred:true})
    }
    if (s.boards===cap) continue
    if (s.boards && !s.transferred && forbidden[s.stop]) continue
    const ready = s.time+(s.boards && !s.transferred ? sameStop[s.stop] : 0)
    for (const trip of trips) for (let board=0;board<trip.length-1;board++) {
      if (trip[board][0]!==s.stop || (trip[board][2] ?? trip[board][1])<ready || (trip[board][2] ?? trip[board][1])>query.horizon) continue
      for (let exit=board+1;exit<trip.length;exit++) offer({stop:trip[exit][0],time:trip[exit][1],walk:s.walk,boards:s.boards+1,transferred:false})
    }
  }
  return results
}
const compare = (a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]
const tuple = r => r.status==='ready' ? [r.bestArrival,r.bestBoardings,r.bestWalkingSeconds] : null

// Downstream equal-time events precede the zero-time feeder in storage. An
// ordinary reachable three-boarding route prevents an all-origins-excluded
// retry from hiding the suboptimal two-boarding corridor result.
const regressionTrips = [ [[1,300],[4,400]], [[0,300],[1,300]], [[0,250],[2,300]], [[2,300],[3,350]], [[3,350],[4,400]] ]
const regressionQuery = { originStops:[0],originWalkSeconds:[0],originCandidateIndices:[0],destinationStops:[4],destinationWalkSeconds:[0],
  destinationCandidateIndices:[0],departure:0,horizon:500,allowPreRideTransfers:false }
const regressionRequest = { ...regressionQuery,earliestArrival:400,boardingUpperBound:3,candidateDestinationIndex:0,candidateWalkingSeconds:0,
  arrivalSlackSeconds:0,transferPenaltySeconds:0,walkReluctance:0 }
const regressionKernel = new TimetableKernel(input(regressionTrips))
const open = regressionKernel.routeParetoRoundCsa({...regressionRequest,restrictionMode:'anchor-only'})
assert.deepEqual(tuple(open),[400,2,0])
if (!process.argv.includes('--reverse-only')) assert.deepEqual(tuple(regressionKernel.routeParetoRoundCsa(regressionRequest)),[400,2,0],
  'Equal-time forward envelope must retain the optimal secondary objective when another origin path remains reachable')

// A prohibition on X->X reboarding does not prohibit Y->X, whose direct
// explicit edge has independently survived transfer-pair filtering.
const forbiddenTrips=[[[0,100],[1,200]],[[2,230],[3,300]]], forbiddenTransfers=[[1,2,20]]
const forbiddenFlags=[0,0,1,0,0,0], zeroMinimum=Array(6).fill(0)
const forbiddenQuery={...regressionQuery,destinationStops:[3],horizon:400}
const forbiddenData=input(forbiddenTrips,forbiddenTransfers,zeroMinimum,forbiddenFlags)
const forbiddenKernel=new TimetableKernel(forbiddenData)
assert.deepEqual(enumerate(forbiddenTrips,forbiddenTransfers,zeroMinimum,forbiddenQuery,2,forbiddenFlags).sort(compare)[0],[300,2,20])
const forbiddenScalar=forbiddenKernel.routeScalarCsa(forbiddenQuery)
const scalarWalking=forbiddenScalar.chainDurations.reduce((sum,duration,i)=>sum+([1,3].includes(forbiddenScalar.chainKinds[i])?duration:0),0)
assert.deepEqual([forbiddenScalar.bestArrival,forbiddenScalar.bestBoardings,scalarWalking],[300,2,20],
  'A same-stop prohibition must not block a permitted explicit transfer from a different stop')
for(const maximumBoardings of [undefined,2]) {
  const reverse=forbiddenKernel.routeArriveByCsa({...forbiddenQuery,earliest:0,deadline:300,...(maximumBoardings===undefined?{}:{maximumBoardings})})
  assert.equal(reverse.latestDeparture,100,'Reverse scan must retain the explicit-transfer latest departure')
}
const forbiddenDirect=new TimetableKernel(input([[[0,100],[2,200]],[[2,230],[3,300]]],[],zeroMinimum,forbiddenFlags))
assert.equal(forbiddenDirect.routeScalarCsa(forbiddenQuery).status,'blocked','Direct same-stop reboarding remains forbidden')
assert.equal(forbiddenDirect.routeArriveByCsa({...forbiddenQuery,earliest:0,deadline:300}).status,'blocked')

let state=619, comparisons=0, reverseComparisons=0
const random = n => ((state=(Math.imul(state,1664525)+1013904223)>>>0)%n)
for (let seed=0;seed<120;seed++) {
  const trips=[]
  for (let run=0;run<12;run++) {
    let time=50+10*random(20),stop=random(6)
    const trip=[[stop,time]]
    for (let i=0,n=1+random(3);i<n;i++) {
      stop=(stop+1+random(5))%6;time+=10*random(4)
      const arrival=time;time+=10*random(2);trip.push([stop,arrival,time])
    }
    trips.push(trip)
  }
  const transfers=[]
  for (let stop=0;stop<6;stop++) if(random(2)) transfers.push([stop,(stop+1+random(5))%6,10*random(3)])
  const minimum=Array.from({length:6},()=>10*random(4)), forbidden=Array.from({length:6},()=>Number(random(4)===0)), cap=1+random(4)
  const query={ originStops:[0,1],originWalkSeconds:[0,10*random(4)],originCandidateIndices:[0,1],destinationStops:[5,4],
    destinationWalkSeconds:[10*random(4),10*random(4)],destinationCandidateIndices:[0,1],departure:50,horizon:400,allowPreRideTransfers:Boolean(seed%2) }
  const data=input(trips,transfers,minimum,forbidden), paths=enumerate(trips,transfers,minimum,query,cap,forbidden).sort(compare)
  if(paths.length && !process.argv.includes('--reverse-only')) {
    const request={...query,earliestArrival:paths[0][0],boardingUpperBound:cap,candidateDestinationIndex:0,candidateWalkingSeconds:100000,
      arrivalSlackSeconds:0,transferPenaltySeconds:0,walkReluctance:0}
    const kernel=new TimetableKernel(data)
    for (const deadlineObjective of [false,true]) {
      const bound=deadlineObjective ? 400 : paths[0][0]
      const expected=paths.filter(p=>p[0]<=bound).sort(deadlineObjective ? (a,b)=>a[1]-b[1]||a[2]-b[2]||a[0]-b[0] : compare)[0]
      const q={...request,deadlineObjective,arrivalSlackSeconds:bound-paths[0][0]}
      assert.deepEqual(tuple(kernel.routeParetoRoundCsa({...q,restrictionMode:'anchor-only'})),expected,`Independent oracle seed=${seed}`)
      assert.deepEqual(tuple(kernel.routeParetoRoundCsa(q)),expected,`Layered corridor seed=${seed}`)
      kernel.routeScalarCsa(query)
      assert.deepEqual(tuple(kernel.routeParetoRoundCsa(q)),expected,`Scalar envelope seed=${seed}`)
      comparisons+=3
    }
  }
  const deadline=150+10*random(20), candidates=[]
  query.originStops.forEach((stop,i)=>{
    const origins=[[stop,query.originWalkSeconds[i]]]
    if(query.allowPreRideTransfers) for(const[from,to,seconds]of transfers)if(from===stop)origins.push([to,query.originWalkSeconds[i]+seconds])
    for(const[boardStop,access]of origins)for(const trip of trips)for(const call of trip.slice(0,-1))if(call[0]===boardStop)candidates.push((call[2]??call[1])-access)
  })
  const expectedLatest=[...new Set(candidates)].filter(t=>t>=50&&t<=deadline).sort((a,b)=>b-a).find(departure =>
    enumerate(trips,transfers,minimum,{...query,departure,horizon:deadline},cap,forbidden).some(p=>p[0]<=deadline))
  const reverse=new TimetableKernel(data).routeArriveByCsa({...query,earliest:50,deadline,maximumBoardings:cap})
  assert.equal(reverse.status,expectedLatest===undefined ? 'blocked' : 'ready',`Latest-departure status seed=${seed}`)
  assert.equal(reverse.latestDeparture ?? null,expectedLatest ?? null,`Latest departure oracle seed=${seed}`)
  if(expectedLatest!==undefined) {
    const witness=new TimetableKernel(data).routeManyCsa({...query,departure:expectedLatest,horizon:deadline,maximumBoardings:cap,
      destinationOffsets:[0,query.destinationStops.length],excludedTrips:[]})
    assert(witness.bestArrivals[0]<=deadline,`Reverse boundary must have a feasible forward witness seed=${seed}`)
  }
  reverseComparisons++
}
console.log(JSON.stringify({status:'passed',equalTimeRegression:!process.argv.includes('--reverse-only'),independentOracleComparisons:comparisons,latestDepartureComparisons:reverseComparisons},null,2))
