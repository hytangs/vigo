import assert from 'node:assert/strict'
import { createProvider } from '../src/agency/provider.mjs'

const requests = []
let mode = 'ok'
const provider = createProvider({}, async (url, options) => {
  requests.push({ url, ...options, body: options.body && JSON.parse(options.body) })
  if (mode === 'unauthorized') return new Response('secret-should-not-echo', { status: 401 })
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }, { id: 'test-model' }, { id: 'other-model' }] })
  return Response.json({ choices: [{ message: mode === 'no-tools' ? { content: 'ready' } : { tool_calls: [{ function: { name: 'connection_check', arguments: '{"ready":true}' } }] } }] })
})
const connection = { baseUrl: 'https://models.example/v1/chat/completions', model: 'test-model', apiKey: 'session-secret' }
assert.equal(provider.available, false)
assert.deepEqual((await provider.models(connection)).models, ['other-model', 'test-model'])
assert.equal(provider.available, false, 'Discovery must not change the active provider')
const status = await provider.connect(connection)
assert.equal(status.available, true)
assert.equal(status.baseUrl, 'https://models.example/v1')
assert.ok(status.testedAt)
assert.equal(status.hasKey, true)
assert.equal(JSON.stringify(status).includes(connection.apiKey), false)
assert.equal(requests.at(-1).headers.authorization, 'Bearer session-secret')
assert.equal(requests.at(-1).redirect, 'error', 'Do not forward a provider key through redirects')
await provider.models({ baseUrl: status.baseUrl })
assert.equal(requests.at(-1).headers.authorization, 'Bearer session-secret')
await provider.models({ baseUrl: 'https://different.example/v1' })
assert.equal(requests.at(-1).headers.authorization, undefined, 'Never carry a key to another endpoint')
const activeRequest = provider.forRequest()
const originalRuntime = { ...activeRequest.runtime }
await activeRequest.complete([{ role: 'user', content: 'A private investigation' }], [])
assert.equal(requests.at(-1).url, 'https://models.example/v1/chat/completions')
assert.equal(requests.at(-1).body.tool_choice, 'none', 'A final response explicitly disables more tool calls, even when earlier calls remain in conversation history')
await provider.connect({ baseUrl: 'https://different.example/v1', model: 'other-model' })
assert.deepEqual(activeRequest.runtime, originalRuntime)
assert.equal(provider.forRequest().runtime.endpoint, 'different.example')
const countBefore = requests.length
assert.throws(() => activeRequest.complete([{ role: 'user', content: 'Continue the private investigation' }], []), /connection changed/)
assert.equal(requests.length, countBefore, 'An active investigation cannot send its next round to a newly selected provider')
await provider.connect(connection)
mode = 'no-tools'
await assert.rejects(provider.connect({ ...connection, model: 'unsupported' }), /function calling/)
assert.equal(provider.model, 'test-model', 'An unsuccessful connection leaves the current provider intact')
mode = 'unauthorized'
await assert.rejects(provider.models(connection), (error) => error.message.includes('401') && !error.message.includes('secret-should-not-echo'))
for (const baseUrl of ['file:///etc/passwd', 'https://user:pass@models.example', 'http://models.example/v1', 'https://models.example/v1?key=secret']) await assert.rejects(provider.models({ baseUrl }))
const disconnectedRequest = provider.forRequest()
provider.disconnect()
assert.throws(() => disconnectedRequest.complete([], []), /connection changed/)
assert.equal(provider.available, false)
assert.equal(provider.status().hasKey, false)
assert.equal(JSON.stringify(provider.status()).includes(connection.apiKey), false)
const nativeRequests = []
const native = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'http://localhost:11434', VIGO_AGENCY_LLM_MODEL: 'local-model', VIGO_AGENCY_LLM_PROTOCOL: 'ollama', VIGO_AGENCY_LLM_CONTEXT_TOKENS: '8192', VIGO_AGENCY_LLM_REASONING_EFFORT: 'none' }, async (url, options) => {
  nativeRequests.push({ url, body: options.body && JSON.parse(options.body) })
  if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'local-model' }] })
  if (nativeRequests.at(-1).body.format) return Response.json({ message: { content: '{"action":"connection_check","arguments":{"ready":true}}' } })
  return Response.json({ done_reason: 'stop', prompt_eval_count: 100, eval_count: 20, message: { content: '', thinking: 'private reasoning', tool_calls: [{ function: { name: 'connection_check', arguments: { ready: true } } }] } })
})
assert.deepEqual((await native.models({ baseUrl: 'http://localhost:11434', protocol: 'ollama' })).models, ['local-model'])
await native.connect({ baseUrl: 'http://localhost:11434', model: 'local-model', protocol: 'ollama', reasoningEffort: 'none' })
assert.equal(nativeRequests.at(-1).body.options.num_ctx, 8192)
assert.equal(nativeRequests.at(-1).body.think, false)
const nativeReply = await native.complete([{ role: 'user', content: 'Check' }], [])
assert.equal(nativeReply.usage.prompt_tokens, 100)
assert.equal(nativeReply.thinking, undefined, 'Private reasoning never enters the common response')
await native.complete([{ role: 'assistant', content: null, tool_calls: nativeReply.tool_calls }, { role: 'tool', tool_call_id: nativeReply.tool_calls[0].id, content: 'Done' }], [])
assert.equal(nativeRequests.at(-1).body.messages[1].tool_name, 'connection_check')
assert.deepEqual(nativeRequests.at(-1).body.messages[0].tool_calls[0].function.arguments, { ready: true })
for (const [reasoningEffort, expected] of [['on', true], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['', undefined]]) {
  await native.connect({ baseUrl: 'http://localhost:11434', model: 'local-model', protocol: 'ollama', reasoningEffort })
  assert.equal(nativeRequests.at(-1).body.think, false, 'The local connection probe does not run a reasoning investigation')
  assert.equal(nativeRequests.at(-1).body.options.num_predict, 128, 'Bound the local test to its small required form')
  assert.equal(nativeRequests.at(-1).body.options.temperature, 0)
  assert.equal(native.status().reasoningEffort, reasoningEffort, 'Testing must preserve the selected reasoning setting')
  await native.complete([{ role: 'user', content: 'A normal question after connecting' }], [])
  assert.equal(nativeRequests.at(-1).body.think, expected, 'Preserve native reasoning levels without guessing from a model name')
  assert.equal(nativeRequests.at(-1).body.options.num_predict, 1800, 'The probe budget must not restrict normal questions')
}
await assert.rejects(provider.models({ baseUrl: 'https://models.example/v1', protocol: 'openai', reasoningEffort: 'on' }), /reasoning effort/)
await assert.rejects(native.models({ baseUrl: 'http://localhost:11434', protocol: 'ollama', contextTokens: 10 }), /Local context/)
assert.throws(() => createProvider({ VIGO_AGENCY_LLM_PROTOCOL: 'invented' }), /protocol/)
assert.equal(createProvider({ VIGO_AGENCY_LLM_PROTOCOL: 'ollama' }).status().reasoningEffort, 'none', 'Environment and desktop connections default to quick local responses')
assert.equal(createProvider({ VIGO_AGENCY_LLM_PROTOCOL: 'ollama', VIGO_AGENCY_LLM_REASONING_EFFORT: '' }).status().reasoningEffort, '', 'Explicit provider default remains available')
assert.equal(createProvider({}).status().reasoningEffort, '', 'Cloud providers retain their own default')
await native.connect({ baseUrl: 'http://localhost:11434', model: 'local-model', protocol: 'ollama' })
await native.complete([{ role: 'user', content: 'A question using the connection defaults' }], [])
assert.equal(nativeRequests.at(-1).body.think, false, 'Session connections and environment configuration use the same local default')
console.log('Agency provider: model discovery, inference verification, private session keys, endpoint isolation, failure recovery, and disconnect passed.')

