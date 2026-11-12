//! Runtime street snapshots: the pedestrian accelerator (v7) and the driving
//! accelerator (v2), byte-compatible with the JavaScript writers.

use crate::jsrt;
use crate::{Error, Result};
use rusqlite::Connection;
use std::io::Write;
use std::path::{Path, PathBuf};
use vigo_format::js::Js;

pub const WALK_SNAPSHOT_VERSION: f64 = 7.0;
pub const WALK_SNAPSHOT_MAGIC: &str = "vigo.street.accelerator";
pub const WALK_SNAPSHOT_SUFFIX: &str = ".street-accelerator-v7.bin";
pub const DRIVE_SNAPSHOT_VERSION: f64 = 2.0;
pub const DRIVE_SNAPSHOT_MAGIC: &str = "vigo.drive.accelerator";
pub const DRIVE_SNAPSHOT_SUFFIX: &str = ".drive-accelerator-v2.bin";
pub const HEADER_BYTES: usize = 4096;
const SPATIAL_CELL_DEGREES: f64 = 0.002;
const MAXIMUM_SPATIAL_CELLS: f64 = 4_000_000.0;

pub fn walk_snapshot_path(store: &Path) -> PathBuf {
    PathBuf::from(format!("{}{WALK_SNAPSHOT_SUFFIX}", store.display()))
}

pub fn drive_snapshot_path(store: &Path) -> PathBuf {
    PathBuf::from(format!("{}{DRIVE_SNAPSHOT_SUFFIX}", store.display()))
}

/// Store metadata as parsed JSON values, the `state.metadata` of the JavaScript store.
pub type Metadata = serde_json::Map<String, serde_json::Value>;

pub fn read_metadata(db: &Connection) -> Result<Metadata> {
    let mut statement = db.prepare("SELECT key, value FROM metadata")?;
    let mut rows = statement.query([])?;
    let mut metadata = Metadata::new();
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let value: String = row.get(1)?;
        let parsed = serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value));
        metadata.insert(key, parsed);
    }
    Ok(metadata)
}

fn field(metadata: &Metadata, key: &str) -> Js {
    metadata.get(key).map_or(Js::Null, Js::from)
}

pub fn walk_identity(metadata: &Metadata) -> Js {
    let mut identity = Js::object().with("identityVersion", "source-metadata-v1");
    // `...(metadata.accessibility ? { accessibility: metadata.accessibility.profile } : {})`;
    // an undefined profile is omitted by JSON.stringify.
    if let Some(accessibility) = metadata.get("accessibility").filter(|value| truthy(value))
        && let Some(profile) = accessibility.get("profile")
    {
        identity.set("accessibility", Js::from(profile));
    }
    identity
        .with("schemaVersion", field(metadata, "schemaVersion"))
        .with("sourceFingerprint", field(metadata, "sourceFingerprint"))
        .with("sourceBytes", field(metadata, "sourceBytes"))
        .with("metadataNodeCount", field(metadata, "nodeCount"))
        .with("metadataEdgeCount", field(metadata, "edgeCount"))
}

/// JavaScript truthiness of a parsed JSON value.
pub fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(v) => *v,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn drive_identity(metadata: &Metadata) -> Js {
    Js::object()
        .with("identityVersion", "source-metadata-v1")
        .with("schemaVersion", field(metadata, "schemaVersion"))
        .with("sourceFingerprint", field(metadata, "sourceFingerprint"))
        .with("driveNodeCount", field(metadata, "driveNodeCount"))
        .with("driveEdgeCount", field(metadata, "driveEdgeCount"))
        .with("drivingWeightModel", field(metadata, "drivingWeightModel"))
}

struct Spatial {
    min_lat: f64,
    min_lon: f64,
    cell_degrees: f64,
    rows: f64,
    columns: f64,
    offsets: Vec<u32>,
    node_indices: Vec<u32>,
}

