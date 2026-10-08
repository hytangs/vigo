import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { loadGridStreetIndex, nativeGridFixture } from './helpers/native-grid-fixture.mjs'

const entry = fileURLToPath(import.meta.url)
const bindingPath = fileURLToPath(new URL('../native/vigo-routing-kernel/vigo-routing-kernel.node', import.meta.url))

function exerciseNative(directory) {
  const binding = createRequire(import.meta.url)(bindingPath)
  const fixture = nativeGridFixture(directory, 8)
  const kernel = loadGridStreetIndex(binding, fixture, directory)
  const result = kernel.routePath({ originLon: 0, originLat: 38, destinationLon: .007,
    destinationLat: 38.007, maximumDistanceM: 5000, maximumPoints: 100 })
  assert.equal(result.found, true)
  assert(Number.isFinite(result.distanceM))
  // Leave native objects and external typed arrays alive until environment
  // teardown, as a resident City does when its routing worker is retired.
  const retained = [kernel]
  for (let i = 0; i < 2048; i++) {
    const geometry = new binding.ShapeGeometry(new Float64Array([0, 38, .001, 38]))
    const rendered = new Float64Array(4)
    assert.equal(geometry.clipCoordinates(0, 1, rendered), 2)
    retained.push(geometry, rendered, geometry.alignStops(new Float64Array([0, 38, .001, 38])))
  }
  globalThis.nativeLifecycleRetention = retained
}

if (!isMainThread) {
  exerciseNative(workerData.directory)
  if (workerData.terminate) parentPort.on('message', () => {})
  parentPort.postMessage('ready')
} else if (process.argv.includes('--worker-child')) {
  const directory = process.argv.at(-1)
  // The parent never loads the addon: each worker must survive being its last
  // loader, including a later worker reusing the process-wide Rayon pools.
  for (let cycle = 0; cycle < 16; cycle++) {
    const workerDirectory = path.join(directory, String(cycle))
    await fs.mkdir(workerDirectory)
    const terminate = cycle % 2 === 1
    await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { directory: workerDirectory, terminate } })
      let ready = false
      worker.on('error', reject)
      worker.on('message', message => {
        ready = message === 'ready'
        if (terminate) worker.terminate().catch(reject)
      })
      worker.on('exit', code => {
        if (!ready || code !== (terminate ? 1 : 0)) reject(new Error(`Native worker ${cycle} exited ${code}; ready=${ready}`))
        else resolve()
      })
    })
  }
  console.log('NATIVE_WORKER_LIFECYCLE_PASSED')
} else if (process.argv.includes('--process-child')) {
  exerciseNative(process.argv.at(-1))
  console.log('NATIVE_PROCESS_LIFECYCLE_PASSED')
} else {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-native-lifecycle-'))
  try {
    for (let repeat = 0; repeat < 4; repeat++) {
      for (const mode of ['process', 'worker']) {
        const childDirectory = path.join(directory, `${mode}-${repeat}`)
        await fs.mkdir(childDirectory)
        const { stdout } = await promisify(execFile)(process.execPath,
          [entry, `--${mode}-child`, childDirectory], { timeout: 60_000, maxBuffer: 1024 * 1024 })
        assert(stdout.includes(`NATIVE_${mode.toUpperCase()}_LIFECYCLE_PASSED`))
      }
    }
    console.log('Native lifecycle passed: 64 worker retirements and 8 process exits with resident kernels and typed arrays.')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
