import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { routeOperations } from '../src/agency/routeOperations.mjs'
import { stopBoard } from '../src/agency/stopBoard.mjs'
import { scheduledServiceWindow } from '../src/agency/serviceWindow.mjs'

const args = process.argv.slice(2)
if (args.length < 4 || args.length > 5) {
  console.error('Usage: node scripts/benchmark-agency-state.mjs STORE.sqlite SNAPSHOT.json STOP_ID ROUTE_ID [REPORT.json]')
  process.exit(2)
}
const [storePath, snapshotPath, stopId, routeId, reportPath] = args
const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'))
const now = Date.parse(snapshot?.fetchedAt) / 1000
if (!Number.isFinite(now)) throw new Error('The snapshot must have a valid fetchedAt timestamp.')
const start = performance.now()
const context = new AgencyContext(storePath, 'Saved City')
const views = {
  network: context => deriveOperationalState(context, snapshot, now),
  station: context => stopBoard(context, snapshot, { stopId }, now),
  line: context => routeOperations(context, snapshot, { routeId }, now),
  serviceWindow: context => scheduledServiceWindow(context, now, now + 1800),
}
const report = { node: process.version, platform: `${process.platform}-${process.arch}`, observation: snapshot.fetchedAt,
  contextMs: performance.now() - start, iterations: 12, stopId, routeId,
  records: { updates: snapshot.tripUpdates?.length ?? 0, vehicles: snapshot.vehicles?.length ?? 0, alerts: snapshot.alerts?.length ?? 0 }, timings: {} }
try {
  if (!context.coverage(now).valid) throw new Error('Use the timetable applicable at this snapshot time.')
  for (const [name, run] of Object.entries(views)) {
    const coldStart = performance.now()
    run(context)
    const firstCallMs = performance.now() - coldStart, times = []
    for (let i = 0; i < report.iterations; i++) { const started = performance.now(); run(context); times.push(performance.now() - started) }
    times.sort((a, b) => a - b)
    report.timings[name] = { firstCallMs, warmMedianMs: times[Math.floor(times.length / 2)], warmP95Ms: times[Math.ceil(times.length * 0.95) - 1] }
  }
  report.caches = { trips: context.tripCache.snapshot(), timetableWindows: context.referenceCache.snapshot() }
} finally { context.close() }
report.isolated = {}
for (const [name, run] of Object.entries(views)) {
  const started = performance.now()
  const freshContext = new AgencyContext(storePath, 'Saved City')
  const contextMs = performance.now() - started
  try {
    const callStarted = performance.now()
    run(freshContext)
    report.isolated[name] = { contextMs, firstCallMs: performance.now() - callStarted }
  } finally { freshContext.close() }
}
report.scope = 'Read-only snapshot replay at its saved timestamp. Timings use one shared City context in view order; isolated first calls each open a new context. The service window spans 30 minutes. Excludes feed retrieval, HTTP serialization, UI rendering, routing search and model inference. Cold means application caches, not OS disk caches. Cache bytes are estimates, not process memory.'
const text = JSON.stringify(report, null, 2) + '\n'
if (reportPath) await fs.writeFile(reportPath, text)
console.log(text)
