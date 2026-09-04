import crypto from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import { haversineKm } from './geometry-utils.mjs'

const workerInstance = crypto.randomUUID()
const workerStartedAt = Date.now()
const operationCounts = {}
let gtfsModulePromise
let stopSearchModulePromise
let osmModulePromise

function loadGtfsModule() {
  gtfsModulePromise ??= import('./national-gtfs-store.mjs')
  return gtfsModulePromise
}

function loadStopSearchModule() {
  stopSearchModulePromise ??= import('./national-stop-search.mjs')
  return stopSearchModulePromise
}

function loadOsmModule() {
  osmModulePromise ??= import('./national-osm-store.mjs')
  return osmModulePromise
}

function tripConnectionCacheFrom(result) {
  return result?.tripConnectionCache
    ?? result?.diagnostics?.searchStats?.tripConnectionCache
    ?? result?.plan?.diagnostics?.searchStats?.tripConnectionCache
}

function runtimeMetrics(result, operation, operationMs) {
  const memory = process.memoryUsage()
  return {
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBufferBytes: memory.arrayBuffers,
    // Node reports ArrayBuffer storage inside `external`; adding both values
    // double-counts the same native allocation and can trigger false pressure.
    isolateResidentEstimateBytes: memory.heapUsed + memory.external,
    processRssBytes: memory.rss,
    processRssScope: 'process-wide-snapshot',
    workerAgeMs: Date.now() - workerStartedAt,
    operation,
    operationMs,
    operationCounts: { ...operationCounts },
    tripConnectionCache: tripConnectionCacheFrom(result),
  }
}

function compactActiveServiceKernelDiagnostics(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.calibrationSearches)) return value
  const { calibrationSearches, ...diagnostics } = value
  return {
    ...diagnostics,
    calibrationSearchCount: calibrationSearches.length,
  }
}

function compactRoutingPlanDiagnostics(plan) {
  const searchStats = plan?.diagnostics?.searchStats
  if (!searchStats?.activeServiceKernel) return plan
  return {
    ...plan,
    diagnostics: {
      ...plan.diagnostics,
      searchStats: {
        ...searchStats,
        activeServiceKernel: compactActiveServiceKernelDiagnostics(searchStats.activeServiceKernel),
      },
    },
  }
}

