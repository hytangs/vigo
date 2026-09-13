function describeObservation(data) {
  const feeds = (data.feeds ?? []).map((feed) => `${feed.kind === 'tripUpdates' ? 'Trip updates' : feed.kind === 'vehicles' ? 'Vehicles' : feed.kind === 'alerts' ? 'Alerts' : 'Feed'}: ${feed.status}${feed.ageSeconds == null ? '' : `, ${Math.round(feed.ageSeconds)} seconds old`}`).join('; ')
  return `The feeds report ${data.counts.vehicles} vehicles with recent locations and ${data.counts.alerts} active service alerts. We matched ${data.counts.matchedTrips} trip reports to the timetable; ${data.counts.unresolvedTrips} could not be matched. ${feeds}. These reports do not cover every departure.`
}

// Every factual sentence below comes from tool output. The model plans queries;
// it cannot substitute its own operational numbers or causal explanation.
export function summarizeEvidence(trace) {
  const good = trace.filter((call) => call.result.ok)
  if (!good.length) return 'I could not complete this check. The activity below explains what happened; your question is ready to retry.'
  const last = good.at(-1)
  const data = last.result.data
  switch (last.tool) {
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
    case 'route_plan': if (data.plan?.legs?.length) return `${last.arguments?.departTime ? `Departing at ${last.arguments.departTime}, the journey` : 'The journey'} takes ${Number(data.plan.durationMinutes.toFixed(1))} minutes, including walking and waiting. ${data.realtime.applied ? 'It uses current trip predictions where the routing engine could apply them.' : 'It uses the timetable.'}`
      return `${data.plan?.status === 'ok' || data.plan?.status === 'ready' || data.plan?.legs?.length ? 'VIGO returned a journey.' : 'VIGO returned a routing result.'} ${data.realtime.applied ? 'The engine reports an applied TripUpdate overlay.' : 'This result uses scheduled service.'} Inspect journey details and engine diagnostics below.`
    case 'reach': return data.summary?.transitStatus ? `From ${data.request?.origin?.label || 'your starting point'}, ${data.summary.transitStatus.reachedStops} transit stops are reachable within ${data.summary.maximumCutoffMinutes} minutes. This estimate includes walking and waiting, using the timetable. The map shows the reachable area.` : 'The reachable area is ready. It uses scheduled departures and the walking network for your selected time budget.'
    case 'draft_rider_message': return `${data.headline}\n\n${data.body}\n\nDraft · Human review required.`
    default: return 'The computed result is available below.'
  }
}
