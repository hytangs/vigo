import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

import {
  buildNationalOsmDriveStore,
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  nationalOsmDriveDirections,
  nationalOsmDrivingSpeedKph,
  prepareNationalOsmDriveStore,
  prepareNationalOsmNativeStore,
  readNationalOsmWalkNodeCoordinate,
  sampleNationalOsmWalkNodes,
  routeNationalStreetMatrix,
  routeNationalStreetStore,
} from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'

const worker = process.argv[2] === '--fixture-worker'
const root = worker ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-street-routing-'))
// Native street maps must be released before Windows can remove the fixture.
if (!worker) {
  try {
    execFileSync(process.execPath, [import.meta.filename, '--fixture-worker', root], { stdio: 'inherit' })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function writeMetadata(database, values) {
  const insert = database.prepare('INSERT INTO metadata VALUES(?,?)')
  for (const [key, value] of Object.entries(values)) insert.run(key, JSON.stringify(value))
}

function createCurrentStore() {
  const storePath = path.join(root, 'street-v3.sqlite')
  const database = new DatabaseSync(storePath)
  database.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE drive_edges(
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      travel_time_s REAL NOT NULL,
      way_id INTEGER NOT NULL,
      road_class INTEGER NOT NULL
    );
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    INSERT INTO metadata VALUES
      ('schemaVersion', '"vigo.street.store.v4"'),
      ('sourceModel', '"pbf"'),
      ('storageLayout', '"walk-drive-role-tables-v2"'),
      ('driveNodeStorage', '"walk-shared-plus-drive-only-v1"'),
      ('driveIndexState', '"ready"'),
      ('sourceFingerprint', '"fixture-v3"'),
      ('nodeCount', '11'),
      ('edgeCount', '6'),
      ('driveNodeCount', '11'),
      ('driveEdgeCount', '6'),
      ('drivingWeightModel', '"osm-maxspeed-or-highway-default-free-flow-seconds-v1"');
    INSERT INTO walk_nodes VALUES
      (1, 42.0000, -71.0000),
      (2, 42.0000, -70.9988),
      (3, 42.0000, -70.9976),
      (30, 42.0020, -71.0100),
      (31, 42.0020, -71.0090);
    INSERT INTO edges VALUES
      (1,2,100,100),(2,1,100,100),
      (2,3,100,101),(3,2,100,101),
      (30,31,82,102),(31,30,82,102);
    INSERT INTO drive_nodes VALUES
      (10,42.0010,-71.0000),(11,42.0010,-70.9988),(12,42.0010,-70.9976),
      (13,42.0018,-70.9988),
      (20,42.0030,-71.0100),(21,42.0030,-71.0090);
    INSERT INTO drive_edges VALUES
      (10,11,100,6,200,1),
      (10,13,125,8,203,1),
      (11,12,100,6,201,1),
      (13,12,125,8,204,1),
      (20,21,82,5,202,2),
      (21,20,82,5,202,2);
  `)
  database.close()
  return storePath
}

if (worker) {
  assert.deepEqual(
    nationalOsmDriveDirections({ highway: 'residential', oneway: '-1' }),
    { forward: false, backward: true },
  )
  assert.deepEqual(
    nationalOsmDriveDirections({ highway: 'primary', junction: 'roundabout' }),
    { forward: true, backward: false },
  )
  assert.equal(
    Number(nationalOsmDrivingSpeedKph({ highway: 'residential', maxspeed: '30 mph' }).toFixed(3)),
    48.28,
  )
  assert.equal(nationalOsmDrivingSpeedKph({ highway: 'motorway' }), 100)

  const currentStore = createCurrentStore()
  const walkRequest = {
    mode: 'walk',
    origin: { coordinate: [-71.0000, 42.0000], label: 'Walk A', source: 'map' },
    destination: { coordinate: [-70.9976, 42.0000], label: 'Walk B', source: 'map' },
    departMinutes: 480,
    walkingSpeedKph: 4.8,
    maxStreetKm: 2,
  }
  const driveRequest = {
    mode: 'drive',
    origin: { coordinate: [-71.0000, 42.0010], label: 'Drive A', source: 'map' },
    destination: { coordinate: [-70.9976, 42.0010], label: 'Drive B', source: 'map' },
    departMinutes: 480,
    maxStreetKm: 20,
  }
  const preparedWalk = buildNationalOsmWalkStore(currentStore, {
    force: true,
    persist: true,
  })
  assert.equal(preparedWalk.ready, true)
  assert.equal(preparedWalk.accelerated, true)
  assert.equal(preparedWalk.snapshotStatus, 'written')
  const preparedDrive = buildNationalOsmDriveStore(currentStore, { force: true, persist: true })
  assert.equal(preparedDrive.ready, true)
  assert.equal(preparedDrive.accelerated, true)
  assert.equal(preparedDrive.nodeCount, 11)
  assert.equal(preparedDrive.edgeCount, 6)
  assert.equal(preparedDrive.snapshotStatus, 'written')
  assert.equal(preparedDrive.nativeCch.cchSource, 'built_mmap')
  assert(fs.existsSync(preparedDrive.snapshotPath))
  const fullStoreSample = sampleNationalOsmWalkNodes(currentStore, {
    endpointCount: 2,
    seed: 41,
  })
  assert.equal(fullStoreSample.sourceTable, 'walk_nodes')
  assert.equal(fullStoreSample.endpoints.length, 2)
  assert(fullStoreSample.endpoints.every((endpoint) => endpoint.osmNodeId !== undefined))
  assert.deepEqual(
    readNationalOsmWalkNodeCoordinate(currentStore, fullStoreSample.endpoints[0]),
    {
      lon: fullStoreSample.endpoints[0].lon,
      lat: fullStoreSample.endpoints[0].lat,
    },
  )
  const compacted = compactNationalOsmRuntimeStore(currentStore, { requireDrive: true })
  assert.equal(compacted.storageLayout, 'runtime-snapshots-v1')
  assert(compacted.afterBytes < compacted.beforeBytes)
  disposeNationalOsmStore(currentStore)
  const reloadedWalk = prepareNationalOsmNativeStore(currentStore)
  const reloadedDrive = prepareNationalOsmDriveStore(currentStore)
  assert.equal(reloadedWalk.source, 'rust_mmap_node_api')
  assert.equal(reloadedDrive.source, 'snapshot')
  assert.equal(reloadedDrive.nativeCch.cchSource, 'in_memory')
  const streetCch = buildNativeStreetCchIndex(currentStore)
  assert(streetCch.loaded.nodeCount > 0)

  const walk = routeNationalStreetStore(currentStore, walkRequest)
  assert.equal(walk.status, 'ready')
  assert.equal(walk.travelMode, 'walk')
  assert.equal(walk.legs.length, 1)
  assert.equal(walk.legs[0].type, 'walk')
  assert.equal(Number(walk.legs[0].distanceKm.toFixed(3)), 0.2)
  assert.equal(Number(walk.durationMinutes.toFixed(3)), 2.5)
  assert(!Object.hasOwn(walk.diagnostics.searchStats, 'cacheHit'))
  assert.equal(walk.diagnostics.searchStats.accelerated, true)

  const repeatedWalk = routeNationalStreetStore(currentStore, walkRequest)
  assert(!Object.hasOwn(repeatedWalk.diagnostics.searchStats, 'cacheHit'))
  assert.deepEqual(repeatedWalk.legs, walk.legs)

  const drive = routeNationalStreetStore(currentStore, driveRequest)
  assert.equal(drive.status, 'ready')
  assert.equal(drive.travelMode, 'drive')
  assert.equal(drive.legs.length, 1)
  assert.equal(drive.legs[0].type, 'drive')
  assert.equal(Number(drive.durationMinutes.toFixed(3)), 0.2)
  assert.equal(drive.diagnostics.algorithm, 'rust_cch_drive_certified')
  assert.equal(drive.diagnostics.weightModel, 'free_flow_seconds')
  assert.equal(drive.diagnostics.searchStats.accelerated, true)
  assert.equal(drive.diagnostics.searchStats.cchAccelerated, true)
  assert.equal(drive.diagnostics.searchStats.cchSource, 'in_memory')

  for (const [request, departurePlan] of [[walkRequest, walk], [driveRequest, drive]]) {
    for (const deadline of [510, 0, -5]) {
      const arrivalPlan = routeNationalStreetStore(currentStore, {
        ...request, timePreference: 'arrive', arriveMinutes: deadline,
      })
      assert.equal(arrivalPlan.status, 'ready')
      assert.equal(arrivalPlan.timePreference, 'arrive')
      assert.equal(arrivalPlan.arriveMinutes, deadline)
      assert.equal(arrivalPlan.departMinutes, deadline - departurePlan.durationMinutes)
      assert.equal(arrivalPlan.legs[0].startMinutes, arrivalPlan.departMinutes)
      assert.equal(arrivalPlan.legs[0].endMinutes, deadline)
      assert.deepEqual(arrivalPlan.legs[0].coordinates, departurePlan.legs[0].coordinates,
        'Arrive-by must retain the same directed path, including one-way roads.')
    }
  }

  // The shared snapshot also contains walk-only vertices. A map click on one
  // must snap to a nearby road instead of becoming an isolated driving node.
  const driveFromWalkNode = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    origin: walkRequest.origin,
  })
  assert.equal(driveFromWalkNode.status, 'ready', 'Walk-only vertices must not capture driving snaps.')
  assert(driveFromWalkNode.diagnostics.originSnapDistanceM > 100)
  const driveToWalkNode = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    destination: walkRequest.destination,
  })
  assert.equal(driveToWalkNode.status, 'ready', 'Driving destinations must snap to road vertices.')
  assert(driveToWalkNode.diagnostics.destinationSnapDistanceM > 100)

  const acceleratedDrive = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    departMinutes: 481,
  })
  assert.equal(acceleratedDrive.status, 'ready')
  assert.equal(acceleratedDrive.diagnostics.searchStats.accelerated, true)
  assert.equal(acceleratedDrive.diagnostics.searchStats.acceleratorSource, 'snapshot')
  assert.equal(acceleratedDrive.legs[0].distanceKm, drive.legs[0].distanceKm)
  assert.equal(acceleratedDrive.durationMinutes, drive.durationMinutes)
  assert.deepEqual(acceleratedDrive.legs[0].coordinates, drive.legs[0].coordinates)

  const trafficSnapshot = {
    source: 'fixture-traffic',
    observedAt: new Date().toISOString(),
    ttlSeconds: 300,
    observations: [{
      fromCoordinate: [-71.0000, 42.0010],
      toCoordinate: [-70.9988, 42.0010],
      delayFactor: 10,
    }],
  }
  const trafficDrive = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    departMinutes: 482,
    trafficSnapshot,
  })
  assert.equal(trafficDrive.status, 'ready')
  assert.equal(Number(trafficDrive.legs[0].distanceKm.toFixed(3)), 0.25)
  assert.equal(Number(trafficDrive.durationMinutes.toFixed(3)), 0.267)
  assert.equal(trafficDrive.diagnostics.weightModel, 'snapshot_customized_traffic_seconds')
  assert.equal(trafficDrive.diagnostics.traffic.status, 'applied')
  assert.equal(trafficDrive.diagnostics.traffic.matchedEdges, 1)
  assert.equal(trafficDrive.diagnostics.searchStats.trafficApplied, true)
  assert.equal(trafficDrive.diagnostics.searchStats.trafficMetricReused, false)

  const reusedTrafficMetric = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    origin: { coordinate: [-70.9988, 42.0018], label: 'Alternate middle', source: 'map' },
    departMinutes: 483,
    trafficSnapshot,
  })
  assert.equal(reusedTrafficMetric.status, 'ready')
  assert.equal(reusedTrafficMetric.diagnostics.searchStats.trafficApplied, true)
  assert.equal(reusedTrafficMetric.diagnostics.searchStats.trafficMetricReused, true)

  const staleTrafficDrive = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    departMinutes: 484,
    trafficSnapshot: {
      ...trafficSnapshot,
      observedAt: new Date(Date.now() - 120_000).toISOString(),
      ttlSeconds: 30,
    },
  })
  assert.equal(Number(staleTrafficDrive.durationMinutes.toFixed(3)), 0.2)
  assert.equal(staleTrafficDrive.diagnostics.weightModel, 'free_flow_seconds')
  assert.equal(staleTrafficDrive.diagnostics.traffic.status, 'stale_fallback')
  assert(staleTrafficDrive.diagnostics.limitations.includes('no_live_traffic'))

  const closedTrafficDrive = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    departMinutes: 485,
    trafficSnapshot: {
      ...trafficSnapshot,
      observations: [{
        fromCoordinate: [-71.0000, 42.0010],
        toCoordinate: [-70.9988, 42.0010],
        closed: true,
      }],
    },
  })
  assert.equal(Number(closedTrafficDrive.durationMinutes.toFixed(3)), 0.267)
  assert.equal(closedTrafficDrive.diagnostics.traffic.closedEdges, 1)
  const allClosedTrafficDrive = routeNationalStreetStore(currentStore, {
    ...driveRequest,
    departMinutes: 486,
    trafficSnapshot: {
      ...trafficSnapshot,
      observations: [
        {
          fromCoordinate: [-71.0000, 42.0010],
          toCoordinate: [-70.9988, 42.0010],
          closed: true,
        },
        {
          fromCoordinate: [-71.0000, 42.0010],
          toCoordinate: [-70.9988, 42.0018],
          closed: true,
        },
      ],
    },
  })
  assert.equal(allClosedTrafficDrive.status, 'blocked')
  assert.equal(allClosedTrafficDrive.diagnostics.traffic.closedEdges, 2)
  assert.throws(
    () => routeNationalStreetStore(currentStore, {
      ...driveRequest,
      departMinutes: 487,
      trafficSnapshot: {
        ...trafficSnapshot,
        observations: [{ edgeIndex: 0, delayFactor: 2, speedKph: 10 }],
      },
    }),
    /must declare exactly one/,
  )
  assert.throws(
    () => routeNationalStreetStore(currentStore, {
      ...driveRequest,
      departMinutes: 488,
      trafficSnapshot: {
        ...trafficSnapshot,
        observations: [{ edgeIndex: 0, delayFactor: 2 }],
      },
    }),
    /streetSourceFingerprint/,
  )

  const recoveredDrive = routeNationalStreetStore(currentStore, {
    mode: 'drive',
    origin: { coordinate: [-71.0105, 42.0030], label: 'Off-network A', source: 'map' },
    destination: { coordinate: [-70.9976, 42.0010], label: 'Drive B', source: 'map' },
    departMinutes: 482,
    maxStreetKm: 20,
  })
  assert.equal(recoveredDrive.status, 'ready')
  assert.equal(recoveredDrive.diagnostics.snapRecovery, true)
  assert(
    recoveredDrive.diagnostics.originSnapDistanceM > 500,
    'The recovery must disclose the full connector from the off-network click to the reachable driving graph.',
  )
  assert.equal(recoveredDrive.diagnostics.destinationSnapDistanceM, 0)

  const reverseDrive = routeNationalStreetStore(currentStore, {
    mode: 'drive',
    origin: { coordinate: [-70.9976, 42.0010], label: 'Drive B', source: 'map' },
    destination: { coordinate: [-71.0000, 42.0010], label: 'Drive A', source: 'map' },
    departMinutes: 480,
    maxStreetKm: 20,
  })
  assert.equal(reverseDrive.status, 'blocked')
  assert.equal(reverseDrive.diagnostics.failureCode, 'no_path')

  const walkMatrix = routeNationalStreetMatrix(currentStore, {
    mode: 'walk',
    origins: [
      walkRequest.origin,
      walkRequest.origin,
      { coordinate: [-70.9988, 42.0000], label: 'Walk middle' },
    ],
    destinations: [walkRequest.destination, walkRequest.origin],
    walkingSpeedKph: 4.8,
    maxStreetKm: 2,
  })
  assert.equal(walkMatrix.schemaVersion, 'vigo.routing.street-matrix.v1')
  assert.equal(walkMatrix.mode, 'walk')
  assert.equal(walkMatrix.rows.length, 6)
  assert.equal(walkMatrix.diagnostics.uniqueOrigins, 2)
  assert.equal(walkMatrix.diagnostics.uniqueDestinations, 2)
  assert.equal(walkMatrix.diagnostics.matrixEngine, 'rust_cch_coordinate_distance_matrix_v1')
  const walkForward = walkMatrix.rows.find((row) => row.originIndex === 0 && row.destinationIndex === 0)
  const walkMiddleToEnd = walkMatrix.rows.find((row) => row.originIndex === 2 && row.destinationIndex === 0)
  assert.equal(walkForward.status, 'ready')
  assert.equal(Number(walkForward.distanceKm.toFixed(3)), 0.2)
  assert.equal(Number(walkMiddleToEnd.distanceKm.toFixed(3)), 0.1)

  const manyWalkDestinations = Array.from({ length: 1024 }, (_, i) => ({
    coordinate: [-71 + 0.0024 * (i + 1) / 1024, 42], label: `Destination ${i}`,
  }))
  const manyWalkRequest = { mode: 'walk', origins: [walkRequest.origin],
    destinations: manyWalkDestinations, maxStreetKm: 2 }
  const manyWalk = routeNationalStreetMatrix(currentStore, manyWalkRequest)
  assert.equal(manyWalk.diagnostics.uniqueDestinations, 1024)
  for (let offset = 0; offset < manyWalkDestinations.length; offset += 256) {
    const chunk = routeNationalStreetMatrix(currentStore, {
      ...manyWalkRequest, destinations: manyWalkDestinations.slice(offset, offset + 256),
    })
    assert.deepEqual(manyWalk.rows.slice(offset, offset + 256), chunk.rows.map((row) => ({
      ...row, destinationIndex: row.destinationIndex + offset,
    })))
  }

  const driveMatrix = routeNationalStreetMatrix(currentStore, {
    mode: 'drive',
    origins: [driveRequest.origin, driveRequest.destination],
    destinations: [driveRequest.destination, driveRequest.origin],
    maxStreetKm: 20,
  })
  assert.equal(driveMatrix.schemaVersion, 'vigo.routing.street-matrix.v1')
  assert.equal(driveMatrix.mode, 'drive')
  assert.equal(driveMatrix.rows.length, 4)
  assert.equal(driveMatrix.diagnostics.matrixEngine, 'rust_cch_drive_time_matrix_v1')
  const driveForward = driveMatrix.rows.find((row) => row.originIndex === 0 && row.destinationIndex === 0)
  const driveReverse = driveMatrix.rows.find((row) => row.originIndex === 1 && row.destinationIndex === 1)
  assert.equal(driveForward.status, 'ready')
  assert.equal(Number(driveForward.distanceKm.toFixed(3)), 0.2)
  assert.equal(Number(driveForward.durationMinutes.toFixed(3)), 0.2)
  assert.equal(driveReverse.status, 'blocked')

  const driveMatrixFromWalkNodes = routeNationalStreetMatrix(currentStore, {
    mode: 'drive',
    origins: [walkRequest.origin],
    destinations: [walkRequest.destination],
    maxStreetKm: 20,
  })
  assert.equal(driveMatrixFromWalkNodes.rows[0].status, 'ready')

  const trafficDriveMatrix = routeNationalStreetMatrix(currentStore, {
    mode: 'drive',
    origins: [driveRequest.origin],
    destinations: [driveRequest.destination],
    maxStreetKm: 20,
    trafficSnapshot,
  })
  assert.equal(Number(trafficDriveMatrix.rows[0].distanceKm.toFixed(3)), 0.25)
  assert.equal(Number(trafficDriveMatrix.rows[0].durationMinutes.toFixed(3)), 0.267)
  assert.equal(trafficDriveMatrix.diagnostics.weightModel, 'snapshot_customized_traffic_seconds')
  assert.equal(trafficDriveMatrix.diagnostics.traffic.status, 'applied')

  const nativeWalk = prepareNationalOsmNativeStore(currentStore)
  assert.equal(nativeWalk.ready, true)
  const nativeGeometryWalk = routeNationalStreetStore(currentStore, {
    ...walkRequest,
    departMinutes: 483,
  })
  assert.equal(nativeGeometryWalk.status, 'ready')
  assert(
    nativeGeometryWalk.legs[0].coordinates.length > 2,
    'A native walk must preserve reconstructed street geometry instead of collapsing to the two clicked endpoints.',
  )
  assert.deepEqual(
    nativeGeometryWalk.legs[0].coordinates[0],
    walkRequest.origin.coordinate,
    'A native walk polyline must begin at the requested origin.',
  )
  assert.deepEqual(
    nativeGeometryWalk.legs[0].coordinates.at(-1),
    walkRequest.destination.coordinate,
    'A native walk polyline must end at the requested destination.',
  )
  assert.notDeepEqual(
    nativeGeometryWalk.legs[0].coordinates[1],
    walkRequest.destination.coordinate,
    'A native walk must not jump to the destination and traverse the graph backward.',
  )
  assert.notDeepEqual(
    nativeGeometryWalk.legs[0].coordinates.at(-2),
    walkRequest.origin.coordinate,
    'A native walk must make forward progress before reaching the destination.',
  )
  assert.equal(
    nativeGeometryWalk.diagnostics.searchStats.acceleratorSource,
    'rust_mmap_node_api',
  )

  const transitPreparationWorker = new Worker(new URL('../src/server/national-route-worker.mjs', import.meta.url))
  const transitPreparation = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Transit street preparation timed out.')), 5_000)
    transitPreparationWorker.once('error', reject)
    transitPreparationWorker.on('message', (message) => {
      if (message?.id !== 'transit-street-preparation-fixture') return
      clearTimeout(timeout)
      if (message.type === 'failed') reject(new Error(message.error))
      else if (message.type === 'complete') resolve(message)
    })
    transitPreparationWorker.postMessage({
      id: 'transit-street-preparation-fixture',
      operation: 'prepare-street',
      storePath: currentStore,
      request: {
        mode: 'transit',
        streetStorePath: currentStore,
      },
    })
  }).finally(() => transitPreparationWorker.terminate())
  assert.equal(transitPreparation.result.streetStore.ready, true)
  assert.equal(transitPreparation.result.streetStore.drive.ready, true)
  assert.equal(
    transitPreparation.result.streetStore.drive.deferred,
    true,
    'Transit preparation must not configure the unrelated Drive kernel.',
  )
  assert.equal(transitPreparation.result.streetStore.drive.prepareMs, 0)

  const worker = new Worker(new URL('../src/server/national-route-worker.mjs', import.meta.url))
  const workerResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Street-route worker timed out.')), 5_000)
    worker.once('error', reject)
    worker.on('message', (message) => {
      if (message?.id !== 'street-route-fixture') return
      clearTimeout(timeout)
      if (message.type === 'failed') reject(new Error(message.error))
      else if (message.type === 'complete') resolve(message)
    })
    worker.postMessage({
      id: 'street-route-fixture',
      operation: 'street-route',
      storePath: currentStore,
      request: {
        ...driveRequest,
        departMinutes: 485,
        streetStorePath: currentStore,
        trafficSnapshot,
      },
    })
  }).finally(() => worker.terminate())
  assert.equal(workerResult.result.status, 'ready')
  assert.equal(workerResult.result.travelMode, 'drive')
  assert.equal(workerResult.result.diagnostics.traffic.status, 'applied')
  assert.equal(Number(workerResult.result.durationMinutes.toFixed(3)), 0.267)
  assert.equal(workerResult.metrics.operation, 'street-route')
  assert(
    workerResult.metrics.operationMs < 250,
    `The resident street-route fixture exceeded its 250 ms responsiveness guard (${workerResult.metrics.operationMs} ms).`,
  )

  const matrixWorker = new Worker(new URL('../src/server/national-route-worker.mjs', import.meta.url))
  const matrixWorkerResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Street matrix worker timed out.')), 5_000)
    matrixWorker.once('error', reject)
    matrixWorker.on('message', (message) => {
      if (message?.id !== 'street-matrix-fixture') return
      clearTimeout(timeout)
      if (message.type === 'failed') reject(new Error(message.error))
      else if (message.type === 'complete') resolve(message)
    })
    matrixWorker.postMessage({
      id: 'street-matrix-fixture',
      operation: 'street-matrix',
      storePath: currentStore,
      request: {
        streetStorePath: currentStore,
        mode: 'drive',
        origins: [driveRequest.origin, driveRequest.destination],
        destinations: [driveRequest.destination, driveRequest.origin],
        maxStreetKm: 20,
      },
    })
  }).finally(() => matrixWorker.terminate())
  assert.equal(matrixWorkerResult.result.schemaVersion, 'vigo.routing.street-matrix.v1')
  assert.equal(matrixWorkerResult.result.rows.length, 4)
  assert.equal(matrixWorkerResult.metrics.operation, 'street-matrix')

  const batchWorker = new Worker(new URL('../src/server/national-route-worker.mjs', import.meta.url))
  const batchResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Street-route batch worker timed out.')), 5_000)
    batchWorker.once('error', reject)
    batchWorker.on('message', (message) => {
      if (message?.id !== 'street-route-batch-fixture') return
      clearTimeout(timeout)
      if (message.type === 'failed') reject(new Error(message.error))
      else if (message.type === 'complete') resolve(message)
    })
    batchWorker.postMessage({
      id: 'street-route-batch-fixture',
      operation: 'street-route-batch',
      storePath: currentStore,
      request: {
        streetStorePath: currentStore,
        mode: 'drive',
        maxStreetKm: 20,
        points: [
          driveRequest.origin,
          { coordinate: [-70.9988, 42.0010], label: 'Drive middle', source: 'map' },
          driveRequest.destination,
        ],
        fallbackGeometry: [
          driveRequest.origin.coordinate,
          [-70.9988, 42.0010],
          driveRequest.destination.coordinate,
        ],
        fallbackSegmentRuntimeMinutes: [4, 4],
        publishedShapeSegmentIndexes: [0],
      },
    })
  }).finally(() => batchWorker.terminate())
  assert.equal(batchResult.result.status, 'ready')
  assert.equal(batchResult.result.segments.length, 2)
  assert.equal(batchResult.result.snappedCoordinates.length, 3)
  assert(batchResult.result.segments.every((segment) => segment.coordinates.length >= 2))
  assert.equal(batchResult.result.segments[0].source, 'published_shape')
  assert.equal(batchResult.result.segments[1].source, 'osm_drive')
  assert.equal(batchResult.result.publishedShapeSegmentCount, 1)
  assert.equal(batchResult.result.osmSegmentCount, 1)
  assert.equal(batchResult.metrics.operation, 'street-route-batch')

  for (const [id, points, expectedStatus] of [
    ['new-line-walk-nodes', [walkRequest.origin, walkRequest.destination], 'ready'],
    ['new-line-one-way', [driveRequest.destination, driveRequest.origin], 'blocked'],
  ]) {
    const newLineWorker = new Worker(new URL('../src/server/national-route-worker.mjs', import.meta.url))
    const { result: newLine } = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('New-line road inference timed out.')), 5_000)
      newLineWorker.once('error', reject)
      newLineWorker.on('message', (message) => {
        if (message?.id !== id) return
        clearTimeout(timeout)
        if (message.type === 'failed') reject(new Error(message.error))
        else if (message.type === 'complete') resolve(message)
      })
      newLineWorker.postMessage({
        id,
        operation: 'street-route-batch',
        storePath: currentStore,
        request: { streetStorePath: currentStore, maxStreetKm: 100, points },
      })
    }).finally(() => newLineWorker.terminate())
    assert.equal(newLine.status, expectedStatus)
    if (expectedStatus === 'ready') {
      assert.equal(newLine.osmSegmentCount, 1)
      assert.equal(newLine.fallbackSegmentCount ?? 0, 0)
      assert.deepEqual(newLine.snappedCoordinates, [driveRequest.origin.coordinate, driveRequest.destination.coordinate])
      assert(newLine.snapDistancesM.every((distance) => distance > 100))
    } else {
      assert.equal(newLine.failedIndex, 0)
      assert.equal(newLine.segments.length, 0)
      assert.match(newLine.detail, /Stops 1 → 2:/)
      assert.match(newLine.detail, /connected roads/)
    }
  }

  const fallbackWorker = new Worker(new URL('../src/server/national-route-worker.mjs', import.meta.url))
  const fallbackResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Street-route shape fallback worker timed out.')), 5_000)
    fallbackWorker.once('error', reject)
    fallbackWorker.on('message', (message) => {
      if (message?.id !== 'street-route-shape-fallback-fixture') return
      clearTimeout(timeout)
      if (message.type === 'failed') reject(new Error(message.error))
      else if (message.type === 'complete') resolve(message)
    })
    fallbackWorker.postMessage({
      id: 'street-route-shape-fallback-fixture',
      operation: 'street-route-batch',
      storePath: currentStore,
      request: {
        streetStorePath: currentStore,
        mode: 'drive',
        maxStreetKm: 20,
        points: [
          { coordinate: [-71.0000, 42.0010], label: 'Disconnected origin', source: 'map' },
          { coordinate: [-71.0100, 42.0030], label: 'Disconnected destination', source: 'map' },
        ],
        fallbackGeometry: [
          [-71.0000, 42.0010],
          [-71.0050, 42.0020],
          [-71.0100, 42.0030],
        ],
        fallbackSegmentRuntimeMinutes: [4],
      },
    })
  }).finally(() => fallbackWorker.terminate())
  assert.equal(fallbackResult.result.status, 'ready')
  assert.equal(fallbackResult.result.fallbackUsed, true)
  assert.equal(fallbackResult.result.fallbackSegmentCount, 1)
  assert.equal(fallbackResult.result.segments[0].source, 'published_shape_fallback')
  assert.equal(fallbackResult.result.segments[0].durationMinutes, 4)

  disposeNationalOsmStore(currentStore)
  const runtimeStoreSample = sampleNationalOsmWalkNodes(currentStore, {
    endpointCount: 2,
    seed: 41,
  })
  assert.equal(runtimeStoreSample.sourceTable, 'street-accelerator-v7')
  assert.equal(runtimeStoreSample.endpoints.length, 2)
  assert(runtimeStoreSample.endpoints.every((endpoint) => Number.isInteger(endpoint.nodeIndex)))
  assert.deepEqual(
    readNationalOsmWalkNodeCoordinate(currentStore, runtimeStoreSample.endpoints[0]),
    {
      lon: runtimeStoreSample.endpoints[0].lon,
      lat: runtimeStoreSample.endpoints[0].lat,
    },
  )
  const runtimeWalk = prepareNationalOsmNativeStore(currentStore)
  assert.equal(runtimeWalk.ready, true)
  const runtimeDrive = prepareNationalOsmDriveStore(currentStore)
  assert.equal(runtimeDrive.ready, true)
  assert.equal(runtimeDrive.nativeCch.cchSource, 'in_memory')
  const runtimeDriveRoute = routeNationalStreetStore(currentStore, driveRequest)
  assert.equal(runtimeDriveRoute.status, 'ready')
  assert.equal(runtimeDriveRoute.diagnostics.searchStats.cchAccelerated, true)

  console.log(JSON.stringify({
    status: 'passed',
    walk: {
      distanceKm: walk.legs[0].distanceKm,
      durationMinutes: walk.durationMinutes,
      firstQueryMs: walk.diagnostics.searchStats.queryMs,
      repeatedQueryMs: repeatedWalk.diagnostics.searchStats.queryMs,
    },
    drive: {
      distanceKm: drive.legs[0].distanceKm,
      durationMinutes: drive.durationMinutes,
      queryMs: drive.diagnostics.searchStats.queryMs,
      acceleratedQueryMs: acceleratedDrive.diagnostics.searchStats.queryMs,
      acceleratorSource: acceleratedDrive.diagnostics.searchStats.acceleratorSource,
      recoveredQueryMs: recoveredDrive.diagnostics.searchStats.queryMs,
      recoveredOriginSnapDistanceM: recoveredDrive.diagnostics.originSnapDistanceM,
      workerOperationMs: workerResult.metrics.operationMs,
      streetMatrixQueryMs: driveMatrix.diagnostics.queryMs,
      streetMatrixWorkerOperationMs: matrixWorkerResult.metrics.operationMs,
      batchWorkerOperationMs: batchResult.metrics.operationMs,
    },
  }, null, 2))
}
