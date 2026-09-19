import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createInflateRaw, crc32 as updateCrc32 } from 'node:zlib'

const eocdSignature = 0x06054b50
const zip64EocdSignature = 0x06064b50
const zip64LocatorSignature = 0x07064b50
const centralEntrySignature = 0x02014b50
const localEntrySignature = 0x04034b50
const localEntryHeaderBytes = 30
const maximumZipCommentBytes = 65_535
const selectedTablesByArchive = new WeakMap()
const recognizedGtfsTables = new Set([
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'transfers.txt',
  'frequencies.txt',
  'shapes.txt',
  'pathways.txt',
  'fare_attributes.txt', 'fare_rules.txt', 'fare_products.txt', 'fare_media.txt',
  'rider_categories.txt', 'fare_leg_rules.txt', 'fare_leg_join_rules.txt',
  'fare_transfer_rules.txt', 'timeframes.txt', 'areas.txt', 'stop_areas.txt',
  'networks.txt', 'route_networks.txt',
])

export const gtfsZipSafetyLimits = Object.freeze({
  maxCompressedBytes: 1024 * 1024 * 1024,
  maxEntries: 256,
  maxCentralDirectoryBytes: 4 * 1024 * 1024,
  maxSelectedUncompressedBytes: 8 * 1024 * 1024 * 1024,
  maxSingleTableUncompressedBytes: 6 * 1024 * 1024 * 1024,
  maxRowsPerTable: 100_000_000,
  maxTotalRows: 150_000_000,
  maxLogicalRecordBytes: 1024 * 1024,
  maxColumns: 256,
  maxTableRuntimeMs: 30 * 60 * 1000,
})

