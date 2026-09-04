export const capabilitySchemaVersion = 'vigo.capabilities.v3'
export const apiVersion = '1.0'
export const cityFormatVersion = 1
export const resultSchemaVersion = 1

export const supportedReachRasterSizes = Object.freeze([
  48,
  64,
  96,
  128,
  192,
  256,
  384,
  512,
  1024,
])

export const publicCliCommands = Object.freeze([
  'build',
  'capabilities',
  'inspect',
  'route',
  'matrix',
  'reach',
  'compare',
])

const supported = 'supported'
const unavailable = 'unavailable'

const queryFamilies = Object.freeze([
  Object.freeze({
    id: 'route',
    label: 'Route',
    purpose: 'Find and explain journeys between ordered points.',
    interfaces: Object.freeze({ studio: supported, python: supported, cli: supported }),
    options: Object.freeze([
      'transit, walk, or drive',
      'depart at or arrive by',
      'departure window',
      'live transit or supplied traffic when supported',
      'ordered waypoints',
      'batch requests',
    ]),
    objective: Object.freeze({
      default: 'earliest_arrival',
      available: Object.freeze(['earliest_arrival']),
      tieBreak: Object.freeze(['fewer_boardings', 'less_walking', 'stable_order']),
    }),
  }),
  Object.freeze({
    id: 'matrix',
    label: 'Matrix',
    purpose: 'Compute travel times between sets of origins and destinations.',
    interfaces: Object.freeze({ studio: unavailable, python: supported, cli: supported }),
    options: Object.freeze([
      'one to many or many to many',
      'transit, walk, or drive',
      'scalar time and distance output',
    ]),
    time: Object.freeze({ available: Object.freeze(['depart_at']), unavailable: Object.freeze(['arrive_by']) }),
  }),
  Object.freeze({
    id: 'reach',
    label: 'Reach',
    purpose: 'Map where the network can reach within one or more time limits.',
    interfaces: Object.freeze({ studio: supported, python: supported, cli: supported }),
    options: Object.freeze([
      'transit, walk, or drive',
      'area contours or reached streets',
      'scenario comparison',
    ]),
    note: 'Reach measures modeled network reach. It does not measure people, jobs, demand, or welfare.',
  }),
])

export const capabilityCatalog = Object.freeze({
  schemaVersion: capabilitySchemaVersion,
  product: Object.freeze({
    name: 'VIGO',
    definition: 'VIGO turns GTFS and OSM into a city model for routing, network-wide travel-time analysis, and service-change testing.',
    model: Object.freeze(['City', 'Scenario', 'Query', 'Result']),
    queryFamilies: Object.freeze(['Route', 'Matrix', 'Reach']),
  }),
  interfaceStates: Object.freeze([supported, unavailable]),
  productLine: Object.freeze([
    Object.freeze({
      id: 'command',
      label: 'VIGO command',
      purpose: 'Build Cities and run repeatable Route, Matrix, Reach, and Compare work.',
    }),
    Object.freeze({
      id: 'studio',
      label: 'VIGO Studio',
      purpose: 'Build and explore a City, plan journeys, and compare network change.',
    }),
    Object.freeze({
      id: 'python',
      label: 'VIGO Python',
      purpose: 'Use the same City, Scenario, Route, Matrix, Reach, and Result model from Python.',
    }),
  ]),
  queries: queryFamilies,
  lenses: Object.freeze([
    Object.freeze({ id: 'services', label: 'Services', purpose: 'Inspect routes, stops, stations, patterns, and schedules.' }),
    Object.freeze({ id: 'playback', label: 'Playback', purpose: 'View scheduled or live vehicle state on the City.' }),
    Object.freeze({ id: 'source', label: 'Data', purpose: 'Inspect supplied GTFS and OSM coverage and warnings.' }),
    Object.freeze({ id: 'run-record', label: 'Run record', purpose: 'Explain the City revision, Scenario, Query, warnings, and timing behind a Result.' }),
  ]),
  scenario: Object.freeze({
    meaning: 'An immutable set of changes applied to one City revision.',
    canChange: Object.freeze(['planned transit service', 'live transit state', 'supplied traffic state']),
    cannotChange: Object.freeze(['query walking limits', 'the City source data', 'the City revision']),
    support: Object.freeze({
      plannedTransit: Object.freeze({
        route: Object.freeze({ supported: false, reason: 'planned_transit_route', available: Object.freeze(['reach']) }),
        matrix: Object.freeze({ supported: false, reason: 'planned_transit_matrix', available: Object.freeze(['reach']) }),
        reach: Object.freeze({ supported: true }),
      }),
      liveTransit: Object.freeze({
        route: Object.freeze({ supported: false, reason: 'live_transit_python', available: Object.freeze(['studio']) }),
        matrix: Object.freeze({ supported: false, reason: 'live_transit_matrix', available: Object.freeze([]) }),
        reach: Object.freeze({ supported: false, reason: 'live_transit_reach', available: Object.freeze([]) }),
      }),
      traffic: Object.freeze({
        route: Object.freeze({ supported: true, modes: Object.freeze(['drive']) }),
        matrix: Object.freeze({ supported: true, modes: Object.freeze(['drive']) }),
        reach: Object.freeze({ supported: false, reason: 'traffic_reach', available: Object.freeze(['drive_route', 'drive_matrix']) }),
      }),
    }),
  }),
})

export function vigoCapabilities(productVersion) {
  return {
    ...capabilityCatalog,
    productVersion,
    apiVersion,
    cityFormatVersion,
    resultSchemaVersion,
    reachRasterSizes: [...supportedReachRasterSizes],
    publicCliCommands: [...publicCliCommands],
  }
}
