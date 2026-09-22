import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { endpointFacts } from '../src/agency/runtimeFacts.mjs'
import { createProvider } from '../src/agency/provider.mjs'
import { createWebResearch } from '../src/agency/webResearch.mjs'
import { createPlaceSearch } from '../src/agency/placeSearch.mjs'
import { createNotebook } from '../src/agency/notebook.mjs'
import { queryAgency } from '../src/agency/queryAgent.mjs'

const environment = { VIGO_AGENCY_LLM_BASE_URL: 'http://localhost:11434', VIGO_AGENCY_LLM_MODEL: 'arbitrary-model', VIGO_AGENCY_LLM_PROTOCOL: 'ollama', VIGO_AGENCY_LLM_API_KEY: 'private-model-key' }
const provider = createProvider(environment)
const inference = provider.forRequest()
assert.equal(inference.runtime.endpoint, 'localhost:11434')
assert.equal(inference.runtime.endpointLocation, 'loopback')
assert.equal(inference.runtime.inferenceLocation, 'unverified', 'Loopback is not proof of local inference')
assert.equal(inference.runtime.externalModelApi, 'unverified')
assert.throws(() => { inference.runtime.inferenceLocation = 'local' }, TypeError)
provider.disconnect()
assert.equal(inference.runtime.model, 'arbitrary-model', 'Old answers retain their request configuration')
assert.equal(provider.forRequest().runtime.model, null)
const remote = createProvider({ ...environment, VIGO_AGENCY_LLM_BASE_URL: 'https://models.example/private-path' }).forRequest().runtime
assert.equal(remote.endpointLocation, 'other')
assert.equal(remote.inferenceLocation, 'unverified')
assert.equal(remote.externalModelApi, 'unverified')
assert.doesNotMatch(JSON.stringify(remote), /private-model-key|private-path/)
assert.equal(endpointFacts('https://user:password@search.example/private?key=secret').endpoint, 'search.example', 'Metadata never includes credentials, paths or queries')
assert.equal(endpointFacts('http://[::1]:1234').endpointLocation, 'loopback')
assert.equal(endpointFacts('http://localhost.example').endpointLocation, 'other')
assert.equal(endpointFacts('invalid').endpointLocation, 'unknown')
assert.equal(endpointFacts('https://127.0.0.2').endpointLocation, 'loopback')

const web = createWebResearch({ env: {}, readPage: async () => ({}) }).forRequest()
assert.equal(web.endpoint, 'html.duckduckgo.com')
const places = createPlaceSearch({ env: {} })
assert.equal(places.endpoint, 'photon.komoot.io')
const privateSearch = createWebResearch({ env: { VIGO_AGENCY_WEB_SEARCH_PROVIDER: 'searxng', VIGO_AGENCY_WEB_SEARCH_URL: 'http://localhost:8080/search', VIGO_AGENCY_WEB_SEARCH_KEY: 'private-search-key' } }).forRequest()
assert.equal(privateSearch.endpoint, 'localhost:8080')

const state = { generatedAt: '2026-09-13T12:00:00Z' }, context = { overview: () => ({}), routeIndex: new Map() }
let turn = 0
const answer = await queryAgency({ question: 'Is everything local and secure?', context, state, webStatus: web, placesAvailable: places.enabled, placeEndpoint: places.endpoint,
  history: [{ question: 'What model?', answer: 'Everything is local and secure.' }],
  provider: { ...inference, reviewUnverifiedReplies: false, complete: async messages => {
    assert.match(messages[0].content, /Never infer architecture/)
    assert.match(messages[1].content, /neither local nor remote inference/, 'Trusted runtime context distinguishes unknown hosting from both local and remote claims')
    assert.doesNotMatch(JSON.stringify(messages), /private-model-key|private-search-key/)
    if (++turn === 1) return { tool_calls: [{ id: 'read', function: { name: 'web_read', arguments: '{"url":"https://example.org"}' } }] }
    return { content: 'Model text cannot modify the runtime record.' }
  } }, callTool: async () => ({ ok: false, data: null, warnings: ['Unavailable'], provenance: [], generatedAt: state.generatedAt }) })
