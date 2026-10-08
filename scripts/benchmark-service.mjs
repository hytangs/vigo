#!/usr/bin/env node
// Replays caller-supplied requests; no private City or workload is bundled.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  url: { type: 'string' }, requests: { type: 'string' }, output: { type: 'string' },
  rounds: { type: 'string', default: '20' }, concurrency: { type: 'string', default: '1' },
  warmup: { type: 'string', default: '1' }, timeout: { type: 'string', default: '120000' },
  city: { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/benchmark-service.mjs --url http://127.0.0.1:8080 --requests queries.ndjson --output results.json [--rounds 20 --concurrency 1 --warmup 1 --timeout 120000 --city ./city]\nRequests are NDJSON objects with kind: route, matrix, or reach. VIGO_API_TOKEN supplies optional authentication. Output files must not already exist.')
  process.exit(0)
}
if (!values.url || !values.requests || !values.output) throw Error('--url, --requests and --output are required; use --help')
const positive = (name, maximum, allowZero = false) => {
  const n = Number(values[name])
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1) || n > maximum) throw Error(`Invalid --${name}`)
  return n
}
const rounds = positive('rounds', 10_000), concurrency = positive('concurrency', 64)
const warmup = positive('warmup', 100, true), timeout = positive('timeout', 3_600_000)
const endpoint = new URL(values.url)
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Supply an HTTP service URL without credentials or a query string')
const raw = await fs.readFile(values.requests, 'utf8')
const queries = raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
if (!queries.length || queries.length > 10_000 || queries.length * (rounds + warmup) > 100_000) throw Error('Workload must contain 1 to 10,000 requests and at most 100,000 total calls')
for (const q of queries) if (!['route', 'matrix', 'reach'].includes(q.kind)) throw Error('Each request needs kind: route, matrix, or reach')
const output = await fs.open(values.output, 'wx')
const headers = { 'Content-Type': 'application/json', ...(process.env.VIGO_API_TOKEN ? { Authorization: `Bearer ${process.env.VIGO_API_TOKEN}` } : {}) }
const address = pathname => new URL(pathname, endpoint).href
async function info(pathname) {
  try { const response = await fetch(address(pathname), { headers, signal: AbortSignal.timeout(10_000) }); return response.ok ? await response.json() : { unavailable: response.status } }
  catch (error) { return { unavailable: error.message } }
}
const quantiles = samples => {
  const times = samples.map(s => s.ms).sort((a, b) => a - b)
  return { count: times.length, medianMs: times.length ? times[Math.ceil(times.length * .5) - 1] : null,
    p95Ms: times.length ? times[Math.ceil(times.length * .95) - 1] : null, maxMs: times.at(-1) ?? null }
}
async function replay(repetitions) {
  const samples = new Array(queries.length * repetitions)
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < samples.length) {
      const index = next++, queryIndex = index % queries.length, body = queries[queryIndex]
      const started = performance.now()
      try {
        const response = await fetch(address(`/v1/${body.kind}`), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
        const text = await response.text()
        let result
        try { result = JSON.parse(text) }
        catch { samples[index] = { queryIndex, kind: body.kind, outcome: 'invalid_response', http: response.status, ms: performance.now() - started, bytes: Buffer.byteLength(text), error: 'Response is not valid JSON' }; continue }
        const outcome = response.status === 429 ? 'overloaded' : response.status === 503 ? 'unavailable' : response.status === 504 ? 'timeout' : !response.ok ? 'http_error'
          : result.status === 'ok' ? 'ok' : result.status === 'not_found' ? 'not_found' : 'query_error'
        samples[index] = { queryIndex, kind: body.kind, outcome, http: response.status, ms: performance.now() - started, bytes: Buffer.byteLength(text),
          ...(outcome !== 'ok' && outcome !== 'not_found' ? { error: result.error ?? 'Unexpected public result status' } : {}) }
      } catch (error) { samples[index] = { queryIndex, kind: body.kind, outcome: 'transport_error', ms: performance.now() - started, error: error.message } }
    }
  }))
  return samples
}
async function storage(directory) {
  const directories = new Set(), files = new Set()
  let logicalBytes = 0
  async function visit(entry) {
    const real = await fs.realpath(entry), stat = await fs.stat(real)
    const identity = `${stat.dev}:${stat.ino}`
    if (stat.isDirectory()) {
      if (directories.has(identity)) return
      directories.add(identity)
      for (const name of await fs.readdir(real)) await visit(path.join(real, name))
    } else if (stat.isFile() && !files.has(identity)) { files.add(identity); logicalBytes += stat.size }
  }
  await visit(directory)
  return { uniqueFiles: files.size, logicalBytes, scope: 'Unique file identities, following shared-directory links; not physical APFS or compressed filesystem allocation.' }
}
const report = { schema: 'vigo.benchmark.v1', startedAt: new Date().toISOString(),
  client: { os: process.platform, architecture: process.arch, node: process.version, cpu: os.cpus()[0]?.model },
  workload: { sha256: createHash('sha256').update(raw).digest('hex'), requests: queries.length, rounds, concurrency, warmupRounds: warmup },
  measurement: 'Caller HTTP wall time, including response transfer and JSON parsing; nearest-rank median and p95. Warmup is retained separately. Server memory is not inferred from the client process.' }
try {
  report.health = await info('/healthz')
  if (report.health.unavailable === 404) report.health = await info('/health')
  report.readiness = await info('/readyz')
  report.capabilities = await info('/v1/capabilities')
  if (values.city) report.storage = await storage(values.city)
  report.warmup = await replay(warmup)
  const started = performance.now()
  report.samples = await replay(rounds)
  report.wallMs = performance.now() - started
  report.groups = Object.fromEntries([...new Set(report.samples.map(s => `${s.kind}:${s.outcome}`))].map(key => [key, quantiles(report.samples.filter(s => `${s.kind}:${s.outcome}` === key))]))
  report.failures = [...report.warmup, ...report.samples].filter(s => !['ok', 'not_found'].includes(s.outcome)).length
  report.finishedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output: values.output, groups: report.groups, failures: report.failures }))
  if (report.failures) process.exitCode = 1
} catch (error) {
  report.error = error.message
  report.finishedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  throw error
} finally { await output.close() }
