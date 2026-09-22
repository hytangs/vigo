import assert from 'node:assert/strict'
import { annotateStationAccess, prepareStationAccessPaths, stationAccessTiming } from '../src/server/station-access.mjs'
import { compileNativeStationPaths, validateNativeStationPaths } from '../src/server/native-routing-kernel.mjs'
import { haversineKm } from '../src/server/geometry-utils.mjs'
import { stationPathLookup } from '../src/server/prepared-access-context.mjs'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from '../src/server/routing-snapshot.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { buildNationalGtfsStore, routeNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'

// Decode native witnesses only; the oracle below independently enumerates paths.
function unpack(packed) {
  return Array.from(packed.from, (from, i) => ({ from, to: packed.to[i], seconds: packed.seconds[i], distanceM: packed.distanceM[i],
    stops: [...packed.pathStops.slice(packed.pathOffsets[i], packed.pathOffsets[i + 1])],
    sources: [...packed.pathSources.slice(packed.pathOffsets[i] - i, packed.pathOffsets[i + 1] - i - 1)].map(s => packed.sources[s]),
  }))
}
const stationAccessPaths = (...args) => unpack(prepareStationAccessPaths(...args))

assert.deepEqual(stationAccessTiming({ distanceKm: 1, accessSeconds: 650,
  accessTransferPathDistanceKm: 0.2, accessTransferSeconds: 50,
  accessTransferStopIds: ['entrance', 'platform'], accessTransferSources: ['gtfs_pathway'],
}), { accessCost: { street: { distanceKm: 0.8, seconds: 600 },
  station: { stopIds: ['entrance', 'platform'], sources: ['gtfs_pathway'], distanceKm: 0.2, seconds: 50 } } })
assert.deepEqual(stationAccessTiming({ distanceKm: 1, accessSeconds: 750 }), {})

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
      to_stop_id: to.stop_id, min_transfer_time: Math.floor(random() * 2000), provenance: 'gtfs_pathway', path_distance_m: null,
    })
  }
  const packed = prepareStationAccessPaths({ transfers, stationMembers: new Map(), forbiddenTransferPairs: new Set() }, stops)
  const actual = unpack(packed)
  const { stopIds, sources, ...arrays } = packed
  const restored = decodeRoutingSnapshot(encodeRoutingSnapshot({ stopIds, sources }, arrays))
  const lookup = stationPathLookup({ ...restored.metadata, ...restored.arrays }, stops)
  for (const link of actual) {
    assert.deepEqual(lookup.get(`${link.from}:${link.to}:${link.seconds}`), {
      stopIds: link.stops.map(index => stops[index].stop_id),
      coordinates: link.stops.map(index => [stops[index].lon, stops[index].lat]), sources: link.sources,
    }, 'Persisted station paths must retain the complete directed path and source evidence.')
  }
  assert.equal(lookup.get('999:0:0'), undefined)
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

const blocked = { ...station, forbiddenTransferPairs: new Set(['A\u0000B']) }
assert.deepEqual(stationAccessPaths(blocked, stationStops), [])
const externalPathway = { ...station, transfers: new Map([['outside', [{ to_stop_id: 'A', provenance: 'gtfs_pathway' }]]]),
  stationMembers: new Map([['S', ['A', 'B', 'outside']]]) }
assert.deepEqual(stationAccessPaths(externalPathway, stationStops), [], 'An outside pathway still owns station connectivity')
const streetOnly = { ...station, transfers: new Map([['A', [{ to_stop_id: 'B', provenance: 'osm_certified_radial' }]]]) }
assert.deepEqual(stationAccessPaths(streetOnly, stationStops).map(p => [p.from, p.to]), [[1, 0]], 'Excluded street links still suppress invented parallel links')
for (const cost of [-1, Infinity, NaN]) {
  assert.throws(() => prepareStationAccessPaths({ ...station,
    transfers: new Map([['A', [{ to_stop_id: 'B', provenance: 'gtfs_pathway', path_distance_m: cost }]]]),
  }, stationStops), /Station paths/)
}

