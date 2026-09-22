import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { resolveServiceDay } from '../service-day.mjs'

const nationalRouteWorkerIdleMs = Math.max(100, Number(process.env.VIGO_ROUTE_WORKER_IDLE_MS) || 120_000)

// Selecting a routing workspace is an explicit signal of near-term use. Keep
// its prepared context for the same lease as an interactive query so a person
// can choose A/B without paying the national cold start a second time.
const nationalRoutePrewarmIdleMs = Math.max(
  100,
  Number(process.env.VIGO_ROUTE_PREWARM_IDLE_MS) || nationalRouteWorkerIdleMs,
)

const nationalRoutePressureIdleMs = Math.max(100, Number(process.env.VIGO_ROUTE_PRESSURE_IDLE_MS) || 15_000)

// A superseded interactive request normally finishes far sooner than a worker
// restart. Preserve the prepared kernel and discard that obsolete result unless
// the synchronous worker operation exceeds this bounded cancellation grace.
const nationalRouteCancellationGraceMs = Math.max(
  25,
  Math.min(1_000, Number(process.env.VIGO_ROUTE_CANCEL_GRACE_MS) || 150),
)

const reachCancellationGraceMs = Math.max(
  1_000,
  Math.min(60_000, Number(process.env.VIGO_REACH_CANCEL_GRACE_MS) || 30_000),
)

const nationalRoutePrewarmWaitTimeoutMs = Math.max(
  1_000,
  Number(process.env.VIGO_ROUTE_PREWARM_WAIT_TIMEOUT_MS) || 180_000,
)

const nationalRoutePrewarmHardTimeoutMs = Math.max(
  60_000,
  Number(process.env.VIGO_ROUTE_PREWARM_HARD_TIMEOUT_MS) || 300_000,
)

export const maxNationalRouteWorkerStores = Math.max(1, Math.min(2, Number(process.env.VIGO_ROUTE_WORKER_MAX_STORES) || 2))

const defaultNationalRouteRssBudgetBytes = Math.max(
  512 * 1024 * 1024,
  Math.min(Math.floor(os.totalmem() * 0.125), 2 * 1024 * 1024 * 1024),
)

const nationalRouteRssBudgetBytes = Math.max(
  256 * 1024 * 1024,
  Number(process.env.VIGO_ROUTE_WORKER_RSS_BUDGET_BYTES) || defaultNationalRouteRssBudgetBytes,
)

export function makeAbortError(message = 'The route request was cancelled.') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function makeWorkerRestartedError() {
  const error = new Error('The routing worker restarted before this request could run.')
  error.code = 'VIGO_ROUTE_WORKER_RESTARTED'
  return error
}

function makePrewarmWaitTimeoutError(timeoutMs) {
  const error = new Error(
    `Routing preparation is still running in the background after ${Math.ceil(timeoutMs / 1_000)} seconds. Retry shortly; the shared cold build was not cancelled.`,
  )
  error.code = 'VIGO_PREWARM_WAIT_TIMEOUT'
  error.statusCode = 504
  return error
}

function makePrewarmHardTimeoutError(timeoutMs) {
  const error = new Error(`Routing preparation exceeded the ${Math.ceil(timeoutMs / 1_000)} second cold-build safety limit.`)
  error.code = 'VIGO_PREWARM_HARD_TIMEOUT'
  error.statusCode = 504
  return error
}

function waitForPromiseWithSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(makeAbortError())
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(makeAbortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function waitForPromiseWithTimeoutAndSignal(promise, timeoutMs, signal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return waitForPromiseWithSignal(promise, signal)
  if (signal?.aborted) return Promise.reject(makeAbortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => settle(reject, makeAbortError())
    const timeout = setTimeout(() => settle(reject, makePrewarmWaitTimeoutError(timeoutMs)), timeoutMs)
    timeout.unref?.()
    signal?.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    )
  })
}

function nationalRoutingPrewarmContext(context = {}) {
  const serviceDate = String(context.serviceDate ?? '').slice(0, 10)
  const streetStorePath = String(context.streetStorePath ?? '').trim()
  const readinessOnly = context.readinessOnly === true
  if (readinessOnly) {
    return {
      key: 'routing-store|timetable-admitted',
      request: { readinessOnly: true },
    }
  }
  const streetContextKey = streetStorePath
    ? path.resolve(streetStorePath)
    : 'none'
  if (!serviceDate) {
    return {
      key: `open|complete|street:${streetContextKey}`,
      request: {
        ...(streetStorePath ? { streetStorePath: path.resolve(streetStorePath) } : {}),
      },
    }
  }
  const serviceDay = resolveServiceDay(serviceDate, context.serviceDay)
  const allowServiceDateFallback = context.allowServiceDateFallback === true
  const requireCompleteServiceCoverage = context.requireCompleteServiceCoverage === true
  return {
    key: `${serviceDate}|${serviceDay}|${allowServiceDateFallback ? 'fallback' : 'exact'}|${requireCompleteServiceCoverage ? 'complete' : 'partial'}|complete|street:${streetContextKey}`,
    request: {
      serviceDate,
      serviceDay,
      allowServiceDateFallback,
      requireCompleteServiceCoverage,
      ...(streetStorePath ? { streetStorePath: path.resolve(streetStorePath) } : {}),
    },
  }
}

