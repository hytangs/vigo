//! Static routing topology sidecars (`<store>.static-topology.sqlite`).

use super::metadata::{
    STATIC_TOPOLOGY_SOURCE_IDENTITY_VERSION, admit_transfer_semantics, metadata_record,
    read_store_metadata, sqlite_store_generation, static_topology_source_fingerprint,
    static_topology_source_identity, storage_identity,
};
use super::policy::{
    TransferCost, station_fallback_seconds, transfer_duration_seconds, walking_model,
};
use super::{BUILD_SQLITE_PAGE_SIZE, Progress, build_sqlite_cache_kib, path_text, report, resolve};
use crate::{Error, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;
use vigo_format::js::Js;

pub const STATIC_TOPOLOGY_SCHEMA_VERSION: &str = "vigo.routing.static-topology.v4";
const MINIMUM_FREE_BYTES: f64 = 2.0 * 1024.0 * 1024.0 * 1024.0;
const RESERVE_FLOOR_BYTES: f64 = 128.0 * 1024.0 * 1024.0;
const TRANSIENT_WORKSPACE_BYTES: f64 = 64.0 * 1024.0 * 1024.0;

pub fn static_topology_sidecar_path(store: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.static-topology.sqlite",
        path_text(&resolve(store))
    ))
}

fn adaptive_reserve_bytes(source_bytes: f64) -> f64 {
    RESERVE_FLOOR_BYTES
        .max(MINIMUM_FREE_BYTES)
        .min(RESERVE_FLOOR_BYTES.max(source_bytes * 2.0 + RESERVE_FLOOR_BYTES))
}

#[cfg(unix)]
fn free_bytes(directory: &Path) -> Result<f64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(directory.as_os_str().as_bytes())
        .map_err(|e| Error::new(e.to_string()))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a NUL-terminated path and a writable statvfs record.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(stat.f_bavail as f64 * stat.f_frsize as f64)
}

#[cfg(not(unix))]
fn free_bytes(_directory: &Path) -> Result<f64> {
    Ok(f64::MAX)
}

fn environment_bytes(name: &str, fallback: f64) -> f64 {
    let number = std::env::var(name)
        .map_or(fallback, |text| crate::jsval::to_number(&text))
        .floor();
    if number.is_nan() { 0.0 } else { number }
}

fn table_present(db: &Connection, sql: &str) -> Result<bool> {
    Ok(db.query_row(sql, [], |_| Ok(())).optional()?.is_some())
}

