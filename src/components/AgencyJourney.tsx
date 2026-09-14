import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { RoutingFare } from './RoutingFare'
import type { RoutingPlan } from '../routingModel'
import type { ToolResult } from '../agency/types'
import { journeyDuration, journeyModeNames, type Journey, type JourneyData } from '../agency/journeyResults.mjs'

const clockMinutes = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}${value >= 1440 ? ` (+${Math.floor(value / 1440)} day)` : ''}`

function AgencyJourney({ plan, endpoints }: { plan: RoutingPlan; endpoints?: Array<{ label: string }> }) {
  const rides = plan.legs.filter((leg) => leg.type === 'ride').length
  if (plan.travelMode === 'walk') {
    const meters = plan.legs.reduce((sum, leg) => sum + (leg.distanceKm ?? 0) * 1000, 0)
    const points = endpoints?.length ? endpoints : [plan.origin, plan.destination]
    return <div className="agency-journey"><strong>{meters < 1000 ? `${Math.round(meters)} m` : `${Number((meters / 1000).toFixed(2))} km`} · about {Math.max(1, Math.ceil(plan.durationMinutes))} min walking</strong><p>{points.map((point, index) => <span key={index}>{index ? <ArrowRight size={12} /> : null}{point.label}</span>)}</p><small>Along the saved OpenStreetMap pedestrian network</small></div>
  }
  const drive = plan.travelMode === 'drive'
  const distanceKm = plan.legs.every(leg => Number.isFinite(leg.distanceKm)) ? plan.legs.reduce((sum, leg) => sum + leg.distanceKm, 0) : null
  return <div className="agency-journey"><strong>{journeyDuration(plan.durationMinutes)} · {drive ? `driving${distanceKm == null ? '' : ` · ${Number(distanceKm.toFixed(1))} km`}` : `${rides} transit ${rides === 1 ? 'leg' : 'legs'}`}</strong><p className="agency-caption">Leave {clockMinutes(plan.departMinutes)} · arrive {clockMinutes(plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes)}</p>{plan.legs.flatMap((leg, index) => {
    const previousEnd = index ? plan.legs[index - 1].endMinutes : plan.departMinutes
    const wait = leg.startMinutes - previousEnd
    const items = wait > 0 ? [<div key={`wait-${index}`}><time>{clockMinutes(previousEnd)}</time><span>Wait at {leg.fromName}</span><small>{wait < 1 ? '<1' : Number(wait.toFixed(1))} min</small></div>] : []
    if (leg.type !== 'walk' || leg.durationMinutes !== 0 || leg.fromName !== leg.toName) items.push(<div key={`leg-${index}`}><time>{clockMinutes(leg.startMinutes)}</time><span><b>{leg.type === 'ride' ? leg.routeShortName || leg.routeId : leg.type === 'walk' ? 'Walk' : 'Drive'}</b> {leg.fromName === leg.toName ? `within ${leg.fromName}` : <>{leg.fromName}<ArrowRight size={12} />{leg.toName}</>}</span><small>{leg.durationMinutes > 0 && leg.durationMinutes < 1 ? '<1' : Number(leg.durationMinutes.toFixed(1))} min</small></div>)
    return items
  })}</div>
}

export function AgencyJourneys({ result, onResult }: { result: ToolResult; onResult?: (result: ToolResult) => void }) {
  const data = result.data as JourneyData
  const journeys = data.journeys
  const [selectedMode, setSelectedMode] = useState(journeys?.find(item => item.status === 'ready')?.mode || journeys?.[0]?.mode)
  const selected = journeys?.find(item => item.mode === selectedMode) || journeys?.[0]
  const plan = selected?.status === 'ready' ? selected.plan : journeys ? undefined : data.plan
  const show = (journey: Journey) => {
    setSelectedMode(journey.mode)
    if (journey.status === 'ready' && journey.plan) onResult?.({ ...result, data: { ...data, plan: journey.plan, realtime: journey.realtime } })
  }
  return <div>
    {journeys && journeys.length > 1 ? <div className="agency-journey-options" role="group" aria-label="Travel modes">{journeys.map(item => <button type="button" className="agency-button" key={item.mode} aria-pressed={selected?.mode === item.mode} onClick={() => show(item)}><strong>{journeyModeNames[item.mode]}</strong><span>{item.status === 'ready' && item.plan ? journeyDuration(item.plan.durationMinutes) : 'Unavailable'}</span></button>)}</div> : null}
    {plan && plan.travelMode !== 'walk' ? <p className="agency-caption">{data.request?.serviceDate ? `${data.request.serviceDate} · ` : ''}{plan.travelMode === 'drive' ? 'Road estimate · live traffic, parking and access walks excluded' : (selected?.realtime?.applied ?? data.realtime?.applied) ? 'Live predictions where applied' : 'Scheduled service · live predictions not applied'}</p> : null}
    {plan ? <><RoutingFare plan={plan} /><AgencyJourney plan={plan} endpoints={data.resolved} /></> : <p className="agency-caption">{selected?.reason || 'No journey was established.'}</p>}
    {onResult && plan ? <button className="agency-text-button" onClick={() => onResult({ ...result, data: { ...data, plan, ...(selected ? { realtime: selected.realtime } : {}) } })}>Show on map <ArrowRight size={13} /></button> : null}
  </div>
}
