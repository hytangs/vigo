// Corpus Cities and requests. Every City is built from the public synthetic
// fixture, or extracted from the frozen 0.5.0 archive, so the corpus replays on
// any machine. Add cases; keep existing names stable so recorded files diff.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import JSZip from 'jszip'

const serviceDate = '2026-07-15'
const sunday = '2026-07-19'
const stop = id => ({ stop: { feed: null, id } })
const base = { serviceDate, time: '07:55', origin: stop('A'), destination: stop('B'), maxWalkKm: 0.2, requireTransitRide: true }
const free = { origin: { coordinate: [-77.05, 38.9] }, destination: { coordinate: [-77.03, 38.91] } }
const coordinate = { ...base, ...free }
const near = { origin: { coordinate: [-77.0499, 38.90005] }, destination: { coordinate: [-77.0301, 38.90995] } }
const reachBase = { serviceDate, time: '07:55', origin: free.origin, maxWalkKm: 1.2, rasterSize: 24, cutoffsMinutes: [15, 30, 45] }
const arriveBase = { serviceDate, time: '08:30', timePreference: 'arrive_by', destination: free.destination, maxWalkKm: 1.2, rasterSize: 24, cutoffsMinutes: [15, 30, 45] }
const frequency = { services: [{ operation: 'add', timeModel: 'preserve-scheduled', stops: [{ stopId: 'A' }, { stopId: 'B' }],
  startMinutes: 475, endMinutes: 600, headwayMinutes: 5, segmentRuntimeMinutes: [5] }] }
const preserved = { services: [{ operation: 'replace', scheduleMode: 'preserve-trips', stops: [{ stopId: 'X' }, { stopId: 'B' }],
  scheduledTrips: [{ tripId: 'T2', departureSeconds: 495 * 60, arrivalOffsetsSeconds: [0, 600], departureOffsetsSeconds: [0, 600],
    canBoard: [1, 0], canAlight: [0, 1] }] }] }

