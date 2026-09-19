import assert from 'node:assert/strict'
import { createProvider } from '../src/agency/provider.mjs'
import { createWebResearch } from '../src/agency/webResearch.mjs'

function harness(kind) {
  const requests = []
  const fetcher = () => { const response = Promise.withResolvers(); requests.push(response); return response.promise }
  if (kind === 'model') {
    const provider = createProvider({}, fetcher)
    return { requests, connect: (name, signal) => provider.connect({ baseUrl: `https://${name}.example/v1`, model: name }, signal),
      disconnect: () => provider.disconnect(), selected: () => provider.model,
      response: () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'connection_check', arguments: '{"ready":true}' } }] } }] }) }
  }
  const web = createWebResearch({ env: { VIGO_AGENCY_WEB_SEARCH_PROVIDER: 'off' }, fetchImpl: fetcher })
  return { requests, connect: (name, signal) => web.connect({ provider: 'searxng', baseUrl: `https://${name}.example/search` }, signal),
    disconnect: () => web.connect({ provider: 'off' }), selected: () => web.status().searchAvailable ? new URL(web.status().baseUrl).hostname.split('.')[0] : null,
    response: () => Response.json({ results: [] }) }
}

for (const kind of ['model', 'search']) {
  for (const scenario of ['newer', 'disconnect', 'abort', 'newer-fails']) {
    const h = harness(kind), controller = new AbortController()
    const older = h.connect('older', controller.signal)
    const rejected = assert.rejects(older, /superseded|abort/i)
    if (scenario === 'newer' || scenario === 'newer-fails') {
      const newer = h.connect('newer')
      h.requests[1].resolve(scenario === 'newer' ? h.response() : new Response('', { status: 401 }))
      if (scenario === 'newer') await newer
      else await assert.rejects(newer, /401/)
    } else if (scenario === 'disconnect') await h.disconnect()
    else controller.abort()
    // Simulate a slow response even if the transport ignores cancellation.
    h.requests[0].resolve(h.response())
    await rejected
    assert.equal(h.selected(), scenario === 'newer' ? 'newer' : null, `${kind}: ${scenario} must prevent an older test from applying settings`)
  }
}
console.log('Agency connections: newer settings, disconnect, cancellation and failed replacements supersede old tests.')
