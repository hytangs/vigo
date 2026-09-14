import assert from 'node:assert/strict'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { draftRiderMessage } from '../src/agency/communications.mjs'
import { createProvider } from '../src/agency/provider.mjs'
import { discoverableTools } from '../src/agency/toolDiscovery.mjs'
import { toolDefinitions } from '../src/agency/toolRegistry.mjs'
import { createJourneyChoices } from '../src/agency/journeyChoices.mjs'
const state = { generatedAt: '2026-09-13T12:00:00Z', observedAt: '2026-09-13T12:00:00Z' }
const context = { overview: () => ({ cityName: 'City X' }), routeIndex: new Map([['R', { short_name: 'R' }]]), stopIndex: new Map([['A', { name: 'River' }]]) }
const clockAnswer = await queryAgency({ question: 'What service runs after 22:00 today?', context: { ...context, timezone: 'America/Los_Angeles' }, state: { ...state, generatedAt: '2026-09-14T03:19:00Z' },
  provider: { available: true, complete: async messages => {
    const supplied = messages.find(message => message.content.includes('Current City clock:')).content
    assert.match(supplied, /Sunday, 2026-09-13, 20:19 PDT/)
    assert.match(supplied, /Today means 2026-09-13/)
    assert.match(supplied, /Observation timestamp in UTC:/)
    return { content: 'The local date is September 13.' }
  } },
})
assert.equal(clockAnswer.timezone, 'America/Los_Angeles', 'The displayed answer timestamp retains the same agency timezone as the model context')
let profileCalls = 0
const profileAnswer = await queryAgency({ question: 'What service runs after 22:00 today?', context: { ...context, timezone: 'America/Los_Angeles' }, state: { ...state, generatedAt: '2026-09-14T03:19:00Z' },
  provider: { available: true, complete: async (_messages, tools) => {
    if (++profileCalls === 2) return { content: '364 indexed trip starts on 2026-09-13 after 22:00 in America/Los_Angeles. The table groups starts by hour, not by an exact departure time. [1]' }
    assert.deepEqual(tools.find(tool => tool.name === 'service_profile').parameters.required, ['groupBy', 'resultUse'])
    return { tool_calls: [{ id: 'profile', function: { name: 'service_profile', arguments: '{"groupBy":"hour","afterTime":"22:00","resultUse":"answer"}' } }] }
  } }, callTool: async (_name, args) => {
    assert.deepEqual(args, { groupBy: 'hour', afterTime: '22:00' })
    return { ok: true, data: { serviceDate: '2026-09-13', timezone: 'America/Los_Angeles', afterTime: '22:00', groupBy: 'hour', rows: [120,104,79,43,18].map((n, i) => ({ service_hour: 22+i, scheduled_trip_starts: n })) }, warnings: [], provenance: ['fixture'] }
  },
})
assert.match(profileAnswer.answer, /364 indexed trip starts on 2026-09-13/)
assert.match(profileAnswer.answer, /groups starts by hour, not by an exact departure time/)
assert.equal(profileAnswer.aiGenerated, true)
assert.equal(profileCalls, 2, 'A timetable result is assessed against the question instead of automatically ending any operational investigation')
const event = { id: 'delay/T1', type: 'delay', title: 'Departure later than scheduled', routeId: 'R', stopId: 'A', observedAt: state.observedAt, evidence: { delaySeconds: 300 }, sourceRefs: ['fixture:trip/T1'] }
const catalog = discoverableTools(toolDefinitions)
for (const name of ['gtfs_query', 'walk_compare', 'run_runtime_study', 'compare_holding']) assert.ok(!catalog.definitions().some(tool => tool.name === name), 'Specialist schemas load only when needed')
assert.throws(() => catalog.prepare({ names: ['invented_tool'] }), /available catalogue/)
for (const name of ['network_overview', 'route_plan', 'realtime_status']) assert.ok(catalog.definitions().some(tool => tool.name === name), 'Common transit tools are ready without a discovery round')
assert.ok(discoverableTools(toolDefinitions, ['walk_compare']).definitions().some(tool => tool.name === 'walk_compare'), 'Follow-ups retain tools used in their saved context')
let discoveryTurn = 0, discoveryExecutions = 0
const discovered = await queryAgency({ question: 'Check current service', context, state, placesAvailable: false,
  provider: { available: true, complete: async (messages, tools) => {
    if (++discoveryTurn === 1) {
      assert.ok(!tools.some(tool => tool.name === 'anomaly_scan'))
      assert.ok(!JSON.stringify(tools.find(tool => tool.name === 'prepare_tools').parameters).includes('place_search'))
      return { tool_calls: [{ id: 'prepare', function: { name: 'prepare_tools', arguments: '{"names":["anomaly_scan"]}' } }] }
    }
    assert.deepEqual(tools.find(tool => tool.name === 'anomaly_scan'), toolDefinitions.find(tool => tool.name === 'anomaly_scan'), 'Loaded tools retain their complete typed schema')
    if (discoveryTurn === 2) return { tool_calls: [{ id: 'status', function: { name: 'realtime_status', arguments: '{}' } }] }
    assert.match(messages.at(-1).content, /Source \[1\]/, 'Preparing tools must not count as checked evidence')
    return { content: 'No reports are available. [1]' }
  } }, callTool: async name => { discoveryExecutions++; assert.equal(name, 'realtime_status'); return { ok: false, data: null, provenance: [], generatedAt: state.generatedAt, warnings: ['No reports'] } } })
