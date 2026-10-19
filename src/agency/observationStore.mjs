import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

// Network connection state is independent of retired research notebooks. Read
// the old observation once when needed; never modify the old database or entries.
export function createObservationStore(directory) {
  mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(path.join(directory, 'network.sqlite'))
  try { db.exec('CREATE TABLE IF NOT EXISTS observation (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)') }
  catch (error) { db.close(); throw error }
  return {
    get() {
      const row = db.prepare('SELECT value FROM observation WHERE id=1').get()
      if (row) return JSON.parse(row.value)
      const oldPath = path.join(directory, 'notebook.sqlite')
      if (!existsSync(oldPath)) return null
      const old = new DatabaseSync(oldPath, { readOnly: true })
      try {
        if (!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) return null
        const retained = old.prepare("SELECT value FROM settings WHERE key='observation'").get()
        return retained ? JSON.parse(retained.value) : null
      } finally { old.close() }
    },
    set(value) { db.prepare('INSERT INTO observation VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value)) },
    close() { db.close() },
  }
}
