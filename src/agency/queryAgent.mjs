import { queryInstructions, executionInstructions } from './queryPrompt.mjs'
import { failedToolResult, toolDefinitions } from './toolRegistry.mjs'
import { summarizeEvidence } from './evidenceSummary.mjs'

// Source URLs can contain feed credentials. Keep them in the local evidence
// record; model decisions need values and timestamps, not connection URLs.
function modelResult(value) {
  return JSON.stringify(value, (key, item) => ['provenance', 'sourceRefs', 'sourceUrl', 'sources'].includes(key) ? undefined : item)
}

export function compactResult(result, tool) {
  const envelope = (data, shortened = false) => modelResult({ ok: result.ok, generatedAt: result.generatedAt, data,
    warnings: [...result.warnings, ...(shortened ? ['Selected records only; the complete response is retained in the evidence panel. Refine the query for other records.'] : [])] })
  if (!result.ok) return envelope(result.data)
  const data = result.data
  const clock = (minutes) => Number.isFinite(minutes) ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}` : undefined
  if (tool === 'recall_notebook') return envelope({ entries: data.entries.map((entry) => ({ id: entry.id, title: entry.title, observedAt: entry.observedAt, shortened: entry.shortened || entry.excerpt.length > 800 || entry.notes.length > 400, excerpt: entry.excerpt.slice(0, 800), notes: entry.notes.slice(0, 400) })) })
  if (tool === 'resolve_entities') return envelope({ total: data.total, ambiguous: data.ambiguous, matches: data.matches.slice(0, 12).map(({ kind, id, name, description, lat, lon }) => ({ kind, id, name, description, lat, lon })) }, data.matches.length > 12)
  if (tool === 'place_search') return envelope({ query: data.query, searchArea: data.searchArea, coverage: data.coverage, nextStep: data.nextStep, matches: data.matches.map(({ id, name, address }) => ({ id, name, address })) })
  if (tool === 'web_read') return envelope({ ...data, content: data.content.slice(0, 8000) }, data.truncated || data.content.length > 8000)
  if (tool === 'route_plan' || tool === 'walk_route') return envelope({
    realtime: data.realtime,
    // Keep units and clocks attached to their values instead of asking the
    // model to convert service minutes or interpret unlabeled distances.
    walking: data.walking ? { distance: `${Math.round(data.walking.distanceMeters)} metres (${data.walking.distanceMiles.toFixed(2)} miles)`, estimatedTime: `${data.walking.durationMinutes.toFixed(1)} minutes`, walkingSpeedKph: data.walking.walkingSpeedKph } : data.walking,
    resolved: data.resolved, request: data.request,
    plan: data.plan ? {
      status: data.plan.status, detail: data.plan.detail, travelMode: data.plan.travelMode,
      durationMinutes: data.plan.durationMinutes,
      departTime: tool === 'route_plan' ? clock(data.plan.departMinutes) : undefined,
      arriveTime: tool === 'route_plan' ? clock(data.plan.arriveMinutes) : undefined,
      transfers: data.plan.transfers,
      legs: data.plan.legs?.map(({ type, routeShortName, fromName, toName, distanceKm, startMinutes, endMinutes }) => ({ type, routeShortName, fromName, toName, distanceKm, ...(tool === 'route_plan' ? { startTime: clock(startMinutes), endTime: clock(endMinutes) } : {}) })),
    } : data.plan,
  })
  if (tool === 'reach') return envelope({ request: data.request, summary: data.summary })
  const minutes = (seconds) => Number.isFinite(seconds) ? Number((seconds / 60).toFixed(1)) : undefined
  const events = (data.events ?? []).slice(0, 3).map(({ id, title, type, observedAt, routeId, routeIds, routeName, stopId, stopIds, stopName, stopNames, tripId, tripIds, vehicleId, evidence: e }) => ({
    id, title, type, observedAt, routeId, routeName, routeIds: data.scope?.routeIds?.length ? routeIds?.filter(id => data.scope.routeIds.includes(id)) : routeIds, stopId, stopIds, stopName, stopNames, tripId, tripIds, vehicleId,
    evidence: { delayMinutes: minutes(e.delaySeconds), scheduledTime: e.scheduledTime, predictedTime: e.predictedTime, scheduledMinutes: minutes(e.scheduledHeadwaySeconds), predictedMinutes: minutes(e.observedHeadwaySeconds), increaseMinutes: minutes(e.observedHeadwaySeconds - e.scheduledHeadwaySeconds), reportReason: e.reason, alertHeader: e.alertHeader, alertDescription: e.alertDescription?.slice(0, 3000), alertCause: e.alertCause, alertEffect: e.alertEffect, alertUrl: e.alertUrl, activePeriods: e.activePeriods },
  }))
  if (tool === 'realtime_status') return envelope({
    connected: data.connected, observedAt: data.observedAt, scope: data.scope,
    networkCounts: data.counts,
    feeds: data.feeds.map(({ kind, status, ageSeconds }) => ({ kind, status, ageSeconds: ageSeconds == null ? null : Math.round(ageSeconds) })),
    routeCount: data.routes.length,
    routes: data.routes.slice(0, 6).map(({ id, name, longName, reportingTrips, maxDelaySeconds, alerts, widestInterval }) => ({ id, name, longName, reportingTrips, maxDelayMinutes: minutes(maxDelaySeconds), alerts, widestInterval: widestInterval ? { stopId: widestInterval.stopId, stopName: widestInterval.stopName, measure: 'spacing between departures', scheduledMinutes: minutes(widestInterval.scheduledSeconds), predictedMinutes: minutes(widestInterval.predictedSeconds), increaseMinutes: minutes(widestInterval.predictedSeconds - widestInterval.scheduledSeconds) } : null })),
    eventCount: data.events.length, events,
  }, data.routes.length > 6 || data.events.length > 3)
  if (tool === 'anomaly_scan' || tool === 'service_alerts') return envelope({ scope: data.scope, coverage: data.coverage, total: data.total, offset: data.offset, ...(tool === 'service_alerts' && (data.offset || 0) + events.length < data.total ? { nextOffset: (data.offset || 0) + events.length } : {}), groupBy: data.groupBy, observedAt: data.observedAt, events }, data.events.length > 3)
  if (data?.rows) return envelope({ ...data, rows: data.rows.slice(0, 12) }, data.rows.length > 12)
  return envelope(data)
}

function replyText(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') : ''
  // Some local servers put marked reasoning in content instead of a separate
  // field. Only the public reply belongs in the conversation and notebook.
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}

export async function queryAgency({ question, context, state, callTool, provider, signal, onProgress = () => {}, history = [], placesAvailable = true, webStatus = {} }) {
  if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw new Error('Ask a question using 1–2000 characters.')
  if (!provider.available) return { answer: 'Connect a model in Ask to start a conversation. Live observations and built-in skills are available now.', trace: [], evidenceRefs: [], generatedAt: state.generatedAt, warnings: [], providerAvailable: false }
  onProgress({ phase: 'planning', progress: 0, detail: 'Reading your question…' })
  const messages = [
    { role: 'system', content: `${queryInstructions}

