import { Clock3, Pause, Play, Radio } from 'lucide-react'
import { useEffect, useState } from 'react'
import { classNames, formatNumber } from '../domain'
import { formatServiceTime, type ScheduledVehicleDiagnostics } from '../scheduledVehicles'
import type { ServiceVehicleFrame, ServiceVehicleMode } from '../serviceVehicles'

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
    <div aria-label={mode === 'schedule' ? 'Schedule playback: estimated positions from GTFS stop times' : 'Live vehicle positions'} className={classNames('service-state-panel', mode === 'live' ? 'is-live' : 'is-schedule', playbackRunning && 'is-playing')}>
      <div className="service-mode-switch" role="group" aria-label="Vehicle source">
        {(['live', 'schedule'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={classNames(mode === option && 'is-active')}
            aria-pressed={mode === option}
            onClick={() => onModeChange(option)}
          >
            {option === 'live' ? 'Live' : 'Schedule'}
          </button>
        ))}
      </div>
      <div className={classNames('service-state-readout', `tone-${diagnostics.tone}`)} title={diagnostics.detail} aria-live="polite">
        {mode === 'live' ? <Radio size={15} /> : <Clock3 size={15} />}
        <span>
          <strong>{mode === 'live' ? `Live · ${formatNumber(vehicleCount)} vehicles` : <><span className="service-estimate-label">Estimated</span><input className="service-clock-input" aria-label="Scheduled time (HH:MM)" value={clockInput} onChange={event => setClockInput(event.currentTarget.value)} onFocus={() => { if (playbackRunning) onTogglePlayback() }} onBlur={commitClock} onKeyDown={event => { if (event.key === 'Enter') { commitClock(); event.currentTarget.blur() } }} /></>}</strong>
          {mode === 'schedule' || diagnostics.tone !== 'good' ? <small>{diagnostics.title}{mode === 'schedule' && onNow ? <> · <button type="button" className="service-now-button" onClick={onNow}>Now</button></> : null}</small> : null}
        </span>
      </div>
      {mode === 'live' ? <details className="service-indicator-legend"><summary>! Delay · ↔ Spacing</summary><p>Vehicle border: amber warning, red severe. ! means predicted delay; ↔ means irregular predicted spacing. Dashed links connect a verified bunching pair, not its driving path.</p><p>GTFS-RT departure predictions are compared with static GTFS at the same stop, direction and service date. Missing reports remain unknown.</p><p>Delay: warning ≥5 min, severe ≥15 min. Wider gaps: warning ≥1.5× scheduled and ≥5 min extra; severe ≥3×, ≥20 min total and ≥10 min extra. Compression: warning ≤half scheduled and ≥3 min compression; severe ≤25%, ≤2 min apart and ≥5 min compression.</p></details> : null}
      {mode === 'schedule' ? (
        <>
          <button type="button" className="service-playback-toggle" onClick={onTogglePlayback} aria-label={playbackRunning ? 'Pause service playback' : 'Play service playback'}>
            {playbackRunning ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <select value={playbackStep} onChange={(event) => onPlaybackStepChange(Number(event.currentTarget.value))} aria-label="Playback step">
            <option value={1}>1 min</option>
            <option value={5}>5 min</option>
            <option value={15}>15 min</option>
          </select>
          <input
            className="service-playback-slider"
            type="range"
            min={0}
            max={scheduleEndMinutes}
            step={1}
            value={scheduleTimeMinutes}
            aria-valuetext={formatServiceTime(scheduleTimeMinutes)}
            onChange={(event) => onScheduleTimeChange(Number(event.currentTarget.value))}
            aria-label="Service time of day"
          />
          <input
            className="service-playback-date"
            type="date"
            value={scheduleServiceDate}
            aria-label="Schedule service date"
            title="GTFS service date; times after 24:00 continue this service day"
            onChange={(event) => onScheduleServiceDateChange(event.currentTarget.value)}
          />
        </>
      ) : (
        <div className="service-live-meta">
          <span className={classNames(frame.freshness?.status === 'stale' && 'is-stale')}><i aria-hidden="true" />{liveUpdatedLabel}</span>
          <small>{formatNumber(frame.tripUpdateCount)} updates · {formatNumber(frame.alertCount)} alerts</small>
        </div>
      )}
    </div>
  )
}
