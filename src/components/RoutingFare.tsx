import { memo } from 'react'
import type { RoutingPlan, RoutingLeg } from '../routingModel'
import { farePriceLabel } from '../farePresentation.mjs'
import '../styles/routing-fares.css'

type Fare = NonNullable<RoutingLeg['fare']>

function FareOptions({ fare }: { fare: Fare }) {
  const prices = new Map<string, Map<string, Set<string>>>()
  for (const option of fare.options ?? []) {
    const price = farePriceLabel([option])
    if (!price) continue
    const label = `${price}${option.riderCategory ? ` · ${option.riderCategory}` : ''}`
    const products = prices.get(label) ?? new Map<string, Set<string>>()
    const media = products.get(option.name) ?? new Set<string>()
    if (option.media) media.add(option.media)
    products.set(option.name, media)
    prices.set(label, products)
  }
  return <>{[...prices].map(([price, products]) => <div className="routing-fare-products" key={price}>
    <strong>{price}</strong>
    {[...products].map(([name, media]) => <p key={name}>{name}{media.size ? <small>{[...media].join(', ')}</small> : null}</p>)}
  </div>)}</>
}

export const RoutingFare = memo(function RoutingFare({ plan }: { plan: RoutingPlan }) {
  const rides = plan.legs.filter(leg => leg.type === 'ride')
  if (plan.status !== 'ready' || !rides.length) return null
  // Equivalent fare catalogues share one row, even when the journey changes vehicles.
  // Keep product, payment and rider distinctions in the optional details.
  const groups = new Map<string, { fare?: Fare; routes: Set<string> }>()
  const sources = new Map<string, Fare>()
  for (const leg of rides) {
    const fare = leg.fare
    const options = (fare?.options ?? []).map(option => JSON.stringify([
      option.productId, option.name, option.amount, option.currency, option.media ?? '', option.riderCategory ?? '',
    ])).sort()
    const key = JSON.stringify([fare?.status, fare?.reason, fare?.source, fare?.standard, fare?.agencyUrl, options])
    const group = groups.get(key) ?? { fare, routes: new Set<string>() }
    group.routes.add(leg.routeShortName || leg.routeId || 'Transit')
    groups.set(key, group)
    if (fare?.status === 'published' && (fare.source || fare.standard || fare.agencyUrl)) {
      sources.set(JSON.stringify([fare.source, fare.standard, fare.agencyUrl]), fare)
    }
  }
  const published = rides.some(leg => leg.fare?.status === 'published' && farePriceLabel(leg.fare.options))
  return <details className="studio-disclosure routing-fares">
    <summary><span>{published ? 'Published fares' : 'Fare unavailable'}</span></summary>
    {published ? <p className="routing-fare-note">{rides.length > 1 ? 'Transfers not calculated. These are individual fares, not a journey total.' : 'Passes and discounts may change what you pay.'}</p> : null}
    {[...groups].map(([key, { fare, routes }]) => <div className="routing-fare-group" key={key}>
      <div className="routing-fare-price"><span>{[...routes].join(', ')}</span><strong>{fare?.status === 'published' ? farePriceLabel(fare.options) || 'Unavailable' : 'Unavailable'}</strong></div>
      {fare?.status === 'published' && farePriceLabel(fare.options) ? <details className="kit-inline-details routing-fare-options">
        <summary>Tickets and payment</summary>
        <FareOptions fare={fare} />
      </details> : <p>{fare?.reason || 'Fare data is unavailable for this service.'}</p>}
    </div>)}
    {sources.size ? <details className="kit-inline-details routing-fare-sources">
      <summary>Fare sources</summary>
      {[...sources].map(([key, fare]) => <p key={key}>{[fare.standard, fare.source].filter(Boolean).join(' · ')}{fare.agencyUrl ? <> · <a href={fare.agencyUrl} target="_blank" rel="noreferrer">Agency fares</a></> : null}</p>)}
    </details> : null}
  </details>
})
