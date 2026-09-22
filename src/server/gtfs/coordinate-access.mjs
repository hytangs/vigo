import fs from 'node:fs'
import path from 'node:path'
import { readNationalOsmStoreMetadata } from '../national-osm-store.mjs'
import { configureNativeRoutingAccessProfile, nativeRoutingAccessProfilePrepared } from '../native-routing-kernel.mjs'
import { numeric } from '../number-utils.mjs'
import { persistPreparedAccessContext, stationPathLookup } from '../prepared-access-context.mjs'
import { stableKeySuffix } from '../routing-plan-identity.mjs'
import { prepareStationAccessPaths } from '../station-access.mjs'
import { nationalRoutingAccessPolicy, nationalRoutingAccessPolicyIdentity, walkingSpeedKph } from './routing-policy.mjs'

const nativeAccessProfileSnapshotCacheMaxEntries = Math.max(
  1,
  Math.min(4, Math.floor(Number(
    process.env.VIGO_NATIVE_ACCESS_PROFILE_CACHE_MAX_ENTRIES ?? 1,
  ) || 0)),
)

const nativeAccessProfileSnapshotCacheMaxBytes = Math.max(
  64 * 1024 * 1024,
  Math.min(1024 * 1024 * 1024, Math.floor(Number(
    process.env.VIGO_NATIVE_ACCESS_PROFILE_CACHE_MAX_BYTES ?? 256 * 1024 * 1024,
  ) || 0)),
)

const nativeAccessProfilePersistenceEnabled = process.env.VIGO_NATIVE_ACCESS_PROFILE_PERSIST !== '0'

function stopHasDirectService(store, stopId) {
  if (store.stopAccessIndex.departureServiceStopIds) {
    return store.stopAccessIndex.departureServiceStopIds.has(stopId)
  }
  const indexedProfile = store.stopAccessIndex.directProfilesByStop?.get(stopId)
  return Boolean(indexedProfile && indexedProfile.departureCount > 0)
}

export function stopSupportsStationAccessRole(store, stopId, accessRole) {
  if (accessRole !== 'destination') return stopHasDirectService(store, stopId)
  return store.stopAccessIndex.arrivalServiceStopIds?.has(stopId) === true
}

function nativeAccessProfileSnapshotPath(storePath, profileKey) {
  return `${path.resolve(storePath)}.native-access-profile.${stableKeySuffix(profileKey)}.bin`
}

export function pruneRoutingSnapshotCache({
  storePath,
  currentSnapshotPath,
  suffix,
  maximumEntries,
  maximumBytes,
  temporaryMinimumAgeMs = 0,
  temporaryReason = 'orphan-temporary',
  schemaVersion,
}) {
  const resolvedStorePath = path.resolve(storePath)
  const resolvedCurrentPath = path.resolve(currentSnapshotPath)
  const directory = path.dirname(resolvedStorePath)
  const prefix = `${path.basename(resolvedStorePath)}.${suffix}`
  const temporaryCutoffMs = Date.now() - temporaryMinimumAgeMs
  const removed = []
  const snapshots = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    const artifactPath = path.join(directory, entry.name)
    const stats = fs.statSync(artifactPath)
    if (entry.name.includes('.bin.') && entry.name.endsWith('.tmp')) {
      if (stats.mtimeMs >= temporaryCutoffMs) continue
      fs.rmSync(artifactPath, { force: true })
      removed.push({ path: artifactPath, bytes: stats.size, reason: temporaryReason })
      continue
    }
    if (!entry.name.endsWith('.bin')) continue
    snapshots.push({
      path: artifactPath,
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
      current: path.resolve(artifactPath) === resolvedCurrentPath,
    })
  }
  snapshots.sort((left, right) => (
    Number(right.current) - Number(left.current)
    || right.mtimeMs - left.mtimeMs
    || left.path.localeCompare(right.path)
  ))
  let retainedCount = 0
  let retainedBytes = 0
  for (const snapshot of snapshots) {
    const retain = snapshot.current || (
      retainedCount < maximumEntries
      && retainedBytes + snapshot.bytes <= maximumBytes
    )
    if (retain) {
      retainedCount += 1
      retainedBytes += snapshot.bytes
      continue
    }
    fs.rmSync(snapshot.path, { force: true })
    removed.push({ ...snapshot, reason: 'retention-budget' })
  }
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    maximumEntries,
    maximumBytes,
    retainedCount,
    retainedBytes,
    removedCount: removed.length,
    removedBytes: removed.reduce((sum, artifact) => sum + artifact.bytes, 0),
    removed,
  }
}

