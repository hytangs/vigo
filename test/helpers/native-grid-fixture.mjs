import fs from 'node:fs'
import path from 'node:path'

// Synthetic, directed grid: no external feeds, downloads, or private inputs.
export function nativeGridFixture(directory, side = 32, { forwardOnly = false } = {}) {
  const nodeCount = side * side
  const nodeLats = new Float64Array(nodeCount)
  const nodeLons = new Float64Array(nodeCount)
  const offsets = [0]
  const targets = []
  const distances = []
  const incoming = Array.from({ length: nodeCount }, () => [])
  for (let node = 0; node < nodeCount; node += 1) {
    const row = Math.floor(node / side)
    const col = node % side
    nodeLats[node] = 38 + row * 0.001
    nodeLons[node] = col * 0.001
    for (const [target, distance, valid] of [
      [node - side, 130, row > 0], [node - 1, 110, col > 0],
      [node + 1, 100, col + 1 < side], [node + side, 120, row + 1 < side],
    ]) {
      if (!valid || (forwardOnly && target < node)) continue
      incoming[target].push([node, targets.length])
      targets.push(target)
      distances.push(distance)
    }
    offsets.push(targets.length)
  }
  const reverseOffsets = [0]
  const reverseSources = []
  const reverseEdgeIndices = []
  for (const entries of incoming) {
    for (const [source, edge] of entries) {
      reverseSources.push(source)
      reverseEdgeIndices.push(edge)
    }
    reverseOffsets.push(reverseSources.length)
  }
  const values = {
    nodeIds: Float64Array.from({ length: nodeCount }, (_, i) => i + 1),
    nodeLats, nodeLons,
    edgeOffsets: new Uint32Array(offsets),
    edgeTargets: new Uint32Array(targets),
    edgeDistances: new Float64Array(distances),
    reciprocalEdgeFlags: new Uint8Array(targets.length).fill(forwardOnly ? 0 : 1),
    spatialOffsets: new Uint32Array([0, nodeCount]),
    componentByNode: new Int32Array(nodeCount),
    componentLengthKm: new Float64Array([distances.reduce((a, b) => a + b, 0) / (forwardOnly ? 1000 : 2000)]),
    reverseOffsets: new Uint32Array(reverseOffsets),
    reverseSources: new Uint32Array(reverseSources),
    reverseEdgeIndices: new Uint32Array(reverseEdgeIndices),
  }
  let byteLength = 4096
  const arrays = {}
  for (const [name, value] of Object.entries(values)) {
    byteLength = Math.ceil(byteLength / value.BYTES_PER_ELEMENT) * value.BYTES_PER_ELEMENT
    arrays[name] = { type: value.constructor.name, offset: byteLength, length: value.length }
    byteLength += value.byteLength
  }
  const buffer = Buffer.alloc(byteLength)
  buffer.fill(0x20, 0, 4096)
  const header = {
    magic: 'vigo.street.accelerator', version: 7, nodeCount, edgeCount: targets.length,
    spatialMinLat: 38, spatialMinLon: 0, spatialCellDegrees: side * 0.001,
    spatialRows: 1, spatialColumns: 1, spatialNodeOrder: 'cell_then_source_node_id',
    componentCount: 1, arrays, byteLength,
  }
  const encoded = Buffer.from(JSON.stringify(header))
  if (encoded.length > 4096) throw new Error('Fixture header exceeds its reserved space.')
  encoded.copy(buffer)
  for (const [name, value] of Object.entries(values)) {
    Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(buffer, arrays[name].offset)
  }
  const snapshotPath = path.join(directory, 'grid.street.bin')
  fs.writeFileSync(snapshotPath, buffer)
  return {
    snapshotPath, nodeCount, values,
    coordinates: (nodes) => nodes.flatMap((node) => [nodeLons[node], nodeLats[node]]),
    driveInput: {
      nodeCount, nodeLats, nodeLons,
      edgeOffsets: values.edgeOffsets, edgeTargets: values.edgeTargets,
      edgeDistances: values.edgeDistances,
      edgeTravelTimes: Float64Array.from(distances, (distance) => distance / 10),
    },
    distance: (source, target) => {
      const rows = Math.floor(target / side) - Math.floor(source / side)
      const cols = target % side - source % side
      if (forwardOnly && (rows < 0 || cols < 0)) return Infinity
      return Math.abs(rows) * (rows > 0 ? 120 : 130) + Math.abs(cols) * (cols > 0 ? 100 : 110)
    },
  }
}

export function loadGridStreetIndex(binding, fixture, directory) {
  const kernel = new binding.CoordinateKernel(fixture.snapshotPath)
  const paths = {
    structurePath: path.join(directory, 'grid.cch.structure'),
    metricPath: path.join(directory, 'grid.cch.metric'),
  }
  kernel.buildStreetCchIndex({ ...paths, orderStrategy: 'inertial' })
  kernel.loadStreetCchIndex(paths)
  return kernel
}
