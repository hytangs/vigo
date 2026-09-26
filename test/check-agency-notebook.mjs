import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNotebook } from '../src/agency/notebook.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-notebook-'))
let notebook
try {
  notebook = createNotebook(directory)
  const answer = { answer: 'Three checked departures.', generatedAt: '2026-09-13T12:00:00Z', trace: [], evidenceRefs: ['fixture'], warnings: [] }
  const first = notebook.save({ title: 'Route question', answer })
  const next = notebook.save({ title: 'What changed?', answer, parentId: first.id })
  notebook.annotate(first.id, 'A researcher note with an explicit limit.')
  notebook.set('observation', { history: [{ id: 'event', observedAt: answer.generatedAt }], tripHistory: {} })
  notebook.close(); notebook = createNotebook(directory)
  assert.equal(notebook.read(next.id).parentId, first.id)
  assert.equal(notebook.read(first.id).notes, 'A researcher note with an explicit limit.')
  const competing = createNotebook(directory)
  try {
    const original = notebook.read(first.id).notes
    competing.annotate(first.id, 'A newer annotation from another window.', original)
    assert.throws(() => notebook.annotate(first.id, 'An outdated draft.', original), error => error.statusCode === 409)
    assert.equal(notebook.read(first.id).notes, 'A newer annotation from another window.', 'Conflicting saves cannot overwrite a newer annotation')
    notebook.annotate(first.id, original, 'A newer annotation from another window.')
    assert.throws(() => notebook.annotate(first.id, 'Invalid baseline.', null), /Invalid previous/)
  } finally { competing.close() }
  assert.equal(notebook.list({ search: 'researcher' })[0].id, first.id)
  assert.equal(notebook.list({ search: 'checked departures' }).length, 2, 'Search includes the saved answer, not only its title')
  assert.equal(notebook.recall({ search: 'researcher' }).length, 0, 'Model retrieval never searches private annotations')
  const recalled = notebook.recall({ entryId: first.id })
  assert.equal(recalled[0].id, first.id)
  assert.equal(recalled[0].observedAt, answer.generatedAt)
  assert.equal(recalled[0].notes, undefined, 'Staff annotations are not sent to model endpoints')
  assert.equal(recalled[0].excerpt, answer.answer)
  assert.equal(recalled[0].answer, undefined, 'Raw tool payloads stay out of retrieval context')
  assert.equal(notebook.recall({ search: '%' }).length, 0, 'Search terms are literal, not SQL wildcards')
  assert.equal(notebook.recall({ entryId: next.id })[0].id, next.id)
  assert.throws(() => notebook.recall({ entryId: first.id, search: 'both' }), /search or one/)
  const other = createNotebook(path.join(directory, 'other-city'))
  assert.equal(other.recall({ search: 'researcher' }).length, 0, 'Notebook retrieval is City-scoped')
  other.close()
  assert.equal(notebook.list({ before: next.id }).length, 1)
  assert.equal(notebook.get('observation').history[0].id, 'event')
  assert.throws(() => notebook.save({ title: 'Missing parent', answer, parentId: 900 }), /not found/)
  assert.throws(() => notebook.read('../escape'), /Invalid/)
  const large = notebook.save({ title: 'Long report', answer: { ...answer, answer: 'x'.repeat(5000) } })
  notebook.annotate(large.id, 'y'.repeat(2000))
  const excerpt = notebook.recall({ entryId: large.id })[0]
  assert.equal(excerpt.excerpt.length, 2000)
  assert.equal(excerpt.notes, undefined)
  assert.equal(excerpt.shortened, true)
  console.log('Notebook persistence, conflicts, scope, pagination and bounded recall passed.')
} finally { notebook?.close(); fs.rmSync(directory, { recursive: true, force: true }) }