for (const value of ['NaN', '0', '300001']) assert.throws(() => createProvider({ VIGO_AGENCY_LLM_TIMEOUT_MS: value }), /timeout/)
const timed = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'http://localhost:11434', VIGO_AGENCY_LLM_MODEL: 'local-model', VIGO_AGENCY_LLM_TIMEOUT_MS: '1000' }, (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })))
// Keep the isolated fixture alive while the provider's unref'd deadline expires.
const keepAlive = setInterval(() => {}, 2000)
try { await assert.rejects(timed.complete([], []), /within 1 seconds/) } finally { clearInterval(keepAlive) }
for (const [kind, detail] of [['thinking', /still reasoning/], ['content', /started responding/]]) {
  const active = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'http://localhost:11434', VIGO_AGENCY_LLM_PROTOCOL: 'ollama', VIGO_AGENCY_LLM_MODEL: 'local-model', VIGO_AGENCY_LLM_TIMEOUT_MS: '1000' }, async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { [kind]: 'private unfinished text' } }) + '\n'))
    options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true })
  } }), { headers: { 'content-type': 'application/x-ndjson' } }))
  const timer = setInterval(() => {}, 2000)
  try { await assert.rejects(active.complete([], [], undefined, { onActivity() {} }), error => detail.test(error.message) && !/private unfinished text|No response activity/.test(error.message)) }
  finally { clearInterval(timer) }
}

