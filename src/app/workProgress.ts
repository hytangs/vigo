export type WorkProgress = { completed: number; total?: number; unit: string }
export type ProgressSample = { at: number; completed: number }
export type StepTiming = { ms: number; total?: number }

export function workFraction(work?: WorkProgress): number | undefined {
  if (!work || !Number.isFinite(work.completed) || work.completed < 0
    || !Number.isFinite(work.total) || Number(work.total) <= 0) return undefined
  return Math.min(1, work.completed / Number(work.total))
}

// Estimate only the current step. A percentage assigned to an import phase
// is not a measure of the work remaining in the complete import.
export function remainingStepMs(work: WorkProgress | undefined, samples: ProgressSample[], now: number,
  elapsedMs: number, history: StepTiming[] = []): number | undefined {
  const fraction = workFraction(work)
  if (fraction === 1) return undefined
  if (samples.length && now - samples[samples.length - 1].at >= 10_000) return undefined
  const recent = samples.filter(sample => now - sample.at <= 30_000)
  if (fraction !== undefined && recent.length >= 3) {
    const first = recent[0], last = recent[recent.length - 1]
    const span = last.at - first.at, completed = last.completed - first.completed
    if (span >= 1500 && completed > 0 && now - last.at < 10_000) {
      const remaining = (Number(work!.total) - work!.completed) * span / completed
      if (Number.isFinite(remaining)) return Math.max(1000, remaining)
    }
  }
  const comparable = history.filter(sample => Number.isFinite(sample.ms) && sample.ms > 0
    && (work?.total === undefined ? sample.total === undefined
      : Number(sample.total) > 0 && work.total / Number(sample.total) >= 0.5 && work.total / Number(sample.total) <= 2))
    .map(sample => sample.ms * (work?.total ? work.total / Number(sample.total) : 1)).sort((a, b) => a - b)
  if (comparable.length < 3) return undefined
  const median = comparable[Math.floor(comparable.length / 2)]
  // Variable or overdue steps do not get a perpetually resetting countdown.
  if (comparable[comparable.length - 1] > comparable[0] * 2 || elapsedMs >= median) return undefined
  return median - elapsedMs
}

export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`
  return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`
}

export function workLabel(work?: WorkProgress): string {
  if (!work || !Number.isFinite(work.completed) || work.completed < 0) return ''
  const format = (value: number) => Math.round(value).toLocaleString()
  if (work.unit === 'bytes') {
    const scale = Math.max(work.completed, work.total ?? 0) >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2
    const unit = scale === 1024 ** 3 ? 'GiB' : 'MiB'
    return `${(work.completed / scale).toFixed(1)}${work.total ? ` of ${(work.total / scale).toFixed(1)}` : ''} ${unit}`
  }
  return `${format(work.completed)}${work.total ? ` of ${format(work.total)}` : ''} ${work.unit}`
}
