import { singleReadStatement } from '../agency/gtfsQuery.mjs'
import { DatabaseSync, constants } from 'node:sqlite'

const tables = new Set(['routes', 'stops', 'trips', 'connections', 'calendar', 'calendar_dates', 'frequencies', 'transfers', 'route_services'])
const functions = new Set(['count', 'min', 'max', 'avg', 'sum', 'total', 'abs', 'round', 'coalesce', 'ifnull', 'nullif', 'lower', 'upper', 'length', 'substr', 'substring', 'instr', 'trim', 'ltrim', 'rtrim', 'replace', 'like', 'glob'])


function execute({ storePath, sql, limit }) {
  const statement = singleReadStatement(sql)
  const db = new DatabaseSync(storePath, { readOnly: true, allowExtension: false })
  try {
    if (typeof db.setAuthorizer !== 'function') throw new Error('This runtime does not support SQLite read authorization.')
    db.setAuthorizer((action, first, second, database) => {
      if (action === constants.SQLITE_SELECT) return constants.SQLITE_OK
      if (action === constants.SQLITE_READ && (database === 'main' || database === null && second === '') && tables.has(first)) return constants.SQLITE_OK
      if (action === constants.SQLITE_FUNCTION && functions.has(String(second).toLowerCase())) return constants.SQLITE_OK
      return constants.SQLITE_DENY
    })
    const rows = []
    let bytes = 0
    let truncated = false
    const prepared = db.prepare(statement)
    for (const row of prepared.iterate()) {
      const size = Buffer.byteLength(JSON.stringify(row))
      if (rows.length >= limit || bytes + size > 256_000) { truncated = true; break }
      rows.push(row)
      bytes += size
    }
    return { rows, rowCount: rows.length, truncated, byteCount: bytes }
  } finally { db.close() }
}

if (process.send) process.once('message', (input) => {
  try { process.send({ ok: true, data: execute(input) }, () => process.exit(0)) }
  catch (error) { process.send({ ok: false, error: error.message }, () => process.exit(1)) }
})
