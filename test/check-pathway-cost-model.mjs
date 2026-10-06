import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { estimatedPathwaySeconds } from '../src/server/gtfs/pathway-cost.mjs'

assert.equal(estimatedPathwaySeconds({ pathway_mode: 2, stair_count: '-33' }), 33)
assert.throws(() => estimatedPathwaySeconds({ pathway_mode: 2, stair_count: '1.5' }), /stair_count/)
const root = path.resolve(import.meta.dirname, '..')
const expected = new Map()
let httpChecks = 0
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-pathway-cost-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder)
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n'
    + 'O,Origin,38.899,-77.051,0,\nC,Bus,38.9,-77.05,0,\nS,Station,38.9,-77.05,1,\nA,Entrance,38.9,-77.05,2,S\n'
    + 'N,Inside,,,3,S\nP,Platform,38.9,-77.049,0,S\nB,Destination,38.91,-77.03,0,\n')
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
    + 'T1,07:59:00,07:59:00,O,1\nT1,08:00:00,08:00:00,C,2\nT2,08:01:00,08:01:00,P,1\nT2,08:10:00,08:10:00,B,2\n')
  for (const variant of ['modeled', 'published', 'unknown', 'reverse']) {
    const gate = variant === 'unknown' ? 1 : 6
    zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time,stair_count\n'
      + `gate,A,N,${gate},0,,${variant === 'published' ? 70 : ''},\n`
      + (variant === 'reverse' ? 'stairs,P,N,2,0,,,-20\n' : 'stairs,N,P,2,0,,,20\n'))
    fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const city = path.join(folder, variant)
    execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city], { cwd: root, stdio: 'pipe' })
    const db = new DatabaseSync(path.join(city, 'routing/project.sqlite'), { readOnly: true })
    const gateRow = db.prepare("SELECT min_transfer_time,provenance FROM transfers JOIN transfer_provenance USING(from_stop_id,to_stop_id) WHERE from_stop_id='A' AND to_stop_id='N'").get()
    assert.equal(gateRow.min_transfer_time, variant === 'unknown' ? null : variant === 'published' ? 70 : 5)
    assert.equal(gateRow.provenance, ['unknown', 'published'].includes(variant) ? 'gtfs_pathway' : 'gtfs_pathway_estimated')
    db.close()
    for (const arrive of [false, true]) for (const runtime of ['node', 'rust']) {
      const body = { origin: { stopId: 'O' }, destination: { stopId: 'B' }, serviceDate: '2026-07-15', time: arrive ? '08:10' : '07:55', timePreference: arrive ? 'arrive_by' : 'depart_at', requireTransitRide: true, maxTransfers: 1 }
      const prefix = runtime === 'node' ? [process.execPath, 'public/vigo.mjs'] : [standaloneBinary]
      const flags = runtime === 'node' ? ['--service-date', body.serviceDate, '--time', body.time, '--time-preference', arrive ? 'arrive' : 'depart'] : []
      const raw = JSON.parse(execFileSync(prefix[0], [...prefix.slice(1), 'route', '--city', city, '--request', '-', ...flags], { cwd: root, input: JSON.stringify({ ...body, diagnostics: 'trace' }), encoding: 'utf8' }))
      expected.set(`${variant}/${runtime}/${arrive}/route`, raw)
      const trace = raw.trace ?? raw
      const result = trace.result ?? trace
      const ready = variant === 'modeled'
      assert.equal(result.status, ready ? 'ready' : 'blocked', `${variant}/${runtime}/${arrive}: ${JSON.stringify(result).slice(0,400)}`)
      if (ready) {
        const text = JSON.stringify(result)
        assert(text.includes('gtfs_pathway_estimated'), 'Estimated costs remain distinguishable in the selected witness.')
        assert(text.includes('unverified'), 'Modeled traversal is not relabeled as published timing.')
        assert(raw.journey.legs.some(leg => leg.quality?.stationTime === 'estimated'), 'Public output identifies estimated station time.')
      }
      const { origin, destination, ...options } = body
      for (const includeJourneys of [false, true]) {
        const rawMatrix = JSON.parse(execFileSync(prefix[0], [...prefix.slice(1), 'matrix', '--city', city, '--request', '-', ...flags], {
          cwd: root, input: JSON.stringify({ ...options, origins: [origin], destinations: [destination], includeJourneys, includeGeometry: includeJourneys, diagnostics: 'trace' }), encoding: 'utf8' }))
        expected.set(`${variant}/${runtime}/${arrive}/matrix/${includeJourneys}`, rawMatrix)
        const matrix = rawMatrix.trace
        const duration = runtime === 'rust' ? matrix.durationsMinutes[0][0] : matrix.rows[0].durationMinutes
        assert(ready ? Number.isFinite(duration) && duration > 0 : duration == null,
          `Matrix ${variant}/${runtime}/${arrive}/${includeJourneys}`)
        if (ready && includeJourneys) assert(JSON.stringify(matrix).includes('gtfs_pathway_estimated'), `Witness ${runtime}/${arrive}: ${JSON.stringify(matrix).slice(0,1600)}`)
      }
    }
    // Check production HTTP entry points against the CLI results for the same
    // newly imported City, including blocked outcomes and public provenance.
    for (const runtime of ['node', 'rust']) {
      const token = 'synthetic-pathway-test-token'
      const server = runtime === 'rust'
        ? spawn(standaloneBinary, ['serve', '--city', city, '--port', '0'], { env: { ...process.env, VIGO_API_TOKEN: token } })
        : spawn(process.execPath, ['public/engine-http.mjs'], { cwd: root,
          env: { ...process.env, VIGO_CITY_DIR: city, VIGO_ENGINE_PORT: '0', VIGO_ENGINE_API_TOKEN: token } })
      try {
        const port = await new Promise((resolve, reject) => {
          let log = ''
          const timer = setTimeout(() => reject(new Error(`Pathway HTTP startup timed out: ${log}`)), 15000)
          const read = data => {
            log += data
            const match = log.match(/listening on 127\.0\.0\.1:(\d+)/) ?? log.match(/"port":(\d+)/)
            if (match) { clearTimeout(timer); resolve(Number(match[1])) }
          }
          server.stdout.on('data', read); server.stderr.on('data', read)
          server.once('error', error => { clearTimeout(timer); reject(error) })
          server.once('exit', code => { clearTimeout(timer); reject(new Error(`Pathway HTTP exit ${code}: ${log}`)) })
        })
        const post = async (operation, body) => {
          const response = await fetch(`http://127.0.0.1:${port}/v1/${operation}`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
          })
          assert.equal(response.status, 200, `${variant}/${runtime}/${operation}`)
          return response.json()
        }
        for (const arrive of [false, true]) {
          const body = { origin: { stopId: 'O' }, destination: { stopId: 'B' }, serviceDate: '2026-07-15',
            time: arrive ? '08:10' : '07:55', timePreference: arrive ? 'arrive_by' : 'depart_at',
            requireTransitRide: true, maxTransfers: 1 }
          const route = await post('route', body)
          const reference = expected.get(`${variant}/${runtime}/${arrive}/route`)
          assert.equal(route.status, reference.status)
          assert.deepEqual(route.journey, reference.journey, `${variant}/${runtime}/${arrive}: HTTP/CLI journey`)
          if (variant === 'modeled') assert(route.journey.legs.some(leg => leg.quality?.stationTime === 'estimated'))
          assert.equal(Object.hasOwn(route, 'trace'), false, 'Estimated station time must be visible without trace diagnostics.')
          httpChecks++
          const { origin, destination, ...options } = body
          for (const includeJourneys of [false, true]) {
            const matrix = await post('matrix', { ...options, origins: [origin], destinations: [destination],
              includeJourneys, includeGeometry: includeJourneys })
            const matrixReference = expected.get(`${variant}/${runtime}/${arrive}/matrix/${includeJourneys}`)
            assert.equal(matrix.status, matrixReference.status)
            assert.deepEqual(matrix.durationsSeconds, matrixReference.durationsSeconds)
            assert.deepEqual(matrix.journeys, matrixReference.journeys)
            if (variant === 'modeled' && includeJourneys) {
              assert(matrix.journeys?.[0]?.[0]?.legs.some(leg => leg.quality?.stationTime === 'estimated'),
                'Detailed HTTP matrices must expose estimated station time without diagnostics.')
            }
            httpChecks++
          }
        }
      } finally {
        if (server.exitCode === null && server.signalCode === null) {
          const closed = once(server, 'exit'); server.kill(); await closed
        }
      }
    }
  }
  console.log(`Pathway HTTP: ${httpChecks} Route/Matrix checks passed across Node and Rust.`)
  console.log('Pathway import/routing: stair counts, gates, published precedence, missing costs and direction pass in Node and Rust.')
} finally { fs.rmSync(folder, { recursive: true, force: true }) }
