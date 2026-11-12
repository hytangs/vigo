//! Drive snapshot preparation and sealing the runtime street store
//! (`compactNationalOsmRuntimeStore`).

use crate::accelerator::{self, Metadata};
use crate::jsrt;
use crate::store::{self, RUNTIME_LAYOUT, SCHEMA_VERSION, elapsed_ms};
use crate::{Error, Result};
use rusqlite::{Connection, OpenFlags, params};
use std::path::Path;
use vigo_format::js::Js;

/// The native drive hierarchy, built by the runtime from the persisted
/// snapshot. Returns `(configureMs, diagnostics)`.
pub type NativeDrive<'a> = &'a mut dyn FnMut(&Path) -> Result<(f64, Js)>;

fn number(metadata: &Metadata, key: &str) -> f64 {
    metadata
        .get(key)
        .filter(|v| !v.is_null())
        .map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN))
}

/// `driveAcceleratorEligibility(metadata)`: `(eligible, reason, nodes, edges)`.
fn drive_eligibility(metadata: &Metadata) -> (bool, &'static str, f64, f64) {
    if metadata
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        != Some(SCHEMA_VERSION)
    {
        return (false, "driving_profile_unavailable", 0.0, 0.0);
    }
    let nodes = jsrt::max(0.0, number(metadata, "driveNodeCount"));
    let edges = jsrt::max(0.0, number(metadata, "driveEdgeCount"));
    if nodes == 0.0 || nodes.is_nan() || edges == 0.0 || edges.is_nan() {
        return (false, "driving_profile_empty", nodes, edges);
    }
    if nodes > store::drive_maximum_nodes() {
        return (false, "node_budget", nodes, edges);
    }
    if edges > store::drive_maximum_edges() {
        return (false, "edge_budget", nodes, edges);
    }
    (true, "eligible", nodes, edges)
}

