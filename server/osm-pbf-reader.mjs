import fs from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { PbfReader } from 'pbf'

const decoder = new TextDecoder('utf8', { fatal: true })

export const osmPbfLimits = Object.freeze({
  blobHeaderBytes: 64 * 1024,
  blobBytes: 32 * 1024 * 1024,
  stringTableEntries: 1_000_000,
  primitiveGroups: 100_000,
  nodesPerBlock: 5_000_000,
  waysPerBlock: 1_000_000,
  tagsPerBlock: 5_000_000,
  wayReferences: 5_000_000,
})

const supportedRequiredFeatures = new Set(['OsmSchema-V0.6', 'DenseNodes'])

function reader(bytes) {
  const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes)
  return new PbfReader(input)
}

function readBlobHeader(bytes) {
  return reader(bytes).readFields((tag, result, pbf) => {
    if (tag === 1) result.type = pbf.readString()
    else if (tag === 3) result.dataSize = pbf.readVarint()
  }, { type: '', dataSize: 0 })
}

function readBlob(bytes) {
  return reader(bytes).readFields((tag, result, pbf) => {
    if (tag === 1) result.raw = pbf.readBytes()
    else if (tag === 2) result.rawSize = pbf.readVarint()
    else if (tag === 3) result.zlibData = pbf.readBytes()
    else if ([4, 5, 6, 7].includes(tag)) {
      result.unsupportedCompression = tag
      pbf.readBytes()
    }
  }, {})
}

function readHeaderBlock(bytes) {
  return reader(bytes).readFields((tag, result, pbf) => {
    if (tag === 4) result.requiredFeatures.push(pbf.readString())
    else if (tag === 5) result.optionalFeatures.push(pbf.readString())
  }, { requiredFeatures: [], optionalFeatures: [] })
}

function readStringTable(bytes) {
  return reader(bytes).readFields((tag, result, pbf) => {
    if (tag !== 1) return
    if (result.length >= osmPbfLimits.stringTableEntries) {
      throw new Error('OSM PBF string table exceeds the per-block entry limit.')
    }
    result.push(decoder.decode(pbf.readBytes()))
  }, [])
}

function readPrimitiveBlock(bytes, requiredFeatures) {
  const block = reader(bytes).readFields((tag, result, pbf) => {
    if (tag === 1) result.strings = readStringTable(pbf.readBytes())
    else if (tag === 2) {
      if (result.groups.length >= osmPbfLimits.primitiveGroups) {
        throw new Error('OSM PBF primitive block exceeds the group limit.')
      }
      result.groups.push(pbf.readBytes())
    } else if (tag === 17) result.granularity = pbf.readVarint()
    else if (tag === 19) result.latOffset = pbf.readVarint(true)
    else if (tag === 20) result.lonOffset = pbf.readVarint(true)
  }, {
    strings: [],
    groups: [],
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
    requiredFeatures,
    entityBudget: { nodes: 0, ways: 0, tags: 0 },
  })
  if (!Number.isInteger(block.granularity) || block.granularity <= 0) {
    throw new Error('OSM PBF primitive block has an invalid granularity.')
  }
  return block
}

function readDenseNodes(bytes, budget, denseNodesAllowed) {
  if (!denseNodesAllowed) {
    throw new Error('OSM PBF uses DenseNodes without declaring the required feature.')
  }
  const packed = reader(bytes).readFields((tag, result, pbf) => {
    if (tag === 1) result.ids = pbf.readPackedSVarint(result.ids)
    else if (tag === 8) result.lats = pbf.readPackedSVarint(result.lats)
    else if (tag === 9) result.lons = pbf.readPackedSVarint(result.lons)
  }, { ids: [], lats: [], lons: [] })
  if (
    packed.ids.length !== packed.lats.length
    || packed.ids.length !== packed.lons.length
    || budget.nodes + packed.ids.length > osmPbfLimits.nodesPerBlock
  ) {
    throw new Error('OSM PBF dense-node arrays are inconsistent or exceed the node limit.')
  }
  budget.nodes += packed.ids.length
  let id = 0
  let lat = 0
  let lon = 0
  for (let index = 0; index < packed.ids.length; index += 1) {
    id += packed.ids[index]
    lat += packed.lats[index]
    lon += packed.lons[index]
    packed.ids[index] = id
    packed.lats[index] = lat
    packed.lons[index] = lon
  }
  return packed
}

