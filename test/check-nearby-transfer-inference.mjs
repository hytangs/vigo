import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import {
  buildNationalGtfsStore,
  disposeNationalGtfsStore,
  routeNationalGtfsStore,
} from '../src/server/national-gtfs-store.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-nearby-transfer-'))
const zipPath = path.join(root, 'nearby-transfer.zip')
const storePath = path.join(root, 'nearby-transfer.sqlite')

try {
  const zip = new JSZip()
  zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture Transit,https://example.test,UTC\n')
  zip.file('stops.txt', [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'A,Origin,0.000000,0.000000,0',
    'BUS_X,Bus beside interchange,0.000000,0.010000,0',
    'RAIL_X,Rail beside interchange,0.001700,0.010000,0',
    'B,Destination,0.001700,0.020000,0',
    'FAR,Too far to infer,0.004700,0.010000,0',
    'FORBID_BUS,Forbidden bus side,0.010000,0.010000,0',
    'FORBID_RAIL,Forbidden rail side,0.010500,0.010000,0',
  ].join('\n'))
  zip.file('routes.txt', [
    'route_id,agency_id,route_short_name,route_long_name,route_type',
    'BUS,fixture,BUS,Bus,3',
    'RAIL,fixture,RAIL,Rail,2',
  ].join('\n'))
  zip.file('trips.txt', [
    'route_id,service_id,trip_id,direction_id',
    'BUS,WKD,BUS_TRIP,0',
    'RAIL,WKD,RAIL_TRIP,0',
  ].join('\n'))
  zip.file('stop_times.txt', [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'BUS_TRIP,08:00:00,08:00:00,A,1',
    'BUS_TRIP,08:10:00,08:10:00,BUS_X,2',
    'RAIL_TRIP,08:14:00,08:14:00,RAIL_X,1',
    'RAIL_TRIP,08:24:00,08:24:00,B,2',
  ].join('\n'))
  zip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWKD,1,1,1,1,1,0,0,20260101,20261231\n')
  zip.file('transfers.txt', 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nFORBID_BUS,FORBID_RAIL,3,0\n')
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const result = await buildNationalGtfsStore({ zipPath, outputPath: storePath })

  const database = new DatabaseSync(storePath, { readOnly: true })
  try {
    const transfer = database.prepare('SELECT transfer_type, min_transfer_time FROM transfers WHERE from_stop_id=? AND to_stop_id=?')
    const forward = transfer.get('BUS_X', 'RAIL_X')
    const reverse = transfer.get('RAIL_X', 'BUS_X')
    assert.equal(forward, undefined, 'A nearby chord without GTFS or OSM proof must not become a routable transfer.')
    assert.equal(reverse, undefined, 'Radial proximity must not invent a reverse transfer.')
    assert.equal(transfer.get('BUS_X', 'FAR'), undefined, 'A 334 m stop pair must stay outside the inference radius.')
    assert.equal(transfer.get('FORBID_BUS', 'FORBID_RAIL')?.transfer_type, 3, 'An explicit forbidden transfer must not be overwritten.')
    assert.equal(database.prepare('SELECT provenance FROM transfer_provenance WHERE from_stop_id=? AND to_stop_id=?').get('FORBID_BUS', 'FORBID_RAIL')?.provenance, 'gtfs_transfer')
  } finally {
    database.close()
  }

  const plan = routeNationalGtfsStore(storePath, {
    origin: { stopId: 'A', coordinate: [0, 0], label: 'Origin', source: 'stop' },
    destination: { stopId: 'B', coordinate: [0.02, 0.0017], label: 'Destination', source: 'stop' },
    departMinutes: 8 * 60,
    timePreference: 'depart',
    serviceDate: '2026-06-10',
    serviceDay: 'weekday',
    allowServiceDateFallback: false,
    maxWalkKm: 0.25,
  })
  assert.equal(plan.status, 'blocked')
  assert.equal(result.transferCount, 1, 'Only the literal forbidden transfer belongs in the routable table.')
  assert.equal(result.transferSemanticsVersion, 'vigo.routing.transfers.v2')
  assert(result.transferGeneration.radialCandidateCount >= 2)
  assert.equal(result.transferGeneration.inferredTransferCount, 0)

  console.log(JSON.stringify({
    ok: true,
    excludedUnprovedPair: ['BUS_X', 'RAIL_X'],
    transferCount: result.transferCount,
  }, null, 2))
} finally {
  disposeNationalGtfsStore(storePath)
  await fs.rm(root, { recursive: true, force: true })
}
