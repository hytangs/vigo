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

const importPollingPromises = new Map<string, Promise<JobRecord>>()

export const resetPreparation = () => importPollingPromises.clear()

export async function waitForImportJob(
  projectId: string,
  jobId: string,
  onProgress: (message: string) => void,
  failureLabel: string,
) {
  const existing = importPollingPromises.get(jobId)
  if (existing) return existing
  const polling = (async () => {
    let firstPoll = true
    while (true) {
      if (!firstPoll) await new Promise((resolve) => window.setTimeout(resolve, 250))
      firstPoll = false
      const result = await apiJson<{ job: JobRecord }>(
        `/api/projects/${encodeURIComponent(projectId)}/national-gtfs-job?jobId=${encodeURIComponent(jobId)}`,
      ).catch((error) => {
        city.set(({ preparationErrors }) => ({
          preparationErrors: { ...preparationErrors, [jobId]: error instanceof Error ? error.message : 'Task status is unavailable.' },
        }))
        throw error
      })
      // Keep frequent job ticks separate from the feeds used to build the map.
      city.set(({ preparationJobUpdates }) => ({ preparationJobUpdates: { ...preparationJobUpdates, [jobId]: result.job } }))
      updateProjects((current) => current.find((project) => project.id === projectId)?.jobs.some((job) => job.id === jobId)
        ? current : updateProjectJob(current, projectId, result.job))
      city.set(({ preparationErrors }) => {
        if (!preparationErrors[jobId]) return {}
        const next = { ...preparationErrors }; delete next[jobId]; return { preparationErrors: next }
      })
      if (selectedProject().id === projectId) onProgress([result.job.phase, result.job.detail].filter(Boolean).join(' · '))
      if (result.job.status === 'failed' || result.job.status === 'cancelled') {
        await refreshImportedProject(projectId, false).catch(() => {})
        throw new Error(result.job.error || (result.job.status === 'cancelled' ? 'Preparation cancelled.' : failureLabel))
      }
      if (result.job.status === 'complete') return result.job
    }
  })()
  importPollingPromises.set(jobId, polling)
  try {
    return await polling
  } finally {
    if (importPollingPromises.get(jobId) === polling) importPollingPromises.delete(jobId)
  }
}

