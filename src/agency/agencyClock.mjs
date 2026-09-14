import { WeightedLruCache } from '../server/weighted-lru-cache.mjs'

const formats = new WeightedLruCache({ maxEntries: 32 })

// Resolve the agency's civil clock once on the server. A UTC observation
// timestamp is an instant, not the agency's date or time of day.
export function agencyClock(instant, timezone) {
  if (!timezone || !Number.isFinite(Date.parse(instant))) return null
  let format = formats.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    })
    formats.set(timezone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday, timezone, zoneLabel: parts.timeZoneName }
}

export const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date
const dateFormats = new WeightedLruCache({ maxEntries: 32 })
const offsetFormats = new WeightedLruCache({ maxEntries: 32 })
const serviceEpochs = new WeightedLruCache({ maxEntries: 128 })

export function localDate(epochSeconds, timezone) {
  let format = dateFormats.get(timezone)
  if (!format) { format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); dateFormats.set(timezone, format) }
  return format.format(new Date(epochSeconds * 1000))
}

// GTFS defines its service clock as noon minus twelve hours, including DST days.
export function serviceEpoch(serviceDate, timezone) {
  if (!validDate(serviceDate)) throw new Error('Invalid service date.')
  const key = JSON.stringify([serviceDate, typeof timezone, timezone]), cached = serviceEpochs.get(key)
  if (cached !== undefined) return cached
  const noon = Date.parse(`${serviceDate}T12:00:00Z`) / 1000
  let format = offsetFormats.get(timezone)
  if (!format) { format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }); offsetFormats.set(timezone, format) }
  const parts = format.formatToParts(new Date(noon * 1000))
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(offset)
  if (!match) throw new Error('Cannot resolve the agency timezone.')
  const seconds = match[1] ? (Number(match[2]) * 3600 + Number(match[3]) * 60) * (match[1] === '+' ? 1 : -1) : 0
  const epoch = noon - seconds - 43200
  serviceEpochs.set(key, epoch)
  return epoch
}
