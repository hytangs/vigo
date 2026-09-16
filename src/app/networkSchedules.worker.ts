import { apiJson } from './api'
import { loadNetworkSchedules } from './networkSchedule'
import { createScheduleCollection, type NetworkScheduleResult } from './networkScheduleCollection'

self.onmessage = async (event: MessageEvent<{ endpoint: string; serviceDate: string; requests: Array<{ feedId: string; routeId: string }> }>) => {
  const { endpoint, serviceDate, requests } = event.data
  const collection = createScheduleCollection()
  let failures = 0, lastProgress = 0
  try {
    await loadNetworkSchedules(requests, request => apiJson<NetworkScheduleResult>(endpoint, {
      method: 'POST', body: JSON.stringify({ ...request, serviceDate }),
    }), (results, completed, failed) => {
      for (const result of results) collection.add(result)
      failures = failed
      if (performance.now() - lastProgress >= 1000 || completed === requests.length) {
        self.postMessage({ type: 'progress', completed, failures })
        lastProgress = performance.now()
      }
    }, new AbortController().signal, 2)
    self.postMessage({ type: 'complete', completed: requests.length, failures, results: collection.finish() })
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Could not load schedules.' })
  }
}
