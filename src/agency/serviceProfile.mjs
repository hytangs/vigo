import { agencyClock } from './agencyClock.mjs'
import { serviceEpoch } from './agencyContext.mjs'
import { gtfsQuery } from './gtfsQuery.mjs'

export async function serviceProfile(context, args, generatedAt, signal) {
  const serviceDate = args.serviceDate || agencyClock(generatedAt, context.timezone)?.date
  if (!serviceDate || !Number.isFinite(Date.parse(`${serviceDate}T12:00:00Z`)) || new Date(`${serviceDate}T12:00:00Z`).toISOString().slice(0, 10) !== serviceDate) throw new Error('A valid service date and agency timezone are required.')
  const quote = value => `'${String(value).replaceAll("'", "''")}'`
  const active = [...context.activeServices(serviceDate)]
  if (!active.length) throw new Error(`No active scheduled service is established for ${serviceDate}.`)
  const [hours, minutes] = (args.afterTime || '00:00').split(':').map(Number)
  const afterSeconds = hours * 3600 + minutes * 60
  const selected = `service_id IN (${active.map(quote).join(',')}) ${args.routeId ? `AND route_id=${quote(args.routeId)}` : ''} AND trip_id NOT IN (SELECT trip_id FROM frequencies)`
  const byRoute = args.groupBy === 'route'
  if (byRoute && !context.timezone) throw new Error('A single agency timezone is required to display local departure times.')
  const sql = byRoute
    ? `WITH service AS (SELECT route_id, COUNT(DISTINCT trip_id) AS scheduled_trips, MIN(departure) AS first_departure, MAX(departure) AS last_departure FROM connections WHERE ${selected} AND departure>=${afterSeconds} GROUP BY route_id) SELECT COALESCE(NULLIF(r.short_name,''),r.long_name,r.route_id) AS route, r.long_name AS route_name, s.scheduled_trips, s.first_departure, s.last_departure FROM service s JOIN routes r ON r.route_id=s.route_id ORDER BY route,r.route_id`
    : `WITH starts AS (SELECT trip_id,route_id,MIN(departure) AS first_departure FROM connections WHERE ${selected} GROUP BY trip_id,route_id) SELECT CAST(first_departure/3600 AS INTEGER) AS service_hour, COUNT(*) AS scheduled_trip_starts, COUNT(DISTINCT route_id) AS routes FROM starts WHERE first_departure>=${afterSeconds} GROUP BY service_hour ORDER BY service_hour`
  const result = await gtfsQuery(context.storePath, { sql, limit: 200 }, { signal })
  const epoch = byRoute ? serviceEpoch(serviceDate, context.timezone) : null
  const clock = seconds => {
    const local = agencyClock(new Date((epoch + seconds) * 1000).toISOString(), context.timezone)
    const days = Math.round((Date.parse(local.date) - Date.parse(serviceDate)) / 86400000)
    return `${local.time}${days ? ` (${days > 0 ? '+' : ''}${days} ${Math.abs(days) === 1 ? 'day' : 'days'})` : ''}`
  }
  const rows = byRoute ? result.rows.map(row => ({ ...row, first_departure: clock(row.first_departure), last_departure: clock(row.last_departure) })) : result.rows
  return { ...result, rows, sql, serviceDate, timezone: context.timezone, activeServices: active.length, groupBy: byRoute ? 'route' : 'hour', afterTime: args.afterTime || '00:00' }
}
