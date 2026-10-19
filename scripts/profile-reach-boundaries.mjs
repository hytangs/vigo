// Deterministic synthetic geometry profile. Optional historical module stays
// outside the source tree; it is never an executable production fallback.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { nativeRasterAreas } from '../src/server/native-routing-kernel.mjs'
const previous = process.argv[2] ? await import(pathToFileURL(path.resolve(process.argv[2]))) : null
const samples = []
for (const size of [96, 192, 320]) {
  for (const pattern of ['smooth', 'fragmented']) {
    const values = Float64Array.from({ length: size * size }, (_, i) => pattern === 'fragmented'
      ? ((i % size + Math.floor(i / size)) % 2 ? Infinity : 1)
      : Math.hypot(i % size - size / 2, Math.floor(i / size) - size / 2) / 4)
    const args = [values, size, size, [-71.12, 42.28, -71.1, 42.3], [5, 10, 20], 'baseline']
    const implementations = [['rust', nativeRasterAreas], ...(previous ? [['previousJs', previous.rasterBoundaryAreas]] : [])]
    const timings = Object.fromEntries(implementations.map(([name]) => [name, []]))
    let expected
    for (let round = 0; round < 6; round++) {
      for (const [name, implementation] of round % 2 ? [...implementations].reverse() : implementations) {
        const begin = performance.now(), result = implementation(...args), ms = performance.now() - begin
        if (round) timings[name].push(ms)
        // Decimal equality after normalizing object key order. Geometry and feature order remain exact.
        const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
        const digest = createHash('sha256').update(JSON.stringify(canonical(result))).digest('hex')
        if (expected) assert.equal(digest, expected, `${size} ${pattern} ${name} parity`)
        expected = digest
      }
    }
    samples.push({ size, pattern, semanticSha256: expected, timings: Object.fromEntries(Object.entries(timings).map(([name, numbers]) => {
      const sorted = [...numbers].sort((a, b) => a - b)
      return [name, { samples: sorted.length, samplesMs: numbers, medianMs: sorted[Math.floor(sorted.length / 2)], maximumMs: sorted.at(-1) }]
    })) })
  }
}
const report = { workload: 'Synthetic square rasters, smooth slope and disconnected checkerboard; three cutoffs', timingBoundary: 'Synchronous function call including N-API and JSON serialization/parsing. Excludes graph search, water estimates, HTTP and map rendering. Warm process; host contention uncontrolled.', samples }
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
