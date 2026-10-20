import { Clock3, Layers, SlidersHorizontal } from 'lucide-react'
import { useId, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { classNames } from '../domain'
import { routingTimeOptions } from '../app/uiOptions'
import { formatScheduleClock } from '../scheduledVehicles'
import type { SidebarPathfinderBoxProps } from './PathfinderPanel'

type RoutingSetupProps = Pick<SidebarPathfinderBoxProps,
  'routingMode' | 'routingNetwork' | 'routingDataMode' | 'routingTimePreference' | 'routingServiceDate'
  | 'routingServiceCoverage' | 'routingServiceDateAvailability' | 'scheduleTimeMinutes' | 'routingWaypoints'
  | 'routingDepartureWindowMinutes' | 'routingMaxTransfers' | 'routingMinimumTransferBufferMinutes'
  | 'routingMaxWalkKm' | 'routingAllowStreetTransfers' | 'routingAllowLongWalk'
  | 'onRoutingDataModeChange' | 'onRoutingTimePreferenceChange' | 'onRoutingServiceDateChange'
  | 'onScheduleTimeChange' | 'onRoutingDepartureWindowChange' | 'onRoutingMaxTransfersChange'
  | 'onRoutingMinimumTransferBufferChange' | 'onRoutingMaxWalkKmChange'
  | 'onRoutingAllowStreetTransfersChange' | 'onRoutingAllowLongWalkChange'>

/** One settings surface. Tabs only change presentation; routing state stays with the caller. */
export function RoutingSetup(props: RoutingSetupProps) {
  const {
    routingMode, routingNetwork, routingDataMode, routingTimePreference, routingServiceDate,
    routingServiceCoverage, routingServiceDateAvailability, scheduleTimeMinutes, routingWaypoints,
    routingDepartureWindowMinutes, routingMaxTransfers, routingMinimumTransferBufferMinutes,
    routingMaxWalkKm, routingAllowStreetTransfers, routingAllowLongWalk,
    onRoutingDataModeChange, onRoutingTimePreferenceChange, onRoutingServiceDateChange,
    onScheduleTimeChange, onRoutingDepartureWindowChange, onRoutingMaxTransfersChange,
    onRoutingMinimumTransferBufferChange, onRoutingMaxWalkKmChange,
    onRoutingAllowStreetTransfersChange, onRoutingAllowLongWalkChange,
  } = props
  const id = useId()
  const [tab, setTab] = useState<'when' | 'preferences'>('when')
  const transit = routingMode === 'transit'
  const activeTab = transit ? tab : 'when'
  const departNow = transit && routingDataMode === 'realtime'
  const transferLimitUnavailable = routingWaypoints.length > 0
  const maxTransfers = transferLimitUnavailable ? undefined : routingMaxTransfers
  const buffer = transferLimitUnavailable ? 0 : routingMinimumTransferBufferMinutes
  const scenario = routingNetwork?.scenarios.find(item => item.id === routingNetwork.selectedId)
  const searchSummary = departNow || routingTimePreference === 'depart'
    ? routingDepartureWindowMinutes ? 'Later departures' : 'Exact time' : 'Arrive by'
  const summary = [searchSummary, `${routingMaxWalkKm.toFixed(1)} km access`,
    maxTransfers === undefined ? '' : `≤${maxTransfers} transfers`,
    routingAllowStreetTransfers === false ? 'No street transfers' : '', buffer > 0 ? `${buffer} min buffer` : ''].filter(Boolean).join(' · ')

  function changeTime(value: string) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value)
    if (!match) return
    onScheduleTimeChange(Math.max(0, Math.min(1435, Number(match[1]) * 60 + Number(match[2]))))
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'when' : event.key === 'End' ? 'preferences' : activeTab === 'when' ? 'preferences' : 'when'
    setTab(next)
    document.getElementById(`${id}-${next}-tab`)?.focus()
  }

  return <section className="routing-setup" aria-label="Journey settings">
    {transit && routingNetwork?.scenarios.length ? <header className="routing-setup-network">
      <Layers size={17} aria-hidden="true" className={classNames(scenario && 'is-scenario')} />
      <div>
        <label htmlFor={`${id}-network`}>Network</label>
        <select id={`${id}-network`} value={routingNetwork.selectedId} onChange={event => routingNetwork.onChange(event.currentTarget.value)} aria-label="Route network" title={scenario ? `${scenario.name} · ${scenario.detail}` : 'City timetable'}>
          <option value="">City timetable</option>
          {routingNetwork.scenarios.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {scenario ? <small>{scenario.detail}</small> : null}
      </div>
      {routingNetwork.error ? <p role="alert">{routingNetwork.error}</p> : null}
    </header> : null}

    {transit ? <div className="routing-setup-tabs" role="tablist" aria-label="Journey settings">
      {(['when', 'preferences'] as const).map(value => <button key={value} type="button" role="tab"
        id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={activeTab === value}
        tabIndex={activeTab === value ? 0 : -1} onKeyDown={moveTab} onClick={() => setTab(value)}>
        {value === 'when' ? <Clock3 size={14} aria-hidden="true" /> : <SlidersHorizontal size={14} aria-hidden="true" />}
        {value === 'when' ? 'When' : 'Preferences'}
      </button>)}
    </div> : null}

    <div className="routing-setup-panel" id={`${id}-when-panel`} role={transit ? 'tabpanel' : undefined}
      aria-labelledby={transit ? `${id}-when-tab` : undefined} hidden={activeTab !== 'when'}
      onInvalid={event => {
        if (activeTab === 'when') return
        // Native date validation must reveal the field before trying to focus it.
        event.preventDefault()
        const input = event.target as HTMLInputElement
        setTab('when')
        requestAnimationFrame(() => input.reportValidity())
      }}>
      {transit ? <div className="routing-setup-source" role="group" aria-label="Transit data mode" aria-describedby="pathfinder-data-mode-help">
        <button type="button" aria-pressed={routingDataMode === 'realtime'} disabled={Boolean(routingNetwork?.selectedId)} title={routingNetwork?.selectedId ? 'Scenarios run on the published timetable.' : undefined} onClick={() => onRoutingDataModeChange('realtime')}>Realtime</button>
        <button type="button" aria-pressed={routingDataMode === 'scheduled'} onClick={() => onRoutingDataModeChange('scheduled')}>Scheduled</button>
      </div> : null}
      {departNow ? <div className="routing-setup-now"><span aria-hidden="true" /><strong>Depart now</strong><small>At the time you run the route</small></div> : <>
        {transit ? <div className="routing-setup-direction" role="group" aria-label="Time preference">
          {routingTimeOptions.map(option => <button key={option.value} type="button" onClick={() => onRoutingTimePreferenceChange(option.value)} aria-pressed={routingTimePreference === option.value}>{option.label}</button>)}
        </div> : <span className="routing-setup-label">Depart at</span>}
        <div className="routing-setup-datetime">
          {transit ? <label className={classNames('routing-setup-input', routingServiceDateAvailability === 'outside' && 'is-outside')}>
            <span>Date</span><input type="date" value={routingServiceDate} min={routingServiceCoverage?.completeStartDate} max={routingServiceCoverage?.completeEndDate} onChange={event => onRoutingServiceDateChange(event.currentTarget.value)} aria-label="Routing service date" />
          </label> : null}
          <label className="routing-setup-input"><span>Time</span><input type="time" value={formatScheduleClock(scheduleTimeMinutes)} onChange={event => changeTime(event.currentTarget.value)} aria-label="Routing time" /></label>
        </div>
      </>}
      {transit ? <p className="routing-setup-note" id="pathfinder-data-mode-help">{routingDataMode === 'scheduled' ? 'Published timetable for your chosen date and time.' : 'Live updates where available; scheduled times otherwise.'}</p> : null}
    </div>

    {transit ? <div className="routing-setup-panel" id={`${id}-preferences-panel`} role="tabpanel" aria-labelledby={`${id}-preferences-tab`} hidden={activeTab !== 'preferences'}>
      {departNow || routingTimePreference === 'depart' ? <div className="routing-preference-section">
        <span className="routing-setup-label">Departure search</span>
        <div className="routing-setup-source" role="group" aria-label="Departure search window">
          <button type="button" onClick={() => onRoutingDepartureWindowChange(0)} aria-pressed={routingDepartureWindowMinutes === 0}>Exact time</button>
          <button type="button" onClick={() => onRoutingDepartureWindowChange(20)} aria-pressed={routingDepartureWindowMinutes === 20}>Later departures</button>
        </div>
      </div> : null}
      <div className="routing-preference-section">
        <div className="routing-setup-columns">
          <label className="routing-setup-select" htmlFor="pathfinder-max-transfers"><span>Maximum transfers</span>
            <select id="pathfinder-max-transfers" value={maxTransfers ?? ''} disabled={transferLimitUnavailable} aria-describedby={transferLimitUnavailable ? 'pathfinder-transfer-limit-note' : undefined} onChange={event => onRoutingMaxTransfersChange(event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value))}>
              <option value="">Unlimited</option>{Array.from({ length: 32 }, (_, count) => <option key={count} value={count}>{count === 0 ? 'Direct only' : count}</option>)}
            </select>
          </label>
          <label className="routing-setup-select" htmlFor="pathfinder-transfer-buffer"><span>Transfer buffer</span>
            <select id="pathfinder-transfer-buffer" value={buffer} disabled={transferLimitUnavailable} aria-label="Minimum transfer buffer" aria-describedby="pathfinder-transfer-buffer-help" onChange={event => onRoutingMinimumTransferBufferChange(Number(event.currentTarget.value))}>
              {[0, 1, 2, 3, 5, 10, 15, 20, 30, 60].map(minutes => <option key={minutes} value={minutes}>{minutes === 0 ? 'None' : `${minutes} min`}</option>)}
            </select>
          </label>
        </div>
        {transferLimitUnavailable ? <p className="routing-setup-note" id="pathfinder-transfer-limit-note">Transfer limits are available for routes without via points.</p> : null}
        <label className="routing-setup-toggle"><span><strong>Walk between stops</strong><small>Connect nearby stations and stops</small></span>
          <input id="pathfinder-street-transfers" type="checkbox" role="switch" aria-label="Allow walks between stations or stops" checked={routingAllowStreetTransfers} aria-describedby="pathfinder-street-transfers-help" onChange={event => onRoutingAllowStreetTransfersChange(event.currentTarget.checked)} />
        </label>
      </div>
      <div className="routing-preference-section">
        <label className="routing-setup-range-label" htmlFor="pathfinder-walk-range"><span>Walk to / from transit</span><strong>{routingMaxWalkKm.toFixed(1)} <small>km</small></strong></label>
        <input className="routing-setup-range" id="pathfinder-walk-range" type="range" min={0.2} max={5} step={0.1} value={routingMaxWalkKm}
          style={{ '--range-progress': `${(routingMaxWalkKm - .2) / 4.8 * 100}%` } as CSSProperties}
          aria-valuetext={`${routingMaxWalkKm.toFixed(1)} kilometers`} onChange={event => onRoutingMaxWalkKmChange(Number(event.currentTarget.value))} />
        <div className="routing-setup-range-scale" aria-hidden="true"><span>0.2 km</span><span>5 km</span></div>
        <label className="routing-setup-toggle"><span><strong>Include longer walks</strong><small>Compare with a walk-only journey</small></span>
          <input id="pathfinder-long-walk" type="checkbox" role="switch" aria-label="Allow longer end-to-end walks" checked={routingAllowLongWalk} onChange={event => onRoutingAllowLongWalkChange(event.currentTarget.checked)} />
        </label>
      </div>
      <details className="routing-setup-help"><summary>How these settings work</summary>
        <p id="pathfinder-transfer-buffer-help">{transferLimitUnavailable ? 'Transfer buffers are available for routes without via points.' : 'The transfer buffer adds time before boarding your next service, after any transfer walk. Your first boarding is unaffected.'}</p>
        <p id="pathfinder-street-transfers-help">{routingAllowStreetTransfers ? 'Walking transfers include connections between separate stations or stops. Station paths and fare eligibility may remain unverified.' : 'Change services at the same stop or within one station. Walking to your first stop and from your last stop is still allowed; station paths may remain unverified.'}</p>
        <p>The access limit applies to walking to your first stop and from your last stop. {routingAllowLongWalk ? 'Transit may also be compared with a graph-verified walk beyond this limit.' : 'Walk-only results stay within this limit; transit is not replaced by a long walk.'}</p>
      </details>
    </div> : null}
    {transit ? <footer className="routing-setup-summary">{summary}</footer> : null}
  </section>
}
