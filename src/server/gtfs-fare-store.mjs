import { gtfsTableEntry, streamGtfsZipCsv } from './gtfs-zip-reader.mjs'

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
}

export function copyGtfsFareCatalogs(db, alias, scope) {
  // alias is an internal SQLite attachment name, never request input.
  if (!/^source_\d+$/.test(alias)) throw new Error('Invalid fare catalog source.')
  if (!db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE name='fare_catalogs' AND type='table'`).get()) return
  for (const row of db.prepare(`SELECT scope, data FROM ${alias}.fare_catalogs`).all()) {
    writeGtfsFareCatalog(db, JSON.parse(row.data), row.scope ? `${scope}\u001f${row.scope}` : scope)
  }
}
