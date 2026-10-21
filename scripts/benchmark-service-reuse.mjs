#!/usr/bin/env node
// Public synthetic City benchmark for calendar views and repeated Matrix pairs.
// Reports engine time separately from round-trip time; no metropolitan claim.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {spawn, execFileSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {writeCliFixtureInputs} from '../test/helpers/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
const {values} = parseArgs({options:{
  reference:{type:'string'}, binary:{type:'string'}, samples:{type:'string',default:'21'}, output:{type:'string'},
}})
assert(values.reference, '--reference must identify the executable to compare')
const samples = Number(values.samples)
assert(Number.isInteger(samples) && samples>=3 && samples<=1000)
const binaries = [path.resolve(values.reference),path.resolve(values.binary ?? path.join(root,'native/target/release',process.platform==='win32'?'vigo.exe':'vigo'))]
for (const binary of binaries) assert(fs.existsSync(binary),binary)
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'vigo-service-reuse-'))
const children = []
function resident(binary, city) {
  const child = spawn(binary,['stream','--city',city,'--stream-output','detailed'],
    {env:{...process.env,RAYON_NUM_THREADS:'2',VIGO_TIMETABLE_CACHE_BYTES:String(128*1024*1024)}})
  children.push(child)
  let stderr=''; child.stderr.on('data',bytes=>{stderr+=bytes})
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]()
  return async query=>{
    const started=performance.now()
    child.stdin.write(JSON.stringify(query)+'\n')
    let timer
    const line=await Promise.race([lines.next(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`Runtime timeout: ${stderr}`)),30000)
    })]).finally(()=>clearTimeout(timer))
    assert(!line.done,stderr)
    const result=JSON.parse(line.value)
    assert(!result.error,JSON.stringify(result))
    return {result:result.trace ?? result,wallMs:performance.now()-started}
  }
}
const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value==='object'
  ? Object.fromEntries(Object.entries(value).filter(([key])=>!['diagnostics','timing'].includes(key)).map(([k,v])=>[k,semantic(v)])) : value
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]
try {
  const inputs=await writeCliFixtureInputs(directory)
  const city=path.join(directory,'city')
  execFileSync(process.execPath,['public/vigo.mjs','build',`--gtfs=${inputs.gtfsPath}`,`--osm=${inputs.osmPath}`,'--street-modes=walk',`--output=${city}`],
    {cwd:root,stdio:['ignore','ignore','pipe']})
  const workers=binaries.map(binary=>resident(binary,city))
  const base={kind:'route',serviceDate:'2026-07-15',time:'07:55',origin:{stopId:'A'},destination:{stopId:'B'},requireTransitRide:true,maxWalkKm:.2}
  let comparisons=0
  async function pair(query, order=[0,1]) {
    const answers=[]
    for (const i of order) answers[i]=await workers[i](query)
    assert.deepEqual(semantic(answers[0].result),semantic(answers[1].result)); comparisons++
    return answers
  }
  const preparation=[]
  for (const day of [15,16,17]) {
    const answers=await pair({...base,serviceDate:`2026-07-${day}`})
    preparation.push({serviceDate:`2026-07-${day}`,timings:answers.map(a=>({wallMs:a.wallMs,engineMs:a.result.timing.totalMs}))})
  }
  const a={coordinate:[-77.0499,38.90005]}, b={coordinate:[-77.0301,38.90995]}
  const matrix={kind:'matrix',mode:'transit',serviceDate:base.serviceDate,time:'08:30',includeJourneys:true,includeGeometry:true,maxStreetKm:5,allowLongWalk:true}
  const cases=[
    ['warm-route',()=>base],
    ['retained-date-switch',i=>({...base,serviceDate:`2026-07-${15+i%3}`})],
    ['repeated-matrix-16x16',()=>({...matrix,origins:Array.from({length:16},(_,i)=>i%2?a:b),destinations:Array.from({length:16},(_,i)=>i%2?b:a)})],
    ['distinct-matrix-8x8',()=>({...matrix,origins:Array.from({length:8},(_,i)=>({coordinate:[-77.049+i*.001,38.9005+i*.0005]})),destinations:Array.from({length:8},(_,i)=>({coordinate:[-77.039+i*.001,38.9055+i*.0005]}))})],
  ]
  const results=[]
  for (const [name,query] of cases) {
    for (let i=0;i<3;i++) await pair(query(i))
    const timings=[[],[]]
    for (let i=0;i<samples;i++) {
      const answers=await pair(query(i),i%2?[1,0]:[0,1])
      for (let version=0;version<2;version++) timings[version].push({wallMs:answers[version].wallMs,engineMs:answers[version].result.timing.totalMs})
    }
    results.push({name,timings,median:timings.map(ts=>({wallMs:median(ts.map(t=>t.wallMs)),engineMs:median(ts.map(t=>t.engineMs))}))})
  }
  const memory=[]
  for (const worker of workers) memory.push((await worker({kind:'info'})).result.memory)
  const report={schema:'vigo.service-reuse-benchmark.v1',scope:'Synthetic City; alternating resident queries, two Rayon threads; engine execution and detailed-output round trip measured separately',binaries: binaries.map(file=>({path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')})),samples,comparisons,preparation,results,memory}
  const text=JSON.stringify(report,null,2)+'\n'
  if(values.output) fs.writeFileSync(path.resolve(values.output),text)
  process.stdout.write(text)
} finally {
  for(const child of children) {
    if(child.exitCode!==null) continue
    const exited=once(child,'exit');child.kill('SIGTERM');await exited
  }
  fs.rmSync(directory,{recursive:true,force:true})
}