function readNode(bytes, budget) {
  if (budget.nodes >= osmPbfLimits.nodesPerBlock) {
    throw new Error('OSM PBF primitive block exceeds the node limit.')
  }
  budget.nodes += 1
  return reader(bytes).readFields((tag, result, pbf) => {
    if (tag === 1) result.id = pbf.readVarint()
    else if (tag === 8) result.lat = pbf.readSVarint()
    else if (tag === 9) result.lon = pbf.readSVarint()
  }, { id: 0, lat: 0, lon: 0 })
}

function readWay(bytes, budget) {
  if (budget.ways >= osmPbfLimits.waysPerBlock) {
    throw new Error('OSM PBF primitive block exceeds the way limit.')
  }
  budget.ways += 1
  const way = reader(bytes).readFields((tag, result, pbf) => {
    if (tag === 1) result.id = pbf.readVarint()
    else if (tag === 2) result.keys = pbf.readPackedVarint(result.keys)
    else if (tag === 3) result.vals = pbf.readPackedVarint(result.vals)
    else if (tag === 8) result.refs = pbf.readPackedSVarint(result.refs)
  }, { id: 0, keys: [], vals: [], refs: [] })
  if (
    way.keys.length !== way.vals.length
    || budget.tags + way.keys.length > osmPbfLimits.tagsPerBlock
    || way.refs.length > osmPbfLimits.wayReferences
  ) {
    throw new Error('OSM PBF way tags or references are inconsistent or exceed their limits.')
  }
  budget.tags += way.keys.length
  let ref = 0
  for (let index = 0; index < way.refs.length; index += 1) {
    ref += way.refs[index]
    way.refs[index] = ref
  }
  return way
}

export function forEachPrimitiveEntity(block, groupBytes, handlers) {
  const denseNodesAllowed = block.requiredFeatures.has('DenseNodes')
  reader(groupBytes).readFields((tag, _result, pbf) => {
    if (tag === 1) handlers.node?.(readNode(pbf.readBytes(), block.entityBudget))
    else if (tag === 2) {
      handlers.denseNodes?.(readDenseNodes(pbf.readBytes(), block.entityBudget, denseNodesAllowed))
    } else if (tag === 3) handlers.way?.(readWay(pbf.readBytes(), block.entityBudget))
  }, null)
}

export function wayTags(way, strings) {
  const tags = {}
  for (let index = 0; index < way.keys.length; index += 1) {
    const key = strings[way.keys[index]]
    const value = strings[way.vals[index]]
    if (key === undefined || value === undefined) {
      throw new Error('OSM PBF way references an out-of-range string-table entry.')
    }
    tags[key] = value
  }
  return tags
}

export function coordinate(block, lat, lon) {
  return [
    (block.lonOffset + block.granularity * lon) * 1e-9,
    (block.latOffset + block.granularity * lat) * 1e-9,
  ]
}

async function readExact(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (!bytesRead) throw new Error('Unexpected end of OSM PBF.')
    offset += bytesRead
  }
  return buffer
}

