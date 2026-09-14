import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { realtimeSnapshotFromFeed } from '../src/server/realtime-snapshot.mjs'

const [inputPath, reportPath, ...extra] = process.argv.slice(2)
if (!inputPath || extra.length) {
  console.error('Usage: node scripts/benchmark-realtime-snapshot.mjs DECODED_FEED.json [REPORT.json]')
  process.exit(2)
}
const feed = JSON.parse(await fs.readFile(inputPath, 'utf8'))
if (!Array.isArray(feed?.entity) || !Number.isFinite(feed?.header?.timestamp)) throw new Error('Supply a decoded feed with an entity array and numeric header timestamp.')
const stamp = new Date(feed.header.timestamp * 1000).toISOString()
const run = () => realtimeSnapshotFromFeed(feed, 'saved-feed', stamp, 'application/x-protobuf')
const firstStarted = performance.now(), snapshot = run()
const report = { node: process.version, platform: `${process.platform}-${process.arch}`, firstCallMs: performance.now() - firstStarted,
  entities: snapshot.entityCount, records: snapshot.counts, stopTimeUpdates: snapshot.tripUpdates.reduce((sum, trip) => sum + trip.stopTimeUpdates.length, 0), iterations: 12 }
const times = []
for (let i = 0; i < report.iterations; i++) { const started = performance.now(); run(); times.push(performance.now() - started) }
times.sort((a, b) => a - b)
report.warmMedianMs = times[Math.floor(times.length / 2)]
report.warmP95Ms = times[Math.ceil(times.length * 0.95) - 1]
report.scope = 'Normalization of supplied decoded records only. No network calls. Excludes protobuf decoding, file reads, serialization, UI rendering and model inference. Fixture provenance must be documented alongside results.'
const text = JSON.stringify(report, null, 2) + '\n'
if (reportPath) await fs.writeFile(reportPath, text)
console.log(text)
