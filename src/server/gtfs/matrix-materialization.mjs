// Request-local reuse. Values already belong to output rows; only keys and map
// entries add retained storage. Copies keep each returned journey independent.
export class MatrixJourneyCache {
  #entries = new Map()
  #keyBytes = 0
  materializations = 0
  reuses = 0

  constructor({ enabled = true, maximumKeyBytes = 1024 * 1024, maximumEntries = 2048 } = {}) {
    this.enabled = enabled
    this.maximumKeyBytes = maximumKeyBytes
    this.maximumEntries = maximumEntries
  }

  materialize(origin, destination, create) {
    // Full points preserve labels and other presentation fields as well as the
    // routing identity. No key allocation on the distinct-endpoint fast path.
    const key = this.enabled ? JSON.stringify([origin, destination]) : null
    if (key !== null && this.#entries.has(key)) {
      this.reuses += 1
      return structuredClone(this.#entries.get(key))
    }
    const journey = create()
    this.materializations += 1
    if (key !== null) {
      const bytes = key.length * 2 + 64
      if (this.#entries.size < this.maximumEntries && bytes <= this.maximumKeyBytes - this.#keyBytes) {
        this.#entries.set(key, journey)
        this.#keyBytes += bytes
      }
    }
    return journey
  }
}
