import { DatabaseSync } from 'node:sqlite'
import { readNationalGtfsPreview } from './national-gtfs-store.mjs'
import { readGtfsRouteAnalysis } from './gtfs-analysis-store.mjs'
import { scenarioEntityCandidates, scenarioEntityMatches } from './scenario-entity-ids.mjs'

const scenarioRouteStopCache = new Map()
const scenarioRouteStopCacheMaxEntries = 256

function scenarioStopsForStoredRoute(storePath, storeIdentity, routeId, patternId) {
  const requestedRouteId = String(routeId ?? '').trim()
  if (!requestedRouteId) return []
  const identity = storeIdentity.storageGeneration
  const requestedPatternId = String(patternId ?? '').trim()
  const key = JSON.stringify([storePath, identity, requestedRouteId, requestedPatternId])
  const retained = scenarioRouteStopCache.get(key)
  if (retained) {
    scenarioRouteStopCache.delete(key)
    scenarioRouteStopCache.set(key, retained)
    return retained.map((stop) => ({ ...stop, coordinate: [...stop.coordinate] }))
  }

  for (const normalizedRouteId of scenarioEntityCandidates(requestedRouteId)) {
    const preview = requestedPatternId
      ? readGtfsRouteAnalysis(storePath, normalizedRouteId, { includeTripIds: true })
      : readNationalGtfsPreview(storePath, {
      routeLimit: 1,
      representativeRouteIds: [normalizedRouteId],
    })
    const route = preview.routes.find((entry) => (
      (entry.routeId === normalizedRouteId || entry.id === normalizedRouteId)
      && (!requestedPatternId || scenarioEntityMatches(entry.id, requestedPatternId)
        || scenarioEntityMatches(entry.patternId, requestedPatternId))
    ))
    const stopById = new Map(preview.stops.map((stop) => [stop.id, stop]))
    const ordered = Array.isArray(route?.stopIds)
      ? route.stopIds.flatMap((stopId, index) => {
        const stop = stopById.get(stopId)
        if (!stop || !Number.isFinite(Number(stop.lon)) || !Number.isFinite(Number(stop.lat))) return []
        return [{
          id: `${normalizedRouteId}:stop:${index + 1}`,
          label: stop.name || `Stop ${index + 1}`,
          coordinate: [Number(stop.lon), Number(stop.lat)],
          source: 'route',
          stopId: stop.id,
        }]
      })
      : []
    const stops = ordered.length >= 2 ? ordered : []
    if (stops.length < 2) continue
    scenarioRouteStopCache.set(key, stops)
    while (scenarioRouteStopCache.size > scenarioRouteStopCacheMaxEntries) {
      scenarioRouteStopCache.delete(scenarioRouteStopCache.keys().next().value)
    }
    return stops.map((stop) => ({ ...stop, coordinate: [...stop.coordinate] }))
  }
  return []
}

function scenarioGeometryForStoredRoute(storePath, routeId, patternId) {
  const requestedRouteId = String(routeId ?? '').trim()
  const requestedPatternId = String(patternId ?? '').trim()
  if (!requestedRouteId) return null
  for (const normalizedRouteId of scenarioEntityCandidates(requestedRouteId)) {
    const analysis = readGtfsRouteAnalysis(storePath, normalizedRouteId, { includeTripIds: true })
    const candidates = Array.isArray(analysis?.routes) ? analysis.routes : []
    const route = candidates.find((candidate) => (
      (!requestedPatternId
        || scenarioEntityMatches(candidate.id, requestedPatternId)
        || scenarioEntityMatches(candidate.patternId, requestedPatternId))
      && Array.isArray(candidate.coordinates)
      && candidate.coordinates.length >= 2
    ))
    if (!route) continue
    return {
      geometry: route.coordinates.map((point) => [Number(point[0]), Number(point[1])]),
      geometrySource: route.geometrySource === 'shape' ? 'shape' : 'stop_sequence',
    }
  }
  return null
}

function scenarioTripIdsForStoredPattern(storePath, routeId, patternId) {
  const requestedRouteId = String(routeId ?? '').trim()
  const requestedPatternId = String(patternId ?? '').trim()
  if (!requestedRouteId || !requestedPatternId) return []
  for (const normalizedRouteId of scenarioEntityCandidates(requestedRouteId)) {
    const analysis = readGtfsRouteAnalysis(storePath, normalizedRouteId, { includeTripIds: true })
    const pattern = analysis?.routes?.find((route) => (
      scenarioEntityMatches(route.id, requestedPatternId)
        || scenarioEntityMatches(route.patternId, requestedPatternId)
    ))
    if (Array.isArray(pattern?.tripIds)) {
      return pattern.tripIds.map((tripId) => String(tripId)).filter(Boolean)
    }
  }
  return []
}

