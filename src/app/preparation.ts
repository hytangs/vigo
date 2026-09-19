import type { JobRecord, VigoProject } from '../domain'

export type PreparationTask = Omit<JobRecord, 'progress'> & { progress?: number; statusError?: string }
export const isActiveTask = (task: Pick<JobRecord, 'status'>) => task.status === 'queued' || task.status === 'running'
export const isPreparationJob = (job: JobRecord) => ['national-gtfs-import', 'national-osm-import', 'national-gtfs-merge'].includes(job.kind)

export function updateProjectJob(projects: VigoProject[], projectId: string, job: JobRecord) {
  return projects.map((project) => project.id === projectId
    ? { ...project, jobs: [job, ...project.jobs.filter((entry) => entry.id !== job.id)] }
    : project)
}

export function preparationTasks(jobs: JobRecord[], pending: PreparationTask[], errors: Record<string, string>): PreparationTask[] {
  const seenKinds = new Set(pending.map((task) => task.kind))
  const recent = [...jobs].filter(isPreparationJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((job) => {
      const keep = !seenKinds.has(job.kind) || isActiveTask(job)
      seenKinds.add(job.kind)
      return keep
    })
  return [...pending, ...recent.map((job) => ({ ...job, statusError: errors[job.id] }))]
    .sort((a, b) => Number(isActiveTask(b)) - Number(isActiveTask(a)))
}

export function taskPercent(task: PreparationTask) {
  if (task.status === 'complete') return 100
  if (task.status === 'queued' || !Number.isFinite(task.progress)) return undefined
  // A worker may finish its phase before the server publishes the final store.
  return Math.min(99, Math.max(0, Math.floor(Number(task.progress) * 100)))
}

export function preparationState(ready: boolean, tasks: PreparationTask[], kinds: string[], building = false) {
  const relevant = tasks.filter((task) => kinds.includes(task.kind))
  const active = relevant.find(isActiveTask)
  if (active) return { status: active.statusError ? 'paused' : 'working', label: active.statusError ? 'Updates paused' : active.status === 'queued' ? 'Queued' : 'Processing', detail: active.statusError || active.phase || 'Preparing data' }
  if (ready) return { status: 'ready', label: 'Ready', detail: '' }
  const failed = relevant.find((task) => task.status === 'failed' || task.status === 'cancelled')
  if (failed) return { status: 'failed', label: failed.status === 'cancelled' ? 'Cancelled' : 'Failed', detail: failed.error || failed.detail || 'Open City to retry or choose another file.' }
  if (building) return { status: 'working', label: 'Loading', detail: 'Loading prepared data into this City' }
  return { status: 'missing', label: 'Import needed', detail: '' }
}
