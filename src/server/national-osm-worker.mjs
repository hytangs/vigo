import { preparationInput, publishPreparation } from './runtime/preparation-channel.mjs'
import { runCityCompiler } from './runtime/city-compiler.mjs'

// The `vigo` executable compiles, seals and indexes the street store; this
// worker relays its progress. Progress stays monotone across the sealing
// and hierarchy phases that follow the source graph build.
const workerData = await preparationInput()
let lastPublishedProgress = 0

function publishProgress(update) {
  const rawProgress = Number(update?.progress ?? 0)
  const publicationPhase = (
    update?.phase === 'Sealing runtime street snapshots'
    || update?.phase === 'Building Rust pedestrian CCH'
  )
  const progress = Math.max(
    lastPublishedProgress,
    publicationPhase
      ? Math.min(0.99, Math.max(0, rawProgress))
      : Math.min(0.96, Math.max(0, rawProgress) * 0.96),
  )
  lastPublishedProgress = progress
  publishPreparation({ type: 'progress', progress: { ...update, progress } })
}

try {
  const result = await runCityCompiler('_build-street-store', [
    `--osm=${workerData.pbfPath}`, `--output-store=${workerData.outputPath}`, '--studio',
    ...(workerData.wheelchair ? ['--wheelchair', `--wheelchair-streets=${workerData.wheelchairStreets ?? 'inferred'}`] : []),
    ...(workerData.privateAccess === 'endpoints'
      ? ['--private-access=endpoints', `--routing-store=${workerData.routingStorePath}`]
      : []),
    '--progress=json',
  ], { label: 'OSM compiler', onProgress: publishProgress })
  publishPreparation({ type: 'complete', result })
} catch (error) {
  publishPreparation({ type: 'failed', error: error instanceof Error ? error.stack || error.message : String(error) })
}
