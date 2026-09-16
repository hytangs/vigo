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
  let requestedModes = ['transit']
  const { serviceDate, departTime, arriveBy, ...endpoints } = definition.parameters.properties
  const { lat, lon, label } = endpoints.origin.anyOf.find(schema => schema.type === 'object').properties
  const point = { anyOf: [endpoints.origin.anyOf.find(schema => schema.type === 'string'), { type: 'object', properties: { lat, lon, label }, required: ['lat', 'lon'], additionalProperties: false }] }
  endpoints.origin = point; endpoints.destination = point
  endpoints.waypoints = { ...endpoints.waypoints, items: point }
  const timed = key => ({ type: 'object', properties: { serviceDate, [key]: key === 'departTime' ? departTime : arriveBy }, required: [key], additionalProperties: false })
  const initial = { ...definition, description: 'Calculate a journey between chosen locations. A category (a beach, any park) needs place_search around the origin first; choose a returned place before routing. Include EVERY requested mode; transit alone when none is specified. Endpoints are place-name or known-ID strings; coordinate objects require coordinates already supplied by the user or a source. routingDataMode defaults to realtime for live journeys; choose when="now" unless the user supplies a departure time or arrival deadline. For schedule-based research choose routingDataMode="scheduled" and put an explicit serviceDate plus departTime or arriveBy in when; never use now for research. Preserve the chosen data mode in follow-ups. The server resolves names to coordinates. Preserve intermediate visits and transfer limits.',
    parameters: { ...definition.parameters, properties: { ...endpoints, when: { anyOf: [{ type: 'string', enum: ['now'] }, timed('departTime'), timed('arriveBy')] }, explain: { type: 'boolean', description: 'Does the user request analysis beyond directions? False for ordinary directions or a transit/drive comparison: VIGO shows the computed journeys. True only for additional explanation, research or investigation.' } }, required: [...definition.parameters.required, 'modes', 'when', 'explain'] } }
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
    snapshot: () => pending && structuredClone({ ...pending, slots: pending.slots.map(slot => ({ ...slot, excluded: [...(slot.excluded ?? [])] })), finishWithJourney, requestedModes }),
    restore(saved) {
      if (!saved?.slots?.length) return
      const { finishWithJourney: finish, requestedModes: modes, ...rest } = structuredClone(saved)
      pending = { ...rest, slots: rest.slots.map(slot => ({ ...slot, excluded: new Set(slot.excluded ?? []) })) }
      finishWithJourney = Boolean(finish); requestedModes = modes ?? ['transit']
    },
    continuationDefinition() {
      if (!pending) return null
      const parameters = schema()
      for (const slot of pending.slots.filter(slot => !slot.fixed)) parameters.properties[slot.key] = { anyOf: [
        parameters.properties[slot.key],
        { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false },
      ] }
      return { name: 'continue_journey', description: 'Continue the pending journey when the user chooses or clarifies its locations. Use a candidate number from the pending journey context, or {query: the refined place name} for an unresolved endpoint. Fixed locations and constraints cannot be changed here. For an unrelated request ignore this tool.', parameters }
    },
    continue(input) {
      validateArguments(input, this.continuationDefinition().parameters)
      for (const slot of pending.slots.filter(slot => !slot.fixed)) {
        if (typeof input[slot.key]?.query === 'string') {
          slot.original = input[slot.key].query; slot.choices = []; slot.excluded = new Set()
          input = { ...input, [slot.key]: slot.original }
        }
      }
      return this.arguments(input)
    },
    finishWithJourney: () => finishWithJourney,
    requestedModes: () => [...requestedModes],
    selectionOnly: () => Boolean(pending && pending.slots.every(slot => slot.fixed || slot.choices.length)),
    locationContext: () => pending?.slots.map(slot => ({ endpoint: slot.key, requested: slot.original, fixed: slot.fixed && location(slot.fixed),
      choices: slot.choices.flatMap(({ id, name, label, address, category, identifiers, lat, lon }, index) => slot.excluded?.has(index) ? [] : [{ choice: String(index + 1), id, name, label, address, category, identifiers, lat, lon }]) })),
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
        if (!input || !Object.hasOwn(input, 'when')) { finishWithJourney = false; requestedModes = input?.modes ?? ['transit']; return input }
        // Accept callers using the earlier completion flag; the model-facing
        // form asks one explicit yes/no question about requested analysis.
        if (Object.hasOwn(input, 'resultUse')) {
          if (!['answer', 'continue'].includes(input.resultUse) || Object.hasOwn(input, 'explain')) throw new Error('Choose one journey completion setting.')
          const { resultUse, ...rest } = input
          input = { ...rest, explain: resultUse === 'continue' }
        }
        validateArguments(input, initial.parameters)
        const { when, explain, ...request } = input
        finishWithJourney = !explain
        requestedModes = [...new Set(request.modes)]
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
      return choices.length ? `The journey still needs a location choice. ${choices.map(slot => `For ${slot.key}, which do you mean: ${slot.choices.flatMap((item, i) => slot.excluded?.has(i) ? [] : [`${i + 1}. ${item.label || item.name}${slot.choices.filter(other => (other.label || other.name) === (item.label || item.name)).length > 1 ? ` (${item.category?.value || item.kind || 'location'}; ${item.lat.toFixed(5)}, ${item.lon.toFixed(5)})` : ''}`]).join('; ')}?`).join(' ')}` : null
    },
  }
}
