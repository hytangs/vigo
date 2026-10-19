import { apiJson } from '../app/api'
import { isActiveTask, isPreparationJob, updateProjectJob, type PreparationTask } from '../app/preparation'
import type { JobRecord } from '../domain'
import { city, refreshImportedProject, setActiveFeedId, setImportMessage, setOsmStreetMessage, updatePendingPreparations, updateProjects } from './city'
import { clock, serviceDay } from './clock'
import { retryScheduleLoad } from './network'
import { importJobs, preparationJobs, selectedProject } from './scope'
import { shell } from './shell'

// Street preparation runs in CityRuntime; its retry is registered here.
const streetControl = { retry: () => {} }
export function registerStreetRetry(retry: () => void) {
  streetControl.retry = retry
}

const importPollingPromises = new Map<string, { promise: Promise<JobRecord>; controller: AbortController }>()
let preparationGeneration = 0
const pollingKey = (projectId: string, jobId: string) => JSON.stringify([projectId, jobId])

export function resetPreparation() {
  preparationGeneration += 1
  for (const entry of importPollingPromises.values()) entry.controller.abort()
  importPollingPromises.clear()
}

function pollingPause(signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, 250)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export async function waitForImportJob(
  projectId: string,
  jobId: string,
  onProgress: (message: string) => void,
  failureLabel: string,
) {
  const key = pollingKey(projectId, jobId)
  const existing = importPollingPromises.get(key)
  if (existing) return existing.promise
  const controller = new AbortController()
  const { signal } = controller
  const polling = (async () => {
    let firstPoll = true
    while (true) {
      if (!firstPoll) await pollingPause(signal)
      signal.throwIfAborted()
      firstPoll = false
      const result = await apiJson<{ job: JobRecord }>(
        `/api/projects/${encodeURIComponent(projectId)}/national-gtfs-job?jobId=${encodeURIComponent(jobId)}`,
        { signal },
      ).catch((error) => {
        if (signal.aborted) throw error
        city.set(({ preparationErrors }) => ({
          preparationErrors: { ...preparationErrors, [projectId]: { ...preparationErrors[projectId], [jobId]: error instanceof Error ? error.message : 'Task status is unavailable.' } },
        }))
        throw error
      })
      signal.throwIfAborted()
      // Keep frequent job ticks separate from the feeds used to build the map.
      city.set(({ preparationJobUpdates }) => ({ preparationJobUpdates: { ...preparationJobUpdates, [projectId]: { ...preparationJobUpdates[projectId], [jobId]: result.job } } }))
      updateProjects((current) => current.find((project) => project.id === projectId)?.jobs.some((job) => job.id === jobId)
        ? current : updateProjectJob(current, projectId, result.job))
      city.set(({ preparationErrors }) => {
        if (!preparationErrors[projectId]?.[jobId]) return {}
        const next = { ...preparationErrors[projectId] }; delete next[jobId]
        return { preparationErrors: { ...preparationErrors, [projectId]: next } }
      })
      if (selectedProject().id === projectId) onProgress([result.job.phase, result.job.detail].filter(Boolean).join(' · '))
      if (result.job.status === 'failed' || result.job.status === 'cancelled') {
        await refreshImportedProject(projectId, false).catch(() => {})
        throw new Error(result.job.error || (result.job.status === 'cancelled' ? 'Preparation cancelled.' : failureLabel))
      }
      if (result.job.status === 'complete') return result.job
    }
  })()
  importPollingPromises.set(key, { promise: polling, controller })
  try {
    return await polling
  } finally {
    if (importPollingPromises.get(key)?.promise === polling) importPollingPromises.delete(key)
  }
}

async function startPreparation(projectId: string, kind: string, label: string, submit: () => Promise<{ id: string }>) {
  const generation = preparationGeneration
  const key = `${projectId}:${kind}`
  const task: PreparationTask = { id: key, kind, label, status: 'running', phase: 'Loading source data', createdAt: new Date().toISOString() }
  updatePendingPreparations((current) => ({ ...current, [key]: task }))
  shell.set({ backgroundTasksOpen: true })
  try {
    const result = await submit()
    if (generation !== preparationGeneration) throw new DOMException('Studio reset', 'AbortError')
    updateProjects((current) => updateProjectJob(current, projectId, {
      ...task, status: 'queued', progress: 0, phase: 'Waiting for processing status', ...result,
    }))
    updatePendingPreparations((current) => { const next = { ...current }; delete next[key]; return next })
    return result
  } catch (error) {
    if (generation !== preparationGeneration) throw error
    updatePendingPreparations((current) => ({ ...current, [key]: { ...task, status: 'failed', error: error instanceof Error ? error.message : 'Could not load source data.' } }))
    throw error
  }
}

