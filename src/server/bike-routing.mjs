import { studioRouteResponse } from './studio-route-plans.mjs'

export function bikeRoute(kernel, request) {
  if (request.traffic || request.trafficSnapshot || request.wheelchair) throw new Error('Bike does not support traffic or wheelchair requests.')
  const arrive = ['arrive', 'arrive_by'].includes(request.timePreference)
  const time = Number(arrive ? request.arriveMinutes ?? request.departMinutes ?? 480 : request.departMinutes ?? 480)
  if (!Number.isFinite(time) || Math.abs(time) > 2880) throw new Error('Bike routing time must be a finite minute in [-2880, 2880].')
  const zone = request.timeZone ?? request.timezone
  const via = request.waypoints ?? request.via ?? []
  if (!Array.isArray(via) || via.length > 16) throw new Error('Bike supports an array of at most 16 via points.')
  const payload = JSON.stringify({
    origin: request.origin?.coordinate, destination: request.destination?.coordinate,
    bike: request.bike, via: via.map(point => point?.coordinate ?? point),
    maxWalkMeters: Number(request.maxWalkKm ?? 1.2) * 1000,
    walkingSpeedKph: Number(request.walkingSpeedKph ?? request.walkSpeedKph ?? 4.8),
    maxDistanceMeters: Number(request.maxStreetKm ?? request.maxDistanceKm ?? 50) * 1000,
    arriveBy: arrive,
    clock: (!arrive || !via.length) && request.serviceDate && zone ? { serviceDate:request.serviceDate, timeZone:zone, seconds:time*60 } : undefined,
  })
  if (!via.length) return bikeSegment(JSON.parse(kernel.route(payload)), time, arrive)
  const parts = JSON.parse(kernel.routeThrough(payload))
  const failed = parts.findIndex(result => result.status !== 'ready')
  if (failed >= 0) return { status:'blocked', reason:'via_leg_blocked', legIndex:failed, leg:parts[failed] }
  const durationMinutes = parts.reduce((total, part) => total + part.legs.reduce((sum, leg) => sum + (leg.seconds + (leg.waitBeforeSeconds ?? 0)) / 60, 0), 0)
  const departureMinutes = arrive ? time - durationMinutes : time
  let clock = departureMinutes
  const segments = parts.map(part => {
    const segment = bikeSegment(part, clock, false)
    clock = segment.arrivalMinutes
    return segment
  })
  return { status:'ready', mode:'bike', departureMinutes, arrivalMinutes:clock, durationMinutes,
    distanceMeters: segments.reduce((total, segment) => total + segment.distanceMeters, 0),
    segments, via, legs:segments.flatMap((segment, orderedSegmentIndex) =>
      segment.legs.map(leg => ({ ...leg, orderedSegmentIndex }))), boardings:0,
    diagnostics:{ orderedSearch:{ segmentQueries:parts.length,
      candidateLimit:1, alternatives:'sequential_bike_history' } } }
}

function bikeSegment(result, time, arrive) {
  const durationMinutes = result.legs.reduce((sum, leg) => sum + (leg.seconds + (leg.waitBeforeSeconds ?? 0)) / 60, 0)
  const earlyArrivalSeconds = arrive ? result.endWaitSeconds ?? 0 : 0
  const departureMinutes = arrive ? time - earlyArrivalSeconds / 60 - durationMinutes : time
  let clock = departureMinutes
  const diagnostics = { algorithm: 'bike_movement_cch', preferenceCost: result.cost,
    originRoadMeters: result.originRoadMeters,
    destinationRoadMeters: result.destinationRoadMeters, unsupportedRestrictions: result.unsupportedRestrictions,
    elevationModel: 'osm_incline_only', timingPolicy: result.timingPolicy,
    ...(earlyArrivalSeconds > 0 ? { arrivalDeadlineMinutes:time, earlyArrivalSeconds } : {}),
    ...(result.maxLts == null ? {} : { trafficStress:{model:'osm_estimated_lts_v1',
      maximumCyclingLevel:result.maxLts,aboveLimit:'walk_if_permitted'} }) }
  return { status: result.status, reason: result.reason, mode: 'bike', departureMinutes,
    arrivalMinutes: departureMinutes + durationMinutes, durationMinutes,
    distanceMeters: result.legs.reduce((sum, leg) => sum + leg.meters, 0), diagnostics,
    legs: result.legs.map(leg => {
      clock += (leg.waitBeforeSeconds ?? 0) / 60
      const start = clock; clock += leg.seconds / 60
      return { kind: leg.kind, departureMinutes: start, arrivalMinutes: clock,
        durationMinutes: leg.seconds / 60, distanceMeters: leg.meters, coordinates: leg.coordinates,
        geometrySource: leg.source, streetPathVerified: leg.verified }
    }),
  }
}

