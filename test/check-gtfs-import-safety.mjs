// GTFS ZIP safety through the City compiler. Reader-level limits that need
// lowered bounds (sizes, logical records, rows) are checked by the Rust
// tests in crates/vigo-gtfs/tests/zip_safety.rs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { buildNationalGtfsStore, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-gtfs-safety-'))
const cases = []
const feed = {
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,38.9,-77.0\n',
  'routes.txt': 'route_id,route_short_name,route_type\nR,R,3\n',
  'trips.txt': 'route_id,service_id,trip_id\nR,WK,T\n',
  'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,A,1\n',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\n',
}

const withoutStops = () => Object.fromEntries(Object.entries(feed).filter(([name]) => name !== 'stops.txt'))

async function writeZip(name, entries, options = {}) {
  const zip = new JSZip()
  for (const [entryName, content] of Object.entries(entries)) zip.file(entryName, content, options.file)
  const zipPath = path.join(temporaryRoot, name)
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: options.compression ?? 'DEFLATE', platform: options.platform }))
  return zipPath
}

async function writeZipWithPatchedCentralName(name, originalName, replacementName, content) {
  assert.equal(Buffer.byteLength(originalName), Buffer.byteLength(replacementName), 'Patched ZIP fixture names must have equal byte length.')
  const zipPath = await writeZip(name, { ...withoutStops(), [originalName]: content })
  const bytes = await fs.readFile(zipPath)
  const centralNameOffset = bytes.lastIndexOf(Buffer.from(originalName))
  assert.ok(centralNameOffset >= 0, `Unable to find ${originalName} in ZIP fixture central directory.`)
  Buffer.from(replacementName).copy(bytes, centralNameOffset)
  await fs.writeFile(zipPath, bytes)
  return zipPath
}

const storeFor = (name) => path.join(temporaryRoot, `${name}.sqlite`)

async function build(name, zipPath) {
  return buildNationalGtfsStore({ zipPath, outputPath: storeFor(name) })
}

// A rejected feed leaves no store, staging database or sidecar behind.
async function rejects(name, zipPath, expected) {
  await assert.rejects(build(name, zipPath), expected)
  const leftovers = (await fs.readdir(temporaryRoot)).filter(file => file.startsWith(`${name}.sqlite`))
  assert.deepEqual(leftovers, [], `${name} left partial output`)
}

async function checkCase(name, callback) {
  const startedAt = performance.now()
  await callback()
  cases.push({ name, milliseconds: Number((performance.now() - startedAt).toFixed(3)) })
}


