import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { totalmem } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  disposeNativeRoutingKernel,
  nativeStreetCchPrepared,
  prepareNativeDriveKernel,
  prepareNativeRoutingKernel,
  rasterNativeStreetSurface,
  routeNativeDriveExact,
  routeNativeDriveMatrix,
  routeNativeTimedConnectors,
  routeNativeWalkMatrix,
  routeNativeStreetPath,
  normalizeNativeMilliseconds,
} from './native-routing-kernel.mjs'
import { haversineKm } from './geometry-utils.mjs'
import { assertMatrixSize } from './matrix-size.mjs'
import {
  coordinate,
  forEachPbfBlock,
  forEachPrimitiveEntity,
  wayTags,
} from './osm-pbf-reader.mjs'
import { timingMilliseconds } from './number-utils.mjs'
import { stableKeySuffix } from './routing-plan-identity.mjs'

// v4 also excludes foot=private from the public pedestrian graph, even when
// the general access tag is absent or permits other travel modes.
// Public pedestrian access semantics are part of the persisted-store
// schema. Rebuild from the source PBF when this schema changes.
const streetStoreSchemaVersion = 'vigo.street.store.v4'
// A store is admitted by version, source model, and the objects the runtime
// actually queries. Column-by-column and index-SQL checks duplicated SQLite's
// schema and made harmless builder changes look like corrupt stores.
const streetStoreTableNames = Object.freeze(['metadata', 'walk_nodes', 'edges'])
const streetStoreIndexTables = Object.freeze({
  walk_nodes_lat_lon: 'walk_nodes',
  edges_from: 'edges',
})
const drivingStoreTableNames = Object.freeze(['drive_nodes', 'drive_edges'])
const drivingStoreIndexTables = Object.freeze({ drive_edges_from: 'drive_edges' })
const streetAcceleratorMemoryGuardMinimumEdges = 50_000
const streetAcceleratorMaximumEdges = Math.max(100_000, Number(process.env.VIGO_STREET_ACCELERATOR_MAX_EDGES) || 40_000_000)
const streetAcceleratorMaximumStoreBytes = Math.max(128 * 1024 * 1024, Number(process.env.VIGO_STREET_ACCELERATOR_MAX_STORE_BYTES) || 12_000_000_000)
const streetAcceleratorAutomaticBuildMaximumEdges = Math.min(streetAcceleratorMaximumEdges, 8_000_000)
const streetAcceleratorAutomaticBuildMaximumStoreBytes = Math.min(
  streetAcceleratorMaximumStoreBytes,
  1_500_000_000,
)
const streetAcceleratorOfflineBuildMinimumMemoryBytes = 8 * 1024 * 1024 * 1024
const streetAcceleratorLargeGraphMinimumMemoryBytes = 16 * 1024 * 1024 * 1024
const streetAcceleratorLargeGraphThresholdEdges = 12_000_000
const streetAcceleratorSpatialCellDegrees = 0.002
const streetAcceleratorMaximumSpatialCells = 4_000_000
const streetAcceleratorSnapshotMagic = 'vigo.street.accelerator'
// v7 removes the runtime-unused OSM node-id copy and stores reverse-edge
// indices instead of duplicating every edge distance. The public graph and
// all route distances remain unchanged.
const streetAcceleratorSnapshotVersion = 7
const streetAcceleratorSnapshotHeaderBytes = 4096
const streetAcceleratorSnapshotSuffix = `.street-accelerator-v${streetAcceleratorSnapshotVersion}.bin`
const runtimeStreetStoreStorageLayout = 'runtime-snapshots-v1'
const readOnlySqliteMmapBytes = Math.max(
  0,
  Math.min(
    2 * 1024 * 1024 * 1024,
    Math.floor(Number(process.env.VIGO_READONLY_SQLITE_MMAP_BYTES ?? 256 * 1024 * 1024) || 0),
  ),
)
const readOnlySqliteCacheKiB = Math.max(
  4 * 1024,
  Math.min(256 * 1024, Math.floor(Number(process.env.VIGO_READONLY_SQLITE_CACHE_KIB ?? 32 * 1024) || 0)),
)
const buildSqliteCacheKiB = Math.max(
  4 * 1024,
  Math.min(256 * 1024, Math.floor(Number(process.env.VIGO_BUILD_SQLITE_CACHE_KIB ?? 32 * 1024) || 0)),
)
const buildSqlitePageSize = 32 * 1024
const driveAcceleratorMaximumNodes = Math.max(100_000, Number(process.env.VIGO_DRIVE_ACCELERATOR_MAX_NODES) || 8_000_000)
const driveAcceleratorMaximumEdges = Math.max(250_000, Number(process.env.VIGO_DRIVE_ACCELERATOR_MAX_EDGES) || 20_000_000)
const driveAcceleratorSnapshotMagic = 'vigo.drive.accelerator'
// v2 is a runtime-only drive graph: node ids are implicit array indices and
// edge weights are persisted in the same fixed-point units already consumed
// by the Rust kernel. The source SQLite graph is therefore not retained after
// preprocessing, and no float-to-fixed conversion is needed on cold load.
const driveAcceleratorSnapshotVersion = 2
const driveAcceleratorSnapshotHeaderBytes = 4096
const driveAcceleratorSnapshotSuffix = `.drive-accelerator-v${driveAcceleratorSnapshotVersion}.bin`
const driveDistanceUnitsPerMeter = 100
const driveTimeUnitsPerSecond = 100
const driveTrafficClosedWeight = 0x7fff_ffff
const driveTrafficDefaultTtlSeconds = 300
const driveTrafficMaximumTtlSeconds = 1_800
const driveTrafficMaximumObservations = 100_000
const driveTrafficMaximumEdgeUpdates = 250_000
const driveTrafficDefaultSnapRadiusKm = 0.12
const driveTrafficMaximumSnapRadiusKm = 1
const driveSnapRecoveryMinimumDistanceKm = 0.025
const driveSnapRecoveryRadiiKm = Object.freeze([0.35, 1, 3, 5])
const driveSnapRecoveryCandidatesPerRadius = 48
const streetStoreCacheMaximumEntries = Math.max(1, Math.min(16, Math.floor(Number(process.env.VIGO_STREET_STORE_CACHE_MAX_ENTRIES ?? 4) || 4)))

const explicitPedestrianAccessValues = new Set([
  'yes',
  'designated',
  'permissive',
  'official',
])
const restrictedPedestrianAccessValues = new Set(['no', 'private'])

const drivableHighways = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street',
  'service', 'road', 'track',
])

function normalizedTag(value) {
  return String(value ?? '').trim().toLowerCase()
}

const driveRoadClassCatalog = Object.freeze([...drivableHighways].sort())
const driveRoadClassCodes = new Map(driveRoadClassCatalog.map((value, index) => [value, index + 1]))

function driveRoadClassCode(value) {
  const code = driveRoadClassCodes.get(normalizedTag(value))
  if (!code) throw new Error(`Unsupported drivable OSM highway class: ${String(value ?? '')}`)
  return code
}

function hasCompletelySeparateSidewalkGeometry(tags) {
  const sidewalk = normalizedTag(tags.sidewalk)
  const both = normalizedTag(tags['sidewalk:both'])
  const left = normalizedTag(tags['sidewalk:left'])
  const right = normalizedTag(tags['sidewalk:right'])
  return sidewalk === 'separate'
    || both === 'separate'
    || (left === 'separate' && right === 'separate')
}

export function nationalOsmWayWalkable(tags) {
  const highway = normalizedTag(tags.highway)
  const access = normalizedTag(tags.access)
  const foot = normalizedTag(tags.foot)
  if (!highway || restrictedPedestrianAccessValues.has(foot)) return false
  // OSM mode-specific access overrides the general access tag. In particular,
  // access=no/private + foot=permissive is a pedestrian path, while an
  // unqualified private way must not enter the public walking graph.
  if (
    restrictedPedestrianAccessValues.has(access)
    && !explicitPedestrianAccessValues.has(foot)
  ) return false
  // On a vehicle way with general access denied, foot=yes is the legal-mode
  // override. If OSM also says both sidewalks are mapped as separate ways,
  // those sidewalk ways—not the restricted carriageway—are the pedestrian
  // geometry. Importing both makes the carriageway win endpoint snapping and
  // duplicates the same physical corridor.
  if (
    restrictedPedestrianAccessValues.has(access)
    && explicitPedestrianAccessValues.has(foot)
    && drivableHighways.has(highway)
    && hasCompletelySeparateSidewalkGeometry(tags)
  ) return false
  return !['motorway', 'motorway_link', 'raceway', 'construction', 'proposed'].includes(highway)
}

function deniesMotorVehicleAccess(value) {
  return ['no', 'private', 'agricultural', 'forestry'].includes(normalizedTag(value))
}

function drivable(tags) {
  const highway = normalizedTag(tags.highway)
  if (!drivableHighways.has(highway)) return false
  const access = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access
  if (deniesMotorVehicleAccess(access)) return false
  return highway !== 'track'
    || ['yes', 'designated', 'permissive'].includes(normalizedTag(
      tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access,
    ))
}

export function nationalOsmWalkDirections(tags) {
  const normalized = (value) => String(value ?? '').trim().toLowerCase()
  let forward = true
  let backward = true
  const oneWayFoot = normalized(tags['oneway:foot'])
  const conveying = normalized(tags.conveying)
  if (['yes', '1', 'true'].includes(oneWayFoot)) backward = false
  else if (['-1', 'reverse'].includes(oneWayFoot)) forward = false
  else if (conveying === 'forward') backward = false
  else if (conveying === 'backward') forward = false
  else if (['yes', 'reversible'].includes(conveying)) {
    // These values do not prove a usable direction at the requested time.
    // Excluding the way is safer than inventing a direction in an offline route.
    forward = false
    backward = false
  }
  if (['no', 'private'].includes(normalized(tags['foot:forward']))) forward = false
  if (['no', 'private'].includes(normalized(tags['foot:backward']))) backward = false
  return { forward, backward }
}

export function nationalOsmDriveDirections(tags) {
  let forward = true
  let backward = true
  const oneWay = normalizedTag(tags['oneway:motor_vehicle'] ?? tags.oneway)
  if (['yes', '1', 'true'].includes(oneWay)) backward = false
  else if (['-1', 'reverse'].includes(oneWay)) forward = false
  else if (!['no', '0', 'false'].includes(oneWay)) {
    const highway = normalizedTag(tags.highway)
    const junction = normalizedTag(tags.junction)
    if (
      ['roundabout', 'circular'].includes(junction)
      || ['motorway', 'motorway_link'].includes(highway)
    ) backward = false
  }
  const forwardAccess = tags['motorcar:forward']
    ?? tags['motor_vehicle:forward']
    ?? tags['vehicle:forward']
  const backwardAccess = tags['motorcar:backward']
    ?? tags['motor_vehicle:backward']
    ?? tags['vehicle:backward']
  if (deniesMotorVehicleAccess(forwardAccess)) forward = false
  if (deniesMotorVehicleAccess(backwardAccess)) backward = false
  return { forward, backward }
}

const highwaySpeedKph = Object.freeze({
  motorway: 100,
  motorway_link: 60,
  trunk: 90,
  trunk_link: 55,
  primary: 60,
  primary_link: 45,
  secondary: 50,
  secondary_link: 40,
  tertiary: 45,
  tertiary_link: 35,
  unclassified: 40,
  residential: 30,
  living_street: 10,
  service: 20,
  road: 30,
  track: 15,
})

function parsedSpeedKph(value) {
  const normalized = normalizedTag(value)
  if (!normalized || ['none', 'signals', 'variable', 'walk'].includes(normalized)) return null
  const match = normalized.match(/(?:^|;)\s*(\d+(?:\.\d+)?)/)
  if (!match) return null
  const number = Number(match[1])
  if (!(number > 0)) return null
  if (normalized.includes('mph')) return number * 1.609344
  if (normalized.includes('knot')) return number * 1.852
  return number
}

export function nationalOsmDrivingSpeedKph(tags, direction = 'forward') {
  const directional = direction === 'backward' ? tags['maxspeed:backward'] : tags['maxspeed:forward']
  const parsed = parsedSpeedKph(directional) ?? parsedSpeedKph(tags.maxspeed)
  return Math.max(5, Math.min(140, parsed ?? highwaySpeedKph[normalizedTag(tags.highway)] ?? 30))
}

