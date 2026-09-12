import crypto from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Duplex, PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  mergeNationalGtfsStores,
  nationalFeedSummary,
  readNationalGtfsPreview,
  readNationalGtfsRouteCatalog,
  readNationalGtfsStoreMetadata,
} from './national-gtfs-store.mjs'
import { readNationalOsmStreetGeometry, readNationalOsmStoreMetadata } from './national-osm-store.mjs'
import { readGtfsNetworkOverview, readGtfsRouteAnalysis } from './gtfs-analysis-store.mjs'
import { decodeGtfsRealtimeFeed, gtfsRealtimeEnums as gtfsRealtime } from './gtfs-realtime-decoder.mjs'
import { fetchSafeRealtimeBody } from './realtime-url-security.mjs'
import { computeReachResult } from './reach.mjs'
import { hydrateScenarioRouteServices } from './scenario-services.mjs'
import { buildServiceEdgeDecomposition } from './service-decomposition.mjs'
import { resolveServiceDay, serviceDayForDate } from './service-day.mjs'
import { integralNumber } from './number-utils.mjs'
import {
  composeOrderedRoutingFailure,
  composeOrderedRoutingPlans,
  routeOrderedRoutingSegments,
  validateOrderedRoutingPoints,
} from './ordered-route-composition.mjs'
import {
  allocateProjectTransportAtlasBudgets,
  compactTransportPreview,
  projectTransportAtlasBudgets,
} from './transport-atlas.mjs'
import {
  applyLocalCors,
  assertLocalBindHost,
  localRequestAccess,
} from './local-http-security.mjs'
import { vigoCapabilities } from '../capabilities.mjs'

const defaultHost = '127.0.0.1'
const defaultPort = 5179
const appVersion = '0.3.1'
const host = (process.env.VIGO_HOST || defaultHost).trim() || defaultHost
const port = normalizePort(process.env.VIGO_PORT ?? process.env.VIGO_API_PORT, defaultPort)
const apiTransport = String(process.env.VIGO_API_TRANSPORT ?? 'tcp').trim().toLowerCase()
const unsafeNonLoopback = process.env.VIGO_UNSAFE_ALLOW_NON_LOOPBACK === '1'
const staticRoot = process.env.VIGO_DIST_DIR ? path.resolve(process.env.VIGO_DIST_DIR) : ''
const envStorageRoot = process.env.VIGO_PROJECTS_DIR ? path.resolve(process.env.VIGO_PROJECTS_DIR) : ''
const maxJsonBodyBytes = Math.max(1e6, Math.min(64e6, Number(process.env.VIGO_MAX_JSON_BODY_BYTES) || 8e6))
const maxSourceUploadBytes = Math.max(1e9, Number(process.env.VIGO_MAX_SOURCE_UPLOAD_BYTES) || 8e9)

const configSchemaVersion = 'vigo.config.v1'
const projectSchemaVersion = 'vigo.project.v1'
const artifactSchemaVersion = 'vigo.artifact.v1'
const jobSchemaVersion = 'vigo.job.v2'
const routingStatusSchemaVersion = 'vigo.routing.status.v1'
const maxRealtimeBytes = 20e6
const maxTransportStopPairs = 2_000
const nationalImportJobs = new Map()
const nationalImportProjects = new Map()
const projectWriteQueues = new Map()
const cityMaintenance = new Set()
const nationalPreviewRefreshes = new Map()
const gtfsRouteAnalysisCache = new Map()
const routingStoreSourceScopesCache = new Map()
const nationalJobProgressPersistedAt = new WeakMap()
const nationalRoutingServiceCoverageCache = new Map()
const nationalRoutingServiceCoverageCacheMaxEntries = 8
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
const maxNationalRouteWorkerStores = Math.max(1, Math.min(2, Number(process.env.VIGO_ROUTE_WORKER_MAX_STORES) || 2))
const defaultNationalRouteRssBudgetBytes = Math.max(
  512 * 1024 * 1024,
  Math.min(Math.floor(os.totalmem() * 0.125), 2 * 1024 * 1024 * 1024),
)
const nationalRouteRssBudgetBytes = Math.max(
  256 * 1024 * 1024,
  Number(process.env.VIGO_ROUTE_WORKER_RSS_BUDGET_BYTES) || defaultNationalRouteRssBudgetBytes,
)

function defaultStorageRoot() {
  return path.join(os.homedir(), 'Documents', 'Vigo Projects')
}

function defaultConfigDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'VIGO')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'VIGO')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'vigo')
}

function normalizeUserPath(value, fallback = defaultStorageRoot()) {
  const raw = String(value || fallback).trim() || fallback
  const expanded = raw === '~' || raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(raw === '~' ? 1 : 2))
    : raw
  return path.resolve(expanded)
}

const configDir = process.env.VIGO_CONFIG_DIR ? path.resolve(process.env.VIGO_CONFIG_DIR) : defaultConfigDir()
const configFile = path.join(configDir, 'config.json')
let configLoadedFromDisk = false
let runtimeConfig = {
  schemaVersion: configSchemaVersion,
  storageRoot: envStorageRoot || defaultStorageRoot(),
  appearance: 'dark',
  accent: 'blue',
  basemap: 'streets',
  createdAt: '',
  updatedAt: '',
}
let storageRoot = normalizeUserPath(runtimeConfig.storageRoot)

function storageStateFile() {
  return path.join(storageRoot, '.vigo-storage.json')
}

function normalizePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback
}