export function bikePlan(kernel, request) {
  return studioRouteResponse(bikeRoute(kernel, request), request).choices[0]
}

export function bikeMatrix(kernel, request, origins, destinations, isCancelled) {
  const via = request.waypoints ?? request.via ?? []
  if (!Array.isArray(via) || via.length > 16) throw new Error('Bike supports an array of at most 16 via points.')
  // Keep per-pair cancellation and ordered-waypoint semantics on their existing
  // path. Ordinary batches share native hierarchy sweeps.
  if (!isCancelled && !via.length) {
    if (request.traffic || request.trafficSnapshot || request.wheelchair) throw new Error('Bike does not support traffic or wheelchair requests.')
    const arrive = ['arrive', 'arrive_by'].includes(request.timePreference)
    const time = Number(arrive ? request.arriveMinutes ?? request.departMinutes ?? 480 : request.departMinutes ?? 480)
    if (!Number.isFinite(time) || Math.abs(time) > 2880) throw new Error('Bike routing time must be a finite minute in [-2880, 2880].')
    const zone = request.timeZone ?? request.timezone
    const result = JSON.parse(kernel.matrix(JSON.stringify({
      origins: origins.map(p => p.coordinate), destinations: destinations.map(p => p.coordinate),
      bike: request.bike, arriveBy: arrive,
      maxWalkMeters: Number(request.maxWalkKm ?? 1.2) * 1000,
      walkingSpeedKph: Number(request.walkingSpeedKph ?? request.walkSpeedKph ?? 4.8),
      maxDistanceMeters: Number(request.maxStreetKm ?? request.maxDistanceKm ?? 50) * 1000,
      clock: request.serviceDate && zone ? { serviceDate: request.serviceDate, timeZone: zone, seconds: time * 60 } : undefined,
    })))
    const rows = result.seconds.map((seconds, i) => ({
      originIndex: Math.floor(i / destinations.length), destinationIndex: i % destinations.length,
      status: seconds === null ? 'blocked' : 'ready',
      distanceKm: seconds === null ? null : result.meters[i] / 1000,
      durationMinutes: seconds === null ? null : seconds / 60,
    }))
    return { schemaVersion: 'vigo.routing.street-matrix.v1', mode: 'bike', rows,
      diagnostics: { owner: 'rust_bike_kernel', matrixEngine: result.sharedFields > 0 ? 'bike_movement_cch_matrix' : 'bike_movement_cch',
        pairs: rows.length, readyPairs: rows.filter(row => row.status === 'ready').length,
        sharedFields: result.sharedFields, certifiedPairs: result.certifiedPairs, pointQueries: result.pointQueries,
        uniqueOrigins: result.uniqueOrigins, uniqueDestinations: result.uniqueDestinations } }
  }
  const rows = []
  for (const [originIndex, origin] of origins.entries()) {
    for (const [destinationIndex, destination] of destinations.entries()) {
      if (isCancelled?.()) throw new Error('Bike Matrix cancelled')
      const route = bikeRoute(kernel, { ...request, origin, destination })
      rows.push({ originIndex, destinationIndex, status: route.status,
        distanceKm: route.status === 'ready' ? route.distanceMeters / 1000 : null,
        durationMinutes: route.status === 'ready' ? route.durationMinutes + (route.diagnostics?.earlyArrivalSeconds ?? 0) / 60 : null })
    }
  }
  return { schemaVersion: 'vigo.routing.street-matrix.v1', mode: 'bike', rows,
    diagnostics: { owner: 'rust_bike_kernel', matrixEngine: 'bike_movement_cch',
      pairs: rows.length, readyPairs: rows.filter(row => row.status === 'ready').length } }
}
