import { useCallback, useEffect, useState } from 'react'
import { apiJson } from './api'
import { isActiveTask, type PreparationTask } from './preparation'

export function useStreetPreparation({ active, projectId, identity, refreshKey = '' }: { active: boolean; projectId: string; identity: string; refreshKey?: string }) {
  const key = `${projectId}:${identity}:${refreshKey}`
  const [state, setState] = useState<{ key: string; task: PreparationTask } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  useEffect(() => {
    setState(null)
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let task: PreparationTask | null = null
    const controller = new AbortController()
    const leaseId = `city-streets-${crypto.randomUUID()}`
    const endpoint = `/api/projects/${encodeURIComponent(projectId)}/street-residency`
    let acquisition: Promise<{ job: PreparationTask }> | null = null
    const acquire = (forceRetry: boolean) => {
      // Let registration settle before cleanup releases this lease. Aborting
      // the HTTP request could release first and leave a late lease behind.
      acquisition = apiJson<{ job: PreparationTask }>(endpoint, {
        method: 'POST', body: JSON.stringify({ resident: true, leaseId, retry: forceRetry }),
      })
      return acquisition
    }
    const commit = (next: PreparationTask) => {
      task = next
      if (!stopped) setState({ key, task: next })
    }
    const update = async (reacquire = false, forceRetry = false) => {
      if (stopped) return
      try {
        const response = reacquire || !task || !isActiveTask(task)
          ? await acquire(forceRetry)
          : await apiJson<{ job: PreparationTask }>(`/api/projects/${encodeURIComponent(projectId)}/national-gtfs-job?jobId=${encodeURIComponent(task.id)}`, { signal: controller.signal })
        if (stopped) return
        commit(response.job)
        // A completed task stays complete. Reacquire when entering a routing
        // mode or reopening the City; periodically rebuilding evicted workers
        // makes open Cities compete endlessly under memory pressure.
        if (isActiveTask(response.job)) timer = setTimeout(() => { void update() }, 500)
      } catch (error) {
        if (stopped) return
        commit({ ...(task ?? {
          id: `${projectId}:street-status`, kind: 'street-runtime-prepare', label: 'OpenStreetMap',
          status: 'queued', createdAt: new Date().toISOString(), phase: 'Preparing walking and driving',
        }), statusError: error instanceof Error ? error.message : 'Street preparation status is unavailable.' })
        timer = setTimeout(() => { void update(true) }, 5_000)
      }
    }
    void update(true, attempt > 0)
    return () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
      const release = () => fetch(endpoint, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resident: false, leaseId }),
      }).catch(() => {})
      if (acquisition) void acquisition.then(release, release)
      else void release()
    }
  }, [active, projectId, key, attempt])
  const task = !active ? null : state?.key === key ? state.task : {
    id: `${projectId}:street-starting`, kind: 'street-runtime-prepare', label: 'OpenStreetMap',
    status: 'queued' as const, phase: 'Preparing walking and driving', createdAt: '',
  }
  return {
    task, retry,
    ready: task?.status === 'complete' && !task.statusError,
    error: task?.statusError || task?.error || '',
  }
}