function makeAbortError(message = 'The route request was cancelled.') {
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

function isAbortError(error) {
  return error?.name === 'AbortError'
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

async function nationalRouteArtifactIdentity(filePath, kind = 'routing') {
  const resolvedPath = path.resolve(filePath)
  const stats = await fs.stat(resolvedPath, { bigint: true })
  if (!stats.isFile()) throw new Error(`${kind} store is not a file: ${resolvedPath}`)
  return {
    path: resolvedPath,
    storageGeneration: [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].map(String).join(':'),
  }
}

async function cachedNationalRoutingServiceCoverage(storePath) {
  const identity = await nationalRouteArtifactIdentity(storePath)
  const cacheKey = [
    identity.path,
    identity.storageGeneration,
  ].join('\u0000')
  const retained = nationalRoutingServiceCoverageCache.get(cacheKey)
  if (retained) {
    nationalRoutingServiceCoverageCache.delete(cacheKey)
    nationalRoutingServiceCoverageCache.set(cacheKey, retained)
    return retained.coverage
  }

  const coverage = nationalRoutingServiceCoverage(storePath)
  for (const [key, entry] of nationalRoutingServiceCoverageCache) {
    if (entry.storePath === identity.path) nationalRoutingServiceCoverageCache.delete(key)
  }
  nationalRoutingServiceCoverageCache.set(cacheKey, { storePath: identity.path, coverage })
  while (nationalRoutingServiceCoverageCache.size > nationalRoutingServiceCoverageCacheMaxEntries) {
    nationalRoutingServiceCoverageCache.delete(nationalRoutingServiceCoverageCache.keys().next().value)
  }
  return coverage
}

function nationalRouteWorkerUrl() {
  const override = String(process.env.VIGO_ROUTE_WORKER_URL ?? '').trim()
  if (!override) return new URL('./national-route-worker.mjs', import.meta.url)
  try {
    return new URL(override)
  } catch {
    return pathToFileURL(path.resolve(override))
  }
}

class NationalRouteWorkerClient {
  constructor(storePath, { onIdle, onExpire, isMemoryPressure }) {
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
      streetStore: this.routingAccessPrepareResult?.streetStore
        ?? this.transferPrepareResult?.streetStore
        ?? this.streetPrepareResult?.streetStore
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
    const worker = new Worker(nationalRouteWorkerUrl())
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
          this.streetPrepareResult = message.result
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

class NationalRouteWorkerPool {
  constructor(maxWorkers) {
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

const nationalRouteWorkerPool = new NationalRouteWorkerPool(maxNationalRouteWorkerStores)

function now() {
  return new Date().toISOString()
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`
}

function slugify(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'untitled-project'
}

function numeric(value) {
  try {
    if (value === null || value === undefined || value === '') return undefined
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    const number = typeof value === 'object' && typeof value.toNumber === 'function'
      ? value.toNumber()
      : Number(value)
    return Number.isFinite(number) ? number : undefined
  } catch {
    return undefined
  }
}

function integralRoutingMinute(value, label, fallback = 8 * 60) {
  const candidate = value === undefined ? fallback : value
  const parsed = integralNumber(candidate)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= 30 * 60) {
    const error = new Error(`${label} must be an integral minute in [0, 1800).`)
    error.statusCode = 400
    error.code = 'invalid_routing_time'
    throw error
  }
  return parsed
}

function enumLabel(enumObject, value) {
  if (value === null || value === undefined) return undefined
  return Object.entries(enumObject).find(([, enumValue]) => enumValue === value)?.[0]
}

function translatedText(value) {
  const translations = value?.translation ?? []
  return translations.find((translation) => translation.language === 'en')?.text
    ?? translations[0]?.text
    ?? ''
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''))
}

function tripFields(trip) {
  return compactObject({
    routeId: trip?.routeId,
    tripId: trip?.tripId,
    startDate: trip?.startDate,
    startTime: trip?.startTime,
    scheduleRelationship: enumLabel(gtfsRealtime.TripDescriptor.ScheduleRelationship, trip?.scheduleRelationship),
  })
}

function vehiclePositionToRecord(entity) {
  const vehicle = entity.vehicle
  const position = vehicle?.position
  return compactObject({
    id: vehicle?.vehicle?.id || entity.id,
    label: vehicle?.vehicle?.label,
    licensePlate: vehicle?.vehicle?.licensePlate,
    ...tripFields(vehicle?.trip),
    stopId: vehicle?.stopId,
    currentStatus: enumLabel(gtfsRealtime.VehiclePosition.VehicleStopStatus, vehicle?.currentStatus),
    congestionLevel: enumLabel(gtfsRealtime.VehiclePosition.CongestionLevel, vehicle?.congestionLevel),
    occupancyStatus: enumLabel(gtfsRealtime.VehiclePosition.OccupancyStatus, vehicle?.occupancyStatus),
    occupancyPercentage: vehicle?.occupancyPercentage,
    timestamp: numeric(vehicle?.timestamp),
    lat: position?.latitude,
    lon: position?.longitude,
    bearing: position?.bearing,
    speed: position?.speed,
  })
}

function stopEventDelay(update) {
  return update.arrival?.delay ?? update.departure?.delay
}

function stopTimeEventToRecord(event) {
  if (!event) return undefined
  return compactObject({
    delay: numeric(event.delay),
    time: numeric(event.time),
    uncertainty: numeric(event.uncertainty),
    scheduledTime: numeric(event.scheduledTime),
  })
}

function stopTimeUpdateToRecord(update) {
  return compactObject({
    stopSequence: numeric(update?.stopSequence),
    stopId: update?.stopId,
    scheduleRelationship: enumLabel(
      gtfsRealtime.StopTimeUpdate.ScheduleRelationship,
      update?.scheduleRelationship,
    ),
    arrival: stopTimeEventToRecord(update?.arrival),
    departure: stopTimeEventToRecord(update?.departure),
  })
}

function tripUpdateToRecord(entity) {
  const tripUpdate = entity.tripUpdate
  const firstUpcoming = tripUpdate?.stopTimeUpdate?.find((update) => update.stopId || update.stopSequence)
  return compactObject({
    id: entity.id,
    ...tripFields(tripUpdate?.trip),
    timestamp: numeric(tripUpdate?.timestamp),
    delaySeconds: tripUpdate?.delay ?? stopEventDelay(firstUpcoming),
    stopUpdateCount: tripUpdate?.stopTimeUpdate?.length ?? 0,
    nextStopId: firstUpcoming?.stopId,
    nextStopSequence: firstUpcoming?.stopSequence,
    stopTimeUpdates: (tripUpdate?.stopTimeUpdate ?? []).map(stopTimeUpdateToRecord),
  })
}

function alertToRecord(entity) {
  const alert = entity.alert
  const informedEntity = alert?.informedEntity ?? []
  return compactObject({
    id: entity.id,
    cause: enumLabel(gtfsRealtime.Alert.Cause, alert?.cause),
    effect: enumLabel(gtfsRealtime.Alert.Effect, alert?.effect),
    severity: enumLabel(gtfsRealtime.Alert.SeverityLevel, alert?.severityLevel),
    header: translatedText(alert?.headerText),
    description: translatedText(alert?.descriptionText),
    url: translatedText(alert?.url),
    routeIds: Array.from(new Set(informedEntity.map((entitySelector) => entitySelector.routeId).filter(Boolean))),
    stopIds: Array.from(new Set(informedEntity.map((entitySelector) => entitySelector.stopId).filter(Boolean))),
    activePeriods: (alert?.activePeriod ?? []).map((period) => compactObject({
      start: numeric(period.start),
      end: numeric(period.end),
    })),
  })
}

function realtimeSnapshotFromFeed(feed, sourceUrl, fetchedAt, contentType) {
  const entities = feed.entity ?? []
  const vehicles = entities.filter((entity) => entity.vehicle).map(vehiclePositionToRecord)
  const tripUpdates = entities.filter((entity) => entity.tripUpdate).map(tripUpdateToRecord)
  const alerts = entities.filter((entity) => entity.alert).map(alertToRecord)
  const classified = vehicles.length + tripUpdates.length + alerts.length
  const feedTimestamp = numeric(feed.header?.timestamp)
  const ageSeconds = Number.isFinite(feedTimestamp)
    ? Math.max(0, Date.parse(fetchedAt) / 1000 - feedTimestamp)
    : undefined

  return {
    sourceUrl,
    fetchedAt,
    feedTimestamp,
    freshness: {
      status: ageSeconds === undefined ? 'unknown' : ageSeconds > 180 ? 'stale' : 'fresh',
      ...(ageSeconds === undefined ? {} : { ageSeconds: Number(ageSeconds.toFixed(1)) }),
      thresholdSeconds: 180,
    },
    feedVersion: feed.header?.feedVersion || undefined,
    gtfsRealtimeVersion: feed.header?.gtfsRealtimeVersion || undefined,
    incrementality: enumLabel(gtfsRealtime.FeedHeader.Incrementality, feed.header?.incrementality),
    contentType,
    entityCount: entities.length,
    counts: {
      vehicles: vehicles.length,
      tripUpdates: tripUpdates.length,
      alerts: alerts.length,
      other: Math.max(0, entities.length - classified),
    },
    vehicles,
    tripUpdates,
    alerts,
  }
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function normalizeAppearance(value) {
  return value === 'light' ? 'light' : 'dark'
}

function normalizeAccent(value) {
  return ['teal', 'blue', 'graphite'].includes(value) ? value : 'blue'
}

function normalizeBasemap(value) {
  return ['none', 'offline', 'minimal', 'streets', 'dark', 'terrain'].includes(value) ? value : 'streets'
}

async function loadRuntimeConfig() {
  if (envStorageRoot) {
    storageRoot = normalizeUserPath(envStorageRoot)
    runtimeConfig = {
      ...runtimeConfig,
      storageRoot,
      configuredAt: runtimeConfig.configuredAt || now(),
      updatedAt: runtimeConfig.updatedAt || now(),
    }
    return
  }

  if (!(await exists(configFile))) {
    storageRoot = normalizeUserPath(runtimeConfig.storageRoot)
    return
  }

  try {
    const stored = await readJson(configFile)
    configLoadedFromDisk = true
    runtimeConfig = {
      ...runtimeConfig,
      ...stored,
      schemaVersion: configSchemaVersion,
      storageRoot: normalizeUserPath(stored.storageRoot),
      appearance: normalizeAppearance(stored.appearance),
      accent: normalizeAccent(stored.accent),
      basemap: normalizeBasemap(stored.basemap),
    }
    storageRoot = runtimeConfig.storageRoot
  } catch {
    storageRoot = normalizeUserPath(runtimeConfig.storageRoot)
  }
}

async function saveRuntimeConfig(config) {
  await writeJsonAtomic(configFile, config)
  configLoadedFromDisk = true
}

async function canWriteDirectory(directory) {
  const testFile = path.join(directory, `.vigo-write-test-${process.pid}-${Date.now()}`)
  try {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(testFile, 'ok')
    await fs.rm(testFile, { force: true })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Storage folder is not writable.',
    }
  }
}

async function setupRequired() {
  if (envStorageRoot || configLoadedFromDisk || await exists(storageStateFile())) return false
  const projects = await listProjectsRaw({ hydrate: false })
  return projects.length === 0
}

async function offlineStatus() {
  const appIndex = staticRoot ? path.join(staticRoot, 'index.html') : ''
  const storage = await canWriteDirectory(storageRoot)

  return {
    localServer: true,
    bundledApp: Boolean(staticRoot && await exists(appIndex)),
    storageWritable: storage.ok,
    storageError: storage.error,
    gtfsImport: true,
    offlineBasemap: true,
    remoteFeedUrlsRequireNetwork: true,
    realtimeUrlsRequireNetwork: true,
  }
}

async function configStatus() {
  return {
    schemaVersion: configSchemaVersion,
    configured: Boolean(envStorageRoot || configLoadedFromDisk || await exists(storageStateFile())),
    setupRequired: await setupRequired(),
    storageRoot,
    defaultStorageRoot: defaultStorageRoot(),
    configFile,
    canChangeStorageRoot: !envStorageRoot,
    appearance: normalizeAppearance(runtimeConfig.appearance),
    accent: normalizeAccent(runtimeConfig.accent),
    basemap: normalizeBasemap(runtimeConfig.basemap),
    offline: await offlineStatus(),
  }
}

async function updateRuntimeConfig(body = {}) {
  const requestedStorageRoot = envStorageRoot
    ? storageRoot
    : normalizeUserPath(body.storageRoot ?? storageRoot)
  const writable = await canWriteDirectory(requestedStorageRoot)

  if (!writable.ok) {
    const error = new Error(writable.error || 'Storage folder is not writable.')
    error.statusCode = 400
    throw error
  }

  if (requestedStorageRoot !== storageRoot) {
    await nationalRouteWorkerPool.closeAll()
    nationalRoutingServiceCoverageCache.clear()
    nationalPreviewRefreshes.clear()
    gtfsRouteAnalysisCache.clear()
  }
  storageRoot = requestedStorageRoot
  const timestamp = now()
  runtimeConfig = {
    schemaVersion: configSchemaVersion,
    storageRoot,
    appearance: normalizeAppearance(body.appearance ?? runtimeConfig.appearance),
    accent: normalizeAccent(body.accent ?? runtimeConfig.accent),
    basemap: normalizeBasemap(body.basemap ?? runtimeConfig.basemap),
    configuredAt: runtimeConfig.configuredAt || timestamp,
    updatedAt: timestamp,
  }

  if (!envStorageRoot) {
    await saveRuntimeConfig(runtimeConfig)
  }

  await markStorageInitialized('configure-storage')

  return configStatus()
}

async function ensureStorage() {
  await fs.mkdir(storageRoot, { recursive: true })
}

function projectDir(projectId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectId)) {
    const error = new Error('Project id is invalid.')
    error.statusCode = 400
    throw error
  }

  const resolvedPath = path.resolve(storageRoot, projectId)
  const relativePath = path.relative(storageRoot, resolvedPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    const error = new Error('Project path is outside Vigo Projects.')
    error.statusCode = 400
    throw error
  }

  return resolvedPath
}

function projectMetaDir(projectId) {
  return path.join(projectDir(projectId), '.vigo')
}

function routingStoreFile(projectId, feedId) {
  return path.join(projectMetaDir(projectId), 'routing', `${feedId}.sqlite`)
}

function feedRoutingStoreFile(projectId, feed) {
  return path.join(
    projectMetaDir(projectId),
    'routing',
    path.basename(feed?.routingStore?.fileName || `${feed?.id}.sqlite`),
  )
}

function projectRoutingStoreFile(projectId, project) {
  return path.join(projectMetaDir(projectId), 'routing', path.basename(project.routingStore?.fileName || 'project.sqlite'))
}

function routingStoreSelection(projectId, project, requestedFeedId) {
  const projectStore = project.routingStore?.status === 'ready'
    ? projectRoutingStoreFile(projectId, project)
    : null
  const feed = project.feeds.find((item) => (
    item.id === requestedFeedId
    && item.routingStore?.status === 'ready'
  ))
  const feedStore = feed ? feedRoutingStoreFile(projectId, feed) : null
  return {
    projectStore,
    feed,
    // A requested feed must stay isolated when its own store is available.
    // The project store is reserved for the explicit bundle/project scope;
    // otherwise a multi-feed Reachability comparison could silently analyze the
    // merged timetable for every selected side.
    storePath: feedStore || projectStore,
  }
}

async function requireRoutingStore(projectId, project, requestedFeedId) {
  const selection = routingStoreSelection(projectId, project, requestedFeedId)
  if (!selection.storePath) {
    const error = new Error('The selected feed does not have a ready routing store.')
    error.statusCode = 409
    throw error
  }
  if (!await exists(selection.storePath)) {
    const error = new Error('The local routing store is missing. Rebuild the GTFS feed.')
    error.statusCode = 409
    throw error
  }
  return selection
}

async function routingStoreSourceScopes(storePath) {
  const storeStats = await fs.stat(storePath).catch(() => null)
  if (!storeStats?.isFile()) return []
  const cacheKey = [storePath, storeStats.size, storeStats.mtimeMs].join(':')
  const cached = routingStoreSourceScopesCache.get(cacheKey)
  if (cached) return cached

  let scopes = []
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const hasMetadata = db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type='table' AND name='metadata'
    `).get()?.present === 1
    const sourceStoresValue = hasMetadata
      ? db.prepare("SELECT value FROM metadata WHERE key='sourceStores'").get()?.value
      : undefined
    const sourceStores = sourceStoresValue ? JSON.parse(sourceStoresValue) : []
    scopes = Array.isArray(sourceStores)
      ? [...new Set(sourceStores.map((source) => String(source?.scope || '').trim()).filter(Boolean))]
      : []
  } catch {
    scopes = []
  } finally {
    db.close()
  }

  routingStoreSourceScopesCache.set(cacheKey, scopes)
  while (routingStoreSourceScopesCache.size > 16) {
    routingStoreSourceScopesCache.delete(routingStoreSourceScopesCache.keys().next().value)
  }
  return scopes
}

async function feedRoutingStoreContext(projectId, project, feed) {
  const projectStorePath = project.routingStore?.status === 'ready'
    ? projectRoutingStoreFile(projectId, project)
    : ''
  const projectStoreReady = Boolean(projectStorePath) && await exists(projectStorePath)
  const declaredFeedStorePath = feed?.routingStore?.status === 'ready'
    ? feedRoutingStoreFile(projectId, feed)
    : ''
  const feedStoreReady = Boolean(declaredFeedStorePath) && await exists(declaredFeedStorePath)

  if (projectStoreReady) {
    if ((project.feeds ?? []).length === 1) {
      return { routingStore: project.routingStore, storePath: projectStorePath, sourceScope: '' }
    }
    const projectSourceScopes = await routingStoreSourceScopes(projectStorePath)
    if (projectSourceScopes.includes(feed.id)) {
      return { routingStore: project.routingStore, storePath: projectStorePath, sourceScope: feed.id }
    }
    if (feedStoreReady && path.resolve(declaredFeedStorePath) === path.resolve(projectStorePath)) {
      return { routingStore: feed.routingStore, storePath: projectStorePath, sourceScope: '' }
    }
  }

  if (feedStoreReady) {
    return { routingStore: feed.routingStore, storePath: declaredFeedStorePath, sourceScope: '' }
  }
  return null
}

function projectNationalRoutingStorePaths(projectId, project) {
  const storePaths = new Set()
  if (project?.routingStore?.status === 'ready') {
    storePaths.add(projectRoutingStoreFile(projectId, project))
  }
  for (const feed of project?.feeds ?? []) {
    if (feed?.routingStore?.status !== 'ready') continue
    storePaths.add(path.join(
      projectMetaDir(projectId),
      'routing',
      path.basename(feed.routingStore.fileName || `${feed.id}.sqlite`),
    ))
  }
  return [...storePaths]
}

function currentNationalRoutingServiceContext(date = new Date()) {
  const serviceDate = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  return {
    serviceDate,
    serviceDay: serviceDayForDate(serviceDate),
    // Exact service dates are the default. A representative timetable is used
    // only after the user explicitly requests the nearest available date.
    allowServiceDateFallback: false,
    requireCompleteServiceCoverage: true,
  }
}

function streetStoreFile(projectId) {
  return path.join(projectMetaDir(projectId), 'osm', 'street-index.sqlite')
}

function queryNumber(url, name) {
  const value = Number(url.searchParams.get(name))
  return Number.isFinite(value) ? value : null
}

async function readLocalStreetGeometry(projectId, url) {
  const project = await readProjectMetadata(projectId)
  if (project.osmStreetIndex?.status !== 'ready' || !await exists(streetStoreFile(projectId))) {
    const error = new Error('This City has no ready OSM street index. Import an .osm.pbf file first.')
    error.statusCode = 409
    throw error
  }

  const requested = {
    west: queryNumber(url, 'west'),
    south: queryNumber(url, 'south'),
    east: queryNumber(url, 'east'),
    north: queryNumber(url, 'north'),
  }
  if (Object.values(requested).some((value) => value === null)) {
    const error = new Error('Local street geometry requires west, south, east, and north.')
    error.statusCode = 400
    throw error
  }
  if (requested.east <= requested.west || requested.north <= requested.south) {
    const error = new Error('Local street geometry bounds are invalid.')
    error.statusCode = 400
    throw error
  }

  const maxSpan = 2.5
  const centerLon = (requested.west + requested.east) / 2
  const centerLat = (requested.south + requested.north) / 2
  const halfLon = Math.min(maxSpan / 2, (requested.east - requested.west) / 2)
  const halfLat = Math.min(maxSpan / 2, (requested.north - requested.south) / 2)
  const bbox = {
    west: Math.max(-180, centerLon - halfLon),
    south: Math.max(-90, centerLat - halfLat),
    east: Math.min(180, centerLon + halfLon),
    north: Math.min(90, centerLat + halfLat),
  }
  const limitValue = Math.floor(queryNumber(url, 'limit') ?? 12_000)
  const limit = Math.max(500, Math.min(16_000, limitValue))
  const runtimeGeometry = readNationalOsmStreetGeometry(streetStoreFile(projectId), bbox, { limit })
  return {
    ...runtimeGeometry,
    metadata: {
      ...runtimeGeometry.metadata,
      requestedBbox: requested,
    },
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function writeJsonAtomic(filePath, value, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${makeId('tmp')}`
  try {
    await fs.writeFile(tempPath, `${options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`)
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function projectVisibleManifest(project) {
  const feeds = (project.feeds ?? []).map((feed) => ({
    id: feed.id,
    name: feed.name,
    fileName: feed.fileName,
    provider: feed.provider,
    routeCount: Number(feed.routeCount ?? 0),
    stopCount: Number(feed.stopCount ?? 0),
    tripCount: Number(feed.tripCount ?? 0),
    routingStore: feed.routingStore
      ? {
        status: feed.routingStore.status,
        connectionCount: Number(feed.routingStore.connectionCount ?? 0),
        bytes: Number(feed.routingStore.bytes ?? 0),
        storedAt: `.vigo/routing/${feed.id}.sqlite`,
      }
      : null,
  }))
  const street = project.osmStreetIndex?.status === 'ready' ? project.osmStreetIndex : null

  return {
    schemaVersion: 'vigo.project.visible_manifest.v1',
    generatedAt: now(),
    project: {
      id: project.id,
      name: project.name,
      region: project.region,
      storagePath: projectDir(project.id),
    },
    summary: project.summary ?? summaryFromFeeds(project.feeds ?? [], {}),
    feeds,
    osmStreetIndex: street
      ? {
        fileName: street.fileName,
        sourceModel: street.sourceModel,
        sourceFingerprint: street.sourceFingerprint,
        nodeCount: Number(street.nodeCount ?? 0),
        edgeCount: Number(street.edgeCount ?? 0),
        bytes: Number(street.bytes ?? 0),
        storedAt: '.vigo/osm/street-index.sqlite',
      }
      : null,
    storageLayout: {
      implementationDirectory: '.vigo',
      routingStores: '.vigo/routing',
      osmStreetIndex: '.vigo/osm/street-index.sqlite',
      artifacts: '.vigo/artifacts',
    },
  }
}

function reproducibilityStoreManifest(store, metadata) {
  const source = metadata ?? store
  if (!source) return null
  return {
    schemaVersion: source.schemaVersion,
    status: store?.status ?? 'ready',
    routingEligibility: store?.routingEligibility ?? source.routingEligibility,
    sourceFingerprint: source.sourceFingerprint ?? store?.sourceFingerprint,
    sourceFile: source.sourceFile,
    sourceBytes: Number(source.sourceBytes ?? 0) || undefined,
    builtAt: source.builtAt ?? store?.builtAt,
    routeCount: Number(source.routeCount ?? 0),
    stopCount: Number(source.stopCount ?? 0),
    tripCount: Number(source.tripCount ?? 0),
    stopTimeCount: Number(source.stopTimeCount ?? 0),
    connectionCount: Number(source.connectionCount ?? store?.connectionCount ?? 0),
    transferCount: Number(source.transferCount ?? 0),
    frequencyCount: Number(source.frequencyCount ?? 0),
    frequencyRoutingModel: source.frequencyRoutingModel,
    featureInventory: source.featureInventory,
    blockingRoutingFeatures: source.blockingRoutingFeatures ?? store?.blockingRoutingFeatures ?? [],
    routingLimitations: source.routingLimitations ?? store?.routingLimitations ?? [],
    sourceStores: source.sourceStores,
  }
}

async function projectReproducibilityManifest(projectId) {
  const project = await readProjectMetadata(projectId)
  const [jobRecords, artifactRecords] = await Promise.all([
    readJsonRecords(path.join(projectMetaDir(projectId), 'jobs')),
    readJsonRecords(path.join(projectMetaDir(projectId), 'artifacts')),
  ])
  const jobs = mergeRecords(jobRecords, project.jobs).map((job) => ({
    schemaVersion: job.schemaVersion ?? jobSchemaVersion,
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    progress: Number(job.progress ?? 0),
    createdAt: job.createdAt,
    phase: job.phase,
    detail: job.detail,
    failureCode: job.failureCode,
    retryable: job.retryable,
    retryOf: job.retryOf,
    sourceFile: job.sourceFile,
    phaseTimingsMs: job.phaseTimingsMs,
    preparation: job.preparation,
    finishedAt: job.finishedAt,
    result: job.result?.feedId ? { feedId: job.result.feedId } : undefined,
  }))
  const feeds = await Promise.all((project.feeds ?? []).map(async (feed) => {
    const storePath = feed.routingStore?.status === 'ready' ? feedRoutingStoreFile(projectId, feed) : ''
    const metadata = storePath && await exists(storePath)
      ? await Promise.resolve().then(() => readNationalGtfsStoreMetadata(storePath)).catch(() => null)
      : null
    return {
      id: feed.id,
      name: feed.name,
      source: feed.source,
      fileName: feed.fileName,
      fileSize: Number(feed.fileSize ?? 0),
      hash: feed.hash,
      routeCount: Number(feed.routeCount ?? 0),
      stopCount: Number(feed.stopCount ?? 0),
      tripCount: Number(feed.tripCount ?? 0),
      routingStore: reproducibilityStoreManifest(feed.routingStore, metadata),
    }
  }))
  const projectStorePath = project.routingStore?.status === 'ready' ? projectRoutingStoreFile(projectId, project) : ''
  const projectStoreMetadata = projectStorePath && await exists(projectStorePath)
    ? await Promise.resolve().then(() => readNationalGtfsStoreMetadata(projectStorePath)).catch(() => null)
    : null
  const street = project.osmStreetIndex
  return {
    schemaVersion: 'vigo.reproducibility.v1',
    generatedAt: now(),
    appVersion,
    contracts: {
      preparation: 'vigo.preparation.v1',
      job: jobSchemaVersion,
      routingStatus: routingStatusSchemaVersion,
    },
    project: {
      id: project.id,
      name: project.name,
      region: project.region,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    summary: project.summary,
    feeds,
    routingStore: reproducibilityStoreManifest(project.routingStore, projectStoreMetadata),
    osmStreetIndex: street
      ? {
        schemaVersion: street.schemaVersion,
        status: street.status,
        fileName: street.fileName,
        sourceFingerprint: street.sourceFingerprint,
        sourceBytes: Number(street.sourceBytes ?? 0),
        bytes: Number(street.bytes ?? 0),
        builtAt: street.builtAt,
        nodeCount: Number(street.nodeCount ?? 0),
        edgeCount: Number(street.edgeCount ?? 0),
        wayCount: Number(street.wayCount ?? 0),
        cch: street.cch,
      }
      : null,
    jobs,
    artifacts: mergeRecords(artifactRecords, project.artifacts),
  }
}

function projectVisibleReadme(project, manifest) {
  const feedLines = manifest.feeds.length
    ? manifest.feeds.map((feed) => `- ${feed.name ?? feed.id}: ${feed.routeCount.toLocaleString()} routes, ${feed.stopCount.toLocaleString()} stops, ${feed.tripCount.toLocaleString()} trips, exact routing at \`${feed.routingStore?.storedAt ?? 'not stored'}\`.`).join('\n')
    : '- No GTFS feeds imported yet.'
  const osmLine = manifest.osmStreetIndex
    ? `OSM street index: ${manifest.osmStreetIndex.fileName}, ${manifest.osmStreetIndex.edgeCount.toLocaleString()} directed edges, stored at \`${manifest.osmStreetIndex.storedAt}\`.`
    : 'OSM street index: not loaded.'

  return `# ${project.name ?? project.id}

This is a VIGO local project stored on disk, not in browser session storage.

Most data lives under the hidden \`.vigo\` implementation folder so the app can keep SQLite routing and street indexes with project metadata. Finder may hide that folder by default; this visible README and \`DATA_MANIFEST.json\` are here so the project never looks empty.

${feedLines}

${osmLine}

Visible manifest: \`DATA_MANIFEST.json\`
Internal project metadata: \`.vigo/project.json\`
`
}

async function writeProjectVisibleFiles(project) {
  const manifest = projectVisibleManifest(project)
  const root = projectDir(project.id)
  await fs.mkdir(root, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(root, 'README.md'), projectVisibleReadme(project, manifest)),
    fs.writeFile(path.join(root, 'DATA_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ])
}

async function readJsonRecords(dirPath) {
  if (!(await exists(dirPath))) return []

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const records = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      records.push(await readJson(path.join(dirPath, entry.name)))
    } catch {
      // One broken sidecar should not hide the whole project.
    }
  }

  return records
}

function mergeRecords(primary = [], secondary = []) {
  const seen = new Set()

  return [...primary, ...secondary].filter((record) => {
    if (!record?.id || seen.has(record.id)) return false
    seen.add(record.id)
    return true
  })
}

function summaryFromFeeds(feeds, fallback) {
  if (!feeds.length) return fallback

  return {
    feeds: feeds.length,
    routes: feeds.reduce((sum, feed) => sum + Number(feed.routeCount ?? 0), 0),
    stops: feeds.reduce((sum, feed) => sum + Number(feed.stopCount ?? 0), 0),
    transferCandidates: feeds.reduce((sum, feed) => sum + Number(feed.transferCandidates ?? 0), 0),
    qualityScore: Math.round(feeds.reduce((sum, feed) => sum + Number(feed.qualityScore ?? 0), 0) / feeds.length),
  }
}

function compactFeedMetadata(feed) {
  return {
    id: feed.id,
    name: feed.name,
    provider: feed.provider,
    versionLabel: feed.versionLabel,
    importedAt: feed.importedAt,
    source: feed.source,
    fileName: feed.fileName,
    fileSize: feed.fileSize,
    hash: feed.hash,
    qualityScore: feed.qualityScore,
    routeCount: feed.routeCount,
    stopCount: feed.stopCount,
    tripCount: feed.tripCount,
    transferCandidates: feed.transferCandidates,
    requiredTables: feed.requiredTables,
    optionalTables: feed.optionalTables,
    tableProfiles: feed.tableProfiles,
    tides: feed.tides,
    warnings: feed.warnings ?? [],
    routingStore: feed.routingStore,
  }
}

function compactIndexedFeed(feed) {
  return {
    ...compactFeedMetadata(feed),
    routeMetrics: feed.routeMetrics ?? [],
    stopMetrics: feed.stopMetrics ?? [],
    mapPreview: feed.mapPreview ?? { routes: [], stops: [], stopPairs: [] },
  }
}

function compactRouteCatalog(routes) {
  return (routes ?? []).map((route) => ({
    ...route,
    coordinates: [],
    points: [],
    stopIds: [],
    scheduledTrips: undefined,
  }))
}

function mergePreviewStops(primary = [], secondary = []) {
  const merged = new Map()
  for (const stop of [...primary, ...secondary]) {
    const existing = merged.get(stop.id)
    if (!existing) {
      merged.set(stop.id, stop)
      continue
    }
    merged.set(stop.id, {
      ...existing,
      ...stop,
      routes: [...new Set([...(existing.routes ?? []), ...(stop.routes ?? [])])],
      tripCount: Math.max(Number(existing.tripCount ?? 0), Number(stop.tripCount ?? 0)),
      transferScore: Math.max(Number(existing.transferScore ?? 0), Number(stop.transferScore ?? 0)),
    })
  }
  return [...merged.values()]
}

function compactFeedForClient(feed, { routingReady = false, budgets } = {}) {
  const hasMapPreview = Boolean(feed.mapPreview?.routes?.length || feed.mapPreview?.stops?.length)
  const stopPairs = feed.mapPreview?.stopPairs ?? []
  const transportStopPairs = stopPairs.length > maxTransportStopPairs ? stopPairs.slice(0, maxTransportStopPairs) : stopPairs
  const mapPreview = routingReady
    ? compactTransportPreview(feed.mapPreview, { routingReady: true, budgets })
    : feed.mapPreview
      ? {
      ...feed.mapPreview,
      stopPairs: transportStopPairs,
      coverage: feed.mapPreview.coverage
        ? {
          ...feed.mapPreview.coverage,
          stopPairsIndexed: feed.mapPreview.coverage.stopPairsIndexed ?? stopPairs.length,
          capped: Boolean(feed.mapPreview.coverage.capped || stopPairs.length > maxTransportStopPairs),
        }
        : undefined,
      }
      : undefined

  return {
    ...compactIndexedFeed(feed),
    routeMetrics: compactRouteCatalog(feed.routeMetrics?.length ? feed.routeMetrics : hasMapPreview ? feed.mapPreview.routes ?? [] : []),
    stopMetrics: hasMapPreview ? [] : feed.stopMetrics ?? [],
    mapPreview,
  }
}

function missingRoutingStoreWarning(feed) {
  return {
    id: 'routing-store-missing',
    severity: 'error',
    table: 'stop_times.txt',
    message: `${feed.fileName ?? feed.name ?? 'GTFS feed'} has no ready SQLite routing store. Re-import the source ZIP.`,
    rows: [feed.id ?? feed.fileName ?? 'feed'],
  }
}

async function normalizeFeedRoutingMetadata(projectId, feed, options = {}) {
  const routingStore = options.routingStore ?? feed?.routingStore
  const storePath = options.storePath ?? routingStoreFile(projectId, feed.id)
  if (routingStore?.status === 'ready' && await exists(storePath)) {
    try {
      readNationalGtfsStoreMetadata(storePath)
    } catch (error) {
      return {
        ...feed,
        routingStore: { ...routingStore, status: 'error', error: error.message },
        warnings: [
          ...(feed.warnings ?? []).filter((warning) => warning.id !== 'routing-store-missing'),
          { ...missingRoutingStoreWarning(feed), message: 'This timetable index is outdated or unreadable. Re-import the source GTFS ZIP.' },
        ],
      }
    }
    const storeStats = await fs.stat(storePath)
    return {
      ...feed,
      routingStore: { ...routingStore, bytes: storeStats.size },
      warnings: (feed.warnings ?? []).filter((warning) => warning.id !== 'routing-store-missing'),
    }
  }
  return {
    ...feed,
    routingStore: undefined,
    warnings: [
      ...(feed.warnings ?? []).filter((warning) => warning.id !== 'routing-store-missing'),
      missingRoutingStoreWarning(feed),
    ],
  }
}

async function refreshNationalFeedPreview(projectId, feed, options = {}) {
  if (feed?.routingStore?.status !== 'ready') return feed
  const routingStore = options.routingStore ?? feed?.routingStore
  if (routingStore?.status !== 'ready') return feed
  const storePath = options.storePath ?? routingStoreFile(projectId, feed.id)
  const storeStats = await fs.stat(storePath).catch(() => null)
  if (!storeStats?.isFile()) return feed

  const sourceScope = String(options.sourceScope || '')
  const cacheKey = [projectId, feed.id, sourceScope, storeStats.size, storeStats.mtimeMs, feed.routeCount, feed.tripCount].join(':')
  let refresh = nationalPreviewRefreshes.get(cacheKey)
  if (!refresh) {
    refresh = Promise.resolve().then(async () => {
      const routeMetrics = readNationalGtfsRouteCatalog(storePath, { sourceScope })
      const representativeRouteIds = [...routeMetrics]
        .sort((left, right) =>
          Number(right.tripCount ?? 0) - Number(left.tripCount ?? 0)
          || String(left.shortName ?? left.routeId ?? left.id).localeCompare(String(right.shortName ?? right.routeId ?? right.id)),
        )
        .slice(0, projectTransportAtlasBudgets.routes)
        .map((route) => route.routeId || route.id)
      const mapPreview = readNationalGtfsPreview(storePath, {
        routeCount: feed.routeCount,
        stopCount: feed.stopCount,
        tripCount: feed.tripCount,
        sourceScope,
        routeLimit: projectTransportAtlasBudgets.routes,
        representativeRouteIds,
      })
      const completeOverview = readGtfsNetworkOverview(storePath, { sourceScope })
      if (!completeOverview.routes.length) return undefined
      const previewByRoute = new Map(completeOverview.routes.map((route) => [route.routeId || route.id, route]))
      const hydratedRouteMetrics = routeMetrics.filter((route) => Number(route.tripCount ?? 0) > 0).map((route) => {
        const previewRoute = previewByRoute.get(route.routeId || route.id)
        return previewRoute
          ? { ...route, ...previewRoute, tripCount: route.tripCount, serviceVariantCount: route.serviceVariantCount }
          : route
      })
      const overviewStops = mergePreviewStops(completeOverview.stops, mapPreview.stops)
      const completePreview = {
        ...mapPreview,
        routes: hydratedRouteMetrics,
        stops: overviewStops,
        coverage: {
          ...completeOverview.coverage,
          rawRouteRows: routeMetrics.length,
          publicRouteIdentities: hydratedRouteMetrics.length,
          stopsIndexed: overviewStops.length,
          capped: false,
        },
      }
      return {
        routeMetrics: hydratedRouteMetrics,
        stopMetrics: completePreview.stops,
        mapPreview: completePreview,
      }
    })
    nationalPreviewRefreshes.set(cacheKey, refresh)
    while (nationalPreviewRefreshes.size > 8) nationalPreviewRefreshes.delete(nationalPreviewRefreshes.keys().next().value)
  }

  try {
    const previewFields = await refresh
    return previewFields
      ? { ...feed, ...previewFields, routingStore: feed.routingStore ? { ...feed.routingStore, bytes: storeStats.size } : undefined }
      : feed
  } catch (error) {
    nationalPreviewRefreshes.delete(cacheKey)
    throw error
  }
}

async function gtfsAnalysisStoreContext(projectId, feedId) {
  const project = await readProjectMetadata(projectId)
  const feed = project.feeds.find((candidate) => candidate.id === feedId)
  if (!feed) {
    const error = new Error('The selected GTFS feed was not found in this project.')
    error.statusCode = 404
    throw error
  }
  const context = await feedRoutingStoreContext(projectId, project, feed)
  if (!context) {
    const error = new Error('The selected feed does not have a ready SQLite analysis store.')
    error.statusCode = 409
    throw error
  }
  return {
    feed,
    storePath: context.storePath,
    sourceScope: context.sourceScope,
  }
}

async function analyzeGtfsRoute(projectId, body = {}) {
  const feedId = String(body.feedId || '').trim()
  const routeId = String(body.routeId || '').trim()
  const serviceDate = String(body.serviceDate || '').trim()
  if (!feedId || !routeId) {
    const error = new Error('feedId and routeId are required for GTFS route analysis.')
    error.statusCode = 400
    throw error
  }
  const context = await gtfsAnalysisStoreContext(projectId, feedId)
  const storeStats = await fs.stat(context.storePath)
  const cacheKey = [context.storePath, storeStats.size, storeStats.mtimeMs, context.sourceScope, routeId, serviceDate].join(':')
  let analysis = gtfsRouteAnalysisCache.get(cacheKey)
  if (!analysis) {
    analysis = readGtfsRouteAnalysis(context.storePath, routeId, {
      sourceScope: context.sourceScope,
      serviceDate: serviceDate || undefined,
    })
    if (!analysis) {
      const error = new Error('No scheduled service patterns were found for this route.')
      error.statusCode = 404
      throw error
    }
    gtfsRouteAnalysisCache.set(cacheKey, analysis)
    while (gtfsRouteAnalysisCache.size > 64) gtfsRouteAnalysisCache.delete(gtfsRouteAnalysisCache.keys().next().value)
  }
  return { feedId: context.feed.id, analysis }
}

function compactProjectMetadata(project) {
  return {
    schemaVersion: project.schemaVersion,
    id: project.id,
    name: project.name,
    region: project.region,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    storagePath: project.storagePath,
    summary: project.summary,
    feeds: (project.feeds ?? []).map(compactFeedMetadata),
    jobs: project.jobs ?? [],
    artifacts: project.artifacts ?? [],
    routingStore: project.routingStore,
    osmStreetIndex: project.osmStreetIndex,
  }
}

async function hydrateProjectSidecars(projectId, project) {
  const metaDir = projectMetaDir(projectId)
  const [jobRecords, artifactRecords] = await Promise.all([
    recoverPersistedNationalJobs(projectId),
    readJsonRecords(path.join(metaDir, 'artifacts')),
  ])
  const hydratedFeeds = await Promise.all(
    (project.feeds ?? []).map(async (storedFeed) => {
      const feed = compactFeedMetadata(storedFeed)
      const context = await feedRoutingStoreContext(projectId, project, feed)
      const normalized = await normalizeFeedRoutingMetadata(projectId, feed, context ?? {})
      return refreshNationalFeedPreview(projectId, normalized, context ?? {})
    }),
  )
  const projectAtlasBudgets = hydratedFeeds.some((feed) => feed.routingStore?.status === 'ready')
    ? allocateProjectTransportAtlasBudgets(hydratedFeeds)
    : new Map()
  const feeds = hydratedFeeds.map((feed) => compactFeedForClient(feed, {
    routingReady: feed.routingStore?.status === 'ready',
    budgets: projectAtlasBudgets.get(feed.id),
  }))
  return {
    ...project,
    feeds,
    jobs: mergeRecords(jobRecords, project.jobs),
    artifacts: mergeRecords(artifactRecords, project.artifacts),
    summary: summaryFromFeeds(feeds, project.summary),
  }
}

async function markStorageInitialized(reason) {
  await writeJsonAtomic(storageStateFile(), {
    schemaVersion: 'vigo.storage.v1',
    reason,
    updatedAt: now(),
  })
}

async function readProjectMetadata(projectId) {
  const projectFile = path.join(projectMetaDir(projectId), 'project.json')
  if (!(await exists(projectFile))) {
    const error = new Error(`Project ${projectId} was not found.`)
    error.statusCode = 404
    throw error
  }

  const project = compactProjectMetadata(await readJson(projectFile))
  project.feeds = await Promise.all((project.feeds ?? []).map(async (feed) => {
    // Keep each feed's own store metadata authoritative in the project record.
    // Hydrated previews may use the merged project store below, but replacing a
    // source feed's fileName with project.sqlite would make a later merge lose
    // the individual GTFS inputs and provenance.
    return normalizeFeedRoutingMetadata(projectId, feed, {
      routingStore: feed.routingStore,
      storePath: feedRoutingStoreFile(projectId, feed),
    })
  }))
  return normalizeProjectStoreMetadata(projectId, project)
}

async function normalizeProjectStoreMetadata(projectId, project) {
  const projectStorePath = projectRoutingStoreFile(projectId, project)
  if (project.routingStore?.status === 'ready') {
    try {
      readNationalGtfsStoreMetadata(projectStorePath)
      const storeStats = await fs.stat(projectStorePath)
      project.routingStore = { ...project.routingStore, bytes: storeStats.size }
    } catch (error) {
      project.routingStore = { ...project.routingStore, status: 'error', error: error.message }
    }
  }
  if (project.osmStreetIndex?.status === 'ready') {
    try {
      const metadata = readNationalOsmStoreMetadata(streetStoreFile(projectId))
      const streetStats = await fs.stat(streetStoreFile(projectId))
      project.osmStreetIndex = { ...project.osmStreetIndex, schemaVersion: metadata.schemaVersion, bytes: streetStats.size }
    } catch (error) {
      project.osmStreetIndex = { ...project.osmStreetIndex, status: 'error', error: error.message }
    }
  }
  return project
}

async function listProjectsRaw({ hydrate = true } = {}) {
  await ensureStorage()
  const entries = await fs.readdir(storageRoot, { withFileTypes: true })
  const projectReads = entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const projectFile = path.join(storageRoot, entry.name, '.vigo', 'project.json')
    if (!(await exists(projectFile))) return null

    try {
      return hydrate ? await readProject(entry.name) : await readProjectMetadata(entry.name)
    } catch {
      // Corrupt project metadata should not prevent the workbench opening.
      return null
    }
  })
  const projects = (await Promise.all(projectReads)).filter(Boolean)

  return projects.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

function listProjects() {
  return listProjectsRaw({ hydrate: false })
}

async function readProject(projectId) {
  const projectFile = path.join(projectMetaDir(projectId), 'project.json')
  if (!(await exists(projectFile))) {
    const error = new Error(`Project ${projectId} was not found.`)
    error.statusCode = 404
    throw error
  }

  return hydrateProjectSidecars(projectId, await normalizeProjectStoreMetadata(projectId, await readJson(projectFile)))
}

async function writeProject(project) {
  const next = {
    ...project,
    schemaVersion: projectSchemaVersion,
    updatedAt: now(),
    storagePath: projectDir(project.id),
  }

  await writeJsonAtomic(path.join(projectMetaDir(project.id), 'project.json'), compactProjectMetadata(next))
  await writeProjectVisibleFiles(next)
  return next
}

function enqueueProjectWrite(projectId, mutation) {
  const previous = projectWriteQueues.get(projectId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(mutation)
  projectWriteQueues.set(projectId, next)
  void next.finally(() => {
    if (projectWriteQueues.get(projectId) === next) projectWriteQueues.delete(projectId)
  }).catch(() => {})
  return next
}

async function createProject(body) {
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled Project'
  const region = typeof body.region === 'string' && body.region.trim() ? body.region.trim() : 'Unassigned region'
  const baseId = slugify(name)
  let id = baseId
  let index = 2

  while (await exists(projectDir(id))) {
    id = `${baseId}-${index}`
    index += 1
  }

  const createdAt = now()
  const project = {
    schemaVersion: projectSchemaVersion,
    id,
    name,
    region,
    createdAt,
    updatedAt: createdAt,
    storagePath: projectDir(id),
    summary: {
      feeds: 0,
      routes: 0,
      stops: 0,
      transferCandidates: 0,
      qualityScore: 0,
    },
    feeds: [],
    jobs: [],
    artifacts: [],
  }

  await fs.mkdir(path.join(projectMetaDir(id), 'jobs'), { recursive: true })
  await fs.mkdir(path.join(projectMetaDir(id), 'artifacts'), { recursive: true })
  await fs.mkdir(path.join(projectMetaDir(id), 'osm'), { recursive: true })
  await fs.mkdir(path.join(projectMetaDir(id), 'routing'), { recursive: true })
  await writeJsonAtomic(path.join(projectMetaDir(id), 'project.json'), project)
  await writeProjectVisibleFiles(project)
  await markStorageInitialized('create-project')
  return project
}

async function updateProject(projectId, body) {
  const project = await readProjectMetadata(projectId)
  const next = { ...project }

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      const error = new Error('Project name is required.')
      error.statusCode = 400
      throw error
    }
    next.name = body.name.trim()
  }

  if (Object.prototype.hasOwnProperty.call(body, 'region')) {
    if (typeof body.region !== 'string' || !body.region.trim()) {
      const error = new Error('Project region is required.')
      error.statusCode = 400
      throw error
    }
    next.region = body.region.trim()
  }

  const updated = await writeProject(next)
  return updated
}

async function deleteProject(projectId) {
  if (cityMaintenance.has(projectId)) {
    const error = new Error('This City is already being modified.')
    error.statusCode = 409
    throw error
  }
  if (nationalImportProjects.has(projectId)) {
    const error = new Error('Wait for the active GTFS or OSM import to finish before removing this City.')
    error.statusCode = 409
    throw error
  }

  cityMaintenance.add(projectId)
  try {
    const project = await readProjectMetadata(projectId)
    invalidateProjectRuntimeCaches(projectId)
    await Promise.all(projectNationalRoutingStorePaths(projectId, project).map((storePath) => (
      nationalRouteWorkerPool.retire(storePath)
    )))
    await fs.rm(projectDir(project.id), { recursive: true, force: true })
    await markStorageInitialized('delete-project')
    return listProjects()
  } finally {
    cityMaintenance.delete(projectId)
  }
}

function addStorageMeasures(...measures) {
  return measures.reduce((total, measure) => ({
    bytes: total.bytes + Number(measure?.bytes ?? 0),
    fileCount: total.fileCount + Number(measure?.fileCount ?? 0),
  }), { bytes: 0, fileCount: 0 })
}

async function measureStoragePath(targetPath) {
  const stats = await fs.lstat(targetPath).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!stats) return { bytes: 0, fileCount: 0 }
  if (!stats.isDirectory()) {
    return { bytes: Number(stats.size ?? 0), fileCount: 1 }
  }
  const entries = await fs.readdir(targetPath, { withFileTypes: true })
  const children = await Promise.all(entries.map((entry) => (
    measureStoragePath(path.join(targetPath, entry.name))
  )))
  return addStorageMeasures(...children)
}

let stagingCleanupCompleted = false

async function removeAbandonedStaging() {
  if (stagingCleanupCompleted) return
  stagingCleanupCompleted = true
  const entries = await fs.readdir(storageRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const targets = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (nationalImportProjects.has(entry.name)) continue
    const targetPath = path.join(storageRoot, entry.name, '.vigo', 'staging')
    if (await exists(targetPath)) targets.push(targetPath)
  }
  await Promise.all(targets.map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })))
}

