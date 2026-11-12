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
// A short deadline lets the test observe a process that never exits.
process.env.VIGO_NATIVE_RETIRE_TIMEOUT_MS = '400'
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
    const secondary = pool.cities.get(layout.key).processes[1].child.requests
    assert.deepEqual(secondary.slice(0, 2), [{ kind: 'info' }, { kind: 'native', operation: 'bike.prepare' }],
      'A second process opens with a preparation, never the queued route')
    const sends = spawned.flatMap(child => child.requests).filter(request => request.id === 'bike-warmup')
    assert(sends.length <= 1, 'The queued route is written once')
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
  assert.equal((await queued).process, 1, 'Work waiting when the new process opens goes to it, not behind the busy one')
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

  // Retirement is a process-exit barrier: it settles only after every
  // affected child has closed, and the City takes no new work meanwhile.
  let holding = false
  const held = []
  const holdingSpawn = (...args) => {
    const child = fakeSpawn(...args)
    const emit = child.emit.bind(child)
    child.emit = (event, ...rest) => {
      if (event === 'close' && holding) {
        held.push(() => emit(event, ...rest))
        return true
      }
      return emit(event, ...rest)
    }
    return child
  }
  const releaseClose = () => { holding = false; for (const close of held.splice(0)) close() }
  const barrier = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: holdingSpawn, maxCities: 4 })
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-nested-city-'))
  try {
    fs.mkdirSync(path.join(parent, 'wheelchair'))
    fs.writeFileSync(path.join(parent, 'wheelchair', 'network.json'), '{}')
    const outer = nativeLayout(parent)
    const wheelchair = nativeLayout(path.join(parent, 'wheelchair'))
    const wheelchairStore = path.join(parent, 'wheelchair', 'routing', 'project.sqlite')
    const roots = () => barrier.snapshot().residentCities.map(city => city.root)

    // A publisher renames files only after retirement settles; while the
    // stopped child has not closed, retirement and the rename both wait.
    await barrier.query(wheelchair, { id: 'wheelchair' })
    holding = true
    let renamed = false
    const publishing = (async () => { await barrier.retire(wheelchairStore); renamed = true })()
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(renamed, false, 'Files must not be replaced before the process exits')
    assert.equal(held.length, 1, 'The stopped process has not closed yet')
    await assert.rejects(barrier.query(wheelchair, { id: 'during-retirement' }),
      error => error instanceof NativeCityUnavailableError && error.retryable === true && /being updated/.test(error.message))
    releaseClose()
    await publishing
    assert.equal(renamed, true)
    assert.equal((await barrier.query(wheelchair, { id: 'after-retirement' })).id, 'after-retirement')

    // A process that never exits makes retirement fail loudly, not succeed.
    holding = true
    await assert.rejects(barrier.retire(wheelchairStore), /did not exit within 400 ms/)
    releaseClose()
    assert.equal((await barrier.query(wheelchair, { id: 'after-timeout' })).id, 'after-timeout')

    // Ownership. A file or the root of the nested City retires it alone, even
    // while the parent answers; a parent file retires the parent alone; the
    // parent root retires both. A nested City that is not resident still owns
    // its files through its published network.json.
    await barrier.query(outer, { id: 'outer' })
    const answering = barrier.query(outer, { id: 'outer-busy', delayMs: 50 })
    await barrier.retire(wheelchairStore)
    assert.equal((await answering).id, 'outer-busy')
    assert.deepEqual(roots(), [outer.root])
    await barrier.query(wheelchair, { id: 'nested-root' })
    await barrier.retire(path.join(parent, 'wheelchair'))
    assert.deepEqual(roots(), [outer.root], 'Retiring the nested root leaves its parent open')
    await barrier.retire(wheelchairStore)
    assert.deepEqual(roots(), [outer.root], 'A non-resident nested City leaves its parent open')
    await barrier.query(wheelchair, { id: 'parent-file' })
    await barrier.retire(path.join(parent, 'routing', 'project.sqlite'))
    assert.deepEqual(roots(), [wheelchair.root], 'A parent file retires the parent alone')
    await barrier.query(outer, { id: 'parent-root' })
    await barrier.retire(parent)
    assert.deepEqual(roots(), [], 'The parent root retires the City and every City beneath it')
    if (process.platform === 'win32') {
      await barrier.query(wheelchair, { id: 'case' })
      await barrier.retire(path.join(parent, 'WHEELCHAIR'))
      assert.deepEqual(roots(), [], 'Windows paths compare case-insensitively')
    }

    // Cancelling one request stops only that work: the City stays open and
    // takes new requests at once, unlike a retirement.
    await barrier.query(outer, { id: 'warm' })
    const cancelled = new AbortController()
    const dropped = barrier.query(outer, { id: 'dropped', delayMs: 40 }, cancelled.signal)
    cancelled.abort()
    await assert.rejects(dropped, { name: 'AbortError' })
    assert.equal((await barrier.query(outer, { id: 'still-open' })).id, 'still-open')

    // closeAll is a barrier as well.
    holding = true
    let closed = false
    const closing = barrier.closeAll().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(closed, false)
    releaseClose()
    await closing
    assert.deepEqual(roots(), [])
  } finally {
    releaseClose()
    await barrier.closeAll().catch(() => {})
    fs.rmSync(parent, { recursive: true, force: true })
  }

  // ---- The serving contract (deep concurrency audit R1–R6) ----
  const until = async (condition, label, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  }
  // A child whose answers wait for release(), so work can be held in place.
  const gated = []
  let gateOpen = true
  const gatedSpawn = (...args) => {
    const child = fakeSpawn(...args)
    const write = child.stdin.write
    child.stdin.write = line => {
      if (gateOpen) return write(line)
      gated.push(() => write(line))
    }
    return child
  }
  const releaseGate = () => { gateOpen = true; for (const send of gated.splice(0)) send() }

  // R1: admission is bounded by count and bytes, globally and per City, with
  // an explicit retryable overload; every outcome returns its permits.
  {
    const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: gatedSpawn, maxCities: 4, maxProcesses: 1,
      limits: { maxPending: 6, maxPendingBytes: 20_000, cityMaxPending: 4, cityMaxPendingBytes: 6_000 } })
    const a = nativeLayout('/cities/admit-a')
    const b = nativeLayout('/cities/admit-b')
    try {
      gateOpen = false
      const held = [1, 2, 3].map(id => pool.query(a, { id: `a${id}` }))
      const cancel = new AbortController()
      const cancelled = pool.query(a, { id: 'a-cancelled' }, cancel.signal)
      const overloaded = error => error.code === 'VIGO_NATIVE_OVERLOADED' && error.statusCode === 503 && error.retryable === true
      await assert.rejects(pool.query(a, { id: 'a5' }), overloaded, 'The City count limit refuses explicitly')
      cancel.abort()
      await assert.rejects(cancelled, { name: 'AbortError' })
      held.push(pool.query(a, { id: 'a-after-cancel' }))
      await assert.rejects(pool.query(a, { id: 'big', padding: 'x'.repeat(7_000) }), overloaded, 'The City byte limit refuses explicitly')
      held.push(pool.query(b, { id: 'b1' }), pool.query(b, { id: 'b2' }))
      await assert.rejects(pool.query(b, { id: 'b3' }), overloaded, 'The global count limit refuses explicitly')
      const admission = pool.snapshot().admission
      assert.equal(admission.pending, 6)
      assert(admission.pendingBytes > 0 && admission.pendingBytes <= 20_000)
      releaseGate()
      await Promise.all(held)
      assert.deepEqual([pool.snapshot().admission.pending, pool.snapshot().admission.pendingBytes], [0, 0], 'Every permit returns')
      // A held City that is retired returns its permits too.
      gateOpen = false
      const retiredWork = [pool.query(a, { id: 'r1' }), pool.query(a, { id: 'r2' })]
      await pool.retire(a.root)
      await Promise.all(retiredWork.map(work => assert.rejects(work)))
      assert.equal(pool.snapshot().admission.pending, 0)
    } finally { releaseGate(); await pool.closeAll() }
  }

  // R4: a request cancelled before admission opens, evicts and starts nothing.
  {
    const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxCities: 1 })
    const warm = nativeLayout('/cities/warm-leased')
    try {
      pool.setResidency(warm, true, 'route')
      await pool.query(warm, { id: 'warm' })
      const before = spawned.length
      const controller = new AbortController()
      controller.abort()
      for (let index = 0; index < 50; index += 1) {
        await assert.rejects(pool.query(nativeLayout(`/cities/cold-${index}`), { id: index }, controller.signal), { name: 'AbortError' })
      }
      assert.equal(spawned.length, before, 'No process starts for cancelled requests')
      assert.deepEqual(pool.snapshot().residentCities.map(city => city.root), [warm.root], 'The warm City stays resident')
      assert.equal(pool.snapshot().admission.pending, 0)
      assert.equal(pool.snapshot().counters.abortedBeforeAdmission, 50)
    } finally { await pool.closeAll() }
  }

  // R5: a backlog reaches every process that becomes ready, including ones
  // that start after the work arrived; each request is written exactly once.
  {
    const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 4 })
    const layout = nativeLayout('/cities/burst')
    try {
      await pool.query(layout, { id: 'open' })
      const first = spawned.length - 1
      const ids = Array.from({ length: 40 }, (_, index) => `burst-${index}`)
      const answers = await Promise.all(ids.map(id => pool.query(layout, { id, delayMs: 15 })))
      const serving = new Set(answers.map(answer => answer.process))
      assert(serving.size >= 3, `The burst spread over ${serving.size} processes`)
      assert(answers.filter(answer => answer.process !== first).length >= 20, 'Most of the burst ran on processes added for it')
      const writes = spawned.flatMap(child => child.requests).filter(request => ids.includes(request.id))
      assert.equal(writes.length, ids.length, 'No request was written twice')
    } finally { await pool.closeAll() }
  }

  // R6: one deadline per request, kept across its retry.
  {
    const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 1, timeoutMs: 300 })
    const layout = nativeLayout('/cities/deadline')
    try {
      const crashOn = (await pool.query(layout, { id: 'probe' })).process
      const started = performance.now()
      await assert.rejects(pool.query(layout, { id: 'late', delayMs: 200, crash: 'once', crashOn }), /exceeded/)
      const elapsed = performance.now() - started
      assert(elapsed < 380, `The retry kept the original deadline (${elapsed.toFixed(0)} ms)`)
      assert.equal(pool.snapshot().counters.retried, 1)
    } finally { await pool.closeAll() }
  }
  // R6: a waiting request that expires leaves the queue; the process running
  // someone else's request keeps running it.
  {
    const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 1 })
    const layout = nativeLayout('/cities/expiry')
    try {
      await pool.query(layout, { id: 'open' })
      const child = pool.cities.get(layout.key).processes[0].child
      const running = pool.query(layout, { id: 'running', delayMs: 150 })
      await assert.rejects(pool.query(layout, { id: 'waiting' }, null, { timeoutMs: 40 }), /exceeded/)
      assert.equal((await running).id, 'running')
      assert.equal(child.killed, false, 'The busy process was not stopped')
      assert(!child.requests.some(request => request.id === 'waiting'), 'The expired request was never written')
      assert.equal(pool.snapshot().counters.expiredWaiting, 1)
    } finally { await pool.closeAll() }
  }

  // R2: a reset makes every earlier request stale. Nothing admitted before it
  // is retried or answered, and nothing reopens the old City by itself.
  {
    const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: fakeSpawn, maxProcesses: 1 })
    const layout = nativeLayout('/cities/reset')
    try {
      const crashOn = (await pool.query(layout, { id: 'probe' })).process
      const crashing = pool.query(layout, { id: 'crashing', delayMs: 20, crash: 'once', crashOn })
      const queued = pool.query(layout, { id: 'queued' })
      // Let the crash happen and its retry start, then reset under it.
      await until(() => pool.snapshot().counters.retried === 1, 'the retry')
      const startsBefore = spawned.length
      await pool.reset()
      await Promise.all([assert.rejects(crashing), assert.rejects(queued)])
      await new Promise(resolve => setTimeout(resolve, 60))
      assert.equal(pool.cities.size, 0, 'No old request reopened the City after the reset')
      assert.equal(spawned.length, startsBefore, 'No process started after the reset')
      assert.equal(pool.snapshot().admission.pending, 0)
      // The runtime still serves after a reset; shutdown is terminal.
      assert.equal((await pool.query(layout, { id: 'after-reset' })).id, 'after-reset')
      await pool.shutdown()
      await assert.rejects(pool.query(layout, { id: 'after-shutdown' }), /shut down/)
    } finally { await pool.closeAll() }
  }

  // S2: response bytes across processes stay within a budget. The process
  // that started first finishes its line; others pause until it does.
  {
    const pool = new NativeRuntime({ executable: '/fake/vigo', spawnProcess: gatedSpawn, maxCities: 2, maxProcesses: 1,
      responseLimitBytes: 4096, limits: { responseBudgetBytes: 4096 } })
    const a = nativeLayout('/cities/budget-a')
    const b = nativeLayout('/cities/budget-b')
    try {
      gateOpen = false
      const first = pool.query(a, { id: 'a' })
      const second = pool.query(b, { id: 'b' })
      const childA = pool.cities.get(a.key).processes[0].child
      const childB = pool.cities.get(b.key).processes[0].child
      for (const child of [childA, childB]) {
        child.pauses = 0
        child.resumes = 0
        child.stdout.pause = () => { child.pauses += 1 }
        child.stdout.resume = () => { child.resumes += 1 }
      }
      const body = id => `{"status":"ok","trace":{"id":"${id}","padding":"${'x'.repeat(3000)}"}}`
      childA.stdout.emit('data', Buffer.from(body('a').slice(0, 2500)))
      childB.stdout.emit('data', Buffer.from(body('b').slice(0, 2500)))
      assert.equal(childB.pauses, 1, 'The later response pauses while over budget')
      assert.equal(childA.pauses, 0, 'The first response always continues')
      assert(pool.snapshot().responses.bufferedBytes <= 5000)
      childA.stdout.emit('data', Buffer.from(`${body('a').slice(2500)}\n`))
      assert.equal((await first).id, 'a')
      assert.equal(childB.resumes, 1, 'The paused response resumes once under budget')
      childB.stdout.emit('data', Buffer.from(`${body('b').slice(2500)}\n`))
      assert.equal((await second).id, 'b')
      assert.equal(pool.snapshot().responses.bufferedBytes, 0)
    } finally { releaseGate(); await pool.closeAll() }
  }
  console.log(`Native runtime passed (${spawned.length} fake processes).`)
} finally {
  await runtime.closeAll()
}
