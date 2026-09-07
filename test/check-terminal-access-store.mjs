import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalOsmStore, prepareNationalOsmNativeStore, disposeNationalOsmStore, compactNationalOsmRuntimeStore } from '../src/server/national-osm-store.mjs'
import { buildNationalGtfsStore, routeNationalGtfsStore, routeNationalGtfsMatrix, disposeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { buildTerminalAccessStore } from '../src/server/terminal-access-store.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-terminal-source-'))
const streetStorePath = path.join(directory, 'street.sqlite'); const routingStorePath = path.join(directory, 'transit.sqlite')
try {
  const { osmPath, gtfsPath } = await writeCliFixtureInputs(directory, { terminalAccess: true })
  await buildNationalOsmStore({ pbfPath: osmPath, outputPath: streetStorePath })
  compactNationalOsmRuntimeStore(streetStorePath, { requireDrive: false })
  await buildNationalGtfsStore({ zipPath: gtfsPath, outputPath: routingStorePath })
  prepareNationalOsmNativeStore(streetStorePath, { requireCurrentSchema: true })
  buildNativeStreetCchIndex(streetStorePath)
  const home = { source: 'map', coordinate: [-77.054, 38.9], label: 'Authorized residence' }
  const school = { source: 'stop', stopId: 'B', coordinate: [-77.03, 38.91], label: 'School stop' }
  const request = { streetStorePath, origin: home, destination: school, serviceDate: '2026-07-15',
    maxWalkKm: 0.6, allowLongWalk: false, departMinutes: 475, horizonMinutes: 120, __disableResultCache: true }
  assert.equal(routeNationalGtfsStore(routingStorePath, request).status, 'blocked')
  const built = await buildTerminalAccessStore({ pbfPath: osmPath, streetStorePath, routingStorePath })
  assert.equal(built.privateWays, 2); assert.equal(built.directedEdges, 4); assert.equal(built.sourceNodeIdentityVerified, true)
  for (const time of [{ timePreference: 'depart', departMinutes: 475 }, { timePreference: 'arrive', arriveMinutes: 510 }]) {
    const plan = routeNationalGtfsStore(routingStorePath, { ...request, ...time })
    assert.equal(plan.status, 'ready'); assert.equal(plan.arriveMinutes, 510)
    assert(plan.legs.some(leg => leg.type === 'walk' && leg.coordinates.some(([lon]) => Math.abs(lon + 77.0535) < 1e-9)))
    const matrix = routeNationalGtfsMatrix(routingStorePath, { ...request, ...time, origins: [home, home], destinations: [school] })
    for (const row of matrix.rows) {
      assert.equal(row.status, 'ready')
      assert(Math.abs((time.timePreference === 'arrive' ? row.departMinutes - plan.departMinutes : row.arriveMinutes - plan.arriveMinutes)) < 0.001)
    }
  }
  console.log(JSON.stringify({ status: 'passed', originalPublicIslandBlocked: true, mappedPrivateAccessRestored: true, sourceIdsPreserved: true, routeMatrixBothTimes: true }))
} finally {
  disposeNationalGtfsStore(routingStorePath); disposeNationalOsmStore(streetStorePath)
  fs.rmSync(directory, { recursive: true, force: true })
}
