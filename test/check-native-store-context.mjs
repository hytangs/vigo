import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { nativeStoreContext } from '../src/server/native-store-context.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-context-'))
try {
  const timetable = path.join(root, 'timetable.sqlite')
  const streets = path.join(root, 'streets.sqlite')
  const db = new DatabaseSync(timetable)
  db.exec('CREATE TABLE metadata (key TEXT, value TEXT); CREATE TABLE connection_permissions (id INTEGER)')
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('sourceFingerprint', '"timetable-one"')
  db.close()
  fs.writeFileSync(streets, 'first street revision')
  const first = nativeStoreContext(timetable, streets)
  assert.equal(nativeStoreContext(timetable, streets), first)
  const stamp = fs.statSync(streets)
  const replacement = `${streets}.new`
  fs.writeFileSync(replacement, 'other street revision')
  fs.utimesSync(replacement, stamp.atime, stamp.mtime)
  fs.renameSync(replacement, streets)
  const changed = nativeStoreContext(timetable, streets)
  assert.notEqual(changed.streetIdentity, first.streetIdentity)
  assert.equal(changed.staticTimetableIdentity, first.staticTimetableIdentity)
  const writer = new DatabaseSync(timetable)
  writer.prepare('UPDATE metadata SET value = ? WHERE key = ?').run('"timetable-two"', 'sourceFingerprint')
  writer.close()
  assert.equal(nativeStoreContext(timetable, streets).staticTimetableIdentity, 'timetable-two')
  console.log('Studio context follows timetable and street publication independently.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
