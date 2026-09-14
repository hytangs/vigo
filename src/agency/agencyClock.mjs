// Resolve the agency's civil clock once on the server. A UTC observation
// timestamp is an instant, not the agency's date or time of day.
export function agencyClock(instant, timezone) {
  if (!timezone || !Number.isFinite(Date.parse(instant))) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday, timezone, zoneLabel: parts.timeZoneName }
}
