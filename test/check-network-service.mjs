import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createObservationStore } from '../src/agency/observationStore.mjs'
import { createAgencyFixture, observationTime, realtimeFixture, tripUpdate } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-service-'))
const agencyDirectory = path.join(directory, 'agency')
const storePath = path.join(directory, 'schedule.sqlite')
const source = { sources: [{ url: 'https://example.org/trips.pb', kind: 'tripUpdates' }] }
const snapshot = realtimeFixture([tripUpdate('T1', 900), tripUpdate('T2'), tripUpdate('T3')])
let service, observation
try {
  createAgencyFixture(storePath)
  await fs.mkdir(agencyDirectory)
  const notebookPath = path.join(agencyDirectory, 'notebook.sqlite')
  const notebook = new DatabaseSync(notebookPath)
  notebook.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE entries(id TEXT PRIMARY KEY,value TEXT)')
  notebook.prepare('INSERT INTO settings VALUES(?,?)').run('observation', JSON.stringify({ request: source }))
  notebook.prepare('INSERT INTO entries VALUES(?,?)').run('retained', 'Historical evidence remains on disk')
  notebook.close()
  const original = await fs.readFile(notebookPath)
  observation = createObservationStore(agencyDirectory)
  assert.deepEqual(observation.get(), { request: source })
  observation.close(); observation = null

  let calls = 0, role = 'admin', fail = false, pending = null
  const options = { clock: () => observationTime * 1000, refreshMs: 60_000, access: async () => ({ id: 'fixture', role }) }
  const adapters = {
    context: async () => ({ storePath, agencyDirectory, cityName: 'City X' }),
    inspectRealtime: async () => { calls++; if (pending) return pending; if (fail) throw new Error('Fixture feed unavailable'); return snapshot },
  }
  service = createAgencyService(adapters, options)
  const state = await service.state('city')
  assert.equal(calls, 1, 'A retained connection resumes with fresh observations')
  assert.ok(state.events.length > 0)
  assert.ok(!('provider' in state), 'Network state has no model-provider surface')
  assert.equal((await service.handle('city', { action: 'route-line', routeId: 'R' })).routeId, 'R')
  assert.ok((await service.handle('city', { action: 'stop-board', stopId: 'B' })).rows.length > 0)
  assert.equal((await service.handle('city', { action: 'connection' })).request.sources[0].url, source.sources[0].url)
  for (const action of ['ask', 'tool', 'briefing', 'briefing-latest', 'briefing-settings', 'provider', 'provider-connect', 'notebook-entry', 'operations-health', 'replay-open', 'skills']) {
    await assert.rejects(service.handle('unused-city', { action }), error => error.statusCode === 400)
  }
  role = 'viewer'
  assert.ok((await service.state('city')).events.length > 0)
  await assert.rejects(service.connect('city', source), error => error.statusCode === 403)
  await assert.rejects(service.disconnect('city'), error => error.statusCode === 403)
  role = 'unknown'
  await assert.rejects(service.state('city'), error => error.statusCode === 403)
  role = 'admin'
  service.close(); service = createAgencyService(adapters, options)
  assert.ok((await service.state('city')).events.length > 0, 'The current observation survives service restart')
  assert.equal(calls, 1, 'Fresh stored observations need no duplicate fetch')

  fail = true
  const replacement = { sources: [{ ...source.sources[0], url: 'https://example.org/replacement.pb' }] }
  await assert.rejects(service.connect('city', replacement), /Fixture feed unavailable/)
  assert.equal((await service.state('city')).counts.matchedTrips, 0, 'Failed source replacement cannot retain old reports')
  service.close(); service = createAgencyService(adapters, options)
  assert.equal((await service.state('city')).counts.matchedTrips, 0, 'Restart cannot restore reports from the replaced source')
  fail = false
  await service.connect('city', source)
  await service.disconnect('city')
  service.close(); service = createAgencyService(adapters, options)
  const before = calls
  assert.equal((await service.handle('city', { action: 'connection' })).request, null)
  await service.state('city')
  assert.equal(calls, before, 'Explicit disconnect cannot resurrect an old notebook connection')

  let release
  pending = new Promise(resolve => { release = resolve })
  const connecting = service.connect('city', source)
  while (calls === before) await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => service.invalidate('city'), error => error.statusCode === 409, 'Active requests retain their timetable')
  await service.disconnect('city')
  release(snapshot)
  await assert.rejects(connecting, error => error.statusCode === 409)
  pending = null
  assert.equal((await service.handle('city', { action: 'connection' })).request, null)
  service.invalidate('city')
  assert.equal((await service.handle('city', { action: 'connection' })).request, null)
  assert.deepEqual(await fs.readFile(notebookPath), original, 'Legacy observations and research entries are never modified')
  service.close(); service = null
  assert.deepEqual(await fs.readdir(agencyDirectory), ['network.sqlite', 'notebook.sqlite'])
} finally {
  service?.close(); observation?.close()
  await fs.rm(directory, { recursive: true, force: true })
}
console.log('Network service: live inspection, retired actions, access, persistence, disconnect, source replacement, in-flight invalidation and legacy data preservation passed.')
