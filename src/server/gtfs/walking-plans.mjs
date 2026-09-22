import { incompleteServiceCoveragePlan, materializeDirectWalkCandidate } from './route-results.mjs'
import {
  accessPaddingFactor,
  accessWalkSeconds,
  directWalkEndToEndLimitKm,
  directWalkTransitEndpointLowerBoundMinutes,
  explicitRoutingStopId,
  requestedAccessStopIds,
  requiredServiceCoverageIncomplete,
  transitRideRequired,
  walkSeconds,
  walkingSpeedKph,
} from './routing-policy.mjs'
import {
  admitCurrentTransferSemantics,
  admitNationalRoutingStore,
  routingSemanticsFromMetadata,
  staticTopologySourceStorageSnapshot,
  stopAccessRoleIndexVersion,
} from './store-metadata.mjs'

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { haversineKm } from '../geometry-utils.mjs'
import { streetPathBetween } from '../national-osm-store.mjs'
import { numeric, timingMilliseconds } from '../number-utils.mjs'
import { lightweightServiceAnchorDateResolution, serviceDateDiagnostics } from './service-calendar.mjs'

const serviceAccessAnchorCache = new Map()

const serviceAccessAnchorCacheMaxEntries = Math.max(
  1,
  Math.min(
    16,
    Math.floor(Number(process.env.VIGO_ACCESS_ANCHOR_CACHE_MAX_ENTRIES ?? 4) || 4),
  ),
)

export function directWalkAlternativePlan(request, preferredWalkKm, alternativeWalkKm) {
  if (
    transitRideRequired(request)
    || request.allowLongWalk === false
    || !request.streetStorePath
  ) {
    return { plan: null, walkSearches: 0 }
  }
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return { plan: null, walkSearches: 0 }
  if (haversineKm(origin.coordinate, destination.coordinate) > alternativeWalkKm) {
    return { plan: null, walkSearches: 0 }
  }
  const path = streetPathBetween(
    request.streetStorePath,
    origin.coordinate,
    destination.coordinate,
    alternativeWalkKm,
  )
  if (!path || path.distanceKm > directWalkEndToEndLimitKm({ ...request,
    allowLongWalk: true, maxStreetKm: alternativeWalkKm }) + 1e-9) return { plan: null, walkSearches: 1 }
  const plan = materializeDirectWalkCandidate(request, alternativeWalkKm, path, {
    choiceLabel: 'Walk only',
    title: 'Walk only',
    recommended: false,
    searchProfile: 'pareto',
    searchStrategy: 'exact_constrained_access',
    algorithm: 'osm_direct_walk_alternative',
    optimality: 'graph_verified_direct_walk_alternative',
    transitLowerBoundMinutes: undefined,
  })
  return {
    plan: {
      ...plan,
      diagnostics: {
        ...plan.diagnostics,
        alternativeStrategy: 'long_walk_direct',
        longerWalkAlternative: path.distanceKm > preferredWalkKm + 0.01,
        preferredMaxWalkKm: preferredWalkKm,
        alternativeMaxWalkKm: alternativeWalkKm,
      },
    },
    walkSearches: 1,
  }
}

function shouldProbeNationalDirectWalkDominance(request) {
  if (transitRideRequired(request) || !request?.streetStorePath) return false
  if (!(directWalkTransitEndpointLowerBoundMinutes > 0)) return false
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return false
  // Explicitly selected stops pay no endpoint overhead, so this coordinate
  // lower-bound proof does not apply to mixed or exact-stop requests.
  if (explicitRoutingStopId(origin) || explicitRoutingStopId(destination)) return false
  const maxWalkKm = Math.max(0.2, Math.min(5, numeric(request.maxWalkKm, 1.6)))
  const crowFlightKm = haversineKm(origin.coordinate, destination.coordinate)
  const physicalWalkLowerBoundMinutes = crowFlightKm / walkingSpeedKph * 60
  return crowFlightKm <= maxWalkKm + 1e-9
    && physicalWalkLowerBoundMinutes < directWalkTransitEndpointLowerBoundMinutes
}

export function dominantDirectWalkPlan(request, maxWalkKm) {
  if (!shouldProbeNationalDirectWalkDominance(request)) return null
  const strictProofDistanceKm = Math.min(
    maxWalkKm,
    directWalkEndToEndLimitKm(request),
    directWalkTransitEndpointLowerBoundMinutes / 60 * walkingSpeedKph,
  )
  const path = streetPathBetween(
    request.streetStorePath,
    request.origin.coordinate,
    request.destination.coordinate,
    strictProofDistanceKm,
  )
  if (!path) return null
  const durationMinutes = path.distanceKm / walkingSpeedKph * 60
  if (!(durationMinutes < directWalkTransitEndpointLowerBoundMinutes)) return null
  return materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: 'osm_direct_walk_dominance',
    optimality: 'direct_walk_strictly_dominates_configured_endpoint_overhead_lower_bound',
    transitLowerBoundMinutes: directWalkTransitEndpointLowerBoundMinutes,
  })
}

function minimumAccessWalkSeconds(stops) {
  let minimumSeconds = Number.POSITIVE_INFINITY
  for (const stop of stops) {
    minimumSeconds = Math.min(minimumSeconds, accessWalkSeconds(stop))
  }
  return minimumSeconds
}

