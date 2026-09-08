import assert from 'node:assert/strict'
import { stationAccessPaths } from '../src/server/station-access.mjs'
import { haversineKm } from '../src/server/geometry-utils.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { buildNationalGtfsStore, routeNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'

// Compare compilation with exhaustive simple-path enumeration. Positive
// cycles cannot improve either time or distance; zero-cost ties collapse.
let randomState = 51023
const random = () => ((randomState = (1664525 * randomState + 1013904223) >>> 0) / 2 ** 32)
for (let fixture = 0; fixture < 40; fixture += 1) {
  const stops = Array.from({ length: 6 }, (_, index) => ({
    stop_id: String(index), lon: random() * 0.01, lat: random() * 0.01,
  }))
  const transfers = new Map(stops.map(stop => [stop.stop_id, []]))
  for (const from of stops) for (const to of stops) {
    if (from !== to && random() < 0.3) transfers.get(from.stop_id).push({
      to_stop_id: to.stop_id, min_transfer_time: Math.floor(random() * 2000), provenance: 'gtfs_pathway',
    })
  }
  const actual = stationAccessPaths({ transfers, stationMembers: new Map(), forbiddenTransferPairs: new Set() }, stops)
  for (let from = 0; from < stops.length; from += 1) {
    const expected = []
    function visit(at, seconds, distanceM, seen) {
      if (at !== from) expected.push({ to: at, seconds, distanceM })
      for (const edge of transfers.get(String(at))) {
        const to = Number(edge.to_stop_id)
        if (seen.has(to)) continue
        const distance = haversineKm([stops[at].lon, stops[at].lat], [stops[to].lon, stops[to].lat]) * 1000
        visit(to, seconds + edge.min_transfer_time, distanceM + distance, new Set([...seen, to]))
      }
    }
    visit(from, 0, 0, new Set([from]))
    const frontier = expected.filter(a => !expected.some(b => a.to === b.to && b.seconds <= a.seconds
      && b.distanceM <= a.distanceM && (b.seconds < a.seconds || b.distanceM < a.distanceM)))
    const normalize = rows => [...new Set(rows.map(({ to, seconds, distanceM }) => `${to}:${seconds}:${distanceM.toFixed(6)}`))].sort()
    assert.deepEqual(normalize(actual.filter(path => path.from === from)), normalize(frontier))
  }
}
console.log('Station walking: 40 directed graphs match exhaustive time/distance frontiers.')

const stationStops = [
  { stop_id: 'A', lon: 0, lat: 0 }, { stop_id: 'B', lon: 0.002, lat: 0 },
]
const station = { stationMembers: new Map([['S', ['A', 'B']]]), forbiddenTransferPairs: new Set(),
  transfers: new Map([['A', [{ to_stop_id: 'B', min_transfer_time: 360,
    path_distance_m: 480, provenance: 'gtfs_pathway' }]]]) }
const declared = stationAccessPaths(station, stationStops)
assert.deepEqual(declared.map(p => [p.from, p.to, p.seconds, p.distanceM]), [[0, 1, 360, 480]],
  'Declared one-way station paths retain source length without an invented reverse platform shortcut.')
const fallback = stationAccessPaths({ ...station, transfers: new Map() }, stationStops)
assert(fallback.every(p => p.seconds >= Math.ceil(p.distanceM / (4.8 / 3.6))),
  'A parent-station fallback must include the time needed to cross its distance.')

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-pathway-time-'))
try {
  for (const usePathway of [true, false]) {
    const zip = new JSZip()
    for (const [name, csv] of Object.entries({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nO,Origin,0,-0.01,0,\nS,Station,0,0,1,\nA,Platform A,0,0,0,S\nB,Platform B,0,0.002,0,S\nD,Destination,0,0.02,0,\n',
      'routes.txt': 'route_id,route_short_name,route_type\nR,R,3\n',
      'trips.txt': 'route_id,service_id,trip_id\nR,WK,feeder\nR,WK,early\nR,WK,later\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
        + 'feeder,07:59:00,07:59:00,O,1\nfeeder,08:00:00,08:00:00,A,2\n'
        + 'early,08:02:00,08:02:00,B,1\nearly,08:05:00,08:05:00,D,2\n'
        + 'later,08:03:00,08:03:00,B,1\nlater,08:10:00,08:10:00,D,2\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\n',
    })) zip.file(name, csv)
    if (usePathway) zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nP,A,B,1,1,240,\n')
    const zipPath = path.join(folder, `feed-${usePathway}.zip`), storePath = path.join(folder, `routing-${usePathway}.sqlite`)
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
    await buildNationalGtfsStore({ zipPath, outputPath: storePath })
    if (usePathway) {
      const db = new DatabaseSync(storePath, { readOnly: true })
      assert.equal(db.prepare("SELECT min_transfer_time FROM transfers WHERE from_stop_id='A' AND to_stop_id='B'").get().min_transfer_time, null)
      assert.equal(db.prepare("SELECT path_distance_m FROM transfer_provenance WHERE from_stop_id='B' AND to_stop_id='A'").get().path_distance_m, 240)
      db.close()
    }
    const plan = routeNationalGtfsStore(storePath, {
      origin: { coordinate: [-0.01, 0], stopId: 'O', source: 'stop', label: 'Origin' },
      destination: { coordinate: [0.02, 0], stopId: 'D', source: 'stop', label: 'Destination' },
      departMinutes: 478, serviceDate: '2026-07-06', serviceDay: 'weekday',
      requireTransitRide: true, maxTransfers: 1, maxWalkKm: 1.2, horizonMinutes: 60,
    })
    assert.equal(plan.status, 'ready')
    assert.equal(plan.arriveMinutes, 490, 'Station walking time must not catch the infeasible 08:02 bus.')
    const walk = plan.legs.find(leg => leg.transferSource === (usePathway ? 'gtfs_pathway' : 'parent_station_fallback'))
    if (usePathway) {
      assert.equal(walk.durationMinutes, 3)
      assert.equal(walk.distanceKm, 0.24)
    } else {
      assert(walk.durationMinutes > 2)
      assert(walk.durationMinutes * 60 >= walk.distanceKm / 4.8 * 3600)
    }
  }
  console.log('GTFS pathway and parent-station walking times preserve boarding feasibility.')
} finally {
  disposeAllNationalGtfsStores()
  await fs.rm(folder, { recursive: true, force: true })
}
