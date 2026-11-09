import type { RoutingPlan } from '../routingModel'

// Group presentation only. Every departure remains an unchanged engine result.
// Same user OD alone is insufficient: require the same ordered leg geometry,
// stop sequence, and access paths. Unknown/schematic ride paths stay separate.
export function journeyGroups(plans: RoutingPlan[]): RoutingPlan[][] {
  const groups = new Map<string, RoutingPlan[][]>()
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
        leg.geometrySource, leg.type === 'ride' ? undefined : leg.coordinates, leg.stationAccessStatus])]) : plan.id
    const candidates = groups.get(key) ?? []
    const group = candidates.find(group => plan.legs.every((leg, i) => leg.type !== 'ride'
      || sameRidePath(leg.coordinates, group[0].legs[i].coordinates)))
    if (group) group.push(plan)
    else candidates.push([plan])
    groups.set(key, candidates)
  }
  return [...groups.values()].flat()
}

// GTFS shapes for the same platform sequence can differ by sub-metre survey
// rounding and redundant vertices. Compare their ordered paths at every vertex
// of both shapes; stop patterns and walking paths still have to match exactly.
export function sameRidePath(a: number[][], b: number[][]): boolean {
  if (a.length < 2 || b.length < 2) return false
  const scale = Math.cos(a[0][1] * Math.PI / 180)
  const distance = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * scale, a[1] - b[1]) * 111_320
  const lengths = (path: number[][]) => {
    const out = [0]
    for (let i = 1; i < path.length; i++) out.push(out[i - 1] + distance(path[i - 1], path[i]))
    return out
  }
  const x = lengths(a), y = lengths(b), ax = x.at(-1)!, by = y.at(-1)!
  if (!Number.isFinite(ax + by) || ax === 0 || by === 0 || Math.abs(ax - by) > 4) return false
  const follows = (p: number[][], lengths: number[], q: number[][], other: number[]) => {
    let j = 1
    return p.every((point, i) => {
      const at = lengths[i] / lengths.at(-1)! * other.at(-1)!
      while (j < q.length - 1 && other[j] < at) j++
      const span = other[j] - other[j - 1]
      const f = span > 0 ? (at - other[j - 1]) / span : 0
      return distance(point, [q[j - 1][0] + f * (q[j][0] - q[j - 1][0]),
        q[j - 1][1] + f * (q[j][1] - q[j - 1][1])]) <= 2
    })
  }
  return follows(a, x, b, y) && follows(b, y, a, x)
}
