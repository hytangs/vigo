import assert from 'node:assert/strict'
import { selectStudioJourneyChoices } from '../src/server/native-routing-kernel.mjs'
const plan = (id, route, arrival, trips, cycle = false, walk = 3) => ({ id, status:'ready', arriveMinutes:arrival, walkMinutes:walk,
  legs:trips.map(tripId=>({type:'ride',tripId,routeId:route,fromStopId:'A',toStopId:'B',startMinutes:480,endMinutes:arrival})),
  diagnostics:cycle?{returnedStationCycle:{advisory:true}}:{} })
const direct=plan('direct','M',504,['m']), detour=plan('detour','E',511,['m','e'],true)
assert.deepEqual(selectStudioJourneyChoices([direct,detour]).map(p=>p.id),['direct'])
assert.deepEqual(selectStudioJourneyChoices([detour]).map(p=>p.id),['detour'],'A required return must remain routable')
assert.equal(selectStudioJourneyChoices([direct,plan('useful','E',503,['m','e'],true)]).length,2)
assert.equal(selectStudioJourneyChoices([direct,plan('less-walk','E',511,['m','e'],true,1)]).length,2)
const pool=[direct,plan('m2','M',506,['m2']),plan('rail','Rail',507,['r']),plan('bus','Bus',508,['b'])]
assert.deepEqual(selectStudioJourneyChoices(pool,3).map(p=>p.id),['direct','rail','bus'],'Repeated departures must not crowd out other routes')
assert.deepEqual(selectStudioJourneyChoices([direct,plan('unnecessary-change','D',504,['d','m'])]).map(p=>p.id),['direct'])
assert.equal(selectStudioJourneyChoices([direct,{...direct,id:'same-ride'}]).length,1)
console.log('Rust Studio selection passed: dominated returns, required and useful returns, distinct route priority, needless changes, exact-trip deduplication.')
