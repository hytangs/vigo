import { serviceDayForDate } from './service-day.mjs'

function requestError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

// Resolve once at the HTTP boundary. Ordered legs then advance from the first
// departure instead of each independently returning to the wall clock.
export function resolveDepartNowRequest(request, agencyTimezones, observationMs = Date.now()) {
  if (request?.departNow === undefined || request.departNow === false) return request
  if (request.departNow !== true) throw requestError('departNow must be a boolean.', 'invalid_depart_now')
  if (request.routingDataMode !== 'realtime' || !['transit', undefined].includes(request.mode)) {
    throw requestError('departNow requires realtime transit routing.', 'invalid_depart_now_mode')
  }
  const zones = [...new Set((agencyTimezones ?? []).map(zone => String(zone).trim()).filter(Boolean))]
  if (zones.length !== 1) {
    throw requestError('Depart now requires one agency timezone in the imported GTFS feed. Rebuild the feed with a valid agency_timezone.',
      'depart_now_timezone_unavailable', 409)
  }
  const timeZone = zones[0]
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
  } catch {
    throw requestError('The imported agency timezone is invalid. Rebuild the GTFS feed before using Depart now.',
      'depart_now_timezone_unavailable', 409)
  }
  const nowMs = Number(observationMs)
  if (!Number.isFinite(nowMs)) throw requestError('The server clock is unavailable.', 'depart_now_clock_unavailable', 503)
  // Public routing times use whole minutes. Round forward before converting to
  // the agency calendar, so an earlier departure within this minute cannot be
  // boarded and a midnight boundary advances the service date as well.
  const instant = new Date(Math.ceil(nowMs / 60_000) * 60_000)
  if (!Number.isFinite(instant.getTime())) throw requestError('The server clock is unavailable.', 'depart_now_clock_unavailable', 503)
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]))
  const serviceDate = `${parts.year}-${parts.month}-${parts.day}`
  const descriptors = Object.getOwnPropertyDescriptors(request)
  for (const field of ['departNow', 'arriveMinutes', 'timeMinutes', 'serviceDateFallbackPolicy']) delete descriptors[field]
  for (const [field, value] of Object.entries({
    serviceDate, serviceDay: serviceDayForDate(serviceDate),
    departMinutes: Number(parts.hour) * 60 + Number(parts.minute),
    timePreference: 'depart', timeZone, allowServiceDateFallback: false,
  })) descriptors[field] = { value, enumerable: true, writable: true, configurable: true }
  return Object.create(Object.getPrototypeOf(request), descriptors)
}
