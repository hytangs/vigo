import assert from 'node:assert/strict'
import { queryAgency } from '../src/agency/queryAgent.mjs'
import { draftRiderMessage } from '../src/agency/communications.mjs'
import { createProvider } from '../src/agency/provider.mjs'
const state = { generatedAt: '2026-09-13T12:00:00Z', observedAt: '2026-09-13T12:00:00Z' }
const context = { overview: () => ({ cityName: 'City X' }), routeIndex: new Map([['R', { short_name: 'R' }]]), stopIndex: new Map([['A', { name: 'River' }]]) }
const event = { id: 'delay/T1', type: 'delay', title: 'Departure later than scheduled', routeId: 'R', stopId: 'A', observedAt: state.observedAt, evidence: { delaySeconds: 300 }, sourceRefs: ['fixture:trip/T1'] }
let round = 0
const provider = { available: true, complete: async () => ++round === 1 ? { tool_calls: [{ id: 'call-1', function: { name: 'anomaly_scan', arguments: '{}' } }] } : { content: 'Invented: everything is cancelled for 90 minutes.' } }
const callTool = async () => ({ ok: true, data: { events: [event], total: 1 }, provenance: event.sourceRefs, generatedAt: state.generatedAt, warnings: [] })
const progress = []
const answer = await queryAgency({ question: 'What is happening?', context, state, callTool, provider, onProgress: (item) => progress.push(item) })
assert.equal(progress[0].phase, 'planning')
assert.ok(progress.some((item) => item.phase === 'tool-0' && item.progress === 0))
assert.ok(progress.some((item) => item.phase === 'tool-0' && item.progress === 1))
assert.doesNotMatch(JSON.stringify(progress), /everything is cancelled/)
assert.equal(answer.trace.length, 1)
assert.deepEqual(answer.evidenceRefs, event.sourceRefs)
assert.doesNotMatch(answer.answer, /90|everything is cancelled/, 'Free model prose is never accepted as operational truth')
let interruptedRound = 0
const partial = await queryAgency({ question: 'Check service', context, state, callTool, provider: { available: true, complete: async () => { if (++interruptedRound === 1) return { tool_calls: [{ id: 'one', function: { name: 'anomaly_scan', arguments: '{}' } }] }; throw new Error('Provider unavailable') } } })
assert.equal(partial.trace.length, 1)
assert.equal(partial.warnings.includes('Provider unavailable'), true)
const unavailable = await queryAgency({ question: 'What is happening?', context, state, callTool, provider: { available: false } })
assert.equal(unavailable.providerAvailable, false)
let recoveryRound = 0
const recovery = await queryAgency({ question: 'Find River', context, state, callTool: async () => { throw new Error('Stop lookup temporarily unavailable') }, provider: { available: true, complete: async (messages) => {
  if (++recoveryRound === 1) return { tool_calls: [{ id: 'lookup', function: { name: 'resolve_entities', arguments: '{"query":"River"}' } }] }
  assert.match(messages.at(-1).content, /Stop lookup temporarily unavailable/)
  return { content: 'Done' }
} } })
assert.equal(recovery.trace[0].result.ok, false, 'A failed lookup remains evidence instead of crashing context projection')
let recallRound = 0
const recalled = await queryAgency({ question: 'Find my earlier service profile', context, state,
  callTool: async () => ({ ok: true, data: { entries: [{ id: 4, title: 'Service profile', excerpt: 'Three scheduled starts.', notes: 'Not demand.', observedAt: state.generatedAt, sources: ['https://private.example/feed?token=fixture-secret'] }] }, provenance: ['notebook:entry/4'], generatedAt: state.generatedAt, warnings: [] }),
  history: [{ question: 'Earlier study', answer: 'Saved result.', observedAt: state.generatedAt, notes: 'A staff annotation.' }],
  provider: { available: true, complete: async (messages) => {
    assert.match(messages[2].content, /Staff annotation.*A staff annotation/s)
    if (++recallRound === 1) return { tool_calls: [{ id: 'recall', function: { name: 'recall_notebook', arguments: '{"search":"service profile"}' } }] }
    assert.match(messages.at(-1).content, /Three scheduled starts/)
    assert.doesNotMatch(messages.at(-1).content, /fixture-secret|private.example/)
    return { content: 'Invented current service assessment' }
  } },
})
assert.match(recalled.answer, /saved investigation/)
assert.doesNotMatch(recalled.answer, /Invented/)
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
const configured = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'https://example.org/v1', VIGO_AGENCY_LLM_MODEL: 'test', VIGO_AGENCY_LLM_API_KEY: 'fixture-secret' }, async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })) })
await configured.complete([{ role: 'user', content: 'question' }], [])
assert.equal(String(request.url), 'https://example.org/v1/chat/completions')
assert.equal(request.options.headers.authorization, 'Bearer fixture-secret')
assert.equal(configured.key, undefined)
console.log('Agency agent: mocked planning, evidence preservation, unavailable provider, constrained rider drafts, unsupported content, and private provider configuration passed.')
