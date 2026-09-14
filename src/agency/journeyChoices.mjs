import { validateArguments } from './toolArguments.mjs'

const validPoint = ({ lat, lon }) => Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180
export const coordinateChoices = (matches = []) => matches.filter(validPoint)
const location = (item) => ({ lat: item.lat, lon: item.lon, label: item.label || item.name,
  ...(item.stopId || item.kind === 'stop' ? { stopId: item.stopId || item.id } : item.placeId || item.kind === 'place' ? { placeId: item.placeId || item.id } : {}) })

// After an ambiguous lookup the next model call is a selection form. The
// server owns the coordinates, resolved endpoints and original constraints.
// This state belongs to one Ask turn, not the shared City or provider.
export function createJourneyChoices(definition) {
  let pending
  let finishWithJourney = false
  const { serviceDate, departTime, arriveBy, ...endpoints } = definition.parameters.properties
  const { lat, lon, label } = endpoints.origin.anyOf.find(schema => schema.type === 'object').properties
  const point = { anyOf: [endpoints.origin.anyOf.find(schema => schema.type === 'string'), { type: 'object', properties: { lat, lon, label }, required: ['lat', 'lon'], additionalProperties: false }] }
  endpoints.origin = point; endpoints.destination = point
  endpoints.waypoints = { ...endpoints.waypoints, items: point }
  const timed = key => ({ type: 'object', properties: { [key]: key === 'departTime' ? departTime : arriveBy, serviceDate }, required: [key], additionalProperties: false })
  const initial = { ...definition, description: 'Calculate a transit journey. Endpoints are place-name or known-ID strings; use coordinate objects only for coordinates already supplied by the user or a source. Choose when="now" unless the user specifies a time. Otherwise choose a departure time OR an arrival deadline, with optional date. The server resolves names to coordinates. Preserve intermediate visits and transfer limits.',
    parameters: { ...definition.parameters, properties: { ...endpoints, when: { anyOf: [{ type: 'string', enum: ['now'] }, timed('departTime'), timed('arriveBy')] }, resultUse: { type: 'string', enum: ['answer', 'continue'], description: 'Choose answer when this journey fulfills the request: VIGO displays its exact times and steps immediately. Choose continue when further comparison, research or other work is requested.' } }, required: [...definition.parameters.required, 'when', 'resultUse'] } }
  const slots = (request) => [
    { key: 'origin', original: request.origin },
    ...(request.waypoints ?? []).map((original, i) => ({ key: `via${i + 1}`, original })),
    { key: 'destination', original: request.destination },
  ]
  const requestFor = points => ({ ...pending.constraints, origin: points[0], destination: points.at(-1),
    ...(pending.hasWaypoints ? { waypoints: points.slice(1, -1) } : {}) })
  function schema() {
    const properties = {}
    for (const [endpoint, slot] of pending.slots.entries()) {
      if (slot.fixed) continue
      properties[slot.key] = slot.choices.length ? {
        type: 'string', enum: [...slot.choices.flatMap((_, i) => slot.excluded?.has(i) ? [] : [String(i + 1)]), 'unclear'],
        description: `Choose a candidate number for endpoint ${endpoint} from the latest location result. Match names, feature types and identifiers. Use unclear only when the intended identity cannot be established. The server uses the chosen coordinates.`,
      } : definition.parameters.properties.origin
    }
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
  }
  return {
    finishWithJourney: () => finishWithJourney,
    selectionOnly: () => Boolean(pending && pending.slots.every(slot => slot.fixed || slot.choices.length)),
    retainedRequest: () => pending && requestFor(pending.slots.map(slot => slot.fixed ? location(slot.fixed) : slot.original)),
    definition() {
      if (!pending) return initial
      const fixed = pending.slots.filter(slot => slot.fixed).map(slot => slot.key)
      return { ...definition, description: `Continue the requested journey. Choose location numbers from this form; do not rewrite names or coordinates. A location without choices still needs a name or verified point. Retained: ${JSON.stringify({ ...pending.constraints, locations: fixed })}. The server supplies coordinates and preserves these settings.${pending.noPath ? ' The last selected arrival point had no itinerary. Review remaining candidates only for another entrance to the same requested place; never substitute an unrelated place or a different explicitly requested terminal.' : ''} Use unclear if a meaningful choice cannot be established.`, parameters: schema() }
    },
    arguments(input) {
      if (!pending) {
        // Accept retained/programmatic requests in their original shape too.
        // The model-facing form requires one mutually exclusive time choice.
        if (!input || !Object.hasOwn(input, 'when')) { finishWithJourney = false; return input }
        validateArguments(input, initial.parameters)
        const { when, resultUse, ...request } = input
        finishWithJourney = resultUse === 'answer'
        return when === 'now' ? request : { ...request, ...when }
      }
      validateArguments(input, schema())
      if (pending.slots.some(slot => !slot.fixed && input[slot.key] === 'unclear')) {
        for (const slot of pending.slots) if (!slot.fixed && slot.choices.length && input[slot.key] !== 'unclear') slot.fixed = slot.choices[Number(input[slot.key]) - 1]
        throw Object.assign(new Error('Choose the remaining journey location.'), { details: { status: 'needs_user_location' } })
      }
      const points = pending.slots.map(slot => slot.fixed ? location(slot.fixed)
        : slot.choices.length ? location(slot.choices[Number(input[slot.key]) - 1]) : input[slot.key])
      return requestFor(points)
    },
    observe(request, result) {
      if (result.data?.status === 'needs_user_location') return
      const clarification = result.data?.clarification
      if (!Array.isArray(clarification?.endpoints)) {
        if (pending && result.ok && result.data?.plan && !result.data.plan.legs?.length) {
          const destination = pending.slots.at(-1)
          const index = destination.choices.findIndex(item => {
            const candidate = location(item), selected = request.destination
            return selected?.stopId ? candidate.stopId === selected.stopId : selected?.placeId ? candidate.placeId === selected.placeId
              : candidate.lat === selected?.lat && candidate.lon === selected?.lon
          })
          if (index >= 0) {
            destination.excluded ??= new Set(); destination.excluded.add(index)
            if (destination.choices.some((_, i) => !destination.excluded.has(i))) {
              const points = [request.origin, ...(request.waypoints ?? [])]
              for (const [i, point] of points.entries()) pending.slots[i].fixed = point
              pending.noPath = true
              return
            }
          }
        }
        if (result.ok) pending = undefined
        return
      }
      const { origin: _origin, destination: _destination, waypoints, ...constraints } = request
      pending = { constraints: structuredClone(constraints), hasWaypoints: Boolean(waypoints), slots: slots(request).map((slot, endpoint) => {
        const fixed = clarification.resolved?.find(item => item.endpoint === endpoint && validPoint(item))
        const choices = coordinateChoices(clarification.endpoints.find(item => item.endpoint === endpoint)?.matches)
        return { ...slot, fixed: fixed && structuredClone(fixed), choices: structuredClone(choices) }
      }) }
    },
    clarification() {
      if (!pending) return null
      const choices = pending.slots.filter(slot => !slot.fixed && slot.choices.length)
      return choices.length ? `The journey still needs a location choice. ${choices.map(slot => `For ${slot.key}, which do you mean: ${slot.choices.filter((_, i) => !slot.excluded?.has(i)).map(item => item.label || item.name).join('; ')}?`).join(' ')}` : null
    },
  }
}
