import { gtfsTableEntry, readGtfsZipJson } from '../gtfs-zip-reader.mjs'

// Optional source tables remain separate from scheduled connection records.
// The importer retains service semantics; Rust resolves geometry, clocks and
// conditional booking metadata at query time. No synthetic scheduled departures.
//
// The catalog is optional and resident at query time, so it has a fixed budget.
// Fixed-route trips (continuous stopping, phone-booked stops) keep their
// scheduled import; past the budget they leave the catalog first, then
// on-demand trips. The build succeeds and reports what was omitted.
export const flexCatalogLimitBytes = 32 * 1024 * 1024
export async function importFlexCatalog({ archive, streamTable, db, prefix, budget, windows, onDemandTrips = new Set(), tripModels, continuousPresent = false }) {
  db.exec(`CREATE TABLE IF NOT EXISTS flex_catalog(scope TEXT PRIMARY KEY, data TEXT NOT NULL);`)
  const bytes = { shared: 0, onDemand: 0, fixed: 0 }
  let fixedOmitted = false, onDemandOmitted = false
  const sizeOf = value => Buffer.byteLength(JSON.stringify(value)) + 16
  const total = () => bytes.shared + bytes.onDemand + bytes.fixed
  // Zones, groups and booking rules define the Flex service itself.
  const retain = value => {
    bytes.shared += sizeOf(value)
    if (bytes.shared > flexCatalogLimitBytes) throw new Error('GTFS Flex location and booking definitions exceed 32 MiB')
    return value
  }
  const omitted = id => onDemandOmitted || (fixedOmitted && !onDemandTrips.has(id))
  const omitNext = () => {
    if (fixedOmitted) onDemandOmitted = true
    fixedOmitted = true
    for (const id of Object.keys(catalog.trips)) if (omitted(id)) delete catalog.trips[id]
    for (const [id, owner] of shapeOwners) if (omitted(owner)) shapes.delete(id)
    bytes.fixed = 0
    if (onDemandOmitted) bytes.onDemand = 0
  }
  // Returns whether the trip is still retained after accounting for value.
  const retainTrip = (id, value) => {
    if (omitted(id)) return false
    bytes[onDemandTrips.has(id) ? 'onDemand' : 'fixed'] += sizeOf(value)
    while (total() > flexCatalogLimitBytes) omitNext()
    return !omitted(id)
  }
  const shapes = new Map(), shapeOwners = new Map()
  const catalog = Object.fromEntries(['groups','locations','bookings','trips','shapes'].map(key => [key, Object.create(null)]))
  const read = async (name, visit) => {
    const entry = gtfsTableEntry(archive, name)
    if (entry) await streamTable(entry, visit, { budget })
  }
  const unique = (map, id, value) => {
    if (!id || Object.hasOwn(map, id)) throw new Error(`Missing or duplicate GTFS Flex identity: ${id}`)
    retain(id)
    map[id] = retain(value)
  }
  await read('location_groups.txt', row => unique(catalog.groups, row.location_group_id, { name: row.location_group_name || '', stops: [] }))
  await read('location_group_stops.txt', row => {
    const group = catalog.groups[row.location_group_id]
    if (!group || !db.prepare('SELECT 1 FROM stops WHERE stop_id=? AND COALESCE(location_type,0)=0').get(row.stop_id)) throw new Error('Broken GTFS location-group stop reference')
    if (!group.stops.includes(row.stop_id)) group.stops.push(retain(row.stop_id))
  })
  await read('booking_rules.txt', row => {
    const type = Number(row.booking_type)
    if (!String(row.booking_type ?? '').trim() || ![0,1,2].includes(type)) throw new Error('Invalid GTFS booking_type')
    for (const field of ['prior_notice_duration_min', 'prior_notice_duration_max', 'prior_notice_last_day', 'prior_notice_start_day']) {
      if (row[field] && (!Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0)) throw new Error(`Invalid GTFS ${field}`)
    }
    for (const field of ['prior_notice_last_time','prior_notice_start_time']) {
      if (row[field] && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(row[field])) throw new Error(`Invalid GTFS ${field}`)
    }
    if (row.prior_notice_duration_min && row.prior_notice_duration_max && Number(row.prior_notice_duration_max) < Number(row.prior_notice_duration_min)) throw new Error('GTFS maximum notice precedes minimum notice')
    if (row.prior_notice_service_id && !db.prepare('SELECT 1 FROM calendar WHERE service_id=? UNION SELECT 1 FROM calendar_dates WHERE service_id=?').get(row.prior_notice_service_id,row.prior_notice_service_id)) throw new Error('Unknown GTFS booking notice service')
    if (type === 1 && !String(row.prior_notice_duration_min ?? '').trim()) throw new Error('Same-day GTFS booking requires minimum notice')
    if (type === 2 && (!String(row.prior_notice_last_day ?? '').trim() || !row.prior_notice_last_time)) throw new Error('Prior-day GTFS booking requires a deadline')
    unique(catalog.bookings, row.booking_rule_id, row)
  })
  const geojson = await readGtfsZipJson(archive, gtfsTableEntry(archive, 'locations.geojson'))
  if (geojson) {
    if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) throw new Error('GTFS locations must be a FeatureCollection')
    for (const feature of geojson.features) {
      if (feature.type !== 'Feature' || typeof feature.id !== 'string' || !feature.id.trim()
        || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) throw new Error('Invalid GTFS location geometry')
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates
      if (!Array.isArray(polygons) || !polygons.length) throw new Error('Empty GTFS location geometry')
      for (const polygon of polygons) {
        if (!Array.isArray(polygon) || !polygon.length) throw new Error('Empty GTFS polygon')
        for (const ring of polygon) {
          if (!Array.isArray(ring) || ring.length < 4 || ring.some(p => !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)
            || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) throw new Error('Invalid GTFS polygon ring')
        }
      }
      unique(catalog.locations, prefix + feature.id, { name: feature.properties?.stop_name || '', geometry: feature.geometry })
    }
  }
  for (const id of [...Object.keys(catalog.groups), ...Object.keys(catalog.locations)]) {
    if (db.prepare('SELECT 1 FROM stops WHERE stop_id=?').get(id) || (catalog.groups[id] && catalog.locations[id])) throw new Error('GTFS Flex locations must have globally unique IDs')
  }
  const continuous = value => {
    if (value == null || String(value).trim() === '') return null
    const n = Number(value)
    if (![0,1,2,3].includes(n)) throw new Error('Invalid GTFS continuous stopping permission')
    return n
  }
  const routes = new Map(), models = new Map()
  if (continuousPresent) await read('routes.txt', row => routes.set(row.route_id, {
    continuousPickup: continuous(row.continuous_pickup) ?? 1,
    continuousDropoff: continuous(row.continuous_drop_off) ?? 1,
  }))
  if (continuousPresent) await read('trips.txt', row => {
    const model = { ...routes.get(row.route_id), shapeId: row.shape_id || null }
    models.set(row.trip_id, model)
    if (model.continuousPickup !== 1 || model.continuousDropoff !== 1) windows.add(row.trip_id)
  })
  if (continuousPresent) await read('stop_times.txt', row => {
    if ([continuous(row.continuous_pickup), continuous(row.continuous_drop_off)].some(v => v != null && v !== 1)) windows.add(row.trip_id)
  })
  const seconds = value => {
    const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value ?? '')
    return m ? Number(m[1])*3600 + Number(m[2])*60 + Number(m[3]) : null
  }
  if (windows.size) await read('stop_times.txt', row => {
    if (!windows.has(row.trip_id)) return
    const trip = db.prepare('SELECT * FROM trips WHERE trip_id=?').get(row.trip_id)
    // Frequency templates are not published departure times. Do not offer their
    // raw stop-time clocks as bookable fixed departures.
    if (db.prepare('SELECT 1 FROM frequencies WHERE trip_id=?').get(row.trip_id)) {
      if (row.location_id || row.location_group_id || row.start_pickup_drop_off_window || row.end_pickup_drop_off_window) throw new Error('GTFS Flex windows cannot be combined with frequencies')
      return
    }
    if (!trip) throw new Error('Unknown GTFS Flex trip')
    const ids = [row.stop_id, row.location_group_id, row.location_id].filter(Boolean)
    if (ids.length !== 1) throw new Error('GTFS Flex call must reference exactly one location')
    const id = ids[0]
    if (!(catalog.groups[id] || catalog.locations[id] || db.prepare('SELECT 1 FROM stops WHERE stop_id=? AND COALESCE(location_type,0)=0').get(id))) throw new Error(`Unknown GTFS Flex location: ${id}`)
    const start = seconds(row.start_pickup_drop_off_window), end = seconds(row.end_pickup_drop_off_window)
    const window = Boolean(row.start_pickup_drop_off_window || row.end_pickup_drop_off_window)
    if (!window && (row.location_id || row.location_group_id)) throw new Error('GTFS Flex zones and groups require time windows')
    if (window && (start == null || end == null || end <= start || row.arrival_time || row.departure_time)) throw new Error('Invalid GTFS Flex service window')
    const pickup = Number(row.pickup_type || 0), dropoff = Number(row.drop_off_type || 0)
    if (![0,1,2,3].includes(pickup) || ![0,1,2,3].includes(dropoff) || (window && (![1,2].includes(pickup) || ![1,2,3].includes(dropoff)))) throw new Error('Invalid GTFS Flex pickup/drop-off permissions')
    for (const key of ['pickup_booking_rule_id','drop_off_booking_rule_id']) if (row[key] && !catalog.bookings[row[key]]) throw new Error('Unknown GTFS Flex booking rule')
    const sequence = Number(row.stop_sequence)
    if (!String(row.stop_sequence ?? '').trim() || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid GTFS Flex stop sequence')
    const record = catalog.trips[row.trip_id] ?? { ...trip, ...tripModels.get(row.trip_id), ...models.get(row.trip_id), calls: [] }
    if (record.calls.some(c => c.sequence === sequence)) throw new Error('Duplicate GTFS Flex stop sequence')
    const continuousPickup = continuous(row.continuous_pickup) ?? record.continuousPickup ?? 1
    const continuousDropoff = continuous(row.continuous_drop_off) ?? record.continuousDropoff ?? 1
    if (window && (continuousPickup !== 1 || continuousDropoff !== 1)) throw new Error('GTFS Flex windows cannot have continuous stopping')
    const shapeDistance = row.shape_dist_traveled ? Number(row.shape_dist_traveled) : null
    if (shapeDistance != null && (!Number.isFinite(shapeDistance) || shapeDistance < 0)) throw new Error('Invalid shape distance')
    const call = { sequence, continuousPickup, continuousDropoff, shapeDistance, location: id, start: window ? start : seconds(row.departure_time || row.arrival_time),
      end: window ? end : seconds(row.arrival_time || row.departure_time), window, pickup, dropoff,
      pickupBooking: row.pickup_booking_rule_id || null, dropoffBooking: row.drop_off_booking_rule_id || null }
    if (!retainTrip(row.trip_id, catalog.trips[row.trip_id] ? call : { record, call })) return
    record.calls.push(call)
    catalog.trips[row.trip_id] = record
  })
  for (const trip of Object.values(catalog.trips)) {
    if (trip.calls.some(c => c.continuousPickup !== 1 || c.continuousDropoff !== 1)) {
      if (!trip.shapeId) throw new Error('GTFS continuous stopping requires a shape')
      shapes.set(trip.shapeId, [])
      // A shape used by any on-demand trip stays as long as that trip does.
      if (!shapeOwners.has(trip.shapeId) || onDemandTrips.has(trip.trip_id)) shapeOwners.set(trip.shapeId, trip.trip_id)
    }
  }
  if (shapes.size) await read('shapes.txt', row => {
    const points = shapes.get(row.shape_id)
    if (!points) return
    const point = [Number(row.shape_pt_lon), Number(row.shape_pt_lat), Number(row.shape_pt_sequence), row.shape_dist_traveled ? Number(row.shape_dist_traveled) : null]
    if (!point.slice(0,3).every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90 || (point[3] != null && (!Number.isFinite(point[3]) || point[3] < 0))) throw new Error('Invalid continuous stopping shape')
    if (retainTrip(shapeOwners.get(row.shape_id), point)) points.push(point)
  })
  for (const points of shapes.values()) {
    points.sort((a,b) => a[2]-b[2])
    if (points.length < 2 || points.some((p,i) => i && (p[2] === points[i-1][2] || (p[3] != null && points[i-1][3] != null && p[3] < points[i-1][3])))) throw new Error('Invalid continuous stopping shape order')
  }
  for (const trip of Object.values(catalog.trips)) {
    trip.calls.sort((a,b) => a.sequence-b.sequence)
    trip.onDemand = trip.calls.some(c => c.window)
    if (trip.onDemand && trip.calls.some(c => c.start == null || c.end == null)) throw new Error('GTFS Flex trip needs timed fixed calls or windows')
    // Ordinary GTFS trips may contain untimed intermediate stops. Preserve their
    // scheduled import and offer conditional journeys only at timed endpoints.
    trip.calls = trip.calls.filter(c => c.start != null && c.end != null)
    if (trip.calls.length < 2) delete catalog.trips[trip.trip_id]
  }
  const serialize = () => {
    catalog.shapes = Object.create(null)
    for (const trip of Object.values(catalog.trips)) if (shapes.has(trip.shapeId)) catalog.shapes[trip.shapeId] = shapes.get(trip.shapeId)
    return JSON.stringify(catalog)
  }
  // The streaming estimate bounds memory; the stored document is checked exactly.
  let data = serialize()
  while (Buffer.byteLength(data) > flexCatalogLimitBytes && !onDemandOmitted) {
    omitNext()
    data = serialize()
  }
  if (Buffer.byteLength(data) > flexCatalogLimitBytes) throw new Error('GTFS Flex location and booking definitions exceed 32 MiB')
  if (Object.keys(catalog.trips).length) db.prepare('INSERT INTO flex_catalog VALUES(?,?)').run(prefix, data)
  const omittedTripIds = [...windows].filter(omitted)
  return {
    tripIds: new Set(Object.keys(catalog.trips)),
    omittedFixedTripCount: omittedTripIds.filter(id => !onDemandTrips.has(id)).length,
    omittedOnDemandTripCount: omittedTripIds.filter(id => onDemandTrips.has(id)).length,
  }
}