function normalizedLimits(overrides = {}) {
  const limits = { ...gtfsZipSafetyLimits, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid GTFS ZIP safety limit: ${name}.`)
    }
  }
  return Object.freeze(limits)
}

function formatBytes(value) {
  return `${Number(value).toLocaleString('en-US', { useGrouping: false })} bytes`
}

function numberFromBigInt(value, field) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`GTFS ZIP ${field} exceeds the supported integer range.`)
  }
  return Number(value)
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (bytesRead === 0) throw new Error('GTFS ZIP ended before its declared metadata.')
    offset += bytesRead
  }
  return buffer
}

function lastEocdOffset(tail, absoluteTailOffset, fileSize) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== eocdSignature) continue
    const commentLength = tail.readUInt16LE(offset + 20)
    if (absoluteTailOffset + offset + 22 + commentLength === fileSize) return offset
  }
  return -1
}

async function centralDirectoryLocation(handle, fileSize, tail, tailOffset, eocdOffset) {
  const diskNumber = tail.readUInt16LE(eocdOffset + 4)
  const directoryDisk = tail.readUInt16LE(eocdOffset + 6)
  const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8)
  const entryCount = tail.readUInt16LE(eocdOffset + 10)
  const directoryBytes = tail.readUInt32LE(eocdOffset + 12)
  const directoryOffset = tail.readUInt32LE(eocdOffset + 16)
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk GTFS ZIP archives are unsupported.')
  }
  if (
    entryCount !== 0xffff
    && directoryBytes !== 0xffffffff
    && directoryOffset !== 0xffffffff
  ) {
    return { entryCount, directoryBytes, directoryOffset }
  }

  const absoluteEocdOffset = tailOffset + eocdOffset
  const locatorOffset = absoluteEocdOffset - 20
  if (locatorOffset < 0) throw new Error('GTFS ZIP64 locator is missing.')
  const locator = await readExactly(handle, 20, locatorOffset)
  if (locator.readUInt32LE(0) !== zip64LocatorSignature) {
    throw new Error('GTFS ZIP64 locator is missing.')
  }
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    throw new Error('Multi-disk GTFS ZIP64 archives are unsupported.')
  }
  const recordOffset = numberFromBigInt(locator.readBigUInt64LE(8), 'ZIP64 record offset')
  const record = await readExactly(handle, 56, recordOffset)
  if (record.readUInt32LE(0) !== zip64EocdSignature) {
    throw new Error('GTFS ZIP64 end record is malformed.')
  }
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
    throw new Error('Multi-disk GTFS ZIP64 archives are unsupported.')
  }
  const entriesOnZip64Disk = numberFromBigInt(record.readBigUInt64LE(24), 'entry count')
  const zip64EntryCount = numberFromBigInt(record.readBigUInt64LE(32), 'entry count')
  if (entriesOnZip64Disk !== zip64EntryCount) {
    throw new Error('Multi-disk GTFS ZIP64 archives are unsupported.')
  }
  return {
    entryCount: zip64EntryCount,
    directoryBytes: numberFromBigInt(record.readBigUInt64LE(40), 'central-directory size'),
    directoryOffset: numberFromBigInt(record.readBigUInt64LE(48), 'central-directory offset'),
  }
}

function zip64EntryValues(extra, raw) {
  const values = { ...raw }
  let offset = 0
  while (offset + 4 <= extra.length) {
    const fieldId = extra.readUInt16LE(offset)
    const fieldLength = extra.readUInt16LE(offset + 2)
    offset += 4
    if (offset + fieldLength > extra.length) {
      throw new Error('GTFS ZIP central-directory extra field is malformed.')
    }
    if (fieldId === 0x0001) {
      const field = extra.subarray(offset, offset + fieldLength)
      let valueOffset = 0
      const take = (name) => {
        if (valueOffset + 8 > field.length) {
          throw new Error('GTFS ZIP64 entry metadata is incomplete.')
        }
        values[name] = numberFromBigInt(field.readBigUInt64LE(valueOffset), name)
        valueOffset += 8
      }
      if (raw.uncompressedBytes === 0xffffffff) take('uncompressedBytes')
      if (raw.compressedBytes === 0xffffffff) take('compressedBytes')
      if (raw.localHeaderOffset === 0xffffffff) take('localHeaderOffset')
      return values
    }
    offset += fieldLength
  }
  if (
    raw.uncompressedBytes === 0xffffffff
    || raw.compressedBytes === 0xffffffff
    || raw.localHeaderOffset === 0xffffffff
  ) {
    throw new Error('GTFS ZIP64 entry metadata is missing.')
  }
  return values
}

function decodeEntryName(bytes, utf8) {
  if (!utf8) return bytes.toString('latin1')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('GTFS ZIP contains an invalid UTF-8 entry name.')
  }
}

function centralEntryType(versionMadeBy, externalAttributes, name) {
  const hostSystem = versionMadeBy >>> 8
  // ZIP host IDs 3 and 19 are Unix and macOS. Their high external-attribute
  // word carries the POSIX mode. Other host formats do not provide equivalent
  // type evidence, so admit them as unknown unless the DOS directory bit or
  // path syntax proves they are directories.
  if (hostSystem === 3 || hostSystem === 19) {
    const unixType = (externalAttributes >>> 16) & 0xf000
    if (unixType === 0x8000) return 'regular'
    if (unixType === 0xa000) return 'symlink'
    if (unixType === 0x4000) return 'directory'
    if (unixType !== 0) return 'non-regular'
  }
  if (name.endsWith('/') || (externalAttributes & 0x10) !== 0) return 'directory'
  return 'unknown'
}

function parseCentralDirectory(buffer, expectedEntryCount) {
  const entries = []
  let offset = 0
  while (offset < buffer.length) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== centralEntrySignature) {
      throw new Error('GTFS ZIP central directory is malformed.')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const versionMadeBy = buffer.readUInt16LE(offset + 4)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const entryLength = 46 + fileNameLength + extraLength + commentLength
    if (offset + entryLength > buffer.length) {
      throw new Error('GTFS ZIP central-directory entry is truncated.')
    }
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + fileNameLength)
    const extra = buffer.subarray(
      offset + 46 + fileNameLength,
      offset + 46 + fileNameLength + extraLength,
    )
    const raw = {
      compressedBytes: buffer.readUInt32LE(offset + 20),
      uncompressedBytes: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    }
    const sizes = zip64EntryValues(extra, raw)
    const name = decodeEntryName(nameBytes, Boolean(flags & 0x0800))
    entries.push(Object.freeze({
      name,
      crc32: buffer.readUInt32LE(offset + 16),
      compressedBytes: sizes.compressedBytes,
      uncompressedBytes: sizes.uncompressedBytes,
      localHeaderOffset: sizes.localHeaderOffset,
      encrypted: Boolean(flags & 0x0001),
      compressionMethod: method,
      entryType: centralEntryType(versionMadeBy, externalAttributes, name),
    }))
    offset += entryLength
  }
  if (entries.length !== expectedEntryCount) {
    throw new Error(`GTFS ZIP entry-count mismatch: expected ${expectedEntryCount}, found ${entries.length}.`)
  }
  return entries
}

function selectedTableName(entryName) {
  const basename = path.posix.basename(entryName).toLowerCase()
  return recognizedGtfsTables.has(basename) ? basename : null
}

function safeSelectedEntryName(entryName) {
  if (
    !entryName
    || entryName.startsWith('/')
    || entryName.startsWith('-')
    || entryName.includes('\\')
    || /[\u0000-\u001f\u007f-\u009f*?[\]]/u.test(entryName)
  ) {
    return false
  }
  const components = entryName.split('/')
  return components.every((component) => component && component !== '.' && component !== '..')
}

export async function inspectGtfsZip(zipPath, options = {}) {
  const limits = normalizedLimits(options.limits)
  const resolvedZipPath = path.resolve(String(zipPath))
  const stats = await fs.lstat(resolvedZipPath)
  if (!stats.isFile()) throw new Error('The selected GTFS path is not a regular file.')
  if (stats.size > limits.maxCompressedBytes) {
    throw new Error(`GTFS ZIP exceeds the compressed-size limit (${formatBytes(limits.maxCompressedBytes)}).`)
  }
  if (stats.size < 22) throw new Error('GTFS ZIP is too small to contain an end record.')

  const handle = await fs.open(resolvedZipPath, 'r')
  try {
    const tailLength = Math.min(
      stats.size,
      22 + maximumZipCommentBytes + 20 + 56,
    )
    const tailOffset = stats.size - tailLength
    const tail = await readExactly(handle, tailLength, tailOffset)
    const relativeEocdOffset = lastEocdOffset(tail, tailOffset, stats.size)
    if (relativeEocdOffset < 0) throw new Error('GTFS ZIP end record is missing or malformed.')
    const location = await centralDirectoryLocation(
      handle,
      stats.size,
      tail,
      tailOffset,
      relativeEocdOffset,
    )
    if (location.entryCount > limits.maxEntries) {
      throw new Error(`GTFS ZIP exceeds the entry-count limit (${limits.maxEntries} entries).`)
    }
    if (location.directoryBytes > limits.maxCentralDirectoryBytes) {
      throw new Error(`GTFS ZIP exceeds the central-directory limit (${formatBytes(limits.maxCentralDirectoryBytes)}).`)
    }
    if (
      location.directoryOffset < 0
      || location.directoryBytes < 0
      || location.directoryOffset + location.directoryBytes > stats.size
    ) {
      throw new Error('GTFS ZIP central-directory bounds are invalid.')
    }
    const directory = await readExactly(
      handle,
      location.directoryBytes,
      location.directoryOffset,
    )
    const entries = parseCentralDirectory(directory, location.entryCount)
    const tables = new Map()
    let selectedExpandedBytes = 0
    for (const entry of entries) {
      const tableName = selectedTableName(entry.name)
      if (!tableName) continue
      if (!safeSelectedEntryName(entry.name)) {
        throw new Error(`Unsafe GTFS ZIP entry name for ${tableName}.`)
      }
      if (entry.encrypted) throw new Error(`Encrypted GTFS ZIP entry is unsupported: ${tableName}.`)
      if (entry.entryType !== 'regular' && entry.entryType !== 'unknown') {
        throw new Error(`Non-regular GTFS ZIP entry is unsupported: ${tableName} (${entry.entryType}).`)
      }
      if (tables.has(tableName)) throw new Error(`Duplicate GTFS table basename: ${tableName}.`)
      if (entry.uncompressedBytes > limits.maxSingleTableUncompressedBytes) {
        throw new Error(
          `GTFS ${tableName} exceeds the single-table expanded-size limit (${formatBytes(limits.maxSingleTableUncompressedBytes)}).`,
        )
      }
      selectedExpandedBytes += entry.uncompressedBytes
      if (selectedExpandedBytes > limits.maxSelectedUncompressedBytes) {
        throw new Error(
          `GTFS ZIP exceeds the selected expanded-size limit (${formatBytes(limits.maxSelectedUncompressedBytes)}).`,
        )
      }
      tables.set(tableName, entry)
    }
    const archive = Object.freeze({
      zipPath: resolvedZipPath,
      compressedBytes: stats.size,
      selectedExpandedBytes,
      entries: Object.freeze(entries),
      limits,
    })
    selectedTablesByArchive.set(archive, tables)
    return archive
  } finally {
    await handle.close()
  }
}

export function gtfsTableEntry(archive, tableName) {
  const normalized = String(tableName ?? '').toLowerCase()
  return selectedTablesByArchive.get(archive)?.get(normalized) ?? null
}

export function createGtfsZipImportBudget() {
  return { totalRows: 0 }
}

function completeCsvRecord(value) {
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '"') continue
    if (quoted && value[index + 1] === '"') index += 1
    else quoted = !quoted
  }
  return !quoted
}

function csvFields(record) {
  const fields = []
  let value = ''
  let quoted = false
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index]
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      fields.push(value)
      value = ''
    } else {
      value += character
    }
  }
  fields.push(value)
  return fields
}

function validateHeaders(entry, values, limits) {
  const headers = values.map((value) => value.trim())
  if (headers.length > limits.maxColumns) {
    throw new Error(`GTFS ${entry} exceeds the column limit (${limits.maxColumns} columns).`)
  }
  if (headers.some((header) => !header)) {
    throw new Error(`GTFS ${entry} contains an empty CSV header name.`)
  }
  const observed = new Set()
  for (const header of headers) {
    const identity = header.toLowerCase()
    if (observed.has(identity)) {
      throw new Error(`GTFS ${entry} contains a duplicate CSV header: ${header}.`)
    }
    observed.add(identity)
  }
  return headers
}

function exceedsUtf8ByteLimit(value, limit) {
  // TextDecoder cannot produce lone surrogate code units, so three bytes per
  // UTF-16 code unit is a conservative upper bound. Normal short GTFS rows
  // avoid an otherwise redundant full UTF-8 byte-count scan.
  return value.length * 3 > limit && Buffer.byteLength(value, 'utf8') > limit
}

async function localEntryDataOffset(archive, entry) {
  if (!Number.isSafeInteger(entry.localHeaderOffset) || entry.localHeaderOffset < 0) {
    throw new Error(`GTFS ${entry.name} has an invalid local-header offset.`)
  }
  const handle = await fs.open(archive.zipPath, 'r')
  try {
    const header = await readExactly(handle, localEntryHeaderBytes, entry.localHeaderOffset)
    if (header.readUInt32LE(0) !== localEntrySignature) {
      throw new Error(`GTFS ${entry.name} has a malformed local ZIP header.`)
    }
    const nameBytes = header.readUInt16LE(26)
    const extraBytes = header.readUInt16LE(28)
    const dataOffset = entry.localHeaderOffset + localEntryHeaderBytes + nameBytes + extraBytes
    if (
      !Number.isSafeInteger(dataOffset)
      || dataOffset < 0
      || entry.compressedBytes < 0
      || dataOffset + entry.compressedBytes > archive.compressedBytes
    ) {
      throw new Error(`GTFS ${entry.name} exceeds its ZIP data bounds.`)
    }
    return dataOffset
  } finally {
    await handle.close()
  }
}

async function openGtfsEntryStream(archive, entry) {
  if (![0, 8].includes(entry.compressionMethod)) {
    throw new Error(`GTFS ${entry.name} uses unsupported ZIP compression method ${entry.compressionMethod}.`)
  }
  const dataOffset = await localEntryDataOffset(archive, entry)
  if (entry.compressedBytes === 0) return Readable.from([])
  const compressed = createReadStream(archive.zipPath, {
    start: dataOffset,
    end: dataOffset + entry.compressedBytes - 1,
  })
  return entry.compressionMethod === 8
    ? compressed.pipe(createInflateRaw())
    : compressed
}

function streamCompletion(stream) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    stream.once('close', () => finish({ closed: true }))
    stream.once('end', () => finish({ ended: true }))
    stream.once('error', (error) => finish({ error }))
  })
}

async function terminateAndDrain(stream, closed) {
  if (!stream.destroyed) stream.destroy()
  stream.resume?.()
  await closed
}

export async function streamGtfsZipCsv(archive, entry, onRow, options = {}) {
  if (!entry) return { fields: [], rows: 0 }
  const limits = normalizedLimits(options.limits ?? archive.limits)
  const budget = options.budget ?? createGtfsZipImportBudget()
  if (!Number.isSafeInteger(budget.totalRows) || budget.totalRows < 0) {
    throw new Error('Invalid GTFS ZIP import row budget.')
  }
  const tableName = selectedTableName(entry.name) ?? path.posix.basename(entry.name)
  if (!selectedTableName(entry.name) || gtfsTableEntry(archive, tableName) !== entry) {
    throw new Error('GTFS ZIP table descriptor was not admitted by preflight.')
  }
  if (entry.uncompressedBytes > limits.maxSingleTableUncompressedBytes) {
    throw new Error(
      `GTFS ${tableName} exceeds the single-table expanded-size limit (${formatBytes(limits.maxSingleTableUncompressedBytes)}).`,
    )
  }

  let source = null
  let closed = Promise.resolve({})
  let extractionError = null
  let timedOut = false
  let timer = null

  const decoder = new TextDecoder('utf-8', { fatal: true })
  let stdoutBytes = 0
  let lineBuffer = ''
  let pendingRecord = ''
  let headers = null
  let rows = 0
  let crc32 = 0

  const consumeLine = (physicalLine) => {
    const line = physicalLine.endsWith('\r') ? physicalLine.slice(0, -1) : physicalLine
    pendingRecord = pendingRecord ? `${pendingRecord}\n${line}` : line
    if (exceedsUtf8ByteLimit(pendingRecord, limits.maxLogicalRecordBytes)) {
      throw new Error(
        `GTFS ${tableName} exceeds the logical-record limit (${formatBytes(limits.maxLogicalRecordBytes)}).`,
      )
    }
    const quoted = pendingRecord.includes('"')
    if (quoted && !completeCsvRecord(pendingRecord)) return
    const record = headers ? pendingRecord : pendingRecord.replace(/^\uFEFF/u, '')
    const values = quoted ? csvFields(record) : record.split(',')
    pendingRecord = ''
    if (!headers) {
      headers = validateHeaders(tableName, values, limits)
      return
    }
    if (values.length > headers.length) {
      throw new Error(
        `GTFS ${tableName} row has ${values.length} columns but its header has ${headers.length}.`,
      )
    }
    if (rows + 1 > limits.maxRowsPerTable) {
      throw new Error(`GTFS ${tableName} exceeds the row limit (${limits.maxRowsPerTable} rows).`)
    }
    if (budget.totalRows + 1 > limits.maxTotalRows) {
      throw new Error(`GTFS ZIP exceeds the total-row limit (${limits.maxTotalRows} rows).`)
    }
    const row = {}
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index]
      const value = values[index] ?? ''
      if (header === '__proto__') {
        Object.defineProperty(row, header, { value, enumerable: true, writable: true, configurable: true })
      } else row[header] = value
    }
    onRow(row)
    rows += 1
    budget.totalRows += 1
  }

  const consumeText = (text) => {
    const combined = lineBuffer ? `${lineBuffer}${text}` : text
    let lineStart = 0
    let newlineIndex = combined.indexOf('\n', lineStart)
    while (newlineIndex >= 0) {
      consumeLine(combined.slice(lineStart, newlineIndex))
      lineStart = newlineIndex + 1
      newlineIndex = combined.indexOf('\n', lineStart)
    }
    lineBuffer = combined.slice(lineStart)
    const openRecord = pendingRecord ? `${pendingRecord}\n${lineBuffer}` : lineBuffer
    if (exceedsUtf8ByteLimit(openRecord, limits.maxLogicalRecordBytes)) {
      throw new Error(
        `GTFS ${tableName} exceeds the logical-record limit (${formatBytes(limits.maxLogicalRecordBytes)}).`,
      )
    }
  }

  try {
    source = await openGtfsEntryStream(archive, entry)
    source.once('error', (error) => { extractionError = error })
    closed = streamCompletion(source)
    timer = setTimeout(() => {
      timedOut = true
      source.destroy()
    }, limits.maxTableRuntimeMs)
    timer.unref?.()

    for await (const chunk of source) {
      stdoutBytes += chunk.length
      if (
        stdoutBytes > entry.uncompressedBytes
        || stdoutBytes > limits.maxSingleTableUncompressedBytes
      ) {
        throw new Error(
          `GTFS ${tableName} exceeds its declared or permitted expanded size.`,
        )
      }
      crc32 = updateCrc32(chunk, crc32)
      let decoded
      try {
        decoded = decoder.decode(chunk, { stream: true })
      } catch (error) {
        throw new Error(`GTFS ${tableName} is not valid UTF-8.`, { cause: error })
      }
      consumeText(decoded)
    }
    let decodedTail
    try {
      decodedTail = decoder.decode()
    } catch (error) {
      throw new Error(`GTFS ${tableName} is not valid UTF-8.`, { cause: error })
    }
    consumeText(decodedTail)
    if (lineBuffer) {
      consumeLine(lineBuffer)
      lineBuffer = ''
    }
    if (pendingRecord) throw new Error(`GTFS ${tableName} ended inside a quoted CSV record.`)

    if (timedOut) {
      throw new Error(`GTFS ${tableName} extraction exceeded ${limits.maxTableRuntimeMs} ms.`)
    }
    await closed
    if (extractionError) throw new Error(`Unable to read GTFS ${tableName}.`, { cause: extractionError })
    if (stdoutBytes !== entry.uncompressedBytes) {
      throw new Error(`GTFS ${tableName} expanded-size metadata does not match extracted bytes.`)
    }
    if (crc32 !== entry.crc32) {
      throw new Error(`GTFS ${tableName} CRC32 does not match its ZIP metadata.`)
    }
    if (!headers) throw new Error(`GTFS ${tableName} is missing a CSV header.`)
    return { fields: headers, rows }
  } catch (error) {
    if (source) await terminateAndDrain(source, closed)
    if (timedOut && !String(error?.message ?? '').includes('extraction exceeded')) {
      throw new Error(`GTFS ${tableName} extraction exceeded ${limits.maxTableRuntimeMs} ms.`, { cause: error })
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
