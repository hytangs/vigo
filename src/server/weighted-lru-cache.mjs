export class WeightedLruCache {
  constructor({
    maxEntries,
    maxSegments = Number.POSITIVE_INFINITY,
    maxBytes = Number.POSITIVE_INFINITY,
  }) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 1))
    this.maxSegments = Math.max(1, Math.floor(Number(maxSegments) || 1))
    this.maxBytes = Math.max(1, Math.floor(Number(maxBytes) || 1))
    this.entries = new Map()
    this.segments = 0
    this.estimatedBytes = 0
    this.evictions = 0
    this.rejections = 0
  }

  get size() {
    return this.entries.size
  }

  get(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value, weight = {}) {
    this.delete(key)
    const segments = Math.max(0, Math.floor(Number(weight.segments) || 0))
    const bytes = Math.max(0, Math.floor(Number(weight.bytes) || 0))
    if (segments > this.maxSegments || bytes > this.maxBytes) {
      this.rejections += 1
      return false
    }
    while (
      this.entries.size >= this.maxEntries
      || this.segments + segments > this.maxSegments
      || this.estimatedBytes + bytes > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.delete(oldestKey)
      this.evictions += 1
    }
    this.entries.set(key, { value, segments, bytes })
    this.segments += segments
    this.estimatedBytes += bytes
    return true
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    this.entries.delete(key)
    this.segments -= entry.segments
    this.estimatedBytes -= entry.bytes
    return true
  }

  clear() {
    this.entries.clear()
    this.segments = 0
    this.estimatedBytes = 0
    this.evictions = 0
    this.rejections = 0
  }

  snapshot() {
    return {
      entries: this.entries.size,
      segments: this.segments,
      estimatedBytes: this.estimatedBytes,
      maxEntries: this.maxEntries,
      maxSegments: this.maxSegments,
      maxBytes: this.maxBytes,
      evictions: this.evictions,
      rejections: this.rejections,
    }
  }
}
