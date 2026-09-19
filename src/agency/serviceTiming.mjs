import { agencyClock, serviceEpoch } from './agencyClock.mjs'
import { routeOperations, tripCalls, station, fresh, matchCall, stopPrediction } from './routeOperations.mjs'
import { vehicleTrip } from './vehicleTrip.mjs'
import { scheduledServiceWindow } from './serviceWindow.mjs'
import { feedStates, defaultPolicy } from './realtimeIntelligence.mjs'

const minutes = seconds => Math.round(seconds / 60)
const clock = (seconds, timezone) => {
  if (!Number.isFinite(seconds)) return null
  const value = agencyClock(new Date(seconds * 1000).toISOString(), timezone)
  return value ? `${value.date} ${value.time} ${value.zoneLabel}` : null
}
const range = values => ({ min: Math.min(...values), max: Math.max(...values) })
const duration = value => value.min === value.max ? `${minutes(value.min)} min` : `${minutes(value.min)}–${minutes(value.max)} min`

function routeIdentity(context, value) {
  if (context.routeIndex.has(value)) return value
  const found = context.resolve({ query: value, kind: 'route' })
  if (found.method !== 'exact' || found.total !== 1) throw new Error('Choose an exact route name or ID for this check.')
  return found.matches[0].id
}

// Expose the same trip/vehicle identities used by the line diagram. These
// operational questions are neither a future station board nor a headway scan.
export function serviceTiming(context, snapshot, state, args, now = Date.now() / 1000) {
  const policy = state.policy || defaultPolicy
  const feeds = new Map(feedStates(snapshot, now, policy).map(feed => [feed.sourceUrl, feed]))
  const result = { kind: 'service_timing', view: args.view, timezone: context.timezone, asOf: clock(now, context.timezone), routeId: null, routeName: null, rows: [], warnings: [] }
  if (!context.timezone) return { ...result, summary: 'The timetable needs an agency timezone before service times can be compared.' }
  let routeId = args.routeId ? routeIdentity(context, args.routeId) : null
  if (args.view === 'trip') {
    const vehicle = vehicleTrip(context, snapshot, { vehicleId: args.vehicleId, routeId }, feeds, now, policy)
    if (vehicle.issue) return { ...result, vehicle, summary: vehicle.issue }
    routeId = vehicle.routeId
    const { calls, continuous } = tripCalls(context, vehicle.tripId)
    if (!continuous || calls.length < 2) return { ...result, vehicle, summary: 'The reported trip has no complete indexed terminal-to-terminal timetable.' }
    const epoch = serviceEpoch(vehicle.serviceDate, context.timezone)
    const start = calls[0], end = calls.at(-1)
    const reports = (snapshot?.tripUpdates ?? []).filter(record => {
      const match = context.matchTripIdentity(record, vehicle.serviceDate)
      return match.trip?.trip_id === vehicle.tripId && match.serviceDate === vehicle.serviceDate
    })
    const update = reports.length === 1 && (!reports[0].vehicleId || reports[0].vehicleId === vehicle.id) && fresh(reports[0], feeds, now, policy) ? reports[0] : null
    const endpoint = (call, index, event) => {
      const scheduled = Number.isFinite(call[event]) ? epoch + call[event] : null
      const matches = (update?.stopTimeUpdates ?? []).filter(item => matchCall(calls, item.stopId, item.stopSequence)?.index === index)
      const report = matches.length === 1 ? matches[0] : null
      const status = update?.scheduleRelationship === 'CANCELED' ? 'cancelled' : update?.scheduleRelationship === 'DELETED' ? 'deleted' : report?.scheduleRelationship === 'SKIPPED' ? 'skipped' : 'scheduled'
      const usable = update && (!update.scheduleRelationship || update.scheduleRelationship === 'SCHEDULED') && report && (!report.scheduleRelationship || report.scheduleRelationship === 'SCHEDULED')
      const timing = usable ? stopPrediction(report, call.arrival == null ? null : epoch + call.arrival, call.departure == null ? null : epoch + call.departure) : null
      return { station: station(context, call.stopId).name, stopId: call.stopId, event, scheduled, predicted: timing?.[event] ?? null,
        predictionAt: usable ? update.timestamp ?? feeds.get(update.sourceUrl)?.feedTimestamp ?? null : null, status, actual: null }
    }
    const departure = endpoint(start, 0, 'departure'), arrival = endpoint(end, calls.length - 1, 'arrival')
    // Retained next-departure forecasts are not observed departures. Repeated
    // terminal calls cannot be matched from history without a stop sequence.
    const history = calls.filter(call => call.stopId === start.stopId).length === 1
      ? (state.tripHistory?.[`${vehicle.tripId}/${vehicle.serviceDate}`] ?? []).filter(point => point.stopId === start.stopId && Number.isFinite(point.delaySeconds)
        && Date.parse(point.at) <= now * 1000 && Date.parse(point.at) >= (now - policy.historyMinutes * 60) * 1000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : []
    const retained = history.at(-1)
    const retainedDeparture = retained && departure.scheduled != null ? { predicted: departure.scheduled + retained.delaySeconds, reportedAt: Date.parse(retained.at) / 1000 } : null
    result.vehicle = vehicle; result.terminals = { departure, arrival, retainedDeparture }
    result.rows = [departure, arrival].map(row => ({ event: row.event, terminal: row.station, scheduled: clock(row.scheduled, context.timezone) ?? 'Not supplied', prediction: clock(row.predicted, context.timezone) ?? 'Not supplied', status: row.status === 'scheduled' ? row.predicted == null ? 'Schedule only' : 'Prediction' : row.status }))
    result.summary = ['cancelled', 'deleted'].includes(departure.status)
      ? `Vehicle ${vehicle.label}’s reported trip is ${departure.status}; its scheduled terminal times do not establish operation.`
      : `On its currently reported trip, vehicle ${vehicle.label} on ${vehicle.routeName} ${departure.scheduled == null ? 'has no indexed terminal departure time' : `${departure.scheduled <= now ? 'was' : 'is'} scheduled to leave ${departure.station} at ${clock(departure.scheduled, context.timezone)}`}. Its actual departure time is not recorded.${retainedDeparture && departure.predicted == null ? ` The last retained departure prediction was ${clock(retainedDeparture.predicted, context.timezone)}, reported at ${clock(retainedDeparture.reportedAt, context.timezone)}; this is a forecast, not a recorded departure.` : ''}`
  } else {
    if (!routeId) throw new Error('Supply the route name or ID for the vehicle list or cycle-time check.')
    if (args.view === 'vehicles') {
      const line = routeOperations(context, snapshot, { routeId }, now, policy)
      const identities = new Map()
      for (const vehicle of line.vehicles.filter(item => item.fresh && item.serviceDate)) {
        if (!identities.has(vehicle.id)) identities.set(vehicle.id, [])
        identities.get(vehicle.id).push(vehicle)
      }
      const vehicles = [...identities.values()].filter(records => records.length === 1).map(records => records[0])
      result.vehicles = vehicles
      if (vehicles.length < identities.size) result.warnings.push('Ambiguous vehicle IDs across feed reports are excluded from the count.')
      result.rows = vehicles.map(vehicle => ({ vehicle: vehicle.label, destination: vehicle.destination || 'Not established',
        'reported stop': vehicle.stop?.name || 'Not established', 'stop status': vehicle.status === 'STOPPED_AT' ? 'At stop' : vehicle.status === 'INCOMING_AT' ? 'Approaching' : vehicle.status === 'IN_TRANSIT_TO' ? 'Toward stop' : 'Not established',
        'schedule comparison': vehicle.delaySeconds == null ? 'No comparison' : vehicle.delaySeconds === 0 ? 'Matches schedule' : `${Math.abs(vehicle.delaySeconds / 60).toFixed(1)} min ${vehicle.delaySeconds > 0 ? 'late' : 'early'}` }))
      result.summary = `${vehicles.length} ${vehicles.length === 1 ? 'vehicle has' : 'vehicles have'} a fresh location report on Route ${line.name}. Upcoming trip assignments are not counted as additional vehicles. No timing comparison means the delay is unknown.`
    } else if (args.view === 'cycle') {
      // Compare scheduled running times for work intersecting the next hour.
      // Matching opposite terminals is a route-level comparison, not evidence
      // that these two trips belong to one vehicle block or include layovers.
      const groups = new Map()
      for (const trip of scheduledServiceWindow(context, now, now + 3600).trips.filter(trip => trip.routeId === routeId)) {
        const { calls, continuous } = tripCalls(context, trip.tripId)
        if (!continuous || calls.length < 2) continue
        if (!Number.isFinite(calls[0].departure) || !Number.isFinite(calls.at(-1).arrival)) continue
        const from = station(context, calls[0].stopId), to = station(context, calls.at(-1).stopId)
        const seconds = calls.at(-1).arrival - calls[0].departure
        if (!Number.isFinite(seconds) || seconds < 0) continue
        const key = JSON.stringify([from.id, to.id])
        if (!groups.has(key)) groups.set(key, { from, to, seconds: [] })
        groups.get(key).seconds.push(seconds)
      }
      const legs = [...groups.values()].map(({ seconds, ...leg }) => ({ ...leg, trips: seconds.length, seconds: range(seconds) }))
      const loops = legs.filter(leg => leg.from.id === leg.to.id).map(leg => ({ from: leg.from.name, via: leg.to.name, loop: true, seconds: leg.seconds }))
      for (const [index, outbound] of legs.entries()) for (const inbound of legs.slice(index + 1)) {
        if (outbound.from.id === inbound.to.id && outbound.to.id === inbound.from.id) loops.push({ from: outbound.from.name, via: outbound.to.name,
          seconds: { min: outbound.seconds.min + inbound.seconds.min, max: outbound.seconds.max + inbound.seconds.max } })
      }
      result.window = { from: now, until: now + 3600 }; result.runningTimes = legs; result.roundTrips = loops
      result.rows = legs.map(leg => ({ from: leg.from.name, to: leg.to.name, 'scheduled running time': duration(leg.seconds), trips: leg.trips }))
      result.summary = `${loops.length ? loops.map(loop => `${loop.loop ? `Loop from ${loop.from}` : `${loop.from} → ${loop.via} → ${loop.from}`}: ${duration(loop.seconds)} of scheduled running time, excluding terminal layovers.`).join(' ') : 'The timetable does not supply both sides of a round trip in this window.'} A full vehicle cycle includes the return trip and terminal layovers; headway is the spacing between vehicles. Current full-cycle time is not verified because linked vehicle blocks and actual terminal departures are not retained here. The table uses scheduled work overlapping the next hour.`
    } else throw new Error('Choose vehicles, trip or cycle.')
  }
  result.routeId = routeId
  const route = context.routeIndex.get(routeId)
  result.routeName = route?.short_name || route?.long_name || routeId
  return result
}
