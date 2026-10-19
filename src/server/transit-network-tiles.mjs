import crypto from 'node:crypto'
import packageJson from '../../package.json' with { type: 'json' }
import {
  registerNativeTransitNetwork,
  releaseNativeTransitNetwork,
  renderNativeTransitNetworkTile,
} from './native-routing-kernel.mjs'

// The Studio draws a City's transit network from vector tiles rendered by the
// Rust kernel. Opening a City therefore needs only the route and stop catalog;
// route geometry stays on the server and arrives tile by tile.

export const bundleNetworkScope = '__bundle__'
const tileSchemaVersion = 'vigo.network-tiles.v1'
const uiScopeDelimiter = '::'
const notRegistered = 'TRANSIT_NETWORK_NOT_REGISTERED'
const maxRegisteredNetworks = 8
const boundsCache = new Map()

// Mirrors the Studio's scopedEntityId: a bundle prefixes every id with its feed.
function scopedEntityId(feedId, localId = '') {
  const index = localId.indexOf(uiScopeDelimiter)
  if (index > 0 && localId.slice(0, index) === feedId) return localId
  const local = index > 0 ? localId.slice(index + uiScopeDelimiter.length) : localId
  return `${feedId}${uiScopeDelimiter}${local || 'unknown'}`
}

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function scopeFeeds(project, scope) {
  return scope === bundleNetworkScope
    ? project.feeds ?? []
    : (project.feeds ?? []).filter((feed) => feed.id === scope)
}

function revisionOf(project, feeds) {
  const feedIdentity = (feed) => [feed.id, feed.name, feed.importedAt, feed.routingStore?.builtAt, feed.routeCount, feed.stopCount]
    .map((value) => value ?? '')
    .join(':')
  return crypto.createHash('sha256')
    .update([tileSchemaVersion, packageJson.version, project.routingStore?.builtAt ?? '', ...feeds.map(feedIdentity)].join('|'))
    .digest('hex')
    .slice(0, 16)
}

function networkScopes(project) {
  const feeds = project.feeds ?? []
  return [[bundleNetworkScope, feeds], ...feeds.map((feed) => [feed.id, [feed]])]
}

/**
 * Tile revision of every scope the Studio can show: the whole City and each
 * feed. A routing store rebuild, feed import or rename, or a new engine
 * version changes it, so tiles under one revision are immutable.
 */
export function transitNetworkRevisions(project) {
  return Object.fromEntries(networkScopes(project).map(([scope, feeds]) => [scope, revisionOf(project, feeds)]))
}

/**
 * The extent the Network view frames: every route vertex and stop, less the
 * outer 2% on each axis so a few distant stops cannot pull the camera away.
 * The Studio computed exactly this from route GeoJSON it no longer receives.
 */
function networkBounds(feeds) {
  let capacity = 0
  for (const feed of feeds) {
    for (const route of feed.mapPreview?.routes ?? []) capacity += route.coordinates?.length ?? 0
    capacity += feed.mapPreview?.stops?.length ?? 0
  }
  const longitudes = new Float64Array(capacity)
  const latitudes = new Float64Array(capacity)
  let count = 0
  const add = (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return
    longitudes[count] = lon
    latitudes[count] = lat
    count += 1
  }
  for (const feed of feeds) {
    for (const route of feed.mapPreview?.routes ?? []) {
      for (const coordinate of route.coordinates ?? []) add(coordinate[0], coordinate[1])
    }
    for (const stop of feed.mapPreview?.stops ?? []) add(stop.lon, stop.lat)
  }
  if (!count) return null
  const lon = longitudes.subarray(0, count).sort()
  const lat = latitudes.subarray(0, count).sort()
  const trim = count >= 500 ? Math.floor(count * 0.02) : 0
  return [[lon[trim], lat[trim]], [lon[count - trim - 1], lat[count - trim - 1]]]
}

/** A scope's framing is fixed for its revision; compute it once per revision. */
function cachedNetworkBounds(project, revision, feeds) {
  const key = `${project.id}\u001f${revision}`
  if (!boundsCache.has(key)) {
    boundsCache.set(key, networkBounds(feeds))
    while (boundsCache.size > 32) boundsCache.delete(boundsCache.keys().next().value)
  }
  return boundsCache.get(key)
}

function catalogRoute({ coordinates: _coordinates, points: _points, stopIds: _stopIds, scheduledTrips: _trips, ...route }) {
  return { ...route, points: [], stopIds: [] }
}

function catalogStop({ x: _x, y: _y, ...stop }) {
  return stop
}

/**
 * The project a Studio opens: metadata plus the route and stop catalog,
 * without route geometry, stop sequences or stop pairs. Per-route detail
 * comes from gtfs-route-analysis when a route is focused.
 */
export function transitNetworkCatalog(project) {
  return {
    ...project,
    feeds: (project.feeds ?? []).map((feed) => feed.mapPreview
      ? {
          ...feed,
          routeMetrics: [],
          stopMetrics: [],
          mapPreview: {
            ...feed.mapPreview,
            routes: (feed.mapPreview.routes ?? []).map(catalogRoute),
            stops: (feed.mapPreview.stops ?? []).map(catalogStop),
            stopPairs: [],
          },
        }
      : feed),
    networkTiles: Object.fromEntries(networkScopes(project).map(([scope, feeds]) => {
      const revision = revisionOf(project, feeds)
      return [scope, { revision, bounds: cachedNetworkBounds(project, revision, feeds) }]
    })),
  }
}

/**
 * The records the kernel indexes for one scope, with the ids, names and
 * fallback geometry the Studio's GeoJSON builder used, so tiles carry the
 * same feature identities the map selects by.
 */
