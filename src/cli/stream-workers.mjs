import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

// A worker owns its resident City. Bound both computation and buffered output
// to one request per worker, and preserve input order even on query errors.
export async function runStreamWorkers(args, count, input = process.stdin, output = process.stdout) {
  const argv = ['stream', ...[...args].filter(([key]) => key !== 'workers')
    .flatMap(([key, values]) => values.map(value => `--${key}=${value}`))]
  const workers = []
  const active = new Set()
  let writing = Promise.resolve()
  let sequence = 0
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      if (active.size === count) await Promise.race(active)
      let worker = workers.find(worker => !worker.busy)
      if (!worker) {
        const child = spawn(process.execPath, [process.argv[1], ...argv], { stdio: ['pipe', 'pipe', 'inherit'] })
        worker = { child, busy: false, pending: null, error: null }
        workers.push(worker)
        const current = worker
        const fail = error => { current.error = error; current.pending?.reject(error); current.pending = null }
        child.on('error', fail)
        child.stdin.on('error', fail)
        child.on('exit', (code, signal) => fail(new Error(`CLI worker exited (${signal ?? code})`)))
        createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', response => {
          current.pending?.resolve(response)
          current.pending = null
        })
      }
      if (worker.error) throw worker.error
      worker.busy = true
      const current = worker
      const index = ++sequence
      let suppliedId = false
      try { const id = JSON.parse(line).id; suppliedId = typeof id === 'string' && Boolean(id.trim()) } catch {}
      const response = new Promise((resolve, reject) => { current.pending = { resolve, reject } })
      // Observe failures immediately, including while an earlier result writes.
      response.catch(() => {})
      current.child.stdin.write(`${line}\n`)
      const task = writing.then(async () => {
        const result = JSON.parse(await response)
        result.sequence = index
        if (!suppliedId && result.id !== undefined) result.id = `request_${index}`
        if (result.trace) {
          result.trace.sequence = index
          result.trace.id = result.id
        }
        if (!output.write(`${JSON.stringify(result)}\n`)) await once(output, 'drain')
      })
      writing = task
      active.add(task)
      task.then(() => { current.busy = false; active.delete(task) }, () => { lines.close() })
    }
    await writing
  } finally {
    lines.close()
    for (const { child, busy } of workers) { if (busy) child.kill(); else child.stdin.end() }
    await Promise.allSettled(active)
  }
}