function decodeBlobPayload(blob, type) {
  const representations = Number(Boolean(blob.raw))
    + Number(Boolean(blob.zlibData))
    + Number(Boolean(blob.unsupportedCompression))
  if (representations !== 1) {
    throw new Error(`OSM PBF ${type} blob must contain exactly one data representation.`)
  }
  if (blob.unsupportedCompression) {
    throw new Error(`OSM PBF ${type} blob uses unsupported compression field ${blob.unsupportedCompression}.`)
  }
  if (blob.raw) {
    if (blob.raw.length > osmPbfLimits.blobBytes) {
      throw new Error(`OSM PBF ${type} raw blob exceeds the 32 MiB limit.`)
    }
    if (blob.rawSize !== undefined && blob.rawSize !== blob.raw.length) {
      throw new Error(`OSM PBF ${type} raw_size does not match its raw payload.`)
    }
    return blob.raw
  }
  if (!Number.isInteger(blob.rawSize) || blob.rawSize < 0 || blob.rawSize > osmPbfLimits.blobBytes) {
    throw new Error(`OSM PBF ${type} zlib blob has an invalid raw_size.`)
  }
  let data
  try {
    data = inflateSync(blob.zlibData, { maxOutputLength: osmPbfLimits.blobBytes })
  } catch (error) {
    throw new Error(`OSM PBF ${type} zlib decompression failed or exceeded 32 MiB: ${error.message}`)
  }
  if (data.length !== blob.rawSize) {
    throw new Error(`OSM PBF ${type} raw_size does not match the decompressed payload.`)
  }
  return data
}

export async function forEachPbfBlock(filePath, onBlock, onProgress, onFileBytes) {
  const handle = await fs.open(filePath, 'r')
  const stats = await handle.stat()
  let offset = 0
  let headerFeatures = null
  let dataBlockCount = 0
  try {
    while (offset < stats.size) {
      const lengthBytes = await readExact(handle, 4, offset)
      onFileBytes?.(lengthBytes)
      const headerLength = lengthBytes.readUInt32BE(0)
      if (headerLength <= 0 || headerLength > osmPbfLimits.blobHeaderBytes) {
        throw new Error('OSM PBF BlobHeader length must be between 1 byte and 64 KiB.')
      }
      offset += 4
      const headerBytes = await readExact(handle, headerLength, offset)
      onFileBytes?.(headerBytes)
      const header = readBlobHeader(headerBytes)
      if (!header.type || !Number.isInteger(header.dataSize)
        || header.dataSize <= 0 || header.dataSize > osmPbfLimits.blobBytes) {
        throw new Error('OSM PBF BlobHeader has an invalid type or data size.')
      }
      offset += headerLength
      const blobBytes = await readExact(handle, header.dataSize, offset)
      onFileBytes?.(blobBytes)
      const data = decodeBlobPayload(readBlob(blobBytes), header.type)
      offset += header.dataSize

      if (header.type === 'OSMHeader') {
        if (headerFeatures) throw new Error('OSM PBF contains more than one OSMHeader block.')
        const parsedHeader = readHeaderBlock(data)
        const unknown = parsedHeader.requiredFeatures.filter(
          (feature) => !supportedRequiredFeatures.has(feature),
        )
        if (!parsedHeader.requiredFeatures.includes('OsmSchema-V0.6') || unknown.length) {
          throw new Error(`OSM PBF declares unsupported required features: ${unknown.join(', ') || 'missing OsmSchema-V0.6'}.`)
        }
        headerFeatures = new Set(parsedHeader.requiredFeatures)
      } else if (header.type === 'OSMData') {
        if (!headerFeatures) throw new Error('OSM PBF must contain OSMHeader before OSMData.')
        dataBlockCount += 1
        await onBlock(readPrimitiveBlock(data, headerFeatures))
      } else {
        throw new Error(`OSM PBF contains unsupported block type ${header.type}.`)
      }
      onProgress?.({ progress: offset / stats.size, bytesRead: offset, totalBytes: stats.size })
    }
    if (!headerFeatures || dataBlockCount === 0) {
      throw new Error('OSM PBF must contain one OSMHeader and at least one OSMData block.')
    }
  } finally {
    await handle.close()
  }
}