/// Nodes bucketed into a grid of `SPATIAL_CELL_DEGREES` cells.
fn spatial_index(lats: &[f64], lons: &[f64]) -> Spatial {
    if lats.is_empty() {
        return Spatial {
            min_lat: 0.0,
            min_lon: 0.0,
            cell_degrees: SPATIAL_CELL_DEGREES,
            rows: 1.0,
            columns: 1.0,
            offsets: vec![0, 0],
            node_indices: Vec::new(),
        };
    }
    let (mut min_lat, mut max_lat, mut min_lon, mut max_lon) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for i in 0..lats.len() {
        min_lat = jsrt::min(min_lat, lats[i]);
        max_lat = jsrt::max(max_lat, lats[i]);
        min_lon = jsrt::min(min_lon, lons[i]);
        max_lon = jsrt::max(max_lon, lons[i]);
    }
    let base_rows = jsrt::max(
        1.0,
        ((max_lat - min_lat) / SPATIAL_CELL_DEGREES).floor() + 1.0,
    );
    let base_columns = jsrt::max(
        1.0,
        ((max_lon - min_lon) / SPATIAL_CELL_DEGREES).floor() + 1.0,
    );
    let scale = jsrt::max(
        1.0,
        ((base_rows * base_columns) / MAXIMUM_SPATIAL_CELLS)
            .sqrt()
            .ceil(),
    );
    let cell_degrees = SPATIAL_CELL_DEGREES * scale;
    let rows = jsrt::max(1.0, ((max_lat - min_lat) / cell_degrees).floor() + 1.0);
    let columns = jsrt::max(1.0, ((max_lon - min_lon) / cell_degrees).floor() + 1.0);
    let cell = |i: usize| -> usize {
        let row = jsrt::min(
            rows - 1.0,
            jsrt::max(0.0, ((lats[i] - min_lat) / cell_degrees).floor()),
        );
        let column = jsrt::min(
            columns - 1.0,
            jsrt::max(0.0, ((lons[i] - min_lon) / cell_degrees).floor()),
        );
        (row * columns + column) as usize
    };
    let cell_count = (rows * columns) as usize;
    let mut offsets = vec![0u32; cell_count + 1];
    let cells: Vec<usize> = (0..lats.len()).map(cell).collect();
    for &c in &cells {
        offsets[c + 1] = offsets[c + 1].wrapping_add(1);
    }
    for c in 1..offsets.len() {
        offsets[c] = offsets[c].wrapping_add(offsets[c - 1]);
    }
    let mut cursors = offsets[..cell_count].to_vec();
    let mut node_indices = vec![0u32; lats.len()];
    for (i, &c) in cells.iter().enumerate() {
        node_indices[cursors[c] as usize] = i as u32;
        cursors[c] += 1;
    }
    Spatial {
        min_lat,
        min_lon,
        cell_degrees,
        rows,
        columns,
        offsets,
        node_indices,
    }
}

/// A typed column in a snapshot, written little-endian at an aligned offset.
enum Column<'a> {
    F64(&'a [f64]),
    U32(&'a [u32]),
    I32(&'a [i32]),
    U8(&'a [u8]),
}

impl Column<'_> {
    fn kind(&self) -> (&'static str, usize, usize) {
        match self {
            Column::F64(v) => ("Float64Array", 8, v.len()),
            Column::U32(v) => ("Uint32Array", 4, v.len()),
            Column::I32(v) => ("Int32Array", 4, v.len()),
            Column::U8(v) => ("Uint8Array", 1, v.len()),
        }
    }

    fn write(&self, out: &mut Vec<u8>) {
        match self {
            Column::F64(v) => v
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Column::U32(v) => v
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Column::I32(v) => v
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Column::U8(v) => out.extend_from_slice(v),
        }
    }
}

/// Write `header` (padded with spaces) and the columns; returns the byte length.
fn write_snapshot(
    path: &Path,
    header: impl Fn(Js, f64) -> Js,
    columns: &[(&str, Column)],
    label: &str,
) -> Result<()> {
    let mut offset = HEADER_BYTES;
    let mut arrays = Js::object();
    let mut placements = Vec::new();
    for (name, column) in columns {
        let (kind, width, length) = column.kind();
        offset = offset.div_ceil(width) * width;
        arrays.set(
            *name,
            Js::object()
                .with("type", kind)
                .with("offset", offset)
                .with("length", length),
        );
        placements.push(offset);
        offset += width * length;
    }
    let encoded = header(arrays, offset as f64).stringify();
    if encoded.len() > HEADER_BYTES {
        return Err(Error::new(format!(
            "{label} snapshot header exceeds its reserved space."
        )));
    }
    let mut bytes = Vec::with_capacity(offset);
    bytes.extend_from_slice(encoded.as_bytes());
    bytes.resize(HEADER_BYTES, b' ');
    for ((_, column), placement) in columns.iter().zip(placements) {
        bytes.resize(placement, 0);
        column.write(&mut bytes);
    }
    bytes.resize(offset, 0);
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis())
    ));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

