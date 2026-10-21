import { ScenarioNetworkSettings } from './ScenarioNetworkSettings'
import { Accessibility, ChevronDown, Clock3, SlidersHorizontal } from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { classNames } from '../domain'
import { routingTimeOptions } from '../app/uiOptions'
import { formatScheduleClock } from '../scheduledVehicles'
import type { SidebarPathfinderBoxProps } from './PathfinderPanel'

type RoutingSetupProps = Pick<SidebarPathfinderBoxProps,
  'routingMode' | 'routingNetwork' | 'routingDataMode' | 'routingTimePreference' | 'routingServiceDate'
  | 'routingServiceCoverage' | 'routingServiceDateAvailability' | 'scheduleTimeMinutes' | 'routingWaypoints'
  | 'routingWheelchair' | 'routingWheelchairAvailable' | 'onRoutingWheelchairChange'
  | 'routingDepartureWindowMinutes' | 'routingMaxTransfers' | 'routingMinimumTransferBufferMinutes'
  | 'routingMaxWalkKm' | 'routingAllowStreetTransfers' | 'routingAllowLongWalk'
  | 'onRoutingDataModeChange' | 'onRoutingTimePreferenceChange' | 'onRoutingServiceDateChange'
  | 'onScheduleTimeChange' | 'onRoutingDepartureWindowChange' | 'onRoutingMaxTransfersChange'
  | 'onRoutingMinimumTransferBufferChange' | 'onRoutingMaxWalkKmChange'
  | 'onRoutingAllowStreetTransfersChange' | 'onRoutingAllowLongWalkChange'> & {
  /** Fold to the summary when journeys first arrive, so results take the panel. */
  resultsShown?: boolean
}

