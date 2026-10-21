import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundedInteger } from './resource-limits.mjs'

// Studio's queries run in the `vigo` executable, the same runtime as the CLI,
// HTTP server and Python. Each opened City (or Studio project store) is served
// by resident `vigo stream` processes that each answer requests in order; this
// module only transports them. Opening a City and activating a service date
// happen once per process, so processes stay resident until idle. A second
// process starts only while every ready one is busy, and a request whose
// process dies under it is answered by a fresh one.
const maxResidentCities = boundedInteger(process.env.VIGO_NATIVE_CITY_MAX, 2, 1, 8)
const processesPerCity = boundedInteger(process.env.VIGO_NATIVE_CITY_PROCESSES, 2, 1, 8)
const residentIdleMs = boundedInteger(process.env.VIGO_NATIVE_CITY_IDLE_MS, 300_000, 100, 3_600_000)
const queryTimeoutMs = boundedInteger(process.env.VIGO_NATIVE_QUERY_TIMEOUT_MS, 600_000, 1000, 3_600_000)
// A cancelled query normally finishes within milliseconds; its answer is then
// discarded. Long analyses are stopped instead of holding the City.
const cancelGraceMs = boundedInteger(process.env.VIGO_NATIVE_CANCEL_GRACE_MS, 1500, 0, 600_000)
const maxResponseBytes = 256 * 1024 * 1024
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const executableName = process.platform === 'win32' ? 'vigo.exe' : 'vigo'

