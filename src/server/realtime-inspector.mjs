import { realtimeSources } from '../shared/realtime-sources.mjs'
import { decodeGtfsRealtimeFeed } from './gtfs-realtime-decoder.mjs'
import { realtimeSnapshotFromFeed, realtimeSnapshotFromFeeds } from './realtime-snapshot.mjs'
import { fetchSafeRealtimeBody } from './realtime-url-security.mjs'

const maximumFeedBytes = 20_000_000
const maximumBatchBytes = 40_000_000
let activeInspections = 0

export async function inspectRealtimeFeed(request, context = {}) {
  const sources = realtimeSources(request)
  for (const source of sources) {
    if (source.sourceScope && context.feedIds && !context.feedIds.includes(source.sourceScope)) {
      throw Object.assign(new Error('The live feed references a static GTFS source that is no longer in this City.'), { statusCode: 400 })
    }
  }
  if (activeInspections >= 2) throw Object.assign(new Error('Live feed refresh capacity is busy. Retry shortly.'), { statusCode: 503 })
  activeInspections++
  const records = new Array(sources.length)
  let next = 0, retainedBytes = 0, retainedEntities = 0, retainedStops = 0
  // At most four sockets across all inspections, with no unbounded queue.
  // A shared deadline covers queued endpoints as well as active downloads.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Live feed refresh exceeded 30 seconds.')), 30_000)
  try {
    await Promise.all(Array.from({ length: Math.min(2, sources.length) }, async () => {
      while (next < sources.length) {
        const index = next++, source = sources[index]
        // A single-source City keeps raw GTFS IDs. Merged Cities namespace IDs.
        const sourceScope = source.sourceScope && context.sourceScopes?.length === 1 && context.sourceScopes[0] === ''
          ? undefined : source.sourceScope
        const record = { sourceUrl: source.url, kind: source.kind, sourceScope, fetchedAt: new Date().toISOString() }
        records[index] = record
        try {
          controller.signal.throwIfAborted()
          if (retainedBytes >= maximumBatchBytes) throw new Error('Combined live feeds exceed the 40 MB refresh limit.')
          const fetched = await fetchSafeRealtimeBody(source.url, { maximumBytes: Math.min(maximumFeedBytes, maximumBatchBytes - retainedBytes),
            signal: controller.signal, headers: { accept: 'application/x-protobuf, application/octet-stream', 'user-agent': 'VIGO GTFS-RT inspector' } })
          retainedBytes += fetched.body.byteLength
          if (retainedBytes > maximumBatchBytes) throw new Error('Combined live feeds exceed the 40 MB refresh limit.')
          const feed = decodeGtfsRealtimeFeed(fetched.body)
          retainedEntities += feed.entity.length
          retainedStops += feed.entity.reduce((total, entity) => total + (entity.tripUpdate?.stopTimeUpdate?.length ?? 0), 0)
          if (retainedEntities > 200_000 || retainedStops > 500_000) throw new Error('Combined live feeds exceed 200,000 entities or 500,000 stop predictions.')
          record.fetchedAt = new Date().toISOString()
          record.snapshot = realtimeSnapshotFromFeed(feed, source.url, record.fetchedAt, fetched.contentType, sourceScope)
        } catch (error) { record.error = error.message }
      }
    }))
    return realtimeSnapshotFromFeeds(records)
  } finally { clearTimeout(timer); activeInspections-- }
}