function invalidateProjectRuntimeCaches(projectId) {
  const projectMetaRoot = `${path.resolve(projectMetaDir(projectId))}${path.sep}`
  for (const [key, entry] of nationalRoutingServiceCoverageCache) {
    if (String(entry?.storePath ?? '').startsWith(projectMetaRoot)) {
      nationalRoutingServiceCoverageCache.delete(key)
    }
  }
  for (const key of nationalPreviewRefreshes.keys()) {
    if (String(key).startsWith(`${projectId}:`)) nationalPreviewRefreshes.delete(key)
  }
  for (const key of gtfsRouteAnalysisCache.keys()) {
    if (String(key).startsWith(projectMetaRoot)) gtfsRouteAnalysisCache.delete(key)
  }
  for (const key of routingStoreSourceScopesCache.keys()) {
    if (String(key).startsWith(projectMetaRoot)) routingStoreSourceScopesCache.delete(key)
  }
}

async function inspectCityData(projectId) {
  const project = await readProjectMetadata(projectId)
  const metaRoot = projectMetaDir(projectId)
  const [timetables, streets, jobs, artifacts, identity] = await Promise.all([
    measureStoragePath(path.join(metaRoot, 'routing')),
    measureStoragePath(path.join(metaRoot, 'osm')),
    measureStoragePath(path.join(metaRoot, 'jobs')),
    measureStoragePath(path.join(metaRoot, 'artifacts')),
    measureStoragePath(path.join(metaRoot, 'project.json')),
  ])
  const knownEntries = new Set(['routing', 'osm', 'jobs', 'artifacts', 'project.json'])
  const entries = await fs.readdir(metaRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const other = addStorageMeasures(...await Promise.all(
    entries
      .filter((entry) => !knownEntries.has(entry.name))
      .map((entry) => measureStoragePath(path.join(metaRoot, entry.name))),
  ))
  const activity = addStorageMeasures(jobs, artifacts)
  const cleanable = addStorageMeasures(timetables, streets, activity, other)

  return {
    schemaVersion: 'vigo.city.data.preview.v1',
    city: {
      id: project.id,
      name: project.name,
      region: project.region,
    },
    estimatedFreedBytes: cleanable.bytes,
    fileCount: cleanable.fileCount,
    managedBytes: cleanable.bytes + identity.bytes,
    activeImport: nationalImportProjects.has(projectId),
    hasData: cleanable.fileCount > 0
      || (project.feeds ?? []).length > 0
      || (project.jobs ?? []).length > 0
      || (project.artifacts ?? []).length > 0
      || Boolean(project.routingStore)
      || Boolean(project.osmStreetIndex),
    counts: {
      feeds: Number(project.summary?.feeds ?? project.feeds?.length ?? 0),
      routes: Number(project.summary?.routes ?? 0),
      stops: Number(project.summary?.stops ?? 0),
    },
    categories: {
      timetables,
      streets,
      activity,
      other,
    },
  }
}

async function resetCityData(projectId, body = {}) {
  if (cityMaintenance.has(projectId)) {
    const error = new Error('This City is already being reset.')
    error.statusCode = 409
    throw error
  }
  cityMaintenance.add(projectId)

  try {
    const project = await readProjectMetadata(projectId)
    if (body.confirmation !== project.name) {
      const error = new Error('Type the exact City name to confirm the reset.')
      error.statusCode = 400
      throw error
    }
    if (nationalImportProjects.has(projectId)) {
      const error = new Error('Wait for the active GTFS or OSM import to finish before resetting this City.')
      error.statusCode = 409
      throw error
    }

    const before = await inspectCityData(projectId)
    const storePaths = projectNationalRoutingStorePaths(projectId, project)
    await Promise.all(storePaths.map((storePath) => nationalRouteWorkerPool.retire(storePath)))
    invalidateProjectRuntimeCaches(projectId)
    for (const [jobId, job] of nationalImportJobs) {
      if (job?.projectId === projectId) nationalImportJobs.delete(jobId)
    }

    const root = projectDir(projectId)
    const metaRoot = projectMetaDir(projectId)
    const quarantine = path.join(root, `.vigo-cleanup-${Date.now()}-${makeId('reset')}`)
    await fs.rename(metaRoot, quarantine)
    try {
      await Promise.all([
        fs.mkdir(path.join(metaRoot, 'jobs'), { recursive: true }),
        fs.mkdir(path.join(metaRoot, 'artifacts'), { recursive: true }),
        fs.mkdir(path.join(metaRoot, 'osm'), { recursive: true }),
        fs.mkdir(path.join(metaRoot, 'routing'), { recursive: true }),
      ])
      await writeProject({
        schemaVersion: projectSchemaVersion,
        id: project.id,
        name: project.name,
        region: project.region,
        createdAt: project.createdAt,
        updatedAt: now(),
        storagePath: projectDir(project.id),
        summary: {
          feeds: 0,
          routes: 0,
          stops: 0,
          transferCandidates: 0,
          qualityScore: 0,
        },
        feeds: [],
        jobs: [],
        artifacts: [],
        routingStore: null,
        osmStreetIndex: null,
      })
    } catch (error) {
      await fs.rm(metaRoot, { recursive: true, force: true }).catch(() => {})
      await fs.rename(quarantine, metaRoot).catch(() => {})
      throw error
    }

    await fs.rm(quarantine, { recursive: true, force: true })
    await markStorageInitialized('reset-city-data')
    invalidateProjectRuntimeCaches(projectId)
    const cleanedProject = await readProject(projectId)
    const after = await inspectCityData(projectId)
    return {
      ok: true,
      city: cleanedProject,
      data: after,
      reset: {
        schemaVersion: 'vigo.city.data.reset.v1',
        completedAt: now(),
        removedFileCount: before.fileCount,
        freedBytes: Math.max(0, before.managedBytes - after.managedBytes),
      },
    }
  } finally {
    cityMaintenance.delete(projectId)
  }
}

async function removeRoutingStoreFamily(storePath) {
  const directory = path.dirname(storePath)
  const fileName = path.basename(storePath)
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(entries
    .filter((entry) => entry.isFile() && (entry.name === fileName || entry.name.startsWith(`${fileName}.`)))
    .map((entry) => fs.rm(path.join(directory, entry.name), { force: true })))
}

async function removeFeedArtifactRecords(projectId, feedIds) {
  if (!feedIds.size) return
  const directory = path.join(projectMetaDir(projectId), 'artifacts')
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json')) return
    const artifactPath = path.join(directory, entry.name)
    const artifact = await readJson(artifactPath).catch(() => null)
    if (!(artifact?.sourceFeedIds ?? []).some((feedId) => feedIds.has(feedId))) return
    await fs.rm(artifactPath, { force: true })
  }))
}

function projectRoutingStorePath(projectId) {
  return path.join(projectMetaDir(projectId), 'routing', 'project.sqlite')
}

function projectRoutingInputsFingerprint(inputs) {
  return [...inputs]
    .map((input) => ({
      scope: String(input.scope ?? ''),
      sourceFingerprint: input.sourceFingerprint || null,
    }))
    .sort((left, right) => left.scope.localeCompare(right.scope))
    .map((input) => `${input.scope}:${input.sourceFingerprint ?? 'unknown'}`)
    .join('|')
}

