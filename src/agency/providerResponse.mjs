// Consume provider responses within one byte limit. Streaming activity carries
// only a phase; private reasoning and partial tool arguments never leave here.
export async function readProviderResponse(response, onActivity) {
  if (!response.ok) {
    await response.body?.cancel()
    const detail = response.status === 401 || response.status === 403 ? 'Check the API key and model permissions.' : response.status === 404 ? 'Check the API base URL and model name.' : response.status === 429 ? 'The provider is rate limited or its usage balance is exhausted.' : 'Check the provider status and try again.'
    throw new Error(`AI provider returned HTTP ${response.status}. ${detail}`)
  }
  if (!response.body) throw new Error('AI provider returned an empty response.')
  const streamed = response.headers.get('content-type')?.includes('ndjson')
  const reader = response.body.getReader(), decoder = new TextDecoder(), activity = new Set()
  let size = 0, pending = '', final, content = '', calls = []
  const parse = text => {
    try { return JSON.parse(text) } catch { throw new Error('The provider did not return valid JSON. Check the API base URL.') }
  }
  const consume = text => {
    if (!text.trim()) return
    if (final) throw new Error('The provider sent data after its completed response.')
    const chunk = parse(text)
    if (chunk.error) throw new Error('The local model could not complete this response. Check the model server.')
    const message = chunk.message
    const kind = message?.tool_calls?.length ? 'tool' : message?.content ? 'content' : message?.thinking ? 'thinking' : null
    if (kind && !activity.has(kind)) { activity.add(kind); onActivity?.(kind) }
    content += message?.content || ''
    calls.push(...(message?.tool_calls ?? []))
    if (chunk.done) final = chunk
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2_000_000) throw new Error('AI provider response is too large.')
      pending += decoder.decode(value, { stream: true })
      if (streamed) {
        let end
        while ((end = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, end)); pending = pending.slice(end + 1) }
      }
    }
    pending += decoder.decode()
    if (!streamed) return parse(pending)
    consume(pending)
    if (!final) throw new Error('The model connection ended before its response was complete. Please retry.')
    return { ...final, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
