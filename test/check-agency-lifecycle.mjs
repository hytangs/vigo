import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createNotebook } from '../src/agency/notebook.mjs'
import { mock } from 'node:test'
import { createAgencyFixture, observationTime, realtimeFixture } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-lifecycle-'))
const file = path.join(directory, 'schedule.sqlite')
try {
  createAgencyFixture(file)
  for (const retirement of ['reload', 'evict', 'close']) {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers()
    const service = createAgencyService({ context: async id => ({ storePath: file, cityName: id, agencyDirectory: path.join(directory, id) }) }, {
      clock: () => observationTime * 1000,
      provider: { available: true, model: 'fixture', complete: async () => { entered.resolve(); await finish.promise; return { content: 'Investigation retained.' } } },
    })
    try {
      const pending = service.handle('active', { action: 'ask', question: 'Hello' })
      await entered.promise
      if (retirement === 'reload') {
        const time = (await fs.stat(file)).mtimeMs / 1000 + 1
        await fs.utimes(file, time, time)
        await service.state('active')
      } else if (retirement === 'evict') {
        for (let i = 0; i < 8; i++) await service.state(`other-${i}`)
      } else service.close()
      finish.resolve()
      const answer = await pending
      assert.ok(answer.entryId, `${retirement} must not close the notebook used by an active investigation`)
      if (retirement !== 'close') assert.equal((await service.handle('active', { action: 'notebook-entry', id: answer.entryId })).entries.at(-1).answer.answer, 'Investigation retained.')
    } finally { finish.resolve(); service.close() }
  }
  for (const replacement of ['disconnect', 'newer', 'failed-older', 'close']) {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers()
    const calls = []
    const service = createAgencyService({
      context: async () => ({ storePath: file, cityName: 'City', agencyDirectory: path.join(directory, `connection-${replacement}`) }),
      inspectRealtime: async request => {
        calls.push(request.source)
        if (request.source === 'older') { entered.resolve(); await finish.promise }
        return realtimeFixture()
      },
    }, { clock: () => observationTime * 1000, refreshMs: 60_000, provider: { available: false, model: null } })
    try {
      const older = service.connect('city', { source: 'older' })
      const superseded = assert.rejects(older, /superseded|closed/i)
      await entered.promise
      let newer
      if (replacement === 'disconnect') await service.disconnect('city')
      else if (replacement === 'close') service.close()
      else {
        newer = service.connect('city', { source: 'newer' })
        // Wait until the replacement has claimed the connection, without resolving the old transport.
        for (let attempt = 0; (await service.handle('city', { action: 'connection' })).request.source !== 'newer'; attempt++) {
          assert.ok(attempt < 100, 'The replacement connection must claim its source before fetching')
          await new Promise(resolve => setImmediate(resolve))
        }
      }
      if (replacement === 'failed-older') finish.reject(new Error('Old feed unavailable'))
      else finish.resolve()
      await superseded
      if (newer) {
        await newer
        assert.deepEqual(calls, ['older', 'newer'], 'A failed superseded feed must not block the replacement connection')
        assert.equal((await service.state('city')).connected, true)
      } else if (replacement === 'disconnect') {
        const health = await service.handle('city', { action: 'operations-health' })
        assert.equal(health.monitoring.active, false, 'A completed older connect must not restart monitoring after disconnect')
        assert.equal((await service.state('city')).connected, false)
      }
    } finally { finish.resolve(); service.close() }
  }
  for (const retirement of ['reload', 'evict', 'close']) {
    const finish = Promise.withResolvers()
    const agencyDirectory = path.join(directory, `timer-${retirement}`)
    let calls = 0
    mock.timers.enable({ apis: ['setInterval'] })
    const initial = realtimeFixture(), late = { ...realtimeFixture(), fetchedAt: '2026-09-13T12:01:00.000Z' }
    const service = createAgencyService({
      context: async id => ({ storePath: file, cityName: id, agencyDirectory: path.join(agencyDirectory, id) }),
      inspectRealtime: async () => ++calls === 1 ? initial : finish.promise,
    }, { clock: () => observationTime * 1000, provider: { available: false, model: null } })
    try {
      await service.connect('active', { source: 'fixture' })
      mock.timers.tick(10_000)
      assert.equal(calls, 2, 'The background timer must start a refresh outside an active request')
      if (retirement === 'reload') {
        const time = (await fs.stat(file)).mtimeMs / 1000 + 1
        await fs.utimes(file, time, time)
        await service.handle('active', { action: 'notebook' })
      } else if (retirement === 'evict') {
        for (let i = 0; i < 8; i++) await service.handle(`other-${i}`, { action: 'notebook' })
      } else service.close()
      finish.resolve(late)
      await new Promise(resolve => setImmediate(resolve))
      mock.timers.tick(60_000)
      assert.equal(calls, 2, `${retirement} clears the retired background timer`)
      const retained = createNotebook(path.join(agencyDirectory, 'active'))
      try { assert.equal(retained.get('observation').snapshot.fetchedAt, initial.fetchedAt, `${retirement} generation invalidation prevents late background results from writing into retired storage`) }
      finally { retained.close() }
    } finally { finish.resolve(late); service.close(); mock.timers.reset() }
  }
  {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers()
    const agencyDirectory = path.join(directory, 'replacement-evidence')
    const service = createAgencyService({
      context: async () => ({ storePath: file, cityName: 'City', agencyDirectory }),
      inspectRealtime: async request => {
        if (request.source === 'newer') { entered.resolve(); await finish.promise }
        return realtimeFixture()
      },
    }, { clock: () => observationTime * 1000, refreshMs: 60_000, provider: { available: false, model: null } })
    try {
      await service.connect('city', { source: 'older' })
      assert.equal((await service.state('city')).connected, true)
      const pending = service.connect('city', { source: 'newer' })
      const failed = assert.rejects(pending, /New feed unavailable/)
      await entered.promise
      assert.equal((await service.state('city')).connected, false, 'Previous-source observations cannot be shown under a replacement connection')
      finish.reject(new Error('New feed unavailable'))
      await failed
      assert.equal((await service.state('city')).connected, false, 'A failed replacement cannot restore previous-source observations')
      service.close()
      const restarted = createAgencyService({
        context: async () => ({ storePath: file, cityName: 'City', agencyDirectory }),
        inspectRealtime: async request => { assert.equal(request.source, 'newer'); throw new Error('New feed still unavailable') },
      }, { clock: () => observationTime * 1000, provider: { available: false, model: null } })
      try { assert.equal((await restarted.state('city')).connected, false, 'Restarting after a failed replacement must not restore previous-source observations') }
      finally { restarted.close() }
    } finally { finish.resolve(); service.close() }
  }
} finally { await fs.rm(directory, { recursive: true, force: true }) }
console.log('Agency lifecycle: retained investigations, superseded feed requests, failed replacements, disconnect and shutdown ordering passed.')
