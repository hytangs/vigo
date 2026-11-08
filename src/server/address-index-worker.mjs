import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { openAddressIndex } from './address-index.mjs'

const defaultDeadlineMs = 2000

/**
 * The same search as openAddressIndex, on a worker thread. SQLite calls are
 * synchronous, and a broad prefix can take a second, which on the gateway's
 * event loop would delay every route in every City. Lookups run one at a time;
 * one past its deadline replaces the worker and answers as no local match.
 */
export function openAddressIndexWorker(filename, options = {}, { deadlineMs = defaultDeadlineMs } = {}) {
  // An invalid index still stops startup rather than failing on the first search.
  const { metadata, close: closeProbe } = openAddressIndex(filename, options)
  closeProbe()
  let worker = null, current = null, closed = false, sequence = 0
  const waiting = []
  const finish = (entry, results) => {
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.abort)
    entry.resolve(results)
  }
  const discardWorker = () => {
    worker?.removeAllListeners()
    void worker?.terminate()
    worker = null
  }
  const failCurrent = () => {
    const entry = current
    current = null
    discardWorker()
    if (entry) finish(entry, [])
    next()
  }
  const start = () => {
    worker = new Worker(fileURLToPath(import.meta.url), { workerData: { addressIndex: { filename, options } } })
    worker.unref()
    worker.on('message', ({ id, results }) => {
      if (current?.id !== id) return
      const entry = current
      current = null
      finish(entry, results)
      next()
    })
    worker.on('error', failCurrent)
    worker.on('exit', failCurrent)
  }
  // The first visitor's search should not pay to start a thread and open the index.
  start()
  function next() {
    if (closed || current) return
    const entry = waiting.shift()
    if (!entry) return
    current = entry
    if (!worker) start()
    entry.timer = setTimeout(failCurrent, deadlineMs)
    worker.postMessage({ id: entry.id, query: entry.query })
  }
  return {
    metadata,
    search(query, { signal } = {}) {
      if (closed) return Promise.resolve([])
      signal?.throwIfAborted()
      return new Promise((resolve, reject) => {
        const entry = { id: ++sequence, query, resolve, signal, timer: null, abort: null }
        // A cancelled caller leaves at once. A lookup already running finishes,
        // bounded by its deadline; its answer is then ignored.
        entry.abort = () => {
          signal.removeEventListener('abort', entry.abort)
          const index = waiting.indexOf(entry)
          if (index >= 0) waiting.splice(index, 1)
          entry.resolve = () => {}
          reject(signal.reason)
        }
        signal?.addEventListener('abort', entry.abort, { once: true })
        waiting.push(entry)
        next()
      })
    },
    close() {
      if (closed) return
      closed = true
      const entries = [...(current ? [current] : []), ...waiting.splice(0)]
      current = null
      discardWorker()
      for (const entry of entries) finish(entry, [])
    },
  }
}

if (!isMainThread && workerData?.addressIndex) {
  const index = openAddressIndex(workerData.addressIndex.filename, workerData.addressIndex.options)
  parentPort.on('message', ({ id, query }) => {
    parentPort.postMessage({ id, results: index.search(query) })
  })
}
