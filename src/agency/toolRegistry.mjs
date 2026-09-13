import { gtfsQuery } from './gtfsQuery.mjs'
import { draftRiderMessage } from './communications.mjs'

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const routeScope = object({ routeId: string })
const coordinate = object({ lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 }, stopId: string }, ['lat', 'lon'])
const journey = { origin: coordinate, serviceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, departMinutes: { type: 'integer', minimum: 0, maximum: 2880 } }

export const toolDefinitions = [
  { name: 'network_overview', description: 'Read the indexed City, modes, timetable coverage, timezone, and source scopes.', parameters: object({}) },
  { name: 'resolve_entities', description: 'Find route and stop IDs by exact ID/name or literal substring. Return candidates; do not guess between ambiguous results.', parameters: object({ query: string, kind: { type: 'string', enum: ['all', 'route', 'stop'] } }, ['query']) },
  { name: 'gtfs_query', description: 'Read VIGO SQLite. Tables: routes(route_id,short_name,long_name,route_type), stops(stop_id,name,lat,lon), trips(trip_id,route_id,service_id,direction_id), connections(departure,arrival,trip_id,route_id,service_id,direction_id,from_stop_id,to_stop_id,stop_sequence), calendar, calendar_dates, frequencies, transfers, route_services. Times are service-day seconds. Connections are NOT original stop_times; do not invent terminal calls. One SELECT/WITH, approved functions, 200 rows maximum, 1.5s execution limit. Apply calendar exceptions for date-specific questions.', parameters: object({ sql: string, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['sql']) },
  { name: 'route_plan', description: 'Use VIGO Studio Route. Resolve exact stops before requesting stop-to-stop journeys. The server supplies current eligible TripUpdates and reports engine application or scheduled fallback.', parameters: object({ ...journey, destination: coordinate }, ['origin', 'destination', 'serviceDate', 'departMinutes']) },
  { name: 'reach', description: 'Use VIGO scheduled Reach. Requires an indexed pedestrian street network. Realtime alerts are not applied to Reach.', parameters: object({ ...journey, cutoffMinutes: { type: 'integer', minimum: 5, maximum: 60 } }, ['origin', 'serviceDate', 'departMinutes', 'cutoffMinutes']) },
  { name: 'realtime_status', description: 'Read the shared observation, route states, coverage, independent feed ages, and unresolved trip counts.', parameters: object({ routeId: string, tripId: string, stopId: string, vehicleId: string }) },
  { name: 'anomaly_scan', description: 'Read deterministic operational events and their complete timetable evidence. Severity is source-provided for alerts; interval changes carry no learned anomaly score.', parameters: routeScope },
  { name: 'service_alerts', description: 'Read currently active, fresh agency alerts and associated entities.', parameters: routeScope },
  { name: 'draft_rider_message', description: 'Create a human-review draft from an existing event. No publishing, invented cause, recovery time, or unverified alternative route.', parameters: object({ eventId: string, channel: { type: 'string', enum: ['app', 'signage', 'service-alert', 'social'] }, language: string, accessibilityMode: { type: 'boolean' } }, ['eventId', 'channel']) },
]

export function validateArguments(value, schema, name = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`)
    for (const key of Object.keys(value)) {
      if (!schema.properties[key]) throw new Error(`Unknown ${name}.${key}.`)
      validateArguments(value[key], schema.properties[key], `${name}.${key}`)
    }
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${name}.${key} is required.`)
  } else {
    if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) throw new Error(`Invalid ${name}.`)
    if (schema.type === 'number' && !Number.isFinite(value)) throw new Error(`Invalid ${name}.`)
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${name}.`)
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw new Error(`Out-of-range ${name}.`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`Invalid ${name}.`)
    if (typeof value === 'string' && value.length > 8000) throw new Error(`${name} is too long.`)
  }
}

export function createToolRegistry({ context, state, snapshot, adapters, provider, signal }) {
  const generatedAt = state.generatedAt
  const belongs = (event, routeId) => !routeId || event.routeId === routeId || event.routeIds?.includes(routeId)
  const envelope = (data, provenance = [], warnings = [], presentation) => ({ ok: true, data, provenance, generatedAt, warnings, ...(presentation ? { presentation } : {}) })
  return async function callTool(name, input = {}) {
    const definition = toolDefinitions.find((tool) => tool.name === name)
    if (!definition) throw new Error(`Unknown tool: ${name}`)
    // Skills may supply their workflow inputs to several typed helpers.
    const args = input
    validateArguments(args, definition.parameters)
    if (args.routeId && !context.routeIndex.has(args.routeId)) throw new Error('Resolve an exact indexed route ID first.')
    const events = state.events.filter((event) => belongs(event, args.routeId))
    if (name === 'network_overview') return envelope(context.overview(Date.parse(generatedAt) / 1000), ['GTFS Static · indexed VIGO City'])
    if (name === 'resolve_entities') return envelope(context.resolve(args), ['GTFS Static · routes / stops'])
    if (name === 'gtfs_query') {
      const result = await gtfsQuery(context.storePath, args, { signal })
      return envelope(result, ['GTFS Static · VIGO SQLite'], result.truncated ? ['Result truncated at its row or byte limit.'] : [])
    }
    if (name === 'realtime_status') return envelope({ ...state, history: undefined, tripHistory: undefined,
      routes: args.routeId ? state.routes.filter((route) => route.id === args.routeId) : state.routes,
      events: events.filter((event) => (!args.tripId || event.tripId === args.tripId) && (!args.stopId || event.stopId === args.stopId || event.stopIds?.includes(args.stopId)) && (!args.vehicleId || event.vehicleId === args.vehicleId)),
      trips: state.trips.filter((trip) => (!args.routeId || trip.routeId === args.routeId) && (!args.tripId || trip.tripId === args.tripId) && (!args.vehicleId || trip.vehicleId === args.vehicleId)).slice(0, 100),
    }, state.feeds.map((feed) => feed.sourceUrl), state.warnings, { routeIds: args.routeId ? [args.routeId] : [] })
    if (name === 'anomaly_scan' || name === 'service_alerts') {
      const selected = name === 'service_alerts' ? events.filter((event) => event.type === 'service-alert') : events
      return envelope({ events: selected.slice(0, 100), total: selected.length, observedAt: state.observedAt }, [...new Set(selected.flatMap((event) => event.sourceRefs))].slice(0, 100), [...state.warnings, ...(selected.length > 100 ? ['Showing the first 100 events.'] : [])], { routeIds: [...new Set(selected.flatMap((event) => event.routeIds ?? (event.routeId ? [event.routeId] : [])))].slice(0, 20) })
    }
    if (name === 'route_plan' || name === 'reach') {
      for (const point of [args.origin, args.destination].filter(Boolean)) if (point.stopId) {
        const stop = context.stopIndex.get(point.stopId)
        if (!stop) throw new Error('Unknown stop ID. Resolve the indexed stop first.')
        point.lat = stop.lat; point.lon = stop.lon
      }
      if (name === 'reach') return envelope(await adapters.reach({ origin: { id: args.origin.stopId || 'origin', label: 'Origin', coordinate: [args.origin.lon, args.origin.lat], ...(args.origin.stopId ? { stopId: args.origin.stopId } : {}) }, serviceDate: args.serviceDate, departMinutes: args.departMinutes, cutoffsMinutes: [args.cutoffMinutes] }, signal), ['VIGO Reach', 'GTFS Static', 'OpenStreetMap'], ['Reach uses scheduled service. Realtime observations and alerts are not applied.'])
      const freshSources = new Set(state.feeds.filter((feed) => feed.status === 'fresh').map((feed) => feed.sourceUrl))
      const eligible = (snapshot?.tripUpdates ?? []).flatMap((update) => {
        if (!freshSources.has(update.sourceUrl)) return []
        const match = context.matchTrip(update, args.serviceDate)
        if (!match.trip || match.serviceDate !== args.serviceDate) return []
        if (typeof update.timestamp === 'number' && Math.abs(Date.parse(generatedAt) / 1000 - update.timestamp) > state.policy.freshnessSeconds) return []
        return [{ ...update, tripId: match.trip.trip_id }]
      })
      const timestamps = state.feeds.filter((feed) => freshSources.has(feed.sourceUrl) && eligible.some((trip) => trip.sourceUrl === feed.sourceUrl)).map((feed) => feed.feedTimestamp)
      const realtimeSnapshot = eligible.length ? { ...snapshot, tripUpdates: eligible, feedTimestamp: Math.min(...timestamps) } : undefined
      const point = (value) => ({ coordinate: [value.lon, value.lat], label: value.stopId ? context.stopIndex.get(value.stopId)?.name || value.stopId : 'Map point', source: value.stopId ? 'stop' : 'map', ...(value.stopId ? { stopId: value.stopId } : {}) })
      const result = await adapters.route({ ...args, origin: point(args.origin), destination: point(args.destination), mode: 'transit', realtimeSnapshot, allowServiceDateFallback: false }, signal)
      const plans = result.plans ?? (result.plan ? [result.plan] : [result])
      const diagnostics = plans.map((plan) => plan?.diagnostics?.realtimeRouting).filter(Boolean)
      const applied = diagnostics.some((item) => item.status === 'applied' || item.status === 'cancellations_only')
      return envelope({ ...result, realtime: { suppliedTripUpdates: eligible.length, applied, diagnostics } }, ['VIGO Route', 'GTFS Static', ...(eligible.length ? ['GTFS-Realtime TripUpdates'] : [])], [applied ? 'The engine applied a bounded TripUpdate overlay; inspect its diagnostics for excluded or pruned observations.' : 'Scheduled fallback: the engine did not report an applied realtime overlay.', 'Service alerts are shown as context; alert text does not automatically close routes or stops.'], { stopIds: [args.origin.stopId, args.destination.stopId].filter(Boolean) })
    }
    if (name === 'draft_rider_message') {
      const event = state.events.find((event) => event.id === args.eventId)
      if (!event) throw new Error('The event is no longer current. Select an event from this observation.')
      return envelope(await draftRiderMessage({ event, context, ...args }, provider, signal), event.sourceRefs, ['Draft · Human review required'])
    }
    throw new Error(`Tool ${name} is not available.`)
  }
}
