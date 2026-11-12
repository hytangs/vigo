import { preparationInput, publishPreparation } from './runtime/preparation-channel.mjs'
import { runCityCompiler } from './runtime/city-compiler.mjs'

// The `vigo` executable compiles the store; this worker relays its progress.
const workerData = await preparationInput()

try {
  const args = workerData?.mode === 'merge'
    ? [...workerData.stores.map(store => `--merge-store=${store.scope}=${store.storePath}`), `--output-store=${workerData.outputPath}`]
    : [`--gtfs=${workerData.zipPath}`, `--output-store=${workerData.outputPath}`,
        ...(workerData.wheelchair ? ['--wheelchair', `--wheelchair-streets=${workerData.wheelchairStreets ?? 'inferred'}`] : [])]
  const result = await runCityCompiler('_build-gtfs-store', [...args, '--progress=json'], {
    label: 'GTFS compiler',
    onProgress: progress => publishPreparation({ type: 'progress', progress }),
  })
  publishPreparation({ type: 'complete', result })
} catch (error) {
  publishPreparation({ type: 'failed', error: error instanceof Error ? error.stack || error.message : String(error) })
}
