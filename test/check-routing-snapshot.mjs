import assert from 'node:assert/strict'
import { deserialize, serialize } from 'node:v8'
import { gzipSync, gunzipSync } from 'node:zlib'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from '../src/server/routing-snapshot.mjs'

const metadata = { schemaVersion: 'fixture', names: ['Platform A', '入口'], empty: null }
const arrays = {
  flags: new Uint8Array([0, 1, 1]), offsets: new Uint32Array([0, 3, 0xffffffff]),
  values: new Float64Array([-0, 0.1, 12345.6789]), signed: new Int32Array([-3, 4]), empty: new Uint8Array(),
}
const bytes = encodeRoutingSnapshot(metadata, arrays)
assert.equal(bytes.subarray(0, 8).toString(), 'VIGORS02')
const restored = decodeRoutingSnapshot(bytes)
assert.deepEqual(restored.metadata, metadata)
for (const [name, array] of Object.entries(arrays)) {
  assert.deepEqual(restored.arrays[name], array)
  assert.equal(restored.arrays[name].byteOffset, 0)
}
assert.throws(() => deserialize(bytes), 'The persistent format must not be a V8 serialization stream.')
assert.throws(() => decodeRoutingSnapshot(serialize(metadata)), /Rebuild/)
const outdated = Buffer.from(bytes)
Buffer.from('VIGORS01').copy(outdated)
assert.throws(() => decodeRoutingSnapshot(outdated), /Rebuild/)
for (const length of [0, 8, 15, bytes.length - 1]) {
  assert.throws(() => decodeRoutingSnapshot(bytes.subarray(0, length)))
}
assert.throws(() => decodeRoutingSnapshot(Buffer.concat([bytes, Buffer.from([0])])), /trailing/)
const invalidHeader = Buffer.from(bytes)
invalidHeader.writeUInt32LE(0xffffffff, 8)
assert.throws(() => decodeRoutingSnapshot(invalidHeader), /metadata/)
function changedHeader(change) {
  const header = JSON.parse(gunzipSync(bytes.subarray(16, 16 + bytes.readUInt32LE(8))))
  change(header)
  const encoded = gzipSync(Buffer.from(JSON.stringify(header)))
  const offset = Math.ceil((16 + encoded.length) / 8) * 8
  const body = bytes.subarray(bytes.readUInt32LE(12))
  const output = Buffer.alloc(offset + body.length)
  Buffer.from('VIGORS02').copy(output)
  output.writeUInt32LE(encoded.length, 8); output.writeUInt32LE(offset, 12)
  encoded.copy(output, 16); body.copy(output, offset)
  return output
}
assert.throws(() => decodeRoutingSnapshot(changedHeader(header => { header.arrays.offsets.offset = 0 })), /layout/)
assert.throws(() => decodeRoutingSnapshot(changedHeader(header => { header.arrays.flags.type = '__proto__' })), /Invalid snapshot array/)
const repeatedMetadata = { rows: Array.from({ length: 5000 }, (_, index) => ({ index, evidence: 'shared immutable source identity' })) }
const compressed = encodeRoutingSnapshot(repeatedMetadata, arrays)
const metadataBytes = Buffer.byteLength(JSON.stringify(repeatedMetadata))
assert(compressed.length < metadataBytes / 5)
assert.deepEqual(decodeRoutingSnapshot(compressed), { metadata: repeatedMetadata, arrays: Object.assign(Object.create(null), arrays) })
const damaged = Buffer.from(compressed)
damaged[30] ^= 255
assert.throws(() => decodeRoutingSnapshot(damaged))
console.log(`Routing snapshots: ${metadataBytes} metadata bytes to ${compressed.length} total bytes; exact arrays, obsolete-format rejection and damaged-input checks passed.`)
