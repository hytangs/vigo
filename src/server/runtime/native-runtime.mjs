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
// A City that keeps stopping must not spend its time reloading.
const rewarmSpacingMs = 30_000
const maxResponseBytes = 256 * 1024 * 1024
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
  constructor({ executable, layout, spawnProcess, onExit, responseLimitBytes }) {
    this.layout = layout
    this.pending = []
    this.lastUsed = Date.now()
    this.closed = false
    this.stopping = false
    this.answered = false
    this.routeModes = new Set()
    this.stderr = ''
    this.chunks = []
    this.bufferedBytes = 0
    this.responseLimitBytes = responseLimitBytes
    this.onExit = onExit
    const args = ['stream', '--stream-output=detailed', `--city=${layout.root}`]
    if (layout.routingStore) args.push(`--routing-store=${path.basename(layout.routingStore)}`)
    this.child = spawnProcess(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: streamEnvironment(process.env) })
    // A closed parent closes stdin, and the stream exits on end of input.
    this.child.unref?.()
    this.child.stdout.on('data', chunk => this.receive(chunk))
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8_000) })
    this.child.stdin.on('error', () => {})
    this.child.on('error', error => this.fail(new NativeCityUnavailableError(`VIGO could not start its runtime: ${error.message}`)))
    // exit can precede the last stderr chunk. Wait for closed streams so a
    // repairable missing/stale City is not reduced to an opaque exit code.
    this.child.on('close', (code, signal) => {
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
      this.bufferedBytes = 0
      if (line.length) this.settle(line)
      if (this.closed) return
      start = newline + 1
      newline = chunk.indexOf(10, start)
    }
    if (start < chunk.length) {
      this.bufferedBytes += chunk.length - start
      if (this.bufferedBytes > this.responseLimitBytes) {
        this.stop(new NativeCityUnavailableError('The VIGO runtime response exceeds its byte limit.'))
        return
      }
      this.chunks.push(chunk.subarray(start))
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
    this.writeNext()
    if (entry.discarded) return
    if (response?.status === 'error') {
      const message = String(response.error?.message ?? 'The VIGO runtime rejected the request.')
      entry.reject(new NativeQueryError(message, String(response.error?.code ?? 'invalid_request')))
    } else if (!response?.trace || typeof response.trace !== 'object') {
      entry.reject(new NativeCityUnavailableError('The VIGO runtime returned no detailed Result.'))
    } else {
      const trace = response.trace
      if (trace.journeyIndices !== undefined) {
        const table = trace.journeyTable
        if (!Array.isArray(table) || !Array.isArray(trace.journeyIndices)
          || trace.journeyIndices.length !== trace.originCount) {
          entry.reject(new Error('Invalid native indexed Matrix journeys'))
          return
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
        } catch (error) {
          entry.reject(error)
          return
        }
      }
      entry.resolve(trace)
    }
  }

  query(request, signal) {
    if (this.closed) return Promise.reject(new NativeCityUnavailableError('The VIGO runtime is not running.'))
    if (signal?.aborted) return Promise.reject(makeAbortError())
    this.lastUsed = Date.now()
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, discarded: false, started: performance.now(), preparing: preparationRequest(request),
        line: `${JSON.stringify(request)}\n`, sent: false }
      // Answers arrive in request order, so only the oldest query is written.
      // A cancelled caller returns at once: a query still waiting here never
      // reaches the engine, and one still running after the grace period
      // stops the process.
      let grace = null
      const abort = () => {
        entry.discarded = true
        reject(makeAbortError())
        if (!entry.sent) {
          const index = this.pending.indexOf(entry)
          if (index >= 0) this.pending.splice(index, 1)
          entry.cleanup()
        } else if (this.pending[0] === entry) {
          grace = setTimeout(() => {
            this.replaceWhenStopped = true
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
      this.writeNext()
    })
  }

  writeNext() {
    const next = this.pending[0]
    if (!next || next.sent) return
    next.sent = true
    this.child.stdin.write(next.line)
    next.line = ''
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
    this.chunks = []
    this.bufferedBytes = 0
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
    responseLimitBytes = maxResponseBytes,
  } = {}) {
    this.executable = executable
    this.warmRoutes = new Map()
    this.lastRewarm = new Map()
    this.maxCities = maxCities
    this.maxProcesses = maxProcesses
    this.idleMs = idleMs
    this.spawnProcess = spawnProcess
    this.responseLimitBytes = responseLimitBytes
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
        const stream = this.#stream(layout, request)
        const result = await stream.query(request, signal)
        const mode = routeMode(request)
        if (mode) {
          stream.routeModes.add(mode)
          // A replacement process loads the mode without replaying a journey.
          if (this.leases.has(layout.key) && !request.scenario && !request.realtimeSnapshot) {
            const known = this.warmRoutes.get(layout.key) ?? new Map()
            known.set(mode, modePreparation({ ...request, serviceDate: result.serviceDate ?? request.serviceDate }))
            this.warmRoutes.set(layout.key, known)
          }
        }
        return result
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
      if (this.cities.size >= this.maxCities) {
        throw new NativeQueryError('All resident City slots are busy. Retry when a query completes.', 'capacity_exceeded', 503)
      }
      city = new CityProcesses(layout)
      this.cities.set(layout.key, city)
    }
    if (city && !city.processes.length) this.#start(city, false)
    this.scheduleIdle()
    return city
  }

  #start(city, warm, request) {
    const stream = new StreamProcess({
      executable: this.executable,
      layout: city.layout,
      spawnProcess: this.spawnProcess,
      responseLimitBytes: this.responseLimitBytes,
      onExit: exited => {
        city.processes = city.processes.filter(other => other !== exited)
        if (city.baseline === exited) city.baseline = null
        if (!city.processes.length && this.cities.get(city.layout.key) === city) this.cities.delete(city.layout.key)
        // A kept City that lost a working process prepares its replacement now,
        // so the next visitor does not pay to load each mode's network again.
        if ((exited.replaceWhenStopped || (!exited.stopping && exited.answered)) && !city.processes.length) this.#rewarm(city.layout)
      },
    })
    // An added stream takes requests once it has opened the City.
    stream.ready = !warm
    if (warm) {
      void (async () => {
        await stream.query({ kind: 'info' })
        // Keep this process out of dispatch until its lazy network is loaded.
        const mode = routeMode(request)
        if (mode) {
          await stream.query(modePreparation(request))
          stream.routeModes.add(mode)
        }
        stream.ready = true
      })().catch(error => stream.stop(error))
    }
    city.processes.push(stream)
    return stream
  }

  // The least busy ready stream; a new one opens while all are busy.
  #stream(layout, request) {
    const city = this.#city(layout, true)
    if (request?.surfaceReuse === 'scenario' && city.baseline && !city.baseline.closed) return city.baseline
    const ready = city.processes.filter(stream => stream.ready && !stream.closed)
    // A process ready for one mode may still be cold for another. Queue on
    // an already loaded network instead of charging a visitor its load time.
    const mode = routeMode(request)
    const loaded = mode ? ready.filter(stream => stream.routeModes.has(mode)) : []
    const candidates = loaded.length ? loaded : ready.length ? ready : city.processes
    const chosen = candidates.reduce((best, stream) => stream.pending.length < best.pending.length ? stream : best)
    if (!preparationRequest(request) && chosen.pending.some(entry => !entry.preparing)
      && city.processes.length < this.maxProcesses
      && city.processes.every(stream => stream.ready && stream.answered)) {
      this.#start(city, true, request)
    }
    if (request?.surfaceReuse === 'baseline') city.baseline = chosen
    return chosen
  }

  #rewarm(layout) {
    const routes = this.warmRoutes.get(layout.key)
    const now = Date.now()
    if (!routes?.size || !this.leases.has(layout.key) || now - (this.lastRewarm.get(layout.key) ?? 0) < rewarmSpacingMs) return
    this.lastRewarm.set(layout.key, now)
    void (async () => {
      for (const [mode, request] of routes) {
        if (!this.leases.has(layout.key)) return
        const stream = this.#stream(layout, request)
        await stream.query(request)
        stream.routeModes.add(mode)
      }
    })().catch(() => {})
  }

  /** Keep `layout` resident while any lease holds it, as the open Route tool does. */
  setResidency(layout, resident, leaseId = 'default') {
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
    idle[0]?.stop()
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
    // Windows paths compare case-insensitively; a missed City would keep the file open.
    const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    const resolved = key(file)
    const within = (inner, outer) => inner === outer || inner.startsWith(`${outer}${path.sep}`)
    const roots = [...this.cities.values()].map(city => key(city.layout.root))
    // A file inside a nested City, such as Studio's wheelchair City under its
    // parent, belongs to that City alone: retiring it must not close the City
    // around it while that City answers queries.
    const nested = root => {
      for (let directory = path.dirname(resolved); directory !== root && within(directory, root); directory = path.dirname(directory)) {
        if (roots.includes(directory) || fs.existsSync(path.join(directory, 'network.json'))) return true
      }
      return false
    }
    for (const city of [...this.cities.values()]) {
      const root = key(city.layout.root)
      if ((within(resolved, root) && !nested(root)) || within(root, resolved)) city.stop()
    }
  }

  closeAll() {
    for (const city of [...this.cities.values()]) city.stop()
    this.cities.clear()
    this.leases.clear()
    this.warmRoutes.clear()
  }
}
