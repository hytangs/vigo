#!/usr/bin/env node
// Golden corpus: public requests and the Results a VIGO executable returns for
// them, against Cities built from the public synthetic fixtures.
//
//   node test/corpus/corpus.mjs record  [--binary <vigo>] [--only <name>]
//   node test/corpus/corpus.mjs check   [--binary <vigo>] [--only <name>]
//   node test/corpus/corpus.mjs harvest --out <directory> [--binary <vigo>]
//
// `record` rewrites test/corpus/recorded from the executable. `check` replays
// every case and fails on any difference outside the declared varying fields.
// `harvest` runs the standalone checks through a recording shim and saves every
// one-shot command they issue, in the same format, for shape coverage. Harvested
// Cities are temporary, so those records are not replayable.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCliFixtureInputs } from '../helpers/cli-fixture-inputs.mjs'
import { cases, cities } from './cases.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const recordedDirectory = path.join(import.meta.dirname, 'recorded')
const args = process.argv.slice(2)
const mode = args[0]
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
const binary = path.resolve(option('binary') ?? process.env.VIGO_STANDALONE_PATH
  ?? path.join(root, 'native/vigo-routing-kernel/target/release', process.platform === 'win32' ? 'vigo.exe' : 'vigo'))
const only = option('only')

// Fields that legitimately differ between runs or builds. Each is replaced by a
// fixed value of the same JSON type, so normalized Results stay schema-valid.
const VARYING = Object.freeze({
  'meta.requestId': 'Generated per request unless the caller supplies id',
  'meta.computeUs': 'Measured time',
  'meta.cityRevision': 'Build timestamp of the City',
  'meta.queryFingerprint': 'Hashes the City revision',
  'profile.timingsUs.*': 'Measured times',
  'revision': 'Build timestamp of the City (info)',
  'trace.**': 'Unstable internal ABI; compared only for presence',
  'request traffic.observedAt': 'Traffic snapshots expire, so cases stamp them at run time',
  'request realtimeSnapshot.feedTimestamp': 'Realtime snapshots go stale, so cases stamp them at run time',
  'meta.realtimeSnapshotFingerprint': 'Hashes a snapshot stamped at run time',
  'cityRevisions.*': 'Build timestamps of the compared Cities',
  '**.memory.**': 'Process memory (info and collection residency)',
})
const STAMPED = 1784113200000

export function normalize(result, request = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const out = structuredClone(result)
  if (out.meta && typeof out.meta === 'object') {
    if (request.id === undefined && typeof out.meta.requestId === 'string') out.meta.requestId = 'vigo-request'
    if (typeof out.meta.computeUs === 'number') out.meta.computeUs = 0
    if (typeof out.meta.cityRevision === 'string') out.meta.cityRevision = 'city-revision'
    if (typeof out.meta.queryFingerprint === 'string') out.meta.queryFingerprint = '0'.repeat(64)
    if (typeof out.meta.realtimeSnapshotFingerprint === 'string') out.meta.realtimeSnapshotFingerprint = '0'.repeat(64)
  }
  if (out.profile?.timingsUs && typeof out.profile.timingsUs === 'object') {
    for (const key of Object.keys(out.profile.timingsUs)) out.profile.timingsUs[key] = 0
  }
  if (/^vigo\.(?:scenarios\.)?info\.v1$/.test(out.schema) && typeof out.revision === 'string') out.revision = 'city-revision'
  if (out.cityRevisions && typeof out.cityRevisions === 'object') {
    for (const key of Object.keys(out.cityRevisions)) out.cityRevisions[key] = 'city-revision'
  }
  if (out.trace !== undefined) out.trace = { normalized: true }
  return zeroMemory(out)
}

function zeroMemory(value) {
  if (Array.isArray(value)) return value.map(zeroMemory)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'memory' ? zeroNumbers(item) : zeroMemory(item)]))
}

