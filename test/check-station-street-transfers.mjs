import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-entrance-transfers-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n'
    + 'A,Origin,38.900,-77.050,0,\nC,Bus stop,38.905,-77.0405,0,\n'
    + 'S,Station,38.905,-77.040,1,\nX,Entrance,38.905,-77.040,2,S\n'
    + 'N,Interior,38.9051,-77.0395,3,S\nY,Platform,38.9051,-77.039,0,S\nB,Destination,38.910,-77.030,0,\n')
  zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\n'
    + 'entry,X,N,1,0,50,60\nplatform,N,Y,1,0,50,60\n')
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
    + 'T1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,C,2\n'
    + 'T2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
  const stops = await zip.file('stops.txt').async('string')
  const pathways = await zip.file('pathways.txt').async('string')
  for (const variant of ['connected', 'unlocated-interior', 'one-way-blocked']) {
    zip.file('stops.txt', variant === 'unlocated-interior' ? stops.replace('N,Interior,38.9051,-77.0395,3,S', 'N,Interior,,,3,S') : stops)
    zip.file('pathways.txt', variant === 'one-way-blocked' ? pathways.replace('platform,N,Y', 'platform,Y,N') : pathways)
    fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const city = path.join(folder, variant)
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
    const db = new DatabaseSync(path.join(city, 'routing/project.sqlite'), { readOnly: true })
    assert(db.prepare("SELECT 1 FROM transfer_provenance WHERE from_stop_id='C' AND to_stop_id='X' AND provenance='osm_certified_radial'").get(),
      'A non-served public entrance must connect to nearby bus stops.')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transfer_provenance WHERE (from_stop_id='Y' OR to_stop_id='Y') AND provenance='osm_certified_radial'").get().n, 0,
      'Street transfers cannot bypass the declared entrance and interior pathway.')
    db.close()
    for (const arrive of [false, true]) {
      const q = { origin: { stopId: 'A' }, destination: { stopId: 'B' }, serviceDate: '2026-07-15',
        time: arrive ? '08:35' : '07:55', timePreference: arrive ? 'arrive_by' : 'depart_at',
        maxTransfers: 1, maxWalkKm: .3, requireTransitRide: true }
      for (const runtime of ['node', 'rust']) {
        const prefix = runtime === 'rust' ? [standaloneBinary] : [process.execPath, 'public/vigo.mjs']
        const flags = runtime === 'node' ? ['--service-date', q.serviceDate, '--time', q.time, '--time-preference', arrive ? 'arrive' : 'depart'] : []
        const call = (kind, body) => JSON.parse(execFileSync(prefix[0], [...prefix.slice(1), kind, '--city', city, '--request', '-', ...flags], {
          cwd: root, input: JSON.stringify({ ...body, diagnostics: 'trace' }), encoding: 'utf8', timeout: 30000 })).trace
        const response = call('route', q)
        const journey = runtime === 'rust' ? response : response.result
        const blocked = variant === 'one-way-blocked'
        assert.equal(journey.status, blocked ? 'blocked' : 'ready', JSON.stringify(response))
        if (!blocked) {
          const legs = journey.legs
          const rides = legs.filter(l => (l.kind ?? l.type) === 'ride')
          assert.deepEqual(rides.map(l => l.tripId), ['T1', 'T2'])
          const walks = legs.filter(l => (l.kind ?? l.type) === 'walk')
          assert(walks.some(l => l.fromStopId === 'C' && l.toStopId === 'X'), JSON.stringify({ runtime, arrive, legs }))
          assert(walks.some(l => l.fromStopId === 'X' && l.toStopId === 'N'))
          assert(walks.some(l => l.fromStopId === 'N' && l.toStopId === 'Y'))
          assert(walks.reduce((sum,l) => sum+l.durationMinutes,0) >= 2)
          if (variant === 'unlocated-interior') {
            assert(walks.some(l => l.stationGeometryStatus === 'incomplete'))
            assert(walks.every(l => (l.coordinates ?? []).every(c => c.every(Number.isFinite))))
          }
        }
        const { origin, destination, ...options } = q
        for (const includeJourneys of [false, true]) {
          const result = call('matrix', { ...options, origins: [origin], destinations: [destination], includeJourneys })
          const duration = runtime === 'rust' ? result.durationsMinutes[0][0] : result.rows[0].durationMinutes
          assert(blocked ? duration == null : Number.isFinite(duration) && duration > 0, JSON.stringify(result))
          if (includeJourneys && !blocked) {
            const j = runtime === 'rust' ? result.journeys[0][0] : result.rows[0].journey
            assert(j.legs.some(l => l.fromStopId === 'X' && l.toStopId === 'N'), JSON.stringify(j))
          }
        }
      }
    }
  }
  for (const exitAllowed of [false, true]) {
    zip.file('stops.txt', stops)
    zip.file('pathways.txt', exitAllowed
      ? pathways.replace('entry,X,N', 'entry,N,X').replace('platform,N,Y', 'platform,Y,N')
      : pathways)
    zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
      + 'T1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,Y,2\n'
      + 'T2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
    fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const city = path.join(folder, exitAllowed ? 'reach-with-exit' : 'reach-without-exit')
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city], {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
    })
    for (const runtime of ['node', 'rust']) {
      const prefix = runtime === 'rust' ? [standaloneBinary] : [process.execPath, 'public/vigo.mjs']
      const flags = runtime === 'node' ? ['--service-date', '2026-07-15'] : []
      const result = JSON.parse(execFileSync(prefix[0], [...prefix.slice(1), 'reach', '--city', city, '--request', '-', ...flags], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        input: JSON.stringify({ origin: { stopId: 'A' }, serviceDate: '2026-07-15', time: '08:00',
          cutoffsMinutes: [15], maxWalkKm: 0.2, maxTransfers: 0, includeNodes: true, diagnostics: 'trace' }),
      })).trace
      const entrance = result.surface.nodes.find(node => {
        const xy = node.coordinate ?? [node.longitude, node.latitude]
        return Math.abs(xy[0] + 77.040) < 1e-8 && Math.abs(xy[1] - 38.905) < 1e-8
      })
      assert.equal(Boolean(entrance), exitAllowed,
        `${runtime}: Reach must respect the declared exit direction. ${JSON.stringify({ stops: result.stops, nodes: result.surface.nodes })}`)
      if (exitAllowed) assert.equal(entrance.durationMinutes, 12, `${runtime}: Reach must pay two minutes inside the station.`)
    }
  }
  console.log('Route, Matrix and Reach retain directed station access and exit costs in both runtimes.')
} finally {
  if (process.env.VIGO_KEEP_TEST_FIXTURE) console.error(`Fixture retained at ${folder}`)
  else fs.rmSync(folder, { recursive: true, force: true })
}
