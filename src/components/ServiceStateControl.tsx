import { Info, Pause, Play, Radio } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { classNames, formatNumber } from '../domain'
import { formatServiceTime, type ScheduledVehicleDiagnostics } from '../scheduledVehicles'
import type { ServiceVehicleFrame, ServiceVehicleMode } from '../serviceVehicles'

/** Share the real toolbar height with map inspectors, including wrapped controls. */
export function ServiceToolbar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const toolbar = ref.current
    const surface = toolbar?.parentElement
    if (!toolbar || !surface) return
    const measure = () => surface.style.setProperty('--service-toolbar-height', `${toolbar.getBoundingClientRect().height}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(toolbar)
    return () => { observer.disconnect(); surface.style.removeProperty('--service-toolbar-height') }
  }, [])
  return <div ref={ref} className="service-toolbar">{children}</div>
}

export function ServiceStateControl({
  mode,
  frame,
  vehicleCount,
  diagnostics,
  scheduleTimeMinutes,
  scheduleServiceDate,
  scheduleEndMinutes,
  playbackRunning,
  playbackStep,
  onModeChange,
  onTogglePlayback,
  onPlaybackStepChange,
  onScheduleTimeChange,
  onScheduleServiceDateChange,
  onNow,
}: {
  mode: ServiceVehicleMode
  frame: ServiceVehicleFrame
  vehicleCount: number
  diagnostics: ScheduledVehicleDiagnostics
  scheduleTimeMinutes: number
  scheduleServiceDate: string
  scheduleEndMinutes: number
  playbackRunning: boolean
  playbackStep: number
  onModeChange: (mode: ServiceVehicleMode) => void
  onTogglePlayback: () => void
  onPlaybackStepChange: (step: number) => void
  onScheduleTimeChange: (minutes: number) => void
  onScheduleServiceDateChange: (serviceDate: string) => void
  onNow?: () => void
}) {
  const [clockInput, setClockInput] = useState(formatServiceTime(scheduleTimeMinutes))
  useEffect(() => setClockInput(formatServiceTime(scheduleTimeMinutes)), [scheduleTimeMinutes])
  const commitClock = () => {
    const match = /^(\d{1,2}):([0-5]\d)$/.exec(clockInput.trim())
    const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : NaN
    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= scheduleEndMinutes) onScheduleTimeChange(minutes)
    else setClockInput(formatServiceTime(scheduleTimeMinutes))
  }
  const liveUpdatedLabel = frame.freshness?.status === 'stale'
    ? `Stale · ${Math.round(frame.freshness.ageSeconds ?? 0)}s`
    : frame.fetchedAt
      ? `Updated ${new Date(frame.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : 'Waiting for positions'

  return (
    <div aria-label={mode === 'schedule' ? 'Schedule playback: estimated positions from GTFS stop times' : 'Live vehicle positions'} className={classNames('service-state-panel', mode === 'live' ? 'is-live' : 'is-schedule')}>
      <div className="studio-tabs service-mode-switch" role="group" aria-label="Vehicle source">
        {(['live', 'schedule'] as const).map((option) => (
          <button key={option} type="button" aria-pressed={mode === option} onClick={() => onModeChange(option)}>
            {option === 'live' ? 'Live' : 'Schedule'}
          </button>
        ))}
      </div>
      {mode === 'schedule' ? (
        <button type="button" className="service-playback-toggle" onClick={onTogglePlayback} aria-label={playbackRunning ? 'Pause service playback' : 'Play service playback'}>
          {playbackRunning ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
      ) : null}
      <div className={classNames('service-state-readout', `tone-${diagnostics.tone}`)} title={diagnostics.detail}>
        {mode === 'live' ? <Radio size={15} aria-hidden="true" /> : null}
        {mode === 'live' ? <strong>{formatNumber(vehicleCount)} vehicles</strong> : <input className="service-clock-input" aria-label="Scheduled time (HH:MM)" value={clockInput} onChange={event => setClockInput(event.currentTarget.value)} onFocus={() => { if (playbackRunning) onTogglePlayback() }} onBlur={commitClock} onKeyDown={event => { if (event.key === 'Enter') { commitClock(); event.currentTarget.blur() } }} />}
        <small>{mode === 'schedule' ? `Estimated · ${diagnostics.title}` : diagnostics.title}{mode === 'schedule' && onNow ? <> · <button type="button" className="service-now-button" onClick={onNow}>Now</button></> : null}</small>
      </div>
      {mode === 'schedule' ? (
        <>
          <input className="service-playback-date" type="date" value={scheduleServiceDate}
            aria-label="Schedule service date" title="GTFS service date; times after 24:00 continue this service day"
            onChange={(event) => onScheduleServiceDateChange(event.currentTarget.value)} />
          <select className="service-playback-step" value={playbackStep} onChange={(event) => onPlaybackStepChange(Number(event.currentTarget.value))} aria-label="Playback step" title="Timetable minutes advanced per playback step">
            <option value={1}>1 min</option><option value={5}>5 min</option><option value={15}>15 min</option>
          </select>
          <div className="service-timeline">
            <input className="service-playback-slider" type="range" min={0} max={scheduleEndMinutes} step={1} value={scheduleTimeMinutes}
              style={{ '--playback-progress': `${100 * scheduleTimeMinutes / Math.max(1, scheduleEndMinutes)}%` } as CSSProperties}
              aria-valuetext={formatServiceTime(scheduleTimeMinutes)} onChange={(event) => onScheduleTimeChange(Number(event.currentTarget.value))} aria-label="Service time of day" />
            <span aria-hidden="true"><span>00:00</span><span>{formatServiceTime(scheduleEndMinutes)}</span></span>
          </div>
        </>
      ) : (
        <>
          <div className="service-live-meta">
            <span className={classNames(frame.freshness?.status === 'stale' && 'is-stale')}><i aria-hidden="true" />{liveUpdatedLabel}</span>
            <small>{formatNumber(frame.tripUpdateCount)} updates · {formatNumber(frame.alertCount)} alerts</small>
          </div>
          <details className="service-indicator-legend">
            <summary aria-label="Vehicle marker key" title="Vehicle marker key"><Info size={14} aria-hidden="true" /></summary>
            <div className="service-indicator-popover">
              <p><strong>! Delay · ↔ Spacing.</strong> Vehicle border: amber warning, red severe. ! means predicted delay; ↔ means irregular predicted spacing. Dashed links connect a verified bunching pair, not its driving path.</p>
              <p>GTFS-RT departure predictions are compared with static GTFS at the same stop, direction and service date. Missing reports remain unknown.</p>
              <p>Delay: warning ≥5 min, severe ≥15 min. Wider gaps: warning ≥1.5× scheduled and ≥5 min extra; severe ≥3×, ≥20 min total and ≥10 min extra. Compression: warning ≤half scheduled and ≥3 min compression; severe ≤25%, ≤2 min apart and ≥5 min compression.</p>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
