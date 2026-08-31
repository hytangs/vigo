#!/usr/bin/env node

import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { performance } from 'node:perf_hooks'
import { writeCliFixtureInputs } from '../scripts/lib/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
const cliPath = path.join(root, 'dist-cli', 'vigo.mjs')
const samples = integerArgument('--samples', 101, 11)
const warmups = integerArgument('--warmups', 10, 1)
const seed = integerArgument('--seed', 20260830, 1)
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-public-benchmark-'))
let child = null

function integerArgument(name, fallback, minimum) {
  const prefix = `${name}=`
  const raw = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  const value = raw ? Number(raw.slice(prefix.length)) : fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`)
  }
  return value
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function directoryBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const absolute = path.join(directory, entry.name)
    return total + (entry.isDirectory() ? directoryBytes(absolute) : fs.statSync(absolute).size)
  }, 0)
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))]
}

function childRssBytes(pid) {
  if (process.platform === 'win32') return null
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024
  } catch {
    return null
  }
}

function seededIndices(count, modulus, initialSeed) {
  let state = initialSeed >>> 0
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % modulus
  })
}

if (!fs.existsSync(cliPath)) {
  throw new Error('Built CLI is missing. Run npm run build:cli before the benchmark.')
}

try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(temporaryRoot)
  const networkPath = path.join(temporaryRoot, 'network')
  const buildStarted = performance.now()
  const build = JSON.parse(execFileSync(process.execPath, [
    cliPath,
    'build-network',
    `--gtfs=${gtfsPath}`,
    `--osm-pbf=${osmPath}`,
    `--output-dir=${networkPath}`,
  ], { encoding: 'utf8' }))
  const buildWallMs = performance.now() - buildStarted

  child = spawn(process.execPath, [
    cliPath,
    'route-ndjson',
    `--store=${build.routingStore.path}`,
    `--street-store=${build.streetStore.path}`,
    '--service-date=2026-07-15',
    '--service-day=weekday',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })

  async function route(request) {
    const started = performance.now()
    child.stdin.write(`${JSON.stringify(request)}\n`)
    const next = await lines.next()
    if (next.done) throw new Error(stderr.trim() || 'Resident VIGO benchmark process stopped.')
    const result = JSON.parse(next.value)
    if (result.status !== 'ok' || result.plan?.status !== 'ready') {
      throw new Error(`Benchmark route failed: ${JSON.stringify(result)}`)
    }
    return { elapsedMs: performance.now() - started, result }
  }

  const odPairs = [
    ['A', 'B'],
    ['A', 'X'],
    ['X', 'B'],
  ]
  const sequence = seededIndices(warmups + samples + 1, odPairs.length, seed)
  const requestFor = (index, id) => ({
    id,
    origin: odPairs[index][0],
    destination: odPairs[index][1],
    time: '07:55',
    timePreference: 'depart',
    routingPreference: 'fastest',
    maxWalkKm: 0.2,
    departureWindowMinutes: 0,
    disableCache: true,
  })

  const first = await route(requestFor(sequence[0], 'first'))
  for (let index = 0; index < warmups; index += 1) {
    await route(requestFor(sequence[index + 1], `warmup-${index}`))
  }
  const rssBytes = childRssBytes(child.pid)
  const measured = []
  const receipts = []
  for (let index = 0; index < samples; index += 1) {
    const routed = await route(requestFor(sequence[index + warmups + 1], `sample-${index}`))
    measured.push(routed.elapsedMs)
    receipts.push({
      status: routed.result.plan.status,
      durationMinutes: routed.result.plan.durationMinutes,
      routes: routed.result.plan.legs
        ?.filter((leg) => leg.type === 'ride')
        .map((leg) => leg.routeId ?? leg.routeShortName ?? ''),
    })
  }
  child.stdin.end()
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `VIGO exited ${code}`)))
  })

  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const output = {
    schemaVersion: 'vigo.public-smoke-benchmark.v1',
    scope: 'deterministic synthetic smoke benchmark; not a universal performance claim',
    vigoVersion: build.version,
    sourceCommit,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    seed,
    inputs: {
      gtfsSha256: sha256File(gtfsPath),
      osmPbfSha256: sha256File(osmPath),
      odPairs,
    },
    preparation: {
      wallMs: buildWallMs,
      reportedMs: build.timing?.totalMs ?? null,
      diskBytes: directoryBytes(networkPath),
    },
    routing: {
      cacheMode: 'disabled',
      warmups,
      samples,
      firstMs: first.elapsedMs,
      meanMs: measured.reduce((sum, value) => sum + value, 0) / measured.length,
      p50Ms: percentile(measured, 0.5),
      p95Ms: percentile(measured, 0.95),
      residentRssBytes: rssBytes,
      pathChecksum: crypto.createHash('sha256').update(JSON.stringify(receipts)).digest('hex'),
    },
  }
  console.log(JSON.stringify(output, null, 2))
} finally {
  if (child?.exitCode === null) child.kill()
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
