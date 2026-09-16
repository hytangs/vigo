import React from 'react'
import { createRoot } from 'react-dom/client'
import { AgencyNoteEditor, AgencyNotebook } from '../../src/components/AgencyNotebook'

const root = createRoot(document.getElementById('root'))
const requests = [], saved = []
const originalFetch = window.fetch
window.fetch = (url, init) => url.startsWith('/fixture-agency/')
  ? new Promise((resolve, reject) => requests.push({ url, body: JSON.parse(init.body), signal: init.signal, resolve, reject }))
  : originalFetch(url, init)
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const check = (condition, message) => { if (!condition) throw Error(message) }
const settle = () => new Promise(resolve => setTimeout(resolve, 25))
async function wait(predicate) {
  const end = performance.now() + 5000
  while (!predicate()) { if (performance.now() > end) throw Error('Timed out: ' + predicate); await settle() }
}
const entry = { id: 1, notes: 'Initial note', title: 'Saved question', kind: 'ask', createdAt: '2026-09-15T12:00:00Z', parentId: null,
  answer: { answer: 'Checked evidence', generatedAt: '2026-09-15T12:00:00Z', evidenceRefs: [], warnings: [], trace: [] }, activities: [] }
let endpoint = '/fixture-agency/city-one'
async function editor(patch = {}) {
  if (patch.endpoint) endpoint = patch.endpoint
  root.render(<AgencyNoteEditor endpoint={endpoint} entry={{ ...entry, ...patch.entry }} onSave={notes => saved.push(notes)} />)
  await settle()
  document.querySelector('details').open = true
}
async function type(selector, value) {
  const input = document.querySelector(selector)
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}
const saveButton = () => document.querySelector('.agency-note-editor .agency-button')
const status = () => document.querySelector('.agency-note-editor [role]').textContent
window.runTests = async () => {
  await editor()
  check(saveButton().disabled, 'Unchanged notes do not create duplicate writes')
  await type('textarea', 'First saved draft')
  saveButton().click(); saveButton().click()
  await wait(() => requests.length === 1)
  check(requests[0].body.previousNotes === 'Initial note', 'Saving supplies the original notes to detect edits from another window')
  check(saveButton().disabled, 'A pending save is guarded against duplicate submissions')
  await type('textarea', 'Newer unsaved draft')
  requests[0].resolve(response({ notes: 'First saved draft' }))
  await wait(() => saved.length === 1)
  check(document.querySelector('textarea').value === 'Newer unsaved draft', 'Completing a save cannot discard edits made while saving')
  check(status() === 'Unsaved changes' && !saveButton().disabled, 'A completed older draft cannot label newer edits Saved')
  check(saved[0] === 'First saved draft', 'The parent receives only the notes actually saved')
  saveButton().click()
  await wait(() => requests.length === 2)
  check(requests[1].body.previousNotes === 'First saved draft', 'The next save compares with the last confirmed draft')
  requests[1].reject(new Error('Fixture offline'))
  await wait(() => status().includes('Fixture offline'))
  check(!saveButton().disabled && document.querySelector('textarea').value === 'Newer unsaved draft', 'Save failures preserve the draft and support retry')
  saveButton().click()
  await wait(() => requests.length === 3)
  requests[2].resolve(response({ notes: 'Newer unsaved draft' }))
  await wait(() => status() === 'Saved')
  check(saveButton().disabled && saved[1] === 'Newer unsaved draft', 'Successful retry records the latest submitted notes')

  await type('textarea', 'City one pending draft')
  saveButton().click()
  await wait(() => requests.length === 4)
  await editor({ endpoint: '/fixture-agency/city-two', entry: { notes: 'City two note' } })
  check(requests[3].signal.aborted, 'Changing City cancels the old editor request even when entry numbers match')
  requests[3].resolve(response({ notes: 'City one pending draft' }))
  await settle()
  check(saved.length === 2 && document.querySelector('textarea').value === 'City two note', 'An obsolete response cannot update the new City or its saved callback')
  await type('textarea', 'Unmounted draft')
  saveButton().click()
  await wait(() => requests.length === 5)
  root.render(<AgencyNotebook endpoint={endpoint} onOpen={() => {}} onBack={() => {}} />)
  await wait(() => requests.length === 6)
  check(requests[4].signal.aborted, 'Closing the editor releases a pending save')
  requests[4].resolve(response({ notes: 'Unmounted draft' }))
  requests[5].resolve(response({ entries: [entry] }))
  await wait(() => document.querySelector('.agency-notebook-list').textContent.includes('Saved question'))
  await type('input', 'missing route')
  await wait(() => requests.length === 7)
  check(!document.querySelector('.agency-notebook-list').textContent.includes('Saved question'), 'A new search clears obsolete results while waiting')
  requests[6].resolve(response({ entries: [] }))
  await wait(() => document.body.textContent.includes('No saved work matches your search'))
  await type('input', 'failed search')
  await wait(() => requests.length === 8)
  requests[7].reject(new Error('Notebook unavailable'))
  await wait(() => document.body.textContent.includes('Notebook unavailable'))
  check(!document.body.textContent.includes('No saved work matches') && !document.body.textContent.includes('will be saved here'), 'Failed searches do not claim the notebook is empty')
  check(saved.length === 2, 'Unmounted requests cannot invoke the saved callback')
  root.unmount()
  window.fetch = originalFetch
  return { checks: 'note save serialization, dirty state, retry, City isolation, unmount, notebook search and failed-state truth' }
}
