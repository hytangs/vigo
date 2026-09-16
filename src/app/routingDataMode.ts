import type { RealtimeSnapshot } from '../domain'
import type { RoutingDataMode, RoutingTravelMode } from '../routingModel'

export const routingDataModeStorageKey = 'vigo-agency-routing-data-mode'

export function readRoutingDataModePreference(): RoutingDataMode {
  try {
    return window.localStorage.getItem(routingDataModeStorageKey) === 'scheduled' ? 'scheduled' : 'realtime'
  } catch {
    return 'realtime'
  }
}

export function saveRoutingDataModePreference(mode: RoutingDataMode) {
  try { window.localStorage.setItem(routingDataModeStorageKey, mode) } catch { /* Storage may be unavailable. */ }
}

// Only transit observations belong to a realtime request. Poll receipt time
// remains in the key so unchanged feed contents are rechecked for expiration;
// research and street requests are independent of every live-feed refresh.
export function routingObservationKey(
  mode: RoutingTravelMode,
  dataMode: RoutingDataMode,
  snapshot: RealtimeSnapshot | null,
) {
  if (mode !== 'transit' || dataMode !== 'realtime' || !snapshot) return ''
  return JSON.stringify({
    sourceUrl: snapshot.sourceUrl,
    sourceUrls: snapshot.sourceUrls,
    fetchedAt: snapshot.fetchedAt,
    feedTimestamp: snapshot.feedTimestamp,
    tripUpdates: snapshot.tripUpdates,
  })
}

// Mirror the server's timestamp admission boundaries without changing the
// observation. One next deadline covers every record in the snapshot.
export function routingObservationValidity(snapshot: RealtimeSnapshot, nowMs: number) {
  let key = ''
  let nextChangeAt: number | null = null
  const timestamp = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      key += '00'
      return
    }
    const validFrom = value * 1000 - 60_000
    const observedAt = value * 1000
    const expiresAt = value * 1000 + 180_001
    key += (nowMs >= validFrom && nowMs < expiresAt ? '1' : '0') + (nowMs >= observedAt ? '1' : '0')
    // Removing unreported past stops also requires the source clock to have
    // occurred, even while the feed is within the allowed future tolerance.
    const next = nowMs < validFrom ? validFrom : nowMs < observedAt ? observedAt : nowMs < expiresAt ? expiresAt : null
    if (next !== null && (nextChangeAt === null || next < nextChangeAt)) nextChangeAt = next
  }
  timestamp(snapshot.feedTimestamp)
  for (const update of snapshot.tripUpdates ?? []) {
    timestamp(update.sourceFeedTimestamp ?? snapshot.feedTimestamp)
    if (update.timestamp != null) timestamp(update.timestamp)
  }
  return { key, nextChangeAt }
}
