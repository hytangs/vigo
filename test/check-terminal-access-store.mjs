import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalOsmStore, prepareNationalOsmNativeStore, disposeNationalOsmStore, compactNationalOsmRuntimeStore } from '../src/server/national-osm-store.mjs'
import { buildNationalGtfsStore, routeNationalGtfsStore, routeNationalGtfsMatrix, routeNationalGtfsReach, disposeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { buildTerminalAccessStore, authorizedEndpointNodeWalkable } from '../src/server/terminal-access-store.mjs'

assert.equal(authorizedEndpointNodeWalkable({ barrier: 'gate' }), true)
assert.equal(authorizedEndpointNodeWalkable({ barrier: 'gate', access: 'private' }), true)
for (const tags of [{ foot: 'no' }, { access: 'no' }, { barrier: 'gate', locked: 'yes' },
  { barrier: 'gate', foot: 'yes', locked: 'yes' }, { barrier: 'wall' }, { barrier: 'wall', foot: 'yes' },
  { barrier: 'gate', 'locked:conditional': 'yes @ (sunset-sunrise)' },
  { barrier: 'gate', opening_hours: '08:00-18:00' }]) {
  assert.equal(authorizedEndpointNodeWalkable(tags), false, JSON.stringify(tags))
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-terminal-source-'))
const streetStorePath = path.join(directory, 'street.sqlite'); const routingStorePath = path.join(directory, 'transit.sqlite')
try {
  const { osmPath, gtfsPath } = await writeCliFixtureInputs(directory, { terminalAccess: true })
  await buildNationalOsmStore({ pbfPath: osmPath, outputPath: streetStorePath })
  compactNationalOsmRuntimeStore(streetStorePath, { requireDrive: false })
  await buildNationalGtfsStore({ zipPath: gtfsPath, outputPath: routingStorePath })
  prepareNationalOsmNativeStore(streetStorePath)
  buildNativeStreetCchIndex(streetStorePath)
  const home = { source: 'map', coordinate: [-77.054, 38.9], label: 'Authorized residence' }
  const school = { source: 'stop', stopId: 'B', coordinate: [-77.03, 38.91], label: 'School stop' }
  const request = { streetStorePath, origin: home, destination: school, serviceDate: '2026-07-15',
    maxWalkKm: 0.6, allowLongWalk: false, departMinutes: 475, horizonMinutes: 120, __disableResultCache: true }
  assert.equal(routeNationalGtfsStore(routingStorePath, request).status, 'blocked')
  const built = await buildTerminalAccessStore({ pbfPath: osmPath, streetStorePath, routingStorePath })
  assert.equal(built.privateWays, 2); assert.equal(built.directedEdges, 4); assert.equal(built.sourceNodeIdentityVerified, true)
  const surface = { bounds: [-77.055, 38.899, -77.049, 38.901], width: 4, height: 4, includeNodes: false, includeEdges: false }
  const reach = routeNationalGtfsReach(routingStorePath, { ...request, mode: 'transit', surfaceSampling: 'cell-center', cutoffMinutes: 10, surface })
  assert.equal(reach.surface.sampling, 'cell-center')
  const [west, south, east, north] = surface.bounds
  const targets = Array.from({ length: 16 }, (_, i) => ({ source: 'map', coordinate: [west + (i % 4 + 0.5) / 4 * (east - west), north - (Math.floor(i / 4) + 0.5) / 4 * (north - south)] }))
  const matrix = routeNationalGtfsMatrix(routingStorePath, { ...request, origins: [home], destinations: targets,
    requireTransitRide: false, includeJourneys: false, includeGeometry: false, horizonMinutes: 10 })
  for (const [i, row] of matrix.rows.entries()) assert.equal(reach.surface.values[i],
    row.status === 'ready' && row.durationMinutes <= 10 ? row.durationMinutes : Infinity)
  const shortReach = routeNationalGtfsReach(routingStorePath, { ...request, surfaceSampling: 'cell-center', cutoffMinutes: 1, surface })
  assert(shortReach.surface.values.every(value => !Number.isFinite(value) || value <= 1), 'Valid sub-five-minute cutoffs stay bounded')
  const streets = routeNationalGtfsReach(routingStorePath, { ...request, cutoffMinutes: 10, surface: { ...surface, includeEdges: true } })
  assert(streets.surface.values.some(Number.isFinite), 'Street Reach retains mapped authorized endpoint connections')
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
  for (const [name, tags, expected, nodeId = 5, directions = { 'foot:forward': 'private' }] of [
    ['unqualified-gate', { barrier: 'gate' }, 'ready'],
    ['private-gate', { barrier: 'gate', access: 'private' }, 'ready'],
    ['pedestrian-private', { foot: 'private' }, 'ready'],
    ['pedestrian-prohibited', { foot: 'no' }, 'blocked'],
    ['gate-prohibited', { barrier: 'gate', access: 'no' }, 'blocked'],
    ['locked-gate', { barrier: 'gate', locked: 'yes' }, 'blocked'],
    ['time-restricted-gate', { barrier: 'gate', opening_hours: '08:00-18:00' }, 'blocked'],
    ['physical-wall', { barrier: 'wall' }, 'blocked'],
    ['private-path-prohibited', { foot: 'no' }, 'blocked', 6],
    ['private-path-locked', { barrier: 'gate', locked: 'yes' }, 'blocked', 6],
    ['private-path-wall', { barrier: 'wall', foot: 'yes' }, 'blocked', 6],
    ['private-direction-prohibited', {}, 'blocked', 5, { 'foot:forward': 'no' }],
  ]) {
    const folder = path.join(directory, name); fs.mkdirSync(folder)
    const inputs = await writeCliFixtureInputs(folder, { terminalAccess: true, terminalNodeTags: { [nodeId]: tags },
      terminalWayTags: { 13: directions } })
    const streets = path.join(folder, 'streets.sqlite'), transit = path.join(folder, 'transit.sqlite')
    try {
      await buildNationalOsmStore({ pbfPath: inputs.osmPath, outputPath: streets })
      compactNationalOsmRuntimeStore(streets, { requireDrive: false })
      await buildNationalGtfsStore({ zipPath: inputs.gtfsPath, outputPath: transit })
      prepareNationalOsmNativeStore(streets); buildNativeStreetCchIndex(streets)
      const query = { ...request, streetStorePath: streets }
      assert.equal(routeNationalGtfsStore(transit, query).status, 'blocked', `${name}: public access remains conservative`)
      await buildTerminalAccessStore({ pbfPath: inputs.osmPath, streetStorePath: streets, routingStorePath: transit })
      for (const time of [{ timePreference: 'depart', departMinutes: 475 }, { timePreference: 'arrive', arriveMinutes: 510 }]) {
        const plan = routeNationalGtfsStore(transit, { ...query, ...time })
        assert.equal(plan.status, expected, `${name}: ${time.timePreference} route`)
        const matrix = routeNationalGtfsMatrix(transit, { ...query, ...time, origins: [home], destinations: [school] })
        assert.equal(matrix.rows[0].status, expected, `${name}: ${time.timePreference} matrix`)
        if (expected === 'ready') assert(plan.legs.some(leg => leg.type === 'walk'
          && leg.coordinates.some(([lon]) => Math.abs(lon + 77.0535) < 1e-9)), 'The route traverses the mapped gate')
      }
      if (name === 'private-direction-prohibited') {
        const reverse = routeNationalGtfsStore(transit, { ...query,
          origin: { source: 'map', coordinate: [-77.05, 38.9] }, destination: home })
        assert.equal(reverse.status, 'ready', 'A forward pedestrian prohibition does not remove the permitted reverse direction')
      }
      // Replacing streets with the public model must not retain a stale overlay.
      await buildNationalOsmStore({ pbfPath: inputs.osmPath, outputPath: streets })
      assert.equal(fs.existsSync(`${streets}.terminal-access-v1.json`), false)
      compactNationalOsmRuntimeStore(streets, { requireDrive: false })
      prepareNationalOsmNativeStore(streets); buildNativeStreetCchIndex(streets)
      assert.equal(routeNationalGtfsStore(transit, query).status, 'blocked', `${name}: permission returns to public`)
    } finally { disposeNationalGtfsStore(transit); disposeNationalOsmStore(streets) }
  }
  console.log(JSON.stringify({ status: 'passed', originalPublicIslandBlocked: true, mappedPrivateAccessRestored: true, sourceIdsPreserved: true, routeMatrixBothTimes: true }))
} finally {
  disposeNationalGtfsStore(routingStorePath); disposeNationalOsmStore(streetStorePath)
  fs.rmSync(directory, { recursive: true, force: true })
}
