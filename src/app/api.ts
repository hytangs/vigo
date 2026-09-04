import type { RoutingExecutionStatus } from '../routingModel'

export type ApiRoutingStatus = RoutingExecutionStatus

export class ApiRequestError extends Error {
  readonly statusCode: number
  readonly routingStatus?: ApiRoutingStatus
  readonly code?: string
  readonly retryable?: boolean
  readonly remediation?: string

  constructor(message: string, response: Response, payload?: {
    status?: ApiRoutingStatus
    code?: string
    retryable?: boolean
    remediation?: string
  }) {
    super(message)
    this.name = 'ApiRequestError'
    this.statusCode = response.status
    this.routingStatus = payload?.status
    this.code = payload?.code
    this.retryable = payload?.retryable
    this.remediation = payload?.remediation
  }
}

async function throwApiError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as {
    error?: string
    status?: ApiRoutingStatus
    routing?: { status?: ApiRoutingStatus; code?: string; retryable?: boolean; remediation?: string }
  } | null
  const routing = body?.routing
  throw new ApiRequestError(
    body?.error ?? `Request failed with ${response.status}`,
    response,
    {
      status: routing?.status ?? body?.status,
      code: routing?.code,
      retryable: routing?.retryable,
      remediation: routing?.remediation,
    },
  )
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  if (!response.ok) await throwApiError(response)

  return response.json() as Promise<T>
}

export type ApiProgress = {
  phase: string
  progress: number
  detail: string
}

export async function apiProgressJson<T>(
  path: string,
  init: RequestInit,
  onProgress: (progress: ApiProgress) => void,
  onPreliminary?: (event: T) => void,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      ...init.headers,
    },
  })
  if (!response.ok) await throwApiError(response)
  if (!response.body) throw new Error('The analysis progress stream is unavailable.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineParts: string[] = []
  let result: T | undefined
  const consume = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as {
      type?: string
      progress?: ApiProgress
      error?: string
    } & T
    if (event.type === 'progress' && event.progress) {
      onProgress(event.progress)
      return
    }
    if (event.type === 'error') throw new Error(event.error || 'Analysis failed.')
    if (event.type === 'preliminary') {
      onPreliminary?.(event)
      return
    }
    if (event.type === 'complete') result = event
  }

  const consumeChunk = (chunk: string) => {
    let start = 0
    let newline = chunk.indexOf('\n', start)
    while (newline >= 0) {
      lineParts.push(chunk.slice(start, newline))
      consume(lineParts.join(''))
      lineParts = []
      start = newline + 1
      newline = chunk.indexOf('\n', start)
    }
    if (start < chunk.length) lineParts.push(chunk.slice(start))
  }

  while (true) {
    const next = await reader.read()
    consumeChunk(decoder.decode(next.value, { stream: !next.done }))
    if (next.done) break
  }
  consume(lineParts.join(''))
  if (!result) throw new Error('The analysis stream ended before returning a surface.')
  return result
}