function zeroNumbers(value) {
  if (typeof value === 'number') return 0
  if (Array.isArray(value)) return value.map(zeroNumbers)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, zeroNumbers(v)]))
  return value
}

function differences(expected, actual, at = '$', found = []) {
  if (found.length >= 20) return found
  if (Object.is(expected, actual)) return found
  const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (kind(expected) !== kind(actual)) {
    found.push(`${at}: ${kind(expected)} → ${kind(actual)}`)
  } else if (kind(expected) === 'array') {
    if (expected.length !== actual.length) found.push(`${at}: length ${expected.length} → ${actual.length}`)
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) differences(expected[i], actual[i], `${at}[${i}]`, found)
  } else if (kind(expected) === 'object') {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!(key in actual)) found.push(`${at}.${key}: removed`)
      else if (!(key in expected)) found.push(`${at}.${key}: added`)
      else differences(expected[key], actual[key], `${at}.${key}`, found)
    }
  } else {
    found.push(`${at}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`)
  }
  return found
}

async function buildCities(workspace, names) {
  const compiler = path.join(root, 'public/vigo.mjs')
  assert(fs.existsSync(compiler), 'Build the compiler first: npm run build:cli-runtime')
  const built = {}
  for (const name of names) {
    const recipe = cities[name]
    const directory = path.join(workspace, name)
    fs.mkdirSync(directory)
    if (recipe.archive) {
      execFileSync('tar', ['-xzf', path.join(root, recipe.archive), '-C', directory])
      built[name] = path.join(directory, recipe.city)
      continue
    }
    const inputs = await writeCliFixtureInputs(directory, recipe.inputs ?? {})
    if (recipe.prepare) await recipe.prepare(inputs, directory)
    const output = path.join(directory, 'city')
    const command = recipe.collection
      ? ['build-scenarios', '--spec', await recipe.collection(inputs, directory), '--output', output]
      : ['build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${output}`]
    const flags = typeof recipe.build === 'function' ? recipe.build(inputs) : recipe.build ?? []
    execFileSync(process.execPath, [compiler, ...command, ...flags],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    built[name] = output
  }
  return built
}

function run(city, entry) {
  const query = !['info', 'capabilities'].includes(entry.kind)
  const command = entry.kind === 'capabilities' ? ['capabilities'] : [entry.kind, '--city', city, ...(query ? ['--request', '-'] : [])]
  const child = spawnSync(binary, [...command, ...(entry.flags ?? [])],
    { input: query ? JSON.stringify(entry.request) : undefined, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (child.error) throw child.error
  // Results go to stdout; a failed command writes its vigo.error.v1 to stderr.
  for (const output of [child.stdout, child.stderr]) {
    try { return { exitCode: child.status, result: JSON.parse(output) } } catch { /* try the next stream */ }
  }
  throw new Error(`${entry.city}/${entry.name}: no JSON output (exit ${child.status}): ${child.stderr.slice(0, 500)}`)
}

// Compare requests embed earlier Results; normalize those like any Result.
// Snapshots stamped at run time are recorded with a fixed timestamp.
function normalizeRequest(kind, request) {
  if (!request) return null
  const out = structuredClone(request)
  if (kind === 'compare') {
    out.before = normalize(out.before, {})
    out.after = normalize(out.after, {})
  }
  if (out.traffic?.observedAt !== undefined) out.traffic.observedAt = STAMPED
  if (out.realtimeSnapshot?.feedTimestamp !== undefined) out.realtimeSnapshot.feedTimestamp = STAMPED / 1000
  return out
}

function record(entry, outcome) {
  return { case: `${entry.city}/${entry.name}`, city: entry.city, kind: entry.kind, ...(entry.flags ? { flags: entry.flags } : {}),
    exitCode: outcome.exitCode, request: normalizeRequest(entry.kind, entry.request), result: normalize(outcome.result, entry.request ?? {}) }
}

const fileName = entry => `${entry.city}--${entry.name}.json`

// Indented JSON with object-free arrays (rasters, coordinates, geometry) on one
// line, so they stay compact and other changes diff line by line.
function stringify(value, indent = '') {
  const flat = item => item === null || typeof item !== 'object' || (Array.isArray(item) && item.every(flat))
  if (Array.isArray(value)) {
    if (flat(value)) return JSON.stringify(value)
    const inner = indent + '  '
    return `[\n${value.map(item => inner + stringify(item, inner)).join(',\n')}\n${indent}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (!entries.length) return '{}'
    const inner = indent + '  '
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${stringify(item, inner)}`).join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value)
}

async function recordOrCheck(write) {
  const selected = cases.filter(entry => !only || entry.city === only || `${entry.city}/${entry.name}` === only)
  assert(selected.length, `No corpus case matches ${only}`)
  const names = new Set(selected.map(entry => {
    assert(Object.hasOwn(cities, entry.city), `Unknown corpus City: ${entry.city}`)
    return entry.city
  }))
  const seen = new Set()
  for (const entry of cases) {
    const key = `${entry.city}/${entry.name}`
    assert(!seen.has(key), `Duplicate corpus case: ${key}`)
    seen.add(key)
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-corpus-'))
  let failures = 0
  try {
    const built = await buildCities(workspace, names)
    if (write) fs.mkdirSync(recordedDirectory, { recursive: true })
    const results = {}
    for (const listed of selected) {
      const entry = typeof listed.request === 'function' ? { ...listed, request: listed.request(results, Date.now()) } : listed
      const outcome = run(built[entry.city], entry)
      results[`${entry.city}/${entry.name}`] = outcome.result
      const actual = record(entry, outcome)
      const file = path.join(recordedDirectory, fileName(entry))
      if (write) {
        fs.writeFileSync(file, stringify(actual) + '\n')
        continue
      }
      if (!fs.existsSync(file)) {
        console.error(`MISSING ${actual.case}: run record`)
        failures++
        continue
      }
      const expected = JSON.parse(fs.readFileSync(file, 'utf8'))
      // V1 adds admission provenance and one command. Keep the retained 0.5
      // receipts byte-for-byte; assert the additions before projecting them out.
      if (actual.case === 'standard/route-drive-traffic' && !expected.result.meta.traffic) {
        const traffic = actual.result.meta.traffic
        assert.equal(traffic.status, 'applied')
        assert.equal(traffic.source, 'traffic-snapshot')
        assert.equal(traffic.observations, 1)
        assert.equal(traffic.matchedObservations, 1)
        assert.equal(traffic.unmatchedObservations, 0)
        assert.equal(traffic.matchedEdges, 1)
        assert.equal(traffic.closedEdges, 0)
        assert.deepEqual(traffic.rejected, {})
        assert.match(traffic.snapshotKey, /^[a-f0-9]{64}$/)
        assert.equal(Date.parse(traffic.expiresAt) - Date.parse(traffic.observedAt), 300000)
        delete actual.result.meta.traffic
      }
      if (actual.case === 'standard/capabilities' && !expected.result.commands.includes('traffic-import')) {
        assert.equal(actual.result.commands.filter(v => v === 'traffic-import').length, 1)
        actual.result.commands = actual.result.commands.filter(v => v !== 'traffic-import')
      }
      const found = differences(expected, actual)
      if (found.length) {
        failures++
        console.error(`DIFF ${actual.case}\n  ${found.join('\n  ')}`)
      }
    }
    if (write && !only) {
      const expected = new Set(selected.map(fileName))
      for (const name of fs.readdirSync(recordedDirectory)) {
        if (name.endsWith('.json') && !expected.has(name)) fs.rmSync(path.join(recordedDirectory, name))
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
  const verb = write ? 'recorded' : 'replayed'
  console.log(JSON.stringify({ status: failures ? 'failed' : 'passed', [verb]: selected.length, failures, varying: Object.keys(VARYING) }))
  if (failures) process.exitCode = 1
}

// Checks that drive the executable through its one-shot commands. HTTP and
// stream transports share the same projection and are not intercepted.
const HARVEST_CHECKS = [
  'test/check-standalone.mjs', 'test/check-public-results.mjs', 'test/check-scenario-collection.mjs',
  'test/check-service-calendar-boundaries.mjs', 'test/check-standalone-prepared.mjs', 'test/check-standalone-parity.mjs',
  'test/check-standalone-station-access.mjs', 'test/check-parent-station-frontiers.mjs', 'test/check-station-street-transfers.mjs',
  'test/check-osm-platform-area.mjs', 'test/check-pathway-cost-model.mjs', 'test/check-reach-grid.mjs',
  'test/check-wheelchair-routing.mjs', 'test/check-standalone-docs.mjs',
]

function harvest() {
  const out = path.resolve(option('out') ?? '')
  assert(option('out'), 'harvest requires --out <directory>')
  assert(!out.startsWith(root + path.sep), 'Write harvested records outside the repository')
  const raw = path.join(out, 'raw')
  fs.mkdirSync(raw, { recursive: true })
  // Checks replace the environment, so the shim carries absolute paths only.
  const shim = path.join(out, 'vigo-shim')
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  fs.writeFileSync(shim, `#!/bin/bash
real=${quote(binary)}
case "$1" in route|matrix|reach|isochrone|compare|info) ;; *) exec "$real" "$@" ;; esac
n=$(/usr/bin/mktemp ${quote(raw)}/rec.XXXXXXXX)
request=; previous=
for argument in "$@"; do
  [ "$previous" = "--request" ] && request="$argument"
  case "$argument" in --request=*) request="\${argument#--request=}" ;; esac
  previous="$argument"
done
if [ "$request" = "-" ]; then
  /bin/cat > "$n.request"
  "$real" "$@" < "$n.request" > "$n.stdout"; code=$?
else
  [ -n "$request" ] && [ -f "$request" ] && /bin/cp "$request" "$n.request"
  "$real" "$@" > "$n.stdout"; code=$?
fi
/bin/cat "$n.stdout"
printf '%s' "$1" > "$n.kind"
printf '%s' "$code" > "$n.exit"
exit $code
`, { mode: 0o755 })
  const outcomes = []
  for (const check of HARVEST_CHECKS) {
    const child = spawnSync(process.execPath, [check], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
      env: { ...process.env, VIGO_STANDALONE_PATH: shim } })
    outcomes.push({ check, status: child.status })
    console.error(`${child.status === 0 ? 'PASS' : 'FAIL'} ${check}`)
  }
  const records = path.join(out, 'records')
  fs.mkdirSync(records, { recursive: true })
  let kept = 0, skipped = 0
  for (const name of fs.readdirSync(raw).filter(name => /^rec\.[^.]+$/.test(name)).sort()) {
    const read = suffix => fs.existsSync(path.join(raw, `${name}.${suffix}`)) ? fs.readFileSync(path.join(raw, `${name}.${suffix}`), 'utf8') : null
    let request = null, result
    try { request = read('request') ? JSON.parse(read('request')) : null } catch { request = null }
    try { result = JSON.parse(read('stdout') ?? '') } catch { skipped++; continue }
    const entry = { case: `harvest/${name}`, city: 'harvest', kind: read('kind'), exitCode: Number(read('exit')), request,
      result: normalize(result, request ?? {}) }
    fs.writeFileSync(path.join(records, `${name.slice(4)}.json`), JSON.stringify(entry) + '\n')
    kept++
  }
  console.log(JSON.stringify({ status: 'harvested', records, kept, skippedNonJson: skipped, checks: outcomes }))
}

if (mode === 'record') await recordOrCheck(true)
else if (mode === 'check') await recordOrCheck(false)
else if (mode === 'harvest') harvest()
else {
  console.error('Usage: node test/corpus/corpus.mjs record|check|harvest [--binary <vigo>] [--only <name>] [--out <directory>]')
  process.exitCode = 2
}
