// Public regressions for selected station costs and honest walking evidence.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = path.resolve(import.meta.dirname, '..')
import { standaloneBinary as binary } from './helpers/standalone-runtime.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-station-evidence-'))
try {
  for (const kind of ['transfer', 'pathway']) {
    const folder = path.join(directory, kind)
    fs.mkdirSync(folder)
    const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
    const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
    zip.file('stops.txt', `stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,38.900,-77.050,0,\nX,Entrance,38.905,-77.040,${kind === 'pathway' ? 2 : 0},P\nY,Platform,38.9051,-77.039,0,P\nP,Station,38.905,-77.040,1,\nB,Bravo,38.910,-77.030,0,\n`)
    zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type\nR1,fixture,R1,Feeder,3\nR2,fixture,R2,Subway,1\n')
    zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,X,2\nT2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
    if (kind === 'transfer') zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nX,Y,2,60\n')
    else {
      zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nR2,WKD,T2,0\n')
      zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
      zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nmoving,X,Y,3,0,90,1\n')
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
    assert.equal(result.status, 'ready', `${kind}: ${JSON.stringify(result).slice(0, 3000)}`)
    const walk = result.legs.find(leg => kind === 'transfer' ? leg.fromStopId === 'X' && leg.toStopId === 'Y' : leg.accessCost)
    assert(walk, `Selected ${kind} witness must be present`)
    if (kind === 'transfer') {
      assert.equal(walk.transferSource, 'gtfs_transfer')
      assert.equal(walk.durationMinutes, 1)
      assert.equal(walk.geometrySource, 'stop_coordinate_fallback')
      assert.equal(walk.stationAccessStatus, 'unverified')
      assert.equal(walk.streetPathVerified, false, 'Published transfer time does not establish an interior OSM path')
    } else {
      assert.deepEqual(walk.accessCost.station.stopIds, ['X', 'Y'])
      assert.deepEqual(walk.accessCost.station.sources, ['gtfs_pathway'])
      assert.equal(walk.accessCost.station.seconds, 1)
      assert.equal(walk.accessCost.station.distanceKm, .09)
      assert.equal(walk.stationAccessStatus, 'source_path')
      assert(Math.abs(walk.durationMinutes * 60 - walk.accessCost.street.seconds - 1) < 1e-8)
      assert(Math.abs(walk.distanceMeters / 1000 - walk.accessCost.street.distanceKm - .09) < 1e-8)
      assert(walk.accessCost.street.seconds >= walk.accessCost.street.distanceKm / 4.8 * 3600)
      assert.equal(walk.geometrySource, 'osm_and_station_path')
    }
  }
  console.log('Standalone station access passed: selected directed pathway costs and unverified transfer interiors.')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
