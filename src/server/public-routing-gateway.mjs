import { searchAddresses, validBounds } from './address-search.mjs'
import { openAddressIndexWorker } from './address-index-worker.mjs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
const reject = (message, status = 400) => Object.assign(new Error(message), { status })
const newLimits = () => ({ minutes: {}, active: 0, buckets: new Map(), searchActive: 0, searchBuckets: new Map(), readActive: 0, readBuckets: new Map() })
const maxConnections = 1024
// Sent as a header so it can name the public app's only other origins: the
// default basemap and the analytics beacon Cloudflare injects at the edge.
const documentPolicy = ["default-src 'self'", "script-src 'self' https://static.cloudflareinsights.com", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org", "font-src 'self' data:",
  "connect-src 'self' https://tiles.openfreemap.org https://cloudflareinsights.com", "worker-src 'self' blob:", "child-src 'self' blob:",
  "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'"].join('; ')

function useScheduledService(request, clock, readiness = false) {
  // Route queries retain the native clock at full precision. Readiness only
  // needs a fixed local service date; it does not execute the journey.
  if (request.departNow && !readiness) { delete request.routingDataMode; return }
  if (request.departNow) {
    const parts = Object.fromEntries(clock.formatToParts(new Date()).map(part => [part.type, part.value]))
    request.serviceDate = `${parts.year}-${parts.month}-${parts.day}`
    request.departMinutes = Number(parts.hour) * 60 + Number(parts.minute)
    request.timePreference = 'depart'
    delete request.departNow
    delete request.arriveMinutes
  }
  request.routingDataMode = 'scheduled'
}

/** The gateway never accepts file paths, feed URLs, scenarios or native requests. */
export function publicRouteInput(body, { readiness = false, bounds = [-72.5, 41, -70, 43.5], cityName = 'Boston' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw reject('Expected a routing request.')
  const mode = body.mode ?? 'transit'
  if (!['transit', 'walk', 'bike', 'drive'].includes(mode)) throw reject('Unknown travel mode.')
  if (body.scenario || body.feedIds || body.wheelchair) throw reject('This public instance supports the baseline City only.')
  const result = { feedId: '__project__', mode, objective: 'earliest_arrival', allowServiceDateFallback: false }
  for (const key of ['departNow', 'requireTransitRide', 'autoExpandWalking', 'allowStreetTransfers', 'includeEarliestTransit', 'sharedLegs', 'includeRankedAlternatives']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw reject(`Invalid ${key}.`)
      result[key] = body[key]
    }
  }
  for (const [key, max] of [['departMinutes', 2880], ['arriveMinutes', 2880], ['maxWalkKm', 2.4], ['maxTransfers', 8], ['minimumTransferBufferMinutes', 15], ['departureWindowMinutes', 20]]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > max) throw reject(`${key} must be between 0 and ${max}.`)
      result[key] = body[key]
    }
  }
  for (const [key, values] of [['timePreference', ['depart', 'arrive']], ['routingDataMode', ['scheduled', 'realtime']], ['serviceDay', ['weekday', 'saturday', 'sunday']], ['departureWindowDirection', ['forward', 'backward']]]) {
    if (body[key] !== undefined) {
      if (!values.includes(body[key])) throw reject(`Invalid ${key}.`)
      result[key] = body[key]
    }
  }
  if (body.serviceDate !== undefined) {
    if (typeof body.serviceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.serviceDate)) throw reject('Invalid service date.')
    result.serviceDate = body.serviceDate
  }
  if (body.bike !== undefined) {
    const { profile, speedKph, maxLts } = body.bike ?? {}
    if (!['fast', 'balanced', 'quiet'].includes(profile) || !Number.isFinite(speedKph) || speedKph < 5 || speedKph > 40) throw reject('Invalid bicycle settings.')
    if (maxLts !== undefined && ![1, 2, 3, 4].includes(maxLts)) throw reject('Invalid bicycle traffic stress limit.')
    result.bike = { profile, speedKph }
    if (maxLts !== undefined) result.bike.maxLts = maxLts
  }
  result.maxStreetKm = 100
  result.allowLongWalk = false
  if (!readiness) {
    const point = value => {
      const c = value?.coordinate
      if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) || c[0] < bounds[0] || c[0] > bounds[2] || c[1] < bounds[1] || c[1] > bounds[3]) throw reject(`Choose a point in the ${cityName} region.`)
      return { coordinate: c, label: String(value.label ?? 'Map point').slice(0, 120), source: 'map' }
    }
    if (body.waypoints !== undefined && (!Array.isArray(body.waypoints) || body.waypoints.length > 3)) throw reject('At most three intermediate stops are supported.')
    result.origin = point(body.origin)
    result.destination = point(body.destination)
    result.waypoints = (body.waypoints ?? []).map(point)
  }
  // Accept legacy client modes, but every public route uses published service.
  result.routingDataMode = 'scheduled'
  return result
}

