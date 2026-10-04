#!/usr/bin/env node
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localRequestAccess } from './local-http-security.mjs'
import { resolveServiceDay, serviceDayForDate } from './service-day.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(directory, 'vigo.mjs')
const help = `VIGO Engine HTTP — resident Route, Matrix and Reach for one City

Usage: VIGO_CITY_DIR=./city node engine-http.mjs

GET  /health             Process and worker status
GET  /v1/capabilities    The public Engine capability contract
POST /v1/route           CLI Route JSON, with serviceDate and time
POST /v1/matrix          CLI Matrix JSON, with serviceDate and time
POST /v1/reach           CLI Reach JSON, with serviceDate and time

Environment:
  VIGO_CITY_DIR                 Required complete City directory
  VIGO_ENGINE_HOST              Default 127.0.0.1
  VIGO_ENGINE_PORT / PORT       Default 8080
  VIGO_ENGINE_API_TOKEN         Bearer token; required for a remote bind
  VIGO_SERVICE_DATE             Optional default YYYY-MM-DD
  VIGO_ENGINE_MAX_WORKERS       Resident service dates, default 2 (1–16)
  VIGO_ENGINE_QUEUE_LIMIT       Requests per worker, default 16 (1–256)
  VIGO_ENGINE_TIMEOUT_MS        Query/queue timeout, default 120000
  VIGO_ENGINE_MAX_BODY_BYTES    JSON body limit, default 1048576
  VIGO_ENGINE_BODY_TIMEOUT_MS   Absolute JSON read deadline, default 10000
  VIGO_ENGINE_MAX_RESPONSE_BYTES Worker response limit, default 67108864
  VIGO_ENGINE_MAX_CONNECTIONS   Open connections, default 128 (1–4096)

Node.js 24.18+ and a matching native kernel are required. City data is mounted
separately. Results use the CLI schemas; Studio project endpoints are excluded.
`

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

function integerEnvironment(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])
  if (!Number.isInteger(value) || value < min || value > max) throw failure(`${name} must be an integer from ${min} to ${max}.`)
  return value
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw failure('serviceDate must be a real YYYY-MM-DD date.')
  }
  return value
}

function queryTime(body) {
  const value = body.time ?? body.timeMinutes
    ?? (body.timePreference === 'arrive' ? body.arriveMinutes : body.departMinutes) ?? '08:00'
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value >= 1800) throw failure('time must be an integral minute from 0 to 1799.')
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
  }
  if (typeof value !== 'string' || !/^(?:[01]?\d|2\d):[0-5]\d$/.test(value)) throw failure('time must be HH:MM or integral service-day minutes.')
  return value
}

// The public resident CLI owns routing, validation, preparation and Result
// assembly. A worker stays bound to one City/service date and runs requests
// serially, preserving the CLI's existing prepared-network reuse semantics.
class ResidentWorker {
  pending = []
  outputChunks = []
  outputBytes = 0
  closed = false
  lastUsed = Date.now()

