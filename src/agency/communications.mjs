import { rawId } from './agencyContext.mjs'

const duration = seconds => seconds < 60 ? 'less than 1 min' : `about ${Math.round(seconds / 60)} min`
const asOf = (value, context) => Number.isFinite(Date.parse(value)) ? `As of ${new Date(value).toLocaleString('en-US', { timeZone: context.timezone || 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.` : 'Observation time unavailable.'
const scopeSentence = event => event.scopeDescription || [event.directionId != null ? `Direction ${event.directionId}` : '', event.tripId ? `trip ${rawId(event.tripId)}` : ''].filter(Boolean).join(' · ')

export function eventSentences(event, context) {
  const routeIds = event.routeIds ?? (event.routeId ? [event.routeId] : [])
  const routeNames = routeIds.map((id) => {
    const route = context.routeIndex.get(id)
    return route?.short_name || route?.long_name || rawId(id)
  })
  const location = event.stopId ? context.stopIndex.get(event.stopId)?.name || rawId(event.stopId) : null
  const subject = routeNames.length ? routeNames.join(', ') : 'Service'
  const where = location ? ` at ${location}` : ''
  const evidence = event.evidence
  let fact
  switch (event.type) {
    case 'delay': fact = `${subject}: departure${where} is predicted ${duration(evidence.delaySeconds)} later than scheduled.`; break
    case 'headway-review':
    case 'bunching':
    case 'service-gap': fact = `${subject}: the interval between two predicted departures${where} is ${duration(evidence.observedHeadwaySeconds)}, compared with ${duration(evidence.scheduledHeadwaySeconds)} ${evidence.comparisonBasis ? 'for the smallest local scheduled interval after trip reordering' : 'scheduled'}.`; break
    case 'cancellation': fact = `${subject}: a scheduled trip is reported cancelled.`; break
    case 'skipped-stop': fact = `${subject}: a trip is reported to skip ${location || 'a scheduled stop'}.`; break
    case 'service-alert': fact = evidence.alertHeader || event.title; break
    case 'stale-data': fact = `${event.title}. Current service conditions cannot be established from this observation.`; break
    default: throw new Error('Unsupported operational event.')
  }
  return [
    { id: 'fact', text: fact },
    ...(evidence.alertDescription ? [{ id: 'detail', text: evidence.alertDescription }] : []),
    ...(evidence.expectedDepartures ? [{ id: 'coverage', text: `Both of the ${evidence.expectedDepartures} scheduled departures in this comparison report a departure prediction at the reference stop.` }] : []),
    ...(scopeSentence(event) ? [{ id: 'scope', text: `${scopeSentence(event)}.` }] : []),
    { id: 'time', text: `${asOf(event.observedAt, context)} Predictions may change. Review before publishing.` },
  ]
}

export async function draftRiderMessage({ event, context, channel, language = 'en', accessibilityMode = false }) {
  if (!['app', 'signage', 'service-alert', 'social'].includes(channel)) throw new Error('Choose a supported communication channel.')
  if (!['en', 'English', 'en-US'].includes(language)) throw new Error('This starting template is English. Translate or draft directly in the conversation from the supplied evidence.')
  const sentences = eventSentences(event, context)
  const chosen = sentences.filter(sentence => !['signage', 'social'].includes(channel) || ['fact', 'scope', 'time'].includes(sentence.id)).map(sentence => sentence.id)
  const disruptive = ['delay', 'service-gap', 'cancellation', 'skipped-stop'].includes(event.type)
    || event.type === 'service-alert' && ['NO_SERVICE', 'SIGNIFICANT_DELAYS', 'DETOUR', 'REDUCED_SERVICE', 'STOP_MOVED', 'ACCESSIBILITY_ISSUE'].includes(event.evidence.alertEffect)
  return { headline: event.type === 'service-alert' ? 'Agency service information' : event.title,
    body: [...chosen.map((id) => sentences.find((sentence) => sentence.id === id).text), ...(disruptive ? ['We’re sorry for the disruption to your journey.'] : [])].join(accessibilityMode ? '\n\n' : ' '),
    recommendedAction: 'Check the agency’s latest service information before travelling.',
    affectedRoutes: event.routeIds ?? (event.routeId ? [event.routeId] : []), affectedStops: event.stopIds ?? (event.stopId ? [event.stopId] : []),
    evidenceRefs: [...event.sourceRefs], reviewRequired: true, generatedBy: 'template', channel, language: 'en', observedAt: event.observedAt }
}

// Route-scoped drafting survives an event expiring between chat turns. The
// assistant can rewrite this starting copy; no extra inference call is needed.
export function draftRouteMessage({ context, state, routeIds, events, channel = 'app', language = 'en' }) {
  if (!['en', 'English', 'en-US'].includes(language)) throw new Error('This starting template is English. Translate or draft directly in the conversation from the supplied evidence.')
  const routes = state.routes.filter(route => routeIds.includes(route.id))
  const facts = routes.flatMap(route => route.maxDelaySeconds > 0 ? [`Some departures on route ${route.name || route.id} are predicted up to ${duration(route.maxDelaySeconds)} late.`] : [])
  const cancelled = events.filter(event => event.type === 'cancellation').length
  if (cancelled) facts.push(`The agency reports ${cancelled} cancelled ${cancelled === 1 ? 'trip' : 'trips'} on the selected service.`)
  const alerts = events.filter(event => event.type === 'service-alert')
  const affected = [...new Set(events.filter(event => event.type === 'skipped-stop').map(event => context.stopIndex.get(event.stopId)?.name).filter(Boolean))]
  if (affected.length) facts.push(`Reported skipped stops: ${affected.join(', ')}.`)
  const disruptionEstablished = facts.length > 0
  if (!facts.length) facts.push('Current reports do not establish a delay for the selected service. Please check the latest departure information before travelling.')
  return { headline: 'Service update', body: `${facts.join(' ')}${disruptionEstablished ? ' We’re sorry for the disruption to your journey.' : ''} ${asOf(state.observedAt, context)} Predictions may change. Review before publishing.`, channel, language: 'en', generatedBy: 'template', reviewRequired: true,
    observedAt: state.observedAt, affectedRoutes: routeIds, affectedStops: [...new Set(events.map(event => event.stopId).filter(Boolean))],
    agencyExplanations: alerts.slice(0, 5).map(event => ({ title: event.title, description: event.evidence.alertDescription, cause: event.evidence.alertCause, scope: event.scopeDescription, observedAt: event.observedAt })),
    evidenceRefs: [...new Set(events.flatMap(event => event.sourceRefs))], note: 'Agency explanations may concern different incidents. Establish the connection before attributing a cause. This draft has not been published.' }
}