Optional local agency context, relevant only to this City's data: ${modelResult(context.overview(Date.parse(state.generatedAt) / 1000))}. Current observation: ${state.observedAt ?? 'none'}. Conversation metadata for interpreting earlier turns, not text to reproduce: ${modelResult(history.map((item) => ({ savedAt: item.observedAt, staffAnnotation: item.notes?.slice(0, 1000) || undefined, previousRequests: item.requests, priorFindings: item.findings?.map(call => ({ tool: call.tool, result: JSON.parse(compactResult(call.result, call.tool)) })) })))}.` },
    ...history.flatMap((item) => [{ role: 'user', content: item.question }, { role: 'assistant', content: item.answer.slice(0, 2000) }]),
    { role: 'user', content: question },
  ]
  const capabilities = { place_search: placesAvailable, web_search: Boolean(webStatus.searchAvailable && webStatus.provider !== 'wikipedia'), reference_lookup: Boolean(webStatus.searchAvailable && webStatus.provider === 'wikipedia'), web_read: Boolean(webStatus.readAvailable) }
  const availableTools = toolDefinitions.filter(tool => capabilities[tool.name] !== false)
  const startedAt = performance.now()
  const timing = { modelCalls: 0, modelMs: 0, toolMs: 0, inputTokens: null, outputTokens: null }
  const trace = []
  const warnings = []
  let answer = '', emptyReplies = 0
  // Reserve a final response even when the model has used its tool budget.
  for (let round = 0; round <= 6; round++) {
    if (signal?.aborted) break
    const canUseTools = round < 6 && trace.length < 8
    if (!canUseTools) messages.push({ role: 'system', content: 'No more tool calls are available for this turn. Answer using completed results and explain any unresolved part. Do not claim checks that were not run.' })
    let message
    const modelStartedAt = performance.now()
    timing.modelCalls++
    if (trace.length) onProgress({ phase: 'response', progress: 0, detail: 'Putting the findings together…' })
    const inferenceMessages = [...messages, { role: 'system', content: executionInstructions(trace, webStatus, placesAvailable) }]
    try { message = await provider.complete(inferenceMessages, canUseTools ? availableTools : [], signal) }
    catch (error) { if (signal?.aborted) break; warnings.push(error.message); onProgress({ phase: 'provider-error', progress: 1, detail: error.message }); break }
    finally { timing.modelMs += performance.now() - modelStartedAt }
    if (Number.isFinite(message?.usage?.prompt_tokens)) timing.inputTokens = (timing.inputTokens ?? 0) + message.usage.prompt_tokens
    if (Number.isFinite(message?.usage?.completion_tokens)) timing.outputTokens = (timing.outputTokens ?? 0) + message.usage.completion_tokens
    if (signal?.aborted) break
    const calls = message?.tool_calls
    if (message?.finishReason === 'length') warnings.push('The model reached its response limit. You can ask it to continue.')
    if (calls == null || (Array.isArray(calls) && !calls.length)) {
      answer = replyText(message?.content)
      if (answer) break
      if (emptyReplies++ === 0 && round < 6) {
        messages.push({ role: 'system', content: 'Your last response contained no public answer or tool call. Please answer the user, ask a clarifying question, or use an available tool.' })
        continue
      }
      warnings.push('The model returned no answer. Please try again or choose another model.')
      break
    }
    if (!Array.isArray(calls) || calls.some((call) => !call || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') || new Set(calls.map((call) => call.id)).size !== calls.length) {
      warnings.push('The model returned an unreadable set of checks. Completed evidence is retained; please retry.'); break
    }
    if (!canUseTools || calls.length > 8 - trace.length) { warnings.push('The model exceeded the tool-call limit. Completed results are retained.'); break }
    messages.push({ role: 'assistant', content: replyText(message.content) || null, tool_calls: calls })
    const toolStartedAt = performance.now(), offset = trace.length
    const execute = async (call, index) => {
      if (signal?.aborted) return null
      let args = {}, result
      const phase = `tool-${offset + index}`
      try {
        args = JSON.parse(call.function.arguments)
        onProgress({ phase, progress: 0, detail: describeTool(call.function.name, args, context) })
        result = await callTool(call.function.name, args)
      } catch (error) { result = failedToolResult(error, state.generatedAt) }
      onProgress({ phase, progress: 1, detail: result.ok ? describeToolResult(call.function.name, result) : result.warnings[0] || 'This check could not be completed.' })
      return { call, args, result }
    }
    // Independent reads can overlap. Preserve order for communication drafting
    // and place lookups that may populate the routing location cache.
    const completed = []
    if (calls.some((call) => call.function.name === 'draft_rider_message') || calls.some((call) => call.function.name === 'place_search') && calls.some((call) => ['walk_route', 'route_plan', 'reach'].includes(call.function.name))) {
      for (const [index, call] of calls.entries()) completed.push(await execute(call, index))
    } else completed.push(...await Promise.all(calls.map(execute)))
    timing.toolMs += performance.now() - toolStartedAt
    for (const item of completed.filter(Boolean)) {
      const { call, args, result } = item
      trace.push({ tool: call.function.name, arguments: args, result })
      messages.push({ role: 'tool', tool_call_id: call.id, content: `Source [${trace.length}]\n${compactResult(result, call.function.name)}` })
    }
  }
  if (signal?.aborted) warnings.push('Stopped. Completed checks are retained in this note.')
  if (!answer && !signal?.aborted) onProgress({ phase: 'response-error', progress: 1, detail: warnings[0] || 'The model did not finish its response.' })
  const citations = new Set()
  // Numbered references resolve only to actual successful tool responses.
  // This does not verify the meaning of model-written claims.
  answer = answer.replace(/(^|[ \t])\[(\d+)\](?=$|[\s.,;:!?])/gm, (reference, _space, number) => {
    if (!trace[Number(number) - 1]?.result.ok) return ''
    citations.add(Number(number))
    return reference
  })
  return {
    answer: answer || (trace.length ? summarizeEvidence(trace) : signal?.aborted ? 'Stopped before a response was ready. You can continue this conversation.' : 'I could not get a response from the model. Please try again.'),
    timing: { ...timing, totalMs: performance.now() - startedAt },
    aiGenerated: Boolean(answer), model: answer ? provider.model : undefined, citations: [...citations],
    trace, evidenceRefs: [...new Set(trace.flatMap((call) => call.result.provenance))], generatedAt: state.generatedAt,
    warnings: [...new Set([...warnings, ...trace.flatMap((call) => call.result.warnings)])], providerAvailable: true,
  }
}

