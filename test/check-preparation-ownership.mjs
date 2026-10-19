import assert from 'node:assert/strict'
import { importTestModules } from './helpers/import-test-modules.mjs'
const [state, preparation, { emptyCityProject }, { applyCitySelection }] = await importTestModules('state/city.ts', 'state/preparation.ts', 'app/projectState.ts', 'state/navigation.ts')
const { city, resetCity } = state
const { resetPreparation, waitForImportJob } = preparation
const originalFetch = globalThis.fetch
const project = id => ({ ...emptyCityProject(), id, name: id })
const initialize = () => { resetPreparation(); resetCity(); city.set({ projects: [project('one'), project('two')], selectedProjectId: 'one' }) }
const pause = () => new Promise(resolve => setImmediate(resolve))
const until = async read => { for (let n = 0; n < 100; n++) { if (read()) return; await pause() } throw Error('Expected pending request did not start') }
try {
  initialize()
  city.set({ isImporting: true, isOsmImporting: true, gtfsImportJobId: 'old', osmImportJobId: 'old', importMessage: 'Old import' })
  applyCitySelection('two')
  assert(!city.get().isImporting && !city.get().isOsmImporting, 'City switching must not block imports in the next City')
  assert.equal(city.get().gtfsImportJobId, '')
  assert.equal(city.get().importMessage, '')
  for (const [label, run] of [
    ['GTFS path', () => preparation.handleNationalGtfsPath('/fixture/feed.zip')],
    ['OSM path', () => preparation.handleNationalOsmPath('/fixture/roads.pbf')],
    ['GTFS upload', () => preparation.handleFiles([new File(['fixture'], 'feed.zip')])],
    ['OSM upload', () => preparation.handleOsmFiles([new File(['fixture'], 'roads.pbf')])],
  ]) {
    initialize()
    let finish
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') return Response.json({ job: { id: 'job-one' } })
      if (String(url).includes('national-gtfs-job')) return new Promise(resolve => { finish = () => resolve(Response.json({ job: { id: 'job-one', status: 'complete', result: { feedId: 'old-feed' } } })) })
      return Response.json({ project: project('one') })
    }
    const work = run()
    await until(() => finish)
    city.set({ selectedProjectId: 'two', activeFeedId: 'two-feed', importMessage: 'Two GTFS', osmStreetMessage: 'Two OSM', isImporting: true, isOsmImporting: true })
    finish()
    await work
    assert.equal(city.get().selectedProjectId, 'two', label)
    assert.equal(city.get().activeFeedId, 'two-feed', `${label}: late import must not change another City's feed`)
    assert.equal(city.get().importMessage, 'Two GTFS', label)
    assert.equal(city.get().osmStreetMessage, 'Two OSM', label)
    assert(city.get().isImporting && city.get().isOsmImporting, `${label}: old completion must not clear a new City's job flags`)
  }
  initialize()
  let signal
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => { signal = init.signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  const abandoned = waitForImportJob('one', 'old-job', () => { throw Error('Stale progress') }, 'failed')
  const rejected = assert.rejects(abandoned, error => error.name === 'AbortError')
  resetPreparation()
  await rejected
  assert(signal.aborted)
  assert.deepEqual(city.get().preparationErrors, {}, 'Reset must not report its intentional cancellation as a new job error')
  assert.deepEqual(city.get().preparationJobUpdates, {})

  initialize()
  const pending = new Map()
  globalThis.fetch = url => new Promise(resolve => pending.set(String(url).includes('/one/') ? 'one' : 'two', resolve))
  const one = waitForImportJob('one', 'same-id', () => {}, 'failed')
  const two = waitForImportJob('two', 'same-id', () => {}, 'failed')
  assert.equal(pending.size, 2, 'Job identity must include the City')
  for (const [id, resolve] of pending) resolve(Response.json({ job: { id: 'same-id', status: 'complete', result: { feedId: id } } }))
  assert.equal((await one).result.feedId, 'one'); assert.equal((await two).result.feedId, 'two')
  assert.equal(city.get().preparationJobUpdates.one['same-id'].result.feedId, 'one')
  assert.equal(city.get().preparationJobUpdates.two['same-id'].result.feedId, 'two')

  initialize()
  let submit, calls = 0
  globalThis.fetch = () => { calls++; return new Promise(resolve => { submit = resolve }) }
  const old = preparation.handleNationalGtfsPath('/fixture/old.zip')
  await until(() => submit)
  initialize()
  city.set({ importMessage: 'New session', isImporting: true })
  submit(Response.json({ job: { id: 'obsolete' } }))
  await old
  assert.equal(calls, 1, 'A response from a reset Studio must not start new polling')
  assert.equal(city.get().importMessage, 'New session')
  assert(city.get().isImporting)
  assert.deepEqual(city.get().pendingPreparations, {})
  console.log('Preparation ownership: four import paths, City switching, reset cancellation, scoped jobs and delayed submission passed.')
} finally { resetPreparation(); resetCity(); globalThis.fetch = originalFetch }
