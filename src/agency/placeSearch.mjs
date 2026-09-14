import { setTimeout as pause } from 'node:timers/promises'
import { endpointFacts } from './runtimeFacts.mjs'

// Only explicit place queries leave the server. No conversation, staff notes,
// feed URLs, or model credentials are sent to the geocoder.
let nextRequestAt = 0
const clean = (value) => typeof value === 'string' ? value.trim().slice(0, 200) : ''
const validPoint = (lon, lat) => Number.isFinite(lon) && Math.abs(lon) <= 180 && Number.isFinite(lat) && Math.abs(lat) <= 90

export function createPlaceSearch({ stops = [], env = process.env, fetchImpl = fetch, clock = Date.now } = {}) {
  const endpoint = env.VIGO_AGENCY_PLACE_SEARCH_URL ?? 'https://photon.komoot.io/api/'
  const enabled = endpoint !== 'off'
  // Internal pathway nodes need not have geographic coordinates in GTFS.
  // Use the declared stops/stations, without guessing away zero coordinates.
  const bounds = stops.filter(stop => [0, 1].includes(Number(stop.location_type ?? 0))).reduce((box, { lon, lat }) => validPoint(lon, lat)
    ? [Math.min(box[0], lon), Math.min(box[1], lat), Math.max(box[2], lon), Math.max(box[3], lat)] : box, [Infinity, Infinity, -Infinity, -Infinity])
  const hasBounds = bounds.every(Number.isFinite) && bounds[0] < bounds[2] && bounds[1] < bounds[3]
  const cache = new Map(), places = new Map()
  return {
    enabled,
    endpoint: enabled ? endpointFacts(endpoint).endpoint : null,
    resolve(id) {
      const match = places.get(id)
      if (!match) throw new Error('Search for this place again before routing; its location is not in the current City session.')
      return match
    },
    async search({ query, near, withinCity = true }, signal) {
      if (!enabled) throw new Error('Online place search is off on this server. Set VIGO_AGENCY_PLACE_SEARCH_URL to a Photon endpoint to enable it.')
      if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Use a place name or address of 1–200 characters.')
      const url = new URL(endpoint)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Configure a valid HTTP(S) Photon endpoint without embedded credentials.')
      url.searchParams.set('q', query.trim())
      url.searchParams.set('limit', '5')
      if (withinCity && hasBounds) url.searchParams.set('bbox', bounds.join(','))
      const center = near ?? (hasBounds ? { lon: (bounds[0] + bounds[2]) / 2, lat: (bounds[1] + bounds[3]) / 2 } : null)
      if (center && validPoint(center.lon, center.lat)) { url.searchParams.set('lon', String(center.lon)); url.searchParams.set('lat', String(center.lat)) }
      const key = url.href, cached = cache.get(key)
      signal?.throwIfAborted()
      const remember = (data) => {
        for (const match of data.matches) { places.delete(match.id); places.set(match.id, match) }
        while (places.size > 256) places.delete(places.keys().next().value)
        return structuredClone(data)
      }
      if (cached && clock() - Date.parse(cached.searchedAt) < 15 * 60_000) return remember(cached)
      const startAt = Math.max(Date.now(), nextRequestAt)
      nextRequestAt = startAt + 1000 // Moderate use of the public demo, shared across City sessions.
      await pause(Math.max(0, startAt - Date.now()), undefined, { signal })
      const timeout = AbortSignal.timeout(12_000)
      let response
      try {
        response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'VIGO-Agency (https://github.com/vigo-developers/vigo-agency)' } })
      } catch (error) {
        signal?.throwIfAborted()
        throw new Error(timeout.aborted ? 'Place search timed out. Please retry.' : 'The place search service could not be reached. Please retry.', { cause: error })
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Place search is unavailable (HTTP ${response.status}). Please retry later.`) }
      if (!response.body) throw new Error('Place search returned an empty response.')
      const reader = response.body.getReader(), chunks = []
      let bytes = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 256 * 1024) throw new Error('Place search returned too much data. Use a more specific address.')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      let payload
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Place search returned an unreadable result.') }
      if (!Array.isArray(payload?.features)) throw new Error('Place search returned an unreadable result.')
      const matches = [], seen = new Set()
      for (const feature of payload.features.slice(0, 5)) {
        const p = feature?.properties ?? {}, [lon, lat] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : []
        const type = { N: 'node', W: 'way', R: 'relation' }[p.osm_type]
        if (feature?.geometry?.type !== 'Point' || !validPoint(lon, lat) || !type || !Number.isSafeInteger(p.osm_id) || p.osm_id <= 0) continue
        if (withinCity && hasBounds && (lon < bounds[0] || lon > bounds[2] || lat < bounds[1] || lat > bounds[3])) continue
        const id = `osm:${type}/${p.osm_id}`
        if (seen.has(id)) continue
        seen.add(id)
        const street = [clean(p.housenumber), clean(p.street)].filter(Boolean).join(' ')
        const address = [...new Set([street, clean(p.district), clean(p.city), clean(p.state), clean(p.postcode), clean(p.country)].filter(Boolean))].join(', ')
        const name = clean(p.name) || street || address
        matches.push({ kind: 'place', id, name, label: [...new Set([name, street || clean(p.city)].filter(Boolean))].join(' · '), address, lat, lon, sourceUrl: `https://www.openstreetmap.org/${type}/${p.osm_id}` })
      }
      if (payload.features.length && !matches.length) throw new Error('Place search returned no usable location coordinates.')
      const data = { query: query.trim(), searchedAt: new Date(clock()).toISOString(), searchArea: withinCity && hasBounds ? 'Current City stop coverage bounds' : 'Worldwide, with a location preference', matches,
        attribution: '© OpenStreetMap contributors · Photon', coverage: 'Up to five OpenStreetMap matches, not a complete business directory. An empty result does not establish that a place does not exist. Addresses and map points do not verify opening hours or accessible entrances.',
        ...(!matches.length ? { nextStep: 'Look up the business street address in an available public source, then geocode that verified address. Do not repeat the same search or substitute a different business.' } : {}) }
      cache.set(key, data)
      while (cache.size > 100) cache.delete(cache.keys().next().value)
      return remember(data)
    },
  }
}