assert.equal(discoveryExecutions, 1)
assert.equal(discovered.trace.length, 1)
assert.deepEqual(discovered.citations, [])
let round = 0
const provider = { available: true, model: 'fixture-model', complete: async () => ++round === 1 ? { tool_calls: [{ id: 'call-1', function: { name: 'anomaly_scan', arguments: '{}' } }] } : { content: 'A departure on R is five minutes late. [1] That is a trip-level finding, not evidence of a route-wide disruption.' } }
const callTool = async () => ({ ok: true, data: { events: [event], total: 1 }, provenance: event.sourceRefs, generatedAt: state.generatedAt, warnings: [] })
const progress = []
const answer = await queryAgency({ question: 'What is happening?', context, state, callTool, provider, onProgress: (item) => progress.push(item) })
assert.equal(progress[0].phase, 'planning')
assert.ok(progress.some((item) => item.phase === 'tool-0' && item.progress === 0))
assert.ok(progress.some((item) => item.phase === 'tool-0' && item.progress === 1))
assert.doesNotMatch(JSON.stringify(progress), /trip-level finding/, 'Activity contains executed steps, not the final answer')
assert.equal(answer.trace.length, 1)
assert.deepEqual(answer.evidenceRefs, event.sourceRefs)
assert.match(answer.answer, /trip-level finding/, 'The model can explain computed results instead of losing its answer')
assert.equal(answer.aiGenerated, true)
assert.deepEqual(answer.citations, [1])
assert.deepEqual(answer.trace[0].result.data.events[0], event, 'Model explanation cannot replace the original evidence')
for (const [question, content] of [
  ['Hello', 'Hello! How can I help?'],
  ['What can you do?', 'I can explain transit concepts, help with writing, and investigate this City with its data.'],
  ['Why do buses bunch?', 'An initial delay can cause a bus to collect more passengers, which can increase dwell time.'],
  ['Help me write an agenda', 'Start with the decision, then discuss evidence, options, and next steps.'],
  ['你好', '你好！有什么我可以帮你的？'],
  ['Find a journey', 'Where are you starting, and where do you want to go?'],
]) {
  let turns = 0
  const reply = await queryAgency({ question, context, state, callTool: async () => assert.fail('A direct reply needs no tool execution'),
    provider: { available: true, model: 'fixture', complete: async () => { turns++; return { content, reasoning_content: 'Private reasoning must never be saved.' } } } })
  assert.equal(reply.answer, content)
  assert.equal(turns, 1)
  assert.equal(reply.trace.length, 0)
  assert.equal(reply.aiGenerated, true)
  assert.deepEqual(reply.warnings, [])
  assert.deepEqual(reply.evidenceRefs, [])
  assert.doesNotMatch(JSON.stringify(reply), /Private reasoning/)
}
const followup = await queryAgency({ question: 'Make that shorter', context, state, callTool: async () => assert.fail('The conversation already supplies this text'),
  history: [{ question: 'Explain headways', answer: 'Headway is the time between successive vehicles at the same stop.', observedAt: state.generatedAt }],
  provider: { available: true, complete: async (messages) => {
    assert.match(messages.find(message => message.role === 'assistant').content, /successive vehicles/)
    assert.equal(messages.filter(message => message.role !== 'system').at(-1).content, 'Make that shorter')
    return { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '<think>internal</think>Time between vehicles.' }] }
  } } })
