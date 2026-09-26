// Admission covers the complete supplied snapshot. Count every rejection so
// downstream routing cannot mistake a filtered input for full feed coverage.
export function prepareJourneyRealtime({ context, state, snapshot, serviceDate, routingDataMode = 'realtime' }) {
  if (routingDataMode === 'scheduled') return {
    inputCoverage: { received: 0, eligible: 0, rejected: 0, rejectionReasons: {}, complete: true },
    realtimeSnapshot: undefined,
  }
  const updates = snapshot?.tripUpdates ?? []
  const inputCoverage = { received: updates.length, eligible: 0, rejected: 0, rejectionReasons: {}, complete: true }
  const reject = reason => {
    inputCoverage.rejected++
    inputCoverage.rejectionReasons[reason] = (inputCoverage.rejectionReasons[reason] ?? 0) + 1
  }
  const now = Date.parse(state.generatedAt) / 1000
  const freshness = state.policy?.freshnessSeconds ?? 180
  const fresh = timestamp => Number.isFinite(timestamp) && Math.abs(now - timestamp) <= freshness
  const feeds = new Map((state.feeds ?? []).map(feed => [feed.sourceUrl, feed]))
  const candidates = []
  const identities = new Map()
  for (const update of updates) {
    if (!update || typeof update !== 'object') { reject('invalid_update'); continue }
    const feed = feeds.get(update.sourceUrl)
    const sourceFeedTimestamp = update.sourceFeedTimestamp ?? feed?.feedTimestamp
    if (feed?.status !== 'fresh' || !fresh(feed.feedTimestamp) || !fresh(sourceFeedTimestamp)) { reject('unfresh_feed'); continue }
    if (update.timestamp !== undefined && update.timestamp !== null) {
      if (!Number.isFinite(update.timestamp)) { reject('invalid_record_timestamp'); continue }
      if (!fresh(update.timestamp)) { reject('stale_record'); continue }
    }
    const match = context.matchTripIdentity(update, serviceDate)
    if (!match.trip) { reject(match.reason || 'unmatched_identity'); continue }
    if (match.serviceDate !== serviceDate) { reject('service_date_mismatch'); continue }
    // Keep the matched GTFS service day explicit, including after midnight.
    const trip = { ...update, tripId: match.trip.trip_id, startDate: match.serviceDate.replaceAll('-', ''), sourceFeedTimestamp }
    candidates.push(trip)
    identities.set(trip.tripId, (identities.get(trip.tripId) ?? 0) + 1)
  }
  const eligible = []
  let feedTimestamp
  for (const trip of candidates) {
    if (identities.get(trip.tripId) !== 1) { reject('duplicate_identity'); continue }
    eligible.push(trip)
    feedTimestamp = feedTimestamp === undefined ? trip.sourceFeedTimestamp : Math.min(feedTimestamp, trip.sourceFeedTimestamp)
  }
  inputCoverage.eligible = eligible.length
  inputCoverage.failedFeeds = snapshot?.feeds?.filter(feed => feed.error).length ?? 0
  inputCoverage.complete = inputCoverage.rejected === 0 && inputCoverage.failedFeeds === 0
  // Preserve even an all-rejected snapshot so the engine can disclose why no
  // realtime update was applied. No snapshot still means no observations.
  return { inputCoverage, realtimeSnapshot: snapshot ? { ...snapshot, tripUpdates: eligible, feedTimestamp, inputCoverage } : undefined }
}

export function journeyRealtimeResult(diagnostics, inputCoverage, routingDataMode = 'realtime') {
  return { routingDataMode, suppliedTripUpdates: inputCoverage.eligible, inputCoverage,
    applied: routingDataMode === 'realtime' && diagnostics.some(item => ['applied', 'cancellations_only', 'partial'].includes(item.status)
      && (Number(item.appliedTrips || 0) + Number(item.canceledTrips || 0) > 0)), diagnostics }
}
