// GTFS times are elapsed seconds from local noon minus twelve hours.
// Using local wall-clock fields would merge the repeated fall-back hour.
// https://gtfs.org/documentation/schedule/reference/#field-types
const epochs = new Map()

export function serviceEpochSeconds(serviceDate, timezone) {
  const key = `${serviceDate}\0${timezone}`
  if (epochs.has(key)) return epochs.get(key)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(serviceDate))) throw new Error('Invalid service date')
  const noon = Date.parse(`${serviceDate}T12:00:00Z`)
  if (!Number.isFinite(noon) || new Date(noon).toISOString().slice(0, 10) !== serviceDate) {
    throw new Error('Invalid service date')
  }
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  let candidate = noon
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = Object.fromEntries(formatter.formatToParts(candidate)
      .filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
    const displayed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const difference = noon - displayed
    if (difference === 0) {
      const epoch = candidate / 1000 - 43_200
      if (epochs.size >= 128) epochs.delete(epochs.keys().next().value)
      epochs.set(key, epoch)
      return epoch
    }
    candidate += difference
  }
  throw new Error('Service date has no unambiguous local noon')
}

export function serviceClock(serviceDate, timezone) {
  const epoch = serviceEpochSeconds(serviceDate, timezone)
  return timestamp => Number.isFinite(Number(timestamp)) ? Number(timestamp) - epoch : undefined
}