assert.equal(followup.answer, 'Time between vehicles.')
const uncited = await queryAgency({ question: 'Explain indexing', context, state, callTool,
  provider: { available: true, complete: async () => ({ content: 'Use x[3] or `[3]`. [99]', finishReason: 'length' }) } })
assert.equal(uncited.answer, 'Use x[3] or `[3]`.', 'Missing source references are removed without altering array notation')
assert.deepEqual(uncited.citations, [])
assert.match(uncited.warnings[0], /response limit/)
let blankReplies = 0
const blank = await queryAgency({ question: 'Hello', context, state, callTool,
  provider: { available: true, complete: async () => { blankReplies++; return { reasoning_content: 'unfinished' } } } })
assert.equal(blankReplies, 2, 'Empty responses get one bounded retry')
assert.equal(blank.aiGenerated, false)
assert.match(blank.warnings[0], /no answer/)
assert.doesNotMatch(blank.answer, /complete this check/)
let budgetRounds = 0
const atBudget = await queryAgency({ question: 'Compare these services', context, state, callTool,
  provider: { available: true, complete: async (_messages, tools) => {
    if (++budgetRounds === 1) return { tool_calls: Array.from({ length: 8 }, (_, index) => ({ id: `budget-${index}`, function: { name: 'anomaly_scan', arguments: '{}' } })) }
    assert.deepEqual(tools, [], 'The last response can explain results but cannot exceed the tool budget')
    return { content: 'Here is the comparison from the completed checks. [1]' }
  } } })
assert.equal(atBudget.trace.length, 8)
assert.equal(budgetRounds, 2)
assert.match(atBudget.answer, /Here is the comparison/)

let compactRound = 0, initialSystem = '', initialContext = ''
const largeEvents = Array.from({ length: 50 }, (_, index) => ({ ...event, id: `event-${index}`, evidence: { ...event.evidence, comparisonTrips: Array.from({ length: 100 }, () => ({ tripId: 'T1' })) } }))
const scoped = await queryAgency({ question: 'Check route R', context, state,
  callTool: async () => ({ ok: true, data: { connected: true, observedAt: state.generatedAt, scope: { routeId: 'R' }, counts: { routes: 100 }, feeds: [], routes: [{ id: 'R', name: 'R', maxDelaySeconds: 300 }], events: largeEvents }, provenance: ['fixture:route/R'], warnings: [] }),
  provider: { available: true, complete: async (messages) => {
    if (++compactRound === 1) { initialSystem = messages[0].content; initialContext = messages[1].content; return { tool_calls: [{ id: 'status', function: { name: 'realtime_status', arguments: '{"routeId":"R"}' } }] } }
    const payload = JSON.parse(messages.filter(message => message.role !== 'system').at(-1).content.split('\n').slice(1).join('\n'))
    assert.equal(messages.filter(message => message.role === 'system').length, 1, 'Local chat templates receive one initial system message')
    assert.equal(messages[0].role, 'system')
    assert.equal(messages[0].content, initialSystem, 'Stable instructions do not change when a tool finishes')
    assert.equal(messages[1].content, initialContext, 'Tool progress must not invalidate earlier conversation and source context')
    assert.match(payload.executionStatus, /realtime_status: completed/)
    assert.doesNotMatch(initialSystem, /priorFindings|previousRequests|Current observation/)
    assert.equal(messages.at(-1).role, 'tool', 'Tool feedback remains the latest conversation message')
    assert.equal(payload.data.scope.routeId, 'R')
    assert.equal(payload.data.networkCounts.routes, 100, 'Network counts stay explicitly separate from route measurements')
    assert.equal(payload.data.events.length, 3)
    assert.equal(payload.data.events[0].id, 'event-0', 'Projected findings retain IDs for follow-up tools')
    assert.equal(payload.data.eventCount, 50)
    assert.equal(payload.data.routes[0].maxDelayMinutes, 5)
    assert.ok(messages.filter(message => message.role !== 'system').at(-1).content.length < 2500, 'Operational context omits bulky per-trip comparison records')
    assert.match(payload.warnings.at(-1), /Selected records only/)
    return { content: 'Route R has a reported five-minute delay. [1]' }
  } } })