async function startPreparation(kind: string, label: string, submit: () => Promise<{ id: string }>) {
  const projectId = selectedProject().id
  const key = `${projectId}:${kind}`
  const task: PreparationTask = { id: key, kind, label, status: 'running', phase: 'Loading source data', createdAt: new Date().toISOString() }
  updatePendingPreparations((current) => ({ ...current, [key]: task }))
  shell.set({ backgroundTasksOpen: true })
  try {
    const result = await submit()
    updateProjects((current) => updateProjectJob(current, projectId, {
      ...task, status: 'queued', progress: 0, phase: 'Waiting for processing status', ...result,
    }))
    updatePendingPreparations((current) => { const next = { ...current }; delete next[key]; return next })
    return result
  } catch (error) {
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
  for (const job of preparationJobs().filter((entry) => isPreparationJob(entry) && isActiveTask(entry))) {
    if (importPollingPromises.has(job.id)) continue
    const kind = job.kind === 'national-osm-import' ? 'osm' : 'gtfs'
    void waitForImportJob(
      projectId,
      job.id,
      kind === 'gtfs' ? setImportMessage : setOsmStreetMessage,
      kind === 'gtfs' ? 'GTFS indexing failed' : 'Street indexing failed',
    ).then(async (completed) => {
      await refreshImportedProject(projectId, true)
      if (selectedProject().id === projectId && kind === 'gtfs' && completed.result?.feedId) setActiveFeedId(completed.result.feedId)
    }).catch((error) => {
      if (selectedProject().id !== projectId) return
      const message = error instanceof Error ? error.message : 'Preparation failed.'
      if (kind === 'gtfs') setImportMessage(message)
      else setOsmStreetMessage(message)
    }).finally(() => {
      if (selectedProject().id !== projectId) return
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

async function cancelImportJob(kind: 'gtfs' | 'osm') {
  const { gtfsImportJob, osmImportJob } = importJobs()
  const job = kind === 'gtfs' ? gtfsImportJob : osmImportJob
  if (!job?.id) return
  const projectId = selectedProject().id
  try {
    await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(projectId)}/national-job-cancel`, {
      method: 'POST',
      body: JSON.stringify({ jobId: job.id }),
    })
    await refreshImportedProject(projectId, false)
    if (kind === 'gtfs') setImportMessage('GTFS preparation cancelled; the source is available to retry.')
    else setOsmStreetMessage('OSM preparation cancelled; the source is available to retry.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preparation could not be cancelled.'
    if (kind === 'gtfs') setImportMessage(message)
    else setOsmStreetMessage(message)
  }
}

async function retryImportJob(kind: 'gtfs' | 'osm') {
  const { gtfsImportJob, osmImportJob } = importJobs()
  const job = kind === 'gtfs' ? gtfsImportJob : osmImportJob
  if (!job?.id) return
  const projectId = selectedProject().id
  if (kind === 'gtfs') city.set({ isImporting: true, importMessage: 'Retrying GTFS preparation…' })
  else city.set({ isOsmImporting: true, osmStreetMessage: 'Retrying OSM preparation…' })
  try {
    const nextJob = await startPreparation(job.kind, job.label, async () => (await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(projectId)}/national-job-retry`, {
      method: 'POST',
      body: JSON.stringify({ jobId: job.id }),
    })).job)
    city.set(kind === 'gtfs' ? { gtfsImportJobId: nextJob.id } : { osmImportJobId: nextJob.id })
    const completed = await waitForImportJob(
      projectId,
      nextJob.id,
      kind === 'gtfs' ? setImportMessage : setOsmStreetMessage,
      kind === 'gtfs' ? 'GTFS indexing failed' : 'Street indexing failed',
    )
    await refreshImportedProject(projectId, true)
    if (kind === 'gtfs') {
      if (completed.result?.feedId) setActiveFeedId(completed.result.feedId)
      setImportMessage('GTFS SQLite routing store ready')
    } else {
      setOsmStreetMessage('Pedestrian SQLite street index ready')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preparation retry failed.'
    if (kind === 'gtfs') setImportMessage(message)
    else setOsmStreetMessage(message)
  } finally {
    city.set(kind === 'gtfs' ? { isImporting: false } : { isOsmImporting: false })
  }
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

  city.set({ isImporting: true })
  try {
    setImportMessage(`Staging ${file.name} for SQLite indexing...`)
    const job = await startPreparation('national-gtfs-import', file.name, () => uploadProjectSourceFile(projectId, file, 'national-gtfs-upload'))
    city.set({ gtfsImportJobId: job.id })
    const completed = await waitForImportJob(projectId, job.id, setImportMessage, 'GTFS indexing failed')
    await refreshImportedProject(projectId, true)
    if (completed.result?.feedId) setActiveFeedId(completed.result.feedId)
    setImportMessage(`${file.name} / SQLite routing store ready`)
  } catch (error) {
    setImportMessage(error instanceof Error ? error.message : 'GTFS indexing failed')
  } finally {
    city.set({ isImporting: false })
  }
}

export async function handleNationalGtfsPath(sourcePath: string) {
  if (!sourcePath || city.get().isImporting) return
  const projectId = selectedProject().id
  city.set({ isImporting: true, importMessage: 'Starting local GTFS index' })
  try {
    const job = await startPreparation('national-gtfs-import', sourcePath.split(/[\\/]/).pop() || 'GTFS feed', async () => (await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(projectId)}/national-gtfs-import`, {
      method: 'POST',
      body: JSON.stringify({
        sourcePath,
        replaceProjectSchedule: false,
        preloadServiceDate: clock.get().serviceDate,
        preloadServiceDay: serviceDay(),
      }),
    })).job)
    city.set({ gtfsImportJobId: job.id })
    const completed = await waitForImportJob(projectId, job.id, setImportMessage, 'GTFS indexing failed')
    await refreshImportedProject(projectId, true)
    if (completed.result?.feedId) setActiveFeedId(completed.result.feedId)
    setImportMessage('GTFS SQLite routing store ready')
  } catch (error) {
    setImportMessage(error instanceof Error ? error.message : 'GTFS indexing failed')
  } finally {
    city.set({ isImporting: false })
  }
}

export async function handleNationalOsmPath(sourcePath: string, privateAccess: 'public' | 'endpoints' = 'public') {
  if (!sourcePath || city.get().isOsmImporting) return
  const projectId = selectedProject().id
  city.set({ isOsmImporting: true, osmStreetMessage: 'Starting local street index' })
  try {
    const job = await startPreparation('national-osm-import', sourcePath.split(/[\\/]/).pop() || 'OSM streets', async () => (await apiJson<{ job: JobRecord }>(`/api/projects/${encodeURIComponent(projectId)}/national-osm-import`, {
      method: 'POST',
      body: JSON.stringify({ sourcePath, privateAccess }),
    })).job)
    city.set({ osmImportJobId: job.id })
    await waitForImportJob(projectId, job.id, setOsmStreetMessage, 'Street indexing failed')
    await refreshImportedProject(projectId, true)
    setOsmStreetMessage('Pedestrian SQLite street index ready')
  } catch (error) {
    setOsmStreetMessage(error instanceof Error ? error.message : 'Street indexing failed')
  } finally {
    city.set({ isOsmImporting: false })
  }
}

export async function handleOsmFiles(filesLike: FileList | File[], privateAccess: 'public' | 'endpoints' = 'public') {
  const file = Array.from(filesLike).find((candidate) => /\.pbf$/i.test(candidate.name))
  if (!file || city.get().isOsmImporting) return
  const projectId = selectedProject().id
  city.set({ isOsmImporting: true })
  try {
    setOsmStreetMessage(`Staging ${file.name} for SQLite street indexing...`)
    const job = await startPreparation('national-osm-import', file.name, () => uploadProjectSourceFile(projectId, file, 'national-osm-upload', privateAccess))
    city.set({ osmImportJobId: job.id })
    await waitForImportJob(projectId, job.id, setOsmStreetMessage, 'Street indexing failed')
    await refreshImportedProject(projectId, true)
    setOsmStreetMessage(`${file.name} / SQLite street index ready`)
  } catch (error) {
    setOsmStreetMessage(error instanceof Error ? error.message : 'Street indexing failed')
  } finally {
    city.set({ isOsmImporting: false })
  }
}

export const cancelGtfsImport = () => { void cancelImportJob('gtfs') }
export const retryGtfsImport = () => { void retryImportJob('gtfs') }
export const cancelOsmImport = () => { void cancelImportJob('osm') }
export const retryOsmImport = () => { void retryImportJob('osm') }