async function readyProjectRoutingInputs(projectId, project) {
  const inputs = []
  for (const feed of project.feeds ?? []) {
    if (feed?.routingStore?.status !== 'ready') continue
    const candidates = [
      routingStoreFile(projectId, feed.id),
      feedRoutingStoreFile(projectId, feed),
    ]
    const sourcePath = [...new Set(candidates.map((candidate) => path.resolve(candidate)))].find((candidate) => (
      path.basename(candidate) !== 'project.sqlite'
      && existsSync(candidate)
    ))
    if (!sourcePath) continue
    let metadata = null
    try {
      metadata = readNationalGtfsStoreMetadata(sourcePath)
    } catch {}
    inputs.push({
      scope: feed.id,
      storePath: sourcePath,
      sourceFingerprint: String(metadata?.sourceFingerprint ?? ''),
    })
  }
  return inputs
}

async function projectRoutingStoreMatchesInputs(projectId, project, inputs) {
  if (inputs.length < 2 || project.routingStore?.status !== 'ready') return false
  if (path.basename(project.routingStore.fileName || '') !== 'project.sqlite') return false
  const outputPath = projectRoutingStorePath(projectId)
  if (!existsSync(outputPath)) return false
  let metadata
  try {
    metadata = readNationalGtfsStoreMetadata(outputPath)
  } catch {
    return false
  }
  if (metadata.serviceModel !== 'exact-date-multi-feed' || !Array.isArray(metadata.sourceStores)) return false
  const expected = new Map(inputs.map((input) => [input.scope, input.sourceFingerprint]))
  const actual = new Map(metadata.sourceStores.map((source) => [String(source.scope || ''), String(source.sourceFingerprint || '')]))
  if (expected.size !== actual.size) return false
  for (const [scope, fingerprint] of expected) {
    if (!fingerprint || actual.get(scope) !== fingerprint) return false
  }
  return true
}

function projectRoutingStoreStatusMetadata({ status, sourceFingerprint, current, error } = {}) {
  return {
    schemaVersion: 'vigo.routing.store.v1',
    status,
    routingEligibility: current?.routingEligibility,
    fileName: 'project.sqlite',
    bytes: Number(current?.bytes ?? 0),
    connectionCount: Number(current?.connectionCount ?? 0),
    builtAt: now(),
    sourceFingerprint,
    ...(current?.blockingRoutingFeatures ? { blockingRoutingFeatures: current.blockingRoutingFeatures } : {}),
    ...(current?.routingLimitations ? { routingLimitations: current.routingLimitations } : {}),
    ...(error ? { error: String(error) } : {}),
  }
}

function projectRoutingStoreMetadataFromBuild(result) {
  const blockingRoutingFeatures = Array.isArray(result.blockingRoutingFeatures)
    ? result.blockingRoutingFeatures
    : []
  const routingLimitations = Array.isArray(result.routingLimitations)
    ? result.routingLimitations
    : []
  return {
    schemaVersion: result.schemaVersion || 'vigo.routing.store.v1',
    status: 'ready',
    routingEligibility: blockingRoutingFeatures.length
      ? 'unsupported'
      : routingLimitations.length ? 'qualified' : 'exact',
    serviceModel: result.serviceModel,
    fileName: 'project.sqlite',
    bytes: Number(result.bytes ?? 0),
    connectionCount: Number(result.connectionCount ?? 0),
    builtAt: result.builtAt || now(),
    sourceFingerprint: result.sourceFingerprint,
    sourceStores: result.sourceStores,
    sourceFile: result.sourceFile,
    sourceBytes: result.sourceBytes,
    blockingRoutingFeatures,
    routingLimitations,
  }
}

function runNationalGtfsMergeWorker({ stores, outputPath, onProgress, job }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./national-gtfs-worker.mjs', import.meta.url), {
      workerData: { mode: 'merge', stores, outputPath },
    })
    if (job) {
      Object.defineProperty(job, 'cancelWorker', {
        configurable: true,
        enumerable: false,
        value: () => worker.terminate().catch(() => {}),
      })
      if (job.cancelRequested) void worker.terminate()
    }
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    worker.on('message', (message) => {
      if (job?.cancelRequested) return
      if (message?.type === 'progress') {
        onProgress?.(message.progress)
      } else if (message?.type === 'complete') {
        settle(resolve, message.result)
      } else if (message?.type === 'failed') {
        settle(reject, new Error(message.error || 'GTFS merge failed.'))
      }
    })
    worker.on('error', (error) => settle(reject, error))
    worker.on('exit', (code) => {
      if (!settled) settle(reject, new Error(`GTFS merge worker exited before completion (code ${code}).`))
    })
  })
}

async function buildProjectRoutingStore(projectId, { job, requestedServiceDate, requestedServiceDay } = {}) {
  if (!job?.projectId) throw new Error('A project routing merge requires a persisted job.')
  const projectFile = path.join(projectMetaDir(projectId), 'project.json')
  const project = await readJson(projectFile)
  const inputs = await readyProjectRoutingInputs(projectId, project)
  const sourceFingerprint = projectRoutingInputsFingerprint(inputs)

  if (inputs.length >= 2 && await projectRoutingStoreMatchesInputs(projectId, project, inputs)) {
    return {
      reused: true,
      routingStore: project.routingStore,
      sourceStores: inputs,
    }
  }

  if (inputs.length === 0) {
    await enqueueProjectWrite(projectId, async () => {
      const current = await readJson(projectFile)
      return writeProject({ ...current, routingStore: null })
    })
    invalidateProjectRuntimeCaches(projectId)
    return { reused: false, routingStore: null, sourceStores: [] }
  }

  if (inputs.length === 1) {
    const input = inputs[0]
    const metadata = readNationalGtfsStoreMetadata(input.storePath)
    const routingStore = {
      ...projectRoutingStoreMetadataFromBuild({ ...metadata, bytes: (await fs.stat(input.storePath)).size }),
      fileName: path.basename(input.storePath),
      sourceFingerprint: metadata.sourceFingerprint,
    }
    const outputPath = projectRoutingStorePath(projectId)
    if (path.resolve(outputPath) !== path.resolve(input.storePath)) {
      await nationalRouteWorkerPool.retire(outputPath)
      await removeRoutingStoreFamily(outputPath)
    }
    await enqueueProjectWrite(projectId, async () => {
      const current = await readJson(projectFile)
      return writeProject({ ...current, routingStore })
    })
    invalidateProjectRuntimeCaches(projectId)
    return { reused: false, routingStore, sourceStores: inputs }
  }

  const outputPath = projectRoutingStorePath(projectId)
  const buildingRoutingStore = projectRoutingStoreStatusMetadata({
    status: 'building',
    sourceFingerprint,
    current: project.routingStore,
  })
  await enqueueProjectWrite(projectId, async () => {
    const current = await readJson(projectFile)
    return writeProject({ ...current, routingStore: buildingRoutingStore })
  })
  await nationalRouteWorkerPool.retire(outputPath)

  try {
    Object.assign(job, {
      phase: 'Combining exact GTFS timetable stores',
      progress: 0.78,
      detail: `${inputs.length} ready GTFS feeds`,
      updatedAt: now(),
    })
    await persistNationalJob(projectId, job)
    const mergeResult = await runNationalGtfsMergeWorker({
      stores: inputs,
      outputPath,
      job,
      onProgress: (progress) => {
        Object.assign(job, {
          phase: progress?.phase || 'Combining exact GTFS timetable stores',
          progress: 0.78 + Math.max(0, Math.min(1, Number(progress?.progress ?? 0))) * 0.14,
          detail: progress?.detail ?? job.detail,
          updatedAt: now(),
        })
      },
    })
    let osmStopTransfers = null
    const currentAfterMerge = await readJson(projectFile)
    const streetStorePath = currentAfterMerge.osmStreetIndex?.status === 'ready'
      && await exists(streetStoreFile(projectId))
      ? streetStoreFile(projectId)
      : ''
    if (streetStorePath) {
      Object.assign(job, {
        phase: 'Building exact pedestrian stop transfers for the combined timetable',
        progress: 0.93,
        detail: 'Linking every ready feed to the project street graph',
        updatedAt: now(),
      })
      await persistNationalJob(projectId, job)
      const prepared = await nationalRouteWorkerPool.dispatch(
        outputPath,
        'prepare-transfers',
        { streetStorePath },
        undefined,
        (progress) => {
          const fraction = Math.max(0, Math.min(1, Number(progress?.progress ?? 0)))
          Object.assign(job, {
            phase: progress?.phase || 'Building exact pedestrian stop transfers for the combined timetable',
            progress: 0.93 + fraction * 0.055,
            detail: progress?.detail ?? job.detail,
            updatedAt: now(),
          })
        },
      )
      osmStopTransfers = prepared.osmStopTransfers
    }
    const preload = await preloadNationalBuiltStore({
      storePath: outputPath,
      streetStorePath,
      requestedServiceDate,
      requestedServiceDay,
      job,
    })
    const routingStore = projectRoutingStoreMetadataFromBuild(mergeResult)
    await enqueueProjectWrite(projectId, async () => {
      const current = await readJson(projectFile)
      return writeProject({ ...current, routingStore })
    })
    invalidateProjectRuntimeCaches(projectId)
    return { reused: false, routingStore, sourceStores: inputs, mergeResult, osmStopTransfers, preload }
  } catch (error) {
    await nationalRouteWorkerPool.retire(outputPath).catch(() => {})
    await removeRoutingStoreFamily(outputPath).catch(() => {})
    await enqueueProjectWrite(projectId, async () => {
      const current = await readJson(projectFile).catch(() => project)
      return writeProject({
        ...current,
        routingStore: projectRoutingStoreStatusMetadata({
          status: 'failed',
          sourceFingerprint,
          current: current.routingStore,
          error: error instanceof Error ? error.message : String(error),
        }),
      })
    }).catch(() => {})
    invalidateProjectRuntimeCaches(projectId)
    throw error
  }
}

async function commitIndexedFeed(projectId, body, options = {}) {
  const project = await readProjectMetadata(projectId)
  const feedId = typeof body.id === 'string' && body.id ? body.id : makeId('feed')
  const replacedFeedIds = new Set(options.replaceFeedIds ?? [])
  const importedAt = now()
  const feed = {
    ...body,
    id: feedId,
    importedAt,
    source: body.source ?? 'local-file',
  }

  const storePath = routingStoreFile(projectId, feedId)
  if (feed.routingStore?.status !== 'ready' || !await exists(storePath)) {
    const error = new Error('A verified SQLite routing store is required before a GTFS feed can be committed.')
    error.statusCode = 500
    throw error
  }
  const storeStats = await fs.stat(storePath)
  const indexedFeed = compactIndexedFeed({
    ...feed,
    routingStore: { ...feed.routingStore, fileName: path.basename(storePath), bytes: storeStats.size },
  })
  const feeds = [
    indexedFeed,
    ...project.feeds.filter((item) => item.id !== feedId && !replacedFeedIds.has(item.id)),
  ]
  const summary = {
    feeds: feeds.length,
    routes: feeds.reduce((sum, item) => sum + Number(item.routeCount ?? 0), 0),
    stops: feeds.reduce((sum, item) => sum + Number(item.stopCount ?? 0), 0),
    transferCandidates: feeds.reduce((sum, item) => sum + Number(item.transferCandidates ?? 0), 0),
    qualityScore: feeds.length
      ? Math.round(feeds.reduce((sum, item) => sum + Number(item.qualityScore ?? 0), 0) / feeds.length)
      : 0,
  }

  const artifact = {
    id: makeId('artifact'),
    schemaVersion: artifactSchemaVersion,
    type: 'validation-summary',
    title: `${feed.name ?? feed.fileName ?? 'Imported feed'} validation`,
    createdAt: importedAt,
    sourceFeedIds: [feedId],
  }

  await writeJsonAtomic(path.join(projectMetaDir(projectId), 'artifacts', `${artifact.id}.json`), {
    ...artifact,
    payload: {
      qualityScore: feed.qualityScore,
      requiredTables: feed.requiredTables,
      optionalTables: feed.optionalTables,
      warnings: feed.warnings,
      tides: feed.tides,
    },
  })

  const retainedArtifacts = (project.artifacts ?? []).filter(
    (candidate) => !(candidate.sourceFeedIds ?? []).some((sourceFeedId) => replacedFeedIds.has(sourceFeedId)),
  )
  const previousStorePaths = options.promoteToProjectStore === true
    ? projectNationalRoutingStorePaths(projectId, project)
    : []
  const updated = await writeProject({
    ...project,
    summary,
    feeds,
    artifacts: [artifact, ...retainedArtifacts],
    ...(options.promoteToProjectStore === true ? {
      routingStore: indexedFeed.routingStore,
      osmStreetIndex: project.osmStreetIndex,
    } : {}),
  })
  if (options.promoteToProjectStore === true) {
    const currentStorePath = routingStoreFile(projectId, feedId)
    const obsoleteStorePaths = previousStorePaths.filter(
      (candidate) => path.resolve(candidate) !== path.resolve(currentStorePath),
    )
    await Promise.all(obsoleteStorePaths.map((candidate) => nationalRouteWorkerPool.retire(candidate)))
    await Promise.all(obsoleteStorePaths.map(removeRoutingStoreFamily))
    await removeFeedArtifactRecords(projectId, replacedFeedIds)
    await fs.rm(path.join(projectMetaDir(projectId), 'rebuild-manifest.json'), { force: true })
  }
  return updated
}

async function persistNationalJob(projectId, job) {
  updateNationalJobTelemetry(job)
  nationalImportJobs.set(job.id, job)
  await writeJsonAtomic(path.join(projectMetaDir(projectId), 'jobs', `${job.id}.json`), job, { pretty: false })
}

async function persistNationalJobProgress(projectId, job) {
  // Progress events can arrive much faster than the UI needs them. Keep the
  // live in-memory record current, but cap metadata writes to reduce preparation
  // overhead on large imports; terminal transitions always use the full writer.
  updateNationalJobTelemetry(job)
  nationalImportJobs.set(job.id, job)
  const observedAt = Date.now()
  const lastPersistedAt = nationalJobProgressPersistedAt.get(job) ?? 0
  if (observedAt - lastPersistedAt < 250) return
  nationalJobProgressPersistedAt.set(job, observedAt)
  await writeJsonAtomic(path.join(projectMetaDir(projectId), 'jobs', `${job.id}.json`), job, { pretty: false })
}

function jobIsTerminal(job) {
  return ['complete', 'failed', 'cancelled'].includes(String(job?.status ?? ''))
}

function updateNationalJobTelemetry(job) {
  if (!job || typeof job !== 'object') return
  const observedAt = Date.now()
  const phase = String(job.phase || 'preparation')
  const createdAtMs = Date.parse(String(job.createdAt || ''))
  const state = job.__telemetry ?? {
    phase,
    phaseStartedAt: Number.isFinite(createdAtMs) ? createdAtMs : observedAt,
    finalized: false,
  }
  const phaseTimingsMs = { ...(job.phaseTimingsMs ?? {}) }
  if (state.phase !== phase) {
    phaseTimingsMs[state.phase] = Number(phaseTimingsMs[state.phase] ?? 0)
      + Math.max(0, observedAt - state.phaseStartedAt)
    state.phase = phase
    state.phaseStartedAt = observedAt
  }
  job.schemaVersion = jobSchemaVersion
  job.phaseTimingsMs = phaseTimingsMs
  job.phaseStartedAt = new Date(state.phaseStartedAt).toISOString()
  if (jobIsTerminal(job) && !state.finalized) {
    phaseTimingsMs[phase] = Number(phaseTimingsMs[phase] ?? 0)
      + Math.max(0, observedAt - state.phaseStartedAt)
    state.finalized = true
    const totalMs = Number.isFinite(createdAtMs)
      ? Math.max(0, observedAt - createdAtMs)
      : Object.values(phaseTimingsMs).reduce((sum, value) => sum + Number(value || 0), 0)
    job.preparation = {
      schemaVersion: 'vigo.preparation.v1',
      totalMs,
      phaseTimingsMs: { ...phaseTimingsMs },
      completedAt: job.finishedAt || new Date(observedAt).toISOString(),
    }
  }
  Object.defineProperty(job, '__telemetry', {
    value: state,
    configurable: true,
    writable: true,
    enumerable: false,
  })
}

function recoverableNationalJob(job) {
  return Boolean(
    job?.retrySourcePath
    || job?.sourcePath
    || job?.kind === 'national-gtfs-merge',
  )
}

async function recoverPersistedNationalJobs(projectId) {
  const records = await readJsonRecords(path.join(projectMetaDir(projectId), 'jobs'))
  for (const job of records) {
    if (!job?.id || !['queued', 'running'].includes(job.status) || nationalImportJobs.has(job.id)) continue
    Object.assign(job, {
      schemaVersion: jobSchemaVersion,
      status: 'failed',
      phase: 'Preparation interrupted',
      error: 'VIGO was restarted before this preparation job finished. Retry the preserved source to continue.',
      failureCode: 'preparation_interrupted',
      retryable: recoverableNationalJob(job),
      finishedAt: now(),
      updatedAt: now(),
    })
    await persistNationalJob(projectId, job)
  }
  return records
}

function activeNationalProjectJob(projectId, kind) {
  return [...nationalImportJobs.values()].find((job) => (
    job?.projectId === projectId
    && job.kind === kind
    && ['queued', 'running'].includes(job.status)
  ))
}

function reserveNationalImportProject(projectId, kind) {
  const activeKinds = nationalImportProjects.get(projectId) ?? new Set()
  if (activeKinds.has(kind)) {
    const label = kind === 'osm' ? 'OSM' : 'GTFS'
    const error = new Error(`This project already has a ${label} import in progress.`)
    error.statusCode = 409
    throw error
  }
  activeKinds.add(kind)
  nationalImportProjects.set(projectId, activeKinds)
}

function releaseNationalImportProject(projectId, kind) {
  const activeKinds = nationalImportProjects.get(projectId)
  if (!activeKinds) return
  activeKinds.delete(kind)
  if (!activeKinds.size) nationalImportProjects.delete(projectId)
}

function cleanupUploadedSource(sourcePath, enabled) {
  let removed = false
  return async () => {
    if (!enabled || removed) return
    removed = true
    await fs.rm(sourcePath, { force: true }).catch(() => {})
  }
}

async function launchNationalImportWorker(projectId, kind, job, workerUrl, workerData) {
  try {
    await persistNationalJob(projectId, job)
    return new Worker(workerUrl, { workerData })
  } catch (error) {
    releaseNationalImportProject(projectId, kind)
    throw error
  }
}

async function stageUploadedProjectFile(projectId, request, { kind, extensions }) {
  await readProjectMetadata(projectId)
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const requestedName = path.basename(url.searchParams.get('fileName') || '')
  const fileName = requestedName.replace(/[^a-zA-Z0-9._ -]/g, '-').trim()
  if (!fileName || !extensions.some((extension) => fileName.toLowerCase().endsWith(extension))) {
    const error = new Error(`Choose a ${extensions.join(' or ')} source file.`)
    error.statusCode = 400
    throw error
  }

  const declaredBytes = Number(request.headers['content-length'] ?? 0)
  if (declaredBytes > maxSourceUploadBytes) {
    const error = new Error(`Source file exceeds the ${Math.round(maxSourceUploadBytes / 1_000_000_000)} GB local upload limit.`)
    error.statusCode = 413
    throw error
  }

  const stagingDirectory = path.join(projectMetaDir(projectId), 'staging')
  await fs.mkdir(stagingDirectory, { recursive: true })
  const stagedPath = path.join(stagingDirectory, `${makeId(kind)}-${fileName}`)
  const writingPath = `${stagedPath}.uploading`
  const handle = await fs.open(writingPath, 'wx')
  let byteLength = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += buffer.byteLength
      if (byteLength > maxSourceUploadBytes) {
        const error = new Error(`Source file exceeds the ${Math.round(maxSourceUploadBytes / 1_000_000_000)} GB local upload limit.`)
        error.statusCode = 413
        throw error
      }
      await handle.write(buffer)
    }
    if (!byteLength) {
      const error = new Error('The uploaded source file is empty.')
      error.statusCode = 400
      throw error
    }
    await handle.sync()
    await handle.close()
    await fs.rename(writingPath, stagedPath)
    return {
      sourcePath: stagedPath,
      cleanupSource: true,
      sourceBytes: byteLength,
      fileName,
      ...(kind === 'gtfs' && url.searchParams.get('replaceProjectSchedule') === 'true'
        ? { replaceProjectSchedule: true }
        : {}),
      ...(kind === 'gtfs' && url.searchParams.get('preloadServiceDate')
        ? { preloadServiceDate: url.searchParams.get('preloadServiceDate') }
        : {}),
      ...(kind === 'gtfs' && url.searchParams.get('preloadServiceDay')
        ? { preloadServiceDay: url.searchParams.get('preloadServiceDay') }
        : {}),
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.rm(writingPath, { force: true }).catch(() => {})
    throw error
  }
}

