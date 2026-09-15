// Opt-in release comparison on supplied, identical GTFS/OSM stores. No network
// retrieval or LLM is involved. See docs/ROUTING-032-VERIFICATION.md.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const [repository, storePath, streetStorePath, casesPath, outputPath, baselinePath] = process.argv.slice(2)
if (!outputPath) throw new Error('Usage: node test/replay-routing-release.mjs REPOSITORY GTFS_SQLITE OSM_SQLITE CASES_JSON OUTPUT_JSON [BASELINE_JSON]')
const moduleAt = file => import(pathToFileURL(path.resolve(repository, 'src/server', file)))
const { routeNationalGtfsStore } = await moduleAt('national-gtfs-store.mjs')
const { routeNationalStreetStore } = await moduleAt('national-osm-store.mjs')
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'))
const results = []
for (const { id, request } of cases) {
  const input = { ...request, streetStorePath: path.resolve(streetStorePath) }
  if (!['transit', 'walk', 'drive'].includes(input.mode ?? 'transit')) throw new Error(`Unsupported mode in ${id}`)
  // These are controlled trip updates for historical service dates, not a
  // retained live feed. Refresh only their transport timestamp for admission.
  if (input.realtimeSnapshot) input.realtimeSnapshot = { ...input.realtimeSnapshot, feedTimestamp: Math.floor(Date.now() / 1000) }
  const started = performance.now()
  const plan = ['walk', 'drive'].includes(input.mode)
    ? routeNationalStreetStore(streetStorePath, input)
    : routeNationalGtfsStore(storePath, input)
  results.push({ id, status: plan.status, departure: plan.departMinutes, arrival: plan.arriveMinutes,
    walkingMinutes: plan.walkMinutes, mode: plan.travelMode, scheduleMode: plan.scheduleMode,
    rides: plan.legs?.filter(leg => leg.type === 'ride').map(leg => ({
      tripId: leg.tripId, from: leg.fromName, to: leg.toName,
      fromStopId: leg.fromStopId, toStopId: leg.toStopId, departure: leg.startMinutes, arrival: leg.endMinutes,
    })),
    elapsedMs: +(performance.now() - started).toFixed(3),
    ...(plan.status === 'ready' ? {} : { detail: plan.detail }),
  })
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2) + '\n')
  console.log(`${id}: ${plan.status}`)
}
if (baselinePath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  // Compare the serialized records: optional undefined fields are absent in
  // the saved baseline, including nested ride fields.
  const withoutTiming = rows => JSON.parse(JSON.stringify(rows)).map(({ elapsedMs, ...result }) => result)
  assert.deepEqual(withoutTiming(results), withoutTiming(baseline), 'Routing results differ from the supplied baseline')
  console.log(`${results.length} route results match the baseline (runtime timings excluded).`)
}
