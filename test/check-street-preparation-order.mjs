import assert from 'node:assert/strict'
import { createStreetPreparationManager } from '../src/server/street-preparation.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
const calls = [], updates = []
let finish, walkReady = false, driveReady = false
const pool = {
  isStreetPrepared: (_store, drive) => drive ? driveReady : walkReady,
  dispatch(_store, operation, request) {
    calls.push({ operation, request })
    return new Promise(resolve => { finish = () => {
      walkReady = true
      if (request.prepareDrive) driveReady = true
      resolve({ streetStore: { ready: true, accelerated: true, ...(driveReady ? { drive: { ready: true, accelerated: true } } : {}) } })
    } })
  },
}
const manager = createStreetPreparationManager({ pool, onJob: job => updates.push(structuredClone(job)) })
const input = { projectId: 'city', storePath: 'streets', workerStorePath: 'transit', identity: 'current' }
const walking = manager.start(input)
await tick()
assert.equal(calls.length, 1)
assert.equal(calls[0].request.prepareDrive, false)
finish(); await tick()
assert.equal(calls.length, 1, 'Opening a City must not allocate the driving network')
assert.equal(walking.status, 'complete')
assert.deepEqual(walking.result.modes, { walk: true, drive: false })
assert.strictEqual(manager.start(input), walking)
const driving = manager.start({ ...input, prepareDrive: true })
assert.notStrictEqual(driving, walking, 'Selecting Drive upgrades walking-only readiness')
await tick(); finish(); await tick()
assert.equal(calls.at(-1).request.prepareDrive, true)
assert.equal(driving.status, 'running')
assert.strictEqual(manager.start(input), driving, 'Concurrent views share ongoing preparation')
finish(); await tick()
assert.equal(driving.status, 'complete')
assert.deepEqual(driving.result.modes, { walk: true, drive: true })
manager.invalidate('streets'); walkReady = driveReady = false
const pending = manager.start(input)
await tick()
assert.strictEqual(manager.start({ ...input, prepareDrive: true }), pending)
finish(); await tick()
assert.equal(calls.at(-1).request.prepareDrive, true, 'Drive requests received while walking opens must be honored')
finish(); await tick()
assert.equal(pending.status, 'complete')
console.log('Walking-only preparation, on-demand Drive, in-flight upgrade and shared readiness passed.')