assert.match(scoped.answer, /Route R has a reported five-minute delay/)
assert.equal(scoped.trace[0].result.data.events.length, 50, 'The full evidence is retained independently of the model projection')
let associationRound = 0
const associated = await queryAgency({ question: 'Compare R and S', context, state,
  callTool: async () => ({ ok: true, data: { scope: { routeIds: ['R', 'S'] }, counts: {}, feeds: [], routes: [{ id: 'S', widestInterval: { stopName: 'Depot', scheduledSeconds: 540, predictedSeconds: 1122 } }], events: [{ ...event, type: 'service-alert', routeId: undefined, routeIds: ['S', 'outside-scope'], stopId: undefined, stopIds: ['A'], stopNames: ['River'], evidence: { reason: 'Escalator unavailable' } }] }, provenance: [], warnings: [] }),
  provider: { available: true, complete: async (messages) => {
    if (++associationRound === 1) return { tool_calls: [{ id: 'comparison', function: { name: 'realtime_status', arguments: '{"routeNames":["R","S"]}' } }] }
    const payload = JSON.parse(messages.filter(message => message.role !== 'system').at(-1).content.split('\n').slice(1).join('\n')).data
    assert.deepEqual(payload.events[0].routeIds, ['S'], 'Alert associations survive projection and remain within the requested scope')
    assert.deepEqual(payload.events[0].stopNames, ['River'], 'The alert location is distinct from the interval reference stop')
    assert.equal(payload.routes[0].widestInterval.stopName, 'Depot')
    assert.equal(payload.routes[0].widestInterval.increaseMinutes, 9.7, 'Minute differences are computed before model interpretation')
    return { content: 'Check the wider interval at Depot. The escalator alert is at River. [1]' }
  } },
})
assert.match(associated.answer, /The escalator alert is at River/)
assert.equal(answer.timing.inputTokens, null, 'Missing provider usage is unknown, not zero')
let interruptedRound = 0
const partial = await queryAgency({ question: 'Check service', context, state, callTool, provider: { available: true, complete: async () => { if (++interruptedRound === 1) return { tool_calls: [{ id: 'one', function: { name: 'anomaly_scan', arguments: '{}' } }] }; throw new Error('Provider unavailable') } } })
assert.equal(partial.trace.length, 1)
assert.equal(partial.warnings.includes('Provider unavailable'), true)
assert.match(partial.answer, /Departure later than scheduled/, 'Provider failure retains the deterministic evidence summary')
assert.match(partial.answer, /model did not finish this answer/, 'A partial source result is not presented as a finished answer')
for (const malformed of [[null], [{ id: 'missing-function' }], [{ id: 'same', function: { name: 'anomaly_scan', arguments: '{}' } }, { id: 'same', function: { name: 'anomaly_scan', arguments: '{}' } }], {}]) {
  const result = await queryAgency({ question: 'Check service', context, state, callTool: async () => assert.fail('Malformed calls must not execute'), provider: { available: true, complete: async () => ({ tool_calls: malformed }) } })
  assert.equal(result.trace.length, 0)
  assert.match(result.warnings[0], /unreadable/)
}
const stop = new AbortController()
let stoppedCalls = 0
const stopped = await queryAgency({ question: 'Check service', context, state, signal: stop.signal,
  callTool: async () => { stoppedCalls++; stop.abort(); return callTool() },
  provider: { available: true, complete: async () => ({ tool_calls: ['first', 'second'].map((id) => ({ id, function: { name: 'anomaly_scan', arguments: '{}' } })) }) },
})
assert.equal(stoppedCalls, 1, 'Stopping a model batch must not execute its remaining calls')
assert.deepEqual(stopped.evidenceRefs, event.sourceRefs)
assert.ok(stopped.warnings.some((warning) => warning.startsWith('Stopped')))
const lastStop = new AbortController()
let finalCalls = 0
const stoppedAtLimit = await queryAgency({ question: 'Check service', context, state, signal: lastStop.signal,
  callTool: async () => { if (++finalCalls === 8) lastStop.abort(); return callTool() },
  provider: { available: true, complete: async () => ({ tool_calls: Array.from({ length: 8 }, (_, index) => ({ id: `check-${index}`, function: { name: 'anomaly_scan', arguments: '{}' } })) }) },
})
assert.match(stoppedAtLimit.warnings[0], /^Stopped\./, 'Cancellation on the last allowed call must still be recorded as a user stop')
const unavailable = await queryAgency({ question: 'What is happening?', context, state, callTool, provider: { available: false } })
assert.equal(unavailable.providerAvailable, false)
let recoveryRound = 0
const recovery = await queryAgency({ question: 'Find River', context, state, callTool: async () => { throw new Error('Stop lookup temporarily unavailable') }, provider: { available: true, complete: async (messages) => {
  if (++recoveryRound === 1) return { tool_calls: [{ id: 'lookup', function: { name: 'resolve_entities', arguments: '{"query":"River"}' } }] }
  assert.match(messages.filter(message => message.role !== 'system').at(-1).content, /Stop lookup temporarily unavailable/)
  return { content: 'I could not resolve that place. Please try a more specific name.' }
} } })
assert.equal(recovery.trace[0].result.ok, false, 'A failed lookup remains evidence instead of crashing context projection')
let recallRound = 0
const recalled = await queryAgency({ question: 'Find my earlier service profile', context, state,
  callTool: async () => ({ ok: true, data: { entries: [{ id: 4, title: 'Service profile', excerpt: 'Three scheduled starts.', notes: 'Not demand.', observedAt: state.generatedAt, sources: ['https://private.example/feed?token=fixture-secret'] }] }, provenance: ['notebook:entry/4'], generatedAt: state.generatedAt, warnings: [] }),
  history: [{ question: 'Earlier study', answer: 'Saved result.', observedAt: state.generatedAt, notes: 'A staff annotation.' }],
  provider: { available: true, complete: async (messages) => {
    assert.doesNotMatch(JSON.stringify(messages), /A staff annotation|Not demand/, 'Private notes never enter model context')
    assert.equal(messages.find(message => message.role === 'assistant').content, 'Saved result.', 'Assistant history contains the public answer without injected metadata')
    if (++recallRound === 1) return { tool_calls: [{ id: 'recall', function: { name: 'recall_notebook', arguments: '{"search":"service profile"}' } }] }
    assert.match(messages.filter(message => message.role !== 'system').at(-1).content, /Three scheduled starts/)
    assert.doesNotMatch(messages.filter(message => message.role !== 'system').at(-1).content, /fixture-secret|private.example/)
    return { content: 'Your saved investigation counted three scheduled starts. It describes supply, not demand or current service. [1]' }
  } },
})
assert.match(recalled.answer, /saved investigation/)
assert.deepEqual(recalled.citations, [1])
assert.match(recalled.trace[0].result.data.entries[0].sources[0], /fixture-secret/, 'Original source references remain local in the retained evidence')
const template = await draftRiderMessage({ event, context, channel: 'app' }, { available: false })
assert.match(template.body, /5 min/)
assert.equal(template.reviewRequired, true)
assert.deepEqual(template.evidenceRefs, event.sourceRefs)
const arranged = await draftRiderMessage({ event, context, channel: 'signage' }, { available: true, complete: async () => assert.fail('A starting draft must not add a nested inference call') })
assert.equal(arranged.generatedBy, 'template')
assert.match(arranged.body, /sorry/)
await assert.rejects(draftRiderMessage({ event, context, channel: 'app', language: 'fr' }, { available: false }), /English/)
assert.equal(createProvider({}).available, false)
let request
const configured = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'https://example.org/v1', VIGO_AGENCY_LLM_MODEL: 'test', VIGO_AGENCY_LLM_API_KEY: 'fixture-secret', VIGO_AGENCY_LLM_TEMPERATURE: '0' }, async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })) })
await configured.complete([{ role: 'user', content: 'question' }], [])
assert.equal(String(request.url), 'https://example.org/v1/chat/completions')
assert.equal(request.options.headers.authorization, 'Bearer fixture-secret')
assert.equal(configured.key, undefined)
assert.equal(JSON.parse(request.options.body).temperature, 0)
assert.throws(() => createProvider({ VIGO_AGENCY_LLM_TEMPERATURE: 'invalid' }), /Temperature/)
console.log('Agency agent: direct conversation, clarification, follow-ups, grounded tool explanations, bounded recovery, evidence preservation, cancellation, and private provider configuration passed.')
const streamedProgress = []
const streamedAnswer = await queryAgency({ question: 'How many routes?', context, state, onProgress: item => streamedProgress.push(item),
  provider: { available: true, complete: async (_messages, _tools, _signal, options) => {
    options.onActivity('thinking'); options.onActivity('content')
    return { content: 'No count was supplied.', metrics: { loadMs: 2, promptMs: 3, generationMs: 4 } }
  } } })