// OSM edges use spherical haversine lengths. The native endpoint snap uses a
// local metric whose smallest scale is 110.574 km/degree; over the supported
// five-kilometre endpoint envelope and |latitude| <= 85 degrees, 0.98 times
// the Earth chord is therefore below every legal snap-plus-graph path. This is
// a conservative metric certificate, not a product-tuning threshold.
const serviceAnchorChordLowerBoundFactor = 0.98

const serviceAnchorLatitudeLimit = 85

const earthMeanRadiusKm = 6371.0088

function sphericalChordKm(leftLon, leftLat, rightLon, rightLat) {
  const radians = (degrees) => degrees * Math.PI / 180
  const latitudeDelta = radians(rightLat - leftLat)
  const longitudeDelta = radians(rightLon - leftLon)
  const leftLatitude = radians(leftLat)
  const rightLatitude = radians(rightLat)
  const haversineValue = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude)
      * Math.cos(rightLatitude)
      * Math.sin(longitudeDelta / 2) ** 2
  return earthMeanRadiusKm
    * 2
    * Math.sqrt(Math.max(0, Math.min(1, haversineValue)))
}

function unitSphereCoordinate(longitude, latitude) {
  const longitudeRadians = longitude * Math.PI / 180
  const latitudeRadians = latitude * Math.PI / 180
  const latitudeScale = Math.cos(latitudeRadians)
  return {
    x: latitudeScale * Math.cos(longitudeRadians),
    y: latitudeScale * Math.sin(longitudeRadians),
    z: Math.sin(latitudeRadians),
  }
}

function unitSphereChordKm(coordinate, unitX, unitY, unitZ) {
  const xDelta = coordinate.x - unitX
  const yDelta = coordinate.y - unitY
  const zDelta = coordinate.z - unitZ
  return earthMeanRadiusKm * Math.sqrt(
    xDelta * xDelta + yDelta * yDelta + zDelta * zDelta,
  )
}

function serviceAccessAnchorProfile(
  db,
  resolvedStorePath,
  metadata,
  sourceStorageIdentity,
) {
  const retainedRoleCount = Number(
    db.prepare('SELECT COUNT(*) AS count FROM stop_access_roles').get()?.count ?? 0,
  )
  if (
    metadata.stopAccessRoleIndexVersion !== stopAccessRoleIndexVersion
    || Number(metadata.stopAccessRoleCount ?? -1) !== retainedRoleCount
  ) {
    const error = new Error(
      'Routing store requires a current persisted stop-access role index.',
    )
    error.code = 'resident_stop_access_index_required'
    throw error
  }
  const cacheKey = [
    resolvedStorePath,
    sourceStorageIdentity,
    metadata.stopAccessRoleIndexVersion,
    retainedRoleCount,
  ].join('\u0000')
  const cached = serviceAccessAnchorCache.get(cacheKey)
  if (cached) {
    serviceAccessAnchorCache.delete(cacheKey)
    serviceAccessAnchorCache.set(cacheKey, cached)
    return { profile: cached, cacheHit: true, buildMs: 0 }
  }

  const startedAt = performance.now()
  const longitudes = []
  const latitudes = []
  const unitX = []
  const unitY = []
  const unitZ = []
  const originEligible = []
  const destinationEligible = []
  const rows = db.prepare(`
    SELECT
      CASE
        WHEN NULLIF(stop.parent_station, '') IS NULL THEN stop.stop_id
        ELSE parent.stop_id
      END AS anchor_id,
      CASE
        WHEN NULLIF(stop.parent_station, '') IS NULL THEN stop.lon
        ELSE parent.lon
      END AS anchor_lon,
      CASE
        WHEN NULLIF(stop.parent_station, '') IS NULL THEN stop.lat
        ELSE parent.lat
      END AS anchor_lat,
      MAX(role.can_board) AS can_board,
      MAX(role.can_alight) AS can_alight
    FROM stop_access_roles AS role
    JOIN stops AS stop ON stop.stop_id=role.stop_id
    LEFT JOIN stops AS parent ON parent.stop_id=NULLIF(stop.parent_station, '')
    GROUP BY anchor_id, anchor_lon, anchor_lat
    HAVING anchor_lon IS NOT NULL AND anchor_lat IS NOT NULL
    ORDER BY anchor_id
  `)
  let originAnchorCount = 0
  let destinationAnchorCount = 0
  for (const row of rows.iterate()) {
    const canBoard = row.can_board === 1
    const canAlight = row.can_alight === 1
    if (!canBoard && !canAlight) continue
    const longitude = Number(row.anchor_lon)
    const latitude = Number(row.anchor_lat)
    const unitCoordinate = unitSphereCoordinate(longitude, latitude)
    longitudes.push(longitude)
    latitudes.push(latitude)
    unitX.push(unitCoordinate.x)
    unitY.push(unitCoordinate.y)
    unitZ.push(unitCoordinate.z)
    originEligible.push(Number(canBoard))
    destinationEligible.push(Number(canAlight))
    if (canBoard) originAnchorCount += 1
    if (canAlight) destinationAnchorCount += 1
  }
  const profileIdentity = [
    'service-access-v1',
    metadata.sourceFingerprint ?? metadata.storeId ?? 'unknown',
    sourceStorageIdentity,
    metadata.stopAccessRoleIndexVersion,
    retainedRoleCount,
    longitudes.length,
    originAnchorCount,
    destinationAnchorCount,
  ].join('|')
  const profile = Object.freeze({
    schemaVersion: 'vigo.routing.service-access-anchor-profile.v1',
    profileIdentity,
    sourceStorageIdentity,
    retainedRoleCount,
    longitudes: Float64Array.from(longitudes),
    latitudes: Float64Array.from(latitudes),
    unitX: Float64Array.from(unitX),
    unitY: Float64Array.from(unitY),
    unitZ: Float64Array.from(unitZ),
    originEligible: Uint8Array.from(originEligible),
    destinationEligible: Uint8Array.from(destinationEligible),
    anchorCount: longitudes.length,
    originAnchorCount,
    destinationAnchorCount,
  })
  serviceAccessAnchorCache.set(cacheKey, profile)
  while (serviceAccessAnchorCache.size > serviceAccessAnchorCacheMaxEntries) {
    const oldestKey = serviceAccessAnchorCache.keys().next().value
    if (oldestKey === undefined) break
    serviceAccessAnchorCache.delete(oldestKey)
  }
  return {
    profile,
    cacheHit: false,
    buildMs: Number((performance.now() - startedAt).toFixed(3)),
  }
}

