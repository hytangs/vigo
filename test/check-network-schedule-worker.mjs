import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
const url = async (name, replacements = {}) => {
  let source = ts.transpileModule(await readFile(new URL(`../src/app/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  for (const [from, to] of Object.entries(replacements)) source = source.replace(`from '${from}'`, `from '${to}'`)
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
const script = await url('networkSchedules.worker', { './api': await url('api'), './networkSchedule': await url('networkSchedule'), './networkScheduleCollection': await url('networkScheduleCollection') })
const worker = new Worker(`
const { parentPort } = require('node:worker_threads');
let active = 0, peak = 0;
globalThis.self = { postMessage: value => parentPort.postMessage({...value, peak}) };
globalThis.fetch = async (_url, init) => {
  const { routeId, serviceDate } = JSON.parse(init.body);
  peak = Math.max(peak, ++active);
  await new Promise(resolve => setTimeout(resolve, 10));
  active--;
  if (routeId === 'failure') return {ok:false,status:500,json:async()=>({error:'fixture failure'})};
  return {ok:true,json:async()=>({feedId:'F',analysis:{routes:[{id:routeId,analysisServiceDate:serviceDate,scheduledTrips:[{tripId:'morning',firstDepartureMinutes:300},{tripId:'overnight',firstDepartureMinutes:1500}]}],stops:[{id:'S',routes:[routeId],tripCount:1,transferScore:1}],stopPairs:[]}})};
};
import(${JSON.stringify(script)}).then(()=>self.onmessage({data:{endpoint:'fixture',serviceDate:'2026-09-16',requests:['R1','R2','R1','failure'].map(routeId=>({routeId,feedId:'F'}))}})).catch(error=>{throw error});
`, { eval: true })
try {
  const messages = []
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker timed out')), 15000)
    worker.on('error', error => { clearTimeout(timer); reject(error) })
    worker.on('message', message => {
      messages.push(message)
      if (message.type === 'complete') { clearTimeout(timer); resolve(message) }
      if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.error)) }
    })
  })
  assert.equal(messages.filter(message => message.results).length, 1, 'Only the final message may publish schedule data')
  assert.equal(result.failures, 1)
  assert.equal(result.peak, 2, 'Bound memory used by simultaneous responses')
  assert.equal(result.results.length, 1)
  const analysis = result.results[0].analysis
  assert.equal(analysis.routes.length, 2, 'Repeated service responses do not duplicate patterns')
  assert.deepEqual(analysis.stops[0].routes.sort(), ['R1', 'R2'])
  assert.equal(analysis.routes[0].scheduledTrips[1].firstDepartureMinutes, 1500, 'Keep service-day trips after midnight')
  console.log('Schedule worker: single final publication, two concurrent requests, deduplication, partial failure and full-day retention passed.')
} finally { await worker.terminate() }
