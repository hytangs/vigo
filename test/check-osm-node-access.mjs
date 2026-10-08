import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PbfWriter } from 'pbf'
import { buildNationalOsmStore, nationalOsmNodeWalkable, nationalOsmWayWalkable } from '../src/server/national-osm-store.mjs'
import { forEachPbfBlock, forEachPrimitiveEntity } from '../src/server/osm-pbf-reader.mjs'

const encode = (write, value) => { const p = new PbfWriter(); write(value, p); return Buffer.from(p.finish()) }
const delta = values => values.map((v, i) => v - (values[i - 1] ?? 0))
function fixture(dense, nodeTags, corrupt, wheelchair = false) {
  const strings = ['', 'highway', 'residential', ...new Set(Object.entries(nodeTags).flat()), 'wheelchair', 'yes']
  const keys = Object.keys(nodeTags).map(k => strings.indexOf(k)), vals = Object.values(nodeTags).map(v => strings.indexOf(v))
  const ids = [5100000001, 5100000002, 5100000003, 5100000004]
  const lons = [0, 10000, 20000, 30000]
  const raw = encode((_, p) => {
    p.writeMessage(1, (ss, p) => { for (const s of ss) p.writeStringField(1, s) }, strings)
    p.writeMessage(2, (_, p) => {
      if (dense) p.writeMessage(2, (_, p) => {
        p.writePackedSVarint(1, delta(ids)); p.writePackedSVarint(8, [0, 0, 0, 0]); p.writePackedSVarint(9, delta(lons))
        const tags = [0, ...keys.flatMap((k, i) => [k, vals[i]]), 0, 0, 0]
        if (corrupt === 'delimiter') tags.pop()
        if (corrupt === 'string') tags[1] = 999
        p.writePackedVarint(10, tags)
      }, null)
      else for (let i = 0; i < ids.length; i++) p.writeMessage(1, (_, p) => {
        p.writeSVarintField(1, ids[i]); p.writeSVarintField(8, 0); p.writeSVarintField(9, lons[i])
        if (i === 1) { p.writePackedVarint(2, keys); p.writePackedVarint(3, vals) }
      }, null)
      p.writeMessage(3, (_, p) => {
        p.writeVarintField(1, 10); p.writePackedVarint(2, wheelchair ? [1, strings.indexOf('wheelchair')] : [1]); p.writePackedVarint(3, wheelchair ? [2, strings.indexOf('yes')] : [2]); p.writePackedSVarint(8, delta(ids))
      }, null)
    }, null)
  }, null)
  const frame = (type, raw) => {
    const blob = encode((raw, p) => { p.writeBytesField(1, raw); p.writeVarintField(2, raw.length) }, raw)
    const header = encode((_, p) => { p.writeStringField(1, type); p.writeVarintField(3, blob.length) }, null)
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length)
    return Buffer.concat([size, header, blob])
  }
  const header = encode((_, p) => { p.writeStringField(4, 'OsmSchema-V0.6'); if (dense) p.writeStringField(4, 'DenseNodes') }, null)
  return Buffer.concat([frame('OSMHeader', header), frame('OSMData', raw)])
}
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-node-access-'))
try {
  for (const dense of [false, true]) for (const [name, tags, blocked] of [
    ['private-gate', { barrier: 'gate', access: 'private' }, true],
    ['foot-override', { barrier: 'gate', access: 'private', foot: 'yes' }, false],
    ['wall', { barrier: 'wall' }, true], ['unknown-gate', { barrier: 'gate' }, true],
    ['public-gate', { barrier: 'gate', access: 'yes' }, false],
    ['conditional', { foot: 'yes', 'foot:conditional': 'no @ (Mo-Fr)' }, true],
  ]) {
    const pbfPath = path.join(folder, `${dense}-${name}.pbf`), outputPath = `${pbfPath}.sqlite`
    await fs.writeFile(pbfPath, fixture(dense, tags))
    const parsed = []
    await forEachPbfBlock(pbfPath, block => {
      for (const group of block.groups) forEachPrimitiveEntity(block, group, {
        node: n => parsed.push(n.id), denseNodes: n => parsed.push(...n.ids),
      })
    })
    assert.deepEqual(parsed, [5100000001, 5100000002, 5100000003, 5100000004], 'Both PBF encodings retain exact node IDs.')
    await buildNationalOsmStore({ pbfPath, outputPath })
    const db = new DatabaseSync(outputPath, { readOnly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edges').get().n, blocked ? 2 : 6)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM walk_nodes').get().n, blocked ? 2 : 4)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edges WHERE from_node=5100000002 OR to_node=5100000002').get().n, blocked ? 0 : 4)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drive_edges').get().n, 6, 'Pedestrian permissions do not rewrite the driving model.')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edges LEFT JOIN walk_nodes ON from_node=node_id WHERE node_id IS NULL').get().n, 0,
      'A segment after a rejected node must still insert its first walk vertex.')
    assert.equal(JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='blockedWalkNodeCount'").get().value), blocked ? 1 : 0)
    db.close()
  }
  for (const dense of [false, true]) for (const [name, tags, blocked] of [
    ['raised-kerb', { kerb: 'raised' }, true], ['narrow', { width: '70 cm', wheelchair: 'yes' }, true],
    ['unknown-bollard', { barrier: 'bollard' }, true], ['accessible-gate', { barrier: 'gate', wheelchair: 'yes', foot: 'yes' }, false],
  ]) {
    const pbfPath = path.join(folder, `wheelchair-${dense}-${name}.pbf`), outputPath = `${pbfPath}.sqlite`
    await fs.writeFile(pbfPath, fixture(dense, tags, null, true))
    await buildNationalOsmStore({ pbfPath, outputPath, wheelchair: true, includeDriving: false })
    const db = new DatabaseSync(outputPath, { readOnly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edges').get().n, blocked ? 2 : 6)
    assert.equal(JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='accessibility'").get().value).profile, 'wheelchair-strict-v1')
    db.close()
  }
  for (const corrupt of ['delimiter', 'string']) {
    const pbfPath = path.join(folder, `bad-${corrupt}.pbf`)
    await fs.writeFile(pbfPath, fixture(true, { foot: 'no' }, corrupt))
    await assert.rejects(buildNationalOsmStore({ pbfPath, outputPath: `${pbfPath}.sqlite` }), /dense-node tags|out-of-range string-table/)
  }
  assert.equal(nationalOsmNodeWalkable({ barrier: 'bollard' }), true)
  assert.equal(nationalOsmWayWalkable({ highway: 'footway', foot: 'use_sidepath' }), false)
  assert.equal(nationalOsmWayWalkable({ highway: 'footway', opening_hours: '24/7' }), true)
  assert.equal(nationalOsmWayWalkable({ highway: 'footway', opening_hours: 'Mo-Fr 08:00-17:00' }), false)
  console.log('OSM node access passed: regular/dense tags, signed IDs, barriers, overrides, conditional access and malformed tags.')
} finally { await fs.rm(folder, { recursive: true, force: true }) }