assert.ok(streamedAnswer.timing.firstResponseMs >= 0)
assert.equal(streamedAnswer.timing.promptMs, 3)
assert.equal(streamedAnswer.timing.loadMs, 2)
assert.equal(streamedAnswer.timing.generationMs, 4)
assert.deepEqual(streamedProgress.map(item => item.detail), ['Working on your request…', 'Preparing a response…', 'Writing the answer…'], 'Activity reports progress without printing hidden reasoning')
assert.equal(new Set(streamedProgress.map(item => item.phase)).size, 1, 'Status updates replace the same activity row')
let failedJourneyTurn = 0
const noJourney = await queryAgency({ question: 'Find a bus to the airport', context, state,
  callTool: async () => ({ ok: false, data: { error: 'Place search timed out.' }, warnings: ['Place search timed out.'], provenance: [] }),
  provider: { available: true, complete: async () => ++failedJourneyTurn === 1 ? { tool_calls: [{ id: 'route', function: { name: 'route_plan', arguments: '{"origin":"Museum","destination":"Airport"}' } }] } : { content: 'Take the invented express bus. It takes 45 minutes.' } },
})
assert.match(noJourney.answer, /Place search timed out/)
assert.doesNotMatch(noJourney.answer, /invented express|45 minutes/)
assert.equal(noJourney.aiGenerated, false)

