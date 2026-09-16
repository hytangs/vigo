import { modelRuntimeFacts } from './runtimeFacts.mjs'
import { readProviderResponse } from './providerResponse.mjs'
import { providerChoice } from './providerChoice.mjs'

function normalizeBaseUrl(value) {
  let url
  try { url = new URL(String(value).trim()) } catch { throw new Error('Enter an API base URL, such as https://api.openai.com/v1.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS base URL without credentials, a query, or a fragment.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) throw new Error('Remote providers require HTTPS. Local providers can use HTTP.')
  return url.toString().replace(/\/$/, '').replace(/\/chat\/completions$/, '')
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
  const effort = String(value ?? (protocol === 'ollama' ? 'none' : ''))
  if (!['', 'none', 'low', 'medium', 'high', ...(protocol === 'ollama' ? ['on'] : [])].includes(effort)) throw new Error('Unsupported reasoning effort.')
  return effort
}

function timeoutDetail(activity, protocol) {
  if (activity === 'thinking') return 'It was still reasoning. Try turning reasoning off in AI settings.'
  if (activity) return 'It started responding, but the response was incomplete.'
  return `No response activity was received.${protocol === 'ollama' ? ' Ollama may be loading the model or handling another request.' : ''}`
}

function modelStudioEndpoint(connection) {
  const host = new URL(normalizeBaseUrl(connection.baseUrl)).hostname
  return host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com' || host === 'dashscope-us.aliyuncs.com' || host.endsWith('.maas.aliyuncs.com')
}

function compatibleReasoning(connection, options) {
  // Model Studio uses enable_thinking, not OpenAI's reasoning_effort.
  // Its named tool choice requires non-thinking mode. This is an API dialect
  // adaptation for documented endpoints, not a claim about model hosting.
  if (modelStudioEndpoint(connection)) return connection.reasoningEffort === 'none' || options.toolChoice?.type === 'function'
    ? { enable_thinking: false } : connection.reasoningEffort ? { enable_thinking: true } : {}
  return connection.reasoningEffort ? { reasoning_effort: connection.reasoningEffort } : {}
}

export function createProvider(environment = process.env, fetcher = globalThis.fetch) {
  let config = { baseUrl: String(environment.VIGO_AGENCY_LLM_BASE_URL ?? '').replace(/\/$/, ''), model: String(environment.VIGO_AGENCY_LLM_MODEL ?? ''), key: String(environment.VIGO_AGENCY_LLM_API_KEY ?? ''), reasoningEffort: environment.VIGO_AGENCY_LLM_REASONING_EFFORT, temperature: temperature(environment.VIGO_AGENCY_LLM_TEMPERATURE) }
  config.protocol = environment.VIGO_AGENCY_LLM_PROTOCOL || 'openai'
  if (!['openai', 'ollama'].includes(config.protocol)) throw new Error('Choose openai or ollama as the model protocol.')
  config.reasoningEffort = reasoning(config.reasoningEffort, config.protocol)
  config.contextTokens = contextSize(environment.VIGO_AGENCY_LLM_CONTEXT_TOKENS)
  // Local prefill plus a constrained tool form can exceed the cloud request
  // budget on a busy laptop. Keep an explicit override and a bounded timeout;
  // streamed activity still reaches Ask while the local model is working.
  const configuredTimeoutMs = environment.VIGO_AGENCY_LLM_TIMEOUT_MS === undefined ? null : Number(environment.VIGO_AGENCY_LLM_TIMEOUT_MS)
  if (configuredTimeoutMs !== null && (!Number.isInteger(configuredTimeoutMs) || configuredTimeoutMs < 1000 || configuredTimeoutMs > 300_000)) throw new Error('Provider timeout must be between 1,000 and 300,000 milliseconds.')
  let source = 'environment', testedAt = null, revision = 0, callSequence = 0, connectionAttempt = 0
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
  async function request(connection, suffix, body, signal, onActivity) {
    const timeoutMs = configuredTimeoutMs ?? (connection.protocol === 'ollama' ? 90_000 : 45_000)
    const timeout = AbortSignal.timeout(timeoutMs)
    let activity
    try {
      const response = await fetcher(`${normalizeBaseUrl(connection.baseUrl)}${suffix}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(connection.key ? { authorization: `Bearer ${connection.key}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return await readProviderResponse(response, kind => { activity = kind; onActivity?.(kind) })
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) throw new Error(`The model did not finish within ${timeoutMs / 1000} seconds. ${timeoutDetail(activity, connection.protocol)}`)
      if (error instanceof TypeError) throw new Error('Could not reach the provider. Check the URL and whether the local model server is running.')
      throw error
    }
  }
  async function completeWith(connection, messages, tools, signal, options = {}) {
    if (options.networkReasoning && connection.protocol === 'openai' && modelStudioEndpoint(connection)) connection = { ...connection, reasoningEffort: 'low' }
    if (!connection.baseUrl || !connection.model) throw new Error('Connect an AI provider in Ask to use natural-language queries.')
    if (connection.protocol === 'ollama') {
      const requiredTool = options.toolChoice?.type === 'function' ? options.toolChoice.function?.name : null
      const choice = (options.structuredTools || requiredTool) && tools?.length ? providerChoice(messages, tools, options.initialTools, options.selectionOnly, requiredTool) : null
      // Choosing supplied location IDs needs a small form, not another full
      // investigation. Explicit reasoning settings still apply to other turns.
      const selecting = choice && options.selectionOnly
      const effort = selecting ? 'none' : connection.reasoningEffort
      const names = new Map(messages.flatMap(message => (message.tool_calls ?? []).map(call => [call.id, call.function.name])))
      const nativeMessages = messages.map(message => ({ role: message.role, content: message.content ?? '',
        ...(message.role === 'tool' ? { tool_name: names.get(message.tool_call_id) } : {}),
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map(call => ({ function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } })) } : {}),
      }))
      const result = await request({ ...connection, baseUrl: normalizeBaseUrl(connection.baseUrl).replace(/\/(?:v1|api)$/, '') }, '/api/chat', {
        model: connection.model, messages: choice?.messages ?? nativeMessages, stream: Boolean(options.onActivity),
        ...(choice ? { format: choice.format } : tools?.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
        ...(effort ? { think: effort === 'none' ? false : effort === 'on' ? true : effort } : {}),
        options: { num_ctx: connection.contextTokens, num_predict: selecting ? Math.min(options.maxTokens || 256, 256) : options.maxTokens || 1800, ...(choice ? { presence_penalty: 0 } : {}), ...(connection.temperature !== undefined ? { temperature: connection.temperature } : choice ? { temperature: 0 } : {}) },
      }, signal, kind => options.onActivity?.(choice && kind === 'content' ? 'decision' : kind))
      if (!result.message) throw new Error('The local model returned no response message.')
      const message = choice ? choice.parse(result.message.content) : { content: result.message.content, tool_calls: result.message.tool_calls?.map(call => ({ type: 'function', function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) } })) }
      return { ...message, tool_calls: message.tool_calls?.map(call => ({ ...call, id: `ollama-${++callSequence}` })),
        finishReason: result.done_reason, usage: { prompt_tokens: result.prompt_eval_count, completion_tokens: result.eval_count },
        metrics: { loadMs: result.load_duration / 1e6, promptMs: result.prompt_eval_duration / 1e6, generationMs: result.eval_duration / 1e6 } }
    }
    const requiredForm = options.structuredTools && options.toolChoice?.type === 'function' && modelStudioEndpoint(connection)
      ? tools?.find(tool => tool.name === options.toolChoice.function.name) : null
    // For a single mandatory form, JSON mode avoids this endpoint's observed
    // malformed nested tool-argument strings. It guarantees syntax only;
    // normal argument validation still decides whether the form is usable.
    const requestMessages = requiredForm ? [...messages, { role: 'system', content: `Return only one JSON object containing the arguments for ${requiredForm.name}. Follow this schema; arrays and objects must be real JSON values, never encoded strings. ${JSON.stringify(requiredForm.parameters)}` }] : messages
    const result = await request(connection, '/chat/completions', { model: connection.model, messages: requestMessages,
      ...(requiredForm ? { response_format: { type: 'json_object' } } : tools?.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: options.toolChoice || 'auto' } : { tool_choice: 'none' }),
      max_completion_tokens: options.maxTokens || 1800, ...compatibleReasoning(connection, options), ...(modelStudioEndpoint(connection) && options.thinkingBudget && !requiredForm ? { thinking_budget: options.thinkingBudget } : {}), ...(connection.temperature !== undefined ? { temperature: connection.temperature } : {}) }, signal)
    const message = result.choices?.[0]?.message
    if (!message || typeof message !== 'object') throw new Error('AI provider returned no response message.')
    if (requiredForm) {
      let argumentsValue
      try { argumentsValue = JSON.parse(message.content) } catch { throw new Error('The model did not finish the requested JSON form.') }
      return { content: '', tool_calls: [{ id: `form-${++callSequence}`, type: 'function', function: { name: requiredForm.name, arguments: JSON.stringify(argumentsValue) } }], finishReason: result.choices[0].finish_reason, usage: result.usage }
    }
    return { ...message, finishReason: result.choices[0].finish_reason, usage: result.usage }
  }
  return {
    get available() { return Boolean(config.baseUrl && config.model) },
    reviewUnverifiedReplies: true,
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
      signal?.throwIfAborted()
      const attempt = ++connectionAttempt
      // Connectivity needs a tiny tool result, not a reasoning run. Keep the
      // user's chosen settings for subsequent questions, including reasoning.
      const probe = next.protocol === 'ollama' ? { ...next, reasoningEffort: 'none', temperature: 0 } : next
      const message = await completeWith(probe, [{ role: 'user', content: 'Connection test only. Call connection_check with ready set to true. Do not call any other tool or answer in prose.' }], [{ name: 'connection_check', description: 'Confirm that function calling works.', parameters: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false } }], signal, { ...(next.protocol === 'ollama' ? { maxTokens: 128 } : {}), structuredTools: next.protocol === 'ollama', toolChoice: { type: 'function', function: { name: 'connection_check' } } })
      const call = message.tool_calls?.find((item) => item.function?.name === 'connection_check')
      let args
      try { args = JSON.parse(call?.function?.arguments || '{}') } catch {}
      if (args?.ready !== true) throw new Error('The model responded, but did not call the test tool. Choose a model that supports function calling.')
      signal?.throwIfAborted()
      if (attempt !== connectionAttempt) throw new Error('This connection test was superseded by newer AI settings.')
      config = next; revision++; source = 'session'; testedAt = new Date().toISOString()
      return this.status()
    },
    disconnect() { connectionAttempt++; config = { baseUrl: '', model: '', key: '' }; revision++; source = 'session'; testedAt = null; return this.status() },
    forRequest() {
      const connection = { ...config }, startedAtRevision = revision
      return { available: this.available, reviewUnverifiedReplies: true, model: this.model, runtime: modelRuntimeFacts(connection), complete(messages, tools, signal, options) {
        if (revision !== startedAtRevision) throw new Error('The model connection changed. Ask again to use the new connection.')
        return completeWith(connection, messages, tools, signal, options)
      } }
    },
    complete(messages, tools, signal, options) { return completeWith({ ...config }, messages, tools, signal, options) },
  }
}