/** One settings surface. Tabs only change presentation; routing state stays with the caller. */
export function RoutingSetup(props: RoutingSetupProps) {
  const {
    routingWheelchair = false, routingWheelchairAvailable = false, onRoutingWheelchairChange,
    routingMode, routingNetwork, routingDataMode, routingTimePreference, routingServiceDate,
    routingServiceCoverage, routingServiceDateAvailability, scheduleTimeMinutes, routingWaypoints,
    routingDepartureWindowMinutes, routingMaxTransfers, routingMinimumTransferBufferMinutes,
    routingMaxWalkKm, routingAllowStreetTransfers, routingAllowLongWalk,
    onRoutingDataModeChange, onRoutingTimePreferenceChange, onRoutingServiceDateChange,
    onScheduleTimeChange, onRoutingDepartureWindowChange, onRoutingMaxTransfersChange,
    onRoutingMinimumTransferBufferChange, onRoutingMaxWalkKmChange,
    onRoutingAllowStreetTransfersChange, onRoutingAllowLongWalkChange, resultsShown = false,
  } = props
  const id = useId()
  const [tab, setTab] = useState<'when' | 'preferences'>('when')
  const [collapsed, setCollapsed] = useState(false)
  const resultsWereShown = useRef(resultsShown)
  useEffect(() => {
    if (resultsShown && !resultsWereShown.current) setCollapsed(true)
    resultsWereShown.current = resultsShown
  }, [resultsShown])
  const transit = routingMode === 'transit'
  const activeTab = transit ? tab : 'when'
  const departNow = transit && routingDataMode === 'realtime'
  const realtimeAvailable = !routingNetwork?.selectedId
  const realtimeUnavailableReason = routingNetwork?.selectedId ? 'Scenarios run on the published timetable.' : undefined
  // Wheelchair networks are prepared from the published timetable; live service carries no accessibility data.
  const wheelchairReason = !routingWheelchairAvailable ? 'No prepared wheelchair network for this selection'
    : departNow ? 'Wheelchair routing uses the published timetable' : ''
  const transferLimitUnavailable = routingWaypoints.length > 0
  const maxTransfers = transferLimitUnavailable ? undefined : routingMaxTransfers
  const buffer = transferLimitUnavailable ? 0 : routingMinimumTransferBufferMinutes
  const scenario = routingNetwork?.scenarios.find(item => item.id === routingNetwork.selectedId)
  const searchSummary = departNow || routingTimePreference === 'depart'
    ? routingDepartureWindowMinutes ? 'Later departures' : 'Exact time'
    : routingDepartureWindowMinutes ? 'Earlier arrivals' : 'Arrive by'
  const summary = [scenario?.name ?? '', routingWheelchair ? 'Wheelchair' : '', searchSummary, `${routingMaxWalkKm.toFixed(1)} km access`,
    maxTransfers === undefined ? '' : `≤${maxTransfers} transfers`,
    routingAllowStreetTransfers === false ? 'No street transfers' : '', buffer > 0 ? `${buffer} min buffer` : ''].filter(Boolean).join(' · ')
  const whenSummary = departNow ? 'Depart now'
    : `${transit && routingTimePreference === 'arrive' ? 'Arrive by' : 'Depart at'} ${formatScheduleClock(scheduleTimeMinutes)}${transit ? ` · ${routingServiceDate}` : ''}`

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
    <header className="routing-setup-header">
    <span className="routing-setup-title"><SlidersHorizontal size={14} aria-hidden="true" />Journey settings</span>
      {onRoutingWheelchairChange ? <button type="button" className="kit-icon-button routing-wheelchair" aria-pressed={routingWheelchair}
        disabled={Boolean(wheelchairReason)} aria-label="Wheelchair routing" title={wheelchairReason || 'Wheelchair routing'}
        onClick={() => onRoutingWheelchairChange(!routingWheelchair)}><Accessibility size={15} aria-hidden="true" /></button> : null}
      <button type="button" className="routing-setup-fold" aria-expanded={!collapsed} aria-controls={`${id}-content`}
        aria-label={collapsed ? 'Expand journey settings' : 'Collapse journey settings'}
        title={collapsed ? 'Expand journey settings' : 'Collapse journey settings'} onClick={() => setCollapsed(value => !value)}>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
    </header>

    <div id={`${id}-content`} hidden={collapsed}>
    {transit ? <div className="routing-setup-tabs" role="tablist" aria-label="Journey settings">
      {(['when', 'preferences'] as const).map(value => <button key={value} type="button" role="tab"
        id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={activeTab === value}
        tabIndex={activeTab === value ? 0 : -1} onKeyDown={moveTab} onClick={() => setTab(value)}>
        {value === 'when' ? <Clock3 size={13} aria-hidden="true" /> : <SlidersHorizontal size={13} aria-hidden="true" />}
        {value === 'when' ? 'When' : 'Preferences'}
      </button>)}
    </div> : null}

    <div className="routing-setup-panel" id={`${id}-when-panel`} role={transit ? 'tabpanel' : undefined}
      aria-labelledby={transit ? `${id}-when-tab` : undefined} hidden={activeTab !== 'when'}
      onInvalid={event => {
        if (!collapsed && activeTab === 'when') return
        // Native date validation must reveal the field before trying to focus it.
        event.preventDefault()
        const input = event.target as HTMLInputElement
        setCollapsed(false)
        setTab('when')
        requestAnimationFrame(() => input.reportValidity())
      }}>
      {transit ? <div className="studio-tabs routing-setup-time" role="group" aria-label="Departure time" aria-describedby="pathfinder-data-mode-help">
        <button type="button" aria-pressed={departNow} disabled={!realtimeAvailable} title={realtimeUnavailableReason}
          onClick={() => { if (routingWheelchair) onRoutingWheelchairChange?.(false); onRoutingTimePreferenceChange('depart'); onRoutingDataModeChange('realtime') }}>Now</button>
        {routingTimeOptions.map(option => <button key={option.value} type="button" aria-pressed={!departNow && routingTimePreference === option.value}
          onClick={() => { onRoutingTimePreferenceChange(option.value); if (departNow) onRoutingDataModeChange('scheduled') }}>{option.value === 'arrive' ? 'Arrive by' : 'Depart at'}</button>)}
      </div> : <span className="routing-setup-label">Depart at</span>}
      {!departNow ? <div className="routing-setup-datetime">
        {transit ? <label className={classNames('routing-setup-input', routingServiceDateAvailability === 'outside' && 'is-outside')}>
          <span>Date</span><input type="date" value={routingServiceDate} min={routingServiceCoverage?.completeStartDate} max={routingServiceCoverage?.completeEndDate} onChange={event => onRoutingServiceDateChange(event.currentTarget.value)} aria-label="Routing service date" />
        </label> : null}
        <label className="routing-setup-input"><span>Time</span><input type="time" value={formatScheduleClock(scheduleTimeMinutes)} onChange={event => changeTime(event.currentTarget.value)} aria-label="Routing time" /></label>
      </div> : null}
      {transit ? <p className="routing-setup-note" id="pathfinder-data-mode-help">{departNow ? 'Departs when you run the route, with live updates where available.' : 'Published timetable for this date and time.'}</p> : null}
    </div>

    {transit ? <div className="routing-setup-panel" id={`${id}-preferences-panel`} role="tabpanel" aria-labelledby={`${id}-preferences-tab`} hidden={activeTab !== 'preferences'}>
    {transit && routingNetwork?.scenarios.length ? <div className="routing-setup-network">
      <div>
        <label htmlFor={`${id}-network`}>Network / scenario</label>
        <select id={`${id}-network`} value={routingNetwork.selectedId} onChange={event => routingNetwork.onChange(event.currentTarget.value)} aria-label="Route network" title={scenario ? `${scenario.name} · ${scenario.detail}` : 'City timetable'}>
          <option value="">{routingNetwork.baselineLabel ?? 'City timetable'}</option>
          {routingNetwork.scenarios.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
    </div> : null}
      {routingNetwork?.selectedId ? <ScenarioNetworkSettings scenarioId={routingNetwork.selectedId} /> : null}
      {departNow || routingTimePreference === 'depart' ? <div className="routing-preference-section">
        <span className="routing-setup-label">Departure search</span>
        <div className="studio-tabs routing-setup-source" role="group" aria-label="Departure search window">
          <button type="button" onClick={() => onRoutingDepartureWindowChange(0)} aria-pressed={routingDepartureWindowMinutes === 0}>Exact time</button>
          <button type="button" onClick={() => onRoutingDepartureWindowChange(20)} aria-pressed={routingDepartureWindowMinutes === 20}>Later departures</button>
        </div>
      </div> : <div className="routing-preference-section">
        <span className="routing-setup-label">Arrival search</span>
        <div className="studio-tabs routing-setup-source" role="group" aria-label="Arrival search window">
          <button type="button" onClick={() => onRoutingDepartureWindowChange(0)} aria-pressed={routingDepartureWindowMinutes === 0}>Exact time</button>
          <button type="button" onClick={() => onRoutingDepartureWindowChange(20)} aria-pressed={routingDepartureWindowMinutes === 20}>Earlier arrivals</button>
        </div>
      </div>}
      <div className="routing-preference-section">
        <div className="routing-setup-columns">
          <label className="routing-setup-select" htmlFor="pathfinder-max-transfers"><span>Maximum transfers</span>
            <select id="pathfinder-max-transfers" value={maxTransfers ?? ''} disabled={transferLimitUnavailable} aria-describedby={transferLimitUnavailable ? 'pathfinder-transfer-limit-note' : undefined} onChange={event => onRoutingMaxTransfersChange(event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value))}>
              <option value="">Unlimited</option>{Array.from({ length: 32 }, (_, count) => <option key={count} value={count}>{count === 0 ? 'Direct only' : count}</option>)}
            </select>
          </label>
          <label className="routing-setup-select" htmlFor="pathfinder-transfer-buffer"><span>Transfer buffer</span>
            <select id="pathfinder-transfer-buffer" value={buffer} disabled={transferLimitUnavailable} aria-label="Minimum transfer buffer" onChange={event => onRoutingMinimumTransferBufferChange(Number(event.currentTarget.value))}>
              {[0, 1, 2, 3, 5, 10, 15, 20, 30, 60].map(minutes => <option key={minutes} value={minutes}>{minutes === 0 ? 'None' : `${minutes} min`}</option>)}
            </select>
          </label>
        </div>
        {transferLimitUnavailable ? <p className="routing-setup-note" id="pathfinder-transfer-limit-note">Transfer limits are available for routes without via points.</p> : null}
        <label className="routing-setup-toggle"><span><strong>Walk between stops</strong><small>Connect nearby stations and stops</small></span>
          <input id="pathfinder-street-transfers" type="checkbox" role="switch" aria-label="Allow walks between stations or stops" checked={routingAllowStreetTransfers} onChange={event => onRoutingAllowStreetTransfersChange(event.currentTarget.checked)} />
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
    </div> : null}
    </div>
    {transit && routingNetwork?.error ? <p className="routing-setup-note" role="alert">{routingNetwork.error}</p> : null}
    {transit || collapsed ? <footer className="routing-setup-summary">{collapsed ? <strong>{whenSummary}</strong> : null}{transit ? <span>{summary}</span> : null}</footer> : null}
  </section>
}
