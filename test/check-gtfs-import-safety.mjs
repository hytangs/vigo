import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import JSZip from 'jszip'
import {
  createGtfsZipImportBudget,
  gtfsTableEntry,
  gtfsZipSafetyLimits,
  inspectGtfsZip,
  streamGtfsZipCsv,
} from '../src/server/gtfs-zip-reader.mjs'

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-gtfs-safety-'))
const cases = []

async function writeZip(name, entries) {
  const zip = new JSZip()
  for (const [entryName, content] of Object.entries(entries)) {
    zip.file(entryName, content)
  }
  const zipPath = path.join(temporaryRoot, name)
  await fs.writeFile(zipPath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  }))
  return zipPath
}

async function writeZipWithPatchedCentralName(name, originalName, replacementName, content) {
  assert.equal(
    Buffer.byteLength(originalName),
    Buffer.byteLength(replacementName),
    'Patched ZIP fixture names must have equal byte length.',
  )
  const zipPath = await writeZip(name, { [originalName]: content })
  const bytes = await fs.readFile(zipPath)
  const originalBytes = Buffer.from(originalName)
  const centralNameOffset = bytes.lastIndexOf(originalBytes)
  assert.ok(centralNameOffset >= 0, `Unable to find ${originalName} in ZIP fixture central directory.`)
  Buffer.from(replacementName).copy(bytes, centralNameOffset)
  await fs.writeFile(zipPath, bytes)
  return zipPath
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
      'stops.txt': '\uFEFFstop_id,stop_name,__proto__,constructor,extra\r\n'
        + `"A","${longName}, ""quoted""\nline",proto,ctor,\r\n`
        + 'B,Plain,,,\r\nC,Missing',
    })
    const archive = await inspectGtfsZip(zipPath)
    const rows = []
    await streamGtfsZipCsv(archive, gtfsTableEntry(archive, 'stops.txt'), (row) => rows.push(row))
    assert.equal(rows.length, 3)
    assert.equal(rows[0].stop_name, `${longName}, "quoted"\nline`)
    assert.equal(rows[0].__proto__, 'proto')
    assert.equal(rows[0].constructor, 'ctor')
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype)
    assert.equal(rows[1].stop_id, 'B')
    assert.equal(rows[1].extra, '')
    assert.equal(rows[2].stop_name, 'Missing')
    assert.equal(rows[2].constructor, '')
    assert.equal(rows[0].stop_id, 'A', 'Streaming callbacks retain independent row objects.')
  })

  await checkCase('valid-looking CSV with corrupt ZIP contents is rejected', async () => {
    const zip = new JSZip()
    zip.file('stops.txt', 'stop_id,stop_name\nA,Alpha\n')
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
    const offset = bytes.indexOf(Buffer.from('Alpha'))
    assert(offset >= 0)
    bytes[offset] = 'B'.charCodeAt(0)
    const zipPath = path.join(temporaryRoot, 'corrupt-crc.zip')
    await fs.writeFile(zipPath, bytes)
    const archive = await inspectGtfsZip(zipPath)
    await assert.rejects(streamGtfsZipCsv(archive, gtfsTableEntry(archive, 'stops.txt'), () => {}), /CRC32 does not match/)
  })

  await checkCase('safe nested GTFS table paths remain supported', async () => {
    const zipPath = await writeZip('nested.zip', {
      'feed/stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,38.9,-77.0\n',
      'feed/routes.txt': 'route_id,route_short_name,route_type\nR,R,3\n',
      'feed/trips.txt': 'route_id,service_id,trip_id\nR,WK,T\n',
      'feed/stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,A,1\n',
      'feed/calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\n',
    })
    const archive = await inspectGtfsZip(zipPath)
    const stops = gtfsTableEntry(archive, 'stops.txt')
    assert.equal(stops?.name, 'feed/stops.txt')
    const rows = []
    const profile = await streamGtfsZipCsv(archive, stops, (row) => rows.push(row), {
      budget: createGtfsZipImportBudget(),
    })
    assert.deepEqual(profile.fields, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'])
    assert.equal(profile.rows, 1)
    assert.equal(rows[0].stop_id, 'A')
  })

  await checkCase('duplicate recognized table basenames are rejected deterministically', async () => {
    const zipPath = await writeZip('duplicate.zip', {
      'stops.txt': 'stop_id\nA\n',
      'nested/stops.txt': 'stop_id\nB\n',
    })
    await assert.rejects(
      inspectGtfsZip(zipPath),
      /Duplicate GTFS table basename: stops\.txt\./,
    )
  })

  await checkCase('unsafe selected entry names are rejected before extraction', async () => {
    const zipPath = await writeZip('unsafe-name.zip', {
      'feed*/stops.txt': 'stop_id\nA\n',
    })
    await assert.rejects(
      inspectGtfsZip(zipPath),
      /Unsafe GTFS ZIP entry name for stops\.txt\./,
    )
  })

  await checkCase('traversal and control-character table names are rejected', async () => {
    for (const [name, replacementName] of [
      ['traversal-name.zip', '../stops.txt'],
      ['control-name.zip', 'a\u0001/stops.txt'],
    ]) {
      const zipPath = await writeZipWithPatchedCentralName(
        name,
        'aa/stops.txt',
        replacementName,
        'stop_id\nA\n',
      )
      await assert.rejects(
        inspectGtfsZip(zipPath),
        /Unsafe GTFS ZIP entry name for stops\.txt\./,
      )
    }
  })

  await checkCase('selected Unix symlink entries are rejected without extraction', async () => {
    const zip = new JSZip()
    zip.file('stops.txt', 'target.txt', { unixPermissions: 0o120777 })
    const zipPath = path.join(temporaryRoot, 'symlink-entry.zip')
    await fs.writeFile(zipPath, await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      platform: 'UNIX',
    }))
    await assert.rejects(
      inspectGtfsZip(zipPath),
      /Non-regular GTFS ZIP entry is unsupported: stops\.txt \(symlink\)\./,
    )
    await assert.rejects(fs.access(path.join(temporaryRoot, 'stops.txt')))
  })

  await checkCase('invalid UTF-8 is rejected instead of replacement-decoded', async () => {
    const invalid = Buffer.concat([
      Buffer.from('stop_id,stop_name\nA,'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('\n'),
    ])
    const zipPath = await writeZip('invalid-utf8.zip', { 'stops.txt': invalid })
    const archive = await inspectGtfsZip(zipPath)
    await assert.rejects(
      streamGtfsZipCsv(archive, gtfsTableEntry(archive, 'stops.txt'), () => {}),
      /GTFS stops\.txt is not valid UTF-8\./,
    )
  })

  await checkCase('single-table expanded-size limits reject oversized metadata', async () => {
    const zipPath = await writeZip('oversized-table.zip', {
      'stops.txt': `stop_id,stop_name\nA,${'x'.repeat(128)}\n`,
    })
    await assert.rejects(
      inspectGtfsZip(zipPath, {
        limits: { ...gtfsZipSafetyLimits, maxSingleTableUncompressedBytes: 64 },
      }),
      /GTFS stops\.txt exceeds the single-table expanded-size limit \(64 bytes\)\./,
    )
  })

  await checkCase('archive compressed and selected expanded-size limits are enforced', async () => {
    const zipPath = await writeZip('archive-limits.zip', {
      'agency.txt': `agency_id,agency_name\nA,${'a'.repeat(80)}\n`,
      'stops.txt': `stop_id,stop_name\nS,${'s'.repeat(80)}\n`,
    })
    await assert.rejects(
      inspectGtfsZip(zipPath, {
        limits: { ...gtfsZipSafetyLimits, maxCompressedBytes: 32 },
      }),
      /GTFS ZIP exceeds the compressed-size limit \(32 bytes\)\./,
    )
    await assert.rejects(
      inspectGtfsZip(zipPath, {
        limits: {
          ...gtfsZipSafetyLimits,
          maxSingleTableUncompressedBytes: 256,
          maxSelectedUncompressedBytes: 128,
        },
      }),
      /GTFS ZIP exceeds the selected expanded-size limit \(128 bytes\)\./,
    )
  })

  await checkCase('logical CSV records are bounded during streaming', async () => {
    const zipPath = await writeZip('oversized-record.zip', {
      'stops.txt': `stop_id,stop_name\nA,"${'x'.repeat(128)}"\n`,
    })
    const limits = { ...gtfsZipSafetyLimits, maxLogicalRecordBytes: 64 }
    const archive = await inspectGtfsZip(zipPath, { limits })
    await assert.rejects(
      streamGtfsZipCsv(archive, gtfsTableEntry(archive, 'stops.txt'), () => {}, { limits }),
      /GTFS stops\.txt exceeds the logical-record limit \(64 bytes\)\./,
    )
  })

  await checkCase('empty and duplicate CSV headers are rejected', async () => {
    for (const [name, content, expected] of [
      ['empty-header.zip', 'stop_id,,stop_name\nA,,Alpha\n', /empty CSV header name/],
      ['duplicate-header.zip', 'stop_id,stop_id\nA,B\n', /duplicate CSV header: stop_id/],
    ]) {
      const zipPath = await writeZip(name, { 'stops.txt': content })
      const archive = await inspectGtfsZip(zipPath)
      await assert.rejects(
        streamGtfsZipCsv(archive, gtfsTableEntry(archive, 'stops.txt'), () => {}),
        expected,
      )
    }
  })

  await checkCase('CSV header column counts are bounded', async () => {
    const headers = Array.from({ length: 257 }, (_, index) => `field_${index}`)
    const zipPath = await writeZip('column-limit.zip', {
      'stops.txt': `${headers.join(',')}\n${headers.map(() => '').join(',')}\n`,
    })
    const archive = await inspectGtfsZip(zipPath)
    await assert.rejects(
      streamGtfsZipCsv(archive, gtfsTableEntry(archive, 'stops.txt'), () => {}),
      /GTFS stops\.txt exceeds the column limit \(256 columns\)\./,
    )
  })

  await checkCase('row and total-row budgets are enforced', async () => {
    const zipPath = await writeZip('row-limit.zip', {
      'stops.txt': 'stop_id\nA\nB\n',
    })
    const limits = {
      ...gtfsZipSafetyLimits,
      maxRowsPerTable: 1,
      maxTotalRows: 1,
    }
    const archive = await inspectGtfsZip(zipPath, { limits })
    await assert.rejects(
      streamGtfsZipCsv(
        archive,
        gtfsTableEntry(archive, 'stops.txt'),
        () => {},
        { limits, budget: createGtfsZipImportBudget() },
      ),
      /GTFS stops\.txt exceeds the row limit \(1 rows\)\./,
    )

    const totalZipPath = await writeZip('total-row-limit.zip', {
      'agency.txt': 'agency_id,agency_name\nA,Agency\n',
      'stops.txt': 'stop_id\nA\n',
    })
    const totalLimits = {
      ...gtfsZipSafetyLimits,
      maxRowsPerTable: 2,
      maxTotalRows: 1,
    }
    const totalArchive = await inspectGtfsZip(totalZipPath, { limits: totalLimits })
    const budget = createGtfsZipImportBudget()
    await streamGtfsZipCsv(
      totalArchive,
      gtfsTableEntry(totalArchive, 'agency.txt'),
      () => {},
      { limits: totalLimits, budget },
    )
    await assert.rejects(
      streamGtfsZipCsv(
        totalArchive,
        gtfsTableEntry(totalArchive, 'stops.txt'),
        () => {},
        { limits: totalLimits, budget },
      ),
      /GTFS ZIP exceeds the total-row limit \(1 rows\)\./,
    )
  })

  console.log(JSON.stringify({
    schemaVersion: 'vigo.gtfs-import-safety-check.v1',
    cases,
  }, null, 2))
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
