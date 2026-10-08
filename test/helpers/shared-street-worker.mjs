import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
const { CoordinateKernel } = createRequire(import.meta.url)(workerData.bindingPath)
const kernel = new CoordinateKernel(workerData.snapshotPath)
parentPort.on('message', () => parentPort.postMessage(kernel.diagnostics()))
parentPort.postMessage(kernel.diagnostics())
