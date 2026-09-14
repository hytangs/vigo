import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gtfsQuery } from '../src/agency/gtfsQuery.mjs'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { deriveOperationalState } from '../src/agency/realtimeIntelligence.mjs'
import { createToolRegistry, toolDefinitions, validateArguments } from '../src/agency/toolRegistry.mjs'
import { createAgencyFixture, realtimeFixture, observationTime } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-tools-'))
const file = path.join(directory, 'schedule.sqlite')
createAgencyFixture(file)
const namesDb = new DatabaseSync(file)
namesDb.exec("INSERT INTO stops VALUES('METRO','Metro Center',42.36,-71.06,'',1,''); INSERT INTO stops VALUES('SHOP','Metro Center shop',42.36,-71.06,'',0,'')")
namesDb.close()
let context
try {
  const placeParameters = toolDefinitions.find(tool => tool.name === 'place_search').parameters
  assert.throws(() => validateArguments({ query: 'x'.repeat(201) }, placeParameters), /too long/)
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => validateArguments({ query: 'A', [key]: 'unexpected' }, placeParameters), /Unknown arguments/)
  }
  const q = (sql, limit = 100, options) => gtfsQuery(file, { sql, limit }, options)
  assert.equal((await q('SELECT count(*) AS n FROM main.trips')).rows[0].n, 3)
  assert.equal((await q("WITH named AS (SELECT name FROM stops) SELECT * FROM named WHERE name LIKE 'Lib%'" )).rows[0].name, 'Library')
  assert.equal((await q("SELECT ';' AS punctuation; -- one statement" )).rows[0].punctuation, ';')
  for (const sql of [
    'PRAGMA table_info(routes)', "ATTACH DATABASE ':memory:' AS extra", 'DELETE FROM trips',
    'SELECT * FROM sqlite_master', 'SELECT * FROM main.sqlite_master', 'SELECT * FROM metadata',
    'SELECT * FROM main.metadata', 'SELECT * FROM pragma_table_info(\'trips\')', 'SELECT load_extension(\'x\')',
    'SELECT randomblob(100000000)', 'SELECT * FROM routes; SELECT * FROM stops',
    'WITH x AS (SELECT 1) DELETE FROM trips', 'SELECT * FROM temp.routes',
    'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT * FROM x',
  ]) await assert.rejects(q(sql), undefined, sql)
  const bounded = await q('SELECT * FROM stops', 2)
  assert.equal(bounded.rows.length, 2)
  assert.equal(bounded.truncated, true)
  const writer = new DatabaseSync(file)
  writer.exec('CREATE TABLE private_data(secret TEXT); INSERT INTO private_data VALUES(\'private\')')
  const insert = writer.prepare('INSERT INTO trips VALUES(?,?,?,?)')
  writer.exec('BEGIN')
  for (let i = 0; i < 3000; i++) insert.run(`large-${i}`, 'R', 'S', '0')
  writer.exec('COMMIT')
  writer.prepare('UPDATE stops SET name=? WHERE stop_id=?').run('x'.repeat(300_000), 'C')
  writer.close()
  assert.equal((await q("SELECT name FROM stops WHERE stop_id='C'")).truncated, true)
  await assert.rejects(q('SELECT * FROM main.private_data'))
  const start = Date.now()
  await assert.rejects(q('SELECT count(*) FROM trips a CROSS JOIN trips b CROSS JOIN trips c', 100, { timeoutMs: 200 }), /exceeded/)
  assert.ok(Date.now() - start < 2000, 'The executing SQL process is terminated, not left running behind a timeout response')
  const controller = new AbortController()
  const expensive = q('SELECT count(*) FROM trips a CROSS JOIN trips b CROSS JOIN trips c', 100, { signal: controller.signal })
  setTimeout(() => controller.abort(), 80)
  await assert.rejects(expensive, /cancelled/)
  assert.equal((await q('SELECT count(*) AS n FROM trips')).rows[0].n, 3003, 'Later queries still work after cancellation')
  context = new AgencyContext(file, 'City X')
  assert.equal(context.resolve({ query: 'Metro Center station', kind: 'stop' }).matches[0].id, 'METRO', 'A typed station label resolves to its exact GTFS station, not a nearby similarly named stop')
  assert.equal(context.resolve({ query: 'Metro Center station, City X', kind: 'stop' }).method, 'exact')
  assert.equal(context.resolve({ query: 'Metro Center station, Another City', kind: 'stop' }).matches.length, 0)
  const snapshot = realtimeFixture()
  const state = deriveOperationalState(context, snapshot, observationTime)
  let requested
  const call = createToolRegistry({ context, state, snapshot, provider: { available: false }, adapters: {
    route: async (input) => { requested = input; return { plan: { status: 'ok', diagnostics: { realtimeRouting: { status: 'applied', appliedTrips: 3 } } } } },
    matrix: async (input) => { requested = input; return { durations: [12] } },
    reach: async (input) => { requested = input; return { origin: input.origin } },
  } })
  const journey = { origin: { stopId: 'A', lat: 0, lon: 0 }, destination: { stopId: 'B', lat: 0, lon: 0 }, serviceDate: '2026-09-13', departMinutes: 720 }
  const originalEvents = state.events
  state.events = [
    { id: 'longest', type: 'service-gap', routeId: 'R', evidence: { observedHeadwaySeconds: 1800, scheduledHeadwaySeconds: 1740 }, sourceRefs: ['fixture:longest'] },
    { id: 'largest-change', type: 'service-gap', routeId: 'R', evidence: { observedHeadwaySeconds: 1200, scheduledHeadwaySeconds: 600 }, sourceRefs: ['fixture:largest-change'] },
  ]
  assert.equal((await call('anomaly_scan', { sortBy: 'headway', groupBy: 'route' })).data.events[0].id, 'longest')
  assert.equal((await call('anomaly_scan', { sortBy: 'headwayChange', groupBy: 'route' })).data.events[0].id, 'largest-change', 'Compare the increase over schedule before choosing one finding per route')
  state.events = originalEvents
  const route = await call('route_plan', journey)
  assert.equal(requested.origin.coordinate[1], 42.36, 'Coordinates come from the exact indexed stop')
  assert.equal(requested.realtimeSnapshot.tripUpdates.length, 3)
  assert.equal(route.data.realtime.applied, true)
  assert.match(route.warnings.join(' '), /alerts/)
  await call('route_plan', { origin: { stopId: 'A' }, destination: { stopId: 'B' }, serviceDate: journey.serviceDate, departTime: '08:00' })
  assert.equal(requested.departMinutes, 480, '08:00 stays eight in the morning at the native adapter')
  assert.equal(requested.origin.label, 'River')
  await assert.rejects(call('route_plan', { ...journey, departTime: '08:00' }), /one departure/)
  snapshot.tripUpdates.push({ ...snapshot.tripUpdates[0] })
  await call('route_plan', journey)
  assert.equal(requested.realtimeSnapshot.tripUpdates.length, 2, 'Duplicate trip identities are excluded from the realtime routing overlay')
  snapshot.tripUpdates.pop()
  await assert.rejects(call('route_plan', { ...journey, arbitraryScript: 'x' }), /Unknown/)
  await assert.rejects(call('shell', {}), /Unknown tool/)
  await assert.rejects(call('anomaly_scan', { routeId: 'invented' }), /exact indexed/)
  await call('reach', { origin: { stopId: 'A', lat: 0, lon: 0 }, serviceDate: '2026-09-13', departMinutes: 720, cutoffMinutes: 30 })
  assert.deepEqual(requested.origin.coordinate, [-71.06, 42.36])
  const matrix = await call('matrix', { origins: [journey.origin], destinations: [journey.destination], serviceDate: journey.serviceDate, departMinutes: journey.departMinutes })
  assert.deepEqual(matrix.data.durations, [12])
  assert.equal(requested.allowServiceDateFallback, false)
  await assert.rejects(call('matrix', { origins: [], destinations: [journey.destination], serviceDate: journey.serviceDate, departMinutes: journey.departMinutes }), /size/)
  console.log('Agency tools: SQLite authorization, qualified bypasses, result size, expensive joins, process termination, cancellation, and native routing/reach handoff passed.')
} finally {
  context?.close()
  await fs.rm(directory, { recursive: true, force: true })
}