const routeDefinition = toolDefinitions.find(tool => tool.name === 'route_plan')
const selection = createJourneyChoices(routeDefinition)
const initialJourneyForm = selection.definition()
assert.deepEqual(selection.arguments({ origin: 'Museum', destination: 'Airport', modes: ['transit'], when: 'now', resultUse: 'answer' }), { origin: 'Museum', destination: 'Airport', modes: ['transit'] })
assert.deepEqual(selection.arguments({ origin: 'Museum', destination: 'Airport', modes: ['transit'], when: { arriveBy: '18:00' }, resultUse: 'continue' }), { origin: 'Museum', destination: 'Airport', modes: ['transit'], arriveBy: '18:00' })
assert.throws(() => selection.arguments({ origin: 'Museum', destination: 'Airport', modes: ['transit'], when: { arriveBy: '18:00', departTime: '17:00' }, resultUse: 'answer' }), /Unknown/)
const museum = { kind: 'place', id: 'osm:way/321', name: 'Museum', label: 'Museum · River Street', lat: 20.25, lon: 10.75 }
const terminal = { kind: 'stop', id: 'S7', name: 'Airport Terminal', lat: 20.5, lon: 10.5 }
const unresolved = { ok: false, data: { error: 'Choose a location.', clarification: { endpoints: [
  { endpoint: 0, matches: [museum, { ...museum, id: 'osm:way/322', name: 'Museum parking' }, { ...museum, lat: 200 }] },
  { endpoint: 2, matches: [terminal] },
], resolved: [{ endpoint: 1, label: 'Library', stopId: 'S0', lat: 20, lon: 10 }] } }, warnings: [], provenance: [] }
const requested = { origin: 'Museum', destination: 'Airport', waypoints: ['Library'], serviceDate: '2026-10-01', arriveBy: '18:00' }
selection.observe(requested, unresolved)
const form = selection.definition()
assert.deepEqual(form.parameters.required, ['origin', 'destination'], 'An already resolved intermediate stop needs no model decision')
assert.deepEqual(form.parameters.properties.origin.enum, ['1', '2', 'unclear'], 'Only retrieved, valid coordinates or an explicit uncertainty choice are allowed')
assert.match(form.parameters.properties.origin.description, /endpoint 0/)
assert.doesNotMatch(form.parameters.properties.origin.description, /Museum/, 'Retrieved names remain source data instead of being promoted to system instructions')
assert.doesNotMatch(form.description, /Library/, 'Fixed source labels also stay outside system-level action forms')
for (const input of [{ origin: '3', destination: '1' }, { origin: '1' }, { origin: { lat: 1, lon: 2 }, destination: '1' }, { origin: '1', destination: '1', arriveBy: '22:00' }]) assert.throws(() => selection.arguments(input), /Invalid|required|Unknown/)
const picked = selection.arguments({ origin: '1', destination: '1' })
assert.deepEqual(picked, { serviceDate: '2026-10-01', arriveBy: '18:00', origin: { lat: 20.25, lon: 10.75, label: museum.label, placeId: museum.id }, destination: { lat: 20.5, lon: 10.5, label: terminal.name, stopId: terminal.id }, waypoints: [{ lat: 20, lon: 10, label: 'Library', stopId: 'S0' }] })
museum.lat = 0
assert.equal(selection.arguments({ origin: '1', destination: '1' }).origin.lat, 20.25, 'Selections retain a snapshot of the retrieved coordinates')
selection.observe(picked, { ok: true })
assert.equal(selection.definition(), initialJourneyForm, 'A finished journey restores the ordinary form for the next request')
assert.deepEqual(createJourneyChoices(routeDefinition).definition(), initialJourneyForm, 'Choice state is not shared between conversations')

