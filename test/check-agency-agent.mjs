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
const answer = await queryAgency({ question: 'What is happening?', context, state, callTool, provider })
assert.equal(answer.trace.length, 1)
assert.deepEqual(answer.evidenceRefs, event.sourceRefs)
assert.doesNotMatch(answer.answer, /90|everything is cancelled/, 'Free model prose is never accepted as operational truth')
const unavailable = await queryAgency({ question: 'What is happening?', context, state, callTool, provider: { available: false } })
assert.equal(unavailable.providerAvailable, false)
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
