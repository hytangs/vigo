import { formatPublicResult } from '../server/native-routing-kernel.mjs'

export function presentationRequest(request, args = new Map()) {
  const q = { ...request }
  if (args.has('diagnostics')) q.diagnostics = args.get('diagnostics').at(-1)
  for (const [option, key] of [['include-geometry', 'includeGeometry'], ['include-limitations', 'includeLimitations']]) {
    if (args.has(option)) q[key] = ['true', 'yes', '1'].includes(args.get(option).at(-1))
  }
  if (q.diagnostics !== undefined && !['none', 'summary', 'profile', 'trace'].includes(q.diagnostics)) throw new Error('diagnostics must be none, summary, profile, or trace')
  for (const key of ['includeGeometry', 'includeLimitations']) if (q[key] !== undefined && typeof q[key] !== 'boolean') throw new Error(`${key} must be boolean`)
  return q
}

export function publicResult(result, request = {}, args = new Map()) {
  return formatPublicResult(result.kind ?? 'route', presentationRequest(request, args), result)
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
  return { schema: 'vigo.error.v1', status: 'error', ...(id === undefined ? {} : { id }), error: { code, message } }
}
