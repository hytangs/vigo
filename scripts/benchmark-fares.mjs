import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { inspectGtfsZip } from '../src/server/gtfs-zip-reader.mjs'
import { readGtfsFareCatalog } from '../src/server/gtfs-fare-store.mjs'
import { quoteBoardingFare } from '../src/fares.mjs'

const [zipPath, storePath, serviceDate, outputPath] = process.argv.slice(2)
if (!zipPath || !storePath || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate ?? '') || process.argv.length > 6) {
  console.error('Usage: node scripts/benchmark-fares.mjs FEED.zip STORE.sqlite YYYY-MM-DD [OUTPUT.json]')
  process.exit(2)
}
const readStart = performance.now()
const catalog = await readGtfsFareCatalog(await inspectGtfsZip(zipPath))
if (!catalog || catalog.unavailableReason) throw new Error('This feed has no supported fare catalog.')
const importMs = performance.now() - readStart
const db = new DatabaseSync(storePath, { readOnly: true })
let samples
try {
  const trips = db.prepare('SELECT route_id, MIN(trip_id) AS trip_id FROM trips GROUP BY route_id').all()
  const connectionQuery = db.prepare('SELECT departure, arrival, from_stop_id, to_stop_id FROM connections WHERE trip_id=? ORDER BY stop_sequence')
  samples = trips.flatMap(trip => {
    const rows = connectionQuery.all(trip.trip_id)
    if (!rows.length) return []
    return [...new Set([0, Math.floor(rows.length / 2)])].map(i => ({ type: 'ride', routeId: trip.route_id, tripId: trip.trip_id,
      fromStopId: rows[i].from_stop_id, toStopId: rows.at(-1).to_stop_id, startMinutes: rows[i].departure / 60, endMinutes: rows.at(-1).arrival / 60 }))
  })
} finally { db.close() }
if (!samples.length || samples.some(sample => sample.routeId.includes('\u001f'))) throw new Error('Use the original unscoped store for this feed.')
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)]
const measure = runs => {
  const times = []
  for (let i = 0; i < runs; i++) for (const sample of samples) {
    const start = performance.now()
    quoteBoardingFare(catalog, sample, serviceDate)
    times.push(performance.now() - start)
  }
  return { medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95) }
}
const first = performance.now()
quoteBoardingFare(catalog, samples[0], serviceDate)
const coldQuoteMs = performance.now() - first
const firstPass = measure(1), warm = measure(8)
const report = { description: 'Fare lookup only; excludes route search, result serialization and UI rendering. Representative trip spans are not an active-service sample.',
  node: process.version, platform: `${process.platform}-${process.arch}`, feed: path.basename(zipPath), serviceDate,
  routes: new Set(samples.map(row => row.routeId)).size, samples: samples.length,
  published: samples.filter(sample => quoteBoardingFare(catalog, sample, serviceDate).status === 'published').length,
  importMs, coldQuoteMs, firstPass, warm }
if (outputPath) await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
