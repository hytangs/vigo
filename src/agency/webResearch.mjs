import { endpointFacts } from './runtimeFacts.mjs'

// A search provider is independent of the language model. Only the explicit
// query leaves the server; provider credentials never enter model context.
const referenceUrl = 'https://en.wikipedia.org/w/api.php'
const braveUrl = 'https://api.search.brave.com/res/v1/web/search'
const duckUrl = 'https://html.duckduckgo.com/html/'
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

export function publicUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a public HTTP(S) URL without embedded credentials.')
  return url.href
}

// Search-engine HTML is not a search API. In particular Google's HTTP 200
// JavaScript challenge must never become a successful source for a business.
function isSearchResultsUrl(value) {
  const url = new URL(value), host = url.hostname.replace(/^www\./, '')
  if (['google.com', 'bing.com'].includes(host)) return url.pathname === '/search' && url.searchParams.has('q')
  if (['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com'].includes(host)) return url.searchParams.has('q')
  return host === 'search.yahoo.com' && url.pathname === '/search' && url.searchParams.has('p')
}

export function pageText(html) {
  return String(html).replace(/<!--[^]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
      if (!name.startsWith('#')) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name.toLowerCase()] || entity
      const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
    }).replace(/\s+/g, ' ').trim()
}

// Read DuckDuckGo's documented non-JavaScript results, not a generic page
// scrape. Join snippets by destination URL so adjacent results cannot mix.
export function duckSearchResults(html) {
  const matches = new Map(), snippets = new Map()
  for (const anchor of html.matchAll(/<a\b([^>]*)>([^]*?)<\/a\s*>/gi)) {
    const classes = anchor[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? []
    if (!classes.includes('result__a') && !classes.includes('result__snippet')) continue
    const href = anchor[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]
    if (!href) continue
    try {
      const link = new URL(pageText(href), duckUrl)
      const url = publicUrl(['duckduckgo.com', 'html.duckduckgo.com'].includes(link.hostname) && link.pathname === '/l/' ? link.searchParams.get('uddg') : link.href)
      const text = pageText(anchor[2])
      if (classes.includes('result__a') && text && !matches.has(url)) matches.set(url, { title: text.slice(0, 200), url, publishedAt: null })
      if (classes.includes('result__snippet')) snippets.set(url, text.slice(0, 1200))
    } catch { /* Invalid destinations are not evidence. */ }
  }
  if (!matches.size && !/class\s*=\s*["'][^"']*\bno-results\b/i.test(html)) throw new Error('DuckDuckGo did not return readable search results. Try again later or connect Brave Search or SearXNG in Web sources.')
  return [...matches.values()].slice(0, 5).map(match => ({ ...match, excerpt: snippets.get(match.url) || '' }))
}

// Prefer the publisher's semantic main region; retain useful source links so
// the next step can read an official site or use a published map location.
export function readablePage(html, baseUrl) {
  const main = html.match(/<main\b[^>]*>([^]*?)<\/main\s*>/i)?.[1] ?? html
  const links = new Map()
  for (const match of main.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])([^]*?)\1[^>]*>([^]*?)<\/a\s*>/gi)) {
    try {
      const url = publicUrl(new URL(pageText(match[2]), baseUrl).href)
      const title = pageText(match[3]).slice(0, 200)
      if (title && !links.has(url)) links.set(url, { title, url })
    } catch { /* Non-web links are not research sources. */ }
    if (links.size === 25) break
  }
  const footer = main === html ? '' : [...html.matchAll(/<footer\b[^>]*>([^]*?)<\/footer\s*>/gi)].map(match => pageText(match[1])).join(' ')
  return { content: pageText(main), footer, links: [...links.values()] }
}