let choiceRound = 0, routed = 0
const journeyInput = { modes: ['transit'], origin: requested.origin, destination: requested.destination, waypoints: requested.waypoints, when: { serviceDate: requested.serviceDate, arriveBy: requested.arriveBy }, resultUse: 'answer' }
const journeyResult = { ok: true, data: { plan: { durationMinutes: 23.5, legs: [{ type: 'ride' }] }, request: { serviceDate: '2026-10-01', timezone: 'Etc/UTC' }, realtime: { applied: false } }, warnings: [], provenance: [] }
const selectedJourney = await queryAgency({ question: 'Museum to airport via library, arrive by 6pm on October 1', context, state,
  provider: { available: true, complete: async (_messages, tools) => {
    if (++choiceRound === 1) return { tool_calls: [{ id: 'lookup', function: { name: 'route_plan', arguments: JSON.stringify(journeyInput) } }] }
    if (choiceRound === 2) {
      assert.equal(_messages.length, 2, 'Location selection needs only its instruction and relevant candidates')
      assert.match(_messages[1].content, /Museum.*Airport/s)
      assert.doesNotMatch(_messages[0].content, /network_overview|gtfs_query/)
      assert.deepEqual(tools.find(tool => tool.name === 'route_plan').parameters.required, ['origin', 'destination'])
      return { tool_calls: [{ id: 'select', function: { name: 'route_plan', arguments: '{"origin":"1","destination":"1"}' } }] }
    }
    assert.fail('A completed journey needs no generation to rewrite its computed values')
  } },
  callTool: async (name, args) => {
    assert.equal(name, 'route_plan')
    if (++routed === 1) return unresolved
    assert.equal(args.origin.lon, 10.75)
    assert.equal(args.destination.stopId, 'S7')
    assert.equal(args.waypoints[0].stopId, 'S0')
    assert.equal(args.arriveBy, '18:00')
    assert.equal(args.resultUse, undefined, 'The completion choice belongs to the harness, not the routing engine')
    return journeyResult
  },
})
assert.equal(routed, 2, 'One lookup and one coordinate routing check; no repeated geocoding round')
assert.equal(selectedJourney.trace[1].arguments.destination.lon, 10.5, 'The saved evidence records the coordinates actually routed')
assert.match(selectedJourney.answer, /Transit: 24 min.*walking, waiting, and riding/s)
assert.equal(selectedJourney.trace[1].result.data.request.serviceDate, '2026-10-01')
assert.equal(selectedJourney.trace[1].result.data.realtime.applied, false, 'The itinerary retains its date and timetable-only status for display')
assert.equal(selectedJourney.aiGenerated, false)
assert.deepEqual(selectedJourney.citations, [2])

