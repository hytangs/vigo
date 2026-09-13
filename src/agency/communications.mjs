import { rawId } from './agencyContext.mjs'

const duration = (seconds) => `${Number((seconds / 60).toFixed(1))} min`

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
    case 'bunching':
    case 'service-gap': fact = `${subject}: the interval between two predicted departures${where} is ${duration(evidence.observedHeadwaySeconds)}, compared with ${duration(evidence.scheduledHeadwaySeconds)} scheduled.`; break
    case 'cancellation': fact = `${subject}: scheduled trip ${rawId(event.tripId)} is reported cancelled.`; break
    case 'skipped-stop': fact = `${subject}: trip ${rawId(event.tripId)} is reported to skip ${location || 'a scheduled stop'}.`; break
    case 'service-alert': fact = evidence.alertHeader || event.title; break
    case 'stale-data': fact = `${event.title}. Current service conditions cannot be established from this observation.`; break
    default: throw new Error('Unsupported operational event.')
  }
  return [
    { id: 'fact', text: fact },
    ...(evidence.alertDescription ? [{ id: 'detail', text: evidence.alertDescription }] : []),
    ...(evidence.expectedDepartures ? [{ id: 'coverage', text: `Both of the ${evidence.expectedDepartures} scheduled departures in this comparison report a departure prediction at the reference stop.` }] : []),
    { id: 'time', text: `Observation: ${new Date(event.observedAt).toISOString()}. Predictions may change.` },
  ]
}

export async function draftRiderMessage({ event, context, channel, language = 'en', accessibilityMode = false }, provider, signal) {
  if (!['app', 'signage', 'service-alert', 'social'].includes(channel)) throw new Error('Choose a supported communication channel.')
  if (!['en', 'English', 'en-US'].includes(language)) throw new Error('This evaluation build supports English drafts only. Translation requires a separately reviewed language workflow.')
  const sentences = eventSentences(event, context)
  let chosen = channel === 'signage' || channel === 'social' ? ['fact'] : sentences.filter((sentence) => sentence.id !== 'time').map((sentence) => sentence.id)
  let generatedBy = 'template'
  if (provider?.available) {
    const response = await provider.complete([
      { role: 'system', content: 'You arrange verified rider-information sentences. Return only JSON {"sentenceIds":[...]}. Select existing sentence IDs only. Include fact first. Do not add text, claims, causes, recovery times, or alternative journeys. Signage and social should be concise. All output is a draft for human review.' },
      { role: 'user', content: JSON.stringify({ channel, accessibilityMode, sentences }) },
    ], [], signal)
    let selection
    try { selection = JSON.parse(response.content) } catch { throw new Error('The draft provider returned invalid structured output.') }
    if (!selection || Object.keys(selection).some((key) => key !== 'sentenceIds') || !Array.isArray(selection.sentenceIds)
      || selection.sentenceIds[0] !== 'fact' || new Set(selection.sentenceIds).size !== selection.sentenceIds.length
      || selection.sentenceIds.some((id) => !sentences.some((sentence) => sentence.id === id))) throw new Error('The draft provider introduced unsupported content. No draft was accepted.')
    chosen = selection.sentenceIds
    generatedBy = 'model'
  }
  return { headline: event.type === 'service-alert' ? 'Agency service information' : event.title,
    body: chosen.map((id) => sentences.find((sentence) => sentence.id === id).text).join(accessibilityMode ? '\n\n' : ' '),
    recommendedAction: 'Check the agency’s latest service information before travelling.',
    affectedRoutes: event.routeIds ?? (event.routeId ? [event.routeId] : []), affectedStops: event.stopIds ?? (event.stopId ? [event.stopId] : []),
    evidenceRefs: [...event.sourceRefs], reviewRequired: true, generatedBy, channel, language: 'en', observedAt: event.observedAt }
}