try {
  await checkCase('quoted and unquoted records preserve fields across UTF-8 chunks', async () => {
    const longName = '站'.repeat(30_000)
    const zipPath = await writeZip('csv-records.zip', {
      ...feed,
      'stops.txt': '﻿stop_id,stop_name,__proto__,constructor,extra\r\n'
        + `"A","${longName}, ""quoted""\nline",proto,ctor,\r\n`
        + 'B,Plain,,,\r\nC,Missing',
    })
    const metadata = await build('csv-records', zipPath)
    assert.equal(metadata.stopCount, 3)
    const db = new DatabaseSync(storeFor('csv-records'), { readOnly: true })
    try {
      assert.deepEqual(db.prepare('SELECT stop_id, name FROM stops ORDER BY stop_id').all().map(row => [row.stop_id, row.name]),
        [['A', `${longName}, "quoted"\nline`], ['B', 'Plain'], ['C', 'Missing']])
    } finally { db.close() }
  })

  await checkCase('valid-looking CSV with corrupt ZIP contents is rejected', async () => {
    const zipPath = await writeZip('corrupt-crc.zip', feed, { compression: 'STORE' })
    const bytes = await fs.readFile(zipPath)
    const offset = bytes.indexOf(Buffer.from('Alpha'))
    assert(offset >= 0)
    bytes[offset] = 'B'.charCodeAt(0)
    await fs.writeFile(zipPath, bytes)
    await rejects('corrupt-crc', zipPath, /CRC32 does not match/)
  })

  await checkCase('safe nested GTFS table paths remain supported', async () => {
    const zipPath = await writeZip('nested.zip', Object.fromEntries(Object.entries(feed).map(([name, content]) => [`feed/${name}`, content])))
    const metadata = await build('nested', zipPath)
    assert.equal(metadata.stopCount, 1)
    assert.deepEqual(metadata.tableProfiles.find(table => table.name === 'stops.txt').fields, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'])
  })

  await checkCase('duplicate recognized table basenames are rejected deterministically', async () => {
    const zipPath = await writeZip('duplicate.zip', { ...feed, 'nested/stops.txt': 'stop_id\nB\n' })
    await rejects('duplicate', zipPath, /Duplicate GTFS table basename: stops\.txt\./)
  })

  await checkCase('unsafe selected entry names are rejected before extraction', async () => {
    const zipPath = await writeZip('unsafe-name.zip', { ...withoutStops(), 'feed*/stops.txt': feed['stops.txt'] })
    await rejects('unsafe-name', zipPath, /Unsafe GTFS ZIP entry name for stops\.txt\./)
  })

  await checkCase('traversal and control-character table names are rejected', async () => {
    for (const [name, replacementName] of [['traversal-name', '../stops.txt'], ['control-name', 'a\u0001/stops.txt']]) {
      const zipPath = await writeZipWithPatchedCentralName(`${name}.zip`, 'aa/stops.txt', replacementName, feed['stops.txt'])
      await rejects(name, zipPath, /Unsafe GTFS ZIP entry name for stops\.txt\./)
    }
  })

  await checkCase('selected Unix symlink entries are rejected without extraction', async () => {
    const zip = new JSZip()
    for (const [name, content] of Object.entries(withoutStops())) zip.file(name, content)
    zip.file('stops.txt', 'target.txt', { unixPermissions: 0o120777 })
    const zipPath = path.join(temporaryRoot, 'symlink-entry.zip')
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }))
    await rejects('symlink-entry', zipPath, /Non-regular GTFS ZIP entry is unsupported: stops\.txt \(symlink\)\./)
    await assert.rejects(fs.access(path.join(temporaryRoot, 'stops.txt')))
  })

  await checkCase('invalid UTF-8 is rejected instead of replacement-decoded', async () => {
    const invalid = Buffer.concat([Buffer.from('stop_id,stop_name\nA,'), Buffer.from([0xc3, 0x28]), Buffer.from('\n')])
    const zipPath = await writeZip('invalid-utf8.zip', { ...feed, 'stops.txt': invalid })
    await rejects('invalid-utf8', zipPath, /GTFS stops\.txt is not valid UTF-8\./)
  })

  await checkCase('empty and duplicate CSV headers are rejected', async () => {
    for (const [name, content, expected] of [
      ['empty-header', 'stop_id,,stop_name\nA,,Alpha\n', /empty CSV header name/],
      ['duplicate-header', 'stop_id,stop_id\nA,B\n', /duplicate CSV header: stop_id/],
    ]) {
      const zipPath = await writeZip(`${name}.zip`, { ...feed, 'stops.txt': content })
      await rejects(name, zipPath, expected)
    }
  })

  await checkCase('CSV header column counts are bounded', async () => {
    const headers = Array.from({ length: 257 }, (_, index) => `field_${index}`)
    const zipPath = await writeZip('column-limit.zip', { ...feed, 'stops.txt': `${headers.join(',')}\n${headers.map(() => '').join(',')}\n` })
    await rejects('column-limit', zipPath, /GTFS stops\.txt exceeds the column limit \(256 columns\)\./)
  })

  console.log(JSON.stringify({ schemaVersion: 'vigo.gtfs-import-safety-check.v2', cases }, null, 2))
} finally {
  disposeAllNationalGtfsStores()
  await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
