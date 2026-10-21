// Public synthetic regression: a slower direct service must remain available
// even when unrestricted ranked results are filled by faster transfers.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
const root = path.resolve(import.meta.dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-direct-alternatives-'))
try {
  const inputs = await writeCliFixtureInputs(directory)
  const zip = await JSZip.loadAsync(fs.readFileSync(inputs.gtfsPath))
  const trips = [
    { id: 'BUS', from: 'A', to: 'B', depart: '08:00:00', arrive: '08:10:00', mode: 3 },
    { id: 'TRAM', from: 'A', to: 'B', depart: '08:01:00', arrive: '08:20:00', mode: 0 },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `FEEDER${i}`, from: 'A', to: 'X', depart: '08:00:00', arrive: '08:04:00', mode: 3 })),
    { id: 'CONNECT', from: 'X', to: 'B', depart: '08:05:00', arrive: '08:12:00', mode: 3 },
  ]
  zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_type\n' + trips.map(t => `${t.id},fixture,${t.id},${t.mode}`).join('\n') + '\n')
  zip.file('trips.txt', 'route_id,service_id,trip_id\n' + trips.map(t => `${t.id},WKD,${t.id}`).join('\n') + '\n')
  zip.file('stop_times.txt', 'trip_id,stop_id,stop_sequence,arrival_time,departure_time\n' + trips.flatMap(t => [
    `${t.id},${t.from},1,${t.depart},${t.depart}`, `${t.id},${t.to},2,${t.arrive},${t.arrive}`,
  ]).join('\n') + '\n')
  fs.writeFileSync(inputs.gtfsPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const city = path.join(directory, 'city')
  execFileSync(process.execPath, ['public/vigo.mjs', 'build', '--gtfs', inputs.gtfsPath, '--osm', inputs.osmPath, '--output', city], { cwd: root, stdio: 'pipe' })
  const query = { origin: { stopId: 'A' }, destination: { stopId: 'B' }, serviceDate: '2026-07-15', time: '08:00', maxWalkKm: 0, requireTransitRide: true, alternatives: 9, alternativeRanking: 'ranked' }
  for (const runtime of ['node', 'standalone']) {
    const run = extra => JSON.parse(execFileSync(runtime === 'node' ? process.execPath : standaloneBinary,
      [...(runtime === 'node' ? ['public/vigo.mjs'] : []), 'route', '--city', city, '--request', '-'],
      { cwd: root, input: JSON.stringify({ ...query, ...extra }), encoding: 'utf8' }))
    const unrestricted = run({ maxTransfers: 3 })
    const direct = run({ maxTransfers: 0 })
    assert.equal(unrestricted.status, 'ok')
    assert.equal(direct.status, 'ok')
    assert.equal(unrestricted.journey.arrivalTime, '08:10:00')
    assert.equal(direct.journey.arrivalTime, unrestricted.journey.arrivalTime)
    const rides = j => j.legs.filter(l => l.type === 'transit')
    const directChoices = [direct.journey, ...(direct.alternatives ?? [])]
    assert(directChoices.every(j => rides(j).length === 1))
    assert(directChoices.some(j => rides(j)[0].route.id.id === 'TRAM' && j.arrivalTime === '08:20:00'), `${runtime} lost slower direct service`)
    assert.equal(direct.alternativeSearch.status, 'complete')
  }
  console.log('Direct-service alternatives passed for Node and standalone: faster bus retained, slower tram available, no invented transfers.')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
