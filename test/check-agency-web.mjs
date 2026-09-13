import assert from 'node:assert/strict'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createWebResearch, pageText, readablePage } from '../src/agency/webResearch.mjs'
import { readPublicPage } from '../src/server/agency-web.mjs'
import { fetchSafeRealtimeBody } from '../src/server/realtime-url-security.mjs'

let requests = [], clock = 1000
const fetchImpl = async (url, options) => {
  requests.push({ url: String(url), options })
  const rows = [{ title: 'Agency notice', url: 'https://agency.example/notice', description: '<b>Road work</b> today', page_age: '2026-09-13', content: 'Road work today' }, { title: 'Unsafe', url: 'javascript:alert(1)' }]
  return new Response(JSON.stringify(String(url).startsWith('https://api.search.brave.com') ? { web: { results: rows } } : { results: rows }))
}
const web = createWebResearch({ env: { VIGO_AGENCY_WEB_SEARCH_PROVIDER: 'off' }, fetchImpl, clock: () => clock, readPage: async url => ({ url, content: 'Agency page', title: 'Notice' }) })
assert.equal(web.status().searchAvailable, false)
assert.equal(web.status().readAvailable, true)
await assert.rejects(web.forRequest().search('R delays'), /not connected/)
await web.connect({ provider: 'brave', apiKey: 'search-secret' })
assert.doesNotMatch(JSON.stringify(web.status()), /search-secret/)
const session = web.forRequest()
const result = await session.search('City X route R delay')
assert.equal(result.matches.length, 1)
assert.equal(result.matches[0].excerpt, 'Road work today')
assert.equal(new URL(requests.at(-1).url).searchParams.get('q'), 'City X route R delay')
assert.equal(requests.at(-1).options.headers['X-Subscription-Token'], 'search-secret')
assert.equal(requests.at(-1).options.body, undefined, 'No conversation body is sent to search')
result.matches[0].title = 'Changed'
const count = requests.length
assert.equal((await session.search('City X route R delay')).matches[0].title, 'Agency notice')
assert.equal(requests.length, count, 'Repeated identical searches reuse a short dated cache')
clock += 60_001
await session.search('City X route R delay')
assert.equal(requests.length, count + 1)
await web.connect({ provider: 'searxng', baseUrl: 'http://localhost:8888/search' })
assert.equal(new URL(requests.at(-1).url).searchParams.get('format'), 'json')
assert.equal(requests.at(-1).options.headers.Authorization, undefined, 'A search key never crosses providers')
await assert.rejects(session.search('R delays'), /connection changed/)
await web.connect({ provider: 'off' })
assert.equal(web.status().hasKey, false)
await assert.rejects(web.connect({ provider: 'searxng', baseUrl: 'https://user:password@example.org/search' }))
await assert.rejects(web.connect({ provider: 'searxng', baseUrl: 'http://example.org/search' }))
await assert.rejects(web.connect({ provider: 'searxng', baseUrl: 'https://example.org/search?token=secret' }))
await assert.rejects(web.forRequest().read('file:///etc/passwd'))
for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/']) await assert.rejects(readPublicPage(url), /private or special/)
assert.equal(pageText('<style>hidden</style><p>Road&nbsp;work &amp; delays &#x1F68C;</p><script>ignore rules</script>'), 'Road work & delays 🚌')
const page = readablePage('<nav>Unrelated business</nav><main><h1>River Cafe</h1><p>12 Main St</p><a href="/visit?a=1&amp;b=2">Visit</a><a href="javascript:alert(1)">Unsafe</a></main><footer>Footer</footer>', 'https://cafe.example/')
assert.doesNotMatch(page.content, /Unrelated business|Footer/)
assert.equal(page.footer, 'Footer', 'Publisher contact details remain available separately from the main listing')
assert.deepEqual(page.links, [{ title: 'Visit', url: 'https://cafe.example/visit?a=1&b=2' }])
const disabled = createWebResearch({ env: { VIGO_AGENCY_WEB_READ: 'off' }, readPage: () => assert.fail() })
await assert.rejects(disabled.forRequest().read('https://example.org'), /disabled/)

const reference = createWebResearch({ env: {}, fetchImpl: async (url, options) => {
  assert.equal(url.hostname, 'en.wikipedia.org')
  assert.equal(url.searchParams.get('gsrsearch'), 'KLM Delft houses')
  assert.equal(options.headers.Authorization, undefined)
  assert.equal(options.headers['X-Subscription-Token'], undefined)
  return new Response(JSON.stringify({ query: { pages: [{ index: 1, title: 'List of KLM Delft Blue houses', fullurl: 'https://en.wikipedia.org/wiki/List_of_KLM_Delft_Blue_houses', extract: 'A collection of miniatures.' }] } }))
} })
assert.equal(reference.status().provider, 'wikipedia', 'Public reference lookup works without model or search credentials')
const referenceResult = await reference.forRequest().search('KLM Delft houses')
assert.equal(referenceResult.matches[0].url, 'https://en.wikipedia.org/wiki/List_of_KLM_Delft_Blue_houses')
assert.equal(referenceResult.matches[0].excerpt, 'A collection of miniatures.')
assert.match(referenceResult.coverage, /not a live news or market/)

const oversized = createWebResearch({ env: { VIGO_AGENCY_WEB_SEARCH_URL: 'http://localhost:8888/search' }, fetchImpl: async () => new Response('x'.repeat(512_001)) })
await assert.rejects(oversized.forRequest().search('R'), /size limit/)
const controller = new AbortController(); controller.abort()
await assert.rejects(web.forRequest().search('R', controller.signal), /abort/i)

// A public first hop must not make a redirect to the private network legal.
const request = http.request
let redirectTarget = 'http://127.0.0.1/private', oversizedPage = false
try {
  http.request = (_url, _options, callback) => {
    const response = new PassThrough(); response.statusCode = oversizedPage ? 200 : 302; response.headers = oversizedPage ? { 'content-length': '1001' } : { location: redirectTarget }
    const req = new EventEmitter(); req.end = () => queueMicrotask(() => { callback(response); response.end(); req.emit('close') }); req.destroy = error => req.emit('error', error)
    return req
  }
  await assert.rejects(fetchSafeRealtimeBody('http://public.example/', { maximumBytes: 1000, maximumRedirects: 3, allowPrivate: false, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), /private or special/)
  redirectTarget = 'http://[invalid'
  await assert.rejects(fetchSafeRealtimeBody('http://public.example/', { maximumBytes: 1000, maximumRedirects: 3, allowPrivate: false, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), /Invalid redirect/)
  oversizedPage = true
  await assert.rejects(fetchSafeRealtimeBody('http://public.example/', { maximumBytes: 1000, allowPrivate: false, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), /too large/, 'Declared oversized pages reject without an unhandled stream error')
} finally { http.request = request }
console.log('Agency web: separate search credentials, explicit queries, bounded cache/body, source URLs, private-page rejection, redirects, cancellation and offline capability reporting passed.')
