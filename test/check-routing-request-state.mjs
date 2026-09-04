import assert from 'node:assert/strict'
import { LatestRequestGate } from '../src/app/latestRequestGate.ts'

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, reject: rejectPromise, resolve: resolvePromise }
}

async function checkLatestResponseWins() {
  const gate = new LatestRequestGate()
  const slow = deferred()
  const fast = deferred()
  const commits = []
  let requestCount = 0

  const run = async (response) => {
    const token = gate.begin()
    requestCount += 1
    try {
      const value = await response.promise
      if (gate.owns(token)) commits.push(value)
    } finally {
      gate.finish(token)
    }
    return token
  }

  const slowRun = run(slow)
  const fastRun = run(fast)
  fast.resolve('new-result')
  await fastRun
  slow.resolve('old-result')
  const slowToken = await slowRun

  assert.equal(requestCount, 2, 'Each distinct routing input should issue exactly one request.')
  assert.equal(slowToken.controller.signal.aborted, true, 'Starting a newer route must abort the older request.')
  assert.deepEqual(commits, ['new-result'], 'A slower older route response must never overwrite the newer result.')
}

async function checkResetInvalidatesPendingResponse() {
  const gate = new LatestRequestGate()
  const pending = deferred()
  const commits = []
  const token = gate.begin()
  const request = pending.promise.then((value) => {
    if (gate.owns(token)) commits.push(value)
  }).finally(() => gate.finish(token))

  gate.cancel()
  pending.resolve('late-after-reset')
  await request

  assert.equal(token.controller.signal.aborted, true, 'Reset must abort the pending request.')
  assert.deepEqual(commits, [], 'A response arriving after reset must not repopulate routing results.')
}

await checkLatestResponseWins()
await checkResetInvalidatesPendingResponse()

console.log('Routing request state check passed: latest-generation commits only.')
