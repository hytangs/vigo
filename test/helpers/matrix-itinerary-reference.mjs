import { routeNationalGtfsStore } from '../../src/server/national-gtfs-store.mjs'

// Test-only reference: materialize every itinerary independently. Production
// Matrix always uses its uniform scalar scan, regardless of City or OD size.
export function matrixItineraryReference(storePath, request) {
  const departure = request.departMinutes ?? 480
  const rows = request.origins.flatMap((origin, originIndex) => request.destinations.map((destination, destinationIndex) => {
    const plan = routeNationalGtfsStore(storePath, {
      ...request, origin, destination, routingPreference: 'fastest',
      returnedStationCyclePolicy: 'represented',
      __suppressServiceDateFallback: true,
    })
    return { originIndex, destinationIndex, status: plan.status, departMinutes: departure,
      arriveMinutes: plan.status === 'ready' ? plan.arriveMinutes : null,
      durationMinutes: plan.status === 'ready' ? plan.durationMinutes : null }
  }))
  return { rows, diagnostics: {
    matrixStrategy: 'test-itinerary-reference',
    uniqueOrigins: new Set(request.origins.map((point) => JSON.stringify(point))).size,
    uniqueDestinations: new Set(request.destinations.map((point) => JSON.stringify(point))).size,
  } }
}