function describeTool(name, args, context) {
  if (name === 'reference_lookup') return `Looking up “${args.subject || ''}” in public references…`
  if (name === 'web_search') return `Searching public sources for “${args.query || ''}”…`
  if (name === 'web_read') return 'Reading the public source…'
  const route = args.routeId ? context.routeIndex.get(args.routeId) : null
  const where = route ? ` for route ${route.short_name || route.long_name}` : ''
  return ({ recall_notebook: 'Finding relevant saved work and staff notes…', service_profile: 'Counting scheduled trip starts for the selected service date…', network_overview: 'Checking the timetable and the latest feed status…', resolve_entities: `Looking up “${args.query || ''}” in this City…`, place_search: `Searching online for “${args.query || ''}”…`, walk_route: 'Measuring the walk along the pedestrian network…', gtfs_query: 'Reading the relevant timetable records…', realtime_status: `Checking current service reports${where}…`, anomaly_scan: `Comparing reported departures with the timetable${where}…`, service_alerts: `Reading the agency’s active alerts${where}…`, route_plan: 'Calculating the journey with VIGO…', reach: 'Calculating how far you can travel by transit and on foot…', draft_rider_message: 'Preparing a rider message from the selected evidence…' })[name] || 'Running the requested check…'
}

function describeToolResult(name, { data }) {
  if (name === 'reference_lookup') return `Found ${data.matches.length} public references.`
  if (name === 'web_search') return `Found ${data.matches.length} public search results.`
  if (name === 'web_read') return `Read ${data.title || 'the public page'}.`
  if (name === 'place_search') return data.matches.length ? `Found ${data.matches.length} possible ${data.matches.length === 1 ? 'location' : 'locations'}.` : 'The map index did not resolve this place.'
  if (name === 'walk_route') return data.walking ? `Calculated ${Math.round(data.walking.distanceMeters)} m of walking on the street network.` : 'No walking route could be established for these locations.'
  if (name === 'recall_notebook') return `Retrieved ${data.entries.length} dated notebook ${data.entries.length === 1 ? 'entry' : 'entries'}.`
  if (name === 'service_profile') return `Counted scheduled trip starts across ${data.rows.length} service hours.`
  if (name === 'network_overview') return `Read ${data.counts.routes} routes and checked ${data.observation?.feeds?.length || 0} realtime feed timestamps.`
  if (name === 'resolve_entities') return `Found ${data.total} matching ${data.total === 1 ? 'place or route' : 'places or routes'}.${data.ambiguous ? ' The exact location still needs to be resolved.' : ''}`
  if (name === 'anomaly_scan' || name === 'service_alerts') return `Found ${data.total} matching ${data.groupBy === 'route' ? 'routes' : name === 'service_alerts' ? 'alerts' : 'service findings'}. Checked source timestamps and timetable references.`
  if (name === 'realtime_status') return `Checked ${data.counts.trips} trip reports and ${data.feeds.length} feed timestamps.`
  if (name === 'gtfs_query') return `The timetable query returned ${data.rowCount} ${data.rowCount === 1 ? 'row' : 'rows'}${data.truncated ? ' within the result limit' : ''}.`
  if (name === 'route_plan') return data.plan?.legs?.length ? 'Calculated a journey and checked whether live predictions were applied.' : 'The routing check finished; no journey was established.'
  if (name === 'reach') return 'Calculated the reachable area using the timetable and walking network.'
  return 'The check is complete.'
}
