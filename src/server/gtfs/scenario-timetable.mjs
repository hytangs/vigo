import {
  compileNativeScenarioTimetable,
  routeNativeCoordinateFrontier,
  routeNativeWalkMatrix,
} from '../native-routing-kernel.mjs'
import { clipNationalShapeCoordinatesThroughStops } from '../national-route-geometry.mjs'
import { haversineKm } from '../geometry-utils.mjs'
import { timetableBudgetBytes, runtimeCapacityError } from '../runtime/resource-limits.mjs'
import { nationalRoutingAccessPolicy, osmTransferMaximumWalkM } from './routing-policy.mjs'

// Point-to-point routing on a planned scenario. The resident timetable stays
// untouched: a derived timetable cancels removed trips and appends planned
// runs, new stops get walking links to the existing network, and journeys on
// planned service are labelled with the scenario's names and geometry.

export const scenarioQueryContext = Symbol('vigo.internal.scenario-query-context')
const scenarioPrefix = 'scenario\u001f'
const derivedKernels = new WeakMap()
const preparedPlans = new WeakMap()

function planError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'invalid_route_scenario' })
}

export function isScenarioRouteId(id) {
  return String(id ?? '').startsWith(scenarioPrefix)
}

function walkSeconds(distanceM, speedKph, padding = 1, overhead = 0) {
  return Math.ceil(distanceM / 1000 / speedKph * 3600 * padding + overhead)
}

/**
 * Resolve a plan against one store and street network once: which planned
 * stops are existing stops, which are new, their walking links, and the stop
 * and route records journeys need.
 */
export function prepareScenarioRouting(store, plan, streetStorePath) {
  if (!plan || typeof plan !== 'object' || typeof plan.identity !== 'string') throw planError('The route scenario plan is malformed.')
  let byStreet = preparedPlans.get(store)
  if (!byStreet) preparedPlans.set(store, byStreet = new Map())
  const key = `${plan.identity}\u0000${streetStorePath ?? ''}`
  const retained = byStreet.get(key)
  if (retained) return retained
  const overlay = plan.overlay
  const tag = `${scenarioPrefix}${plan.identity}`
  const stops = new Map()
  const stopDomain = []
  const appended = []
  for (const [index, stop] of (overlay?.stops ?? []).entries()) {
    const baseId = stop.stopId && store.stopRecords.has(stop.stopId) ? stop.stopId : null
    if (baseId) {
      stopDomain.push({ baseId })
      continue
    }
    const id = `${tag}\u001fstop\u001f${index}`
    const record = {
      stop_id: id, name: String(stop.label || `Planned stop ${index + 1}`), lon: stop.coordinate[0], lat: stop.coordinate[1],
      location_type: 0, parent_station: '', scenarioStop: true,
    }
    stops.set(id, record)
    stopDomain.push({ appendedIndex: appended.length })
    appended.push(record)
  }
  const routes = new Map()
  const directionRoutes = (plan.directions ?? []).map((direction) => {
    const id = `${tag}\u001f${direction.serviceId}`
    if (!routes.has(id)) {
      const source = direction.sourceRouteId ? store.routeLookup.get(direction.sourceRouteId) : null
      routes.set(id, {
        route_id: id,
        route_type: source?.route_type ?? 3,
        short_name: source?.short_name || direction.name,
        long_name: source?.short_name ? direction.name : source?.long_name ?? null,
        color: source?.color || '7c5cff',
      })
    }
    return id
  })

  // Walking links between new stops and the network, at the transfer radius
  // the City's own stop transfers use.
  const transfer = { walkingSpeedKph: nationalRoutingAccessPolicy.walkingSpeedKph, accessPaddingFactor: 1, accessOverheadSeconds: 0 }
  const links = { from: [], to: [], duration: [] }
  if (appended.length && streetStorePath) {
    for (const [index, stop] of appended.entries()) {
      for (const role of ['origin', 'destination']) {
        const frontier = routeNativeCoordinateFrontier(streetStorePath, {
          coordinate: [stop.lon, stop.lat], role, maximumWalkM: osmTransferMaximumWalkM, ...transfer,
        })
        for (const candidate of frontier.candidates) {
          if (!store.stopRecords.has(candidate.stop_id)) continue
          links.from.push(role === 'origin' ? { appendedIndex: index } : { baseId: candidate.stop_id })
          links.to.push(role === 'origin' ? { baseId: candidate.stop_id } : { appendedIndex: index })
          links.duration.push(Math.max(0, Math.ceil(candidate.accessSeconds)))
        }
      }
    }
    if (appended.length > 1) {
      const coordinates = appended.flatMap((stop) => [stop.lon, stop.lat])
      const matrix = routeNativeWalkMatrix(streetStorePath, {
        originCoordinates: coordinates, destinationCoordinates: coordinates, maximumDistanceKm: osmTransferMaximumWalkM / 1000,
      })
      for (let from = 0; from < appended.length; from += 1) {
        for (let to = 0; to < appended.length; to += 1) {
          const distanceM = matrix.distancesM[from * appended.length + to]
          if (from === to || !Number.isFinite(distanceM)) continue
          links.from.push({ appendedIndex: from })
          links.to.push({ appendedIndex: to })
          links.duration.push(walkSeconds(distanceM, transfer.walkingSpeedKph))
        }
      }
    }
  }
  const prepared = { plan, tag, stops, routes, stopDomain, appended, directionRoutes, links }
  if (byStreet.size >= 8) byStreet.delete(byStreet.keys().next().value)
  byStreet.set(key, prepared)
  return prepared
}

