import { gtfsTableEntry, streamGtfsZipCsv } from './gtfs-zip-reader.mjs'
import { quoteBoardingFare } from '../fares.mjs'

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
const scheduledTripsByDatabase = new WeakMap()

function scheduledFareLeg(db, leg) {
  if (leg.scheduleMode !== 'realtime-adjusted' || !leg.tripId || !(leg.stopIds?.length >= 2)) return leg
  let statement = scheduledTripsByDatabase.get(db)
  if (!statement) {
    statement = db.prepare('SELECT departure, arrival, from_stop_id, to_stop_id FROM connections WHERE trip_id=? ORDER BY stop_sequence')
    scheduledTripsByDatabase.set(db, statement)
  }
  const connections = statement.all(leg.tripId)
  const matches = connections.flatMap((first, offset) => {
    const segment = connections.slice(offset, offset + leg.stopIds.length - 1)
    if (first.from_stop_id !== leg.stopIds[0] || segment.length !== leg.stopIds.length - 1
      || segment.some((item, i) => item.from_stop_id !== leg.stopIds[i] || item.to_stop_id !== leg.stopIds[i + 1])) return []
    return [{ ...leg, scheduleMode: 'exact', startMinutes: first.departure / 60, endMinutes: segment.at(-1).arrival / 60 }]
  })
  // Repeated stop sequences are ambiguous. Do not guess which timed fare applies.
  return matches.length === 1 ? matches[0] : leg
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
  let catalogs = catalogsByDatabase.get(db)
  if (!catalogs) {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE name='fare_catalogs' AND type='table'").get()
    catalogs = present ? db.prepare('SELECT scope, data FROM fare_catalogs').all().map(row => ({ scope: row.scope, catalog: JSON.parse(row.data) })) : []
    catalogsByDatabase.set(db, catalogs)
  }
  const legs = plan.legs.map(leg => {
    if (leg.type !== 'ride') return leg
    const matches = catalogs.filter(({ scope }) => scope ? leg.routeId?.startsWith(`${scope}\u001f`) : !leg.routeId?.includes('\u001f'))
    const entry = matches.length === 1 ? matches[0] : null
    const prefix = entry?.scope ? `${entry.scope}\u001f` : ''
    const unscoped = value => value?.startsWith(prefix) ? value.slice(prefix.length) : value
    const sameScope = !prefix || [leg.fromStopId, leg.toStopId].every(id => id?.startsWith(prefix))
    const fare = entry && sameScope ? quoteBoardingFare(entry.catalog, {
      ...scheduledFareLeg(db, leg), routeId: unscoped(leg.routeId), fromStopId: unscoped(leg.fromStopId), toStopId: unscoped(leg.toStopId),
    }, plan.diagnostics?.serviceDate) : { status: 'unavailable', reason: 'Fare data was not imported with this timetable.' }
    return { ...leg, fare }
  })
  return { ...plan, legs }
}
