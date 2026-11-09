import fs from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { searchAddresses, validBounds } from './address-search.mjs'

// Coverage belongs to the selected City, not the current viewport or a client's
// claimed region. Identity keys also invalidate a replaced/imported data store.
const coverageCache = new Map()
async function identity(filename) {
  try { const s = await fs.stat(filename); return [filename, s.size, s.mtimeMs, s.ctimeMs] } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}
async function cityBounds(streetPath, routingPaths) {
  const snapshot = streetPath ? `${streetPath}.street-accelerator-v7.bin` : null
  const sources = await Promise.all([snapshot, ...routingPaths].map(p => p ? identity(p) : null))
  const key = JSON.stringify(sources)
  if (coverageCache.has(key)) return coverageCache.get(key)
  let bounds
  if (sources[0]) {
    const file = await fs.open(snapshot, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      await file.read(buffer, 0, buffer.length, 0)
      const h = JSON.parse(buffer.toString('utf8').replace(/\0+$/, '').trim())
      if (h.magic === 'vigo.street.accelerator' && h.version === 7) {
        const b = [h.spatialMinLon, h.spatialMinLat,
          h.spatialMinLon + h.spatialColumns * h.spatialCellDegrees,
          h.spatialMinLat + h.spatialRows * h.spatialCellDegrees]
        if (validBounds(b)) bounds = b
      }
    } catch { /* Older Cities can still use their timetable's coverage. */ }
    finally { await file.close() }
  }
  if (!bounds) {
    for (const source of sources.slice(1).filter(Boolean)) {
      const db = new DatabaseSync(source[0], { readOnly: true })
      try {
        const r = db.prepare('SELECT min(lon) AS west,min(lat) AS south,max(lon) AS east,max(lat) AS north FROM stops WHERE lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90').get()
        if (Object.values(r).some(v => !Number.isFinite(v))) continue
        const b = [r.west, r.south, r.east, r.north]
        // A single stop still defines a local search area.
        if (b[0] === b[2]) { b[0] = Math.max(-180, b[0] - .01); b[2] = Math.min(180, b[2] + .01) }
        if (b[1] === b[3]) { b[1] = Math.max(-90, b[1] - .01); b[3] = Math.min(90, b[3] + .01) }
        if (validBounds(b)) bounds = bounds ? [Math.min(bounds[0],b[0]),Math.min(bounds[1],b[1]),Math.max(bounds[2],b[2]),Math.max(bounds[3],b[3])] : b
      } finally { db.close() }
    }
  }
  if (coverageCache.size >= 16) coverageCache.delete(coverageCache.keys().next().value)
  coverageCache.set(key, bounds)
  return bounds
}

export async function searchStudioAddresses(query, { streetPath, routingPaths = [], ...options }) {
  const bounds = await cityBounds(streetPath, routingPaths)
  if (!bounds) throw Object.assign(Error('Import a street map or timetable to search within this City.'), { statusCode: 409 })
  return searchAddresses(query, bounds, options)
}
