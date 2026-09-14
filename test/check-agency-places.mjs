import assert from 'node:assert/strict'
import { createPlaceSearch } from '../src/agency/placeSearch.mjs'
import { createToolRegistry } from '../src/agency/toolRegistry.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { compactResult } from '../src/agency/queryAgent.mjs'

const feature = (id, name, lon, lat) => ({ type: 'Feature', properties: { osm_type: 'N', osm_id: id, name, housenumber: '17', street: 'Market Street', city: 'City X' }, geometry: { type: 'Point', coordinates: [lon, lat] } })
const stops = [{ stop_id: 'internal', name: 'Internal station node', location_type: 3, lon: 0, lat: 0 }, { stop_id: 'A', name: 'Library', lon: 10, lat: 20 }, { stop_id: 'B', name: 'Station', lon: 11, lat: 21 }]
let requests = 0, requestUrl, requested
const places = createPlaceSearch({ stops, env: { VIGO_AGENCY_PLACE_SEARCH_URL: 'http://localhost:2322/api/' }, fetchImpl: async (url, options) => {
  requestUrl = url; requests++
  assert.equal(options.headers.Authorization, undefined, 'No model credentials go to the geocoder')
  assert.equal(options.redirect, 'error')
  return Response.json({ features: [feature(1, 'Coffee House', 10.1, 20.2), feature(2, 'Coffee House', 10.3, 20.4), feature(2, 'Duplicate', 10.3, 20.4), feature(3, 'Invalid', 800, 20)] })
} })
const matches = await places.search({ query: 'Coffee House City X', near: stops[2] })
assert.equal(matches.matches.length, 2, 'Keep distinct branches and discard invalid coordinates and duplicate OSM identities')
assert.equal(requestUrl.searchParams.get('bbox'), '10,20,11,21', 'Search bounds come from this City, never a hardcoded city')
assert.equal(requestUrl.searchParams.get('lon'), '11')
assert.equal(matches.matches[0].address, '17 Market Street, City X')
matches.matches[0].lon = 99
await places.search({ query: 'Coffee House City X', near: stops[2] })
assert.equal(requests, 1, 'Repeat queries reuse the timestamped bounded cache')
assert.equal(places.resolve('osm:node/1').lon, 10.1, 'Caller mutation cannot change routing coordinates')
await places.search({ query: 'Coffee House Elsewhere', withinCity: false })
assert.equal(requestUrl.searchParams.has('bbox'), false, 'Explicit searches can extend beyond the City')
assert.throws(() => places.resolve('osm:node/999'), /Search for this place again/)
await assert.rejects(places.search({ query: 'x'.repeat(201) }), /1–200/)
const abort = new AbortController(); abort.abort()
await assert.rejects(places.search({ query: 'Coffee House City X' }, abort.signal), /abort/i)
assert.equal(requests, 2, 'Cancellation prevents a network request')
await assert.rejects(createPlaceSearch({ env: { VIGO_AGENCY_PLACE_SEARCH_URL: 'off' }, fetchImpl: () => assert.fail('Offline mode must not fetch') }).search({ query: 'Coffee' }), /search is off/)
await assert.rejects(createPlaceSearch({ env: {}, fetchImpl: async () => new Response('', { status: 429 }) }).search({ query: 'Coffee' }), /HTTP 429/)
await assert.rejects(createPlaceSearch({ env: {}, fetchImpl: async () => new Response('x'.repeat(300_000)) }).search({ query: 'Coffee' }), /too much data/)
await assert.rejects(createPlaceSearch({ env: {}, fetchImpl: async () => Response.json(null) }).search({ query: 'Coffee' }), /unreadable/)

