import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PbfWriter } from 'pbf'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, prepareNationalOsmNativeStore, routeNationalStreetStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { buildNativeStreetCchIndex } from '../src/server/native-routing-kernel.mjs'
import { buildNationalGtfsStore, disposeNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { buildTerminalAccessStore } from '../src/server/terminal-access-store.mjs'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const encode = (write, value) => { const p = new PbfWriter(); write(value, p); return Buffer.from(p.finish()) }
const delta = values => values.map((v, i) => v - (values[i - 1] ?? 0))
function fixture({ secondEntrance = true, privatePlatform = false, privateGate = false } = {}) {
  const nodes = [
    [1, -77.051, 38.9], [2, -77.05, 38.9], [3, -77.05, 38.9001],
    [4, -77.049, 38.9001], [5, -77.049, 38.9], [6, -77.048, 38.9],
    [7, -77.051, 38.8999], [8, -77.048, 38.8999],
  ]
  const ways = [
    [10, [1, 2], { highway: 'footway' }],
    ...(secondEntrance ? [[11, [5, 6], { highway: 'footway' }]] : []),
    [20, [2, 3, 4, 5, 2], { railway: 'platform', area: 'yes', foot: privatePlatform ? 'private' : 'yes' }],
    [30, [7, 8], { railway: 'light_rail' }],
  ]
  const gate = { barrier: 'gate', ...(privateGate ? { access: 'private' } : {}) }
  const strings = ['', ...new Set([...ways.flatMap(w => Object.entries(w[2]).flat()), ...Object.entries(gate).flat()])]
  const tags = (p, t) => {
    p.writePackedVarint(2, Object.keys(t).map(k => strings.indexOf(k)))
    p.writePackedVarint(3, Object.values(t).map(v => strings.indexOf(v)))
  }
  const raw = encode((_, p) => {
    p.writeMessage(1, (_, p) => { for (const s of strings) p.writeStringField(1, s) }, null)
    p.writeMessage(2, (_, p) => {
      for (const [id, lon, lat] of nodes) p.writeMessage(1, (_, p) => {
        p.writeSVarintField(1, id); p.writeSVarintField(8, Math.round(lat * 1e7)); p.writeSVarintField(9, Math.round(lon * 1e7))
        if (id === 2) tags(p, gate)
      }, null)
      // The platform comes first: connectivity must not depend on way order.
      for (const [id, refs, t] of ways.toReversed()) p.writeMessage(3, (_, p) => {
        p.writeVarintField(1, id); tags(p, t); p.writePackedSVarint(8, delta(refs))
      }, null)
    }, null)
  }, null)
  const frame = (type, raw) => {
    const blob = encode((_, p) => { p.writeBytesField(1, raw); p.writeVarintField(2, raw.length) }, null)
    const header = encode((_, p) => { p.writeStringField(1, type); p.writeVarintField(3, blob.length) }, null)
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length)
    return Buffer.concat([size, header, blob])
  }
  return Buffer.concat([frame('OSMHeader', encode((_, p) => p.writeStringField(4, 'OsmSchema-V0.6'), null)), frame('OSMData', raw)])
}

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-platform-connections-'))
const streetStores = []
try {
  for (const [name, options, connected] of [
    ['public', {}, true], ['one-entrance', { secondEntrance: false }, false],
    ['private-platform', { privatePlatform: true }, false], ['private-gate', { privateGate: true }, false],
  ]) {
    const dir = path.join(folder, name); fs.mkdirSync(dir)
    const { gtfsPath, osmPath } = await writeCliFixtureInputs(dir)
    fs.writeFileSync(osmPath, fixture(options))
    const store = path.join(dir, 'streets.sqlite')
    streetStores.push(store)
    await buildNationalOsmStore({ pbfPath: osmPath, outputPath: store, includeDriving: false })
    const db = new DatabaseSync(store, { readOnly: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edges WHERE way_id=20').get().n, connected ? 8 : 0, name)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edges WHERE way_id=30').get().n, 0, 'Railway tracks never supply walking edges')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM walk_nodes WHERE node_id IN (3,4)').get().n, connected ? 2 : 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='platform_areas'").get().n, 0, 'Import staging is not retained')
    db.close()
    if (connected) {
      compactNationalOsmRuntimeStore(store, { requireDrive: false })
      prepareNationalOsmNativeStore(store); buildNativeStreetCchIndex(store)
      for (const [from, to] of [[[-77.051, 38.9], [-77.048, 38.9]], [[-77.048, 38.9], [-77.051, 38.9]]]) {
        const result = routeNationalStreetStore(store, { mode: 'walk', origin: { coordinate: from }, destination: { coordinate: to }, maxStreetKm: 1 })
        assert.equal(result.status, 'ready')
        assert(result.durationMinutes > 3 && result.durationMinutes < 4)
      }
      const transit = path.join(dir, 'transit.sqlite')
      await buildNationalGtfsStore({ zipPath: gtfsPath, outputPath: transit })
      const overlay = await buildTerminalAccessStore({ pbfPath: osmPath, streetStorePath: store, routingStorePath: transit })
      assert.equal(overlay.sourceNodeIdentityVerified, true, 'Optional endpoint access reproduces platform vertex identities')
      disposeNationalGtfsStore(transit)
    }
  }
  console.log('Platform connections passed: mapped public junctions, both directions, private gates/platforms, isolated outlines, excluded tracks, and source identity.')
} finally {
  for (const store of streetStores) disposeNationalOsmStore(store)
  fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
