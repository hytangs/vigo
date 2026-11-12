import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundedInteger, memoryCapacityBytes } from './resource-limits.mjs'

// Studio's queries run in the `vigo` executable, the same runtime as the CLI,
// HTTP server and Python. Each opened City (or Studio project store) is served
// by resident `vigo stream` processes that each answer one request at a time.
//
// The serving contract, in the order a request meets it:
// - Admission. A cancelled request, a City being replaced or a shut-down
//   runtime is refused before anything is opened, evicted or started. An
//   admitted request reserves a count and byte permit, globally and for its
//   City, and returns both on every outcome. Exhausted permits are an explicit
//   retryable overload (503), never an unbounded queue.
// - One deadline. Each request gets an absolute deadline when admitted. It
//   covers waiting, a process start and one automatic retry. A request that
//   expires while waiting leaves the queue; only the request a process is
//   computing can stop that process.
// - Dispatch. Unsent work waits in its City's queue and is written to a ready
//   process the moment one is free, including one that has just started. A
//   written request is never moved. Point routes go before analyses, which may
//   be passed over at most four times. A request waits briefly for a process
//   that has its travel mode loaded, then takes any idle one.
// - Generations. Retiring a City's files (a refresh in the same library)
//   starts a new City generation synchronously and is transparent to admitted
//   work: waiting work, and work arriving meanwhile, is held until the old
//   processes have exited and then runs on the new generation; a request the
//   retirement stopped mid-computation runs once more there. All of it stays
//   within each request's deadline. A reset (another library) or shutdown bumps
//   the runtime epoch instead and refuses everything admitted before it. No
//   answer or retry of an old generation or epoch is ever accepted.
const maxResidentCities = boundedInteger(process.env.VIGO_NATIVE_CITY_MAX, 2, 1, 8)
const processesPerCity = boundedInteger(process.env.VIGO_NATIVE_CITY_PROCESSES, 2, 1, 8)
const residentIdleMs = boundedInteger(process.env.VIGO_NATIVE_CITY_IDLE_MS, 300_000, 100, 3_600_000)
const queryTimeoutMs = boundedInteger(process.env.VIGO_NATIVE_QUERY_TIMEOUT_MS, 600_000, 1000, 3_600_000)
// A cancelled query normally finishes within milliseconds; its answer is then
// discarded. Long analyses are stopped instead of holding the City.
const cancelGraceMs = boundedInteger(process.env.VIGO_NATIVE_CANCEL_GRACE_MS, 1500, 0, 600_000)
// A City that keeps stopping must not spend its time reloading.
const rewarmSpacingMs = 30_000
// At most this many process starts per City in any 30 seconds; further
// requests wait (within their deadlines) instead of restarting in a loop.
const restartWindowMs = 30_000
const restartBudget = boundedInteger(process.env.VIGO_NATIVE_RESTART_BUDGET, 6, 1, 100)
// Retirement waits this long for stopped processes to exit before failing.
const retireTimeoutMs = boundedInteger(process.env.VIGO_NATIVE_RETIRE_TIMEOUT_MS, 15_000, 100, 600_000)
const maxResponseBytes = 256 * 1024 * 1024
const MiB = 1024 * 1024
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Math.floor(value)))
// Admission permits: requests waiting or running, and their encoded bytes.
const defaultPendingBytes = clamp(memoryCapacityBytes / 64, 16 * MiB, 256 * MiB)
const maxPendingRequests = boundedInteger(process.env.VIGO_NATIVE_MAX_PENDING, 256, 1, 100_000)
const maxCityPendingRequests = boundedInteger(process.env.VIGO_NATIVE_CITY_MAX_PENDING, 128, 1, 100_000)
const maxPendingBytes = boundedInteger(process.env.VIGO_NATIVE_MAX_PENDING_BYTES, defaultPendingBytes, MiB, 4096 * MiB)
const maxCityPendingBytes = boundedInteger(process.env.VIGO_NATIVE_CITY_MAX_PENDING_BYTES,
  Math.max(MiB, Math.floor(maxPendingBytes / 2)), MiB, 4096 * MiB)
// Response lines being received and decoded, across every process. One line
// may always finish; other processes pause their output while the total is
// over budget, so a burst of large answers cannot all be held at once.
const responseBudgetBytes = boundedInteger(process.env.VIGO_NATIVE_RESPONSE_BUDGET_BYTES,
  clamp(memoryCapacityBytes / 8, maxResponseBytes, 2048 * MiB), MiB, 16384 * MiB)
// How long a request waits for a process with its travel mode loaded before
// taking an idle process that must load it first.
const affinityWaitMs = boundedInteger(process.env.VIGO_NATIVE_AFFINITY_WAIT_MS, 500, 1, 60_000)
// An analysis may be passed over by this many point routes, then goes next.
const maximumAnalysisBypasses = 4
// Each process loads a mode when it is first asked for it (modePreparation), so
// an opening process activates only the timetable. The engine default, all
// modes, adds the bicycle hierarchy and street networks to every process:
// about 1 GB more per Boston process, with up to two processes per City.
// An explicit VIGO_PREPARE still applies.
const streamEnvironment = environment => environment.VIGO_PREPARE ? environment : { ...environment, VIGO_PREPARE: 'transit' }
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const preparationRequest = request => request?.kind === 'info'
  || request?.kind === 'native' && request.operation?.endsWith('.prepare')
