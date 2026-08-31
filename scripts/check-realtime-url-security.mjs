import assert from 'node:assert/strict'
import http from 'node:http'
import {
  assertSafeRealtimeUrl,
  fetchSafeRealtimeBody,
  isPrivateOrSpecialAddress,
} from '../server/realtime-url-security.mjs'

for (const address of [
  '127.0.0.1',
  '10.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '192.168.0.1',
  '::1',
  'fd00::1',
  'fe80::1',
  '::ffff:7f00:1',
]) assert.equal(isPrivateOrSpecialAddress(address), true, address)
assert.equal(isPrivateOrSpecialAddress('8.8.8.8'), false)
assert.equal(isPrivateOrSpecialAddress('2606:4700:4700::1111'), false)

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }]
assert.equal(
  (await assertSafeRealtimeUrl('https://example.test/feed.pb', { lookup: publicLookup })).hostname,
  'example.test',
)
await assert.rejects(
  () => assertSafeRealtimeUrl('https://example.test/feed.pb', {
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
  }),
  /private or special/,
)
await assert.rejects(
  () => assertSafeRealtimeUrl('file:///tmp/feed.pb', { lookup: publicLookup }),
  /http or https/,
)
await assert.rejects(
  () => assertSafeRealtimeUrl('https://user:secret@example.test/feed.pb', { lookup: publicLookup }),
  /embedded credentials/,
)

const server = http.createServer((request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/feed.pb' })
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/x-protobuf' })
  response.end('fixture')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
try {
  const fetched = await fetchSafeRealtimeBody(`http://127.0.0.1:${port}/feed.pb`, {
    maximumBytes: 16,
    allowPrivate: true,
  })
  assert.equal(new TextDecoder().decode(fetched.body), 'fixture')
  await assert.rejects(
    () => fetchSafeRealtimeBody(`http://127.0.0.1:${port}/feed.pb`, {
      maximumBytes: 3,
      allowPrivate: true,
    }),
    (error) => error.code === 'response_too_large',
  )
  await assert.rejects(
    () => fetchSafeRealtimeBody(`http://127.0.0.1:${port}/redirect`, {
      maximumBytes: 16,
      allowPrivate: true,
    }),
    (error) => error.code === 'response_status',
  )
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

console.log('GTFS-Realtime URL pinning, address-policy, redirect, and size checks passed.')
