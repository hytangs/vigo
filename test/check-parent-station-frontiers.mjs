import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'

const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-parent-frontiers-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(directory)
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n'
    + 'A,Alpha,38.900,-77.050,0,PA\nX,Transfer,38.905,-77.040,0,\n'
    + 'B,Bravo,38.910,-77.030,0,PB\nPA,Alpha station,38.900,-77.050,1,\nPB,Bravo station,38.910,-77.030,1,\n')
  fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const city = path.join(directory, 'city')
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
  const coordinates = [{ coordinate: [-77.05, 38.9] }, { coordinate: [-77.03, 38.91] }]
  const requests = []
  // Interleave parent, exact-platform and coordinate requests in both roles.
  // A first query catches mismatched origin/destination tokens; repetitions
  // catch candidate labels retained after a later native endpoint query.
  for (const arrive of [false, true]) for (const disableCache of [false, true]) {
    const options = { serviceDate: '2026-07-15', time: arrive ? '08:40' : '07:55',
      timePreference: arrive ? 'arrive' : 'depart', maxWalkKm: .3, requireTransitRide: true, disableCache }
    for (const [origin, destination] of [
      ['PA', 'PB'], [coordinates[0], coordinates[1]], ['A', 'PB'], ['PA', 'B'],
      ['PA', coordinates[1]], [coordinates[0], 'PB'], ['PA', 'PB'], ['A', 'PB'],
    ]) requests.push({ kind: 'route', origin, destination, ...options })
    requests.push({ kind: 'matrix', origins: ['PA', 'A', coordinates[0]],
      destinations: ['PB', 'B', coordinates[1]], includeJourneys: true, includeGeometry: true, ...options })
  }
  let reference
  for (const runtime of ['node', 'rust']) {
    const prefix = runtime === 'node' ? [process.execPath, 'public/vigo.mjs'] : [standaloneBinary]
    const output = execFileSync(prefix[0], [...prefix.slice(1), 'stream', '--city', city], {
      cwd: root, input: requests.map((q, id) => JSON.stringify({ ...q, id })).join('\n') + '\n', encoding: 'utf8', timeout: 60_000,
    }).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(output.length, requests.length)
    const durations = output.map((result, i) => {
      assert.equal(result.status, 'ok', `${runtime} request ${i}: ${JSON.stringify(result)}`)
      if (requests[i].kind === 'route') {
        assert(result.journey.legs.some(leg => leg.type === 'transit'), JSON.stringify(result.journey))
        assert(result.journey.legs.every(leg => leg.durationSeconds === 0 || leg.geometry?.coordinates?.length >= 2), 'Every positive-duration leg must retain geometry: ' + JSON.stringify(result.journey))
        return result.journey.durationSeconds
      }
      assert.equal(result.journeys.flat().length, 9)
      assert(result.journeys.flat().every(journey => journey?.legs?.length), JSON.stringify(result))
      return result.durationsSeconds.flat()
    })
    if (reference) assert.deepEqual(durations, reference, 'Parent selections retain the standalone cost contract.')
    else reference = durations
  }
  console.log('Parent-station Route/Matrix frontiers passed: paired and mixed endpoints, repeated resident queries, depart/arrive, cached/uncached, and Node/Rust parity.')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