const preparationModes = { 'street.prepare': 'walk', 'drive.prepare': 'drive', 'bike.prepare': 'bike', 'timetable.prepare': 'transit' }
const routeMode = request => request?.kind === 'native' ? preparationModes[request.operation] ?? null
  : ['route', 'matrix', 'reach'].includes(request?.kind) ? request.mode ?? 'transit' : null
const analysisRequest = request => request?.kind === 'matrix' || request?.kind === 'reach'
// Preparation keeps only timetable selectors, never a visitor's journey.
function modePreparation(request) {
  const mode = routeMode(request)
  if (!mode) return null
  if (mode === 'transit' && !request.serviceDate) return { kind: 'info' }
  const operation = { walk: 'street.prepare', drive: 'drive.prepare', bike: 'bike.prepare', transit: 'timetable.prepare' }[mode]
  if (!operation) return null
  const selectors = ['serviceDate', 'serviceDay', 'time', 'timeMinutes', 'timePreference',
    'horizonMinutes', 'allowStreetTransfers', 'minimumTransferBufferMinutes', 'wheelchair', 'sourceScopes']
  return { kind: 'native', operation,
    ...(mode === 'transit' ? Object.fromEntries(selectors.filter(key => request[key] !== undefined).map(key => [key, request[key]])) : {}) }
}
const executableName = process.platform === 'win32' ? 'vigo.exe' : 'vigo'

function makeAbortError(message = 'The request was cancelled.') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** The `vigo` executable beside the bundled server, or this checkout's release build. */
export function nativeExecutable(environment = process.env, directory = moduleDirectory) {
  const configured = String(environment.VIGO_STANDALONE_PATH ?? '').trim()
  const candidates = configured ? [configured] : [
    path.join(directory, executableName),
    path.join(directory, '..', executableName),
    path.join(directory, '..', 'server', executableName),
    path.resolve(directory, '..', 'target', 'release', executableName),
    path.resolve(directory, '..', '..', '..', 'target', 'release', executableName),
  ]
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

/** A request the runtime rejected, with its public error code. */
export class NativeQueryError extends Error {
  constructor(message, code, statusCode = 400, { retryable = false } = {}) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.retryable = retryable
  }
}

/**
 * The runtime could not open or keep serving a City. `preparation` marks a
 * Studio project store whose prepared artifacts are missing or stale.
 */
export class NativeCityUnavailableError extends Error {
  constructor(message, { preparation = false, retryable = false } = {}) {
    super(message)
    this.code = 'VIGO_NATIVE_CITY_UNAVAILABLE'
    this.statusCode = 409
    this.preparation = preparation
    // The process stopped for a reason other than this request; another
    // process can answer it.
    this.retryable = retryable
  }
}

const overloaded = scope => new NativeQueryError(
  `The VIGO runtime has too much work waiting${scope}. Retry shortly.`, 'VIGO_NATIVE_OVERLOADED', 503, { retryable: true })
const beingUpdated = () => new NativeCityUnavailableError('The City is being updated. Retry shortly.', { retryable: true })

// Prepared-artifact failures a Studio project's preparation step repairs,
// including a prepared file it has not written yet.
const preparationFailure = /prepared|rebuild|stale|coordinate access|access context|terminal-access|unexpected SQLite WAL|file was not found/i

/** One routing store of a City or Studio project. */
export function nativeLayout(root, routingStore = null) {
  const resolved = path.resolve(root)
  const store = routingStore ? path.resolve(resolved, 'routing', path.basename(routingStore)) : null
  return {
    root: resolved,
    routingStore: store,
    key: store ? `${resolved}\u0000${store}` : resolved,
  }
}

/**
 * One resident `vigo stream` process of a City. It computes one request at a
 * time (`current`); the runtime decides what it is given next.
 */
