import assert from 'node:assert/strict'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { draftRiderMessage } from '../src/agency/communications.mjs'
import { createProvider } from '../src/agency/provider.mjs'
const state = { generatedAt: '2026-09-13T12:00:00Z', observedAt: '2026-09-13T12:00:00Z' }
const context = { overview: () => ({ cityName: 'City X' }), routeIndex: new Map([['R', { short_name: 'R' }]]), stopIndex: new Map([['A', { name: 'River' }]]) }
const event = { id: 'delay/T1', type: 'delay', title: 'Departure later than scheduled', routeId: 'R', stopId: 'A', observedAt: state.observedAt, evidence: { delaySeconds: 300 }, sourceRefs: ['fixture:trip/T1'] }
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
    assert.match(messages[2].content, /successive vehicles/)
    assert.equal(messages.at(-1).content, 'Make that shorter')
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

let compactRound = 0
const largeEvents = Array.from({ length: 50 }, (_, index) => ({ ...event, id: `event-${index}`, evidence: { ...event.evidence, comparisonTrips: Array.from({ length: 100 }, () => ({ tripId: 'T1' })) } }))
const scoped = await queryAgency({ question: 'Check route R', context, state,
  callTool: async () => ({ ok: true, data: { connected: true, observedAt: state.generatedAt, scope: { routeId: 'R' }, counts: { routes: 100 }, feeds: [], routes: [{ id: 'R', name: 'R', maxDelaySeconds: 300 }], events: largeEvents }, provenance: ['fixture:route/R'], warnings: [] }),
  provider: { available: true, complete: async (messages) => {
    if (++compactRound === 1) return { tool_calls: [{ id: 'status', function: { name: 'realtime_status', arguments: '{"routeId":"R"}' } }] }
    const payload = JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n'))
    assert.equal(payload.data.scope.routeId, 'R')
    assert.equal(payload.data.networkCounts.routes, 100, 'Network counts stay explicitly separate from route measurements')
    assert.equal(payload.data.events.length, 3)
    assert.equal(payload.data.events[0].id, 'event-0', 'Projected findings retain IDs for follow-up tools')
    assert.equal(payload.data.eventCount, 50)
    assert.equal(payload.data.routes[0].maxDelaySeconds, 300)
    assert.ok(messages.at(-1).content.length < 2500, 'Operational context omits bulky per-trip comparison records')
    assert.match(payload.warnings.at(-1), /Selected records only/)
    return { content: 'Route R has a reported five-minute delay. [1]' }
  } } })
assert.equal(scoped.trace[0].result.data.events.length, 50, 'The full evidence is retained independently of the model projection')
let interruptedRound = 0
const partial = await queryAgency({ question: 'Check service', context, state, callTool, provider: { available: true, complete: async () => { if (++interruptedRound === 1) return { tool_calls: [{ id: 'one', function: { name: 'anomaly_scan', arguments: '{}' } }] }; throw new Error('Provider unavailable') } } })
assert.equal(partial.trace.length, 1)
assert.equal(partial.warnings.includes('Provider unavailable'), true)
assert.match(partial.answer, /Departure later than scheduled/, 'Provider failure retains the deterministic evidence summary')
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
  assert.match(messages.at(-1).content, /Stop lookup temporarily unavailable/)
  return { content: 'I could not resolve that place. Please try a more specific name.' }
} } })
assert.equal(recovery.trace[0].result.ok, false, 'A failed lookup remains evidence instead of crashing context projection')
let recallRound = 0
const recalled = await queryAgency({ question: 'Find my earlier service profile', context, state,
  callTool: async () => ({ ok: true, data: { entries: [{ id: 4, title: 'Service profile', excerpt: 'Three scheduled starts.', notes: 'Not demand.', observedAt: state.generatedAt, sources: ['https://private.example/feed?token=fixture-secret'] }] }, provenance: ['notebook:entry/4'], generatedAt: state.generatedAt, warnings: [] }),
  history: [{ question: 'Earlier study', answer: 'Saved result.', observedAt: state.generatedAt, notes: 'A staff annotation.' }],
  provider: { available: true, complete: async (messages) => {
    assert.match(messages[0].content, /staffAnnotation.*A staff annotation/s)
    assert.equal(messages[2].content, 'Saved result.', 'Assistant history contains the public answer without injected metadata')
    if (++recallRound === 1) return { tool_calls: [{ id: 'recall', function: { name: 'recall_notebook', arguments: '{"search":"service profile"}' } }] }
    assert.match(messages.at(-1).content, /Three scheduled starts/)
    assert.doesNotMatch(messages.at(-1).content, /fixture-secret|private.example/)
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
const arranged = await draftRiderMessage({ event, context, channel: 'signage' }, { available: true, complete: async () => ({ content: '{"sentenceIds":["fact"]}' }) })
assert.equal(arranged.generatedBy, 'model')
await assert.rejects(draftRiderMessage({ event, context, channel: 'app' }, { available: true, complete: async () => ({ content: '{"sentenceIds":["fact"],"body":"Recovery in 10 minutes"}' }) }), /unsupported/)
await assert.rejects(draftRiderMessage({ event, context, channel: 'app' }, { available: true, complete: async () => ({ content: '{"sentenceIds":["invented"]}' }) }), /unsupported/)
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
