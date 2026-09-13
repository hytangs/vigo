function normalizeBaseUrl(value) {
  let url
  try { url = new URL(String(value).trim()) } catch { throw new Error('Enter an API base URL, such as https://api.openai.com/v1.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS base URL without credentials, a query, or a fragment.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) throw new Error('Remote providers require HTTPS. Local providers can use HTTP.')
  return url.toString().replace(/\/$/, '').replace(/\/chat\/completions$/, '')
}

async function readResponse(response) {
  if (!response.ok) {
    await response.body?.cancel()
    const detail = response.status === 401 || response.status === 403 ? 'Check the API key and model permissions.' : response.status === 404 ? 'Check the API base URL and model name.' : response.status === 429 ? 'The provider is rate limited or its usage balance is exhausted.' : 'Check the provider status and try again.'
    throw new Error(`AI provider returned HTTP ${response.status}. ${detail}`)
  }
  if (!response.body) throw new Error('AI provider returned an empty response.')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 2_000_000) { await reader.cancel(); throw new Error('AI provider response is too large.') }
    chunks.push(value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('The provider did not return valid JSON. Check the API base URL.') }
}

function temperature(value) {
  if (value == null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 2) throw new Error('Temperature must be between 0 and 2.')
  return number
}

function contextSize(value) {
  const size = Number(value ?? 8192)
  if (!Number.isInteger(size) || size < 2048 || size > 131072) throw new Error('Local context must be between 2048 and 131072 tokens.')
  return size
}

function reasoning(value, protocol) {
  const effort = String(value ?? '')
  if (!['', 'none', 'low', 'medium', 'high', ...(protocol === 'ollama' ? ['on'] : [])].includes(effort)) throw new Error('Unsupported reasoning effort.')
  return effort
}

export function createProvider(environment = process.env, fetcher = globalThis.fetch) {
  let config = { baseUrl: String(environment.VIGO_AGENCY_LLM_BASE_URL ?? '').replace(/\/$/, ''), model: String(environment.VIGO_AGENCY_LLM_MODEL ?? ''), key: String(environment.VIGO_AGENCY_LLM_API_KEY ?? ''), reasoningEffort: String(environment.VIGO_AGENCY_LLM_REASONING_EFFORT ?? ''), temperature: temperature(environment.VIGO_AGENCY_LLM_TEMPERATURE) }
  config.protocol = environment.VIGO_AGENCY_LLM_PROTOCOL || 'openai'
  if (!['openai', 'ollama'].includes(config.protocol)) throw new Error('Choose openai or ollama as the model protocol.')
  config.reasoningEffort = reasoning(config.reasoningEffort, config.protocol)
  config.contextTokens = contextSize(environment.VIGO_AGENCY_LLM_CONTEXT_TOKENS)
  const timeoutMs = Number(environment.VIGO_AGENCY_LLM_TIMEOUT_MS ?? 45_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new Error('Provider timeout must be between 1,000 and 300,000 milliseconds.')
  let source = 'environment', testedAt = null, revision = 0, callSequence = 0
  function candidate(input) {
    if (!input || typeof input !== 'object') throw new Error('Enter the provider connection details.')
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const model = String(input.model ?? '').trim()
    const protocol = input.protocol ?? (baseUrl === config.baseUrl ? config.protocol : 'openai')
    if (!['openai', 'ollama'].includes(protocol)) throw new Error('Choose an OpenAI-compatible or Ollama connection.')
    if (model.length > 200 || String(input.apiKey ?? '').length > 2000) throw new Error('The model name or key is too long.')
    // A blank key retains the active key only for the same endpoint. It never crosses providers.
    return { baseUrl, model, protocol, contextTokens: contextSize(input.contextTokens ?? config.contextTokens), reasoningEffort: reasoning(input.reasoningEffort, protocol), temperature: temperature(input.temperature ?? (baseUrl === config.baseUrl ? config.temperature : undefined)), key: String(input.apiKey ?? '').trim() || (baseUrl === config.baseUrl ? config.key : '') }
  }
  async function request(connection, suffix, body, signal) {
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      const response = await fetcher(`${normalizeBaseUrl(connection.baseUrl)}${suffix}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(connection.key ? { authorization: `Bearer ${connection.key}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return await readResponse(response)
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) throw new Error(`The provider did not respond within ${timeoutMs / 1000} seconds.`)
      if (error instanceof TypeError) throw new Error('Could not reach the provider. Check the URL and whether the local model server is running.')
      throw error
    }
  }
  async function completeWith(connection, messages, tools, signal, options = {}) {
    if (!connection.baseUrl || !connection.model) throw new Error('Connect an AI provider in Ask to use natural-language queries.')
    if (connection.protocol === 'ollama') {
      const names = new Map(messages.flatMap(message => (message.tool_calls ?? []).map(call => [call.id, call.function.name])))
      const nativeMessages = messages.map(message => ({ role: message.role, content: message.content ?? '',
        ...(message.role === 'tool' ? { tool_name: names.get(message.tool_call_id) } : {}),
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map(call => ({ function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } })) } : {}),
      }))
      const result = await request({ ...connection, baseUrl: normalizeBaseUrl(connection.baseUrl).replace(/\/(?:v1|api)$/, '') }, '/api/chat', {
        model: connection.model, messages: nativeMessages, stream: false,
        ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
        ...(connection.reasoningEffort ? { think: connection.reasoningEffort === 'none' ? false : connection.reasoningEffort === 'on' ? true : connection.reasoningEffort } : {}),
        options: { num_ctx: connection.contextTokens, num_predict: options.maxTokens || 1800, ...(connection.temperature !== undefined ? { temperature: connection.temperature } : {}) },
      }, signal)
      if (!result.message) throw new Error('The local model returned no response message.')
      return { content: result.message.content, tool_calls: result.message.tool_calls?.map(call => ({ id: `ollama-${++callSequence}`, type: 'function', function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) } })),
        finishReason: result.done_reason, usage: { prompt_tokens: result.prompt_eval_count, completion_tokens: result.eval_count } }
    }
    const result = await request(connection, '/chat/completions', { model: connection.model, messages, ...(tools?.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: options.toolChoice || 'auto' } : {}), max_completion_tokens: options.maxTokens || 1800, ...(connection.reasoningEffort ? { reasoning_effort: connection.reasoningEffort } : {}), ...(connection.temperature !== undefined ? { temperature: connection.temperature } : {}) }, signal)
    const message = result.choices?.[0]?.message
    if (!message || typeof message !== 'object') throw new Error('AI provider returned no response message.')
    return { ...message, finishReason: result.choices[0].finish_reason, usage: result.usage }
  }
  return {
    get available() { return Boolean(config.baseUrl && config.model) },
    get model() { return this.available ? config.model : null },
    status() { return { available: this.available, model: this.model, baseUrl: config.baseUrl, protocol: config.protocol, contextTokens: config.protocol === 'ollama' ? config.contextTokens : undefined, hasKey: Boolean(config.key), reasoningEffort: config.reasoningEffort || '', temperature: config.temperature, source, testedAt } },
    async models(input, signal) {
      const connection = candidate(input)
      if (connection.protocol === 'ollama') {
        const result = await request({ ...connection, baseUrl: connection.baseUrl.replace(/\/(?:v1|api)$/, '') }, '/api/tags', null, signal)
        return { models: [...new Set((result.models ?? []).map(item => item.name).filter(name => typeof name === 'string'))].sort().slice(0, 500) }
      }
      const result = await request(connection, '/models', null, signal)
      return { models: [...new Set((Array.isArray(result.data) ? result.data : []).map((item) => item.id).filter((id) => typeof id === 'string' && id.length <= 200))].sort().slice(0, 500) }
    },
    async connect(input, signal) {
      const next = candidate(input)
      if (!next.model) throw new Error('Choose or enter a model name.')
      const message = await completeWith(next, [{ role: 'user', content: 'Connection test only. Call connection_check with ready set to true. Do not call any other tool or answer in prose.' }], [{ name: 'connection_check', description: 'Confirm that function calling works.', parameters: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false } }], signal)
      const call = message.tool_calls?.find((item) => item.function?.name === 'connection_check')
      let args
      try { args = JSON.parse(call?.function?.arguments || '{}') } catch {}
      if (args?.ready !== true) throw new Error('The model responded, but did not call the test tool. Choose a model that supports function calling.')
      config = next; revision++; source = 'session'; testedAt = new Date().toISOString()
      return this.status()
    },
    disconnect() { config = { baseUrl: '', model: '', key: '' }; revision++; source = 'session'; testedAt = null; return this.status() },
    forRequest() {
      const connection = { ...config }, startedAtRevision = revision
      return { available: this.available, model: this.model, complete(messages, tools, signal, options) {
        if (revision !== startedAtRevision) throw new Error('The model connection changed. Ask again to use the new connection.')
        return completeWith(connection, messages, tools, signal, options)
      } }
    },
    complete(messages, tools, signal, options) { return completeWith({ ...config }, messages, tools, signal, options) },
  }
}
