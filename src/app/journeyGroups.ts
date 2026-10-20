import type { RoutingPlan } from '../routingModel'

// Group presentation only. Every departure remains an unchanged engine result.
// Same user OD alone is insufficient: require the same ordered leg geometry,
// stop sequence, and access paths. Unknown/schematic ride paths stay separate.
export function journeyGroups(plans: RoutingPlan[]): RoutingPlan[][] {
  const groups = new Map<string, RoutingPlan[]>()
  const ridesOf = (plan: RoutingPlan) => plan.legs.filter(leg => leg.type === 'ride')
  const arrival = (plan: RoutingPlan) => plan.arriveMinutes ?? plan.departMinutes + plan.durationMinutes
  const useful = plans.filter(plan => !plans.some(other => {
    const rides = ridesOf(plan), simpler = ridesOf(other)
    // Hide needless vehicle changes when the very same vehicle is already
    // offered with fewer boardings, no later arrival, and no extra walking.
    return other !== plan && simpler.length > 0 && simpler.length < rides.length
      && arrival(other) <= arrival(plan) && other.walkMinutes <= plan.walkMinutes
      && simpler.at(-1)?.tripId === rides.at(-1)?.tripId
      && simpler.every(ride => ride.tripId && rides.some(candidate => candidate.tripId === ride.tripId))
  }))
  for (const plan of useful) {
    const rides = plan.legs.filter(leg => leg.type === 'ride')
    const proven = rides.length > 0 && rides.every(leg =>
      ['gtfs_shape', 'shape', 'scenario_plan'].includes(leg.geometrySource ?? '')
      && leg.fromStopId && leg.toStopId && leg.coordinates.length > 1)
    const key = proven ? JSON.stringify([plan.travelMode, plan.timePreference, plan.waypoints,
      plan.legs.map(leg => [leg.type, leg.fromStopId, leg.toStopId, leg.stopIds,
        leg.geometrySource, leg.coordinates, leg.stationAccessStatus])]) : plan.id
    const group = groups.get(key)
    if (group) group.push(plan)
    else groups.set(key, [plan])
  }
  return [...groups.values()]
}