async function startNationalGtfsImport(projectId, body) {
  const sourcePath = path.resolve(String(body?.sourcePath ?? ''))
  const cleanupSource = body?.cleanupSource === true
  const sourceName = path.basename(String(body?.fileName || sourcePath))
  const sourceStats = await fs.stat(sourcePath).catch(() => null)
  if (!sourceStats?.isFile() || !/\.zip$/i.test(sourcePath)) {
    const error = new Error('Choose a readable GTFS ZIP file.')
    error.statusCode = 400
    throw error
  }
  const project = await readProjectMetadata(projectId)
  reserveNationalImportProject(projectId, 'gtfs')
  const streetStorePath = (
    project.osmStreetIndex?.status === 'ready'
    && await exists(streetStoreFile(projectId))
  )
    ? streetStoreFile(projectId)
    : ''
  const replaceProjectSchedule = body?.replaceProjectSchedule === true
  const replaceFeedIds = replaceProjectSchedule ? project.feeds.map((feed) => feed.id) : []
  const feedId = makeId('feed')
  const job = {
    schemaVersion: jobSchemaVersion,
    id: makeId('national_gtfs'),
    kind: 'national-gtfs-import',
    label: sourceName,
    status: 'running',
    phase: 'Starting GTFS routing-store build',
    progress: 0,
    detail: '',
    createdAt: now(),
    projectId,
    sourcePath: cleanupSource ? undefined : sourcePath,
    retrySourcePath: sourcePath,
    sourceFile: sourceName,
    stagedUpload: cleanupSource,
    feedId,
    preloadServiceDate: body?.preloadServiceDate,
    preloadServiceDay: body?.preloadServiceDay,
    retryable: true,
    ...(replaceProjectSchedule ? { replaceProjectSchedule, replaceFeedIds } : {}),
  }
  const outputPath = routingStoreFile(projectId, feedId)
  let committed = false
  const removeUploadedSource = cleanupUploadedSource(sourcePath, cleanupSource)
  const worker = await launchNationalImportWorker(
    projectId,
    'gtfs',
    job,
    new URL('./national-gtfs-worker.mjs', import.meta.url),
    { zipPath: sourcePath, outputPath },
  )
  let terminalMessageReceived = false
  worker.on('message', async (message) => {
    try {
      if (job.cancelRequested) return
      if (message?.type === 'progress') {
        Object.assign(job, {
          phase: message.progress.phase,
          progress: Number(message.progress.progress ?? job.progress),
          detail: message.progress.detail ?? '',
          rssBytes: Number(message.progress.memory ?? 0),
          updatedAt: now(),
        })
        await persistNationalJobProgress(projectId, job)
      } else if (message?.type === 'complete') {
        terminalMessageReceived = true
        if (job.cancelRequested) return
        const importResult = { ...message.result, sourceFile: sourceName }
        let osmStopTransfers = null
        if (streetStorePath) {
          Object.assign(job, {
            phase: 'Building exact pedestrian stop transfers',
            progress: 0.94,
            detail: 'Preparing the imported timetable against the project street graph',
            updatedAt: now(),
          })
          await persistNationalJob(projectId, job)
          const prepared = await nationalRouteWorkerPool.dispatch(
            outputPath,
            'prepare-transfers',
            { streetStorePath },
            undefined,
            (progress) => {
              const fraction = Math.max(0, Math.min(1, Number(progress?.progress ?? 0)))
              Object.assign(job, {
                phase: progress?.phase || 'Building exact pedestrian stop transfers',
                progress: 0.94 + fraction * 0.055,
                detail: progress?.detail ?? job.detail,
                updatedAt: now(),
              })
            },
          )
          osmStopTransfers = prepared.osmStopTransfers
          if (job.cancelRequested) return
          Object.assign(job, {
            phase: 'Publishing routing store',
            progress: 0.995,
            detail: `${Number(osmStopTransfers?.edgeCount ?? 0).toLocaleString()} directed pedestrian transfers`,
            updatedAt: now(),
          })
          await persistNationalJob(projectId, job)
        }
        const preload = await preloadNationalBuiltStore({
          storePath: outputPath,
          streetStorePath,
          requestedServiceDate: body?.preloadServiceDate,
          requestedServiceDay: body?.preloadServiceDay,
          job,
        })
        if (job.cancelRequested) return
        const feed = nationalFeedSummary(outputPath, importResult, feedId)
        await enqueueProjectWrite(projectId, () => commitIndexedFeed(projectId, feed, {
          replaceFeedIds,
          promoteToProjectStore: replaceProjectSchedule,
        }))
        committed = true
        if (job.cancelRequested) return
        const projectRouting = await buildProjectRoutingStore(projectId, {
          job,
          requestedServiceDate: body?.preloadServiceDate,
          requestedServiceDay: body?.preloadServiceDay,
        })
        Object.assign(job, {
          status: 'complete', phase: 'Routing store ready', progress: 1,
          detail: `${Number(projectRouting.routingStore?.connectionCount ?? message.result.connectionCount).toLocaleString()} combined connections`,
          result: {
            feedId,
            store: feed.routingStore,
            combinedStore: projectRouting.routingStore,
            combinedSourceStores: projectRouting.sourceStores,
            buildSeconds: message.result.buildSeconds,
            ...(osmStopTransfers ? { osmStopTransfers } : {}),
            preload,
            ...(projectRouting.mergeResult ? { merge: projectRouting.mergeResult } : {}),
            ...(projectRouting.osmStopTransfers ? { combinedOsmStopTransfers: projectRouting.osmStopTransfers } : {}),
            ...(projectRouting.preload ? { combinedPreload: projectRouting.preload } : {}),
          },
          finishedAt: now(),
          updatedAt: now(),
        })
        await removeUploadedSource()
        await persistNationalJob(projectId, job)
        releaseNationalImportProject(projectId, 'gtfs')
      } else if (message?.type === 'failed') {
        terminalMessageReceived = true
        Object.assign(job, { status: 'failed', phase: 'Import failed', error: message.error ?? 'Unknown import error', finishedAt: now(), updatedAt: now() })
        await removeRoutingStoreFamily(outputPath)
        await persistNationalJob(projectId, job)
        releaseNationalImportProject(projectId, 'gtfs')
      }
    } catch (error) {
      if (job.cancelRequested) return
      Object.assign(job, { status: 'failed', phase: 'Import failed', error: error instanceof Error ? error.stack || error.message : String(error), finishedAt: now(), updatedAt: now() })
      if (!committed) await removeRoutingStoreFamily(outputPath).catch(() => {})
      await persistNationalJob(projectId, job).catch(() => {})
      releaseNationalImportProject(projectId, 'gtfs')
    }
  })
  worker.on('error', async (error) => {
    if (job.cancelRequested) return
    terminalMessageReceived = true
    Object.assign(job, { status: 'failed', phase: 'Import failed', error: error.stack || error.message, finishedAt: now(), updatedAt: now() })
    if (!committed) await removeRoutingStoreFamily(outputPath).catch(() => {})
    await persistNationalJob(projectId, job).catch(() => {})
    releaseNationalImportProject(projectId, 'gtfs')
  })
  worker.on('exit', async (code) => {
    if (terminalMessageReceived || job.cancelRequested || job.status !== 'running') return
    Object.assign(job, {
      status: 'failed',
      phase: 'Import failed',
      error: `GTFS import worker exited before completion (code ${code}).`,
      finishedAt: now(),
      updatedAt: now(),
    })
    if (!committed) await removeRoutingStoreFamily(outputPath).catch(() => {})
    await persistNationalJob(projectId, job).catch(() => {})
    releaseNationalImportProject(projectId, 'gtfs')
  })
  Object.defineProperty(job, 'cancel', {
    configurable: true,
    enumerable: false,
    value: async () => {
      if (jobIsTerminal(job)) return job
      if (committed) return job
      job.cancelRequested = true
      terminalMessageReceived = true
      await worker.terminate().catch(() => {})
      if (!committed) await removeRoutingStoreFamily(outputPath).catch(() => {})
      Object.assign(job, {
        status: 'cancelled',
        phase: 'Preparation cancelled',
        error: 'Preparation was cancelled. The source was kept so it can be retried.',
        failureCode: 'preparation_cancelled',
        retryable: true,
        finishedAt: now(),
        updatedAt: now(),
      })
      await persistNationalJob(projectId, job).catch(() => {})
      releaseNationalImportProject(projectId, 'gtfs')
      return job
    },
  })
  return job
}

async function startNationalGtfsMerge(projectId, body = {}) {
  const projectFile = path.join(projectMetaDir(projectId), 'project.json')
  const project = await readJson(projectFile)
  const inputs = await readyProjectRoutingInputs(projectId, project)
  if (inputs.length < 2) {
    const error = new Error('At least two ready GTFS feeds are required before building a combined routing store.')
    error.statusCode = 409
    throw error
  }
  if (await projectRoutingStoreMatchesInputs(projectId, project, inputs)) {
    const job = {
      schemaVersion: jobSchemaVersion,
      id: makeId('national_gtfs_merge'),
      kind: 'national-gtfs-merge',
      label: 'Combined GTFS routing store',
      status: 'complete',
      phase: 'Routing store ready',
      progress: 1,
      detail: `${inputs.length} GTFS feeds already combined`,
      createdAt: now(),
      finishedAt: now(),
      updatedAt: now(),
      projectId,
      preloadServiceDate: body.preloadServiceDate,
      preloadServiceDay: body.preloadServiceDay,
      result: { combinedStore: project.routingStore, combinedSourceStores: inputs },
    }
    await persistNationalJob(projectId, job)
    return job
  }
  const activeMerge = activeNationalProjectJob(projectId, 'national-gtfs-merge')
  if (activeMerge) return activeMerge
  reserveNationalImportProject(projectId, 'gtfs')
  const job = {
    schemaVersion: jobSchemaVersion,
    id: makeId('national_gtfs_merge'),
    kind: 'national-gtfs-merge',
    label: 'Combined GTFS routing store',
    status: 'running',
    phase: 'Preparing combined exact timetable',
    progress: 0.02,
    detail: `${inputs.length} ready GTFS feeds`,
    createdAt: now(),
    projectId,
    sourceFeedIds: inputs.map((input) => input.scope),
    preloadServiceDate: body.preloadServiceDate,
    preloadServiceDay: body.preloadServiceDay,
    retryable: true,
  }
  const buildingRoutingStore = projectRoutingStoreStatusMetadata({
    status: 'building',
    sourceFingerprint: projectRoutingInputsFingerprint(inputs),
    current: project.routingStore,
  })
  try {
    await enqueueProjectWrite(projectId, async () => {
      const current = await readJson(projectFile)
      return writeProject({ ...current, routingStore: buildingRoutingStore })
    })
    await persistNationalJob(projectId, job)
  } catch (error) {
    releaseNationalImportProject(projectId, 'gtfs')
    throw error
  }

  Object.defineProperty(job, 'cancel', {
    configurable: true,
    enumerable: false,
    value: async () => {
      if (jobIsTerminal(job)) return job
      job.cancelRequested = true
      await job.cancelWorker?.()
      Object.assign(job, {
        status: 'cancelled',
        phase: 'Preparation cancelled',
        error: 'Combined routing preparation was cancelled. Retry it when the feeds are ready.',
        failureCode: 'preparation_cancelled',
        retryable: true,
        finishedAt: now(),
        updatedAt: now(),
      })
      await persistNationalJob(projectId, job).catch(() => {})
      releaseNationalImportProject(projectId, 'gtfs')
      return job
    },
  })

  void (async () => {
    try {
      if (job.cancelRequested) return
      const result = await buildProjectRoutingStore(projectId, {
        job,
        requestedServiceDate: body.preloadServiceDate,
        requestedServiceDay: body.preloadServiceDay,
      })
      if (job.cancelRequested) return
      Object.assign(job, {
        status: 'complete',
        phase: 'Routing store ready',
        progress: 1,
        detail: `${Number(result.routingStore?.connectionCount ?? 0).toLocaleString()} combined connections`,
        result: {
          combinedStore: result.routingStore,
          combinedSourceStores: result.sourceStores,
          ...(result.mergeResult ? { merge: result.mergeResult } : {}),
          ...(result.osmStopTransfers ? { osmStopTransfers: result.osmStopTransfers } : {}),
          ...(result.preload ? { preload: result.preload } : {}),
        },
        finishedAt: now(),
        updatedAt: now(),
      })
    } catch (error) {
      if (job.cancelRequested) return
      Object.assign(job, {
        status: 'failed',
        phase: 'Combined routing-store build failed',
        error: error instanceof Error ? error.stack || error.message : String(error),
        finishedAt: now(),
        updatedAt: now(),
      })
    }
    await persistNationalJob(projectId, job).catch(() => {})
    releaseNationalImportProject(projectId, 'gtfs')
  })()
  return job
}

async function startNationalOsmImport(projectId, body) {
  const sourcePath = path.resolve(String(body?.sourcePath ?? ''))
  const cleanupSource = body?.cleanupSource === true
  const sourceName = path.basename(String(body?.fileName || sourcePath))
  const sourceStats = await fs.stat(sourcePath).catch(() => null)
  if (!sourceStats?.isFile() || !/\.pbf$/i.test(sourcePath)) {
    const error = new Error('Choose a readable OpenStreetMap PBF file.')
    error.statusCode = 400
    throw error
  }
  await readProjectMetadata(projectId)
  reserveNationalImportProject(projectId, 'osm')
  const job = {
    schemaVersion: jobSchemaVersion,
    id: makeId('national_osm'), kind: 'national-osm-import', label: sourceName, status: 'running',
    phase: 'Starting walk and drive street-index build', progress: 0, detail: '', createdAt: now(),
    sourcePath: cleanupSource ? undefined : sourcePath,
    retrySourcePath: sourcePath,
    sourceFile: sourceName,
    stagedUpload: cleanupSource,
    projectId,
    retryable: true,
  }
  const outputPath = streetStoreFile(projectId)
  const removeUploadedSource = cleanupUploadedSource(sourcePath, cleanupSource)
  const worker = await launchNationalImportWorker(
    projectId,
    'osm',
    job,
    new URL('./national-osm-worker.mjs', import.meta.url),
    {
      pbfPath: sourcePath,
      outputPath,
      buildDrivingProfile: true,
    },
  )
  let terminalMessageReceived = false
  worker.on('message', async (message) => {
    try {
      if (job.cancelRequested) return
      if (message?.type === 'progress') {
        Object.assign(job, { phase: message.progress.phase, progress: Number(message.progress.progress ?? job.progress), detail: message.progress.detail ?? '', rssBytes: Number(message.progress.memory ?? 0), updatedAt: now() })
      } else if (message?.type === 'complete') {
        terminalMessageReceived = true
        if (job.cancelRequested) return
        const project = await enqueueProjectWrite(projectId, async () => {
          const current = await readProjectMetadata(projectId)
          return writeProject({ ...current, osmStreetIndex: {
            schemaVersion: message.result.schemaVersion, status: 'ready', fileName: sourceName,
            sourceModel: message.result.sourceModel,
            sourceBytes: message.result.sourceBytes,
            sourceFingerprint: message.result.sourceFingerprint,
            bytes: message.result.bytes, nodeCount: message.result.nodeCount,
            storageLayout: message.result.storageLayout,
            runtimeCompaction: message.result.runtimeCompaction,
            walkNodeCount: message.result.walkNodeCount,
            edgeCount: message.result.edgeCount, wayCount: message.result.wayCount,
            driveNodeCount: message.result.driveNodeCount,
            driveEdgeCount: message.result.driveEdgeCount,
            driveWayCount: message.result.driveWayCount,
            drivingWeightModel: message.result.drivingWeightModel,
            walkAccelerator: message.result.walkAccelerator,
            driveAccelerator: message.result.driveAccelerator,
            driveSnapshot: message.result.driveSnapshot,
            cch: message.result.cch,
            directionRestrictedWayCount: message.result.directionRestrictedWayCount,
            directionExcludedWayCount: message.result.directionExcludedWayCount,
            uncertainConveyingWayCount: message.result.uncertainConveyingWayCount,
            builtAt: message.result.builtAt,
          } })
        })
        if (job.cancelRequested) return
        await Promise.all(projectNationalRoutingStorePaths(projectId, project).map((storePath) => (
          nationalRouteWorkerPool.retire(storePath)
        )))
        Object.assign(job, { status: 'complete', phase: 'Street index ready', progress: 1, detail: `${message.result.edgeCount.toLocaleString()} walk + ${message.result.driveEdgeCount.toLocaleString()} drive edges`, result: { ...message.result, sourceFile: sourceName }, finishedAt: now(), updatedAt: now() })
        await removeUploadedSource()
      } else if (message?.type === 'failed') {
        terminalMessageReceived = true
        Object.assign(job, { status: 'failed', phase: 'Street indexing failed', error: message.error ?? 'Unknown OSM error', finishedAt: now(), updatedAt: now() })
      }
      if (message?.type === 'progress') await persistNationalJobProgress(projectId, job)
      else await persistNationalJob(projectId, job)
      if (job.status !== 'running') releaseNationalImportProject(projectId, 'osm')
    } catch (error) {
      if (job.cancelRequested) return
      Object.assign(job, { status: 'failed', phase: 'Street indexing failed', error: error instanceof Error ? error.stack || error.message : String(error), finishedAt: now(), updatedAt: now() })
      await persistNationalJob(projectId, job).catch(() => {})
      releaseNationalImportProject(projectId, 'osm')
    }
  })
  worker.on('error', async (error) => {
    if (job.cancelRequested) return
    terminalMessageReceived = true
    Object.assign(job, { status: 'failed', phase: 'Street indexing failed', error: error.stack || error.message, finishedAt: now(), updatedAt: now() })
    await persistNationalJob(projectId, job).catch(() => {})
    releaseNationalImportProject(projectId, 'osm')
  })
  worker.on('exit', async (code) => {
    if (terminalMessageReceived || job.cancelRequested || job.status !== 'running') return
    Object.assign(job, {
      status: 'failed',
      phase: 'Street indexing failed',
      error: `OSM import worker exited before completion (code ${code}).`,
      finishedAt: now(),
      updatedAt: now(),
    })
    await persistNationalJob(projectId, job).catch(() => {})
    releaseNationalImportProject(projectId, 'osm')
  })
  Object.defineProperty(job, 'cancel', {
    configurable: true,
    enumerable: false,
    value: async () => {
      if (jobIsTerminal(job)) return job
      job.cancelRequested = true
      terminalMessageReceived = true
      await worker.terminate().catch(() => {})
      Object.assign(job, {
        status: 'cancelled',
        phase: 'Preparation cancelled',
        error: 'Preparation was cancelled. The source was kept so it can be retried.',
        failureCode: 'preparation_cancelled',
        retryable: true,
        finishedAt: now(),
        updatedAt: now(),
      })
      await persistNationalJob(projectId, job).catch(() => {})
      releaseNationalImportProject(projectId, 'osm')
      return job
    },
  })
  return job
}

async function readNationalImportJob(projectId, jobId) {
  const memoryJob = nationalImportJobs.get(jobId)
  if (memoryJob?.projectId === projectId) return memoryJob
  if (memoryJob) {
    const error = new Error('National import job was not found for this project.')
    error.statusCode = 404
    throw error
  }
  const job = await readJson(path.join(projectMetaDir(projectId), 'jobs', `${jobId}.json`)).catch(() => null)
  if (!job) {
    const error = new Error('National preparation job was not found.')
    error.statusCode = 404
    throw error
  }
  if (['queued', 'running'].includes(job.status)) {
    Object.assign(job, {
      schemaVersion: jobSchemaVersion,
      status: 'failed',
      phase: 'Preparation interrupted',
      error: 'VIGO was restarted before this preparation job finished. Retry the preserved source to continue.',
      failureCode: 'preparation_interrupted',
      retryable: recoverableNationalJob(job),
      finishedAt: now(),
      updatedAt: now(),
    })
    await persistNationalJob(projectId, job)
  }
  return job
}

async function cancelNationalImportJob(projectId, jobId) {
  const job = await readNationalImportJob(projectId, jobId)
  if (jobIsTerminal(job)) return job
  if (typeof job.cancel === 'function') return job.cancel()
  const error = new Error('This preparation job is no longer attached to a live worker. Reload the City and retry it.')
  error.statusCode = 409
  error.code = 'preparation_worker_unavailable'
  throw error
}