export function publicJson(value) {
  if (Array.isArray(value)) return value.map(publicJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:path|directory|sourceFile|sourceUrl|token|password|secret|apiKey|configFile)$/i.test(key))
    .map(([key, item]) => [key, publicJson(item)]))
  return typeof value === 'string' && /\/(Users|home|var|private)\//.test(value) ? '' : value
}

function publicProject(project) {
  const result = publicJson(pick(project, ['schemaVersion', 'id', 'name', 'region', 'createdAt', 'updatedAt', 'summary', 'routingStore', 'osmStreetIndex', 'networkTiles']))
  result.storagePath = ''
  result.jobs = []
  result.artifacts = []
  result.feeds = (project.feeds ?? []).map(feed => {
    // Routing needs the City's extent, not every network line and stop. Keep
    // real boundary stops for the initial map fit; route geometry comes from
    // each itinerary and point names come from the bounded place endpoint.
    const stops = (feed.mapPreview?.stops ?? []).filter(stop => Number.isFinite(stop.lon) && Number.isFinite(stop.lat))
    const bounds = new Set()
    for (const axis of ['lon', 'lat']) {
      if (!stops.length) break
      bounds.add(stops.reduce((a, b) => a[axis] < b[axis] ? a : b))
      bounds.add(stops.reduce((a, b) => a[axis] > b[axis] ? a : b))
    }
    return { warnings: [], tableProfiles: [], routeMetrics: [], stopMetrics: [],
      ...publicJson(pick(feed, ['id', 'name', 'provider', 'versionLabel', 'importedAt', 'source', 'fileName', 'fileSize', 'hash', 'qualityScore', 'routeCount', 'stopCount', 'tripCount', 'transferCandidates', 'requiredTables', 'optionalTables', 'routingStore'])),
      mapPreview: { routes: [], stops: [...bounds].map(stop => ({ ...pick(stop, ['id', 'name', 'lon', 'lat']), x: 0, y: 0, routes: [], tripCount: 0, transferScore: 0 })), stopPairs: [], coverage: { capped: true, previewStrategy: 'public-routing-bounds' } },
    }
  })
  return result
}

