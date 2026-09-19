import { describeCurrentTime } from './currentTime.mjs'
import { describeJourneys } from './journeyResults.mjs'
import { describeVehicleArrival } from './vehicleTrip.mjs'
import { placeEvidenceText } from './placeResults.mjs'

function describeObservation(data) {
  const feeds = (data.feeds ?? []).map((feed) => `${feed.kind === 'tripUpdates' ? 'Trip updates' : feed.kind === 'vehicles' ? 'Vehicles' : feed.kind === 'alerts' ? 'Alerts' : 'Feed'}: ${feed.status}${feed.ageSeconds == null ? '' : `, ${Math.round(feed.ageSeconds)} seconds old`}`).join('; ')
  return `The feeds report ${data.counts.vehicles} vehicles with recent locations and ${data.counts.alerts} active service alerts. We matched ${data.counts.matchedTrips} trip reports to the timetable; ${data.counts.unresolvedTrips} could not be matched. ${feeds}. These reports do not cover every departure.`
}

// A deterministic fallback for interrupted answers and non-model workflows.
// Completed evidence remains readable when the provider cannot finish.
export function summarizeEvidence(trace) {
  const summary = summarizeLastEvidence(trace)
  const places = placeEvidenceText(trace)
  return places && trace.filter(call => call.result.ok).at(-1)?.tool !== 'place_search' ? `${places}\n\n${summary}` : summary
}

function summarizeLastEvidence(trace) {
  const good = trace.filter((call) => call.result.ok)
  if (!good.length) return 'I could not complete this check. The activity below explains what happened; your question is ready to retry.'
  const last = good.at(-1)
  const data = last.result.data
  if (data.status === 'needs_location_choice') return 'The starting place still needs a choice from the returned locations. No journey or nearby-place comparison has been calculated yet.'
  switch (last.tool) {
    case 'current_time': return describeCurrentTime(data)
    case 'inspect_service': return data.routes ? `Checked service conditions for ${data.scope?.allNetwork ? 'the network' : data.scope?.routes?.map(route => route.name).join(', ') || 'the selected location'}. ${data.totalReportingTrips} ${data.totalReportingTrips === 1 ? 'trip has' : 'trips have'} comparable departure predictions; ${data.totalNotices} agency ${data.totalNotices === 1 ? 'notice was' : 'notices were'} found. A completed interpretation is not yet available.` : 'The requested service evidence was checked. A completed interpretation is not yet available.'
    case 'service_timing': return data.summary
    case 'stop_arrivals': {
      const board = data.board
      if (board.vehicle) return describeVehicleArrival(board)
      const count = board.routeCount > 0 ? `${board.routeCount} ${board.routeCount === 1 ? 'route has' : 'routes have'} upcoming service at ${board.stop.name} in the next ${board.windowMinutes / 60} hours. ` : ''
      return board.rows.length ? `${count || `${board.nextPerRoute ? 'Next service for each route and direction' : 'Upcoming service'} at ${board.stop.name}. `}Predictions are shown where available; other times are scheduled.` : `No timed service was found at ${board.stop.name} in the next ${board.windowMinutes / 60} hours. This does not establish that all service has stopped.`
    }
    case 'reference_lookup':
    case 'web_search': return `Found ${data.matches.length} public search results. These are leads; read the sources to verify their details.`
    case 'web_read': return `Read ${data.title || data.url}. The source text is retained for inspection; check its subject and date before drawing conclusions.`
    case 'network_overview': return `${data.cityName} has ${data.counts.routes.toLocaleString('en-US')} routes and ${data.counts.stops.toLocaleString('en-US')} stops. ${data.coverage.message} ${data.observation?.connected ? describeObservation(data.observation) : 'Realtime is not connected, so current service health is unknown.'}`
    case 'resolve_entities': return `${data.total} matching ${data.total === 1 ? 'entity' : 'entities'}. ${data.ambiguous ? 'Choose the intended stop or route by its exact ID.' : 'The indexed identity is shown below.'}`
    case 'recall_notebook': return data.entries.length ? `Found ${data.entries.length} saved ${data.entries.length === 1 ? 'investigation' : 'investigations'}. The dated excerpts and staff notes are below. Open an original to continue it or inspect its sources.` : 'No saved work matched that phrase. Try a route name or words from the question or notes.'
    case 'anomaly_scan':
    case 'service_alerts': {
      const event = data.events[0]
      const e = event?.evidence
      if (e?.observedHeadwaySeconds !== undefined) return `At ${event.stopName || 'the reference stop'}, ${event.routeName ? `route ${event.routeName} departures` : 'departures'} are predicted ${Number((e.observedHeadwaySeconds / 60).toFixed(1))} minutes apart. The timetable spaces these same departures ${Number((e.scheduledHeadwaySeconds / 60).toFixed(1))} minutes apart. Both trips are reporting. ${data.total > 1 ? `${data.total} ${data.groupBy === 'route' ? 'routes have matching findings' : 'matching findings are available'} in the results.` : ''}`
      return `${data.total} ${last.tool === 'service_alerts' ? 'active alerts' : 'operational events'} in this observation. ${data.events[0]?.title ?? 'No event was established by the available evidence.'} See the findings below for where and when.`
    }
    case 'realtime_status': return data.connected ? describeObservation(data) : 'Realtime is not connected. Current service health and data freshness are unknown.'
    case 'gtfs_query': return `${data.rowCount} ${data.rowCount === 1 ? 'row' : 'rows'} from the timetable${data.truncated ? ' (result limited)' : ''}. The results are shown below; the exact query is included in the downloadable record.`
    case 'service_profile': {
      const scope = `on ${data.serviceDate} at or after ${data.afterTime || '00:00'} (${data.timezone || 'agency time'})`
      return data.groupBy === 'route'
        ? `The timetable lists ${data.truncated ? 'at least ' : ''}${data.rows.length} routes with indexed departures ${scope}. The table shows local times; day offsets mark departures past midnight. These are scheduled departures; live operation is not established by this check.`
        : `The timetable has ${data.rows.reduce((sum, row) => sum + row.scheduled_trip_starts, 0)} indexed trip starts ${scope}. The table groups starts by hour, not by an exact departure time. Service times of 24:00 or later continue past midnight.`
    }
    case 'place_search': return `${data.matches.length} matching addresses from OpenStreetMap. ${data.matches.map((match) => `${match.name}: ${match.address}`).join('; ')}`
    case 'nearby_stops': return `${data.matches.length} nearby transit stops. These are stops near the searched location, not the place itself.`
    case 'walk_route': return data.walking ? `The walk is ${Math.round(data.walking.distanceMeters)} m, about ${Math.round(data.walking.durationMinutes)} minutes on the saved pedestrian network.` : data.plan?.detail || 'No walking route could be established for these locations.'
    case 'route_plan': return describeJourneys(data)
    case 'reach': return data.summary?.transitStatus ? `From ${data.request?.origin?.label || 'your starting point'}, ${data.summary.transitStatus.reachedStops} transit stops are reachable within ${data.summary.maximumCutoffMinutes} minutes. This estimate includes walking and waiting, using the timetable. The map shows the reachable area.` : 'The reachable area is ready. It uses scheduled departures and the walking network for your selected time budget.'
    case 'draft_rider_message': return `${data.headline}\n\n${data.body}\n\nDraft · Human review required.`
    default: return 'The computed result is available below.'
  }
}
