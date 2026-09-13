import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// A lexer only separates statements; SQLite's authorizer decides what may execute.
export function singleReadStatement(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 8000) throw new Error('SQL must contain 1–8000 characters.')
  let clean = ''
  for (let index = 0; index < sql.length;) {
    const char = sql[index]
    if (char === '-' && sql[index + 1] === '-') {
      index = sql.indexOf('\n', index + 2)
      if (index < 0) break
      clean += ' '
    } else if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end < 0) throw new Error('Unclosed SQL comment.')
      index = end + 2
      clean += ' '
    } else if (["'", '"', '`', '['].includes(char)) {
      const endChar = char === '[' ? ']' : char
      index++
      let closed = false
      while (index < sql.length) {
        if (sql[index++] !== endChar) continue
        if (sql[index] === endChar && endChar !== ']') { index++; continue }
        closed = true
        break
      }
      if (!closed) throw new Error('Unclosed SQL literal or identifier.')
      clean += ' literal '
    } else { clean += char; index++ }
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(clean) || !/^[^;]*;?\s*$/.test(clean)) throw new Error('Only one SELECT or WITH statement is allowed.')
  return sql.trim().replace(/;\s*$/, '')
}


let activeQueries = 0
export async function gtfsQuery(storePath, { sql, limit = 100 }, { signal, timeoutMs = 1500 } = {}) {
  singleReadStatement(sql)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('SQL result limit must be between 1 and 200.')
  if (signal?.aborted) throw new Error('SQL query cancelled.')
  if (activeQueries >= 2) throw new Error('Two SQL queries are already running. Try again shortly.')
  activeQueries++
  // SQLite synchronous execution cannot be interrupted by a JS timer. A small,
  // fixed read-only worker process can be killed even inside sqlite3_step.
  // Routing never uses this process; it uses Studio's native module adapters.
  const worker = fork(fileURLToPath(new URL('../server/agency-sql-worker.mjs', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), ELECTRON_RUN_AS_NODE: '1' },
  })
  return new Promise((resolve, reject) => {
    let result
    let failure
    const stop = (message) => { failure = new Error(message); worker.kill('SIGKILL') }
    const abort = () => stop('SQL query cancelled.')
    const timer = setTimeout(() => stop(`SQL execution exceeded ${timeoutMs} ms.`), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('message', (message) => { result = message })
    worker.once('error', (error) => { failure = error })
    worker.once('exit', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      activeQueries--
      if (failure) reject(failure)
      else if (result?.ok) resolve(result.data)
      else reject(new Error(result?.error || 'SQL worker exited without a result.'))
    })
    worker.send({ storePath, sql, limit })
  })
}
