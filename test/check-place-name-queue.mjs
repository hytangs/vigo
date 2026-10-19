import assert from 'node:assert/strict'
import { createPlaceNameQueue } from '../src/app/usePlaceNames.ts'
const original=globalThis.fetch
try {
  const calls=[]
  globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>{
    calls.push({url,resolve})
    options.signal.addEventListener('abort',()=>reject(new Error('aborted')))
  })
  const point={coordinate:[5,52],source:'map',label:'Origin'}
  const queue=createPlaceNameQueue('one',30), applied=[]
  queue.name(point,v=>applied.push(v.label));queue.name({...point,coordinate:[6,53]},v=>applied.push(v.label))
  calls[1].resolve({ok:true,json:async()=>({places:[{label:'Second St'}]})})
  calls[0].resolve({ok:true,json:async()=>({places:[{label:'First St'}]})})
  await new Promise(r=>setTimeout(r,10));assert.deepEqual(applied,['First St','Second St'])
  queue.name(point,v=>applied.push(v.label))
  await new Promise(r=>setTimeout(r,40));assert.equal(applied.at(-1),'Origin','Timeout retains coordinates and fallback label')
  const old=createPlaceNameQueue('previous',30)
  old.name(point,()=>assert.fail('A prior City must never receive a delayed click'))
  old.dispose();calls.at(-1).resolve({ok:true,json:async()=>({places:[{label:'Wrong City'}]})})
  queue.name(point,v=>applied.push(v.label))
  calls.at(-1).resolve({ok:true,json:async()=>({places:[{label:{invalid:true}}]})})
  await new Promise(r=>setTimeout(r,10));assert.equal(applied.at(-1),'Origin')
  queue.dispose()
  console.log('Place-name click ordering, timeout, City cancellation and malformed result checks passed.')
} finally {globalThis.fetch=original}
