import { DatabaseSync } from 'node:sqlite'

// Desktop previews qualify IDs with ::; merged timetables use the GTFS scope
// separator. Resolve against the chosen store before granting exact-stop access.
export function normalizeRoutingPointIdentities(storePath, request, localFeedId = '') {
  const fields = ['origin', 'destination', 'waypoints', 'origins', 'destinations']
  const points = fields.flatMap(field => Array.isArray(request?.[field]) ? request[field] : [request?.[field]])
  let db
  let lookup
  let merged = false
  if (points.some(point => point?.source !== 'map' && String(point?.stopId ?? '').trim())) {
    db = new DatabaseSync(storePath, { readOnly: true })
    try {
      lookup = db.prepare('SELECT stop_id FROM stops WHERE stop_id = ?')
      const sources = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key = 'sourceStores'").get()?.value ?? '[]')
      merged = Array.isArray(sources) && sources.some(source => String(source?.scope ?? '').trim())
    } catch (error) {
      db.close()
      throw error
    }
  }
  function pointIdentity(point) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) return point
    const stopId = String(point.stopId ?? '').trim()
    if (!stopId) return point
    const { stopId: _stopId, ...coordinatePoint } = point
    if (point.source === 'map') return coordinatePoint
    // GTFS IDs are opaque and may themselves contain either delimiter. An
    // existing exact record wins before interpreting a desktop namespace.
    if (lookup?.get(stopId)) return { ...point, stopId }
    const uiSeparator = stopId.indexOf('::')
    const storeSeparator = stopId.indexOf('\u001f')
    const separator = storeSeparator > 0 ? storeSeparator : uiSeparator
    const scope = separator > 0 ? stopId.slice(0, separator) : ''
    const localId = separator > 0 ? stopId.slice(separator + (storeSeparator > 0 ? 1 : 2)) : stopId
    const candidate = scope
      ? merged ? `${scope}\u001f${localId}` : scope === localFeedId ? localId : ''
      : stopId
    if (candidate && lookup?.get(candidate)) return { ...point, stopId: candidate }
    // A foreign or missing stop remains the requested place. Never borrow an
    // identically named stop from another feed during a comparison.
    return { ...coordinatePoint, source: 'map' }
  }
  try {
    const normalized = { ...request }
    for (const field of fields) {
      if (!Object.hasOwn(request ?? {}, field)) continue
      normalized[field] = Array.isArray(request[field])
        ? request[field].map(pointIdentity)
        : pointIdentity(request[field])
    }
    return normalized
  } finally {
    db?.close()
  }
}
