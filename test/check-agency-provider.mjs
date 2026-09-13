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
await activeRequest.complete([{ role: 'user', content: 'A private investigation' }], [])
assert.equal(requests.at(-1).url, 'https://models.example/v1/chat/completions')
await provider.connect({ baseUrl: 'https://different.example/v1', model: 'other-model' })
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
await assert.rejects(native.models({ baseUrl: 'http://localhost:11434', protocol: 'ollama', contextTokens: 10 }), /Local context/)
assert.throws(() => createProvider({ VIGO_AGENCY_LLM_PROTOCOL: 'invented' }), /protocol/)
console.log('Agency provider: model discovery, inference verification, private session keys, endpoint isolation, failure recovery, and disconnect passed.')

for (const value of ['NaN', '0', '300001']) assert.throws(() => createProvider({ VIGO_AGENCY_LLM_TIMEOUT_MS: value }), /timeout/)
const timed = createProvider({ VIGO_AGENCY_LLM_BASE_URL: 'http://localhost:11434', VIGO_AGENCY_LLM_MODEL: 'local-model', VIGO_AGENCY_LLM_TIMEOUT_MS: '1000' }, (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })))
// Keep the isolated fixture alive while the provider's unref'd deadline expires.
const keepAlive = setInterval(() => {}, 2000)
try { await assert.rejects(timed.complete([], []), /within 1 seconds/) } finally { clearInterval(keepAlive) }