/** Standalone, deny-by-default bridge. The local API's security remains unchanged. */
export function createPublicRoutingGateway(config) {
  if (!config.cities) return createCityGateway(config)
  if (!Array.isArray(config.cities) || !config.cities.length || config.cities.length > 8) throw Error('Configure one to eight public Cities.')
  const ids = new Set(config.cities.map(c => c.cityId))
  if (ids.size !== config.cities.length) throw Error('Public City IDs must be unique.')
  const limits = newLimits()
  const children = new Map()
  const server = http.createServer((req, res) => {
    const id = /^\/api\/projects\/([a-z0-9_-]+)(?:[/?]|$)/.exec(req.url ?? '')?.[1]
    ;(children.get(id) ?? children.values().next().value).emit('request', req, res)
  })
  for (const city of config.cities) children.set(city.cityId, createCityGateway({ ...config, warmupRequests: [], ...city,
    limits, address: () => server.address(), catalogProjects: () => Promise.all([...children.values()].map(s => s.publicProject())) }))
  server.prepareRouting = async () => {
    const results = []
    try { for (const [cityId, child] of children) results.push({ cityId, ...await child.prepareRouting() }) }
    catch (error) { await Promise.all([...children.values()].map(child => child.shutdown())); throw error }
    return { ready: true, cities: results }
  }
  let stopping
  server.shutdown = () => stopping ??= (async () => {
    await new Promise(resolve => server.close(() => resolve()))
    await Promise.all([...children.values()].map(child => child.shutdown()))
  })()
  server.on('close', () => { for (const child of children.values()) child.emit('close') })
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = maxConnections
  return server
}