assert.deepEqual(answer.runtime.networkTools.map(tool => tool.tool), ['web_search', 'web_read', 'place_search'])
assert.deepEqual(answer.runtime.networkToolCalls, [{ tool: 'web_read', completed: false }], 'A failed call is still an attempted use, not proof of zero network traffic')
assert.equal(answer.runtime.modelConnection.model, 'arbitrary-model')
const offline = await queryAgency({ question: 'Explain headways', context, state, placesAvailable: false, webStatus: { searchAvailable: false, readAvailable: false },
  provider: { available: true, complete: async () => ({ content: 'Time between vehicles.' }) } })
assert.deepEqual(offline.runtime.networkTools, [])
assert.deepEqual(offline.runtime.networkToolCalls, [])
assert.equal(offline.runtime.modelConnection.externalModelApi, 'unknown', 'Missing metadata must not become a local deployment claim')
let runtimeTurn = 0
const factual = await queryAgency({ question: 'Is inference local?', context, state, webStatus: web, placesAvailable: places.enabled, placeEndpoint: places.endpoint,
  provider: { ...inference, reviewUnverifiedReplies: false, complete: async messages => {
    if (++runtimeTurn === 1) return { content: 'Everything is local and secure.', tool_calls: [{ id: 'runtime', function: { name: 'runtime_status', arguments: '{}' } }] }
    const result = JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n'))
    assert.equal(result.data.inferenceHosting, 'Not verified')
    assert.match(result.data.requestWorkflow.execution, /VIGO validates arguments/)
    assert.match(result.data.requestWorkflow.diagnosis, /not private model reasoning/)
    assert.doesNotMatch(JSON.stringify(result.data), /localhost:11434|arbitrary-model/, 'Ambiguous endpoint/model cues belong in the server-rendered record, not speculative prose')
    return { content: 'Inference hosting is not verified by the server configuration. [1]' }
  } } })
assert.equal(factual.aiGenerated, true)
assert.equal(runtimeTurn, 2, 'Runtime evidence returns to the conversation; it must not force a final answer')
assert.equal(factual.trace.length, 1)
assert.doesNotMatch(factual.answer, /Everything is local and secure/)
assert.deepEqual(factual.runtime.networkToolCalls, [])

let countTurn = 0
const count = await queryAgency({ question: 'How many routes are there?', context: { ...context, overview: () => ({ cityName: 'City X', counts: { routes: 37 } }) }, state,
  provider: { ...inference, reviewUnverifiedReplies: false, complete: async (messages, tools) => {
    if (++countTurn === 1) {
      assert.ok(tools.some(tool => tool.name === 'runtime_status'), 'Privacy questions can request the server record without a discovery round')
      assert.match(messages[1].content, /privacyAndSecurity.*not verified/, 'Hosting and privacy limits are server-supplied context even before a tool call')
      // Reproduce the wrong selection from the reported failure.
      return { tool_calls: [{ id: 'misrouted', function: { name: 'runtime_status', arguments: '{}' } }] }
    }
    assert.equal(messages.at(-2).role, 'assistant')
    assert.ok(messages.some(message => message.content === 'How many routes are there?'))
    return { content: 'City X has 37 indexed routes.' }
  } } })
assert.equal(count.answer, 'City X has 37 indexed routes.')
assert.equal(countTurn, 2)
assert.equal(count.runtime.modelConnection.inferenceLocation, 'unverified', 'A corrected transit answer still retains honest deployment metadata')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-runtime-'))
let notebook
try {
  notebook = createNotebook(directory)
  const saved = notebook.save({ title: 'Runtime check', answer })
  notebook.close(); notebook = createNotebook(directory)
  assert.deepEqual(notebook.read(saved.id).answer.runtime, answer.runtime, 'Runtime evidence survives restart and provider changes')
} finally { notebook?.close(); fs.rmSync(directory, { recursive: true, force: true }) }
console.log('Agency runtime: request snapshots, unknown hosting, endpoint redaction, available versus attempted tools, and saved evidence passed.')
