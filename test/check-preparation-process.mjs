import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { PreparationProcess } from '../src/server/runtime/preparation-process.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const helper = new URL('./helpers/preparation-lifecycle-worker.mjs', import.meta.url)
const gone = pid => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
async function run(url, workerData) {
  const worker = new PreparationProcess(url, { workerData })
  const messages = []
  worker.on('message', m => { messages.push(m); if (m.type === 'complete' || m.type === 'failed') gone(worker.pid) })
  const [code] = await once(worker, 'exit')
  return { code, messages, pid: worker.pid }
}
const success = await run(helper, { mode: 'complete' })
assert.equal(success.code, 0)
assert.equal(success.messages.at(-1).result.value, 17)
assert(success.messages.at(-1).preparation.exited)
assert(success.messages.at(-1).preparation.peakRssBytes > 64 * 1024 * 1024)
assert.equal((await run(helper, { mode: 'failed' })).messages.at(-1).type, 'failed')
const crash = await run(helper, { mode: 'crash' })
assert.equal(crash.code, 2)
assert.equal(crash.messages.filter(m => m.type === 'complete').length, 0)
const canceled = new PreparationProcess(helper, { workerData: { mode: 'hold' } })
await once(canceled, 'message')
await canceled.terminate()
gone(canceled.pid)

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-preparation-process-'))
try {
  // A process that could not spawn emits error and close, but never exit.
  const executable = process.execPath
  let unstarted
  try {
    process.execPath = path.join(directory, 'missing-runtime')
    unstarted = new PreparationProcess(helper, { workerData: { mode: 'hold' } })
  } finally { process.execPath = executable }
  const startupErrors = []
  let startupExits = 0
  unstarted.on('error', error => startupErrors.push(error.code))
  unstarted.on('exit', () => { startupExits++ })
  let startupTimer
  try {
    const code = await Promise.race([unstarted.completion, new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(Error('A failed process start left preparation cleanup pending')), 1500)
    })])
    assert.notEqual(code, 0)
    assert.equal(await unstarted.terminate(), code)
    assert.equal(unstarted.exited, true)
    assert.equal(startupExits, 1)
    assert(startupErrors.includes('ENOENT'))
  } finally { clearTimeout(startupTimer) }

  const inputs = await writeCliFixtureInputs(directory)
  const gtfs = path.join(directory, 'transit.sqlite'), osm = path.join(directory, 'street.sqlite')
  const transit = await run(new URL('../src/server/national-gtfs-worker.mjs', import.meta.url), {
    zipPath: inputs.gtfsPath, outputPath: gtfs,
  })
  assert.equal(transit.code, 0, JSON.stringify(transit.messages.at(-1)))
  assert.equal(transit.messages.at(-1).type, 'complete')
  assert(transit.messages.some(m => m.type === 'progress' && m.progress.work?.unit === 'bytes' && m.progress.work.completed > 0), 'GTFS compiler must publish measured bytes')
  const db = new DatabaseSync(gtfs, { readOnly: true })
  assert(db.prepare('SELECT count(*) AS n FROM connections').get().n > 0)
  db.close()
  const streets = await run(new URL('../src/server/national-osm-worker.mjs', import.meta.url), {
    pbfPath: inputs.osmPath, outputPath: osm,
  })
  assert.equal(streets.code, 0, JSON.stringify(streets.messages.at(-1)))
  assert(streets.messages.at(-1).result.cch.ready)
  assert(streets.messages.some(m => m.type === 'progress' && m.progress.work?.unit === 'bytes' && m.progress.work.total > 0), 'OSM compiler must publish measured bytes')
  assert(streets.messages.at(-1).result.runtimeCompaction.ready)
  const failed = await run(new URL('../src/server/national-gtfs-worker.mjs', import.meta.url), {
    zipPath: path.join(directory, 'missing.zip'), outputPath: path.join(directory, 'missing.sqlite'),
  })
  assert.equal(failed.messages.at(-1).type, 'failed')
  console.log(JSON.stringify({ checks: 8, compilerPeaks: {
    gtfs: transit.messages.at(-1).preparation.peakRssBytes,
    osm: streets.messages.at(-1).preparation.peakRssBytes,
  }, parent: process.memoryUsage() }))
} finally { await fs.rm(directory, { recursive: true, force: true }) }
