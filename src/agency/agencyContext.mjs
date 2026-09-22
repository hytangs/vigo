import { localDate, serviceEpoch, validDate } from './agencyClock.mjs'
export { localDate, serviceEpoch } from './agencyClock.mjs'
import { scheduledServiceWindow } from './serviceWindow.mjs'
import { DatabaseSync } from 'node:sqlite'
import { WeightedLruCache } from '../server/weighted-lru-cache.mjs'

const separator = '\u001f'
export const rawId = (value) => String(value ?? '').split(separator).at(-1)
export const scopeOf = (value) => String(value ?? '').includes(separator) ? String(value).split(separator)[0] : ''
const dateToken = (date) => Number(String(date).replaceAll('-', ''))
const isoDate = (token) => token ? String(token).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null
export class AgencyContext {
  constructor(storePath, cityName) {
    this.storePath = storePath
    this.cityName = cityName
    this.db = new DatabaseSync(storePath, { readOnly: true, allowExtension: false })
    try {
      const metadata = Object.fromEntries(this.db.prepare('SELECT key,value FROM metadata').all().map(({ key, value }) => {
        try { return [key, JSON.parse(value)] } catch { return [key, value] }
      }))
      this.timezone = metadata.agencyTimezones?.length === 1 ? metadata.agencyTimezones[0] : null
      this.routes = this.db.prepare('SELECT * FROM routes ORDER BY short_name, route_id').all()
      this.stops = this.db.prepare('SELECT * FROM stops ORDER BY name, stop_id').all()
      this.trips = this.db.prepare('SELECT * FROM trips').all()
      this.tripById = new Map(this.trips.map(trip => [trip.trip_id, trip]))
      this.tripIndex = new Map()
      for (const trip of this.trips) {
        const key = rawId(trip.trip_id)
        if (!this.tripIndex.has(key)) this.tripIndex.set(key, [])
        this.tripIndex.get(key).push(trip)
      }
      this.routeIndex = new Map(this.routes.map((route) => [route.route_id, route]))
      this.stopIndex = new Map(this.stops.map((stop) => [stop.stop_id, stop]))
      const stopEntity = (row) => ({ kind: 'stop', id: row.stop_id, name: row.name, lat: row.lat, lon: row.lon, locationType: row.location_type })
      // GTFS parent_station explicitly groups platforms into a station. Name
      // lookup uses that declared identity, without a nearest-place guess.
      const places = new Map()
      for (const row of this.stops) {
        if (![0, 1].includes(Number(row.location_type ?? 0))) continue
        const parent = this.stopIndex.get(row.parent_station)
        const place = parent && Number(parent.location_type) === 1 ? parent : row
        if (!places.has(place.stop_id)) {
          const names = [place.name, ...(Number(place.location_type) === 1 ? [`${place.name} station`] : [])]
          // Exact typed and City-qualified labels still identify the same GTFS
          // record. Do not strip words, fuzzy-match names or move coordinates.
          places.set(place.stop_id, { ...stopEntity(place), aliases: names.flatMap(name => [name, `${name}, ${this.cityName}`]).map(name => name.toLocaleLowerCase()) })
        }
        places.get(place.stop_id).aliases.push(row.name.toLocaleLowerCase())
      }
      this.stopPlaces = [...places.values()]
      this.routeEntities = this.routes.map(row => {
        const names = [...new Set([row.short_name, row.long_name, rawId(row.route_id)].filter(Boolean))]
        // Accept the exact typed labels used in the UI, just as station lookup
        // does above. Every alias comes from an indexed record; collisions
        // remain ambiguous rather than choosing a route by similarity.
        return { kind: 'route', id: row.route_id, name: row.short_name || row.long_name || rawId(row.route_id), description: row.long_name,
          aliases: names.flatMap(name => [name, `Route ${name}`]).map(name => name.toLocaleLowerCase()) }
      })
      this.stopsBySearchId = new Map()
      for (const stop of this.stops) for (const key of new Set([stop.stop_id.toLocaleLowerCase(), rawId(stop.stop_id).toLocaleLowerCase()])) {
        if (!this.stopsBySearchId.has(key)) this.stopsBySearchId.set(key, [])
        this.stopsBySearchId.get(key).push(stopEntity(stop))
      }
      this.calendar = this.db.prepare('SELECT * FROM calendar').all()
      this.exceptions = this.db.prepare('SELECT * FROM calendar_dates').all()
      const dates = [...this.calendar.flatMap(row => [row.start_date, row.end_date]), ...this.exceptions.filter(row => row.exception_type === 1).map(row => row.date)]
      this.firstDate = dates.length ? dates.reduce((a, b) => Math.min(a, b), Infinity) : null
      this.lastDate = dates.length ? dates.reduce((a, b) => Math.max(a, b), -Infinity) : null
      this.frequencyTrips = new Set(this.db.prepare('SELECT DISTINCT trip_id FROM frequencies').all().map((row) => row.trip_id))
      this.scopes = [...new Set(this.trips.map((trip) => scopeOf(trip.trip_id)))]
      this.scopeDates = new Map(this.scopes.map(scope => {
        const dates = [...this.calendar.filter(row => scopeOf(row.service_id) === scope).flatMap(row => [row.start_date, row.end_date]), ...this.exceptions.filter(row => scopeOf(row.service_id) === scope && row.exception_type === 1).map(row => row.date)]
        return [scope, dates.length ? { first: dates.reduce((a, b) => Math.min(a, b), Infinity), last: dates.reduce((a, b) => Math.max(a, b), -Infinity) } : null]
      }))
      this.departures = this.db.prepare('SELECT departure, arrival, from_stop_id, to_stop_id, stop_sequence FROM connections WHERE trip_id=? ORDER BY stop_sequence')
      // The existing stop/departure covering index supplies these columns. Route
      // and direction belong to the already-loaded trips; reading them from
      // each connection forces thousands of extra disk lookups during refresh.
      this.referenceDepartures = this.db.prepare('SELECT trip_id, service_id, departure, stop_sequence FROM connections WHERE from_stop_id=? AND departure BETWEEN ? AND ? ORDER BY departure, trip_id')
      this.activeCache = new WeightedLruCache({ maxEntries: 16 })
      this.tripCache = new WeightedLruCache({ maxEntries: 4096, maxSegments: 250_000, maxBytes: 32 * 1024 * 1024 })
      this.referenceCache = new WeightedLruCache({ maxEntries: 16_384, maxSegments: 100_000, maxBytes: 16 * 1024 * 1024 })
    } catch (error) { this.db.close(); throw error }
  }

