// Bound concurrent reads and merge each batch together for large networks.
export async function loadNetworkSchedules<T, R>(
  requests: T[], load: (request: T) => Promise<R>,
  receive: (results: R[], completed: number, failures: number) => void,
  signal: AbortSignal,
) {
  let failures = 0
  for (let offset = 0; offset < requests.length && !signal.aborted; offset += 4) {
    const batch = await Promise.allSettled(requests.slice(offset, offset + 4).map(load))
    if (signal.aborted) return
    failures += batch.filter(result => result.status === 'rejected').length
    receive(batch.flatMap(result => result.status === 'fulfilled' ? [result.value] : []), Math.min(offset + 4, requests.length), failures)
  }
}