export async function buildNationalOsmStore({
  pbfPath,
  outputPath,
  onProgress,
  buildDrivingProfile = process.env.VIGO_BUILD_DRIVE_ACCELERATOR === '1',
}) {
  const started = performance.now()
  const source = await fs.stat(pbfPath)
  const tempPath = `${outputPath}.building`
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.rm(tempPath, { force: true })
  const db = new DatabaseSync(tempPath)
  db.exec(`
    PRAGMA page_size=${buildSqlitePageSize}; PRAGMA journal_mode=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-${buildSqliteCacheKiB};
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
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
  `)
  const insertNode = db.prepare('INSERT OR REPLACE INTO nodes VALUES(?,?,?)')
  const insertEdge = db.prepare('INSERT INTO edges VALUES(?,?,?,?)')
  const insertWalkNode = db.prepare('INSERT OR IGNORE INTO walk_nodes VALUES(?,?,?)')
  const insertDriveEdge = db.prepare('INSERT INTO drive_edges VALUES(?,?,?,?,?,?)')
  const insertDriveNode = db.prepare('INSERT OR IGNORE INTO drive_nodes VALUES(?,?,?)')
  const getNode = db.prepare('SELECT lat,lon FROM nodes WHERE node_id=?')
  let nodeCount = 0
  let walkNodeCount = 0
  let edgeCount = 0
  let wayCount = 0
  let driveNodeCount = 0
  let driveEdgeCount = 0
  let driveWayCount = 0
  let directionRestrictedWayCount = 0
  let directionExcludedWayCount = 0
  let uncertainConveyingWayCount = 0
  let transactionRows = 0
  const sourceHasher = crypto.createHash('sha256')
  const validateNodeId = (id) => {
    // Unreferenced nodes no longer reach SQLite, so preserve the integer-range
    // validation previously enforced by its INTEGER PRIMARY KEY column.
    if (!Number.isInteger(id) || id < -(2 ** 63) || id >= 2 ** 63) {
      throw new Error('OSM node ID is outside the supported 64-bit integer range.')
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    // Resolve every supported way, but avoid writing unrelated building/land-use
    // nodes to the temporary SQLite lookup. The second pass still validates all
    // node records and preserves the original source-node count.
    // Bound each Set by its integer-ID range, including on large extracts.
    const nodeIdBucketSize = 1_048_576
    const requiredNodes = new Map()
    let requiredNodeCount = 0
    const requireNode = (id) => {
      const bucketId = Math.floor(id / nodeIdBucketSize)
      let bucket = requiredNodes.get(bucketId)
      if (!bucket) requiredNodes.set(bucketId, bucket = new Set())
      const previousSize = bucket.size
      bucket.add(id - bucketId * nodeIdBucketSize)
      requiredNodeCount += bucket.size - previousSize
    }
    const isRequiredNode = (id) => {
      const bucketId = Math.floor(id / nodeIdBucketSize)
      return requiredNodes.get(bucketId)?.has(id - bucketId * nodeIdBucketSize) === true
    }
    const selectionHasher = crypto.createHash('sha256')
    await forEachPbfBlock(pbfPath, async (block) => {
      for (const groupBytes of block.groups) {
        forEachPrimitiveEntity(block, groupBytes, {
          way: (way) => {
            const tags = wayTags(way, block.strings)
            if (!nationalOsmWayWalkable(tags) && !drivable(tags)) return
            for (const nodeId of way.refs) requireNode(nodeId)
          },
        })
      }
    }, ({ progress, bytesRead, totalBytes }) => onProgress?.({
      phase: 'Selecting street node references', progress: progress * 0.12,
      detail: `${requiredNodeCount.toLocaleString()} referenced nodes`,
      bytesRead, totalBytes, memory: process.memoryUsage().rss,
    }), (bytes) => selectionHasher.update(bytes))
    const selectedSourceFingerprint = selectionHasher.digest('hex')
    await forEachPbfBlock(pbfPath, async (block) => {
      for (const groupBytes of block.groups) {
        forEachPrimitiveEntity(block, groupBytes, {
          node: (node) => {
            if (node.id) {
              validateNodeId(node.id)
              nodeCount += 1
              if (isRequiredNode(node.id)) {
                const [lon, lat] = coordinate(block, node.lat, node.lon)
                insertNode.run(node.id, lat, lon)
                transactionRows += 1
              }
            }
          },
          denseNodes: (dense) => {
            for (let index = 0; index < dense.ids.length; index += 1) {
              validateNodeId(dense.ids[index])
              nodeCount += 1
              if (!isRequiredNode(dense.ids[index])) continue
              const [lon, lat] = coordinate(block, dense.lats[index], dense.lons[index])
              insertNode.run(dense.ids[index], lat, lon)
              transactionRows += 1
            }
          },
          way: (way) => {
            const tags = wayTags(way, block.strings)
            const isWalkable = nationalOsmWayWalkable(tags)
            const isDrivable = drivable(tags)
            if (!isWalkable && !isDrivable) return
            const walkDirections = isWalkable
              ? nationalOsmWalkDirections(tags)
              : { forward: false, backward: false }
            const driveDirections = isDrivable
              ? nationalOsmDriveDirections(tags)
              : { forward: false, backward: false }
            if (isWalkable && !walkDirections.forward && !walkDirections.backward) {
              directionExcludedWayCount += 1
              if (['yes', 'reversible'].includes(String(tags.conveying ?? '').trim().toLowerCase())) {
                uncertainConveyingWayCount += 1
              }
            }
            if (isWalkable && (!walkDirections.forward || !walkDirections.backward)) directionRestrictedWayCount += 1
            if (walkDirections.forward || walkDirections.backward) wayCount += 1
            if (driveDirections.forward || driveDirections.backward) driveWayCount += 1
            const roadClass = isDrivable ? driveRoadClassCode(tags.highway) : 0
            const forwardSpeedKph = nationalOsmDrivingSpeedKph(tags, 'forward')
            const backwardSpeedKph = nationalOsmDrivingSpeedKph(tags, 'backward')
            let previous = null
            for (const nodeId of way.refs) {
              const point = getNode.get(nodeId)
              let indexed = false
              if (previous && point) {
                const distanceM = haversineKm([previous.lon, previous.lat], [point.lon, point.lat]) * 1000
                if (distanceM > 0 && distanceM < 10_000) {
                  if (walkDirections.forward || walkDirections.backward) {
                    if (walkDirections.forward) insertEdge.run(previous.id, nodeId, distanceM, way.id)
                    if (walkDirections.backward) insertEdge.run(nodeId, previous.id, distanceM, way.id)
                    if (!previous.indexed) walkNodeCount += Number(insertWalkNode.run(previous.id, previous.lat, previous.lon).changes > 0)
                    walkNodeCount += Number(insertWalkNode.run(nodeId, point.lat, point.lon).changes > 0)
                    edgeCount += Number(walkDirections.forward) + Number(walkDirections.backward)
                    transactionRows += Number(walkDirections.forward) + Number(walkDirections.backward)
                  }
                  if (driveDirections.forward || driveDirections.backward) {
                    if (driveDirections.forward) {
                      insertDriveEdge.run(
                        previous.id,
                        nodeId,
                        distanceM,
                        distanceM / (forwardSpeedKph / 3.6),
                        way.id,
                        roadClass,
                      )
                    }
                    if (driveDirections.backward) {
                      insertDriveEdge.run(
                        nodeId,
                        previous.id,
                        distanceM,
                        distanceM / (backwardSpeedKph / 3.6),
                        way.id,
                        roadClass,
                      )
                    }
                    if (!previous.indexed) driveNodeCount += Number(insertDriveNode.run(previous.id, previous.lat, previous.lon).changes > 0)
                    const pointInsert = insertDriveNode.run(nodeId, point.lat, point.lon)
                    driveNodeCount += Number(pointInsert.changes > 0)
                    driveEdgeCount += Number(driveDirections.forward) + Number(driveDirections.backward)
                    transactionRows += Number(driveDirections.forward) + Number(driveDirections.backward)
                  }
                  indexed = true
                }
              }
              // A valid preceding segment has already inserted this endpoint
              // for the same way permissions; avoid the duplicate SQL writes.
              previous = point ? { id: nodeId, ...point, indexed } : null
            }
          },
        })
      }
      if (transactionRows >= 250_000) {
        db.exec('COMMIT; BEGIN IMMEDIATE')
        transactionRows = 0
      }
    }, ({ progress, bytesRead, totalBytes }) => onProgress?.({
      phase: wayCount || driveWayCount ? 'Indexing pedestrian and driving streets' : 'Reading OSM nodes',
      progress: 0.12 + progress * 0.76,
      detail: `${nodeCount.toLocaleString()} nodes / ${edgeCount.toLocaleString()} walk + ${driveEdgeCount.toLocaleString()} drive edges`,
      bytesRead,
      totalBytes,
      memory: process.memoryUsage().rss,
    }), (bytes) => sourceHasher.update(bytes))
    const sourceFingerprint = sourceHasher.digest('hex')
    if (sourceFingerprint !== selectedSourceFingerprint) {
      throw new Error('OSM PBF changed during street compilation; retry against a stable input.')
    }
    requiredNodes.clear()
    db.exec('COMMIT')
    onProgress?.({ phase: 'Building street indexes', progress: 0.9, detail: `${edgeCount.toLocaleString()} walk + ${driveEdgeCount.toLocaleString()} drive edges`, memory: process.memoryUsage().rss })
    // `nodes` is an import-time lookup table used to resolve OSM way
    // references. Runtime walk/drive queries use the role-specific tables,
    // so retaining every imported OSM node permanently duplicates storage
    // without changing the public street graph.
    db.exec('DROP TABLE nodes')
    // Almost every drivable OSM node is already a pedestrian node. Retain
    // only the small drive-only remainder in drive_nodes and resolve the
    // shared coordinates from walk_nodes at drive-profile preparation time.
    // This is the only source-store layout emitted by the current builder.
    db.exec(`
      CREATE TABLE drive_nodes_compact(
        node_id INTEGER PRIMARY KEY,
        lat REAL NOT NULL,
        lon REAL NOT NULL
      );
      INSERT INTO drive_nodes_compact(node_id, lat, lon)
      SELECT drive.node_id, drive.lat, drive.lon
      FROM drive_nodes AS drive
      LEFT JOIN walk_nodes AS walk ON walk.node_id=drive.node_id
      WHERE walk.node_id IS NULL;
      DROP TABLE drive_nodes;
      ALTER TABLE drive_nodes_compact RENAME TO drive_nodes;
    `)
    const driveNodeStoredCount = Number(db.prepare('SELECT COUNT(*) AS count FROM drive_nodes').get()?.count ?? 0)
    driveNodeCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT node_id FROM walk_nodes
        UNION
        SELECT node_id FROM drive_nodes
      )
    `).get()?.count ?? 0)
    db.exec(`
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    `)
    if (buildDrivingProfile) {
      db.exec('CREATE INDEX drive_edges_from ON drive_edges(from_node);')
    }
    // Drive indexes are deliberately omitted from the default artifact. The
    // driving profile is lazy, so paying for and storing its three indexes
    // during every walk/transit build only inflates cold work and disk use.
    // SQLite analyzes the indexes that are actually present.
    db.exec('ANALYZE;')
    const metadata = {
      schemaVersion: streetStoreSchemaVersion,
      sourceModel: 'pbf',
      sourceFingerprint,
      sourceFile: path.basename(pbfPath),
      sourceBytes: source.size,
      builtAt: new Date().toISOString(),
      nodeCount,
      walkNodeCount,
      edgeCount,
      wayCount,
      driveNodeCount,
      driveNodeStoredCount,
      driveEdgeCount,
      driveWayCount,
      drivingWeightModel: 'osm-maxspeed-or-highway-default-free-flow-seconds-v1',
      roadClassCatalog: driveRoadClassCatalog,
      directionRestrictedWayCount,
      directionExcludedWayCount,
      uncertainConveyingWayCount,
      storageLayout: 'walk-drive-role-tables-v2',
      driveNodeStorage: 'walk-shared-plus-drive-only-v1',
      driveIndexState: buildDrivingProfile ? 'ready' : 'deferred',
    }
    const insertMetadata = db.prepare('INSERT INTO metadata VALUES(?,?)')
    db.exec('BEGIN IMMEDIATE')
    for (const [key, value] of Object.entries(metadata)) insertMetadata.run(key, JSON.stringify(value))
    db.exec('COMMIT; PRAGMA optimize;')
    // Dropping the import-only node table and compacting shared drive nodes
    // leaves free SQLite pages behind. Reclaim them before publishing the
    // immutable artifact so the on-disk store reflects the compact layout.
    const freePages = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0)
    if (freePages > 0) db.exec('VACUUM')
    db.close()
    invalidateStreetStore(outputPath)
    await fs.rename(tempPath, outputPath)
    let driveAccelerator = {
      ready: false,
      source: null,
      buildMs: 0,
      snapshotWriteMs: 0,
      snapshotStatus: 'deferred',
      error: null,
      reason: 'deferred_until_drive_request',
    }
    if (buildDrivingProfile) {
      onProgress?.({
        phase: 'Building driving accelerator',
        progress: 0.94,
        detail: `${driveNodeCount.toLocaleString()} drive nodes / ${driveEdgeCount.toLocaleString()} drive edges`,
        memory: process.memoryUsage().rss,
      })
      // The raw importer only needs to emit the immutable drive snapshot. A
      // native drive CCH is deliberately prepared on first runtime use, so
      // the expensive build overlaps GTFS compilation without adding a
      // second persisted graph to the published project.
      driveAccelerator = buildNationalOsmDriveStore(outputPath, {
        persist: true,
        prepareNative: false,
      })
      disposeNationalOsmStore(outputPath)
    }
    const output = await fs.stat(outputPath)
    const acceleratorMemoryRequirement = edgeCount > streetAcceleratorLargeGraphThresholdEdges
      ? streetAcceleratorLargeGraphMinimumMemoryBytes
      : edgeCount >= streetAcceleratorMemoryGuardMinimumEdges
        ? streetAcceleratorOfflineBuildMinimumMemoryBytes
        : 0
    const walkAcceleratorEligible = (
      edgeCount > 0
      && edgeCount <= streetAcceleratorMaximumEdges
      && output.size <= streetAcceleratorMaximumStoreBytes
      && totalmem() >= acceleratorMemoryRequirement
    )
    let walkAccelerator = {
      ready: false,
      accelerated: false,
      reason: edgeCount <= 0
        ? 'graph_empty'
        : edgeCount > streetAcceleratorMaximumEdges
          ? 'edge_budget'
          : output.size > streetAcceleratorMaximumStoreBytes
            ? 'store_size_budget'
            : totalmem() < acceleratorMemoryRequirement
              ? 'memory_budget'
              : 'unavailable',
    }
    if (walkAcceleratorEligible) {
      onProgress?.({
        phase: 'Building pedestrian access accelerator',
        progress: 0.97,
        detail: `${walkNodeCount.toLocaleString()} walk nodes / ${edgeCount.toLocaleString()} directed edges`,
        memory: process.memoryUsage().rss,
      })
      // This expensive build belongs to the import worker, never to an
      // interactive route. The route worker only memory-maps/loads the
      // persisted snapshot; standalone Walk blocks explicitly if it is absent.
      walkAccelerator = buildNationalOsmWalkStore(outputPath, {
        force: true,
        persist: true,
      })
      disposeNationalOsmStore(outputPath)
    }
    onProgress?.({ phase: 'Street index ready', progress: 1, detail: `${Math.round(output.size / 1024 / 1024).toLocaleString()} MB`, memory: process.memoryUsage().rss })
    return {
      ...metadata,
      path: outputPath,
      bytes: output.size,
      buildSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      driveAccelerator: {
        ready: driveAccelerator.ready,
        source: driveAccelerator.source,
        buildMs: driveAccelerator.buildMs,
        snapshotWriteMs: driveAccelerator.snapshotWriteMs,
        snapshotStatus: driveAccelerator.snapshotStatus,
        reason: driveAccelerator.reason,
        error: driveAccelerator.error,
      },
      walkAccelerator: {
        ready: walkAccelerator.ready,
        source: walkAccelerator.source,
        buildMs: walkAccelerator.buildMs,
        snapshotWriteMs: walkAccelerator.snapshotWriteMs,
        snapshotStatus: walkAccelerator.snapshotStatus,
        reason: walkAccelerator.reason,
        error: walkAccelerator.error,
      },
    }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    try { db.close() } catch {}
    await fs.rm(tempPath, { force: true })
    throw error
  }
}

function acceleratorEligibility(storePath, metadata) {
  let storeBytes = Number.POSITIVE_INFINITY
  try { storeBytes = fsSync.statSync(storePath).size } catch {}
  const edgeCount = Math.max(0, Number(metadata.edgeCount ?? 0))
  if (edgeCount <= 0) {
    return {
      eligible: false,
      automaticBuildEligible: false,
      automaticBuildReason: 'graph_empty',
      reason: 'graph_empty',
      edgeCount,
      storeBytes,
    }
  }
  if (edgeCount > streetAcceleratorMaximumEdges) {
    return {
      eligible: false,
      automaticBuildEligible: false,
      automaticBuildReason: 'edge_budget',
      reason: 'edge_budget',
      edgeCount,
      storeBytes,
    }
  }
  if (storeBytes > streetAcceleratorMaximumStoreBytes) {
    return {
      eligible: false,
      automaticBuildEligible: false,
      automaticBuildReason: 'store_size_budget',
      reason: 'store_size_budget',
      edgeCount,
      storeBytes,
    }
  }
  const automaticBuildReason = edgeCount > streetAcceleratorAutomaticBuildMaximumEdges
    ? 'edge_budget'
    : storeBytes > streetAcceleratorAutomaticBuildMaximumStoreBytes
      ? 'store_size_budget'
      : 'eligible'
  return {
    eligible: true,
    automaticBuildEligible: automaticBuildReason === 'eligible',
    automaticBuildReason,
    reason: 'eligible',
    edgeCount,
    storeBytes,
  }
}

function driveAcceleratorEligibility(metadata) {
  if (metadata.schemaVersion !== streetStoreSchemaVersion) {
    return { eligible: false, reason: 'driving_profile_unavailable', nodeCount: 0, edgeCount: 0 }
  }
  const nodeCount = Math.max(0, Number(metadata.driveNodeCount ?? 0))
  const edgeCount = Math.max(0, Number(metadata.driveEdgeCount ?? 0))
  if (!nodeCount || !edgeCount) return { eligible: false, reason: 'driving_profile_empty', nodeCount, edgeCount }
  if (nodeCount > driveAcceleratorMaximumNodes) return { eligible: false, reason: 'node_budget', nodeCount, edgeCount }
  if (edgeCount > driveAcceleratorMaximumEdges) return { eligible: false, reason: 'edge_budget', nodeCount, edgeCount }
  return { eligible: true, reason: 'eligible', nodeCount, edgeCount }
}

function buildAcceleratorSpatialIndex(nodeLats, nodeLons) {
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLon = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  for (let nodeIndex = 0; nodeIndex < nodeLats.length; nodeIndex += 1) {
    minLat = Math.min(minLat, nodeLats[nodeIndex])
    maxLat = Math.max(maxLat, nodeLats[nodeIndex])
    minLon = Math.min(minLon, nodeLons[nodeIndex])
    maxLon = Math.max(maxLon, nodeLons[nodeIndex])
  }
  if (!nodeLats.length) {
    return {
      spatialMinLat: 0,
      spatialMinLon: 0,
      spatialCellDegrees: streetAcceleratorSpatialCellDegrees,
      spatialRows: 1,
      spatialColumns: 1,
      spatialOffsets: new Uint32Array(2),
      spatialNodeIndices: new Uint32Array(),
    }
  }
  const baseRows = Math.max(1, Math.floor((maxLat - minLat) / streetAcceleratorSpatialCellDegrees) + 1)
  const baseColumns = Math.max(1, Math.floor((maxLon - minLon) / streetAcceleratorSpatialCellDegrees) + 1)
  const scale = Math.max(1, Math.ceil(Math.sqrt((baseRows * baseColumns) / streetAcceleratorMaximumSpatialCells)))
  const spatialCellDegrees = streetAcceleratorSpatialCellDegrees * scale
  const spatialRows = Math.max(1, Math.floor((maxLat - minLat) / spatialCellDegrees) + 1)
  const spatialColumns = Math.max(1, Math.floor((maxLon - minLon) / spatialCellDegrees) + 1)
  const spatialOffsets = new Uint32Array(spatialRows * spatialColumns + 1)
  const cellForNode = (nodeIndex) => {
    const row = Math.min(spatialRows - 1, Math.max(0, Math.floor((nodeLats[nodeIndex] - minLat) / spatialCellDegrees)))
    const column = Math.min(spatialColumns - 1, Math.max(0, Math.floor((nodeLons[nodeIndex] - minLon) / spatialCellDegrees)))
    return row * spatialColumns + column
  }
  for (let nodeIndex = 0; nodeIndex < nodeLats.length; nodeIndex += 1) spatialOffsets[cellForNode(nodeIndex) + 1] += 1
  for (let cell = 1; cell < spatialOffsets.length; cell += 1) spatialOffsets[cell] += spatialOffsets[cell - 1]
  const spatialCursors = spatialOffsets.slice(0, -1)
  const spatialNodeIndices = new Uint32Array(nodeLats.length)
  for (let nodeIndex = 0; nodeIndex < nodeLats.length; nodeIndex += 1) {
    const cell = cellForNode(nodeIndex)
    spatialNodeIndices[spatialCursors[cell]] = nodeIndex
    spatialCursors[cell] += 1
  }
  return {
    spatialMinLat: minLat,
    spatialMinLon: minLon,
    spatialCellDegrees,
    spatialRows,
    spatialColumns,
    spatialOffsets,
    spatialNodeIndices,
  }
}

function spatiallyOrderStreetAcceleratorNodes(sourceNodeIds, sourceNodeLats, sourceNodeLons) {
  const spatial = buildAcceleratorSpatialIndex(sourceNodeLats, sourceNodeLons)
  const nodeIds = new Float64Array(sourceNodeIds.length)
  const nodeLats = new Float64Array(sourceNodeLats.length)
  const nodeLons = new Float64Array(sourceNodeLons.length)
  for (let nodeIndex = 0; nodeIndex < spatial.spatialNodeIndices.length; nodeIndex += 1) {
    const sourceIndex = spatial.spatialNodeIndices[nodeIndex]
    nodeIds[nodeIndex] = sourceNodeIds[sourceIndex]
    nodeLats[nodeIndex] = sourceNodeLats[sourceIndex]
    nodeLons[nodeIndex] = sourceNodeLons[sourceIndex]
  }
  return {
    nodeIds,
    nodeLats,
    nodeLons,
    spatialMinLat: spatial.spatialMinLat,
    spatialMinLon: spatial.spatialMinLon,
    spatialCellDegrees: spatial.spatialCellDegrees,
    spatialRows: spatial.spatialRows,
    spatialColumns: spatial.spatialColumns,
    spatialOffsets: spatial.spatialOffsets,
    spatialNodeOrder: 'cell_then_source_node_id',
  }
}

function markAcceleratorReciprocalEdges(
  edgeOffsets,
  edgeTargets,
  reciprocalEdgeFlags,
  edgeIndex,
  fromIndex,
  toIndex,
) {
  let reciprocal = false
  for (let edge = edgeOffsets[fromIndex]; edge < edgeOffsets[fromIndex + 1]; edge += 1) {
    if (edgeTargets[edge] !== toIndex) continue
    reciprocalEdgeFlags[edge] = 1
    reciprocal = true
  }
  if (reciprocal) reciprocalEdgeFlags[edgeIndex] = 1
  return reciprocal
}

function buildAcceleratorComponentIndex(edgeOffsets, edgeTargets, edgeDistances, nodeCount) {
  const parents = new Int32Array(nodeCount)
  const ranks = new Uint8Array(nodeCount)
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) parents[nodeIndex] = nodeIndex
  const find = (nodeIndex) => {
    let root = nodeIndex
    while (parents[root] !== root) root = parents[root]
    while (parents[nodeIndex] !== nodeIndex) {
      const parent = parents[nodeIndex]
      parents[nodeIndex] = root
      nodeIndex = parent
    }
    return root
  }
  const union = (left, right) => {
    let leftRoot = find(left)
    let rightRoot = find(right)
    if (leftRoot === rightRoot) return
    if (ranks[leftRoot] < ranks[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot]
    parents[rightRoot] = leftRoot
    if (ranks[leftRoot] === ranks[rightRoot]) ranks[leftRoot] += 1
  }
  for (let fromIndex = 0; fromIndex < nodeCount; fromIndex += 1) {
    for (let edgeIndex = edgeOffsets[fromIndex]; edgeIndex < edgeOffsets[fromIndex + 1]; edgeIndex += 1) {
      union(fromIndex, edgeTargets[edgeIndex])
    }
  }

  const componentByNode = new Int32Array(nodeCount)
  const reciprocalEdgeFlags = new Uint8Array(edgeTargets.length)
  const componentByRoot = new Map()
  const componentLengthKm = []
  let componentCount = 0
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const root = find(nodeIndex)
    let component = componentByRoot.get(root)
    if (component === undefined) {
      component = componentCount
      componentByRoot.set(root, component)
      componentLengthKm.push(0)
      componentCount += 1
    }
    componentByNode[nodeIndex] = component
  }
  for (let fromIndex = 0; fromIndex < nodeCount; fromIndex += 1) {
    const component = componentByNode[fromIndex]
    for (let edgeIndex = edgeOffsets[fromIndex]; edgeIndex < edgeOffsets[fromIndex + 1]; edgeIndex += 1) {
      const toIndex = edgeTargets[edgeIndex]
      if (
        fromIndex > toIndex
        && markAcceleratorReciprocalEdges(
          edgeOffsets,
          edgeTargets,
          reciprocalEdgeFlags,
          edgeIndex,
          toIndex,
          fromIndex,
        )
      ) continue
      if (fromIndex === toIndex) reciprocalEdgeFlags[edgeIndex] = 1
      componentLengthKm[component] += edgeDistances[edgeIndex] / 1000
    }
  }

  return {
    componentByNode,
    componentLengthKm: Float64Array.from(componentLengthKm),
    componentCount,
    reciprocalEdgeFlags,
  }
}

function buildAcceleratorReverseIndex(edgeOffsets, edgeTargets, nodeCount) {
  const reverseOffsets = new Uint32Array(nodeCount + 1)
  for (let edgeIndex = 0; edgeIndex < edgeTargets.length; edgeIndex += 1) {
    reverseOffsets[edgeTargets[edgeIndex] + 1] += 1
  }
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    reverseOffsets[nodeIndex + 1] += reverseOffsets[nodeIndex]
  }
  const reverseCursors = reverseOffsets.slice(0, nodeCount)
  const reverseSources = new Uint32Array(edgeTargets.length)
  const reverseEdgeIndices = new Uint32Array(edgeTargets.length)
  for (let fromIndex = 0; fromIndex < nodeCount; fromIndex += 1) {
    for (let edgeIndex = edgeOffsets[fromIndex]; edgeIndex < edgeOffsets[fromIndex + 1]; edgeIndex += 1) {
      const targetIndex = edgeTargets[edgeIndex]
      const cursor = reverseCursors[targetIndex]
      reverseSources[cursor] = fromIndex
      reverseEdgeIndices[cursor] = edgeIndex
      reverseCursors[targetIndex] += 1
    }
  }
  return {
    reverseOffsets,
    reverseSources,
    reverseEdgeIndices,
  }
}

const streetAcceleratorSnapshotArrays = [
  ['nodeLats', Float64Array],
  ['nodeLons', Float64Array],
  ['edgeOffsets', Uint32Array],
  ['edgeTargets', Uint32Array],
  ['edgeDistances', Float64Array],
  ['spatialOffsets', Uint32Array],
  ['componentByNode', Int32Array],
  ['componentLengthKm', Float64Array],
  ['reverseOffsets', Uint32Array],
  ['reverseSources', Uint32Array],
  ['reverseEdgeIndices', Uint32Array],
  ['reciprocalEdgeFlags', Uint8Array],
]

function streetAcceleratorSnapshotPath(storePath) {
  return `${storePath}${streetAcceleratorSnapshotSuffix}`
}

function removeObsoleteStreetAcceleratorSnapshots(storePath) {
  for (let version = 1; version < streetAcceleratorSnapshotVersion; version += 1) {
    try { fsSync.unlinkSync(`${storePath}.street-accelerator-v${version}.bin`) } catch {}
  }
}

function streetAcceleratorStoreIdentity(state) {
  return {
    identityVersion: 'source-metadata-v1',
    schemaVersion: state.metadata.schemaVersion ?? null,
    sourceFingerprint: state.metadata.sourceFingerprint ?? null,
    sourceBytes: state.metadata.sourceBytes ?? null,
    metadataNodeCount: state.metadata.nodeCount ?? null,
    metadataEdgeCount: state.metadata.edgeCount ?? null,
  }
}

function streetAcceleratorIdentityMatches(headerIdentity, state) {
  const expected = streetAcceleratorStoreIdentity(state)
  return Object.entries(expected).every(([key, value]) => headerIdentity?.[key] === value)
}

function alignSnapshotOffset(offset, byteAlignment) {
  return Math.ceil(offset / byteAlignment) * byteAlignment
}

function createRuntimeAccelerator(data, diagnostics = {}) {
  return {
    ...data,
    buildMs: diagnostics.buildMs ?? 0,
    loadMs: diagnostics.loadMs ?? 0,
    snapshotWriteMs: diagnostics.snapshotWriteMs ?? 0,
    source: diagnostics.source ?? 'built',
    snapshotBuffer: diagnostics.snapshotBuffer,
    queryCount: 0,
    queryMs: 0,
    settledNodes: 0,
    relaxedEdges: 0,
  }
}

function writeBufferAt(fd, buffer, position) {
  let cursor = 0
  while (cursor < buffer.length) {
    const written = fsSync.writeSync(fd, buffer, cursor, buffer.length - cursor, position + cursor)
    if (!written) throw new Error('Street accelerator snapshot write made no progress.')
    cursor += written
  }
}

function persistStreetAccelerator(state, accelerator) {
  const startedAt = performance.now()
  const snapshotPath = streetAcceleratorSnapshotPath(state.storePath)
  const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`
  let fd
  try {
    let nextOffset = streetAcceleratorSnapshotHeaderBytes
    const arrays = {}
    for (const [name, Type] of streetAcceleratorSnapshotArrays) {
      const value = accelerator[name]
      if (!(value instanceof Type)) throw new Error(`Street accelerator snapshot is missing ${name}.`)
      nextOffset = alignSnapshotOffset(nextOffset, Type.BYTES_PER_ELEMENT)
      arrays[name] = { type: Type.name, offset: nextOffset, length: value.length }
      nextOffset += value.byteLength
    }
    const header = {
      magic: streetAcceleratorSnapshotMagic,
      version: streetAcceleratorSnapshotVersion,
      identity: streetAcceleratorStoreIdentity(state),
      nodeCount: accelerator.nodeCount,
      edgeCount: accelerator.edgeCount,
      spatialMinLat: accelerator.spatialMinLat,
      spatialMinLon: accelerator.spatialMinLon,
      spatialCellDegrees: accelerator.spatialCellDegrees,
      spatialRows: accelerator.spatialRows,
      spatialColumns: accelerator.spatialColumns,
      spatialNodeOrder: accelerator.spatialNodeOrder,
      componentCount: accelerator.componentCount,
      arrays,
      byteLength: nextOffset,
    }
    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8')
    if (encodedHeader.length > streetAcceleratorSnapshotHeaderBytes) throw new Error('Street accelerator snapshot header exceeds its reserved space.')
    const headerBuffer = Buffer.alloc(streetAcceleratorSnapshotHeaderBytes, 0x20)
    encodedHeader.copy(headerBuffer)
    fd = fsSync.openSync(temporaryPath, 'w')
    fsSync.ftruncateSync(fd, nextOffset)
    writeBufferAt(fd, headerBuffer, 0)
    for (const [name] of streetAcceleratorSnapshotArrays) {
      const descriptor = arrays[name]
      const value = accelerator[name]
      writeBufferAt(fd, Buffer.from(value.buffer, value.byteOffset, value.byteLength), descriptor.offset)
    }
    fsSync.fsyncSync(fd)
    fsSync.closeSync(fd)
    fd = undefined
    fsSync.renameSync(temporaryPath, snapshotPath)
    removeObsoleteStreetAcceleratorSnapshots(state.storePath)
    state.acceleratorSnapshotStatus = 'written'
    state.acceleratorSnapshotError = ''
    accelerator.snapshotWriteMs = Number((performance.now() - startedAt).toFixed(3))
    return true
  } catch (error) {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd) } catch {}
    }
    try { fsSync.unlinkSync(temporaryPath) } catch {}
    state.acceleratorSnapshotStatus = 'write_error'
    state.acceleratorSnapshotError = error instanceof Error ? error.message : String(error)
    return false
  }
}