export function copyFlexCatalogs(db, alias, prefix) {
  if (!db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE name='flex_catalog'`).get()) return
  db.exec('CREATE TABLE IF NOT EXISTS flex_catalog(scope TEXT PRIMARY KEY, data TEXT NOT NULL)')
  for (const row of db.prepare(`SELECT scope,data FROM ${alias}.flex_catalog`).all()) {
    const catalog = JSON.parse(row.data)
    for (const key of ['groups','locations','bookings','trips']) catalog[key] = Object.fromEntries(Object.entries(catalog[key]).map(([id,value]) => [prefix+id,value]))
    if (catalog.shapes) catalog.shapes = Object.fromEntries(Object.entries(catalog.shapes).map(([id,value]) => [prefix+id,value]))
    for (const group of Object.values(catalog.groups)) group.stops = group.stops.map(id=>prefix+id)
    for (const rule of Object.values(catalog.bookings)) for (const key of ['booking_rule_id','prior_notice_service_id']) if (rule[key]) rule[key] = prefix+rule[key]
    for (const trip of Object.values(catalog.trips)) {
      if (trip.shapeId) trip.shapeId = prefix+trip.shapeId
      for (const key of ['trip_id','route_id','service_id']) trip[key] = prefix+trip[key]
      for (const call of trip.calls) for (const key of ['location','pickupBooking','dropoffBooking']) if (call[key]) call[key] = prefix+call[key]
    }
    db.prepare('INSERT INTO flex_catalog VALUES(?,?)').run(prefix+row.scope,JSON.stringify(catalog))
  }
}
