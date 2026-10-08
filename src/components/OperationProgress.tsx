import { useEffect, useRef, useState } from 'react'
import { durationLabel, remainingStepMs, workFraction, workLabel, type ProgressSample, type StepTiming, type WorkProgress } from '../app/workProgress'

const historyKey = 'vigo.step-times.v1'
type History = Record<string, StepTiming[]>
function readHistory(): History {
  try {
    if (typeof window === 'undefined') return {}
    const stored = window.localStorage.getItem(historyKey) || '{}'
    if (stored.length > 32_768) return {}
    const value = JSON.parse(stored)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).slice(-32).map(([key, samples]) => [key,
      Array.isArray(samples) ? samples.filter(sample => sample && Number.isFinite(sample.ms) && sample.ms > 0).slice(-8) : []]))
  } catch { return {} }
}
function rememberStep(key: string, timing: StepTiming) {
  if (timing.ms < 1000 || timing.ms > 24 * 3600_000) return
  try {
    const history = readHistory()
    const previous = Array.isArray(history[key]) ? history[key] : []
    delete history[key]
    const entries = Object.entries(history).slice(-31)
    entries.push([key, [...previous.slice(-7), timing]])
    localStorage.setItem(historyKey, JSON.stringify(Object.fromEntries(entries)))
  } catch { /* Progress remains usable when browser storage is unavailable. */ }
}

export function OperationProgress({ phase, detail, work, profile = '', startedAt, phaseStartedAt, updatedAt, finishedAt, complete = false, paused = false, compact = false }: {
  phase: string; detail?: string; work?: WorkProgress; profile?: string; startedAt?: string; phaseStartedAt?: string; updatedAt?: string; finishedAt?: string
  complete?: boolean; paused?: boolean; compact?: boolean
}) {
  const [now, setNow] = useState(Date.now)
  const start = useRef(Number.isFinite(Date.parse(startedAt || '')) ? Date.parse(startedAt!) : now)
  const phaseTime = Date.parse(phaseStartedAt || '')
  const knownPhaseTime = Number.isFinite(phaseTime) && phaseTime <= now
  const step = useRef({ phase, at: knownPhaseTime ? phaseTime : now, lastUpdate: now, lastCompleted: work?.completed, total: work?.total, samples: [] as ProgressSample[], recorded: false, recordable: knownPhaseTime || !startedAt })
  useEffect(() => {
    if (complete || paused) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [complete, paused])
  useEffect(() => {
    const time = Date.now(), previous = step.current
    if (previous.phase !== phase) {
      if (profile && previous.recordable && !previous.recorded && !paused) rememberStep(`${profile}:${previous.phase}`, { ms: time - previous.at, total: previous.total })
      step.current = { phase, at: knownPhaseTime ? phaseTime : time, lastUpdate: time, lastCompleted: undefined, total: work?.total, samples: [], recorded: false, recordable: true }
    }
    const current = step.current
    if (knownPhaseTime) { current.at = phaseTime; current.recordable = true }
    if (work?.completed !== undefined && (current.lastCompleted !== work.completed || !current.samples.length)) {
      // A new pass or changing denominator invalidates the previous rate.
      if (work.completed < (current.lastCompleted ?? 0) || current.total !== work.total) current.samples = []
      current.samples.push({ at: time, completed: work.completed })
      current.samples = current.samples.slice(-32)
      current.lastCompleted = work.completed
      current.total = work.total
      current.lastUpdate = time
    }
    if (updatedAt) current.lastUpdate = Date.parse(updatedAt) || time
    if (complete && current.recordable && !current.recorded && profile) {
      rememberStep(`${profile}:${phase}`, { ms: time - current.at, total: work?.total })
      current.recorded = true
    }
    setNow(time)
  }, [phase, phaseTime, knownPhaseTime, work?.completed, work?.total, updatedAt, complete, paused, profile])
  const current = step.current
  const history = profile ? readHistory()[`${profile}:${phase}`] : []
  const remaining = !paused && !complete ? remainingStepMs(work, current.samples, now, now - current.at, Array.isArray(history) ? history : []) : undefined
  const fraction = workFraction(work)
  const percent = fraction === undefined ? undefined : Math.min(100, Math.floor(fraction * 100))
  const count = workLabel(work)
  const stoppedAt = complete && Number.isFinite(Date.parse(finishedAt || '')) ? Date.parse(finishedAt!) : now
  const Container = compact ? 'span' : 'div'
  return <Container className={`operation-progress${compact ? ' is-compact' : ''}`}>
    {!compact ? <div className="operation-progress-heading"><span>{phase}</span>{percent !== undefined && !paused ? <small>{percent}% of step</small> : null}</div> : null}
    {!paused && !complete ? <progress max={100} value={percent} aria-label={`${phase} progress`} aria-valuetext={count || `${phase}; duration not yet known`} /> : null}
    {detail && !compact ? <p>{detail}</p> : null}
    <span className="operation-progress-timing" aria-live="off">
      {count ? <span>{count}</span> : null}
      <span>{durationLabel(stoppedAt - start.current)} elapsed</span>
      {remaining !== undefined ? <span>About {durationLabel(remaining)} left in this step</span> : !complete && !paused && now - current.lastUpdate >= 15_000 ? <span>Last progress update {durationLabel(now - current.lastUpdate)} ago</span> : null}
    </span>
  </Container>
}