function materializeServiceAnchorLowerBound(profile, coordinate, state) {
  if (state.anchorIndex < 0) return null
  const exactCoordinate = (
    coordinate[0] === profile.longitudes[state.anchorIndex]
    && coordinate[1] === profile.latitudes[state.anchorIndex]
  )
  return {
    anchorIndex: state.anchorIndex,
    distanceKm: state.distanceKm,
    seconds: exactCoordinate ? 0 : walkSeconds(state.distanceKm),
  }
}

function minimumServiceAnchorLowerBounds(
  profile,
  originCoordinate,
  destinationCoordinate,
) {
  const originUnit = unitSphereCoordinate(
    originCoordinate[0],
    originCoordinate[1],
  )
  const destinationUnit = unitSphereCoordinate(
    destinationCoordinate[0],
    destinationCoordinate[1],
  )
  const origin = {
    distanceKm: Number.POSITIVE_INFINITY,
    anchorIndex: -1,
  }
  const destination = {
    distanceKm: Number.POSITIVE_INFINITY,
    anchorIndex: -1,
  }
  for (let index = 0; index < profile.anchorCount; index += 1) {
    const anchorLatitude = profile.latitudes[index]
    if (Math.abs(anchorLatitude) > serviceAnchorLatitudeLimit) continue
    if (profile.originEligible[index] === 1) {
      const distanceKm = unitSphereChordKm(
        originUnit,
        profile.unitX[index],
        profile.unitY[index],
        profile.unitZ[index],
      ) * serviceAnchorChordLowerBoundFactor
      if (distanceKm < origin.distanceKm) {
        origin.distanceKm = distanceKm
        origin.anchorIndex = index
      }
    }
    if (profile.destinationEligible[index] === 1) {
      const distanceKm = unitSphereChordKm(
        destinationUnit,
        profile.unitX[index],
        profile.unitY[index],
        profile.unitZ[index],
      ) * serviceAnchorChordLowerBoundFactor
      if (distanceKm < destination.distanceKm) {
        destination.distanceKm = distanceKm
        destination.anchorIndex = index
      }
    }
  }
  return {
    origin: materializeServiceAnchorLowerBound(
      profile,
      originCoordinate,
      origin,
    ),
    destination: materializeServiceAnchorLowerBound(
      profile,
      destinationCoordinate,
      destination,
    ),
  }
}

function lightweightIncompleteCoveragePlan(
  resolvedStorePath,
  sourceStorageIdentity,
  request,
  maxWalkKm,
  routingSemantics,
  serviceDateResolution,
  startedAt,
) {
  const directWalkEligible = (
    !transitRideRequired(request)
    && request.streetStorePath
    && Array.isArray(request.origin?.coordinate)
    && Array.isArray(request.destination?.coordinate)
    && !explicitRoutingStopId(request.origin)
    && !explicitRoutingStopId(request.destination)
    && haversineKm(request.origin.coordinate, request.destination.coordinate)
      <= maxWalkKm + 1e-9
  )
  const streetSearchStartedAt = performance.now()
  const directPath = directWalkEligible
    ? streetPathBetween(
        request.streetStorePath,
        request.origin.coordinate,
        request.destination.coordinate,
        maxWalkKm,
      )
    : null
  const streetSearchMs = directWalkEligible
    ? Number((performance.now() - streetSearchStartedAt).toFixed(3))
    : 0
  if (
    staticTopologySourceStorageSnapshot(resolvedStorePath)
    !== sourceStorageIdentity
  ) return null
  if (directPath && directPath.distanceKm <= directWalkEndToEndLimitKm(request) + 1e-9) {
    const plan = materializeDirectWalkCandidate(
      request,
      maxWalkKm,
      directPath,
      {
        algorithm: 'osm_direct_walk_incomplete_service_coverage',
        optimality:
          'graph_verified_direct_walk_when_required_service_coverage_is_incomplete',
        transitLowerBoundMinutes: undefined,
      },
    )
    const queryMs = Number((performance.now() - startedAt).toFixed(3))
    return {
      ...plan,
      diagnostics: {
        ...plan.diagnostics,
        ...serviceDateDiagnostics(serviceDateResolution),
        dataSemantics: routingSemantics.routingDataSemantics,
        methodState: 'complete',
        transitSearchAttempted: false,
        transitSearchSkippedReason: 'incomplete_required_service_coverage',
        transitFailureCode: 'incomplete_service_coverage',
        transitFailureCategory: 'schedule',
        directWalkFallback: {
          streetSearchMs,
          streetPathReused: false,
          distanceKm: directPath.distanceKm,
        },
        transitServiceCoverageProbe:
          serviceDateDiagnostics(serviceDateResolution),
        searchStats: {
          queryMs,
          engineQueryMs: streetSearchMs,
        },
      },
    }
  }
  const selectedMinutes = numeric(
    request.timePreference === 'arrive'
      ? request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes
      : request.departMinutes,
    8 * 60,
  )
  const plan = incompleteServiceCoveragePlan(
    request,
    selectedMinutes,
    maxWalkKm,
    serviceDateResolution,
  )
  const queryMs = Number((performance.now() - startedAt).toFixed(3))
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      optimality: 'search_limited_to_supported_scheduled_core',
      dataSemantics: routingSemantics.routingDataSemantics,
      methodState: 'failed',
      transitSearchAttempted: false,
      transitSearchSkippedReason: 'incomplete_required_service_coverage',
      transitFailureCode: 'incomplete_service_coverage',
      transitFailureCategory: 'data_coverage',
      transitServiceCoverageProbe:
        serviceDateDiagnostics(serviceDateResolution),
      searchStats: {
        ...plan.diagnostics.searchStats,
        queryMs,
        engineQueryMs: streetSearchMs,
      },
    },
  }
}

