import { gunzipSync } from 'node:zlib'
import { encodeNativeRoutingSnapshot } from './native-routing-kernel.mjs'

// Compress metadata, while leaving numeric arrays aligned and directly
// readable by the native runtime. Rebuild older snapshots with this runtime.
const magic = Buffer.from('VIGORS02')
const maximumHeaderBytes = 512 * 1024 * 1024
const types = { Uint8Array, Uint32Array, Int32Array, Float64Array }
const align = value => Math.ceil(value / 8) * 8

export function encodeRoutingSnapshot(metadata, arrays = {}) {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new Error('Routing snapshots require a little-endian runtime.')
  }
  const columns = Object.entries(arrays).map(([name, array]) => {
    const kind = array?.constructor?.name
    if (!Object.hasOwn(types, kind)) throw new Error(`Unsupported snapshot array: ${name}`)
    return { name, kind, data: new Uint8Array(array.buffer, array.byteOffset, array.byteLength) }
  })
  // Match the published envelope's JSON semantics: omitted values stay absent,
  // and a custom toJSON receives the key "metadata", not the root key "".
  const envelope = JSON.stringify({ metadata })
  const metadataJson = envelope === '{}' ? undefined : envelope.slice('{"metadata":'.length, -1)
  return encodeNativeRoutingSnapshot(metadataJson, columns)
}

export function decodeRoutingSnapshot(bytes) {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new Error('Routing snapshots require a little-endian runtime.')
  }
  if (bytes.length < 16) throw new Error('Routing snapshot is truncated.')
  if (!bytes.subarray(0, 8).equals(magic)) {
    throw new Error('Unsupported routing snapshot. Rebuild the City with VIGO 0.5.0 or later.')
  }
  const headerLength = bytes.readUInt32LE(8)
  const dataOffset = bytes.readUInt32LE(12)
  if (headerLength > maximumHeaderBytes || dataOffset !== align(16 + headerLength) || dataOffset > bytes.length) {
    throw new Error('Routing snapshot metadata exceeds its file.')
  }
  const headerBytes = bytes.subarray(16, 16 + headerLength)
  const header = JSON.parse(gunzipSync(headerBytes, { maxOutputLength: maximumHeaderBytes }).toString('utf8'))
  if (!header?.metadata || !header.arrays || typeof header.arrays !== 'object') {
    throw new Error('Routing snapshot metadata is invalid.')
  }
  const arrays = Object.create(null)
  let end = 0
  for (const [name, descriptor] of Object.entries(header.arrays)) {
    if (!descriptor || !Object.hasOwn(types, descriptor.type)) throw new Error(`Invalid snapshot array: ${name}`)
    const { offset, length, type } = descriptor
    const byteLength = length * types[type].BYTES_PER_ELEMENT
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0
      || offset !== align(end) || !Number.isSafeInteger(byteLength)
      || dataOffset + offset + byteLength > bytes.length) {
      throw new Error(`Routing snapshot array exceeds its layout: ${name}`)
    }
    // Each array owns an aligned, zero-offset buffer usable directly by N-API.
    const array = new types[type](length)
    new Uint8Array(array.buffer).set(bytes.subarray(dataOffset + offset, dataOffset + offset + byteLength))
    arrays[name] = array
    end = offset + byteLength
  }
  if (dataOffset + align(end) !== bytes.length) throw new Error('Routing snapshot has trailing data.')
  return { metadata: header.metadata, arrays }
}
