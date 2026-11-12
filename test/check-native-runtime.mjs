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
function fakeSpawn(_executable, args, options) {
  const child = new EventEmitter()
  child.id = spawned.length
  child.args = args
  child.env = options?.env
  child.exitCode = null
  child.killed = false
  child.served = []
  child.requests = []
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let queue = Promise.resolve()
  const die = (signal, trailingError = null) => {
    if (child.exitCode !== null || child.killed) return
    child.killed = signal === 'SIGKILL'
    child.exitCode = signal ? null : 1
    child.emit('exit', signal ? null : 1, signal)
    const close = () => {
      if (trailingError) child.stderr.emit('data', Buffer.from(trailingError))
      child.emit('close', signal ? null : 1, signal)
    }
    if (trailingError) queueMicrotask(close)
    else close()
  }
  child.kill = signal => die(signal)
  child.unref = () => {}
  child.stdin = {
    on() {},
    end() {},
    write(line) {
      const request = JSON.parse(line)
      child.requests.push(request)
      queue = queue.then(() => new Promise(resolve => setTimeout(resolve, request.delayMs ?? 1))).then(() => {
        if (child.exitCode !== null || child.killed) return
        if (request.crash === 'always' || (request.crash === 'once' && child.id === request.crashOn)) {
          die('SIGSEGV')
          return
        }
        if (request.kind === 'open-failure' || request.kind === 'open-failure-late') {
          const message = '{"error":{"message":"The prepared access profile is stale"}}\n'
          if (request.kind === 'open-failure-late') die(null, message)
          else {
            child.stderr.emit('data', Buffer.from(message))
            die(null)
          }
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

// Completed and fragmented lines obey the same per-response byte budget.
for (const fragments of [[Buffer.alloc(65, 32), Buffer.from('\n')], [Buffer.concat([Buffer.alloc(65, 32), Buffer.from('\n')])], [Buffer.alloc(32, 32), Buffer.concat([Buffer.alloc(33, 32), Buffer.from('\n')])]]) {
  const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, responseLimitBytes: 64 })
  const layout = nativeLayout('/cities/response-limit')
  try {
    const pending = pool.query(layout, { delayMs: 30 })
    const rejected = assert.rejects(pending, /response exceeds its byte limit/)
    const child = pool.cities.get(layout.key).processes[0].child
    for (const fragment of fragments) child.stdout.emit('data', fragment)
    await rejected
    assert(child.killed)
  } finally { pool.closeAll() }
}
// Busy Cities cannot silently exceed the admission limit; an idle slot can be reused.
{
  const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxCities: 1 })
  try {
    const first = pool.query(nativeLayout('/cities/busy'), { delayMs: 30 })
    const before = spawned.length
    await assert.rejects(pool.query(nativeLayout('/cities/overflow'), {}), error => error.code === 'capacity_exceeded' && error.statusCode === 503)
    assert.equal(spawned.length, before)
    await first
    await pool.query(nativeLayout('/cities/overflow'), {})
    assert.equal(pool.cities.size, 1)
  } finally { pool.closeAll() }
}
spawned.length = 0

// An opening process activates only the timetable; each other mode loads on its
// first request. An explicit VIGO_PREPARE is passed through unchanged.
{
  const explicit = process.env.VIGO_PREPARE
  try {
    for (const [setting, expected] of [[undefined, 'transit'], ['all', 'all'], ['none', 'none']]) {
      if (setting === undefined) delete process.env.VIGO_PREPARE
      else process.env.VIGO_PREPARE = setting
      const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn })
      try {
        await pool.query(nativeLayout(`/cities/prepare-${expected}`), { id: `prepare-${expected}` })
        assert.equal(spawned.at(-1).env.VIGO_PREPARE, expected)
        assert.equal(spawned.at(-1).env.PATH, process.env.PATH, 'The stream keeps the rest of the environment')
      } finally { pool.closeAll() }
    }
  } finally {
    if (explicit === undefined) delete process.env.VIGO_PREPARE
    else process.env.VIGO_PREPARE = explicit
  }
}
spawned.length = 0

