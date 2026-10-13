import { boundedCacheGet, boundedCacheSet } from '../weighted-lru-cache.mjs'

const maximumCachedDepartures = 64

// Diagnostic schedule metadata, not route answers. Own it with the immutable
// source store; active_services is replaced atomically before its key changes.
// Keep raw SQLite clocks, including fractions, rather than rounded native times.
export function createTransitDepartureLookup(db) {
  const statement = db.prepare(`
    SELECT MIN(connection.departure) AS next_departure
    FROM connections AS connection
    INNER JOIN active_services AS active_service
      ON active_service.service_id = connection.service_id
    WHERE connection.departure >= ? AND connection.departure <= ?
  `)
  const entries = new Map()
  let activeServiceKey
  return (serviceKey, departure) => {
    if (serviceKey !== activeServiceKey) {
      entries.clear()
      activeServiceKey = serviceKey
    }
    const cached = boundedCacheGet(entries, departure)
    if (cached !== undefined) return cached
    const value = statement.get(departure, departure + 24 * 60 * 60)?.next_departure
    const nextDeparture = value == null ? Number.NaN : Number(value)
    const result = Number.isFinite(nextDeparture) ? nextDeparture : null
    boundedCacheSet(entries, departure, result, maximumCachedDepartures)
    return result
  }
}