/// Whether a persisted drive snapshot can be loaded for this store
/// (`loadDriveAcceleratorSnapshot`): `Ok(Some(nodes, edges))`, or the status.
fn load_drive_snapshot(
    path: &Path,
    metadata: &Metadata,
) -> std::result::Result<(f64, f64), (&'static str, String)> {
    let snapshot = accelerator::drive_snapshot_path(path);
    let size = match std::fs::metadata(&snapshot) {
        Ok(stat) => stat.len() as f64,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(("missing", String::new()));
        }
        Err(error) => return Err(("load_error", error.to_string())),
    };
    let load_error = |message: &str| ("load_error", message.to_owned());
    if size < accelerator::HEADER_BYTES as f64 {
        return Err(load_error("Drive accelerator snapshot is truncated."));
    }
    let header =
        accelerator::read_header(&snapshot).map_err(|error| ("load_error", error.to_string()))?;
    if header.get("magic").and_then(|v| v.as_str()) != Some(accelerator::DRIVE_SNAPSHOT_MAGIC)
        || header.get("version").and_then(|v| v.as_f64())
            != Some(accelerator::DRIVE_SNAPSHOT_VERSION)
    {
        return Err(load_error(
            "Drive accelerator snapshot version is unsupported.",
        ));
    }
    // JSON.stringify(header.identity) === JSON.stringify(expected): the
    // header text keeps the member order a parsed map would lose.
    let raw = accelerator::read_header_text(&snapshot)
        .map_err(|error| ("load_error", error.to_string()))?;
    let expected = accelerator::drive_identity(metadata).stringify();
    let same_values = header.get("identity").is_some_and(|v| {
        Js::from(v)
            == Js::from(&serde_json::from_str::<serde_json::Value>(&expected).unwrap_or_default())
    });
    if !same_values || !raw.contains(&format!("\"identity\":{expected}")) {
        return Err(("stale", String::new()));
    }
    if header.get("byteLength").and_then(|v| v.as_f64()) != Some(size) {
        return Err(load_error(
            "Drive accelerator snapshot length does not match its header.",
        ));
    }
    let nodes = header
        .get("nodeCount")
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::NAN);
    let edges = header
        .get("edgeCount")
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::NAN);
    let rows = header
        .get("spatialRows")
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::NAN);
    let columns = header
        .get("spatialColumns")
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::NAN);
    let arrays = header.get("arrays");
    let length =
        |name: &str, kind: &str, width: f64| -> std::result::Result<f64, (&'static str, String)> {
            let descriptor = arrays.and_then(|a| a.get(name));
            let valid = descriptor.is_some_and(|d| {
                d.get("type").and_then(|v| v.as_str()) == Some(kind)
                    && d.get("offset")
                        .and_then(|v| v.as_f64())
                        .is_some_and(jsrt::is_integer)
                    && d.get("length")
                        .and_then(|v| v.as_f64())
                        .is_some_and(jsrt::is_integer)
            });
            if !valid {
                return Err(load_error(&format!(
                    "Street accelerator snapshot has an invalid {kind} descriptor."
                )));
            }
            let descriptor = descriptor.unwrap_or(&serde_json::Value::Null);
            let offset = descriptor["offset"].as_f64().unwrap_or(0.0);
            let count = descriptor["length"].as_f64().unwrap_or(0.0);
            if offset < accelerator::HEADER_BYTES as f64 || offset + count * width > size {
                return Err(load_error(
                    "Street accelerator snapshot array exceeds the file boundary.",
                ));
            }
            if offset % width != 0.0 {
                return Err(load_error(
                    "Street accelerator snapshot array is misaligned.",
                ));
            }
            Ok(count)
        };
    let consistent = length("nodeLats", "Float64Array", 8.0)? == nodes
        && length("nodeLons", "Float64Array", 8.0)? == nodes
        && length("edgeOffsets", "Uint32Array", 4.0)? == nodes + 1.0
        && length("edgeTargets", "Uint32Array", 4.0)? == edges
        && length("edgeDistanceUnits", "Uint32Array", 4.0)? == edges
        && length("edgeTimeUnits", "Uint32Array", 4.0)? == edges
        && length("spatialOffsets", "Uint32Array", 4.0)? == rows * columns + 1.0
        && length("spatialNodeIndices", "Uint32Array", 4.0)? == nodes;
    if !consistent {
        return Err(load_error(
            "Drive accelerator snapshot topology is inconsistent.",
        ));
    }
    Ok((nodes, edges))
}

/// The driving snapshot of a source store and its preparation result: an
/// existing current snapshot is loaded, otherwise one is built (and written
/// when `persist`). `native` builds the drive CCH from the snapshot.
pub fn drive_profile(path: &Path, persist: bool, native: Option<NativeDrive>) -> Result<Js> {
    let started = std::time::Instant::now();
    let db = store::open_read_only(path)?;
    let metadata = accelerator::read_metadata(&db)?;
    store::admit_source(&db, path, &metadata)?;
    let (eligible, reason, eligible_nodes, eligible_edges) = drive_eligibility(&metadata);
    let snapshot_path = accelerator::drive_snapshot_path(path);
    let mut result = Js::object();
    let (accelerator, status, error) = match load_drive_snapshot(path, &metadata) {
        Ok((nodes, edges)) => {
            let load_ms = elapsed_ms(started);
            (
                Some(("snapshot", nodes, edges, 0.0, load_ms, 0.0)),
                "loaded",
                String::new(),
            )
        }
        // A snapshot load error is a status, not the profile's error.
        Err((status, _)) => {
            if !eligible {
                (None, status, String::new())
            } else {
                let built = accelerator::build_drive(path, &db, &metadata);
                match built {
                    Ok(built) if persist => (
                        Some((
                            "built",
                            built.node_count,
                            built.edge_count,
                            built.build_ms,
                            0.0,
                            built.snapshot_write_ms,
                        )),
                        "written",
                        String::new(),
                    ),
                    Ok(built) => (
                        Some((
                            "built",
                            built.node_count,
                            built.edge_count,
                            built.build_ms,
                            0.0,
                            0.0,
                        )),
                        status,
                        String::new(),
                    ),
                    Err(error) => (None, status, error.to_string()),
                }
            }
        }
    };
    let native_result = match (&accelerator, native) {
        (Some(_), Some(native)) => Some(native(&snapshot_path)?),
        _ => None,
    };
    result.set("ready", accelerator.is_some());
    result.set("accelerated", accelerator.is_some());
    result.set(
        "reason",
        if accelerator.is_some() {
            "ready"
        } else {
            reason
        },
    );
    result.set("prepareMs", elapsed_ms(started));
    result.set("buildMs", accelerator.map_or(0.0, |a| a.3));
    result.set("loadMs", accelerator.map_or(0.0, |a| a.4));
    result.set(
        "nativeConfigureMs",
        native_result.as_ref().map_or(0.0, |n| n.0),
    );
    if let Some((_, diagnostics)) = &native_result {
        result.set("nativeCch", diagnostics.clone());
    }
    result.set("snapshotWriteMs", accelerator.map_or(0.0, |a| a.5));
    if let Some(accelerator) = accelerator {
        result.set("source", accelerator.0);
    }
    result.set("snapshotStatus", status);
    result.set("snapshotPath", snapshot_path.display().to_string());
    result.set("nodeCount", accelerator.map_or(eligible_nodes, |a| a.1));
    result.set("edgeCount", accelerator.map_or(eligible_edges, |a| a.2));
    if !error.is_empty() {
        result.set("error", error);
    }
    Ok(result)
}

