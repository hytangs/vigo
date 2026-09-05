import { matrixItineraryReference } from './helpers/matrix-itinerary-reference.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { DatabaseSync } from 'node:sqlite'
import {
  buildNationalGtfsStore,
  prepareNationalGtfsRoutingContext,
  routeNationalGtfsMatrix,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'
import {
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  prepareNationalOsmNativeStore,
} from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { finalizeCurrentStreetFixture } from './helpers/street-fixture.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-state-identity-'))
const zipPath = path.join(folder, 'state-identity.zip')
const storePath = path.join(folder, 'state-identity.sqlite')
const matrixZipPath = path.join(folder, 'matrix-egress.zip')
const matrixStorePath = path.join(folder, 'matrix-egress.sqlite')
const directWalkZipPath = path.join(folder, 'direct-walk-selected-stop.zip')
const directWalkStorePath = path.join(folder, 'direct-walk-selected-stop.sqlite')
const directWalkStreetPath = path.join(folder, 'direct-walk-selected-stop-street.sqlite')
const streetIdentityZipPath = path.join(folder, 'street-state-identity.zip')
const streetIdentityStorePath = path.join(folder, 'street-state-identity.sqlite')
const streetIdentityPath = path.join(folder, 'street-state-identity-street.sqlite')

function prepareRustFixtureStreetStore(storePath) {
  assert.equal(buildNationalOsmWalkStore(storePath, { force: true, persist: true }).ready, true)
  assert.equal(compactNationalOsmRuntimeStore(storePath).storageLayout, 'runtime-snapshots-v1')
  disposeNationalOsmStore(storePath)
  const native = prepareNationalOsmNativeStore(storePath)
  assert.equal(native.ready, true)
  assert(buildNativeStreetCchIndex(storePath).loaded.nodeCount > 0)
}

