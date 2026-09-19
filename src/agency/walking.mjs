import { resolveJourneyPoints } from './journeyInputs.mjs'

// A station centroid is not a street entrance. Compare its declared GTFS
// entrances on the existing pedestrian graph; never move arbitrary map points.
function endpointOptions(context, point) {
  if (Number(context.stopIndex.get(point.stopId)?.location_type) !== 1) return [point]
  const entrances = [...context.stopIndex.values()].filter(stop => stop.parent_station === point.stopId && Number(stop.location_type) === 2 && Number.isFinite(stop.lon) && Number.isFinite(stop.lat))
  return entrances.length ? entrances.map(stop => ({ coordinate: [stop.lon, stop.lat], label: `${point.label} · ${stop.name}`, source: 'stop', stopId: stop.stop_id })) : [point]
}

async function selectEntrances(context, adapters, points, signal) {
  const options = points.map(point => endpointOptions(context, point))
  if (options.every((set, index) => set[0] === points[index])) return { points, entrances: [] }
  if (!adapters.streetMatrix) throw new Error('Walking from a station requires the pedestrian matrix adapter to compare its mapped entrances.')
  // Keep the same entrance through an intermediate visit. Independent minima
  // on adjacent legs would silently walk across an unmapped station interior.
  let labels = options[0].map(point => ({ distance: 0, points: [point] }))
  for (let i = 1; i < options.length; i++) {
    signal?.throwIfAborted()
    const matrix = await adapters.streetMatrix({ mode: 'walk', origins: options[i - 1], destinations: options[i] }, signal)
    const next = options[i].map(() => null)
    for (const row of matrix.rows) {
      const prior = labels[row.originIndex]
      if (!prior || row.status !== 'ready' || !Number.isFinite(row.distanceKm) || row.distanceKm < 0) continue
      const distance = prior.distance + row.distanceKm
      if (!next[row.destinationIndex] || distance < next[row.destinationIndex].distance) next[row.destinationIndex] = { distance, points: [...prior.points, options[i][row.destinationIndex]] }
    }
    labels = next
  }
  const best = labels.filter(Boolean).sort((a, b) => a.distance - b.distance)[0]
  if (!best) throw Object.assign(new Error('No connected walk was found through the mapped station entrances and these destinations. Choose a specific public entrance or check street coverage.'), { code: 'walking_disconnected' })
  return { points: best.points, entrances: best.points.flatMap((point, index) => point !== points[index] ? [{ station: points[index].label, entrance: point.label, stopId: point.stopId, endpoint: index }] : []) }
}

export function walkingAssessment(walking, args) {
  return {
    ...(args.minimumDistanceMiles != null ? { minimumDistanceMiles: args.minimumDistanceMiles, meetsMinimumDistance: walking ? walking.distanceMeters >= args.minimumDistanceMiles * 1609.344 : null } : {}),
    ...(args.timeBudgetMinutes != null ? { timeBudgetMinutes: args.timeBudgetMinutes,
      activityMinutes: args.activityMinutes ?? null,
      minutesAfterWalking: walking ? args.timeBudgetMinutes - walking.durationMinutes : null,
      fitsIncludingActivities: walking && args.activityMinutes != null ? walking.durationMinutes + args.activityMinutes <= args.timeBudgetMinutes : null } : {}),
  }
}

export async function calculateWalk(context, places, adapters, args, signal) {
  const { origin, destination, waypoints, resolved, sources } = await resolveJourneyPoints(context, places, args, signal)
  const selected = await selectEntrances(context, adapters, [origin, ...waypoints, destination], signal)
  const result = await adapters.route({ origin: selected.points[0], destination: selected.points.at(-1), ...(waypoints.length ? { waypoints: selected.points.slice(1, -1) } : {}), mode: 'walk', departMinutes: 0 }, signal)
  const plan = result.plan
  const ready = plan?.status === 'ready' && plan.travelMode === 'walk' && Number.isFinite(plan.durationMinutes) && plan.durationMinutes >= 0 && plan.legs?.length && plan.legs.every(leg => leg.type === 'walk' && Number.isFinite(leg.distanceKm) && leg.distanceKm >= 0)
  const distanceMeters = ready ? plan.legs.reduce((sum, leg) => sum + leg.distanceKm * 1000, 0) : null
  const walking = ready ? { distanceMeters, distanceMiles: distanceMeters / 1609.344, durationMinutes: plan.durationMinutes, walkingSpeedKph: plan.diagnostics?.walkingSpeedKph,
    endpointConnectionsMeters: { origin: plan.diagnostics?.originSnapDistanceM, destination: plan.diagnostics?.destinationSnapDistanceM } } : null
  const warnings = ready ? ['Walking time is estimated on the saved pedestrian network. Map points may differ from public entrances. Opening hours, permission to eat, queues and activity time are not verified.'] : [plan?.detail || 'No walking route was established. Check the street index and endpoint coverage.']
  if (selected.entrances.length) warnings.push('Station walks start or finish at the selected GTFS entrance. Time inside the station and entrance availability are not included.')
  return { data: { ...result, walking, resolved, entrances: selected.entrances, assessment: walkingAssessment(walking, args) }, sources: ['VIGO Route · saved OpenStreetMap pedestrian network', ...sources], warnings }
}
