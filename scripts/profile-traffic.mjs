// Matched synthetic CCH query benchmark. Supply the retained pre-change binding.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const baseline = process.argv[2]
if (!baseline)
  throw new Error('Usage: node scripts/profile-traffic.mjs BASELINE.node [OUTPUT.json]')
const current = path.resolve('native/vigo-routing-kernel.node')
const side = 60,
  count = side * side,
  lons = [],
  lats = [],
  offsets = [0],
  targets = [],
  distances = [],
  times = []
for (let y = 0; y < side; y++)
  for (let x = 0; x < side; x++) {
    lons.push(5 + x * 0.0015)
    lats.push(52 + y * 0.001)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      if (x + dx >= 0 && x + dx < side && y + dy >= 0 && y + dy < side) {
        targets.push((y + dy) * side + x + dx)
        distances.push(dx ? 10269 : 11120)
        times.push(dx ? 1027 : 1112)
      }
    offsets.push(targets.length)
  }
const graph = {
  nodeCount: count,
  nodeLons: new Float64Array(lons),
  nodeLats: new Float64Array(lats),
  edgeOffsets: new Uint32Array(offsets),
  edgeTargets: new Uint32Array(targets),
  edgeDistanceUnits: new Uint32Array(distances),
  edgeTimeUnits: new Uint32Array(times),
}
const kernels = [baseline, current].map(
  (file) => new (require(path.resolve(file)).DriveKernel)(graph),
)
const traffic = {
  snapshotKey: 'benchmark-fixed-weights',
  edgeIndices: targets.map((_, i) => i).filter((i) => i % 19 === 0),
  edgeTimeUnits: targets.map((_, i) => times[i] * 3).filter((_, i) => i % 19 === 0),
}
function query(i, t) {
  return {
    originNodes: [i % side],
    originSnapMeters: [0],
    targetNodes: [count - 1 - ((i * 17) % side)],
    targetSnapMeters: [0],
    maximumDistanceMeters: 30000,
    ...(t ? { traffic } : {}),
  }
}
const percentile = (a, p) => {
  const x = [...a].sort((a, b) => a - b)
  return x[Math.min(x.length - 1, Math.floor(p * x.length))]
}
const report = {
  cpu: os.cpus()[0].model,
  platform: `${process.platform}-${process.arch}`,
  nodes: count,
  edges: targets.length,
  queriesPerRound: 1500,
  rounds: 5,
  scope:
    'resident native routeExact including N-API input/output; fixed node snaps; materialized path',
  binaries: [baseline, current].map((file) => ({
    path: file,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  })),
  results: [],
}
for (const mode of ['baseline-costs', 'traffic-costs']) {
  const timing = [[], []],
    kernelTiming = [[], []],
    customization = []
  for (let k = 0; k < 2; k++) {
    const r = kernels[k].routeExact(query(0, mode === 'traffic-costs'))
    customization.push(r.trafficCustomizationNs / 1000)
    for (let i = 0; i < 150; i++) kernels[k].routeExact(query(i, mode === 'traffic-costs'))
  }
  let reference
  for (let round = 0; round < 5; round++)
    for (const k of round % 2 ? [1, 0] : [0, 1]) {
      let checksum = 0
      for (let i = 0; i < 1500; i++) {
        const start = performance.now(),
          r = kernels[k].routeExact(query(i, mode === 'traffic-costs'))
        timing[k].push((performance.now() - start) * 1000)
        kernelTiming[k].push(r.queryNs / 1000)
        checksum += r.durationSeconds
        assert.equal(r.status, 'ready')
        if (mode === 'traffic-costs') assert.equal(r.trafficMetricReused, true)
      }
      reference ??= checksum
      assert.equal(checksum, reference)
    }
  report.results.push({
    mode,
    checksum: reference,
    customizationUs: customization,
    measurements: timing.map((a, k) => ({
      p50Us: percentile(a, 0.5),
      p95Us: percentile(a, 0.95),
      p99Us: percentile(a, 0.99),
      kernelP50Us: percentile(kernelTiming[k], 0.5),
    })),
  })
}
const input = {
  observedAt: Date.now(),
  snapRadiusMeters: 15,
  observations: Array.from({ length: side }, (_, y) => ({
    coordinates: [
      [lons[y * side], lats[y * side]],
      [lons[y * side + side - 1], lats[y * side + side - 1]],
    ],
    delayFactor: 2,
  })),
}
const encoded = JSON.stringify(input),
  k = kernels[1],
  normalize = () =>
    JSON.parse(
      k.normalizeTrafficJson(encoded, 'synthetic-grid', graph.nodeLons, graph.nodeLats, Date.now()),
    )
const start = performance.now(),
  first = normalize(),
  compileMs = performance.now() - start
assert.equal(first.matchedObservations, side)
const admission = []
for (let i = 0; i < 1000; i++) {
  const start = performance.now()
  normalize()
  admission.push((performance.now() - start) * 1000)
}
report.snapshot = {
  observations: side,
  matchedEdges: first.matchedEdges,
  compileMs,
  warmAdmissionP50Us: percentile(admission, 0.5),
  warmAdmissionP95Us: percentile(admission, 0.95),
  memory: process.memoryUsage(),
  note: 'Current compiler only; includes JSON and admission output, excludes provider XML. This is not a provider coverage or end-to-end city benchmark.',
}
// Baselines from before snapshot normalization existed remain supported. When
// both bindings expose it, compare compilation on identical fresh kernels too.
if (typeof kernels[0].normalizeTrafficJson === 'function') {
  const measurements = [[], []]
  let weights
  for (let round = 0; round < 5; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const file = [baseline, current][index]
      const compiler = new (require(path.resolve(file)).DriveKernel)(graph)
      const started = performance.now()
      const result = JSON.parse(compiler.normalizeTrafficJson(encoded, 'synthetic-grid', graph.nodeLons, graph.nodeLats, input.observedAt))
      measurements[index].push(performance.now() - started)
      weights ??= result.nativeInput
      assert.deepEqual(result.nativeInput, weights, 'Both compilers must assign identical weights')
      assert.equal(result.matchedObservations, side)
    }
  }
  report.snapshotCompilation = measurements.map((samples, i) => ({
    version: i ? 'current' : 'baseline', samplesMs: samples, medianMs: percentile(samples, 0.5),
  }))
}
const json = JSON.stringify(report, null, 2) + '\n'
if (process.argv[3]) fs.writeFileSync(process.argv[3], json)
console.log(json)
