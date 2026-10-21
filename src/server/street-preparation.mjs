import { randomUUID } from 'node:crypto'

/**
 * Walking or driving prepared in a JavaScript worker: the networks of a
 * street-only project, or derived street files a City lacks.
 */
export function prepareStreetsInWorker(pool, drive) {
  return async ({ storePath, workerStorePath = storePath, signal, onProgress }) => {
    const result = await pool.dispatch(workerStorePath, 'prepare-street', {
      streetStorePath: storePath, prepareDrive: drive,
    }, signal, onProgress)
    const street = result?.streetStore
    if (!street?.ready || !street.accelerated
      || (drive && (!street.drive?.ready || street.drive.deferred || !street.drive.accelerated))) {
      throw new Error(drive ? 'Walking and driving street preparation did not finish.' : 'Walking street preparation did not finish.')
    }
  }
}

// Runtime readiness belongs to the live runtime, never to a saved import
// record. `walking` and `driving` open those networks for routing, writing
// any derived files they lack first; each resolves once its mode can route.
export function createStreetPreparationManager({ walking, driving, onJob = () => {} }) {
  const entries = new Map()
  function start({ projectId, storePath, workerStorePath = storePath, identity, label, retry = false, prepareDrive = false }) {
    const previous = entries.get(storePath)
    if (previous?.identity === identity) {
      if (previous.job.status === 'queued' || previous.job.status === 'running') {
        previous.prepareDrive ||= prepareDrive
        return previous.job
      }
      if (previous.job.status === 'complete' && (!prepareDrive || previous.job.result?.modes?.drive)) return previous.job
      if (previous.job.status === 'failed' && !retry) return previous.job
    }
    previous?.controller.abort()
    const controller = new AbortController()
    const job = {
      id: `street-runtime-${randomUUID()}`, kind: 'street-runtime-prepare', projectId,
      label, status: 'queued', phase: prepareDrive ? 'Preparing walking and driving' : 'Preparing walking',
      detail: 'Opening the saved OSM networks in the background',
      createdAt: new Date().toISOString(), retryable: true,
      result: { modes: { walk: false, drive: false } },
    }
    const publish = (patch) => {
      if (patch.phase && patch.phase !== job.phase) {
        job.work = undefined
        job.phaseStartedAt = new Date().toISOString()
      }
      Object.assign(job, patch, { updatedAt: new Date().toISOString() })
      onJob(job)
    }
    const entry = { identity, job, controller, prepareDrive }
    entries.set(storePath, entry)
    onJob(job)
    // No HTTP waiter owns this work. Switching views or reloading does not
    // cancel a shared preparation, and concurrent callers get the same job.
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new Error('Street preparation superseded by a newer OSM network.')
      publish({ status: 'running' })
      const preparation = { projectId, storePath, workerStorePath, signal: controller.signal,
        onProgress: (progress) => publish({ phase: progress.phase, detail: progress.detail, work: progress.work }) }
      await walking(preparation)
      if (!entry.prepareDrive) {
        publish({ status: 'complete', phase: 'Walking ready',
          detail: 'Driving opens when you select Drive', progress: 1,
          result: { modes: { walk: true, drive: false } }, finishedAt: new Date().toISOString() })
        return
      }
      publish({ phase: 'Walking ready · preparing driving',
        detail: 'Walking is available; opening the saved driving network',
        result: { modes: { walk: true, drive: false } } })
      // Driving loads only on demand.
      await driving({ ...preparation, onProgress: (progress) => publish({
        phase: progress.phase, detail: progress.detail, work: progress.work,
        ...(progress.modes ? { result: { modes: { ...progress.modes, walk: true } } } : {}),
      }) })
      publish({ status: 'complete', phase: 'Walking and driving ready',
        detail: 'Background preparation finished for both OSM networks', progress: 1,
        result: { modes: { walk: true, drive: true } }, finishedAt: new Date().toISOString() })
    }).catch((error) => publish({ status: 'failed', phase: 'Street preparation failed',
      error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }))
    return job
  }
  function invalidate(storePath) {
    const entry = entries.get(storePath)
    entry?.controller.abort()
    entries.delete(storePath)
  }
  return { start, invalidate }
}