/// The outcome of one accelerator build, shaped like the JavaScript result.
pub struct Built {
    pub node_count: f64,
    pub edge_count: f64,
    pub build_ms: f64,
    pub snapshot_write_ms: f64,
}

fn elapsed_ms(started: std::time::Instant) -> f64 {
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    jsrt::string_to_number(&jsrt::to_fixed(ms, 3))
}

/// Sorted `(id, index)` pairs for node-ID lookups.
struct Lookup(Vec<(i64, u32)>);

impl Lookup {
    fn new(ids: &[i64]) -> Self {
        let mut pairs: Vec<(i64, u32)> = ids
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index as u32))
            .collect();
        pairs.sort_unstable();
        Lookup(pairs)
    }

    fn get(&self, id: i64) -> Option<u32> {
        self.0
            .binary_search_by_key(&id, |pair| pair.0)
            .ok()
            .map(|position| self.0[position].1)
    }
}

/// Build and persist the pedestrian snapshot, and join bicycle nodes to it.
// Index loops follow the JavaScript CSR passes they reproduce.
#[allow(clippy::needless_range_loop)]
pub fn build_walk(store: &Path, db: &Connection, metadata: &Metadata) -> Result<Built> {
    let started = std::time::Instant::now();
    let node_count: i64 = db.query_row("SELECT COUNT(*) AS count FROM walk_nodes", [], |row| {
        row.get(0)
    })?;
    let metadata_edges = metadata
        .get("edgeCount")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    let expected_edges = if metadata_edges != 0.0 {
        metadata_edges
    } else {
        db.query_row("SELECT COUNT(*) AS count FROM edges", [], |row| {
            row.get::<_, i64>(0)
        })? as f64
    };
    let node_count = node_count as usize;
    let mut source_ids = Vec::with_capacity(node_count);
    let mut source_lats = Vec::with_capacity(node_count);
    let mut source_lons = Vec::with_capacity(node_count);
    {
        let mut statement =
            db.prepare("SELECT node_id,lat,lon FROM walk_nodes ORDER BY node_id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            source_ids.push(row.get::<_, i64>(0)?);
            source_lats.push(row.get::<_, f64>(1)?);
            source_lons.push(row.get::<_, f64>(2)?);
        }
    }
    if source_ids.len() != node_count {
        return Err(Error::new(format!(
            "Street accelerator read {} of {node_count} walk nodes.",
            source_ids.len()
        )));
    }
    let spatial = spatial_index(&source_lats, &source_lons);
    let order = &spatial.node_indices;
    let node_ids: Vec<i64> = order.iter().map(|&i| source_ids[i as usize]).collect();
    let node_lats: Vec<f64> = order.iter().map(|&i| source_lats[i as usize]).collect();
    let node_lons: Vec<f64> = order.iter().map(|&i| source_lons[i as usize]).collect();
    drop((source_ids, source_lats, source_lons));
    let lookup = Lookup::new(&node_ids);
    // JavaScript reads `ORDER BY from_node,to_node`. Equal pairs carry equal
    // distances (both come from the same two node coordinates), so a Rust
    // sort of the unordered rows yields the same CSR arrays without SQLite's
    // external sort.
    let mut rows: Vec<(i64, i64, f64)> = Vec::new();
    {
        let mut statement = db.prepare("SELECT from_node,to_node,distance_m FROM edges")?;
        let mut cursor = statement.query([])?;
        while let Some(row) = cursor.next()? {
            rows.push((row.get(0)?, row.get(1)?, row.get(2)?));
        }
    }
    rows.sort_unstable_by_key(|row| (row.0, row.1));
    let mut edges: Vec<(u32, u32, f64)> = Vec::with_capacity(rows.len());
    for (from, to, distance) in rows {
        let (Some(from), Some(to)) = (lookup.get(from), lookup.get(to)) else {
            continue;
        };
        edges.push((from, to, distance));
    }
    if edges.len() as f64 > expected_edges {
        return Err(Error::new(
            "Street accelerator edge metadata under-reported the graph size.",
        ));
    }
    let mut edge_offsets = vec![0u32; node_count + 1];
    for &(from, _, _) in &edges {
        edge_offsets[from as usize + 1] += 1;
    }
    for i in 0..node_count {
        edge_offsets[i + 1] += edge_offsets[i];
    }
    let mut edge_targets = vec![0u32; edges.len()];
    let mut edge_distances = vec![0f64; edges.len()];
    let mut cursors = edge_offsets[..node_count].to_vec();
    for &(from, to, distance) in &edges {
        let cursor = cursors[from as usize] as usize;
        edge_targets[cursor] = to;
        edge_distances[cursor] = distance;
        cursors[from as usize] += 1;
    }
    drop(edges);

    // Components with union by rank and path compression.
    let mut parents: Vec<i32> = (0..node_count as i32).collect();
    let mut ranks = vec![0u8; node_count];
    fn find(parents: &mut [i32], mut node: usize) -> usize {
        let mut root = node;
        while parents[root] as usize != root {
            root = parents[root] as usize;
        }
        while parents[node] as usize != node {
            let parent = parents[node] as usize;
            parents[node] = root as i32;
            node = parent;
        }
        root
    }
    for from in 0..node_count {
        for edge in edge_offsets[from] as usize..edge_offsets[from + 1] as usize {
            let mut left = find(&mut parents, from);
            let mut right = find(&mut parents, edge_targets[edge] as usize);
            if left == right {
                continue;
            }
            if ranks[left] < ranks[right] {
                std::mem::swap(&mut left, &mut right);
            }
            parents[right] = left as i32;
            if ranks[left] == ranks[right] {
                ranks[left] = ranks[left].wrapping_add(1);
            }
        }
    }
    let mut component_by_node = vec![0i32; node_count];
    let mut component_by_root: std::collections::HashMap<usize, i32> =
        std::collections::HashMap::new();
    let mut component_length_km: Vec<f64> = Vec::new();
    for node in 0..node_count {
        let root = find(&mut parents, node);
        let component = *component_by_root.entry(root).or_insert_with(|| {
            component_length_km.push(0.0);
            (component_length_km.len() - 1) as i32
        });
        component_by_node[node] = component;
    }
    let mut reciprocal = vec![0u8; edge_targets.len()];
    for from in 0..node_count {
        let component = component_by_node[from] as usize;
        for edge in edge_offsets[from] as usize..edge_offsets[from + 1] as usize {
            let to = edge_targets[edge] as usize;
            if from > to {
                let mut found = false;
                for back in edge_offsets[to] as usize..edge_offsets[to + 1] as usize {
                    if edge_targets[back] as usize == from {
                        reciprocal[back] = 1;
                        found = true;
                    }
                }
                if found {
                    reciprocal[edge] = 1;
                    continue;
                }
            }
            if from == to {
                reciprocal[edge] = 1;
            }
            component_length_km[component] += edge_distances[edge] / 1000.0;
        }
    }
    let component_count = component_length_km.len();

    let mut reverse_offsets = vec![0u32; node_count + 1];
    for &target in &edge_targets {
        reverse_offsets[target as usize + 1] += 1;
    }
    for i in 0..node_count {
        reverse_offsets[i + 1] += reverse_offsets[i];
    }
    let mut reverse_cursors = reverse_offsets[..node_count].to_vec();
    let mut reverse_sources = vec![0u32; edge_targets.len()];
    let mut reverse_edges = vec![0u32; edge_targets.len()];
    for from in 0..node_count {
        for edge in edge_offsets[from] as usize..edge_offsets[from + 1] as usize {
            let target = edge_targets[edge] as usize;
            let cursor = reverse_cursors[target] as usize;
            reverse_sources[cursor] = from as u32;
            reverse_edges[cursor] = edge as u32;
            reverse_cursors[target] += 1;
        }
    }
    let edge_count = edge_targets.len();
    let build_ms = elapsed_ms(started);

    let write_started = std::time::Instant::now();
    let identity = walk_identity(metadata);
    let header = |arrays: Js, byte_length: f64| {
        Js::object()
            .with("magic", WALK_SNAPSHOT_MAGIC)
            .with("version", WALK_SNAPSHOT_VERSION)
            .with("identity", identity.clone())
            .with("nodeCount", node_count)
            .with("edgeCount", edge_count)
            .with("spatialMinLat", spatial.min_lat)
            .with("spatialMinLon", spatial.min_lon)
            .with("spatialCellDegrees", spatial.cell_degrees)
            .with("spatialRows", spatial.rows)
            .with("spatialColumns", spatial.columns)
            .with("spatialNodeOrder", "cell_then_source_node_id")
            .with("componentCount", component_count)
            .with("arrays", arrays)
            .with("byteLength", byte_length)
    };
    let snapshot = walk_snapshot_path(store);
    write_snapshot(
        &snapshot,
        header,
        &[
            ("nodeLats", Column::F64(&node_lats)),
            ("nodeLons", Column::F64(&node_lons)),
            ("edgeOffsets", Column::U32(&edge_offsets)),
            ("edgeTargets", Column::U32(&edge_targets)),
            ("edgeDistances", Column::F64(&edge_distances)),
            ("spatialOffsets", Column::U32(&spatial.offsets)),
            ("componentByNode", Column::I32(&component_by_node)),
            ("componentLengthKm", Column::F64(&component_length_km)),
            ("reverseOffsets", Column::U32(&reverse_offsets)),
            ("reverseSources", Column::U32(&reverse_sources)),
            ("reverseEdgeIndices", Column::U32(&reverse_edges)),
            ("reciprocalEdgeFlags", Column::U8(&reciprocal)),
        ],
        "Street accelerator",
    )?;
    for version in 1..7 {
        let _ = std::fs::remove_file(format!(
            "{}.street-accelerator-v{version}.bin",
            store.display()
        ));
    }
    let snapshot_write_ms = elapsed_ms(write_started);

    let has_bike: bool = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bike_nodes'",
            [],
            |_| Ok(()),
        )
        .map(|_| true)
        .or_else(|error| {
            if error == rusqlite::Error::QueryReturnedNoRows {
                Ok(false)
            } else {
                Err(error)
            }
        })?;
    if has_bike {
        // Preserve source identity across spatial ordering and compaction.
        let link = Connection::open(store)?;
        link.execute_batch("BEGIN")?;
        let result = (|| -> Result<()> {
            link.execute_batch("CREATE TABLE IF NOT EXISTS bike_walk_nodes(bike_node INTEGER PRIMARY KEY,walk_node INTEGER NOT NULL); DELETE FROM bike_walk_nodes;")?;
            {
                let mut insert = link.prepare("INSERT INTO bike_walk_nodes VALUES(?,?)")?;
                let mut statement = link.prepare("SELECT node_id FROM bike_nodes")?;
                let mut rows = statement.query([])?;
                while let Some(row) = rows.next()? {
                    let node: i64 = row.get(0)?;
                    if let Some(walk) = lookup.get(node) {
                        insert.execute(rusqlite::params![node as f64, f64::from(walk)])?;
                    }
                }
            }
            let access = Js::object()
                .with("version", 1)
                .with("snapshotSuffix", WALK_SNAPSHOT_SUFFIX)
                .with("identity", walk_identity(metadata))
                .with("nodeCount", node_count)
                .with("edgeCount", edge_count);
            link.execute(
                "INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)",
                rusqlite::params!["bikeWalkAccess", access.stringify()],
            )?;
            link.execute_batch("COMMIT")?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = link.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
    Ok(Built {
        node_count: node_count as f64,
        edge_count: edge_count as f64,
        build_ms,
        snapshot_write_ms,
    })
}

fn fixed_point(value: f64, units: f64, label: &str) -> Result<u32> {
    let scaled = jsrt::round(value * units);
    if !scaled.is_finite() || !(0.0..4_294_967_295.0).contains(&scaled) {
        return Err(Error::new(format!(
            "{label} exceeds the exact fixed-point drive domain."
        )));
    }
    Ok(scaled as u32)
}

/// Build and persist the driving snapshot.
pub fn build_drive(store: &Path, db: &Connection, metadata: &Metadata) -> Result<Built> {
    let started = std::time::Instant::now();
    let source = "(SELECT node_id,lat,lon FROM walk_nodes UNION ALL SELECT node_id,lat,lon FROM drive_nodes)";
    let node_count = match metadata.get("driveNodeCount").filter(|v| !v.is_null()) {
        Some(value) => value.as_f64().unwrap_or(f64::NAN),
        None => db.query_row(
            &format!("SELECT COUNT(*) AS count FROM {source}"),
            [],
            |row| row.get::<_, i64>(0),
        )? as f64,
    };
    let edge_capacity: i64 =
        db.query_row("SELECT COUNT(*) AS count FROM drive_edges", [], |row| {
            row.get(0)
        })?;
    let mut ids = Vec::new();
    let mut lats = Vec::new();
    let mut lons = Vec::new();
    {
        let mut statement = db.prepare(&format!(
            "SELECT node_id,lat,lon FROM {source} ORDER BY node_id"
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            ids.push(row.get::<_, i64>(0)?);
            lats.push(row.get::<_, f64>(1)?);
            lons.push(row.get::<_, f64>(2)?);
        }
    }
    if ids.len() as f64 != node_count {
        return Err(Error::new(format!(
            "Drive accelerator read {} of {} nodes.",
            ids.len(),
            vigo_format::js::number(node_count)
        )));
    }
    let node_count = ids.len();
    let lookup = Lookup::new(&ids);
    let mut edge_offsets = vec![0u32; node_count + 1];
    let mut targets = Vec::with_capacity(edge_capacity as usize);
    let mut distances = Vec::with_capacity(edge_capacity as usize);
    let mut times = Vec::with_capacity(edge_capacity as usize);
    let mut next_offset = 0usize;
    {
        let mut statement = db.prepare(
            "SELECT from_node,to_node,distance_m,travel_time_s FROM drive_edges ORDER BY from_node",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let (Some(from), Some(to)) = (lookup.get(row.get(0)?), lookup.get(row.get(1)?)) else {
                continue;
            };
            while next_offset <= from as usize {
                edge_offsets[next_offset] = targets.len() as u32;
                next_offset += 1;
            }
            if targets.len() as i64 >= edge_capacity {
                return Err(Error::new(
                    "Drive accelerator edge metadata under-reported the graph size.",
                ));
            }
            targets.push(to);
            distances.push(fixed_point(row.get(2)?, 100.0, "Drive edge distance")?);
            times.push(fixed_point(row.get(3)?, 100.0, "Drive edge travel time")?);
        }
    }
    while next_offset <= node_count {
        edge_offsets[next_offset] = targets.len() as u32;
        next_offset += 1;
    }
    let spatial = spatial_index(&lats, &lons);
    let edge_count = targets.len();
    let build_ms = elapsed_ms(started);
    let write_started = std::time::Instant::now();
    let identity = drive_identity(metadata);
    let header = |arrays: Js, byte_length: f64| {
        Js::object()
            .with("magic", DRIVE_SNAPSHOT_MAGIC)
            .with("version", DRIVE_SNAPSHOT_VERSION)
            .with("identity", identity.clone())
            .with("nodeCount", node_count)
            .with("edgeCount", edge_count)
            .with("spatialMinLat", spatial.min_lat)
            .with("spatialMinLon", spatial.min_lon)
            .with("spatialCellDegrees", spatial.cell_degrees)
            .with("spatialRows", spatial.rows)
            .with("spatialColumns", spatial.columns)
            .with("arrays", arrays)
            .with("byteLength", byte_length)
    };
    write_snapshot(
        &drive_snapshot_path(store),
        header,
        &[
            ("nodeLats", Column::F64(&lats)),
            ("nodeLons", Column::F64(&lons)),
            ("edgeOffsets", Column::U32(&edge_offsets)),
            ("edgeTargets", Column::U32(&targets)),
            ("edgeDistanceUnits", Column::U32(&distances)),
            ("edgeTimeUnits", Column::U32(&times)),
            ("spatialOffsets", Column::U32(&spatial.offsets)),
            ("spatialNodeIndices", Column::U32(&spatial.node_indices)),
        ],
        "Drive accelerator",
    )?;
    Ok(Built {
        node_count: node_count as f64,
        edge_count: edge_count as f64,
        build_ms,
        snapshot_write_ms: elapsed_ms(write_started),
    })
}

/// The first 4096 bytes of a snapshot, trimmed.
pub fn read_header_text(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut header = vec![0u8; HEADER_BYTES];
    file.read_exact(&mut header)
        .map_err(|_| Error::new("truncated snapshot header"))?;
    Ok(jsrt::trim(&String::from_utf8_lossy(&header)).to_owned())
}

/// Read a snapshot's JSON header (the first 4096 bytes, trimmed).
pub fn read_header(path: &Path) -> Result<serde_json::Value> {
    serde_json::from_str(&read_header_text(path)?).map_err(|error| Error::new(error.to_string()))
}
