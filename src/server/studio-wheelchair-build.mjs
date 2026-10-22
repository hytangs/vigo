import fs from 'node:fs/promises'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { studioWheelchairSelection } from './studio-wheelchair.mjs'
import { cityCaseFeedIds } from './gtfs/source-selection.mjs'

// Reuse the public City compiler and its strict policy. Ordinary imports never
// claim wheelchair coverage, and no second preparation implementation lives here.
export async function wheelchairBuildSources(directory, project, request) {
  const ids = cityCaseFeedIds(project, request)
  const id = ids?.length === 1 ? ids[0] : !ids
    ? (request.feedId && request.feedId !== '__project__' ? request.feedId : project.defaultRoutingFeedId ?? (project.feeds.length === 1 ? project.feeds[0].id : null)) : null
  const feed = project.feeds.find(value => value.id === id)
  if (!feed || request.scenario || request.scenarioKey || request.waypoints?.length || !['transit', 'walk', undefined].includes(request.mode)) {
    throw new Error('Wheelchair preparation requires one source timetable, without scenarios or via points.')
  }
  const files = await fs.readdir(path.join(directory, 'jobs')).catch(() => [])
  const jobs = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => fs.readFile(path.join(directory, 'jobs', file), 'utf8').then(JSON.parse).catch(() => null)))
  const source = async predicate => {
    for (const job of jobs.filter(job => job?.status === 'complete' && predicate(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const candidate = job.retrySourcePath || job.sourcePath
      if (candidate && (await fs.stat(candidate).catch(() => null))?.isFile()) return candidate
    }
    throw new Error('Original source files are unavailable. Reimport this City’s GTFS ZIP and OSM PBF from local files to prepare wheelchair routing.')
  }
  const gtfs = await source(job => job.kind === 'national-gtfs-import' && job.result?.feedId === id
    && job.result?.store?.sourceFingerprint === feed.routingStore?.sourceFingerprint)
  const osm = await source(job => job.kind === 'national-osm-import'
    && job.result?.sourceFingerprint === project.osmStreetIndex?.sourceFingerprint)
  return { gtfs, osm, feedId: id }
}

export async function buildStudioWheelchair({ directory, sources, readProject, signal, onProgress, beforePublish = async () => {} }) {
  const staging = await fs.mkdtemp(path.join(directory, '.wheelchair-staging-'))
  const output = path.join(staging, 'wheelchair')
  const candidates = ['../../public/vigo.mjs', '../public/vigo.mjs'].map(relative => fileURLToPath(new URL(relative, import.meta.url)))
  try {
    const cli = (await Promise.all(candidates.map(async file => await fs.access(file).then(() => file).catch(() => null)))).find(Boolean)
    if (!cli) throw new Error('The Studio package is missing the City compiler.')
    signal.throwIfAborted()
    await new Promise((resolve, reject) => {
      const child = fork(cli, ['build', `--gtfs=${sources.gtfs}`, `--osm=${sources.osm}`, `--output=${output}`, '--wheelchair'], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
        env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      })
      let detail = '', pending = ''
      const abort = () => child.kill()
      signal.addEventListener('abort', abort, { once: true })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        detail = (detail + chunk).slice(-4000)
        pending += chunk
        const lines = pending.split('\n'); pending = lines.pop()
        for (const line of lines) if (/^\[\w+\] /.test(line)) onProgress(line.replace(/^\[\w+\] /, ''))
      })
      child.once('error', reject)
      child.once('close', code => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(new Error('Wheelchair preparation cancelled.'))
        else if (code !== 0) reject(new Error(`Wheelchair preparation failed: ${detail.trim() || `compiler exited ${code}`}`))
        else resolve()
      })
    })
    signal.throwIfAborted()
    await beforePublish()
    signal.throwIfAborted()
    // Source fingerprints are checked again immediately before publication.
    const current = await readProject()
    studioWheelchairSelection(staging, current, { wheelchair: true, feedId: sources.feedId })
    const target = path.join(directory, 'wheelchair')
    const backup = path.join(directory, `wheelchair-backup-${Date.now()}`)
    let moved = false
    try { await fs.rename(target, backup); moved = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { await fs.rename(output, target) } catch (error) {
      if (moved) await fs.rename(backup, target)
      throw error
    }
    return { feedId: sources.feedId, ...(moved ? { backup: path.basename(backup) } : {}) }
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}
