// Translate compact test timetables into real GTFS inputs. Production has one
// compiler: the same scoped GTFS importer used by City preparation.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import Papa from 'papaparse'
import { buildNationalGtfsCityStore } from '../../src/server/national-gtfs-store.mjs'

function weekdays(trip) {
  const explicit = trip.serviceCalendar?.weekdays
  if (explicit?.length) return new Set(explicit.map(Number))
  const days = new Set((trip.serviceDays ?? []).flatMap(day => (
    day === 'weekday' ? [1, 2, 3, 4, 5] : day === 'saturday' ? [6] : day === 'sunday' ? [0] : []
  )))
  return days.size ? days : new Set([0, 1, 2, 3, 4, 5, 6])
}
const date = value => String(value).replaceAll('-', '')
function time(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return ''
  const seconds = Math.round(Number(minutes) * 60)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':')
}

export async function buildScheduleFixture({ schedules, outputPath, onProgress }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-schedule-gtfs-'))
  try {
    const feeds = []
    for (const [index, descriptor] of schedules.entries()) {
      const schedule = JSON.parse(await fs.readFile(descriptor.schedulePath, 'utf8'))
      const zip = new JSZip()
      const scope = descriptor.feedId || `feed-${index + 1}`
      // Single-feed Cities retain input IDs; these fixtures explicitly use
      // scoped IDs even when there is only one source.
      const ids = new Set(['stop_id', 'parent_station', 'route_id', 'trip_id', 'service_id', 'from_stop_id', 'to_stop_id'])
      const table = (name, fields, rows) => zip.file(name + '.txt', Papa.unparse({ fields,
        data: schedules.length === 1 ? rows.map(row => row.map((value, column) => (
          ids.has(fields[column]) && value != null && value !== '' ? `${scope}\u001f${value}` : value
        ))) : rows,
      }))
      table('agency', ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], [['fixture', 'Fixture', 'https://example.test', 'UTC']])
      table('stops', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'parent_station', 'location_type', 'platform_code'],
        (schedule.stops ?? []).map(stop => [stop.id, stop.name || stop.id, stop.lat, stop.lon, stop.parentStationId, stop.locationType ?? 0, stop.platformCode]))
      const routes = new Map(), trips = new Map(), calendars = new Map(), exceptions = new Map(), stopTimes = []
      for (const route of schedule.routes ?? []) {
        const routeId = route.routeId || route.id
        if (!routes.has(routeId)) routes.set(routeId, [routeId, 'fixture', route.shortName || '', route.longName || '', route.routeType ?? 3, String(route.color || '').replace(/^#/, '')])
        for (const trip of route.scheduledTrips ?? []) {
          if (trips.has(trip.tripId)) continue
          const serviceId = trip.serviceId || `${trip.patternId || route.id}:service`
          trips.set(trip.tripId, [routeId, serviceId, trip.tripId, trip.directionId ?? route.directionId])
          const days = weekdays(trip), calendar = trip.serviceCalendar ?? {}
          if (!calendars.has(serviceId)) calendars.set(serviceId, [serviceId, ...[1, 2, 3, 4, 5, 6, 0].map(day => Number(days.has(day))), date(calendar.startDate || '19000101'), date(calendar.endDate || '29991231')])
          for (const [dates, kind] of [[calendar.addedDates, 1], [calendar.removedDates, 2]]) {
            for (const value of dates ?? []) exceptions.set(`${serviceId}:${date(value)}`, [serviceId, date(value), kind])
          }
          for (const [position, stop] of (trip.stopTimes ?? []).entries()) stopTimes.push([
            trip.tripId, time(stop.arrivalMinutes ?? stop.departureMinutes), time(stop.departureMinutes ?? stop.arrivalMinutes), stop.stopId, stop.sequence ?? position + 1,
          ])
        }
      }
      table('routes', ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'], [...routes.values()])
      table('trips', ['route_id', 'service_id', 'trip_id', 'direction_id'], [...trips.values()])
      table('calendar', ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'], [...calendars.values()])
      if (exceptions.size) table('calendar_dates', ['service_id', 'date', 'exception_type'], [...exceptions.values()])
      table('stop_times', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'], stopTimes)
      if (schedule.transferRules?.length) table('transfers', ['from_stop_id', 'to_stop_id', 'transfer_type', 'min_transfer_time'],
        schedule.transferRules.map(rule => [rule.fromStopId, rule.toStopId, rule.transferType ?? 0, rule.minTransferTimeSeconds ?? 0]))
      if (schedule.pathways?.length) table('pathways', ['pathway_id', 'from_stop_id', 'to_stop_id', 'pathway_mode', 'is_bidirectional', 'traversal_time'],
        schedule.pathways.map((way, id) => [id, way.fromStopId, way.toStopId, 1, Number(Boolean(way.isBidirectional)), way.traversalTimeSeconds ?? 0]))
      const zipPath = path.join(directory, `${index}.zip`)
      await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))
      feeds.push({ scope: descriptor.feedId || `feed-${index + 1}`, path: zipPath })
    }
    return await buildNationalGtfsCityStore({ feeds, outputPath, onProgress })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
