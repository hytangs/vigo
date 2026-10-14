import { formatPublicResult, serializePublicResult } from '../server/native-routing-kernel.mjs'

// Request fields set by each routing option. A one-shot command's options
// override its request; a stream's options are defaults for every line.
const routingOptionFields = [
  ['service-date', ['serviceDate']], ['time', ['time', 'timeMinutes']], ['mode', ['mode']],
  ['max-walk', ['maxWalkKm']], ['horizon', ['horizonMinutes']], ['raster-size', ['rasterSize']],
  ['max-transfers', ['maxTransfers']], ['alternatives', ['alternatives']],
  ['alternative-ranking', ['alternativeRanking']], ['street-edges', ['includeStreetEdges']], ['cutoffs', ['cutoffsMinutes']],
]

export function streamLineArgs(line, args) {
  const fields = new Set(Object.keys(line && typeof line === 'object' ? line : {}))
  const overridden = new Set(routingOptionFields.filter(([, keys]) => keys.some(key => fields.has(key))).map(([option]) => option))
  return new Map([...args].filter(([option]) => !overridden.has(option)))
}

export function presentationRequest(request, args = new Map()) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('A query must be a JSON object')
  const q = { ...request }
  // Command-line options override request fields exactly as in the Rust CLI,
  // so both runtimes format, and fingerprint, the same effective request.
  for (const [option, key] of [['service-date', 'serviceDate'], ['time', 'time'], ['mode', 'mode']]) {
    if (!args.has(option)) continue
    if (key === 'time') delete q.timeMinutes
    q[key] = args.get(option).at(-1)
  }
  if (args.has('alternative-ranking')) q.alternativeRanking = args.get('alternative-ranking').at(-1)
  for (const [option, key] of [['max-walk', 'maxWalkKm'], ['horizon', 'horizonMinutes'], ['raster-size', 'rasterSize'], ['max-transfers', 'maxTransfers'], ['alternatives', 'alternatives']]) {
    if (!args.has(option)) continue
    try { q[key] = JSON.parse(args.get(option).at(-1)) } catch { q[key] = args.get(option).at(-1) }
  }
  if (args.has('street-edges')) q.includeStreetEdges = ['true', 'yes', '1'].includes(String(args.get('street-edges').at(-1)).toLowerCase())
  if (args.has('cutoffs')) q.cutoffsMinutes = String(args.get('cutoffs').at(-1)).split(',').map(Number)
  if (args.has('diagnostics')) q.diagnostics = args.get('diagnostics').at(-1)
  for (const [option, key] of [['wheelchair', 'wheelchair'], ['include-geometry', 'includeGeometry'], ['include-limitations', 'includeLimitations']]) {
    if (args.has(option)) q[key] = ['true', 'yes', '1'].includes(String(args.get(option).at(-1)).toLowerCase())
  }
  if (q.diagnostics !== undefined && !['none', 'summary', 'profile', 'trace'].includes(q.diagnostics)) throw new Error('diagnostics must be none, summary, profile, or trace')
  for (const key of ['wheelchair', 'includeGeometry', 'includeLimitations']) if (q[key] !== undefined && typeof q[key] !== 'boolean') throw new Error(`${key} must be boolean`)
  return q
}

export function publicResult(result, request = {}, args = new Map()) {
  const formatted = formatPublicResult(result.kind ?? 'route', presentationRequest(request, args), result)
  if (result.city?.accessibility) formatted.accessibility = result.city.accessibility
  return formatted
}

export function publicResultJson(result, request = {}, args = new Map()) {
  const serialized = serializePublicResult(result.kind ?? 'route', presentationRequest(request, args), result)
  // The shared Rust projection already places a stream `sequence`.
  const extra = result.city?.accessibility ? { accessibility: result.city.accessibility } : {}
  const suffix = JSON.stringify(extra).slice(1, -1)
  return suffix ? `${serialized.slice(0, -1)},${suffix}}` : serialized
}

export function normalizePublicPoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'stop')) return value
  const { stop, ...rest } = value
  if (rest.stopId !== undefined) throw new Error('Supply stop or stopId, not both')
  if (typeof stop?.id !== 'string' || !stop.id || stop.id.includes('\u001f')
    || (stop.feed != null && (typeof stop.feed !== 'string' || !stop.feed || stop.feed.includes('\u001f')))) throw new Error('Invalid public stop reference')
  return { ...rest, stopId: stop.feed == null ? stop.id : `${stop.feed}\u001f${stop.id}` }
}

export function publicError(message, id) {
  let code = 'invalid_request'
  if (message.startsWith('Unknown stop')) { code = 'stop_not_found'; message = 'A requested stop is not present in this City.' }
  else if (/ENOENT|file not found/.test(message)) { code = 'file_not_found'; message = 'The requested input or City file was not found.' }
  else if (/EACCES|Permission denied/.test(message)) { code = 'permission_denied'; message = 'VIGO cannot read or write a required file.' }
  else if (/SQLITE|SQLite|os error/.test(message)) { code = 'city_unavailable'; message = 'The City could not be opened. Check its files and rebuild if necessary.' }
  // Keys in the order the Rust runtime writes them, so both emit the same bytes.
  return { error: { code, message }, ...(id === undefined ? {} : { id }), schema: 'vigo.error.v1', status: 'error' }
}
