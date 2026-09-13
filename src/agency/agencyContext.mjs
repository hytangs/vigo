import { DatabaseSync } from 'node:sqlite'

const separator = '\u001f'
export const rawId = (value) => String(value ?? '').split(separator).at(-1)
export const scopeOf = (value) => String(value ?? '').includes(separator) ? String(value).split(separator)[0] : ''
export const dateToken = (date) => Number(String(date).replaceAll('-', ''))
const isoDate = (token) => token ? String(token).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null

export function localDate(epochSeconds, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(epochSeconds * 1000))
}

// GTFS defines its service clock as noon minus twelve hours, including DST days.
export function serviceEpoch(serviceDate, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error('Invalid service date.')
  const noon = Date.parse(`${serviceDate}T12:00:00Z`) / 1000
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(new Date(noon * 1000))
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(offset)
  if (!match) throw new Error('Cannot resolve the agency timezone.')
  const seconds = match[1] ? (Number(match[2]) * 3600 + Number(match[3]) * 60) * (match[1] === '+' ? 1 : -1) : 0
  return noon - seconds - 43200
}

export class AgencyContext {
  constructor(storePath, cityName) {
    this.storePath = storePath
    this.cityName = cityName
    this.db = new DatabaseSync(storePath, { readOnly: true, allowExtension: false })
    const metadata = Object.fromEntries(this.db.prepare('SELECT key,value FROM metadata').all().map(({ key, value }) => {
      try { return [key, JSON.parse(value)] } catch { return [key, value] }
    }))
    this.timezone = metadata.agencyTimezones?.length === 1 ? metadata.agencyTimezones[0] : null
    this.routes = this.db.prepare('SELECT * FROM routes ORDER BY short_name, route_id').all()
    this.stops = this.db.prepare('SELECT * FROM stops ORDER BY name, stop_id').all()
    this.trips = this.db.prepare('SELECT * FROM trips').all()
    this.tripIndex = new Map()
    for (const trip of this.trips) {
      const key = rawId(trip.trip_id)
      if (!this.tripIndex.has(key)) this.tripIndex.set(key, [])
      this.tripIndex.get(key).push(trip)
    }
    this.routeIndex = new Map(this.routes.map((route) => [route.route_id, route]))
    this.stopIndex = new Map(this.stops.map((stop) => [stop.stop_id, stop]))
    this.calendar = this.db.prepare('SELECT * FROM calendar').all()
    this.exceptions = this.db.prepare('SELECT * FROM calendar_dates').all()
    this.frequencyTrips = new Set(this.db.prepare('SELECT DISTINCT trip_id FROM frequencies').all().map((row) => row.trip_id))
    this.scopes = [...new Set(this.trips.map((trip) => scopeOf(trip.trip_id)))]
    this.departures = this.db.prepare('SELECT departure, arrival, from_stop_id, to_stop_id, stop_sequence FROM connections WHERE trip_id=? ORDER BY stop_sequence')
    this.referenceDepartures = this.db.prepare('SELECT trip_id, service_id, departure, stop_sequence FROM connections WHERE route_id=? AND from_stop_id=? AND direction_id IS ? AND departure BETWEEN ? AND ? ORDER BY departure, trip_id')
    this.activeCache = new Map()
    this.tripCache = new Map()
  }

  close() { this.db.close() }