class StreamProcess {
  constructor({ executable, layout, spawnProcess, responseLimitBytes, events }) {
    this.layout = layout
    this.current = null
    this.lastUsed = Date.now()
    this.closed = false
    this.stopping = false
    this.answered = false
    this.ready = true
    this.paused = false
    this.routeModes = new Set()
    this.stderr = ''
    this.chunks = []
    this.bufferedBytes = 0
    this.responseLimitBytes = responseLimitBytes
    this.events = events
    // Settles once the child has exited and released its files: retirement
    // waits on it before a City's files are replaced.
    this.exited = new Promise(resolve => { this.markExited = resolve })
    const args = ['stream', '--stream-output=detailed', `--city=${layout.root}`]
    if (layout.routingStore) args.push(`--routing-store=${path.basename(layout.routingStore)}`)
    this.child = spawnProcess(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: streamEnvironment(process.env) })
    // A closed parent closes stdin, and the stream exits on end of input.
    this.child.unref?.()
    this.child.stdout.on('data', chunk => this.receive(chunk))
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8_000) })
    this.child.stdin.on('error', () => {})
    this.child.on('error', error => {
      this.fail(new NativeCityUnavailableError(`VIGO could not start its runtime: ${error.message}`))
      // A child that never started holds no files and may not report close.
      if (this.child.pid === undefined) this.markExited()
    })
    // exit can precede the last stderr chunk. Wait for closed streams so a
    // repairable missing/stale City is not reduced to an opaque exit code.
    this.child.on('close', (code, signal) => {
      this.markExited()
      const detail = this.lastError() || `exit ${code ?? signal}`
      // A process that opened its City, or was killed, can be replaced; one
      // that could not open it reports why.
      this.fail(this.answered || signal
        ? new NativeCityUnavailableError(`The VIGO runtime stopped: ${detail}`, { retryable: !this.stopping })
        : new NativeCityUnavailableError(detail, { preparation: preparationFailure.test(detail) }))
    })
  }

  get busy() {
    return Boolean(this.current)
  }

  lastError() {
    const line = this.stderr.trim().split('\n').at(-1) ?? ''
    try {
      return String(JSON.parse(line)?.error?.message ?? line)
    } catch {
      return line
    }
  }

  /** Write `job`; the process answers it next. */
  send(job) {
    this.current = job
    this.lastUsed = Date.now()
    job.state = 'sent'
    job.stream = this
    this.child.stdin.write(job.line)
  }

  receive(chunk) {
    if (this.closed) return
    let start = 0
    let newline = chunk.indexOf(10)
    while (newline >= 0) {
      if (this.bufferedBytes + newline - start > this.responseLimitBytes) {
        this.stop(new NativeCityUnavailableError('The VIGO runtime response exceeds its byte limit.'))
        return
      }
      this.chunks.push(chunk.subarray(start, newline))
      const line = Buffer.concat(this.chunks)
      this.chunks = []
      // The line stays counted against the response budget until decoded.
      this.events.buffered(this, line.length - this.bufferedBytes)
      this.bufferedBytes = line.length
      if (line.length) this.settle(line)
      this.events.buffered(this, -this.bufferedBytes)
      this.bufferedBytes = 0
      if (this.closed) return
      start = newline + 1
      newline = chunk.indexOf(10, start)
    }
    if (start < chunk.length) {
      const bytes = chunk.length - start
      if (this.bufferedBytes + bytes > this.responseLimitBytes) {
        this.stop(new NativeCityUnavailableError('The VIGO runtime response exceeds its byte limit.'))
        return
      }
      this.events.buffered(this, bytes)
      this.bufferedBytes += bytes
      this.chunks.push(chunk.subarray(start))
    }
  }

  settle(text) {
    let response
    try {
      response = JSON.parse(text.toString('utf8'))
    } catch {
      this.stop(new NativeCityUnavailableError('The VIGO runtime returned malformed output.'))
      return
    }
    this.answered = true
    const job = this.current
    this.current = null
    this.lastUsed = Date.now()
    if (!job) return
    let outcome
    if (response?.status === 'error') {
      const message = String(response.error?.message ?? 'The VIGO runtime rejected the request.')
      outcome = { error: new NativeQueryError(message, String(response.error?.code ?? 'invalid_request')) }
    } else if (!response?.trace || typeof response.trace !== 'object') {
      outcome = { error: new NativeCityUnavailableError('The VIGO runtime returned no detailed Result.') }
    } else {
      outcome = decodeTrace(response.trace)
    }
    this.events.answered(this, job, outcome)
  }

  /** Close the process; its current request, if any, receives `error`. */
  fail(error, culprit = null) {
    if (this.closed) return
    this.closed = true
    const job = this.current
    this.current = null
    this.events.buffered(this, -this.bufferedBytes)
    this.chunks = []
    this.bufferedBytes = 0
    this.events.failed(this, job, error, culprit)
  }

  /** Stop the process; the result settles once it has exited. */
  stop(error = new NativeCityUnavailableError('The VIGO runtime was closed.'), culprit = null) {
    this.stopping = true
    // Settle the current request before the exit event can.
    this.fail(error, culprit)
    if (!this.child.killed && this.child.exitCode === null) {
      this.child.stdin.end()
      this.child.kill('SIGKILL')
    }
    return this.exited
  }
}

// An indexed Matrix answer shares journeys through a table; expand it.
function decodeTrace(trace) {
  if (trace.journeyIndices === undefined) return { value: trace }
  const table = trace.journeyTable
  if (!Array.isArray(table) || !Array.isArray(trace.journeyIndices)
    || trace.journeyIndices.length !== trace.originCount) {
    return { error: new Error('Invalid native indexed Matrix journeys') }
  }
  try {
    trace.journeys = trace.journeyIndices.map(row => {
      if (!Array.isArray(row) || row.length !== trace.destinationCount) throw new Error('Invalid native Matrix journey row')
      return row.map(index => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= table.length) throw new Error('Invalid native Matrix journey index')
        return table[index]
      })
    })
    delete trace.journeyTable
    delete trace.journeyIndices
    return { value: trace }
  } catch (error) {
    return { error }
  }
}

// Windows paths compare case-insensitively; a missed City would keep a file open.
function ownerKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function within(inner, outer) {
  return inner === outer || inner.startsWith(`${outer}${path.sep}`)
}

/**
 * The City that owns `target`: the nearest directory, the target itself
 * included, that is a resident City root or holds a published City's
 * network.json. Null when `target` lies inside no City.
 */
