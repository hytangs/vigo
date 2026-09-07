import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { nativeGridFixture, loadGridStreetIndex } from './helpers/native-grid-fixture.mjs'

const require = createRequire(import.meta.url)
const binding = require('../native/vigo-routing-kernel/vigo-routing-kernel.node')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-terminal-access-'))
try {
  const fixture = nativeGridFixture(directory, 12)
  const kernel = loadGridStreetIndex(binding, fixture, directory)
  const origin = fixture.coordinates([0]); const target = fixture.coordinates([11])
  const home = [-0.002, 38]; const neighbor = [-0.001, 38]
  const query = (from, to, maximumDistanceM = 5000) => kernel.routePath({ originLon: from[0], originLat: from[1], destinationLon: to[0], destinationLat: to[1], maximumDistanceM, maximumPoints: 1000 })
  const publicDistance = query(origin, target).distanceM
  assert.equal(query(home, target).found, false)
  const graph = {
    schemaVersion: 'vigo.street.terminal-access.v1', publicNodeCount: fixture.nodeCount,
    publicEdgeCount: kernel.diagnostics().edgeCount,
    nodeLons: [origin[0], neighbor[0], home[0], target[0], 0.006],
    nodeLats: [origin[1], neighbor[1], home[1], target[1], 37.999],
    publicNodes: [0, 0xffffffff, 0xffffffff, 11, 0xffffffff],
    edgeSources: [0, 1, 1, 2, 0, 4, 4, 3],
    edgeTargets: [1, 0, 2, 1, 4, 0, 3, 4],
    edgeDistancesM: [100, 100, 100, 100, 540, 540, 454, 454],
    boundaryComponents: [0],
  }
  const file = path.join(directory, 'terminal.json')
  fs.writeFileSync(file, JSON.stringify(graph))
  kernel.setAccessProfile({ profileKey: 'terminal-test', anchorLons: [target[0]], anchorLats: [target[1]],
    anchorMemberOffsets: [0, 1], anchorMemberIndices: [0], memberLons: [target[0]], memberLats: [target[1]],
    memberOriginEligible: [1], memberDestinationEligible: [1] })
  assert.deepEqual(kernel.publicAccessComponents(), [0])
  const access = (point, role) => kernel.routeEndpoint({ longitude: point[0], latitude: point[1], maximumWalkM: 5000, role, disableCache: true })
  const publicAccess = Object.fromEntries(['origin', 'destination'].map(role => [role, access(origin, role).distancesM[0]]))
  kernel.configureTerminalAccess(file)
  for (const role of ['origin', 'destination']) {
    const result = access(home, role)
    assert(Math.abs(result.distancesM[0] - publicAccess[role] - 200) < 0.001)
    const path = kernel.materializePath({ queryToken: result.queryToken, role, memberIndex: 0, maximumPoints: 1000 }).coordinates
    assert.deepEqual(role === 'origin' ? path.slice(0, 4) : path.slice(-4), role === 'origin' ? [...home, ...neighbor] : [...neighbor, ...home])
  }
  // Two different private regions share a public boundary. Neither can be
  // crossed after the query has entered that boundary, even if it is cheaper.
  assert.equal(query(origin, target).distanceM, publicDistance)
  const fromHome = query(home, target)
  for (const role of ['origin', 'destination']) {
    const noStop = kernel.routeEndpoint({ longitude: home[0], latitude: home[1], maximumWalkM: 400, role })
    assert.equal(noStop.memberIndices.length, 0)
  }
  const localWalk = kernel.routeStreetMatrix({ originCoordinates: [...home, ...origin],
    destinationCoordinates: [...home, ...origin], maximumDistanceM: 400 })
  assert.deepEqual(localWalk.distancesM, [0, 200, 200, 0],
    'An empty transit frontier must retain valid coordinate walking attachments.')
  assert.equal(fromHome.distanceM, 200 + publicDistance)
  assert.equal(fromHome.originSnapDistanceM, 0, 'Mapped private access is not off-network snap distance.')
  assert.equal(query(target, home).destinationSnapDistanceM, 0)
  assert.deepEqual(fromHome.coordinates.slice(0, 4), [...home, ...neighbor])
  assert.equal(query(target, home).distanceM, 200 + query(target, origin).distanceM)
  assert.equal(query(home, neighbor).distanceM, 100)
  assert.equal(query(home, neighbor, 99).found, false)
  assert.equal(query(home, target, fromHome.distanceM - 0.1).found, false)
  const points = [home, neighbor, origin, target]
  const matrix = kernel.routeStreetMatrix({ originCoordinates: points.flat(), destinationCoordinates: points.flat(), maximumDistanceM: 5000 })
  const expected = points.flatMap((from) => points.map((to) => from === to ? 0 : query(from, to).distanceM))
  assert.deepEqual(matrix.distancesM, expected)
  // Directed private access must reverse the search, not the permission.
  graph.edgeSources = [1, 2]; graph.edgeTargets = [0, 1]; graph.edgeDistancesM = [100, 100]
  fs.writeFileSync(file, JSON.stringify(graph)); kernel.configureTerminalAccess(file)
  assert.equal(query(home, target).found, true)
  assert.equal(query(target, home).found, false)
  for (const [origins, destinations] of [[points, [target]], [[target], points], [points, [home, target]]]) {
    const directed = kernel.routeStreetMatrix({
      originCoordinates: origins.flat(), destinationCoordinates: destinations.flat(), maximumDistanceM: 5000,
    })
    assert.deepEqual(directed.distancesM, origins.flatMap(from => destinations.map(to => {
      const path = query(from, to)
      return path.found ? path.distanceM : Infinity
    })), 'Matrix orientation must preserve directed private endpoint permissions.')
  }

  // Reject an artifact linked to a different physical public vertex.
  graph.nodeLons[0] += 0.01
  fs.writeFileSync(file, JSON.stringify(graph))
  assert.throws(() => kernel.configureTerminalAccess(file), /does not match/)
  console.log(JSON.stringify({ status: 'passed', endpointPrivateAccess: true, throughPrivateShortcuts: false, privateRegionReentry: false, directedPaths: true, matrixParity: true }))
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