function compactStreetRouteBatchResult(result) {
  if (!result || typeof result !== 'object') return result
  return {
    status: result.status,
    segments: Array.isArray(result.segments)
      ? result.segments.map((segment) => ({
          coordinates: segment.coordinates,
          distanceKm: segment.distanceKm,
          durationMinutes: segment.durationMinutes,
          originSnapDistanceM: segment.originSnapDistanceM,
          destinationSnapDistanceM: segment.destinationSnapDistanceM,
          ...(segment.source ? { source: segment.source } : {}),
        }))
      : [],
    ...(Number.isInteger(result.failedIndex) ? { failedIndex: result.failedIndex } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
    ...(result.fallbackUsed ? { fallbackUsed: true } : {}),
    ...(Number.isInteger(result.fallbackSegmentCount) ? { fallbackSegmentCount: result.fallbackSegmentCount } : {}),
    ...(Array.isArray(result.fallbackSegments) ? { fallbackSegments: result.fallbackSegments } : {}),
    ...(Number.isInteger(result.publishedShapeSegmentCount) ? { publishedShapeSegmentCount: result.publishedShapeSegmentCount } : {}),
    ...(Number.isInteger(result.osmSegmentCount) ? { osmSegmentCount: result.osmSegmentCount } : {}),
    ...(Array.isArray(result.snappedCoordinates) ? { snappedCoordinates: result.snappedCoordinates } : {}),
    ...(Array.isArray(result.snapDistancesM) ? { snapDistancesM: result.snapDistancesM } : {}),
    ...(Number.isFinite(result.totalDistanceKm) ? { totalDistanceKm: result.totalDistanceKm } : {}),
    ...(Number.isFinite(result.totalDurationMinutes) ? { totalDurationMinutes: result.totalDurationMinutes } : {}),
  }
}

function earliestTransitEvidenceFromPlans(plans) {
  let earliest = null
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (plan?.status !== 'ready' || plan?.travelMode !== 'transit') continue
    const firstRide = plan.legs?.find((leg) => leg.type === 'ride')
    const firstBoardingMinutes = Number(firstRide?.startMinutes)
    const arriveMinutes = Number(plan.arriveMinutes)
    if (!firstRide || !Number.isFinite(firstBoardingMinutes) || !Number.isFinite(arriveMinutes)) continue
    const candidate = {
      status: 'ready',
      departMinutes: Number(plan.departMinutes),
      firstBoardingMinutes,
      arriveMinutes,
      routeShortName: firstRide.routeShortName || firstRide.routeId || undefined,
      transfers: Number(plan.transfers ?? 0),
    }
    if (
      !earliest
      || candidate.firstBoardingMinutes < earliest.firstBoardingMinutes
      || candidate.firstBoardingMinutes === earliest.firstBoardingMinutes
        && (candidate.arriveMinutes < earliest.arriveMinutes
          || candidate.arriveMinutes === earliest.arriveMinutes
            && candidate.transfers < earliest.transfers)
    ) {
      earliest = candidate
    }
  }
  return earliest
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function projectPointOnShapeSegment(point, start, end) {
  const latitude = (Number(start[1]) + Number(end[1]) + Number(point[1])) / 3
  const longitudeScale = Math.max(12, 111.32 * Math.cos(latitude * Math.PI / 180))
  const latitudeScale = 111.32
  const startX = Number(start[0]) * longitudeScale
  const startY = Number(start[1]) * latitudeScale
  const endX = Number(end[0]) * longitudeScale
  const endY = Number(end[1]) * latitudeScale
  const pointX = Number(point[0]) * longitudeScale
  const pointY = Number(point[1]) * latitudeScale
  const deltaX = endX - startX
  const deltaY = endY - startY
  const denominator = deltaX * deltaX + deltaY * deltaY
  const fraction = denominator > 0
    ? clamp(((pointX - startX) * deltaX + (pointY - startY) * deltaY) / denominator, 0, 1)
    : 0
  const coordinate = [
    Number(start[0]) + (Number(end[0]) - Number(start[0])) * fraction,
    Number(start[1]) + (Number(end[1]) - Number(start[1])) * fraction,
  ]
  return {
    coordinate,
    distanceKm: haversineKm(point, coordinate),
    fraction,
  }
}

function shapeAnchorsForPoints(points, fallbackGeometry) {
  if (!Array.isArray(fallbackGeometry) || fallbackGeometry.length < 2) return null
  const anchors = []
  let minimumProgress = 0
  for (const point of points) {
    let best = null
    for (let segmentIndex = Math.floor(minimumProgress); segmentIndex < fallbackGeometry.length - 1; segmentIndex += 1) {
      const projection = projectPointOnShapeSegment(
        point.coordinate,
        fallbackGeometry[segmentIndex],
        fallbackGeometry[segmentIndex + 1],
      )
      const progress = segmentIndex + projection.fraction
      if (progress + 1e-6 < minimumProgress) continue
      if (!best || projection.distanceKm < best.distanceKm) {
        best = { ...projection, progress, segmentIndex }
      }
    }
    if (!best) return null
    anchors.push(best)
    minimumProgress = best.progress
  }
  return anchors
}

function shapeSlice(fallbackGeometry, startAnchor, endAnchor) {
  const coordinates = [startAnchor.coordinate]
  if (endAnchor.segmentIndex >= startAnchor.segmentIndex) {
    for (
      let index = startAnchor.segmentIndex + 1;
      index <= endAnchor.segmentIndex;
      index += 1
    ) {
      coordinates.push(fallbackGeometry[index])
    }
  }
  coordinates.push(endAnchor.coordinate)
  return coordinates.filter((coordinate, index, all) => (
    index === 0
      || coordinate[0] !== all[index - 1][0]
      || coordinate[1] !== all[index - 1][1]
  ))
}

function fallbackShapeSegment(points, index, fallbackGeometry, anchors, fallbackRuntimes, source = 'published_shape_fallback') {
  const globalPair = anchors?.[index] && anchors?.[index + 1]
    ? [anchors[index], anchors[index + 1]]
    : null
  const pairAnchors = globalPair && globalPair[1].progress + 1e-6 >= globalPair[0].progress
    ? globalPair
    : shapeAnchorsForPoints(points.slice(index, index + 2), fallbackGeometry)
  const startAnchor = pairAnchors?.[0]
  const endAnchor = pairAnchors?.[1]
  if (!startAnchor || !endAnchor) return null
  const coordinates = shapeSlice(fallbackGeometry, startAnchor, endAnchor)
  if (coordinates.length < 2) return null
  let distanceKm = 0
  for (let coordinateIndex = 1; coordinateIndex < coordinates.length; coordinateIndex += 1) {
    distanceKm += haversineKm(coordinates[coordinateIndex - 1], coordinates[coordinateIndex])
  }
  const requestedRuntime = Number(fallbackRuntimes?.[index])
  const durationMinutes = Number.isFinite(requestedRuntime) && requestedRuntime >= 0
    ? requestedRuntime
    : Math.max(0.05, distanceKm / 25 * 60)
  return {
    coordinates,
    distanceKm,
    durationMinutes,
    originSnapDistanceM: startAnchor.distanceKm * 1000,
    destinationSnapDistanceM: endAnchor.distanceKm * 1000,
    source,
  }
}

function compactWorkerResult(operation, result) {
  if (operation === 'prepare' && result?.activeServiceKernel) {
    return {
      ...result,
      activeServiceKernel: compactActiveServiceKernelDiagnostics(result.activeServiceKernel),
    }
  }
  if (
    operation === 'route'
    || operation === 'street-route'
  ) return compactRoutingPlanDiagnostics(result)
  if (operation === 'street-route-batch') return compactStreetRouteBatchResult(result)
  if (operation === 'window') {
    return {
      ...result,
      plan: compactRoutingPlanDiagnostics(result?.plan),
      choices: Array.isArray(result?.choices)
        ? result.choices.map(compactRoutingPlanDiagnostics)
        : result?.choices,
    }
  }
  return result
}

async function prepareStreetStore(request) {
  const streetStorePath = String(request?.streetStorePath ?? '').trim()
  if (!streetStorePath) {
    return {
      ready: true,
      accelerated: false,
      reason: 'not_configured',
      prepareMs: 0,
      buildMs: 0,
    }
  }
  const {
    prepareNationalOsmDriveStore,
    prepareNationalOsmNativeStore,
  } = await loadOsmModule()
  const prepared = prepareNationalOsmNativeStore(streetStorePath, {
    requireCurrentSchema: true,
  })
  if (!prepared.ready || !prepared.accelerated) {
    const error = new Error(
      `Pedestrian accelerator unavailable (${prepared.reason ?? 'unknown reason'}). Rebuild the OpenStreetMap street index.`,
    )
    error.code = 'VIGO_STREET_ACCELERATOR_REQUIRED'
    throw error
  }
  // Transit access, Reach, and Walk use the pedestrian kernel only. Preparing
  // Boston's full driving kernel here added more than twelve seconds to a cold
  // transit request even though no drive edge could participate in its answer.
  // Keep the response shape stable and load Drive only for an explicit Drive
  // preparation; street-route also prepares it immediately before a Drive query.
  const drive = request?.mode === 'drive' || request?.prepareDrive === true
    ? prepareNationalOsmDriveStore(streetStorePath)
    : {
        ready: true,
        deferred: true,
        reason: 'not_required_for_walk_or_transit',
        prepareMs: 0,
        buildMs: 0,
      }
  return {
    ...prepared,
    drive,
  }
}

parentPort.on('message', async (message) => {
  const { id, operation, storePath, request = {}, cancelBuffer } = message ?? {}
  const operationStartedAt = performance.now()
  operationCounts[operation] = Number(operationCounts[operation] ?? 0) + 1
  try {
    let result
    if (operation === 'prepare-street') {
      const streetStore = await prepareStreetStore(request)
      result = {
        ready: true,
        streetStore,
      }
    } else if (operation === 'prepare-transfers') {
      const { ensureNationalGtfsOsmStopTransfers } = await loadGtfsModule()
      const streetStore = await prepareStreetStore(request)
      const osmStopTransfers = await ensureNationalGtfsOsmStopTransfers(
        storePath,
        request.streetStorePath,
        {
          onProgress: (progress) => parentPort.postMessage({
            type: 'progress',
            id,
            progress,
            workerInstance,
          }),
        },
      )
      result = {
        ready: true,
        streetStore,
        osmStopTransfers,
      }
    } else if (operation === 'prepare-derived') {
      const { ensureNationalGtfsDerivedArtifactsCurrent } = await loadGtfsModule()
      result = await ensureNationalGtfsDerivedArtifactsCurrent(storePath, {
        onProgress: (progress) => parentPort.postMessage({
          type: 'progress',
          id,
          progress,
          workerInstance,
        }),
      })
    } else if (operation === 'prepare') {
      const {
        ensureNationalGtfsDerivedArtifactsCurrent,
        ensureNationalGtfsOsmStopTransfers,
        prepareNationalGtfsStore,
        prepareNationalGtfsRoutingReadiness,
        prepareNationalGtfsRoutingContext,
      } = await loadGtfsModule()
      const readinessOnly = request.readinessOnly === true
      const streetStore = readinessOnly
        ? {
            ready: true,
            accelerated: false,
            deferred: true,
            reason: 'background_access_preparation',
            prepareMs: 0,
            buildMs: 0,
          }
        : await prepareStreetStore(request)
      const osmStopTransfers = !readinessOnly && request.streetStorePath
        ? await ensureNationalGtfsOsmStopTransfers(storePath, request.streetStorePath)
        : null
      const derivedArtifacts = readinessOnly
        ? { ready: true, deferred: true, reason: 'background_routing_preparation' }
        : await ensureNationalGtfsDerivedArtifactsCurrent(
            storePath,
            {
              onProgress: (progress) => parentPort.postMessage({
                type: 'progress',
                id,
                progress,
                workerInstance,
              }),
            },
          )
      const routing = readinessOnly
        ? prepareNationalGtfsRoutingReadiness(storePath)
        : request.serviceDate
          ? prepareNationalGtfsRoutingContext(storePath, request)
          : prepareNationalGtfsStore(storePath)
      result = {
        ...routing,
        streetStore,
        osmStopTransfers,
        derivedArtifacts,
        nativeCoordinateAccess: routing.nativeCoordinateAccess ?? null,
      }
    } else if (operation === 'prepare-routing-access') {
      const {
        ensureNationalGtfsDerivedArtifactsCurrent,
        ensureNationalGtfsOsmStopTransfers,
        prepareNationalGtfsRoutingContext,
      } = await loadGtfsModule()
      const streetStore = await prepareStreetStore(request)
      const osmStopTransfers = request.streetStorePath
        ? await ensureNationalGtfsOsmStopTransfers(storePath, request.streetStorePath)
        : null
      const derivedArtifacts = await ensureNationalGtfsDerivedArtifactsCurrent(
        storePath,
        {
          onProgress: (progress) => parentPort.postMessage({
            type: 'progress',
            id,
            progress,
            workerInstance,
          }),
        },
      )
      const routing = prepareNationalGtfsRoutingContext(storePath, {
        ...request,
        prepareAccess: true,
        prewarmRouteGeometry: true,
        prewarmRoutingPipeline: true,
      })
      result = {
        ...routing,
        streetStore,
        osmStopTransfers,
        derivedArtifacts,
        nativeCoordinateAccess: routing.nativeCoordinateAccess ?? null,
      }
    } else if (operation === 'search') {
      const { searchNationalGtfsStops } = await loadStopSearchModule()
      result = searchNationalGtfsStops(storePath, request.query, request.limit)
    } else if (operation === 'search-pair' || operation === 'search-many') {
      const minimumQueryCount = operation === 'search-pair' ? 2 : 3
      const maximumQueryCount = operation === 'search-pair' ? 2 : 8
      if (
        !Array.isArray(request.queries)
        || request.queries.length < minimumQueryCount
        || request.queries.length > maximumQueryCount
        || request.queries.some((query) => typeof query !== 'string')
      ) {
        throw new Error(`National stop search ${operation} requires ${minimumQueryCount}-${maximumQueryCount} strings.`)
      }
      const { searchNationalGtfsStops } = await loadStopSearchModule()
      result = request.queries.map((query) => searchNationalGtfsStops(storePath, query, request.limit))
    } else if (operation === 'window') {
      const { routeNationalGtfsDepartureWindow } = await loadGtfsModule()
      const routed = routeNationalGtfsDepartureWindow(storePath, request)
      const earliestTransit = earliestTransitEvidenceFromPlans(routed.profile?.plans)
      const { plans: _samplePlans, ...profile } = routed.profile
      result = {
        plan: routed.plan,
        choices: routed.choices,
        profile,
        ...(earliestTransit ? { earliestTransit } : {}),
      }
    } else if (operation === 'matrix') {
      const { routeNationalGtfsMatrix } = await loadGtfsModule()
      result = routeNationalGtfsMatrix(storePath, request)
    } else if (operation === 'reach') {
      const { routeNationalGtfsReach } = await loadGtfsModule()
      const cancellation = cancelBuffer instanceof SharedArrayBuffer
        ? new Int32Array(cancelBuffer)
        : null
      result = routeNationalGtfsReach(storePath, request, {
        streetStorePath: request.streetStorePath,
        isCancelled: () => Boolean(cancellation && Atomics.load(cancellation, 0)),
        onProgress: (progress) => parentPort.postMessage({
          type: 'progress',
          id,
          progress,
          workerInstance,
        }),
      })
    } else if (operation === 'street-surface') {
      const { streetNetworkTravelTimeRaster } = await loadOsmModule()
      const cancellation = cancelBuffer instanceof SharedArrayBuffer
        ? new Int32Array(cancelBuffer)
        : null
      const streetStorePath = String(request.streetStorePath ?? '').trim()
      if (!streetStorePath) throw new Error('Street surface analysis requires a persisted OSM street store.')
      result = streetNetworkTravelTimeRaster(streetStorePath, request, {
        isCancelled: () => Boolean(cancellation && Atomics.load(cancellation, 0)),
        onProgress: (progress) => parentPort.postMessage({
          type: 'progress',
          id,
          progress,
          workerInstance,
        }),
      })
    } else if (operation === 'route') {
      const { routeNationalGtfsStore } = await loadGtfsModule()
      result = routeNationalGtfsStore(storePath, request)
    } else if (operation === 'street-route') {
      const {
        prepareNationalOsmDriveStore,
        prepareNationalOsmNativeStore,
        routeNationalStreetStore,
      } = await loadOsmModule()
      const streetStorePath = String(request.streetStorePath ?? '').trim()
      if (!streetStorePath) throw new Error('Walking and driving require a persisted OSM street store.')
      if (request.mode === 'drive') {
        prepareNationalOsmDriveStore(streetStorePath)
      } else {
        const prepared = prepareNationalOsmNativeStore(streetStorePath, {
          requireCurrentSchema: true,
        })
        if (!prepared.ready || !prepared.accelerated) {
          throw new Error(
            `Pedestrian accelerator unavailable (${prepared.reason ?? 'unknown reason'}). Rebuild the OpenStreetMap street index.`,
          )
        }
      }
      result = routeNationalStreetStore(streetStorePath, request)
    } else if (operation === 'street-matrix') {
      const { routeNationalStreetMatrix } = await loadOsmModule()
      const cancellation = cancelBuffer instanceof SharedArrayBuffer
        ? new Int32Array(cancelBuffer)
        : null
      const streetStorePath = String(request.streetStorePath ?? '').trim()
      if (!streetStorePath) throw new Error('Walk and drive matrices require a persisted OSM street store.')
      result = routeNationalStreetMatrix(streetStorePath, request, {
        isCancelled: () => Boolean(cancellation && Atomics.load(cancellation, 0)),
      })
      if (cancellation && Atomics.load(cancellation, 0)) {
        const error = new Error('Street matrix routing was cancelled.')
        error.name = 'AbortError'
        error.code = 'ABORT_ERR'
        throw error
      }
    } else if (operation === 'street-route-batch') {
      const {
        prepareNationalOsmDriveStore,
        routeNationalStreetStore,
      } = await loadOsmModule()
      const streetStorePath = String(request.streetStorePath ?? '').trim()
      const points = Array.isArray(request.points) ? request.points : []
      if (!streetStorePath) throw new Error('Road-following route inference requires a persisted OSM street store.')
      if (points.length < 2 || points.length > 256) {
        throw new Error('Road-following route inference requires 2 to 256 ordered points.')
      }
      if (points.some((point) => (
        !point
        || !Array.isArray(point.coordinate)
        || point.coordinate.length !== 2
        || point.coordinate.some((value) => !Number.isFinite(Number(value)))
      ))) {
        throw new Error('Road-following route inference received an invalid coordinate.')
      }
      prepareNationalOsmDriveStore(streetStorePath)
      const fallbackGeometry = Array.isArray(request.fallbackGeometry)
        ? request.fallbackGeometry
          .filter((coordinate) => (
            Array.isArray(coordinate)
              && coordinate.length === 2
              && coordinate.every((value) => Number.isFinite(Number(value)))
          ))
          .map((coordinate) => coordinate.map(Number))
        : []
      const fallbackAnchors = shapeAnchorsForPoints(points, fallbackGeometry)
      const unavailableShapeDetail = fallbackGeometry.length >= 2
        ? 'The supplied GTFS shape could not be aligned to this edited gap.'
        : 'Move the stops onto connected roads, import OSM coverage for this gap, or choose Straight-line estimate.'
      const fallbackRuntimes = Array.isArray(request.fallbackSegmentRuntimeMinutes)
        ? request.fallbackSegmentRuntimeMinutes.map((value) => {
            const numericValue = Number(value)
            return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : undefined
          })
        : []
      const publishedShapeSegmentIndexes = new Set(
        Array.isArray(request.publishedShapeSegmentIndexes)
          ? request.publishedShapeSegmentIndexes
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 0 && value < points.length - 1)
          : [],
      )
      const segments = []
      const snappedCoordinates = points.map((point) => point.coordinate.map(Number))
      const snapDistancesM = points.map(() => 0)
      const fallbackSegments = []
      const publishedShapeSegments = []
      const osmSegments = []
      let totalDistanceKm = 0
      let totalDurationMinutes = 0
      const appendShapeSegment = (index, source = 'published_shape_fallback') => {
        const fallback = fallbackShapeSegment(
          points,
          index,
          fallbackGeometry,
          fallbackAnchors,
          fallbackRuntimes,
          source,
        )
        if (!fallback) return false
        segments.push(fallback)
        if (source === 'published_shape') publishedShapeSegments.push(index)
        else fallbackSegments.push(index)
        snappedCoordinates[index] = fallback.coordinates[0]
        snappedCoordinates[index + 1] = fallback.coordinates.at(-1)
        snapDistancesM[index] = fallback.originSnapDistanceM
        snapDistancesM[index + 1] = fallback.destinationSnapDistanceM
        totalDistanceKm += fallback.distanceKm
        totalDurationMinutes += fallback.durationMinutes
        return true
      }
      for (let index = 0; index < points.length - 1; index += 1) {
        // A published GTFS shape is authoritative for an untouched original
        // stop pair. Only edited gaps need OSM drive inference. This avoids
        // throwing away reliable shape evidence merely because the local
        // drivable graph is incomplete around an existing stop.
        if (publishedShapeSegmentIndexes.has(index) && appendShapeSegment(index, 'published_shape')) continue
        const plan = routeNationalStreetStore(streetStorePath, {
          mode: 'drive',
          origin: points[index],
          destination: points[index + 1],
          maxStreetKm: request.maxStreetKm,
        })
        if (plan?.status !== 'ready') {
          if (appendShapeSegment(index)) continue
          result = {
            status: 'blocked',
            failedIndex: index,
            detail: `Stops ${index + 1} → ${index + 2}: ${plan?.detail ?? 'No drivable OSM path was found.'} ${unavailableShapeDetail}`,
            segments,
            snappedCoordinates,
            snapDistancesM,
            totalDistanceKm,
            totalDurationMinutes,
          }
          break
        }
        const leg = plan.legs?.find((candidate) => candidate.travelMode === 'drive') ?? plan.legs?.[0]
        const coordinates = Array.isArray(leg?.coordinates) ? leg.coordinates : []
        const distanceKm = Number(leg?.distanceKm ?? plan.distanceKm)
        const durationMinutes = Number(leg?.durationMinutes ?? plan.durationMinutes)
        const originSnapDistanceM = Number(plan.diagnostics?.originSnapDistanceM ?? 0)
        const destinationSnapDistanceM = Number(plan.diagnostics?.destinationSnapDistanceM ?? 0)
        if (coordinates.length < 2 || !Number.isFinite(distanceKm) || !Number.isFinite(durationMinutes)) {
          if (appendShapeSegment(index)) continue
          result = {
            status: 'blocked',
            failedIndex: index,
            detail: `The OSM route between stops ${index + 1} and ${index + 2} returned incomplete geometry. ${unavailableShapeDetail}`,
            segments,
            snappedCoordinates,
            snapDistancesM,
            totalDistanceKm,
            totalDurationMinutes,
          }
          break
        }
        const internalCoordinates = coordinates.length > 2 ? coordinates.slice(1, -1) : []
        if (internalCoordinates.length) {
          snappedCoordinates[index] = internalCoordinates[0]
          snappedCoordinates[index + 1] = internalCoordinates.at(-1)
        }
        snapDistancesM[index] = originSnapDistanceM
        snapDistancesM[index + 1] = destinationSnapDistanceM
        segments.push({
          coordinates,
          distanceKm,
          durationMinutes,
          originSnapDistanceM,
          destinationSnapDistanceM,
          source: 'osm_drive',
        })
        osmSegments.push(index)
        totalDistanceKm += distanceKm
        totalDurationMinutes += durationMinutes
      }
      if (!result?.status || result.status !== 'blocked') {
        result = {
          status: 'ready',
          segments,
          snappedCoordinates,
          snapDistancesM,
          totalDistanceKm,
          totalDurationMinutes,
          ...(fallbackSegments.length
            ? {
                fallbackUsed: true,
                fallbackSegmentCount: fallbackSegments.length,
                fallbackSegments,
                detail: `Used the published GTFS shape for ${fallbackSegments.length} ordered segment${fallbackSegments.length === 1 ? '' : 's'} where the local drive graph had no connected path.`,
              }
            : {}),
          publishedShapeSegmentCount: publishedShapeSegments.length,
          osmSegmentCount: osmSegments.length,
        }
      }
    } else {
      throw new Error(`Unsupported national route-worker operation: ${operation}`)
    }
    result = compactWorkerResult(operation, result)
    parentPort.postMessage({
      type: 'complete',
      id,
      result,
      workerInstance,
      metrics: runtimeMetrics(result, operation, performance.now() - operationStartedAt),
    })
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      id,
      error: error instanceof Error
        ? ['reach', 'street-surface', 'street-matrix'].includes(operation)
          ? error.message
          : error.stack || error.message
        : String(error),
      errorCode: error?.code,
      errorContext: error?.activeServiceKernel
        ? { activeServiceKernel: error.activeServiceKernel }
        : undefined,
      workerInstance,
      metrics: runtimeMetrics(null, operation, performance.now() - operationStartedAt),
    })
  }
})