export function lightweightServiceAnchorDirectWalkProbe(storePath, request, maxWalkKm) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || directWalkTransitEndpointLowerBoundMinutes > 0
    || explicitRoutingStopId(request.origin)
    || explicitRoutingStopId(request.destination)
    || requestedAccessStopIds(request, '__originAccessStopIds')
    || requestedAccessStopIds(request, '__destinationAccessStopIds')
    || !Array.isArray(request.origin?.coordinate)
    || !Array.isArray(request.destination?.coordinate)
    || !request.origin.coordinate.every(Number.isFinite)
    || !request.destination.coordinate.every(Number.isFinite)
    || Math.abs(request.origin.coordinate[1]) > serviceAnchorLatitudeLimit
    || Math.abs(request.destination.coordinate[1]) > serviceAnchorLatitudeLimit
  ) return null

  const directWalkEligible = (
    haversineKm(request.origin.coordinate, request.destination.coordinate)
      <= maxWalkKm + 1e-9
  )
  const startedAt = performance.now()
  const resolvedStorePath = path.resolve(storePath)
  const sourceStorageSnapshot = staticTopologySourceStorageSnapshot(
    resolvedStorePath,
  )
  let db
  let anchorProfile
  let serviceDateResolution
  let routingSemantics
  let incompleteServiceCoverage = false
  try {
    db = new DatabaseSync(resolvedStorePath, { readOnly: true })
    db.exec('PRAGMA mmap_size=0; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY;')
    const { metadata } = admitNationalRoutingStore(db, resolvedStorePath)
    admitCurrentTransferSemantics(db, resolvedStorePath, metadata)
    const hasConnectionPermissions = db.prepare(`
      SELECT 1 AS ready
      FROM sqlite_master
      WHERE type='table' AND name='connection_permissions'
    `).get()?.ready === 1
    routingSemantics = routingSemanticsFromMetadata(
      metadata,
      hasConnectionPermissions,
    )
    if (routingSemantics.blockingRoutingFeatures.length) return null
    const lightweightStore = {
      db,
      serviceModel: metadata.serviceModel || 'exact-date',
      sourceScopes: Array.isArray(metadata.sourceStores)
        ? metadata.sourceStores
          .map((source) => String(source.scope || ''))
          .filter(Boolean)
        : [],
      servicesByDate: new Map(),
      serviceDateResolutionCache: new Map(),
    }
    serviceDateResolution = lightweightServiceAnchorDateResolution(
      lightweightStore,
      request,
    )
    incompleteServiceCoverage = requiredServiceCoverageIncomplete(
      request,
      serviceDateResolution,
    )
    if (!incompleteServiceCoverage && directWalkEligible) {
      anchorProfile = serviceAccessAnchorProfile(
        db,
        resolvedStorePath,
        metadata,
        sourceStorageSnapshot,
      )
    }
  } finally {
    try { db?.close() } catch {}
  }

  if (incompleteServiceCoverage) {
    return lightweightIncompleteCoveragePlan(
      resolvedStorePath,
      sourceStorageSnapshot,
      request,
      maxWalkKm,
      routingSemantics,
      serviceDateResolution,
      startedAt,
    )
  }
  if (!directWalkEligible) return null

  const anchorScanStartedAt = performance.now()
  const anchorLowerBounds = minimumServiceAnchorLowerBounds(
    anchorProfile.profile,
    request.origin.coordinate,
    request.destination.coordinate,
  )
  const originLowerBound = anchorLowerBounds.origin
  const destinationLowerBound = anchorLowerBounds.destination
  const anchorScanMs = Number(
    (performance.now() - anchorScanStartedAt).toFixed(3),
  )
  if (!originLowerBound || !destinationLowerBound) return null
  const transitEndpointLowerBoundSeconds = originLowerBound.seconds
    + destinationLowerBound.seconds
  if (!(transitEndpointLowerBoundSeconds > 0)) return null
  const directPhysicalLowerBoundSeconds = (
    sphericalChordKm(
      request.origin.coordinate[0],
      request.origin.coordinate[1],
      request.destination.coordinate[0],
      request.destination.coordinate[1],
    )
    * serviceAnchorChordLowerBoundFactor
    / walkingSpeedKph
    * 3600
    * accessPaddingFactor
  )
  if (!(directPhysicalLowerBoundSeconds < transitEndpointLowerBoundSeconds)) {
    return null
  }

  const streetSearchStartedAt = performance.now()
  const directPath = streetPathBetween(
    request.streetStorePath,
    request.origin.coordinate,
    request.destination.coordinate,
    maxWalkKm,
  )
  const streetSearchMs = Number(
    (performance.now() - streetSearchStartedAt).toFixed(3),
  )
  if (!directPath || directPath.distanceKm > directWalkEndToEndLimitKm(request) + 1e-9) return null
  const directWalkSeconds = directPath.distanceKm / walkingSpeedKph * 3600
  if (!(directWalkSeconds < transitEndpointLowerBoundSeconds)) return null
  if (
    staticTopologySourceStorageSnapshot(resolvedStorePath)
    !== sourceStorageSnapshot
  ) return null

  const plan = materializeDirectWalkCandidate(
    request,
    maxWalkKm,
    directPath,
    {
      algorithm: 'osm_direct_walk_service_anchor_lower_bound',
      optimality:
        'direct_walk_strictly_dominates_exact_service_anchor_lower_bound',
      transitLowerBoundMinutes: transitEndpointLowerBoundSeconds / 60,
    },
  )
  const queryMs = Number((performance.now() - startedAt).toFixed(3))
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      dataSemantics: routingSemantics.routingDataSemantics,
      methodState: 'complete',
      originStopCandidates: anchorProfile.profile.originAnchorCount,
      destinationStopCandidates:
        anchorProfile.profile.destinationAnchorCount,
      originAccessLowerBoundSeconds: originLowerBound.seconds,
      destinationEgressLowerBoundSeconds: destinationLowerBound.seconds,
      transitEndpointLowerBoundSeconds,
      coordinateAccessLowerBound:
        'global_role_eligible_public_anchor_chord_certificate',
      serviceAccessAnchorProfile: {
        schemaVersion: anchorProfile.profile.schemaVersion,
        profileIdentity: anchorProfile.profile.profileIdentity,
        sourceStorageIdentity: anchorProfile.profile.sourceStorageIdentity,
        anchors: anchorProfile.profile.anchorCount,
        originAnchors: anchorProfile.profile.originAnchorCount,
        destinationAnchors: anchorProfile.profile.destinationAnchorCount,
        retainedRoleCount: anchorProfile.profile.retainedRoleCount,
        cacheHit: anchorProfile.cacheHit,
        buildMs: anchorProfile.buildMs,
        scanMs: anchorScanMs,
        distanceKernel: 'single_pass_precomputed_unit_chord',
        scanPasses: 1,
        chordLowerBoundFactor: serviceAnchorChordLowerBoundFactor,
        latitudeDomain: [-serviceAnchorLatitudeLimit, serviceAnchorLatitudeLimit],
      },
      transitServiceCoverageProbe:
        serviceDateDiagnostics(serviceDateResolution),
      directWalkProof: {
        streetSearchMs,
        directWalkSeconds,
        transitEndpointLowerBoundSeconds,
      },
      searchStats: {
        queryMs,
        engineQueryMs: streetSearchMs,
      },
    },
  }
}