async function rewriteFeed(gtfsPath, edit) {
  const zip = await JSZip.loadAsync(fs.readFileSync(gtfsPath))
  await edit(zip)
  fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export const cities = {
  standard: {},
  'walk-only': { build: ['--street-modes=walk'] },
  // Accessibility attributes as in check-wheelchair-routing.mjs.
  wheelchair: {
    inputs: { wheelchair: true },
    build: ['--wheelchair'],
    prepare: ({ gtfsPath }) => rewriteFeed(gtfsPath, async zip => {
      zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding\n'
        + 'S,Parent,38.9,-77.05,1,,1\nA,Alpha,38.9,-77.05,0,S,0\nX,Transfer,38.905,-77.04,0,,1\nB,Bravo,38.91,-77.03,0,,1\nD,Denied,38.906,-77.038,0,S,2\nU,Unknown,38.907,-77.036,0,,0\n')
      zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,wheelchair_accessible\nR1,WKD,T1,0,1\nR2,WKD,T2,0,1\nR1,WKD,FAST,0,2\nR1,WKD,UNKNOWN,0,0\n')
      zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string'))
        .replace('T1,08:10:00,08:10:00,X,2', 'T1,08:02:00,08:02:00,D,2\nT1,08:03:00,08:03:00,U,3\nT1,08:10:00,08:10:00,X,4')
        + 'FAST,08:00:00,08:00:00,A,1\nFAST,08:05:00,08:05:00,B,2\nUNKNOWN,08:00:00,08:00:00,A,1\nUNKNOWN,08:06:00,08:06:00,B,2\n')
    }),
  },
  'private-access': { inputs: { terminalAccess: true }, build: ['--private-access=endpoints'] },
  'platform-area': { inputs: { platformOutline: true } },
  fares: {
    prepare: ({ gtfsPath }) => rewriteFeed(gtfsPath, zip => {
      zip.file('fare_attributes.txt', 'fare_id,price,currency_type,payment_method,transfers,agency_id\nBASE,2.40,USD,0,,fixture\n')
      zip.file('fare_rules.txt', 'fare_id,route_id\nBASE,R1\nBASE,R2\n')
    }),
  },
  'display-metadata': {
    prepare: ({ gtfsPath }) => rewriteFeed(gtfsPath, zip => {
      zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type,route_color\nR1,fixture,R1,First Route,3,00843D\nR2,fixture,,Second Route,1,DA291C\n')
      zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,trip_headsign,trip_short_name\nR1,WKD,T1,0,Transfer,One\nR2,WKD,T2,1,Bravo,Two\n')
      zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:05:00,08:05:30,M,2\nT1,08:10:00,08:10:00,X,3\nT2,08:15:00,08:15:00,X,1\nT2,08:30:00,08:30:00,B,2\n')
      zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,38.900,-77.050\nM,Middle,38.9025,-77.045\nX,Transfer,38.905,-77.040\nB,Bravo,38.910,-77.030\n')
    }),
  },
  collection: {
    collection: async ({ gtfsPath, osmPath }, directory) => {
      const shifted = path.join(directory, 'shifted.zip')
      fs.copyFileSync(gtfsPath, shifted)
      await rewriteFeed(shifted, async zip => {
        zip.file('stop_times.txt', (await zip.file('stop_times.txt').async('string')).replaceAll('08:30:00', '08:25:00'))
      })
      const spec = { schemaVersion: 'vigo.scenarios.source.v1', name: 'Corpus scenarios', maximumResidentScenarios: 2,
        prepareDates: [serviceDate], osm: { path: path.basename(osmPath), sha256: digest(osmPath) },
        scenarios: [
          { id: 'current', name: 'Current service', feeds: [{ path: path.basename(gtfsPath), scope: 'fixture', sha256: digest(gtfsPath) }] },
          { id: 'faster', name: 'Faster R2', feeds: [{ path: 'shifted.zip', scope: 'fixture', sha256: digest(shifted) }] },
        ] }
      const specPath = path.join(directory, 'source.json')
      fs.writeFileSync(specPath, JSON.stringify(spec))
      return specPath
    },
  },
  // Station fixtures as in check-standalone-station-access.mjs and check-pathway-cost-model.mjs.
  'station-pathway': { prepare: ({ gtfsPath }) => stationFeed(gtfsPath, 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nmoving,X,Y,3,0,90,1\n') },
  'station-unpriced': { prepare: ({ gtfsPath }) => stationFeed(gtfsPath, 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nfirst,X,N,1,0,,\nsecond,N,Y,1,0,,\n', true) },
  'pathway-estimated': {
    prepare: ({ gtfsPath }) => rewriteFeed(gtfsPath, zip => {
      zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n'
        + 'O,Origin,38.899,-77.051,0,\nC,Bus,38.9,-77.05,0,\nS,Station,38.9,-77.05,1,\nA,Entrance,38.9,-77.05,2,S\n'
        + 'N,Inside,,,3,S\nP,Platform,38.9,-77.049,0,S\nB,Destination,38.91,-77.03,0,\n')
      zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
        + 'T1,07:59:00,07:59:00,O,1\nT1,08:00:00,08:00:00,C,2\nT2,08:01:00,08:01:00,P,1\nT2,08:10:00,08:10:00,B,2\n')
      zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time,stair_count\n'
        + 'gate,A,N,6,0,,,\nstairs,N,P,2,0,,,20\n')
    }),
  },
  // Two scoped copies of the feed, as in check-wheelchair-routing.mjs, so IDs carry feeds.
  scoped: { build: ({ gtfsPath }) => ['--gtfs', gtfsPath, '--gtfs-scope', 'one', '--gtfs-scope', 'two'] },
  'frozen-050': { archive: 'test/fixtures/format-0.5.0/city.tar.gz', city: 'city' },
}

function stationFeed(gtfsPath, pathways, interior = false) {
  return rewriteFeed(gtfsPath, zip => {
    zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,38.900,-77.050,0,\n'
      + 'X,Entrance,38.905,-77.040,2,P\nY,Platform,38.9051,-77.039,0,P\nP,Station,38.905,-77.040,1,\nB,Bravo,38.910,-77.030,0,\n'
      + (interior ? 'N,Interior,,,3,P\n' : ''))
    zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type\nR1,fixture,R1,Feeder,3\nR2,fixture,R2,Subway,1\n')
    zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id\nR2,WKD,T2,0\n')
    zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT2,08:15:00,08:15:00,Y,1\nT2,08:30:00,08:30:00,B,2\n')
    zip.file('pathways.txt', pathways)
  })
}

const route = (city, name, request, extra = {}) => ({ city, name, kind: 'route', request, ...extra })
const matrix = (city, name, request) => ({ city, name, kind: 'matrix', request })
const reach = (city, name, request, extra = {}) => ({ city, name, kind: 'reach', request, ...extra })

