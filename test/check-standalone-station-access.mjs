// Public regressions for selected station costs and honest walking evidence.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { routeNationalGtfsStore, disposeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'

const root = path.resolve(import.meta.dirname, '..')
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-station-evidence-'))
try {
  for (const kind of ['transfer', 'pathway', 'missing_coordinate', 'timed_unlocated', 'unpriced']) {
    const folder = path.join(directory, kind)
    fs.mkdirSync(folder)
    const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
    const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
    zip.file('stops.txt', `stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,38.900,-77.050,0,\nX,Entrance,38.905,-77.040,${kind !== 'transfer' ? 2 : 0},P\nY,Platform,38.9051,-77.039,0,P\nP,Station,38.905,-77.040,1,\nB,Bravo,38.910,-77.030,0,\n${['missing_coordinate', 'timed_unlocated', 'unpriced'].includes(kind) ? 'N,Interior,,,3,P\n' : ''}`)
    zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type\nR1,fixture,R1,Feeder,3\nR2,fixture,R2,Subway,1\n')
    zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,X,2\nT2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
    if (kind === 'transfer') zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nX,Y,2,60\n')
    else {
      zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nR2,WKD,T2,0\n')
      zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
      zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nmoving,X,Y,3,0,90,1\n')
      if (kind === 'missing_coordinate') zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nfirst,X,N,3,0,40,1\nsecond,N,Y,3,0,50,1\n')
      if (kind === 'timed_unlocated') zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nfirst,X,N,1,0,,12\nsecond,N,Y,1,0,,18\n')
      if (kind === 'unpriced') zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nfirst,X,N,1,0,,\nsecond,N,Y,1,0,,\n')
    }
    fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const city = path.join(folder, 'city')
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
    const request = { origin: kind === 'transfer' ? { stopId: 'A' } : { coordinate: [-77.0405, 38.90475] },
      destination: { stopId: 'B' }, serviceDate: '2026-07-15', time: '07:55', maxWalkKm: 1.2,
      maxTransfers: 2, requireTransitRide: true }
    const query = body => JSON.parse(execFileSync(binary, ['route', '--city', city, '--request', '-'], {
      input: JSON.stringify(body), encoding: 'utf8', env: { PATH: '', RAYON_NUM_THREADS: '2' }, timeout: 30000 }))
    const result = query(request)
    if (kind === 'unpriced') {
      assert.equal(result.status, 'blocked', `Unknown station cost must prevent boarding through that link: ${JSON.stringify(result)}`)
      assert(result.warnings.some(w => w.code === 'unpriced_pathways' && w.count === 2))
      const routing = path.join(city, 'routing/project.sqlite')
      for (const arrive of [false, true]) {
        const body = { ...request, timePreference: arrive ? 'arrive_by' : 'depart_at', time: arrive ? '08:40' : '07:55' }
        assert.equal(query(body).status, 'blocked')
        const { origin, destination, ...options } = body
        const matrix = JSON.parse(execFileSync(binary, ['matrix', '--city', city, '--request', '-'], {
          input: JSON.stringify({ ...options, origins: [origin], destinations: [destination], includeJourneys: true }), encoding: 'utf8', timeout: 30000 }))
        assert.deepEqual(matrix.durationsMinutes, [[null]])
        const node = routeNationalGtfsStore(routing, { ...body, timePreference: arrive ? 'arrive' : 'depart', departMinutes: 475, arriveMinutes: 520,
          destination: { ...request.destination, coordinate: [-77.030, 38.910], source: 'stop' },
          streetStorePath: path.join(city, 'osm/street-index.sqlite'), serviceDay: 'weekday' })
        assert.equal(node.status, 'blocked', node.detail)
      }
      disposeNationalGtfsStore(routing)
      continue
    }
    assert.equal(result.status, 'ready', `${kind}: ${JSON.stringify(result).slice(0, 3000)}`)
    const walk = result.legs.find(leg => kind === 'transfer' ? leg.fromStopId === 'X' && leg.toStopId === 'Y' : leg.accessCost)
    assert(walk, `Selected ${kind} witness must be present`)
    if (kind === 'transfer') {
      assert.equal(walk.transferSource, 'gtfs_transfer')
      assert(walk.durationMinutes > 1, 'A transfer minimum cannot underprice the configured walking distance.')
      assert.equal(walk.geometrySource, 'stop_coordinate_fallback')
      assert.equal(walk.stationAccessStatus, 'unverified')
      assert.equal(walk.streetPathVerified, false, 'Published transfer time does not establish an interior OSM path')
    } else {
      const unknown = ['missing_coordinate', 'timed_unlocated'].includes(kind)
      const seconds = kind === 'timed_unlocated' ? 30 : unknown ? 2 : 1
      const distanceKm = kind === 'timed_unlocated' ? 0 : .09
      assert.deepEqual(walk.accessCost.station.stopIds, unknown ? ['X', 'N', 'Y'] : ['X', 'Y'])
      assert.deepEqual(walk.accessCost.station.sources, unknown ? ['gtfs_pathway', 'gtfs_pathway'] : ['gtfs_pathway'])
      assert.equal(walk.accessCost.station.seconds, seconds)
      assert.equal(walk.accessCost.station.distanceKm, distanceKm)
      assert.equal(walk.stationAccessStatus, 'source_path')
      assert(Math.abs(walk.durationMinutes * 60 - walk.accessCost.street.seconds - (seconds)) < 1e-8)
      assert(Math.abs(walk.distanceMeters / 1000 - walk.accessCost.street.distanceKm - distanceKm) < 1e-8)
      assert(walk.accessCost.street.seconds >= walk.accessCost.street.distanceKm / 4.8 * 3600)
      assert.equal(walk.geometrySource, 'osm_and_station_path')
      if (unknown) {
        assert.equal(walk.stationGeometryStatus, 'incomplete')
        assert(walk.coordinates.every(([lon, lat]) => lon < -70 && lat > 35), 'Missing interior coordinates cannot become (0, 0).')
        const routing = path.join(city, 'routing/project.sqlite')
        const node = routeNationalGtfsStore(routing, { ...request, departMinutes: 475,
          destination: { ...request.destination, coordinate: [-77.030, 38.910], source: 'stop' },
          streetStorePath: path.join(city, 'osm/street-index.sqlite'), serviceDay: 'weekday' })
        assert.equal(node.status, 'ready', node.detail)
        const nodeWalk = node.legs.find(leg => leg.accessCost)
        assert.equal(nodeWalk.stationGeometryStatus, 'incomplete')
        assert(nodeWalk.coordinates.every(([lon, lat]) => lon < -70 && lat > 35))
        assert.deepEqual(nodeWalk.accessCost.station.stopIds, ['X', 'N', 'Y'])
        assert.equal(nodeWalk.accessCost.station.seconds, seconds)
        if (kind === 'timed_unlocated') {
          assert.equal(walk.stationDistanceStatus, 'lower_bound')
          assert.equal(nodeWalk.stationDistanceStatus, 'lower_bound')
        }
        disposeNationalGtfsStore(routing)
      }
    }
  }
  console.log('Standalone station access passed: selected directed pathway costs and unverified transfer interiors.')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
