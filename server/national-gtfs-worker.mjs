import { parentPort, workerData } from 'node:worker_threads'
import { buildNationalGtfsStore, mergeNationalGtfsStores } from './national-gtfs-store.mjs'

try {
  const result = workerData?.mode === 'merge'
    ? await mergeNationalGtfsStores({
        stores: workerData.stores,
        outputPath: workerData.outputPath,
        onProgress: (progress) => parentPort?.postMessage({ type: 'progress', progress }),
        removeSourcesAfterMerge: false,
      })
    : await buildNationalGtfsStore({
        ...workerData,
        onProgress: (progress) => parentPort?.postMessage({ type: 'progress', progress }),
      })
  parentPort?.postMessage({ type: 'complete', result })
} catch (error) {
  parentPort?.postMessage({ type: 'failed', error: error instanceof Error ? error.stack || error.message : String(error) })
}
