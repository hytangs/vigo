import assert from 'node:assert/strict'
import { importTestModules } from './helpers/import-test-modules.mjs'

const [{ buildSearchResults }, { buildNetworkSearchIndex, findNetworkSearchHits }] = await importTestModules(
  'features/search/searchModel.ts',
  'routingUi.ts',
)

// A Boston-shaped network: the Park Street station, nearby bus stops, the Red
// Line, bus 43 whose long name ends at Park Street, and rail-replacement
// shuttles published as separate GTFS routes that share one short name.
const route = (id, fields) => ({
  id, routeId: id, routeType: 3, shortName: '', longName: '', color: 'FFC72C',
  tripCount: 2, stopCount: 2, headwayMinutes: 0, spanHours: 0, serviceHours: 0,
  status: 'baseline', points: [], stopIds: [], ...fields,
})
const stop = (id, name, lat, lon, fields = {}) => ({
  id, name, lat, lon, x: 0, y: 0, routes: [], tripCount: 4, transferScore: 0, locationType: 0, ...fields,
})
const redLineShuttles = [
  'Park Street - Alewife (Shuttle)', 'Alewife - Park Street', 'Harvard - Park Street', 'Kendall/MIT - Park Street',
  'JFK/UMass - Park Street', 'JFK/UMass - Park Street via Post Office', 'Ashmont - Park Street via Post Office',
  'Braintree - Park Street', 'Ashmont - Braintree',
].map((longName, index) => route(`Shuttle-Red-${index}`, { shortName: 'Red Line Shuttle', longName }))
const preview = {
  routes: [
    route('Red', { routeType: 1, longName: 'Red Line', color: 'DA291C', tripCount: 900 }),
    route('43-0', { routeId: '43', shortName: '43', longName: 'Ruggles Station - Park Street Station', directionId: '0', patternRank: 0, tripCount: 320 }),
    route('43-1', { routeId: '43', shortName: '43', longName: 'Ruggles Station - Park Street Station', directionId: '1', patternRank: 1, tripCount: 326 }),
    route('195', { shortName: '195', longName: 'Lemuel Shattuck Hospital - Park Street & Tremont Street', tripCount: 0 }),
    ...redLineShuttles,
    route('Shuttle-HeathPark', { shortName: 'Green Line E Shuttle', longName: 'Heath Street - Park Street' }),
    route('Shuttle-MedfordNorth', { shortName: 'Green Line E Shuttle', longName: 'North Station - Medford/Tufts (Shuttle)' }),
  ],
  stops: [
    ...['70075', '70076', '70196', '70197'].map((id) => stop(id, 'Park Street', 42.3563946, -71.0624242, {
      parentStationId: 'place-pktrm', parentStationName: 'Park Street', routes: ['Red', 'Green-B'], tripCount: 600, transferScore: 70,
    })),
    stop('9070076', 'Park Street - Tremont St @ Winter St', 42.356164, -71.062487, { routes: ['43'], tripCount: 120 }),
    stop('2433', 'Park St @ Beacon St', 42.3571, -71.0632, { routes: ['43'] }),
    stop('1258', 'Tremont St opp Park Street', 42.3548, -71.0631, { routes: ['43'] }),
    stop('43', 'Ruggles', 42.3365, -71.0890, { routes: ['43', 'Orange'], tripCount: 700, transferScore: 60 }),
  ],
}
const networkSearchIndex = buildNetworkSearchIndex(preview)
const projects = [{ id: 'boston', name: 'Boston', summary: { routes: 402, stops: 10281 } }]
const search = (query) => buildSearchResults({ query, preview, networkSearchIndex, projects, recentIds: [] })
const titles = (results) => results.map((result) => `${result.kind}:${result.title}`)

// Search is computed from the loaded City alone; it must not reach the network.
const fetch = globalThis.fetch
globalThis.fetch = () => { throw new Error('Search must work offline') }
try {
  const parkStreet = search('Park Street')
  assert.deepEqual(parkStreet[0], {
    id: 'stop:70075', kind: 'stop', group: 'stops', title: 'Park Street',
    subtitle: '4 platforms · 2 services · 2,400 stop-times',
  }, 'The Park Street station is the first result')
  assert.deepEqual(titles(parkStreet.filter((result) => result.group !== 'commands')), [
    'stop:Park Street',
    'stop:Park Street - Tremont St @ Winter St',
    'stop:Tremont St opp Park Street',
    'route:43',
    'route:195',
    'route:Red Line Shuttle',
    'route:Green Line E Shuttle',
  ], 'Stations and stop prefixes, then lines, then service variants')
  const shuttles = parkStreet.filter((result) => result.title === 'Red Line Shuttle')
  assert.equal(shuttles.length, 1, 'Red Line Shuttle variants collapse into one result')
  assert.match(shuttles[0].subtitle, /^8 variants · Park Street - Alewife \(Shuttle\), /)
  assert.equal(parkStreet.find((result) => result.title === 'Green Line E Shuttle').subtitle, 'Heath Street - Park Street',
    'A single matching variant keeps its own description')

  const hits = findNetworkSearchHits(networkSearchIndex, 'Park Street', 12)
  assert.equal(hits.find((hit) => hit.title === 'Red Line Shuttle').variantCount, 8)
  assert.equal(hits.find((hit) => hit.title === 'Red Line Shuttle').routeId, 'Shuttle-Red-0',
    'The collapsed result opens the variant that matches best')

  // Keyboard order follows the rendered sections: each group stays contiguous.
  for (const query of ['Park Street', '43', 'Park', 'Red Line']) {
    const groups = search(query).map((result) => result.group)
    assert.deepEqual(groups, [...new Set(groups)].flatMap((group) => groups.filter((item) => item === group)),
      `${query} keeps each palette section together`)
  }

  assert.equal(search('park')[0].title, 'Park Street', 'A station name prefix leads lines that only mention it')
  assert.deepEqual(titles(search('43')).slice(0, 2), ['route:43', 'stop:Ruggles'],
    'An exact line name leads stops matched by id or served route')
  assert.deepEqual(titles(search('Red Line')).slice(0, 2), ['route:Red', 'route:Red Line Shuttle'],
    'The line leads its replacement shuttles')
  const exactShuttle = search('Red Line Shuttle')
  assert.equal(exactShuttle[0].title, 'Red Line Shuttle')
  assert.match(exactShuttle[0].subtitle, /^9 variants · /, 'Every matching variant is counted')

  const rideAction = {
    id: 'command:route-query', kind: 'command', group: 'commands', title: 'Plan this journey',
  }
  for (const [query, subtitle] of [
    ['42.3564, -71.0624 to 42.3365, -71.0890', '42.3564, -71.0624 → 42.3365, -71.0890'],
    ['route 42.3564,-71.0624 -> 42.3365,-71.0890 arrive by 09:05', '42.3564,-71.0624 → 42.3365,-71.0890 · Arrive by 09:05'],
  ]) assert.deepEqual(search(query), [{ ...rideAction, subtitle, routingQuery: query }], `${query} plans a journey`)
  assert.equal(search('42.3564, -71.0624').some((result) => result.kind === 'stop' || result.kind === 'route'), false,
    'A coordinate does not match stops or lines by its digits')
} finally {
  globalThis.fetch = fetch
}

console.log('Search ranking: stations first, then lines, then collapsed service variants; offline, coordinate and routing-command searches passed.')
