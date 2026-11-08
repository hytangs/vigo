// A source pathway through an unlocated node has costs, not a drawable partial line.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-transfer-geometry-'))
try {
  for (const located of [false, true]) {
    const directory = path.join(temporary, String(located))
    fs.mkdirSync(directory)
    const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
    const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
    zip.file('stops.txt', `stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,38.900,-77.050,0,\nX,Arrival,38.905,-77.040,0,P\nN,Interior,${located ? '38.90505,-77.0395' : ','},3,P\nY,Departure,38.9051,-77.039,0,P\nP,Station,38.905,-77.040,1,\nB,Bravo,38.910,-77.030,0,\n`)
    zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type\nR1,fixture,R1,Feeder,3\nR2,fixture,R2,Second,3\n')
    zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nR1,WKD,T1,0\nR2,WKD,T2,0\n')
    zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,X,2\nT2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
    zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nfirst,X,N,1,0,40,30\nsecond,N,Y,1,0,50,40\n')
    fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const city = path.join(directory, 'city')
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${city}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
    const request = { kind: 'route', origin: { stopId: 'A' }, destination: { stopId: 'B' }, serviceDate: '2026-07-15', time: '07:55', maxWalkKm: 1.2, maxTransfers: 1, requireTransitRide: true, diagnostics: 'trace' }
    for (const command of [
      [standaloneBinary, 'route', '--city', city, '--request', '-'],
      [process.execPath, 'public/vigo.mjs', 'stream', '--city', city, '--stream-output=detailed'],
    ]) {
      const result = JSON.parse(execFileSync(command[0], command.slice(1), { cwd: root, input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 30000 }))
      const journey = result.schema === 'vigo.stream.detail.v1' ? result.trace.result : result.trace
      assert.equal(journey.status, 'ready')
      assert.equal(journey.transfers, 1)
      const walks = journey.legs.filter(leg => leg.fromStopId === 'N' || leg.toStopId === 'N')
      assert.equal(walks.length, 2, 'Keep both priced source edges')
      for (const [i, leg] of walks.entries()) {
        assert.equal(leg.accessCost.station.seconds, [30, 40][i])
        assert.equal(leg.accessCost.station.distanceKm, [.04, .05][i])
        if (located) {
          assert.equal(leg.coordinates.length, 2)
          assert.notEqual(leg.stationGeometryStatus, 'incomplete')
        } else {
          assert.deepEqual(leg.coordinates, [], 'Do not represent an unlocated pathway by its one known endpoint')
          assert.equal(leg.stationGeometryStatus, 'incomplete')
        }
      }
    }
  }
  console.log('Station transfer geometry: missing endpoints remain unknown; located edges and source costs are retained.')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