/** The timetable a scenario request routes on, derived once per resident timetable. */
export function scenarioTimetableFor(kernel, prepared) {
  if (!kernel || !prepared) return kernel
  let views = derivedKernels.get(kernel)
  if (!views) derivedKernels.set(kernel, views = new Map())
  const retained = views.get(prepared.plan.identity)
  if (retained) return retained
  const started = performance.now()
  const { plan, tag, stopDomain, appended, links } = prepared
  const baseStops = kernel.stopIds.length
  const domainIndex = (entry) => entry.baseId !== undefined ? kernel.stopIndex.get(entry.baseId) : baseStops + entry.appendedIndex
  const excludedRoutes = new Set(plan.excludedRouteIds ?? [])
  const excludedTrips = new Set(plan.excludedTripIds ?? [])
  const tripCount = kernel.tripIds.length
  const canceled = new Uint8Array(tripCount)
  for (let trip = 0; trip < tripCount; trip += 1) {
    if (excludedRoutes.has(kernel.routeIds[trip]) || excludedTrips.has(kernel.tripIds[trip])) canceled[trip] = 1
  }
  const overlay = plan.overlay
  const runs = overlay?.serviceStartSeconds?.length ?? 0
  const patternStops = []
  const patternDepartures = []
  const patternArrivals = []
  for (let call = 0; call < (overlay?.directionStops?.length ?? 0); call += 1) {
    const stop = domainIndex(stopDomain[overlay.directionStops[call]] ?? {})
    if (!Number.isInteger(stop)) throw planError('A planned stop is outside this timetable.')
    patternStops.push(stop)
    patternDepartures.push(Math.round(overlay.directionStopOffsetsSeconds[call]))
    patternArrivals.push(Math.round(overlay.directionArrivalOffsetsSeconds[call]))
  }
  const estimatedBytes = (kernel.estimatedBytes ?? kernel.activeSegmentCount * 96) + patternStops.length * 64
  if (estimatedBytes > timetableBudgetBytes) {
    throw runtimeCapacityError('This scenario needs more memory than the timetable budget allows.', 'VIGO_SCENARIO_MEMORY_LIMIT')
  }
  const compiled = compileNativeScenarioTimetable({
    stopCount: baseStops,
    addedStopCount: appended.length,
    departureSeconds: kernel.departureSeconds,
    arrivalSeconds: kernel.arrivalSeconds,
    fromStop: kernel.fromStop,
    toStop: kernel.toStop,
    sequence: kernel.sequence,
    segmentRun: kernel.segmentRun,
    continuityBreak: kernel.continuityBreak,
    canBoard: kernel.canBoard,
    canAlight: kernel.canAlight,
    tripStart: kernel.tripStart,
    canceled,
    transferOffset: kernel.transferOffset,
    transferTo: kernel.transferTo,
    transferDuration: kernel.transferDuration,
    forbiddenSameStop: kernel.forbiddenSameStop,
    ...(kernel.sameStopTransferMinimum ? { sameStopTransferMinimum: kernel.sameStopTransferMinimum } : {}),
    patternOffsets: Uint32Array.from(overlay?.directionOffsets ?? [0]),
    patternStops: Uint32Array.from(patternStops),
    patternDepartureOffsets: Uint32Array.from(patternDepartures),
    patternArrivalOffsets: Uint32Array.from(patternArrivals),
    patternCanBoard: Uint8Array.from(overlay?.directionCanBoard ?? []),
    patternCanAlight: Uint8Array.from(overlay?.directionCanAlight ?? []),
    runStartSeconds: Uint32Array.from(overlay?.serviceStartSeconds ?? [], Math.round),
    runEndSeconds: Uint32Array.from(overlay?.serviceEndSeconds ?? [], Math.round),
    runHeadwaySeconds: Uint32Array.from(overlay?.serviceHeadwaySeconds ?? [], (value) => Math.max(1, Math.round(value))),
    addedTransferFrom: Uint32Array.from(links.from, domainIndex),
    addedTransferTo: Uint32Array.from(links.to, domainIndex),
    addedTransferDuration: Uint32Array.from(links.duration),
  })
  const added = compiled.addedTripPatterns.length
  const tripIds = new Array(tripCount + added)
  const routeIds = new Array(tripCount + added)
  const serviceIds = new Array(tripCount + added)
  const directionIds = new Array(tripCount + added)
  for (let trip = 0; trip < tripCount; trip += 1) {
    tripIds[trip] = kernel.tripIds[trip]
    routeIds[trip] = kernel.routeIds[trip]
    serviceIds[trip] = kernel.serviceIds[trip]
    directionIds[trip] = kernel.directionIds[trip]
  }
  for (let index = 0; index < added; index += 1) {
    const run = compiled.addedTripPatterns[index]
    const direction = plan.runDirections?.[run] ?? 0
    const routeId = prepared.directionRoutes[direction] ?? `${tag}\u001fservice`
    tripIds[tripCount + index] = `${routeId}\u001f${direction}\u001f${compiled.addedTripDepartures[index]}`
    routeIds[tripCount + index] = routeId
    serviceIds[tripCount + index] = `${tag}\u001fservice`
    directionIds[tripCount + index] = plan.directions?.[direction]?.inbound ? '1' : '0'
  }
  const stopIds = [...kernel.stopIds, ...appended.map((stop) => stop.stop_id)]
  const derived = {
    ...kernel,
    stopCount: compiled.stopCount,
    departureSeconds: compiled.departureSeconds,
    arrivalSeconds: compiled.arrivalSeconds,
    fromStop: compiled.fromStop,
    toStop: compiled.toStop,
    sequence: compiled.sequence,
    segmentTrip: compiled.segmentTrip,
    segmentRun: compiled.segmentRun,
    continuityBreak: compiled.continuityBreak,
    canBoard: compiled.canBoard,
    canAlight: compiled.canAlight,
    tripStart: compiled.tripStart,
    departureOffset: compiled.departureOffset,
    departureOrder: compiled.departureOrder,
    transferOffset: compiled.transferOffset,
    transferTo: compiled.transferTo,
    transferDuration: compiled.transferDuration,
    transferCount: compiled.transferTo.length,
    forbiddenSameStop: compiled.forbiddenSameStop,
    ...(compiled.sameStopTransferMinimum ? { sameStopTransferMinimum: compiled.sameStopTransferMinimum } : {}),
    runCount: compiled.runCount,
    activeSegmentCount: compiled.activeSegmentCount,
    stopIds,
    stopIndex: new Map(stopIds.map((id, index) => [id, index])),
    tripIds,
    routeIds,
    serviceIds,
    directionIds,
    ...(kernel.tripServiceDates ? { tripServiceDates: [...kernel.tripServiceDates, ...new Array(added).fill('')] } : {}),
    serviceKey: `${kernel.serviceKey}|${tag}`,
    sourceArtifactIdentity: `${kernel.sourceArtifactIdentity ?? kernel.sourceStorageIdentity ?? ''}|${tag}`,
    scenarioDiagnostics: {
      id: plan.id,
      name: plan.name,
      appendedStops: appended.length,
      appendedTrips: added,
      canceledTrips: compiled.canceledTripCount,
      walkingLinks: links.from.length,
      compileMs: Number((performance.now() - started).toFixed(3)),
    },
  }
  for (const field of ['nativeTimetableKernel', 'sourceTypedArrayBytes', 'nativeIndexBytes', 'nativeWorkspaceBytes', 'typedArrayBytes', 'estimatedBytes']) {
    delete derived[field]
  }
  if (views.size >= 4) views.delete(views.keys().next().value)
  views.set(plan.identity, derived)
  return derived
}

