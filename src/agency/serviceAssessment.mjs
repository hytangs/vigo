import { inspectOperationalService } from './serviceInspection.mjs'
import { diagnoseNetwork } from './networkDiagnosis.mjs'
import { networkNarrative } from './networkNarrative.mjs'

// The model chooses the questions and exact entities. Computation supplies the
// statements and their limits; composition can order them, not rewrite values.
export const serviceChecks = {
  conditions: 'Current service and spatial patterns',
  spacing: 'Wider gaps and close departure pairs',
  causes: 'Agency causes and competing explanations',
  history: 'Retained forecast changes, onset and historical limits',
  occupancy: 'Vehicle occupancy, without inferring demand',
  coverage: 'Scheduled work, cancellations and missing reports',
  outlook: 'Future exposure and recovery limits',
  interventions: 'Hold, short-turn, spare allocation or connection protection',
  resources: 'Fleet, crew or maintenance readiness',
  rider_impact: 'Waiting and passenger-impact limits',
  alert_coverage: 'Whether notices cover affected services',
  communications: 'Rider messages for requested channels',
  alternatives: 'Inputs needed for a suspension alternative',
  data_quality: 'Feed freshness and independent position agreement',
}
const string = { type: 'string', minLength: 1, maxLength: 180 }
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
export const serviceAssessmentTool = {
  name: 'assess_service',
  description: `Answer operational questions with checked facts. Choose only 1–3 relevant checks, never the entire list. conditions already includes the service overview and spacing. Include all explicitly named entities; for an unspecified network/area or unnamed deteriorating routes, use network, never invented Route A/B/C. Copy names from the question. ${Object.entries(serviceChecks).map(([key, description]) => `${key}: ${description}`).join('; ')}. Use stop_arrivals for ETA and gtfs_query for SQL.`,
  parameters: object({
    targets: { type: 'array', minItems: 1, maxItems: 6, items: object({ kind: { type: 'string', enum: ['network', 'route', 'stop', 'vehicle', 'trip'] }, name: { ...string, description: 'Required for route, stop, vehicle or trip. Omit for network.' } }, ['kind']) },
    checks: { type: 'array', minItems: 1, maxItems: 5, description: 'Only checks needed to answer the request, normally one or two. Do not select all options.', items: { type: 'string', enum: Object.keys(serviceChecks) } },
    period: { type: 'string', enum: ['current', 'historical', 'future'], description: 'Use historical only for an explicitly different day/week/year. Questions about how a CURRENT problem began remain current and use the history check. Future/peak uses future. Omit for current.' },
    horizons: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 1, maximum: 120 }, description: 'Requested future windows in minutes. Omit unless asked; 30/60/90 are exposure checks, not forecasts.' },
  }, ['targets', 'checks']),
}
const n = value => Number.isFinite(value) ? Number(value.toFixed(1)) : null
const list = values => [...new Set(values)].join(', ')