function nationalRouteWorkerUrl(defaultUrl) {
  const override = String(process.env.VIGO_ROUTE_WORKER_URL ?? '').trim()
  if (!override) return defaultUrl
  try {
    return new URL(override)
  } catch {
    return pathToFileURL(path.resolve(override))
  }
}

class NationalRouteWorkerClient {
  constructor(storePath, { onIdle, onExpire, isMemoryPressure, workerUrl }) {
    this.workerUrl = workerUrl
    this.storePath = storePath
    this.onIdle = onIdle
    this.onExpire = onExpire
    this.isMemoryPressure = isMemoryPressure
    this.worker = null
    this.workerInstance = ''
    this.metrics = {}
    this.generation = 0
    this.sequence = 0
    this.queue = []
    this.active = null
    this.restarting = false
    this.closed = false
    this.idleTimer = null
    this.createdAt = Date.now()
    this.workerStartedAt = 0
    this.storeOpenedAt = 0
    this.preparedAt = 0
    this.prepareResult = null
    this.preparedContextKey = ''
    this.streetPrepareResult = null
    this.streetPrepareStorePath = ''
    this.transferPrepareResult = null
    this.transferPrepareStorePath = ''
    this.routingAccessPrepareResult = null
    this.routingAccessPreparedContextKey = ''
    this.lastRouteContext = null
    this.coldStartMs = 0
    this.completedJobs = 0
    this.failedJobs = 0
    this.abandonedJobs = 0
    this.forcedCancellationRestarts = 0
    this.lastOperation = ''
    this.lastOperationMs = 0
    this.hasInteractiveUse = false
    this.residencyLeases = 0
    this.lastUsedAt = Date.now()
  }

  get isIdle() {
    return !this.closed && !this.restarting && !this.active && this.queue.length === 0
  }

  get hasWorker() {
    return Boolean(this.worker)
  }

  get prepared() {
    return Boolean(this.worker && this.preparedAt && this.prepareResult?.ready)
  }

  preparedResultFor(contextKey) {
    if (!this.prepared || this.preparedContextKey !== contextKey) return null
    return { ...this.prepareResult, alreadyWarm: true }
  }

  admissionPrepared(operation, streetStorePath) {
    const normalizedStreetStorePath = String(streetStorePath ?? '').trim()
    if (!normalizedStreetStorePath) return false
    const storePath = path.resolve(normalizedStreetStorePath)
    if (operation === 'prepare-transfers') {
      return Boolean(this.transferPrepareResult?.ready && this.transferPrepareStorePath === storePath)
    }
    if (operation === 'prepare-street') {
      return Boolean(this.streetPrepareResult?.ready && this.streetPrepareStorePath === storePath)
    }
    return false
  }

  routingAccessResultFor(contextKey) {
    if (
      !this.worker
      || !this.routingAccessPrepareResult?.ready
      || this.routingAccessPreparedContextKey !== contextKey
    ) return null
    return { ...this.routingAccessPrepareResult, alreadyWarm: true }
  }

  enqueue(operation, request, signal, onProgress) {
    if (this.closed) return Promise.reject(new Error('The route worker is no longer available.'))
    if (signal?.aborted) return Promise.reject(makeAbortError())
    this.#clearIdleTimer()
    return new Promise((resolve, reject) => {
      const job = {
        id: `${process.pid}-${++this.sequence}`,
        operation,
        request,
        signal,
        onProgress,
        resolve,
        reject,
        abort: null,
        cancelTimer: null,
        cancelled: false,
        cancellation: ['reach', 'street-surface', 'street-matrix', 'street-route-batch'].includes(operation)
          ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
          : null,
      }
      if (signal) {
        job.abort = () => this.#cancel(job)
        signal.addEventListener('abort', job.abort, { once: true })
      }
      this.queue.push(job)
      this.lastUsedAt = Date.now()
      this.#pump()
    })
  }

