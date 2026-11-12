// A journey whose final ride gives way to a longer walk (expandedWalkKm) was
// found with the wider walking limit's endpoint evidence. Its shared-leg
// substitutions must be rebuilt from that evidence, not the ordinary one,
// which does not list the stop the longer walk leaves from.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-shared-expanded-'))
try {
  // Stops on the fixture's street nodes 1, 2 and 3, about a kilometre apart.
  const stops = { O: [-77.05, 38.9], A: [-77.04, 38.905], C: [-77.03, 38.91] }
  const clock = (minutes) => `08:${String(minutes).padStart(2, '0')}:00`
  // Three services share O→A; G leaves A for C fifteen minutes later.
  const trips = [
    ['F', ['O', 'A'], [0, 5]],
    ['E', ['O', 'A'], [1, 6]],
    ['M', ['O', 'A'], [2, 7]],
    ['G', ['A', 'C'], [20, 25]],
  ]
  const zip = new JSZip()
  const table = (name, header, rows) => zip.file(`${name}.txt`, `${header}\n${rows.join('\n')}\n`)
  table('agency', 'agency_name,agency_url,agency_timezone', [
    'Shared,https://example.test,America/New_York',
  ])
  table(
    'stops',
    'stop_id,stop_name,stop_lat,stop_lon',
    Object.entries(stops).map(([id, [lon, lat]]) => `${id},${id},${lat},${lon}`),
  )
  table(
    'routes',
    'route_id,route_short_name,route_type',
    trips.map(([id]) => `${id},${id},3`),
  )
  table(
    'trips',
    'route_id,service_id,trip_id,shape_id',
    trips.map(([id]) => `${id},ON,${id},${id}`),
  )
  table('calendar_dates', 'service_id,date,exception_type', ['ON,20260715,1'])
  table(
    'stop_times',
    'trip_id,stop_id,stop_sequence,arrival_time,departure_time',
    trips.flatMap(([id, calls, times]) =>
      calls.map((stop, i) => `${id},${stop},${i + 1},${clock(times[i])},${clock(times[i])}`),
    ),
  )
  table(
    'shapes',
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    trips.flatMap(([id, calls]) =>
      calls.map((stop, i) => `${id},${stops[stop][1]},${stops[stop][0]},${i + 1}`),
    ),
  )
  const gtfs = path.join(root, 'feed.zip')
  await fs.writeFile(gtfs, await zip.generateAsync({ type: 'nodebuffer' }))
  const { osmPath } = await writeCliFixtureInputs(root)
  const city = path.join(root, 'city')
  execFileSync(
    standaloneBinary,
    ['build', `--gtfs=${gtfs}`, `--osm=${osmPath}`, '--street-modes=walk', `--output=${city}`],
    { stdio: 'pipe' },
  )
  const route = (request) =>
    JSON.parse(
      execFileSync(standaloneBinary, ['route', '--city', city, '--request', '-'], {
        input: JSON.stringify(request),
        encoding: 'utf8',
      }),
    )
  const request = {
    origin: { stopId: 'O' },
    destination: { coordinate: stops.C },
    serviceDate: '2026-07-15',
    time: '08:00',
    maxWalkKm: 0.5,
    expandedWalkKm: 2.4,
    windowMinutes: 2,
    windowChoices: 'supported',
    sharedLegs: true,
    requireTransitRide: true,
  }
  const result = route(request)
  assert.equal(result.status, 'ok', JSON.stringify(result))
  const journeys = [
    result.journey,
    ...(result.alternatives ?? []).map((a) => a.journey ?? a),
  ].filter(Boolean)
  // The recommended journey walks the rest from A instead of waiting for G.
  const walked = journeys.find(
    (journey) =>
      journey.legs.filter((leg) => leg.type === 'transit').length === 1 &&
      journey.legs.at(-1).type === 'walk' &&
      journey.legs.at(-1).from?.stop?.id === 'A',
  )
  assert(
    walked,
    `No walk-the-rest journey: ${JSON.stringify(journeys.map((j) => j.legs.map((l) => `${l.type}:${l.from?.stop?.id ?? ''}>${l.to?.stop?.id ?? ''}`)))}`,
  )
  const shared = walked.sharedLegAlternatives
  assert(shared, 'Shared legs were not searched for the walk-the-rest journey')
  assert.equal(
    shared.omitted,
    undefined,
    `Substitutions were omitted: ${JSON.stringify(shared.omitted)}`,
  )
  const routes = shared.options
    .map((option) => option.journey.legs.find((leg) => leg.type === 'transit').route.id.id)
    .sort()
  assert.deepEqual(routes, ['E', 'M'], 'The other O→A services are offered for the shared leg')
  console.log(
    `Shared legs of a walk-the-rest journey use its wider endpoint evidence (${shared.options.length} substitutions).`,
  )
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
