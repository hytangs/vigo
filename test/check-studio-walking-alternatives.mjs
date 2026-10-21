import assert from 'node:assert/strict'
import { withStudioWalkingAlternatives } from '../src/server/studio-walking-alternatives.mjs'
const plan = (id, durationMinutes, arriveMinutes = 480 + durationMinutes) => ({ id, status:'ready', durationMinutes, arriveMinutes, legs:[{type:'ride'}], diagnostics:{} })
const request = { mode:'transit', autoExpandWalking:true, maxWalkKm:1.2 }
const slow = plan('slow',42), fast=plan('fast',32)
const calls=[]
const run = async r => { calls.push(r); const p=r.maxWalkKm===2.4?fast:slow; return {plan:p,choices:[p]} }
const expanded=await withStudioWalkingAlternatives(request,run)
assert.equal(expanded.plan.id,'fast')
assert.equal(expanded.choices.length,2)
assert.equal(expanded.plan.diagnostics.expandedWalkingLimitKm,2.4)
assert.equal(calls[1].requireTransitRide,true)
for(const patch of [{autoExpandWalking:false},{wheelchair:true},{mode:'walk'},{waypoints:[{}]}]) {
 calls.length=0; await withStudioWalkingAlternatives({...request,...patch},run);assert.equal(calls.length,1)
}
const failed=await withStudioWalkingAlternatives(request,async r=>{if(r.maxWalkKm===2.4)throw Error('optional failed');return {plan:slow,choices:[slow]}})
assert.equal(failed.plan.id,'slow')
const slower=await withStudioWalkingAlternatives(request,async r=>({plan:r.maxWalkKm===2.4?plan('slower',50):slow,choices:[]}))
assert.equal(slower.plan.id,'slow')
console.log('Studio expanded walking: faster options, explicit limits, optional failures and deduplication passed')
const { importTestModules } = await import('./helpers/import-test-modules.mjs')
const [map] = await importTestModules('map/journeyFeatures.ts')
const line = {type:'walk', coordinates:[[-71.059978,42.35588],[-71.059375,42.354763]], durationMinutes:2.417, transferSource:'gtfs_transfer', geometrySource:'stop_coordinate_fallback',streetPathVerified:false}
const features=map.routingLineFeatures({legs:[line]})
assert.equal(features.features[0].properties.approximateWalk,true)
assert.deepEqual(features.features[0].geometry.coordinates,line.coordinates)
assert.equal(map.routingLineFeatures({legs:[{...line,geometrySource:'osm',streetPathVerified:true}]}).features[0].properties.approximateWalk,false)
console.log('Station connectors retain source coordinates and expose approximate geometry')
