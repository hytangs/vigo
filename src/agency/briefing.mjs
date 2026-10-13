import { summarizeEvidence } from './evidenceSummary.mjs'
import { diagnoseNetwork, compactDiagnosis } from './networkDiagnosis.mjs'
import { networkNarrative } from './networkNarrative.mjs'
import { investigateBriefing } from './briefingInvestigation.mjs'
import { synthesizeNetwork } from './networkSynthesis.mjs'
import { investigationFacts } from './briefingInterpretation.mjs'

const number = (value) => value > 0 && value < 0.1 ? 'less than 0.1' : Number(value.toFixed(1)).toLocaleString('en-US')
export function briefingFacts(trace) {
  const facts = []
  const add = (source, text, kind = 'service') => facts.push({ id: facts.length + 1, source, text, kind })
  for (const [index, call] of trace.entries()) {
    if (!call.result.ok) continue
    const source = index + 1, data = call.result.data
    if (data.dataset === 'MBTA LAMP subway performance' && data.comparison) {
      const c = data.comparison
      add(source, `On held-out dates after ${data.range.trainEnd} through ${data.range.end}, historical segment predictions had ${number(c.historical.maeSeconds)} seconds mean absolute error, compared with ${number(c.scheduled.maeSeconds)} seconds for the matched timetable. Both were evaluated on the same ${c.scoredTestSegments.toLocaleString('en-US')} segment records.`)
      add(source, 'This retrospective study uses reconstructed LAMP stop events, which can include final arrival predictions. It does not validate current incidents, recovery, or passenger impact. Adjacent segments from the same trip are not independent observations.')
    }
    const observation = data.observation || (call.tool === 'realtime_status' ? data : null)
    if (observation?.connected) {
      const sources = observation.feeds ?? []
      const label = (feed) => feed.kind === 'tripUpdates' ? 'Departure predictions' : feed.kind === 'vehicles' ? 'Vehicle locations' : 'Service alerts'
      for (const feed of sources.filter((feed) => feed.status !== 'fresh')) add(source, `${label(feed)} ${feed.status === 'stale' ? 'are out of date' : 'could not be verified'}. Check the source before using them for an operational decision.`, 'coverage')
      if (!observation.counts.matchedTrips) add(source, 'No current trip reports could be matched to this timetable. Departure conditions cannot be assessed.', 'coverage')
    } else if (observation) add(source, 'Live updates are not connected. Connect them to assess current service.', 'coverage')
    if (call.tool === 'service_profile' && data.groupBy === 'route') add(source, summarizeEvidence([call]))
    if (call.tool === 'service_profile' && data.groupBy !== 'route' && data.rows?.length) {
      const rows = data.rows, total = rows.reduce((sum, row) => sum + row.scheduled_trip_starts, 0)
      const peak = Math.max(...rows.map((row) => row.scheduled_trip_starts))
      const hours = rows.filter((row) => row.scheduled_trip_starts === peak).map((row) => row.service_hour)
      add(source, `The timetable has ${total.toLocaleString('en-US')} indexed trip starts on ${data.serviceDate}${data.afterTime ? ` at or after ${data.afterTime}` : ''}, across ${rows.length} service hours with departures.`)
      add(source, `The largest hourly count is ${peak} trip starts in service hour${hours.length > 1 ? 's' : ''} ${hours.join(', ')}. Service hours above 23 continue the same GTFS service day.`)
      add(source, 'These counts describe scheduled supply. Frequency templates and trips without indexed connections are excluded; observed service, demand, and passenger capacity are not measured.')
    }
    for (const event of (data.events ?? []).slice(0, 3)) {
      const e = event.evidence
      const route = event.routeName || event.routeId, stop = event.stopName || event.stopId
      if (e.observedHeadwaySeconds != null) {
        const difference = e.observedHeadwaySeconds - e.scheduledHeadwaySeconds
        add(source, `Expect a ${number(e.observedHeadwaySeconds / 60)} minute gap on ${route} at ${stop}. That is ${number(Math.abs(difference) / 60)} minutes ${difference < 0 ? 'shorter' : 'longer'} than ${e.comparisonBasis ? 'the smallest local scheduled interval after trip reordering:' : 'the scheduled'} ${number(e.scheduledHeadwaySeconds / 60)} minutes.`, 'interval')
      } else if (e.delaySeconds != null) add(source, `A departure on ${route} from ${stop} is expected ${number(e.delaySeconds / 60)} minutes late.`, 'delay')
      else if (event.type === 'service-alert') add(source, event.title, 'alert')
    }
  }
  return facts
}

