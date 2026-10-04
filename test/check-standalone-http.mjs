import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-rust-http-'))
const city = path.join(directory, 'city')
const token = 'public-synthetic-test-token'
const body = JSON.stringify({ origin: { stopId: 'A' }, destination: { stopId: 'B' }, serviceDate: '2026-07-15', time: '07:55', maxWalkKm: .2 })
let server, port, checks = 0
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
  server = spawn(binary, ['serve', '--city', city, '--port', '0', '--max-body-bytes', '1048576', '--request-timeout-ms', '250', '--query-timeout-ms', '250', '--max-connections', '4', '--max-queue', '2'], { env: { PATH: '', VIGO_API_TOKEN: token, RAYON_NUM_THREADS: '2' } })
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP startup timed out')), 15000)
    let text = ''
    server.stderr.on('data', data => { text += data; const m = text.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])) } })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${text}`)) })
  })
  const origin = `http://127.0.0.1:${port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const post = () => fetch(`${origin}/v1/route`, { method: 'POST', headers, body })
  const health = () => fetch(`${origin}/healthz`)
  async function raw(request) {
    const socket = net.connect(port, '127.0.0.1')
    const response = new Promise((resolve, reject) => {
      let text = ''
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('Raw HTTP timed out')) })
      socket.setEncoding('utf8').on('data', data => { text += data })
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    await once(socket, 'connect')
    socket.write(request)
    return response
  }
  const prefix = `POST /v1/route HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\n`
  async function status(request, expected) {
    const r = await raw(request)
    assert.equal(Number(r.match(/^HTTP\/1\.1 (\d+)/)?.[1]), expected, r.slice(0, 400)); checks++
    return r
  }
  assert.equal((await post()).status, 200); checks++
  for (const arrivalBufferMinutes of [5, 6]) {
    const response = await fetch(`${origin}/v1/route`, { method: 'POST', headers,
      body: JSON.stringify({ ...JSON.parse(body), time: '08:35', timePreference: 'arrive_by', arrivalBufferMinutes }) })
    assert.equal(response.status, 200)
    const plan = await response.json()
    assert.equal(plan.status, arrivalBufferMinutes === 5 ? 'ready' : 'blocked')
    assert.equal(plan.diagnostics.timeReserves.planningArrivalMinutes, 515 - arrivalBufferMinutes)
    assert.equal(plan.diagnostics.timeReserves.calibratedProbability, false)
    checks++
  }
  const invalidReserve = await fetch(`${origin}/v1/route`, { method: 'POST', headers,
    body: JSON.stringify({ ...JSON.parse(body), arrivalBufferMinutes: 5 }) })
  assert.equal(invalidReserve.status, 400); checks++
  await status(prefix + `Content-Length: ${body.length}\r\nContent-Length: ${body.length}\r\n\r\n${body}`, 400)
  await status(prefix + `Content-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\n\r\n${body}`, 400)
  await status(prefix + 'Content-Length: 1048577\r\n\r\n', 413)
  await status(prefix + 'Transfer-Encoding: chunked\r\n\r\n100001\r\n', 413)
  await status(prefix + 'Transfer-Encoding: chunked\r\n\r\nQ\r\n', 400)
  const chunked = await status(prefix + `Transfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`, 200)
  assert.equal(JSON.parse(chunked.split('\r\n\r\n')[1]).arrivalMinutes, 510)
  await status(prefix + `X-Oversized: ${'a'.repeat(17000)}\r\n\r\n`, 431)
  const slow = raw(prefix + 'Content-Length: 1000\r\n\r\n{')
  assert.equal((await health()).status, 200, 'A slow body must not block health'); checks++
  assert.match(await slow, /^HTTP\/1\.1 408 /); checks++
  const afterBodyTimeout = await post()
  assert.equal(afterBodyTimeout.status, 200, 'Body timeout must not poison routing')
  await afterBodyTimeout.arrayBuffer()
  checks++
  if (process.platform !== 'win32') {
    // Stop only the child of the exact server this test created. A deadline
    // must terminate actual native work, replace the worker, and recover.
    const children = execFileSync('pgrep', ['-P', String(server.pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
    assert.equal(children.length, 1)
    const worker = children[0]
    process.kill(worker, 'SIGSTOP')
    const overload = await Promise.allSettled(Array.from({ length: 7 }, async () => {
      const response = await post()
      await response.arrayBuffer()
      return response.status
    }))
    // Four connections can enter HTTP handling. Excess connections are closed
    // before their bodies are read; macOS can report that close as a TCP reset
    // instead of delivering the best-effort 503. This allowance is confined to
    // the three excess connections, never normal requests or queue timeouts.
    const refused = overload.filter(reply => reply.status === 'rejected')
    assert(refused.length <= 3, 'Admitted connections must return HTTP responses')
    for (const reply of refused) assert.match(reply.reason?.cause?.code ?? '', /^(ECONNRESET|UND_ERR_SOCKET)$/)
    const replies = overload.filter(reply => reply.status === 'fulfilled').map(reply => reply.value)
    assert(replies.every(status => [200, 503, 504].includes(status)), 'Unexpected overload HTTP response')
    assert(replies.includes(503), 'Full connection/query capacity must reject work')
    assert(replies.includes(504), 'Stalled worker must time out')
    checks += 3
    const firstRecovery = Date.now() + 5000
    while ((await fetch(`${origin}/readyz`)).status !== 200) {
      assert(Date.now() < firstRecovery); await new Promise(resolve => setTimeout(resolve, 25))
    }
    const nextWorker = Number(execFileSync('pgrep', ['-P', String(server.pid)], { encoding: 'utf8' }).trim())
    process.kill(nextWorker, 'SIGSTOP')
    const large = JSON.stringify({ ...JSON.parse(body), origin: { stopId: 'A', name: 'x'.repeat(512 * 1024) } })
    const stalled = await fetch(`${origin}/v1/route`, { method: 'POST', headers, body: large, signal: AbortSignal.timeout(5000) })
    assert.equal(stalled.status, 504, 'Deadline must cover a full worker input pipe'); checks++
    const recoveredBy = Date.now() + 5000
    while ((await fetch(`${origin}/readyz`)).status !== 200) {
      assert(Date.now() < recoveredBy); await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal((await post()).status, 200); checks++
    const idleWorker = Number(execFileSync('pgrep', ['-P', String(server.pid)], { encoding: 'utf8' }).trim())
    process.kill(idleWorker, 'SIGKILL')
    const restartedBy = Date.now() + 5000
    while (true) {
      let replacement = ''
      try { replacement = execFileSync('pgrep', ['-P', String(server.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
      if (replacement && Number(replacement) !== idleWorker && (await fetch(`${origin}/readyz`)).status === 200) break
      assert(Date.now() < restartedBy, 'Idle crash must recover without a query'); await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal((await post()).status, 200); checks++
    const deadline = Date.now() + 5000
    while (true) {
      if ((await fetch(`${origin}/readyz`)).status === 200) break
      assert(Date.now() < deadline, 'Replacement worker did not become ready')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const recovered = await post()
    assert.equal(recovered.status, 200)
    assert.equal((await recovered.json()).arrivalMinutes, 510)
    assert.throws(() => process.kill(worker, 0), { code: 'ESRCH' }, 'Timed-out process must be reaped')
    checks += 2
  }
  console.log(`Standalone HTTP checks passed (${checks} checks: framing, slow bodies, bounds, worker termination and recovery).`)
} finally {
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit') }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
