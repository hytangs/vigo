import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNotebook } from '../src/agency/notebook.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agency-clear-history-'))
let notebook
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
  console.log('History deletion persists and preserves research, settings and parent consistency.')
} finally { notebook?.close(); await fs.rm(directory, { recursive: true, force: true }) }
