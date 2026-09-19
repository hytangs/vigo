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