export async function reconnectPreparation(task: PreparationTask) {
  if (task.kind === 'vehicle-schedules') {
    retryScheduleLoad(task.id)
    return
  }
  if (task.kind === 'street-runtime-prepare') { streetControl.retry(); return }
  const projectId = selectedProject().id
  try {
    await waitForImportJob(projectId, task.id, () => {}, 'Data preparation failed')
    await refreshImportedProject(projectId, true)
  } catch { /* The task panel retains the last status and connection error. */ }
}

/** Follow every running import of the selected City until it settles. */
export function followActivePreparationJobs() {
  const projectId = selectedProject().id
  const generation = preparationGeneration
  for (const job of preparationJobs().filter((entry) => isPreparationJob(entry) && isActiveTask(entry))) {
    if (importPollingPromises.has(pollingKey(projectId, job.id))) continue
    const kind = job.kind === 'national-osm-import' ? 'osm' : 'gtfs'
    void waitForImportJob(
      projectId,
      job.id,
      kind === 'gtfs' ? setImportMessage : setOsmStreetMessage,
      kind === 'gtfs' ? 'GTFS indexing failed' : 'Street indexing failed',
    ).then(async (completed) => {
      if (generation !== preparationGeneration) return
      await refreshImportedProject(projectId, true)
      if (generation === preparationGeneration && selectedProject().id === projectId && kind === 'gtfs' && completed.result?.feedId) setActiveFeedId(completed.result.feedId)
    }).catch((error) => {
      if (generation !== preparationGeneration || selectedProject().id !== projectId) return
      const message = error instanceof Error ? error.message : 'Preparation failed.'
      if (kind === 'gtfs') setImportMessage(message)
      else setOsmStreetMessage(message)
    }).finally(() => {
      if (generation !== preparationGeneration || selectedProject().id !== projectId) return
      city.set(kind === 'gtfs' ? { isImporting: false } : { isOsmImporting: false })
    })
  }
}

/** Show an import as running while the selected City has a queued or running job of its kind. */
export function syncImportFlags() {
  const { gtfsImportJob, osmImportJob, latestActiveGtfsJob, latestActiveOsmJob } = importJobs()
  const { gtfsImportJobId, osmImportJobId } = city.get()
  if (latestActiveGtfsJob) {
    city.set({ gtfsImportJobId: latestActiveGtfsJob.id, isImporting: true })
  } else if (gtfsImportJobId && gtfsImportJob?.status && gtfsImportJob.status !== 'running' && gtfsImportJob.status !== 'queued') {
    city.set({ isImporting: false })
  }
  if (latestActiveOsmJob) {
    city.set({ osmImportJobId: latestActiveOsmJob.id, isOsmImporting: true })
  } else if (osmImportJobId && osmImportJob?.status && osmImportJob.status !== 'running' && osmImportJob.status !== 'queued') {
    city.set({ isOsmImporting: false })
  }
}

// All import entry points share one completion owner. Library/job updates may
// finish in the background; feed selection and messages belong to the initiating
// City and Studio generation only.
async function runSourceImport(
  projectId: string, kind: 'gtfs' | 'osm', label: string,
  submit: () => Promise<{ id: string }>, initial: string, success: string,
) {
  const generation = preparationGeneration
  const ownsView = () => generation === preparationGeneration && selectedProject().id === projectId
  const message = kind === 'gtfs' ? setImportMessage : setOsmStreetMessage
  city.set(kind === 'gtfs' ? { isImporting: true } : { isOsmImporting: true })
  message(initial)
  try {
    const job = await startPreparation(projectId, kind === 'gtfs' ? 'national-gtfs-import' : 'national-osm-import', label, submit)
    if (ownsView()) city.set(kind === 'gtfs' ? { gtfsImportJobId: job.id } : { osmImportJobId: job.id })
    const completed = await waitForImportJob(projectId, job.id, message, `${kind === 'gtfs' ? 'GTFS' : 'Street'} indexing failed`)
    if (generation !== preparationGeneration) return
    await refreshImportedProject(projectId, true)
    if (!ownsView()) return
    if (kind === 'gtfs' && completed.result?.feedId) setActiveFeedId(completed.result.feedId)
    message(success)
  } catch (error) {
    if (ownsView()) message(error instanceof Error ? error.message : 'Preparation failed.')
  } finally {
    if (ownsView()) city.set(kind === 'gtfs' ? { isImporting: false } : { isOsmImporting: false })
  }
}

async function cancelImportJob(kind: 'gtfs' | 'osm') {
  const { gtfsImportJob, osmImportJob } = importJobs()
  const job = kind === 'gtfs' ? gtfsImportJob : osmImportJob
  if (!job?.id) return
  const projectId = selectedProject().id, generation = preparationGeneration
  const ownsView = () => generation === preparationGeneration && selectedProject().id === projectId
  const message = kind === 'gtfs' ? setImportMessage : setOsmStreetMessage
  try {
    await apiJson(`/api/projects/${encodeURIComponent(projectId)}/national-job-cancel`, {
      method: 'POST', body: JSON.stringify({ jobId: job.id }),
    })
    if (generation !== preparationGeneration) return
    await refreshImportedProject(projectId, false)
    if (ownsView()) message(`${kind.toUpperCase()} preparation cancelled; the source is available to retry.`)
  } catch (error) {
    if (ownsView()) message(error instanceof Error ? error.message : 'Preparation could not be cancelled.')
  }
}

