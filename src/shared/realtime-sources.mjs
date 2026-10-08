export const maximumRealtimeSources = 16

const kinds = new Set(['feed', 'vehicles', 'tripUpdates', 'alerts'])
const invalid = message => Object.assign(new Error(message), { statusCode: 400 })

function endpoint(value) {
  let url
  try { url = new URL(String(value ?? '').trim()) } catch { throw invalid('Enter a valid HTTP or HTTPS GTFS-RT URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) {
    throw invalid('GTFS-RT URLs must use HTTP or HTTPS without embedded credentials.')
  }
  return url
}

// Current requests identify each endpoint explicitly; do not infer additional
// feeds or reinterpret saved viewer URLs from older connection formats.
export function realtimeSources(request) {
  if (request && typeof request === 'object' && ('url' in request || 'urls' in request)) {
    throw invalid('Use sources: [{ url, kind, sourceScope? }] for GTFS-RT endpoints. Reconnect saved connections using this format.')
  }
  const sources = request?.sources
  if (!Array.isArray(sources) || !sources.length || sources.length > maximumRealtimeSources) {
    throw invalid(`Configure 1 to ${maximumRealtimeSources} GTFS-RT endpoints.`)
  }
  const unique = new Map()
  for (const source of sources) {
    const url = endpoint(source?.url)
    if (url.hostname === 'viz.rt.gtfs.zone') throw invalid('Use the feed URL from the viewer, not the viewer page.')
    url.hash = ''
    const kind = source.kind ?? 'feed'
    if (!kinds.has(kind)) throw invalid('Choose a supported GTFS-RT feed type.')
    const scope = source.sourceScope
    if (scope != null && (typeof scope !== 'string' || scope.length > 160 || /[\x00-\x1f\x7f]/.test(scope))) {
      throw invalid('Choose a valid static GTFS source.')
    }
    const sourceScope = scope?.trim() || undefined
    const previous = unique.get(url.href)
    if (previous && previous.sourceScope !== sourceScope) throw invalid('One GTFS-RT URL cannot belong to two static GTFS sources.')
    unique.set(url.href, { url: url.href, kind: previous && previous.kind !== kind ? 'feed' : kind, ...(sourceScope ? { sourceScope } : {}) })
  }
  return [...unique.values()]
}