/// `driveBudgetDetail(preparation)`.
fn drive_budget_detail(preparation: &Js) -> String {
    let reason = preparation.get("reason").and_then(Js::as_str).unwrap_or("");
    let budget = match reason {
        "node_budget" => Some((
            "vertices",
            "nodeCount",
            store::drive_maximum_nodes(),
            "VIGO_DRIVE_ACCELERATOR_MAX_NODES",
        )),
        "edge_budget" => Some((
            "edges",
            "edgeCount",
            store::drive_maximum_edges(),
            "VIGO_DRIVE_ACCELERATOR_MAX_EDGES",
        )),
        _ => None,
    };
    match budget {
        Some((unit, count, limit, variable)) => format!(
            "{reason}: the driving network has {} {unit}, above the limit of {}. Raise {variable}, or build with --street-modes walk or walk,bike to omit driving.",
            jsrt::grouped(preparation.get(count).and_then(Js::as_f64).unwrap_or(0.0)),
            jsrt::grouped(limit)
        ),
        None => preparation
            .get("error")
            .and_then(Js::as_str)
            .map_or_else(|| reason.to_owned(), str::to_owned),
    }
}

fn identity_matches(header: &serde_json::Value, metadata: &Metadata) -> bool {
    let Js::Object(expected) = accelerator::walk_identity(metadata) else {
        return false;
    };
    expected.iter().all(|(key, value)| {
        header
            .get("identity")
            .and_then(|identity| identity.get(key))
            .map(Js::from)
            .is_some_and(|actual| actual == *value)
    })
}

