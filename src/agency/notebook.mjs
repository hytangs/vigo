import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

// City-owned research record. Timetable data stays read-only in its original store.
export function createNotebook(directory) {
  mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(path.join(directory, 'notebook.sqlite'))
  db.exec(`CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, kind TEXT NOT NULL,
    title TEXT NOT NULL, created_at TEXT NOT NULL, answer TEXT NOT NULL, activities TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT ''
  ); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const decode = (row) => row ? { id: row.id, parentId: row.parent_id, kind: row.kind, title: row.title, createdAt: row.created_at, answer: JSON.parse(row.answer), activities: JSON.parse(row.activities), notes: row.notes } : null
  const searchCondition = `(instr(lower(title),lower(?)) > 0 OR instr(lower(notes),lower(?)) > 0 OR instr(lower(json_extract(answer,'$.answer')),lower(?)) > 0)`
  return {
    directory,
    list({ search = '', before = Number.MAX_SAFE_INTEGER } = {}) {
      if (typeof search !== 'string' || search.length > 200 || !Number.isSafeInteger(before)) throw new Error('Invalid notebook search.')
      return db.prepare(`SELECT id,parent_id AS parentId,kind,title,created_at AS createdAt,substr(notes,1,140) AS notePreview
        FROM entries WHERE id < ? AND ${searchCondition} ORDER BY id DESC LIMIT 30`).all(before, search, search, search)
    },
    recall({ search = '', entryId } = {}) {
      if (typeof search !== 'string' || search.length > 200 || (entryId !== undefined && (!Number.isSafeInteger(entryId) || entryId < 1 || search))) throw new Error('Use a notebook search or one saved entry number.')
      // Project only readable evidence. Large tool payloads and settings never enter model context.
      const rows = db.prepare(`SELECT id,title,created_at AS createdAt,
        json_extract(answer,'$.generatedAt') AS observedAt,
        substr(json_extract(answer,'$.answer'),1,2000) AS excerpt,substr(notes,1,1000) AS notes,
        json_extract(answer,'$.evidenceRefs') AS sources,
        length(json_extract(answer,'$.answer')) > 2000 OR length(notes) > 1000 AS shortened
        FROM entries WHERE ${entryId === undefined ? searchCondition : 'id=?'} ORDER BY id DESC LIMIT 5`)
        .all(...(entryId === undefined ? [search, search, search] : [entryId]))
      return rows.map(({ sources, shortened, ...row }) => ({ ...row, sources: JSON.parse(sources || '[]').slice(0, 12), shortened: Boolean(shortened) }))
    },
    read(id) {
      if (!Number.isSafeInteger(id)) throw new Error('Invalid notebook entry.')
      const entry = decode(db.prepare('SELECT * FROM entries WHERE id=?').get(id))
      if (!entry) throw new Error('Notebook entry not found.')
      return entry
    },
    latest(kind) { return decode(db.prepare('SELECT * FROM entries WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind)) },
    save({ title, kind = 'ask', parentId = null, answer, activities = [] }) {
      if (parentId !== null) this.read(parentId)
      const createdAt = new Date().toISOString()
      const { lastInsertRowid } = db.prepare('INSERT INTO entries(parent_id,kind,title,created_at,answer,activities) VALUES(?,?,?,?,?,?)').run(parentId, kind, title, createdAt, JSON.stringify(answer), JSON.stringify(activities))
      return this.read(Number(lastInsertRowid))
    },
    annotate(id, notes) {
      this.read(id)
      if (typeof notes !== 'string' || notes.length > 20_000) throw new Error('Notes must be at most 20,000 characters.')
      db.prepare('UPDATE entries SET notes=? WHERE id=?').run(notes, id)
      return this.read(id)
    },
    get(key) { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null },
    set(key, value) { db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) },
    close() { db.close() },
  }
}
