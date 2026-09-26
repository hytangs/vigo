import assert from 'node:assert/strict'
import http from 'node:http'
import { assertSafeRealtimeUrl, fetchSafeRealtimeBody, isPrivateOrSpecialAddress } from '../src/server/realtime-url-security.mjs'

for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:7f00:1']) {
  assert(isPrivateOrSpecialAddress(address), address)
}
for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateOrSpecialAddress(address), false)
assert.equal((await assertSafeRealtimeUrl('https://8.8.8.8/feed.pb')).hostname, '8.8.8.8')
for (const url of ['http://127.0.0.1/feed.pb', 'http://[::1]/feed.pb', 'http://localhost/feed.pb', 'http://169.254.169.254/feed.pb']) {
  await assert.rejects(assertSafeRealtimeUrl(url), /private or special/)
}
await assert.rejects(assertSafeRealtimeUrl('file:///tmp/feed.pb'), /http or https/)
await assert.rejects(assertSafeRealtimeUrl('https://user:secret@8.8.8.8/feed.pb'), /embedded credentials/)
const server = http.createServer((request, response) => {
  if (request.url === '/wait') return
  if (request.url === '/redirect') { response.writeHead(302, { location: '/feed.pb' }); response.end(); return }
  response.writeHead(200, { 'content-type': 'application/x-protobuf' })
  response.end(Buffer.from([8, 1]))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
try {
  const result = await fetchSafeRealtimeBody(`${base}/feed.pb`, { allowPrivate: true, maximumBytes: 16 })
  assert.deepEqual([...result.body], [8, 1])
  await assert.rejects(fetchSafeRealtimeBody(`${base}/feed.pb`, { maximumBytes: 16 }), /private or special/)
  await assert.rejects(fetchSafeRealtimeBody(`${base}/feed.pb`, { allowPrivate: true, maximumBytes: 1 }), { code: 'response_too_large' })
  await assert.rejects(fetchSafeRealtimeBody(`${base}/redirect`, { allowPrivate: true, maximumBytes: 16 }), { code: 'response_status' })
  await assert.rejects(fetchSafeRealtimeBody(`${base}/wait`, { allowPrivate: true, maximumBytes: 16, timeoutMs: 30 }), { code: 'request_timeout' })
  const controller = new AbortController()
  const request = fetchSafeRealtimeBody(`${base}/wait`, { allowPrivate: true, maximumBytes: 16, signal: controller.signal })
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  console.log('Realtime security: actual HTTP bytes, private-address rejection, size bounds, redirects, timeout and cancellation passed.')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
