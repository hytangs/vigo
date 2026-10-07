import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-reach-grid-'))
const processes = []
function resident(exe, args) {
  const child = spawn(exe, args, { cwd: root, env: { ...process.env, RAYON_NUM_THREADS: '2' } })
  processes.push(child)
  let errors = ''; child.stderr.on('data', value => { errors += value })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  return async q => {
    child.stdin.write(JSON.stringify({ ...q, diagnostics: 'trace' }) + '\n')
    let timer
    const line = await Promise.race([lines.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Reach timeout: ${errors}`)), 30000)
    })]).finally(() => clearTimeout(timer))
    assert(!line.done, errors)
    const value = JSON.parse(line.value)
    assert(!value.error, JSON.stringify(value.error))
    return value.trace ?? value
  }
}
let cells = 0
try {
  const inputs = await writeCliFixtureInputs(directory)
  const city = path.join(directory, 'city')
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${city}`], { cwd: root, stdio: 'pipe' })
  const node = resident(process.execPath, ['public/vigo.mjs', 'stream', `--city=${city}`, '--service-date=2026-07-15'])
  const rust = resident(standaloneBinary, ['stream', '--city', city])
  for (const mode of ['walk', 'transit']) for (const maxTransfers of [0, 1]) {
    const q = { kind: 'reach', mode, origin: { coordinate: [-77.049, 38.9005] }, serviceDate: '2026-07-15',
      timeMinutes: 475, maxWalkKm: 1.2, maxTransfers, surfaceSampling: 'cell-center',
      cutoffsMinutes: [15, 30, 45], extentRadiusKm: 2, rasterSize: 48 }
    const n = await node(q)
    assert.equal(n.surface.sampling, 'cell-center')
    const r = await rust({ ...q, bounds: n.surface.bounds })
    assert.equal(r.surface.sampling, 'cell-center')
    assert.deepEqual(n.surface.fullBounds, n.surface.bounds)
    assert.deepEqual(n.surface.fullValues, n.surface.values)
    const [w, s, e, north] = n.surface.bounds
    const destinations = Array.from({ length: 48 * 48 }, (_, i) => ({ coordinate: [w + (i % 48 + .5) / 48 * (e - w), north - (Math.floor(i / 48) + .5) / 48 * (north - s)] }))
    const matrix = await node({ ...q, kind: 'matrix', origins: [q.origin], destinations,
      horizonMinutes: 45, allowLongWalk: false, requireTransitRide: false, maxDistanceKm: 1.2 })
    assert.equal(matrix.rows.length, destinations.length)
    let reached = 0
    n.surface.values.forEach((value, i) => {
      const row = matrix.rows[i]
      const expected = row.status === 'ready' && row.durationMinutes <= 45 ? row.durationMinutes : null
      assert.equal(value, expected, `${mode} cap ${maxTransfers} matrix cell ${i}`)
      assert.equal(value === null, r.surface.values[i] === null, `${mode} runtime cell ${i}`)
      if (value !== null) { reached++; assert(Math.abs(value - r.surface.values[i]) <= .0011, `${mode} cell ${i}: ${value} / ${r.surface.values[i]}`) }
      cells++
    })
    assert(reached > 0 && reached < destinations.length, 'The fixture must cover reachable and blocked cells.')
    assert.deepEqual((await node(q)).surface.values, n.surface.values, 'Repeated grids must preserve missing cells and times.')
    if (mode === 'walk' && maxTransfers === 0) {
      const withNodes = await rust({ ...q, bounds: n.surface.bounds, includeNodes: true })
      assert(withNodes.surface.nodes.length > 1, 'Grid Reach must honor requested node evidence without requiring edges.')
      assert.equal(withNodes.diagnostics.surface.nodeEvidenceTruncated, false)
      assert.deepEqual(withNodes.surface.values, r.surface.values, 'Requested evidence must not change grid results.')
    }
  }
  // A grid above one batch exercises the chunk boundary without changing its origin or bounds.
  const q = { kind: 'reach', mode: 'walk', origin: { coordinate: [-77.049, 38.9005] }, serviceDate: '2026-07-15',
    timeMinutes: 475, maxWalkKm: .2, surfaceSampling: 'cell-center', cutoffsMinutes: [5], extentRadiusKm: 1, rasterSize: 192 }
  const n = await node(q), r = await rust({ ...q, bounds: n.surface.bounds })
  assert.equal(n.surface.diagnostics.matrixBatches, 3)
  assert.deepEqual(n.surface.values.map(v => v === null), r.surface.values.map(v => v === null))
  console.log(JSON.stringify({ checkedCells: cells, chunkedCells: n.surface.values.length, modes: ['walk', 'transit'], maxTransfers: [0, 1], repeat: 'identical' }))
} finally {
  await Promise.all(processes.filter(p => p.exitCode === null).map(async p => { const ended = once(p, 'exit'); p.kill(); await ended }))
  fs.rmSync(directory, { recursive: true, force: true })
}