export function accessFrontierDirectWalkProbe(
  request,
  maxWalkKm,
  originStops,
  destinationStops,
) {
  return accessFrontierDirectWalkProbeFromMetrics(
    request,
    maxWalkKm,
    minimumAccessWalkSeconds(originStops),
    minimumAccessWalkSeconds(destinationStops),
    originStops.length,
    destinationStops.length,
  )
}

export function accessFrontierDirectWalkProbeFromNative(
  request,
  maxWalkKm,
  routed,
) {
  const endpoints = routed.endpoints
  const minimum = (values) => {
    let result = Number.POSITIVE_INFINITY
    for (const value of values) result = Math.min(result, Number(value))
    return result
  }
  const verifiedPath = routed.directWalkPathChecked
    ? routed.directWalkPath
    : routed.directWalkCchChecked
    ? Number.isFinite(routed.directWalkDistanceKm)
      ? {
          distanceKm: routed.directWalkDistanceKm,
          nativeDistanceOnly: true,
          nativeQueryMs: timingMilliseconds(routed.directWalkQueryMs),
          nativeSettledNodes: 0,
          nativeRelaxedEdges: 0,
        }
      : null
    : undefined
  return accessFrontierDirectWalkProbeFromMetrics(
    request,
    maxWalkKm,
    Number.isFinite(routed.minimumOriginAccessSeconds)
      ? routed.minimumOriginAccessSeconds
      : minimum(endpoints.originAccessSeconds),
    Number.isFinite(routed.minimumDestinationAccessSeconds)
      ? routed.minimumDestinationAccessSeconds
      : minimum(endpoints.destinationAccessSeconds),
    routed.originCandidateCount,
    routed.destinationCandidateCount,
    verifiedPath,
    routed.directWalkQueryMs,
  )
}

