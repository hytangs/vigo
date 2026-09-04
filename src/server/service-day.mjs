const serviceDays = new Set(['weekday', 'saturday', 'sunday'])
const weekdayNames = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])

export function serviceDayForDate(serviceDate) {
  const normalized = String(serviceDate ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized)
  if (!match) throw new Error('A valid service date is required to derive service day.')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  // Date.UTC treats years 0..99 as 1900..1999. Set the full year after
  // construction so the calendar calculation is correct for every supported
  // four-digit ISO year. Keep the accepted range aligned with Python's
  // datetime.date and the documented YYYY-MM-DD contract.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(12, 0, 0, 0)
  if (
    year < 1
    || year > 9999
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) throw new Error(`Invalid service date: ${normalized || serviceDate}`)
  const weekday = date.getUTCDay()
  return weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'weekday'
}

export function resolveServiceDay(serviceDate, requestedServiceDay) {
  const derived = serviceDayForDate(serviceDate)
  const requested = String(requestedServiceDay ?? '').trim().toLowerCase()
  if (!requested) return derived
  if (weekdayNames.has(requested)) return 'weekday'
  if (!serviceDays.has(requested)) {
    throw new Error('service day must be weekday, saturday, or sunday')
  }
  return requested
}