  activeServices(serviceDate) {
    if (this.activeCache.has(serviceDate)) return this.activeCache.get(serviceDate)
    const token = dateToken(serviceDate)
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${serviceDate}T12:00:00Z`).getUTCDay()]
    const active = new Set(this.calendar.filter((row) => row.start_date <= token && row.end_date >= token && row[weekday] === 1).map((row) => row.service_id))
    for (const row of this.exceptions) if (row.date === token) {
      if (row.exception_type === 1) active.add(row.service_id)
      if (row.exception_type === 2) active.delete(row.service_id)
    }
    this.activeCache.set(serviceDate, active)
    if (this.activeCache.size > 4) this.activeCache.delete(this.activeCache.keys().next().value)
    return active
  }

  coverage(epochSeconds = Date.now() / 1000) {
    const serviceDate = this.timezone ? localDate(epochSeconds, this.timezone) : null
    const token = dateToken(serviceDate)
    const dates = [...this.calendar.flatMap((row) => [row.start_date, row.end_date]), ...this.exceptions.filter((row) => row.exception_type === 1).map((row) => row.date)]
    const first = dates.length ? Math.min(...dates) : null
    const last = dates.length ? Math.max(...dates) : null
    const active = serviceDate ? this.activeServices(serviceDate) : new Set()
    const missingScopes = this.scopes.filter((scope) => ![...active].some((id) => scopeOf(id) === scope))
    const valid = Boolean(this.timezone && first && last && token >= first && token <= last && active.size && !missingScopes.length)
    return { valid, timezone: this.timezone, serviceDate, firstDate: isoDate(first), lastDate: isoDate(last), activeServices: active.size,
      message: !this.timezone ? 'A single agency timezone is required.' : token > last ? 'This timetable has expired. Import current GTFS before connecting live feeds.' : token < first ? 'This timetable has not started yet.' : !active.size || missingScopes.length ? 'No active service is established for every feed scope on this date. Check calendar exceptions.' : 'Service dates and calendar exceptions cover today.' }
  }

  matchTrip(record, defaultDate) {
    const serviceDate = record.startDate ? isoDate(record.startDate) : defaultDate
    if (!serviceDate || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return { reason: 'Missing or invalid service date.' }
    if (!record.tripId) return { reason: 'No exact trip identity; the indexed connections do not establish an original trip start time.' }
    const candidates = (this.tripIndex.get(rawId(record.tripId)) ?? []).filter((trip) =>
      (!record.sourceScope || scopeOf(trip.trip_id) === record.sourceScope)
      && (!String(record.tripId).includes(separator) || trip.trip_id === record.tripId)
      && (!record.routeId || rawId(trip.route_id) === rawId(record.routeId))
      && (record.directionId === undefined || String(trip.direction_id) === String(record.directionId))
      && this.activeServices(serviceDate).has(trip.service_id))
    if (candidates.length !== 1) return { reason: candidates.length ? 'Trip identity is ambiguous across source scopes.' : 'Trip is absent from active scheduled service.' }
    const trip = candidates[0]
    if (this.frequencyTrips.has(trip.trip_id)) return { reason: 'Frequency trip instances need a retained start-time model.' }
    if (!this.tripCache.has(trip.trip_id)) this.tripCache.set(trip.trip_id, this.departures.all(trip.trip_id))
    return { trip, serviceDate, departures: this.tripCache.get(trip.trip_id), epoch: serviceEpoch(serviceDate, this.timezone) }
  }

  expectedDepartures(trip, stopId, serviceDate, from, to) {
    const active = this.activeServices(serviceDate)
    return this.referenceDepartures.all(trip.route_id, stopId, trip.direction_id, from, to).filter((row) => active.has(row.service_id))
  }

  overview(epochSeconds) {
    return { cityName: this.cityName, coverage: this.coverage(epochSeconds), counts: { routes: this.routes.length, stops: this.stops.length, trips: this.trips.length }, modes: [...new Set(this.routes.map((route) => route.route_type))], sources: this.scopes, scheduleRepresentation: 'VIGO SQLite connections; original terminal departures and untimed stop calls are not reconstructed.' }
  }

  resolve({ query = '', kind = 'all', limit = 12 }) {
    const text = String(query).trim().toLocaleLowerCase()
    if (!text || text.length > 200) throw new Error('Supply an entity name or ID, up to 200 characters.')
    const entities = [
      ...(kind === 'all' || kind === 'route' ? this.routes.map((row) => ({ kind: 'route', id: row.route_id, name: row.short_name || row.long_name || rawId(row.route_id), description: row.long_name })) : []),
      ...(kind === 'all' || kind === 'stop' ? this.stops.map((row) => ({ kind: 'stop', id: row.stop_id, name: row.name, lat: row.lat, lon: row.lon })) : []),
    ]
    const exact = entities.filter((row) => rawId(row.id).toLocaleLowerCase() === text || row.name.toLocaleLowerCase() === text)
    const matches = exact.length ? exact : entities.filter((row) => `${row.name} ${row.description ?? ''}`.toLocaleLowerCase().includes(text))
    return { matches: matches.slice(0, Math.min(30, Math.max(1, Number(limit) || 12))), total: matches.length, method: exact.length ? 'exact' : 'literal substring', ambiguous: matches.length > 1 }
  }
}
