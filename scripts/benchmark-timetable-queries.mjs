#!/usr/bin/env node
// Public synthetic microbenchmark, not a City/HTTP or real-world ETA benchmark.
// Tail comparison: --tail --samples 2001 --reference /path/to/reference.node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { timetableQueryFixture, timetableMatrixRequest } from '../test/helpers/timetable-query-fixture.mjs'

const { values } = parseArgs({ options: {
  binding: { type: 'string' }, reference: { type: 'string' },
  tail: { type: 'boolean', default: false },
  samples: { type: 'string', default: '31' }, output: { type: 'string' },
} })
const samples = Number(values.samples)
assert(Number.isInteger(samples) && samples >= 3 && samples <= 100000)
const require = createRequire(import.meta.url)
const current = require(path.resolve(values.binding ?? fileURLToPath(new URL('../native/vigo-routing-kernel/vigo-routing-kernel.node', import.meta.url))))
const reference = values.reference ? require(path.resolve(values.reference)) : null
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const results = []
for (const groups of (values.tail ? [128] : [8, 128])) {
  const fixture = timetableQueryFixture(groups)
  const kernels = [reference && new reference.TimetableKernel(fixture), new current.TimetableKernel(fixture)]
  for (const [originCount, destinationCount] of [[1, 1], [16, 16], [1, 128], [128, 1]]) {
    for (const arriveBy of [false, true]) for (const includeJourneys of [false, true]) for (const terminalTransfers of [false, true]) {
      if (values.tail && !(includeJourneys && (
        arriveBy && originCount === 1 && destinationCount === 128
        || !arriveBy && originCount === 128 && destinationCount === 1
      ))) continue
      const request = timetableMatrixRequest(
        Array.from({ length: originCount }, (_, i) => i % 128),
        Array.from({ length: destinationCount }, (_, i) => 31 + i % 128),
        { arriveBy, includeJourneys, maximumBoardings: 3,
          allowPreRideTransfers: Array(originCount).fill(terminalTransfers),
          allowPostRideTransfers: Array(destinationCount).fill(terminalTransfers) },
      )
      const timings = [[], []], native = [[], []], first = []
      const counters = []
      let expected
      const run = (index, timed) => {
        if (!kernels[index]) return
        const start = performance.now()
        const result = kernels[index].routeMatrixCsa(request)
        const wallMs = performance.now() - start
        if (!first[index]) first[index] = { wallMs, nativeMs: result.queryNs / 1e6 }
        if (timed) { timings[index].push(wallMs); native[index].push(result.queryNs / 1e6) }
        // Work counters may improve across builds; all returned routing
        // semantics, including complete selected witnesses, must match.
        const { times, journeys, queryNs, ...work } = result
        counters[index] = work
        const semantic = { times, journeys }
        if (expected) assert.deepEqual(semantic, expected)
        else expected = semantic
      }
      for (let warm = 0; warm < 3; warm++) { run(0, false); run(1, false) }
      for (let sample = 0; sample < samples; sample++) {
        // Alternate which build executes first to reduce ordering bias.
        for (const index of sample % 2 ? [1, 0] : [0, 1]) run(index, true)
      }
      const summarize = i => kernels[i] ? {
        firstRequest: first[i], medianMs: percentile(timings[i], .5),
        p95Ms: percentile(timings[i], .95),
        p99Ms: samples >= 100 ? percentile(timings[i], .99) : null,
        p999Ms: samples >= 1000 ? percentile(timings[i], .999) : null,
        maxMs: Math.max(...timings[i]), nativeMedianMs: percentile(native[i], .5),
        samplesMs: timings[i], nativeSamplesMs: native[i],
        workspaceBytes: kernels[i].diagnostics().workspaceBytes,
        counters: counters[i],
      } : null
      results.push({ stops: fixture.stopCount, connections: fixture.fromStop.length,
        origins: originCount, destinations: destinationCount, arriveBy, includeJourneys, terminalTransfers,
        reachablePairs: expected.times.filter(Number.isFinite).length,
        exactOutputParity: Boolean(reference), reference: summarize(0), current: summarize(1) })
    }
  }
}
const report = {
  boundary: 'Resident native timetable Matrix call including Node-API input/output conversion; native timing reported separately. Synthetic prepared timetable only; excludes City loading, street access, fares, geometry, JSON, HTTP and process startup.',
  state: 'No result cache. Prepared timetable and scratch memory remain resident. First request is per workload on a reused kernel, not a cold process or cold filesystem.',
  platform: `${process.platform}/${process.arch}`, node: process.version, samples,
  tailSubset: values.tail,
  quantiles: 'Empirical nearest-rank per workload; p99 requires at least 100 samples, p99.9 at least 1000. Extreme percentiles remain sensitive to scheduling and sample count.',
  results,
}
const json = JSON.stringify(report, null, 2) + '\n'
if (values.output) fs.writeFileSync(values.output, json, { flag: 'wx' })
console.log(json)
