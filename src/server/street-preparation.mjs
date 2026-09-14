import { randomUUID } from 'node:crypto'

// Runtime readiness belongs to a live worker, never to a saved import record.
export function createStreetPreparationManager({ pool, onJob = () => {} }) {
  const entries = new Map()
  function start({ projectId, storePath, workerStorePath = storePath, identity, label, retry = false }) {
    const previous = entries.get(storePath)
    if (previous?.identity === identity) {
      if (previous.job.status === 'queued' || previous.job.status === 'running') return previous.job
      if (previous.job.status === 'complete' && pool.isStreetPrepared(workerStorePath, true)) return previous.job
      if (previous.job.status === 'failed' && !retry) return previous.job
    }
    previous?.controller.abort()
    const controller = new AbortController()
    const job = {
      id: `street-runtime-${randomUUID()}`, kind: 'street-runtime-prepare', projectId,
      label, status: 'queued', phase: 'Preparing walking and driving',
      detail: 'Opening the saved OSM networks in the background',
      createdAt: new Date().toISOString(), retryable: true,
      result: { modes: { walk: false, drive: false } },
    }
    const publish = (patch) => {
      Object.assign(job, patch, { updatedAt: new Date().toISOString() })
      onJob(job)
    }
    entries.set(storePath, { identity, job, controller })
    onJob(job)
    // No HTTP waiter owns this work. Switching views or reloading does not
    // cancel a shared preparation, and concurrent callers get the same job.
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new Error('Street preparation superseded by a newer OSM network.')
      publish({ status: 'running' })
      const result = await pool.dispatch(workerStorePath, 'prepare-street', {
        streetStorePath: storePath, prepareDrive: true,
      }, controller.signal, (progress) => publish({
        phase: progress.phase, detail: progress.detail,
        ...(progress.modes ? { result: { modes: progress.modes } } : {}),
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