/// `inspectNationalStaticTopologySidecar(storePath, sidecarPath)`.
pub fn inspect_static_topology_sidecar(store: &Path, sidecar: Option<&Path>) -> Result<Js> {
    let sidecar = sidecar.map_or_else(|| static_topology_sidecar_path(store), resolve);
    let not_ready = |reason: &str| {
        Js::object()
            .with("ready", false)
            .with("reason", reason)
            .with("version", STATIC_TOPOLOGY_SCHEMA_VERSION)
            .with("sidecarPath", path_text(&sidecar))
    };
    if !sidecar.exists() {
        return Ok(not_ready("sidecar_absent"));
    }
    let source = Connection::open_with_flags(store, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let target = Connection::open_with_flags(&sidecar, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let source_metadata = metadata_record(&source)?;
    let fingerprint = static_topology_source_fingerprint(&source_metadata);
    let source_storage = storage_identity(store);
    let generation = sqlite_store_generation(store)?;
    let metadata = metadata_record(&target)?;
    if !table_present(
        &target,
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='static_topology_edges'",
    )? {
        return Ok(not_ready("table_absent"));
    }
    if !table_present(
        &target,
        "SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='static_topology_edges_to'",
    )? {
        return Ok(not_ready("reverse_index_absent"));
    }
    if metadata.get("staticTopologyVersion").and_then(Js::as_str)
        != Some(STATIC_TOPOLOGY_SCHEMA_VERSION)
    {
        let mut result = Js::object()
            .with("ready", false)
            .with("reason", "version_mismatch");
        if let Some(version) = metadata.get("staticTopologyVersion") {
            result.set("version", version.clone());
        }
        return Ok(result
            .with("expectedVersion", STATIC_TOPOLOGY_SCHEMA_VERSION)
            .with("sidecarPath", path_text(&sidecar)));
    }
    let identity_matches = metadata
        .get("staticTopologySourceIdentity")
        .and_then(Js::as_str)
        == Some(static_topology_source_identity(&source_metadata).as_str())
        && metadata
            .get("staticTopologySourceGeneration")
            .and_then(Js::as_str)
            == Some(generation.as_str());
    if !identity_matches {
        return Ok(not_ready("source_mismatch"));
    }
    let edge_count = match metadata.get("staticTopologyEdgeCount") {
        Some(Js::Number(n)) => *n,
        _ => 0.0,
    };
    let mut result = Js::object()
        .with("ready", true)
        .with("reason", "ready")
        .with("version", STATIC_TOPOLOGY_SCHEMA_VERSION)
        .with("edgeCount", edge_count);
    if let Some(built) = metadata.get("staticTopologyBuiltAt") {
        result.set("builtAt", built.clone());
    }
    Ok(result
        .with("sidecarPath", path_text(&sidecar))
        .with("sourceFingerprint", fingerprint)
        .with("sourceStorageIdentity", source_storage))
}

/// stop_id, parent_station, lat, lon.
type StopRow = (String, Option<String>, Option<f64>, Option<f64>);

struct Counts {
    scheduled_rows: f64,
    scheduled_edges: f64,
    bridge_count: f64,
    transfer_count: f64,
    station_sibling_count: f64,
}

fn populate(
    source: &Connection,
    target: &Connection,
    expected: f64,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Counts> {
    let mut insert = target.prepare(
        "INSERT INTO static_topology_edges(from_stop_id, to_stop_id, min_duration) VALUES(?, ?, ?)
      ON CONFLICT(from_stop_id, to_stop_id) DO UPDATE SET
        min_duration=MIN(static_topology_edges.min_duration, excluded.min_duration)",
    )?;
    let mut upsert = |from: &str, to: &str, duration: f64| -> Result<()> {
        insert.execute(params![from, to, duration])?;
        Ok(())
    };
    let mut counts = Counts {
        scheduled_rows: 0.0,
        scheduled_edges: 0.0,
        bridge_count: 0.0,
        transfer_count: 0.0,
        station_sibling_count: 0.0,
    };
    let mut next_progress = 1_000_000.0;
    {
        let mut statement = source.prepare(
            "SELECT from_stop_id, to_stop_id, MIN(arrival - departure) AS min_duration, COUNT(*) AS connection_count
    FROM connections WHERE from_stop_id != to_stop_id AND arrival >= departure GROUP BY from_stop_id, to_stop_id",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let from: String = row.get(0)?;
            let to: String = row.get(1)?;
            let duration: f64 = row.get(2)?;
            let count: f64 = row.get(3)?;
            upsert(&from, &to, duration)?;
            counts.scheduled_edges += 1.0;
            counts.scheduled_rows += count;
            if counts.scheduled_rows >= next_progress {
                report(
                    progress,
                    "Building static routing topology",
                    0.02 + (counts.scheduled_rows / expected.max(1.0) * 0.6).min(0.6),
                    &format!(
                        "{} scheduled connections",
                        vigo_format::js::grouped(counts.scheduled_rows as i64)
                    ),
                );
                next_progress = counts.scheduled_rows + 1_000_000.0;
            }
        }
    }
    report(
        progress,
        "Building static routing topology",
        0.64,
        "Validating interpolated stop-time gaps",
    );
    {
        let mut statement = source.prepare(
            "SELECT previous_to_stop_id, from_stop_id, departure - previous_arrival AS duration
    FROM (
      SELECT from_stop_id, departure, stop_sequence, route_id, service_id,
        LAG(to_stop_id) OVER trip_order AS previous_to_stop_id,
        LAG(arrival) OVER trip_order AS previous_arrival,
        LAG(stop_sequence) OVER trip_order AS previous_sequence,
        LAG(route_id) OVER trip_order AS previous_route_id,
        LAG(service_id) OVER trip_order AS previous_service_id
      FROM connections
      WINDOW trip_order AS (PARTITION BY trip_id ORDER BY stop_sequence)
    )
    WHERE previous_to_stop_id != from_stop_id
      AND stop_sequence - previous_sequence > 1
      AND route_id = previous_route_id AND service_id = previous_service_id
      AND departure >= previous_arrival",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let from: String = row.get(0)?;
            let to: String = row.get(1)?;
            let duration: f64 = row.get(2)?;
            upsert(&from, &to, duration)?;
            counts.bridge_count += 1.0;
        }
    }
    report(
        progress,
        "Building static routing topology",
        0.78,
        "Transfers and station members",
    );
    {
        let mut statement = source.prepare(
            "SELECT transfer.from_stop_id, transfer.to_stop_id,
      transfer.min_transfer_time, provenance.provenance, provenance.path_distance_m
    FROM transfers AS transfer
    JOIN transfer_provenance AS provenance
      ON provenance.from_stop_id=transfer.from_stop_id
      AND provenance.to_stop_id=transfer.to_stop_id
    WHERE COALESCE(transfer.transfer_type, 0) != 3
      AND transfer.from_stop_id != transfer.to_stop_id",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let from: String = row.get(0)?;
            let to: String = row.get(1)?;
            let minimum: Option<f64> = row.get(2)?;
            let provenance: Option<String> = row.get(3)?;
            let distance: Option<f64> = row.get(4)?;
            let cost = TransferCost {
                provenance: provenance.as_deref(),
                min_transfer_time: minimum,
                path_distance_m: distance,
            };
            let Some(duration) = transfer_duration_seconds(&cost) else {
                continue;
            };
            upsert(&from, &to, duration)?;
            counts.transfer_count += 1.0;
        }
    }
    let mut stops: Vec<StopRow> = Vec::new();
    {
        let mut statement =
            source.prepare("SELECT stop_id, parent_station, lat, lon FROM stops")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            stops.push((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?));
        }
    }
    let coordinates: HashMap<&str, (f64, f64)> = stops
        .iter()
        .map(|(id, _, lat, lon)| (id.as_str(), (lon.unwrap_or(0.0), lat.unwrap_or(0.0))))
        .collect();
    let stop_ids: HashSet<&str> = stops.iter().map(|(id, ..)| id.as_str()).collect();
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    for (id, parent, ..) in &stops {
        let group = crate::jsval::trim(parent.as_deref().unwrap_or("")).to_owned();
        if group.is_empty() {
            continue;
        }
        let index = *group_index.entry(group.clone()).or_insert_with(|| {
            groups.push((group.clone(), Vec::new()));
            groups.len() - 1
        });
        if !groups[index].1.contains(id) {
            groups[index].1.push(id.clone());
        }
    }
    let speed = walking_model().speed_kph;
    for (group, mut members) in groups {
        if stop_ids.contains(group.as_str()) && !members.contains(&group) {
            members.push(group.clone());
        }
        for from in &members {
            for to in &members {
                if from == to {
                    continue;
                }
                let seconds = station_fallback_seconds(
                    coordinates[from.as_str()],
                    coordinates[to.as_str()],
                    speed,
                );
                upsert(from, to, seconds)?;
                counts.station_sibling_count += 1.0;
            }
        }
    }
    Ok(counts)
}

/// `buildNationalStaticTopologySidecar({ storePath, outputPath, minimumFreeBytes, force })`.
pub fn build_static_topology_sidecar(
    store: &Path,
    output: &Path,
    progress: &mut dyn FnMut(&Progress),
    minimum_free_bytes: Option<f64>,
    force: bool,
) -> Result<Js> {
    let store = resolve(store);
    let output = resolve(output);
    read_store_metadata(&store)?;
    let before = inspect_static_topology_sidecar(&store, Some(&output))?;
    if before.get("ready") == Some(&Js::Bool(true)) && !force {
        let mut result = before;
        result
            .set("built", false)
            .set("sourceStorePath", path_text(&store))
            .set("outputPath", path_text(&output))
            .set("bytes", std::fs::metadata(&output)?.len());
        return Ok(result);
    }
    let temp = PathBuf::from(format!("{}.building", path_text(&output)));
    let parent = output.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let source_bytes = std::fs::metadata(&store)?.len() as f64;
    let free_before = free_bytes(parent)?;
    let reserved = match minimum_free_bytes {
        None => adaptive_reserve_bytes(source_bytes),
        Some(bytes) => RESERVE_FLOOR_BYTES.max(if bytes.is_finite() {
            bytes
        } else {
            MINIMUM_FREE_BYTES
        }),
    };
    if free_before <= reserved + TRANSIENT_WORKSPACE_BYTES {
        return Err(Error::new(format!(
            "Static-topology sidecar requires at least {} MB free; only {} MB is available.",
            ((reserved + TRANSIENT_WORKSPACE_BYTES) / 1024.0 / 1024.0).ceil(),
            (free_before / 1024.0 / 1024.0).floor()
        )));
    }
    super::remove_file(&temp);
    let started = Instant::now();
    let outcome = (|| -> Result<Js> {
        let source = Connection::open_with_flags(&store, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let target = Connection::open(&temp)?;
        let mmap = environment_bytes("VIGO_READONLY_SQLITE_MMAP_BYTES", 0.0)
            .clamp(0.0, 2.0 * 1024.0 * 1024.0 * 1024.0);
        let cache = environment_bytes("VIGO_READONLY_SQLITE_CACHE_KIB", 16.0 * 1024.0)
            .clamp(4.0 * 1024.0, 256.0 * 1024.0);
        source.execute_batch(&format!(
            "PRAGMA query_only=ON; PRAGMA temp_store=FILE; PRAGMA mmap_size={mmap}; PRAGMA cache_size=-{cache};"
        ))?;
        let source_storage = storage_identity(&store);
        source.execute_batch("BEGIN")?;
        let source_metadata = metadata_record(&source)?;
        admit_transfer_semantics(&source, &store, &source_metadata)?;
        let fingerprint = static_topology_source_fingerprint(&source_metadata);
        target.execute_batch(&format!("PRAGMA page_size={BUILD_SQLITE_PAGE_SIZE}"))?;
        let page_size: f64 = target.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let guarded_pages = 1f64.max(((free_before - reserved) / page_size).floor());
        target.execute_batch(&format!(
            "
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-{};
      PRAGMA max_page_count={};
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE static_topology_edges(
        from_stop_id TEXT NOT NULL,
        to_stop_id TEXT NOT NULL,
        min_duration INTEGER NOT NULL CHECK(min_duration >= 0),
        PRIMARY KEY(from_stop_id, to_stop_id)
      ) WITHOUT ROWID;
      CREATE INDEX static_topology_edges_to ON static_topology_edges(to_stop_id, from_stop_id, min_duration);
      BEGIN IMMEDIATE;
    ",
            build_sqlite_cache_kib(),
            guarded_pages as u64
        ))?;
        let expected = match source_metadata.get("connectionCount") {
            Some(Js::Number(n)) => *n,
            Some(Js::String(s)) => crate::jsval::to_number(s),
            _ => 1.0,
        };
        let counts = populate(
            &source,
            &target,
            if expected.is_nan() {
                f64::NAN
            } else {
                expected.max(1.0)
            },
            progress,
        )?;
        if storage_identity(&store) != source_storage {
            return Err(Error::new(
                "Routing store changed while its static-topology snapshot was being built; retry against a stable store.",
            ));
        }
        source.execute_batch("COMMIT")?;
        drop(source);
        if storage_identity(&store) != source_storage {
            return Err(Error::new(
                "Routing store changed before the static-topology sidecar could be sealed; retry against a stable store.",
            ));
        }
        let edge_count: f64 = target.query_row(
            "SELECT COUNT(*) AS count FROM static_topology_edges",
            [],
            |row| row.get(0),
        )?;
        let built_at = super::iso_now();
        let connection_count = match source_metadata.get("connectionCount") {
            None | Some(Js::Null) => counts.scheduled_rows,
            Some(Js::Number(n)) => *n,
            Some(Js::String(s)) => crate::jsval::to_number(s),
            Some(_) => f64::NAN,
        };
        let values = Js::object()
            .with("staticTopologyVersion", STATIC_TOPOLOGY_SCHEMA_VERSION)
            .with("staticTopologySourceFingerprint", fingerprint.clone())
            .with(
                "staticTopologySourceIdentityVersion",
                STATIC_TOPOLOGY_SOURCE_IDENTITY_VERSION,
            )
            .with(
                "staticTopologySourceIdentity",
                static_topology_source_identity(&source_metadata),
            )
            .with(
                "staticTopologySourceGeneration",
                sqlite_store_generation(&store)?,
            )
            .with(
                "staticTopologySourceStorageIdentity",
                source_storage.clone(),
            )
            .with("staticTopologyEdgeCount", edge_count)
            .with("staticTopologyBuiltAt", built_at.clone())
            .with(
                "sourceStoreId",
                source_metadata.get("storeId").cloned().unwrap_or(Js::Null),
            )
            .with("sourceConnectionCount", connection_count);
        super::write_metadata(
            &target,
            "INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)",
            &values,
        )?;
        target.execute_batch("COMMIT; PRAGMA optimize;")?;
        drop(target);
        std::fs::rename(&temp, &output)?;
        report(
            progress,
            "Static routing topology sidecar ready",
            1.0,
            &format!("{} edges", vigo_format::js::grouped(edge_count as i64)),
        );
        Ok(Js::object()
            .with("ready", true)
            .with("reason", "ready")
            .with("version", STATIC_TOPOLOGY_SCHEMA_VERSION)
            .with("built", true)
            .with("builtAt", built_at)
            .with("edgeCount", edge_count)
            .with("sourceFingerprint", fingerprint)
            .with("sourceStorageIdentity", source_storage)
            .with("sourceStorePath", path_text(&store))
            .with("outputPath", path_text(&output))
            .with(
                "buildSeconds",
                (started.elapsed().as_secs_f64() * 1000.0).round() / 1000.0,
            )
            .with("bytes", std::fs::metadata(&output)?.len())
            .with("freeBytesBefore", free_before)
            .with("minimumFreeBytes", reserved)
            .with("scheduledRows", counts.scheduled_rows)
            .with("scheduledEdges", counts.scheduled_edges)
            .with("bridgeCount", counts.bridge_count)
            .with("transferCount", counts.transfer_count)
            .with("stationSiblingCount", counts.station_sibling_count))
    })();
    if outcome.is_err() {
        super::remove_file(&temp);
    }
    outcome
}

/// The sidecar staged beside an unpublished store (`buildDefaultStaticTopologySidecar`).
pub(crate) struct StagedTopology {
    pub result: Js,
    pub staged: PathBuf,
    pub output: PathBuf,
}

pub(crate) fn build_default_sidecar(
    temp_store: &Path,
    output_store: &Path,
    progress: &mut dyn FnMut(&Progress),
) -> Result<StagedTopology> {
    let output = static_topology_sidecar_path(output_store);
    let staged = PathBuf::from(format!("{}.next", path_text(&output)));
    let source_bytes = std::fs::metadata(temp_store)?.len() as f64;
    super::remove_file(&staged);
    super::remove_file(Path::new(&format!("{}.building", path_text(&staged))));
    let mut scaled = |event: &Progress| {
        progress(&Progress {
            phase: event.phase.clone(),
            progress: 0.91 + event.progress.clamp(0.0, 1.0) * 0.08,
            detail: event.detail.clone(),
            work: event.work,
        })
    };
    let result = build_static_topology_sidecar(
        temp_store,
        &staged,
        &mut scaled,
        Some(adaptive_reserve_bytes(source_bytes)),
        false,
    )?;
    Ok(StagedTopology {
        result,
        staged,
        output,
    })
}

/// `publishRoutingStoreWithSidecar`: publish the sidecar, then the store.
pub(crate) fn publish_with_sidecar(
    temp_store: &Path,
    output_store: &Path,
    topology: StagedTopology,
) -> Result<Js> {
    let backup = PathBuf::from(format!("{}.previous", path_text(&topology.output)));
    let had_previous = topology.output.exists();
    super::remove_file(&backup);
    if had_previous {
        std::fs::rename(&topology.output, &backup)?;
    }
    let mut published = false;
    let outcome = (|| -> Result<()> {
        std::fs::rename(&topology.staged, &topology.output)?;
        published = true;
        std::fs::rename(temp_store, output_store)?;
        Ok(())
    })();
    if let Err(error) = outcome {
        if published {
            super::remove_file(&topology.output);
        }
        if had_previous && backup.exists() {
            std::fs::rename(&backup, &topology.output)?;
        }
        return Err(error);
    }
    super::remove_file(&backup);
    let mut result = topology.result;
    result.set("outputPath", path_text(&topology.output));
    Ok(result)
}
