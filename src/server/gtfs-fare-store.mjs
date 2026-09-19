import { gtfsTableEntry, streamGtfsZipCsv } from './gtfs-zip-reader.mjs'
import { quoteBoardingFare, fareNeedsScheduledTime } from '../fares.mjs'
import { WeightedLruCache } from './weighted-lru-cache.mjs'

// Kept separate from the routing graph: fare data never changes path selection.
const fareTables = ['fare_attributes', 'fare_rules', 'fare_products', 'fare_media',
  'rider_categories', 'fare_leg_rules', 'fare_leg_join_rules', 'fare_transfer_rules',
  'timeframes', 'areas', 'stop_areas', 'networks', 'route_networks']
const contextFields = {
  agency: ['agency_id', 'agency_name', 'agency_fare_url', 'agency_timezone'],
  routes: ['route_id', 'agency_id', 'network_id'],
  stops: ['stop_id', 'parent_station', 'zone_id', 'stop_timezone'],
  calendar: ['service_id', 'start_date', 'end_date', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
  calendar_dates: ['service_id', 'date', 'exception_type'],
}
const catalogsByDatabase = new WeakMap()
const missingFare = Object.freeze({ status: 'unavailable', code: 'missing_catalog', reason: 'Fare data was not imported with this timetable.' })
const invalidFare = Object.freeze({ status: 'unavailable', code: 'invalid_data', reason: 'The saved fare data could not be read. Your route is still available.' })

function databaseState(db) {
  let state = catalogsByDatabase.get(db)
  if (!state) {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE name='fare_catalogs' AND type='table'").get()
    state = { scopes: new Set(present ? db.prepare('SELECT scope FROM fare_catalogs').all().map(row => row.scope) : []),
      catalogQuery: present ? db.prepare('SELECT data FROM fare_catalogs WHERE scope=?') : null,
      catalogs: new WeightedLruCache({ maxEntries: 8, maxBytes: 32 * 1024 * 1024 }),
      trips: new WeightedLruCache({ maxEntries: 128, maxBytes: 2 * 1024 * 1024 }), tripQuery: null, plans: new WeakMap() }
    catalogsByDatabase.set(db, state)
  }
  return state
}

function catalogForScope(state, scope) {
  if (!state.scopes.has(scope)) return null
  let catalog = state.catalogs.get(scope)
  if (!catalog) {
    let bytes = 128
    try {
      const raw = state.catalogQuery.get(scope)?.data
      if (typeof raw !== 'string' || raw.length > 16 * 1024 * 1024) throw new Error('Invalid fare catalog size.')
      catalog = JSON.parse(raw)
      if (catalog?.version !== 1 || !catalog.tables) throw new Error('Invalid fare catalog.')
      bytes = raw.length * 2
    } catch { catalog = { version: 1, tables: {}, unavailableReason: invalidFare.reason } }
    state.catalogs.set(scope, catalog, { bytes })
  }
  return catalog
}

// Find a unique contiguous stop sequence in linear time, including loop routes.
function uniqueSequenceOffset(values, pattern) {
  const prefix = new Array(pattern.length).fill(0)
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j && pattern[i] !== pattern[j]) j = prefix[j - 1]
    if (pattern[i] === pattern[j]) j++
    prefix[i] = j
  }
  let found = -1
  for (let i = 0, j = 0; i < values.length; i++) {
    while (j && values[i] !== pattern[j]) j = prefix[j - 1]
    if (values[i] === pattern[j]) j++
    if (j === pattern.length) {
      if (found !== -1) return -1
      found = i - j + 1
      j = prefix[j - 1]
    }
  }
  return found
}

function scheduledFareLeg(db, state, leg) {
  if (leg.scheduleMode !== 'realtime-adjusted' || !leg.tripId || !(leg.stopIds?.length >= 2)) return leg
  let connections = state.trips.get(leg.tripId)
  if (!connections) {
    state.tripQuery ??= db.prepare('SELECT departure, arrival, from_stop_id, to_stop_id FROM connections WHERE trip_id=? ORDER BY stop_sequence LIMIT 4097')
    const rows = state.tripQuery.all(leg.tripId)
    connections = rows.length > 4096 ? [] : rows
    state.trips.set(leg.tripId, connections, { bytes: JSON.stringify(connections).length * 2 })
  }
  if (!connections.length || connections.some((row, i) => i && row.from_stop_id !== connections[i - 1].to_stop_id)) return leg
  const sequence = [connections[0].from_stop_id, ...connections.map(row => row.to_stop_id)]
  const offset = uniqueSequenceOffset(sequence, leg.stopIds)
  return offset < 0 ? leg : { ...leg, scheduleMode: 'exact', startMinutes: connections[offset].departure / 60,
    endMinutes: connections[offset + leg.stopIds.length - 2].arrival / 60 }
}

