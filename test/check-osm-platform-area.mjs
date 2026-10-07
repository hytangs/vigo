import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { nationalOsmWayWalkable } from '../src/server/national-osm-store.mjs'

const root = path.resolve(import.meta.dirname, '..')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-platform-area-'))
try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(folder, { platformOutline: true })
  const city = path.join(folder, 'city')
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', gtfsPath, '--osm', osmPath, '--output', city],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
  const durations = []
  for (const runtime of ['node', 'rust']) {
    const prefix = runtime === 'rust' ? [standaloneBinary] : [process.execPath, 'public/vigo.mjs']
    const request = { origin: { coordinate: [-77.0501, 38.90005] }, destination: { coordinate: [-77.04, 38.905] },
      serviceDate: '2026-07-15', time: '08:00', mode: 'walk', diagnostics: 'trace' }
    const response = JSON.parse(execFileSync(prefix[0], [...prefix.slice(1), 'route', '--city', city, '--request', '-'],
      { cwd: root, input: JSON.stringify(request), encoding: 'utf8', timeout: 30000 })).trace
    const journey = runtime === 'rust' ? response : response.result
    assert.equal(journey.status, 'ready', `${runtime}: A platform area outline must not capture the origin in an isolated walking loop.`)
    assert(journey.durationMinutes > 10 && journey.durationMinutes < 20)
    durations.push(journey.durationMinutes)
  }
  assert(Math.abs(durations[0] - durations[1]) < 0.001)
  assert.equal(nationalOsmWayWalkable({ highway: 'platform', area: 'yes' }), false)
  assert.equal(nationalOsmWayWalkable({ highway: 'platform' }), true, 'A mapped platform centre line remains a walking way.')
  assert.equal(nationalOsmWayWalkable({ highway: 'platform', area: 'no' }), true)
  assert.equal(nationalOsmWayWalkable({ highway: 'footway', access: 'private' }), false)
  console.log('Platform outlines cannot trap coordinate walking; both runtimes retain the mapped street route.')
} finally { fs.rmSync(folder, { recursive: true, force: true }) }
