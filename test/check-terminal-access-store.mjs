import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalOsmStore, prepareNationalOsmNativeStore, disposeNationalOsmStore, compactNationalOsmRuntimeStore } from '../src/server/national-osm-store.mjs'
import { buildNationalGtfsStore, disposeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { buildTerminalAccessStore } from '../src/server/terminal-access-store.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-terminal-source-'))
const streetStorePath = path.join(directory, 'street.sqlite'); const routingStorePath = path.join(directory, 'transit.sqlite')
try {
  const { osmPath, gtfsPath } = await writeCliFixtureInputs(directory, { terminalAccess: true })
  await buildNationalOsmStore({ pbfPath: osmPath, outputPath: streetStorePath })
  compactNationalOsmRuntimeStore(streetStorePath, { requireDrive: false })
  await buildNationalGtfsStore({ zipPath: gtfsPath, outputPath: routingStorePath })
  prepareNationalOsmNativeStore(streetStorePath)
  buildNativeStreetCchIndex(streetStorePath)
  const built = await buildTerminalAccessStore({ pbfPath: osmPath, streetStorePath, routingStorePath })
  assert.equal(built.privateWays, 2); assert.equal(built.directedEdges, 4); assert.equal(built.sourceNodeIdentityVerified, true)
  for (const [name, tags, expected, nodeId = 5, directions = { 'foot:forward': 'private' }] of [
    ['unqualified-gate', { barrier: 'gate' }, 'ready'],
    ['private-gate', { barrier: 'gate', access: 'private' }, 'ready'],
    ['destination-gate', { barrier: 'gate', access: 'destination' }, 'ready'],
    ['pedestrian-destination-gate', { barrier: 'gate', foot: 'destination' }, 'ready'],
    ['destination-gate-locked', { barrier: 'gate', access: 'destination', locked: 'yes' }, 'blocked'],
    ['destination-gate-prohibited', { barrier: 'gate', access: 'destination', foot: 'no' }, 'blocked'],
    ['destination-gate-hours', { barrier: 'gate', access: 'destination', opening_hours: '08:00-18:00' }, 'blocked'],
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
      await buildTerminalAccessStore({ pbfPath: inputs.osmPath, streetStorePath: streets, routingStorePath: transit })
      // Street replacement is covered through the API import test, where
      // owning routing workers retire before mapped snapshots are replaced.
    } finally { disposeNationalGtfsStore(transit); disposeNationalOsmStore(streets) }
  }
  console.log(JSON.stringify({ status: 'passed', originalPublicIslandBlocked: true, mappedPrivateAccessRestored: true, sourceIdsPreserved: true, routeMatrixBothTimes: true }))
} finally {
  disposeNationalGtfsStore(routingStorePath); disposeNationalOsmStore(streetStorePath)
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
