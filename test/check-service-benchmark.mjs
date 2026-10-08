import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-benchmark-check-'))
let active = 0, maximum = 0
const server = http.createServer(async (request, response) => {
  if (request.method === 'GET') {
    if (!['/healthz', '/readyz', '/v1/capabilities'].includes(request.url)) response.writeHead(404)
    response.end(JSON.stringify({ status: 'ready', version: 'fixture' })); return
  }
  active++; maximum = Math.max(maximum, active)
  const parts = []; for await (const part of request) parts.push(part)
  const query = JSON.parse(Buffer.concat(parts).toString())
  await new Promise(resolve => setTimeout(resolve, 10))
  if (query.fail) response.writeHead(400)
  response.end(JSON.stringify({ status: query.fail ? 'error' : query.unreachable ? 'not_found' : 'ok' }))
  active--
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
async function run(name, queries) {
  const input = path.join(directory, `${name}.ndjson`), output = path.join(directory, `${name}.json`)
  await fs.writeFile(input, queries.map(q => JSON.stringify(q)).join('\n'))
  const child = spawn(process.execPath, ['scripts/benchmark-service.mjs', '--url', `http://127.0.0.1:${server.address().port}`, '--requests', input,
    '--output', output, '--concurrency', '2', '--rounds', '3', '--warmup', '1'], { stdio: ['ignore', 'pipe', 'inherit'] })
  child.stdout.resume()
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  return { code, report: JSON.parse(await fs.readFile(output, 'utf8')) }
}
try {
  const success = await run('success', [{ kind: 'route' }, { kind: 'matrix' }, { kind: 'reach', unreachable: true }])
  assert.equal(success.code, 0)
  assert.equal(success.report.samples.length, 9)
  assert.equal(success.report.health.status, 'ready')
  assert.equal(success.report.readiness.status, 'ready')
  assert.equal(success.report.warmup.length, 3)
  assert.equal(success.report.groups['reach:not_found'].count, 3)
  assert.equal(success.report.groups['route:ok'].count, 3)
  assert.equal(maximum, 2)
  const failure = await run('failure', [{ kind: 'route', fail: true }])
  assert.equal(failure.code, 1)
  assert.equal(failure.report.failures, 4, 'Warmup errors must not be hidden')
  assert.equal(failure.report.groups['route:http_error'].count, 3)
  console.log('Public benchmark preserves concurrency, warmup, valid no-journey outcomes and failures.')
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }) }