  constructor(config, serviceDate) {
    this.config = config
    this.child = spawn(process.execPath, [cli, '_route-stream', `--city=${config.city}`, `--service-date=${serviceDate}`], {
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    this.child.stderr.on('data', data => process.stderr.write(data))
    this.child.stdin.on('error', () => this.close(failure('Engine worker input closed.', 503)))
    this.child.on('error', () => this.close(failure('Engine worker could not start.', 503)))
    this.child.on('close', () => this.close(failure('Engine worker exited; retry the request.', 503)))
    this.child.stdout.on('data', data => this.readResponses(data))
  }

  readResponses(data) {
    let offset = 0
    while (!this.closed && offset < data.length) {
      const newline = data.indexOf(10, offset)
      const end = newline < 0 ? data.length : newline
      const chunk = data.subarray(offset, end)
      this.outputBytes += chunk.length
      if (this.outputBytes > this.config.maxResponseBytes) {
        return this.close(failure('Engine response exceeded its byte limit.', 503))
      }
      this.outputChunks.push(chunk)
      if (newline < 0) return
      const line = Buffer.concat(this.outputChunks, this.outputBytes).toString('utf8')
      this.outputChunks = []
      this.outputBytes = 0
      const pending = this.pending.shift()
      if (!pending) return this.close(failure('Engine worker returned an unexpected response.', 503))
      clearTimeout(pending.timer)
      this.lastUsed = Date.now()
      try { pending.resolve(JSON.parse(line)) }
      catch { pending.reject(failure('Engine worker returned invalid JSON.', 503)); this.close() }
      offset = end + 1
    }
  }

  query(body) {
    if (this.closed) throw failure('Engine worker is unavailable; retry the request.', 503)
    if (this.pending.length >= this.config.queueLimit) throw failure('Engine request queue is full.', 429)
    this.lastUsed = Date.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(failure('Engine query exceeded its queue/query timeout.', 504)), this.config.timeoutMs)
      this.pending.push({ resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(body)}\n`)
    })
  }

  close(error = failure('Engine worker stopped.', 503)) {
    if (this.closed) return
    this.closed = true
    this.outputChunks = []
    this.outputBytes = 0
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    // A native query (or a stopped process) may never handle SIGTERM. A
    // deadline must end the actual work before another worker is admitted.
    this.child.kill('SIGKILL')
    for (const pending of this.pending.splice(0)) { clearTimeout(pending.timer); pending.reject(error) }
  }
}

async function readBody(request, maxBytes, timeoutMs) {
  if (String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw failure('Content-Type must be application/json.', 415)
  }
  if (Number(request.headers['content-length']) > maxBytes) { request.resume(); throw failure('JSON body is too large.', 413) }
  const chunks = await new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    const timer = setTimeout(() => error(failure('Request body exceeded its read deadline.', 408)), timeoutMs)
    function cleanup() { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted) }
    function error(value) { cleanup(); reject(value) }
    function aborted() { error(failure('Request was aborted.')) }
    function end() { cleanup(); resolve(chunks) }
    function data(chunk) {
      bytes += chunk.length
      if (bytes > maxBytes) { error(failure('JSON body is too large.', 413)); request.resume() }
      else chunks.push(chunk)
    }
    request.on('data', data); request.on('end', end); request.on('error', error); request.on('aborted', aborted)
  })
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw failure('Request body must be valid JSON.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Request body must be a JSON object.')
  for (const name of ['city', 'cityPath', 'output', 'input', 'request']) {
    if (Object.hasOwn(body, name)) throw failure(`${name} is configured by the service, not by query requests.`)
  }
  return body
}

function send(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return
  // An absolute write deadline also bounds clients that read very slowly.
  const timer = setTimeout(() => response.destroy(), 10000)
  timer.unref()
  const clear = () => clearTimeout(timer)
  response.once('finish', clear)
  response.once('close', clear)
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || major === 24 && minor < 18) throw failure('VIGO Engine requires Node.js 24.18 or newer.')
  if (!process.env.VIGO_CITY_DIR?.trim()) throw failure('VIGO_CITY_DIR must name a complete City directory.')
  const host = process.env.VIGO_ENGINE_HOST?.trim() || '127.0.0.1'
  const token = process.env.VIGO_ENGINE_API_TOKEN ?? ''
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host)
  if (!loopback && !token) throw failure('A remote bind requires VIGO_ENGINE_API_TOKEN.')
  const native = [process.env.VIGO_NATIVE_ROUTING_KERNEL,
    path.join(directory, 'vigo-routing-kernel.node'),
    path.resolve(directory, '..', 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node')].find(value => value && existsSync(value))
  if (!native || typeof createRequire(import.meta.url)(path.resolve(native)).TimetableKernel !== 'function') throw failure('A matching native VIGO kernel is required.')
  const config = {
    city: path.resolve(process.env.VIGO_CITY_DIR),
    port: integerEnvironment(process.env.VIGO_ENGINE_PORT === undefined ? 'PORT' : 'VIGO_ENGINE_PORT', 8080, 0, 65535),
    maxWorkers: integerEnvironment('VIGO_ENGINE_MAX_WORKERS', 2, 1, 16),
    queueLimit: integerEnvironment('VIGO_ENGINE_QUEUE_LIMIT', 16, 1, 256),
    timeoutMs: integerEnvironment('VIGO_ENGINE_TIMEOUT_MS', 120000, 1, 3600000),
    maxBytes: integerEnvironment('VIGO_ENGINE_MAX_BODY_BYTES', 1048576, 1, 16777216),
    bodyTimeoutMs: integerEnvironment('VIGO_ENGINE_BODY_TIMEOUT_MS', 10000, 1, 120000),
    maxResponseBytes: integerEnvironment('VIGO_ENGINE_MAX_RESPONSE_BYTES', 67108864, 1, 268435456),
    maxConnections: integerEnvironment('VIGO_ENGINE_MAX_CONNECTIONS', 128, 1, 4096),
    defaultDate: process.env.VIGO_SERVICE_DATE ? validateDate(process.env.VIGO_SERVICE_DATE) : undefined,
  }
  // Fail startup for an invalid City. Neither request bodies nor URLs can
  // select arbitrary City paths or invoke build/import/output commands.
  execFileSync(process.execPath, [cli, 'inspect', `--city=${config.city}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
  const capabilities = JSON.parse(execFileSync(process.execPath, [cli, 'capabilities'], { timeout: 30000, encoding: 'utf8' }))
  const tokenHash = crypto.createHash('sha256').update(token).digest()
  const workers = new Map()
  function worker(date) {
    for (const [key, value] of workers) if (value.closed) workers.delete(key)
    if (workers.has(date)) return workers.get(date)
    if (workers.size >= config.maxWorkers) {
      const idle = [...workers].filter(([, value]) => value.pending.length === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (!idle) throw failure('All resident service-date workers are busy.', 429)
      idle[1].close(); workers.delete(idle[0])
    }
    const value = new ResidentWorker(config, date)
    workers.set(date, value)
    return value
  }
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://engine').pathname
      if (request.method === 'GET' && pathname === '/health') {
        return send(response, 200, { status: 'ready', productVersion: capabilities.productVersion,
          platform: process.platform, architecture: process.arch,
          residentWorkers: [...workers.values()].filter(value => !value.closed).length })
      }
      if (token) {
        const authorization = String(request.headers.authorization ?? '')
        const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        if (!crypto.timingSafeEqual(tokenHash, crypto.createHash('sha256').update(supplied).digest())) {
          response.setHeader('www-authenticate', 'Bearer')
          throw failure('A valid bearer token is required.', 401)
        }
      } else if (!localRequestAccess(request, { staticRoot: 'engine' }).allowed) throw failure('Only local same-origin requests are allowed.', 403)
      if (request.method === 'GET' && pathname === '/v1/capabilities') return send(response, 200, capabilities)
      const kind = /^\/v1\/(route|matrix|reach)$/.exec(pathname)?.[1]
      if (!kind) throw failure('Unknown Engine endpoint.', 404)
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); throw failure('This endpoint requires POST.', 405) }
      const body = await readBody(request, config.maxBytes, config.bodyTimeoutMs)
      const date = validateDate(body.serviceDate ?? config.defaultDate)
      try {
        if (resolveServiceDay(date, body.serviceDay) !== serviceDayForDate(date)) throw failure('serviceDay must agree with serviceDate.')
      }
      catch (error) { throw failure(error.message) }
      if (body.kind !== undefined && body.kind !== kind) throw failure('Request kind must match the endpoint.')
      const time = queryTime(body)
      const result = await worker(date).query({ ...body, id: body.id ?? crypto.randomUUID(), kind, time })
      send(response, result.status === 'error' ? 422 : 200, result)
    } catch (error) {
      if (!request.complete) {
        response.setHeader('connection', 'close')
        response.once('finish', () => request.destroy())
      }
      send(response, error.statusCode ?? 503, { status: 'error', error: { message: error.message } })
    }
  })
  server.maxConnections = config.maxConnections
  server.requestTimeout = Math.max(30000, config.bodyTimeoutMs + 10000)
  server.headersTimeout = 10000
  server.listen(config.port, host, () => console.log(JSON.stringify({ status: 'listening', host, port: server.address().port,
    productVersion: capabilities.productVersion, authenticated: Boolean(token) })))
  server.on('error', error => { console.error(`VIGO Engine HTTP: ${error.message}`); process.exitCode = 1 })
  let stopping = false
  function stop() {
    if (stopping) return
    stopping = true
    for (const value of workers.values()) value.close()
    server.close()
    server.closeIdleConnections()
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0) }, 5000)
    deadline.unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv.length > 2) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(help)
  else { process.stderr.write('VIGO Engine HTTP accepts --help; configure the service through environment variables.\n'); process.exitCode = 2 }
} else {
  try { await main() }
  catch (error) { process.stderr.write(`VIGO Engine HTTP: ${error.message}\n`); process.exitCode = 2 }
}
