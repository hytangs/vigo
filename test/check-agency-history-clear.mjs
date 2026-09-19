import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNotebook } from '../src/agency/notebook.mjs'
import { createAgencyService } from '../src/server/agency-api.mjs'
import { createAgencyFixture } from './fixtures/agency.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-clear-history-'))
let notebook, service
try {
  const agencyDirectory = path.join(directory, 'agency')
  notebook = createNotebook(agencyDirectory)
  const answer = { answer: 'Saved answer', generatedAt: new Date().toISOString(), trace: [], evidenceRefs: [], warnings: [] }
  const first = notebook.save({ title: 'First question', answer })
  notebook.save({ title: 'Follow-up', answer, parentId: first.id })
  notebook.annotate(first.id, 'Private note')
  const briefing = notebook.save({ title: 'Briefing', kind: 'briefing', answer, parentId: first.id })
  const research = notebook.save({ title: 'Research', kind: 'research', answer })
  notebook.set('observation', { retained: true })
  assert.equal(notebook.clearAskHistory().deleted, 2)
  assert.throws(() => notebook.read(first.id), /not found/)
  assert.deepEqual(notebook.recall({ entryId: first.id }), [])
  assert.equal(notebook.read(briefing.id).parentId, null)
  assert.equal(notebook.read(research.id).kind, 'research')
  assert.equal(notebook.get('observation').retained, true)
  notebook.close(); notebook = createNotebook(agencyDirectory)
  assert.equal(notebook.list().length, 2, 'Deletion persists after reopening')
  assert.equal(notebook.clearAskHistory().deleted, 0, 'Clearing twice is safe')
  notebook.close(); notebook = null
  const storePath = path.join(directory, 'schedule.sqlite'); createAgencyFixture(storePath)
  let role = 'admin'
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const paused = new Promise(resolve => { release = resolve })
  service = createAgencyService({ context: async () => ({ storePath, cityName: 'Fixture', agencyDirectory }) }, {
    access: async () => ({ id: 'fixture', role }),
    provider: { available: true, complete: async () => { entered(); await paused; return { content: 'Hello.' } } },
  })
  role = 'viewer'
  await assert.rejects(service.handle('fixture', { action: 'notebook-clear-ask' }), error => error.statusCode === 403)
  role = 'admin'
  const pending = service.handle('fixture', { action: 'ask', question: 'Hello' })
  const rejected = assert.rejects(pending, error => error.statusCode === 409 && /history was cleared/.test(error.message))
  await started
  await service.handle('fixture', { action: 'notebook-clear-ask' })
  release()
  await rejected
  const { entries } = await service.handle('fixture', { action: 'notebook' })
  assert.equal(entries.filter(entry => entry.kind === 'ask').length, 0, 'In-flight answers cannot restore cleared history')
  console.log('Ask history clear: durable deletion, retained research/settings, detached parents, recall exclusion and in-flight answer protection passed.')
} finally { service?.close(); notebook?.close(); await fs.rm(directory, { recursive: true, force: true }) }
