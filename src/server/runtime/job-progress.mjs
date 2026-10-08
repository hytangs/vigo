// Carry measured work separately from legacy weighted phase milestones.
// Unknown native stages stay indeterminate instead of freezing at 99%.
export function jobProgressUpdate(update, job = {}, observedAt = new Date().toISOString()) {
  const phase = update?.phase || job.phase || 'Preparing data'
  let work = update?.work
  if (!work && Number.isFinite(update?.bytesRead) && Number.isFinite(update?.totalBytes)) {
    work = { completed: update.bytesRead, total: update.totalBytes, unit: 'bytes' }
  }
  if (!work && phase === job.phase) work = job.work
  if (work && (!Number.isFinite(work.completed) || work.completed < 0 || typeof work.unit !== 'string')) work = undefined
  return { phase, detail: update?.detail ?? '', progress: Number(update?.progress ?? job.progress ?? 0),
    work: work ? { ...work, phase } : undefined,
    phaseStartedAt: phase === job.phase ? job.phaseStartedAt : observedAt,
    updatedAt: observedAt, rssBytes: Number(update?.memory ?? job.rssBytes ?? 0) }
}
