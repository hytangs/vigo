type PreparedStore = { routingStore?: { status?: string } | null }

/**
 * Feeds whose route schedules can be read now, as a stable key: `*` once the
 * City's combined timetable is ready, otherwise each feed with a ready store.
 * A feed still being imported is left out until its store is written, so a new
 * City does not fail every route and then wait for a manual retry.
 */
export function readyScheduleFeeds(project: PreparedStore & { feeds: Array<PreparedStore & { id: string }> }): string {
  if (project.routingStore?.status === 'ready') return '*'
  return project.feeds.filter(feed => feed.routingStore?.status === 'ready').map(feed => feed.id).sort().join('\n')
}

export function scheduleFeedReady(readyFeeds: string, feedId: string) {
  return readyFeeds === '*' || readyFeeds.split('\n').includes(feedId)
}

// Bound concurrent reads; callers decide whether to collect or publish batches.
export async function loadNetworkSchedules<T, R>(
  requests: T[], load: (request: T) => Promise<R>,
  receive: (results: R[], completed: number, failures: number) => void,
  signal: AbortSignal, concurrency = 4,
) {
  let failures = 0
  for (let offset = 0; offset < requests.length && !signal.aborted; offset += concurrency) {
    const batch = await Promise.allSettled(requests.slice(offset, offset + concurrency).map(load))
    if (signal.aborted) return
    failures += batch.filter(result => result.status === 'rejected').length
    receive(batch.flatMap(result => result.status === 'fulfilled' ? [result.value] : []), Math.min(offset + concurrency, requests.length), failures)
  }
}