// Native streaming must surface activity before completion, without leaking
// thinking or executing an incomplete function call.
const { readProviderResponse } = await import('../src/agency/providerResponse.mjs')
const encoder = new TextEncoder(), activities = []
let streamController
const stream = new ReadableStream({ start(controller) { streamController = controller } })
const streamed = readProviderResponse(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }), kind => activities.push(kind))
streamController.enqueue(encoder.encode(JSON.stringify({ message: { thinking: 'private draft' } }) + '\n'))
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(activities, ['thinking'], 'Activity arrives while inference is still running')
const wire = encoder.encode([
  JSON.stringify({ message: { content: '你好' } }),
  JSON.stringify({ message: { tool_calls: [{ function: { name: 'network_overview', arguments: {} } }] } }),
  JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 10, eval_count: 3, prompt_eval_duration: 1000000 }),
].join('\n'))
for (const byte of wire) streamController.enqueue(Uint8Array.of(byte))
streamController.close()
const assembled = await streamed
assert.equal(assembled.message.content, '你好', 'UTF-8 and NDJSON boundaries may cross arbitrary network chunks')
assert.equal(assembled.message.tool_calls.length, 1)
assert.equal(assembled.prompt_eval_count, 10)
assert.deepEqual(activities, ['thinking', 'content', 'tool'])
assert.doesNotMatch(JSON.stringify(assembled), /private draft|thinking/)
const ndjson = text => new Response(text, { headers: { 'content-type': 'application/x-ndjson' } })
await assert.rejects(readProviderResponse(ndjson('{"message":{"content":"unfinished"}}\n')), /before its response was complete/)
await assert.rejects(readProviderResponse(ndjson('{broken}\n')), /valid JSON/)
await assert.rejects(readProviderResponse(ndjson('{"error":"private server detail"}\n')), error => !error.message.includes('private server detail'))
await assert.rejects(readProviderResponse(ndjson('{"done":true}\n{"message":{"content":"extra"}}\n')), /after its completed response/)
await assert.rejects(readProviderResponse(ndjson('x'.repeat(2_000_001))), /too large/)
let cancelled = false
const broken = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('not-json\n')) }, cancel() { cancelled = true } })
await assert.rejects(readProviderResponse(new Response(broken, { headers: { 'content-type': 'application/x-ndjson' } })), /valid JSON/)
assert.equal(cancelled, true, 'A rejected stream releases its upstream reader')
console.log('Agency provider streaming: early activity, UTF-8 boundaries, complete tools, private reasoning exclusion, incomplete streams and bounded reads passed.')

