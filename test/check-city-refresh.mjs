import assert from 'node:assert/strict'
import { importTestModules } from './helpers/import-test-modules.mjs'
const [{ city, refreshImportedProject, replaceProject, resetCity }, { emptyCityProject }, { applyCityReset, deleteProject }] = await importTestModules('state/city.ts', 'app/projectState.ts', 'state/navigation.ts')
const makeCity = (id, name = id) => ({ ...emptyCityProject(), id, name })
const originalFetch = globalThis.fetch
const reads = []
globalThis.fetch = () => new Promise(resolve => reads.push(project => resolve(Response.json({ project }))))
try {
  city.set({ projects: [makeCity('one'), makeCity('two')], selectedProjectId: 'one' })
  const background = refreshImportedProject('one', false)
  city.set({ selectedProjectId: 'two' })
  reads.shift()(makeCity('one', 'Updated in background'))
  await background
  assert.equal(city.get().selectedProjectId, 'two', 'Background completion must never change the selected City')
  assert.equal(city.get().projects[0].name, 'Updated in background')
  assert.deepEqual(city.get().projects.map(p => p.id), ['one', 'two'], 'Refresh preserves library order')

  const old = refreshImportedProject('two'), recent = refreshImportedProject('two')
  const [oldReply, recentReply] = reads.splice(0)
  recentReply(makeCity('two', 'Latest'))
  await recent
  oldReply(makeCity('two', 'Stale'))
  await old
  assert.equal(city.get().projects[1].name, 'Latest', 'Out-of-order refresh must not replace newer City metadata')

  const deleted = refreshImportedProject('one')
  city.set({ projects: city.get().projects.filter(p => p.id !== 'one') })
  reads.shift()(makeCity('one'))
  await deleted
  assert.deepEqual(city.get().projects.map(p => p.id), ['two'], 'A delayed refresh must not resurrect a removed City')

  const reset = refreshImportedProject('two')
  resetCity()
  city.set({ projects: [makeCity('two', 'New library')], selectedProjectId: 'two' })
  reads.shift()(makeCity('two', 'Old library'))
  await reset
  assert.equal(city.get().projects[0].name, 'New library', 'Reset invalidates responses even when the next library has the same City id')

  for (const [label, replace] of [['source reset', applyCityReset], ['explicit replacement', replaceProject]]) {
    const pending = refreshImportedProject('two')
    replace(makeCity('two', label))
    reads.shift()(makeCity('two', 'Before replacement'))
    await pending
    assert.equal(city.get().projects[0].name, label, `${label} invalidates an earlier background read`)
  }

  city.set({ projects: [makeCity('one'), makeCity('two'), makeCity('three')], selectedProjectId: 'one' })
  let finishDeletion
  globalThis.fetch = (url, init) => init?.method === 'DELETE'
    ? new Promise(resolve => { finishDeletion = () => resolve(Response.json({ ok: true, projects: [makeCity('two'), makeCity('three')] })) })
    : Promise.resolve(Response.json({ project: makeCity('three') }))
  const deletion = deleteProject('one', { confirm: false })
  city.set({ selectedProjectId: 'three' })
  finishDeletion()
  assert(await deletion)
  assert.equal(city.get().selectedProjectId, 'three', 'Deletion completion preserves a City selected while deletion was pending')
  console.log('City refresh: navigation isolation, library order, latest generation, deletion, source replacement and reset passed.')
} finally { globalThis.fetch = originalFetch; resetCity() }