function pruneNativeAccessProfileSnapshots(storePath, currentSnapshotPath) {
  return pruneRoutingSnapshotCache({
    storePath,
    currentSnapshotPath,
    suffix: 'native-access-profile.',
    maximumEntries: nativeAccessProfileSnapshotCacheMaxEntries,
    maximumBytes: nativeAccessProfileSnapshotCacheMaxBytes,
    temporaryMinimumAgeMs: 10 * 60 * 1000,
    temporaryReason: 'stale-temporary',
  })
}

function coordinateAccessArtifactStreetIdentity(store, streetStorePath) {
  const retained = store.metadata.osmStopTransferGraph
  return String(
    retained?.streetIdentity
    ?? retained?.streetStorageIdentity
    ?? osmStopTransferStreetIdentity(readNationalOsmStoreMetadata(streetStorePath)),
  )
}

export function nativeCoordinateAccessProfile(store, streetStorePath, streetStorageIdentity) {
  const cacheKey = `${path.resolve(streetStorePath)}\u0000${streetStorageIdentity}`
  let profile = store.nativeCoordinateAccessProfiles.get(cacheKey)
  if (!profile) {
    if (!store.stopAccessIndex.ready) {
      const error = new Error(
        `Resident stop-access index is required for native coordinate routing: ${store.stopAccessIndex.reason ?? 'unavailable'}`,
      )
      error.code = 'resident_stop_access_index_required'
      throw error
    }
    profile = physicalStopAccessProfile(store, streetStorePath, 'coordinate-access-v11')
    store.nativeCoordinateAccessProfiles.set(cacheKey, profile)
    while (store.nativeCoordinateAccessProfiles.size > 4) {
      store.nativeCoordinateAccessProfiles.delete(
        store.nativeCoordinateAccessProfiles.keys().next().value,
      )
    }
  }
  if (
    profile.nativeConfiguration
    && nativeRoutingAccessProfilePrepared(streetStorePath, profile.profileKey)
  ) {
    return {
      profile,
      diagnostics: {
        ...profile.nativeConfiguration,
        cacheHit: true,
        snapshotRetention: null,
      },
    }
  }
  const snapshotPath = nativeAccessProfileSnapshotPath(store.storePath, profile.profileKey)
  const diagnostics = configureNativeRoutingAccessProfile(
    streetStorePath,
    profile,
    { snapshotPath: nativeAccessProfilePersistenceEnabled ? snapshotPath : '' },
  )
  const snapshotRetention = ['memory', 'disabled'].includes(diagnostics.persistenceState)
    ? null
    : pruneNativeAccessProfileSnapshots(store.storePath, snapshotPath)
  const configuredDiagnostics = {
    ...diagnostics,
    snapshotRetention,
  }
  profile.nativeConfiguration = configuredDiagnostics
  return {
    profile,
    diagnostics: configuredDiagnostics,
  }
}

