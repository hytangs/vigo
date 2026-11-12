import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { PbfWriter } from 'pbf'
import { DatabaseSync } from 'node:sqlite'
import { buildNationalOsmStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { haversineKm } from '../src/server/geometry-utils.mjs'

// The street compiler in the `vigo` executable reads every PBF. These cases
// run it on malformed files and expect its reader to reject them.
const osmPbfLimits = Object.freeze({ blobHeaderBytes: 64 * 1024, blobBytes: 32 * 1024 * 1024 })
for (let latitude=-89;latitude<90;latitude+=.7) {
  const distance=haversineKm([23.4,latitude],[-156.6,-latitude])
  assert(Number.isFinite(distance)&&Math.abs(distance-Math.PI*6371.0088)<.001)
}

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

// One residential way through nodes [id, lat, lon] in 100-nanodegree units.
function writeStreetBlock(nodes, pbf) {
  pbf.writeMessage(1, (_, table) => { for (const s of ['', 'highway', 'residential']) table.writeStringField(1, s) })
  pbf.writeMessage(2, (_, group) => {
    for (const [id, lat, lon] of nodes) group.writeMessage(1, (__, node) => {
      node.writeSVarintField(1, id); node.writeSVarintField(8, lat); node.writeSVarintField(9, lon)
    })
    group.writeMessage(3, (__, way) => {
      way.writeVarintField(1, 1); way.writePackedVarint(2, [1]); way.writePackedVarint(3, [2])
      way.writePackedSVarint(8, nodes.map(([id], index) => id - (nodes[index - 1]?.[0] ?? 0)))
    })
  })
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
    () => buildNationalOsmStore({ pbfPath: filePath, outputPath: `${filePath}.sqlite`, includeDriving: false }),
    pattern,
  )
}

try {
  // A well-formed file without streets is read to the end and fails only for its empty graph.
  await assertRejected('valid', Buffer.concat([validHeader, rawBlock('OSMData', validData)]), /graph_empty/)

  // Coordinates are checked against the geographic bounds; the bounds themselves are valid.
  const streetCase = nodes => Buffer.concat([validHeader, rawBlock('OSMData', pbfMessage(writeStreetBlock, nodes))])
  const boundaryPath = await writeCase('boundary', streetCase([[1, 899_999_000, 1_799_999_000], [2, 900_000_000, 1_800_000_000]]))
  await buildNationalOsmStore({ pbfPath: boundaryPath, outputPath: `${boundaryPath}.sqlite`, includeDriving: false })
  const boundary = new DatabaseSync(`${boundaryPath}.sqlite`, { readOnly: true })
  try {
    assert.deepEqual({ ...boundary.prepare('SELECT lat, lon FROM walk_nodes WHERE node_id=2').get() }, { lat: 90, lon: 180 })
  } finally {
    boundary.close()
    disposeNationalOsmStore(`${boundaryPath}.sqlite`)
  }
  for (const [index, [lat, lon]] of [[900_000_001, 0], [-900_000_001, 0], [0, 1_800_000_001], [0, -1_800_000_001]].entries()) {
    await assertRejected(`coordinate-${index}`, streetCase([[1, 0, 0], [2, lat, lon]]), /invalid geographic coordinate/)
  }

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
    cases: 12,
  }))
} finally {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