let continuedJourneyCalls = 0
const continuedJourney = await queryAgency({ question: 'Calculate this journey, then explain the transfer policy', context, state,
  provider: { available: true, complete: async () => ++continuedJourneyCalls === 1
    ? { tool_calls: [{ id: 'continue-journey', function: { name: 'route_plan', arguments: JSON.stringify({ ...journeyInput, resultUse: 'continue' }) } }] }
    : { content: 'The journey and the requested transfer explanation.' } }, callTool: async () => journeyResult,
})
assert.equal(continuedJourneyCalls, 2, 'A computed journey does not end a request that still needs other work')
assert.match(continuedJourney.answer, /transfer explanation/)

const retrySelection = createJourneyChoices(routeDefinition)
retrySelection.observe({ origin: 'Library', destination: 'Airport', arriveBy: '18:00' }, { ok: true, data: { status: 'needs_location_choice', clarification: {
  endpoints: [{ endpoint: 1, matches: [terminal, { ...terminal, id: 'S8', name: 'Other terminal platform' }] }],
  resolved: [{ endpoint: 0, label: 'Library', stopId: 'S0', lat: 20, lon: 10 }],
} } })
assert.equal(retrySelection.selectionOnly(), true, 'A completed lookup leads to a selection task, not another free-form answer')
const noPathRequest = retrySelection.arguments({ destination: '2' })
retrySelection.observe(noPathRequest, { ok: true, data: { plan: { status: 'blocked', legs: [] } } })
assert.deepEqual(retrySelection.definition().parameters.properties.destination.enum, ['1', 'unclear'], 'Review an untested arrival point before concluding that the whole destination is unreachable; preserve co-located stop identity')
assert.equal(retrySelection.arguments({ destination: '1' }).destination.stopId, 'S7')
assert.throws(() => retrySelection.arguments({ destination: '2' }), /Invalid/, 'Do not repeat the same no-path check')
assert.throws(() => retrySelection.arguments({ destination: 'unclear' }), error => error.details.status === 'needs_user_location')
assert.equal(retrySelection.retainedRequest().arriveBy, '18:00')
assert.equal(retrySelection.retainedRequest().origin.stopId, 'S0')
assert.equal(retrySelection.retainedRequest().destination, 'Airport', 'A clarification retains real journey inputs, never model option numbers')

const failureActivity = []
await queryAgency({ question: 'Hello', context, state, onProgress: item => failureActivity.push(item), provider: { available: true, complete: async () => { throw new Error('Fixture unavailable') } } })
assert.equal(failureActivity.filter(item => item.detail === 'Fixture unavailable').length, 1, 'A provider failure appears once in activity')

// Research adapters may exist on the server, but everyday Ask must not launch them.
let focusedTurns = 0
const focused = await queryAgency({ question: 'Explain this service and prepare an update.', context, state, placesAvailable: false, runtimeStudyAvailable: true,
  provider: { available: true, complete: async (_messages, tools) => {
    assert.ok(!JSON.stringify(tools).includes('compare_holding'))
    assert.ok(!JSON.stringify(tools).includes('run_runtime_study'))
    if (++focusedTurns === 1) return { tool_calls: ['compare_holding', 'run_runtime_study'].map((name, index) => ({ id: `outside-${index}`, function: { name, arguments: '{}' } })) }
    return { content: 'Those research actions are outside Ask. Current service evidence and rider drafts remain available.' }
  } }, callTool: () => assert.fail('A model cannot invoke an out-of-scope research adapter'),
})
assert.equal(focused.trace.length, 2)
assert.ok(focused.trace.every(call => !call.result.ok))
assert.ok(!focused.runtime.networkTools.some(tool => tool.tool === 'run_runtime_study'))
console.log('Focused Ask: research actions excluded from discovery, execution and runtime capabilities.')
