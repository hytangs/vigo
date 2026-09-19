import { resolveJourneyPoints } from './journeyInputs.mjs'
import { calculateWalk } from './walking.mjs'

// Compose existing geocoding and routing for an ordered visit. Selection is
// shortest measured walking time among the returned candidates, not a rating
// of businesses or a claim about public access and opening hours.
export async function findWalk(context, places, adapters, args, signal) {
  const indexed = context.resolve({ query: args.origin, kind: 'stop' })
  const origin = indexed.method === 'exact' && indexed.matches.length ? { stopName: args.origin } : { placeQuery: args.origin }
  const start = await resolveJourneyPoints(context, places, { origin }, signal)
  const [lon, lat] = start.origin.coordinate
  const searches = await Promise.all(args.visits.map(visit => places.search({ ...visit, query: visit.query?.trim() || context.overview().cityName, near: { lon, lat } }, signal)))
  const sources = new Set(start.sources)
  for (const search of searches) for (const place of search.matches) sources.add(place.sourceUrl)
  const missing = searches.findIndex(search => !search.matches.length)
  if (missing >= 0) throw new Error(`No mapped ${args.visits[missing].osmTag.replace(':', ' / ')} matched “${args.visits[missing].query}”. For a category-only visit, search the city name with its category. For a business, use its proper name or a verified address. Empty results do not establish nonexistence.`)
  let combinations = [[]]
  for (const search of searches) combinations = combinations.flatMap(prefix => search.matches.map(place => [...prefix, place]))
  const candidates = []
  let checked = 0, connected = 0
  for (const visits of combinations) {
    signal?.throwIfAborted()
    try {
      const measured = await calculateWalk(context, places, adapters, { origin, destination: { placeId: visits.at(-1).id }, waypoints: visits.slice(0, -1).map(place => ({ placeId: place.id })), timeBudgetMinutes: args.timeBudgetMinutes, activityMinutes: args.activityMinutes }, signal)
      checked++
      if (!measured.data.walking) continue
      connected++
      candidates.push({ ...measured, visits })
    } catch (error) {
      signal?.throwIfAborted()
      if (error.code === 'walking_disconnected') { checked++; continue }
      // An adapter/configuration failure must not be hidden as a distant place.
      throw new Error(`The visit comparison could not finish: ${error.message}`)
    }
  }
  let best, visitEvidence, restricted = 0
  for (const candidate of candidates.sort((a, b) => a.data.walking.durationMinutes - b.data.walking.durationMinutes)) {
    const evidence = await Promise.all(candidate.visits.map(async place => {
      try { const detail = await places.details?.(place.id, signal); if (detail) sources.add(detail.url); return { ...place, evidence: detail } }
      catch (error) { signal?.throwIfAborted(); return { ...place, evidenceError: error.message } }
    }))
    // Explicit map restrictions disqualify a candidate. Missing tags remain
    // unknown; the absence of a restriction is not proof of public access.
    if (evidence.some(place => ['access', 'foot'].some(key => ['no', 'private'].includes(place.evidence?.tags?.[key])))) { restricted++; continue }
    best = candidate; visitEvidence = evidence; break
  }
  if (!best) throw new Error('No connected walking itinerary without a recorded access restriction was established for these mapped candidates. Check public entrances and street coverage.')
  for (const source of best.sources) sources.add(source)
  return { ...best, sources: [...sources], data: { ...best.data, visits: visitEvidence, comparison: { checked, connected, restricted, method: 'Shortest measured walking time among returned mapped candidates without recorded access restrictions; not an exhaustive search or a business recommendation.' } } }
}

export function explainFindWalk(data, sourceIndex = 1) {
  const walk = data.walking, budget = data.assessment
  const visits = data.visits.map(place => place.label || `${place.name} (${place.address})`).join(' → ')
  const takeaway = data.visits.filter(place => place.evidence?.tags?.takeaway === 'yes').map(place => place.name)
  return `${data.resolved[0].label} → ${visits}.\n\n**About ${Math.ceil(walk.durationMinutes)} minutes walking (${walk.distanceMiles.toFixed(2)} miles).**${budget.minutesAfterWalking >= 0 ? ` That leaves about ${Math.floor(budget.minutesAfterWalking)} minutes of your ${budget.timeBudgetMinutes}-minute budget for activities.` : ` Walking alone exceeds your budget by about ${Math.ceil(-budget.minutesAfterWalking)} minutes.`} [${sourceIndex}]\n\n${takeaway.length ? `OpenStreetMap records takeout at ${takeaway.join(', ')}. ` : 'Takeout availability is not verified. '}The final place is mapped as ${data.visits.at(-1).category?.value?.replaceAll('_', ' ') || 'a place'}. Current opening, public access, permission to eat and queues are not confirmed. This is the shortest walk among the mapped options checked.${data.entrances?.length ? ' Time inside stations is excluded.' : ''} No return trip is included. [${sourceIndex}]`
}