/** Walking candidates from a free coordinate to the scenario's new stops. */
export function scenarioAccessCandidates(prepared, streetStorePath, coordinate, role, maxWalkKm) {
  if (!prepared?.appended.length || !streetStorePath || !Array.isArray(coordinate)) return []
  const targets = prepared.appended.flatMap((stop) => [stop.lon, stop.lat])
  const matrix = role === 'destination'
    ? routeNativeWalkMatrix(streetStorePath, { originCoordinates: targets, destinationCoordinates: coordinate, maximumDistanceKm: maxWalkKm })
    : routeNativeWalkMatrix(streetStorePath, { originCoordinates: coordinate, destinationCoordinates: targets, maximumDistanceKm: maxWalkKm })
  const policy = nationalRoutingAccessPolicy
  return prepared.appended.flatMap((stop, index) => {
    const distanceM = matrix.distancesM[index]
    if (!Number.isFinite(distanceM) || distanceM > maxWalkKm * 1000) return []
    return [{
      stop_id: stop.stop_id, name: stop.name, lat: stop.lat, lon: stop.lon, parent_station: '', location_type: 0,
      distanceKm: distanceM / 1000, distanceM,
      accessSeconds: walkSeconds(distanceM, policy.walkingSpeedKph, policy.accessPaddingFactor, policy.accessOverheadSeconds),
      exactStopAccess: false, walkSource: 'osm', streetPathVerified: true, accessRole: role,
      accessCandidateClass: 'scenario-stop-street-access', accessSearchComplete: true,
    }]
  })
}