async function retryNationalImportJob(projectId, jobId) {
  const previous = await readNationalImportJob(projectId, jobId)
  if (!['failed', 'cancelled'].includes(previous.status)) {
    const error = new Error('Only a failed or cancelled preparation job can be retried.')
    error.statusCode = 409
    throw error
  }
  if (previous.kind === 'national-gtfs-merge') {
    const retriedMerge = await startNationalGtfsMerge(projectId, {
      preloadServiceDate: previous.preloadServiceDate,
      preloadServiceDay: previous.preloadServiceDay,
    })
    retriedMerge.retryOf = previous.id
    await persistNationalJob(projectId, retriedMerge)
    return retriedMerge
  }
  const retrySourcePath = path.resolve(String(previous.retrySourcePath || previous.sourcePath || ''))
  const sourceStats = await fs.stat(retrySourcePath).catch(() => null)
  if (!sourceStats?.isFile()) {
    const error = new Error('The preserved source is no longer available. Select the GTFS ZIP or OSM PBF again.')
    error.statusCode = 409
    error.code = 'preparation_source_missing'
    throw error
  }
  const common = {
    sourcePath: retrySourcePath,
    fileName: previous.sourceFile || previous.label,
    cleanupSource: previous.stagedUpload === true,
    preloadServiceDate: previous.preloadServiceDate,
    preloadServiceDay: previous.preloadServiceDay,
  }
  const retried = previous.kind === 'national-osm-import'
    ? await startNationalOsmImport(projectId, common)
    : await startNationalGtfsImport(projectId, {
      ...common,
      replaceProjectSchedule: previous.replaceProjectSchedule === true,
    })
  retried.retryOf = previous.id
  await persistNationalJob(projectId, retried)
  return retried
}

async function dispatchLazyNationalTransitRoute(
  storePath,
  streetStorePath,
  routeRequest,
  windowMinutes,
  signal,
) {
  const exactCoverageUnavailable = Boolean(
    streetStorePath
    && routeRequest.requireCompleteServiceCoverage === true
    && routeRequest.allowServiceDateFallback !== true
    && routingDateOutsideCompleteCoverage(
      await cachedNationalRoutingServiceCoverage(storePath),
      routeRequest.serviceDate,
    ),
  )
  const admissionOperation = !streetStorePath
    ? null
    : exactCoverageUnavailable
      ? 'prepare-street'
      : 'prepare-transfers'
  const preparedContext = {
    serviceDate: routeRequest.serviceDate,
    serviceDay: routeRequest.serviceDay,
    allowServiceDateFallback: routeRequest.allowServiceDateFallback,
    requireCompleteServiceCoverage: routeRequest.requireCompleteServiceCoverage,
    streetStorePath,
  }
  let admissionReady = admissionOperation === null
    || nationalRouteWorkerPool.isPrepared(storePath, preparedContext)
    || nationalRouteWorkerPool.isAdmissionPrepared(storePath, admissionOperation, streetStorePath)
  let workerRestartRetried = false
  let derivedArtifactRepairRetried = false
  while (true) {
    try {
      if (!admissionReady) {
        if (admissionOperation === 'prepare-transfers') {
          await nationalRouteWorkerPool.prepareRoutingAccess(storePath, {
            reason: 'route-dispatch',
            signal,
            context: preparedContext,
          })
        } else {
          await nationalRouteWorkerPool.dispatch(
            storePath,
            admissionOperation,
            { streetStorePath },
            signal,
          )
        }
        admissionReady = true
      }
      return await nationalRouteWorkerPool.dispatch(
        storePath,
        windowMinutes ? 'window' : 'route',
        routeRequest,
        signal,
      )
    } catch (error) {
      if (
        !workerRestartRetried
        && error?.code === 'VIGO_ROUTE_WORKER_RESTARTED'
        && !signal?.aborted
      ) {
        workerRestartRetried = true
        admissionReady = admissionOperation === null
        continue
      }
      if (
        !derivedArtifactRepairRetried
        && error?.code === 'resident_timetable_kernel_required'
        && error?.activeServiceKernel?.reason === 'topology_unavailable'
        && !signal?.aborted
      ) {
        derivedArtifactRepairRetried = true
        await nationalRouteWorkerPool.dispatch(
          storePath,
          'prepare-derived',
          {},
          signal,
        )
        continue
      }
      throw error
    }
  }
}

function earliestTransitEvidenceFromPlan(plan) {
  if (plan?.status !== 'ready' || plan?.travelMode !== 'transit') return null
  const firstRide = plan.legs?.find((leg) => leg.type === 'ride')
  if (!firstRide) return null
  const firstBoardingMinutes = Number(firstRide.startMinutes)
  const arriveMinutes = Number(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)
  if (!Number.isFinite(firstBoardingMinutes) || !Number.isFinite(arriveMinutes)) return null
  return {
    status: 'ready',
    departMinutes: Number(plan.departMinutes),
    firstBoardingMinutes,
    arriveMinutes,
    routeShortName: firstRide.routeShortName || firstRide.routeId || undefined,
    transfers: Number(plan.transfers ?? 0),
  }
}

function earliestTransitEvidenceFromResponse(response) {
  if (response?.earliestTransit?.status === 'ready') return response.earliestTransit
  const candidates = [
    response?.plan,
    ...(Array.isArray(response?.choices) ? response.choices : []),
  ]
    .map(earliestTransitEvidenceFromPlan)
    .filter(Boolean)
  if (!candidates.length) return null
  candidates.sort((left, right) => (
    left.firstBoardingMinutes - right.firstBoardingMinutes
      || left.arriveMinutes - right.arriveMinutes
      || left.transfers - right.transfers
  ))
  return candidates[0]
}

async function earliestTransitEvidence(
  storePath,
  streetPath,
  routeRequest,
  windowMinutes,
  responseResult,
  signal,
) {
  const existing = earliestTransitEvidenceFromResponse(responseResult)
  if (existing) return existing
  try {
    const probeRequest = {
      ...routeRequest,
      departureWindowMinutes: windowMinutes,
      __disableDirectWalkDominance: true,
    }
    const probe = await dispatchLazyNationalTransitRoute(
      storePath,
      streetPath,
      probeRequest,
      windowMinutes,
      signal,
    )
    const probedResponse = windowMinutes
      ? { plan: probe.plan, choices: probe.choices }
      : { plan: probe }
    const evidence = earliestTransitEvidenceFromResponse(probedResponse)
    return evidence ?? {
      status: 'none',
      detail: 'No scheduled transit option was found in the selected search window.',
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'The earliest-transit check was unavailable.',
    }
  }
}

async function runSingleNationalRoute(projectId, body, signal, options = {}) {
  const project = await readProjectMetadata(projectId)
  const serviceContext = nationalRequestServiceContext(body)
  const mode = ['walk', 'drive'].includes(body?.mode) ? body.mode : 'transit'
  const feedId = String(body?.feedId ?? '')
  const { storePath } = await requireRoutingStore(projectId, project, feedId)
  const streetPath = project.osmStreetIndex?.status === 'ready' && await exists(streetStoreFile(projectId))
    ? streetStoreFile(projectId)
    : undefined
  if (mode !== 'transit' && !streetPath) {
    const error = new Error('Walking and driving require a ready OpenStreetMap street index.')
    error.statusCode = 409
    throw error
  }
  const exactStopEndpoints = Boolean(
    String(body?.origin?.stopId ?? '').trim()
    && String(body?.destination?.stopId ?? '').trim(),
  )
  const pedestrianAccessRequested = mode === 'walk' || mode === 'transit'
  if (pedestrianAccessRequested && streetPath && project.osmStreetIndex?.cch?.ready !== true) {
    const error = new Error(
      'The saved OSM street index is from an older or incomplete build. Rebuild the OpenStreetMap street index before routing between map points.',
    )
    error.statusCode = 409
    error.code = 'street_index_stale'
    error.routingStatus = 'stale'
    throw error
  }
  if (mode === 'transit' && !exactStopEndpoints && !streetPath) {
    const error = new Error(
      'Map-point transit routing requires a ready pedestrian accelerator. Rebuild the OpenStreetMap street index.',
    )
    error.statusCode = 409
    throw error
  }
  const transitStreetPath = streetPath
  const windowMinutes = mode !== 'transit' || body?.timePreference === 'arrive'
    ? 0
    : integralRoutingMinute(body?.departureWindowMinutes, 'departureWindowMinutes', 0)
  if (windowMinutes > 30) {
    const error = new Error('departureWindowMinutes must be an integral minute in [0, 30].')
    error.statusCode = 400
    error.code = 'invalid_departure_window'
    throw error
  }
  const centerMinutes = integralRoutingMinute(body?.departMinutes, 'departMinutes')
  if (Object.hasOwn(body ?? {}, 'routingPreference')) {
    const error = new Error('routingPreference is not a public option; use objective')
    error.statusCode = 400
    error.code = 'invalid_objective'
    throw error
  }
  const objective = String(body?.objective ?? 'earliest_arrival')
  if (objective !== 'earliest_arrival') {
    const error = new Error('objective must be earliest_arrival')
    error.statusCode = 400
    error.code = 'invalid_objective'
    throw error
  }
  const routingPreference = 'fastest'
  const requireTransitRide = mode === 'transit' && options.requireTransitRide === true
  const publicRoutingBody = Object.fromEntries(
    Object.entries(body ?? {}).filter(([key]) => !key.startsWith('__')),
  )
  const routeRequest = windowMinutes
    ? {
      ...publicRoutingBody,
      ...serviceContext,
      mode,
      objective,
      routingPreference,
      departMinutes: centerMinutes,
      departureWindowMinutes: windowMinutes,
      streetStorePath: transitStreetPath,
      requireCompleteServiceCoverage: true,
      ...(requireTransitRide ? { __disableDirectWalkDominance: true } : {}),
      }
    : {
        ...publicRoutingBody,
        ...serviceContext,
        mode,
        objective,
        routingPreference,
        streetStorePath: transitStreetPath,
        requireCompleteServiceCoverage: true,
        ...(requireTransitRide ? { __disableDirectWalkDominance: true } : {}),
      }
  if (mode !== 'transit') {
    const plan = await nationalRouteWorkerPool.dispatch(
      streetPath,
      'street-route',
      routeRequest,
      signal,
    )
    return { plan, choices: [plan] }
  }

  // Exact complete-coverage failure is decidable from the routing store alone.
  // Let the route core construct that blocked response without first building
  // a street/stop transfer frontier that cannot be used. Every admissible
  // transit request still admits the identical transfer graph before routing.
  let responseResult
  const routed = await dispatchLazyNationalTransitRoute(
    storePath,
    transitStreetPath,
    routeRequest,
    windowMinutes,
    signal,
  )
  if (!windowMinutes) {
    responseResult = { plan: routed, choices: [routed] }
  } else {
    const { plans: _samplePlans, ...window } = routed.profile
    responseResult = {
      plan: routed.plan,
      choices: routed.choices,
      window,
      ...(routed.earliestTransit ? { earliestTransit: routed.earliestTransit } : {}),
    }
  }
  if (body?.includeEarliestTransit === true) {
    responseResult = {
      ...responseResult,
      earliestTransit: await earliestTransitEvidence(
        storePath,
        transitStreetPath,
        routeRequest,
        windowMinutes,
        responseResult,
        signal,
      ),
    }
  }
  return responseResult
}

function nationalRequestServiceContext(body, defaultContext = currentNationalRoutingServiceContext()) {
  const serviceDate = String(body?.serviceDate ?? '').trim() || defaultContext.serviceDate
  try {
    return {
      serviceDate,
      serviceDay: resolveServiceDay(serviceDate, body?.serviceDay),
    }
  } catch (error) {
    if (error && typeof error === 'object' && !('statusCode' in error)) {
      error.statusCode = 400
    }
    throw error
  }
}

async function runNationalRoute(projectId, body, signal) {
  if (
    Object.prototype.hasOwnProperty.call(body ?? {}, 'waypoints')
    && !Array.isArray(body.waypoints)
  ) {
    const error = new Error('Routing waypoints must be an ordered array.')
    error.statusCode = 400
    throw error
  }
  const waypoints = Array.isArray(body?.waypoints) ? body.waypoints : []
  if (!waypoints.length) return runSingleNationalRoute(projectId, body, signal)

  const points = validateOrderedRoutingPoints(body?.origin, waypoints, body?.destination)
  const { waypoints: _waypoints, ...baseRequest } = body
  const orderedMode = ['walk', 'drive'].includes(baseRequest?.mode) ? baseRequest.mode : 'transit'
  const orderedRequest = { ...baseRequest, mode: orderedMode }
  const routed = await routeOrderedRoutingSegments(
    points,
    orderedRequest,
    async (segmentRequest) => {
      const response = await runSingleNationalRoute(
        projectId,
        segmentRequest,
        signal,
        { requireTransitRide: orderedMode === 'transit' },
      )
      if (signal?.aborted) throw makeAbortError()
      return response.plan
    },
  )
  if (routed.failedIndex >= 0) {
    const plan = composeOrderedRoutingFailure(
      routed.failedPlan,
      routed.failedIndex,
      points,
      routed.componentPlans,
    )
    return { plan, choices: [plan] }
  }

  const plan = composeOrderedRoutingPlans(routed.componentPlans, points, orderedRequest)
  return { plan, choices: [plan] }
}

async function runScenarioRoadGeometry(projectId, body, signal) {
  const project = await readProjectMetadata(projectId)
  const points = Array.isArray(body?.points) ? body.points : []
  if (points.length < 2 || points.length > 256) {
    const error = new Error('Road-following route inference requires 2 to 256 ordered stops.')
    error.statusCode = 400
    throw error
  }
  const normalizedPoints = points.map((point, index) => {
    const coordinate = Array.isArray(point?.coordinate) ? point.coordinate.map(Number) : []
    if (
      coordinate.length !== 2
      || coordinate.some((value) => !Number.isFinite(value))
      || coordinate[0] < -180
      || coordinate[0] > 180
      || coordinate[1] < -85
      || coordinate[1] > 85
    ) {
      const error = new Error(`Road-following route inference stop ${index + 1} has an invalid coordinate.`)
      error.statusCode = 400
      throw error
    }
    return {
      coordinate,
      label: String(point?.label ?? `Stop ${index + 1}`).slice(0, 120),
    }
  })
  const feedId = String(body?.feedId ?? '__project__').trim() || '__project__'
  const selection = routingStoreSelection(projectId, project, feedId)
  if (!selection.storePath || !await exists(selection.storePath)) {
    const error = new Error('The selected GTFS routing store is not ready for route inference.')
    error.statusCode = 409
    throw error
  }
  const osmPath = project.osmStreetIndex?.status === 'ready' && await exists(streetStoreFile(projectId))
    ? streetStoreFile(projectId)
    : ''
  if (!osmPath) {
    const error = new Error('Import and build the OSM street index before inferring a road-following route.')
    error.statusCode = 409
    throw error
  }
  const maxStreetKm = Math.max(0.25, Math.min(1_500, Number(body?.maxStreetKm) || 50))
  const fallbackGeometry = Array.isArray(body?.fallbackGeometry)
    && body.fallbackGeometry.length >= 2
    && body.fallbackGeometry.length <= 16_384
    ? body.fallbackGeometry.map((coordinate, index) => {
        if (
          !Array.isArray(coordinate)
          || coordinate.length !== 2
          || coordinate.some((value) => !Number.isFinite(Number(value)))
          || Number(coordinate[0]) < -180
          || Number(coordinate[0]) > 180
          || Number(coordinate[1]) < -85
          || Number(coordinate[1]) > 85
        ) {
          const error = new Error(`The published fallback geometry coordinate ${index + 1} is invalid.`)
          error.statusCode = 400
          throw error
        }
        return coordinate.map(Number)
      })
    : undefined
  const fallbackSegmentRuntimeMinutes = Array.isArray(body?.fallbackSegmentRuntimeMinutes)
    ? body.fallbackSegmentRuntimeMinutes
      .slice(0, 255)
      .map((value) => Number(value))
      .map((value) => Number.isFinite(value) && value >= 0 ? value : undefined)
    : undefined
  const publishedShapeSegmentIndexes = Array.isArray(body?.publishedShapeSegmentIndexes)
    ? [...new Set(body.publishedShapeSegmentIndexes.map((value) => Number(value)))]
      .filter((value) => Number.isInteger(value) && value >= 0 && value < normalizedPoints.length - 1)
    : undefined
  const result = await nationalRouteWorkerPool.dispatch(
    selection.storePath,
    'street-route-batch',
    {
      streetStorePath: osmPath,
      mode: 'drive',
      points: normalizedPoints,
      maxStreetKm,
      ...(fallbackGeometry ? { fallbackGeometry } : {}),
      ...(fallbackSegmentRuntimeMinutes ? { fallbackSegmentRuntimeMinutes } : {}),
      ...(publishedShapeSegmentIndexes ? { publishedShapeSegmentIndexes } : {}),
    },
    signal,
  )
  return {
    ...result,
    diagnostics: {
      feedId,
      maxStreetKm,
      pointCount: normalizedPoints.length,
      publishedShapeSegmentIndexes: publishedShapeSegmentIndexes ?? [],
      osmStore: path.basename(osmPath),
    },
  }
}

function routingStoreCalendarDate(value) {
  const date = String(Math.trunc(Number(value) || 0)).padStart(8, '0')
  if (!/^(?:19|20)\d{6}$/.test(date)) return ''
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
}

