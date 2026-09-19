import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { operationsPolicy, fail, recordIdentity, qualitySummary } from './operations.mjs'
import { applicableProcedures, procedureResult } from './procedures.mjs'

// One City-owned ledger. Every human edit and its revision are committed together.
export function createOperationsStore(directory, projectId, clock = () => Date.now()) {
  mkdirSync(directory, { recursive: true })
  const db = new DatabaseSync(path.join(directory, 'operations.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout=1500; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > 1) fail('This operations database requires a newer Agency version.', 409)
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS owner (id TEXT PRIMARY KEY);
      CREATE UNIQUE INDEX IF NOT EXISTS owner_singleton ON owner((1));
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS finding_identity ON records(json_extract(data,'$.eventKey')) WHERE kind='finding';
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(record_id,version));
      CREATE TABLE IF NOT EXISTS samples (bucket INTEGER PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`)
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(record_id UNINDEXED,title,body);
      CREATE TRIGGER IF NOT EXISTS knowledge_insert AFTER INSERT ON records WHEN new.kind='knowledge' BEGIN
        INSERT INTO knowledge_fts VALUES(new.id,json_extract(new.data,'$.title'),json_extract(new.data,'$.body')); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_update AFTER UPDATE ON records WHEN new.kind='knowledge' BEGIN
        DELETE FROM knowledge_fts WHERE record_id=old.id;
        INSERT INTO knowledge_fts VALUES(new.id,json_extract(new.data,'$.title'),json_extract(new.data,'$.body')); END;
      INSERT INTO knowledge_fts SELECT id,json_extract(data,'$.title'),json_extract(data,'$.body') FROM records
        WHERE kind='knowledge' AND id NOT IN (SELECT record_id FROM knowledge_fts);`)
    db.prepare('INSERT OR IGNORE INTO owner VALUES(?)').run(projectId)
    if (db.prepare('SELECT id FROM owner').get().id !== projectId) fail('Operations storage belongs to another City.', 403)
  } catch (error) { db.close(); throw error }
  const now = () => new Date(clock()).toISOString()
  const decode = row => row ? { id: row.id, kind: row.kind, version: row.version, updatedAt: row.updated_at, ...JSON.parse(row.data) } : null
  const read = (id, kind) => {
    if (typeof id !== 'string' || id.length > 200) fail('Invalid operations record.')
    const record = decode(db.prepare('SELECT * FROM records WHERE id=?').get(id))
    if (!record || kind && record.kind !== kind) fail('Operations record not found in this City.', 404)
    return record
  }
  let depth = 0
  const transaction = run => {
    const nested = depth++, name = `operations_${nested}`
    try {
      db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE')
      try { const result = run(); db.exec(nested ? `RELEASE ${name}` : 'COMMIT'); return result }
      catch (error) { db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK'); throw error }
    } finally { depth-- }
  }
  function save(kind, id, expectedVersion, value, principal, action) {
    const previous = id ? read(id, kind) : null
    if (previous && (!Number.isInteger(expectedVersion) || previous.version !== expectedVersion)) fail('This record changed. Reload before saving.', 409)
    if (!previous && db.prepare('SELECT count(*) AS n FROM records').get().n >= operationsPolicy.maxRecords) fail('Operations record capacity reached. Archive this City before adding records.', 409)
    const recordId = id || randomUUID(), version = (previous?.version || 0) + 1, at = now()
    const { id: _id, kind: _kind, version: _version, updatedAt: _at, ...data } = value
    const encoded = JSON.stringify(data)
    if (Buffer.byteLength(encoded) > 128_000) fail('Operations record exceeds 128 KB.')
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at,data=excluded.data').run(recordId, kind, version, at, encoded)
    db.prepare('INSERT INTO audit(record_id,version,at,actor,role,action,data) VALUES(?,?,?,?,?,?,?)').run(recordId, version, at, principal.id, principal.role, action, encoded)
    return read(recordId)
  }
  const meta = key => { const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key); return row ? JSON.parse(row.value) : null }
  const setMeta = (key, value) => db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  const searchTerms = (search = '') => {
    if (typeof search !== 'string' || search.length > 200) fail('Knowledge search must be at most 200 characters.')
    return (search.match(/[\p{L}\p{N}]+/gu) ?? []).map(term => `"${term}"`).join(' OR ')
  }
  return {
    read, transaction, save, meta, setMeta,
    procedures(query) {
      const terms = searchTerms(query.search)
      // Applicability needs metadata, not thousands of full SOP passages in memory.
      const records = db.prepare("SELECT id,kind,version,updated_at,json_remove(data,'$.body','$.source','$.note') AS data FROM records WHERE kind='knowledge'").all().map(decode)
      const selection = applicableProcedures(query.recordIds ? records.filter(record => query.recordIds.includes(record.id)) : records, query)
      const ids = selection.applicable.map(record => record.id)
      const matches = ids.length && terms ? db.prepare(`SELECT record_id FROM knowledge_fts WHERE record_id IN (SELECT value FROM json_each(?)) AND knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts),record_id LIMIT 5`).all(JSON.stringify(ids), terms).map(row => row.record_id) : ids.sort().slice(0, 5)
      return procedureResult(selection, matches.map(id => read(id, 'knowledge')))
    },
    publicKnowledge(search, at) {
      const terms = searchTerms(search)
      if (!Number.isFinite(Date.parse(at))) fail('A current clock is required for model disclosure.')
      const eligible = `kind='knowledge' AND json_extract(data,'$.visibility')='public' AND json_extract(data,'$.status')='approved'
        AND julianday(json_extract(data,'$.validUntil'))>julianday(?)
        AND (json_extract(data,'$.procedure') IS NULL OR julianday(json_extract(data,'$.procedure.effectiveFrom'))<=julianday(?))`
      const rows = terms ? db.prepare(`SELECT record_id FROM knowledge_fts WHERE record_id IN (SELECT id FROM records WHERE ${eligible}) AND knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts),record_id LIMIT 5`).all(at, at, terms)
        : db.prepare(`SELECT id AS record_id FROM records WHERE ${eligible} ORDER BY updated_at DESC,id LIMIT 5`).all(at, at)
      return rows.map(row => read(row.record_id, 'knowledge'))
    },
    finding(eventKey) { return decode(db.prepare("SELECT * FROM records WHERE kind='finding' AND json_extract(data,'$.eventKey')=?").get(eventKey)) },
    list(kind, { search = '', before = '', limit = 50 } = {}) {
      if (typeof search !== 'string' || search.length > 200 || typeof before !== 'string' || before.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid operations search.')
      return db.prepare(`SELECT * FROM records WHERE kind=? AND instr(lower(data),lower(?))>0 AND (?='' OR id>?) ORDER BY id LIMIT ?`).all(kind, search, before, before, limit).map(decode)
    },
    audit(id, before = Number.MAX_SAFE_INTEGER) {
      read(id)
      if (!Number.isSafeInteger(before) || before < 1) fail('Invalid audit cursor.')
      return db.prepare('SELECT sequence,version,at,actor,role,action,data FROM audit WHERE record_id=? AND sequence<? ORDER BY sequence DESC LIMIT 50').all(id, before).map(row => ({ ...row, data: JSON.parse(row.data) }))
    },
    observe(state, scheduleIdentity) {
      if (!state.observedAt) return
      const identity = recordIdentity([state.observedAt, scheduleIdentity, state.feeds.map(feed => [feed.sourceUrl, feed.feedTimestamp, feed.error])])
      if (meta('lastObservation') === identity) return
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: state.coverage.timezone || 'UTC', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(state.generatedAt))
      const at = clock(), bucket = Math.floor(at / (operationsPolicy.sampleMinutes * 60_000))
      const sample = { at: state.generatedAt, observedAt: state.observedAt, scheduleIdentity, serviceDate: state.coverage.serviceDate, coverageValid: state.coverage.valid,
        weekday: parts.find(part => part.type === 'weekday').value, hour: parts.find(part => part.type === 'hour').value,
        quality: qualitySummary(state), feeds: state.feeds.map(({ sourceUrl, kind, status, feedTimestamp }) => ({ sourceUrl, kind, status, feedTimestamp })),
        routes: state.routes.filter(route => route.reportingTrips || route.events).map(({ id, reportingTrips, maxDelaySeconds, widestInterval, events }) => ({ id, reportingTrips, maxDelaySeconds, widestInterval, events })) }
      transaction(() => {
        // First observation per bucket is retained, never weighted by UI polling frequency.
        const inserted = db.prepare('INSERT OR IGNORE INTO samples VALUES(?,?,?)').run(bucket, sample.at, JSON.stringify(sample))
        db.prepare('DELETE FROM samples WHERE bucket<?').run(Math.floor((at - operationsPolicy.retentionDays * 86_400_000) / (operationsPolicy.sampleMinutes * 60_000)))
        db.prepare('DELETE FROM samples WHERE bucket NOT IN (SELECT bucket FROM samples ORDER BY bucket DESC LIMIT ?)').run(operationsPolicy.maxSamples)
        setMeta('lastObservation', identity)
        if (inserted.changes) setMeta('lastStoredAt', now())
      })
    },
    samples() { return db.prepare('SELECT data FROM samples ORDER BY bucket').all().map(row => JSON.parse(row.data)) },
    routeSamples(routeId, scheduleIdentity) {
      // Project one route inside SQLite, before loading retained payloads into JS.
      return db.prepare(`SELECT json_extract(s.data,'$.serviceDate') AS serviceDate,json_extract(s.data,'$.weekday') AS weekday,
        json_extract(s.data,'$.hour') AS hour,json_extract(s.data,'$.coverageValid') AS coverageValid, r.value AS route
        FROM samples s,json_each(s.data,'$.routes') r
        WHERE json_extract(s.data,'$.scheduleIdentity')=? AND json_extract(r.value,'$.id')=? ORDER BY s.bucket`).all(scheduleIdentity, routeId)
        .map(({ route, ...row }) => ({ ...row, scheduleIdentity, routes: [JSON.parse(route)] }))
    },
    samplePage(before = Number.MAX_SAFE_INTEGER) {
      if (!Number.isSafeInteger(before)) fail('Invalid observation cursor.')
      return db.prepare('SELECT bucket,data FROM samples WHERE bucket<? ORDER BY bucket DESC LIMIT 100').all(before).map(row => ({ bucket: row.bucket, ...JSON.parse(row.data) }))
    },
    health() { return { schemaVersion: 1, projectId, lastStoredAt: meta('lastStoredAt'), sampleCount: db.prepare('SELECT count(*) AS n FROM samples').get().n,
      recordCount: db.prepare('SELECT count(*) AS n FROM records').get().n, auditCount: db.prepare('SELECT count(*) AS n FROM audit').get().n, policy: operationsPolicy,
      integrity: db.prepare('PRAGMA quick_check').get().quick_check } },
    close() { db.close() },
  }
}