export async function readGtfsFareCatalog(archive, { budget } = {}) {
  if (!['fare_products', 'fare_attributes'].some(name => gtfsTableEntry(archive, `${name}.txt`))) return null
  const tables = {}
  let bytes = 0
  let overflow = false
  for (const name of [...fareTables, ...Object.keys(contextFields)]) {
    const entry = gtfsTableEntry(archive, `${name}.txt`)
    if (!entry) continue
    tables[name] = []
    const fareServices = new Set((tables.timeframes ?? []).map(row => row.service_id))
    await streamGtfsZipCsv(archive, entry, row => {
      if (['calendar', 'calendar_dates'].includes(name) && !fareServices.has(row.service_id)) return
      const fields = contextFields[name] ?? Object.keys(row)
      const item = Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))
      if (!overflow) {
        bytes += Buffer.byteLength(JSON.stringify(item))
        overflow = bytes > 16 * 1024 * 1024
        if (!overflow) tables[name].push(item)
      }
    }, { budget })
    if (overflow) return { version: 1, tables: {}, unavailableReason: 'Fare references exceed the supported catalog size. Boarding prices are unavailable.' }
  }
  return { version: 1, source: archive.zipPath.split(/[\\/]/).at(-1), tables }
}

export function writeGtfsFareCatalog(db, catalog, scope = '') {
  if (!catalog) return
  db.exec('CREATE TABLE IF NOT EXISTS fare_catalogs(scope TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID')
  db.prepare('INSERT OR REPLACE INTO fare_catalogs VALUES(?,?)').run(scope, JSON.stringify(catalog))
  catalogsByDatabase.delete(db)
}

export function copyGtfsFareCatalogs(db, alias, scope) {
  // alias is an internal SQLite attachment name, never request input.
  if (!/^source_\d+$/.test(alias)) throw new Error('Invalid fare catalog source.')
  if (!db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE name='fare_catalogs' AND type='table'`).get()) return
  for (const row of db.prepare(`SELECT scope, data FROM ${alias}.fare_catalogs`).all()) {
    writeGtfsFareCatalog(db, JSON.parse(row.data), row.scope ? `${scope}\u001f${row.scope}` : scope)
  }
}

export function addGtfsFares(db, plan) {
  if (plan?.status !== 'ready' || !plan.legs?.some(leg => leg.type === 'ride')) return plan
  // Optional fare failures must never discard an already-computed journey.
  let state
  try { state = databaseState(db) } catch {
    return { ...plan, legs: plan.legs.map(leg => leg.type === 'ride' ? { ...leg, fare: invalidFare } : leg) }
  }
  if (state.plans.has(plan)) return state.plans.get(plan)
  const legs = plan.legs.map(leg => {
    if (leg.type !== 'ride') return leg
    try {
      const separator = leg.routeId?.lastIndexOf('\u001f') ?? -1
      const scope = separator < 0 ? '' : leg.routeId.slice(0, separator)
      const prefix = scope ? `${scope}\u001f` : ''
      const catalog = catalogForScope(state, scope)
      if (!catalog || (prefix && ![leg.fromStopId, leg.toStopId].every(id => id?.startsWith(prefix)))) return { ...leg, fare: missingFare }
      const unscoped = value => value?.startsWith(prefix) ? value.slice(prefix.length) : value
      const ids = { routeId: unscoped(leg.routeId), fromStopId: unscoped(leg.fromStopId), toStopId: unscoped(leg.toStopId) }
      const scheduled = leg.scheduleMode === 'realtime-adjusted' && fareNeedsScheduledTime(catalog, ids) ? scheduledFareLeg(db, state, leg) : leg
      return { ...leg, fare: quoteBoardingFare(catalog, { ...scheduled, ...ids }, plan.diagnostics?.serviceDate) }
    } catch { return { ...leg, fare: invalidFare } }
  })
  const annotated = { ...plan, legs }
  state.plans.set(plan, annotated)
  return annotated
}
