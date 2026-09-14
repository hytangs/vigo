// Configuration facts, not a privacy attestation. Never derive hosting or
// retention policy from a model name, response, or loopback connection.
export function endpointFacts(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported endpoint')
    return Object.freeze({ endpoint: url.host, transport: url.protocol.slice(0, -1),
      endpointLocation: (['localhost', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)) ? 'loopback' : 'other' })
  } catch { return Object.freeze({ endpoint: null, transport: null, endpointLocation: 'unknown' }) }
}

export function modelRuntimeFacts({ baseUrl, model, protocol }) {
  const endpoint = endpointFacts(baseUrl)
  return Object.freeze({ model: model || null, protocol: protocol || null, ...endpoint,
    inferenceLocation: 'unverified',
    externalModelApi: endpoint.endpoint ? 'unverified' : 'unknown' })
}

export const runtimeTool = { name: 'runtime_status', description: 'Show the server-recorded model, endpoint, network tools and privacy limits directly as the final answer. Use for questions about this model, deployment or privacy; the server renders the facts without speculative paraphrasing.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }

export function explainRuntime(runtime) {
  const connection = runtime.modelConnection
  return `**Model:** ${connection.model || 'Not recorded'}\n**Inference:** Not verified\n**Endpoint:** ${connection.endpoint || 'Not recorded'}${connection.transport ? ` (${connection.transport.toUpperCase()})` : ''}\n**External model API:** Not verified; the configured endpoint may forward requests\n**Network-enabled tools:** ${runtime.networkTools.map(tool => tool.label).join(', ') || 'None enabled for this answer'}\n\nVIGO sends the question, supplied conversation context and tool results to the configured model endpoint. These settings do not verify where inference runs, downstream forwarding, retention, training use or security. Background feed refresh and other application traffic are outside this answer record.`
}

export function queryRuntimeFacts({ provider, webStatus, placesAvailable, placeEndpoint, placeDetailsEndpoint, generatedAt }) {
  const networkTools = []
  if (webStatus.searchAvailable) networkTools.push({ tool: webStatus.provider === 'wikipedia' ? 'reference_lookup' : 'web_search',
    label: webStatus.provider === 'wikipedia' ? 'Public references' : 'Web search', endpoint: webStatus.endpoint ?? null })
  if (webStatus.readAvailable) networkTools.push({ tool: 'web_read', label: 'Public page reading', endpoint: 'Requested public website' })
  if (placesAvailable) networkTools.push({ tool: 'place_search', label: 'Place search', endpoint: placeEndpoint ?? null })
  if (placesAvailable && placeDetailsEndpoint) networkTools.push({ tool: 'find_walk', label: 'Map place details', endpoint: placeDetailsEndpoint })
  return { capturedAt: generatedAt, modelConnection: provider.runtime ?? modelRuntimeFacts({ model: provider.model }), networkTools,
    limits: 'Endpoint configuration does not verify inference hosting, downstream forwarding, retention, training use, or security. Tools listed here can access a network; calls are not a traffic audit. Journey tools may use place search. Feed refresh and other application traffic are outside this answer record.' }
}

export function withRuntimeActivity(runtime, trace) {
  const names = new Set(runtime.networkTools.map(item => item.tool))
  // Journey tools share the place resolver; record indirect use as a capability,
  // without pretending a cache hit or failed validation made an HTTP request.
  if (names.has('place_search')) for (const name of ['route_plan', 'walk_route', 'walk_compare', 'find_walk', 'reach']) names.add(name)
  return { ...runtime, networkToolCalls: trace.filter(call => names.has(call.tool)).map(call => ({ tool: call.tool, completed: call.result.ok })) }
}
