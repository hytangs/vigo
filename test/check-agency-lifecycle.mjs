import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture, observationTime } from './fixtures/agency.mjs'

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
} finally { await fs.rm(directory, { recursive: true, force: true }) }
console.log('Agency lifecycle: running investigations retain their context and notebook across timetable reload, eviction and shutdown.')
