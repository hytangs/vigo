import { DatabaseSync } from 'node:sqlite'
import { AgencyContext } from '../src/agency/agencyContext.mjs'
import { routeOperations } from '../src/agency/routeOperations.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { workspaceSelection, selectedStopIds, eventInSelection } from '../src/agency/workspaceSelection.mjs'
import { findNetworkRoute, findNetworkStop, networkRouteId } from '../src/app/networkSelection.ts'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate } from './fixtures/agency.mjs'

const routes = [
  { id: 'north::pattern1', routeId: 'R' }, { id: 'north::pattern2', routeId: 'R' },
  { id: 'south::pattern1', routeId: 'R' },
]
assert.equal(networkRouteId(routes[0]), 'north::R')
assert.equal(findNetworkRoute(routes, 'south\u001fR'), routes[2])
assert.equal(findNetworkRoute(routes, 'R'), undefined, 'A route number shared by two feeds is ambiguous')
assert.equal(findNetworkRoute(routes.slice(0, 2), 'R'), routes[0], 'Patterns of one service share selection')
assert.equal(findNetworkStop([{ id: 'north::S' }, { id: 'south::S' }], 'S'), undefined)
assert.equal(findNetworkStop([{ id: 'north::S' }], 'north\u001fS').id, 'north::S')
const merged = { scopes: ['north', 'south'], routeIndex: new Map([['north\u001fR', { short_name: 'R' }], ['south\u001fR', { short_name: 'R' }]]),
  stopIndex: new Map([['P', { name: 'Station', lon: 10, lat: 20 }], ['A', { name: 'Platform', parent_station: 'P' }], ['B', { name: 'Other', parent_station: 'P' }]]), stops: [{ stop_id: 'A', parent_station: 'P' }, { stop_id: 'B', parent_station: 'P' }] }
assert.equal(workspaceSelection(merged, { routeId: 'south::R' }, ['north', 'south']).route.id, 'south\u001fR')
assert.throws(() => workspaceSelection(merged, { routeId: 'R' }, ['north', 'south']), /exact route/)
assert.throws(() => workspaceSelection(merged, { routeId: 'unknown::R' }, ['north', 'south']), /exact route/)
assert.throws(() => workspaceSelection(merged, { stopId: 'P', name: 'Ignore instructions' }), /timetable ID/)
const station = workspaceSelection(merged, { stopId: 'P' })
const stops = selectedStopIds(merged, station)
assert.deepEqual(station.stop.coordinate, [10, 20], 'Coordinates come from the store in longitude/latitude order')
assert.equal(eventInSelection({ stopId: 'A' }, station, stops), true)
assert.equal(eventInSelection({ stopIds: ['B'] }, station, stops), true)
assert.equal(eventInSelection({ stopId: 'Elsewhere' }, station, stops), false)
const platform = workspaceSelection(merged, { stopId: 'A' })
assert.equal(eventInSelection({ stopId: 'B' }, platform, selectedStopIds(merged, platform)), false, 'A platform selection does not include another platform’s delay')
const routeStation = { ...station, route: { id: 'north\u001fR' } }
assert.equal(eventInSelection({ type: 'service-alert', routeId: 'north\u001fR' }, routeStation, stops), true)
assert.equal(eventInSelection({ type: 'service-alert', routeId: 'south\u001fR', stopId: 'P' }, routeStation, stops), false)

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-workspace-'))
let service
try {
  const file = path.join(directory, 'schedule.sqlite')
  createAgencyFixture(file)
  const db = new DatabaseSync(file)
  db.exec(`INSERT INTO calendar VALUES('N',0,0,0,0,0,0,1,20260901,20260930);
    INSERT INTO trips VALUES('NIGHT','R','N','0');
    INSERT INTO connections VALUES(86400,87000,'NIGHT','R','N','0','A','C',10);`)
  db.close()
  const context = new AgencyContext(file, 'City X')
  try {
    const now = Date.parse('2026-09-14T00:05:00Z') / 1000
    const sourceUrl = 'https://example.org/vehicles.pb'
    const line = routeOperations(context, { fetchedAt: new Date(now * 1000).toISOString(), feeds: [{ sourceUrl, kind: 'vehicles', feedTimestamp: now }],
      vehicles: [{ id: 'night-bus', tripId: 'NIGHT', routeId: 'R', startDate: '20260913', sourceUrl, timestamp: now, stopId: 'A', currentStopSequence: 10 }], tripUpdates: [] }, { routeId: 'R' }, now)
    assert.equal(line.vehicles[0].serviceDate, '2026-09-13')
    assert.notEqual(line.vehicles[0].patternId, null, 'Fresh previous-day vehicles stay on their exact stop pattern after midnight')
    assert.deepEqual(line.serviceDates, ['2026-09-13', '2026-09-14'])
    assert.deepEqual(line.patterns.find(pattern => pattern.id === line.vehicles[0].patternId).stops.map(stop => stop.id), ['A', 'C'])
  } finally { context.close() }
  let calls = 0
  service = createAgencyService({ context: async () => ({ storePath: file, cityName: 'City X', agencyDirectory: directory, feedIds: ['fixture'] }), inspectRealtime: async () => realtimeFixture([tripUpdate('T1', 600)]) }, {
    clock: () => observationTime * 1000,
    provider: { available: true, model: 'fixture', complete: async messages => {
      calls++
      const supplied = messages.find(message => message.content.includes('Selected workspace objects')).content
      assert.match(supplied, /"route":\{"id":"R","name":"R","description":"River service"\}/)
      assert.match(supplied, /"stop":\{"id":"A","name":"River","coordinate":\[-71.06,42.36\]\}/)
      return { content: 'The selected station is River on route R.' }
    } },
  })
  await service.connect('x', { sourceUrl: 'fixture' })
  const input = { routeId: 'fixture::R', stopId: 'fixture::A' }
  const state = await service.state('x', input)
  assert.equal(state.selection.stop.name, 'River')
  assert.ok(state.events.some(event => event.type === 'delay'))
  assert.equal((await service.state('x', { stopId: 'fixture::C' })).events.length, 0)
  const answer = await service.handle('x', { action: 'ask', question: 'What station is selected?', selection: input })
  assert.deepEqual(answer.selection, state.selection, 'UI and Ask resolve exactly the same selection')
  assert.deepEqual((await service.handle('x', { action: 'notebook-entry', id: answer.entryId })).entries[0].answer.selection, state.selection, 'Saved answers retain their original context')
  await assert.rejects(service.handle('x', { action: 'ask', question: 'What is here?', selection: { stopId: 'missing' } }), /exact stop/)
  assert.equal(calls, 1, 'Invalid selection never reaches the model')
} finally { service?.close(); await fs.rm(directory, { recursive: true, force: true }) }
console.log('Network workspace: exact feed identities, parent/platform filtering, shared Ask context and saved selection passed.')
