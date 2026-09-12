import assert from 'node:assert/strict'
import { deserialize, serialize } from 'node:v8'
import { decodeRoutingSnapshot, encodeRoutingSnapshot } from '../src/server/routing-snapshot.mjs'

const metadata = { schemaVersion: 'fixture', names: ['Platform A', '入口'], empty: null }
const arrays = {
  flags: new Uint8Array([0, 1, 1]), offsets: new Uint32Array([0, 3, 0xffffffff]),
  values: new Float64Array([-0, 0.1, 12345.6789]), signed: new Int32Array([-3, 4]), empty: new Uint8Array(),
}
const bytes = encodeRoutingSnapshot(metadata, arrays)
const restored = decodeRoutingSnapshot(bytes)
assert.deepEqual(restored.metadata, metadata)
for (const [name, array] of Object.entries(arrays)) {
  assert.deepEqual(restored.arrays[name], array)
  assert.equal(restored.arrays[name].byteOffset, 0)
}
assert.throws(() => deserialize(bytes), 'The persistent format must not be a V8 serialization stream.')
assert.throws(() => decodeRoutingSnapshot(serialize(metadata)), /Unsupported/)
for (const length of [0, 8, 15, bytes.length - 1]) {
  assert.throws(() => decodeRoutingSnapshot(bytes.subarray(0, length)))
}
assert.throws(() => decodeRoutingSnapshot(Buffer.concat([bytes, Buffer.from([0])])), /trailing/)
const invalidHeader = Buffer.from(bytes)
invalidHeader.writeUInt32LE(0xffffffff, 8)
assert.throws(() => decodeRoutingSnapshot(invalidHeader), /metadata/)
const overlapping = Buffer.from(bytes)
const header = JSON.parse(bytes.toString('utf8', 16, 16 + bytes.readUInt32LE(8)))
header.arrays.offsets.offset = 0
const replacement = Buffer.from(JSON.stringify(header))
assert.equal(replacement.length, bytes.readUInt32LE(8))
replacement.copy(overlapping, 16)
assert.throws(() => decodeRoutingSnapshot(overlapping), /layout/)
const polluted = Buffer.from(bytes)
Buffer.from(bytes.toString('utf8', 16, 16 + bytes.readUInt32LE(8)).replace('Uint8Array', '__proto__x')).copy(polluted, 16)
assert.throws(() => decodeRoutingSnapshot(polluted), /Invalid snapshot array/)
console.log('Portable routing snapshots preserve arrays and reject truncated, overlapping, and unsupported layouts.')