const nativeEmpty = { coordinates: new Float64Array(0), platforms: new Uint8Array(0), edges: [], groups: [],
  forbiddenFrom: new Uint32Array(0), forbiddenTo: new Uint32Array(0), fallbackSource: 0, walkingSpeedKph: 4.8 }
assert.deepEqual([...compileNativeStationPaths(nativeEmpty).offsets], [0])
for (const change of [
  { coordinates: Float64Array.of(0) }, { forbiddenFrom: Uint32Array.of(0) },
  { groups: [{ members: [0], declared: false }] }, { walkingSpeedKph: 0 },
  { edges: [{ from: 0, to: 0, seconds: 0, source: 0, street: false }] },
]) assert.throws(() => compileNativeStationPaths({ ...nativeEmpty, ...change }), /Station paths/)

const packedPaths = prepareStationAccessPaths(station, stationStops)
const validPaths = { ...packedPaths, stopCount: 2, sourceCount: packedPaths.sources.length }
validateNativeStationPaths(validPaths)
for (const change of [
  { offsets: Uint32Array.of(0, 9, 1) }, { pathOffsets: Uint32Array.of(0, 1) },
  { seconds: Float64Array.of(-1) }, { to: Uint32Array.of(2) },
  { pathSources: Uint32Array.of(99) }, { pathStops: Uint32Array.of(1, 0) },
]) assert.throws(() => validateNativeStationPaths({ ...validPaths, ...change }), /Prepared station paths/)

const evidenceLegs = [
  { type: 'walk', toStopId: 'A', durationMinutes: 0, distanceKm: 0, streetPathVerified: true },
  { type: 'ride', routeType: 1, fromStopId: 'A', toStopId: 'B' },
  { type: 'walk', fromStopId: 'B', toStopId: 'C', transferSource: 'osm_certified_radial', streetPathVerified: true },
  { type: 'ride', routeType: 3, fromStopId: 'C', toStopId: 'D' },
  { type: 'walk', fromStopId: 'D', streetPathVerified: true },
]
const evidence = annotateStationAccess(evidenceLegs)
assert.equal(evidence.unverifiedStationAccessLegs, 2,
  'Coincident coordinates and an OSM street witness do not establish a subway entrance path.')
assert.equal(evidenceLegs[0].streetPathVerified, false)
assert.equal(evidenceLegs[2].streetSegmentVerified, true)
assert.equal(evidenceLegs[4].stationAccessStatus, undefined, 'Ordinary bus access is unaffected.')
assert.deepEqual(annotateStationAccess(evidenceLegs), evidence, 'Annotation preserves the narrower evidence on repeated composition.')
const declaredAccess = [
  { type: 'walk', toStopId: 'A', stationPathSources: ['gtfs_pathway'] },
  { type: 'ride', routeType: 1, fromStopId: 'A', toStopId: 'B' },
  { type: 'walk', fromStopId: 'B' },
]
assert.equal(annotateStationAccess(declaredAccess, { exactStationEgress: true }).stationAccessStatus, 'source_path')
assert.equal(declaredAccess[2].stationAccessStatus, undefined)
const transferMinimum = [
  { type: 'walk', toStopId: 'A', transferSource: 'gtfs_transfer' },
  { type: 'ride', routeType: 1, fromStopId: 'A', toStopId: 'B' },
]
assert.equal(annotateStationAccess(transferMinimum).stationAccessStatus, 'unverified',
  'A published transfer minimum is timing evidence, not an interior-path witness.')

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
    assert.equal(plan.diagnostics.stationAccessStatus, usePathway ? 'source_path' : 'unverified')
    assert.equal(plan.diagnostics.unverifiedStationAccessLegs, usePathway ? 0 : 1)
    if (!usePathway) assert.match(plan.detail, /station access unverified/)
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