export function makeAbortError(message = 'The request was cancelled.') {
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
  constructor(message, code, statusCode = 400) {
    super(message)
    this.code = code
    this.statusCode = statusCode
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

/** One resident `vigo stream` process of a City. */
class StreamProcess {
  constructor({ executable, layout, spawnProcess, onExit }) {
    this.layout = layout
    this.pending = []
    this.lastUsed = Date.now()
    this.closed = false
    this.stopping = false
    this.answered = false
    this.stderr = ''
    this.chunks = []
    this.bufferedBytes = 0
    this.onExit = onExit
    const args = ['stream', '--stream-output=detailed', `--city=${layout.root}`]
    if (layout.routingStore) args.push(`--routing-store=${path.basename(layout.routingStore)}`)
    this.child = spawnProcess(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    // A closed parent closes stdin, and the stream exits on end of input.
    this.child.unref?.()
    this.child.stdout.on('data', chunk => this.receive(chunk))
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8_000) })
    this.child.stdin.on('error', () => {})
    this.child.on('error', error => this.fail(new NativeCityUnavailableError(`VIGO could not start its runtime: ${error.message}`)))
    this.child.on('exit', (code, signal) => {
      const detail = this.lastError() || `exit ${code ?? signal}`
      // A process that opened its City, or was killed, can be replaced; one
      // that could not open it reports why.
      this.fail(this.answered || signal
        ? new NativeCityUnavailableError(`The VIGO runtime stopped: ${detail}`, { retryable: !this.stopping })
        : new NativeCityUnavailableError(detail, { preparation: preparationFailure.test(detail) }))
    })
  }

  lastError() {
    const line = this.stderr.trim().split('\n').at(-1) ?? ''
    try {
      return String(JSON.parse(line)?.error?.message ?? line)
    } catch {
      return line
    }
  }

  receive(chunk) {
    let start = 0
    let newline = chunk.indexOf(10)
    while (newline >= 0) {
      this.chunks.push(chunk.subarray(start, newline))
      const line = Buffer.concat(this.chunks)
      this.chunks = []
      this.bufferedBytes = 0
      if (line.length) this.settle(line)
      start = newline + 1
      newline = chunk.indexOf(10, start)
    }
    if (start < chunk.length) {
      this.chunks.push(chunk.subarray(start))
      this.bufferedBytes += chunk.length - start
      if (this.bufferedBytes > maxResponseBytes) this.stop(new NativeCityUnavailableError('The VIGO runtime response exceeds 256 MiB.'))
    }
  }

  settle(line) {
    let response
    try {
      response = JSON.parse(line.toString('utf8'))
    } catch {
      this.stop(new NativeCityUnavailableError('The VIGO runtime returned malformed output.'))
      return
    }
    this.answered = true
    const entry = this.pending.shift()
    if (!entry) return
    entry.cleanup()
    this.lastUsed = Date.now()
    if (entry.discarded) return
    if (response?.status === 'error') {
      const message = String(response.error?.message ?? 'The VIGO runtime rejected the request.')
      entry.reject(new NativeQueryError(message, String(response.error?.code ?? 'invalid_request')))
    } else if (!response?.trace || typeof response.trace !== 'object') {
      entry.reject(new NativeCityUnavailableError('The VIGO runtime returned no detailed Result.'))
    } else {
      entry.resolve(response.trace)
    }
  }

  query(request, signal) {
    if (this.closed) return Promise.reject(new NativeCityUnavailableError('The VIGO runtime is not running.'))
    if (signal?.aborted) return Promise.reject(makeAbortError())
    this.lastUsed = Date.now()
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, discarded: false, started: performance.now() }
      // Answers arrive in request order. A cancelled caller returns at once;
      // a query still running after the grace period stops the process.
      let grace = null
      const abort = () => {
        entry.discarded = true
        reject(makeAbortError())
        if (this.pending[0] === entry) {
          grace = setTimeout(() => {
            if (this.pending.includes(entry)) this.stop(new NativeCityUnavailableError('A cancelled query was stopped.'), entry)
          }, cancelGraceMs)
          grace.unref?.()
        }
      }
      const timeout = setTimeout(() => {
        this.stop(new NativeCityUnavailableError(`The VIGO runtime exceeded ${Math.ceil(queryTimeoutMs / 1000)} seconds.`), entry)
      }, queryTimeoutMs)
      timeout.unref?.()
      entry.cleanup = () => {
        clearTimeout(timeout)
        if (grace) clearTimeout(grace)
        signal?.removeEventListener('abort', abort)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.push(entry)
      this.child.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  /** Reject every waiting request; those queued behind `culprit` can be retried. */
  fail(error, culprit = null) {
    if (this.closed && !this.pending.length) return
    this.closed = true
    for (const entry of this.pending) {
      entry.cleanup()
      if (entry.discarded) continue
      entry.reject(culprit && entry !== culprit
        ? new NativeCityUnavailableError(error.message, { retryable: true })
        : error)
    }
    this.pending = []
    this.onExit?.(this, error)
  }

  stop(error = new NativeCityUnavailableError('The VIGO runtime was closed.'), culprit = null) {
    this.stopping = true
    // Settle waiting requests before the exit event can.
    this.fail(error, culprit)
    if (!this.child.killed && this.child.exitCode === null) {
      this.child.stdin.end()
      this.child.kill('SIGKILL')
    }
  }
}

/** The processes serving one City layout. */
class CityProcesses {
  constructor(layout) {
    this.layout = layout
    this.processes = []
    // A Reach comparison's scenario grows from its baseline's stream.
    this.baseline = null
  }

  get pending() {
    return this.processes.reduce((total, stream) => total + stream.pending.length, 0)
  }

  get lastUsed() {
    return Math.max(0, ...this.processes.map(stream => stream.lastUsed))
  }

  stop(error) {
    for (const stream of [...this.processes]) stream.stop(error)
  }
}

export class NativeRuntime {
  constructor({
    executable = nativeExecutable(),
    maxCities = maxResidentCities,
    maxProcesses = processesPerCity,
    idleMs = residentIdleMs,
    spawnProcess = spawn,
  } = {}) {
    this.executable = executable
    this.maxCities = maxCities
    this.maxProcesses = maxProcesses
    this.idleMs = idleMs
    this.spawnProcess = spawnProcess
    this.cities = new Map()
    this.leases = new Map()
    this.idleTimer = null
  }

  get available() {
    return Boolean(this.executable)
  }

  /**
   * Answer one public request (`kind` route, matrix, reach, …) on `layout`.
   * A request left behind by a stream that stopped for another reason is
   * sent once more, to a fresh stream.
   */
  async query(layout, request, signal) {
    if (!this.executable) {
      throw new NativeCityUnavailableError('The VIGO executable is missing. Run npm run build:standalone.')
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#stream(layout, request).query(request, signal)
      } catch (error) {
        if (attempt || !error?.retryable || signal?.aborted) throw error
      }
    }
  }

  /** Open `layout` ahead of its first query; a failure reappears on that query. */
  open(layout) {
    if (this.executable) this.#city(layout, true)
  }

  #city(layout, create) {
    let city = this.cities.get(layout.key)
    if (!city && create) {
      this.evict()
      city = new CityProcesses(layout)
      this.cities.set(layout.key, city)
    }
    if (city && !city.processes.length) this.#start(city, false)
    this.scheduleIdle()
    return city
  }

  #start(city, warm) {
    const stream = new StreamProcess({
      executable: this.executable,
      layout: city.layout,
      spawnProcess: this.spawnProcess,
      onExit: exited => {
        city.processes = city.processes.filter(other => other !== exited)
        if (city.baseline === exited) city.baseline = null
        if (!city.processes.length && this.cities.get(city.layout.key) === city) this.cities.delete(city.layout.key)
      },
    })
    // An added stream takes requests once it has opened the City.
    stream.ready = !warm
    if (warm) {
      stream.query({ kind: 'info' }).then(() => { stream.ready = true }, () => {})
    }
    city.processes.push(stream)
    return stream
  }

  // The least busy ready stream; a new one opens while all are busy.
  #stream(layout, request) {
    const city = this.#city(layout, true)
    if (request?.surfaceReuse === 'scenario' && city.baseline && !city.baseline.closed) return city.baseline
    const ready = city.processes.filter(stream => stream.ready && !stream.closed)
    const candidates = ready.length ? ready : city.processes
    const chosen = candidates.reduce((best, stream) => stream.pending.length < best.pending.length ? stream : best)
    if (chosen.pending.length && city.processes.length < this.maxProcesses
      && city.processes.every(stream => stream.ready)) {
      this.#start(city, true)
    }
    if (request?.surfaceReuse === 'baseline') city.baseline = chosen
    return chosen
  }

  /** Keep `layout` resident while any lease holds it, as the open Route tool does. */
  setResidency(layout, resident, leaseId = 'default') {
    const leases = this.leases.get(layout.key) ?? new Set()
    if (resident) leases.add(leaseId)
    else leases.delete(leaseId)
    if (leases.size) this.leases.set(layout.key, leases)
    else this.leases.delete(layout.key)
    return { resident: leases.size > 0, leases: leases.size, open: this.cities.has(layout.key) }
  }

  evict() {
    if (this.cities.size < this.maxCities) return
    const idle = [...this.cities.values()].filter(city => !city.pending)
      .sort((left, right) => Number(this.leases.has(left.layout.key)) - Number(this.leases.has(right.layout.key))
        || left.lastUsed - right.lastUsed)
    idle[0]?.stop()
  }

  // Idle processes stop; a leased City keeps its most recently used one.
  scheduleIdle() {
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      const now = Date.now()
      for (const city of [...this.cities.values()]) {
        const keep = this.leases.has(city.layout.key)
          ? city.processes.reduce((latest, stream) => (!latest || stream.lastUsed > latest.lastUsed ? stream : latest), null)
          : null
        for (const stream of [...city.processes]) {
          if (stream !== keep && !stream.pending.length && now - stream.lastUsed >= this.idleMs) stream.stop()
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
      residentCities: [...this.cities.values()].map(city => ({
        root: city.layout.root,
        routingStore: city.layout.routingStore ? path.basename(city.layout.routingStore) : null,
        processes: city.processes.length,
        pending: city.pending,
        resident: this.leases.has(city.layout.key),
      })),
    }
  }

  /** Release every City that contains or lies under `file` before it is replaced or removed. */
  retire(file) {
    const resolved = path.resolve(file)
    const within = (inner, outer) => inner === outer || inner.startsWith(`${outer}${path.sep}`)
    for (const city of [...this.cities.values()]) {
      if (within(resolved, city.layout.root) || within(city.layout.root, resolved)) city.stop()
    }
  }

  closeAll() {
    for (const city of [...this.cities.values()]) city.stop()
    this.cities.clear()
    this.leases.clear()
  }
}