  diagnostics() {
    const osmStopTransfers = this.transferPrepareResult?.osmStopTransfers
      ?? this.prepareResult?.osmStopTransfers
    const state = this.restarting
      ? 'restarting'
      : this.active
        ? this.storeOpenedAt ? 'busy' : 'warming'
        : this.prepared
          ? 'ready'
          : this.storeOpenedAt
            ? 'open'
            : this.worker
              ? 'starting'
              : 'cold'
    const normalLeaseTimeoutMs = this.hasInteractiveUse ? nationalRouteWorkerIdleMs : nationalRoutePrewarmIdleMs
    return {
      storeKey: this.storePath,
      storeFile: path.basename(this.storePath),
      state,
      prepared: this.prepared,
      preparedContext: this.preparedContextKey || undefined,
      streetStore: this.streetPrepareResult?.streetStore
        ?? this.routingAccessPrepareResult?.streetStore
        ?? this.transferPrepareResult?.streetStore
        ?? this.prepareResult?.streetStore,
      transferAdmission: osmStopTransfers
        ? {
            ready: true,
            osmStopTransfers,
          }
        : undefined,
      routingAccessPrepared: this.routingAccessPrepareResult?.ready === true,
      routingAccessContext: this.routingAccessPreparedContextKey || undefined,
      lastRouteContext: this.lastRouteContext ?? undefined,
      active: Boolean(this.active),
      activeOperation: this.active?.operation,
      queued: this.queue.length,
      restarting: this.restarting,
      generation: this.generation,
      workerInstance: this.workerInstance || undefined,
      heapUsedBytes: Number(this.metrics.heapUsedBytes),
      externalBytes: Number(this.metrics.externalBytes),
      arrayBufferBytes: Number(this.metrics.arrayBufferBytes),
      isolateResidentEstimateBytes: Number(this.metrics.isolateResidentEstimateBytes),
      processRssBytes: Number(this.metrics.processRssBytes),
      processRssScope: this.metrics.processRssScope,
      tripConnectionCache: this.metrics.tripConnectionCache,
      operationCounts: this.metrics.operationCounts,
      coldStartMs: this.coldStartMs || undefined,
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      abandonedJobs: this.abandonedJobs,
      forcedCancellationRestarts: this.forcedCancellationRestarts,
      cancellationGraceMs: nationalRouteCancellationGraceMs,
      reachCancellationGraceMs,
      lastOperation: this.lastOperation || undefined,
      lastOperationMs: this.lastOperation ? this.lastOperationMs : undefined,
      leaseKind: this.hasInteractiveUse ? 'interactive' : 'prewarm',
      residencyLeases: this.residencyLeases,
      leaseTimeoutMs: this.residencyLeases > 0
        ? null
        : this.isMemoryPressure()
          ? Math.min(normalLeaseTimeoutMs, nationalRoutePressureIdleMs)
          : normalLeaseTimeoutMs,
      workerAgeMs: this.workerStartedAt ? Math.max(0, Date.now() - this.workerStartedAt) : 0,
      idleForMs: this.isIdle ? Math.max(0, Date.now() - this.lastUsedAt) : 0,
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.#clearIdleTimer()
    const error = new Error('The route worker was retired.')
    if (this.active) {
      const job = this.active
      this.active = null
      this.#cleanupJob(job)
      job.reject(error)
    }
    for (const job of this.queue.splice(0)) {
      this.#cleanupJob(job)
      job.reject(error)
    }
    const worker = this.#detachWorker()
    if (worker) await worker.terminate().catch(() => {})
  }

  setResidencyLeases(count) {
    this.residencyLeases = Math.max(0, Math.floor(Number(count) || 0))
    if (this.residencyLeases) {
      this.#clearIdleTimer()
    } else if (this.isIdle) {
      this.#becameIdle()
    }
  }

  refreshIdleLease() {
    if (this.isIdle) this.#scheduleIdleTimer()
  }

  #ensureWorker() {
    if (this.worker) return this.worker
    if (this.closed) throw new Error('The route worker is closed.')
    const worker = new Worker(nationalRouteWorkerUrl(this.workerUrl))
    const generation = ++this.generation
    this.worker = worker
    this.workerStartedAt = Date.now()
    this.storeOpenedAt = 0
    this.preparedAt = 0
    this.prepareResult = null
    this.preparedContextKey = ''
    this.streetPrepareResult = null
    this.streetPrepareStorePath = ''
    this.transferPrepareResult = null
    this.transferPrepareStorePath = ''
    this.routingAccessPrepareResult = null
    this.routingAccessPreparedContextKey = ''
    this.lastRouteContext = null
    this.coldStartMs = 0
    this.workerInstance = ''
    this.metrics = {}
    this.hasInteractiveUse = false
    worker.on('message', (message) => this.#handleMessage(message, generation))
    worker.on('error', (error) => this.#handleWorkerFailure(error, generation))
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.#handleWorkerFailure(new Error(`National route worker exited with code ${code}.`), generation)
      }
    })
    return worker
  }

  #detachWorker() {
    const worker = this.worker
    if (!worker) return null
    this.worker = null
    this.generation += 1
    worker.removeAllListeners()
    return worker
  }

  #pump() {
    if (this.closed || this.restarting || this.active || !this.queue.length) return
    while (this.queue[0]?.signal?.aborted) {
      const aborted = this.queue.shift()
      this.#cleanupJob(aborted)
      aborted.reject(makeAbortError())
    }
    if (!this.queue.length) {
      this.#becameIdle()
      return
    }
    let worker
    try {
      worker = this.#ensureWorker()
    } catch (error) {
      const failed = this.queue.shift()
      this.#cleanupJob(failed)
      failed.reject(error)
      queueMicrotask(() => this.#pump())
      return
    }
    const job = this.queue.shift()
    this.active = job
    job.startedAt = Date.now()
    if (!['prepare', 'prepare-street', 'prepare-transfers', 'prepare-derived', 'prepare-routing-access'].includes(job.operation)) {
      this.hasInteractiveUse = true
    }
    worker.postMessage({
      id: job.id,
      operation: job.operation,
      storePath: this.storePath,
      request: job.request,
      ...(job.cancellation ? { cancelBuffer: job.cancellation.buffer } : {}),
    })
  }

  #handleMessage(message, generation) {
    if (generation !== this.generation || !this.active || message?.id !== this.active.id) return
    if (message?.type === 'progress') {
      if (!this.active.cancelled) this.active.onProgress?.(message.progress)
      return
    }
    const completedAt = Date.now()
    this.workerInstance = String(message.workerInstance ?? this.workerInstance)
    this.metrics = message.metrics ?? this.metrics
    const job = this.active
    this.active = null
    this.#cleanupJob(job)
    this.lastUsedAt = completedAt
    this.lastOperation = job.operation
    this.lastOperationMs = Math.max(0, completedAt - Number(job.startedAt || completedAt))
    if (message?.type === 'complete') {
      this.completedJobs += 1
      if (!this.storeOpenedAt) {
        this.storeOpenedAt = completedAt
        this.coldStartMs = Math.max(0, completedAt - this.workerStartedAt)
      }
      if (
        (job.operation === 'prepare' || job.operation === 'prepare-routing-access')
        && job.request?.streetStorePath
      ) {
        const streetStorePath = path.resolve(String(job.request.streetStorePath))
        if (message.result?.streetStore?.ready) {
          const retainedDrive = this.streetPrepareStorePath === streetStorePath
            ? this.streetPrepareResult?.streetStore?.drive : null
          // A transit-only request does not unload a previously prepared Drive
          // kernel. Keep that readiness when its response says Drive was deferred.
          this.streetPrepareResult = retainedDrive?.ready && retainedDrive.accelerated
            && !retainedDrive.deferred && message.result.streetStore.drive?.deferred
            ? { ...message.result, streetStore: { ...message.result.streetStore, drive: retainedDrive } }
            : message.result
          this.streetPrepareStorePath = streetStorePath
        }
        if (message.result?.osmStopTransfers?.ready) {
          this.transferPrepareResult = message.result
          this.transferPrepareStorePath = streetStorePath
        }
      }
      if (job.operation === 'prepare') {
        this.preparedAt = completedAt
        this.prepareResult = message.result
        this.preparedContextKey = String(job.request?.prewarmContextKey || 'open')
      }
      if (job.operation === 'prepare-transfers') {
        this.transferPrepareResult = message.result
        this.transferPrepareStorePath = job.request?.streetStorePath
          ? path.resolve(String(job.request.streetStorePath))
          : ''
      }
      if (job.operation === 'prepare-routing-access') {
        this.routingAccessPrepareResult = message.result
        this.routingAccessPreparedContextKey = String(job.request?.prewarmContextKey || 'open')
      }
      if (job.operation === 'prepare-street') {
        this.streetPrepareResult = message.result
        this.streetPrepareStorePath = job.request?.streetStorePath
          ? path.resolve(String(job.request.streetStorePath))
          : ''
      }
      if (job.operation === 'route' || job.operation === 'window') {
        const plan = job.operation === 'window' ? message.result?.plan : message.result
        const planDiagnostics = plan?.diagnostics ?? {}
        const activeServiceKernel = planDiagnostics.searchStats?.activeServiceKernel
        this.lastRouteContext = {
          operation: job.operation,
          requestedServiceDate: String(
            planDiagnostics.requestedServiceDate
              ?? job.request?.serviceDate
              ?? '',
          ) || undefined,
          resolvedServiceDate: String(
            planDiagnostics.resolvedServiceDate
              ?? job.request?.serviceDate
              ?? '',
          ) || undefined,
          serviceDay: String(planDiagnostics.serviceDay ?? job.request?.serviceDay ?? '')
            || undefined,
          allowServiceDateFallback: job.request?.allowServiceDateFallback === true,
          requireCompleteServiceCoverage:
            job.request?.requireCompleteServiceCoverage === true,
          status: plan?.status,
          algorithm: planDiagnostics.algorithm,
          optimality: planDiagnostics.optimality,
          activeServiceKernelReady: activeServiceKernel?.ready === true,
          activeServiceKey: activeServiceKernel?.serviceKey,
        }
      }
      if (!job.cancelled) job.resolve(message.result)
    } else {
      this.failedJobs += 1
      const error = new Error(message?.error ?? 'National route worker failed.')
      error.statusCode = message?.errorCode === 'VIGO_NATIVE_STREET_CCH_REQUIRED' ? 409 : 400
      if (message?.errorCode) error.code = message.errorCode
      if (message?.errorContext?.activeServiceKernel) {
        error.activeServiceKernel = message.errorContext.activeServiceKernel
      }
      if (!job.cancelled) job.reject(error)
    }
    this.#pump()
    if (this.isIdle) this.#becameIdle()
  }

  #handleWorkerFailure(error, generation) {
    if (generation !== this.generation || !this.worker) return
    const worker = this.#detachWorker()
    worker?.terminate().catch(() => {})
    if (this.active) {
      const job = this.active
      this.active = null
      this.#cleanupJob(job)
      job.reject(error)
    }
    for (const queued of this.queue.splice(0)) {
      this.#cleanupJob(queued)
      queued.reject(makeWorkerRestartedError())
    }
    this.lastUsedAt = Date.now()
    if (this.isIdle) this.#becameIdle()
  }

  #cancel(job) {
    const queuedIndex = this.queue.indexOf(job)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      this.#cleanupJob(job)
      job.reject(makeAbortError())
      if (this.isIdle) this.#becameIdle()
      return
    }
    if (this.active !== job) return
    this.#cleanupJob(job)
    job.cancelled = true
    if (job.cancellation) Atomics.store(job.cancellation, 0, 1)
    this.abandonedJobs += 1
    job.reject(makeAbortError())
    if (!['prepare', 'prepare-derived', 'prepare-routing-access'].includes(job.operation)) {
      const cancellationGraceMs = ['reach', 'street-surface', 'street-matrix'].includes(job.operation)
        ? reachCancellationGraceMs
        : nationalRouteCancellationGraceMs
      job.cancelTimer = setTimeout(() => {
        job.cancelTimer = null
        if (this.active === job && job.cancelled) this.#forceCancellationRestart(job)
      }, cancellationGraceMs)
      job.cancelTimer.unref?.()
      return
    }
    this.#forceCancellationRestart(job)
  }

  #forceCancellationRestart(job) {
    if (this.active !== job) return
    this.active = null
    this.#cleanupJob(job)
    this.forcedCancellationRestarts += 1
    // Every queued job was admitted against the generation that is about to be
    // destroyed. Reject it with a retriable internal code instead of silently
    // dispatching it into a replacement isolate with different resident state.
    for (const queued of this.queue.splice(0)) {
      this.#cleanupJob(queued)
      queued.reject(makeWorkerRestartedError())
    }
    this.#restartAfterCancellation().catch((error) => {
      for (const queued of this.queue.splice(0)) {
        this.#cleanupJob(queued)
        queued.reject(error)
      }
      if (this.isIdle) this.#becameIdle()
    })
  }

  async #restartAfterCancellation() {
    if (this.closed || this.restarting) return
    this.restarting = true
    const worker = this.#detachWorker()
    if (worker) await worker.terminate().catch(() => {})
    this.restarting = false
    if (this.closed) return
    this.#ensureWorker()
    this.#pump()
    if (this.isIdle) this.#becameIdle()
  }

  #cleanupJob(job) {
    if (job?.signal && job.abort) job.signal.removeEventListener('abort', job.abort)
    if (job?.cancelTimer) {
      clearTimeout(job.cancelTimer)
      job.cancelTimer = null
    }
  }

  #becameIdle() {
    if (!this.isIdle) return
    this.onIdle(this)
    this.#scheduleIdleTimer()
  }

  #scheduleIdleTimer() {
    this.#clearIdleTimer()
    if (!this.isIdle || this.residencyLeases > 0) return
    const normalIdleMs = this.hasInteractiveUse ? nationalRouteWorkerIdleMs : nationalRoutePrewarmIdleMs
    const idleMs = this.isMemoryPressure()
      ? Math.min(normalIdleMs, nationalRoutePressureIdleMs)
      : normalIdleMs
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.isIdle) this.onExpire(this)
    }, idleMs)
    this.idleTimer.unref?.()
  }

  #clearIdleTimer() {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