export function transitNetworkInput(project, scope) {
  const routes = []
  const stops = []
  for (const feed of scopeFeeds(project, scope)) {
    const preview = feed.mapPreview
    if (!preview) continue
    const scoped = scope === bundleNetworkScope
    const entityId = (value) => scoped ? scopedEntityId(feed.id, value) : value
    const stopsById = new Map((preview.stops ?? []).map((stop) => [stop.id, stop]))
    for (const route of preview.routes ?? []) {
      const coordinates = route.coordinates?.length >= 2
        ? route.coordinates
        : (route.stopIds ?? [])
          .map((stopId) => stopsById.get(stopId))
          .filter((stop) => typeof stop?.lon === 'number' && typeof stop?.lat === 'number')
          .map((stop) => [stop.lon, stop.lat])
      const id = scoped ? scopedEntityId(feed.id, route.id) : route.id
      routes.push({
        featureId: id || route.patternId || route.routeId || route.shortName || '',
        routeId: route.routeId ?? id ?? '',
        patternId: entityId(route.patternId ?? route.id) ?? '',
        directionId: route.directionId ?? '',
        shortName: route.shortName ?? '',
        longName: scoped ? `${feed.name} / ${route.longName}` : route.longName ?? '',
        color: route.color ?? '',
        routeType: Number.isInteger(route.routeType) ? route.routeType : undefined,
        tripCount: finite(route.tripCount),
        status: route.status ?? '',
        headwayMinutes: finite(route.headwayMinutes),
        spanHours: finite(route.spanHours),
        stopCount: finite(route.stopCount),
        serviceHours: finite(route.serviceHours),
        serviceShare: finite(route.serviceShare),
        frequencyClass: route.frequencyClass ?? 'low',
        geometrySource: route.geometrySource ?? (route.coordinates?.length ? 'shape' : 'stop_sequence'),
        distanceKm: Number.isFinite(route.distanceKm) ? route.distanceKm : undefined,
        scheduledSpeedKph: finite(route.scheduledSpeedKph),
        coordinates,
      })
    }
    for (const stop of preview.stops ?? []) {
      if (!Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) continue
      stops.push({
        stopId: entityId(stop.id),
        lon: stop.lon,
        lat: stop.lat,
        routeCount: stop.routes?.length ?? 0,
        tripCount: finite(stop.tripCount),
        transferScore: finite(stop.transferScore),
      })
    }
  }
  return { routes, stops }
}

/**
 * Registers each City scope with the kernel once per revision and renders
 * its tiles. Concurrent tile requests for an unregistered scope share one
 * registration.
 */
export function createTransitNetworkTiles({ readProject }) {
  const registered = new Map()
  const lookups = new Map()
  const invalidated = () => Object.assign(new Error('The City changed while loading its network. Retry with the current City.'), { statusCode: 409 })

  function forget(id) {
    const entry = registered.get(id)
    if (!entry) return
    registered.delete(id)
    releaseNativeTransitNetwork(entry.key)
  }

  async function refresh(projectId, scope, id, pending) {
    const project = await readProject(projectId)
    if (pending.canceled) throw invalidated()
    const revision = transitNetworkRevisions(project)[scope]
    if (!revision) {
      const error = new Error('This City has no transit feed with that id.')
      error.statusCode = 404
      throw error
    }
    const current = registered.get(id)
    if (current?.revision === revision) return current
    const key = `${id}\u001f${revision}\u001f${crypto.randomUUID()}`
    await registerNativeTransitNetwork(key, JSON.stringify(transitNetworkInput(project, scope)))
    if (pending.canceled) {
      releaseNativeTransitNetwork(key)
      throw invalidated()
    }
    forget(id)
    const entry = { key, revision }
    registered.set(id, entry)
    while (registered.size > maxRegisteredNetworks) forget(registered.keys().next().value)
    return entry
  }

  function network(projectId, scope, requestedRevision) {
    const id = `${projectId}\u001f${scope}`
    const known = registered.get(id)
    if (known && requestedRevision && known.revision === requestedRevision) {
      // Keep recently drawn Cities registered longest.
      registered.delete(id)
      registered.set(id, known)
      return Promise.resolve(known)
    }
    let lookup = lookups.get(id)
    if (!lookup) {
      lookup = { canceled: false }
      const pending = lookup
      lookup.promise = refresh(projectId, scope, id, pending).finally(() => {
        if (lookups.get(id) === pending) lookups.delete(id)
      })
      lookups.set(id, lookup)
    }
    return lookup.promise
  }

  return {
    /** MVT bytes for z/x/y and whether they belong to the requested revision. */
    async tile(projectId, scope, requestedRevision, z, x, y) {
      let entry = await network(projectId, scope, requestedRevision)
      let bytes
      try {
        bytes = await renderNativeTransitNetworkTile(entry.key, z, x, y)
      } catch (error) {
        if (!String(error?.message ?? '').includes(notRegistered)) throw error
        registered.delete(`${projectId}\u001f${scope}`)
        entry = await network(projectId, scope, requestedRevision)
        bytes = await renderNativeTransitNetworkTile(entry.key, z, x, y)
      }
      return { bytes, current: entry.revision === requestedRevision }
    },
    invalidate(projectId) {
      for (const [id, pending] of lookups) {
        if (id.startsWith(`${projectId}\u001f`)) { pending.canceled = true; lookups.delete(id) }
      }
      for (const id of [...registered.keys()]) {
        if (id.startsWith(`${projectId}\u001f`)) forget(id)
      }
    },
  }
}