  close() { this.tripCache.clear(); this.activeCache.clear(); this.referenceCache.clear(); this.db.close() }

  activeServices(serviceDate) {
    const cached = this.activeCache.get(serviceDate)
    if (cached) return cached
    const token = dateToken(serviceDate)
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${serviceDate}T12:00:00Z`).getUTCDay()]
    const active = new Set(this.calendar.filter((row) => row.start_date <= token && row.end_date >= token && row[weekday] === 1).map((row) => row.service_id))
    for (const row of this.exceptions) if (row.date === token) {
      if (row.exception_type === 1) active.add(row.service_id)
      if (row.exception_type === 2) active.delete(row.service_id)
    }
    this.activeCache.set(serviceDate, active)
    return active
  }

  coverage(epochSeconds = Date.now() / 1000) {
    const serviceDate = this.timezone ? localDate(epochSeconds, this.timezone) : null
    const token = dateToken(serviceDate)
    const first = this.firstDate, last = this.lastDate
    const active = serviceDate ? this.activeServices(serviceDate) : new Set()
    const activeScopes = new Set([...active].map(scopeOf))
    const sources = this.scopes.map(scope => {
      const bounds = this.scopeDates.get(scope)
      const covered = bounds && token >= bounds.first && token <= bounds.last
      return { scope, status: !bounds || !this.timezone ? 'unknown' : covered ? activeScopes.has(scope) ? 'scheduled_service' : 'no_service_today' : 'outside_dates' }
    })
    // Past-midnight service belongs to its original GTFS day, even when the
    // calendar's final date has passed. Read the existing cached trip spans
    // only when a source is outside its date range.
    if (this.timezone && sources.some(source => source.status === 'outside_dates')) {
      const ongoing = scheduledServiceWindow(this, epochSeconds, epochSeconds + 1).trips
      for (const source of sources) if (source.status === 'outside_dates' && ongoing.some(trip => scopeOf(trip.tripId) === source.scope)) source.status = 'continuing_service'
    }
    const valid = sources.some(source => ['scheduled_service', 'no_service_today', 'continuing_service'].includes(source.status))
    const incomplete = sources.some(source => ['unknown', 'outside_dates'].includes(source.status))
    return { valid, timezone: this.timezone, serviceDate, firstDate: isoDate(first), lastDate: isoDate(last), activeServices: active.size, sources,
      message: !this.timezone ? 'A single agency timezone is required.' : !valid ? token > last && last ? 'This timetable has expired. Import current GTFS before connecting live feeds.' : 'No source timetable covers this time. Import current GTFS before connecting live feeds.'
        : incomplete ? 'Some source timetables are outside their supported dates. Only trips with valid source and service-day matches are compared.'
          : sources.some(source => source.status === 'continuing_service') ? 'Prior-day service continues past midnight.'
            : !active.size ? 'The timetable covers today; no service is scheduled for this date.' : 'Service dates and calendar exceptions cover today.' }
  }

  // Identity checks share admission rules without loading unrelated stop times.
  matchTripIdentity(record, defaultDate) {
    const serviceDate = record.startDate ? isoDate(record.startDate) : defaultDate
    if (!serviceDate || !validDate(serviceDate)) return { reason: 'Missing or invalid service date.' }
    if (!record.tripId) return { reason: 'No exact trip identity; the indexed connections do not establish an original trip start time.' }
    const candidates = (this.tripIndex.get(rawId(record.tripId)) ?? []).filter((trip) =>
      (!record.sourceScope || scopeOf(trip.trip_id) === record.sourceScope)
      && (!String(record.tripId).includes(separator) || trip.trip_id === record.tripId)
      && (!record.routeId || (String(record.routeId).includes(separator) ? trip.route_id === record.routeId : rawId(trip.route_id) === rawId(record.routeId)))
      && (record.directionId === undefined || String(trip.direction_id) === String(record.directionId))
      && this.activeServices(serviceDate).has(trip.service_id))
    if (candidates.length !== 1) return { reason: candidates.length ? 'Trip identity is ambiguous across source scopes.' : 'Trip is absent from active scheduled service.' }
    const trip = candidates[0]
    if (this.frequencyTrips.has(trip.trip_id)) return { reason: 'Frequency trip instances need a retained start-time model.' }
    return { trip, serviceDate }
  }

  matchTrip(record, defaultDate) {
    const match = this.matchTripIdentity(record, defaultDate)
    if (!match.trip) return match
    return { ...match, departures: this.tripDepartures(match.trip.trip_id), epoch: serviceEpoch(match.serviceDate, this.timezone) }
  }

  tripDepartures(tripId) {
    let rows = this.tripCache.get(tripId)
    if (!rows) {
      rows = this.departures.all(tripId)
      this.tripCache.set(tripId, rows, { segments: rows.length, bytes: JSON.stringify(rows).length * 2 })
    }
    return rows
  }

  expectedDepartures(trip, stopId, serviceDate, from, to) {
    // Read whole service-clock hours so advancing the observation by seconds
    // reuses static rows. Always apply the exact, inclusive request bounds below.
    const first = Math.floor(from / 3600) * 3600, last = Math.ceil(to / 3600) * 3600
    const key = JSON.stringify([trip.route_id, trip.direction_id, stopId, serviceDate, first, last])
    let rows = this.referenceCache.get(key)
    if (!rows) {
      const active = this.activeServices(serviceDate)
      rows = this.referenceDepartures.all(stopId, first, last).filter(row => {
        const scheduled = this.tripById.get(row.trip_id)
        return active.has(row.service_id) && scheduled?.route_id === trip.route_id && scheduled.direction_id === trip.direction_id
      })
      this.referenceCache.set(key, rows, { segments: rows.length, bytes: key.length * 2 + JSON.stringify(rows).length * 2 })
    }
    return rows.filter(row => row.departure >= from && row.departure <= to)
  }

  overview(epochSeconds) {
    return { cityName: this.cityName, coverage: this.coverage(epochSeconds), counts: { routes: this.routes.length, stops: this.stops.length, trips: this.trips.length }, modes: [...new Set(this.routes.map((route) => route.route_type))], sources: this.scopes, scheduleRepresentation: 'VIGO SQLite connections; original terminal departures and untimed stop calls are not reconstructed.' }
  }

  resolve({ query = '', kind = 'all', limit = 12 }) {
    const text = String(query).trim().toLocaleLowerCase()
    if (!text || text.length > 200) throw new Error('Supply an entity name or ID, up to 200 characters.')
    const exactStops = this.stopsBySearchId.get(text) ?? []
    const entities = [
      ...(kind === 'all' || kind === 'route' ? this.routeEntities : []),
      ...(kind === 'all' || kind === 'stop' ? exactStops.length ? exactStops : this.stopPlaces : []),
    ]
    const exact = entities.filter((row) => row.id.toLocaleLowerCase() === text || rawId(row.id).toLocaleLowerCase() === text || row.name.toLocaleLowerCase() === text || row.aliases?.includes(text))
    const matches = exact.length ? exact : entities.filter((row) => `${row.name} ${row.description ?? ''}`.toLocaleLowerCase().includes(text))
    return { matches: matches.slice(0, Math.min(30, Math.max(1, Number(limit) || 12))).map(({ aliases, ...entity }) => entity), total: matches.length, method: exact.length ? 'exact' : 'literal substring', ambiguous: matches.length > 1 }
  }
}