export class NationalRouteWorkerPool {
  constructor(maxWorkers, workerUrl) {
    this.workerUrl = workerUrl
    this.maxWorkers = maxWorkers
    this.clients = new Map()
    this.waiters = new Set()
    this.prewarmInFlight = new Map()
    this.routingAccessPrewarmInFlight = new Map()
    this.routeLifecycleTails = new Map()
    this.residencyLeases = new Map()
    this.prewarmStats = {
      requested: 0,
      started: 0,
      coalesced: 0,
      readyHits: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      waitTimedOut: 0,
      hardTimedOut: 0,
      pressureEvictions: 0,
    }
    this.lastPrewarmError = ''
    this.routingAccessPrewarmStats = {
      requested: 0,
      started: 0,
      coalesced: 0,
      readyHits: 0,
      completed: 0,
      failed: 0,
    }
    this.memoryStats = {
      pressureEvictions: 0,
      activeWorkerTerminationCount: 0,
      peakAggregateResidentRssBytes: 0,
    }
    this.lock = Promise.resolve()
  }

  prepare(storePath, { reason = 'explicit', signal, context } = {}) {
    this.prewarmStats.requested += 1
    const normalizedContext = nationalRoutingPrewarmContext(context)
    const reused = this.#reusePreparation(storePath, normalizedContext, signal, reason)
    if (reused) return reused
    return this.#withRouteLifecycle(storePath, signal, () => (
      this.#prepareNormalized(storePath, normalizedContext, signal, reason)
    ))
  }

  prepareRoutingAccess(storePath, { reason = 'background-access', signal, context } = {}) {
    this.routingAccessPrewarmStats.requested += 1
    const normalizedContext = nationalRoutingPrewarmContext(context)
    const retained = this.clients.get(storePath)?.routingAccessResultFor(normalizedContext.key)
    if (retained) {
      this.routingAccessPrewarmStats.readyHits += 1
      return waitForPromiseWithSignal(Promise.resolve(retained), signal)
    }
    const warmupKey = `${storePath}\u0000${normalizedContext.key}`
    const existing = this.routingAccessPrewarmInFlight.get(warmupKey)
    if (existing) {
      this.routingAccessPrewarmStats.coalesced += 1
      return waitForPromiseWithSignal(existing.promise, signal)
    }
    this.routingAccessPrewarmStats.started += 1
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), nationalRoutePrewarmHardTimeoutMs)
    timeout.unref?.()
    const entry = { controller, reason, storePath, promise: null }
    entry.promise = this.dispatch(storePath, 'prepare-routing-access', {
      ...normalizedContext.request,
      prewarmContextKey: normalizedContext.key,
      prewarmReason: reason,
    }, controller.signal)
      .then((result) => {
        this.routingAccessPrewarmStats.completed += 1
        return result
      })
      .catch((error) => {
        this.routingAccessPrewarmStats.failed += 1
        throw error
      })
      .finally(() => {
        clearTimeout(timeout)
        if (this.routingAccessPrewarmInFlight.get(warmupKey) === entry) {
          this.routingAccessPrewarmInFlight.delete(warmupKey)
        }
      })
    this.routingAccessPrewarmInFlight.set(warmupKey, entry)
    return waitForPromiseWithSignal(entry.promise, signal)
  }

  isPrepared(storePath, context) {
    const normalizedContext = nationalRoutingPrewarmContext(context)
    return Boolean(this.clients.get(storePath)?.preparedResultFor(normalizedContext.key))
  }

  isRoutingAccessPrepared(storePath, context) {
    const normalizedContext = nationalRoutingPrewarmContext(context)
    return Boolean(this.clients.get(storePath)?.routingAccessResultFor(normalizedContext.key))
  }

  isAdmissionPrepared(storePath, operation, streetStorePath) {
    return Boolean(this.clients.get(storePath)?.admissionPrepared(operation, streetStorePath))
  }

  isStreetPrepared(storePath, requireDrive = false) {
    const client = this.clients.get(storePath)
    const street = client?.streetPrepareResult?.streetStore
    return Boolean(client?.hasWorker && street?.ready && street.accelerated
      && (!requireDrive || (street.drive?.ready && street.drive.accelerated && !street.drive.deferred)))
  }

  dispatchRoutingAccessPrepared(storePath, operation, request, { signal, context, onProgress } = {}) {
    const timetableContext = nationalRoutingPrewarmContext({
      ...context,
      readinessOnly: true,
      streetStorePath: undefined,
    })
    return this.#withRouteLifecycle(storePath, signal, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.#prepareNormalized(storePath, timetableContext, signal, 'route-dispatch')
        await this.prepareRoutingAccess(storePath, {
          reason: 'route-dispatch',
          signal,
          context,
        })
        try {
          return await this.dispatch(storePath, operation, request, signal, onProgress)
        } catch (error) {
          if (
            attempt === 0
            && error?.code === 'VIGO_ROUTE_WORKER_RESTARTED'
            && !signal?.aborted
          ) continue
          throw error
        }
      }
      throw new Error('Unable to restore the prepared route worker.')
    })
  }

  #prepareNormalized(storePath, normalizedContext, signal, reason) {
    const reused = this.#reusePreparation(storePath, normalizedContext, signal, reason)
    if (reused) return reused

    const warmupKey = `${storePath}\u0000${normalizedContext.key}`
    this.prewarmStats.started += 1
    const controller = new AbortController()
    let hardTimedOut = false
    const timeout = setTimeout(() => {
      hardTimedOut = true
      controller.abort()
    }, nationalRoutePrewarmHardTimeoutMs)
    timeout.unref?.()
    const entry = { controller, reason, storePath, promise: null }
    entry.promise = this.dispatch(storePath, 'prepare', {
      ...normalizedContext.request,
      prewarmContextKey: normalizedContext.key,
      prewarmReason: reason,
    }, controller.signal)
      .then((result) => {
        this.prewarmStats.completed += 1
        this.lastPrewarmError = ''
        return result
      })
      .catch((error) => {
        this.prewarmStats.failed += 1
        if (hardTimedOut) {
          this.prewarmStats.timedOut += 1
          this.prewarmStats.hardTimedOut += 1
          const timeoutError = makePrewarmHardTimeoutError(nationalRoutePrewarmHardTimeoutMs)
          this.lastPrewarmError = timeoutError.message
          throw timeoutError
        }
        this.lastPrewarmError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        clearTimeout(timeout)
        if (this.prewarmInFlight.get(warmupKey) === entry) this.prewarmInFlight.delete(warmupKey)
      })
    this.prewarmInFlight.set(warmupKey, entry)
    return this.#waitForPrepare(entry.promise, signal, reason)
  }

  #reusePreparation(storePath, normalizedContext, signal, reason) {
    const prepared = this.clients.get(storePath)?.preparedResultFor(normalizedContext.key)
    if (prepared) {
      this.prewarmStats.readyHits += 1
      return this.#waitForPrepare(Promise.resolve(prepared), signal, reason)
    }

    const warmupKey = `${storePath}\u0000${normalizedContext.key}`
    const existing = this.prewarmInFlight.get(warmupKey)
    if (existing) {
      this.prewarmStats.coalesced += 1
      return this.#waitForPrepare(existing.promise, signal, reason)
    }
    return null
  }

  async dispatch(storePath, operation, request, signal, onProgress) {
    while (true) {
      if (signal?.aborted) throw makeAbortError()
      const attempt = await this.#withLock(async () => {
        let client = this.clients.get(storePath)
        if (!client) {
          if (this.clients.size >= this.maxWorkers) {
            const idleEntry = [...this.clients].find(
              ([candidateStorePath, candidate]) => candidate.isIdle && !this.residencyLeases.has(candidateStorePath),
            )
            if (!idleEntry) return null
            this.clients.delete(idleEntry[0])
            await idleEntry[1].close()
          }
          client = this.#createClient(storePath)
          this.clients.set(storePath, client)
        }
        this.#touch(storePath, client)
        return { result: client.enqueue(operation, request, signal, onProgress) }
      })
      if (attempt) return attempt.result
      await this.#waitForCapacity(signal)
    }
  }

  snapshot() {
    const memory = this.#memorySnapshot()
    const workers = [...this.clients.values()]
      .filter((client) => client.hasWorker)
      .map((client) => client.diagnostics())
    return {
      maxWorkers: this.maxWorkers,
      workerCount: workers.length,
      residentStoreCount: this.clients.size,
      idleTimeoutMs: nationalRouteWorkerIdleMs,
      prewarmIdleTimeoutMs: nationalRoutePrewarmIdleMs,
      pressureIdleTimeoutMs: nationalRoutePressureIdleMs,
      rssBudgetBytes: nationalRouteRssBudgetBytes,
      memoryPressure: memory.pressure,
      processRssBytes: memory.mainProcessRssBytes,
      mainProcessRssBytes: memory.mainProcessRssBytes,
      aggregateResidentRssBytes: memory.aggregateResidentRssBytes,
      workerProcessRssMaxBytes: memory.workerProcessRssMaxBytes,
      workerIsolateResidentEstimateBytes: memory.workerIsolateResidentEstimateBytes,
      mainHeapUsedBytes: memory.mainHeapUsedBytes,
      memory: {
        ...this.memoryStats,
        budgetBytes: nationalRouteRssBudgetBytes,
        pressure: memory.pressure,
      },
      residentRoutingStores: this.residencyLeases.size,
      residentAnalysisStores: this.residencyLeases.size,
      prewarm: {
        ...this.prewarmStats,
        inFlight: this.prewarmInFlight.size,
        waitTimeoutMs: nationalRoutePrewarmWaitTimeoutMs,
        hardTimeoutMs: nationalRoutePrewarmHardTimeoutMs,
        lastError: this.lastPrewarmError || undefined,
      },
      routingAccessPrewarm: {
        ...this.routingAccessPrewarmStats,
        inFlight: this.routingAccessPrewarmInFlight.size,
      },
      workers,
    }
  }

  async retire(storePath) {
    this.residencyLeases.delete(storePath)
    for (const warmup of this.prewarmInFlight.values()) {
      if (warmup.storePath === storePath) warmup.controller.abort()
    }
    for (const warmup of this.routingAccessPrewarmInFlight.values()) {
      if (warmup.storePath === storePath) warmup.controller.abort()
    }
    await this.#withLock(async () => {
      const client = this.clients.get(storePath)
      if (!client) return
      this.clients.delete(storePath)
      await client.close()
      this.#notifyCapacity()
    })
  }

  async closeAll() {
    for (const warmup of this.prewarmInFlight.values()) warmup.controller.abort()
    for (const warmup of this.routingAccessPrewarmInFlight.values()) warmup.controller.abort()
    await this.#withLock(async () => {
      const clients = [...this.clients.values()]
      this.clients.clear()
      this.residencyLeases.clear()
      await Promise.all(clients.map((client) => client.close()))
      this.#notifyCapacity()
    })
  }

  #withRouteLifecycle(storePath, signal, action) {
    const previous = this.routeLifecycleTails.get(storePath)
    let execution
    if (previous) {
      execution = previous.then(() => {
        if (signal?.aborted) throw makeAbortError()
        return action()
      })
    } else {
      if (signal?.aborted) return Promise.reject(makeAbortError())
      try {
        execution = Promise.resolve(action())
      } catch (error) {
        execution = Promise.reject(error)
      }
    }
    const tail = execution.then(() => undefined, () => undefined)
    this.routeLifecycleTails.set(storePath, tail)
    tail.finally(() => {
      if (this.routeLifecycleTails.get(storePath) !== tail) return
      this.routeLifecycleTails.delete(storePath)
      const client = this.clients.get(storePath)
      if (client?.isIdle) this.#trimIdleForPressure(client).catch(() => {})
    })
    return waitForPromiseWithSignal(execution, signal)
  }

  #waitForPrepare(promise, signal, reason) {
    const sharedLifecycleCaller = reason === 'project-selection' || reason === 'route-dispatch'
    const waiter = sharedLifecycleCaller
      ? waitForPromiseWithSignal(promise, signal)
      : waitForPromiseWithTimeoutAndSignal(promise, nationalRoutePrewarmWaitTimeoutMs, signal)
    return waiter.catch((error) => {
      if (error?.code === 'VIGO_PREWARM_WAIT_TIMEOUT') this.prewarmStats.waitTimedOut += 1
      throw error
    })
  }

  #createClient(storePath) {
    let client
    client = new NationalRouteWorkerClient(storePath, {
      workerUrl: this.workerUrl,
      // Pressure shortens this lease only while another idle store can be
      // evicted. The sole most-recent national worker is the minimum usable
      // working set; expiring it every 15 seconds makes every national query cold
      // without reducing memory while the user is actively routing.
      isMemoryPressure: () => (
        this.#memorySnapshot().pressure
        && [...this.clients.values()].some((candidate) => candidate !== client && candidate.isIdle)
      ),
      onIdle: (client) => {
        if (this.clients.get(storePath) === client) this.#touch(storePath, client)
        this.#notifyCapacity()
        if (!this.routeLifecycleTails.has(storePath)) this.#trimIdleForPressure(client).catch(() => {})
      },
      onExpire: (client) => {
        this.#withLock(async () => {
          if (this.clients.get(storePath) !== client || !client.isIdle) return
          this.clients.delete(storePath)
          await client.close()
          this.#notifyCapacity()
        }).catch(() => {})
      },
    })
    client.setResidencyLeases(this.residencyLeases.get(storePath)?.size ?? 0)
    return client
  }

  setResidency(storePath, resident, leaseId = 'default') {
    const normalizedLeaseId = String(leaseId ?? 'default').trim().slice(0, 128) || 'default'
    const leases = this.residencyLeases.get(storePath) ?? new Set()
    if (resident) leases.add(normalizedLeaseId)
    else leases.delete(normalizedLeaseId)
    if (leases.size) this.residencyLeases.set(storePath, leases)
    else this.residencyLeases.delete(storePath)
    this.clients.get(storePath)?.setResidencyLeases(leases.size)
    return {
      resident: leases.size > 0,
      leaseId: normalizedLeaseId,
      leaseCount: leases.size,
      residentStores: this.residencyLeases.size,
    }
  }

  #touch(storePath, client) {
    if (this.clients.get(storePath) !== client) return
    this.clients.delete(storePath)
    this.clients.set(storePath, client)
  }

  async #trimIdleForPressure(recentClient) {
    if (!this.#memorySnapshot().pressure || this.clients.size === 0) return
    await this.#withLock(async () => {
      while (this.#memorySnapshot().pressure && this.clients.size > 0) {
        const idleEntry = [...this.clients].find(
          ([, candidate]) => candidate !== recentClient && candidate.isIdle,
        )
        if (!idleEntry) break
        this.clients.delete(idleEntry[0])
        await idleEntry[1].close()
        this.prewarmStats.pressureEvictions += 1
        this.memoryStats.pressureEvictions += 1
        this.#notifyCapacity()
      }
      recentClient?.refreshIdleLease()
    })
  }

  #memorySnapshot() {
    const main = process.memoryUsage()
    const workerMetrics = [...this.clients.values()]
      .filter((client) => client.hasWorker)
      .map((client) => client.metrics ?? {})
    const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0
    const workerProcessRssMaxBytes = workerMetrics.reduce((maximum, metrics) => (
      finitePositive(metrics.processRssBytes) ? Math.max(maximum, Number(metrics.processRssBytes)) : maximum
    ), 0)
    const workerIsolateResidentEstimateBytes = workerMetrics.reduce((sum, metrics) => {
      const reported = Number(metrics.isolateResidentEstimateBytes)
      if (Number.isFinite(reported) && reported > 0) return sum + reported
      return sum + ['heapUsedBytes', 'externalBytes'].reduce((subtotal, key) => (
        finitePositive(metrics[key]) ? subtotal + Number(metrics[key]) : subtotal
      ), 0)
    }, 0)
    // Node worker_threads share one process, so the main thread's current RSS is
    // authoritative. A worker-reported RSS is only a historical point sample:
    // retaining its transient high watermark after a cold build caused an idle
    // largest worker to be evicted even after the process had returned below the
    // budget. Isolate estimates remain a conservative floor for persistent data.
    const aggregateResidentRssBytes = Math.max(main.rss, workerIsolateResidentEstimateBytes)
    this.memoryStats.peakAggregateResidentRssBytes = Math.max(
      this.memoryStats.peakAggregateResidentRssBytes,
      aggregateResidentRssBytes,
    )
    return {
      mainProcessRssBytes: main.rss,
      mainHeapUsedBytes: main.heapUsed,
      workerProcessRssMaxBytes,
      workerIsolateResidentEstimateBytes,
      aggregateResidentRssBytes,
      pressure: aggregateResidentRssBytes > nationalRouteRssBudgetBytes,
    }
  }

  #notifyCapacity() {
    for (const wake of [...this.waiters]) wake()
  }

  #waitForCapacity(signal) {
    if (signal?.aborted) return Promise.reject(makeAbortError())
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', abort)
      }
      const wake = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(makeAbortError())
      }
      this.waiters.add(wake)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async #withLock(action) {
    const previous = this.lock
    let release
    this.lock = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }
}