export async function assessService(environment, args) {
  const { context, state } = environment
  const diagnosis = diagnoseNetwork(context, state)
  environment = { ...environment, diagnosis }
  const cache = new Map()
  const inspect = inputs => {
    const key = JSON.stringify(inputs)
    if (!cache.has(key)) cache.set(key, inspectOperationalService(environment, inputs))
    return cache.get(key)
  }
  const checks = args.period === 'historical' ? ['history'] : [...new Set(args.checks)].filter(check => !(check === 'causes' && args.checks.includes('alert_coverage')) && !(check === 'coverage' && args.checks.includes('outlook')))
  const sections = [], inspections = []
  const add = (target, check, text) => sections.push({ id: `s${sections.length + 1}`, target, check, title: serviceChecks[check], text })
  let preface = ''
  if (args.period === 'historical') preface = 'This current observation cannot establish events, causes or action outcomes for the requested past period. Reconstruct that period from dated observations, applicable schedules and dispatch action logs; a historical runtime study alone does not establish the effect of an intervention. The retained forecasts below belong to the current observation only.'
  if (args.period === 'future') preface = 'The following current evidence is a preparation watchlist, not a prediction for the requested future period. Fleet and crew readiness and a validated service forecast are not connected.'
  for (const target of args.targets) {
    if (target.kind !== 'network' && !target.name) throw new Error('A named target needs its route, station, vehicle or trip identity.')
    const scope = target.kind === 'network' ? {} : { [({ route: 'routeNames', stop: 'stopIds', vehicle: 'vehicleId', trip: 'tripId' })[target.kind]]: ['route', 'stop'].includes(target.kind) ? [target.name] : target.name }
    const d = await inspect(scope)
    inspections.push({ target, data: d })
    if (['vehicle', 'trip'].includes(target.kind) && !d.matchedTripReports && !d.freshVehicleReports) {
      add(target.name, 'conditions', `No matching ${target.kind} report was found for “${target.name}”. Confirm its ${target.kind === 'vehicle' ? 'fleet number' : 'trip ID and service date'}. No report does not establish that it is out of service.${checks.includes('resources') ? ' Maintenance clearance, fault logs and crew/block assignments are not connected; identifying the vehicle does not supply those records.' : ''}`)
      continue
    }
    const label = target.kind === 'network' ? 'Network' : target.kind === 'route' ? `Route ${d.scope.routes.map(row => row.name).join(', ')}` : target.kind === 'vehicle' ? `Vehicle ${target.name}` : target.name
    const routeText = d.routes.map(row => `${row.route}: ${!row.reportingTrips ? 'no comparable next-departure predictions' : row.matchingTrips === row.reportingTrips ? `all ${row.reportingTrips} reporting trips match their next scheduled departures` : `${row.laterTrips} of ${row.reportingTrips} reporting trips have a late next departure${row.laterTrips && row.maxDelayMinutes !== null ? `, up to ${n(row.maxDelayMinutes)} min` : ''}`}${row.cancelledTrips ? `; ${row.cancelledTrips} ${row.cancelledTrips === 1 ? 'trip is' : 'trips are'} reported cancelled` : ''}`).join('; ')
    const scopeNote = target.kind === 'network' || target.kind === 'route' ? 'These are predictions for reporting trips, not actual passages or all service.' : 'Route totals describe the whole route; the selected vehicle or stop is assessed separately.'
    const changedPairs = d.intervals.filter(row => row.predictedMinutes !== row.scheduledMinutes)
    const pairText = changedPairs.map(row => `${row.route} at ${row.stop}: ${n(row.predictedMinutes)} min between predicted departures versus ${n(row.scheduledMinutes)} min scheduled`).join('; ')
    const notices = d.notices.filter(row => !['ACCESSIBILITY_ISSUE', 'NO_EFFECT'].includes(row.effect))
    const noticeText = notices.map(row => `${row.scopeDescription || list(row.routes.map(r => r.name))}: ${row.title}${row.cause && row.cause !== 'UNKNOWN_CAUSE' ? ` (agency-reported cause: ${row.cause.toLowerCase().replaceAll('_', ' ')})` : ''}`).join('; ')
    let history, occupancy, agreement
    for (const check of checks) {
      let text
      if (check === 'conditions') {
        if (target.kind === 'network') {
          const narrative = networkNarrative(diagnosis)
          const matching = diagnosis.routes.filter(row => row.measuredTrips > 0 && row.matchingTrips === row.measuredTrips)
          text = `${narrative.overview} ${narrative.sections.filter(row => !checks.includes('spacing') || row.id !== 'spacing').map(row => `${row.title}: ${row.text}`).join(' ')}${matching.length ? ` Reporting trips on ${list(matching.map(row => row.name))} match their next scheduled departures.` : ''} ${diagnosis.coverage.unknownTrips} scheduled ${diagnosis.coverage.unknownTrips === 1 ? 'trip has' : 'trips have'} no usable report.`
        } else if (target.kind === 'route') text = `${label} — ${routeText || 'No comparable predictions are available'}. ${pairText && !checks.includes('spacing') ? `Spacing also needs attention: ${pairText}. ` : ''}${scopeNote}`
        else text = `${label}: ${d.trips.length ? d.trips.map(row => `${row.route}, next compared departure at ${row.stop}, scheduled ${row.scheduled}, predicted ${row.predicted} (${n(row.delayMinutes)} min deviation)`).join('; ') : 'no matching upcoming departure predictions'}. ${scopeNote}`
        if (noticeText && !checks.includes('causes') && !checks.includes('alert_coverage')) text += ` Agency notice: ${noticeText}. Its cause applies only to the stated scope.`
        if (!checks.includes('occupancy')) {
          occupancy ??= await inspect({ ...scope, aspect: 'vehicle_reports' })
          const full = occupancy.vehicles.filter(row => row.occupancy === 'FULL')
          if (full.length) text += ` Full occupancy is reported by ${full.map(row => `${row.route} vehicle ${row.vehicle}`).join(', ')}; this is not a passenger count or a demand diagnosis.`
        }
        const access = d.notices.filter(row => row.effect === 'ACCESSIBILITY_ISSUE')
        if (access.length) text += ` Separate access notice: ${access.map(row => row.title).join('; ')}.`
      } else if (check === 'spacing') {
        const close = d.routes.reduce((sum, row) => sum + row.closerPairs, 0), wide = d.routes.reduce((sum, row) => sum + row.widerPairs, 0)
        text = `${label}: ${target.kind === 'network' || target.kind === 'route' ? `the returned route comparisons contain ${close} closer and ${wide} wider distinct departure pairs. ` : ''}${pairText || (d.totalIntervalPairs ? 'Available departure pairs match their scheduled spacing' : 'No comparable departure pair is available')}. Predictions alone do not establish measured bunching or persistence.`
      } else if (check === 'causes' || check === 'alert_coverage') {
        text = `${label}: ${noticeText ? `the agency reports ${noticeText}. This applies only to the notice's stated services and location.` : 'no matching current operational notice establishes a cause.'} ${d.concentrations.length ? `Late predictions overlap at ${list(d.concentrations.map(row => row.place))}; compare the same trips before and after that area to test a shared disruption.` : 'Check upstream and terminal departure records to distinguish carried-in delay from a local problem.'} Neither a shared delay pattern nor the absence of a notice establishes a common or separate cause.`
        if (check === 'alert_coverage') text += ` ${d.routes.filter(row => row.laterTrips || row.cancelledTrips).map(row => row.route).join(', ') || 'No returned route'} has reported timing or cancellation issues; these need a selector-by-selector check against notice direction, stop and accessibility scope. Do not extend a notice's cause to uncovered services.`
      } else if (check === 'history') {
        history ??= await inspect({ ...scope, aspect: 'prediction_progression' })
        const series = history.trips.flatMap(trip => trip.retainedPredictionSeries.map(row => ({ ...row, route: context.routeIndex.get(trip.routeId)?.short_name || trip.routeId })))
        text = `${label}: ${series.length ? series.map(row => `${row.route} at ${row.stop}: its departure forecast changed by ${n(row.changeMinutes)} min over ${n(row.elapsedMinutes)} min (${row.firstReport.at.time}–${row.reports.at(-1).at.time} ${row.firstReport.at.zoneLabel})`).join('; ') : 'no retained same-stop forecast history is available for these trips'}. This cannot locate incident onset or establish actual movement. A comparison with yesterday or this week requires dated observations from those periods; the current snapshot cannot supply that comparison.`
      } else if (check === 'occupancy') {
        occupancy ??= await inspect({ ...scope, aspect: 'vehicle_reports' })
        const known = occupancy.vehicles.filter(row => row.occupancy)
        text = `${label}: ${known.length ? known.map(row => `${row.route} vehicle ${row.vehicle} reports ${row.occupancy.toLowerCase().replaceAll('_', ' ')} at ${row.at.time} ${row.at.zoneLabel}`).join('; ') : 'no occupancy category is supplied by the returned fresh vehicle reports'}. ${occupancy.totalVehicleReports} fresh vehicle ${occupancy.totalVehicleReports === 1 ? 'report was' : 'reports were'} matched; ${occupancy.vehicles.filter(row => !row.occupancy).length} displayed reports have unknown occupancy. Passenger counts and a capacity baseline are needed to distinguish high demand from a service shortfall; a FULL category alone cannot explain the cause.`
      } else if (check === 'coverage' || check === 'outlook') {
        const windows = args.horizons || (check === 'outlook' ? [30, 60, 90] : [state.policy.windowMinutes])
        const rows = await Promise.all(windows.map(async minutes => (await inspect({ ...scope, horizonMinutes: minutes })).outlook[0]))
        text = `${label} — ${rows.map(row => `next ${row.minutes} min: ${row.scheduledTrips} scheduled trips, ${row.reportedCancelled} reported cancelled, ${row.withoutMatchedReport} without a matched report`).join('; ')}. Cancellation and missing-report counts are separate; do not subtract one from the other. Future trips need not report yet. ${check === 'outlook' ? 'This is scheduled exposure, not a forecast of conditions or recovery. Follow the same trips and following departure intervals; a recovery time requires a validated forecast.' : 'An unreported trip is unknown, not confirmed cancelled or on time.'}`
      } else if (check === 'interventions') {
        text = `${label}: a dispatch recommendation is not established by the available observations. Compare the options before committing: a hold may protect a verified transfer but delays riders already aboard and can widen the gap ahead; a short-turn may return a vehicle sooner on the retained side but removes service beyond the turn; expressing skips service at bypassed stops; an extra vehicle requires a feasible vehicle and crew assignment. Keep the current plan as the baseline. No optimal spare location, holding duration or wait reduction has been computed. For connections, match the feeder arrival, onward departure and transfer allowance first; delays alone cannot rank missed connections.`
      } else if (check === 'resources') {
        text = `${label}: current reporting positions do not establish usable fleet or peak readiness. Vehicle fitness requires maintenance status and fault records; pull-out feasibility needs assigned blocks, available vehicles and crews; relief risk needs the duty roster and relief locations. Those records are not connected to this assessment. Confirm them with dispatch before selecting a swap or claiming a shortage. A reported cancellation does not identify a mechanical fault.`
      } else if (check === 'rider_impact') {
        text = `${label}: a wider departure gap increases the possible wait for riders arriving during it, but it is not extra waiting experienced by every passenger. ${pairText ? `The checked comparisons are ${pairText}. ` : 'No comparable pair was established here. '}Passenger arrival times, boarding counts and downstream connections are needed to quantify total impact. A user-supplied deviation is not a verified service observation.`
      } else if (check === 'data_quality') {
        agreement ??= await inspect({ ...scope, aspect: 'vehicle_reports' })
        text = `${label}: ${d.coverage.feeds.map(feed => `${feed.kind}: ${feed.status}`).join('; ')}. ${agreement.reportsWithFreshPosition} of ${agreement.timedTripReports} timed trip reports have a fresh position with matching identity. This checks identity and recency, not forecast accuracy. Actual passage records are needed for independent timing verification. Missing positions are not proof of bad data, and fresh feeds are not proof that every trip is reporting.`
      } else if (check === 'communications') {
        const content = d.routes.filter(row => row.cancelledTrips || row.laterTrips).map(row => `${row.route}${row.cancelledTrips ? ' has a reported cancellation' : ' has departures predicted late'}`).join('; ')
        const update = content ? `${content}. Please allow extra time and check the latest departure information. We’re sorry for the disruption.` : 'We do not yet have a verified service issue for this selection. Please check the latest departure information.'
        text = `App: ${update}\n\nStation sign: ${content || 'Check current departure information'}. ${content ? 'Sorry for the disruption.' : ''}\n\nSocial media: ${update} No cause, recovery time or dispatch action is being announced without confirmation.`
      } else if (check === 'alternatives') text = 'An alternative journey needs the actual origin, destination, suspended segment and travel time. A map selection cannot supply unnamed A/B endpoints. Once those are specified, calculate the alternative with route_plan; no substitute journey has been checked here.'
      if (text) add(label, check, text)
    }
  }
  return { kind: 'service_assessment', asOf: state.generatedAt, requested: args, preface, sections, inspections,
    meaning: 'Verified checks and explicit capability limits. The model may prioritize these sections; it must not rewrite facts, add a cause, or omit a requested check.' }
}

