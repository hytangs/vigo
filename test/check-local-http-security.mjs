import assert from 'node:assert/strict'
import {
  assertLocalBindHost,
  isLoopbackRemoteAddress,
  localRequestAccess,
} from '../src/server/local-http-security.mjs'

assert.doesNotThrow(() => assertLocalBindHost({ host: '127.0.0.1', transport: 'tcp' }))
assert.doesNotThrow(() => assertLocalBindHost({ host: '::1', transport: 'tcp' }))
assert.doesNotThrow(() => assertLocalBindHost({ host: '0.0.0.0', transport: 'memory' }))
assert.throws(
  () => assertLocalBindHost({ host: '0.0.0.0', transport: 'tcp' }),
  /Refusing non-loopback VIGO_HOST/,
)
assert.doesNotThrow(() => assertLocalBindHost({
  host: '0.0.0.0',
  transport: 'tcp',
  unsafeNonLoopback: true,
}))

assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true)
assert.equal(isLoopbackRemoteAddress('::1'), true)
assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true)
assert.equal(isLoopbackRemoteAddress('192.0.2.20'), false)

function request({ host = '127.0.0.1:5179', origin, remoteAddress = '127.0.0.1' } = {}) {
  return {
    headers: { host, ...(origin ? { origin } : {}) },
    socket: { remoteAddress },
  }
}

assert.equal(localRequestAccess(request()).allowed, true)
assert.equal(localRequestAccess(request({ remoteAddress: '192.0.2.20' })).allowed, false)
assert.equal(localRequestAccess(request({ host: 'example.com:5179' })).allowed, false)
assert.equal(localRequestAccess(request({ origin: 'http://127.0.0.1:5179' })).allowed, true)
assert.equal(localRequestAccess(request({ origin: 'https://example.com' })).allowed, false)
assert.equal(
  localRequestAccess(request({ origin: 'http://localhost:5178' }), { staticRoot: '' }).allowed,
  true,
)
assert.equal(
  localRequestAccess(request({ origin: 'http://localhost:5178' }), { staticRoot: '/app' }).allowed,
  false,
)

console.log('Local HTTP binding, remote-address, Host, and Origin security checks passed.')
