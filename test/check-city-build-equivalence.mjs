// The City compiler in the `vigo` executable: equivalent build paths produce
// the same routing rows and metadata, invalid sources fail without partial
// stores, and street references survive every node-ID range.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-city-build-equivalence-'))
const quote = (name) => `"${name.replaceAll('"', '""')}"`
const compile = (command, ...args) => JSON.parse(execFileSync(standaloneBinary, [command, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }))
const rejects = (pattern, command, ...args) => {
  const result = spawnSync(standaloneBinary, [command, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, pattern)
}

function contents(file, ignoredMetadata = []) {
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
    for (const key of ['builtAt', 'routeServiceCatalogBuiltAt', ...ignoredMetadata]) delete metadata[key]
    return { tables: result, metadata }
  } finally {
    db.close()
  }
}

async function absent(...files) {
  for (const file of files) await assert.rejects(fs.stat(file), { code: 'ENOENT' }, `${file} must not remain after a failed build.`)
}

try {
  const inputs = await writeCliFixtureInputs(root, { unreferencedNodes: 1_000 })
  const street = compile('_build-street-store', `--osm=${inputs.osmPath}`, `--output-store=${path.join(root, 'streets.sqlite')}`)
  assert.equal(street.nodeCount, 1_003, 'Filtering temporary coordinates must retain the complete source-node count.')
  assert.equal(street.walkNodeCount, 3)
  assert.equal(street.edgeCount, 4)
  assert.equal(street.driveEdgeCount, 4)
  for (const nodeIdOffset of [1_048_574, 9_000_000_000]) {
    const directory = path.join(root, `node-ids-${nodeIdOffset}`)
    await fs.mkdir(directory)
    const shifted = await writeCliFixtureInputs(directory, { nodeIdOffset })
    const store = path.join(directory, 'streets.sqlite')
    compile('_build-street-store', `--osm=${shifted.osmPath}`, `--output-store=${store}`)
    const db = new DatabaseSync(store, { readOnly: true })
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
    }
  }

  const zip = await JSZip.loadAsync(await fs.readFile(inputs.gtfsPath))
  // Empty parent_station means no parent; it must not become a scoped ID.
  zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,parent_station,location_type\nS,Station,38.905,-77.040,,1\nA,Alpha,38.900,-77.050,,0\nX,Transfer,38.905,-77.040,S,0\nB,Bravo,38.910,-77.030,,0\nE,Entrance,38.9051,-77.0401,S,2\n')
  zip.file('trips.txt', 'route_id,service_id,trip_id,direction_id,shape_id\nR1,WKD,T1,0, curve \nR2,WKD,T2,0,curve\nR1,WKD,F,0,curve\nR1,WKD,I,0,curve\n')
  zip.file('shapes.txt', 'shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\ncurve,3,38.910,-77.030\ncurve,1,38.900,-77.050\ncurve,2,38.905,-77.040\n')
  zip.file('calendar_dates.txt', 'service_id,date,exception_type\nWKD,20260704,2\nWKD,20260705,1\n')
  zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT1,08:10:00,08:10:00,X,2,1,0\nT1,08:00:00,08:00:00,A,1,0,1\nT2,08:30:00,08:30:00,B,2,0,0\nT2,08:15:00,08:15:00,X,1,0,0\nF,09:00:00,09:00:00,A,1,0,0\nF,09:10:00,09:10:00,X,2,0,0\nI,10:00:00,10:00:00,A,1,0,0\nI,10:10:00,10:10:00,X,2,0,0\n')
  zip.file('frequencies.txt', 'trip_id,start_time,end_time,headway_secs,exact_times\nF,09:00:00,09:30:00,600,1\nI,10:00:00,11:00:00,600,0\n')
  zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time,from_route_id,from_trip_id,to_trip_id\nX,B,2,90,  ,,\nB,A,3,0,,,\nA,X,2,60,R1,,\nX,X,4,,,T1,T2\n')
  zip.file('pathways.txt', 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\np,E,X,1,1,45,\nq,A,X,1,0,100,80\n')
  await fs.writeFile(inputs.gtfsPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const validStops = await zip.file('stops.txt').async('string')
  for (const missingId of ['', '   ']) {
    zip.file('stops.txt', validStops + `${missingId},Missing ID,38.920,-77.020,,0\n`)
    const invalidZip = path.join(root, 'missing-stop-id.zip')
    await fs.writeFile(invalidZip, await zip.generateAsync({ type: 'nodebuffer' }))
    for (const scoped of [false, true]) {
      const invalidStore = path.join(root, `missing-stop-id-${scoped}.sqlite`)
      rejects(/non-empty stop_id/, '_build-gtfs-store', `--output-store=${invalidStore}`, ...(scoped
        ? ['--city', `--gtfs=${invalidZip}`, '--gtfs-scope=first', `--gtfs=${inputs.gtfsPath}`, '--gtfs-scope=second']
        : [`--gtfs=${invalidZip}`]))
      await absent(invalidStore, `${invalidStore}.building`)
    }
  }
  zip.file('stops.txt', validStops)

  const raw = path.join(root, 'raw.sqlite')
  await fs.writeFile(`${raw}.building-journal`, 'interrupted unpublished compiler journal')
  const rawResult = compile('_build-gtfs-store', `--gtfs=${inputs.gtfsPath}`, `--output-store=${raw}`)
  await absent(`${raw}.building-journal`)
  assert.equal(rawResult.staticTopology.ready, true, 'Standalone raw builds still publish complete topology.')

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
  compile('_build-static-topology', `--store=${topologySource}`, `--output=${topologyPath}`, '--force')
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

  // A City store defers its departure index; every routing row is the same.
  const single = path.join(root, 'single.sqlite')
  const singleResult = compile('_build-gtfs-store', '--city', `--gtfs=${inputs.gtfsPath}`, '--gtfs-scope=single', `--output-store=${single}`)
  assert.equal(singleResult.staticTopology.ready, false, 'A staged City feed is not yet a published routable City.')
  assert.deepEqual(contents(single, ['departureIndexState']), contents(raw, ['departureIndexState']),
    'Single-feed City staging must retain every transit row and source rule.')

  const feeds = [['🚌-bus', inputs.gtfsPath], ['rail', inputs.gtfsPath]]
  const merged = path.join(root, 'merged.sqlite')
  compile('_build-gtfs-store', '--city', ...feeds.map(([scope]) => `--merge-store=${scope}=${raw}`), `--output-store=${merged}`)
  const direct = path.join(root, 'direct.sqlite')
  compile('_build-gtfs-store', '--city', ...feeds.flatMap(([scope, file]) => [`--gtfs=${file}`, `--gtfs-scope=${scope}`]), `--output-store=${direct}`)
  assert.deepEqual(contents(direct), contents(merged), 'Direct multi-feed import must preserve namespace collisions, calendars, permissions, frequencies, shapes, transfers, and pathway provenance.')

  rejects(/unique/, '_build-gtfs-store', '--city', `--gtfs=${inputs.gtfsPath}`, '--gtfs-scope=dup', `--gtfs=${inputs.gtfsPath}`, '--gtfs-scope=dup',
    `--output-store=${path.join(root, 'duplicate.sqlite')}`)
  for (const [name, broken] of [
    ['reference', 'T1,08:00:00,08:00:00,MISSING,1,0,0\nT1,08:10:00,08:10:00,X,2,0,0\n'],
    ['sequence', 'T1,08:00:00,08:00:00,A,1,0,0\nT1,08:10:00,08:10:00,X,1,0,0\n'],
  ]) {
    zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n' + broken)
    const invalidZip = path.join(root, `${name}.zip`)
    await fs.writeFile(invalidZip, await zip.generateAsync({ type: 'nodebuffer' }))
    const outputPath = path.join(root, `${name}.sqlite`)
    rejects(/Broken GTFS reference|duplicate GTFS stop_sequence/, '_build-gtfs-store', '--city',
      `--gtfs=${inputs.gtfsPath}`, '--gtfs-scope=🚌-bus', `--gtfs=${invalidZip}`, '--gtfs-scope=invalid', `--output-store=${outputPath}`)
    await absent(outputPath, `${outputPath}.building`, `${outputPath}.stop-times-building`)
  }
  console.log('City build equivalence passed: complete table and metadata parity, scoped inputs, source validation, and failure cleanup.')
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