function physicalStopAccessProfile(store, streetStorePath, version) {
  // Access, egress and generated transfers attach to the same physical stop.
  // A parent centroid cannot provide free movement to every platform, and a
  // stop cannot connect street components that ordinary walking cannot join.
  const members = []
  const memberLons = []
  const memberLats = []
  const memberOriginEligible = []
  const memberDestinationEligible = []
  const memberStreetAccessStopIds = []
  const anchorLons = []
  const anchorLats = []
  const anchorMemberOffsets = [0]
  const anchorMemberIndices = []
  for (const stop of store.stopRecords.values()) {
    if (
      numeric(stop.location_type, 0) === 1
      || !Number.isFinite(stop.lon)
      || !Number.isFinite(stop.lat)
    ) {
      continue
    }
    const originEligible = stopHasDirectService(store, stop.stop_id)
    const destinationEligible = stopSupportsStationAccessRole(
      store,
      stop.stop_id,
      'destination',
    )
    if (!originEligible && !destinationEligible
      && (numeric(stop.location_type, 0) === 0 || version.startsWith('stop-transfer'))) continue
    const memberIndex = members.length
    members.push(stop)
    memberLons.push(stop.lon)
    memberLats.push(stop.lat)
    memberOriginEligible.push(Number(originEligible))
    memberDestinationEligible.push(Number(destinationEligible))
    memberStreetAccessStopIds.push(stop.stop_id)
    // Interior pathway nodes carry their declared connections, not additional
    // entrances through the nearest external street.
    if ([0, 2].includes(numeric(stop.location_type, 0))) {
      anchorLons.push(stop.lon)
      anchorLats.push(stop.lat)
      anchorMemberIndices.push(memberIndex)
      anchorMemberOffsets.push(anchorMemberIndices.length)
    }
  }
  const profileKey = [
    version,
    encodeURIComponent(store.sourceArtifactIdentity),
    encodeURIComponent(coordinateAccessArtifactStreetIdentity(store, streetStorePath)),
    members.length,
    anchorLons.length,
    encodeURIComponent(nationalRoutingAccessPolicyIdentity),
  ].join(':')
  const profile = {
    profileKey,
    members,
    stops: members,
    stopIds: members.map(stop => stop.stop_id),
    anchorLons,
    anchorLats,
    anchorMemberOffsets,
    anchorMemberIndices,
    memberLons,
    memberLats,
    memberOriginEligible,
    memberDestinationEligible,
    memberStreetAccessStopIds,
    walkingSpeedKph: nationalRoutingAccessPolicy.walkingSpeedKph,
    accessPaddingFactor: nationalRoutingAccessPolicy.accessPaddingFactor,
    accessOverheadSeconds: nationalRoutingAccessPolicy.accessOverheadSeconds,
  }
  if (version.startsWith('coordinate-access')) {
    let paths = store.preparedStationPaths
    if (!paths || paths.stopIds.length !== members.length
      || paths.stopIds.some((id, index) => id !== members[index].stop_id)) {
      paths = prepareStationAccessPaths(store, members, walkingSpeedKph)
      store.preparedStationPaths = paths
      Object.assign(store.accessMaterialization, persistPreparedAccessContext(store, nationalRoutingAccessPolicyIdentity))
    }
    profile.memberStopKeys = members.map((_, index) => index)
    // Each physical stop has its own key; no centroid-to-platform broadcast.
    profile.memberStationKeys = profile.memberStopKeys
    profile.memberOriginExpansionEligible = memberOriginEligible
    profile.memberDestinationExpansionEligible = memberDestinationEligible
    profile.memberOriginEligible = members.map(() => 1)
    profile.memberDestinationEligible = members.map(() => 1)
    profile.transferFromStopKeys = paths.from
    profile.transferToStopKeys = paths.to
    profile.transferToStationKeys = profile.transferToStopKeys
    profile.transferMinDurations = paths.seconds
    profile.transferPathDistancesM = paths.distanceM
    profile.transferOsmCertified = new Uint8Array(paths.from.length)
    profile.transferPaths = stationPathLookup(paths, members)
  }
  return profile
}

export function nativeStopTransferProfile(store, streetStorePath) {
  const profile = physicalStopAccessProfile(store, streetStorePath, 'stop-transfer-v2')
  const diagnostics = configureNativeRoutingAccessProfile(streetStorePath, profile)
  return { profile, diagnostics }
}

export function osmStopTransferStreetIdentity(metadata) {
  return [
    metadata.schemaVersion ?? '',
    metadata.sourceModel ?? '',
    metadata.sourceFingerprint ?? '',
    Number(metadata.sourceBytes ?? -1),
    Number(metadata.nodeCount ?? -1),
    Number(metadata.edgeCount ?? -1),
  ].join('|')
}