function snapshotTypedArray(buffer, descriptor, Type) {
  if (!descriptor || descriptor.type !== Type.name || !Number.isInteger(descriptor.offset) || !Number.isInteger(descriptor.length)) {
    throw new Error(`Street accelerator snapshot has an invalid ${Type.name} descriptor.`)
  }
  const byteLength = descriptor.length * Type.BYTES_PER_ELEMENT
  if (descriptor.offset < streetAcceleratorSnapshotHeaderBytes || descriptor.offset + byteLength > buffer.byteLength) {
    throw new Error('Street accelerator snapshot array exceeds the file boundary.')
  }
  const byteOffset = buffer.byteOffset + descriptor.offset
  if (byteOffset % Type.BYTES_PER_ELEMENT) throw new Error('Street accelerator snapshot array is misaligned.')
  return new Type(buffer.buffer, byteOffset, descriptor.length)
}

function loadStreetAcceleratorSnapshot(state) {
  const startedAt = performance.now()
  const snapshotPath = streetAcceleratorSnapshotPath(state.storePath)
  try {
    const snapshotBuffer = fsSync.readFileSync(snapshotPath)
    if (snapshotBuffer.byteLength < streetAcceleratorSnapshotHeaderBytes) throw new Error('Street accelerator snapshot is truncated.')
    const header = JSON.parse(snapshotBuffer.subarray(0, streetAcceleratorSnapshotHeaderBytes).toString('utf8').trim())
    if (header.magic !== streetAcceleratorSnapshotMagic || header.version !== streetAcceleratorSnapshotVersion) {
      throw new Error('Street accelerator snapshot version is unsupported.')
    }
    if (!streetAcceleratorIdentityMatches(header.identity, state)) {
      state.acceleratorSnapshotStatus = 'stale'
      return null
    }
    if (header.byteLength !== snapshotBuffer.byteLength) throw new Error('Street accelerator snapshot length does not match its header.')
    const data = {
      nodeCount: Number(header.nodeCount),
      edgeCount: Number(header.edgeCount),
      spatialMinLat: Number(header.spatialMinLat),
      spatialMinLon: Number(header.spatialMinLon),
      spatialCellDegrees: Number(header.spatialCellDegrees),
      spatialRows: Number(header.spatialRows),
      spatialColumns: Number(header.spatialColumns),
      spatialNodeOrder: String(header.spatialNodeOrder ?? ''),
      componentCount: Number(header.componentCount),
    }
    for (const [name, Type] of streetAcceleratorSnapshotArrays) data[name] = snapshotTypedArray(snapshotBuffer, header.arrays?.[name], Type)
    if (
      data.nodeLats.length !== data.nodeCount
      || data.nodeLons.length !== data.nodeCount
      || data.edgeOffsets.length !== data.nodeCount + 1
      || data.edgeTargets.length !== data.edgeCount
      || data.edgeDistances.length !== data.edgeCount
      || data.spatialOffsets.length !== data.spatialRows * data.spatialColumns + 1
      || data.componentByNode.length !== data.nodeCount
      || data.componentLengthKm.length !== data.componentCount
      || data.reverseOffsets.length !== data.nodeCount + 1
      || data.reverseSources.length !== data.edgeCount
      || data.reverseEdgeIndices.length !== data.edgeCount
      || data.reciprocalEdgeFlags.length !== data.edgeCount
      || data.edgeOffsets[data.nodeCount] !== data.edgeCount
      || data.spatialOffsets[data.spatialOffsets.length - 1] !== data.nodeCount
      || data.reverseOffsets[data.nodeCount] !== data.edgeCount
      || data.spatialNodeOrder !== 'cell_then_source_node_id'
    ) throw new Error('Street accelerator snapshot topology is inconsistent.')
    const loadMs = Number((performance.now() - startedAt).toFixed(3))
    state.acceleratorSnapshotStatus = 'loaded'
    state.acceleratorSnapshotError = ''
    state.accelerator = createRuntimeAccelerator(data, { source: 'snapshot', loadMs, snapshotBuffer })
    return state.accelerator
  } catch (error) {
    if (error?.code === 'ENOENT') {
      state.acceleratorSnapshotStatus = 'missing'
      state.acceleratorSnapshotError = ''
    } else {
      state.acceleratorSnapshotStatus = 'load_error'
      state.acceleratorSnapshotError = error instanceof Error ? error.message : String(error)
    }
    return null
  }
}

function buildStreetAccelerator(state, force = false, persist = true) {
  if (state.accelerator) return state.accelerator
  if (
    (
      !state.acceleratorEligibility.eligible
      || state.acceleratorEligibility.automaticBuildEligible === false
    )
    && !force
  ) return null
  if (state.invalidated || state.acceleratorBuilding) return null
  const startedAt = performance.now()
  state.acceleratorBuilding = true
  try {
    const nodeCount = Number(state.db.prepare('SELECT COUNT(*) AS count FROM walk_nodes').get().count)
    const expectedEdgeCapacity = state.acceleratorEligibility.edgeCount
      || Number(state.db.prepare('SELECT COUNT(*) AS count FROM edges').get().count)
    let sourceNodeIds = new Float64Array(nodeCount)
    let sourceNodeLats = new Float64Array(nodeCount)
    let sourceNodeLons = new Float64Array(nodeCount)
    let nodeCursor = 0
    for (const node of state.db.prepare('SELECT node_id,lat,lon FROM walk_nodes ORDER BY node_id').iterate()) {
      sourceNodeIds[nodeCursor] = node.node_id
      sourceNodeLats[nodeCursor] = node.lat
      sourceNodeLons[nodeCursor] = node.lon
      nodeCursor += 1
    }
    if (nodeCursor !== nodeCount) throw new Error(`Street accelerator read ${nodeCursor} of ${nodeCount} walk nodes.`)
    const spatialNodes = spatiallyOrderStreetAcceleratorNodes(
      sourceNodeIds,
      sourceNodeLats,
      sourceNodeLons,
    )
    sourceNodeIds = null
    sourceNodeLats = null
    sourceNodeLons = null
    const { nodeIds, nodeLats, nodeLons } = spatialNodes
    let nodeIndexById = new Map()
    for (let nodeIndex = 0; nodeIndex < nodeIds.length; nodeIndex += 1) {
      nodeIndexById.set(nodeIds[nodeIndex], nodeIndex)
    }
    const edgeOffsets = new Uint32Array(nodeCount + 1)
    let validEdgeCount = 0
    for (const edge of state.db.prepare('SELECT from_node,to_node,distance_m FROM edges ORDER BY from_node,to_node').iterate()) {
      const fromIndex = nodeIndexById.get(edge.from_node)
      const toIndex = nodeIndexById.get(edge.to_node)
      if (fromIndex === undefined || toIndex === undefined) continue
      edgeOffsets[fromIndex + 1] += 1
      validEdgeCount += 1
    }
    if (validEdgeCount > expectedEdgeCapacity) {
      throw new Error('Street accelerator edge metadata under-reported the graph size.')
    }
    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
      edgeOffsets[nodeIndex + 1] += edgeOffsets[nodeIndex]
    }
    const edgeTargets = new Uint32Array(validEdgeCount)
    const edgeDistances = new Float64Array(validEdgeCount)
    const edgeCursors = edgeOffsets.slice(0, nodeCount)
    let edgeCursor = 0
    for (const edge of state.db.prepare('SELECT from_node,to_node,distance_m FROM edges ORDER BY from_node,to_node').iterate()) {
      const fromIndex = nodeIndexById.get(edge.from_node)
      const toIndex = nodeIndexById.get(edge.to_node)
      if (fromIndex === undefined || toIndex === undefined) continue
      const cursor = edgeCursors[fromIndex]
      edgeTargets[cursor] = toIndex
      edgeDistances[cursor] = edge.distance_m
      edgeCursors[fromIndex] += 1
      edgeCursor += 1
    }
    nodeIndexById.clear()
    if (edgeCursor !== validEdgeCount) throw new Error(`Street accelerator wrote ${edgeCursor} of ${validEdgeCount} walk edges.`)
    const componentIndex = buildAcceleratorComponentIndex(
      edgeOffsets,
      edgeTargets,
      edgeDistances,
      nodeCount,
    )
    const reverseIndex = buildAcceleratorReverseIndex(edgeOffsets, edgeTargets, nodeCount)
    const accelerator = createRuntimeAccelerator({
      nodeIds,
      nodeLats,
      nodeLons,
      edgeOffsets,
      edgeTargets,
      edgeDistances,
      ...spatialNodes,
      ...componentIndex,
      ...reverseIndex,
      nodeCount,
      edgeCount: validEdgeCount,
    }, { buildMs: Number((performance.now() - startedAt).toFixed(3)), source: 'built' })
    state.accelerator = accelerator
    state.acceleratorError = ''
    if (persist) persistStreetAccelerator(state, accelerator)
    return accelerator
  } catch (error) {
    state.acceleratorError = error instanceof Error ? error.message : String(error)
    return null
  } finally {
    state.acceleratorBuilding = false
  }
}

const driveAcceleratorSnapshotArrays = [
  ['nodeLats', Float64Array],
  ['nodeLons', Float64Array],
  ['edgeOffsets', Uint32Array],
  ['edgeTargets', Uint32Array],
  ['edgeDistanceUnits', Uint32Array],
  ['edgeTimeUnits', Uint32Array],
  ['spatialOffsets', Uint32Array],
  ['spatialNodeIndices', Uint32Array],
]

function driveAcceleratorSnapshotPath(storePath) {
  return `${storePath}${driveAcceleratorSnapshotSuffix}`
}

function driveAcceleratorStoreIdentity(state) {
  return {
    identityVersion: 'source-metadata-v1',
    schemaVersion: state.metadata.schemaVersion ?? null,
    sourceFingerprint: state.metadata.sourceFingerprint ?? null,
    driveNodeCount: state.metadata.driveNodeCount ?? null,
    driveEdgeCount: state.metadata.driveEdgeCount ?? null,
    drivingWeightModel: state.metadata.drivingWeightModel ?? null,
  }
}

function createRuntimeDriveAccelerator(data, diagnostics = {}) {
  // The shared node table includes walk-only vertices. Driving snaps must
  // touch a drive edge; retain incoming-only endpoints of one-way roads too.
  const driveNodeMask = new Uint8Array(data.nodeCount)
  for (let index = 0; index < data.nodeCount; index += 1) {
    if (data.edgeOffsets[index] < data.edgeOffsets[index + 1]) driveNodeMask[index] = 1
  }
  for (const target of data.edgeTargets) driveNodeMask[target] = 1
  return {
    ...data,
    driveNodeMask,
    buildMs: diagnostics.buildMs ?? 0,
    loadMs: diagnostics.loadMs ?? 0,
    snapshotWriteMs: diagnostics.snapshotWriteMs ?? 0,
    source: diagnostics.source ?? 'built',
    snapshotPath: diagnostics.snapshotPath,
    snapshotBuffer: diagnostics.snapshotBuffer,
    queryCount: 0,
    queryMs: 0,
    settledNodes: 0,
    relaxedEdges: 0,
  }
}

function driveFixedPointValue(value, unitsPerValue, label) {
  const scaled = Math.round(Number(value) * unitsPerValue)
  if (!Number.isFinite(scaled) || scaled < 0 || scaled >= 0xffff_ffff) {
    throw new Error(`${label} exceeds the exact fixed-point drive domain.`)
  }
  return scaled
}

function driveFixedPointUnits(values, unitsPerValue, label) {
  const units = new Uint32Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    units[index] = driveFixedPointValue(values[index], unitsPerValue, label)
  }
  return units
}

