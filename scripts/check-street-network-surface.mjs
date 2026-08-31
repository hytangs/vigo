import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  buildNationalOsmWalkStore,
  compactNationalOsmRuntimeStore,
  disposeNationalOsmStore,
  streetNetworkTimedConnectors,
  streetNetworkTravelTimeRaster,
} from '../server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../server/native-routing-kernel.mjs'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-street-surface-'))
const storePath = path.join(folder, 'street.sqlite')
const osmStoreSource = await fs.readFile(
  new URL('../server/national-osm-store.mjs', import.meta.url),
  'utf8',
)
for (const removedExecutor of [
  'class StreetSurfaceQueue',
  'function surfaceLabel',
  'function connectorLabel',
  'runTimedConnectorSearch',
  'state.edges.iterate(current.node)',
]) {
  assert.equal(
    osmStoreSource.includes(removedExecutor),
    false,
    `JavaScript street executor must stay removed: ${removedExecutor}`,
  )
}

function buildFixture() {
  const db = new DatabaseSync(storePath)
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    CREATE INDEX edges_to ON edges(to_node);
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE drive_edges(
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      travel_time_s REAL NOT NULL,
      way_id INTEGER NOT NULL,
      road_class INTEGER NOT NULL
    );
    CREATE INDEX drive_nodes_lat_lon ON drive_nodes(lat,lon);
    CREATE INDEX drive_edges_from ON drive_edges(from_node);
    CREATE INDEX drive_edges_to ON drive_edges(to_node);
    INSERT INTO metadata VALUES
      ('schemaVersion', '"vigo.street.store.v3"'),
      ('sourceModel', '"pbf"'),
      ('storageLayout', '"walk-drive-role-tables-v2"'),
      ('nodeCount', '6'),
      ('edgeCount', '4');
    INSERT INTO nodes VALUES
      (1, 42.0000, -71.0000),
      (2, 42.0000, -70.9990),
      (3, 42.0010, -70.9990),
      (4, 42.0020, -70.9990),
      (5, 42.0025, -70.9985),
      (6, 42.0025, -70.9980);
    INSERT INTO walk_nodes SELECT * FROM nodes;
    INSERT INTO edges VALUES
      (1, 2, 82, 1),
      (2, 3, 111, 2),
      (3, 4, 111, 3),
      (5, 6, 42, 4);
    INSERT INTO drive_nodes SELECT * FROM nodes;
  `)
  db.close()
}

function finiteCells(result) {
  return [...result.values].filter(Number.isFinite)
}

function rasterIndex(bounds, width, height, [longitude, latitude]) {
  const [west, south, east, north] = bounds
  const x = Math.max(0, Math.min(width - 1, Math.floor((longitude - west) / (east - west) * width)))
  const y = Math.max(0, Math.min(height - 1, Math.floor((north - latitude) / (north - south) * height)))
  return y * width + x
}

try {
  buildFixture()
  const nativeStore = buildNationalOsmWalkStore(storePath, { force: true, persist: true })
  assert.equal(nativeStore.ready, true, nativeStore.error)
  assert.equal(nativeStore.snapshotStatus, 'written')
  assert.equal(
    compactNationalOsmRuntimeStore(storePath).storageLayout,
    'runtime-snapshots-v1',
  )
  disposeNationalOsmStore(storePath)
  const common = {
    bounds: [-71.001, 41.999, -70.998, 42.003],
    width: 48,
    height: 48,
    maxWalkKm: 0.21,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  }
  const forward = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    includeEdges: true,
    edgeEvidenceLimit: 100,
    seeds: [{ coordinate: [-71, 42], durationMinutes: 0 }],
  })
  assert.equal(forward.schemaVersion, 'vigo.street.network-raster.v1')
  assert.equal(forward.diagnostics.kernel, 'rust_mmap_street_surface_v1')
  assert.equal(forward.values.length, 48 * 48)
  assert.equal(forward.diagnostics.seeds, 1)
  assert(forward.diagnostics.snappedSeeds >= 1)
  assert(forward.diagnostics.settledLabels >= 3)
  assert(finiteCells(forward).length >= 3)
  assert(forward.edges.length >= 2, 'Street-path rendering must receive reached directed OSM edges.')
  assert.deepEqual(forward.edges[0].coordinates.length, 2)
  assert(
    forward.diagnostics.reachedPixels > 3,
    'Surface rasterization must interpolate reachable OSM edges between graph nodes.',
  )
  assert.equal(
    forward.values[rasterIndex(common.bounds, common.width, common.height, [-70.9985, 42.0025])],
    Number.POSITIVE_INFINITY,
    'Surface rasterization must not extrapolate across disconnected OSM components.',
  )
  assert(
    Math.max(...finiteCells(forward)) >= 2,
    'Network travel time must accumulate along the L-shaped street path.',
  )

  const unboundedEvidence = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    includeEdges: true,
    edgeEvidenceLimit: 0,
    seeds: [{ coordinate: [-71, 42], durationMinutes: 0 }],
  })
  assert.equal(
    unboundedEvidence.diagnostics.edgeEvidenceTruncated,
    false,
    'The explicit full-map street geometry mode must not truncate reached edges.',
  )
  assert.equal(
    unboundedEvidence.edges.length,
    unboundedEvidence.diagnostics.reachedEdgeCount,
    'The full-map street geometry mode must return every reached directed edge.',
  )

  const unboundedArea = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    bounds: [-71.0002, 41.9998, -70.9998, 42.0002],
    maxWalkKm: 0.35,
    includeEdges: false,
    edgeEvidenceLimit: 0,
    expandBoundsToReachedEdges: true,
    seeds: [{ coordinate: [-71, 42], durationMinutes: 0 }],
  })
  assert.equal(unboundedArea.edges.length, 0, 'Area mode must not serialize street edges.')
  assert(
    unboundedArea.fullBounds[2] > -70.9998 || unboundedArea.fullBounds[3] > 42.0002,
    'Area mode must expand beyond the initial raster envelope to every reached street.',
  )
  assert.equal(unboundedArea.fullValues.length, common.width * common.height)

  const maximumResolution = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    width: 1024,
    height: 1024,
    seeds: [{ coordinate: [-71, 42], durationMinutes: 0 }],
  })
  assert.equal(maximumResolution.width, 1024)
  assert.equal(maximumResolution.height, 1024)
  assert.equal(maximumResolution.values.length, 1024 * 1024)

  const reverse = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    seeds: [{ coordinate: [-70.999, 42.001], durationMinutes: 0 }],
  })
  assert(
    reverse.diagnostics.reachedPixels < forward.diagnostics.reachedPixels,
    'Directed OSM edges must prevent a reverse circular reachability halo.',
  )

  const shortBudget = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    maxWalkKm: 0.09,
    seeds: [{ coordinate: [-71, 42], durationMinutes: 0 }],
  })
  assert(
    shortBudget.diagnostics.reachedPixels < forward.diagnostics.reachedPixels,
    'The adjustable walking budget must truncate network settlement.',
  )

  const slowerWalk = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    walkSpeedKph: 3,
    seeds: [{ coordinate: [-71, 42], durationMinutes: 0 }],
  })
  assert(
    Math.max(...finiteCells(slowerWalk)) > Math.max(...finiteCells(forward)),
    'Walking speed must change settled travel times without changing the graph.',
  )

  const earlyBudgetSpent = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    maxWalkKm: 0.15,
    seeds: [{ coordinate: [-71, 42], durationMinutes: 0 }],
  })
  const laterBudgetAvailable = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    maxWalkKm: 0.15,
    seeds: [
      { coordinate: [-71, 42], durationMinutes: 0 },
      { coordinate: [-70.999, 42], durationMinutes: 2 },
    ],
  })
  assert(
    laterBudgetAvailable.diagnostics.reachedPixels > earlyBudgetSpent.diagnostics.reachedPixels,
    'A later label with unused walking budget must survive an earlier label at the same street vertex.',
  )

  const transitStopEgressSurface = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    maxWalkKm: 0.15,
    includeEdges: true,
    edgeEvidenceLimit: 100,
    seeds: [
      { coordinate: [-71, 42], durationMinutes: 0 },
      { coordinate: [-70.999, 42.001], durationMinutes: 12 },
    ],
  })
  assert(
    transitStopEgressSurface.edges.some((edge) => (
      edge.coordinates[0][0] === -70.999
      && edge.coordinates[0][1] === 42.001
      && edge.coordinates[1][0] === -70.999
      && edge.coordinates[1][1] === 42.002
    )),
    'Street paths must include downstream OSM edges from a later reachable transit-stop seed within the total cutoff.',
  )
  assert(
    transitStopEgressSurface.edges.some((edge) => edge.durationMinutes > 12),
    'Transit-stop street paths must retain the stop arrival time plus remaining walk time.',
  )

  const cutoffSeedSurface = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    maxWalkKm: 0.15,
    maximumDurationMinutes: 12,
    independentTerminalWalk: false,
    includeEdges: true,
    edgeEvidenceLimit: 100,
    seeds: [{ coordinate: [-70.999, 42.001], durationMinutes: 12 }],
  })
  assert.equal(
    cutoffSeedSurface.edges.length,
    0,
    'A stop reached at the cutoff must not create an extra terminal-walk fringe.',
  )

  const independentTerminalWalkSurface = streetNetworkTravelTimeRaster(storePath, {
    ...common,
    maxWalkKm: 0.15,
    maximumDurationMinutes: 12 + (0.15 / 4.8 * 60),
    independentTerminalWalk: true,
    includeEdges: true,
    edgeEvidenceLimit: 100,
    seeds: [
      { coordinate: [-71, 42], durationMinutes: 0 },
      { coordinate: [-70.999, 42.001], durationMinutes: 12 },
    ],
  })
  assert.equal(
    independentTerminalWalkSurface.diagnostics.terminalWalkMode,
    'independent-full-budget',
    'The native kernel must retain its explicit independent terminal-walk mode for non-product callers.',
  )
  assert.equal(
    independentTerminalWalkSurface.values[rasterIndex(common.bounds, common.width, common.height, [-70.999, 42.002])],
    12,
    'A stop reached at the transit cutoff must still expand to the full walking budget; its surface value remains the seed transit arrival.',
  )
  assert(
    independentTerminalWalkSurface.edges.some((edge) => (
      edge.transitArrivalMinutes === 12
      && edge.durationMinutes > 12
    )),
    'Independent terminal-walk edges must retain both the supporting transit arrival and actual walk-inclusive duration.',
  )

  const connectors = streetNetworkTimedConnectors(storePath, {
    seeds: [{
      coordinate: [-70.999, 42.001],
      durationMinutes: 2,
      maxWalkKm: 0.2,
      snapMode: 'fixed',
    }],
    targets: [
      { id: 'upstream', coordinate: [-70.999, 42.001] },
      { id: 'downstream', coordinate: [-70.999, 42.002] },
    ],
    includeTargetMatrix: true,
    maxWalkKm: 0.2,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  })
  assert.equal(connectors.schemaVersion, 'vigo.street.timed-connectors.v1')
  assert.equal(connectors.diagnostics.kernel, 'rust_mmap_timed_connectors_v1')
  assert.equal(connectors.diagnostics.directed, true)
  assert.equal(connectors.arrivals[0].durationMinutes, 2)
  assert.equal(connectors.arrivals[1].status, 'ready')
  assert(connectors.arrivals[1].durationMinutes > 3)
  assert.equal(connectors.matrix.size, 2)
  assert.equal(connectors.matrix.durationsMinutes[0], 0)
  assert(Number.isFinite(connectors.matrix.durationsMinutes[1]))
  assert.equal(
    connectors.matrix.durationsMinutes[2],
    null,
    'A short coordinate chord must remain disconnected when the directed OSM graph has no reverse path.',
  )
  assert.equal(connectors.matrix.durationsMinutes[3], 0)

  const cchBuild = buildNativeStreetCchIndex(storePath)
  assert.equal(cchBuild.loaded?.nodeCount, 6)
  const cchConnectors = streetNetworkTimedConnectors(storePath, {
    seeds: [{
      coordinate: [-70.999, 42.001],
      durationMinutes: 2,
      maxWalkKm: 0.2,
      snapMode: 'fixed',
    }],
    targets: [
      { id: 'upstream', coordinate: [-70.999, 42.001] },
      { id: 'downstream', coordinate: [-70.999, 42.002] },
    ],
    includeTargetMatrix: true,
    maxWalkKm: 0.2,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  })
  assert.equal(cchConnectors.diagnostics.aggregateCchAccelerated, true)
  assert.equal(cchConnectors.diagnostics.matrixCchAccelerated, true)
  assert.deepEqual(
    cchConnectors.arrivals.map((arrival) => arrival.status),
    connectors.arrivals.map((arrival) => arrival.status),
    'CCH and exact connector fallback must preserve directed reachability.',
  )
  for (let index = 0; index < connectors.arrivals.length; index += 1) {
    const exact = connectors.arrivals[index].durationMinutes
    const accelerated = cchConnectors.arrivals[index].durationMinutes
    if (exact === null || accelerated === null) assert.equal(accelerated, exact)
    else assert(Math.abs(accelerated - exact) < 1e-5)
  }
  for (let index = 0; index < connectors.matrix.durationsMinutes.length; index += 1) {
    const exact = connectors.matrix.durationsMinutes[index]
    const accelerated = cchConnectors.matrix.durationsMinutes[index]
    if (exact === null || accelerated === null) assert.equal(accelerated, exact)
    else assert(Math.abs(accelerated - exact) < 1e-5)
  }
  const duplicateCoordinate = [-70.9991, 42.001]
  const duplicateConnectors = streetNetworkTimedConnectors(storePath, {
    seeds: [{
      coordinate: duplicateCoordinate,
      durationMinutes: 4,
      maxWalkKm: 0.2,
      snapMode: 'fixed',
    }],
    targets: [
      { id: 'duplicate-a', coordinate: duplicateCoordinate },
      { id: 'duplicate-b', coordinate: duplicateCoordinate },
    ],
    includeTargetMatrix: true,
    maxWalkKm: 0.2,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  })
  assert.deepEqual(
    duplicateConnectors.arrivals.map((arrival) => arrival.durationMinutes),
    [4, 4],
    'Coordinate identity must remain zero-cost before and after CCH snapping.',
  )
  assert.deepEqual(duplicateConnectors.matrix.durationsMinutes, [0, 0, 0, 0])

  const multiSeedConnectors = streetNetworkTimedConnectors(storePath, {
    seeds: [
      { coordinate: [-71, 42], durationMinutes: 0, maxWalkKm: 0.09, snapMode: 'fixed' },
      { coordinate: [-70.999, 42], durationMinutes: 2, maxWalkKm: 0.2, snapMode: 'fixed' },
    ],
    targets: [{ id: 'multi-seed-target', coordinate: [-70.999, 42.001] }],
    includeTargetMatrix: false,
    maxWalkKm: 0.2,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  })
  assert.equal(
    multiSeedConnectors.diagnostics.aggregateCchAccelerated,
    false,
    'Different seed times and walk budgets must retain the exact multi-resource operator.',
  )
  assert.equal(multiSeedConnectors.arrivals[0].status, 'ready')

  const extendedRouteTargets = Array.from({ length: 25 }, (_, index) => ({
    id: `extended-route-${index + 1}`,
    coordinate: index % 2 === 0 ? [-71, 42] : [-70.999, 42],
  }))
  const extendedRouteConnectors = streetNetworkTimedConnectors(storePath, {
    seeds: [{
      coordinate: [-71, 42],
      durationMinutes: 0,
      maxWalkKm: 0.2,
      snapMode: 'fixed',
    }],
    targets: extendedRouteTargets,
    includeTargetMatrix: true,
    maxWalkKm: 0.2,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  })
  assert.equal(
    extendedRouteConnectors.matrix.size,
    25,
    'A route with more than 24 stops must retain its complete directed connector matrix.',
  )
  assert.throws(
    () => streetNetworkTimedConnectors(storePath, {
      seeds: [{
        coordinate: [-71, 42],
        durationMinutes: 0,
        maxWalkKm: 0.2,
      }],
      targets: Array.from({ length: 257 }, (_, index) => ({
        id: `overflow-${index + 1}`,
        coordinate: [-71, 42],
      })),
      includeTargetMatrix: true,
      maxWalkKm: 0.2,
      maximumDurationMinutes: 15,
    }),
    /limited to 256 targets/i,
  )

  const disconnectedShortChord = streetNetworkTimedConnectors(storePath, {
    seeds: [{
      coordinate: [-70.999, 42.002],
      durationMinutes: 0,
      maxWalkKm: 0.2,
      snapMode: 'fixed',
    }],
    targets: [{ id: 'near-but-unreachable', coordinate: [-70.999, 42.001] }],
    maxWalkKm: 0.2,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  })
  assert.equal(disconnectedShortChord.arrivals[0].status, 'blocked')
  assert.equal(disconnectedShortChord.arrivals[0].durationMinutes, null)

  const perSeedBudgets = streetNetworkTimedConnectors(storePath, {
    seeds: [
      {
        coordinate: [-71, 42],
        durationMinutes: 0,
        maxWalkKm: 0.15,
        snapMode: 'fixed',
      },
      {
        coordinate: [-70.999, 42.001],
        durationMinutes: 2,
        maxWalkKm: 0.15,
        snapMode: 'fixed',
      },
    ],
    targets: [{ id: 'downstream', coordinate: [-70.999, 42.002] }],
    maxWalkKm: 0.15,
    walkSpeedKph: 4.8,
    maximumDurationMinutes: 15,
  })
  assert.equal(perSeedBudgets.arrivals[0].status, 'ready')
  assert.equal(
    perSeedBudgets.arrivals[0].seedIndex,
    1,
    'A later seed with a fresh per-seed walking budget must survive an earlier exhausted seed.',
  )

  assert.throws(
    () => streetNetworkTimedConnectors(storePath, {
      seeds: [{
        coordinate: [-71, 42],
        durationMinutes: 0,
        maxWalkKm: 0.2,
      }],
      targets: [{ id: 'target', coordinate: [-70.999, 42.001] }],
      maxWalkKm: 0.2,
      maximumDurationMinutes: 15,
    }, { isCancelled: () => true }),
    (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
  )

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: forward.schemaVersion,
    forward: forward.diagnostics,
    reverse: reverse.diagnostics,
    shortBudget: shortBudget.diagnostics,
      multiLabelBudget: laterBudgetAvailable.diagnostics,
      connectors: cchConnectors.diagnostics,
    disconnectedShortChord: disconnectedShortChord.diagnostics,
  }, null, 2))
} finally {
  disposeNationalOsmStore(storePath)
  await fs.rm(folder, { recursive: true, force: true })
}
