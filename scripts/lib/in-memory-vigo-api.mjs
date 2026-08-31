import { fork } from 'node:child_process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

function roundMilliseconds(value) {
  return Number(Number(value).toFixed(3))
}

export function parseJsonResponseBody(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return { parseError: true, text: text.slice(0, 2_000) }
  }
}

export function failedJsonResponse(error, startedAt) {
  return {
    ok: false,
    status: 0,
    latencyMs: roundMilliseconds(performance.now() - startedAt),
    bytes: 0,
    text: '',
    bodyBuffer: Buffer.alloc(0),
    error: error instanceof Error ? error.message : String(error),
    body: null,
  }
}

function logTail(value, maximum = 8_000) {
  const text = String(value || '')
  return text.length <= maximum ? text : text.slice(-maximum)
}

export async function startInMemoryVigoApi({
  repositoryRoot,
  executable = process.execPath,
  serverPath = path.join(repositoryRoot, 'server', 'vigo-api.mjs'),
  workingDirectory = repositoryRoot,
  inheritEnvironment = true,
  environment = {},
  requestTimeoutMs = 45_000,
  startupTimeoutMs = 10_000,
  stopTimeoutMs = 1_500,
}) {
  const startedAt = performance.now()
  const child = fork(serverPath, [], {
    cwd: workingDirectory,
    execPath: executable,
    env: {
      ...(inheritEnvironment ? process.env : {}),
      ...environment,
      VIGO_API_TRANSPORT: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let log = ''
  let readyResolved = false
  let sequence = 0
  const pending = new Map()
  const appendLog = (chunk) => { log += chunk.toString() }
  child.stdout.on('data', appendLog)
  child.stderr.on('data', appendLog)

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`VIGO in-memory API did not start within ${startupTimeoutMs} ms.\n${logTail(log)}`))
    }, startupTimeoutMs)
    child.on('message', (message) => {
      if (message?.type === 'vigo-api-ready' && !readyResolved) {
        readyResolved = true
        clearTimeout(timeout)
        resolve()
        return
      }
      if (message?.type !== 'vigo-api-response') return
      const id = String(message.id ?? '')
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(entry.timeout)
      entry.signal?.removeEventListener('abort', entry.abort)
      const responseBuffer = typeof message.bodyBase64 === 'string'
        ? Buffer.from(message.bodyBase64, 'base64')
        : Buffer.from(String(message.body ?? ''))
      const responseText = responseBuffer.toString('utf8')
      entry.resolve({
        ok: Number(message.status) >= 200 && Number(message.status) < 300,
        status: Number(message.status || 0),
        headers: message.headers ?? {},
        latencyMs: roundMilliseconds(performance.now() - entry.startedAt),
        bytes: responseBuffer.byteLength,
        text: responseText,
        bodyBuffer: responseBuffer,
        body: parseJsonResponseBody(responseText),
        ...(message.error ? { error: String(message.error) } : {}),
      })
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      const error = new Error(
        `VIGO in-memory API exited (code=${code}, signal=${signal}).\n${logTail(log)}`,
      )
      if (!readyResolved) reject(error)
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout)
        entry.signal?.removeEventListener('abort', entry.abort)
        entry.resolve(failedJsonResponse(error, entry.startedAt))
      }
      pending.clear()
    })
  })

  try {
    await ready
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    throw error
  }

  const requestJson = (apiPath, options = {}, timeoutMs = requestTimeoutMs) => {
    const id = `${process.pid}-${++sequence}`
    const requestStartedAt = performance.now()
    const signal = options.signal
    if (signal?.aborted) {
      return Promise.resolve(failedJsonResponse(
        signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'),
        requestStartedAt,
      ))
    }
    return new Promise((resolve) => {
      const settleFailure = (error) => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        clearTimeout(entry.timeout)
        entry.signal?.removeEventListener('abort', entry.abort)
        resolve(failedJsonResponse(error, requestStartedAt))
      }
      const timeout = setTimeout(() => {
        if (child.connected) child.send({ type: 'vigo-api-cancel', id })
        settleFailure(new Error(`Request exceeded ${timeoutMs} ms.`))
      }, timeoutMs)
      const abort = () => {
        if (child.connected) child.send({ type: 'vigo-api-cancel', id })
        settleFailure(
          signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'),
        )
      }
      pending.set(id, {
        resolve,
        startedAt: requestStartedAt,
        timeout,
        signal,
        abort,
      })
      signal?.addEventListener('abort', abort, { once: true })
      const binaryBody = Buffer.isBuffer(options.body)
        ? options.body
        : options.body instanceof Uint8Array
          ? Buffer.from(options.body)
          : null
      child.send({
        type: 'vigo-api-request',
        id,
        path: apiPath,
        method: options.method || 'GET',
        headers: options.headers || {},
        ...(binaryBody
          ? { bodyBase64: binaryBody.toString('base64') }
          : { body: options.body }),
      }, (error) => {
        if (error) settleFailure(error)
      })
    })
  }

  const fetchResponse = async (input, options = {}) => {
    const baseUrl = 'http://127.0.0.1/'
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url ?? String(input), baseUrl)
    const signal = options.signal ?? request?.signal
    let body = options.body
    if (body === undefined && request && !['GET', 'HEAD'].includes(request.method)) {
      body = Buffer.from(await request.arrayBuffer())
    }
    const headers = Object.fromEntries(
      new Headers(options.headers ?? request?.headers ?? {}).entries(),
    )
    const response = await requestJson(
      `${url.pathname}${url.search}`,
      {
        method: options.method ?? request?.method ?? 'GET',
        headers,
        body,
        signal,
      },
      options.timeoutMs ?? requestTimeoutMs,
    )
    if (response.status === 0) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError')
      }
      throw new Error(response.error || 'In-memory HTTP request failed.')
    }
    const responseHeaders = Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(', ') : String(value),
      ]),
    )
    const responseBody = [204, 205, 304].includes(response.status)
      ? null
      : response.bodyBuffer
    return new Response(responseBody, {
      status: response.status,
      headers: responseHeaders,
    })
  }

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, stopTimeoutMs)),
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  return {
    transport: 'memory-http',
    baseUrl: 'http://127.0.0.1/',
    fetch: fetchResponse,
    requestJson,
    startupMs: roundMilliseconds(performance.now() - startedAt),
    log: () => log,
    stop,
  }
}
