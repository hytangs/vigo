import { randomUUID } from 'node:crypto'

// Runtime readiness belongs to a live worker, never to a saved import record.
export function createStreetPreparationManager({ pool, onJob = () => {} }) {
  const entries = new Map()
  function start({ projectId, storePath, workerStorePath = storePath, identity, label, retry = false, prepareDrive = false }) {
    const previous = entries.get(storePath)
    if (previous?.identity === identity) {
      if (previous.job.status === 'queued' || previous.job.status === 'running') {
        previous.prepareDrive ||= prepareDrive
        return previous.job
      }
      if (previous.job.status === 'complete' && pool.isStreetPrepared(workerStorePath, prepareDrive)) return previous.job
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
      const walking = await pool.dispatch(workerStorePath, 'prepare-street', {
        streetStorePath: storePath, prepareDrive: false,
      }, controller.signal, (progress) => publish({ phase: progress.phase, detail: progress.detail, work: progress.work }))
      if (!walking?.streetStore?.ready || !walking.streetStore.accelerated) {
        throw new Error('Walking street preparation did not finish.')
      }
      if (!entry.prepareDrive) {
        publish({ status: 'complete', phase: 'Walking ready',
          detail: 'Driving opens when you select Drive', progress: 1,
          result: { modes: { walk: true, drive: false } }, finishedAt: new Date().toISOString() })
        return
      }
      publish({ phase: 'Walking ready · preparing driving',
        detail: 'Walking is available; opening the saved driving network',
        result: { modes: { walk: true, drive: false } } })
      // Driving loads only on demand. Separate worker operations let queued
      // transit work run between the walking and driving loads.
      const result = await pool.dispatch(workerStorePath, 'prepare-street', {
        streetStorePath: storePath, prepareDrive: true,
      }, controller.signal, (progress) => publish({
        phase: progress.phase, detail: progress.detail, work: progress.work,
        ...(progress.modes ? { result: { modes: { ...progress.modes, walk: true } } } : {}),
      }))
      if (!result?.streetStore?.ready || !result.streetStore.accelerated
        || !result.streetStore.drive?.ready || result.streetStore.drive.deferred
        || !result.streetStore.drive.accelerated) throw new Error('Walking and driving street preparation did not finish.')
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