function scenarioStoredRouteId(storePath, routeId) {
  const candidates = scenarioEntityCandidates(routeId)
  if (!candidates.length) return ''
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const findRoute = db.prepare('SELECT route_id FROM routes WHERE route_id=? LIMIT 1')
    for (const candidate of candidates) {
      if (findRoute.get(candidate)?.route_id) return candidate
    }
  } finally {
    db.close()
  }
  const error = new Error(`Unable to resolve GTFS route ${String(routeId)}.`)
  error.statusCode = 400
  throw error
}

function expandedScenarioRouteIds(storePath, routeIds) {
  return [...new Set(
    (Array.isArray(routeIds) ? routeIds : [])
      .map((routeId) => scenarioStoredRouteId(storePath, routeId))
      .filter(Boolean),
  )]
}

export function hydrateScenarioRouteServices(storePath, storeIdentity, body) {
  const scenario = body?.scenario
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)
    || ['services', 'excludedRouteIds', 'excludedTripIds', 'excludedPatternIds']
      .some((field) => scenario[field] !== undefined && !Array.isArray(scenario[field]))) return body
  const excludedRouteIds = Array.isArray(scenario.excludedRouteIds) ? [...scenario.excludedRouteIds] : []
  const replacedScopes = new Map()
  const reserveReplacement = (routeId, trips) => {
    const key = trips ? JSON.stringify([...trips].sort()) : null
    const previous = replacedScopes.get(routeId) ?? new Set()
    if (previous.has(key) || previous.has(null) || (key === null && previous.size)) {
      const error = new Error(`Conflicting replacement services for GTFS route ${routeId}.`)
      error.statusCode = 400
      throw error
    }
    previous.add(key)
    replacedScopes.set(routeId, previous)
  }
  const excludedTripIds = Array.isArray(scenario.excludedTripIds)
    ? scenario.excludedTripIds.map((tripId) => String(tripId ?? '').trim()).filter(Boolean)
    : []
  const excludedPatternIds = Array.isArray(scenario.excludedPatternIds)
    ? scenario.excludedPatternIds
    : []
  const services = (scenario.services ?? []).map((service) => {
    if (
      !service
      || service.operation === 'add'
      || (Array.isArray(service.stops) && service.stops.length >= 2)
    ) {
      if (Array.isArray(service?.geometry) && service.geometry.length >= 2) return service
      const geometry = service?.sourceRouteId
        ? scenarioGeometryForStoredRoute(storePath, service.sourceRouteId, service.sourcePatternId)
        : null
      return geometry ? { ...service, ...geometry } : service
    }
    const routeId = String(service.sourceRouteId ?? '').trim()
    const stops = scenarioStopsForStoredRoute(storePath, storeIdentity, routeId, service.sourcePatternId)
    const geometry = scenarioGeometryForStoredRoute(storePath, routeId, service.sourcePatternId)
    if (stops.length >= 2) return {
      ...service,
      stops,
      ...(geometry && !Array.isArray(service.geometry) ? geometry : {}),
    }
    const error = new Error(`Unable to derive an ordered stop pattern for route ${routeId || '(missing route)'}.`)
    error.statusCode = 400
    throw error
  })
  for (const reference of excludedPatternIds) {
    const tripIds = scenarioTripIdsForStoredPattern(
      storePath,
      reference?.routeId,
      reference?.patternId,
    )
    if (!tripIds.length) {
      const error = new Error(
        `Unable to resolve the selected GTFS branch ${String(reference?.patternId ?? '(missing pattern)')}.`,
      )
      error.statusCode = 400
      throw error
    }
    excludedTripIds.push(...tripIds)
  }
  for (const service of services) {
    if (!service || service.operation !== 'replace') continue
    if (!service.sourceRouteId) {
      const error = new Error('A replacement service requires sourceRouteId.')
      error.statusCode = 400
      throw error
    }
    if (service.routeScope === 'edge') {
      const error = new Error('Exact-edge edits must be expanded into branch replacements.')
      error.statusCode = 400
      throw error
    }
    const routeId = scenarioStoredRouteId(storePath, service.sourceRouteId)
    const patternScoped = service.routeScope === 'pattern'
      || (service.routeScope !== 'route' && Boolean(service.sourcePatternId))
    if (!patternScoped) {
      reserveReplacement(routeId, null)
      excludedRouteIds.push(routeId)
      continue
    }
    const tripIds = scenarioTripIdsForStoredPattern(
      storePath,
      service.sourceRouteId,
      service.sourcePatternId,
    )
    if (!tripIds.length) {
      const error = new Error(
        `Unable to resolve the selected GTFS branch ${String(service.sourcePatternId ?? '(missing pattern)')}.`,
      )
      error.statusCode = 400
      throw error
    }
    reserveReplacement(routeId, tripIds)
    excludedTripIds.push(...tripIds)
  }
  return {
    ...body,
    scenario: {
      ...scenario,
      services,
      excludedTripIds: [...new Set(excludedTripIds)],
      excludedRouteIds: expandedScenarioRouteIds(storePath, excludedRouteIds),
    },
  }
}
