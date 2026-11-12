import fs from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { searchAddresses, validBounds } from './address-search.mjs'
import { readerBusyTimeoutMs } from './sqlite-readers.mjs'

// A street snapshot's coverage fits in its 4 KiB header. Read it directly:
// a same-size rewrite can retain the old timestamps on some filesystems.
async function streetBounds(streetPath) {
  if (!streetPath) return null
  let file
  try {
    file = await fs.open(`${streetPath}.street-accelerator-v7.bin`, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const header = JSON.parse(buffer.toString('utf8', 0, bytesRead).replace(/\0+$/, '').trim())
    if (header.magic !== 'vigo.street.accelerator' || header.version !== 7) return null
    const { spatialMinLon: west, spatialMinLat: south, spatialColumns, spatialRows, spatialCellDegrees } = header
    const bounds = [west, south, west + spatialColumns * spatialCellDegrees, south + spatialRows * spatialCellDegrees]
    return validBounds(bounds) ? bounds : null
  } catch {
    return null
  } finally {
    await file.close()
  }
}

const timetableCoverage = new Map()
async function timetableBounds(routingPaths) {
  const sources = (await Promise.all(routingPaths.filter(Boolean).map(async filename => {
    try {
      const stat = await fs.stat(filename, { bigint: true })
      return [filename, `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`]
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }))).filter(Boolean)
  const key = JSON.stringify(sources)
  if (timetableCoverage.has(key)) return timetableCoverage.get(key)
  let bounds
  for (const [filename] of sources) {
    const db = new DatabaseSync(filename, { readOnly: true, timeout: readerBusyTimeoutMs })
    try {
      const { west, south, east, north } = db.prepare(
        'SELECT min(lon) AS west,min(lat) AS south,max(lon) AS east,max(lat) AS north FROM stops WHERE lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90',
      ).get()
      if (![west, south, east, north].every(Number.isFinite)) continue
      // A single stop still defines a local search area.
      const b = [
        west === east ? Math.max(-180, west - .01) : west,
        south === north ? Math.max(-90, south - .01) : south,
        west === east ? Math.min(180, east + .01) : east,
        south === north ? Math.min(90, north + .01) : north,
      ]
      if (validBounds(b)) bounds = bounds
        ? [Math.min(bounds[0], b[0]), Math.min(bounds[1], b[1]), Math.max(bounds[2], b[2]), Math.max(bounds[3], b[3])]
        : b
    } finally { db.close() }
  }
  if (timetableCoverage.size >= 16) timetableCoverage.delete(timetableCoverage.keys().next().value)
  timetableCoverage.set(key, bounds)
  return bounds
}

export async function searchStudioAddresses(query, { streetPath, routingPaths = [], ...options }) {
  const bounds = await streetBounds(streetPath) ?? await timetableBounds(routingPaths)
  if (!bounds) throw Object.assign(Error('Import a street map or timetable to search within this City.'), { statusCode: 409 })
  return searchAddresses(query, bounds, options)
}
