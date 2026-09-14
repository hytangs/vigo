import { WeightedLruCache } from './server/weighted-lru-cache.mjs'

const clocks = new WeightedLruCache({ maxEntries: 32 })
const anchors = new WeightedLruCache({ maxEntries: 128 })
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function clock(timezone) {
  let format = clocks.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    clocks.set(timezone, format)
  }
  return format
}

function civilParts(epoch, timezone) {
  return Object.fromEntries(clock(timezone).formatToParts(epoch).map(part => [part.type, part.value]))
}

function civilEpoch(parts) {
  return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`)
}

// GTFS service times are elapsed time since local noon minus twelve hours.
// Civil midnight is a different instant on daylight-saving transition days.
export function fareEventDay(serviceDate, minutes, agencyTimezone, eventTimezone = agencyTimezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate ?? '') || !Number.isFinite(minutes) || minutes < 0 || !agencyTimezone || !eventTimezone) return null
  try {
    const key = JSON.stringify([serviceDate, agencyTimezone])
    let anchor = anchors.get(key)
    if (anchor === undefined) {
      const targetNoon = Date.parse(`${serviceDate}T12:00:00Z`)
      if (!Number.isFinite(targetNoon) || new Date(targetNoon).toISOString().slice(0, 10) !== serviceDate) return null
      let noon = targetNoon
      for (let i = 0; i < 3; i++) {
        const delta = targetNoon - civilEpoch(civilParts(noon, agencyTimezone))
        if (!delta) break
        noon += delta
      }
      if (civilEpoch(civilParts(noon, agencyTimezone)) !== targetNoon) return null
      anchor = noon - 12 * 3600_000
      anchors.set(key, anchor)
    }
    const parts = civilParts(anchor + minutes * 60_000, eventTimezone)
    const date = `${parts.year}${parts.month}${parts.day}`
    return { date, weekday: weekdays[new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`).getUTCDay()],
      seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) }
  } catch { return null }
}

export function fareClockSeconds(text, fallback) {
  if (!text) return fallback
  if (!/^\d{2}:\d{2}:\d{2}$/.test(text)) return NaN
  const [h, m, s] = text.split(':').map(Number)
  return h <= 24 && m < 60 && s < 60 && (h < 24 || m + s === 0) ? h * 3600 + m * 60 + s : NaN
}