function persistDriveAccelerator(state, accelerator) {
  const startedAt = performance.now()
  const snapshotPath = driveAcceleratorSnapshotPath(state.storePath)
  const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`
  let fd
  try {
    const snapshotData = {
      ...accelerator,
      edgeDistanceUnits: accelerator.edgeDistanceUnits
        ?? driveFixedPointUnits(accelerator.edgeDistances, driveDistanceUnitsPerMeter, 'Drive edge distance'),
      edgeTimeUnits: accelerator.edgeTimeUnits
        ?? driveFixedPointUnits(accelerator.edgeTravelTimes, driveTimeUnitsPerSecond, 'Drive edge travel time'),
    }
    let nextOffset = driveAcceleratorSnapshotHeaderBytes
    const arrays = {}
    for (const [name, Type] of driveAcceleratorSnapshotArrays) {
      const value = snapshotData[name]
      if (!(value instanceof Type)) throw new Error(`Drive accelerator snapshot is missing ${name}.`)
      nextOffset = alignSnapshotOffset(nextOffset, Type.BYTES_PER_ELEMENT)
      arrays[name] = { type: Type.name, offset: nextOffset, length: value.length }
      nextOffset += value.byteLength
    }
    const header = {
      magic: driveAcceleratorSnapshotMagic,
      version: driveAcceleratorSnapshotVersion,
      identity: driveAcceleratorStoreIdentity(state),
      nodeCount: accelerator.nodeCount,
      edgeCount: accelerator.edgeCount,
      spatialMinLat: accelerator.spatialMinLat,
      spatialMinLon: accelerator.spatialMinLon,
      spatialCellDegrees: accelerator.spatialCellDegrees,
      spatialRows: accelerator.spatialRows,
      spatialColumns: accelerator.spatialColumns,
      arrays,
      byteLength: nextOffset,
    }
    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8')
    if (encodedHeader.length > driveAcceleratorSnapshotHeaderBytes) throw new Error('Drive accelerator snapshot header exceeds its reserved space.')
    const headerBuffer = Buffer.alloc(driveAcceleratorSnapshotHeaderBytes, 0x20)
    encodedHeader.copy(headerBuffer)
    fd = fsSync.openSync(temporaryPath, 'w')
    fsSync.ftruncateSync(fd, nextOffset)
    writeBufferAt(fd, headerBuffer, 0)
    for (const [name] of driveAcceleratorSnapshotArrays) {
      const descriptor = arrays[name]
      const value = snapshotData[name]
      writeBufferAt(fd, Buffer.from(value.buffer, value.byteOffset, value.byteLength), descriptor.offset)
    }
    fsSync.fsyncSync(fd)
    fsSync.closeSync(fd)
    fd = undefined
    fsSync.renameSync(temporaryPath, snapshotPath)
    state.driveAcceleratorSnapshotStatus = 'written'
    state.driveAcceleratorSnapshotError = ''
    accelerator.snapshotWriteMs = Number((performance.now() - startedAt).toFixed(3))
    accelerator.snapshotPath = snapshotPath
    return true
  } catch (error) {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd) } catch {}
    }
    try { fsSync.unlinkSync(temporaryPath) } catch {}
    state.driveAcceleratorSnapshotStatus = 'write_error'
    state.driveAcceleratorSnapshotError = error instanceof Error ? error.message : String(error)
    return false
  }
}

function loadDriveAcceleratorSnapshot(state) {
  const startedAt = performance.now()
  const snapshotPath = driveAcceleratorSnapshotPath(state.storePath)
  try {
    const snapshotBuffer = fsSync.readFileSync(snapshotPath)
    if (snapshotBuffer.byteLength < driveAcceleratorSnapshotHeaderBytes) throw new Error('Drive accelerator snapshot is truncated.')
    const header = JSON.parse(snapshotBuffer.subarray(0, driveAcceleratorSnapshotHeaderBytes).toString('utf8').trim())
    if (header.magic !== driveAcceleratorSnapshotMagic || header.version !== driveAcceleratorSnapshotVersion) {
      throw new Error('Drive accelerator snapshot version is unsupported.')
    }
    if (JSON.stringify(header.identity) !== JSON.stringify(driveAcceleratorStoreIdentity(state))) {
      state.driveAcceleratorSnapshotStatus = 'stale'
      return null
    }
    if (header.byteLength !== snapshotBuffer.byteLength) throw new Error('Drive accelerator snapshot length does not match its header.')
    const data = {
      nodeCount: Number(header.nodeCount),
      edgeCount: Number(header.edgeCount),
      spatialMinLat: Number(header.spatialMinLat),
      spatialMinLon: Number(header.spatialMinLon),
      spatialCellDegrees: Number(header.spatialCellDegrees),
      spatialRows: Number(header.spatialRows),
      spatialColumns: Number(header.spatialColumns),
    }
    for (const [name, Type] of driveAcceleratorSnapshotArrays) {
      data[name] = snapshotTypedArray(snapshotBuffer, header.arrays?.[name], Type)
    }
    if (
      data.nodeLats.length !== data.nodeCount
      || data.nodeLons.length !== data.nodeCount
      || data.edgeOffsets.length !== data.nodeCount + 1
      || data.edgeTargets.length !== data.edgeCount
      || data.edgeDistanceUnits.length !== data.edgeCount
      || data.edgeTimeUnits.length !== data.edgeCount
      || data.spatialNodeIndices.length !== data.nodeCount
      || data.spatialOffsets.length !== data.spatialRows * data.spatialColumns + 1
      || data.edgeOffsets[data.nodeCount] !== data.edgeCount
      || data.spatialOffsets[data.spatialOffsets.length - 1] !== data.nodeCount
    ) throw new Error('Drive accelerator snapshot topology is inconsistent.')
    const loadMs = Number((performance.now() - startedAt).toFixed(3))
    state.driveAcceleratorSnapshotStatus = 'loaded'
    state.driveAcceleratorSnapshotError = ''
    state.driveAccelerator = createRuntimeDriveAccelerator(data, {
      source: 'snapshot',
      loadMs,
      snapshotPath,
      snapshotBuffer,
    })
    return state.driveAccelerator
  } catch (error) {
    if (error?.code === 'ENOENT') {
      state.driveAcceleratorSnapshotStatus = 'missing'
      state.driveAcceleratorSnapshotError = ''
    } else {
      state.driveAcceleratorSnapshotStatus = 'load_error'
      state.driveAcceleratorSnapshotError = error instanceof Error ? error.message : String(error)
    }
    return null
  }
}

function buildDriveAccelerator(state, { force = false, persist = true } = {}) {
  if (state.driveAccelerator) return state.driveAccelerator
  if (state.runtimeSnapshotOnly) {
    state.driveAcceleratorError = 'The runtime street store contains snapshots only; rebuild the drive snapshot instead of querying SQLite.'
    return null
  }
  if ((!state.driveAcceleratorEligibility.eligible && !force) || state.invalidated || state.driveAcceleratorBuilding) return null
  const startedAt = performance.now()
  state.driveAcceleratorBuilding = true
  try {
    // The current source layout keeps coordinates for drive-only nodes in
    // drive_nodes and shares the much larger pedestrian-node table for every
    // other driving vertex. Reconstruct that one directed vertex set only
    // while building the compact drive snapshot.
    const driveNodeSourceSql = '(SELECT node_id,lat,lon FROM walk_nodes UNION ALL SELECT node_id,lat,lon FROM drive_nodes)'
    const nodeCount = Number(state.metadata.driveNodeCount ?? state.db.prepare(
      `SELECT COUNT(*) AS count FROM ${driveNodeSourceSql}`,
    ).get().count)
    const edgeCapacity = Number(state.db.prepare('SELECT COUNT(*) AS count FROM drive_edges').get().count)
    const nodeLats = new Float64Array(nodeCount)
    const nodeLons = new Float64Array(nodeCount)
    const nodeIndexById = new Map()
    let nodeCursor = 0
    for (const node of state.db.prepare(
      `SELECT node_id,lat,lon FROM ${driveNodeSourceSql} ORDER BY node_id`,
    ).iterate()) {
      nodeLats[nodeCursor] = node.lat
      nodeLons[nodeCursor] = node.lon
      nodeIndexById.set(node.node_id, nodeCursor)
      nodeCursor += 1
    }
    if (nodeCursor !== nodeCount) throw new Error(`Drive accelerator read ${nodeCursor} of ${nodeCount} nodes.`)

    const edgeOffsets = new Uint32Array(nodeCount + 1)
    const edgeTargets = new Uint32Array(edgeCapacity)
    // Keep the importer in the same compact representation that the Rust
    // drive kernel consumes. Avoid retaining a second pair of float arrays
    // only to quantize them again when writing the v2 snapshot.
    const edgeDistanceUnits = new Uint32Array(edgeCapacity)
    const edgeTimeUnits = new Uint32Array(edgeCapacity)
    let edgeCursor = 0
    let nextOffsetIndex = 0
    for (const edge of state.db.prepare('SELECT from_node,to_node,distance_m,travel_time_s FROM drive_edges ORDER BY from_node').iterate()) {
      const fromIndex = nodeIndexById.get(edge.from_node)
      const toIndex = nodeIndexById.get(edge.to_node)
      if (fromIndex === undefined || toIndex === undefined) continue
      while (nextOffsetIndex <= fromIndex) {
        edgeOffsets[nextOffsetIndex] = edgeCursor
        nextOffsetIndex += 1
      }
      if (edgeCursor >= edgeTargets.length) throw new Error('Drive accelerator edge metadata under-reported the graph size.')
      edgeTargets[edgeCursor] = toIndex
      edgeDistanceUnits[edgeCursor] = driveFixedPointValue(
        edge.distance_m,
        driveDistanceUnitsPerMeter,
        'Drive edge distance',
      )
      edgeTimeUnits[edgeCursor] = driveFixedPointValue(
        edge.travel_time_s,
        driveTimeUnitsPerSecond,
        'Drive edge travel time',
      )
      edgeCursor += 1
    }
    while (nextOffsetIndex <= nodeCount) {
      edgeOffsets[nextOffsetIndex] = edgeCursor
      nextOffsetIndex += 1
    }
    nodeIndexById.clear()
    const spatialIndex = buildAcceleratorSpatialIndex(nodeLats, nodeLons)
    const accelerator = createRuntimeDriveAccelerator({
      nodeLats,
      nodeLons,
      edgeOffsets,
      edgeTargets: edgeCursor === edgeTargets.length ? edgeTargets : edgeTargets.slice(0, edgeCursor),
      edgeDistanceUnits: edgeCursor === edgeDistanceUnits.length
        ? edgeDistanceUnits
        : edgeDistanceUnits.slice(0, edgeCursor),
      edgeTimeUnits: edgeCursor === edgeTimeUnits.length
        ? edgeTimeUnits
        : edgeTimeUnits.slice(0, edgeCursor),
      ...spatialIndex,
      nodeCount,
      edgeCount: edgeCursor,
    }, { buildMs: Number((performance.now() - startedAt).toFixed(3)), source: 'built' })
    state.driveAccelerator = accelerator
    state.driveAcceleratorError = ''
    if (persist) persistDriveAccelerator(state, accelerator)
    return accelerator
  } catch (error) {
    state.driveAcceleratorError = error instanceof Error ? error.message : String(error)
    return null
  } finally {
    state.driveAcceleratorBuilding = false
  }
}

function driveIndexesPresent(storePath) {
  const db = new DatabaseSync(path.resolve(storePath), { readOnly: true })
  try {
    const expected = Object.keys(drivingStoreIndexTables)
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE type='index' AND name IN (${expected.map(() => '?').join(',')})
    `).get(...expected)
    return Number(row?.count ?? 0) === expected.length
  } finally {
    db.close()
  }
}

function ensureNationalOsmDriveIndexes(storePath) {
  const resolvedPath = path.resolve(storePath)
  if (driveIndexesPresent(resolvedPath)) return { built: false, ready: true }
  // A cached read-only connection can keep the SQLite file open while the
  // deferred indexes are created. Close it before taking the write lock.
  invalidateStreetStore(resolvedPath)
  const db = new DatabaseSync(resolvedPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec(`
      CREATE INDEX IF NOT EXISTS drive_edges_from ON drive_edges(from_node);
      ANALYZE;
    `)
    const metadataUpdated = db.prepare(
      "UPDATE metadata SET value=? WHERE key='driveIndexState'",
    ).run(JSON.stringify('ready'))
    if (Number(metadataUpdated?.changes ?? 0) === 0) {
      db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(
        'driveIndexState',
        JSON.stringify('ready'),
      )
    }
    db.exec('COMMIT')
    return { built: true, ready: true }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    db.close()
  }
}

function prepareNationalOsmDriveProfile(state, storePath, options, startedAt) {
  if (!state.drivingProfileAvailable) {
    return {
      ready: false,
      accelerated: false,
      reason: 'driving_profile_unavailable',
      prepareMs: Number((performance.now() - startedAt).toFixed(3)),
      nodeCount: 0,
      edgeCount: 0,
    }
  }
  if (!state.driveAccelerator && state.driveAcceleratorSnapshotStatus === 'not_checked') {
    loadDriveAcceleratorSnapshot(state)
  }
  const accelerator = buildDriveAccelerator(state, {
    force: options.force === true,
    persist: options.persist !== false,
  })
  const nativeDriveKernel = accelerator && options.prepareNative !== false
    ? prepareNativeDriveKernel(accelerator, {
        persistCch: state.metadata.driveCchPersistence !== 'ephemeral',
      })
    : null
  return {
    ready: Boolean(accelerator),
    accelerated: Boolean(accelerator),
    reason: accelerator ? 'ready' : state.driveAcceleratorEligibility.reason,
    prepareMs: Number((performance.now() - startedAt).toFixed(3)),
    buildMs: accelerator?.buildMs ?? 0,
    loadMs: accelerator?.loadMs ?? 0,
    nativeConfigureMs: timingMilliseconds(nativeDriveKernel?.configureMs),
    nativeCch: nativeDriveKernel?.diagnostics,
    snapshotWriteMs: accelerator?.snapshotWriteMs ?? 0,
    source: accelerator?.source,
    snapshotStatus: state.driveAcceleratorSnapshotStatus,
    snapshotPath: driveAcceleratorSnapshotPath(storePath),
    nodeCount: accelerator?.nodeCount ?? state.driveAcceleratorEligibility.nodeCount,
    edgeCount: accelerator?.edgeCount ?? state.driveAcceleratorEligibility.edgeCount,
    error: state.driveAcceleratorError || undefined,
  }
}

/** Build the drive snapshot from the compiler-only source graph. */
export function buildNationalOsmDriveStore(storePath, options = {}) {
  const startedAt = performance.now()
  let state = openSourceStreetStore(storePath)
  if (options.ensureIndexes !== false) {
    ensureNationalOsmDriveIndexes(storePath)
    state = openSourceStreetStore(storePath)
  }
  return prepareNationalOsmDriveProfile(state, storePath, options, startedAt)
}

/** Prepare the sealed drive snapshot and its in-memory query accelerator. */
export function prepareNationalOsmDriveStore(storePath, options = {}) {
  const startedAt = performance.now()
  const state = openRuntimeStreetStore(storePath)
  return prepareNationalOsmDriveProfile(state, storePath, options, startedAt)
}

/** Build the pedestrian snapshot from the compiler-only source graph. */
export function buildNationalOsmWalkStore(storePath, options = {}) {
  const startedAt = performance.now()
  const state = openSourceStreetStore(storePath)
  const accelerator = buildStreetAccelerator(state, options.force === true, options.persist !== false)
  return {
    ready: Boolean(accelerator),
    accelerated: Boolean(accelerator),
    reason: accelerator
      ? 'ready'
      : state.acceleratorEligibility.eligible
        && state.acceleratorEligibility.automaticBuildEligible === false
        ? 'large_snapshot_required'
      : state.acceleratorEligibility.reason,
    prepareMs: Number((performance.now() - startedAt).toFixed(3)),
    buildMs: accelerator?.buildMs ?? 0,
    loadMs: accelerator?.loadMs ?? 0,
    snapshotWriteMs: accelerator?.snapshotWriteMs ?? 0,
    source: accelerator?.source,
    snapshotStatus: state.acceleratorSnapshotStatus,
    snapshotPath: streetAcceleratorSnapshotPath(storePath),
    storeAdmission: state.admission,
    nodeCount: accelerator?.nodeCount ?? 0,
    edgeCount: accelerator?.edgeCount ?? state.acceleratorEligibility.edgeCount,
    storeBytes: state.acceleratorEligibility.storeBytes,
    error: state.acceleratorError || undefined,
  }
}

function coordinateInsideBounds(longitude, latitude, bounds) {
  return longitude >= bounds.west
    && longitude <= bounds.east
    && latitude >= bounds.south
    && latitude <= bounds.north
}

function snapshotNodeIndicesInBounds(accelerator, bounds) {
  if (!accelerator?.spatialOffsets?.length) return []
  const minRow = Math.max(
    0,
    Math.floor((bounds.south - accelerator.spatialMinLat) / accelerator.spatialCellDegrees),
  )
  const maxRow = Math.min(
    accelerator.spatialRows - 1,
    Math.floor((bounds.north - accelerator.spatialMinLat) / accelerator.spatialCellDegrees),
  )
  const minColumn = Math.max(
    0,
    Math.floor((bounds.west - accelerator.spatialMinLon) / accelerator.spatialCellDegrees),
  )
  const maxColumn = Math.min(
    accelerator.spatialColumns - 1,
    Math.floor((bounds.east - accelerator.spatialMinLon) / accelerator.spatialCellDegrees),
  )
  if (maxRow < minRow || maxColumn < minColumn) return []
  const nodeIndices = []
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const cell = row * accelerator.spatialColumns + column
      const start = accelerator.spatialOffsets[cell]
      const end = accelerator.spatialOffsets[cell + 1]
      for (let cursor = start; cursor < end; cursor += 1) {
        const nodeIndex = accelerator.spatialNodeIndices[cursor]
        if (coordinateInsideBounds(accelerator.nodeLons[nodeIndex], accelerator.nodeLats[nodeIndex], bounds)) {
          nodeIndices.push(nodeIndex)
        }
      }
    }
  }
  return nodeIndices
}

function runtimeStreetGeometryFromAccelerator(accelerator, bounds, limit) {
  const fromNodes = snapshotNodeIndicesInBounds(accelerator, bounds)
  const features = []
  const seenSegments = new Set()
  for (const fromNode of fromNodes) {
    if (features.length >= limit) break
    for (
      let edgeIndex = accelerator.edgeOffsets[fromNode];
      edgeIndex < accelerator.edgeOffsets[fromNode + 1] && features.length < limit;
      edgeIndex += 1
    ) {
      const toNode = accelerator.edgeTargets[edgeIndex]
      if (
        fromNode === toNode
        || !coordinateInsideBounds(accelerator.nodeLons[toNode], accelerator.nodeLats[toNode], bounds)
      ) continue
      const segmentKey = fromNode < toNode
        ? `${fromNode}:${toNode}`
        : `${toNode}:${fromNode}`
      if (seenSegments.has(segmentKey)) continue
      seenSegments.add(segmentKey)
      features.push({
        type: 'Feature',
        properties: {
          // Runtime snapshots intentionally omit source OSM way ids. The
          // edge ordinal is stable for this immutable snapshot and is all
          // the map renderer needs for a local street line.
          wayId: null,
          edgeIndex,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [accelerator.nodeLons[fromNode], accelerator.nodeLats[fromNode]],
            [accelerator.nodeLons[toNode], accelerator.nodeLats[toNode]],
          ],
        },
      })
    }
  }
  return features
}

/** Read local street lines from the sealed pedestrian snapshot. */
export function readNationalOsmStreetGeometry(storePath, bounds, options = {}) {
  const state = openRuntimeStreetStore(storePath)
  const accelerator = state.accelerator ?? loadStreetAcceleratorSnapshot(state)
  const limit = Math.max(1, Math.min(16_000, Math.floor(Number(options.limit) || 12_000)))
  const features = runtimeStreetGeometryFromAccelerator(accelerator, bounds, limit) ?? []
  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      source: 'local-osm-street-snapshot',
      storageLayout: runtimeStreetStoreStorageLayout,
      bbox: bounds,
      edgeCount: features.length,
      sampled: features.length >= limit,
    },
  }
}

