import assert from 'node:assert/strict'
import {createStreetPreparationManager} from '../src/server/street-preparation.mjs'
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const calls=[]
let finishWalking,finishDriving
const pool={isStreetPrepared:()=>true,dispatch(_store,operation,request){calls.push({operation,request});return new Promise(resolve=>{if(request.prepareDrive)finishDriving=resolve;else finishWalking=resolve})}}
const updates=[]
const manager=createStreetPreparationManager({pool,onJob:job=>updates.push(structuredClone(job))})
const input={projectId:'city',storePath:'streets',workerStorePath:'transit',identity:'current'}
const job=manager.start(input)
await tick()
assert.equal(calls.length,1);assert.equal(calls[0].request.prepareDrive,false)
assert.equal(job.result.modes.walk,false)
finishWalking({streetStore:{ready:true,accelerated:true}})
await tick()
assert.equal(calls.length,2,'Driving must start automatically immediately after walking completes')
assert.equal(calls[1].request.prepareDrive,true)
assert.equal(job.status,'running');assert.deepEqual(job.result.modes,{walk:true,drive:false})
assert.strictEqual(manager.start(input),job,'A second view must share the in-progress driving load')
finishDriving({streetStore:{ready:true,accelerated:true,drive:{ready:true,accelerated:true}}})
await tick()
assert.equal(job.status,'complete');assert.deepEqual(job.result.modes,{walk:true,drive:true})
assert(updates.some(update=>update.status==='running'&&update.result.modes.walk&&!update.result.modes.drive))
console.log('Walking is ready before automatic driving preparation; concurrent views share both phases.')