function accessFrontierDirectWalkProbeFromMetrics(
  request,
  maxWalkKm,
  minimumAccessSeconds,
  minimumEgressSeconds,
  originCandidateCount,
  destinationCandidateCount,
  verifiedPath = undefined,
  verifiedPathSearchMs = undefined,
) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || explicitRoutingStopId(request.origin)
    || explicitRoutingStopId(request.destination)
    || requestedAccessStopIds(request, '__originAccessStopIds')
    || requestedAccessStopIds(request, '__destinationAccessStopIds')
  ) return { plan: null, path: undefined }
  const transitEndpointLowerBoundSeconds = minimumAccessSeconds + minimumEgressSeconds
  if (!(transitEndpointLowerBoundSeconds > 0)) return { plan: null, path: undefined }
  const crowFlightKm = haversineKm(
    request.origin.coordinate,
    request.destination.coordinate,
  )
  if (crowFlightKm > maxWalkKm + 1e-9) return { plan: null, path: undefined }
  const physicalWalkLowerBoundSeconds = crowFlightKm / walkingSpeedKph * 3600
  if (!(physicalWalkLowerBoundSeconds < transitEndpointLowerBoundSeconds)) {
    return { plan: null, path: undefined }
  }
  const streetSearchStartedAt = performance.now()
  let path = verifiedPath === undefined
    ? streetPathBetween(
        request.streetStorePath,
        request.origin.coordinate,
        request.destination.coordinate,
        maxWalkKm,
      )
    : verifiedPath
  let streetSearchMs = verifiedPath === undefined
    ? Number((performance.now() - streetSearchStartedAt).toFixed(3))
    : numeric(verifiedPathSearchMs, 0)
  if (!path || path.distanceKm > directWalkEndToEndLimitKm(request) + 1e-9) return { plan: null, path, streetSearchMs }
  const durationSeconds = path.distanceKm / walkingSpeedKph * 3600
  if (!(durationSeconds < transitEndpointLowerBoundSeconds)) {
    return { plan: null, path, streetSearchMs }
  }
  if (path.nativeDistanceOnly) {
    const materializationStartedAt = performance.now()
    path = streetPathBetween(
      request.streetStorePath,
      request.origin.coordinate,
      request.destination.coordinate,
      maxWalkKm,
    )
    streetSearchMs += performance.now() - materializationStartedAt
    if (!path) return { plan: null, path: null, streetSearchMs }
  }
  const plan = materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: 'osm_direct_walk_access_frontier_dominance',
    optimality: 'direct_walk_strictly_dominates_complete_endpoint_access_lower_bound',
    transitLowerBoundMinutes: transitEndpointLowerBoundSeconds / 60,
  })
  return {
    path,
    streetSearchMs,
    plan: {
      ...plan,
      diagnostics: {
        ...plan.diagnostics,
        originStopCandidates: originCandidateCount,
        destinationStopCandidates: destinationCandidateCount,
        originAccessLowerBoundSeconds: minimumAccessSeconds,
        destinationEgressLowerBoundSeconds: minimumEgressSeconds,
        transitEndpointLowerBoundSeconds,
        coordinateAccessFrontier: 'complete_osm_reachable',
        directWalkProof: {
          streetSearchMs,
          directWalkSeconds: durationSeconds,
          transitEndpointLowerBoundSeconds,
        },
      },
    },
  }
}

export function directWalkEnvelopeDiagnostics(request, maxWalkKm, path) {
  const directWalkLimitKm = directWalkEndToEndLimitKm(request)
  return {
    distanceKm: path.distanceKm,
    maxWalkKm,
    accessEgressLimitKm: maxWalkKm,
    directWalkLimitKm,
    directWalkLimitScope: 'end-to-end',
    exceedsAccessEgressLimit: path.distanceKm > maxWalkKm + 1e-9,
  }
}