export function assessmentChoices(data, targets = serviceAssessmentTool.parameters.properties.targets) {
  return { name: 'finish_assessment', description: `Choose the relevant completed sections for a complete answer, keeping every named target. Request missing checks when needed. ${Object.entries(serviceChecks).map(([key, title]) => `${key}: ${title}`).join('; ')}`,
    parameters: object({ sectionIds: { type: 'array', items: { type: 'string', enum: data.sections.map(row => row.id) }, minItems: 1, maxItems: data.sections.length },
      missingChecks: { type: 'array', items: { type: 'string', enum: Object.keys(serviceChecks) }, maxItems: 3 },
      correctTargets: { ...targets, description: 'Only when the checked scope does not match the question: select the correct targets to replace it. Do not use to omit an explicitly requested entity.' } }, ['sectionIds', 'missingChecks']) }
}

export function renderAssessment(data, ids = data.sections.map(row => row.id)) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !data.sections.some(row => row.id === id))) throw new Error('Choose each completed check at most once.')
  const byId = new Map(data.sections.map(row => [row.id, row]))
  const selected = ids.map(id => byId.get(id))
  if (new Set(selected.map(row => row.target)).size !== new Set(data.sections.map(row => row.target)).size) throw new Error('Include each completed check target; do not omit a requested entity.')
  return [data.preface, ...selected.map(row => row.text)].filter(Boolean).join('\n\n')
}