const state = { generatedAt: '2026-09-13T12:00:00Z', events: [], feeds: [] }
const context = { stopIndex: new Map(stops.map((stop) => [stop.stop_id, stop])), routeIndex: new Map(), overview: () => ({ cityName: 'City X' }) }
let blocked = false
const callTool = createToolRegistry({ context, state, places, adapters: { reach: async (input) => { requested = input; return { request: input } }, route: async (input) => {
  requested = input
  return { plan: blocked ? { status: 'blocked', detail: 'No pedestrian path.' } : { status: 'ready', travelMode: 'walk', origin: input.origin, destination: input.destination, durationMinutes: 6, legs: [{ type: 'walk', distanceKm: 0.48, fromName: input.origin.label, toName: input.destination.label, coordinates: Array(1000).fill([10, 20]) }], diagnostics: { walkingSpeedKph: 4.8 } } }
} } })
await assert.rejects(callTool('place_search', { query: 'Coffee', nearStopId: 'invented' }), /exact stop ID/)
const input = { origin: { placeId: 'osm:node/1', lat: 0, lon: 0 }, destination: { stopId: 'B' } }
const result = await callTool('walk_route', input)
assert.deepEqual(requested.origin.coordinate, [10.1, 20.2], 'Route uses the provider result, never model-supplied replacement coordinates')
assert.deepEqual(requested.destination.coordinate, [11, 21])
assert.equal(requested.mode, 'walk')
assert.equal(requested.realtimeSnapshot, undefined, 'Walking requires neither timetable nor realtime parameters')
assert.equal(result.data.walking.distanceMeters, 480)
assert.equal(result.data.walking.durationMinutes, 6)
assert.equal(result.data.walking.distanceMiles, 480 / 1609.344, 'Imperial distance uses the exact international mile conversion')
assert.equal(input.origin.lon, 0, 'Tool input remains intact in the evidence record')
await assert.rejects(callTool('walk_route', { ...input, origin: { placeId: 'osm:node/999' } }), /Search for this place again/)
await assert.rejects(callTool('walk_route', { ...input, origin: { placeId: 'osm:node/1', stopId: 'A' } }), /Choose one stop ID/)
blocked = true
assert.equal((await callTool('walk_route', input)).data.walking, null, 'No fabricated distance when the native engine finds no path')
blocked = false
await callTool('route_plan', { ...input, serviceDate: '2026-09-13', departTime: '08:00' })
assert.equal(requested.mode, 'transit')
assert.deepEqual(requested.origin.coordinate, [10.1, 20.2], 'The same resolved place works for transit')
await callTool('reach', { origin: input.origin, serviceDate: '2026-09-13', departTime: '08:00', cutoffMinutes: 15 })
assert.deepEqual(requested.origin.coordinate, [10.1, 20.2], 'Reach shares place identity without another geocoder or routing model')
let round = 0
const answer = await queryAgency({ question: 'How far is the walk?', context, state, callTool, provider: { available: true, complete: async (messages) => {
  if (++round === 1) return { tool_calls: [{ id: 'walk', function: { name: 'walk_route', arguments: JSON.stringify(input) } }] }
  assert.match(messages.filter(message => message.role !== 'system').at(-1).content, /480 metres \(0.30 miles\)/)
  assert.doesNotMatch(messages.filter(message => message.role !== 'system').at(-1).content, /coordinates/, 'The model sees distance and endpoints, not thousands of map coordinates')
  return { content: 'From Coffee House at 17 Market Street to Station, the walk is 480 m, about 6 minutes. [1]' }
} } })
assert.deepEqual(answer.citations, [1])
assert.equal(answer.trace[0].result.data.plan.legs[0].coordinates.length, 1000, 'Full route geometry remains in saved evidence and available to the map')
const offlineReply = await queryAgency({ question: 'Can you look online?', context, state, callTool, placesAvailable: false, provider: { available: true, complete: async (messages, definitions) => {
  assert.ok(!definitions.some((tool) => tool.name === 'place_search'), 'Disabled online lookup is not offered to the model')
  assert.match(messages[1].content, /place_search unavailable/)
  return { content: 'Online place search is disabled on this server.' }
} } })
assert.equal(offlineReply.answer, 'Online place search is disabled on this server.', 'Assertions inside the provider must not be hidden by provider-error recovery')

const categoryPlaces = createPlaceSearch({ stops, env: {}, fetchImpl: async url => {
  assert.equal(url.searchParams.get('osm_tag'), 'leisure:park')
  const park = feature(11, 'Central Common', 10.1, 20.1), hotel = feature(12, 'Park Palace', 10.2, 20.2)
  Object.assign(park.properties, { osm_key: 'leisure', osm_value: 'park' })
  Object.assign(hotel.properties, { osm_key: 'tourism', osm_value: 'hotel' })
  return Response.json({ features: [hotel, park] }) // A provider ignoring the filter cannot admit the hotel.
} })
const parks = await categoryPlaces.search({ query: 'park', osmTag: 'leisure:park' })
assert.deepEqual(parks.matches.map(m => m.name), ['Central Common'])
assert.equal(parks.matches[0].publicAccess, 'unverified', 'Mapped park category does not prove access or food permission')
const projection = JSON.parse(compactResult({ ok: true, data: parks, warnings: [] }, 'place_search'))
assert.deepEqual(projection.data.matches[0].category, { key: 'leisure', value: 'park' })
assert.equal(projection.data.matches[0].publicAccess, 'unverified')
const restored = createPlaceSearch({ stops, env: {}, fetchImpl: () => assert.fail('A retained exact identity should not be geocoded again') })
restored.restore(parks.matches)
assert.equal(restored.resolve('osm:node/11').lat, 20.1)
parks.matches[0].lat = 0
assert.equal(restored.resolve('osm:node/11').lat, 20.1)
let now = Date.now(), detailRequests = 0
const detailed = createPlaceSearch({ clock: () => now, env: { VIGO_AGENCY_PLACE_DETAILS_URL: 'http://localhost:2322/osm/' }, fetchImpl: async url => {
  detailRequests++
  assert.equal(url.href, 'http://localhost:2322/osm/node/11.json')
  return Response.json({ elements: [{ type: 'node', id: 12, tags: { access: 'yes' } }, { type: 'node', id: 11, tags: { leisure: 'park', access: 'private', unrelated: 'not needed' } }] })
} })
detailed.restore(restored.resolve('osm:node/11') ? [restored.resolve('osm:node/11')] : [])
const detail = await detailed.details('osm:node/11')
assert.deepEqual(detail.tags, { leisure: 'park', access: 'private' }, 'Use the exact OSM identity and only relevant tags')
detail.tags.access = 'yes'
assert.equal((await detailed.details('osm:node/11')).tags.access, 'private')
assert.equal(detailRequests, 1)
now += 15 * 60_000
await detailed.details('osm:node/11')
assert.equal(detailRequests, 2, 'Map detail evidence expires rather than silently becoming permanent')
assert.equal(detailed.detailsEndpoint, 'localhost:2322', 'Runtime facts expose the configured details host')
const disabledDetails = createPlaceSearch({ env: { VIGO_AGENCY_PLACE_DETAILS_URL: 'off' }, fetchImpl: () => assert.fail('Details disabled') })
assert.equal(await disabledDetails.details('osm:node/11'), null)
const invalidDetails = createPlaceSearch({ env: { VIGO_AGENCY_PLACE_DETAILS_URL: 'https://user:secret@localhost/' }, fetchImpl: () => assert.fail('No embedded credentials') })
invalidDetails.restore([restored.resolve('osm:node/11')])
await assert.rejects(invalidDetails.details('osm:node/11'), /without embedded credentials/)
console.log('Agency places: City-scoped online lookup, exact identities, private endpoints, caching, cancellation, provider failures, native walking handoff and model evidence passed.')
