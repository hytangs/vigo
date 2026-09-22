import { osmTransferMaximumWalkM } from './routing-policy.mjs'

import fs from 'node:fs'
import path from 'node:path'
import { performance as nodePerformance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { stableJson } from '../routing-plan-identity.mjs'

export const storeSchemaVersion = 'vigo.routing.store.v1'

export const transferSemanticsVersion = 'vigo.routing.transfers.v3'

export const stopAccessRoleIndexVersion = 'vigo.routing.stop-access-roles.v1'

// Admission checks only the objects needed to identify a current store and
// execute the routing queries. SQLite remains the source of truth for column
// details; keeping a second copy of every table and index definition here was
// brittle and added no useful protection after the store was opened read-only.
const routingStoreTableNames = Object.freeze([
  'metadata', 'stops', 'routes', 'trips', 'route_services',
  'trip_shapes', 'shape_points', 'calendar', 'calendar_dates', 'transfers',
  'frequencies', 'connections', 'stop_modes', 'stop_access_roles',
])

const routingStoreIndexTables = Object.freeze({
  calendar_dates_date: 'calendar_dates',
  connections_from_departure_cover: 'connections',
  route_services_representative: 'route_services',
  route_services_trip_rank: 'route_services',
  routes_service_identity: 'routes',
  stop_modes_stop_type: 'stop_modes',
  stop_modes_type_stop: 'stop_modes',
  stops_lat_lon: 'stops',
  stops_parent: 'stops',
  transfers_from: 'transfers',
  trip_shapes_shape: 'trip_shapes',
  trips_route: 'trips',
  trips_service: 'trips',
})

export const staticTopologySourceIdentityVersion = 'vigo.routing.static-topology-source.v3'

const monotonicNow = nodePerformance.now.bind(nodePerformance)

const streetStorageIdentityCache = new Map()

const streetStorageIdentityCacheMaxEntries = Math.max(1, Math.min(64, Math.floor(Number(process.env.VIGO_STREET_IDENTITY_CACHE_MAX_ENTRIES ?? 16) || 16)))

const supportedScheduledCoreLimitationCodes = new Set([
  'frequency_based_service',
  'on_demand_boarding_or_alighting',
  'restricted_boarding_or_alighting',
  'continuous_pickup_or_drop_off',
  'scoped_transfer_rules',
  'timed_transfer_guarantee',
  'in_seat_transfer_rules',
  'block_interlining',
  'pathway_accessibility',
  'wheelchair_accessibility',
  'bicycle_accessibility',
  'station_entrances',
  'station_level_hierarchy',
  'feature_inventory_incomplete',
])

const requiredRoutingFeatureInventoryKeys = Object.freeze([
  'stopWheelchairBoardingRuleCount',
  'tripWheelchairAccessibleRuleCount',
  'tripBikesAllowedRuleCount',
  'stationEntranceCount',
  'stationLevelRuleCount',
])

export function metadataRecord(db) {
  const metadata = {}
  for (const row of db.prepare('SELECT key, value FROM metadata').all()) {
    try {
      metadata[row.key] = JSON.parse(row.value)
    } catch {
      metadata[row.key] = row.value
    }
  }
  return metadata
}

export function routingStoreAdmissionError(storePath, reason, detail) {
  const message = [
    `Routing store admission failed for ${storePath}: ${detail}`,
    `Expected an exact current ${storeSchemaVersion} SQLite store.`,
    'Rebuild the routing store from the source GTFS instead of modifying it in place.',
  ].join(' ')
  const error = new Error(message)
  error.code = 'VIGO_ROUTING_STORE_ADMISSION_FAILED'
  error.reason = reason
  error.storePath = storePath
  return error
}

function admitRoutingStoreVersion(storePath, metadata) {
  if (metadata.schemaVersion !== storeSchemaVersion) {
    throw routingStoreAdmissionError(storePath, 'schema_version_mismatch',
      `metadata.schemaVersion is ${JSON.stringify(metadata.schemaVersion)}.`)
  }
  if (metadata.transferSemanticsVersion !== transferSemanticsVersion) {
    throw routingStoreAdmissionError(
      storePath,
      'transfer_semantics_mismatch',
      `Transfer semantics are ${String(metadata.transferSemanticsVersion ?? 'unspecified')}; ${transferSemanticsVersion} is required.`,
    )
  }
}

export function admitCurrentTransferSemantics(db, storePath, metadata = metadataRecord(db)) {
  admitRoutingStoreVersion(storePath, metadata)
  const hasTransferProvenance = db.prepare(`
    SELECT 1 AS ready
    FROM sqlite_master
    WHERE type='table' AND name='transfer_provenance'
  `).get()?.ready === 1
  if (!hasTransferProvenance) {
    throw routingStoreAdmissionError(
      storePath,
      'transfer_provenance_missing',
      `${transferSemanticsVersion} requires a complete transfer_provenance table.`,
    )
  }
  if (db.prepare(`
    SELECT 1 AS invalid
    FROM (
      SELECT from_stop_id, to_stop_id FROM transfers
      EXCEPT
      SELECT from_stop_id, to_stop_id FROM transfer_provenance
    )
    LIMIT 1
  `).get()?.invalid === 1) {
    throw routingStoreAdmissionError(
      storePath,
      'transfer_provenance_incomplete',
      'A routable transfer lacks provenance.',
    )
  }
  return metadata
}

export function admitNationalRoutingStore(db, storePath) {
  const startedAt = monotonicNow()
  const requiredTableNames = routingStoreTableNames
  let departureIndexState = 'ready'
  try {
    const row = db.prepare(
      "SELECT value FROM metadata WHERE key='departureIndexState'",
    ).get()
    if (row?.value !== undefined) departureIndexState = JSON.parse(String(row.value))
  } catch {}
  const deferredDepartureIndex = departureIndexState === 'deferred'
  const requiredIndexNames = Object.keys(routingStoreIndexTables).filter((name) => (
    !deferredDepartureIndex || name !== 'connections_from_departure_cover'
  ))
  const requiredObjectNames = [...requiredTableNames, ...requiredIndexNames]
  const placeholders = requiredObjectNames.map(() => '?').join(',')
  let schemaRows
  try {
    schemaRows = db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name IN (${placeholders})
      ORDER BY type, name
    `).all(...requiredObjectNames)
  } catch (error) {
    throw routingStoreAdmissionError(
      storePath,
      'schema_catalog_unreadable',
      `SQLite could not read the schema catalog (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  const schemaByName = new Map(schemaRows.map((row) => [String(row.name), row]))

  for (const tableName of requiredTableNames) {
    const object = schemaByName.get(tableName)
    if (!object) {
      throw routingStoreAdmissionError(storePath, 'required_table_missing', `Required table "${tableName}" is missing.`)
    }
    if (object.type !== 'table' || object.tbl_name !== tableName) {
      throw routingStoreAdmissionError(
        storePath,
        'required_table_wrong_type',
        `Required table "${tableName}" resolves to ${object.type}:${object.tbl_name}.`,
      )
    }
  }

  for (const [indexName, tableName] of Object.entries(routingStoreIndexTables)) {
    if (!requiredIndexNames.includes(indexName)) continue
    const object = schemaByName.get(indexName)
    if (!object) {
      throw routingStoreAdmissionError(storePath, 'required_index_missing', `Required index "${indexName}" is missing.`)
    }
    if (object.type !== 'index' || object.tbl_name !== tableName) {
      throw routingStoreAdmissionError(
        storePath,
        'required_index_wrong_target',
        `Required index "${indexName}" resolves to ${object.type}:${object.tbl_name}; expected index:${tableName}.`,
      )
    }
  }

  let metadata
  try {
    metadata = metadataRecord(db)
  } catch (error) {
    throw routingStoreAdmissionError(
      storePath,
      'metadata_unreadable',
      `SQLite could not read store metadata (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  const schemaVersion = metadata.schemaVersion
  if (schemaVersion === undefined) {
    throw routingStoreAdmissionError(storePath, 'schema_version_missing', 'metadata.schemaVersion is missing.')
  }
  admitRoutingStoreVersion(storePath, metadata)
  return {
    metadata,
    admission: Object.freeze({
      status: 'admitted',
      schemaVersion,
      requiredTableCount: requiredTableNames.length,
      requiredIndexCount: requiredIndexNames.length,
      departureIndexState,
      metadataRows: Object.keys(metadata).length,
      admissionMs: Number((monotonicNow() - startedAt).toFixed(3)),
      integrityScan: 'not_run_on_open',
      authoritativeConnection: 'read_only',
      temporaryState: 'connection_local',
    }),
  }
}

function immutableJsonSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJsonSnapshot))
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, immutableJsonSnapshot(entry)]),
    ))
  }
  return value
}

export function supportedScheduledCoreCoverage(store) {
  const excludedFeatures = (store.routingLimitations ?? [])
    .filter((feature) => supportedScheduledCoreLimitationCodes.has(feature.code))
    .map((feature) => ({
      code: feature.code,
      count: Number(feature.count ?? 0),
      detail: feature.detail,
    }))
  return {
    mode: excludedFeatures.length ? 'supported_scheduled_core' : 'complete_supported_feed',
    complete: excludedFeatures.length === 0,
    excludedFeatures,
  }
}

export function staticTopologySourceFingerprint(metadata) {
  return String(metadata.sourceFingerprint ?? metadata.storeId ?? '')
}

export function staticTopologySourceIdentity(metadata) {
  return stableJson({
    identityVersion: staticTopologySourceIdentityVersion,
    storeId: metadata.storeId ?? null,
    schemaVersion: metadata.schemaVersion ?? null,
    connectionCount: Number(metadata.connectionCount ?? -1),
    transferCount: Number(metadata.transferCount ?? -1),
    transferSemanticsVersion: metadata.transferSemanticsVersion ?? null,
    transferGeneration: metadata.transferGeneration ?? null,
    stopCount: Number(metadata.stopCount ?? -1),
    bridgedUntimedGapCount: Number(metadata.bridgedUntimedGapCount ?? -1),
  })
}

export function staticTopologySourceMatches(
  artifactMetadata,
  sourceMetadata,
  sourceGeneration = '',
) {
  return artifactMetadata.staticTopologySourceIdentity === staticTopologySourceIdentity(sourceMetadata)
    && artifactMetadata.staticTopologySourceGeneration === sourceGeneration
}

export function staticTopologySourceStorageIdentity(storePath) {
  return sqliteStoreStatSignature(storePath)
}

function sqliteFileStatSignature(filePath) {
  const stats = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false })
  if (!stats) return ''
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`
}

export function sqliteStoreStatSignature(storePath) {
  return `${sqliteFileStatSignature(storePath)}|${sqliteFileStatSignature(`${storePath}-wal`)}`
}

function sqliteFileGeneration(filePath, headerBytes) {
  const stats = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false })
  if (!stats) return ''
  const header = Buffer.alloc(headerBytes)
  const handle = fs.openSync(filePath, 'r')
  let bytesRead
  try {
    bytesRead = fs.readSync(handle, header, 0, header.length, 0)
  } finally {
    fs.closeSync(handle)
  }
  if (bytesRead < headerBytes) return `${stats.size}:short`
  if (
    headerBytes === 100
    && header.subarray(0, 16).equals(Buffer.from('SQLite format 3\u0000'))
  ) {
    return [
      stats.size,
      header.readUInt32BE(24),
      header.readUInt32BE(28),
      header.readUInt32BE(40),
      header.readUInt32BE(92),
    ].join(':')
  }
  return [
    stats.size,
    header.readUInt32BE(0),
    header.readUInt32BE(12),
    header.readUInt32BE(16),
    header.readUInt32BE(20),
  ].join(':')
}

export function sqliteStoreGeneration(storePath) {
  return `${sqliteFileGeneration(storePath, 100)}|${sqliteFileGeneration(`${storePath}-wal`, 32)}`
}

export function staticTopologySourceStorageSnapshot(storePath) {
  // Read twice so a concurrently replaced SQLite file is not admitted as a
  // stable cache baseline.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const statSignature = sqliteStoreStatSignature(storePath)
    if (sqliteStoreStatSignature(storePath) === statSignature) {
      return statSignature
    }
  }
  throw new Error('Routing store changed repeatedly while its source identity was being read.')
}

function streetStoreStorageSnapshot(storePath) {
  const resolvedPath = path.resolve(storePath)
  // Keep the storage key cheap; the store admission path remains responsible
  // for opening and validating the SQLite file before it is used.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const statSignature = sqliteStoreStatSignature(resolvedPath)
    if (sqliteStoreStatSignature(resolvedPath) === statSignature) {
      return statSignature
    }
  }
  throw new Error('Street store changed repeatedly while its storage identity was being read.')
}

export function currentStreetStoreStorageIdentity(storePath) {
  if (!storePath) return 'direct'
  const resolvedPath = path.resolve(storePath)
  const statSignature = sqliteStoreStatSignature(resolvedPath)
  const cached = streetStorageIdentityCache.get(resolvedPath)
  if (cached === statSignature) {
    streetStorageIdentityCache.delete(resolvedPath)
    streetStorageIdentityCache.set(resolvedPath, cached)
    return cached
  }
  const snapshot = streetStoreStorageSnapshot(resolvedPath)
  streetStorageIdentityCache.delete(resolvedPath)
  streetStorageIdentityCache.set(resolvedPath, snapshot)
  while (streetStorageIdentityCache.size > streetStorageIdentityCacheMaxEntries) {
    const oldestPath = streetStorageIdentityCache.keys().next().value
    if (oldestPath === undefined) break
    streetStorageIdentityCache.delete(oldestPath)
  }
  return snapshot
}

export function readNationalGtfsStoreMetadata(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const metadata = metadataRecord(db)
    admitRoutingStoreVersion(storePath, metadata)
    return metadata
  } finally {
    db.close()
  }
}