/// `compactNationalOsmRuntimeStore(path, { requireDrive })`. `native` builds
/// the drive CCH from the persisted snapshot before the source graph is dropped.
pub fn compact_runtime_store(
    path: &Path,
    require_drive: bool,
    native: Option<NativeDrive>,
) -> Result<Js> {
    let before_bytes = std::fs::metadata(path)?.len() as f64;
    let metadata = {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let metadata = accelerator::read_metadata(&db)?;
        if metadata
            .get("storageLayout")
            .and_then(serde_json::Value::as_str)
            == Some(RUNTIME_LAYOUT)
        {
            store::admit_version(path, &metadata)?;
            return Ok(Js::object()
                .with("ready", true)
                .with("built", false)
                .with("storageLayout", RUNTIME_LAYOUT)
                .with("beforeBytes", before_bytes)
                .with("afterBytes", before_bytes)
                .with("bytesSaved", 0)
                .with(
                    "drive",
                    Js::object().with("ready", true).with("source", "snapshot"),
                ));
        }
        store::admit_source(&db, path, &metadata)?;
        metadata
    };
    let walk = accelerator::walk_snapshot_path(path);
    let verified = (|| -> std::result::Result<(), String> {
        let size = std::fs::metadata(&walk)
            .map_err(|error| error.to_string())?
            .len() as f64;
        let header = accelerator::read_header(&walk).map_err(|error| error.to_string())?;
        if header.get("magic").and_then(|v| v.as_str()) != Some(accelerator::WALK_SNAPSHOT_MAGIC)
            || header.get("version").and_then(|v| v.as_f64())
                != Some(accelerator::WALK_SNAPSHOT_VERSION)
            || header.get("byteLength").and_then(|v| v.as_f64()) != Some(size)
            || !identity_matches(&header, &metadata)
        {
            return Err("snapshot does not match the source graph".to_owned());
        }
        Ok(())
    })();
    if let Err(message) = verified {
        return Err(Error::new(format!(
            "Cannot seal street store: pedestrian accelerator is not persisted ({message}). Source graph retained at {}; rerun street preparation before sealing.",
            path.display()
        )));
    }
    let mut drive_preparation = None;
    if number(&metadata, "driveEdgeCount") > 0.0 {
        let preparation = drive_profile(path, true, native)?;
        if preparation.get("ready") != Some(&Js::Bool(true)) && require_drive {
            return Err(Error::new(format!(
                "Drive snapshot could not be prepared before OSM compaction: {}",
                drive_budget_detail(&preparation)
            )));
        }
        drive_preparation = Some(preparation);
    }
    let db = Connection::open(path)?;
    db.execute_batch("BEGIN IMMEDIATE")?;
    let sealed = (|| -> Result<()> {
        db.execute_batch(
            "
      DROP INDEX IF EXISTS walk_nodes_lat_lon;
      DROP INDEX IF EXISTS edges_from;
      DROP INDEX IF EXISTS drive_edges_from;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS drive_edges;
      DROP TABLE IF EXISTS walk_nodes;
      DROP TABLE IF EXISTS drive_nodes;
      DROP TABLE IF EXISTS nodes;
    ",
        )?;
        let mut set = db.prepare(
            "
      INSERT INTO metadata(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    ",
        )?;
        let has_drive = drive_preparation.is_some();
        set.execute(params![
            "storageLayout",
            Js::from(RUNTIME_LAYOUT).stringify()
        ])?;
        set.execute(params![
            "driveIndexState",
            Js::from(if has_drive {
                "snapshot"
            } else {
                "not_prepared"
            })
            .stringify()
        ])?;
        set.execute(params![
            "driveNodeStorage",
            Js::from("snapshot-only-v1").stringify()
        ])?;
        set.execute(params![
            "driveCchPersistence",
            Js::from("persisted").stringify()
        ])?;
        let versions = Js::object()
            .with("walk", accelerator::WALK_SNAPSHOT_VERSION)
            .with(
                "drive",
                if has_drive {
                    Js::Number(accelerator::DRIVE_SNAPSHOT_VERSION)
                } else {
                    Js::Null
                },
            );
        set.execute(params!["runtimeSnapshotVersion", versions.stringify()])?;
        Ok(())
    })();
    if let Err(error) = sealed {
        let _ = db.execute_batch("ROLLBACK");
        return Err(error);
    }
    db.execute_batch("COMMIT")?;
    db.execute_batch("VACUUM")?;
    drop(db);
    let after_bytes = std::fs::metadata(path)?.len() as f64;
    Ok(Js::object()
        .with("ready", true)
        .with("built", true)
        .with("storageLayout", RUNTIME_LAYOUT)
        .with("beforeBytes", before_bytes)
        .with("afterBytes", after_bytes)
        .with("bytesSaved", before_bytes - after_bytes)
        .with(
            "drive",
            drive_preparation.unwrap_or_else(|| {
                Js::object()
                    .with("ready", false)
                    .with("reason", "no_drive_edges")
            }),
        ))
}
