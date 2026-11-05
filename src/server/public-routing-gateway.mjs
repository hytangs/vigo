import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
const reject = (message, status = 400) => Object.assign(new Error(message), { status })

/** The gateway never accepts file paths, feed URLs, scenarios or native requests. */
export function publicRouteInput(body, { readiness = false } = {}) {
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
      if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) || c[0] < -72.5 || c[0] > -70 || c[1] < 41 || c[1] > 43.5) throw reject('Choose a point in the Boston region.')
      return { coordinate: c, label: String(value.label ?? 'Map point').slice(0, 120), source: 'map' }
    }
    if (body.waypoints !== undefined && (!Array.isArray(body.waypoints) || body.waypoints.length > 3)) throw reject('At most three intermediate stops are supported.')
    result.origin = point(body.origin)
    result.destination = point(body.destination)
    result.waypoints = (body.waypoints ?? []).map(point)
  }
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
  result.feeds = (project.feeds ?? []).map(feed => ({ warnings: [], tableProfiles: [], ...publicJson(pick(feed, ['id', 'name', 'provider', 'versionLabel', 'importedAt', 'source', 'fileName', 'fileSize', 'hash', 'qualityScore', 'routeCount', 'stopCount', 'tripCount', 'transferCandidates', 'requiredTables', 'optionalTables', 'routingStore', 'routeMetrics', 'stopMetrics', 'mapPreview'])) }))
  return result
}

/** Standalone, deny-by-default bridge. The local API's security remains unchanged. */
export function createPublicRoutingGateway({ upstream, publicOrigin, cityId, staticRoot, realtimeRequest = null, maxActive = 2 }) {
  const origin = new URL(upstream)
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw Error('Upstream must be a local HTTP server.')
  if (!/^[a-z0-9_-]+$/.test(cityId)) throw Error('Invalid City ID.')
  const prefix = `/api/projects/${cityId}`
  const rootPath = fs.realpath(staticRoot)
  const buckets = new Map()
  let active = 0, catalog, catalogAt = 0, catalogPending, snapshot, snapshotAt = 0, snapshotPending
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  const local = async (pathname, init = {}) => {
    const response = await fetch(new URL(pathname, origin), { ...init, redirect: 'error', headers: { 'Content-Type': 'application/json', Origin: origin.origin }, signal: init.signal ?? AbortSignal.timeout(45000) })
    if (!response.ok) throw reject(response.status === 400 ? 'The routing request could not be completed with these settings.' : 'Routing is temporarily unavailable. Please retry.', response.status >= 500 ? 503 : response.status)
    return response
  }
  const project = async () => {
    if (catalog && Date.now() - catalogAt < 60000) return catalog
    catalogPending ??= local(`${prefix}?detail=catalog`).then(r => r.json()).then(r => { catalog = publicProject(r.project); catalogAt = Date.now(); return catalog }).finally(() => { catalogPending = null })
    return catalogPending
  }
  const live = async () => {
    if (!realtimeRequest) return undefined
    if (snapshot && Date.now() - snapshotAt < 30000) return snapshot
    snapshotPending ??= local(`${prefix}/agency`, { method: 'POST', body: JSON.stringify({ action: 'connect', request: realtimeRequest }) }).then(r => r.json()).then(r => { snapshot = r.snapshot; snapshotAt = Date.now(); return snapshot }).finally(() => { snapshotPending = null })
    return snapshotPending
  }
  const allowedRead = new Set([`${prefix}/place`, `${prefix}/local-basemap`])
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableEnded) abort.abort() })
    try {
      const host = String(req.headers.host ?? '')
      const localHost = `127.0.0.1:${server.address()?.port}`
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
        if (pathname === '/') bytes = Buffer.from(bytes.toString().replace('<html', `<html data-vigo-public-city="${cityId}"`))
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' }
        res.writeHead(200, { 'Content-Type': types[path.extname(real)], 'Cache-Control': 'public, max-age=60' })
        res.end(req.method === 'HEAD' ? undefined : bytes)
        return
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        const health = await (await local('/api/health')).json()
        json(res, 200, { ok: health.ok, version: health.version, storageRoot: '', config: { configured: true, setupRequired: false, storageRoot: '', defaultStorageRoot: '', configFile: '', canChangeStorageRoot: false, appearance: 'light', accent: 'teal', basemap: 'minimal', offline: { localServer: false, bundledApp: true, storageWritable: false, gtfsImport: false, offlineBasemap: true } } }); return
      }
      if (req.method === 'GET' && (pathname === '/api/projects' || pathname === prefix)) {
        const p = await project(); json(res, 200, pathname === prefix ? { project: p } : { projects: [p] }); return
      }
      if (req.method === 'GET' && (allowedRead.has(pathname) || new RegExp(`^${prefix}/(basemap|network)-tiles/\\d{1,2}/\\d{1,7}/\\d{1,7}\\.mvt$`).test(pathname))) {
        const response = await local(pathname + url.search, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
        const type = response.headers.get('content-type') ?? 'application/octet-stream'
        if (type.includes('json')) json(res, 200, publicJson(await response.json()))
        else { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=60' }); res.end(Buffer.from(await response.arrayBuffer())) }
        return
      }
      const actions = new Set(['national-route', 'national-ready', 'routing-residency', 'street-residency', 'wheelchair-availability'])
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
      const clean = publicRouteInput(body, { readiness: action === 'national-ready' })
      const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress)
      const minute = Math.floor(Date.now() / 60000)
      for (const [key, bucket] of buckets) if (bucket.minute < minute) buckets.delete(key)
      const bucket = buckets.get(ip) ?? { minute, count: 0 }
      if (bucket.count >= 30 || buckets.size >= 10000 || active >= maxActive) { res.setHeader('Retry-After', '10'); throw reject('Routing is busy. Please retry shortly.', 429) }
      bucket.count++; buckets.set(ip, bucket); active++
      try {
        if (action === 'national-route' && clean.mode === 'transit' && clean.routingDataMode === 'realtime') clean.realtimeSnapshot = await live().catch(() => undefined)
        const response = await local(pathname, { method: 'POST', body: JSON.stringify(clean), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]) })
        json(res, 200, publicJson(await response.json()))
      } finally { active-- }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status ?? 503, { error: error.status ? error.message : 'Routing is temporarily unavailable. Please retry.' })
      else res.end()
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.maxConnections = 64
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
  const server = createPublicRoutingGateway(config)
  server.listen(config.port ?? 8788, '127.0.0.1', () => console.log(`Public routing gateway listening on ${JSON.stringify(server.address())}`))
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
