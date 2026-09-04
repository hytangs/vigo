import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { PbfWriter } from 'pbf'
import { forEachPbfBlock, osmPbfLimits } from '../src/server/osm-pbf-reader.mjs'

function pbfMessage(write, value) {
  const writer = new PbfWriter()
  write(value, writer)
  return Buffer.from(writer.finish())
}

function writeBlobHeader(value, pbf) {
  pbf.writeStringField(1, value.type)
  pbf.writeVarintField(3, value.dataSize)
}

function writeBlob(value, pbf) {
  if (value.raw) pbf.writeBytesField(1, value.raw)
  if (value.rawSize !== undefined) pbf.writeVarintField(2, value.rawSize)
  if (value.zlibData) pbf.writeBytesField(3, value.zlibData)
  if (value.lz4Data) pbf.writeBytesField(6, value.lz4Data)
}

function writeHeaderBlock(value, pbf) {
  for (const feature of value.requiredFeatures) pbf.writeStringField(4, feature)
}

function writeStringTable(_value, pbf) {
  pbf.writeStringField(1, '')
}

function writePrimitiveBlock(_value, pbf) {
  pbf.writeMessage(1, writeStringTable, {})
}

function framedBlock(type, blobValue) {
  const blob = pbfMessage(writeBlob, blobValue)
  const header = pbfMessage(writeBlobHeader, { type, dataSize: blob.length })
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  return Buffer.concat([length, header, blob])
}

function rawBlock(type, raw) {
  return framedBlock(type, { raw, rawSize: raw.length })
}

const validHeader = rawBlock('OSMHeader', pbfMessage(writeHeaderBlock, {
  requiredFeatures: ['OsmSchema-V0.6'],
}))
const validData = pbfMessage(writePrimitiveBlock, {})
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-osm-pbf-safety-'))

async function writeCase(name, contents) {
  const filePath = path.join(directory, `${name}.osm.pbf`)
  await fs.writeFile(filePath, contents)
  return filePath
}

async function assertRejected(name, contents, pattern) {
  const filePath = await writeCase(name, contents)
  await assert.rejects(
    () => forEachPbfBlock(filePath, async () => {}),
    pattern,
  )
}

try {
  const validPath = await writeCase('valid', Buffer.concat([validHeader, rawBlock('OSMData', validData)]))
  let dataBlocks = 0
  await forEachPbfBlock(validPath, async () => { dataBlocks += 1 })
  assert.equal(dataBlocks, 1)

  await assertRejected('missing-header', rawBlock('OSMData', validData), /OSMHeader before OSMData/)

  const oversizedHeader = Buffer.alloc(4)
  oversizedHeader.writeUInt32BE(osmPbfLimits.blobHeaderBytes + 1)
  await assertRejected('oversized-header', oversizedHeader, /BlobHeader length/)

  const oversizedDataHeader = pbfMessage(writeBlobHeader, {
    type: 'OSMData',
    dataSize: osmPbfLimits.blobBytes + 1,
  })
  const oversizedDataLength = Buffer.alloc(4)
  oversizedDataLength.writeUInt32BE(oversizedDataHeader.length)
  await assertRejected(
    'oversized-data',
    Buffer.concat([oversizedDataLength, oversizedDataHeader]),
    /invalid type or data size/,
  )

  const unsupportedHeader = rawBlock('OSMHeader', pbfMessage(writeHeaderBlock, {
    requiredFeatures: ['OsmSchema-V0.6', 'HistoricalInformation'],
  }))
  await assertRejected(
    'unsupported-feature',
    Buffer.concat([unsupportedHeader, rawBlock('OSMData', validData)]),
    /unsupported required features/,
  )

  await assertRejected(
    'unsupported-compression',
    Buffer.concat([validHeader, framedBlock('OSMData', { lz4Data: Buffer.from([1, 2, 3]), rawSize: 3 })]),
    /unsupported compression/,
  )

  await assertRejected(
    'zlib-size-mismatch',
    Buffer.concat([validHeader, framedBlock('OSMData', {
      zlibData: deflateSync(validData),
      rawSize: validData.length + 1,
    })]),
    /raw_size does not match/,
  )

  await assertRejected(
    'zlib-oversized-raw-size',
    Buffer.concat([validHeader, framedBlock('OSMData', {
      zlibData: deflateSync(validData),
      rawSize: osmPbfLimits.blobBytes + 1,
    })]),
    /invalid raw_size/,
  )

  console.log(JSON.stringify({
    status: 'passed',
    blobHeaderLimitBytes: osmPbfLimits.blobHeaderBytes,
    blobLimitBytes: osmPbfLimits.blobBytes,
    cases: 7,
  }))
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
