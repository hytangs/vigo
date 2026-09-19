import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

function privateIpv4(address) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true
  }
  const [a, b, c] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && [18, 19].includes(b))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

function privateIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice('::ffff:'.length))
  if (/^::(?:ffff:)?[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(normalized)) {
    const words = normalized.split(':').slice(-2).map((word) => Number.parseInt(word, 16))
    return privateIpv4(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`)
  }
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || normalized.startsWith('2001:db8:')
}

export function isPrivateOrSpecialAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return privateIpv4(address)
  if (family === 6) return privateIpv6(address)
  return true
}

async function resolveSafeRealtimeTarget(
  sourceUrl,
  {
    lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
    allowPrivate = process.env.VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME === '1',
  } = {},
) {
  const parsedUrl = new URL(sourceUrl)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('GTFS-RT URL must use http or https.')
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('GTFS-RT URL must not contain embedded credentials.')
  }
  if (allowPrivate) return { parsedUrl, addresses: null }
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '')
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('GTFS-RT URL resolves to a private or special address.')
  }
  const literalFamily = net.isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname }]
    : await lookup(hostname)
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrSpecialAddress(address))) {
    throw new Error('GTFS-RT URL resolves to a private or special address.')
  }
  return { parsedUrl, addresses }
}

export async function assertSafeRealtimeUrl(sourceUrl, options) {
  return (await resolveSafeRealtimeTarget(sourceUrl, options)).parsedUrl
}

// DNS promises are not cancellable, but waiting for them must be. The same
// signal/deadline covers validation, every redirect, and the response body.
function abortable(promise, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

export async function fetchSafeRealtimeBody(sourceUrl, options = {}) {
  const { timeoutMs = 15_000 } = options
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive safe integer')
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  signal.throwIfAborted()
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(`GTFS-RT request timed out after ${Math.round(timeoutMs / 1_000)} seconds.`), { code: 'request_timeout' })), timeoutMs)
  try { return await fetchTarget(sourceUrl, { ...options, signal }) }
  finally { clearTimeout(timer) }
}

async function fetchTarget(
  sourceUrl,
  {
    maximumBytes,
    headers = {},
    lookup,
    allowPrivate,
    signal,
    maximumRedirects = 0,
  } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError('maximumBytes must be a positive safe integer')
  }
  if (!Number.isInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 5) throw new TypeError('maximumRedirects must be an integer from 0 to 5')
  let target
  try {
    target = await abortable(resolveSafeRealtimeTarget(sourceUrl, { lookup, allowPrivate }), signal)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    error.code = 'unsafe_url'
    throw error
  }
  const { parsedUrl, addresses } = target
  const selected = addresses?.[0]
  const pinnedLookup = selected
    ? (_hostname, options, callback) => {
        const family = selected.family || net.isIP(selected.address)
        // Node's automatic IPv4/IPv6 selection requests the array form of lookup.
        // Keep every already-validated address available for connection fallback.
        if (options.all) callback(null, addresses.map(item => ({ address: item.address, family: item.family || net.isIP(item.address) })))
        else callback(null, selected.address, family)
      }
    : undefined
  const transport = parsedUrl.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const request = transport.request(parsedUrl, { headers, lookup: pinnedLookup, signal }, (response) => {
      response.on('error', reject)
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && maximumRedirects > 0) {
        response.destroy()
        // Every hop is resolved and pinned again. Realtime callers continue to
        // reject redirects unless they explicitly opt in.
        let redirectUrl
        try { redirectUrl = new URL(response.headers.location, parsedUrl).href } catch { reject(new Error('Invalid redirect URL.')); return }
        fetchTarget(redirectUrl, { maximumBytes, headers, lookup, allowPrivate, signal, maximumRedirects: maximumRedirects - 1 }).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        const error = new Error(`GTFS-RT request returned ${status} ${response.statusMessage ?? ''}.`.trim())
        error.code = 'response_status'
        reject(error)
        return
      }
      const declaredLength = Number(response.headers['content-length'] ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        const error = new Error('GTFS-RT response is too large for interactive inspection.')
        error.code = 'response_too_large'
        response.destroy(error)
        return
      }
      const chunks = []
      let totalBytes = 0
      response.on('data', (chunk) => {
        totalBytes += chunk.byteLength
        if (totalBytes > maximumBytes) {
          const error = new Error('GTFS-RT response is too large for interactive inspection.')
          error.code = 'response_too_large'
          response.destroy(error)
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({
        body: new Uint8Array(Buffer.concat(chunks, totalBytes)),
        contentType: response.headers['content-type'],
        url: parsedUrl.href,
      }))
    })
    request.on('error', error => reject(signal.aborted ? signal.reason : error))
    request.end()
  })
}
