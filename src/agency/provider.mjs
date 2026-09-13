export function createProvider(environment = process.env, fetcher = globalThis.fetch) {
  const baseUrl = String(environment.VIGO_AGENCY_LLM_BASE_URL ?? '').replace(/\/$/, '')
  const model = String(environment.VIGO_AGENCY_LLM_MODEL ?? '')
  const key = String(environment.VIGO_AGENCY_LLM_API_KEY ?? '')
  const available = Boolean(baseUrl && model)
  return {
    available, model: available ? model : null,
    async complete(messages, tools, signal) {
      if (!available) throw new Error('No AI provider is configured.')
      const url = new URL(`${baseUrl}/chat/completions`)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The AI provider requires an HTTP or HTTPS base URL.')
      const timeout = AbortSignal.timeout(45_000)
      const response = await fetcher(url, {
        method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages, ...(tools?.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}), max_completion_tokens: 1800 }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`AI provider returned HTTP ${response.status}.`) }
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2_000_000) { await reader.cancel(); throw new Error('AI provider response is too large.') }
        chunks.push(value)
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const message = result.choices?.[0]?.message
      if (!message || typeof message !== 'object') throw new Error('AI provider returned no response message.')
      return message
    },
  }
}
