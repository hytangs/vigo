import { preparationInput, publishPreparation } from './runtime/preparation-channel.mjs'
import { buildNationalGtfsStore, mergeNationalGtfsStores } from './national-gtfs-store.mjs'

const workerData = await preparationInput()

try {
  const result = workerData?.mode === 'merge'
    ? await mergeNationalGtfsStores({
        stores: workerData.stores,
        outputPath: workerData.outputPath,
        onProgress: (progress) => publishPreparation({ type: 'progress', progress }),
        removeSourcesAfterMerge: false,
      })
    : await buildNationalGtfsStore({
        ...workerData,
        onProgress: (progress) => publishPreparation({ type: 'progress', progress }),
      })
  publishPreparation({ type: 'complete', result })
} catch (error) {
  publishPreparation({ type: 'failed', error: error instanceof Error ? error.stack || error.message : String(error) })
}