/**
 * Read directed driving geometry from the sealed v2 drive snapshot. The
 * runtime snapshot intentionally omits source OSM way ids and road classes;
 * immutable edge ordinals are sufficient for geometry-based service analysis
 * and avoid retaining the raw drive graph in the published store.
 */
export function readNationalOsmDriveGeometry(storePath, bounds) {
  const state = openRuntimeStreetStore(storePath)
  const normalizedBounds = {
    west: Number(bounds?.west),
    south: Number(bounds?.south),
    east: Number(bounds?.east),
    north: Number(bounds?.north),
  }
  if (
    !Object.values(normalizedBounds).every(Number.isFinite)
    || normalizedBounds.east < normalizedBounds.west
    || normalizedBounds.north < normalizedBounds.south
  ) {
    throw new TypeError('Driving geometry requires finite ordered bounds.')
  }
  const accelerator = state.driveAccelerator ?? loadDriveAcceleratorSnapshot(state)
  if (!accelerator) {
    const error = new Error(
      `The sealed street store has no readable drive snapshot for ${path.resolve(storePath)}. Rebuild the OpenStreetMap street index.`,
    )
    error.code = 'VIGO_DRIVE_SNAPSHOT_REQUIRED'
    throw error
  }
  const fromNodes = snapshotNodeIndicesInBounds(accelerator, normalizedBounds)
  const rows = []
  for (const fromNode of fromNodes) {
    for (
      let edgeIndex = accelerator.edgeOffsets[fromNode];
      edgeIndex < accelerator.edgeOffsets[fromNode + 1];
      edgeIndex += 1
    ) {
      const toNode = accelerator.edgeTargets[edgeIndex]
      if (
        toNode === fromNode
        || !coordinateInsideBounds(accelerator.nodeLons[toNode], accelerator.nodeLats[toNode], normalizedBounds)
      ) continue
      rows.push({
        edgeIndex,
        wayId: null,
        fromNode,
        toNode,
        roadClass: null,
        fromLon: Number(accelerator.nodeLons[fromNode]),
        fromLat: Number(accelerator.nodeLats[fromNode]),
        toLon: Number(accelerator.nodeLons[toNode]),
        toLat: Number(accelerator.nodeLats[toNode]),
      })
    }
  }
  return {
    rows,
    metadata: {
      sourceFingerprint: state.metadata.sourceFingerprint ?? null,
      storageLayout: runtimeStreetStoreStorageLayout,
      snapshotVersion: driveAcceleratorSnapshotVersion,
    },
  }
}

function coordinateSampleKey(lon, lat) {
  return `${Number(lon).toFixed(7)},${Number(lat).toFixed(7)}`
}