function lineDistanceKm(coordinates) {
  let total = 0
  for (let index = 1; index < coordinates.length; index += 1) total += haversineKm(coordinates[index - 1], coordinates[index])
  return total
}

/**
 * Label rides on planned service and draw them along the planned geometry.
 * @template T
 * @param {T} result
 * @param {any} prepared
 * @returns {T}
 */
export function decorateScenarioPlan(result, prepared) {
  if (!result || typeof result !== 'object' || !prepared) return result
  const visit = (plan) => {
    if (!plan || typeof plan !== 'object') return
    if (Array.isArray(plan.legs)) {
      for (const leg of plan.legs) {
        if (leg?.type !== 'ride' || !isScenarioRouteId(leg.routeId)) continue
        const directionIndex = Number(String(leg.tripId).split('\u001f').at(-2))
        const direction = prepared.plan.directions?.[directionIndex]
        const stopCoordinates = [leg.from?.coordinate, ...(leg.intermediateStops ?? []).map((stop) => stop.coordinate), leg.to?.coordinate]
          .filter((coordinate) => Array.isArray(coordinate))
        const clipped = direction?.geometry?.length >= 2 && stopCoordinates.length >= 2
          ? clipNationalShapeCoordinatesThroughStops(direction.geometry, stopCoordinates)
          : null
        Object.assign(leg, {
          scenarioService: { scenarioId: prepared.plan.id, scenarioName: prepared.plan.name, serviceId: direction?.serviceId ?? null, name: direction?.name ?? leg.routeShortName },
          headsign: leg.headsign ?? (direction ? `${direction.name}${direction.inbound ? ' · return' : ''}` : null),
          serviceId: undefined,
          ...(clipped?.length >= 2 ? { coordinates: clipped, distanceKm: lineDistanceKm(clipped), geometrySource: 'scenario_plan' } : {}),
        })
      }
    }
    for (const key of ['alternatives', 'choices', 'plans']) if (Array.isArray(plan[key])) plan[key].forEach(visit)
    for (const key of ['plan', 'profile']) if (plan[key] && typeof plan[key] === 'object') visit(plan[key])
  }
  visit(result)
  result.scenario = { id: prepared.plan.id, name: prepared.plan.name }
  return result
}
