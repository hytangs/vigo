export function routeDisplayLongName(shortName, longName, stops, routeId) {
  const short = String(shortName ?? '').trim()
  const long = String(longName ?? '').trim()
  if (long && long.toLocaleLowerCase() !== short.toLocaleLowerCase()) return long
  const first = String(stops[0]?.name ?? '').trim()
  const last = String(stops.at(-1)?.name ?? '').trim()
  if (first && last) return first === last ? `${first} loop` : `${first} → ${last}`
  return long || String(routeId)
}
