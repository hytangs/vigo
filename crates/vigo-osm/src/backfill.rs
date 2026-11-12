//! Add the optional place-name tables to an existing street store
//! (`backfillPlaceNames`). Routing data, the basemap and every other table
//! stay as they are: the City is only written in one final transaction, and
//! only when the PBF is the store's own source.
use crate::pbf::{self, Block, DenseNodes, Handler, Node, Way};
use crate::places::{self, Place};
use crate::store::{IdMap, IdSet, NodeLookup, elapsed_ms, iso_now};
use crate::tags::Tags;
use crate::{Error, Progress, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::path::Path;
use vigo_format::js::Js;

/// `metadata.placeNames.schemaVersion`.
pub const SCHEMA_VERSION: &str = "vigo.place-names.v1";

const SOURCE_MISMATCH: &str =
    "OSM source fingerprint does not match the existing City. No City data was changed.";

/// A selected way, classified while its tags are in hand.
struct Selected {
    id: i64,
    refs: Vec<i64>,
    place: Place,
}

/// Node coordinates as `(lat, lon)`, read back as the SQLite REAL staging
/// column returned them: a negative zero becomes zero.
#[derive(Default)]
struct Coordinates(IdMap<(f64, f64)>);

impl NodeLookup for Coordinates {
    fn get(&self, id: i64) -> Option<(f64, f64)> {
        self.0.get(&id).copied()
    }
}

struct SelectionPass {
    ways: Vec<Selected>,
    required: IdSet,
}

impl Handler for SelectionPass {
    fn wants_ways(&self) -> bool {
        true
    }
    fn way(&mut self, block: &Block, way: Way) -> Result<()> {
        let tags = Tags::from_keys(block, &way.keys, &way.vals)?;
        let Some(place) = places::classify(&way, &tags) else {
            return Ok(());
        };
        self.required.extend(way.refs.iter().copied());
        self.ways.push(Selected {
            id: way.id,
            refs: way.refs,
            place,
        });
        Ok(())
    }
}

struct GeometryPass<'a> {
    required: &'a IdSet,
    nodes: Coordinates,
}

impl GeometryPass<'_> {
    // Every coordinate is validated, as the JavaScript pass converted each one.
    fn node(&mut self, block: &Block, id: i64, lat: i64, lon: i64) -> Result<()> {
        let (lon, lat) = block.coordinate(lat, lon)?;
        if self.required.contains(&id) {
            self.nodes.0.insert(id, (lat + 0.0, lon + 0.0));
        }
        Ok(())
    }
}

impl Handler for GeometryPass<'_> {
    fn wants_nodes(&self) -> bool {
        true
    }
    fn node(&mut self, block: &Block, node: Node) -> Result<()> {
        GeometryPass::node(self, block, node.id, node.lat, node.lon)
    }
    fn dense_nodes(&mut self, block: &Block, dense: DenseNodes) -> Result<()> {
        for index in 0..dense.ids.len() {
            GeometryPass::node(
                self,
                block,
                dense.ids[index],
                dense.lats[index],
                dense.lons[index],
            )?;
        }
        Ok(())
    }
}

fn source_fingerprint(db: &Connection) -> Result<String> {
    let text: Option<String> = db
        .query_row(
            "SELECT value FROM metadata WHERE key='sourceFingerprint'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let value =
        Js::parse(text.as_deref().unwrap_or("null")).map_err(|e| Error::new(e.to_string()))?;
    match value.as_str() {
        Some(text)
            if text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Ok(text.to_owned())
        }
        _ => Err(Error::new(
            "The existing street store has no valid OSM source fingerprint.",
        )),
    }
}

fn counts(db: &Connection, schema: &str) -> rusqlite::Result<(f64, f64)> {
    let count = |table: &str| {
        db.query_row(
            &format!("SELECT count(*) AS n FROM {schema}.{table}"),
            [],
            |row| row.get::<_, i64>(0),
        )
    };
    Ok((count("place_streets")? as f64, count("place_areas")? as f64))
}