async function retryImportJob(kind: 'gtfs' | 'osm') {
  const { gtfsImportJob, osmImportJob } = importJobs()
  const job = kind === 'gtfs' ? gtfsImportJob : osmImportJob
  if (!job?.id) return
  const projectId = selectedProject().id
  await runSourceImport(projectId, kind, job.label, async () => (await apiJson<{ job: { id: string } }>(
    `/api/projects/${encodeURIComponent(projectId)}/national-job-retry`, {
      method: 'POST', body: JSON.stringify({ jobId: job.id }),
    })).job, `Retrying ${kind.toUpperCase()} preparation…`, `${kind.toUpperCase()} routing store ready`)
}

async function uploadProjectSourceFile(
  projectId: string,
  file: File,
  action: 'national-gtfs-upload' | 'national-osm-upload',
  privateAccess: 'public' | 'endpoints' = 'public',
) {
  const parameters = new URLSearchParams({ fileName: file.name })
  if (action === 'national-gtfs-upload') {
    parameters.set('preloadServiceDate', clock.get().serviceDate)
    parameters.set('preloadServiceDay', serviceDay())
  }
  if (action === 'national-osm-upload') parameters.set('privateAccess', privateAccess)
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${action}?${parameters}`,
    {
      method: 'POST',
      headers: { 'Content-Type': action === 'national-gtfs-upload' ? 'application/zip' : 'application/octet-stream' },
      body: file,
    },
  )
  const body = await response.json().catch(() => ({})) as { job?: { id: string }; error?: string }
  if (!response.ok || !body.job?.id) throw new Error(body.error || `Source upload failed with ${response.status}`)
  return body.job
}

export async function handleFiles(filesLike: FileList | File[]) {
  const file = Array.from(filesLike).find((candidate) => candidate.name.toLowerCase().endsWith('.zip'))
  if (!file || city.get().isImporting) return
  const projectId = selectedProject().id
  if (!city.get().projects.some((project) => project.id === projectId)) {
    setImportMessage('Create a City before loading GTFS.')
    shell.set({ page: 'projects' })
    return
  }
  await runSourceImport(projectId, 'gtfs', file.name, () => uploadProjectSourceFile(projectId, file, 'national-gtfs-upload'),
    `Staging ${file.name} for SQLite indexing...`, `${file.name} / SQLite routing store ready`)
}

export async function handleNationalGtfsPath(sourcePath: string) {
  if (!sourcePath || city.get().isImporting) return
  const projectId = selectedProject().id
  await runSourceImport(projectId, 'gtfs', sourcePath.split(/[\\/]/).pop() || 'GTFS feed', async () => (await apiJson<{ job: { id: string } }>(
    `/api/projects/${encodeURIComponent(projectId)}/national-gtfs-import`, {
      method: 'POST', body: JSON.stringify({ sourcePath, replaceProjectSchedule: false,
        preloadServiceDate: clock.get().serviceDate, preloadServiceDay: serviceDay() }),
    })).job, 'Starting local GTFS index', 'GTFS SQLite routing store ready')
}

export async function handleNationalOsmPath(sourcePath: string, privateAccess: 'public' | 'endpoints' = 'public') {
  if (!sourcePath || city.get().isOsmImporting) return
  const projectId = selectedProject().id
  await runSourceImport(projectId, 'osm', sourcePath.split(/[\\/]/).pop() || 'OSM streets', async () => (await apiJson<{ job: { id: string } }>(
    `/api/projects/${encodeURIComponent(projectId)}/national-osm-import`, {
      method: 'POST', body: JSON.stringify({ sourcePath, privateAccess }),
    })).job, 'Starting local street index', 'Pedestrian SQLite street index ready')
}

export async function handleOsmFiles(filesLike: FileList | File[], privateAccess: 'public' | 'endpoints' = 'public') {
  const file = Array.from(filesLike).find((candidate) => /\.pbf$/i.test(candidate.name))
  if (!file || city.get().isOsmImporting) return
  const projectId = selectedProject().id
  await runSourceImport(projectId, 'osm', file.name, () => uploadProjectSourceFile(projectId, file, 'national-osm-upload', privateAccess),
    `Staging ${file.name} for SQLite street indexing...`, `${file.name} / SQLite street index ready`)
}

export const cancelGtfsImport = () => { void cancelImportJob('gtfs') }
export const retryGtfsImport = () => { void retryImportJob('gtfs') }
export const cancelOsmImport = () => { void cancelImportJob('osm') }
export const retryOsmImport = () => { void retryImportJob('osm') }
