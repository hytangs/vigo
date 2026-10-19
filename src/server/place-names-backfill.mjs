import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { coordinate, forEachPbfBlock, forEachPrimitiveEntity, wayTags } from './osm-pbf-reader.mjs'
import { createPlaceStreetWriter, placeWayNeedsNodes } from './place-names-store.mjs'

const schemaVersion = 'vigo.place-names.v1'

function sourceFingerprint(db) {
  const value = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='sourceFingerprint'").get()?.value ?? 'null')
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('The existing street store has no valid OSM source fingerprint.')
  }
  return value
}

function counts(db) {
  return {
    streets: db.prepare('SELECT count(*) AS n FROM main.place_streets').get().n,
    areas: db.prepare('SELECT count(*) AS n FROM main.place_areas').get().n,
  }
}

function completedIndex(db, fingerprint) {
  const metadata = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='placeNames'").get()?.value ?? 'null')
  if (metadata?.schemaVersion !== schemaVersion || metadata.sourceFingerprint !== fingerprint) return null
  try {
    const actual = counts(db)
    return actual.streets === metadata.streets && actual.areas === metadata.areas ? metadata : null
  } catch {
    return null // An interrupted/older optional index can be repaired without rebuilding the City.
  }
}

/** Add only optional display-name tables. Never rebuild or replace routing data.
 * Reuses the importer's PBF reader and naming policy; lookups remain in Rust.
 * Temporary node/way storage is disk-backed, bounded by SQLite's page cache.
 */
export async function backfillPlaceNames({ streetPath, pbfPath, signal, onProgress }) {
  const started = performance.now()
  signal?.throwIfAborted()
  const original = await fs.stat(streetPath)
  let db = new DatabaseSync(streetPath, { readOnly: true })
  let fingerprint, complete
  try {
    fingerprint = sourceFingerprint(db)
    complete = completedIndex(db, fingerprint)
  } finally {
    db.close()
  }
  if (complete) return { ...complete, built: false, elapsedMs: performance.now() - started }
  // A unique sibling staging directory permits retries without deleting someone
  // else's work. Nothing in the live store is written during the PBF passes.
  const staging = await fs.mkdtemp(path.join(path.dirname(streetPath), '.place-names-'))
  let stage
  try {
    stage = new DatabaseSync(path.join(staging, 'names.sqlite'))
    stage.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-32768; PRAGMA temp_store=FILE;
      CREATE TABLE nodes(id INTEGER PRIMARY KEY, lon REAL, lat REAL);
      CREATE TABLE ways(id INTEGER PRIMARY KEY, refs TEXT NOT NULL, tags TEXT NOT NULL);`)
    const writer = createPlaceStreetWriter(stage)
    const insertWay = stage.prepare('INSERT INTO ways VALUES(?,?,?)')
    const requireNode = stage.prepare('INSERT OR IGNORE INTO nodes(id) VALUES(?)')
    const updateNode = stage.prepare('UPDATE nodes SET lon=?,lat=? WHERE id=?')
    const getNode = stage.prepare('SELECT lon,lat FROM nodes WHERE id=? AND lon IS NOT NULL AND lat IS NOT NULL')
    let selectedWays = 0
    const scan = async (phase, visit) => {
      const hash = crypto.createHash('sha256')
      await forEachPbfBlock(pbfPath, (block) => {
        signal?.throwIfAborted()
        stage.exec('BEGIN')
        try {
          for (const group of block.groups) forEachPrimitiveEntity(block, group, visit(block))
          stage.exec('COMMIT')
        } catch (error) {
          stage.exec('ROLLBACK')
          throw error
        }
      }, (progress) => onProgress?.({ ...progress, phase }), (bytes) => hash.update(bytes))
      if (hash.digest('hex') !== fingerprint) {
        throw new Error('OSM source fingerprint does not match the existing City. No City data was changed.')
      }
    }
    await scan('Selecting named ways', (block) => ({ way(way) {
      const tags = wayTags(way, block.strings)
      if (!placeWayNeedsNodes(way, tags)) return
      insertWay.run(way.id, JSON.stringify(way.refs), JSON.stringify(tags))
      for (const id of way.refs) requireNode.run(id)
      selectedWays += 1
    } }))
    // Resolve nodes in a separate pass: ways-before-nodes PBFs work as well.
    await scan('Resolving named-way geometry', (block) => ({
      node(node) { updateNode.run(...coordinate(block, node.lat, node.lon), node.id) },
      denseNodes(dense) {
        for (let i = 0; i < dense.ids.length; i += 1) {
          updateNode.run(...coordinate(block, dense.lats[i], dense.lons[i]), dense.ids[i])
        }
      },
    }))
    onProgress?.({ phase: 'Writing place names', progress: 0 })
    stage.exec('BEGIN')
    for (const way of stage.prepare('SELECT refs,tags FROM ways ORDER BY id').iterate()) {
      signal?.throwIfAborted()
      writer.addWay({ refs: JSON.parse(way.refs) }, JSON.parse(way.tags), getNode)
    }
    stage.exec('COMMIT')
    const totals = counts(stage)
    const result = { schemaVersion, sourceFingerprint: fingerprint, ...totals,
      skippedWays: selectedWays - totals.streets - totals.areas, builtAt: new Date().toISOString() }
    stage.close()
    stage = null
    signal?.throwIfAborted()
    onProgress?.({ phase: 'Publishing place names', progress: 0 })
    // Commit both tables and their receipt together, preserving the existing
    // file/inode, basemap, metadata and graph sidecars. SQLite readers see either
    // the old complete index or the new complete index, including in WAL mode.
    db = new DatabaseSync(streetPath)
    try {
      db.exec('PRAGMA busy_timeout=5000')
      db.prepare('ATTACH DATABASE ? AS names').run(path.join(staging, 'names.sqlite'))
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = await fs.stat(streetPath)
        if (current.dev !== original.dev || current.ino !== original.ino || sourceFingerprint(db) !== fingerprint) {
          throw new Error('The street store changed during place-name preparation. Retry with its current source.')
        }
        signal?.throwIfAborted()
        // A concurrent backfill may have completed while this one was staging.
        complete = completedIndex(db, fingerprint)
        if (!complete) {
          db.exec('DROP TABLE IF EXISTS main.place_streets; DROP TABLE IF EXISTS main.place_areas')
          createPlaceStreetWriter(db)
          db.exec('INSERT INTO main.place_streets SELECT * FROM names.place_streets; INSERT INTO main.place_areas SELECT * FROM names.place_areas')
          db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('placeNames',?)").run(JSON.stringify(result))
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      db.close()
    }
    return { ...(complete ?? result), built: !complete, elapsedMs: performance.now() - started }
  } finally {
    stage?.close()
    await fs.rm(staging, { recursive: true, force: true })
  }
}
