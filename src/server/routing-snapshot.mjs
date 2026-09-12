// JSON metadata and aligned little-endian arrays, independent of V8's private
// serialization version. Both Node and the packaged runtime read this format.
const magic = Buffer.from('VIGORS01')
const types = { Uint8Array, Uint32Array, Int32Array, Float64Array }
const align = value => Math.ceil(value / 8) * 8

export function encodeRoutingSnapshot(metadata, arrays = {}) {
  const layout = {}
  let size = 0
  for (const [name, array] of Object.entries(arrays)) {
    const type = array?.constructor?.name
    if (!Object.hasOwn(types, type)) throw new Error(`Unsupported snapshot array: ${name}`)
    layout[name] = { type, offset: size, length: array.length }
    size = align(size + array.byteLength)
  }
  const header = Buffer.from(JSON.stringify({ metadata, arrays: layout }))
  const dataOffset = align(16 + header.length)
  const bytes = Buffer.alloc(dataOffset + size)
  magic.copy(bytes)
  bytes.writeUInt32LE(header.length, 8)
  bytes.writeUInt32LE(dataOffset, 12)
  header.copy(bytes, 16)
  for (const [name, array] of Object.entries(arrays)) {
    Buffer.from(array.buffer, array.byteOffset, array.byteLength).copy(bytes, dataOffset + layout[name].offset)
  }
  return bytes
}

export function decodeRoutingSnapshot(bytes) {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new Error('Routing snapshots require a little-endian runtime.')
  }
  if (bytes.length < 16 || !bytes.subarray(0, 8).equals(magic)) {
    throw new Error('Unsupported or truncated routing snapshot.')
  }
  const headerLength = bytes.readUInt32LE(8)
  const dataOffset = bytes.readUInt32LE(12)
  if (dataOffset !== align(16 + headerLength) || dataOffset > bytes.length) {
    throw new Error('Routing snapshot metadata exceeds its file.')
  }
  const header = JSON.parse(bytes.toString('utf8', 16, 16 + headerLength))
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