export function directWalkAfterBlockedTransitPlan(
  request,
  maxWalkKm,
  transitPlan,
  verifiedPath = undefined,
  verifiedPathSearchMs = undefined,
) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || transitPlan?.status === 'ready'
  ) return null
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return null
  // Exact-stop routing is a distinct API surface. This fallback completes the
  // arbitrary-point WALK+TRANSIT contract without changing the exact-stop
  // endpoint contract.
  if (explicitRoutingStopId(origin) || explicitRoutingStopId(destination)) return null
  // maxWalkKm is a per-endpoint transit access/egress constraint. A complete
  // A-to-B pedestrian journey has the independent end-to-end envelope used by
  // the public walk router; conflating the two incorrectly blocks valid walks
  // whenever neither endpoint can reach transit inside the selected budget.
  const directWalkLimitKm = directWalkEndToEndLimitKm(request)
  if (
    haversineKm(origin.coordinate, destination.coordinate)
      > directWalkLimitKm + 1e-9
  ) return null
  const streetSearchStartedAt = performance.now()
  // A failed proof bounded by maxWalkKm says nothing about a longer, legal
  // end-to-end walk, so only reuse that miss when both envelopes are equal.
  const streetPathReused = verifiedPath !== undefined && (
    verifiedPath !== null
    || directWalkLimitKm <= maxWalkKm + 1e-9
  )
  let path = !streetPathReused
    ? streetPathBetween(
        request.streetStorePath,
        origin.coordinate,
        destination.coordinate,
        directWalkLimitKm,
      )
    : verifiedPath
  let streetSearchMs = streetPathReused
    ? numeric(verifiedPathSearchMs, 0)
    : Number((performance.now() - streetSearchStartedAt).toFixed(3))
  if (path?.nativeDistanceOnly) {
    const materializationStartedAt = performance.now()
    path = streetPathBetween(
      request.streetStorePath,
      origin.coordinate,
      destination.coordinate,
      directWalkLimitKm,
    )
    streetSearchMs += performance.now() - materializationStartedAt
  }
  if (!path || path.distanceKm > directWalkLimitKm + 1e-9) return null
  const failureCode = transitPlan?.diagnostics?.failure?.code
    ?? transitPlan?.diagnostics?.failureCode
    ?? 'no_path'
  const walkPlan = materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: 'osm_direct_walk_no_transit_fallback',
    optimality: 'graph_verified_direct_walk_when_no_supported_transit_path',
    transitLowerBoundMinutes: undefined,
  })
  return {
    ...walkPlan,
    diagnostics: {
      ...walkPlan.diagnostics,
      ...(transitPlan?.diagnostics?.realtimeRouting ? { realtimeRouting: transitPlan.diagnostics.realtimeRouting } : {}),
      scannedDepartures: numeric(transitPlan?.diagnostics?.scannedDepartures, 0),
      relaxedStops: numeric(transitPlan?.diagnostics?.relaxedStops, 0),
      serviceDay: transitPlan?.diagnostics?.serviceDay ?? walkPlan.diagnostics.serviceDay,
      serviceDate: transitPlan?.diagnostics?.serviceDate ?? walkPlan.diagnostics.serviceDate,
      requestedServiceDate: transitPlan?.diagnostics?.requestedServiceDate
        ?? walkPlan.diagnostics.requestedServiceDate,
      resolvedServiceDate: transitPlan?.diagnostics?.resolvedServiceDate
        ?? walkPlan.diagnostics.resolvedServiceDate,
      serviceDateFallbackApplied: transitPlan?.diagnostics?.serviceDateFallbackApplied === true,
      requestedServiceScopeCount: numeric(
        transitPlan?.diagnostics?.requestedServiceScopeCount,
        walkPlan.diagnostics.requestedServiceScopeCount,
      ),
      resolvedServiceScopeCount: numeric(
        transitPlan?.diagnostics?.resolvedServiceScopeCount,
        walkPlan.diagnostics.resolvedServiceScopeCount,
      ),
      availableServiceScopeCount: numeric(
        transitPlan?.diagnostics?.availableServiceScopeCount,
        walkPlan.diagnostics.availableServiceScopeCount,
      ),
      originStopCandidates: numeric(transitPlan?.diagnostics?.originStopCandidates, 0),
      destinationStopCandidates: numeric(transitPlan?.diagnostics?.destinationStopCandidates, 0),
      searchStats: {
        ...transitPlan?.diagnostics?.searchStats,
        directWalkFallbackMs: streetSearchMs,
        directWalkFallbackNativeQueryMs: timingMilliseconds(path.nativeQueryMs),
        directWalkFallbackSettledNodes: path.nativeSettledNodes,
        directWalkFallbackRelaxedEdges: path.nativeRelaxedEdges,
        directWalkFallbackChainSkippedNodes: path.nativeChainSkippedNodes,
        directWalkFallbackContractedArcRelaxations:
          path.nativeContractedArcRelaxations,
        directWalkFallbackCchAccelerated: path.nativeCchAccelerated === true,
      },
      transitSearchAttempted: true,
      transitFailureCode: failureCode,
      transitFailureCategory: transitPlan?.diagnostics?.failure?.category
        ?? transitPlan?.diagnostics?.failureCategory
        ?? 'routing',
      directWalkFallback: {
        streetSearchMs,
        streetPathReused,
        nativeQueryMs: timingMilliseconds(path.nativeQueryMs),
        nativeSettledNodes: path.nativeSettledNodes,
        nativeRelaxedEdges: path.nativeRelaxedEdges,
        nativeChainSkippedNodes: path.nativeChainSkippedNodes,
        nativeContractedArcRelaxations: path.nativeContractedArcRelaxations,
        nativeCchAccelerated: path.nativeCchAccelerated === true,
        ...directWalkEnvelopeDiagnostics(request, maxWalkKm, path),
        transitStatus: transitPlan?.status ?? 'blocked',
        transitFailureCode: failureCode,
        transitAlgorithm: transitPlan?.diagnostics?.algorithm ?? null,
        transitSearchQueryMs: timingMilliseconds(
          transitPlan?.diagnostics?.searchStats?.queryMs,
          null,
        ),
      },
    },
  }
}