const runtime = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 2, idleMs: 60_000 })
// A kept City replaces a process stopped by a cancelled query and reloads its modes.
{
  const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 1 })
  const layout = nativeLayout('/cities/rewarm')
  try {
    pool.setResidency(layout, true, 'visitor')
    await pool.query(layout, { kind: 'native', operation: 'bike.prepare' })
    await pool.query(layout, { kind: 'reach', mode: 'drive', origin: { coordinate: [1, 2] }, id: 'drive-surface' })
    await pool.query(layout, { kind: 'matrix', mode: 'walk', origins: [[1, 2]], destinations: [[3, 4]], id: 'walk-matrix' })
    const first = pool.cities.get(layout.key).processes[0].child
    const controller = new AbortController()
    const overrun = pool.query(layout, { kind: 'route', mode: 'walk', scenario: { id: 'x' }, id: 'overrun', delayMs: 500 }, controller.signal)
    controller.abort()
    await assert.rejects(overrun, { name: 'AbortError' })
    await new Promise(resolve => setTimeout(resolve, 80))
    const replacement = pool.cities.get(layout.key).processes[0]
    assert.notEqual(replacement.child, first)
    assert.deepEqual(replacement.child.requests, [
      { kind: 'native', operation: 'bike.prepare' },
      { kind: 'native', operation: 'drive.prepare' },
      { kind: 'native', operation: 'street.prepare' },
    ], 'Replacement loads only the prepared networks and retains no journey or surface')
    assert(replacement.routeModes.has('bike'))
    assert(replacement.routeModes.has('drive'))
    assert(replacement.routeModes.has('walk'))
    pool.setResidency(layout, false, 'visitor')
    assert.equal(pool.warmRoutes.has(layout.key), false)
  } finally { pool.closeAll() }
}
// A cancelled query still waiting its turn never reaches the engine.
{
  const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 1 })
  const layout = nativeLayout('/cities/cancelled-queue')
  try {
    const running = pool.query(layout, { id: 'running', delayMs: 30 })
    const controller = new AbortController()
    const waiting = pool.query(layout, { id: 'waiting', delayMs: 2000 }, controller.signal)
    const after = pool.query(layout, { id: 'after' })
    controller.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    await Promise.all([running, after])
    assert.deepEqual(pool.cities.get(layout.key).processes[0].child.served, ['running', 'after'])
  } finally { pool.closeAll() }
}
// Metadata readiness must not expose a second process's cold bike network.
for (const kind of ['route', 'matrix', 'reach']) {
  const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 2 })
  const layout = nativeLayout('/cities/bike-startup')
  try {
    const first = await pool.query(layout, { kind, mode: 'bike', id: 'bike-first' })
    await pool.query(layout, { kind: 'route', mode: 'walk', id: 'walk-first' })
    const busy = pool.query(layout, { kind, mode: 'bike', id: 'bike-busy', delayMs: 100 })
    const queued = pool.query(layout, { kind, mode: 'bike', id: 'bike-warmup', delayMs: 100 })
    await new Promise(resolve => setTimeout(resolve, 20))
    const during = pool.query(layout, { kind, mode: 'bike', id: 'during-warmup' })
    await during
    assert(pool.cities.get(layout.key).processes[1].child.requests.some(request => request.operation === 'bike.prepare'))
    assert(!pool.cities.get(layout.key).processes[1].child.requests.some(request => request.id === 'bike-warmup'), 'Secondary initialization never repeats the queued route')
    await Promise.all([busy, queued])
    const slow = pool.query(layout, { kind, mode: 'bike', id: 'occupy-primary', delayMs: 100 })
    const parallel = await pool.query(layout, { kind, mode: 'bike', id: 'warm-secondary' })
    assert.notEqual(parallel.process, first.process, 'The prepared second bike process can serve parallel routes')
    const walk = await pool.query(layout, { kind: 'route', mode: 'walk', id: 'walk-affinity' })
    assert.equal(walk.process, first.process, 'Bike preparation does not make the secondary walking network warm')
    await slow
    const city = pool.cities.get(layout.key)
    city.processes.find(stream => stream.child.id === parallel.process).lastUsed = Date.now() + 1
    pool.setResidency(layout, true, 'startup')
    pool.idleMs = 20
    clearTimeout(pool.idleTimer)
    pool.idleTimer = null
    pool.scheduleIdle()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(city.processes.length, 1)
    assert.equal(city.processes[0].child.id, first.process, 'Idle cleanup retains the process with all prepared modes')
  } finally { pool.closeAll() }
  spawned.length = 0
}
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
  const late = nativeLayout('/cities/stale-late-stderr')
  const beforeLate = spawned.length
  await assert.rejects(runtime.query(late, { kind: 'open-failure-late' }),
    error => error.preparation === true && error.retryable === false && /prepared access profile is stale/.test(error.message))
  assert.equal(spawned.length, beforeLate + 1, 'Trailing startup errors must request preparation, not an unprepared retry')

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