const { providerChoice } = await import('../src/agency/providerChoice.mjs')
const { toolDefinitions } = await import('../src/agency/toolRegistry.mjs')
const route = toolDefinitions.find(tool => tool.name === 'route_plan')
const form = providerChoice([{ role: 'user', content: 'Find a bus from the museum to the airport.' }], [route])
assert.deepEqual(form.parse('{"task":"Plan a journey","action":"answer","text":"There are 37 indexed routes."}'), { content: 'There are 37 indexed routes.' })
assert.equal(form.parse('{"task":"Plan a journey","action":"route_plan","arguments":{"origin":"Museum","destination":"Airport"}}').tool_calls[0].function.name, 'route_plan')
for (const bad of ['{"task":"Plan a journey","action":"route_plan","arguments":{"names":["Museum","Airport"]}}', '{"task":"Plan a journey","action":"route_plan","arguments":{"query":"Museum to airport"}}', '{"task":"Plan a journey","action":"invented","arguments":{}}', '{"answer":"Done","task":"Plan a journey","action":"route_plan"}', '{"answer":']) {
  assert.throws(() => form.parse(bad), /Unknown|unavailable|did not finish/)
}
let formBody
const formed = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'http://localhost:11434', VIGO_AGENCY_LLM_PROTOCOL: 'ollama', VIGO_AGENCY_LLM_MODEL: 'local-model', VIGO_AGENCY_LLM_REASONING_EFFORT: 'on' }, async (_url, options) => {
  formBody = JSON.parse(options.body)
  return Response.json({ message: { content: JSON.stringify({ ...(formBody.format.anyOf[0].properties.task ? { task: 'Plan a journey' } : {}), action: 'route_plan', arguments: { origin: 'Museum', destination: 'Airport' } }) } })
})
const chosen = await formed.complete([{ role: 'user', content: 'Plan a journey' }], [route], undefined, { structuredTools: true })
assert.deepEqual(formBody.format, form.format, 'Ollama receives the complete schema as an enforced response format')
assert.equal(formBody.tools, undefined, 'One constrained action surface; do not mix native tool generation with the response form')
assert.equal(formBody.options.presence_penalty, 0, 'Repeated field names and choices must not be penalized as creative repetition')
assert.equal(formBody.options.temperature, 0, 'Structured choices default to deterministic sampling')
assert.deepEqual(JSON.parse(chosen.tool_calls[0].function.arguments), { origin: 'Museum', destination: 'Airport' })
assert.ok(chosen.tool_calls[0].id)
const continued = providerChoice([{ role: 'assistant', tool_calls: chosen.tool_calls }, { role: 'tool', tool_call_id: chosen.tool_calls[0].id, content: 'Source [1]\n{}' }], [route])
assert.equal(continued.format.anyOf[0].properties.task, undefined, 'Intermediate steps do not generate another task restatement')
assert.equal(continued.parse('{"action":"route_plan","arguments":{"origin":"Museum","destination":"Airport"}}').tool_calls.length, 1)
assert.match(continued.messages[1].content, /"action":"route_plan"/)
assert.match(continued.messages[2].content, /Result of route_plan/)
assert.equal(form.format.anyOf[0].properties.arguments.properties.origin.anyOf[0].maxLength, undefined, 'Decoder repetition limits must not disable argument-shape constraints')
assert.throws(() => form.parse(JSON.stringify({ task: 'Plan a journey', action: 'route_plan', arguments: { origin: 'x'.repeat(201), destination: 'Airport' } })), /too long/, 'String limits remain enforced before tool execution')
const updated = providerChoice([{ role: 'user', content: 'Which destination?' }], [{ ...route, parameters: { type: 'object', properties: { destination: { type: 'string', enum: ['1', '2'] } }, required: ['destination'], additionalProperties: false } }], [route])
assert.equal(updated.messages[0].content, form.messages[0].content, 'The policy and original forms stay a reusable prompt prefix')
assert.match(updated.messages.at(-1).content, /Updated action forms/)
assert.equal(updated.parse('{"task":"Plan a journey","action":"route_plan","arguments":{"destination":"2"}}').tool_calls.length, 1)
assert.throws(() => updated.parse('{"task":"Plan a journey","action":"route_plan","arguments":{"destination":"3"}}'), /Invalid/)
const selectionOnly = providerChoice([], [route], [route], true)
assert.equal(selectionOnly.format.anyOf.length, 1)
assert.throws(() => selectionOnly.parse('{"action":"answer","text":"Please choose all the locations yourself."}'), /unavailable/, 'The coordinate-selection stage cannot turn into a generic essay')
console.log('Agency provider forms: enforced schemas, shared tool parameters, invalid argument rejection and evidence follow-ups passed.')

const requiredForm = providerChoice([], [route], [route], false, route.name)
assert.equal(requiredForm.format.anyOf.length, 1)
assert.throws(() => requiredForm.parse(JSON.stringify({action: 'answer', text: 'Skipped the required form'})), /unavailable/)
assert.throws(() => providerChoice([], [route], [route], false, 'missing'), /unavailable/)
await formed.complete([], [route], undefined, {toolChoice: {type: 'function', function: {name: route.name}}})
assert.equal(formBody.format.anyOf.length, 1, 'Native required-tool requests must also constrain Ollama output')
assert.equal(formBody.think, true, 'A required tool by itself must not disable requested investigation reasoning')
await formed.complete([], [route], undefined, { structuredTools: true, selectionOnly: true })
assert.equal(formBody.think, false, 'Bounded coordinate choices cannot consume the investigation reasoning budget')
assert.equal(formBody.options.num_predict, 256)
assert.equal(formBody.options.num_ctx, 8192, 'Selection should reuse the loaded model context instead of reloading it')
assert.equal(formed.status().reasoningEffort, 'on', 'A short location choice does not change the connection settings')
await formed.complete([], [route], undefined, { structuredTools: true })
assert.equal(formBody.think, true)
assert.equal(formBody.options.num_predict, 1800, 'Full questions retain their response budget after a location choice')
