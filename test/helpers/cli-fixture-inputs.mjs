import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { PbfWriter } from 'pbf'

function pbfMessage(write, value) {
  const writer = new PbfWriter()
  write(value, writer)
  return Buffer.from(writer.finish())
}

function writeBlobHeader(value, pbf) {
  pbf.writeStringField(1, value.type)
  pbf.writeVarintField(3, value.dataSize)
}

function writeBlob(value, pbf) {
  pbf.writeBytesField(1, value.raw)
  pbf.writeVarintField(2, value.raw.length)
}

function writeHeaderBlock(_value, pbf) {
  pbf.writeStringField(4, 'OsmSchema-V0.6')
}

function writeStringTable(strings, pbf) {
  for (const value of strings) pbf.writeStringField(1, value)
}

function writeNode(node, pbf) {
  pbf.writeVarintField(1, node.id)
  pbf.writeSVarintField(8, node.lat)
  pbf.writeSVarintField(9, node.lon)
}

function writeWay(way, pbf) {
  pbf.writeVarintField(1, way.id)
  pbf.writePackedVarint(2, way.keys)
  pbf.writePackedVarint(3, way.values)
  pbf.writePackedSVarint(8, way.refs)
}

function writePrimitiveGroup(group, pbf) {
  for (const node of group.nodes) pbf.writeMessage(1, writeNode, node)
  for (const way of group.ways ?? [group.way]) pbf.writeMessage(3, writeWay, way)
}

function writePrimitiveBlock(block, pbf) {
  pbf.writeMessage(1, writeStringTable, block.strings)
  pbf.writeMessage(2, writePrimitiveGroup, block.group)
}

function writeOsmFixture(filePath, terminalAccess) {
  const raw = pbfMessage(writePrimitiveBlock, {
    strings: ['', 'highway', 'residential', 'footway', 'service', 'access', 'private', 'foot'],
    group: {
      nodes: [
        { id: 1, lat: 389_000_000, lon: -770_500_000 },
        { id: 2, lat: 389_050_000, lon: -770_400_000 },
        { id: 3, lat: 389_100_000, lon: -770_300_000 },
        ...(terminalAccess ? [
          { id: 4, lat: 389_000_000, lon: -770_540_000 },
          { id: 5, lat: 389_000_000, lon: -770_535_000 },
          { id: 6, lat: 389_000_000, lon: -770_520_000 },
        ] : []),
      ],
      ways: [
        { id: 10, keys: [1], values: [2], refs: [1, 1, 1] },
        ...(terminalAccess ? [
          { id: 11, keys: [1], values: [3], refs: [4, 1] },
          { id: 12, keys: [1, 5], values: [4, 6], refs: [5, 1] },
          { id: 13, keys: [1, 7], values: [3, 6], refs: [6, -5] },
        ] : []),
      ],
    },
  })
  const framedBlock = (type, payload) => {
    const blob = pbfMessage(writeBlob, { raw: payload })
    const header = pbfMessage(writeBlobHeader, { type, dataSize: blob.length })
    const length = Buffer.alloc(4)
    length.writeUInt32BE(header.length)
    return Buffer.concat([length, header, blob])
  }
  fs.writeFileSync(filePath, Buffer.concat([
    framedBlock('OSMHeader', pbfMessage(writeHeaderBlock, {})),
    framedBlock('OSMData', raw),
  ]))
}

export async function writeCliFixtureInputs(directory, { terminalAccess = false } = {}) {
  const gtfsPath = path.join(directory, 'fixture.zip')
  const osmPath = path.join(directory, 'fixture.osm.pbf')
  const zip = new JSZip()
  const fixtureDate = new Date('2026-01-01T00:00:00.000Z')
  const addTable = (name, contents) => zip.file(name, contents, { date: fixtureDate })
  addTable('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture Transit,https://example.test,America/New_York\n')
  addTable('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,38.900,-77.050\nX,Transfer,38.905,-77.040\nB,Bravo,38.910,-77.030\n')
  addTable('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type\nR1,fixture,R1,First Route,3\nR2,fixture,R2,Second Route,3\n')
  addTable('trips.txt', 'route_id,service_id,trip_id,direction_id\nR1,WKD,T1,0\nR2,WKD,T2,0\n')
  addTable('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,X,2\nT2,08:15:00,08:15:00,X,1\nT2,08:30:00,08:30:00,B,2\n')
  addTable('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWKD,1,1,1,1,1,0,0,20260101,20261231\n')
  fs.writeFileSync(gtfsPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  writeOsmFixture(osmPath, terminalAccess)
  return { gtfsPath, osmPath }
}
