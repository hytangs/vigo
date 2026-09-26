import crypto from 'node:crypto'
import { parentPort } from 'node:worker_threads'

const workerInstance = crypto.randomUUID()
let prepareCount = 0
let streetPrepareCount = 0
let routingAccessPrepareCount = 0
let derivedArtifactsReady = false
const operationCounts = {}

function wait(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function metrics() {
  const memory = process.memoryUsage()
  const reportedProcessRssBytes = Number(process.env.VIGO_MOCK_REPORTED_RSS_BYTES) || memory.rss
  const reportedIsolateResidentEstimateBytes = Number(process.env.VIGO_MOCK_REPORTED_ISOLATE_BYTES)
    || memory.heapUsed + memory.external
  return {
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBufferBytes: memory.arrayBuffers,
    isolateResidentEstimateBytes: reportedIsolateResidentEstimateBytes,
    processRssBytes: reportedProcessRssBytes,
    processRssScope: 'process-wide-snapshot',
    operationCounts: { ...operationCounts },
  }
}

function routePlan(request = {}) {
  wait(Number(request.testDelayMs ?? 0))
  if (request.serviceDate === process.env.VIGO_MOCK_BLOCKED_SERVICE_DATE) {
    return {
      id: `mock-blocked-${crypto.randomUUID()}`,
      status: 'blocked',
      travelMode: 'transit',
      timePreference: request.timePreference === 'arrive' ? 'arrive' : 'depart',
      departMinutes: Number(request.departMinutes ?? 480),
      durationMinutes: 0,
      waitMinutes: 0,
      walkMinutes: 0,
      rideMinutes: 0,
      transfers: 0,
      origin: request.origin,
      destination: request.destination,
      legs: [],
      diagnostics: {
        workerInstance,
        failure: {
          code: 'coverage_incomplete',
          category: 'data_coverage',
          retryable: false,
        },
      },
    }
  }
  return {
    id: `mock-${crypto.randomUUID()}`,
    status: 'ready',
    travelMode: 'transit',
    timePreference: request.timePreference === 'arrive' ? 'arrive' : 'depart',
    departMinutes: Number(request.departMinutes ?? 480),
    arriveMinutes: Number(request.departMinutes ?? 480) + 12,
    durationMinutes: 12,
    waitMinutes: 0,
    walkMinutes: 2,
    rideMinutes: 10,
    transfers: 0,
    origin: request.origin,
    destination: request.destination,
    legs: [],
    diagnostics: { workerInstance },
  }
}

parentPort.on('message', (message) => {
  const { id, operation, storePath, request = {} } = message ?? {}
  const staleDerivedArtifactFixture = String(storePath ?? '').includes(
    String(process.env.VIGO_MOCK_STALE_TOPOLOGY_PROJECT ?? '\u0000'),
  )
  operationCounts[operation] = Number(operationCounts[operation] ?? 0) + 1
  try {
    let result
    if (operation === 'prepare-street') {
      if (request.prepareDrive) {
        parentPort.postMessage({ type: 'progress', id, workerInstance, progress: {
          phase: 'Opening walking street snapshot', detail: 'Fixture walking preparation', modes: { walk: false, drive: false },
        } })
        wait(Number(process.env.VIGO_MOCK_STREET_PREPARE_DELAY_MS ?? 0) / 2)
        parentPort.postMessage({ type: 'progress', id, workerInstance, progress: {
          phase: 'Opening driving street snapshot', detail: 'Fixture driving preparation', modes: { walk: true, drive: false },
        } })
        wait(Number(process.env.VIGO_MOCK_STREET_PREPARE_DELAY_MS ?? 0) / 2)
      }
      result = {
        ready: true,
        workerInstance,
        streetStore: request.streetStorePath
          ? {
              ready: true,
              accelerated: true,
              reason: 'ready',
              prepareMs: 1,
              buildMs: 0,
              ...(request.prepareDrive ? { drive: { ready: true, accelerated: true } } : {}),
            }
          : {
              ready: true,
              accelerated: false,
              reason: 'not_configured',
              prepareMs: 0,
              buildMs: 0,
            },
      }
    } else if (operation === 'prepare-transfers') {
      result = {
        ready: true,
        workerInstance,
        streetStore: request.streetStorePath
          ? {
              ready: true,
              accelerated: true,
              reason: 'ready',
              prepareMs: 1,
              buildMs: 0,
            }
          : {
              ready: true,
              accelerated: false,
              reason: 'not_configured',
              prepareMs: 0,
              buildMs: 0,
            },
        osmStopTransfers: request.streetStorePath
          ? { ready: true, built: false, edgeCount: 1 }
          : null,
      }
    } else if (operation === 'prepare-derived') {
      derivedArtifactsReady = true
      result = {
        ready: true,
        refreshed: true,
        source: 'sidecar',
        workerInstance,
      }
    } else if (operation === 'prepare-routing-access') {
      routingAccessPrepareCount += 1
      if (request.streetStorePath) streetPrepareCount += 1
      const accessPrepareDelayMs = request.serviceDate === process.env.VIGO_MOCK_SLOW_SERVICE_DATE
        ? Number(process.env.VIGO_MOCK_SLOW_PREPARE_DELAY_MS ?? process.env.VIGO_MOCK_ACCESS_PREPARE_DELAY_MS ?? 0)
        : Number(process.env.VIGO_MOCK_ACCESS_PREPARE_DELAY_MS ?? process.env.VIGO_MOCK_PREPARE_DELAY_MS ?? 0)
      wait(accessPrepareDelayMs)
      result = {
        ready: true,
        workerInstance,
        routingAccessPrepareCount,
        streetPrepareCount,
        prepareRequest: request,
        accessMaterialization: { ready: true, reason: 'ready' },
        streetStore: request.streetStorePath
          ? { ready: true, accelerated: true, reason: 'ready', prepareMs: 1, buildMs: 1, drive: { ready: true, deferred: true } }
          : { ready: true, accelerated: false, reason: 'not_configured', prepareMs: 0, buildMs: 0 },
        osmStopTransfers: request.streetStorePath
          ? { ready: true, built: false, edgeCount: 1 }
          : null,
      }
    } else if (operation === 'prepare') {
      prepareCount += 1
      if (request.streetStorePath) streetPrepareCount += 1
      const prepareDelayMs = request.readinessOnly
        ? Number(process.env.VIGO_MOCK_READINESS_DELAY_MS ?? 0)
        : request.serviceDate === process.env.VIGO_MOCK_SLOW_SERVICE_DATE
          ? Number(process.env.VIGO_MOCK_SLOW_PREPARE_DELAY_MS ?? process.env.VIGO_MOCK_PREPARE_DELAY_MS ?? 0)
          : Number(process.env.VIGO_MOCK_PREPARE_DELAY_MS ?? 0)
      wait(prepareDelayMs)
      result = {
        ready: true,
        workerInstance,
        prepareCount,
        prepareRequest: request,
        streetPrepareCount,
        accessMaterialization: request.readinessOnly
          ? { ready: false, reason: 'deferred' }
          : { ready: true, reason: 'ready' },
        transferSemanticsAdmission: request.readinessOnly
          ? { ready: false, reason: 'deferred' }
          : { ready: true, reason: 'ready' },
        activeServiceKernel: request.readinessOnly
          ? { ready: false, reason: 'background_preparation' }
          : { ready: true, reason: 'ready' },
        streetStore: request.readinessOnly
          ? { ready: true, accelerated: false, deferred: true, reason: 'background_access_preparation', prepareMs: 0, buildMs: 0 }
          : request.streetStorePath
            ? { ready: true, accelerated: true, reason: 'ready', prepareMs: 1, buildMs: 1 }
            : { ready: true, accelerated: false, reason: 'not_configured', prepareMs: 0, buildMs: 0 },
      }
    } else if (operation === 'search') {
      result = [{ id: 'mock-stop', name: 'Mock stop', workerInstance }]
    } else if (operation === 'window') {
      const plan = routePlan(request)
      result = {
        plan,
        choices: [plan],
        profile: {
          centerMinutes: plan.departMinutes,
          beforeMinutes: Number(request.departureWindowMinutes ?? 0),
          afterMinutes: Number(request.departureWindowMinutes ?? 0),
          sampleCount: 1,
          routeSearches: 1,
          plans: [plan],
        },
      }
    } else if (operation === 'matrix' || operation === 'street-matrix') {
      const origins = Array.isArray(request.origins) ? request.origins : []
      const destinations = Array.isArray(request.destinations) ? request.destinations : []
      result = {
        schemaVersion: 'vigo.routing.matrix.v1',
        rows: origins.flatMap((_, originIndex) => destinations.map((__, destinationIndex) => ({
          originIndex,
          destinationIndex,
          status: 'ready',
          departMinutes: Number(request.departMinutes ?? 480),
          arriveMinutes: Number(request.departMinutes ?? 480) + 12,
          durationMinutes: 12,
        }))),
        diagnostics: {
          workerInstance,
          matrixStrategy: request.matrixStrategy ?? 'auto',
          origins: origins.length,
          destinations: destinations.length,
          pairs: origins.length * destinations.length,
        },
      }
    } else if (operation === 'street-route') {
      result = { ...routePlan(request), travelMode: request.mode }
    } else if (operation === 'route') {
      if (staleDerivedArtifactFixture && !derivedArtifactsReady) {
        const error = new Error(
          'Resident timetable kernel failed; no SQL route executor exists: topology_unavailable',
        )
        error.code = 'resident_timetable_kernel_required'
        error.activeServiceKernel = {
          ready: false,
          reason: 'topology_unavailable',
        }
        throw error
      }
      result = routePlan(request)
    } else {
      throw new Error(`Unsupported mock route-worker operation: ${operation}`)
    }
    parentPort.postMessage({ type: 'complete', id, result, workerInstance, metrics: metrics() })
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      id,
      error: error instanceof Error ? error.stack || error.message : String(error),
      errorCode: error?.code,
      errorContext: error?.activeServiceKernel
        ? { activeServiceKernel: error.activeServiceKernel }
        : undefined,
      workerInstance,
      metrics: metrics(),
    })
  }
})
