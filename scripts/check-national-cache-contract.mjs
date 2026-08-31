import assert from 'node:assert/strict'
import { WeightedLruCache } from '../server/national-gtfs-store.mjs'

const cache = new WeightedLruCache({
  maxEntries: 8,
  maxSegments: 24,
  maxBytes: 4_096,
})

for (let trip = 0; trip < 2_000; trip += 1) {
  const segments = Array.from({ length: 1 + (trip % 7) }, (_, index) => ({
    trip_id: `trip-${trip}`,
    from_stop_id: `stop-${index}`,
    to_stop_id: `stop-${index + 1}`,
    departure: trip * 60 + index,
    arrival: trip * 60 + index + 1,
  }))
  cache.set(`trip-${trip}`, segments, {
    segments: segments.length,
    bytes: segments.length * 192,
  })
}

const snapshot = cache.snapshot()
assert(snapshot.entries <= 8)
assert(snapshot.segments <= 24)
assert(snapshot.estimatedBytes <= 4_096)
assert.equal(snapshot.maxEntries, 8)
assert.equal(snapshot.maxSegments, 24)
assert.equal(snapshot.maxBytes, 4_096)
assert(snapshot.evictions > 0, 'The pressure fixture must exercise weighted LRU eviction.')
assert.equal(cache.get('trip-0'), undefined, 'Old trip arrays must not survive the bounded LRU pressure run.')

cache.set('recent-a', [{ id: 1 }], { segments: 1, bytes: 192 })
cache.set('recent-b', [{ id: 2 }], { segments: 1, bytes: 192 })
assert(cache.get('recent-a'))
for (let index = 0; index < 7; index += 1) {
  cache.set(`new-${index}`, [{ id: index }], { segments: 1, bytes: 192 })
}
assert(cache.get('recent-a'), 'Reading an entry must refresh its recency.')
assert.equal(cache.get('recent-b'), undefined, 'The least-recently-used entry must be evicted first.')

console.log(JSON.stringify({ check: 'national-trip-cache-contract', ...cache.snapshot() }, null, 2))
