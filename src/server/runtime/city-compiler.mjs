import { spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { nativeExecutable } from './native-runtime.mjs'

// Studio's GTFS and OSM preparation runs the `vigo` executable's internal
// compiler commands. The compiler's stdin stays open while this process lives:
// it exits when that pipe closes, so a killed parent never leaves it writing.
const maximumResultBytes = 16 * 1024 * 1024

/**
 * Start `vigo COMMAND ...args`. Progress lines go to `onProgress` as
 * `{ phase, progress, detail }` when the command reports JSON progress, and
 * other standard-error output is forwarded to this process's standard error.
 */
export function startCityCompiler(command, args, { label = 'City compiler', onProgress } = {}) {
  const executable = nativeExecutable()
  if (!executable) {
    throw new Error('Cities are compiled by the vigo executable. Build it with npm run build:standalone, or set VIGO_STANDALONE_PATH.')
  }
  const startedAt = performance.now()
  const child = spawn(executable, [command, ...args, '--parent-pipe'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // The compiler never reads its input; an error here means it already exited.
  child.stdin.on('error', () => {})
  let stdout = ''
  let pending = ''
  let tail = ''
  let refusal
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    if (stdout.length > maximumResultBytes) child.kill()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      if (line.startsWith('{')) {
        let event
        try { event = JSON.parse(line) } catch {}
        if (event?.error) {
          refusal = event.error
          continue
        }
        if (event) {
          onProgress?.(event)
          continue
        }
      }
      tail = `${tail}${line}\n`.slice(-8_000)
      if (!line.startsWith('VIGO ') && !line.startsWith('Run "vigo')) process.stderr.write(`${line}\n`)
    }
  })
  const outcome = new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    child.once('error', error => settle({ error }))
    child.once('close', (code, signal) => {
      if (code !== 0) {
        if (code === 2 && tail.trim()) {
          settle({ error: compilerFailure(tail, label, refusal) })
          return
        }
        settle({ error: new Error(`${label} exited with ${signal ?? code}.${signal === 'SIGKILL'
          ? ' Check the Linux/WSL or container OOM log. Large offline builds may need disk-backed swap or a larger build machine; serving a prepared City has a separate memory budget.'
          : ''}`) })
        return
      }
      try {
        settle({ result: JSON.parse(stdout) })
      } catch (error) {
        settle({ error: new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`) })
      }
    })
  })
  return { child, startedAt, outcome }
}

/** Run a compiler command to completion and return its JSON result. */
export async function runCityCompiler(command, args, options = {}) {
  const { child, outcome } = startCityCompiler(command, args, options)
  // A stopped preparation stops its compiler; SIGKILL needs no handler,
  // because the closed pipe ends the compiler.
  const stop = () => child.kill()
  process.once('exit', stop)
  try {
    const settled = await outcome
    if (settled.error) throw settled.error
    return settled.result
  } finally {
    process.removeListener('exit', stop)
  }
}

/**
 * The error of a failed compiler run, without its usage hint. A refused store
 * keeps the compiler's admission `code` and `reason`.
 */
function compilerFailure(stderr, label, refusal) {
  const lines = String(stderr ?? '').trim().split('\n').filter(line => line && !line.startsWith('Run "vigo') && !line.startsWith('{'))
  const message = lines.at(-1)?.replace(/^VIGO [\w-]+: /u, '')
  const error = new Error(message || `${label} failed.`)
  if (refusal?.code) Object.assign(error, { code: refusal.code, reason: refusal.reason })
  return error
}

/** The `{"error":{code,reason}}` line of a refused store, if any. */
function compilerRefusal(stderr) {
  for (const line of String(stderr ?? '').split('\n')) {
    if (!line.startsWith('{"error"')) continue
    try { return JSON.parse(line).error } catch {}
  }
  return undefined
}

/** Run a short compiler command synchronously and return its JSON result. */
export function runCityCompilerSync(command, args, { label = 'City compiler' } = {}) {
  const executable = nativeExecutable()
  if (!executable) {
    throw new Error('Cities are compiled by the vigo executable. Build it with npm run build:standalone, or set VIGO_STANDALONE_PATH.')
  }
  const result = spawnSync(executable, [command, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: maximumResultBytes,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw compilerFailure(result.stderr, label, compilerRefusal(result.stderr))
  return JSON.parse(result.stdout)
}
