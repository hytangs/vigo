// Public synthetic City + protocol-shaped NDW v3 records. No provider/network dependency.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-traffic-'))
const city = path.join(directory, 'city')
const children = []
function resident(executable, args) {
  const child = spawn(executable, args, {
    cwd: root,
    env: { ...process.env, RAYON_NUM_THREADS: '2' },
  })
  children.push(child)
  let stderr = ''
  child.stderr.on('data', (v) => {
    stderr += v
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  return async (q) => {
    child.stdin.write(`${JSON.stringify(q.traffic ? { ...q, routingDataMode: 'realtime' } : q)}\n`)
    let timer
    const line = await Promise.race([
      lines.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Query timeout ${stderr}`)), 30000)
      }),
    ]).finally(() => clearTimeout(timer))
    assert(!line.done, stderr)
    return JSON.parse(line.value)
  }
}
try {
  const inputs = await writeCliFixtureInputs(directory)
  execFileSync(
    process.execPath,
    [
      'public/vigo.mjs',
      'build',
      `--gtfs=${inputs.gtfsPath}`,
      `--osm=${inputs.osmPath}`,
      `--output=${city}`,
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const now = Date.now()
  const stamp = new Date(now - 60000).toISOString()
  const sites = fs
    .readFileSync(path.join(root, 'crates/vigo-traffic/tests/fixtures/sites.xml'), 'utf8')
    .replace('52 5 52 5.002', '38.9 -77.05 38.905 -77.04 38.91 -77.03')
  const measurements = fs
    .readFileSync(path.join(root, 'crates/vigo-traffic/tests/fixtures/measurements.xml'), 'utf8')
    .replaceAll('2026-10-19T06:07:00Z', stamp)
    .replaceAll('2026-10-19T06:06:00Z', stamp)
    .replace('<roa:duration>30</roa:duration>', '<roa:duration>900</roa:duration>')
  const config = path.join(directory, 'sites.xml.gz'),
    data = path.join(directory, 'measurements.xml.gz')
  fs.writeFileSync(config, gzipSync(sites))
  fs.writeFileSync(data, gzipSync(measurements))
  const prepared = JSON.parse(
    execFileSync(
      binary,
      ['traffic-import', '--city', city, '--configuration', config, '--measurements', data],
      { encoding: 'utf8' },
    ),
  )
  assert.equal(prepared.ingestion.acceptedMeasurements, 1)
  assert.equal(prepared.ingestion.traffic.status, 'applied')
  assert.equal(prepared.edgeIndices.length, 2)
  assert(
    Math.abs(prepared.edgeTimeUnits.reduce((a, b) => a + b, 0) - 90000) <= 1,
    'total segment time must not be duplicated on each edge',
  )
  const rust = resident(binary, ['stream', '--city', city])
  const node = resident(process.execPath, [
    'public/vigo.mjs',
    'stream',
    '--city',
    city,
    '--service-date=2026-07-15',
  ])
  const request = {
    kind: 'route',
    mode: 'drive',
    serviceDate: '2026-07-15',
    time: '08:00',
    origin: { coordinate: [-77.05, 38.9] },
    destination: { coordinate: [-77.03, 38.91] },
    diagnostics: 'trace',
  }
  for (const query of [rust, node]) {
    const baseline = await query(request)
    assert.equal(baseline.status, 'ok', JSON.stringify(baseline))
    const fresh = await query({ ...request, traffic: prepared })
    assert.equal(fresh.status, 'ok', JSON.stringify(fresh))
    assert.equal(
      fresh.meta.traffic?.status,
      'applied',
      JSON.stringify({ runtime: query === rust ? 'rust' : 'node', fresh }),
    )
    assert(fresh.journey.durationSeconds > baseline.journey.durationSeconds)
    const observed = {
      observedAt: stamp,
      observations: [
        {
          coordinates: [
            [-77.05, 38.9],
            [-77.04, 38.905],
            [-77.03, 38.91],
          ],
          travelTimeSeconds: 900,
        },
      ],
    }
    const inline = await query({ ...request, traffic: observed })
    assert.equal(inline.meta.traffic.snapshotKey, fresh.meta.traffic.snapshotKey)
    assert.equal(inline.journey.durationSeconds, fresh.journey.durationSeconds)
    const stale = { ...prepared, observedAt: now - 400000, expiresAt: now - 100000 }
    const expired = await query({ ...request, traffic: stale })
    assert.equal(expired.meta.traffic.status, 'stale_fallback')
    assert.equal(expired.journey.durationSeconds, baseline.journey.durationSeconds)
    // Reusing a caller key cannot conceal different effective weights.
    const closed = { ...prepared, edgeTimeUnits: prepared.edgeIndices.map(() => 2147483647) }
    const blocked = await query({ ...request, traffic: closed })
    assert.equal(blocked.status, 'not_found')
    assert.equal(blocked.meta.traffic.status, 'applied')
    assert.notEqual(blocked.meta.traffic.snapshotKey, fresh.meta.traffic.snapshotKey)
    const staleClosure = await query({
      ...request,
      traffic: { ...closed, observedAt: stale.observedAt, expiresAt: stale.expiresAt },
    })
    assert.equal(staleClosure.meta.traffic.status, 'stale_fallback')
    assert.equal(staleClosure.journey.durationSeconds, baseline.journey.durationSeconds)
    const reset = await query(request)
    assert.equal(reset.journey.durationSeconds, baseline.journey.durationSeconds)
    const noMatches = await query({
      ...request,
      traffic: {
        observedAt: stamp,
        observations: [
          {
            coordinates: [
              [5, 52],
              [5.001, 52],
            ],
            closed: true,
          },
        ],
      },
    })
    assert.equal(noMatches.meta.traffic.status, 'no_matches')
    const invalid = { ...prepared }
    delete invalid.observedAt
    assert.equal((await query({ ...request, traffic: invalid })).status, 'error')
    assert.equal(
      (await query({ ...request, traffic: { ...prepared, streetSourceFingerprint: 'wrong' } }))
        .status,
      'error',
    )
    const matrix = {
      kind: 'matrix',
      mode: 'drive',
      serviceDate: request.serviceDate,
      time: request.time,
      origins: [request.origin],
      destinations: [request.destination],
      traffic: prepared,
      diagnostics: 'trace',
    }
    const m = await query(matrix)
    assert.equal(m.status, 'ok', JSON.stringify(m))
    assert.equal(m.meta.traffic.status, 'applied')
    const staleMatrix = await query({ ...matrix, traffic: stale })
    assert.equal(staleMatrix.meta.traffic.status, 'stale_fallback')
  }
  console.log(
    'Traffic import, Node/Rust route and matrix parity, expiry, reset, metadata and graph identity passed.',
  )
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      child.stdin.end()
      await once(child, 'exit')
    }
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
