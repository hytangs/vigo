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
// Retained independent 0.5 writer. Compression streams may differ; descriptor
// order, metadata and every aligned payload byte must stay identical.
function publishedWriter(metadata, arrays) {
  const layout = {}
  let size = 0
  const align = n => Math.ceil(n / 8) * 8
  for (const [name, array] of Object.entries(arrays)) {
    layout[name] = { type: array.constructor.name, offset: size, length: array.length }
    size = align(size + array.byteLength)
  }
  const header = gzipSync(Buffer.from(JSON.stringify({ metadata, arrays: layout })), { level: 1 })
  const base = align(16 + header.length)
  const bytes = Buffer.alloc(base + size)
  Buffer.from('VIGORS02').copy(bytes)
  bytes.writeUInt32LE(header.length, 8)
  bytes.writeUInt32LE(base, 12)
  header.copy(bytes, 16)
  for (const [name, array] of Object.entries(arrays)) {
    Buffer.from(array.buffer, array.byteOffset, array.byteLength).copy(bytes, base + layout[name].offset)
  }
  return bytes
}
const headerOf = bytes => gunzipSync(bytes.subarray(16, 16 + bytes.readUInt32LE(8)))
const payloadOf = bytes => bytes.subarray(bytes.readUInt32LE(12))
for (let i = 0; i < 80; i++) {
  const columns = {
    z: new Uint8Array([99, i, 255, 77]).subarray(1, 3),
    empty: new Uint32Array(),
    a: new Int32Array([0, -i, -2147483648, 2147483647]).subarray(1),
    floats: new Float64Array([-0, Number.MIN_VALUE, Math.PI * i, Infinity, NaN]),
    '入口': new Uint32Array([0xffffffff, i]),
  }
  const meta = { source: `feed-${i}`, unknown: null, clock: i * 600, names: ['入口', 'A'] }
  const previous = publishedWriter(meta, columns)
  const native = encodeRoutingSnapshot(meta, columns)
  assert.deepEqual(headerOf(native), headerOf(previous))
  assert.deepEqual(payloadOf(native), payloadOf(previous))
  assert.deepEqual(decodeRoutingSnapshot(native), decodeRoutingSnapshot(previous))
}
assert.throws(() => encodeRoutingSnapshot(metadata, { bad: new Float32Array([1]) }), /Unsupported snapshot array/)
for (const meta of [undefined, null, false, 0, '', Symbol('omitted'), () => {},
  { toJSON(key) { return { key, value: 12 } } }, { toJSON() { return undefined } }]) {
  assert.deepEqual(headerOf(encodeRoutingSnapshot(meta)), headerOf(publishedWriter(meta, {})))
}
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
