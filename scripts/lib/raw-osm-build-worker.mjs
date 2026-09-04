import { parentPort, workerData } from 'node:worker_threads'
import { buildNationalOsmStore } from '../../src/server/national-osm-store.mjs'

if (!parentPort) throw new Error('Raw OSM build worker requires a parent thread.')

try {
  const result = await buildNationalOsmStore({
    pbfPath: workerData.pbfPath,
    outputPath: workerData.outputPath,
    buildDrivingProfile: workerData.buildDrivingProfile === true,
    onProgress: (update) => parentPort.postMessage({ type: 'progress', update }),
  })
  parentPort.postMessage({ type: 'result', result })
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })
}
