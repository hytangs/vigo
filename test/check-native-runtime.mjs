// The native runtime's process management, against fake `vigo stream`
// children: least-busy dispatch, a second process under load, Reach
// baseline affinity, replacement of a process that dies, and the failures
// that are not retried.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// A short grace makes a cancelled query's process stop within the test.
process.env.VIGO_NATIVE_CANCEL_GRACE_MS = '20'
const { NativeCityUnavailableError, NativeRuntime, nativeLayout, nativeExecutable } = await import('../src/server/runtime/native-runtime.mjs')

// Source, bundled CLI and bundled server all resolve the same native runtime.
const locations = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-runtime-layout-'))
try {
  const binary = process.platform === 'win32' ? 'vigo.exe' : 'vigo'
  for (const [modulePath, executablePath] of [
    ['src/server/runtime', 'target/release'],
    ['public', 'target/release'],
    ['cli', 'cli'],
    ['app/server/runtime', 'app/server'],
  ]) {
    const directory = path.join(locations, modulePath)
    const executable = path.join(locations, executablePath, binary)
    fs.mkdirSync(directory, { recursive: true })
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '', { mode: 0o755 })
    assert.equal(nativeExecutable({}, directory), executable)
    assert.equal(nativeExecutable({ VIGO_STANDALONE_PATH: executable }, directory), executable)
    assert.equal(nativeExecutable({ VIGO_STANDALONE_PATH: path.join(locations, 'missing') }, directory), null)
    fs.unlinkSync(executable)
  }
} finally {
  fs.rmSync(locations, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

const spawned = []
// Each child answers its requests in order. A request may ask for a delay,
// or for the child serving it to die, once or always.
function fakeSpawn(_executable, args) {
  const child = new EventEmitter()
  child.id = spawned.length
  child.args = args
  child.exitCode = null
  child.killed = false
  child.served = []
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let queue = Promise.resolve()
  const die = signal => {
    if (child.exitCode !== null || child.killed) return
    child.killed = signal === 'SIGKILL'
    child.exitCode = signal ? null : 1
    child.emit('exit', signal ? null : 1, signal)
  }
  child.kill = signal => die(signal)
  child.unref = () => {}
  child.stdin = {
    on() {},
    end() {},
    write(line) {
      const request = JSON.parse(line)
      queue = queue.then(() => new Promise(resolve => setTimeout(resolve, request.delayMs ?? 1))).then(() => {
        if (child.exitCode !== null || child.killed) return
        if (request.crash === 'always' || (request.crash === 'once' && child.id === request.crashOn)) {
          die('SIGSEGV')
          return
        }
        if (request.kind === 'open-failure') {
          child.stderr.emit('data', Buffer.from('{"error":{"message":"The prepared access profile is stale"}}\n'))
          die(null)
          return
        }
        child.served.push(request.id)
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ status: 'ok', trace: request.trace ?? { id: request.id, process: child.id } })}\n`))
      })
    },
  }
  spawned.push(child)
  return child
}

const runtime = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 2, idleMs: 60_000 })
const boston = nativeLayout('/cities/boston')
try {
  // One request opens one process.
  assert.equal((await runtime.query(boston, { id: 'first' })).process, 0)
  assert.equal(spawned.length, 1)

  // While it is busy, a second process opens and takes the next requests
  // once it has opened the City.
  const slow = runtime.query(boston, { id: 'slow', delayMs: 200 })
  const queued = runtime.query(boston, { id: 'queued' })
  assert.equal(spawned.length, 2, 'A busy City opens a second process')
  await new Promise(resolve => setTimeout(resolve, 20))
  const parallel = await runtime.query(boston, { id: 'parallel' })
  assert.equal(parallel.process, 1, 'The ready idle process answers instead of queueing behind the slow one')
  assert.equal((await slow).process, 0)
  assert.equal((await queued).process, 0, 'A request sent before the new process opened waits on the busy one')
  assert.equal(spawned.length, 2, 'No more than maxProcesses per City')

  // A Reach scenario grows from its baseline's process.
  const baseline = await runtime.query(boston, { id: 'baseline', surfaceReuse: 'baseline' })
  const busy = runtime.query(boston, { id: 'busy', delayMs: 100 })
  const scenario = await runtime.query(boston, { id: 'scenario', surfaceReuse: 'scenario' })
  assert.equal(scenario.process, baseline.process)
  await busy

  // A request whose process dies is answered by another one: the survivor,
  // or a fresh process when the City had only that one.
  const crashOn = (await runtime.query(boston, { id: 'probe' })).process
  const recovered = await runtime.query(boston, { id: 'recovered', crash: 'once', crashOn })
  assert.notEqual(recovered.process, crashOn)
  assert.equal(runtime.snapshot().residentCities.find(city => city.root === boston.root).processes, 1)
  const cambridge = nativeLayout('/cities/cambridge')
  const only = (await runtime.query(cambridge, { id: 'only' })).process
  const before = spawned.length
  const replaced = await runtime.query(cambridge, { id: 'replaced', crash: 'once', crashOn: only })
  assert.equal(replaced.process, before, 'A fresh process replaced the one that died')
  runtime.retire('/cities/cambridge')

  // A request that kills every process it reaches fails after one retry.
  await assert.rejects(runtime.query(boston, { id: 'poison', crash: 'always' }),
    error => error instanceof NativeCityUnavailableError && /stopped/.test(error.message))

  // An aborted request rejects at once and is not retried.
  const controller = new AbortController()
  const aborted = runtime.query(boston, { id: 'aborted', delayMs: 50 }, controller.signal)
  controller.abort()
  await assert.rejects(aborted, { name: 'AbortError' })

  // A cancelled query that keeps running stops its process; requests queued
  // behind it are answered by another process.
  const somerville = nativeLayout('/cities/somerville')
  await runtime.query(somerville, { id: 'warm' })
  const cancel = new AbortController()
  const overrun = runtime.query(somerville, { id: 'overrun', delayMs: 300 }, cancel.signal)
  const behind = runtime.query(somerville, { id: 'behind' })
  cancel.abort()
  await assert.rejects(overrun, { name: 'AbortError' })
  assert.equal((await behind).id, 'behind')
  runtime.retire('/cities/somerville')

  // A City that cannot open reports why, marked for preparation, without a retry.
  const stale = nativeLayout('/cities/stale')
  const opened = spawned.length
  await assert.rejects(runtime.query(stale, { kind: 'open-failure' }),
    error => error.preparation === true && error.retryable === false)
  assert.equal(spawned.length, opened + 1)

  const indexed = { originCount: 2, destinationCount: 2,
    journeyTable: [{ legs: [{ kind: 'ride', tripId: 'trip' }] }, null],
    journeyIndices: [[0, 1], [0, 0]] }
  const decoded = await runtime.query(boston, { trace: indexed })
  assert.deepEqual(decoded.journeys, [[indexed.journeyTable[0], null],
    [indexed.journeyTable[0], indexed.journeyTable[0]]])
  assert.equal(decoded.journeyIndices, undefined)
  for (const journeyIndices of [[[0]], [[0, 2], [0, 0]], [[0, -1], [0, 0]]]) {
    await assert.rejects(runtime.query(boston, { trace: { ...indexed, journeyIndices } }), /Invalid native/)
  }
  assert.equal((await runtime.query(boston, { id: 'after-bad-index' })).id, 'after-bad-index')

  // Retiring a City's files stops its processes; their requests are not retried.
  const retiring = runtime.query(boston, { id: 'retired', delayMs: 100 })
  runtime.retire('/cities/boston')
  await assert.rejects(retiring, error => error.retryable === false)
  assert.equal(runtime.snapshot().residentCities.some(city => city.root === boston.root), false)
  console.log(`Native runtime passed (${spawned.length} fake processes).`)
} finally {
  runtime.closeAll()
}