export async function networkBriefing({ context, state, provider, callTool, signal, scheduleIdentity, onProgress = () => {} }) {
  onProgress({ phase: 'assessment', progress: 0, detail: 'Assessing scheduled service, reporting coverage, and shared locations…' })
  const diagnosis = diagnoseNetwork(context, state), narrative = networkNarrative(diagnosis)
  const provenance = ['GTFS Static · indexed VIGO City', ...state.feeds.map(feed => feed.sourceUrl)]
  const trace = [{ tool: 'network_overview', arguments: {}, result: { ok: true, data: { diagnosis: compactDiagnosis(diagnosis) }, provenance, generatedAt: state.generatedAt, warnings: state.warnings } }]
  onProgress({ phase: 'assessment', progress: 1, detail: 'Network assessment ready. Route and trip evidence retained.' })
  const answer = { answer: [narrative.overview, ...narrative.sections.map(section => `${section.title}\n${section.text}`), narrative.elsewhere, narrative.coverage].filter(Boolean).join('\n\n'),
    diagnosis, narrative, scheduleIdentity, aiGenerated: false, trace, timezone: context.timezone, generatedAt: state.generatedAt, evidenceRefs: provenance, warnings: [...state.warnings], providerAvailable: state.provider?.available ?? false }
  onProgress({ preliminary: answer })
  try {
    const investigation = await investigateBriefing({ diagnosis, narrative, provider, callTool, signal, onProgress })
    if (investigation) {
      answer.trace.push(...investigation.trace)
      answer.investigation = { plan: investigation.plan, focusTitle: investigation.focusTitle, explanation: investigation.explanation, watchNext: investigation.watchNext, assessment: investigation.assessment, rankedHypotheses: investigation.rankedHypotheses, facts: investigation.facts, incomplete: investigation.incomplete,
        checks: investigation.trace.map(call => ({ aspect: call.arguments.aspect, completed: call.result.ok })) }
      answer.evidenceRefs = [...new Set(answer.trace.flatMap(call => call.result.provenance))]
    }
  } catch (error) {
    if (signal?.aborted) throw error
    answer.investigation = { incomplete: true, checks: [] }
    if (error.completedTrace) {
      answer.trace.push(...error.completedTrace)
      answer.investigation = { plan: error.investigationPlan, facts: investigationFacts(error.completedTrace, diagnosis), incomplete: true, checks: error.completedTrace.map(call => ({ aspect: call.arguments.aspect, completed: call.result.ok })) }
      answer.evidenceRefs = [...new Set(answer.trace.flatMap(call => call.result.provenance))]
    }
    answer.warnings.push(`The AI investigation could not finish. The computed assessment is retained. ${error.message}`)
  }
  try {
    const synthesis = await synthesizeNetwork({ diagnosis, investigation: answer.investigation, narrative, provider, signal, onProgress })
    if (synthesis) {
      answer.narrative = synthesis.narrative; answer.synthesis = synthesis.review
      answer.aiGenerated = true; answer.model = provider.model
      answer.answer = [answer.narrative.overview, ...answer.narrative.sections.map(section => `${section.title}\n${section.text}`), answer.narrative.coverage].join('\n\n')
    }
  } catch (error) {
    if (signal?.aborted) throw error
    answer.synthesis = { unavailable: true, review: error.briefingReview }
    answer.warnings.push(`AI briefing unavailable. ${error.message}`)
  }
  return answer
}