function owningCity(target, knownRoots) {
  for (let directory = target; ; directory = path.dirname(directory)) {
    if (knownRoots.includes(directory) || fs.existsSync(path.join(directory, 'network.json'))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return null
  }
}

/** The processes and waiting work of one City layout. */
class CityProcesses {
  constructor(layout) {
    this.layout = layout
    this.root = ownerKey(layout.root)
    this.processes = []
    this.queue = []
    this.starts = []
    this.pendingCount = 0
    this.pendingBytes = 0
    this.affinityTimer = null
    this.restartTimer = null
    // A Reach comparison's scenario grows from its baseline's stream.
    this.baseline = null
  }

  /** Requests waiting or running here. */
  get pending() {
    return this.queue.length + this.processes.filter(stream => stream.busy).length
  }

  get lastUsed() {
    return Math.max(0, ...this.processes.map(stream => stream.lastUsed))
  }

  clearTimers() {
    clearTimeout(this.affinityTimer)
    clearTimeout(this.restartTimer)
    this.affinityTimer = null
    this.restartTimer = null
  }

  /** Stop every process; the result settles once all have exited. */
  stop(error) {
    this.clearTimers()
    return Promise.all([...this.processes].map(stream => stream.stop(error)))
  }
}

export class NativeRuntime {
  constructor({
    executable = nativeExecutable(),
    maxCities = maxResidentCities,
    maxProcesses = processesPerCity,
    idleMs = residentIdleMs,
    spawnProcess = spawn,
    responseLimitBytes = maxResponseBytes,
    timeoutMs = queryTimeoutMs,
    limits = {},
    // Throws when the caller's work may no longer open a City, for example a
    // request that began before Studio switched library.
    admit = () => {},
  } = {}) {
    this.executable = executable
    this.admit = admit
    this.warmRoutes = new Map()
    this.lastRewarm = new Map()
    this.maxCities = maxCities
    this.maxProcesses = maxProcesses
    this.idleMs = idleMs
    this.spawnProcess = spawnProcess
    this.responseLimitBytes = responseLimitBytes
    this.timeoutMs = timeoutMs
    this.limits = {
      maxPending: maxPendingRequests,
      maxPendingBytes,
      cityMaxPending: maxCityPendingRequests,
      cityMaxPendingBytes: maxCityPendingBytes,
      responseBudgetBytes: Math.max(responseLimitBytes, responseBudgetBytes),
      affinityWaitMs,
      restartBudget,
      ...limits,
    }
    this.cities = new Map()
    this.leases = new Map()
    this.idleTimer = null
    // Roots whose processes are exiting before their files are replaced.
    this.retiring = new Map()
    // A reset makes every earlier request stale; retiring a City makes its own.
    this.epoch = 0
    this.generations = new Map()
    // Admitted requests waiting for a City's retirement to finish, by root.
    this.held = new Map()
    this.shut = false
    this.sequence = 0
    this.pendingCount = 0
    this.pendingBytes = 0
    this.responseBytes = 0
    this.buffering = new Set()
    this.counters = {
      admitted: 0, overloaded: 0, abortedBeforeAdmission: 0, expiredWaiting: 0, timedOutRunning: 0,
      cancelledRunning: 0, retried: 0, processStarts: 0, staleGeneration: 0, startsDeferred: 0,
      heldForRetirement: 0, rerunAfterRetirement: 0,
    }
  }

  get available() {
    return Boolean(this.executable)
  }

  #generation(root) {
    return this.generations.get(root) ?? 0
  }

  /**
   * Answer one public request (`kind` route, matrix, reach, …) on `layout`.
   * A request whose process stops for another reason is sent once more, to a
   * fresh process, within its original deadline. `timeoutMs` shortens that
   * deadline for a caller with less time to spend.
   */
  async query(layout, request, signal, { timeoutMs } = {}) {
    return this.#submit(layout, request, signal, { internal: false, timeoutMs })
  }

  #submit(layout, request, signal, { internal, pinned = null, timeoutMs }) {
    if (this.shut) return Promise.reject(new NativeCityUnavailableError('The VIGO runtime has shut down.'))
    if (!this.executable) {
      return Promise.reject(new NativeCityUnavailableError('The VIGO executable is missing. Run npm run build:standalone.'))
    }
    try {
      if (!internal) this.admit()
    } catch (error) {
      return Promise.reject(error)
    }
    // Nothing is opened, evicted or started for a request already cancelled.
    if (signal?.aborted) {
      this.counters.abortedBeforeAdmission += 1
      return Promise.reject(makeAbortError())
    }
    const root = ownerKey(layout.root)
    // Only a same-library refresh holds new public work; warm-ups and work
    // arriving during a reset are refused.
    const retiring = this.retiring.get(root)
    const hold = Boolean(retiring) && retiring.transparent && !internal
    if (retiring && !hold) return Promise.reject(beingUpdated())
    let line
    try {
      line = `${JSON.stringify(request)}\n`
    } catch (error) {
      return Promise.reject(error)
    }
    const bytes = Buffer.byteLength(line)
    const existing = this.cities.get(layout.key)
    if (!internal) {
      const cityCount = existing?.pendingCount ?? 0
      const cityBytes = existing?.pendingBytes ?? 0
      let scope = null
      if (this.pendingCount + 1 > this.limits.maxPending || this.pendingBytes + bytes > this.limits.maxPendingBytes) scope = ''
      else if (cityCount + 1 > this.limits.cityMaxPending || cityBytes + bytes > this.limits.cityMaxPendingBytes) scope = ' for this City'
      if (scope !== null) {
        this.counters.overloaded += 1
        return Promise.reject(overloaded(scope))
      }
    }
    let city = null
    if (!hold) {
      try {
        city = this.#city(layout, true)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, this.timeoutMs) : this.timeoutMs
    return new Promise((resolve, reject) => {
      const now = performance.now()
      const job = {
        seq: (this.sequence += 1), request, line, bytes, internal, pinned, city: null, layout, root,
        mode: routeMode(request), analysis: analysisRequest(request), preparing: preparationRequest(request),
        epoch: this.epoch, generation: this.#generation(root), admittedAt: now, queuedAt: now,
        deadline: now + budgetMs, budgetMs, attempts: 0, bypasses: 0, state: 'queued', stream: null,
        done: false, discarded: false, resolve, reject, signal,
      }
      if (!internal) {
        this.counters.admitted += 1
        this.pendingCount += 1
        this.pendingBytes += bytes
      }
      job.timer = setTimeout(() => this.#expire(job), budgetMs)
      job.timer.unref?.()
      if (signal) {
        job.abort = () => this.#cancel(job)
        signal.addEventListener('abort', job.abort, { once: true })
      }
      if (hold) this.#hold(job)
      else this.#attach(job, city)
    })
  }

  // Queue `job` on `city`, which holds its City permits from now on.
  #attach(job, city) {
    job.city = city
    job.state = 'queued'
    job.stream = null
    job.queuedAt = performance.now()
    if (!job.internal) {
      city.pendingCount += 1
      city.pendingBytes += job.bytes
    }
    if (job.request?.surfaceReuse === 'scenario' && city.baseline && !city.baseline.closed) job.pinned = city.baseline
    if (job.attempts) city.queue.unshift(job)
    else city.queue.push(job)
    this.#dispatch(city)
  }

  // Leave `job.city` (its queue and City permits), keeping the global permit.
  #detach(job) {
    const city = job.city
    if (!city) return
    job.city = null
    if (!job.internal) {
      city.pendingCount -= 1
      city.pendingBytes -= job.bytes
    }
    const index = city.queue.indexOf(job)
    if (index >= 0) city.queue.splice(index, 1)
  }

  // Keep `job` until its City's retirement has finished; it then runs on the
  // new generation (#release). Its deadline keeps running meanwhile.
  #hold(job) {
    this.#detach(job)
    job.state = 'held'
    job.stream = null
    job.pinned = null
    if (!this.retiring.has(job.root)) {
      this.#readmit(job)
      return
    }
    this.counters.heldForRetirement += 1
    const held = this.held.get(job.root) ?? new Set()
    held.add(job)
    this.held.set(job.root, held)
  }

  #readmit(job) {
    if (job.done) return
    if (job.epoch !== this.epoch || this.shut) {
      this.counters.staleGeneration += 1
      this.#finish(job, beingUpdated())
      return
    }
    job.generation = this.#generation(job.root)
    let city
    try {
      city = this.#city(job.layout, true)
    } catch (error) {
      this.#finish(job, error)
      return
    }
    this.#attach(job, city)
  }

  // A held request of a City still current (same epoch) goes back in.
  #release(root) {
    const held = this.held.get(root)
    if (!held) return
    this.held.delete(root)
    for (const job of held) this.#readmit(job)
  }

  /** Settle `job` once: return its permits, leave the queue and answer the caller. */
  #finish(job, error, value) {
    if (job.done) return
    job.done = true
    clearTimeout(job.timer)
    clearTimeout(job.grace)
    if (job.abort) job.signal.removeEventListener('abort', job.abort)
    if (!job.internal) {
      this.pendingCount -= 1
      this.pendingBytes -= job.bytes
    }
    this.#detach(job)
    this.held.get(job.root)?.delete(job)
    job.line = ''
    if (job.discarded) return
    if (error) job.reject(error)
    else job.resolve(value)
  }

  #current(job) {
    return job.epoch === this.epoch && job.generation === this.#generation(job.root)
  }

  // A public request a same-library retirement interrupted is run once more
  // on the City's next generation, if its epoch and deadline still allow.
  #rerun(job) {
    if (!job.interrupted || job.internal || job.attempts > 0 || job.epoch !== this.epoch) return false
    if (performance.now() >= job.deadline) return false
    job.interrupted = false
    job.attempts += 1
    this.counters.rerunAfterRetirement += 1
    this.#hold(job)
    return true
  }

  #cancel(job) {
    if (job.done) return
    if (job.state !== 'sent') {
      this.#finish(job, makeAbortError())
      return
    }
    // The caller returns at once; a query still running after the grace
    // period stops its process, which is then replaced.
    this.counters.cancelledRunning += 1
    this.#finish(job, makeAbortError())
    job.discarded = true
    const stream = job.stream
    job.grace = setTimeout(() => {
      if (stream.current !== job) return
      stream.replaceWhenStopped = true
      stream.stop(new NativeCityUnavailableError('A cancelled query was stopped.'), job)
    }, cancelGraceMs)
    job.grace.unref?.()
  }

  // The request's deadline passed. Waiting work simply leaves; only the
  // request a process is computing stops that process.
  #expire(job) {
    if (job.done) return
    const error = new NativeCityUnavailableError(`The VIGO runtime exceeded ${Math.ceil(job.budgetMs / 1000)} seconds.`)
    if (job.state === 'sent' && job.stream?.current === job) {
      this.counters.timedOutRunning += 1
      job.stream.stop(error, job)
    } else {
      this.counters.expiredWaiting += 1
      this.#finish(job, error)
    }
  }

  #events(city) {
    return {
      buffered: (stream, delta) => this.#buffered(stream, delta),
      answered: (stream, job, outcome) => {
        if (job.done) {
          this.#dispatch(city)
          return
        }
        if (!this.#current(job)) {
          if (!this.#rerun(job)) {
            this.counters.staleGeneration += 1
            this.#finish(job, beingUpdated())
          }
        } else if (outcome.error) {
          this.#finish(job, outcome.error)
        } else {
          if (job.mode) {
            stream.routeModes.add(job.mode)
            // A replacement process loads the mode without replaying a journey.
            const request = job.request
            if (!job.internal && this.leases.has(city.layout.key) && !request.scenario && !request.realtimeSnapshot) {
              const known = this.warmRoutes.get(city.layout.key) ?? new Map()
              known.set(job.mode, modePreparation({ ...request, serviceDate: outcome.value.serviceDate ?? request.serviceDate }))
              this.warmRoutes.set(city.layout.key, known)
            }
          }
          if (job.request?.surfaceReuse === 'baseline') city.baseline = stream
          this.#finish(job, null, outcome.value)
        }
        this.#dispatch(city)
      },
      failed: (stream, job, error, culprit) => {
        city.processes = city.processes.filter(other => other !== stream)
        if (city.baseline === stream) city.baseline = null
        this.#buffered(stream, 0)
        if (job && !job.done && this.#rerun(job)) {
          // Stopped by a same-library retirement: runs again on the new generation.
        } else if (job && !job.done && !this.#current(job)) {
          // Stopped by a reset: its library is gone.
          this.counters.staleGeneration += 1
          this.#finish(job, beingUpdated())
        } else if (job && !job.done) {
          // Work stopped by another request's failure, or by a crash, is
          // answered once more within its own deadline; a request that
          // caused the stop is not.
          const retry = error.retryable || (culprit && culprit !== job)
          if (retry && job.attempts === 0 && this.#current(job) && performance.now() < job.deadline
            && !(job.pinned && job.internal)) {
            job.attempts += 1
            job.state = 'queued'
            job.stream = null
            if (job.pinned === stream) job.pinned = null
            job.queuedAt = performance.now()
            city.queue.unshift(job)
            this.counters.retried += 1
          } else {
            this.#finish(job, error)
          }
        }
        // Work pinned to this process (a Reach scenario on its baseline) runs
        // on any other process instead.
        for (const waiting of city.queue) {
          if (waiting.pinned === stream) {
            if (waiting.internal) this.#finish(waiting, error)
            else waiting.pinned = null
          }
        }
        if (!city.processes.length && !city.queue.length && this.cities.get(city.layout.key) === city) {
          city.clearTimers()
          this.cities.delete(city.layout.key)
        }
        // A kept City that lost a working process prepares its replacement now,
        // so the next visitor does not pay to load each mode's network again.
        if ((stream.replaceWhenStopped || (!stream.stopping && stream.answered)) && !city.processes.length) this.#rewarm(city.layout)
        if (this.cities.get(city.layout.key) === city) this.#dispatch(city)
      },
    }
  }

  // Response bytes across every process, called before `stream.bufferedBytes`
  // changes by `delta`. The process that started receiving first always
  // continues, so one line can finish; while the total is over budget the
  // others pause their output, and resume as soon as it is not.
  #buffered(stream, delta) {
    this.responseBytes = Math.max(0, this.responseBytes + delta)
    if (stream.bufferedBytes + delta > 0 && !stream.closed) this.buffering.add(stream)
    else this.buffering.delete(stream)
    const over = this.responseBytes > this.limits.responseBudgetBytes
    const first = this.buffering.values().next().value
    for (const city of this.cities.values()) {
      for (const candidate of city.processes) {
        const pause = over && candidate !== first && this.buffering.has(candidate) && !candidate.closed
        if (pause === candidate.paused) continue
        candidate.paused = pause
        if (pause) candidate.child.stdout.pause?.()
        else candidate.child.stdout.resume?.()
      }
    }
    // A stream that stopped while paused must not stay counted as paused.
    if (stream.closed) stream.paused = false
  }

  /** Open `layout` ahead of its first query; a failure reappears on that query. */
  open(layout) {
    if (!this.executable || this.shut) return
    this.admit()
    if (this.retiring.has(ownerKey(layout.root))) return
    const city = this.#city(layout, true)
    if (!city.processes.length && this.#mayStart(city)) this.#start(city, false)
  }

  #city(layout, create) {
    // A City being retired takes no new work until its processes have exited:
    // its files are about to be replaced. The caller may retry afterwards.
    if (create && this.retiring.has(ownerKey(layout.root))) throw beingUpdated()
    let city = this.cities.get(layout.key)
    if (!city && create) {
      this.evict()
      if (this.cities.size >= this.maxCities) {
        throw new NativeQueryError('All resident City slots are busy. Retry when a query completes.', 'capacity_exceeded', 503, { retryable: true })
      }
      city = new CityProcesses(layout)
      this.cities.set(layout.key, city)
    }
    this.scheduleIdle()
    return city
  }

  #mayStart(city) {
    const now = Date.now()
    city.starts = city.starts.filter(started => now - started < restartWindowMs)
    if (city.starts.length < this.limits.restartBudget) return true
    this.counters.startsDeferred += 1
    if (!city.restartTimer) {
      city.restartTimer = setTimeout(() => {
        city.restartTimer = null
        if (this.cities.get(city.layout.key) === city) this.#dispatch(city)
      }, Math.max(1, restartWindowMs - (now - city.starts[0])))
      city.restartTimer.unref?.()
    }
    return false
  }

  #start(city, warm, request) {
    city.starts.push(Date.now())
    this.counters.processStarts += 1
    const stream = new StreamProcess({
      executable: this.executable,
      layout: city.layout,
      spawnProcess: this.spawnProcess,
      responseLimitBytes: this.responseLimitBytes,
      events: this.#events(city),
    })
    city.processes.push(stream)
    // An added process takes requests once it has opened the City and loaded
    // the travel mode of the work that made it start.
    if (warm) {
      stream.ready = false
      const preparation = modePreparation(request)
      void (async () => {
        await this.#submit(city.layout, { kind: 'info' }, null, { internal: true, pinned: stream })
        if (preparation) await this.#submit(city.layout, preparation, null, { internal: true, pinned: stream })
        stream.ready = true
        this.#dispatch(city)
      })().catch(error => stream.stop(error))
    }
    return stream
  }

  // Order: point routes and preparation first, then analyses, oldest first; an
  // analysis passed over too often goes next.
  #ordered(city) {
    const rank = job => job.analysis && job.bypasses < maximumAnalysisBypasses ? 1 : 0
    return [...city.queue].sort((left, right) => rank(left) - rank(right) || left.seq - right.seq)
  }

  // The idle process `job` should run on now, or null to keep waiting.
  #target(city, job, idle) {
    if (job.pinned) return idle.includes(job.pinned) ? job.pinned : null
    const ready = idle.filter(stream => stream.ready)
    if (!ready.length || !job.mode) return ready[0] ?? null
    const loaded = ready.find(stream => stream.routeModes.has(job.mode))
    if (loaded) return loaded
    // A process ready for one mode may still be cold for another. Wait a
    // little for one that has the mode loaded, then pay the load instead.
    const warmElsewhere = city.processes.some(stream => !stream.closed && stream.routeModes.has(job.mode))
    if (!warmElsewhere || performance.now() - job.queuedAt >= this.limits.affinityWaitMs) return ready[0]
    return null
  }

  #dispatch(city) {
    if (this.cities.get(city.layout.key) !== city) return
    for (const job of [...city.queue]) {
      if (!job.done && !this.#current(job)) {
        this.counters.staleGeneration += 1
        this.#finish(job, beingUpdated())
      }
    }
    if (!city.processes.length && city.queue.length && this.#mayStart(city)) this.#start(city, false)
    let affinityWait = Infinity
    for (let progressed = true; progressed;) {
      progressed = false
      const idle = city.processes.filter(stream => !stream.closed && !stream.busy)
      if (!idle.length) break
      for (const job of this.#ordered(city)) {
        if (job.done) continue
        const stream = this.#target(city, job, idle)
        if (!stream) {
          if (!job.pinned && job.mode) affinityWait = Math.min(affinityWait, this.limits.affinityWaitMs - (performance.now() - job.queuedAt))
          continue
        }
        city.queue.splice(city.queue.indexOf(job), 1)
        for (const passed of city.queue) if (passed.analysis && passed.seq < job.seq && !job.analysis) passed.bypasses += 1
        stream.send(job)
        progressed = true
        break
      }
    }
    // Grow from the backlog: a request waiting behind busy processes starts
    // another one (up to the limit), loaded for that request's mode.
    const waiting = city.queue.find(job => !job.done && !job.pinned && !job.internal && !job.preparing)
    if (waiting && city.processes.length < this.maxProcesses
      && city.processes.every(stream => stream.ready && stream.answered && !stream.closed)
      && this.#mayStart(city)) {
      this.#start(city, true, waiting.request)
    }
    clearTimeout(city.affinityTimer)
    city.affinityTimer = null
    if (Number.isFinite(affinityWait)) {
      city.affinityTimer = setTimeout(() => {
        city.affinityTimer = null
        this.#dispatch(city)
      }, Math.max(1, Math.ceil(affinityWait)))
      city.affinityTimer.unref?.()
    }
    this.scheduleIdle()
  }

  #rewarm(layout) {
    const routes = this.warmRoutes.get(layout.key)
    const now = Date.now()
    if (!routes?.size || !this.leases.has(layout.key) || now - (this.lastRewarm.get(layout.key) ?? 0) < rewarmSpacingMs) return
    this.lastRewarm.set(layout.key, now)
    const epoch = this.epoch
    void (async () => {
      for (const request of routes.values()) {
        if (!this.leases.has(layout.key) || epoch !== this.epoch) return
        await this.#submit(layout, request, null, { internal: true })
      }
    })().catch(() => {})
  }

  /** Keep `layout` resident while any lease holds it, as the open Route tool does. */
  setResidency(layout, resident, leaseId = 'default') {
    if (resident) this.admit()
    const leases = this.leases.get(layout.key) ?? new Set()
    if (resident) leases.add(leaseId)
    else leases.delete(leaseId)
    if (leases.size) this.leases.set(layout.key, leases)
    else {
      this.leases.delete(layout.key)
      this.warmRoutes.delete(layout.key)
    }
    return { resident: leases.size > 0, leases: leases.size, open: this.cities.has(layout.key) }
  }

  evict() {
    if (this.cities.size < this.maxCities) return
    const idle = [...this.cities.values()].filter(city => !city.pending)
      .sort((left, right) => Number(this.leases.has(left.layout.key)) - Number(this.leases.has(right.layout.key))
        || left.lastUsed - right.lastUsed)
    const city = idle[0]
    if (!city) return
    this.cities.delete(city.layout.key)
    void city.stop()
  }

  // Keep the most fully prepared process for a leased City. A recently
  // added bike-only worker must not replace startup's all-mode preparation.
  scheduleIdle() {
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      const now = Date.now()
      for (const city of [...this.cities.values()]) {
        const keep = this.leases.has(city.layout.key)
          ? city.processes.reduce((best, stream) => (!best
            || stream.routeModes.size > best.routeModes.size
            || stream.routeModes.size === best.routeModes.size && stream.lastUsed > best.lastUsed ? stream : best), null)
          : null
        for (const stream of [...city.processes]) {
          if (stream !== keep && !stream.busy && !city.queue.length && now - stream.lastUsed >= this.idleMs) stream.stop()
        }
      }
      if (this.cities.size) this.scheduleIdle()
    }, Math.min(this.idleMs, 30_000))
    this.idleTimer.unref?.()
  }

  snapshot() {
    return {
      available: this.available,
      executable: this.executable ? path.basename(this.executable) : null,
      processesPerCity: this.maxProcesses,
      epoch: this.epoch,
      admission: {
        pending: this.pendingCount,
        pendingBytes: this.pendingBytes,
        maxPending: this.limits.maxPending,
        maxPendingBytes: this.limits.maxPendingBytes,
        cityMaxPending: this.limits.cityMaxPending,
        cityMaxPendingBytes: this.limits.cityMaxPendingBytes,
      },
      responses: { bufferedBytes: this.responseBytes, budgetBytes: this.limits.responseBudgetBytes },
      counters: { ...this.counters },
      residentCities: [...this.cities.values()].map(city => ({
        root: city.layout.root,
        routingStore: city.layout.routingStore ? path.basename(city.layout.routingStore) : null,
        processes: city.processes.length,
        readyProcesses: city.processes.filter(stream => stream.ready && !stream.closed).length,
        pending: city.pending,
        queued: city.queue.length,
        generation: this.#generation(city.root),
        resident: this.leases.has(city.layout.key),
      })),
    }
  }

  /**
   * Release the Cities that read `file` before it is replaced or removed, and
   * settle once their processes have exited. A file or directory inside a
   * nested City (Studio's wheelchair City under its parent) belongs to that
   * City alone; a directory also releases every City beneath it. The affected
   * Cities start a new generation at once: no new work is admitted until the
   * processes have exited, waiting work is refused, and nothing admitted
   * before is retried or answered. The result rejects if a process outlives
   * the retirement deadline, so files are never replaced under it.
   */
  retire(file) {
    const target = ownerKey(file)
    const cities = [...this.cities.values()]
    const known = cities.map(city => city.root)
    const owner = owningCity(target, known)
    const affected = cities.filter(city => city.root === owner || within(city.root, target))
    return this.#retireCities(affected, [owner, ...affected.map(city => city.root)].filter(Boolean), { transparent: true })
  }

  /**
   * Retire the City at `root` (and any City beneath it) for a caller that
   * knows which City it replaces, as `retire` does for a file. Nothing is
   * inferred from the path: a parent City is never touched, even when the
   * City at `root` has not been published yet.
   */
  retireCity(root) {
    const target = ownerKey(root)
    const affected = [...this.cities.values()].filter(city => within(city.root, target))
    return this.#retireCities(affected, [target, ...affected.map(city => city.root)], { transparent: true })
  }

  /**
   * Stop every City and refuse everything admitted so far; settles once every
   * process has exited. The runtime stays usable, as after switching library.
   */
  reset() {
    this.epoch += 1
    const cities = [...this.cities.values()]
    this.leases.clear()
    this.warmRoutes.clear()
    this.lastRewarm.clear()
    // Requests held for a refresh belong to the epoch that just ended.
    for (const [root, held] of [...this.held]) {
      this.held.delete(root)
      for (const job of held) this.#finish(job, beingUpdated())
    }
    return this.#retireCities(cities, cities.map(city => city.root))
  }

  /** The same barrier as reset, kept for callers that close at exit. */
  closeAll() {
    return this.reset()
  }

  /** Stop for good: every later request is refused. */
  shutdown() {
    this.shut = true
    return this.reset()
  }

  async #retireCities(cities, roots, { transparent = false } = {}) {
    const marker = { transparent }
    for (const root of new Set(roots)) {
      this.retiring.set(root, marker)
      this.generations.set(root, this.#generation(root) + 1)
    }
    for (const city of cities) {
      if (this.cities.get(city.layout.key) === city) this.cities.delete(city.layout.key)
      for (const job of [...city.queue]) {
        if (transparent && !job.internal) this.#hold(job)
        else this.#finish(job, beingUpdated())
      }
      if (transparent) for (const stream of city.processes) if (stream.current) stream.current.interrupted = true
    }
    let timer
    try {
      const exited = Promise.all(cities.map(city => city.stop()))
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new NativeCityUnavailableError(
          `VIGO runtime processes did not exit within ${retireTimeoutMs} ms; their City files were not replaced.`,
        )), retireTimeoutMs)
      })
      await Promise.race([exited, deadline])
    } finally {
      clearTimeout(timer)
      // A later retirement of the same root releases what both held.
      for (const root of new Set(roots)) {
        if (this.retiring.get(root) !== marker) continue
        this.retiring.delete(root)
        this.#release(root)
      }
    }
  }
}
