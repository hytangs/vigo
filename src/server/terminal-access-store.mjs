import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { forEachPbfBlock, forEachPrimitiveEntity, coordinate, wayTags } from './osm-pbf-reader.mjs'
import { haversineKm } from './geometry-utils.mjs'
import { nationalOsmWayWalkable, nationalOsmWalkDirections } from './national-osm-store.mjs'
import { prepareNationalGtfsNativeCoordinateAccess, disposeNationalGtfsStore } from './national-gtfs-store.mjs'
import { nativePublicAccessComponents, disposeNativeRoutingKernel } from './native-routing-kernel.mjs'

function authorizedPrivateWay(tags) {
  const access = String(tags.access ?? '').trim().toLowerCase()
  const foot = String(tags.foot ?? '').trim().toLowerCase()
  if (access !== 'private' && foot !== 'private') return false
  if (foot === 'no' || (access === 'no' && foot !== 'private')) return false
  return nationalOsmWayWalkable({ ...tags, access: 'yes', foot: foot === 'private' ? 'yes' : foot })
}

// Reconstruct the existing snapshot's source-node ordering, then verify every
// coordinate. Linking by source OSM ids preserves distinct coincident vertices
// on bridges, tunnels and separate levels; nearest-coordinate links cannot.
export async function buildTerminalAccessStore({ pbfPath, streetStorePath, routingStorePath }) {
  const started = performance.now()
  const snapshotPath = `${streetStorePath}.street-accelerator-v7.bin`
  const snapshot = fs.readFileSync(snapshotPath)
  const header = JSON.parse(snapshot.subarray(0, 4096).toString('utf8').trim())
  const array = (name, Type) => {
    const spec = header.arrays[name]
    return new Type(snapshot.buffer, snapshot.byteOffset + spec.offset, spec.length)
  }
  const sourceLons = array('nodeLons', Float64Array)
  const sourceLats = array('nodeLats', Float64Array)
  const candidateIds = new Set()
  const privateWays = []
  const sourceHash = createHash('sha256')
  await forEachPbfBlock(pbfPath, async (block) => {
    for (const group of block.groups) forEachPrimitiveEntity(block, group, {
      way(way) {
        const tags = wayTags(way, block.strings)
        const publicWay = nationalOsmWayWalkable(tags)
        const privateWay = !publicWay && authorizedPrivateWay(tags)
        const directions = nationalOsmWalkDirections(tags)
        if ((!publicWay && !privateWay) || (!directions.forward && !directions.backward)) return
        for (const id of way.refs) candidateIds.add(id)
        if (privateWay) privateWays.push({ id: way.id, refs: way.refs, directions, access: tags.access ?? null, foot: tags.foot ?? null })
      },
    })
  }, undefined, (bytes) => sourceHash.update(bytes))
  if (sourceHash.digest('hex') !== header.identity.sourceFingerprint) throw new Error('Terminal access requires the same OSM input used to build this City.')
  const ids = Float64Array.from(candidateIds)
  candidateIds.clear()
  const byId = new Map(Array.from(ids, (id, index) => [id, index]))
  const lons = new Float64Array(ids.length).fill(NaN)
  const lats = new Float64Array(ids.length).fill(NaN)
  const publicNodes = new Uint8Array(ids.length)
  const saveNode = (id, point) => {
    const index = byId.get(id)
    if (index !== undefined) { lons[index] = point[0]; lats[index] = point[1] }
  }
  const segments = (refs, visit) => {
    for (let i = 1; i < refs.length; i += 1) {
      const from = byId.get(refs[i - 1]); const to = byId.get(refs[i])
      if (from === undefined || to === undefined || !Number.isFinite(lons[from]) || !Number.isFinite(lons[to])) continue
      const distance = haversineKm([lons[from], lats[from]], [lons[to], lats[to]]) * 1000
      if (distance > 0 && distance < 10_000) visit(from, to, distance)
    }
  }
  await forEachPbfBlock(pbfPath, async (block) => {
    for (const group of block.groups) forEachPrimitiveEntity(block, group, {
      node(node) { saveNode(node.id, coordinate(block, node.lat, node.lon)) },
      denseNodes(dense) {
        for (let i = 0; i < dense.ids.length; i += 1) saveNode(dense.ids[i], coordinate(block, dense.lats[i], dense.lons[i]))
      },
      way(way) {
        const tags = wayTags(way, block.strings)
        const directions = nationalOsmWalkDirections(tags)
        if (nationalOsmWayWalkable(tags) && (directions.forward || directions.backward)) {
          segments(way.refs, (from, to) => { publicNodes[from] = 1; publicNodes[to] = 1 })
        }
      },
    })
  })
  const cell = (i) => {
    const row = Math.min(header.spatialRows - 1, Math.max(0, Math.floor((lats[i] - header.spatialMinLat) / header.spatialCellDegrees)))
    const column = Math.min(header.spatialColumns - 1, Math.max(0, Math.floor((lons[i] - header.spatialMinLon) / header.spatialCellDegrees)))
    return row * header.spatialColumns + column
  }
  const publicOrder = []
  for (let i = 0; i < ids.length; i += 1) if (publicNodes[i]) publicOrder.push(i)
  publicOrder.sort((a, b) => cell(a) - cell(b) || ids[a] - ids[b])
  if (publicOrder.length !== header.nodeCount) throw new Error('OSM source does not reproduce the public street snapshot node set; rebuild the City from the same inputs.')
  const publicIndex = new Uint32Array(ids.length).fill(0xffffffff)
  for (let node = 0; node < publicOrder.length; node += 1) {
    const i = publicOrder[node]
    if (Math.abs(lons[i] - sourceLons[node]) > 1e-10 || Math.abs(lats[i] - sourceLats[node]) > 1e-10) {
      throw new Error('OSM source-node ordering differs from the public snapshot; terminal access cannot be linked safely.')
    }
    publicIndex[i] = node
  }
  const localIndex = new Map()
  const nodeLons = []; const nodeLats = []; const mappedPublicNodes = []
  const local = (i) => {
    if (!localIndex.has(i)) {
      localIndex.set(i, nodeLons.length)
      nodeLons.push(lons[i]); nodeLats.push(lats[i]); mappedPublicNodes.push(publicIndex[i])
    }
    return localIndex.get(i)
  }
  const edgeSources = []; const edgeTargets = []; const edgeDistancesM = []; const edgeWayIds = []
  const add = (from, to, distance, way) => {
    edgeSources.push(local(from)); edgeTargets.push(local(to)); edgeDistancesM.push(distance); edgeWayIds.push(way)
  }
  for (const way of privateWays) segments(way.refs, (from, to, distance) => {
    if (way.directions.forward) add(from, to, distance, way.id)
    if (way.directions.backward) add(to, from, distance, way.id)
  })
  prepareNationalGtfsNativeCoordinateAccess(routingStorePath, streetStorePath)
  const boundaryComponents = nativePublicAccessComponents(streetStorePath)
  const result = {
    schemaVersion: 'vigo.street.terminal-access.v1', permission: 'authorized_endpoints',
    publicNodeCount: header.nodeCount, publicEdgeCount: header.edgeCount,
    sourceFingerprint: header.identity.sourceFingerprint,
    nodeLons, nodeLats, publicNodes: mappedPublicNodes,
    edgeSources, edgeTargets, edgeDistancesM, edgeWayIds,
    boundaryComponents,
    sourceWays: privateWays.map(({ id, access, foot }) => ({ id, access, foot })),
  }
  const destination = `${streetStorePath}.terminal-access-v1.json`
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(result))
    fs.renameSync(temporary, destination)
  } finally { fs.rmSync(temporary, { force: true }) }
  disposeNativeRoutingKernel(streetStorePath)
  disposeNationalGtfsStore(routingStorePath)
  return { model: 'authorized_endpoints', artifact: path.basename(destination), nodes: nodeLons.length,
    directedEdges: edgeSources.length, privateWays: privateWays.length, publicBoundaryComponents: boundaryComponents.length,
    sourceNodeIdentityVerified: true, throughPrivateStreets: false, buildMs: Number((performance.now() - started).toFixed(3)) }
}