function nationalRoutingServiceCoverage(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const tables = new Set(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('calendar', 'calendar_dates', 'metadata')
    `).all().map((row) => String(row.name)))
    if (!tables.has('calendar') || !tables.has('calendar_dates')) {
      return { schemaVersion: 'vigo.routing.service-coverage.v1', scopeCount: 0, scopes: [] }
    }
    const sourceStoresValue = tables.has('metadata')
      ? db.prepare("SELECT value FROM metadata WHERE key='sourceStores'").get()?.value
      : undefined
    let sourceStores = []
    try {
      sourceStores = sourceStoresValue ? JSON.parse(sourceStoresValue) : []
    } catch {}
    const exceptionDateIndexReady = db.prepare(`
      SELECT 1 AS ready FROM sqlite_master
      WHERE type='index' AND name='calendar_dates_date'
    `).get()?.ready === 1
    if (!Array.isArray(sourceStores) || sourceStores.length === 0) {
      const calendar = db.prepare(`
        SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date
        FROM calendar
        WHERE start_date > 19000101 AND end_date < 29991231
      `).get()
      const firstException = exceptionDateIndexReady
        ? db.prepare(`
            SELECT date FROM calendar_dates INDEXED BY calendar_dates_date
            WHERE exception_type=1 ORDER BY date LIMIT 1
          `).get()?.date
        : db.prepare('SELECT MIN(date) AS date FROM calendar_dates WHERE exception_type=1').get()?.date
      const lastException = exceptionDateIndexReady
        ? db.prepare(`
            SELECT date FROM calendar_dates INDEXED BY calendar_dates_date
            WHERE exception_type=1 ORDER BY date DESC LIMIT 1
          `).get()?.date
        : db.prepare('SELECT MAX(date) AS date FROM calendar_dates WHERE exception_type=1').get()?.date
      const startDate = routingStoreCalendarDate(Math.min(
        ...[calendar?.start_date, firstException].map(Number).filter(Number.isFinite),
      ))
      const endDate = routingStoreCalendarDate(Math.max(
        ...[calendar?.end_date, lastException].map(Number).filter(Number.isFinite),
      ))
      if (startDate && endDate && startDate <= endDate) {
        const scope = { id: '__store__', startDate, endDate }
        return {
          schemaVersion: 'vigo.routing.service-coverage.v1',
          scopeCount: 1,
          completeStartDate: startDate,
          completeEndDate: endDate,
          scopes: [scope],
        }
      }
    }
    const rows = db.prepare(`
      SELECT service_id, MIN(start_date) AS start_date, MAX(end_date) AS end_date
      FROM (
        SELECT service_id, start_date, end_date
        FROM calendar
        WHERE start_date > 19000101 AND end_date < 29991231
        UNION ALL
        SELECT service_id, date AS start_date, date AS end_date
        FROM calendar_dates
        WHERE exception_type = 1
      )
      GROUP BY service_id
    `).all()
    const scopes = new Map()
    for (const row of rows) {
      const serviceId = String(row.service_id ?? '')
      const separator = serviceId.indexOf('\u001f')
      const scopeId = separator > 0 ? serviceId.slice(0, separator) : '__store__'
      const startDate = routingStoreCalendarDate(row.start_date)
      const endDate = routingStoreCalendarDate(row.end_date)
      if (!startDate || !endDate) continue
      const current = scopes.get(scopeId)
      scopes.set(scopeId, {
        id: scopeId,
        startDate: current?.startDate && current.startDate < startDate ? current.startDate : startDate,
        endDate: current?.endDate && current.endDate > endDate ? current.endDate : endDate,
      })
    }
    const scopeRanges = [...scopes.values()].sort((left, right) => left.id.localeCompare(right.id))
    const completeStartDate = scopeRanges.reduce(
      (latest, scope) => !latest || scope.startDate > latest ? scope.startDate : latest,
      '',
    )
    const completeEndDate = scopeRanges.reduce(
      (earliest, scope) => !earliest || scope.endDate < earliest ? scope.endDate : earliest,
      '',
    )
    return {
      schemaVersion: 'vigo.routing.service-coverage.v1',
      scopeCount: scopeRanges.length,
      completeStartDate: completeStartDate && completeEndDate && completeStartDate <= completeEndDate ? completeStartDate : undefined,
      completeEndDate: completeStartDate && completeEndDate && completeStartDate <= completeEndDate ? completeEndDate : undefined,
      scopes: scopeRanges,
    }
  } finally {
    db.close()
  }
}

function routingDateOutsideCompleteCoverage(serviceCoverage, serviceDate) {
  const requested = String(serviceDate ?? '')
  return Boolean(
    requested
    && serviceCoverage.completeStartDate
    && serviceCoverage.completeEndDate
    && (requested < serviceCoverage.completeStartDate || requested > serviceCoverage.completeEndDate),
  )
}

function nationalServiceDayForDate(serviceDate) {
  return serviceDayForDate(serviceDate)
}

async function nationalBuildPreloadContext(storePath, requestedServiceDate, requestedServiceDay) {
  const defaultContext = currentNationalRoutingServiceContext()
  const serviceCoverage = await cachedNationalRoutingServiceCoverage(storePath)
  const requestedDate = String(requestedServiceDate ?? '').trim()
  const requestedDay = requestedDate
    ? resolveServiceDay(requestedDate, requestedServiceDay)
    : defaultContext.serviceDay
  const usableRequestedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    && !routingDateOutsideCompleteCoverage(serviceCoverage, requestedDate)
  const boundedServiceDate = requestedDate > serviceCoverage.completeEndDate
    ? serviceCoverage.completeEndDate
    : serviceCoverage.completeStartDate
  const serviceDate = usableRequestedDate
    ? requestedDate
    : boundedServiceDate || defaultContext.serviceDate
  return {
    serviceDate,
    serviceDay: usableRequestedDate ? requestedDay : nationalServiceDayForDate(serviceDate),
    allowServiceDateFallback: false,
    requireCompleteServiceCoverage: true,
    requestedServiceDate: requestedDate || undefined,
  }
}

async function preloadNationalBuiltStore({
  storePath,
  streetStorePath,
  requestedServiceDate,
  requestedServiceDay,
  job,
}) {
  let context = await nationalBuildPreloadContext(
    storePath,
    requestedServiceDate,
    requestedServiceDay,
  )
  for (let attempt = 0; attempt < 3; attempt += 1) {
    Object.assign(job, {
      phase: 'Preloading exact timetable kernel',
      progress: 0.997,
      detail: `${context.serviceDate} / ${context.serviceDay}`,
      preloadServiceDate: context.serviceDate,
      preloadServiceDay: context.serviceDay,
      updatedAt: now(),
    })
    await persistNationalJob(job.projectId, job)
    const prepared = await nationalRouteWorkerPool.dispatch(
      storePath,
      'prepare',
      {
        ...context,
        streetStorePath: streetStorePath || undefined,
      },
      undefined,
      (progress) => {
        Object.assign(job, {
          phase: progress?.phase || 'Preloading exact timetable kernel',
          progress: 0.997 + Math.max(0, Math.min(1, Number(progress?.progress ?? 0))) * 0.002,
          detail: progress?.detail ?? job.detail,
          updatedAt: now(),
        })
      },
    )
    const activeServiceKernel = prepared?.activeServiceKernel
    if (activeServiceKernel?.ready === true) {
      if (!['written', 'loaded'].includes(String(activeServiceKernel.persistenceState ?? ''))) {
        const error = new Error(`The active-service kernel was compiled but not persisted for ${context.serviceDate}.`)
        error.code = 'VIGO_ACTIVE_KERNEL_PRELOAD_NOT_PERSISTED'
        error.activeServiceKernel = activeServiceKernel
        throw error
      }
      return {
        serviceDate: context.serviceDate,
        serviceDay: context.serviceDay,
        requestedServiceDate: context.requestedServiceDate,
        persistenceState: activeServiceKernel.persistenceState,
        snapshotPath: activeServiceKernel.snapshotPath,
        snapshotBytes: activeServiceKernel.snapshotBytes,
        snapshotWriteMs: activeServiceKernel.snapshotWriteMs,
        snapshotLoadMs: activeServiceKernel.snapshotLoadMs,
        compileMs: activeServiceKernel.compileMs,
        buildMs: activeServiceKernel.buildMs,
        engine: activeServiceKernel.engine,
        heuristicMode: activeServiceKernel.heuristicMode,
        nativeTimetableReady: activeServiceKernel.nativeTimetableKernel?.ready === true,
        activeSegments: activeServiceKernel.activeSegments,
      }
    }

    const nextDate = prepared?.serviceDateOptions?.find((option) => option.recommended)?.date
      ?? prepared?.serviceDateOptions?.[0]?.date
    if (
      activeServiceKernel?.reason !== 'incomplete_service_coverage'
      || !nextDate
      || nextDate === context.serviceDate
    ) {
      const error = new Error(
        `The built timetable could not preload an exact active-service kernel for ${context.serviceDate}: ${activeServiceKernel?.detail || activeServiceKernel?.reason || 'unknown reason'}.`,
      )
      error.code = 'VIGO_ACTIVE_KERNEL_PRELOAD_FAILED'
      error.activeServiceKernel = activeServiceKernel
      throw error
    }
    context = {
      ...context,
      serviceDate: nextDate,
      serviceDay: nationalServiceDayForDate(nextDate),
    }
  }
  throw new Error('The active-service kernel could not be preloaded after selecting complete feed coverage.')
}

async function prepareNationalRouting(projectId, body, signal) {
  const project = await readProjectMetadata(projectId)
  const feedId = String(body?.feedId ?? '')
  const { storePath } = routingStoreSelection(projectId, project, feedId)
  if (!storePath || !await exists(storePath)) {
    const error = new Error('The selected routing database is not ready.')
    error.statusCode = 409
    throw error
  }
  const defaultContext = currentNationalRoutingServiceContext()
  const projectStreetStorePath = project.osmStreetIndex?.status === 'ready' && await exists(streetStoreFile(projectId))
    ? streetStoreFile(projectId)
    : undefined
  const serviceCoverage = await cachedNationalRoutingServiceCoverage(storePath)
  if (routingDateOutsideCompleteCoverage(serviceCoverage, body?.serviceDate)) {
    return {
      ready: true,
      queryMs: 0,
      serviceModel: 'complete-coverage-gate',
      dateOutsideCoverage: true,
      serviceCoverage,
    }
  }
  const routingContext = {
    ...nationalRequestServiceContext(body, defaultContext),
    allowServiceDateFallback: body?.allowServiceDateFallback === true,
    requireCompleteServiceCoverage: true,
  }
  const routing = await nationalRouteWorkerPool.prepare(storePath, {
    reason: 'routing-readiness',
    signal,
    context: {
      ...routingContext,
      readinessOnly: true,
    },
  })
  // Pathfinder readiness only admits the immutable local store. Load the exact
  // active-date kernel, transfers, and coordinate access in the same resident
  // worker while the person chooses A/B; an immediate route coalesces here.
  const routingAccessContext = {
    ...routingContext,
    streetStorePath: projectStreetStorePath,
  }
  const accessAlreadyPrepared = nationalRouteWorkerPool.isRoutingAccessPrepared(
    storePath,
    routingAccessContext,
  )
  void nationalRouteWorkerPool.prepareRoutingAccess(storePath, {
    reason: 'routing-readiness-background-access',
    context: routingAccessContext,
  }).catch((error) => {
    if (!isAbortError(error)) {
      console.warn(
        `Unable to prepare background routing access for ${projectId}:`,
        error instanceof Error ? error.message : error,
      )
    }
  })
  return {
    ...routing,
    serviceCoverage,
    requestedRoutingContext: routingContext,
    accessPreparation: {
      state: accessAlreadyPrepared ? 'ready' : 'warming',
      background: !accessAlreadyPrepared,
    },
  }
}

async function runNationalMatrix(projectId, body, signal) {
  const project = await readProjectMetadata(projectId)
  const feedId = String(body?.feedId ?? '')
  const { storePath } = await requireRoutingStore(projectId, project, feedId)
  const streetStorePath = project.osmStreetIndex?.status === 'ready' && await exists(streetStoreFile(projectId))
    ? streetStoreFile(projectId)
    : undefined
  const defaultContext = currentNationalRoutingServiceContext()
  const serviceContext = nationalRequestServiceContext(body, defaultContext)
  const matrixRequest = {
    ...body,
    ...serviceContext,
    streetStorePath,
    requireCompleteServiceCoverage: true,
  }
  return nationalRouteWorkerPool.dispatchRoutingAccessPrepared(storePath, 'matrix', matrixRequest, {
    signal,
    context: {
      ...serviceContext,
      allowServiceDateFallback: body?.allowServiceDateFallback === true,
      requireCompleteServiceCoverage: true,
      streetStorePath,
    },
  })
}

async function runNationalStreetMatrix(projectId, body, signal) {
  const project = await readProjectMetadata(projectId)
  const mode = String(body?.mode ?? '').trim()
  if (!['walk', 'drive'].includes(mode)) {
    const error = new Error('Street matrices require mode "walk" or "drive".')
    error.statusCode = 400
    throw error
  }
  const streetPath = project.osmStreetIndex?.status === 'ready' && await exists(streetStoreFile(projectId))
    ? streetStoreFile(projectId)
    : undefined
  if (!streetPath) {
    const error = new Error('Walking and driving matrices require a ready OpenStreetMap street index.')
    error.statusCode = 409
    throw error
  }
  return nationalRouteWorkerPool.dispatch(
    streetPath,
    'street-matrix',
    {
      ...body,
      mode,
      streetStorePath: streetPath,
    },
    signal,
  )
}

async function runReach(projectId, body, signal, onProgress, onPreliminary) {
  const project = await readProjectMetadata(projectId)
  const serviceContext = nationalRequestServiceContext(body)
  const feedId = String(body?.feedId ?? '')
  const { storePath } = await requireRoutingStore(projectId, project, feedId)
  const streetPath = project.osmStreetIndex?.status === 'ready' && await exists(streetStoreFile(projectId))
    ? streetStoreFile(projectId)
    : null
  if (!streetPath) {
    const error = new Error('Reach analysis requires a ready OSM pedestrian street index.')
    error.statusCode = 409
    throw error
  }
  const [storeIdentity, streetIdentity] = await Promise.all([
    nationalRouteArtifactIdentity(storePath),
    streetPath ? nationalRouteArtifactIdentity(streetPath, 'street') : Promise.resolve(null),
  ])
  const baselineIdentity = JSON.stringify({
    appVersion,
    store: storeIdentity,
    street: streetIdentity,
  })
  const hydratedBody = hydrateScenarioRouteServices(
    storePath,
    storeIdentity,
    { ...body, ...serviceContext },
  )
  const progressWindow = (stage) => {
    switch (stage) {
      case 'preliminary-surface': return [0, 0.08]
      case 'baseline-range': return [0.08, 0.52]
      case 'scenario-range': return [0.52, 0.98]
      default: return [0, 0.98]
    }
  }
  const mapReachProgress = (stage, progress) => {
    const [start, end] = progressWindow(stage)
    const ratio = Math.max(0, Math.min(1, Number(progress ?? 0)))
    return start + ratio * (end - start)
  }
  return computeReachResult({
    ...hydratedBody,
    feedId,
    baselineIdentity,
  }, {
    runReach: (rangeRequest) => nationalRouteWorkerPool.dispatch(
      storePath,
      'reach',
      {
        ...rangeRequest,
        streetStorePath: streetPath || undefined,
      },
      signal,
      (progress) => onProgress?.({
        ...progress,
        phase: progress.phase === 'complete' ? 'search' : progress.phase,
        progress: mapReachProgress(rangeRequest.stage, progress.progress),
      }),
    ),
    buildPreliminaryStreetRaster: (surfaceRequest) => nationalRouteWorkerPool.dispatch(
      storePath,
      'street-surface',
      {
        ...surfaceRequest,
        streetStorePath: streetPath,
      },
      signal,
      (progress) => onProgress?.({
        ...progress,
        progress: mapReachProgress(surfaceRequest.stage, progress.progress),
      }),
    ),
    onProgress,
    onPreliminary,
  })
}

async function runServiceEdgeDecomposition(projectId, body, signal) {
  const project = await readProjectMetadata(projectId)
  const baselineFeedId = String(body?.baselineFeedId ?? '').trim()
  const comparisonFeedId = String(body?.comparisonFeedId ?? '').trim()
  if (!baselineFeedId || !comparisonFeedId || baselineFeedId === comparisonFeedId) {
    const error = new Error('Service comparison requires two different GTFS feeds.')
    error.statusCode = 400
    throw error
  }
  const baselineFeed = project.feeds.find((feed) => feed.id === baselineFeedId)
  const comparisonFeed = project.feeds.find((feed) => feed.id === comparisonFeedId)
  if (!baselineFeed || !comparisonFeed) {
    const error = new Error('Both selected GTFS feeds must belong to this City.')
    error.statusCode = 400
    throw error
  }
  const [baselineContext, comparisonContext] = await Promise.all([
    feedRoutingStoreContext(projectId, project, baselineFeed),
    feedRoutingStoreContext(projectId, project, comparisonFeed),
  ])
  if (!baselineContext?.storePath || !comparisonContext?.storePath) {
    const error = new Error('Both selected GTFS feeds need ready SQLite routing stores.')
    error.statusCode = 409
    throw error
  }
  const streetPath = project.osmStreetIndex?.status === 'ready'
    && await exists(streetStoreFile(projectId))
    ? streetStoreFile(projectId)
    : null
  if (!streetPath) {
    const error = new Error('Service edge comparison requires a ready local OSM street index.')
    error.statusCode = 409
    throw error
  }
  if (signal?.aborted) throw makeAbortError()
  const decomposition = buildServiceEdgeDecomposition({
    baselineStorePath: baselineContext.storePath,
    comparisonStorePath: comparisonContext.storePath,
    streetStorePath: streetPath,
    baselineSourceScope: baselineContext.sourceScope,
    comparisonSourceScope: comparisonContext.sourceScope,
    baselineRouteIds: body?.baselineRouteIds,
    comparisonRouteIds: body?.comparisonRouteIds,
    matchDistanceM: body?.matchDistanceM,
    sampleSpacingM: body?.sampleSpacingM,
    maxPatterns: body?.maxPatterns,
    maxFeatures: body?.maxFeatures,
  })
  if (signal?.aborted) throw makeAbortError()
  return {
    baselineFeedId,
    comparisonFeedId,
    ...decomposition,
  }
}

async function setRoutingResidency(projectId, body) {
  const project = await readProjectMetadata(projectId)
  const feedId = String(body?.feedId ?? '')
  const { storePath } = await requireRoutingStore(projectId, project, feedId)
  const residency = nationalRouteWorkerPool.setResidency(
    storePath,
    body?.resident === true,
    body?.leaseId,
  )
  let reachPreparation = null
  if (body?.resident === true && String(body?.serviceDate ?? '').trim()) {
    const streetPath = project.osmStreetIndex?.status === 'ready'
      && await exists(streetStoreFile(projectId))
      ? streetStoreFile(projectId)
      : null
    if (streetPath) {
      try {
        reachPreparation = await nationalRouteWorkerPool.prepareRoutingAccess(
          storePath,
          {
            reason: 'reach-residency',
            context: {
              ...nationalRequestServiceContext(body),
              streetStorePath: streetPath,
              allowServiceDateFallback: false,
            },
          },
        )
      } catch (error) {
        reachPreparation = {
          ready: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }
  return {
    ...residency,
    reachPreparation,
    ...(body?.resident === true
      ? { serviceCoverage: await cachedNationalRoutingServiceCoverage(storePath) }
      : {}),
  }
}

async function runNationalStopSearch(projectId, body, signal) {
  const project = await readProjectMetadata(projectId)
  const feedId = String(body?.feedId ?? '')
  const { storePath } = await requireRoutingStore(projectId, project, feedId)
  const hasOrderedQueries = Object.prototype.hasOwnProperty.call(body ?? {}, 'queries')
  if (hasOrderedQueries && (
    !Array.isArray(body.queries)
    || body.queries.length < 2
    || body.queries.length > 8
    || body.queries.some((query) => typeof query !== 'string')
  )) {
    const error = new Error('National stop search queries must contain 2-8 strings.')
    error.statusCode = 400
    throw error
  }
  const searchOperation = hasOrderedQueries
    ? body.queries.length === 2 ? 'search-pair' : 'search-many'
    : 'search'
  const stops = await nationalRouteWorkerPool.dispatch(
    storePath,
    searchOperation,
    hasOrderedQueries
      ? { queries: body.queries, limit: body?.limit }
      : { query: body?.query, limit: body?.limit },
    signal,
  )
  return hasOrderedQueries ? { results: stops } : { stops }
}

function sendJson(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return false
  const serialized = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(serialized)
  return true
}

function routingStatusForError(error) {
  const code = String(error?.code ?? error?.errorCode ?? '')
  if (code.includes('cancel')) return 'cancelled'
  if (code.includes('stale') || code.includes('artifact') || code === 'VIGO_NATIVE_STREET_CCH_REQUIRED') return 'stale'
  if (code.includes('unsupported')) return 'unsupported'
  return 'error'
}

function apiErrorPayload(error) {
  const message = error instanceof Error ? error.message : 'Unexpected server error'
  const code = String(error?.code ?? error?.errorCode ?? '') || undefined
  const routingStatus = routingStatusForError(error)
  return {
    error: message,
    status: routingStatus,
    routing: {
      schemaVersion: routingStatusSchemaVersion,
      status: routingStatus,
      ...(code ? { code } : {}),
      retryable: routingStatus === 'stale' || routingStatus === 'error',
      ...(routingStatus === 'stale'
        ? { remediation: 'Rebuild the affected OSM/GTFS preparation artifact, then retry routing.' }
        : {}),
    },
  }
}

function routingStatusForPlan(plan) {
  if (plan?.status === 'ready') return 'ready'
  const code = String(plan?.diagnostics?.failure?.code ?? plan?.diagnostics?.failureCode ?? '')
  const category = String(plan?.diagnostics?.failure?.category ?? plan?.diagnostics?.failureCategory ?? '')
  if (code.includes('stale') || code.includes('artifact')) return 'stale'
  if (code.includes('cancel')) return 'cancelled'
  if (category === 'unsupported_feature' || code.includes('unsupported')) return 'unsupported'
  return 'blocked'
}

function decorateRoutingPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan
  const diagnostics = plan.diagnostics ?? {}
  return {
    ...plan,
    diagnostics: {
      ...diagnostics,
      routingStatus: diagnostics.routingStatus ?? routingStatusForPlan(plan),
      routingStatusSchemaVersion: routingStatusSchemaVersion,
    },
  }
}

function decorateRoutingResponse(result) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    ...(result.plan ? { plan: decorateRoutingPlan(result.plan) } : {}),
    ...(Array.isArray(result.choices) ? { choices: result.choices.map(decorateRoutingPlan) } : {}),
    ...(result.earliestTransit ? { earliestTransit: result.earliestTransit } : {}),
  }
}

async function withRequestAbort(request, response, action) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => {
    if (!response.writableEnded) controller.abort()
  }
  request.once('aborted', abort)
  response.once('close', close)
  try {
    return await action(controller.signal)
  } finally {
    request.removeListener('aborted', abort)
    response.removeListener('close', close)
  }
}

async function readBody(request) {
  const declaredBytes = Number(request.headers['content-length'] ?? 0)
  if (declaredBytes > maxJsonBodyBytes) {
    const error = new Error(`JSON request body exceeds the ${Math.round(maxJsonBodyBytes / 1_000_000)} MB limit.`)
    error.statusCode = 413
    throw error
  }
  const chunks = []
  let byteLength = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    chunks.push(buffer)
    byteLength += buffer.byteLength
    if (byteLength > maxJsonBodyBytes) {
      const limitMb = Math.round(maxJsonBodyBytes / 1_000_000)
      const error = new Error(`JSON request body exceeds the ${limitMb} MB limit.`)
      error.statusCode = 413
      throw error
    }
  }

  if (!byteLength) return {}

  return JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8'))
}

function optionalUrl(value) {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function viewerRealtimeUrls(sourceUrl) {
  const parsedUrl = optionalUrl(sourceUrl)
  if (!parsedUrl) return undefined
  if (parsedUrl.hostname !== 'viz.rt.gtfs.zone') return undefined
  const params = new URLSearchParams(parsedUrl.hash.replace(/^#/, ''))
  const urls = compactObject({
    vehicles: params.get('rt_vp') || undefined,
    tripUpdates: params.get('rt_tu') || undefined,
    alerts: params.get('rt_al') || undefined,
  })
  return Object.keys(urls).length ? urls : undefined
}

function mbtaStandardRealtimeUrls(sourceUrl) {
  const parsedUrl = optionalUrl(sourceUrl)
  if (!parsedUrl) return undefined
  if (parsedUrl.hostname !== 'cdn.mbta.com') return undefined
  if (!/^\/realtime\/(?:Alerts|TripUpdates|VehiclePositions)\.pb$/i.test(parsedUrl.pathname)) return undefined

  return {
    vehicles: new URL('/realtime/VehiclePositions.pb', parsedUrl.origin).toString(),
    tripUpdates: new URL('/realtime/TripUpdates.pb', parsedUrl.origin).toString(),
    alerts: new URL('/realtime/Alerts.pb', parsedUrl.origin).toString(),
  }
}

function realtimeFeedUrls(body) {
  const supplied = body?.urls && typeof body.urls === 'object' ? body.urls : {}
  const urls = compactObject({
    vehicles: supplied.vehicles ?? supplied.vehiclePositions ?? supplied.rt_vp,
    tripUpdates: supplied.tripUpdates ?? supplied.trip_updates ?? supplied.rt_tu,
    alerts: supplied.alerts ?? supplied.rt_al,
  })
  if (Object.keys(urls).length) return urls
  const sourceUrl = typeof body?.url === 'string' ? body.url.trim() : ''
  if (!sourceUrl) return {}
  return viewerRealtimeUrls(sourceUrl) ?? mbtaStandardRealtimeUrls(sourceUrl) ?? { feed: sourceUrl }
}

async function fetchRealtimeFeed(sourceUrl) {
  let fetched
  try {
    fetched = await fetchSafeRealtimeBody(sourceUrl, {
      maximumBytes: maxRealtimeBytes,
      headers: {
        accept: 'application/x-protobuf, application/octet-stream, */*',
        'user-agent': `VIGO GTFS-RT inspector/${appVersion}`,
      },
    })
  } catch (error) {
    const next = new Error(error.code === 'unsafe_url' ? error.message : `GTFS-RT request failed: ${error.message}`)
    next.statusCode = error.code === 'unsafe_url' ? 400 : error.code === 'response_too_large' ? 413 : 502
    throw next
  }

  let feed
  try {
    feed = decodeGtfsRealtimeFeed(fetched.body)
  } catch (error) {
    const next = new Error(`GTFS-RT protobuf decode failed: ${error.message}`)
    next.statusCode = 400
    throw next
  }

  return {
    feed,
    sourceUrl,
    fetchedAt: now(),
    contentType: fetched.contentType,
  }
}

function realtimeSnapshotFromFeeds(records) {
  const snapshots = records.map((record) => realtimeSnapshotFromFeed(
    record.feed,
    record.sourceUrl,
    record.fetchedAt,
    record.contentType,
  ))
  const first = snapshots[0]
  const sourceUrls = snapshots.map((snapshot) => snapshot.sourceUrl).filter(Boolean)
  const vehicles = snapshots.flatMap((snapshot) => snapshot.vehicles)
  const tripUpdates = snapshots.flatMap((snapshot) => snapshot.tripUpdates)
  const alerts = snapshots.flatMap((snapshot) => snapshot.alerts)
  const other = snapshots.reduce((total, snapshot) => total + snapshot.counts.other, 0)
  return {
    sourceUrl: sourceUrls.length === 1 ? sourceUrls[0] : undefined,
    sourceUrls,
    fetchedAt: records.reduce((latest, record) => record.fetchedAt > latest ? record.fetchedAt : latest, first.fetchedAt),
    feedTimestamp: snapshots.reduce((latest, snapshot) => Math.max(latest, snapshot.feedTimestamp ?? 0), 0) || undefined,
    freshness: {
      status: snapshots.some((snapshot) => snapshot.freshness?.status === 'stale')
        ? 'stale'
        : snapshots.every((snapshot) => snapshot.freshness?.status === 'fresh') ? 'fresh' : 'unknown',
      ...(snapshots.some((snapshot) => Number.isFinite(snapshot.freshness?.ageSeconds))
        ? { ageSeconds: Math.max(...snapshots.map((snapshot) => Number(snapshot.freshness?.ageSeconds ?? 0))) }
        : {}),
      thresholdSeconds: 180,
    },
    feedVersion: first.feedVersion,
    gtfsRealtimeVersion: first.gtfsRealtimeVersion,
    incrementality: first.incrementality,
    contentType: snapshots.length === 1 ? first.contentType : 'multiple',
    entityCount: snapshots.reduce((total, snapshot) => total + snapshot.entityCount, 0),
    counts: {
      vehicles: vehicles.length,
      tripUpdates: tripUpdates.length,
      alerts: alerts.length,
      other,
    },
    vehicles,
    tripUpdates,
    alerts,
  }
}

async function inspectRealtimeFeed(body) {
  const urls = realtimeFeedUrls(body)
  const entries = Object.entries(urls)
    .map(([kind, value]) => [kind, typeof value === 'string' ? value.trim() : ''])
    .filter(([, value]) => value)
  if (!entries.length) {
    const error = new Error('GTFS-RT URL is required.')
    error.statusCode = 400
    throw error
  }
  const records = await Promise.all(entries.map(([, sourceUrl]) => fetchRealtimeFeed(sourceUrl)))
  return realtimeSnapshotFromFeeds(records)
}

function requestPathname(request) {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`).pathname
  } catch {
    return '/'
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function safeDecodePathname(pathname) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return ''
  }
}

