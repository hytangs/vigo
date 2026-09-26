import assert from 'node:assert/strict'
import http from 'node:http'
import { createProvider } from '../src/agency/provider.mjs'

const provider = createProvider({})
assert.equal(provider.available, false)
assert.throws(() => createProvider({ VIGO_AGENCY_LLM_PROTOCOL: 'invented' }), /protocol/)
for (const value of ['NaN', '0', '300001']) assert.throws(() => createProvider({ VIGO_AGENCY_LLM_TIMEOUT_MS: value }), /timeout/)
assert.equal(createProvider({ VIGO_AGENCY_LLM_PROTOCOL: 'ollama' }).status().reasoningEffort, 'none')
for (const baseUrl of ['file:///etc/passwd', 'https://user:pass@models.example', 'http://models.example/v1', 'https://models.example/v1?key=secret']) {
  await assert.rejects(provider.models({ baseUrl }))
}
// An actual unresponsive TCP/HTTP endpoint exercises the production timeout
// and cancellation paths without supplying an invented model answer.
const server = http.createServer(() => {})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const connection = createProvider({ VIGO_AGENCY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}`, VIGO_AGENCY_LLM_MODEL: 'unavailable', VIGO_AGENCY_LLM_TIMEOUT_MS: '1000' })
  await assert.rejects(connection.complete([{ role: 'user', content: 'Check transport deadline' }], []), /timeout|timed out|deadline|did not finish/i)
  const controller = new AbortController()
  const pending = connection.complete([], [], controller.signal)
  controller.abort()
  await assert.rejects(pending)
  connection.disconnect()
  assert.equal(connection.available, false)
  assert.equal(connection.status().hasKey, false)
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
console.log('Provider configuration, unsafe URL rejection, real transport timeout, abort and disconnect passed; model behavior requires a configured-provider evaluation.')
