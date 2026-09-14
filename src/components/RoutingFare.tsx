import type { RoutingPlan, RoutingLeg } from '../routingModel'
import { farePriceLabel } from '../fares.mjs'
import '../styles/routing-fares.css'

function FareOptions({ fare }: { fare: NonNullable<RoutingLeg['fare']> }) {
  const groups = new Map<string, { label: string; media: Set<string> }>()
  for (const option of fare.options ?? []) {
    const label = `${option.name} · ${farePriceLabel([option])}${option.riderCategory ? ` · ${option.riderCategory}` : ''}`
    const group = groups.get(label) ?? { label, media: new Set<string>() }
    if (option.media) group.media.add(option.media)
    groups.set(label, group)
  }
  return <>{[...groups.values()].map(group => <p key={group.label}>{group.label}{group.media.size ? <small>{[...group.media].join(', ')}</small> : null}</p>)}</>
}

export function RoutingFare({ plan }: { plan: RoutingPlan }) {
  const rides = plan.legs.filter(leg => leg.type === 'ride')
  if (plan.status !== 'ready' || !rides.length) return null
  const quoted = rides.filter(leg => leg.fare?.status === 'published')
  const single = rides.length === 1
  const label = !quoted.length ? 'Fare unavailable' : single ? `${farePriceLabel(quoted[0].fare?.options)} boarding fare` : 'Boarding fares · total unavailable'
  return <details className="routing-fares">
    <summary>{label}</summary>
    {rides.map((leg, index) => <div key={index}>
      {!single ? <strong>{leg.routeShortName || leg.routeId} · {leg.fromName}</strong> : null}
      {leg.fare?.status === 'published' ? <><FareOptions fare={leg.fare} /><small>{leg.fare.standard} · {leg.fare.source}{leg.fare.agencyUrl ? <> · <a href={leg.fare.agencyUrl} target="_blank" rel="noreferrer">Agency fares</a></> : null}</small></> : <p>{leg.fare?.reason || 'Fare data was not imported with this timetable.'}</p>}
    </div>)}
    {quoted.length ? <p>{single ? 'Published boarding price. Existing passes and discounts may change what you pay.' : 'Prices are for separate boardings. Transfers and passes may reduce the total; a journey fare has not been calculated.'}</p> : null}
  </details>
}