function safeStaticPath(pathname) {
  if (!staticRoot) return null
  const normalized = path.normalize(pathname.replace(/^\/+/, ''))
  const resolvedPath = path.resolve(staticRoot, normalized || 'index.html')
  const relativePath = path.relative(staticRoot, resolvedPath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return resolvedPath
}

async function resolveStaticAsset(pathname) {
  const requestedPath = safeDecodePathname(pathname)
  if (!requestedPath) return null

  const directPath = safeStaticPath(requestedPath)
  if (directPath && await fileExists(directPath) && (await fs.stat(directPath)).isFile()) {
    return directPath
  }

  const indexPath = safeStaticPath('/index.html')
  if (indexPath && await fileExists(indexPath)) return indexPath
  return null
}

function contentTypeFor(assetPath) {
  const extension = path.extname(assetPath).toLowerCase()
  const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }

  return mimeTypes[extension] ?? 'application/octet-stream'
}

function cacheControlFor(assetPath) {
  return path.basename(assetPath) === 'index.html'
    ? 'no-cache'
    : 'public, max-age=31536000, immutable'
}

async function serveStaticAsset(request, response) {
  if (!staticRoot) {
    sendJson(response, 404, { error: 'Not found' })
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }

  const assetPath = await resolveStaticAsset(requestPathname(request))
  if (!assetPath) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  const assetStats = await fs.stat(assetPath)
  response.writeHead(200, {
    'Cache-Control': cacheControlFor(assetPath),
    'Content-Length': String(assetStats.size),
    'Content-Type': contentTypeFor(assetPath),
  })

  if (request.method === 'HEAD') {
    response.end()
    return
  }

  createReadStream(assetPath).pipe(response)
}

async function route(request, response) {
  const access = localRequestAccess(request, { staticRoot })
  if (!access.allowed) {
    sendJson(response, 403, { error: access.error })
    return true
  }
  applyLocalCors(response, access.origin)

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const { pathname } = url

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Max-Age': '600',
    })
    response.end()
    return true
  }

  if (!pathname.startsWith('/api/')) return false

  if (request.method === 'GET' && pathname === '/api/health') {
    await ensureStorage()
    const config = await configStatus()
    sendJson(response, 200, {
      ok: true,
      app: 'VIGO',
      version: appVersion,
      storageRoot,
      config,
      offline: config.offline,
      projectSchemaVersion,
      artifactSchemaVersion,
      routingRuntime: nationalRouteWorkerPool.snapshot(),
    })
    return true
  }

  if (request.method === 'GET' && pathname === '/api/capabilities') {
    sendJson(response, 200, { capabilities: vigoCapabilities(appVersion) })
    return true
  }

  if (request.method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, { config: await configStatus() })
    return true
  }

  if ((request.method === 'POST' || request.method === 'PATCH') && pathname === '/api/config') {
    sendJson(response, 200, { config: await updateRuntimeConfig(await readBody(request)) })
    return true
  }

  if (request.method === 'GET' && pathname === '/api/projects') {
    sendJson(response, 200, { projects: await listProjects() })
    return true
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    sendJson(response, 201, { project: await createProject(await readBody(request)) })
    return true
  }

  if (request.method === 'POST' && pathname === '/api/realtime/inspect') {
    sendJson(response, 200, { snapshot: await inspectRealtimeFeed(await readBody(request)) })
    return true
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/([^/]+))?$/)
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1])
    const action = projectMatch[2]

    if (cityMaintenance.has(projectId)) {
      const error = new Error('This City is temporarily unavailable while cleanup finishes.')
      error.statusCode = 409
      throw error
    }

    if (request.method === 'GET' && !action) {
      const project = url.searchParams.get('detail') === 'metadata'
        ? await readProjectMetadata(projectId)
        : await readProject(projectId)
      sendJson(response, 200, { project })
      return true
    }

    if (request.method === 'PATCH' && !action) {
      sendJson(response, 200, { project: await updateProject(projectId, await readBody(request)) })
      return true
    }

    if (request.method === 'DELETE' && !action) {
      sendJson(response, 200, { ok: true, projects: await deleteProject(projectId) })
      return true
    }

    if (request.method === 'GET' && action === 'city-data') {
      sendJson(response, 200, { data: await inspectCityData(projectId) })
      return true
    }

    if (request.method === 'GET' && action === 'local-streets') {
      sendJson(response, 200, await readLocalStreetGeometry(projectId, url))
      return true
    }

    if (request.method === 'GET' && action === 'reproducibility') {
      sendJson(response, 200, { manifest: await projectReproducibilityManifest(projectId) })
      return true
    }

    if (request.method === 'POST' && action === 'city-data') {
      sendJson(response, 200, await resetCityData(projectId, await readBody(request)))
      return true
    }

    if (request.method === 'POST' && action === 'national-gtfs-import') {
      sendJson(response, 202, { job: await startNationalGtfsImport(projectId, await readBody(request)) })
      return true
    }

    if (request.method === 'POST' && action === 'national-routing-merge') {
      sendJson(response, 202, { job: await startNationalGtfsMerge(projectId, await readBody(request)) })
      return true
    }

    if (request.method === 'POST' && action === 'national-gtfs-upload') {
      const staged = await stageUploadedProjectFile(projectId, request, { kind: 'gtfs', extensions: ['.zip'] })
      try {
        sendJson(response, 202, { job: await startNationalGtfsImport(projectId, staged) })
      } catch (error) {
        await fs.rm(staged.sourcePath, { force: true }).catch(() => {})
        throw error
      }
      return true
    }

    if (request.method === 'GET' && action === 'national-gtfs-job') {
      sendJson(response, 200, { job: await readNationalImportJob(projectId, url.searchParams.get('jobId') || '') })
      return true
    }

    if (request.method === 'POST' && action === 'national-job-cancel') {
      const body = await readBody(request)
      sendJson(response, 200, { job: await cancelNationalImportJob(projectId, String(body?.jobId || '')) })
      return true
    }

    if (request.method === 'POST' && action === 'national-job-retry') {
      const body = await readBody(request)
      sendJson(response, 202, { job: await retryNationalImportJob(projectId, String(body?.jobId || '')) })
      return true
    }

    if (request.method === 'POST' && action === 'gtfs-route-analysis') {
      sendJson(response, 200, await analyzeGtfsRoute(projectId, await readBody(request)))
      return true
    }

    if (request.method === 'POST' && action === 'national-osm-import') {
      sendJson(response, 202, { job: await startNationalOsmImport(projectId, await readBody(request)) })
      return true
    }

    if (request.method === 'POST' && action === 'national-osm-upload') {
      const staged = await stageUploadedProjectFile(projectId, request, { kind: 'osm', extensions: ['.osm.pbf', '.pbf'] })
      try {
        sendJson(response, 202, { job: await startNationalOsmImport(projectId, staged) })
      } catch (error) {
        await fs.rm(staged.sourcePath, { force: true }).catch(() => {})
        throw error
      }
      return true
    }

    if (request.method === 'POST' && action === 'national-route') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const result = await runNationalRoute(projectId, body, signal)
        if (signal.aborted) throw makeAbortError()
        sendJson(response, 200, decorateRoutingResponse(result))
      })
      return true
    }

    if (request.method === 'POST' && action === 'scenario-road-geometry') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const geometry = await runScenarioRoadGeometry(projectId, body, signal)
        if (signal.aborted) throw makeAbortError()
        sendJson(response, 200, { geometry })
      })
      return true
    }

    if (request.method === 'POST' && action === 'national-ready') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const routing = await prepareNationalRouting(projectId, body, signal)
        if (signal.aborted) throw makeAbortError()
        sendJson(response, 200, { routing })
      })
      return true
    }

    if (request.method === 'POST' && action === 'national-matrix') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const matrix = await runNationalMatrix(projectId, body, signal)
        if (signal.aborted) throw makeAbortError()
        sendJson(response, 200, { matrix })
      })
      return true
    }

    if (request.method === 'POST' && action === 'national-street-matrix') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const matrix = await runNationalStreetMatrix(projectId, body, signal)
        if (signal.aborted) throw makeAbortError()
        sendJson(response, 200, { matrix })
      })
      return true
    }

    if (request.method === 'POST' && action === 'reach') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const streamsProgress = String(request.headers.accept ?? '').includes('application/x-ndjson')
        if (!streamsProgress) {
          const result = await runReach(projectId, body, signal)
          if (signal.aborted) throw makeAbortError()
          sendJson(response, 200, { result })
          return
        }
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        })
        let latestProgress = 0
        const write = (value) => {
          if (!signal.aborted && !response.destroyed && !response.writableEnded) {
            response.write(`${JSON.stringify(value)}\n`)
          }
        }
        try {
          const result = await runReach(
            projectId,
            body,
            signal,
            (progress) => {
              latestProgress = Math.max(latestProgress, Math.min(1, Number(progress?.progress ?? latestProgress)))
              write({
                type: 'progress',
                progress: {
                  phase: String(progress?.phase ?? 'preparation'),
                  progress: latestProgress,
                  detail: String(progress?.detail ?? ''),
                },
              })
            },
            (preliminary) => write({ type: 'preliminary', result: preliminary }),
          )
          if (signal.aborted) return
          write({ type: 'complete', result })
          response.end()
        } catch (error) {
          if (signal.aborted || isAbortError(error)) {
            if (!response.writableEnded) response.end()
            return
          }
          write({
            type: 'error',
            error: error instanceof Error ? error.message : 'Analysis failed.',
          })
          response.end()
        }
      })
      return true
    }

    if (request.method === 'POST' && action === 'service-edge-decomposition') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const decomposition = await runServiceEdgeDecomposition(projectId, body, signal)
        if (signal.aborted) throw makeAbortError()
        sendJson(response, 200, { decomposition })
      })
      return true
    }

    if (request.method === 'POST' && action === 'routing-residency') {
      sendJson(response, 200, {
        residency: await setRoutingResidency(projectId, await readBody(request)),
      })
      return true
    }

    if (request.method === 'POST' && action === 'national-search') {
      await withRequestAbort(request, response, async (signal) => {
        const body = await readBody(request)
        const result = await runNationalStopSearch(projectId, body, signal)
        if (signal.aborted) throw makeAbortError()
        sendJson(response, 200, result)
      })
      return true
    }

  }

  sendJson(response, 404, { error: 'Not found' })
  return true
}

const server = http.createServer((request, response) => {
  route(request, response).then((handled) => {
    if (!handled) return serveStaticAsset(request, response)
  }).catch((error) => {
    if (isAbortError(error) || response.destroyed || response.writableEnded) return
    const statusCode = Number(error.statusCode ?? 500)
    sendJson(response, statusCode, apiErrorPayload(error))
  })
})

class InMemoryHttpAgent extends http.Agent {
  constructor(targetServer) {
    super({ keepAlive: false })
    this.targetServer = targetServer
  }

  createConnection(_options, callback) {
    const clientToServer = new PassThrough()
    const serverToClient = new PassThrough()
    const clientSocket = Duplex.from({
      readable: serverToClient,
      writable: clientToServer,
    })
    const serverSocket = Duplex.from({
      readable: clientToServer,
      writable: serverToClient,
    })
    Object.defineProperties(serverSocket, {
      localAddress: { value: '127.0.0.1' },
      remoteAddress: { value: '127.0.0.1' },
    })
    this.targetServer.emit('connection', serverSocket)
    callback(null, clientSocket)
    return clientSocket
  }
}

function inMemoryParentChannel() {
  const utilityPort = process.parentPort
  if (utilityPort && typeof utilityPort.postMessage === 'function') {
    return {
      binary: true,
      onMessage(listener) {
        utilityPort.on('message', (event) => listener(event?.data))
      },
      send(message) {
        utilityPort.postMessage(message)
      },
    }
  }

  if (typeof process.send === 'function') {
    return {
      binary: false,
      onDisconnect(listener) {
        process.once('disconnect', listener)
      },
      onMessage(listener) {
        process.on('message', listener)
      },
      send(message) {
        process.send?.(message)
      },
    }
  }

  throw new Error('The in-memory HTTP transport requires a parent message channel.')
}

function startInMemoryHttpTransport() {
  const parent = inMemoryParentChannel()
  const agent = new InMemoryHttpAgent(server)
  const requests = new Map()
  parent.onMessage((message) => {
    const id = String(message?.id ?? '')
    if (message?.type === 'vigo-api-cancel') {
      requests.get(id)?.destroy(makeAbortError())
      return
    }
    if (message?.type !== 'vigo-api-request' || !id) return
    const body = message.bodyBytes instanceof Uint8Array
      ? Buffer.from(message.bodyBytes)
      : typeof message.bodyBase64 === 'string'
      ? Buffer.from(message.bodyBase64, 'base64')
      : typeof message.body === 'string'
        ? message.body
        : message.body === undefined ? '' : JSON.stringify(message.body)
    const headers = {
      ...message.headers,
      Host: '127.0.0.1',
      ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
    }
    const startedAt = performance.now()
    let settled = false
    const sendResponse = (payload) => {
      if (settled) return
      settled = true
      requests.delete(id)
      parent.send({
        type: 'vigo-api-response',
        id,
        latencyMs: performance.now() - startedAt,
        ...payload,
      })
    }
    const request = http.request({
      host: '127.0.0.1',
      path: String(message.path || '/'),
      method: String(message.method || 'GET'),
      headers,
      agent,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks)
        sendResponse({
          status: Number(response.statusCode || 0),
          headers: response.headers,
          ...(parent.binary
            ? { bodyBytes: responseBody }
            : { bodyBase64: responseBody.toString('base64') }),
        })
      })
    })
    requests.set(id, request)
    request.on('error', (error) => {
      sendResponse({
        status: 0,
        headers: {},
        body: '',
        error: error instanceof Error ? error.message : String(error),
      })
    })
    if (body) request.write(body)
    request.end()
  })
  parent.onDisconnect?.(() => {
    for (const request of requests.values()) request.destroy(makeAbortError())
    requests.clear()
    agent.destroy()
  })
  parent.send({
    type: 'vigo-api-ready',
    transport: 'memory-http',
    storageRoot,
  })
}

await loadRuntimeConfig()

if (!['tcp', 'memory'].includes(apiTransport)) {
  throw new Error(`Unsupported VIGO API transport "${apiTransport}".`)
}
assertLocalBindHost({ host, transport: apiTransport, unsafeNonLoopback })

if (apiTransport === 'memory') {
  await ensureStorage()
  await removeAbandonedStaging().catch((error) => {
    console.warn(`VIGO staging cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
  })
  process.title = 'VIGO'
  startInMemoryHttpTransport()
} else {
  server.listen(port, host, async () => {
    await ensureStorage()
    await removeAbandonedStaging().catch((error) => {
      console.warn(`VIGO staging cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
    })
    const address = server.address()
    const resolvedPort = typeof address === 'object' && address ? address.port : port
    const url = `http://${host}:${resolvedPort}/`
    process.title = 'VIGO'
    if (staticRoot) console.log(`VIGO_READY ${url}`)
    console.log(`VIGO API listening on ${url}`)
    console.log(`Project storage: ${storageRoot}`)
    console.log(`VIGO config: ${configFile}`)
  })
}
