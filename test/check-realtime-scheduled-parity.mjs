import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { buildNationalGtfsStore, disposeNationalGtfsStore, routeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'

// Independent oracle: import a second raw GTFS feed whose literal stop times
// already contain the expected predictions. No realtime resolver/compiler is
// used to create that timetable. Every comparison exercises both public APIs.
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-realtime-static-parity-'))
const stores = []
const stops = ['A', 'B', 'C', 'D']
const baseTrips = {
  main: [['A', 600], ['B', 610, 615], ['C', 625], ['D', 635]],
  slow: [['A', 605], ['B', 616], ['D', 640]],
  later: [['A', 620], ['D', 645]],
  feeder: [['A', 599], ['B', 608]],
  connection: [['B', 612], ['D', 626]],
  laterConnection: [['B', 622], ['D', 637]],
  lastConnection: [['C', 628], ['D', 638]],
  backup: [['A', 650], ['D', 670]],
}
const update = (tripId, changes = {}) => ({ tripId, startDate: '20260821', delaySeconds: 0, ...changes })
const cases = [
  {
    name: 'all predictions unchanged',
    updates: Object.keys(baseTrips).map(tripId => update(tripId)),
    replacements: {},
  },
  {
    name: 'delayed main and canceled early connection',
    updates: [update('main', { delaySeconds: 600 }), update('connection', { scheduleRelationship: 'CANCELED' })],
    replacements: { main: [['A', 610], ['B', 620, 625], ['C', 635], ['D', 645]], connection: null },
  },
  {
    name: 'early departure overtakes another trip',
    updates: [update('main', { delaySeconds: -300 })],
    replacements: { main: [['A', 595], ['B', 605, 610], ['C', 620], ['D', 630]] },
  },
  {
    name: 'interior delay propagates through dwell and later stops',
    updates: [update('main', { stopTimeUpdates: [{ stopId: 'B', stopSequence: 2, arrival: { delay: 180 }, departure: { delay: 180 } }] })],
    replacements: { main: [['A', 600], ['B', 613, 618], ['C', 628], ['D', 638]] },
  },
  {
    name: 'no data resets propagated trip delay',
    updates: [update('main', { delaySeconds: 120, stopTimeUpdates: [{ stopId: 'B', stopSequence: 2, scheduleRelationship: 'NO_DATA' }] })],
    replacements: { main: [['A', 602], ['B', 610, 615], ['C', 625], ['D', 635]] },
  },
  {
    name: 'skipped interior stop removes boarding and alighting',
    updates: [update('main', { stopTimeUpdates: [{ stopId: 'B', stopSequence: 2, scheduleRelationship: 'SKIPPED' }] })],
    replacements: { main: [['A', 600], ['C', 625], ['D', 635]] },
  },
  {
    name: 'skipped terminal requires another connection',
    updates: [update('main', { stopTimeUpdates: [{ stopId: 'D', stopSequence: 4, scheduleRelationship: 'SKIPPED' }] })],
    replacements: { main: [['A', 600], ['B', 610, 615], ['C', 625]] },
  },
  {
    name: 'all origin service canceled',
    updates: ['main', 'slow', 'later', 'feeder', 'backup'].map(tripId => update(tripId, { scheduleRelationship: 'CANCELED' })),
    replacements: { main: null, slow: null, later: null, feeder: null, backup: null },
  },
]
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`
async function build(name, trips) {
  const archive = new JSZip()
  const put = (name, contents) => archive.file(name, contents, { date: new Date('2026-08-01T00:00:00Z') })
  put('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture,https://example.test,UTC\n')
  put('stops.txt', `stop_id,stop_name,stop_lat,stop_lon\n${stops.map((stopId, index) => `${stopId},${stopId},0,${index * .1}`).join('\n')}\n`)
  put('routes.txt', 'route_id,agency_id,route_short_name,route_type\nR,fixture,R,3\n')
  put('trips.txt', `route_id,service_id,trip_id\n${Object.keys(trips).map(tripId => `R,day,${tripId}`).join('\n')}\n`)
  put('calendar_dates.txt', 'service_id,date,exception_type\nday,20260821,1\n')
  put('stop_times.txt', `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${Object.entries(trips).flatMap(([tripId, calls]) =>
    calls.map(([stopId, arrival, departure = arrival]) => {
      // Preserve the source call sequence when a stop is skipped. GTFS does
      // not require these sequences to be contiguous.
      const sequence = baseTrips[tripId].findIndex(call => call[0] === stopId) + 1
      return `${tripId},${clock(arrival)},${clock(departure)},${stopId},${sequence}`
    })).join('\n')}\n`)
  const zipPath = path.join(folder, `${name}.zip`)
  const storePath = path.join(folder, `${name}.sqlite`)
  await fs.writeFile(zipPath, await archive.generateAsync({ type: 'nodebuffer' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })
  stores.push(storePath)
  return storePath
}
const point = stopId => ({ stopId, source: 'stop', coordinate: [stops.indexOf(stopId) * .1, 0] })
function outcome(plan) {
  if (plan.status !== 'ready') return { status: plan.status }
  return {
    status: plan.status, departMinutes: plan.departMinutes, arriveMinutes: plan.arriveMinutes,
    transfers: plan.transfers, walkMinutes: plan.walkMinutes,
  }
}
function verifyWitness(plan, effectiveTrips, label) {
  if (plan.status !== 'ready') return
  for (const leg of plan.legs) {
    assert(leg.endMinutes >= leg.startMinutes, `${label}: backward leg`)
    if (leg.type !== 'ride') continue
    const calls = effectiveTrips[leg.tripId]
    assert(calls, `${label}: used canceled or nonexistent trip ${leg.tripId}`)
    const boarding = calls.findIndex(call => call[0] === leg.fromStopId)
    const alighting = calls.findIndex(call => call[0] === leg.toStopId)
    assert(boarding >= 0 && alighting > boarding, `${label}: boarded/alighted at skipped call`)
    assert.equal(leg.startMinutes, calls[boarding][2] ?? calls[boarding][1], `${label}: incorrect boarding prediction`)
    assert.equal(leg.endMinutes, calls[alighting][1], `${label}: incorrect alighting prediction`)
  }
  for (let index = 1; index < plan.legs.length; index++) {
    assert(plan.legs[index].startMinutes + 1e-6 >= plan.legs[index - 1].endMinutes, `${label}: impossible connection`)
  }
}

let pairs = 0
try {
  const baseStore = await build('scheduled-base', baseTrips)
  for (const [caseIndex, scenario] of cases.entries()) {
    const effectiveTrips = Object.fromEntries(Object.entries({ ...baseTrips, ...scenario.replacements }).filter(([, calls]) => calls !== null))
    const literalStore = await build(`literal-${caseIndex}`, effectiveTrips)
    const realtimeSnapshot = { sourceUrl: 'https://example.test/parity.pb', feedTimestamp: Math.floor(Date.now() / 1000), tripUpdates: scenario.updates }
    let casePairs = 0
    for (const [from, to] of [['A', 'D'], ['A', 'B'], ['B', 'D'], ['C', 'D']]) {
      for (const timePreference of ['depart', 'arrive']) {
        for (const time of timePreference === 'depart' ? [598, 600, 610, 630] : [626, 635, 645, 670]) {
          for (const maxTransfers of [undefined, 0, 1]) {
            for (const routingPreference of ['fastest', 'balanced']) {
              const request = {
                origin: point(from), destination: point(to), serviceDate: '2026-08-21',
                timePreference, ...(timePreference === 'depart' ? { departMinutes: time } : { arriveMinutes: time }),
                maxTransfers, routingPreference, maxWalkKm: .2, __disableDirectWalkDominance: true,
              }
              const label = `${scenario.name}: ${from}→${to} ${timePreference} ${time}, transfers ${maxTransfers}, ${routingPreference}`
              const realtime = routeNationalGtfsStore(baseStore, { ...request, routingDataMode: 'realtime', realtimeSnapshot })
              const literal = routeNationalGtfsStore(literalStore, { ...request, routingDataMode: 'scheduled' })
              assert.deepEqual(outcome(realtime), outcome(literal), label)
              verifyWitness(realtime, effectiveTrips, label)
              verifyWitness(literal, effectiveTrips, label)
              assert.equal(realtime.diagnostics.realtimeRouting.coverage.complete, true, label)
              assert.equal(realtime.diagnostics.realtimeRouting.prunedTrips, 0, label)
              pairs++
              casePairs++
            }
          }
        }
      }
    }
    console.log(`PASS ${scenario.name} (${casePairs} realtime/literal GTFS comparisons)`)
  }
} finally {
  for (const store of stores) disposeNationalGtfsStore(store)
  await fs.rm(folder, { recursive: true, force: true })
}
assert.equal(pairs, 1536)
console.log(`Realtime/scheduled parity check passed (${pairs} paired public queries across ${cases.length} independently imported timetables).`)
