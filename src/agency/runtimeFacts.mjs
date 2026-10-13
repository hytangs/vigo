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