export function routingSemanticsFromMetadata(metadata, hasConnectionPermissions) {
  const blockingRoutingFeatures = Array.isArray(metadata.blockingRoutingFeatures)
    ? metadata.blockingRoutingFeatures
    : []
  const routingLimitations = Array.isArray(metadata.routingLimitations)
    ? [...metadata.routingLimitations]
    : []
  const missingFeatureInventoryKeys = requiredRoutingFeatureInventoryKeys.filter((key) => (
    !metadata.featureInventory
    || !Object.prototype.hasOwnProperty.call(metadata.featureInventory, key)
  ))
  if (
    missingFeatureInventoryKeys.length
    && !routingLimitations.some((feature) => feature.code === 'feature_inventory_incomplete')
  ) {
    routingLimitations.push({
      code: 'feature_inventory_incomplete',
      count: missingFeatureInventoryKeys.length,
      exactness: 'unknown',
      detail: `This routing store predates required feature inventory fields (${missingFeatureInventoryKeys.join(', ')}); rebuild it before making complete-feed claims.`,
    })
  }
  const transferGeneration = metadata.transferGeneration ?? null
  const sourceFingerprint = staticTopologySourceFingerprint(metadata)
  const routingCoverage = immutableJsonSnapshot(supportedScheduledCoreCoverage({
    routingLimitations,
  }))
  const routingDataSemantics = immutableJsonSnapshot({
    sourceFingerprint,
    blockingFeatures: blockingRoutingFeatures,
    limitations: routingLimitations,
    routingCoverage,
    transferSemanticsVersion,
    transferEpisode: {
      schemaVersion: 'vigo.routing.transfer-episode.v1',
      maximumExplicitEdgesBeforeBoarding: 1,
      maximumGeneratedOsmWalkM: osmTransferMaximumWalkM,
      resetsAfterBoarding: true,
    },
    transferGeneration,
    hasConnectionPermissions,
  })
  return {
    blockingRoutingFeatures,
    routingLimitations,
    routingCoverage,
    routingDataSemantics,
    transferGeneration,
    sourceFingerprint,
  }
}