/// The receipt of a complete index for this source, or `None` when the
/// index is missing, older, from another source or incomplete.
fn completed_index(db: &Connection, fingerprint: &str) -> Result<Option<Js>> {
    let text: Option<String> = db
        .query_row(
            "SELECT value FROM metadata WHERE key='placeNames'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let metadata =
        Js::parse(text.as_deref().unwrap_or("null")).map_err(|e| Error::new(e.to_string()))?;
    if metadata.get("schemaVersion").and_then(Js::as_str) != Some(SCHEMA_VERSION)
        || metadata.get("sourceFingerprint").and_then(Js::as_str) != Some(fingerprint)
    {
        return Ok(None);
    }
    // An interrupted or older optional index is repaired without rebuilding the City.
    let Ok((streets, areas)) = counts(db, "main") else {
        return Ok(None);
    };
    let matches = metadata.get("streets").and_then(Js::as_f64) == Some(streets)
        && metadata.get("areas").and_then(Js::as_f64) == Some(areas);
    Ok(matches.then_some(metadata))
}

#[cfg(unix)]
fn file_identity(path: &Path) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(path: &Path) -> Result<(u64, u64)> {
    let created = std::fs::metadata(path)?
        .created()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok((created.as_secs(), u64::from(created.subsec_nanos())))
}

fn finish(mut receipt: Js, built: bool, started: std::time::Instant) -> Js {
    receipt
        .set("built", built)
        .set("elapsedMs", elapsed_ms(started));
    receipt
}

/// Scan one pass of the PBF and require it to be the store's source.
fn scan(
    pbf_path: &Path,
    fingerprint: &str,
    phase: &str,
    handler: &mut dyn Handler,
    progress: &mut dyn FnMut(&Progress) -> Result<()>,
) -> Result<()> {
    let digest = pbf::for_each_block(
        pbf_path,
        &mut |block| block.for_each(&mut *handler),
        &mut |p| {
            progress(&Progress {
                phase,
                progress: p.fraction(),
                detail: "",
                work: Some(crate::Work {
                    completed: p.bytes_read,
                    total: p.total_bytes,
                }),
            })
        },
    )?;
    if digest != fingerprint {
        return Err(Error::new(SOURCE_MISMATCH));
    }
    Ok(())
}

/// `backfillPlaceNames({ streetPath, pbfPath, onProgress })`. An error from
/// `progress` stops the backfill with the City unchanged.
pub fn backfill_place_names(
    street_path: &Path,
    pbf_path: &Path,
    progress: &mut dyn FnMut(&Progress) -> Result<()>,
) -> Result<Js> {
    let started = std::time::Instant::now();
    let original = file_identity(street_path)?;
    let fingerprint = {
        let db = Connection::open_with_flags(street_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let fingerprint = source_fingerprint(&db)?;
        if let Some(complete) = completed_index(&db, &fingerprint)? {
            return Ok(finish(complete, false, started));
        }
        fingerprint
    };

    // Nothing in the City is written during the PBF passes.
    let mut selection = SelectionPass {
        ways: Vec::new(),
        required: IdSet::default(),
    };
    scan(
        pbf_path,
        &fingerprint,
        "Selecting named ways",
        &mut selection,
        progress,
    )?;
    // Resolve nodes in a separate pass: ways-before-nodes PBFs work as well.
    let mut geometry = GeometryPass {
        required: &selection.required,
        nodes: Coordinates::default(),
    };
    scan(
        pbf_path,
        &fingerprint,
        "Resolving named-way geometry",
        &mut geometry,
        progress,
    )?;
    let nodes = geometry.nodes;
    progress(&Progress {
        phase: "Writing place names",
        progress: 0.0,
        detail: "",
        work: None,
    })?;
    // Places are written in way-ID order, as the staged index was read.
    let mut ways = selection.ways;
    ways.sort_by_key(|way| way.id);
    if ways.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err(Error::new("UNIQUE constraint failed: ways.id"));
    }
    let staging = Connection::open_in_memory()?;
    places::create_tables(&staging)?;
    staging.execute_batch("BEGIN")?;
    for way in &ways {
        places::write(&staging, &way.place, &way.refs, &nodes)?;
    }
    staging.execute_batch("COMMIT")?;
    let (streets, areas) = counts(&staging, "main")?;
    let receipt = Js::object()
        .with("schemaVersion", SCHEMA_VERSION)
        .with("sourceFingerprint", fingerprint.as_str())
        .with("streets", streets)
        .with("areas", areas)
        .with("skippedWays", ways.len() as f64 - streets - areas)
        .with("builtAt", iso_now());
    drop(nodes);
    drop(ways);
    progress(&Progress {
        phase: "Publishing place names",
        progress: 0.0,
        detail: "",
        work: None,
    })?;

    // Both tables and their receipt commit together; the file, basemap,
    // metadata and graph sidecars are kept. SQLite readers see either the
    // old complete index or the new one, including in WAL mode.
    let db = Connection::open(street_path)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    // In WAL mode the commit stays in the WAL when this connection closes.
    // Another process's read locks can be lost when that process opens the
    // store through a second SQLite library, and a checkpoint here would then
    // rewrite pages under its reader; the next connection checkpoints instead.
    db.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )?;
    db.execute_batch("BEGIN IMMEDIATE")?;
    let published = (|| -> Result<Option<Js>> {
        if file_identity(street_path)? != original || source_fingerprint(&db)? != fingerprint {
            return Err(Error::new(
                "The street store changed during place-name preparation. Retry with its current source.",
            ));
        }
        // A concurrent backfill may have completed while this one was staging.
        if let Some(complete) = completed_index(&db, &fingerprint)? {
            return Ok(Some(complete));
        }
        db.execute_batch(
            "DROP TABLE IF EXISTS main.place_streets; DROP TABLE IF EXISTS main.place_areas",
        )?;
        places::create_tables(&db)?;
        copy_rows(&staging, &db, "place_streets", "name, road_class, geometry")?;
        copy_rows(&staging, &db, "place_areas", "name, kind, geometry")?;
        db.execute(
            "INSERT OR REPLACE INTO metadata(key,value) VALUES('placeNames',?)",
            params![receipt.stringify()],
        )?;
        Ok(None)
    })();
    match published {
        Ok(complete) => {
            db.execute_batch("COMMIT")?;
            Ok(match complete {
                Some(complete) => finish(complete, false, started),
                None => finish(receipt, true, started),
            })
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// `INSERT INTO main.T SELECT * FROM names.T`: rows keep their IDs.
fn copy_rows(from: &Connection, to: &Connection, table: &str, columns: &str) -> Result<()> {
    let mut select = from.prepare(&format!("SELECT id, {columns} FROM {table} ORDER BY id"))?;
    let mut insert = to.prepare(&format!(
        "INSERT INTO main.{table}(id, {columns}) VALUES(?,?,?,?)"
    ))?;
    let mut rows = select.query([])?;
    while let Some(row) = rows.next()? {
        insert.execute(params![
            row.get::<_, rusqlite::types::Value>(0)?,
            row.get::<_, rusqlite::types::Value>(1)?,
            row.get::<_, rusqlite::types::Value>(2)?,
            row.get::<_, rusqlite::types::Value>(3)?,
        ])?;
    }
    Ok(())
}