export const cases = [
  { city: 'standard', name: 'info', kind: 'info' },
  route('standard', 'route-stops', base),
  route('standard', 'route-no-geometry', { ...base, includeGeometry: false }),
  route('standard', 'route-coordinates', coordinate),
  route('standard', 'route-near-coordinates', { ...base, ...near, disableCache: true }),
  route('standard', 'route-legacy-stop-ids', { ...base, origin: { stopId: 'A' }, destination: { stopId: 'B' } }),
  route('standard', 'route-labels', { ...coordinate, origin: { ...free.origin, label: 'Home' }, destination: { ...free.destination, name: 'Office' } }),
  route('standard', 'route-time-minutes', { ...base, time: undefined, timeMinutes: 475 }),
  route('standard', 'route-time-seconds', { ...base, time: '07:55:30' }),
  route('standard', 'route-after-midnight-clock', { ...base, time: '29:50' }),
  route('standard', 'route-arrive-by', { ...base, time: '08:30', timePreference: 'arrive_by' }),
  route('standard', 'route-arrive-by-reserve', { ...base, time: '08:40', timePreference: 'arrive_by', arrivalBufferMinutes: 5 }),
  route('standard', 'route-not-found-transfers', { ...base, maxTransfers: 0 }),
  route('standard', 'route-not-found-sunday', { ...base, serviceDate: sunday }),
  route('standard', 'route-not-found-no-access', { ...base, maxWalkKm: 0.01, origin: { coordinate: [-77.0498, 38.9001] }, destination: { coordinate: [-77.0495, 38.90025] } }),
  route('standard', 'route-transfer-buffer', { ...base, minimumTransferBufferMinutes: 5, allowStreetTransfers: false }),
  route('standard', 'route-default-mode', { ...base, requireTransitRide: undefined }),
  route('standard', 'route-walk', { ...coordinate, mode: 'walk' }),
  route('standard', 'route-drive', { ...coordinate, mode: 'drive' }),
  route('standard', 'route-drive-traffic', (_, now) => ({ ...coordinate, mode: 'drive', traffic: { observedAt: now,
    observations: [{ fromCoordinate: [-77.05, 38.9], toCoordinate: [-77.04, 38.905], delayFactor: 3 }] } })),
  route('standard', 'route-alternatives-pareto', { ...base, alternatives: 2, alternativeRanking: 'pareto' }),
  route('standard', 'route-alternatives-ranked', { ...base, alternatives: 2, alternativeRanking: 'ranked', alternativeSlackMinutes: 30 }),
  route('standard', 'route-window', { ...base, requireTransitRide: undefined, windowMinutes: 5 }),
  route('standard', 'route-waypoints', { ...coordinate, requireTransitRide: undefined, mode: 'walk', waypoints: [{ coordinate: [-77.04, 38.905] }] }),
  // Realtime snapshots go stale, so these requests are stamped at run time.
  route('standard', 'route-realtime-delay', (_, now) => ({ ...base, realtimeSnapshot: { incrementality: 'FULL_DATASET',
    feedTimestamp: Math.floor(now / 1000), tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }] } })),
  route('standard', 'route-realtime-canceled', (_, now) => ({ ...base, realtimeSnapshot: { feedTimestamp: Math.floor(now / 1000),
    tripUpdates: [{ tripId: 'T1', scheduleRelationship: 'CANCELED' }] } })),
  route('standard', 'route-realtime-stale', { ...base, realtimeSnapshot: { feedTimestamp: 1784113200, tripUpdates: [{ tripId: 'T2', delaySeconds: 600 }] } }),
  route('standard', 'route-diagnostics-summary', { ...base, diagnostics: 'summary' }),
  route('standard', 'route-diagnostics-profile', { ...base, diagnostics: 'profile' }),
  route('standard', 'route-diagnostics-trace', { ...base, diagnostics: 'trace' }),
  route('standard', 'route-limitations', { ...base, includeLimitations: true }),
  route('standard', 'route-string-id', { ...base, id: 'commute-1' }),
  route('standard', 'route-object-id', { ...base, id: { batch: 7, row: 3 } }),
  route('standard', 'error-missing-time', { ...base, time: undefined }),
  route('standard', 'error-diagnostics', { ...base, diagnostics: 'verbose' }),
  route('standard', 'error-unknown-stop', { ...base, origin: stop('NOPE') }),
  route('standard', 'error-alternatives-arrive-by', { ...base, alternatives: 1, timePreference: 'arrive_by' }),
  route('standard', 'error-wheelchair', { ...base, wheelchair: true }),
  matrix('standard', 'matrix-durations', { serviceDate, time: '07:55', origins: [stop('A')], destinations: [stop('B')], maxWalkKm: 0.2, requireTransitRide: true }),
  matrix('standard', 'matrix-journeys', { serviceDate, time: '07:55', origins: [stop('A')], destinations: [stop('B')], maxWalkKm: 0.2, requireTransitRide: true, includeJourneys: true }),
  matrix('standard', 'matrix-journeys-geometry', { serviceDate, time: '07:55', origins: [free.origin], destinations: [free.destination], maxWalkKm: 0.2, includeJourneys: true, includeGeometry: true }),
  matrix('standard', 'matrix-journeys-compact', { serviceDate, time: '07:55', origins: [stop('A')], destinations: [stop('B')], maxWalkKm: 0.2, includeJourneys: true, journeyFormat: 'compact' }),
  matrix('standard', 'matrix-unreachable', { serviceDate, time: '07:55', origins: [stop('A'), stop('B')], destinations: [stop('B'), stop('A'), { coordinate: [-77.0, 39.0] }], maxWalkKm: 0.2, requireTransitRide: true }),
  matrix('standard', 'matrix-ids', { serviceDate, time: '07:55', origins: [{ ...free.origin, id: 'home' }], destinations: [{ ...free.destination, id: 'work' }], maxWalkKm: 0.2 }),
  matrix('standard', 'matrix-arrive-by', { serviceDate, time: '08:30', timePreference: 'arrive_by', origins: [free.origin], destinations: [free.destination], maxWalkKm: 0.2 }),
  matrix('standard', 'matrix-walk', { serviceDate, time: '07:55', mode: 'walk', origins: [free.origin], destinations: [free.destination] }),
  matrix('standard', 'matrix-drive', { serviceDate, time: '07:55', mode: 'drive', origins: [free.origin], destinations: [free.destination] }),
  matrix('standard', 'matrix-summary', { serviceDate, time: '07:55', origins: [stop('A')], destinations: [stop('B')], maxWalkKm: 0.2, diagnostics: 'summary' }),
  reach('standard', 'reach-full', reachBase),
  reach('standard', 'reach-map', { ...reachBase, reachFormat: 'map' }),
  reach('standard', 'reach-street-edges', { ...reachBase, includeStreetEdges: true }),
  reach('standard', 'reach-nodes', { ...reachBase, includeNodes: true }),
  reach('standard', 'reach-walk', { ...reachBase, mode: 'walk' }),
  reach('standard', 'reach-cell-center', { ...reachBase, surfaceSampling: 'cell-center', rasterSize: 16 }),
  reach('standard', 'reach-bounds', { ...reachBase, bounds: [-77.06, 38.89, -77.02, 38.92] }),
  reach('standard', 'reach-scenario-frequency', { ...reachBase, scenario: frequency }),
  reach('standard', 'reach-scenario-preserved', { ...reachBase, scenario: preserved }),
  reach('standard', 'reach-profile', { ...reachBase, diagnostics: 'profile' }),
  reach('standard', 'reach-arrive-by', arriveBase),
  reach('standard', 'reach-arrive-by-street-edges', { ...arriveBase, includeStreetEdges: true }),
  reach('standard', 'reach-arrive-by-walk', { ...arriveBase, mode: 'walk' }),
  reach('standard', 'reach-arrive-by-cell-center', { ...arriveBase, surfaceSampling: 'cell-center', rasterSize: 16 }),
  reach('standard', 'reach-arrive-by-scenario-frequency', { ...arriveBase, scenario: frequency }),
  reach('standard', 'error-reach-arrive-by-origin', { ...arriveBase, origin: free.origin }),
  { city: 'standard', name: 'isochrone', kind: 'isochrone', request: { ...reachBase, cutoffsMinutes: [20] } },
  { city: 'standard', name: 'compare-reach', kind: 'compare',
    request: results => ({ before: results['standard/reach-full'], after: results['standard/reach-scenario-frequency'] }) },
  { city: 'standard', name: 'error-compare-mismatch', kind: 'compare',
    request: results => ({ before: results['standard/reach-full'], after: results['standard/route-stops'] }) },
  route('walk-only', 'route-drive-unprepared', { ...coordinate, mode: 'drive' }),
  route('walk-only', 'route-stops', base),
  route('wheelchair', 'route-stops', { ...base, wheelchair: true }),
  route('wheelchair', 'route-inherited', base),
  route('wheelchair', 'route-walk', { ...base, mode: 'walk', requireTransitRide: false, wheelchair: true, maxWalkKm: 5 }),
  reach('wheelchair', 'reach-full', { ...reachBase, origin: stop('A'), wheelchair: true }),
  route('private-access', 'route-stops', base),
  route('private-access', 'route-private-endpoint', { ...base, origin: { coordinate: [-77.054, 38.9] }, maxWalkKm: 1.2 }),
  route('platform-area', 'route-coordinates', { ...coordinate, origin: { coordinate: [-77.05008, 38.90004] } }),
  route('fares', 'route-stops', base),
  matrix('fares', 'matrix-journeys', { serviceDate, time: '07:55', origins: [stop('A')], destinations: [stop('B')], maxWalkKm: 0.2, requireTransitRide: true, includeJourneys: true }),
  route('display-metadata', 'route-stops', base),
  route('display-metadata', 'route-from-middle', { ...base, origin: stop('M') }),
  route('collection', 'route-default', base, { flags: [] }),
  route('collection', 'route-faster', { ...base, scenarioId: 'faster' }),
  route('collection', 'error-unknown-scenario', { ...base, scenarioId: 'missing' }),
  { city: 'collection', name: 'info', kind: 'info' },
  { city: 'standard', name: 'capabilities', kind: 'capabilities' },
  route('standard', 'error-service-day', { ...base, serviceDate: undefined, serviceDay: 'weekday' }),
  route('standard', 'route-walk-dateless', { time: '07:55', mode: 'walk', ...free }),
  reach('standard', 'reach-walk-dateless', { ...reachBase, serviceDate: undefined, mode: 'walk' }),
  matrix('standard', 'matrix-journeys-unreachable', { serviceDate, time: '07:55', origins: [stop('A'), stop('B')], destinations: [stop('B')], maxWalkKm: 0.2, requireTransitRide: true, includeJourneys: true }),
  route('station-pathway', 'route-from-entrance', { serviceDate, time: '07:55', origin: { coordinate: [-77.0405, 38.90475] }, destination: stop('B'), maxWalkKm: 1.2, maxTransfers: 2, requireTransitRide: true }),
  matrix('station-pathway', 'matrix-journeys', { serviceDate, time: '07:55', origins: [{ coordinate: [-77.0405, 38.90475] }], destinations: [stop('B')], maxWalkKm: 1.2, requireTransitRide: true, includeJourneys: true }),
  route('station-unpriced', 'route-blocked', { serviceDate, time: '07:55', origin: { coordinate: [-77.0405, 38.90475] }, destination: stop('B'), maxWalkKm: 1.2, maxTransfers: 2, requireTransitRide: true, includeLimitations: true }),
  { city: 'station-unpriced', name: 'info', kind: 'info' },
  route('pathway-estimated', 'route-estimated', { origin: stop('O'), destination: stop('B'), serviceDate, time: '07:55', requireTransitRide: true, maxTransfers: 1 }),
  route('pathway-estimated', 'route-estimated-arrive-by', { origin: stop('O'), destination: stop('B'), serviceDate, time: '08:10', timePreference: 'arrive_by', requireTransitRide: true, maxTransfers: 1 }),
  route('scoped', 'route-scoped-stops', { ...base, origin: { stop: { feed: 'one', id: 'A' } }, destination: { stop: { feed: 'two', id: 'B' } } }),
  route('scoped', 'route-scoped-legacy', { ...base, origin: { stopId: 'one\u001fA' }, destination: { stop: { feed: 'one', id: 'B' } } }),
  route('scoped', 'route-coordinates', coordinate),
  matrix('scoped', 'matrix-journeys', { serviceDate, time: '07:55', origins: [{ stop: { feed: 'one', id: 'A' } }], destinations: [{ stop: { feed: 'two', id: 'B' } }], maxWalkKm: 0.2, includeJourneys: true }),
  reach('scoped', 'reach-from-stop', { ...reachBase, origin: { stop: { feed: 'two', id: 'A' } } }),
  { city: 'frozen-050', name: 'info', kind: 'info' },
  route('frozen-050', 'route-transit', { serviceDate: '2026-07-15', time: '08:00', origin: stop('A'), destination: stop('B'), maxWalkKm: 1.2 }),
  route('frozen-050', 'route-arrive-by', { serviceDate: '2026-07-15', time: '08:35', timePreference: 'arrive_by', origin: stop('A'), destination: stop('B'), maxWalkKm: 1.2 }),
  route('frozen-050', 'route-walk', { serviceDate: '2026-07-15', time: '08:00', mode: 'walk', origin: stop('A'), destination: stop('B') }),
  matrix('frozen-050', 'matrix', { serviceDate: '2026-07-15', time: '08:00', origins: [stop('A')], destinations: [stop('B'), stop('X')], maxWalkKm: 1.2 }),
  reach('frozen-050', 'reach', { serviceDate: '2026-07-15', time: '08:00', origin: stop('A'), cutoffsMinutes: [10, 20], rasterSize: 24 }),
].map(entry => entry.request && typeof entry.request === 'object'
  ? { ...entry, request: Object.fromEntries(Object.entries(entry.request).filter(([, value]) => value !== undefined)) }
  : entry)
