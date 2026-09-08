import { Clock3, Pause, Play, Radio } from 'lucide-react'
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
}) {
  const liveUpdatedLabel = frame.freshness?.status === 'stale'
    ? `Stale · ${Math.round(frame.freshness.ageSeconds ?? 0)}s`
    : frame.fetchedAt
      ? `Updated ${new Date(frame.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : 'Waiting for Vehicle Positions'

  return (
    <div className={classNames('service-state-panel', mode === 'live' ? 'is-live' : 'is-schedule', playbackRunning && 'is-playing')}>
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
          <strong>{mode === 'live' ? `Live · ${formatNumber(vehicleCount)} vehicles` : `Schedule · ${formatServiceTime(scheduleTimeMinutes)}`}</strong>
          <small>{diagnostics.title}</small>
        </span>
      </div>
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