export function createWebResearch({ env = process.env, fetchImpl = fetch, readPage, clock = Date.now } = {}) {
  let config = { provider: env.VIGO_AGENCY_WEB_SEARCH_PROVIDER || (env.VIGO_AGENCY_WEB_SEARCH_URL ? 'searxng' : env.VIGO_AGENCY_WEB_SEARCH_KEY ? 'brave' : 'duckduckgo'),
    baseUrl: env.VIGO_AGENCY_WEB_SEARCH_URL || '', key: env.VIGO_AGENCY_WEB_SEARCH_KEY || '' }
  const readAvailable = env.VIGO_AGENCY_WEB_READ !== 'off' && Boolean(readPage)
  let revision = 0, connectionAttempt = 0
  const cache = new Map()
  function candidate(input) {
    if (!['off', 'duckduckgo', 'wikipedia', 'brave', 'searxng'].includes(input?.provider)) throw new Error('Choose DuckDuckGo, Wikipedia, Brave Search, SearXNG, or Off.')
    if (input.provider === 'off') return { provider: 'off', baseUrl: '', key: '' }
    if (input.provider === 'duckduckgo') return { provider: 'duckduckgo', baseUrl: duckUrl, key: '' }
    if (input.provider === 'wikipedia') return { provider: 'wikipedia', baseUrl: referenceUrl, key: '' }
    const baseUrl = input.provider === 'brave' ? braveUrl : publicUrl(input.baseUrl)
    const url = new URL(baseUrl)
    if (url.search || url.hash || url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use an HTTPS search endpoint, or HTTP on localhost, without query parameters.')
    const key = clean(input.apiKey, 2000) || (config.provider === input.provider && config.baseUrl === baseUrl ? config.key : '')
    if (input.provider === 'brave' && !key) throw new Error('Enter a Brave Search API key, or use your own SearXNG endpoint.')
    return { provider: input.provider, baseUrl, key }
  }
  async function search(connection, query, signal) {
    if (connection.provider === 'off') throw new Error('Web search is not connected. Choose DuckDuckGo, Brave Search or SearXNG in AI settings → Web sources.')
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Use a public search query of 1–300 characters.')
    const url = new URL(connection.baseUrl)
    url.searchParams.set(connection.provider === 'wikipedia' ? 'gsrsearch' : 'q', query.trim())
    if (connection.provider === 'wikipedia') Object.entries({ action: 'query', generator: 'search', gsrlimit: '5', prop: 'extracts|info', inprop: 'url', exintro: '1', explaintext: '1', exchars: '1200', format: 'json', formatversion: '2', utf8: '1' }).forEach(([key, value]) => url.searchParams.set(key, value))
    else if (connection.provider === 'brave') url.searchParams.set('count', '5')
    else if (connection.provider === 'searxng') { url.searchParams.set('format', 'json'); url.searchParams.set('categories', 'general') }
    const timeout = AbortSignal.timeout(12_000)
    const response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: connection.provider === 'duckduckgo' ? 'text/html' : 'application/json', 'User-Agent': 'VIGO-Agency (https://github.com/vigo-developers/vigo-agency)', ...(connection.key ? connection.provider === 'brave' ? { 'X-Subscription-Token': connection.key } : { Authorization: `Bearer ${connection.key}` } : {}) } })
    if (!response.ok || connection.provider === 'duckduckgo' && response.status !== 200) { await response.body?.cancel(); throw new Error(`Web search returned HTTP ${response.status}. Try later or choose another search provider in AI settings.`) }
    if (!response.body) throw new Error('Web search returned no response.')
    const reader = response.body.getReader(), chunks = []
    let bytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 512_000) throw new Error('Search response exceeded the size limit.')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const body = Buffer.concat(chunks).toString('utf8')
    const coverage = 'Search results are leads, not confirmed causes. Read the source and check the subject and date. Missing results do not prove nonexistence.'
    if (connection.provider === 'duckduckgo') return { query, matches: duckSearchResults(body), retrievedAt: new Date(clock()).toISOString(), coverage }
    let payload
    try { payload = JSON.parse(body) } catch { throw new Error('The search endpoint did not return JSON. Enable JSON output for SearXNG.') }
    const rows = connection.provider === 'wikipedia' ? (payload.query?.pages ?? (payload.batchcomplete ? [] : undefined)) : connection.provider === 'brave' ? payload.web?.results : payload.results
    if (!Array.isArray(rows)) throw new Error('The search provider returned an unsupported result.')
    if (connection.provider === 'wikipedia') rows.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
    const matches = rows.slice(0, 5).flatMap(row => {
      try { return [{ title: clean(row.title, 200), url: publicUrl(connection.provider === 'wikipedia' ? row.fullurl : row.url), excerpt: pageText(row.extract || row.description || row.content || '').slice(0, 1200), publishedAt: clean(row.page_age || row.publishedDate, 100) || null }] } catch { return [] }
    })
    return { query, matches, retrievedAt: new Date(clock()).toISOString(), coverage: connection.provider === 'wikipedia' ? 'Wikipedia reference search only, not a live news or market index. These are introductory extracts from separate articles, not interchangeable descriptions. Read the matching source for further details. Missing results do not prove nonexistence.' : coverage }
  }
  config = candidate({ provider: config.provider, baseUrl: config.baseUrl, apiKey: config.key })
  return {
    status() { return { provider: config.provider, baseUrl: config.provider === 'searxng' ? config.baseUrl : '', hasKey: Boolean(config.key), searchAvailable: config.provider !== 'off', readAvailable } },
    async connect(input, signal) {
      const next = candidate(input)
      signal?.throwIfAborted()
      const attempt = ++connectionAttempt
      if (next.provider !== 'off') await search(next, 'public transit', signal)
      signal?.throwIfAborted()
      if (attempt !== connectionAttempt) throw new Error('This connection test was superseded by newer search settings.')
      config = next; revision++; cache.clear()
      return this.status()
    },
    forRequest() {
      const connection = { ...config }, started = revision
      return {
        ...this.status(),
        endpoint: connection.provider === 'off' ? null : endpointFacts(connection.baseUrl).endpoint,
        async search(query, signal) {
          signal?.throwIfAborted()
          if (started !== revision) throw new Error('The search connection changed. Ask again to use it.')
          const key = JSON.stringify([started, query]), cached = cache.get(key)
          if (cached && clock() - Date.parse(cached.retrievedAt) < 60_000) return structuredClone(cached)
          const result = await search(connection, query, signal)
          if (started === revision) { cache.set(key, result); if (cache.size > 50) cache.delete(cache.keys().next().value) }
          return structuredClone(result)
        },
        async read(url, signal) {
          if (!readAvailable) throw new Error('Public page reading is disabled on this server.')
          const target = publicUrl(url)
          if (isSearchResultsUrl(target)) throw new Error(`This is a search-results URL, not a source page. ${['duckduckgo', 'brave', 'searxng'].includes(connection.provider) ? 'Use web_search with the search terms, then read a returned source.' : 'General web search is not connected. Choose DuckDuckGo, Brave Search or SearXNG in AI settings → Web sources. Wikipedia and the map index do not replace a business web search.'}`)
          const result = await readPage(target, signal)
          return { ...result, retrievedAt: new Date(clock()).toISOString() }
        },
      }
    },
  }
}
