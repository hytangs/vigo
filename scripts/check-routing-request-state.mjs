import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LatestRequestGate } from '../src/app/latestRequestGate.ts'

const root = resolve(import.meta.dirname, '..')
const routingHookSource = readFileSync(resolve(root, 'src/app/useNationalRouting.ts'), 'utf8')

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

function checkOneAtomicPostPerStableInput() {
  const routeEffectStart = routingHookSource.indexOf(
    "useEffect(() => {\n    if (!active || !feedId || !origin || !destination || !routeAllowed || !ready",
  )
  const routeEffectEnd = routingHookSource.indexOf('\n  return {', routeEffectStart)
  assert(routeEffectStart >= 0 && routeEffectEnd > routeEffectStart, 'Could not isolate the primary route effect.')
  const routeEffect = routingHookSource.slice(routeEffectStart, routeEffectEnd)
  const postCount = routeEffect.match(/apiJson<NationalRouteResponse>/g)?.length ?? 0

  assert.equal(postCount, 1, 'One stable Directions input must issue one atomic national-route POST.')
  assert(routeEffect.includes('departureWindowMinutes,'), 'The atomic request must use the selected departure window.')
  assert(!routeEffect.includes('alternativeMaxWalkKm'), 'The route request must honor the selected walking limit without hidden expansion.')
  assert(!routeEffect.includes('departureWindowMinutes: 0'), 'The primary request must not issue a preliminary exact-only route.')
  assert(!routeEffect.includes('setTimeout('), 'Routing must not retain the former 80 ms dispatch delay.')
  assert(!routeEffect.includes('requestAnimationFrame('), 'Routing must not stage a second request after paint.')
  assert(!routeEffect.includes('requestRoutes('), 'Routing must not retain exact-then-profile duplicate dispatch.')
  assert(!routeEffect.includes('mergeProgressiveRoutingChoices'), 'A later response must not rewrite an already committed route list.')
}

await checkLatestResponseWins()
await checkResetInvalidatesPendingResponse()
checkOneAtomicPostPerStableInput()

console.log('Routing request state check passed: one atomic POST and latest-generation commits only.')
