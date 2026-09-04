function normalizedHostname(value) {
  const hostname = String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isLoopbackHostname(value) {
  const hostname = normalizedHostname(value)
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

export function isLoopbackRemoteAddress(value) {
  const address = normalizedHostname(value)
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

export function assertLocalBindHost({ host, transport, unsafeNonLoopback = false }) {
  if (transport !== 'tcp' || isLoopbackHostname(host) || unsafeNonLoopback) return
  throw new Error(
    `Refusing non-loopback VIGO_HOST "${host}". The local API has no remote-service authentication. `
    + 'Set VIGO_UNSAFE_ALLOW_NON_LOOPBACK=1 only for an isolated host where remote socket access remains blocked.',
  )
}

function requestHostUrl(request) {
  const hostHeader = String(request.headers.host ?? '').trim()
  if (!hostHeader) return null
  try {
    const parsed = new URL(`http://${hostHeader}`)
    return parsed.host.toLowerCase() === hostHeader.toLowerCase() ? parsed : null
  } catch {
    return null
  }
}

export function localRequestAccess(request, { staticRoot = '' } = {}) {
  if (!isLoopbackRemoteAddress(request.socket?.remoteAddress)) {
    return { allowed: false, error: 'VIGO only accepts connections from the local machine.' }
  }

  const requestHost = requestHostUrl(request)
  if (!requestHost || !isLoopbackHostname(requestHost.hostname)) {
    return { allowed: false, error: 'VIGO only accepts requests addressed to the local runtime.' }
  }

  const originValue = String(request.headers.origin ?? '').trim()
  if (!originValue) return { allowed: true, origin: '' }

  try {
    const origin = new URL(originValue)
    const originOnly = origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password
    const viteDevOrigin = !staticRoot
      && ['127.0.0.1', 'localhost'].includes(normalizedHostname(origin.hostname))
      && origin.port === '5178'
    const sameLocalOrigin = origin.origin === requestHost.origin
    if (
      !originOnly
      || origin.protocol !== 'http:'
      || !isLoopbackHostname(origin.hostname)
      || (!sameLocalOrigin && !viteDevOrigin)
    ) {
      return { allowed: false, error: 'VIGO only accepts browser requests from the same local origin.' }
    }
    return { allowed: true, origin: origin.origin }
  } catch {
    return { allowed: false, error: 'VIGO only accepts browser requests from the same local origin.' }
  }
}

export function applyLocalCors(response, origin) {
  if (!origin) return
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
}