export function transitDominatingDirectWalkPlan(
  request,
  maxWalkKm,
  transitPlan,
  verifiedPath = undefined,
  verifiedPathSearchMs = undefined,
) {
  if (
    transitRideRequired(request)
    || !request.streetStorePath
    || transitPlan?.status !== 'ready'
    || transitPlan?.travelMode !== 'transit'
  ) return null
  const origin = request.origin
  const destination = request.destination
  if (!origin?.coordinate || !destination?.coordinate) return null
  // Transit access/egress and a complete A-to-B walk have distinct envelopes.
  // The final mode comparator must use the same end-to-end street bound as the
  // no-transit fallback, regardless of whether a transit plan is available.
  const directWalkLimitKm = directWalkEndToEndLimitKm(request)
  const crowFlightKm = haversineKm(origin.coordinate, destination.coordinate)
  if (crowFlightKm > directWalkLimitKm + 1e-9) return null
  const arriveBy = request.timePreference === 'arrive'
  const selectedArrival = numeric(request.arriveMinutes ?? request.timeMinutes ?? request.departMinutes, 8 * 60)
  const physicalWalkLowerBoundMinutes = crowFlightKm / walkingSpeedKph * 60
  // Avoid a street-graph query when the physical lower bound cannot improve
  // the public objective. Depart-at minimizes arrival/duration; arrive-by
  // maximizes the first departure, even when the direct walk lasts longer.
  if (arriveBy) {
    if (selectedArrival - physicalWalkLowerBoundMinutes <= numeric(transitPlan.departMinutes, Number.NEGATIVE_INFINITY)) return null
  } else if (physicalWalkLowerBoundMinutes > numeric(transitPlan.durationMinutes, 0) + 1e-9) return null
  const competitiveWalkMinutes = arriveBy
    ? selectedArrival - numeric(transitPlan.departMinutes, selectedArrival)
    : numeric(transitPlan.durationMinutes, 0)
  const competitiveDistanceLimitKm = Math.min(
    directWalkLimitKm,
    competitiveWalkMinutes / 60 * walkingSpeedKph,
  )
  if (!(competitiveDistanceLimitKm > 0)) return null
  const streetSearchStartedAt = performance.now()
  // A miss bounded by the narrower endpoint envelope cannot prove that no
  // legal end-to-end path exists. Reuse a miss only when both bounds coincide.
  const streetPathReused = verifiedPath !== undefined && (
    verifiedPath !== null
    || competitiveDistanceLimitKm <= maxWalkKm + 1e-9
  )
  let path = streetPathReused
    ? verifiedPath
    : streetPathBetween(
        request.streetStorePath,
        origin.coordinate,
        destination.coordinate,
        competitiveDistanceLimitKm,
      )
  let streetSearchMs = streetPathReused
    ? numeric(verifiedPathSearchMs, 0)
    : Number((performance.now() - streetSearchStartedAt).toFixed(3))
  if (
    path?.nativeDistanceOnly
    && path.distanceKm <= competitiveDistanceLimitKm + 1e-9
  ) {
    const materializationStartedAt = performance.now()
    path = streetPathBetween(
      request.streetStorePath,
      origin.coordinate,
      destination.coordinate,
      competitiveDistanceLimitKm,
    )
    streetSearchMs += performance.now() - materializationStartedAt
  }
  const comparisonDiagnostics = {
    streetSearchMs,
    streetPathReused,
    competitiveDistanceLimitKm,
    directWalkLimitKm,
    ...(path ? {
      nativeQueryMs: timingMilliseconds(path.nativeQueryMs),
      nativeSettledNodes: path.nativeSettledNodes,
      nativeRelaxedEdges: path.nativeRelaxedEdges,
      nativeChainSkippedNodes: path.nativeChainSkippedNodes,
      nativeContractedArcRelaxations: path.nativeContractedArcRelaxations,
      nativeCchAccelerated: path.nativeCchAccelerated === true,
    } : {}),
  }
  const retainTransitPlan = (outcome) => ({
    ...transitPlan,
    diagnostics: {
      ...transitPlan.diagnostics,
      directWalkComparison: { ...comparisonDiagnostics, outcome },
      searchStats: {
        ...transitPlan.diagnostics?.searchStats,
        directWalkComparisonMs: streetSearchMs,
      },
    },
  })
  if (!path || path.distanceKm > competitiveDistanceLimitKm + 1e-9) {
    return retainTransitPlan('no_competitive_path')
  }
  const durationMinutes = path.distanceKm / walkingSpeedKph * 60
  const materializedWalkPlan = materializeDirectWalkCandidate(request, maxWalkKm, path, {
    algorithm: arriveBy ? 'osm_direct_walk_latest_departure' : 'osm_direct_walk_vs_transit',
    optimality: arriveBy
      ? 'latest_departure_across_direct_walk_and_materialized_transit_plan'
      : 'direct_walk_dominates_materialized_transit_plan',
    transitLowerBoundMinutes: undefined,
    transitAlternativeMinutes: transitPlan.durationMinutes,
  })
  const walkPlan = {
    ...materializedWalkPlan,
    diagnostics: {
      ...materializedWalkPlan.diagnostics,
      ...(transitPlan.diagnostics?.realtimeRouting ? { realtimeRouting: transitPlan.diagnostics.realtimeRouting } : {}),
      directWalkStreetSearchMs: streetSearchMs,
      directWalkStreetPathReused: streetPathReused,
      directWalkComparison: { ...comparisonDiagnostics, outcome: 'direct_walk' },
      searchStats: {
        ...transitPlan.diagnostics?.searchStats,
        directWalkComparisonMs: streetSearchMs,
      },
      directWalkEnvelope: directWalkEnvelopeDiagnostics(
        request,
        maxWalkKm,
        path,
      ),
    },
  }
  if (arriveBy) {
    return walkPlan.departMinutes > numeric(transitPlan.departMinutes, Number.NEGATIVE_INFINITY)
      ? walkPlan
      : retainTransitPlan('transit')
  }
  // The strict point objective is lexicographic in (arrival, boardings, walking).
  // A walk-only path has zero boardings, so it wins an exact arrival tie with
  // a ride-bearing path instead of inheriting an implementation-order tie.
  return durationMinutes <= numeric(transitPlan.durationMinutes, 0) + 1e-9
    ? walkPlan
    : retainTransitPlan('transit')
}

// The coordinator clears anchor profiles with the store that owns them.
export function clearServiceAccessAnchors(resolvedStorePath) {
  if (resolvedStorePath === undefined) {
    serviceAccessAnchorCache.clear()
    return
  }
  for (const key of serviceAccessAnchorCache.keys()) {
    if (key.startsWith(`${resolvedStorePath}\u0000`)) serviceAccessAnchorCache.delete(key)
  }
}
