import { rankAddressResults } from './address-index.mjs'

/** Local City lookup with bounded Photon fallback. Clients cannot select upstream URLs. */
const cache = new Map()
let active = 0
export function validBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90
    && bounds[0] < bounds[2] && bounds[1] < bounds[3]
}
export async function searchAddresses(query, bounds, { fetcher = fetch, endpoint = 'https://photon.komoot.io/api/', signal, index, center, remote = true } = {}) {
  signal?.throwIfAborted()
  if (typeof query !== 'string' || query.trim().length < 3 || query.length > 160) throw Object.assign(Error('Enter an address or place between 3 and 160 characters.'), { status: 400, statusCode: 400 })
  if (bounds && !validBounds(bounds)) throw Error('Invalid address search bounds.')
  const local = await index?.search(query, { signal })
  signal?.throwIfAborted()
  if (local?.length || !remote) return { results: local ?? [], attribution: '© OpenStreetMap contributors', source: 'local' }
  const key = JSON.stringify([endpoint, bounds, center, query.trim().toLowerCase()])
  const saved = cache.get(key)
  if (saved && Date.now() - saved.at < 3600000) return saved.value
  if (active >= 2) throw Object.assign(Error('Address search is busy. Try again shortly.'), { status: 429, statusCode: 429 })
  const url = new URL(endpoint)
  url.searchParams.set('q', query.trim()); url.searchParams.set('limit', '12'); url.searchParams.set('lang', 'en')
  if (bounds) {
    url.searchParams.set('bbox', bounds.join(','))
    url.searchParams.set('lon', String(center?.[0] ?? (bounds[0] + bounds[2]) / 2))
    url.searchParams.set('lat', String(center?.[1] ?? (bounds[1] + bounds[3]) / 2))
  }
  active++
  try {
    const timeout = AbortSignal.timeout(8000)
    const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: 'application/json' }, redirect: 'error' })
    if (!response.ok) throw Error('Geocoder unavailable')
    const data = await response.json()
    signal?.throwIfAborted()
    const candidates = []
    for (const feature of (Array.isArray(data.features) ? data.features : []).slice(0, 20)) {
      const c = feature.geometry?.coordinates, p = feature.properties ?? {}
      if (feature.geometry?.type !== 'Point' || !Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)
        || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90 || bounds && (c[0] < bounds[0] || c[0] > bounds[2] || c[1] < bounds[1] || c[1] > bounds[3])) continue
      const street = [p.housenumber, p.street].filter(Boolean).join(' ')
      const label = String(p.name || street || p.city || p.district || '').slice(0, 180)
      if (!label) continue
      candidates.push({ label, address: street, locality: p.city || p.district || p.state || '', postcode: p.postcode,
        kind: p.type === 'street' || p.osm_key === 'highway' ? 'street' : !p.name && street ? 'address' : 'place', coordinate: c })
    }
    const value = { results: rankAddressResults(candidates, query, { center }), attribution: 'Photon · © OpenStreetMap contributors', source: 'photon' }
    if (cache.size >= 500) cache.delete(cache.keys().next().value)
    cache.set(key, { at: Date.now(), value })
    return value
  } catch {
    signal?.throwIfAborted()
    throw Object.assign(Error('Address search is temporarily unavailable. Try again or pick on the map.'), { status: 503, statusCode: 503 })
  } finally { active-- }
}