function createCityGateway({ upstream, publicOrigin, cityId, staticRoot, maxActive = 2, warmupRequests = [], addressIndexPath, searchCenter,
  bounds = [-72.5, 41, -70, 43.5], name = 'Boston', coverage = '', coverageUrl, timeZone = 'America/New_York', address, catalogProjects, geocoderEndpoint, limits = newLimits() }) {
  const origin = new URL(upstream)
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Upstream must be a local HTTP server.')
  if (!/^[a-z0-9_-]+$/.test(cityId)) throw Error('Invalid City ID.')
  if (!validBounds(bounds)) throw Error('Invalid City bounds.')
  if (searchCenter && (!Array.isArray(searchCenter) || searchCenter.length !== 2 || !searchCenter.every(Number.isFinite)
    || searchCenter[0] < bounds[0] || searchCenter[0] > bounds[2] || searchCenter[1] < bounds[1] || searchCenter[1] > bounds[3])) throw Error('Invalid address search center.')
  const addressIndex = addressIndexPath ? openAddressIndexWorker(addressIndexPath, { bounds, center: searchCenter, name }) : null
  if (coverageUrl && new URL(coverageUrl).protocol !== 'https:') throw Error('Coverage links must use HTTPS.')
  if (geocoderEndpoint && new URL(geocoderEndpoint).protocol !== 'https:') throw Error('The geocoder endpoint must use HTTPS.')
  // A City with its own index keeps what visitors type on this host unless an
  // operator names a geocoding service for the places it does not know.
  const remoteGeocoder = Boolean(geocoderEndpoint) || !addressIndex
  const serviceClock = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const prefix = `/api/projects/${cityId}`
  const rootPath = fs.realpath(staticRoot)
  let catalog, catalogPending
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  const local = async (pathname, init = {}) => {
    let response
    try {
      response = await fetch(new URL(pathname, origin), { ...init, redirect: 'error', headers: { 'Content-Type': 'application/json', Origin: origin.origin }, signal: init.signal ?? AbortSignal.timeout(45000) })
    } catch (error) {
      if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(error.cause?.code)) {
        throw Object.assign(reject('Routing is temporarily unavailable.', 503), { serviceOffline: true })
      }
      throw error
    }
    if (!response.ok) throw reject(response.status === 400 ? 'The routing request could not be completed with these settings.' : 'Routing is temporarily unavailable. Please retry.', response.status >= 500 ? 503 : response.status)
    return response
  }
  const project = async () => {
    if (catalog) return catalog
    catalogPending ??= local(`${prefix}?detail=catalog`).then(r => r.json()).then(r => { catalog = { ...publicProject(r.project), name, publicRouting: { bounds, coverage, coverageUrl, realtime: false } }; return catalog }).finally(() => { catalogPending = null })
    return catalogPending
  }
  if (!Array.isArray(warmupRequests) || warmupRequests.length > 4) throw Error('Configure at most four startup routing requests.')
  const startupRequests = warmupRequests.map(body => publicRouteInput(body, { bounds, cityName: name }))
  // This lease belongs to the one gateway serving this origin/City, not to a
  // browser tab. A graceful shutdown releases it without touching other leases.
  const leaseId = `public-gateway:${new URL(publicOrigin).host}:${cityId}`
  let leaseHeld = false, preparation, releasing, shutdownPending
  const startupAbort = new AbortController()
  const releaseRouting = () => {
    if (!leaseHeld) return Promise.resolve()
    releasing ??= (async () => {
      const response = await local(`${prefix}/routing-residency`, { method: 'POST',
        body: JSON.stringify({ feedId: '__project__', resident: false, leaseId }), signal: AbortSignal.timeout(10000) })
      await response.arrayBuffer()
      leaseHeld = false
    })().finally(() => { releasing = null })
    return releasing
  }
  const prepareRouting = () => {
    preparation ??= (async () => {
      if (!startupRequests.length) return { ready: true, modes: [], preparationMs: 0 }
      const started = performance.now()
      const warnings = []
      const post = (action, body) => local(`${prefix}/${action}`, { method: 'POST', body: JSON.stringify(body),
        // A cold host may need longer to load the graph than to answer a query.
        // Keep visitor deadlines unchanged; preparation happens before listening.
        signal: AbortSignal.any([startupAbort.signal, AbortSignal.timeout(600000)]) })
        .catch(error => { throw new Error(`${name} ${body.mode ?? 'transit'} ${action}: ${error.message}`, { cause: error }) })
      // Resolve each catalog before listening so a visitor switching Cities
      // does not pay for the first feed-summary read.
      await project()
      // Mark before dispatch: cancellation may arrive after the server commits
      // the lease but before its response reaches this process.
      leaseHeld = true
      try {
        await (await local(`${prefix}/routing-residency`, { method: 'POST',
          body: JSON.stringify({ feedId: '__project__', resident: true, leaseId }), signal: AbortSignal.timeout(10000) })).arrayBuffer()
        for (const configured of startupRequests) {
          startupAbort.signal.throwIfAborted()
          const clean = { ...configured }
          if (clean.mode === 'transit') useScheduledService(clean, serviceClock)
          if (clean.mode === 'transit') {
            const readyInput = { ...clean }
            useScheduledService(readyInput, serviceClock, true)
            const readiness = await (await post('national-ready', readyInput)).json()
            if (readiness.routing?.ready !== true) throw Error('Transit startup is not ready.')
            // The following route waits for background timetable preparation.
          }
          const data = await (await post('national-route', clean)).json()
          // A valid blocked journey still prepares its mode. HTTP errors or
          // malformed results must prevent a premature ready/listening state.
          if (!Array.isArray(data.choices) || data.choices.some(choice => !['ready', 'blocked'].includes(choice.status))) {
            throw Error('Routing startup returned an invalid result.')
          }
        }
        return { ready: true, warnings, modes: [...new Set(startupRequests.map(request => request.mode))],
          preparationMs: Number((performance.now() - started).toFixed(1)) }
      } catch (error) {
        await releaseRouting().catch(() => {})
        throw error
      }
    })()
    return preparation
  }
  const allowedRead = new Set([`${prefix}/place`, `${prefix}/local-basemap`])
  // One visitor budget and shared concurrency per kind of work, across Cities.
  const meters = {
    route: { active: 'active', buckets: 'buckets', perMinute: 30, concurrent: maxActive, label: 'Routing' },
    search: { active: 'searchActive', buckets: 'searchBuckets', perMinute: 60, concurrent: 8, label: 'Address search' },
    read: { active: 'readActive', buckets: 'readBuckets', perMinute: 600, concurrent: 32, label: 'This service' },
  }
  const metered = async (req, res, kind, work) => {
    const meter = meters[kind], buckets = limits[meter.buckets]
    const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress)
    const minute = Math.floor(Date.now() / 60000)
    if (limits.minutes[kind] !== minute) {
      buckets.clear()
      limits.minutes[kind] = minute
    }
    const bucket = buckets.get(ip) ?? { minute, count: 0 }
    if (bucket.count >= meter.perMinute || !buckets.has(ip) && buckets.size >= 10000 || limits[meter.active] >= meter.concurrent) {
      res.setHeader('Retry-After', '10'); throw reject(`${meter.label} is busy. Please retry shortly.`, 429)
    }
    bucket.count++; buckets.set(ip, bucket); limits[meter.active]++
    try { return await work() } finally { limits[meter.active]-- }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableEnded) abort.abort() })
    try {
      const host = String(req.headers.host ?? '')
      const localHost = `127.0.0.1:${(address?.() ?? server.address())?.port}`
      const expected = host === new URL(publicOrigin).host ? publicOrigin : host === localHost ? `http://${localHost}` : ''
      if (!expected || (req.headers.origin && req.headers.origin !== expected) || req.headers['sec-fetch-site'] === 'cross-site') throw reject('Origin not allowed.', 403)
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048 || /%2f|%5c|%2e|\\/i.test(req.url)) throw reject('Invalid path.')
      const url = new URL(req.url, expected), pathname = url.pathname
      if (!['GET', 'POST', 'HEAD'].includes(req.method)) throw reject('This public instance is read-only.', 403)
      if (!pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw reject('Method not allowed.', 405)
        const allowed = pathname === '/' || /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2?|png|svg)$/.test(pathname) || /^\/(favicon|vigo-mark-transparent|vigo-mark-dark|vigo-wordmark)\.png$/.test(pathname)
        if (!allowed) throw reject('Not found.', 404)
        const file = path.resolve(staticRoot, pathname === '/' ? 'index.html' : `.${pathname}`)
        const real = await fs.realpath(file)
        if (!real.startsWith(await rootPath + path.sep)) throw reject('Not found.', 404)
        let bytes = await fs.readFile(real)
        if (pathname === '/') bytes = Buffer.from(bytes.toString().replace('<html', `<html data-vigo-public-city="${cityId}"`).replace('<title>VIGO Studio</title>', '<title>VIGO · Route your city</title>').replace('VIGO Studio turns GTFS and OSM into a city you can explore, route, and analyze.', 'Find transit, walking, cycling, and driving routes in your city.').replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/i, ''))
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' }
        // Built assets carry a content hash, so only the document is revalidated.
        const etag = `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`
        const headers = { 'Content-Type': types[path.extname(real)], ETag: etag,
          'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : pathname === '/' ? 'no-cache' : 'public, max-age=3600' }
        if (pathname === '/') headers['Content-Security-Policy'] = documentPolicy
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
        res.writeHead(200, headers)
        res.end(req.method === 'HEAD' ? undefined : bytes)
        return
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        const health = await metered(req, res, 'read', () => local('/api/health', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) }).then(response => response.json()))
        json(res, 200, { ok: health.ok, version: health.version, storageRoot: '', config: { configured: true, setupRequired: false, storageRoot: '', defaultStorageRoot: '', configFile: '', canChangeStorageRoot: false, appearance: 'light', accent: 'teal', basemap: 'minimal', offline: { localServer: false, bundledApp: true, storageWritable: false, gtfsImport: false, offlineBasemap: true } } }); return
      }
      if (req.method === 'GET' && (pathname === '/api/projects' || pathname === prefix)) {
        const p = await project(); json(res, 200, pathname === prefix ? { project: p } : { projects: catalogProjects ? await catalogProjects() : [p] }); return
      }
      if (req.method === 'GET' && (allowedRead.has(pathname) || new RegExp(`^${prefix}/(basemap|network)-tiles/\\d{1,2}/\\d{1,7}/\\d{1,7}\\.mvt$`).test(pathname))) {
        await metered(req, res, 'read', async () => {
          const response = await local(pathname + url.search, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
          const type = response.headers.get('content-type') ?? 'application/octet-stream'
          if (type.includes('json')) json(res, 200, publicJson(await response.json()))
          else { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=60' }); res.end(Buffer.from(await response.arrayBuffer())) }
        })
        return
      }
      const actions = new Set(['national-route', 'national-ready', 'routing-residency', 'street-residency', 'wheelchair-availability', 'address-search'])
      const action = pathname.startsWith(prefix + '/') ? pathname.slice(prefix.length + 1) : ''
      if (req.method !== 'POST' || !actions.has(action) || url.search) throw reject('This public endpoint is unavailable.', 403)
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw reject('Expected JSON.', 415)
      const chunks = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 16384) throw reject('Request too large.', 413); chunks.push(chunk) }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { throw reject('Invalid JSON.') }
      if (action === 'routing-residency') { json(res, 200, { residency: { retained: false } }); return }
      if (action === 'street-residency') {
        const p = await project()
        const ready = p.osmStreetIndex?.status === 'ready'
        json(res, 200, { job: { id: 'public-streets', status: ready ? 'complete' : 'failed', result: { modes: { walk: ready, drive: ready && p.osmStreetIndex.driveEdgeCount > 0 } } } }); return
      }
      if (action === 'wheelchair-availability') { json(res, 200, { available: false, canPrepare: false, reason: 'Wheelchair routing is not enabled on this public instance.' }); return }
      const isAddressSearch = action === 'address-search'
      const clean = isAddressSearch ? null : publicRouteInput(body, { readiness: action === 'national-ready', bounds, cityName: name })
      // Autocomplete must not occupy the route engine's slots or query budget.
      await metered(req, res, isAddressSearch ? 'search' : 'route', async () => {
        const started = performance.now()
        if (isAddressSearch) {
          const result = await searchAddresses(body?.query, bounds, { signal: abort.signal, index: addressIndex, center: searchCenter, remote: remoteGeocoder, ...(geocoderEndpoint ? { endpoint: geocoderEndpoint } : {}) })
          res.setHeader('Server-Timing', `address;dur=${(performance.now() - started).toFixed(1)}`)
          json(res, 200, result); return
        }
        if (clean.mode === 'transit') useScheduledService(clean, serviceClock, action === 'national-ready')
        const response = await local(pathname, { method: 'POST', body: JSON.stringify(clean), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]) })
        const data = await response.json()
        res.setHeader('Server-Timing', `routing;dur=${(performance.now() - started).toFixed(1)}`)
        json(res, 200, publicJson(data))
      })
    } catch (error) {
      if (error.serviceOffline && !res.headersSent) res.setHeader('X-Vigo-Offline', '1')
      if (!res.headersSent && !res.destroyed) json(res, error.status ?? 503, { error: error.status ? error.message : 'Routing is temporarily unavailable. Please retry.' })
      else res.end()
    }
  })
  server.on('close', () => {
    addressIndex?.close()
    startupAbort.abort()
    void Promise.resolve(preparation).catch(() => {}).then(releaseRouting).catch(() => {})
  })
  server.publicProject = project
  server.prepareRouting = prepareRouting
  server.shutdown = () => shutdownPending ??= (async () => {
    startupAbort.abort()
    await new Promise(resolve => server.close(() => resolve()))
    await preparation?.catch(() => {})
    await releaseRouting()
  })()
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.maxConnections = maxConnections
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
  const server = createPublicRoutingGateway(config)
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    void server.shutdown().then(() => process.exit(0), error => { console.error(error.message); process.exit(1) })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    const prepared = await server.prepareRouting()
    if (!stopping) {
      console.log(`Public routing startup: ${JSON.stringify(prepared)}`)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port ?? 8788, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
      console.log(`Public routing gateway listening on ${JSON.stringify(server.address())}`)
    }
  } catch (error) {
    console.error(`Public routing startup failed: ${error.message}`)
    await server.shutdown().catch(reason => console.error(reason.message))
    process.exitCode = 1
  }
}