try {
  const zip = new JSZip()
  zip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'O,Origin,42.0000,-71.0000,0',
    'Y,Transfer approach,42.0100,-71.0100,0',
    'X,Interchange,42.0101,-71.0101,0',
    'D,Destination,42.0200,-71.0200,0',
    'CO,Cache policy origin,41.0000,-70.0000,0',
    'CX,Cache policy interchange,41.0100,-70.0100,0',
    'CD,Cache policy destination,41.0200,-70.0200,0',
    'LO,Transfer-chain origin,40.0000,-69.0000,0',
    'L1,Transfer-chain alighting,40.0100,-69.0100,0',
    'L2,Transfer-chain waypoint,40.0110,-69.0110,0',
    'L3,Transfer-chain boarding,40.0120,-69.0120,0',
    'LD,Transfer-chain destination,40.0200,-69.0200,0',
  ].join('\n'))
  zip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    'DIRECT,DIRECT,Direct arrival with unpaid boarding slack,3',
    'FEED,FEED,Feeder to physical transfer,3',
    'OUT,OUT,Tight outbound connection,3',
    'CF1,CF1,Fast cache-policy feeder,3',
    'CF2,CF2,Fast cache-policy connection,3',
    'CB,CB,Balanced cache-policy direct ride,3',
    'LF,LF,Transfer-chain micro feeder,3',
    'LT,LT,Transfer-chain shortcut,3',
    'LG,LG,Transfer-chain legitimate direct ride,3',
  ].join('\n'))
  zip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'DIRECT,S,direct,0',
    'FEED,S,feed,0',
    'OUT,S,out,0',
    'CF1,S,cache-fast-one,0',
    'CF2,S,cache-fast-two,0',
    'CB,S,cache-balanced,0',
    'LF,S,chain-feeder,0',
    'LT,S,chain-shortcut,0',
    'LG,S,chain-direct,0',
  ].join('\n'))
  zip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'direct,08:05:00,08:05:00,O,1',
    'direct,08:15:00,08:15:00,X,2',
    'feed,08:05:00,08:05:00,O,1',
    'feed,08:13:00,08:13:00,Y,2',
    'out,08:16:00,08:16:00,X,1',
    'out,08:30:00,08:30:00,D,2',
    'cache-fast-one,08:00:00,08:00:00,CO,1',
    'cache-fast-one,08:05:00,08:05:00,CX,2',
    'cache-fast-two,08:08:00,08:08:00,CX,1',
    'cache-fast-two,08:12:00,08:12:00,CD,2',
    'cache-balanced,08:01:00,08:01:00,CO,1',
    'cache-balanced,08:16:00,08:16:00,CD,2',
    'chain-feeder,08:00:00,08:00:00,LO,1',
    'chain-feeder,08:01:00,08:01:00,L1,2',
    'chain-shortcut,08:08:00,08:08:00,L3,1',
    'chain-shortcut,08:15:00,08:15:00,LD,2',
    'chain-direct,08:02:00,08:02:00,LO,1',
    'chain-direct,08:25:00,08:25:00,LD,2',
  ].join('\n'))
  zip.file('transfers.txt', [
    'from_stop_id,to_stop_id,transfer_type,min_transfer_time',
    'Y,X,2,120',
    'L1,L2,2,120',
    'L2,L3,2,120',
  ].join('\n'))
  zip.file('calendar_dates.txt', [
    'service_id,date,exception_type',
    'S,20260716,1',
  ].join('\n'))
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  await buildNationalGtfsStore({ zipPath, outputPath: storePath })

  const request = {
    origin: { coordinate: [-71, 42], label: 'Origin', source: 'stop', stopId: 'O' },
    destination: { coordinate: [-71.02, 42.02], label: 'Destination', source: 'stop', stopId: 'D' },
    departMinutes: 8 * 60,
    serviceDate: '2026-07-16',
    serviceDay: 'thursday',
    maxWalkKm: 0.2,
  }

  prepareNationalGtfsRoutingContext(storePath, request)
  const plan = routeNationalGtfsStore(storePath, request)
  assert.equal(plan.status, 'ready', 'A transfer-complete label must not be dominated by an equal-time label that still owes boarding slack.')
  assert.deepEqual(
    plan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['FEED', 'OUT'],
    'The exact router must retain the history state that can board the tight outbound trip.',
  )
  assert.equal(
    plan.legs.find((leg) => leg.type === 'ride' && leg.routeShortName === 'OUT')?.startMinutes,
    496,
    'The two-minute transfer already consumes the interchange allowance; a second generic slack must not be added.',
  )

  const chainRequest = {
    ...request,
    origin: { coordinate: [-69, 40], label: 'Transfer-chain origin', source: 'stop', stopId: 'LO' },
    destination: { coordinate: [-69.02, 40.02], label: 'Transfer-chain destination', source: 'stop', stopId: 'LD' },
  }
  const chainPlan = routeNationalGtfsStore(storePath, chainRequest)
  assert.equal(chainPlan.status, 'ready')
  assert.deepEqual(
    chainPlan.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['LG'],
    'A one-minute feeder must not unlock a shortcut by chaining transfer edges as pedestrian waypoints.',
  )
  assert.equal(
    chainPlan.legs.filter((leg) => leg.type === 'walk' && leg.walkSource === 'transfer').length,
    0,
    'One boarding may expose at most one direct transfer edge before the next boarding.',
  )
  const preRideTransferChain = routeNationalGtfsStore(storePath, {
    ...chainRequest,
    origin: { coordinate: [-69.01, 40.01], label: 'Transfer-chain alighting', source: 'stop', stopId: 'L1' },
  })
  assert.equal(
    preRideTransferChain.status,
    'blocked',
    'The optional pre-ride transfer episode must also stop after one explicit edge.',
  )

  const preferenceRequest = {
    ...request,
    origin: { coordinate: [-70, 41], label: 'Preference origin', source: 'stop', stopId: 'CO' },
    destination: { coordinate: [-70.02, 41.02], label: 'Preference destination', source: 'stop', stopId: 'CD' },
  }
  const fastest = routeNationalGtfsStore(storePath, {
    ...preferenceRequest,
    routingPreference: 'fastest',
  })
  const balanced = routeNationalGtfsStore(storePath, {
    ...preferenceRequest,
    routingPreference: 'balanced',
  })
  assert.deepEqual(
    fastest.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['CF1', 'CF2'],
    'The preference fixture must expose the earlier two-boarding journey.',
  )
  assert.deepEqual(
    balanced.legs.filter((leg) => leg.type === 'ride').map((leg) => leg.routeShortName),
    ['CB'],
    'A fastest result must never leak into a balanced request with the same endpoints and departure.',
  )
  const balancedReplay = routeNationalGtfsStore(storePath, {
    ...preferenceRequest,
    routingPreference: 'balanced',
  })
  assert.deepEqual(
    balancedReplay.legs,
    balanced.legs,
    'Repeated balanced routing must recompute the same deterministic journey.',
  )
  assert(!Object.hasOwn(balancedReplay.diagnostics.searchStats, 'cacheHit'))

  let staticTopologyPathReads = 0
  const freshRequest = {
    ...request,
    departMinutes: request.departMinutes + 1,
  }
  Object.defineProperty(freshRequest, 'staticTopologyPath', {
    enumerable: true,
    get() {
      staticTopologyPathReads += 1
      return undefined
    },
  })
  const freshPlan = routeNationalGtfsStore(storePath, freshRequest)
  assert.equal(freshPlan.status, 'ready')
  assert.match(freshPlan.diagnostics.algorithm, /^rust_exact_connection_scan/)
  const dataSemantics = freshPlan.diagnostics.dataSemantics
  assert.equal(Object.isFrozen(dataSemantics), true)
  assert.equal(Object.isFrozen(dataSemantics.blockingFeatures), true)
  assert.equal(Object.isFrozen(dataSemantics.limitations), true)
  assert.equal(Object.isFrozen(dataSemantics.routingCoverage), true)
  assert.equal(Object.isFrozen(dataSemantics.routingCoverage.excludedFeatures), true)
  assert.equal(Object.isFrozen(dataSemantics.transferEpisode), true)
  assert.equal(dataSemantics.transferEpisode.maximumExplicitEdgesBeforeBoarding, 1)
  assert.equal(dataSemantics.transferEpisode.maximumGeneratedOsmWalkM, 500)
  assert.throws(
    () => { dataSemantics.routingCoverage.complete = !dataSemantics.routingCoverage.complete },
    TypeError,
    'Shared routing-semantics diagnostics must be immutable across in-process callers.',
  )
  assert.equal(
    staticTopologyPathReads,
    0,
    'Routing must not inspect the analysis-only static-topology path.',
  )

  const planBeforeMutation = routeNationalGtfsStore(storePath, request)
  assert.equal(planBeforeMutation.arriveMinutes, 510)
  const mutatedStore = new DatabaseSync(storePath)
  mutatedStore.prepare(`
    UPDATE connections
    SET departure=departure+300, arrival=arrival+300
    WHERE trip_id='out'
  `).run()
  mutatedStore.close()
  // A changed source identity must refresh the resident timetable image.
  const refreshedPlanAfterMutation = routeNationalGtfsStore(storePath, request)
  assert.equal(
    refreshedPlanAfterMutation.arriveMinutes,
    515,
    'A changed SQLite source must refresh active service state.',
  )
  assert.equal(
    refreshedPlanAfterMutation.legs.find((leg) => leg.type === 'ride' && leg.routeShortName === 'OUT')?.startMinutes,
    501,
    'The route after source invalidation must be materialized from the changed timetable.',
  )

  const matrixZip = new JSZip()
  matrixZip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'MO,Matrix origin,43.0000,-72.0000,0',
    'MA,Matrix alighting stop,43.0100,-72.0100,0',
    'MD,Matrix destination,43.0101,-72.0101,0',
  ].join('\n'))
  matrixZip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    'MR,MR,Only scheduled ride,3',
  ].join('\n'))
  matrixZip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'MR,S,matrix-trip,0',
  ].join('\n'))
  matrixZip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'matrix-trip,08:00:00,08:00:00,MO,1',
    'matrix-trip,08:10:00,08:10:00,MA,2',
  ].join('\n'))
  matrixZip.file('transfers.txt', [
    'from_stop_id,to_stop_id,transfer_type,min_transfer_time',
    'MA,MD,2,60',
  ].join('\n'))
  matrixZip.file('calendar_dates.txt', [
    'service_id,date,exception_type',
    'S,20260716,1',
  ].join('\n'))
  await fs.writeFile(matrixZipPath, await matrixZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  await buildNationalGtfsStore({ zipPath: matrixZipPath, outputPath: matrixStorePath })

  const matrixRequest = {
    origins: [{ coordinate: [-72, 43], label: 'Matrix origin', source: 'stop', stopId: 'MO' }],
    destinations: [{ coordinate: [-72.0101, 43.0101], label: 'Matrix destination', source: 'stop', stopId: 'MD' }],
    departMinutes: 8 * 60,
    serviceDate: '2026-07-16',
    serviceDay: 'thursday',
    maxWalkKm: 0.2,
  }
  const pairwise = matrixItineraryReference(matrixStorePath, matrixRequest)
  const shared = routeNationalGtfsMatrix(matrixStorePath, { ...matrixRequest, matrixStrategy: 'shared' })
  assert.equal(
    pairwise.rows[0]?.status,
    'blocked',
    'A terminal GTFS transfer into a non-service target is not part of the resident destination frontier.',
  )
  assert.deepEqual(
    shared.rows,
    pairwise.rows,
    'Shared matrix routing must preserve the same egress-readiness state as independent canonical queries.',
  )

  const directWalkZip = new JSZip()
  directWalkZip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'WO,Walk origin,44.0000,-73.0000,0',
    'WD,Walk destination,44.0000,-72.9988,0',
  ].join('\n'))
  directWalkZip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    'FAST,FAST,One-minute scheduled ride,3',
  ].join('\n'))
  directWalkZip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'FAST,S,fast-trip,0',
  ].join('\n'))
  directWalkZip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'fast-trip,08:00:00,08:00:00,WO,1',
    'fast-trip,08:01:00,08:01:00,WD,2',
  ].join('\n'))
  directWalkZip.file('calendar_dates.txt', [
    'service_id,date,exception_type',
    'S,20260716,1',
  ].join('\n'))
  await fs.writeFile(directWalkZipPath, await directWalkZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  await buildNationalGtfsStore({ zipPath: directWalkZipPath, outputPath: directWalkStorePath })
  const street = new DatabaseSync(directWalkStreetPath)
  street.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    INSERT INTO metadata VALUES('schemaVersion', '"vigo.street.store.v3"');
    INSERT INTO metadata VALUES('sourceModel', '"pbf"');
    INSERT INTO walk_nodes VALUES(1,44.0000,-73.0000),(2,44.0000,-72.9988);
    INSERT INTO edges VALUES(1,2,100,1),(2,1,100,1);
  `)
  finalizeCurrentStreetFixture(street)
  street.close()
  prepareRustFixtureStreetStore(directWalkStreetPath)
  const selectedStopRequest = {
    origin: { coordinate: [-73, 44], label: 'Walk origin', source: 'stop', stopId: 'WO' },
    destination: { coordinate: [-72.9988, 44], label: 'Walk destination', source: 'stop', stopId: 'WD' },
    serviceDate: '2026-07-16',
    serviceDay: 'thursday',
    maxWalkKm: 0.2,
    streetStorePath: directWalkStreetPath,
  }
  const departAt = routeNationalGtfsStore(directWalkStorePath, {
    ...selectedStopRequest,
    timePreference: 'depart',
    departMinutes: 8 * 60,
  })
  const arriveBy = routeNationalGtfsStore(directWalkStorePath, {
    ...selectedStopRequest,
    timePreference: 'arrive',
    arriveMinutes: 8 * 60 + 1,
    departMinutes: 8 * 60 + 1,
  })
  assert.equal(departAt.travelMode, 'transit', 'An explicit-stop transit ride that arrives sooner must beat any direct-walk alternative.')
  assert.equal(departAt.arriveMinutes, 481)
  assert.equal(arriveBy.travelMode, 'transit', 'Arrive-by must prefer the later feasible explicit-stop transit departure over walking.')
  assert.equal(arriveBy.departMinutes, 480)
  const missingSelectedStop = routeNationalGtfsStore(directWalkStorePath, {
    ...selectedStopRequest,
    origin: { coordinate: [-74, 44], label: 'Missing selected stop', source: 'stop', stopId: 'MISSING' },
    departMinutes: 8 * 60,
  })
  assert.equal(missingSelectedStop.status, 'blocked')
  assert.equal(
    missingSelectedStop.diagnostics?.failureCode,
    'access_unreachable',
    'An unknown explicit stop must remain an unavailable exact-stop endpoint instead of falling through to coordinate routing.',
  )

  const streetIdentityZip = new JSZip()
  streetIdentityZip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'SO,Street origin,42.0000,-70.0000,0',
    'SD,Street destination,42.0000,-70.0100,0',
  ].join('\n'))
  streetIdentityZip.file('routes.txt', [
    'route_id,route_short_name,route_long_name,route_type',
    'STREET,STREET,Street identity route,3',
  ].join('\n'))
  streetIdentityZip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'STREET,S,street-trip,0',
  ].join('\n'))
  streetIdentityZip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'street-trip,08:05:00,08:05:00,SO,1',
    'street-trip,08:15:00,08:15:00,SD,2',
  ].join('\n'))
  streetIdentityZip.file('calendar_dates.txt', [
    'service_id,date,exception_type',
    'S,20260716,1',
  ].join('\n'))
  await fs.writeFile(streetIdentityZipPath, await streetIdentityZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  await buildNationalGtfsStore({ zipPath: streetIdentityZipPath, outputPath: streetIdentityStorePath })

  const buildStreetIdentityFixture = (filePath) => {
    const db = new DatabaseSync(filePath)
    db.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
      CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
      CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
      CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
      CREATE INDEX edges_from ON edges(from_node);
      CREATE INDEX edges_to ON edges(to_node);
    `)
    const insertMetadata = db.prepare('INSERT INTO metadata VALUES(?,?)')
    insertMetadata.run('schemaVersion', JSON.stringify('vigo.street.store.v3'))
    insertMetadata.run('sourceModel', JSON.stringify('pbf'))
    insertMetadata.run('sourceFingerprint', JSON.stringify('a'.repeat(64)))
    insertMetadata.run('nodeCount', JSON.stringify(4))
    insertMetadata.run('edgeCount', JSON.stringify(4))
    db.exec(`
      INSERT INTO walk_nodes VALUES
        (1,42.0000,-70.0022),
        (2,42.0000,-70.0000),
        (3,42.0000,-70.0100),
        (4,42.0000,-70.0078);
      INSERT INTO edges VALUES
        (1,2,182,1),(2,1,182,1),
        (3,4,182,2),(4,3,182,2);
    `)
    finalizeCurrentStreetFixture(db)
    db.close()
  }
  buildStreetIdentityFixture(streetIdentityPath)
  prepareRustFixtureStreetStore(streetIdentityPath)

  const streetIdentityRequest = {
    origin: { coordinate: [-70.0022, 42], label: 'Map origin', source: 'map' },
    destination: { coordinate: [-70.0078, 42], label: 'Map destination', source: 'map' },
    departMinutes: 8 * 60,
    serviceDate: '2026-07-16',
    serviceDay: 'thursday',
    maxWalkKm: 0.25,
    streetStorePath: streetIdentityPath,
    __disableDirectWalkDominance: true,
  }
  const streetPlanBeforeMutation = routeNationalGtfsStore(streetIdentityStorePath, streetIdentityRequest)
  const shiftedStreetPlanBeforeMutation = routeNationalGtfsStore(streetIdentityStorePath, {
    ...streetIdentityRequest,
    departMinutes: streetIdentityRequest.departMinutes + 1,
  })
  assert.equal(streetPlanBeforeMutation.status, 'ready')
  assert.equal(shiftedStreetPlanBeforeMutation.status, 'ready')
  const repeatedStreetPlan = routeNationalGtfsStore(streetIdentityStorePath, streetIdentityRequest)
  assert.equal(repeatedStreetPlan.status, 'ready')
  assert(!Object.hasOwn(repeatedStreetPlan.diagnostics.searchStats, 'cacheHit'))

  const mutatedStreetStore = new DatabaseSync(streetIdentityPath)
  mutatedStreetStore.prepare('UPDATE metadata SET value=? WHERE key=?')
    .run(JSON.stringify('mutated-after-seal'), 'sourceFingerprint')
  mutatedStreetStore.close()

  const shiftedStreetPlanAfterMutation = routeNationalGtfsStore(streetIdentityStorePath, {
    ...streetIdentityRequest,
    departMinutes: streetIdentityRequest.departMinutes + 1,
  })
  assert.equal(
    shiftedStreetPlanAfterMutation.status,
    'ready',
    'SQLite mutation alone must not become a pedestrian execution path while the admitted Rust snapshot is unchanged.',
  )
  const streetPlanAfterMutation = routeNationalGtfsStore(streetIdentityStorePath, streetIdentityRequest)
  assert.equal(
    streetPlanAfterMutation.status,
    'ready',
    'A fresh route must continue to use the immutable Rust snapshot rather than a SQLite routing fallback.',
  )

  console.log('National routing state-identity check passed.')
} finally {
  await fs.rm(folder, { recursive: true, force: true })
}