function sampleRandom(seed) {
  let state = Number(seed) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Iterate the authoritative pedestrian-node representation for a source or
 * runtime store. Import diagnostics use `walk_nodes`; published consumers use
 * the immutable v7 accelerator arrays.
 *
 * Runtime snapshots do not retain isolated nodes because they cannot
 * contribute to a walk path. Set `includeDisconnected` only for diagnostics
 * that explicitly need the complete coordinate population.
 */
function forEachNationalOsmWalkNode(storePath, callback, options = {}) {
  if (typeof callback !== 'function') throw new TypeError('OSM walk-node iteration requires a callback.')
  const state = openDiagnosticStreetStore(storePath)
  const bounds = options.bounds
    && Number.isFinite(Number(options.bounds.west))
    && Number.isFinite(Number(options.bounds.south))
    && Number.isFinite(Number(options.bounds.east))
    && Number.isFinite(Number(options.bounds.north))
    ? {
        west: Number(options.bounds.west),
        south: Number(options.bounds.south),
        east: Number(options.bounds.east),
        north: Number(options.bounds.north),
      }
    : null
  const includeDisconnected = options.includeDisconnected === true
  let visitedNodes = 0
  const visit = (node) => {
    const lat = Number(node.lat)
    const lon = Number(node.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    if (bounds && !coordinateInsideBounds(lon, lat, bounds)) return
    visitedNodes += 1
    callback({
      ...node,
      lat,
      lon,
    })
  }

  if (state.runtimeSnapshotOnly) {
    const accelerator = state.accelerator ?? loadStreetAcceleratorSnapshot(state)
    if (!accelerator) {
      throw new Error(`OSM runtime snapshot is unavailable for ${path.resolve(storePath)}.`)
    }
    const nodeCount = Number(accelerator.nodeCount ?? accelerator.nodeLats.length)
    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
      if (!includeDisconnected) {
        const hasOutgoing = accelerator.edgeOffsets[nodeIndex] < accelerator.edgeOffsets[nodeIndex + 1]
        const hasIncoming = accelerator.reverseOffsets[nodeIndex] < accelerator.reverseOffsets[nodeIndex + 1]
        if (!hasOutgoing && !hasIncoming) continue
      }
      visit({
        nodeKey: `snapshot:${nodeIndex}`,
        nodeIndex,
        lat: accelerator.nodeLats[nodeIndex],
        lon: accelerator.nodeLons[nodeIndex],
      })
    }
    return {
      sourceTable: 'street-accelerator-v7',
      walkNodeCount: nodeCount,
      visitedNodes,
    }
  }

  const walkNodeCount = Number(state.db.prepare(
    'SELECT COUNT(*) AS count FROM walk_nodes',
  ).get()?.count ?? 0)
  const query = bounds
    ? state.db.prepare(`
        SELECT node_id,lat,lon FROM walk_nodes
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
        ORDER BY node_id
      `)
    : state.db.prepare('SELECT node_id,lat,lon FROM walk_nodes ORDER BY node_id')
  const rows = bounds
    ? query.iterate(bounds.south, bounds.north, bounds.west, bounds.east)
    : query.iterate()
  for (const node of rows) {
    visit({
      nodeKey: `osm:${node.node_id}`,
      osmNodeId: node.node_id,
      lat: node.lat,
      lon: node.lon,
    })
  }
  return {
    sourceTable: 'walk_nodes',
    walkNodeCount,
    visitedNodes,
  }
}

/**
 * Resolve an endpoint identity through the source/runtime diagnostics adapter.
 * Runtime snapshots carry dense `nodeIndex` identities; source stores carry
 * durable `osmNodeId` values.
 */
export function readNationalOsmWalkNodeCoordinate(storePath, endpoint = {}) {
  const state = openDiagnosticStreetStore(storePath)
  if (state.runtimeSnapshotOnly) {
    const nodeIndex = Number(endpoint.nodeIndex)
    const accelerator = state.accelerator ?? loadStreetAcceleratorSnapshot(state)
    if (!accelerator || !Number.isSafeInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= accelerator.nodeCount) {
      return null
    }
    return {
      lon: Number(accelerator.nodeLons[nodeIndex]),
      lat: Number(accelerator.nodeLats[nodeIndex]),
    }
  }
  if (endpoint.osmNodeId === undefined || endpoint.osmNodeId === null) return null
  const row = state.db.prepare('SELECT lon,lat FROM walk_nodes WHERE node_id=?').get(String(endpoint.osmNodeId))
  return row
    ? { lon: Number(row.lon), lat: Number(row.lat) }
    : null
}

/**
 * Sample usable pedestrian graph coordinates without hydrating a runtime
 * snapshot into a second JavaScript graph. Source stores use `walk_nodes`;
 * runtime stores use the memory-mappable v7 accelerator arrays.
 */
export function sampleNationalOsmWalkNodes(storePath, options = {}) {
  const endpointCount = Math.max(1, Math.floor(Number(options.endpointCount) || 2))
  const seed = Number(options.seed) >>> 0
  const excludedCoordinates = options.excludedCoordinates instanceof Set
    ? options.excludedCoordinates
    : new Set(options.excludedCoordinates ?? [])
  const random = sampleRandom(seed)
  const selected = []
  let eligibleNodes = 0
  let skippedExcludedCoordinates = 0
  const consider = ({ nodeKey, osmNodeId = null, nodeIndex = null, lat, lon }) => {
    const numericLat = Number(lat)
    const numericLon = Number(lon)
    if (!Number.isFinite(numericLat) || !Number.isFinite(numericLon)) return
    if (excludedCoordinates.has(coordinateSampleKey(numericLon, numericLat))) {
      skippedExcludedCoordinates += 1
      return
    }
    const endpoint = {
      nodeKey: String(nodeKey),
      ...(osmNodeId == null ? {} : { osmNodeId: String(osmNodeId) }),
      ...(nodeIndex == null ? {} : { nodeIndex: Number(nodeIndex) }),
      lon: numericLon,
      lat: numericLat,
    }
    eligibleNodes += 1
    if (selected.length < endpointCount) {
      selected.push(endpoint)
      return
    }
    const replacement = Math.floor(random() * eligibleNodes)
    if (replacement < endpointCount) selected[replacement] = endpoint
  }

  const iteration = forEachNationalOsmWalkNode(storePath, consider, {
    bounds: options.bounds,
  })
  if (selected.length < endpointCount) {
    throw new Error(`Only ${selected.length}/${endpointCount} usable OSM endpoints were available in ${iteration.sourceTable}.`)
  }
  selected.sort((left, right) => left.nodeKey.localeCompare(right.nodeKey))
  return {
    sourceTable: iteration.sourceTable,
    seed,
    requestedEndpoints: endpointCount,
    endpoints: selected,
    population: {
      walkNodeCount: iteration.walkNodeCount,
      eligibleNodes,
      skippedExcludedCoordinates,
    },
  }
}

/**
 * Admit the authoritative SQLite store without hydrating the JavaScript graph,
 * then memory-map its immutable accelerator in the Rust Node-API kernel.
 * Coordinate transit workers use this path so the same street snapshot is not
 * retained once by V8 and again by native code.
 */
export function prepareNationalOsmNativeStore(storePath) {
  const startedAt = performance.now()
  const resolvedPath = path.resolve(storePath)
  let db
  try {
    db = new DatabaseSync(resolvedPath, { readOnly: true })
    const metadata = readStreetStoreMetadata(db, resolvedPath)
    admitStreetStoreVersion(resolvedPath, metadata)
    if (metadata.storageLayout !== runtimeStreetStoreStorageLayout) {
      throw streetStoreAdmissionError(
        resolvedPath,
        'runtime_layout_required',
        `Native routing preparation requires the sealed ${runtimeStreetStoreStorageLayout} layout.`,
      )
    }
    const { admission } = admitRuntimeSnapshotStore(db, resolvedPath, metadata, startedAt)
    const native = prepareNativeRoutingKernel(resolvedPath)
    return {
      ...native,
      reason: 'ready',
      prepareMs: Number((performance.now() - startedAt).toFixed(3)),
      storeAdmission: admission,
      storeBytes: fsSync.statSync(resolvedPath).size,
    }
  } catch (error) {
    if (error?.code === 'VIGO_STREET_STORE_ADMISSION_FAILED') throw error
    return {
      ready: false,
      accelerated: false,
      reason: error?.code === 'VIGO_NATIVE_STREET_SNAPSHOT_REQUIRED'
        ? 'native_snapshot_required'
        : 'native_kernel_unavailable',
      prepareMs: Number((performance.now() - startedAt).toFixed(3)),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try { db?.close() } catch {}
  }
}

export function nationalOsmStoreDiagnostics(storePath) {
  const state = openDiagnosticStreetStore(storePath)
  const accelerator = state.accelerator
  const driveAccelerator = state.driveAccelerator
  return {
    sourceModel: state.sourceModel,
    storeAdmission: state.admission,
    sourceFingerprint: state.metadata.sourceFingerprint ?? null,
    directionMetadataPresent: [
      'directionRestrictedWayCount',
      'directionExcludedWayCount',
      'uncertainConveyingWayCount',
    ].every((key) => Object.hasOwn(state.metadata, key)),
    directionRestrictedWayCount: Number(state.metadata.directionRestrictedWayCount ?? 0),
    directionExcludedWayCount: Number(state.metadata.directionExcludedWayCount ?? 0),
    uncertainConveyingWayCount: Number(state.metadata.uncertainConveyingWayCount ?? 0),
    eligible: state.acceleratorEligibility.eligible,
    reason: accelerator
      ? 'ready'
      : state.acceleratorEligibility.eligible
        && state.acceleratorEligibility.automaticBuildEligible === false
        ? 'large_snapshot_required'
        : state.acceleratorEligibility.reason,
    accelerated: Boolean(accelerator),
    building: state.acceleratorBuilding,
    error: state.acceleratorError || undefined,
    storeBytes: state.acceleratorEligibility.storeBytes,
    nodeCount: accelerator?.nodeCount ?? 0,
    edgeCount: accelerator?.edgeCount ?? state.acceleratorEligibility.edgeCount,
    buildMs: accelerator?.buildMs ?? 0,
    loadMs: accelerator?.loadMs ?? 0,
    snapshotWriteMs: accelerator?.snapshotWriteMs ?? 0,
    source: accelerator?.source,
    snapshotStatus: state.acceleratorSnapshotStatus,
    snapshotError: state.acceleratorSnapshotError || undefined,
    snapshotPath: streetAcceleratorSnapshotPath(storePath),
    queryCount: accelerator?.queryCount ?? 0,
    queryMs: timingMilliseconds(accelerator?.queryMs),
    settledNodes: accelerator?.settledNodes ?? 0,
    relaxedEdges: accelerator?.relaxedEdges ?? 0,
    driveAccelerator: {
      eligible: state.driveAcceleratorEligibility.eligible,
      reason: driveAccelerator ? 'ready' : state.driveAcceleratorEligibility.reason,
      accelerated: Boolean(driveAccelerator),
      building: state.driveAcceleratorBuilding,
      error: state.driveAcceleratorError || undefined,
      nodeCount: driveAccelerator?.nodeCount ?? state.driveAcceleratorEligibility.nodeCount,
      edgeCount: driveAccelerator?.edgeCount ?? state.driveAcceleratorEligibility.edgeCount,
      buildMs: driveAccelerator?.buildMs ?? 0,
      loadMs: driveAccelerator?.loadMs ?? 0,
      snapshotWriteMs: driveAccelerator?.snapshotWriteMs ?? 0,
      source: driveAccelerator?.source,
      snapshotStatus: state.driveAcceleratorSnapshotStatus,
      snapshotError: state.driveAcceleratorSnapshotError || undefined,
      snapshotPath: driveAcceleratorSnapshotPath(storePath),
      queryCount: driveAccelerator?.queryCount ?? 0,
      queryMs: timingMilliseconds(driveAccelerator?.queryMs),
      settledNodes: driveAccelerator?.settledNodes ?? 0,
      relaxedEdges: driveAccelerator?.relaxedEdges ?? 0,
    },
    openStoreCache: {
      entries: streetStoreCache.size,
      maxEntries: streetStoreCacheMaximumEntries,
    },
  }
}

const streetStoreCache = new Map()

function invalidateStreetStore(storePath) {
  const resolvedPath = path.resolve(storePath)
  const cached = streetStoreCache.get(resolvedPath)
  if (!cached) return
  cached.invalidated = true
  try { cached.db.close() } catch {}
  cached.accelerator = null
  cached.driveAccelerator = null
  streetStoreCache.delete(resolvedPath)
}

export function disposeNationalOsmStore(storePath) {
  disposeNativeRoutingKernel(storePath)
  invalidateStreetStore(storePath)
}

/**
 * Seal a built OSM graph into the runtime representation. The importer and
 * all graph-dependent preprocessing run against the normalized SQLite graph;
 * the published workspace retains only bounded metadata plus the current walk
 * and drive snapshots. Drive routing remains available, but its CCH is built
 * in memory on demand so the immutable runtime does not pay for a second copy
 * of the drive topology on disk.
 */
export function compactNationalOsmRuntimeStore(storePath, options = {}) {
  const resolvedPath = path.resolve(storePath)
  const beforeBytes = fsSync.statSync(resolvedPath).size
  let drivePreparation = null
  const metadataBefore = (() => {
    const database = new DatabaseSync(resolvedPath, { readOnly: true })
    try { return admitDiagnosticStreetStore(database, resolvedPath).metadata } finally { database.close() }
  })()
  if (metadataBefore.storageLayout === runtimeStreetStoreStorageLayout) {
    return {
      ready: true,
      built: false,
      storageLayout: runtimeStreetStoreStorageLayout,
      beforeBytes,
      afterBytes: beforeBytes,
      bytesSaved: 0,
      drive: { ready: true, source: 'snapshot' },
    }
  }
  if (Number(metadataBefore.driveEdgeCount ?? 0) > 0) {
    drivePreparation = buildNationalOsmDriveStore(resolvedPath, {
      force: options.forceDrive === true,
      prepareNative: false,
      persist: true,
      ensureIndexes: false,
    })
    if (!drivePreparation.ready && options.requireDrive !== false) {
      throw new Error(`Drive snapshot could not be prepared before OSM compaction: ${drivePreparation.error ?? drivePreparation.reason}`)
    }
  }

  // No source-side connection or native kernel may survive publication of the
  // sealed file. Runtime callers will reopen the one immutable snapshot.
  disposeNationalOsmStore(resolvedPath)
  const database = new DatabaseSync(resolvedPath)
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      DROP INDEX IF EXISTS walk_nodes_lat_lon;
      DROP INDEX IF EXISTS edges_from;
      DROP INDEX IF EXISTS drive_edges_from;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS drive_edges;
      DROP TABLE IF EXISTS walk_nodes;
      DROP TABLE IF EXISTS drive_nodes;
      DROP TABLE IF EXISTS nodes;
    `)
    const setMetadata = database.prepare(`
      INSERT INTO metadata(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `)
    setMetadata.run('storageLayout', JSON.stringify(runtimeStreetStoreStorageLayout))
    setMetadata.run('driveIndexState', JSON.stringify('snapshot'))
    setMetadata.run('driveNodeStorage', JSON.stringify('snapshot-only-v1'))
    setMetadata.run('driveCchPersistence', JSON.stringify('ephemeral'))
    setMetadata.run('runtimeSnapshotVersion', JSON.stringify({ walk: streetAcceleratorSnapshotVersion, drive: driveAcceleratorSnapshotVersion }))
    database.exec('COMMIT')
    database.exec('VACUUM')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    database.close()
  }
  const afterBytes = fsSync.statSync(resolvedPath).size
  return {
    ready: true,
    built: true,
    storageLayout: runtimeStreetStoreStorageLayout,
    beforeBytes,
    afterBytes,
    bytesSaved: beforeBytes - afterBytes,
    drive: drivePreparation ?? { ready: false, reason: 'no_drive_edges' },
  }
}

function streetStoreAdmissionError(storePath, reason, detail) {
  const error = new Error([
    `Street store admission failed for ${storePath}: ${detail}`,
    `Expected the current ${streetStoreSchemaVersion} SQLite street store with sourceModel="pbf".`,
    'Rebuild the street index from the source OSM PBF instead of modifying it in place.',
  ].join(' '))
  error.code = 'VIGO_STREET_STORE_ADMISSION_FAILED'
  error.reason = reason
  error.storePath = storePath
  return error
}

function validateStoreObjects(db, storePath, tableNames, indexTables, detail = 'store') {
  const indexNames = Object.keys(indexTables)
  const objectNames = [...tableNames, ...indexNames]
  const schemaRows = db.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_schema
    WHERE name IN (${objectNames.map(() => '?').join(',')})
  `).all(...objectNames)
  const schemaByName = new Map(schemaRows.map((row) => [String(row.name), row]))
  for (const tableName of tableNames) {
    const object = schemaByName.get(tableName)
    if (!object || object.type !== 'table' || object.tbl_name !== tableName) {
      throw streetStoreAdmissionError(
        storePath,
        'required_table_missing',
        `Required ${detail} table "${tableName}" is missing.`,
      )
    }
  }
  for (const [indexName, tableName] of Object.entries(indexTables)) {
    const object = schemaByName.get(indexName)
    if (!object || object.type !== 'index' || object.tbl_name !== tableName) {
      throw streetStoreAdmissionError(
        storePath,
        'required_index_missing',
        `Required ${detail} index "${indexName}" is missing.`,
      )
    }
  }
}

function readStreetStoreMetadata(db, storePath) {
  try {
    return Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map((row) => {
      try {
        return [row.key, JSON.parse(row.value)]
      } catch {
        return [row.key, row.value]
      }
    }))
  } catch (error) {
    if (error?.code === 'VIGO_STREET_STORE_ADMISSION_FAILED') throw error
    throw streetStoreAdmissionError(
      storePath,
      'metadata_unreadable',
      `SQLite could not read metadata (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
}

export function readNationalOsmStoreMetadata(storePath) {
  const resolvedPath = path.resolve(storePath)
  const database = new DatabaseSync(resolvedPath, { readOnly: true })
  try {
    const metadata = readStreetStoreMetadata(database, resolvedPath)
    admitStreetStoreVersion(resolvedPath, metadata)
    return metadata
  } finally {
    database.close()
  }
}

function admitStreetStoreVersion(storePath, metadata) {
  if (metadata.schemaVersion !== streetStoreSchemaVersion) {
    throw streetStoreAdmissionError(
      storePath,
      'schema_version_mismatch',
      `metadata.schemaVersion is ${JSON.stringify(metadata.schemaVersion)}.`,
    )
  }
  if (metadata.sourceModel !== 'pbf') {
    throw streetStoreAdmissionError(
      storePath,
      'source_model_mismatch',
      `metadata.sourceModel is ${JSON.stringify(metadata.sourceModel)}.`,
    )
  }
}

function admitRuntimeSnapshotStore(db, storePath, metadata, startedAt) {
  validateStoreObjects(db, storePath, ['metadata'], {}, 'runtime')
  admitStreetStoreVersion(storePath, metadata)
  const walkSnapshotPath = streetAcceleratorSnapshotPath(storePath)
  if (!fsSync.existsSync(walkSnapshotPath)) {
    throw streetStoreAdmissionError(
      storePath,
      'walk_snapshot_missing',
      `The runtime layout requires ${walkSnapshotPath}.`,
    )
  }
  const driveSnapshotRequired = Number(metadata.driveNodeCount ?? 0) > 0 && Number(metadata.driveEdgeCount ?? 0) > 0
  if (driveSnapshotRequired && !fsSync.existsSync(driveAcceleratorSnapshotPath(storePath))) {
    throw streetStoreAdmissionError(
      storePath,
      'drive_snapshot_missing',
      `The runtime layout requires ${driveAcceleratorSnapshotPath(storePath)} for drive and Reach queries.`,
    )
  }
  return {
    metadata,
    admission: Object.freeze({
      status: 'admitted',
      schemaVersion: metadata.schemaVersion,
      sourceModel: 'pbf',
      storageLayout: runtimeStreetStoreStorageLayout,
      runtimeSnapshotOnly: true,
      requiredTableCount: 1,
      requiredIndexCount: 0,
      metadataRows: Object.keys(metadata).length,
      admissionMs: Number((performance.now() - startedAt).toFixed(3)),
      integrityScan: 'not_run_on_open',
      authoritativeConnection: 'read_only',
    }),
  }
}

function admitSourceStreetStore(db, storePath, metadata, startedAt) {
  admitStreetStoreVersion(storePath, metadata)
  if (metadata.storageLayout !== 'walk-drive-role-tables-v2') {
    throw streetStoreAdmissionError(
      storePath,
      'storage_layout_mismatch',
      `metadata.storageLayout must be "walk-drive-role-tables-v2" before runtime compaction.`,
    )
  }
  const deferredDriveIndexes = metadata.driveIndexState === 'deferred'
  const tableNames = streetStoreTableNames
  const indexTables = deferredDriveIndexes
    ? streetStoreIndexTables
    : { ...streetStoreIndexTables, ...drivingStoreIndexTables }
  validateStoreObjects(db, storePath, [
    ...tableNames,
    ...drivingStoreTableNames,
  ], indexTables)

  return {
    metadata,
    admission: Object.freeze({
      status: 'admitted',
      schemaVersion: metadata.schemaVersion,
      sourceModel: 'pbf',
      requiredTableCount: tableNames.length + drivingStoreTableNames.length,
      requiredIndexCount: Object.keys(indexTables).length,
      metadataRows: Object.keys(metadata).length,
      admissionMs: Number((performance.now() - startedAt).toFixed(3)),
      integrityScan: 'not_run_on_open',
      authoritativeConnection: 'read_only',
    }),
  }
}

function admitDiagnosticStreetStore(db, storePath) {
  const startedAt = performance.now()
  const metadata = readStreetStoreMetadata(db, storePath)
  return metadata.storageLayout === runtimeStreetStoreStorageLayout
    ? admitRuntimeSnapshotStore(db, storePath, metadata, startedAt)
    : admitSourceStreetStore(db, storePath, metadata, startedAt)
}

function streetStoreStorageIdentity(storePath) {
  const stat = fsSync.statSync(storePath, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
}

function openStreetStoreWithAdmission(storePath, admissionFunction, requiredLayout = 'diagnostic') {
  const resolvedPath = path.resolve(storePath)
  let storageIdentity
  try {
    storageIdentity = streetStoreStorageIdentity(resolvedPath)
  } catch (error) {
    throw streetStoreAdmissionError(
      resolvedPath,
      'sqlite_open_failed',
      `SQLite could not stat the authoritative file (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  const cached = streetStoreCache.get(resolvedPath)
  if (cached?.storageIdentity === storageIdentity) {
    if (requiredLayout === 'runtime' && !cached.runtimeSnapshotOnly) {
      throw runtimeStreetStoreError(resolvedPath, 'Runtime street-store access')
    }
    if (requiredLayout === 'source' && cached.runtimeSnapshotOnly) {
      throw sourceStreetStoreError(resolvedPath, 'Source street-store access')
    }
    streetStoreCache.delete(resolvedPath)
    streetStoreCache.set(resolvedPath, cached)
    return cached
  }
  if (cached) invalidateStreetStore(resolvedPath)
  let db
  try {
    try {
      db = new DatabaseSync(resolvedPath, { readOnly: true })
    } catch (error) {
      throw streetStoreAdmissionError(
        resolvedPath,
        'sqlite_open_failed',
        `SQLite could not open the authoritative file read-only (${error instanceof Error ? error.message : String(error)}).`,
      )
    }
    const { metadata, admission } = admissionFunction(db, resolvedPath)
    db.exec(`PRAGMA mmap_size=${readOnlySqliteMmapBytes}; PRAGMA cache_size=-${readOnlySqliteCacheKiB};`)
    const runtimeSnapshotOnly = metadata.storageLayout === runtimeStreetStoreStorageLayout
    const drivingProfileAvailable = metadata.schemaVersion === streetStoreSchemaVersion
      && (!runtimeSnapshotOnly || fsSync.existsSync(driveAcceleratorSnapshotPath(resolvedPath)))
    const state = {
      db,
      storePath: resolvedPath,
      storageIdentity,
      metadata,
      admission,
      sourceModel: 'pbf',
      drivingProfileAvailable,
      runtimeSnapshotOnly,
      accelerator: null,
      acceleratorBuilding: false,
      acceleratorError: '',
      acceleratorSnapshotStatus: 'not_checked',
      acceleratorSnapshotError: '',
      driveAccelerator: null,
      driveAcceleratorBuilding: false,
      driveAcceleratorError: '',
      driveAcceleratorSnapshotStatus: 'not_checked',
      driveAcceleratorSnapshotError: '',
      invalidated: false,
      acceleratorEligibility: acceleratorEligibility(resolvedPath, metadata),
      driveAcceleratorEligibility: driveAcceleratorEligibility(metadata),
    }
    // Drive is a separate, optional profile. Do not fault its snapshot into a
    // transit/walk worker merely because the authoritative store contains
    // driving rows; the first drive request materializes it below.
    while (streetStoreCache.size >= streetStoreCacheMaximumEntries) {
      const oldestStorePath = streetStoreCache.keys().next().value
      if (oldestStorePath === undefined) break
      invalidateStreetStore(oldestStorePath)
    }
    streetStoreCache.set(resolvedPath, state)
    return state
  } catch (error) {
    try { db.close() } catch {}
    if (error?.code === 'VIGO_STREET_STORE_ADMISSION_FAILED') throw error
    throw streetStoreAdmissionError(
      resolvedPath,
      'schema_unreadable',
      `SQLite could not prepare the current street schema (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
}

function openSourceStreetStore(storePath) {
  return openStreetStoreWithAdmission(
    storePath,
    (db, resolvedPath) => {
      const startedAt = performance.now()
      const metadata = readStreetStoreMetadata(db, resolvedPath)
      if (metadata.storageLayout === runtimeStreetStoreStorageLayout) {
        throw sourceStreetStoreError(resolvedPath, 'Source street-store access')
      }
      return admitSourceStreetStore(db, resolvedPath, metadata, startedAt)
    },
    'source',
  )
}

function openRuntimeStreetStore(storePath) {
  return openStreetStoreWithAdmission(
    storePath,
    (db, resolvedPath) => {
      const startedAt = performance.now()
      const metadata = readStreetStoreMetadata(db, resolvedPath)
      if (metadata.storageLayout !== runtimeStreetStoreStorageLayout) {
        throw runtimeStreetStoreError(resolvedPath, 'Runtime street-store access')
      }
      return admitRuntimeSnapshotStore(db, resolvedPath, metadata, startedAt)
    },
    'runtime',
  )
}

function openDiagnosticStreetStore(storePath) {
  return openStreetStoreWithAdmission(storePath, admitDiagnosticStreetStore)
}

function sourceStreetStoreError(storePath, operation) {
  const error = new Error(
    `${operation} requires the compiler-only walk-drive-role-tables-v2 street store at ${path.resolve(storePath)}.`,
  )
  error.code = 'VIGO_SOURCE_STREET_STORE_REQUIRED'
  error.reason = 'source_layout_required'
  error.storePath = path.resolve(storePath)
  return error
}

function runtimeStreetStoreError(storePath, operation) {
  const error = new Error(
    `${operation} requires the sealed ${runtimeStreetStoreStorageLayout} street store at ${path.resolve(storePath)}. Rebuild the OpenStreetMap street index from the source PBF.`,
  )
  error.code = 'VIGO_RUNTIME_STREET_STORE_REQUIRED'
  error.reason = 'runtime_layout_required'
  error.storePath = path.resolve(storePath)
  return error
}

function acceleratedNodesInBounds(accelerator, coordinateValue, maxDistanceKm) {
  if (!accelerator.spatialOffsets?.length) return []
  const latitude = coordinateValue[1]
  const longitude = coordinateValue[0]
  const latDelta = maxDistanceKm / 110.574
  const lonDelta = maxDistanceKm / Math.max(1, 111.32 * Math.cos(latitude * Math.PI / 180))
  const minRow = Math.max(0, Math.floor((latitude - latDelta - accelerator.spatialMinLat) / accelerator.spatialCellDegrees))
  const maxRow = Math.min(accelerator.spatialRows - 1, Math.floor((latitude + latDelta - accelerator.spatialMinLat) / accelerator.spatialCellDegrees))
  const minColumn = Math.max(0, Math.floor((longitude - lonDelta - accelerator.spatialMinLon) / accelerator.spatialCellDegrees))
  const maxColumn = Math.min(accelerator.spatialColumns - 1, Math.floor((longitude + lonDelta - accelerator.spatialMinLon) / accelerator.spatialCellDegrees))
  if (maxRow < minRow || maxColumn < minColumn) return []
  const candidates = []
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const cell = row * accelerator.spatialColumns + column
      const start = accelerator.spatialOffsets[cell]
      const end = accelerator.spatialOffsets[cell + 1]
      for (let cursor = start; cursor < end; cursor += 1) {
        const nodeIndex = accelerator.spatialNodeIndices[cursor]
        const nodeLat = accelerator.nodeLats[nodeIndex]
        const nodeLon = accelerator.nodeLons[nodeIndex]
        if (nodeLat < latitude - latDelta || nodeLat > latitude + latDelta || nodeLon < longitude - lonDelta || nodeLon > longitude + lonDelta) continue
        const distanceKm = haversineKm(coordinateValue, [nodeLon, nodeLat])
        if (distanceKm <= maxDistanceKm) candidates.push({
          // Drive node ids are only used to make the snap shortlist stable;
          // the native kernel addresses the resident graph by compact index.
          // Runtime snapshots intentionally omit the redundant source-id array.
          node_id: accelerator.nodeIds?.[nodeIndex] ?? nodeIndex,
          nodeIndex,
          lat: nodeLat,
          lon: nodeLon,
          distanceKm,
        })
      }
    }
  }
  return candidates
}

export function streetPathBetween(storePath, fromCoordinate, toCoordinate, maxDistanceKm) {
  openRuntimeStreetStore(storePath)
  if (!nativeStreetCchPrepared(storePath)) {
    const error = new Error(
      'Rust pedestrian routing requires the current sealed street CCH index. Rebuild the OSM street index before routing.',
    )
    error.code = 'VIGO_NATIVE_STREET_CCH_REQUIRED'
    throw error
  }
  return routeNativeStreetPath(
    storePath,
    fromCoordinate,
    toCoordinate,
    maxDistanceKm,
  )
}

function driveNodesWithinRadius(state, coordinateValue, radiusKm) {
  if (!state.driveAccelerator) return []
  return acceleratedNodesInBounds(state.driveAccelerator, coordinateValue, radiusKm)
    .filter((node) => state.driveAccelerator.driveNodeMask[node.nodeIndex] && node.distanceKm <= radiusKm)
    .sort((left, right) => left.distanceKm - right.distanceKm || left.node_id - right.node_id)
}

function nearbyDriveNodes(state, coordinateValue, maxSnapKm = 0.35, limit = 6) {
  for (const radiusKm of [0.06, 0.12, maxSnapKm]) {
    const candidates = driveNodesWithinRadius(state, coordinateValue, radiusKm).slice(0, limit)
    if (candidates.length) return candidates
  }
  return []
}

function recoveryDriveNodes(state, coordinateValue) {
  let candidates = []
  for (const radiusKm of driveSnapRecoveryRadiiKm) {
    candidates = driveNodesWithinRadius(state, coordinateValue, radiusKm)
    if (candidates.length >= driveSnapRecoveryCandidatesPerRadius) break
  }
  return candidates.slice(0, driveSnapRecoveryCandidatesPerRadius)
}

function minimumDriveSnapDistanceKm(candidates) {
  return candidates.length
    ? Math.min(...candidates.map((candidate) => candidate.distanceKm))
    : Number.POSITIVE_INFINITY
}

function driveCandidatesForCoordinate(state, coordinateValue) {
  const primary = nearbyDriveNodes(state, coordinateValue, 0.35, 6)
  const recovery = minimumDriveSnapDistanceKm(primary) > driveSnapRecoveryMinimumDistanceKm
  return {
    candidates: recovery ? recoveryDriveNodes(state, coordinateValue) : primary,
    snapRecovery: recovery,
  }
}

function driveTrafficSnapshotError(detail) {
  const error = new Error(`Invalid drive traffic snapshot: ${detail}`)
  error.code = 'VIGO_INVALID_TRAFFIC_SNAPSHOT'
  return error
}

function driveTrafficEpochMilliseconds(value, label) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim()))) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) throw driveTrafficSnapshotError(`${label} is invalid.`)
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
  }
  const parsed = Date.parse(String(value ?? ''))
  if (!Number.isFinite(parsed)) throw driveTrafficSnapshotError(`${label} is invalid.`)
  return parsed
}

function driveTrafficCoordinate(value, label) {
  const coordinate = Array.isArray(value) ? value.map(Number) : []
  if (
    coordinate.length !== 2
    || !coordinate.every(Number.isFinite)
    || coordinate[0] < -180
    || coordinate[0] > 180
    || coordinate[1] < -90
    || coordinate[1] > 90
  ) throw driveTrafficSnapshotError(`${label} must be [longitude, latitude].`)
  return coordinate
}

function driveTrafficObservationCoordinatePairs(observation, observationIndex) {
  if (Array.isArray(observation?.coordinates)) {
    if (observation.coordinates.length < 2 || observation.coordinates.length > 512) {
      throw driveTrafficSnapshotError(`observations[${observationIndex}].coordinates must contain 2 to 512 points.`)
    }
    const coordinates = observation.coordinates.map((coordinate, index) => (
      driveTrafficCoordinate(coordinate, `observations[${observationIndex}].coordinates[${index}]`)
    ))
    return coordinates.slice(1).map((coordinate, index) => [coordinates[index], coordinate])
  }
  if (observation?.fromCoordinate !== undefined || observation?.toCoordinate !== undefined) {
    return [[
      driveTrafficCoordinate(observation.fromCoordinate, `observations[${observationIndex}].fromCoordinate`),
      driveTrafficCoordinate(observation.toCoordinate, `observations[${observationIndex}].toCoordinate`),
    ]]
  }
  return []
}

function matchedDriveTrafficEdge(accelerator, fromCoordinate, toCoordinate, snapRadiusKm) {
  const sources = acceleratedNodesInBounds(accelerator, fromCoordinate, snapRadiusKm)
    .sort((left, right) => left.distanceKm - right.distanceKm || left.nodeIndex - right.nodeIndex)
    .slice(0, 16)
  let best = null
  for (const source of sources) {
    const start = accelerator.edgeOffsets[source.nodeIndex]
    const end = accelerator.edgeOffsets[source.nodeIndex + 1]
    for (let edgeIndex = start; edgeIndex < end; edgeIndex += 1) {
      const targetIndex = accelerator.edgeTargets[edgeIndex]
      const targetDistanceKm = haversineKm(toCoordinate, [
        accelerator.nodeLons[targetIndex],
        accelerator.nodeLats[targetIndex],
      ])
      if (targetDistanceKm > snapRadiusKm) continue
      const scoreKm = source.distanceKm + targetDistanceKm
      if (!best || scoreKm < best.scoreKm || (scoreKm === best.scoreKm && edgeIndex < best.edgeIndex)) {
        best = { edgeIndex, scoreKm }
      }
    }
  }
  return best
}

function driveTrafficObservationMetric(observation, observationIndex) {
  const closed = observation?.closed === true
  const travelTimeSeconds = Number(observation?.travelTimeSeconds)
  const speedKph = Number(observation?.speedKph)
  const factor = Number(observation?.delayFactor ?? observation?.factor ?? observation?.multiplier)
  const supplied = [
    closed,
    Number.isFinite(travelTimeSeconds),
    Number.isFinite(speedKph),
    Number.isFinite(factor),
  ].filter(Boolean).length
  if (supplied !== 1) {
    throw driveTrafficSnapshotError(
      `observations[${observationIndex}] must declare exactly one of closed, travelTimeSeconds, speedKph, or delayFactor.`,
    )
  }
  if (closed) return { type: 'closed' }
  if (Number.isFinite(travelTimeSeconds)) {
    if (travelTimeSeconds <= 0 || travelTimeSeconds > 86_400) {
      throw driveTrafficSnapshotError(`observations[${observationIndex}].travelTimeSeconds is out of range.`)
    }
    return { type: 'travel-time', value: travelTimeSeconds }
  } else if (Number.isFinite(speedKph)) {
    if (speedKph < 1 || speedKph > 200) {
      throw driveTrafficSnapshotError(`observations[${observationIndex}].speedKph is out of range.`)
    }
    return { type: 'speed', value: speedKph }
  }
  if (factor < 1 || factor > 100) {
    throw driveTrafficSnapshotError(`observations[${observationIndex}].delayFactor is out of range.`)
  }
  return { type: 'factor', value: factor }
}

function driveTrafficObservationWeight(accelerator, edgeIndex, metric, observationIndex) {
  if (metric.type === 'closed') return driveTrafficClosedWeight
  const adjustedSeconds = metric.type === 'travel-time'
    ? metric.value
    : metric.type === 'speed'
      ? accelerator.edgeDistanceUnits[edgeIndex] / driveDistanceUnitsPerMeter / (metric.value / 3.6)
      : accelerator.edgeTimeUnits[edgeIndex] / driveTimeUnitsPerSecond * metric.value
  const units = Math.round(adjustedSeconds * driveTimeUnitsPerSecond)
  if (!Number.isFinite(units) || units <= 0 || units >= driveTrafficClosedWeight) {
    throw driveTrafficSnapshotError(`observations[${observationIndex}] exceeds the CCH traffic-time domain.`)
  }
  return Math.max(accelerator.edgeTimeUnits[edgeIndex], units)
}

function normalizeDriveTrafficSnapshot(accelerator, value, streetSourceFingerprint) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw driveTrafficSnapshotError('the snapshot must be an object.')
  }
  const observations = Array.isArray(value.observations)
    ? value.observations
    : Array.isArray(value.segments)
      ? value.segments
      : Array.isArray(value.edgeUpdates)
        ? value.edgeUpdates
        : null
  if (!observations || !observations.length || observations.length > driveTrafficMaximumObservations) {
    throw driveTrafficSnapshotError(`observations must contain 1 to ${driveTrafficMaximumObservations.toLocaleString()} entries.`)
  }
  const observedAtMs = driveTrafficEpochMilliseconds(
    value.observedAt ?? value.fetchedAt ?? value.timestamp,
    'observedAt',
  )
  const nowMs = Date.now()
  if (observedAtMs > nowMs + 60_000) throw driveTrafficSnapshotError('observedAt is in the future.')
  const ttlSeconds = Number(value.ttlSeconds ?? driveTrafficDefaultTtlSeconds)
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > driveTrafficMaximumTtlSeconds) {
    throw driveTrafficSnapshotError(`ttlSeconds must be between 1 and ${driveTrafficMaximumTtlSeconds}.`)
  }
  const expiresAtMs = value.expiresAt === undefined
    ? observedAtMs + ttlSeconds * 1_000
    : driveTrafficEpochMilliseconds(value.expiresAt, 'expiresAt')
  if (expiresAtMs <= observedAtMs) throw driveTrafficSnapshotError('expiresAt must be later than observedAt.')
  if (expiresAtMs - observedAtMs > driveTrafficMaximumTtlSeconds * 1_000) {
    throw driveTrafficSnapshotError(`expiresAt cannot extend more than ${driveTrafficMaximumTtlSeconds} seconds past observedAt.`)
  }
  const snapRadiusKm = Number(value.snapRadiusMeters ?? driveTrafficDefaultSnapRadiusKm * 1_000) / 1_000
  if (!Number.isFinite(snapRadiusKm) || snapRadiusKm <= 0 || snapRadiusKm > driveTrafficMaximumSnapRadiusKm) {
    throw driveTrafficSnapshotError(`snapRadiusMeters must be between 1 and ${driveTrafficMaximumSnapRadiusKm * 1_000}.`)
  }
  const source = String(value.source ?? 'traffic-snapshot').trim().slice(0, 160) || 'traffic-snapshot'
  const snapshotId = String(value.snapshotId ?? value.id ?? '').trim().slice(0, 160) || undefined
  const declaredStreetFingerprint = String(value.streetSourceFingerprint ?? '').trim()
  const base = {
    source,
    snapshotId,
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ageSeconds: Number(Math.max(0, (nowMs - observedAtMs) / 1_000).toFixed(1)),
    observations: observations.length,
  }
  if (nowMs >= expiresAtMs) {
    return {
      ...base,
      status: 'stale_fallback',
      matchedObservations: 0,
      matchedEdges: 0,
      unmatchedObservations: observations.length,
      closedEdges: 0,
      cacheKey: `stale:${observedAtMs}:${expiresAtMs}`,
    }
  }

  const updateByEdge = new Map()
  let matchedObservations = 0
  let closedEdges = 0
  let observationReferences = 0
  for (let observationIndex = 0; observationIndex < observations.length; observationIndex += 1) {
    const observation = observations[observationIndex]
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw driveTrafficSnapshotError(`observations[${observationIndex}] must be an object.`)
    }
    const metric = driveTrafficObservationMetric(observation, observationIndex)
    const directEdges = Array.isArray(observation.edgeIndices)
      ? observation.edgeIndices.map(Number)
      : observation.edgeIndex === undefined
        ? []
        : [Number(observation.edgeIndex)]
    if (directEdges.length > 4_096) {
      throw driveTrafficSnapshotError(`observations[${observationIndex}].edgeIndices exceeds 4,096 entries.`)
    }
    if (directEdges.some((edgeIndex) => !Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= accelerator.edgeCount)) {
      throw driveTrafficSnapshotError(`observations[${observationIndex}] contains an invalid edge index.`)
    }
    if (directEdges.length && (
      !declaredStreetFingerprint
      || !streetSourceFingerprint
      || declaredStreetFingerprint !== streetSourceFingerprint
    )) {
      throw driveTrafficSnapshotError(
        `observations[${observationIndex}] uses edge indices without the current streetSourceFingerprint.`,
      )
    }
    const coordinatePairs = driveTrafficObservationCoordinatePairs(observation, observationIndex)
    if (!directEdges.length && !coordinatePairs.length) {
      throw driveTrafficSnapshotError(`observations[${observationIndex}] must identify at least one directed edge.`)
    }
    observationReferences += directEdges.length + coordinatePairs.length
    if (observationReferences > driveTrafficMaximumEdgeUpdates) {
      throw driveTrafficSnapshotError(`traffic edge references exceed ${driveTrafficMaximumEdgeUpdates.toLocaleString()} entries.`)
    }
    const matchedEdges = new Set(directEdges)
    for (const [fromCoordinate, toCoordinate] of coordinatePairs) {
      const match = matchedDriveTrafficEdge(accelerator, fromCoordinate, toCoordinate, snapRadiusKm)
      if (match) matchedEdges.add(match.edgeIndex)
    }
    if (!matchedEdges.size) continue
    matchedObservations += 1
    for (const edgeIndex of matchedEdges) {
      const weight = driveTrafficObservationWeight(accelerator, edgeIndex, metric, observationIndex)
      const previous = updateByEdge.get(edgeIndex)
      if (previous === undefined || weight > previous) updateByEdge.set(edgeIndex, weight)
      if (updateByEdge.size > driveTrafficMaximumEdgeUpdates) {
        throw driveTrafficSnapshotError(`matched traffic edges exceed ${driveTrafficMaximumEdgeUpdates.toLocaleString()} entries.`)
      }
    }
  }
  const updates = [...updateByEdge]
    .filter(([edgeIndex, weight]) => weight > accelerator.edgeTimeUnits[edgeIndex])
    .sort((left, right) => left[0] - right[0])
  closedEdges = updates.filter(([, weight]) => weight === driveTrafficClosedWeight).length
  if (!updates.length) {
    return {
      ...base,
      status: matchedObservations ? 'free_flow_equivalent' : 'no_matches',
      matchedObservations,
      matchedEdges: updateByEdge.size,
      unmatchedObservations: observations.length - matchedObservations,
      closedEdges: 0,
      cacheKey: `${matchedObservations ? 'free-flow-equivalent' : 'no-matches'}:${observedAtMs}`,
    }
  }
  const snapshotKey = stableKeySuffix(JSON.stringify(updates))
  return {
    ...base,
    status: 'applied',
    mode: 'cch-time-metric',
    snapshotKey,
    matchedObservations,
    matchedEdges: updates.length,
    unmatchedObservations: observations.length - matchedObservations,
    closedEdges,
    cacheKey: `applied:${snapshotKey}:${observedAtMs}:${expiresAtMs}`,
    nativeInput: {
      snapshotKey,
      edgeIndices: updates.map(([edgeIndex]) => edgeIndex),
      edgeTimeUnits: updates.map(([, weight]) => weight),
    },
  }
}

function drivePathCoordinates(state, nodeIndices, fromCoordinate, toCoordinate) {
  if (!nodeIndices.length) return [fromCoordinate, toCoordinate]
  const stride = Math.max(1, Math.ceil(nodeIndices.length / 1_200))
  const sampled = nodeIndices
    .filter((_nodeIndex, index) => index === 0 || index === nodeIndices.length - 1 || index % stride === 0)
    .map((nodeIndex) => [
      state.driveAccelerator.nodeLons[nodeIndex],
      state.driveAccelerator.nodeLats[nodeIndex],
    ])
  return [fromCoordinate, ...sampled, toCoordinate]
}

function nativeDrivePathBetween(state, fromCoordinate, toCoordinate, maxDistanceKm, origins, targets, traffic, roadGeometryOnly = false) {
  const accelerator = state.driveAccelerator
  if (!accelerator) return null
  const startedAt = performance.now()
  const snappedResult = routeNativeDriveExact(accelerator, {
    origins,
    targets,
    maximumDistanceKm: maxDistanceKm,
    traffic: traffic?.nativeInput,
  })
  // Scenario traces move their stops onto the selected road nodes. Query
  // those exact nodes again so both the geometry and its distance/runtime
  // exclude the point-to-road connectors used to choose the initial snaps.
  const result = roadGeometryOnly && snappedResult.status === 'ready' && snappedResult.nodeIndices.length
    ? routeNativeDriveExact(accelerator, {
        origins: [{ nodeIndex: snappedResult.nodeIndices[0], distanceKm: 0 }],
        targets: [{ nodeIndex: snappedResult.nodeIndices.at(-1), distanceKm: 0 }],
        maximumDistanceKm: maxDistanceKm,
        traffic: traffic?.nativeInput,
      })
    : snappedResult
  const searchMs = timingMilliseconds(result.queryMs)
    + (result === snappedResult ? 0 : timingMilliseconds(snappedResult.queryMs))
  const settledNodes = result.settledLabels + (result === snappedResult ? 0 : snappedResult.settledLabels)
  const relaxedEdges = result.relaxedEdges + (result === snappedResult ? 0 : snappedResult.relaxedEdges)
  accelerator.queryCount += result === snappedResult ? 1 : 2
  accelerator.queryMs = timingMilliseconds(accelerator.queryMs) + searchMs
  accelerator.settledNodes += settledNodes
  accelerator.relaxedEdges += relaxedEdges
  return {
    path: result.status !== 'ready'
      ? null
      : {
          distanceKm: result.distanceMeters / 1_000,
          durationSeconds: result.durationSeconds,
          coordinates: roadGeometryOnly
            ? drivePathCoordinates(state, result.nodeIndices, fromCoordinate, toCoordinate).slice(1, -1)
            : drivePathCoordinates(state, result.nodeIndices, fromCoordinate, toCoordinate),
          originSnapDistanceKm: snappedResult.originSnapMeters / 1_000,
          destinationSnapDistanceKm: snappedResult.targetSnapMeters / 1_000,
        },
    settledNodes,
    relaxedEdges,
    searchMs,
    failureCode: result.reason ?? null,
    accelerated: true,
    acceleratorSource: accelerator.source,
    algorithm: result.algorithm,
    cchAccelerated: result.cchAccelerated === true,
    cchSource: result.cchSource,
    cchCandidateQueries: Number(result.cchCandidateQueries ?? 0)
      + (result === snappedResult ? 0 : Number(snappedResult.cchCandidateQueries ?? 0)),
    trafficApplied: result.trafficApplied === true,
    trafficSnapshotKey: result.trafficSnapshotKey,
    trafficUpdatedEdges: result.trafficUpdatedEdges,
    trafficCustomizationMs: normalizeNativeMilliseconds(result.trafficCustomizationNs),
    trafficMetricReused: result.trafficMetricReused === true,
    fastPathMs: normalizeNativeMilliseconds(result.fastPathQueryNs),
    distancePathMs: normalizeNativeMilliseconds(result.distancePathQueryNs),
    fallbackMs: normalizeNativeMilliseconds(result.fallbackQueryNs),
    fallbackUsed: result.fallbackUsed === true,
    generatedLabels: result.generatedLabels,
    dominatedLabels: result.dominatedLabels,
    boundaryMs: Number((performance.now() - startedAt).toFixed(3)),
  }
}

function drivePathBetween(state, fromCoordinate, toCoordinate, maxDistanceKm, traffic, options = {}) {
  const startedAt = performance.now()
  const originCandidates = driveCandidatesForCoordinate(state, fromCoordinate)
  const destinationCandidates = driveCandidatesForCoordinate(state, toCoordinate)
  // A preceding scenario segment has already selected this stop's graph
  // node. Allowing another origin snap here can disconnect the two paths.
  const origins = options.originAtRoadNode
    ? originCandidates.candidates.filter((candidate) => candidate.distanceKm === 0)
    : originCandidates.candidates
  const targets = destinationCandidates.candidates
  const snapRecovery = originCandidates.snapRecovery || destinationCandidates.snapRecovery
  const result = origins.length && targets.length
    ? nativeDrivePathBetween(
      state,
      fromCoordinate,
      toCoordinate,
      maxDistanceKm,
      origins,
      targets,
      traffic,
      options.roadGeometryOnly === true,
    )
    : {
        path: null,
        settledNodes: 0,
        relaxedEdges: 0,
        searchMs: 0,
        failureCode: 'street_snap_failed',
        accelerated: true,
        acceleratorSource: state.driveAccelerator?.source,
      }
  if (snapRecovery) result.snapRecovery = true
  result.queryMs = Number((performance.now() - startedAt).toFixed(3))
  return result
}

function streetRouteSearchDiagnostics(queryMs, search, mode) {
  const normalizedQueryMs = timingMilliseconds(queryMs)
  return {
    queryMs: normalizedQueryMs,
    searchMs: timingMilliseconds(search?.searchMs, normalizedQueryMs),
    settledNodes: search?.settledNodes ?? null,
    relaxedEdges: search?.relaxedEdges ?? null,
    profile: mode,
    accelerated: search?.accelerated === true,
    acceleratorSource: search?.acceleratorSource,
    snapRecovery: search?.snapRecovery === true,
    geometryReversed: search?.geometryReversed === true,
    algorithm: search?.algorithm,
    cchAccelerated: search?.cchAccelerated === true,
    cchSource: search?.cchSource,
    cchCandidateQueries: search?.cchCandidateQueries,
    trafficApplied: search?.trafficApplied === true,
    trafficSnapshotKey: search?.trafficSnapshotKey,
    trafficUpdatedEdges: search?.trafficUpdatedEdges,
    trafficCustomizationMs: timingMilliseconds(search?.trafficCustomizationMs),
    trafficMetricReused: search?.trafficMetricReused === true,
    fastPathMs: timingMilliseconds(search?.fastPathMs),
    distancePathMs: timingMilliseconds(search?.distancePathMs),
    fallbackMs: timingMilliseconds(search?.fallbackMs),
    fallbackUsed: search?.fallbackUsed === true,
  }
}

function blockedStreetRoute(request, failureCode, detail, diagnostics = {}) {
  const mode = request.mode === 'drive' ? 'drive' : 'walk'
  const walkAlgorithm = 'rust_cch_walk_exact'
  return {
    id: `street-${mode}-blocked`,
    status: 'blocked',
    travelMode: mode,
    timePreference: request.timePreference,
    maxWalkKm: mode === 'walk' ? Number(request.maxStreetKm ?? request.maxWalkKm ?? 50) : 0,
    origin: request.origin,
    destination: request.destination,
    title: mode === 'drive' ? 'Driving route unavailable' : 'Walking route unavailable',
    detail,
    departMinutes: request.departMinutes,
    arriveMinutes: null,
    durationMinutes: null,
    waitMinutes: 0,
    walkMinutes: 0,
    rideMinutes: 0,
    transfers: 0,
    legs: [],
    diagnostics: {
      scannedDepartures: 0,
      relaxedStops: 0,
      serviceDay: request.serviceDay ?? 'weekday',
      scheduleMode: 'none',
      walkingNetwork: mode === 'walk' ? 'osm' : 'direct',
      walkingSpeedKph: mode === 'walk' ? Number(request.walkingSpeedKph ?? 4.8) : 0,
      algorithm: mode === 'drive' ? 'rust_cch_drive_certified' : walkAlgorithm,
      weightModel: mode === 'drive' ? 'free_flow_seconds' : 'distance_meters',
      failureCode,
      ...diagnostics,
    },
  }
}

/**
 * Route one first-class walking or driving request over the sealed OSM snapshot.
 * Results are exact for the stored directed graph and selected metric. Driving
 * uses free-flow weights unless a fresh normalized traffic snapshot customizes
 * the resident CCH time metric; turn restrictions remain outside this graph.
 */
export function routeNationalStreetStore(storePath, request) {
  const startedAt = performance.now()
  const mode = request?.mode === 'drive' ? 'drive' : 'walk'
  const timePreference = request?.timePreference === 'arrive' ? 'arrive' : 'depart'
  const requestedMinutes = Number(timePreference === 'arrive'
    ? request.arriveMinutes ?? request.departMinutes ?? 8 * 60
    : request?.departMinutes ?? 8 * 60)
  // Ordered arrive-by legs can start on the preceding day. Street weights
  // are static for this query, so signed service-day minutes preserve that
  // chronology without reversing the directed path or wrapping its clock.
  if (!Number.isFinite(requestedMinutes) || Math.abs(requestedMinutes) > 2_880) {
    throw new Error('Street routing time must be a finite minute in [-2880, 2880].')
  }
  let state = openRuntimeStreetStore(storePath)
  const nativeWalk = mode === 'walk' && nativeStreetCchPrepared(storePath)
  const originCoordinate = request?.origin?.coordinate?.map(Number)
  const destinationCoordinate = request?.destination?.coordinate?.map(Number)
  const normalizedRequest = {
    ...request,
    mode,
    timePreference,
    departMinutes: requestedMinutes,
  }
  if (
    originCoordinate?.length !== 2
    || destinationCoordinate?.length !== 2
    || !originCoordinate.every(Number.isFinite)
    || !destinationCoordinate.every(Number.isFinite)
  ) {
    return blockedStreetRoute(normalizedRequest, 'invalid_coordinates', 'Choose valid origin and destination points.')
  }
  if (mode === 'walk' && !nativeWalk) {
    return blockedStreetRoute(
      normalizedRequest,
      'native_street_cch_required',
      'The Rust pedestrian CCH index is not prepared. Rebuild the OSM street index before routing.',
      {
        searchStats: streetRouteSearchDiagnostics(performance.now() - startedAt, null, mode),
      },
    )
  }
  if (mode === 'drive' && !state.driveAccelerator) {
    const preparedDrive = prepareNationalOsmDriveStore(storePath)
    if (preparedDrive.ready) state = openRuntimeStreetStore(storePath)
  }
  const profileAccelerator = mode === 'drive' ? state.driveAccelerator : nativeWalk
  if (!profileAccelerator) {
    return blockedStreetRoute(
      normalizedRequest,
      'street_accelerator_unavailable',
      `The accelerated ${mode} profile is unavailable. Prepare or rebuild the OpenStreetMap street index.`,
      {
        searchStats: streetRouteSearchDiagnostics(performance.now() - startedAt, null, mode),
      },
    )
  }
  const traffic = mode === 'drive'
    ? normalizeDriveTrafficSnapshot(
        state.driveAccelerator,
        request.trafficSnapshot,
        state.metadata.sourceFingerprint,
      )
    : null
  const trafficDiagnostics = traffic
    ? Object.fromEntries(Object.entries(traffic).filter(([key]) => !['nativeInput', 'cacheKey'].includes(key)))
    : null
  normalizedRequest.trafficCacheKey = traffic?.cacheKey ?? 'free-flow'

  const maxStreetKm = mode === 'drive'
    ? Math.max(0.25, Math.min(1_500, Number(request.maxStreetKm) || 750))
    : Math.max(0.05, Math.min(100, Number(request.maxStreetKm) || 50))
  normalizedRequest.maxStreetKm = maxStreetKm
  let pathResult
  let search
  if (mode === 'drive') {
    search = drivePathBetween(state, originCoordinate, destinationCoordinate, maxStreetKm, traffic, {
      roadGeometryOnly: request.roadGeometryOnly === true,
      originAtRoadNode: request.originAtRoadNode === true,
    })
    pathResult = search.path
  } else if (nativeWalk) {
    pathResult = routeNativeStreetPath(
      storePath,
      originCoordinate,
      destinationCoordinate,
      maxStreetKm,
      800,
    )
    const fallbackSearchMs = performance.now() - startedAt
    search = {
      searchMs: timingMilliseconds(pathResult?.nativeQueryMs, fallbackSearchMs),
      settledNodes: pathResult?.nativeSettledNodes ?? 0,
      relaxedEdges: pathResult?.nativeRelaxedEdges ?? 0,
      chainSkippedNodes: pathResult?.nativeChainSkippedNodes ?? 0,
      contractedArcRelaxations:
        pathResult?.nativeContractedArcRelaxations ?? 0,
      cchAccelerated: pathResult?.nativeCchAccelerated === true,
      failureCode: pathResult ? null : 'no_path',
      accelerated: true,
      acceleratorSource: 'rust_mmap_node_api',
      cacheHit: false,
      geometryReversed: pathResult?.geometryReversed === true,
    }
  }
  if (!pathResult) {
    const failureCode = search?.failureCode ?? 'no_path'
    const blockedTrafficApplied = mode === 'drive'
      && traffic?.status === 'applied'
      && search?.trafficApplied === true
    return blockedStreetRoute(
      normalizedRequest,
      failureCode,
      failureCode === 'street_snap_failed'
        ? `The ${mode} graph does not reach one of these points.`
        : `No ${mode} path was found within ${maxStreetKm.toFixed(1)} km.`,
      {
        searchStats: streetRouteSearchDiagnostics(performance.now() - startedAt, search, mode),
        ...(mode === 'drive' ? {
          scheduleMode: 'none',
          roadMetricMode: blockedTrafficApplied ? 'traffic-adjusted' : 'free-flow',
          weightModel: blockedTrafficApplied ? 'snapshot_customized_traffic_seconds' : 'free_flow_seconds',
          limitations: [
            ...(blockedTrafficApplied ? [] : ['no_live_traffic']),
            'no_turn_restriction_relations',
            'no_signal_delay',
          ],
          ...(trafficDiagnostics ? {
            traffic: {
              ...trafficDiagnostics,
              ...(traffic?.status === 'applied' ? {
                status: blockedTrafficApplied ? 'applied' : 'native_fallback',
                customizationMs: search?.trafficCustomizationMs,
                metricReused: search?.trafficMetricReused === true,
              } : {}),
            },
          } : {}),
        } : {}),
      },
    )
  }
  if (mode === 'walk') {
    // The Rust path already contains ordered graph coordinates. Replacing
    // them through the obsolete node-id materializer is invalid because a
    // native result intentionally carries no JavaScript node-id array; doing
    // so collapsed a correct walk into the two endpoint coordinates.
    if (!Array.isArray(pathResult.coordinates) || pathResult.coordinates.length < 2) {
      throw new Error('Rust pedestrian routing returned no materializable geometry.')
    }
  }

  const walkingSpeedKph = Math.max(1, Math.min(12, Number(request.walkingSpeedKph) || 4.8))
  const durationMinutes = mode === 'drive'
    ? pathResult.durationSeconds / 60
    : pathResult.distanceKm / walkingSpeedKph * 60
  const distanceKm = pathResult.distanceKm
  const arriveMinutes = timePreference === 'arrive' ? requestedMinutes : requestedMinutes + durationMinutes
  const departMinutes = timePreference === 'arrive' ? requestedMinutes - durationMinutes : requestedMinutes
  const fromName = String(request.origin?.label ?? 'Origin')
  const toName = String(request.destination?.label ?? 'Destination')
  const trafficApplied = mode === 'drive' && traffic?.status === 'applied' && search?.trafficApplied === true
  const plan = {
    id: `street-${mode}`,
    status: 'ready',
    travelMode: mode,
    timePreference,
    maxWalkKm: mode === 'walk' ? maxStreetKm : 0,
    choiceLabel: mode === 'drive' ? (trafficApplied ? 'Fastest drive · live traffic' : 'Fastest drive') : 'Direct walk',
    recommended: true,
    origin: request.origin,
    destination: request.destination,
    title: mode === 'drive' ? `Drive to ${toName}` : `Walk to ${toName}`,
    detail: `${distanceKm.toFixed(distanceKm < 10 ? 2 : 1)} km · ${Math.max(1, Math.round(durationMinutes))} min`,
    departMinutes,
    arriveMinutes,
    durationMinutes,
    waitMinutes: 0,
    walkMinutes: mode === 'walk' ? durationMinutes : 0,
    rideMinutes: mode === 'drive' ? durationMinutes : 0,
    transfers: 0,
    legs: [{
      type: mode,
      travelMode: mode,
      fromName,
      toName,
      startMinutes: departMinutes,
      endMinutes: arriveMinutes,
      durationMinutes,
      distanceKm,
      stopCount: 0,
      coordinates: pathResult.coordinates,
    }],
    diagnostics: {
      scannedDepartures: 0,
      relaxedStops: 0,
      serviceDay: request.serviceDay ?? 'weekday',
      scheduleMode: 'none',
      roadMetricMode: trafficApplied ? 'traffic-adjusted' : 'free-flow',
      walkingNetwork: mode === 'walk' ? 'osm' : 'direct',
      walkingSpeedKph: mode === 'walk' ? walkingSpeedKph : 0,
      algorithm: mode === 'drive' ? 'rust_cch_drive_certified' : 'rust_cch_walk_exact',
      weightModel: mode === 'drive'
        ? trafficApplied ? 'snapshot_customized_traffic_seconds' : 'free_flow_seconds'
        : 'distance_meters',
      optimality: trafficApplied
        ? 'exact_on_stored_directed_graph_for_normalized_traffic_snapshot'
        : 'exact_on_stored_directed_graph',
      limitations: mode === 'drive'
        ? [
            ...(trafficApplied ? [] : ['no_live_traffic']),
            'no_turn_restriction_relations',
            'no_signal_delay',
          ]
        : [],
      ...(mode === 'drive' && trafficDiagnostics ? {
        traffic: {
          ...trafficDiagnostics,
          ...(traffic?.status === 'applied' ? {
            status: trafficApplied ? 'applied' : 'native_fallback',
            customizationMs: search?.trafficCustomizationMs,
            metricReused: search?.trafficMetricReused === true,
          } : {}),
        },
      } : {}),
      snapRecovery: search?.snapRecovery === true,
      originSnapDistanceM: Number(((pathResult.originSnapDistanceKm ?? 0) * 1_000).toFixed(3)),
      destinationSnapDistanceM: Number(((pathResult.destinationSnapDistanceKm ?? 0) * 1_000).toFixed(3)),
      searchStats: streetRouteSearchDiagnostics(performance.now() - startedAt, search, mode),
    },
  }
  return plan
}

function normalizeStreetMatrixPoints(value, label) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`Street matrix requires a non-empty ${label} array.`)
  }
  return value.map((point, index) => {
    const coordinate = Array.isArray(point)
      ? point.map(Number)
      : Array.isArray(point?.coordinate)
        ? point.coordinate.map(Number)
        : []
    if (
      coordinate.length !== 2
      || coordinate.some((value) => !Number.isFinite(value))
      || coordinate[0] < -180
      || coordinate[0] > 180
      || coordinate[1] < -85
      || coordinate[1] > 85
    ) {
      throw new Error(`Street matrix ${label} ${index + 1} has invalid coordinates.`)
    }
    return {
      coordinate,
      label: String(point?.label ?? `${label} ${index + 1}`),
    }
  })
}

function uniqueStreetMatrixPoints(points) {
  const unique = []
  const lookup = new Map()
  const indexes = points.map((point) => {
    const key = coordinateSampleKey(point.coordinate[0], point.coordinate[1])
    if (!lookup.has(key)) {
      lookup.set(key, unique.length)
      unique.push(point)
    }
    return lookup.get(key)
  })
  return { unique, indexes }
}

/**
 * Compute a directed Walk or Drive scalar matrix through one resident Rust
 * batch boundary. The mode-specific CCH weight remains explicit, but the
 * request shape, row order, caps, and diagnostics are shared.
 */
export function routeNationalStreetMatrix(storePath, request = {}, options = {}) {
  const startedAt = performance.now()
  if (options.isCancelled?.()) throw streetAnalysisAbort('matrix')
  const mode = request.mode === 'drive' ? 'drive' : 'walk'
  assertMatrixSize(request.origins?.length, request.destinations?.length)
  const origins = normalizeStreetMatrixPoints(request.origins, 'origin')
  const destinations = normalizeStreetMatrixPoints(request.destinations, 'destination')
  const originSet = uniqueStreetMatrixPoints(origins)
  const destinationSet = uniqueStreetMatrixPoints(destinations)
  const defaultMaximumDistanceKm = mode === 'drive' ? 750 : 50
  const maximumDistanceKm = mode === 'drive'
    ? Math.max(0.25, Math.min(1_500, Number(request.maxDistanceKm ?? request.maxStreetKm) || defaultMaximumDistanceKm))
    : Math.max(0.05, Math.min(100, Number(request.maxDistanceKm ?? request.maxStreetKm) || defaultMaximumDistanceKm))
  const walkingSpeedKph = Math.max(1, Math.min(12, Number(request.walkingSpeedKph) || 4.8))
  let native
  let traffic = null
  let snapRecoveryCount = 0
  if (mode === 'walk') {
    const prepared = prepareNationalOsmNativeStore(storePath)
    if (!prepared.ready || !prepared.accelerated) {
      const error = new Error(
        `The Rust pedestrian matrix kernel is unavailable: ${prepared.error ?? prepared.reason ?? 'unknown reason'}`,
      )
      error.code = 'VIGO_NATIVE_ROUTING_KERNEL_REQUIRED'
      throw error
    }
    if (!prepared.streetCch?.ready) {
      const error = new Error(
        'The Rust pedestrian matrix kernel requires the current sealed street CCH index. Rebuild the OSM street index before running a matrix.',
      )
      error.code = 'VIGO_NATIVE_STREET_CCH_REQUIRED'
      throw error
    }
    native = routeNativeWalkMatrix(storePath, {
      originCoordinates: originSet.unique.flatMap((point) => point.coordinate),
      destinationCoordinates: destinationSet.unique.flatMap((point) => point.coordinate),
      maximumDistanceKm,
    })
  } else {
    let state = openRuntimeStreetStore(storePath)
    if (!state.driveAccelerator) {
      const prepared = prepareNationalOsmDriveStore(storePath)
      if (prepared.ready) state = openRuntimeStreetStore(storePath)
    }
    if (!state.driveAccelerator) {
      const error = new Error(
        `The Rust driving matrix kernel is unavailable: ${state.driveAcceleratorError ?? 'rebuild the drive snapshot.'}`,
      )
      error.code = 'VIGO_DRIVE_SNAPSHOT_REQUIRED'
      throw error
    }
    traffic = normalizeDriveTrafficSnapshot(
      state.driveAccelerator,
      request.trafficSnapshot,
      state.metadata.sourceFingerprint,
    )
    const originCandidateSets = originSet.unique.map((point) => {
      const result = driveCandidatesForCoordinate(state, point.coordinate)
      if (result.snapRecovery) snapRecoveryCount += 1
      return result.candidates
    })
    const destinationCandidateSets = destinationSet.unique.map((point) => {
      const result = driveCandidatesForCoordinate(state, point.coordinate)
      if (result.snapRecovery) snapRecoveryCount += 1
      return result.candidates
    })
    native = routeNativeDriveMatrix(state.driveAccelerator, {
      originCandidateSets,
      destinationCandidateSets,
      maximumDistanceKm,
      traffic: traffic?.nativeInput,
    })
  }
  if (options.isCancelled?.()) throw streetAnalysisAbort('matrix')

  const uniqueDestinationCount = destinationSet.unique.length
  const rows = new Array(origins.length * destinations.length)
  let rowIndex = 0
  for (let originIndex = 0; originIndex < origins.length; originIndex += 1) {
    for (let destinationIndex = 0; destinationIndex < destinations.length; destinationIndex += 1) {
      const matrixIndex = originSet.indexes[originIndex] * uniqueDestinationCount
        + destinationSet.indexes[destinationIndex]
      const distanceM = Number(native.distancesM[matrixIndex])
      const durationMinutes = mode === 'drive'
        ? Number(native.durationsS[matrixIndex]) / 60
        : distanceM / 1_000 / walkingSpeedKph * 60
      const finiteDistance = Number.isFinite(distanceM)
      const finiteDuration = Number.isFinite(durationMinutes)
      const ready = finiteDistance && finiteDuration
      rows[rowIndex] = {
        originIndex,
        destinationIndex,
        status: ready ? 'ready' : 'blocked',
        distanceKm: finiteDistance ? distanceM / 1_000 : null,
        durationMinutes: finiteDuration ? durationMinutes : null,
      }
      rowIndex += 1
    }
  }
  const trafficApplied = mode === 'drive' && traffic?.status === 'applied' && native.diagnostics.trafficApplied === true
  const trafficDiagnostics = traffic
    ? Object.fromEntries(Object.entries(traffic).filter(([key]) => !['nativeInput', 'cacheKey'].includes(key)))
    : null
  return {
    schemaVersion: 'vigo.routing.street-matrix.v1',
    mode,
    rows,
    diagnostics: {
      owner: 'rust_resident_street_matrix_kernel',
      matrixEngine: native.diagnostics.algorithm,
      mode,
      weightModel: mode === 'drive'
        ? (trafficApplied ? 'snapshot_customized_traffic_seconds' : 'free_flow_seconds')
        : 'distance_meters',
      origins: origins.length,
      destinations: destinations.length,
      pairs: rows.length,
      uniqueOrigins: originSet.unique.length,
      uniqueDestinations: destinationSet.unique.length,
      readyPairs: native.readyPairs,
      cchAccelerated: native.diagnostics.cchAccelerated === true,
      cchCandidateQueries: native.diagnostics.cchCandidateQueries ?? null,
      pathQueries: native.diagnostics.pathQueries ?? null,
      sourceCandidates: native.diagnostics.sourceCandidates ?? null,
      destinationCandidates: native.diagnostics.destinationCandidates ?? null,
      snapRecoveryCount,
      maximumDistanceKm,
      walkingSpeedKph: mode === 'walk' ? walkingSpeedKph : null,
      ...(mode === 'drive' && trafficDiagnostics ? {
        traffic: {
          ...trafficDiagnostics,
          ...(traffic?.status === 'applied' ? {
            status: trafficApplied ? 'applied' : 'native_fallback',
            customizationMs: native.diagnostics.trafficCustomizationMs,
            metricReused: native.diagnostics.trafficMetricReused === true,
          } : {}),
        },
      } : {}),
      nativeQueryMs: timingMilliseconds(native.queryMs),
      nodeApiWallMs: timingMilliseconds(native.nodeApiWallMs),
      queryMs: Number((performance.now() - startedAt).toFixed(3)),
      ...(options.isCancelled?.() ? { cancelled: true } : {}),
    },
  }
}

function streetAnalysisAbort(surface) {
  const error = new Error(`Street ${surface} analysis was cancelled.`)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/**
 * Rasterize exact directed pedestrian-network travel times in the Rust mmap
 * kernel. JavaScript validates worker cancellation and shapes the public
 * response; it does not retain or execute a street graph.
 */
export function streetNetworkTravelTimeRaster(storePath, value, options = {}) {
  openRuntimeStreetStore(storePath)
  if (options.isCancelled?.()) throw streetAnalysisAbort('surface')
  options.onProgress?.({
    phase: 'street-surface',
    progress: 0.01,
    detail: 'Rust pedestrian surface search',
  })
  const result = rasterNativeStreetSurface(storePath, value)
  if (options.isCancelled?.()) throw streetAnalysisAbort('surface')
  options.onProgress?.({
    phase: 'street-surface',
    progress: 0.98,
    detail: `${result.diagnostics.settledLabels.toLocaleString()} pedestrian labels settled`,
  })
  return result
}

/**
 * Resolve timed scenario-stop arrivals and the optional exact directed matrix
 * in the Rust mmap kernel. No SQLite or JavaScript graph-search fallback is
 * retained.
 */
export function streetNetworkTimedConnectors(storePath, value, options = {}) {
  openRuntimeStreetStore(storePath)
  if (options.isCancelled?.()) throw streetAnalysisAbort('connector')
  options.onProgress?.({
    phase: 'reach-connectors',
    progress: 0.01,
    detail: 'Rust timed connector search',
  })
  const result = routeNativeTimedConnectors(storePath, value)
  if (options.isCancelled?.()) throw streetAnalysisAbort('connector')
  options.onProgress?.({
    phase: 'reach-connectors',
    progress: 0.98,
    detail: `${result.diagnostics.reachedTargets.toLocaleString()} scenario stops connected`,
  })
  return result
}
