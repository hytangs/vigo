import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { once } from 'node:events'
import { runStreamWorkers } from '../src/cli/stream-workers.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-stream-workers-'))
const previous = process.argv[1]
try {
  const child = path.join(directory, 'worker.mjs')
  fs.writeFileSync(child, `import {createInterface} from 'node:readline';
    let sequence=0;
    for await(const line of createInterface({input:process.stdin})) {
      const query=JSON.parse(line); if(query.crash) process.exit(3);
      await new Promise(resolve=>setTimeout(resolve,query.delay||0));
      console.log(JSON.stringify({id:query.id||'request_'+(++sequence),sequence,
        status:query.invalid?'error':'ok',value:query.value,process:process.pid}));
    }`)
  process.argv[1] = child
  const input = new PassThrough()
  const output = new PassThrough()
  const received = []
  output.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)))
  const running = runStreamWorkers(new Map(), 2, input, output)
  const first = once(output, 'data')
  input.write(JSON.stringify({value: 0})+'\n')
  await first // Must respond while stdin stays open.
  input.write(JSON.stringify({value: 1, delay: 40})+'\n')
  input.write(JSON.stringify({value: 2, invalid: true})+'\n')
  input.end(JSON.stringify({value: 3, id: 'custom'})+'\n')
  await running
  assert.deepEqual(received.map(result => result.value), [0, 1, 2, 3])
  assert.deepEqual(received.map(result => result.sequence), [1, 2, 3, 4])
  assert.deepEqual(received.map(result => result.id), ['request_1', 'request_2', 'request_3', 'custom'])
  assert.equal(new Set(received.map(result => result.process)).size, 2)
  const failure = new PassThrough()
  failure.end('{"crash":true}\n')
  await assert.rejects(runStreamWorkers(new Map(), 2, failure, new Writable({write(c,e,cb){cb()}})), /worker exited/)
  console.log('CLI stream workers: ordering, resident reuse, interactive input and crash cleanup passed')
} finally {
  process.argv[1] = previous
  fs.rmSync(directory, {recursive: true, force: true})
}
