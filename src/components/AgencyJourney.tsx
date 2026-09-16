import { useState } from 'react'
import { ArrowRight, Car, Footprints } from 'lucide-react'
import { RoutingFare } from './RoutingFare'
import type { RoutingLeg, RoutingPlan } from '../routingModel'
import type { ToolResult } from '../agency/types'
import { journeyContinuityIssue } from '../journeyIntegrity.mjs'
import { journeyBreakdown, journeyDuration, journeyModeNames, type Journey, type JourneyData } from '../agency/journeyResults.mjs'

const clockMinutes = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}${value >= 1440 ? ` (+${Math.floor(value / 1440)} day)` : ''}`
const routeName = (leg: RoutingLeg) => leg.routeShortName || leg.routeId || 'Transit'
const routeColor = (leg: RoutingLeg) => /^[0-9a-f]{6}$/i.test(leg.routeColor ?? '') ? `#${leg.routeColor}` : undefined

function AgencyJourney({ plan, endpoints }: { plan: RoutingPlan; endpoints?: Array<{ label: string }> }) {
  const rides = plan.legs.filter(leg => leg.type === 'ride')
  const transfers = Math.max(0, rides.length - 1)
  const drive = plan.travelMode === 'drive'
  const walk = plan.travelMode === 'walk'
  const distanceKm = plan.legs.every(leg => Number.isFinite(leg.distanceKm)) ? plan.legs.reduce((sum, leg) => sum + leg.distanceKm, 0) : null
  const points = endpoints?.length ? endpoints : [plan.origin, plan.destination]
  const breakdown = journeyBreakdown(plan)
  const steps = plan.legs.map((leg, index) => ({ leg, index, wait: leg.startMinutes - (index ? plan.legs[index - 1].endMinutes : plan.departMinutes) }))
    .filter(({ leg }) => leg.type !== 'walk' || leg.durationMinutes !== 0 || leg.fromName !== leg.toName)
  return <section className="agency-journey" aria-label="Journey directions">
    <header className="agency-journey-heading">
      <strong>{journeyDuration(plan.durationMinutes)}</strong>
      <span>{drive ? 'Driving' : walk ? 'Walking' : transfers ? `${transfers} ${transfers === 1 ? 'transfer' : 'transfers'}` : 'Direct transit'}</span>
      {(walk || drive) && distanceKm !== null ? <span>{distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${Number(distanceKm.toFixed(1))} km`}</span> : null}
    </header>
    <p className="agency-journey-endpoints">{points.filter(Boolean).map((point, index) => <span key={index}>{index ? <ArrowRight size={13} aria-hidden="true" /> : null}{point.label}</span>)}</p>
    <p className="agency-journey-times">Leave <b>{clockMinutes(plan.departMinutes)}</b><ArrowRight size={13} aria-hidden="true" />Arrive <b>{clockMinutes(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</b></p>
    {rides.length ? <div className="agency-journey-route-chain" aria-label="Routes in order">{rides.map((leg, index) => <span key={index}>{index ? <ArrowRight size={13} aria-hidden="true" /> : null}<b className="agency-journey-route-badge" style={{ borderLeftColor: routeColor(leg) }}>{routeName(leg)}</b></span>)}</div> : null}
    {!drive && !walk ? <p className="agency-caption">{journeyDuration(breakdown.walk)} walking · {journeyDuration(breakdown.wait)} waiting · {journeyDuration(breakdown.ride)} riding</p> : null}
    {walk ? <small>Along the saved OpenStreetMap pedestrian network</small> : null}
    <details className="agency-journey-directions">
      <summary>Step-by-step directions <span>{steps.length} steps</span></summary>
      <ol className="agency-journey-steps">{steps.map(({ leg, index, wait }) => <li key={index} data-mode={leg.type}>
        <time>{clockMinutes(leg.startMinutes)}</time>
        <div className="agency-journey-step">
          {wait > .002 ? <small className="agency-journey-wait">Wait {journeyDuration(wait)} at {leg.fromName}</small> : null}
          <div className="agency-journey-step-title">{leg.type === 'ride' ? <b className="agency-journey-route-badge" style={{ borderLeftColor: routeColor(leg) }}>{routeName(leg)}</b> : <b>{leg.type === 'walk' ? <Footprints size={14} /> : <Car size={14} />}{leg.type === 'walk' ? 'Walk' : 'Drive'}</b>}<small>{journeyDuration(leg.durationMinutes)}</small></div>
          {leg.fromName === leg.toName ? <p>Within {leg.fromName}</p> : <p>{leg.fromName}<ArrowRight size={12} aria-hidden="true" />{leg.toName}</p>}
          {leg.type === 'ride' ? <small>Arrive {clockMinutes(leg.endMinutes)}{leg.stopCount ? ` · ${leg.stopCount} ${leg.stopCount === 1 ? 'stop' : 'stops'}` : ''}</small> : null}
        </div>
      </li>)}</ol>
    </details>
  </section>
}

export function AgencyJourneys({ result, onResult }: { result: ToolResult; onResult?: (result: ToolResult) => void }) {
  const data = result.data as JourneyData
  const journeys = data.journeys
  const [selectedMode, setSelectedMode] = useState(journeys?.find(item => item.status === 'ready')?.mode || journeys?.[0]?.mode)
  const selected = journeys?.find(item => item.mode === selectedMode) || journeys?.[0]
  const candidate = selected?.status === 'ready' ? selected.plan : journeys ? undefined : data.plan
  const issue = journeyContinuityIssue(candidate)
  const plan = issue ? undefined : candidate
  const show = (journey: Journey) => {
    setSelectedMode(journey.mode)
    if (journey.status === 'ready' && journey.plan) onResult?.({ ...result, data: { ...data, plan: journey.plan, realtime: journey.realtime } })
  }
  return <div>
    {journeys && journeys.length > 1 ? <div className="agency-journey-options" role="group" aria-label="Travel modes">{journeys.map(item => <button type="button" className="agency-button" key={item.mode} aria-pressed={selected?.mode === item.mode} onClick={() => show(item)}><strong>{journeyModeNames[item.mode]}</strong><span>{item.status === 'ready' && item.plan && !journeyContinuityIssue(item.plan) ? journeyDuration(item.plan.durationMinutes) : 'Unavailable'}</span></button>)}</div> : null}
    {issue ? <p className="agency-error" role="alert">{issue}</p> : null}
    {plan ? <>
      <AgencyJourney plan={plan} endpoints={data.resolved} />
      {plan.travelMode !== 'walk' ? <p className="agency-caption">{data.request?.serviceDate ? `${data.request.serviceDate} · ` : ''}{plan.travelMode === 'drive' ? 'Road estimate · live traffic, parking and access walks excluded' : (selected?.realtime?.applied ?? data.realtime?.applied) ? 'Live predictions where applied' : 'Scheduled service · live predictions not applied'}</p> : null}
      <RoutingFare plan={plan} />
    </> : !issue ? <p className="agency-caption">{selected?.reason || 'No journey was established.'}</p> : null}
    {onResult && plan ? <button className="agency-text-button" onClick={() => onResult({ ...result, data: { ...data, plan, ...(selected ? { realtime: selected.realtime } : {}) } })}>Show on map <ArrowRight size={13} /></button> : null}
  </div>
}
