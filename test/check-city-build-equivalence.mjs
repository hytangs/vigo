import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalOsmStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import {
  buildNationalGtfsCityStore,
  buildNationalGtfsStore,
  buildNationalStaticTopologySidecar,
  compactNationalGtfsRuntimeStore,
  disposeAllNationalGtfsStores,
  inspectNationalStaticTopologySidecar,
  mergeNationalGtfsStores,
} from '../src/server/national-gtfs-store.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-city-build-equivalence-'))
const quote = (name) => `"${name.replaceAll('"', '""')}"`

function contents(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const result = {}
    for (const { name } of tables) {
      if (name === 'metadata') continue
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(({ name }) => quote(name))
      result[name] = db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.join(',')}`).all()
    }
    const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata ORDER BY key').all().map(({ key, value }) => [key, JSON.parse(value)]))
    delete metadata.builtAt
    delete metadata.routeServiceCatalogBuiltAt
    return { tables: result, metadata }
  } finally {
    db.close()
  }
}

try {
  const inputs = await writeCliFixtureInputs(root, { unreferencedNodes: 1_000 })
  const streetPath = path.join(root, 'streets.sqlite')
  const street = await buildNationalOsmStore({ pbfPath: inputs.osmPath, outputPath: streetPath })
  assert.equal(street.nodeCount, 1_003, 'Filtering temporary coordinates must retain the complete source-node count.')
  assert.equal(street.walkNodeCount, 3)
  assert.equal(street.edgeCount, 4)
  assert.equal(street.driveEdgeCount, 4)
  disposeNationalOsmStore(streetPath)
  for (const nodeIdOffset of [1_048_574, 9_000_000_000]) {
    const directory = path.join(root, `node-ids-${nodeIdOffset}`)
    await fs.mkdir(directory)
    const shifted = await writeCliFixtureInputs(directory, { nodeIdOffset })
    const shiftedStore = path.join(directory, 'streets.sqlite')
    await buildNationalOsmStore({ pbfPath: shifted.osmPath, outputPath: shiftedStore })
    const db = new DatabaseSync(shiftedStore, { readOnly: true })
    try {
      for (const table of ['edges', 'drive_edges']) {
        assert.deepEqual(
          db.prepare(`SELECT from_node, to_node FROM ${table} ORDER BY from_node, to_node`).all().map(Object.values),
          [[1, 2], [2, 1], [2, 3], [3, 2]].map((pair) => pair.map((id) => id + nodeIdOffset)),
          'Reference membership must preserve edges across ID buckets and for IDs above 32 bits.',
        )
      }
    } finally {
      db.close()
      disposeNationalOsmStore(shiftedStore)
    }
  }
  const changingPbf = path.join(root, 'changing.osm.pbf')
  const changedBytes = await fs.readFile(inputs.osmPath)
  await fs.writeFile(changingPbf, changedBytes)
  let changed = false
  const changingStreet = path.join(root, 'changing-street.sqlite')
  await assert.rejects(buildNationalOsmStore({
    pbfPath: changingPbf, outputPath: changingStreet,
    onProgress: (event) => {
      if (!changed && event.phase === 'Selecting street node references' && event.progress === 0.12) {
        changed = true
        const unusedTag = changedBytes.indexOf(Buffer.from('service'))
        assert(unusedTag >= 0)
        changedBytes[unusedTag] ^= 1
        writeFileSync(changingPbf, changedBytes)
      }
    },
  }), /changed during street compilation/)
  assert.equal(changed, true)
  await assert.rejects(fs.stat(changingStreet), { code: 'ENOENT' })
  await assert.rejects(fs.stat(`${changingStreet}.building`), { code: 'ENOENT' })
  const zip = await JSZip.loadAsync(await fs.readFile(inputs.gtfsPath))
  // The legacy importer accepts an empty stop ID; namespacing must preserve
  // that row too, while an empty parent_station remains an absent reference.
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,parent_station,location_type\nS,Station,38.905,-77.040,,1\nA,Alpha,38.900,-77.050,,0\nX,Transfer,38.905,-77.040,S,0\nB,Bravo,38.910,-77.030,,0\nE,Entrance,38.9051,-77.0401,S,2\n,Empty ID,38.920,-77.020,,0\n')
  zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,shape_id\nR1,WKD,T1,0, curve \nR2,WKD,T2,0,curve\nR1,WKD,F,0,curve\nR1,WKD,I,0,curve\n')
  zip.file('shapes.txt', 'shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\ncurve,3,38.910,-77.030\ncurve,1,38.900,-77.050\ncurve,2,38.905,-77.040\n')
  zip.file('calendar_dates.txt', 'service_id,date,exception_type\nWKD,20260704,2\nWKD,20260705,1\n')
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT1,08:10:00,08:10:00,X,2,1,0\nT1,08:00:00,08:00:00,A,1,0,1\nT2,08:30:00,08:30:00,B,2,0,0\nT2,08:15:00,08:15:00,X,1,0,0\nF,09:00:00,09:00:00,A,1,0,0\nF,09:10:00,09:10:00,X,2,0,0\nI,10:00:00,10:00:00,A,1,0,0\nI,10:10:00,10:10:00,X,2,0,0\n')
  zip.file('frequencies.txt', 'trip_id,start_time,end_time,headway_secs,exact_times\nF,09:00:00,09:30:00,600,1\nI,10:00:00,11:00:00,600,0\n')
  zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time,from_route_id\nX,B,2,90,  \nB,A,3,0,\nA,X,2,60,R1\n')
  zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\np,E,X,1,1,45,\nq,A,X,1,0,100,80\n')
  await fs.writeFile(inputs.gtfsPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const raw = path.join(root, 'raw.sqlite')
  await buildNationalGtfsStore({ zipPath: inputs.gtfsPath, outputPath: raw })
  assert.equal(inspectNationalStaticTopologySidecar(raw).ready, true, 'Standalone raw builds still publish complete topology.')
  const topologySource = path.join(root, 'topology-source.sqlite')
  await fs.copyFile(raw, topologySource)
  const topologyDb = new DatabaseSync(topologySource)
  topologyDb.exec('DELETE FROM connections; DELETE FROM transfers; DELETE FROM transfer_provenance; UPDATE stops SET parent_station=NULL;')
  const topologyConnections = [
    [100, 110, 'g', 'R1', 'WKD', null, 'A', 'X', 1],
    [120, 140, 'g', 'R1', 'WKD', null, 'E', 'B', 4],
    [150, 160, 'g', 'R1', 'WKD', null, 'S', 'A', 5],
    [10, 12, 'same', 'R1', 'WKD', null, 'X', 'X', 1],
    [15, 20, 'same', 'R1', 'WKD', null, 'X', 'A', 3],
    [200, 200, 'z', 'R1', 'WKD', null, 'A', 'X', 1],
    [210, 220, 'z', 'R2', 'WKD', null, 'B', 'E', 3],
    [230, 240, 'z', 'R2', 'OTHER', null, 'X', 'S', 5],
    [235, 245, 'z', 'R2', 'OTHER', null, 'E', 'A', 7],
  ]
  const insertTopologyConnection = topologyDb.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?)')
  for (const row of topologyConnections) insertTopologyConnection.run(...row)
  topologyDb.prepare("UPDATE metadata SET value=? WHERE key='connectionCount'").run(String(topologyConnections.length))
  topologyDb.exec("UPDATE metadata SET value='0' WHERE key='transferCount';")
  topologyDb.close()
  const topologyPath = `${topologySource}.static-topology.sqlite`
  await buildNationalStaticTopologySidecar({ storePath: topologySource, outputPath: topologyPath })
  const topology = new DatabaseSync(topologyPath, { readOnly: true })
  try {
    assert.deepEqual(
      topology.prepare('SELECT from_stop_id, to_stop_id, min_duration FROM static_topology_edges ORDER BY from_stop_id, to_stop_id').all().map(Object.values),
      [['A', 'X', 0], ['B', 'E', 10], ['E', 'A', 10], ['E', 'B', 20], ['S', 'A', 10], ['X', 'A', 5], ['X', 'E', 10], ['X', 'S', 10]],
      'Topology must keep exact pair minima and bridge only consecutive connections with a sequence gap, matching route/service and nonnegative time.',
    )
  } finally {
    topology.close()
  }
  const single = path.join(root, 'single.sqlite')
  await buildNationalGtfsCityStore({ feeds: [{ scope: 'single', path: inputs.gtfsPath }], outputPath: single })
  compactNationalGtfsRuntimeStore(raw)
  assert.deepEqual(contents(single), contents(raw), 'Single-feed City staging must retain every transit row and source rule.')
  assert.equal(inspectNationalStaticTopologySidecar(single).ready, false, 'A staged City feed is not yet a published routable City.')

  const feeds = [{ scope: '🚌-bus', path: inputs.gtfsPath }, { scope: 'rail', path: inputs.gtfsPath }]
  const merged = path.join(root, 'merged.sqlite')
  await mergeNationalGtfsStores({ stores: feeds.map(({ scope }) => ({ scope, storePath: raw })), outputPath: merged })
  compactNationalGtfsRuntimeStore(merged)
  const direct = path.join(root, 'direct.sqlite')
  await buildNationalGtfsCityStore({ feeds, outputPath: direct })
  assert.deepEqual(contents(direct), contents(merged), 'Direct multi-feed import must preserve namespace collisions, calendars, permissions, frequencies, shapes, transfers, and pathway provenance.')

  await assert.rejects(buildNationalGtfsCityStore({ feeds: [feeds[0], feeds[0]], outputPath: path.join(root, 'duplicate.sqlite') }), /unique/)
  for (const [name, broken] of [
    ['reference', 'T1,08:00:00,08:00:00,MISSING,1,0,0\nT1,08:10:00,08:10:00,X,2,0,0\n'],
    ['sequence', 'T1,08:00:00,08:00:00,A,1,0,0\nT1,08:10:00,08:10:00,X,1,0,0\n'],
  ]) {
    zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n' + broken)
    const invalidZip = path.join(root, `${name}.zip`)
    await fs.writeFile(invalidZip, await zip.generateAsync({ type: 'nodebuffer' }))
    const outputPath = path.join(root, `${name}.sqlite`)
    await assert.rejects(buildNationalGtfsCityStore({ feeds: [feeds[0], { scope: 'invalid', path: invalidZip }], outputPath }), /Broken GTFS reference|duplicate GTFS stop_sequence/)
    for (const file of [outputPath, `${outputPath}.building`, `${outputPath}.stop-times-building`]) {
      await assert.rejects(fs.stat(file), { code: 'ENOENT' }, 'Failed imports must not publish a partial City store.')
    }
  }
  console.log('City build equivalence passed: complete table and metadata parity, scoped inputs, source validation, and failure cleanup.')
} finally {
  disposeAllNationalGtfsStores()
  await fs.rm(root, { recursive: true, force: true })
}
