//! `buildNationalOsmStore`: compile an OSM PBF into the street store, its
//! basemap, place names, bicycle profile and runtime snapshots.

use crate::accelerator::{self, Metadata};
use crate::basemap::BasemapWriter;
use crate::bike::{self, BikeWriter};
use crate::jsrt::{self, grouped};
use crate::pbf::{self, Block, DenseNodes, Handler, Node, Relation, Way};
use crate::rules::{self, WheelchairStreets};
use crate::tags::Tags;
use crate::{Error, Progress, Result, places};
use rusqlite::{Connection, OpenFlags, params};
use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};
use std::path::{Path, PathBuf};
use vigo_format::js::Js;
use vigo_format::js_math;

pub const SCHEMA_VERSION: &str = "vigo.street.store.v6";
pub const RUNTIME_LAYOUT: &str = "runtime-snapshots-v1";
const SOURCE_LAYOUT: &str = "walk-drive-role-tables-v2";
const BUILD_PAGE_SIZE: u32 = 32 * 1024;

fn env_number(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .map(|value| jsrt::string_to_number(&value))
        .filter(|v| *v != 0.0 && !v.is_nan())
}

fn clamp_kib(name: &str, fallback: f64) -> f64 {
    let raw = std::env::var(name)
        .ok()
        .map_or(fallback, |value| jsrt::string_to_number(&value));
    let value = if raw.is_nan() { 0.0 } else { raw.floor() };
    let value = if value == 0.0 { 0.0 } else { value };
    (4.0 * 1024.0f64).max((256.0 * 1024.0f64).min(value))
}

fn build_cache_kib() -> f64 {
    clamp_kib("VIGO_BUILD_SQLITE_CACHE_KIB", 32.0 * 1024.0)
}

pub fn walk_maximum_edges() -> f64 {
    jsrt::max(
        100_000.0,
        env_number("VIGO_STREET_ACCELERATOR_MAX_EDGES").unwrap_or(40_000_000.0),
    )
}

pub fn walk_maximum_store_bytes() -> f64 {
    jsrt::max(
        128.0 * 1024.0 * 1024.0,
        env_number("VIGO_STREET_ACCELERATOR_MAX_STORE_BYTES").unwrap_or(12_000_000_000.0),
    )
}

pub fn drive_maximum_nodes() -> f64 {
    jsrt::max(
        100_000.0,
        env_number("VIGO_DRIVE_ACCELERATOR_MAX_NODES").unwrap_or(40_000_000.0),
    )
}

pub fn drive_maximum_edges() -> f64 {
    jsrt::max(
        250_000.0,
        env_number("VIGO_DRIVE_ACCELERATOR_MAX_EDGES").unwrap_or(20_000_000.0),
    )
}

/// `getNode.get(id)`: `(lat, lon)` of a node imported so far.
pub trait NodeLookup {
    fn get(&self, id: i64) -> Option<(f64, f64)>;
}

/// A multiplicative hash for integer IDs.
#[derive(Default)]
pub struct IdHasher(u64);

impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 =
                (self.0.rotate_left(5) ^ u64::from(*byte)).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    fn write_i64(&mut self, value: i64) {
        self.0 = (value as u64)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .rotate_left(29);
    }
}

pub type IdSet = HashSet<i64, BuildHasherDefault<IdHasher>>;
static EMPTY_IDS: std::sync::LazyLock<IdSet> = std::sync::LazyLock::new(IdSet::default);
pub(crate) type IdMap<V> = std::collections::HashMap<i64, V, BuildHasherDefault<IdHasher>>;

/// The importer's node table, kept in memory. Values are what the SQLite REAL
/// column returned: a negative zero is read back as zero. `INSERT OR REPLACE`
/// keeps the last coordinate for a repeated ID.
#[derive(Default)]
struct NodeStore {
    ids: Vec<i64>,
    coordinates: Vec<(f64, f64)>,
    map: Option<IdMap<(f64, f64)>>,
}

impl NodeStore {
    fn insert(&mut self, id: i64, lat: f64, lon: f64) {
        let value = (lat + 0.0, lon + 0.0);
        if let Some(map) = &mut self.map {
            map.insert(id, value);
            return;
        }
        if self.ids.last().is_none_or(|last| *last < id) {
            self.ids.push(id);
            self.coordinates.push(value);
            return;
        }
        let mut map: IdMap<(f64, f64)> = IdMap::default();
        map.reserve(self.ids.len() * 2);
        for (id, coordinate) in self.ids.drain(..).zip(self.coordinates.drain(..)) {
            map.insert(id, coordinate);
        }
        map.insert(id, value);
        self.map = Some(map);
    }
}

impl NodeLookup for NodeStore {
    fn get(&self, id: i64) -> Option<(f64, f64)> {
        match &self.map {
            Some(map) => map.get(&id).copied(),
            None => self
                .ids
                .binary_search(&id)
                .ok()
                .map(|index| self.coordinates[index]),
        }
    }
}

/// Options of `buildNationalOsmStore`.
#[derive(Clone, Debug)]
pub struct StreetOptions {
    pub include_driving: bool,
    pub include_biking: bool,
    pub flex_driving: bool,
    pub wheelchair: bool,
    pub wheelchair_streets: WheelchairStreets,
    /// Studio prepares the drive snapshot during import.
    pub build_driving_profile: bool,
}

impl Default for StreetOptions {
    fn default() -> Self {
        Self {
            include_driving: true,
            include_biking: false,
            flex_driving: false,
            wheelchair: false,
            wheelchair_streets: WheelchairStreets::Inferred,
            build_driving_profile: std::env::var("VIGO_BUILD_DRIVE_ACCELERATOR").as_deref()
                == Ok("1"),
        }
    }
}

pub(crate) use vigo_format::js::iso_now;

pub(crate) fn elapsed_ms(started: std::time::Instant) -> f64 {
    jsrt::string_to_number(&jsrt::to_fixed(started.elapsed().as_secs_f64() * 1000.0, 3))
}

fn haversine_m(from: (f64, f64), to: (f64, f64)) -> f64 {
    // `haversineKm([lon, lat], [lon, lat]) * 1000`
    js_math::haversine_km(from.1, from.0, to.1, to.0) * 1000.0
}

struct Counters {
    node_count: f64,
    walk_node_count: f64,
    edge_count: f64,
    way_count: f64,
    drive_node_count: f64,
    drive_edge_count: f64,
    drive_way_count: f64,
    direction_restricted: f64,
    direction_excluded: f64,
    uncertain_conveying: f64,
    blocked_segments: f64,
    transaction_rows: usize,
}

struct Rules<'o> {
    options: &'o StreetOptions,
}

impl Rules<'_> {
    fn way_allowed(&self, tags: &Tags, refs: &[i64]) -> bool {
        rules::way_walkable(tags, refs)
            && (!self.options.wheelchair
                || rules::wheelchair_way_allowed(tags, self.options.wheelchair_streets))
    }
    fn platform_allowed(&self, tags: &Tags) -> bool {
        rules::platform_area_walkable(tags)
            && (!self.options.wheelchair
                || rules::wheelchair_way_allowed(tags, self.options.wheelchair_streets))
    }
    fn node_allowed(&self, tags: &Tags) -> bool {
        rules::node_walkable(tags)
            && (!self.options.wheelchair
                || rules::wheelchair_node_allowed(tags, self.options.wheelchair_streets))
    }
}

struct RelationPass<'a> {
    db: &'a Connection,
    basemap: &'a mut BasemapWriter,
}

impl Handler for RelationPass<'_> {
    fn wants_relations(&self) -> bool {
        true
    }
    fn relation(&mut self, block: &Block, relation: Relation) -> Result<()> {
        let tags = Tags::from_keys(block, &relation.keys, &relation.vals)?;
        self.basemap
            .select_relation(self.db, block, &relation, &tags)
    }
}

struct SelectionPass<'a> {
    rules: &'a Rules<'a>,
    basemap: &'a BasemapWriter,
    required: &'a mut IdSet,
}

impl Handler for SelectionPass<'_> {
    fn wants_ways(&self) -> bool {
        true
    }
    fn way(&mut self, block: &Block, way: Way) -> Result<()> {
        let tags = Tags::from_keys(block, &way.keys, &way.vals)?;
        let options = self.rules.options;
        let needed = self.rules.way_allowed(&tags, &way.refs)
            || self.rules.platform_allowed(&tags)
            || (options.include_driving && rules::drivable(&tags))
            || (options.include_biking
                && (bike::directions(&tags).any() || !bike::way_windows(&tags, None)?.is_empty()))
            || self.basemap.needs_way(&way, &tags)
            || places::way_needs_nodes(&way, &tags);
        if needed {
            self.required.extend(way.refs.iter().copied());
        }
        Ok(())
    }
}

struct StreetPass<'a> {
    db: &'a Connection,
    rules: &'a Rules<'a>,
    required: &'a IdSet,
    nodes: NodeStore,
    blocked_walk: IdSet,
    walk_nodes: IdSet,
    drive_nodes: IdSet,
    basemap: &'a mut BasemapWriter,
    bike: Option<&'a mut BikeWriter>,
    counters: Counters,
}

impl StreetPass<'_> {
    fn import_node(
        &mut self,
        block: &Block,
        id: i64,
        tags: Tags,
        lat: i64,
        lon: i64,
    ) -> Result<()> {
        if !self.rules.node_allowed(&tags) {
            self.blocked_walk.insert(id);
        }
        if let Some(bike) = self.bike.as_deref_mut() {
            bike.node(id, &tags)?;
        }
        let (lon, lat) = block.coordinate(lat, lon)?;
        self.nodes.insert(id, lat, lon);
        self.counters.transaction_rows += 1;
        Ok(())
    }

    // The rows are inserted when the JavaScript compiler inserted them: the
    // source store's B-tree layout, and so its size and the reported
    // compaction savings, follow the insert order. A repeated ID is an
    // `INSERT OR IGNORE` no-op and is skipped without a statement.
    fn insert_walk_node(&mut self, id: i64, lat: f64, lon: f64) -> Result<f64> {
        if !self.walk_nodes.insert(id) {
            return Ok(0.0);
        }
        self.db
            .prepare_cached("INSERT OR IGNORE INTO walk_nodes VALUES(?,?,?)")?
            .execute(params![id as f64, lat, lon])?;
        Ok(1.0)
    }

    fn insert_drive_node(&mut self, id: i64, lat: f64, lon: f64) -> Result<f64> {
        if !self.drive_nodes.insert(id) {
            return Ok(0.0);
        }
        self.db
            .prepare_cached("INSERT OR IGNORE INTO drive_nodes VALUES(?,?,?)")?
            .execute(params![id as f64, lat, lon])?;
        Ok(1.0)
    }
}

impl Handler for StreetPass<'_> {
    fn wants_nodes(&self) -> bool {
        true
    }
    fn wants_ways(&self) -> bool {
        true
    }
    fn wants_relations(&self) -> bool {
        true
    }

    fn node(&mut self, block: &Block, node: Node) -> Result<()> {
        if node.id == 0 {
            return Ok(());
        }
        self.counters.node_count += 1.0;
        if self.required.contains(&node.id) {
            let tags = Tags::from_keys(block, &node.keys, &node.vals)?;
            self.import_node(block, node.id, tags, node.lat, node.lon)?;
        }
        Ok(())
    }

    fn dense_nodes(&mut self, block: &Block, dense: DenseNodes) -> Result<()> {
        for index in 0..dense.ids.len() {
            self.counters.node_count += 1.0;
            let id = dense.ids[index];
            if !self.required.contains(&id) {
                continue;
            }
            let tags = Tags::from_dense(block, &dense, index)?;
            self.import_node(block, id, tags, dense.lats[index], dense.lons[index])?;
        }
        Ok(())
    }

    fn relation(&mut self, block: &Block, relation: Relation) -> Result<()> {
        if let Some(bike) = self.bike.as_deref_mut() {
            let tags = Tags::from_keys(block, &relation.keys, &relation.vals)?;
            bike.relation(self.db, block, &relation, &tags)?;
        }
        Ok(())
    }

    fn way(&mut self, block: &Block, way: Way) -> Result<()> {
        let tags = Tags::from_keys(block, &way.keys, &way.vals)?;
        self.basemap.add_way(self.db, &way, &tags, &self.nodes)?;
        places::add_way(self.db, &way, &tags, &self.nodes)?;
        if let Some(bike) = self.bike.as_deref_mut() {
            bike.way(self.db, way.id, &tags, &way.refs, &self.nodes)?;
        }
        if self.rules.platform_allowed(&tags) {
            let directions = rules::walk_directions(&tags);
            if directions.any() {
                let refs = Js::Array(way.refs.iter().map(|id| Js::Number(*id as f64)).collect())
                    .stringify();
                self.db
                    .prepare_cached(
                        "INSERT INTO platform_areas(way_id,refs,forward,backward) VALUES(?,?,?,?)",
                    )?
                    .execute(params![
                        way.id as f64,
                        refs,
                        f64::from(u8::from(directions.forward)),
                        f64::from(u8::from(directions.backward))
                    ])?;
            }
        }
        let walkable = self.rules.way_allowed(&tags, &way.refs);
        let drivable = self.rules.options.include_driving && rules::drivable(&tags);
        if !walkable && !drivable {
            return Ok(());
        }
        let walk = if walkable {
            rules::walk_directions(&tags)
        } else {
            rules::Directions::default()
        };
        let drive = if drivable {
            rules::drive_directions(&tags)
        } else {
            rules::Directions::default()
        };
        if walkable && !walk.any() {
            self.counters.direction_excluded += 1.0;
            let conveying = jsrt::norm(tags.get("conveying").unwrap_or(""));
            if conveying == "yes" || conveying == "reversible" {
                self.counters.uncertain_conveying += 1.0;
            }
        }
        if walkable && (!walk.forward || !walk.backward) {
            self.counters.direction_restricted += 1.0;
        }
        if walk.any() {
            self.counters.way_count += 1.0;
        }
        if drive.any() {
            self.counters.drive_way_count += 1.0;
        }
        let road_class = if drivable {
            rules::drive_road_class_code(tags.get("highway"))?
        } else {
            0.0
        };
        let forward_speed = rules::driving_speed_kph(&tags, false);
        let backward_speed = rules::driving_speed_kph(&tags, true);
        let mut previous: Option<(i64, f64, f64, bool, bool)> = None;
        for &node_id in &way.refs {
            let point = self.nodes.get(node_id);
            let (mut walk_indexed, mut drive_indexed) = (false, false);
            if let (
                Some((previous_id, previous_lat, previous_lon, previous_walk, previous_drive)),
                Some((lat, lon)),
            ) = (previous, point)
            {
                let distance = haversine_m((previous_lat, previous_lon), (lat, lon));
                if distance.is_finite() && distance > 0.0 {
                    let access = !self.blocked_walk.contains(&previous_id)
                        && !self.blocked_walk.contains(&node_id);
                    if !access && walk.any() {
                        self.counters.blocked_segments += 1.0;
                    }
                    if access && walk.any() {
                        let mut insert = self
                            .db
                            .prepare_cached("INSERT INTO edges VALUES(?,?,?,?)")?;
                        if walk.forward {
                            insert.execute(params![
                                previous_id as f64,
                                node_id as f64,
                                distance,
                                way.id as f64
                            ])?;
                        }
                        if walk.backward {
                            insert.execute(params![
                                node_id as f64,
                                previous_id as f64,
                                distance,
                                way.id as f64
                            ])?;
                        }
                        drop(insert);
                        if !previous_walk {
                            self.counters.walk_node_count +=
                                self.insert_walk_node(previous_id, previous_lat, previous_lon)?;
                        }
                        self.counters.walk_node_count +=
                            self.insert_walk_node(node_id, lat, lon)?;
                        let added =
                            f64::from(u8::from(walk.forward)) + f64::from(u8::from(walk.backward));
                        self.counters.edge_count += added;
                        self.counters.transaction_rows += added as usize;
                        walk_indexed = true;
                    }
                    if drive.any() {
                        let mut insert = self
                            .db
                            .prepare_cached("INSERT INTO drive_edges VALUES(?,?,?,?,?,?)")?;
                        if drive.forward {
                            insert.execute(params![
                                previous_id as f64,
                                node_id as f64,
                                distance,
                                distance / (forward_speed / 3.6),
                                way.id as f64,
                                road_class
                            ])?;
                        }
                        if drive.backward {
                            insert.execute(params![
                                node_id as f64,
                                previous_id as f64,
                                distance,
                                distance / (backward_speed / 3.6),
                                way.id as f64,
                                road_class
                            ])?;
                        }
                        drop(insert);
                        if !previous_drive {
                            self.counters.drive_node_count +=
                                self.insert_drive_node(previous_id, previous_lat, previous_lon)?;
                        }
                        self.counters.drive_node_count +=
                            self.insert_drive_node(node_id, lat, lon)?;
                        let added = f64::from(u8::from(drive.forward))
                            + f64::from(u8::from(drive.backward));
                        self.counters.drive_edge_count += added;
                        self.counters.transaction_rows += added as usize;
                        drive_indexed = true;
                    }
                }
            }
            previous = point.map(|(lat, lon)| (node_id, lat, lon, walk_indexed, drive_indexed));
        }
        Ok(())
    }
}

fn configure_build(db: &Connection) -> Result<()> {
    db.execute_batch(&format!(
        "PRAGMA page_size={BUILD_PAGE_SIZE}; PRAGMA journal_mode=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-{};",
        build_cache_kib()
    ))?;
    Ok(())
}

fn progress_event(progress: &mut dyn FnMut(&Progress), phase: &str, fraction: f64, detail: &str) {
    progress(&Progress {
        phase,
        progress: fraction,
        detail,
        work: None,
    });
}

/// A progress event of a PBF pass, with the bytes it has read.
fn progress_bytes(
    progress: &mut dyn FnMut(&Progress),
    phase: &str,
    fraction: f64,
    detail: &str,
    block: &pbf::BlockProgress,
) {
    progress(&Progress {
        phase,
        progress: fraction,
        detail,
        work: Some(crate::Work {
            completed: block.bytes_read,
            total: block.total_bytes,
        }),
    });
}

/// `buildNationalOsmStore`. Returns the same JSON object as the JavaScript compiler.
pub fn build_street_store(
    pbf_path: &Path,
    output: &Path,
    options: &StreetOptions,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Js> {
    if options.wheelchair && options.include_driving && !options.flex_driving {
        return Err(Error::new(
            "Wheelchair Cities require walk street preparation",
        ));
    }
    let started = std::time::Instant::now();
    let source_bytes = std::fs::metadata(pbf_path)?.len() as f64;
    let temporary = PathBuf::from(format!("{}.building", output.display()));
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    remove_if_present(&temporary)?;
    let db = Connection::open(&temporary)?;
    let compiled = compile(&db, pbf_path, options, source_bytes, progress);
    let metadata = match compiled {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            drop(db);
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
    };
    drop(db);
    std::fs::rename(&temporary, output)?;
    remove_stale_artifacts(output)?;

    let drive_node_count = metadata
        .get("driveNodeCount")
        .and_then(Js::as_f64)
        .unwrap_or(0.0);
    let drive_edge_count = metadata
        .get("driveEdgeCount")
        .and_then(Js::as_f64)
        .unwrap_or(0.0);
    let walk_node_count = metadata
        .get("walkNodeCount")
        .and_then(Js::as_f64)
        .unwrap_or(0.0);
    let edge_count = metadata
        .get("edgeCount")
        .and_then(Js::as_f64)
        .unwrap_or(0.0);
    let mut drive_accelerator = Js::object()
        .with("ready", false)
        .with("source", Js::Null)
        .with("buildMs", 0)
        .with("snapshotWriteMs", 0)
        .with("snapshotStatus", "deferred")
        .with("reason", "deferred_until_drive_request")
        .with("error", Js::Null);
    if options.build_driving_profile {
        progress_event(
            progress,
            "Building driving accelerator",
            0.94,
            &format!(
                "{} drive nodes / {} drive edges",
                grouped(drive_node_count),
                grouped(drive_edge_count)
            ),
        );
        let drive = crate::compact::drive_profile(output, true, None)?;
        drive_accelerator = accelerator_summary(&drive);
    }
    let output_bytes = std::fs::metadata(output)?.len() as f64;
    let eligible = edge_count > 0.0
        && edge_count <= walk_maximum_edges()
        && output_bytes <= walk_maximum_store_bytes();
    let walk_accelerator = if eligible {
        progress_event(
            progress,
            "Building pedestrian access accelerator",
            0.97,
            &format!(
                "{} walk nodes / {} directed edges",
                grouped(walk_node_count),
                grouped(edge_count)
            ),
        );
        let built = build_walk_store(output).map_err(|error| {
            Error::new(format!(
                "Pedestrian accelerator preparation failed: {error}. Source street tables have been retained at {}.",
                output.display()
            ))
        })?;
        Js::object()
            .with("ready", true)
            .with("source", "built")
            .with("buildMs", built.build_ms)
            .with("snapshotWriteMs", built.snapshot_write_ms)
            .with("snapshotStatus", "written")
            .with("reason", "ready")
    } else {
        let reason = if edge_count <= 0.0 {
            "graph_empty"
        } else if edge_count > walk_maximum_edges() {
            "edge_budget"
        } else {
            "store_size_budget"
        };
        return Err(Error::new(format!(
            "Pedestrian accelerator preparation failed: {reason}. Source street tables have been retained at {}.",
            output.display()
        )));
    };
    progress_event(
        progress,
        "Street index ready",
        1.0,
        &format!(
            "{} MB",
            grouped(jsrt::round(output_bytes / 1024.0 / 1024.0))
        ),
    );
    let mut result = metadata;
    result.set("path", output.display().to_string());
    result.set("bytes", output_bytes);
    result.set(
        "buildSeconds",
        jsrt::string_to_number(&jsrt::to_fixed(started.elapsed().as_secs_f64(), 3)),
    );
    result.set("driveAccelerator", drive_accelerator);
    result.set("walkAccelerator", walk_accelerator);
    Ok(result)
}

/// The seven fields a store result reports for an accelerator.
fn accelerator_summary(result: &Js) -> Js {
    let mut summary = Js::object();
    for key in [
        "ready",
        "source",
        "buildMs",
        "snapshotWriteMs",
        "snapshotStatus",
        "reason",
        "error",
    ] {
        if let Some(value) = result.get(key) {
            summary.set(key, value.clone());
        }
    }
    summary
}

fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Replace snapshots, CCH generations and endpoint overlays of an earlier graph.
fn remove_stale_artifacts(output: &Path) -> Result<()> {
    let names = [
        accelerator::walk_snapshot_path(output),
        accelerator::drive_snapshot_path(output),
    ]
    .map(|path| {
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    // `path.dirname('name')` is '.'.
    let directory = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if !kind.is_file() && !kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let stale = names.iter().any(|base| {
            name == *base
                || ((name.starts_with(&format!("{base}.street-cch-"))
                    || name.starts_with(&format!("{base}.drive-cch-")))
                    && (name.ends_with(".structure")
                        || name.ends_with(".metric")
                        || name.ends_with(".manifest.json")))
        });
        if stale {
            remove_if_present(&entry.path())?;
        }
    }
    remove_if_present(&PathBuf::from(format!(
        "{}.terminal-access-v1.json",
        output.display()
    )))
}

fn compile(
    db: &Connection,
    pbf_path: &Path,
    options: &StreetOptions,
    source_bytes: f64,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Js> {
    configure_build(db)?;
    db.execute_batch(
        "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE walk_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_m REAL NOT NULL, way_id INTEGER NOT NULL);
    CREATE TABLE platform_areas(way_id INTEGER PRIMARY KEY, refs TEXT NOT NULL, forward INTEGER NOT NULL, backward INTEGER NOT NULL, connected INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE drive_nodes(node_id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
    CREATE TABLE drive_edges(
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      distance_m REAL NOT NULL,
      travel_time_s REAL NOT NULL,
      way_id INTEGER NOT NULL,
      road_class INTEGER NOT NULL
    );",
    )?;
    let mut bike = if options.include_biking {
        Some(BikeWriter::create(db)?)
    } else {
        None
    };
    let mut basemap = BasemapWriter::create(db)?;
    places::create_tables(db)?;
    let street_rules = Rules { options };
    db.execute_batch("BEGIN IMMEDIATE")?;

    // Relations follow ways in a PBF; select water members first.
    let relation_fingerprint = {
        let mut pass = RelationPass {
            db,
            basemap: &mut basemap,
        };
        pbf::for_each_block(
            pbf_path,
            &mut |block| {
                pass.basemap.set_source_bounds(block.bounds);
                block.for_each(&mut pass)
            },
            &mut |p| {
                progress_bytes(
                    progress,
                    "Selecting local water geometry",
                    p.fraction() * 0.03,
                    "",
                    p,
                );
                Ok(())
            },
        )?
    };

    let mut required = IdSet::default();
    let selection_fingerprint = {
        let mut pass = SelectionPass {
            rules: &street_rules,
            basemap: &basemap,
            required: &mut required,
        };
        let count = std::cell::Cell::new(0usize);
        pbf::for_each_block(
            pbf_path,
            &mut |block| {
                block.for_each(&mut pass)?;
                count.set(pass.required.len());
                Ok(())
            },
            &mut |p| {
                progress_bytes(
                    progress,
                    "Selecting street node references",
                    0.03 + p.fraction() * 0.09,
                    &format!("{} referenced nodes", grouped(count.get() as f64)),
                    p,
                );
                Ok(())
            },
        )?
    };

    let mut pass = StreetPass {
        db,
        rules: &street_rules,
        required: &required,
        nodes: NodeStore::default(),
        blocked_walk: IdSet::default(),
        walk_nodes: IdSet::default(),
        drive_nodes: IdSet::default(),
        basemap: &mut basemap,
        bike: bike.as_mut(),
        counters: Counters {
            node_count: 0.0,
            walk_node_count: 0.0,
            edge_count: 0.0,
            way_count: 0.0,
            drive_node_count: 0.0,
            drive_edge_count: 0.0,
            drive_way_count: 0.0,
            direction_restricted: 0.0,
            direction_excluded: 0.0,
            uncertain_conveying: 0.0,
            blocked_segments: 0.0,
            transaction_rows: 0,
        },
    };
    let source_fingerprint = {
        let pass_cell = std::cell::RefCell::new(&mut pass);
        pbf::for_each_block(
            pbf_path,
            &mut |block| {
                let mut pass = pass_cell.borrow_mut();
                block.for_each(&mut **pass)?;
                if pass.counters.transaction_rows >= 250_000 {
                    pass.db.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
                    pass.counters.transaction_rows = 0;
                }
                Ok(())
            },
            &mut |p| {
                let pass = pass_cell.borrow();
                let c = &pass.counters;
                let phase = if c.way_count != 0.0 || c.drive_way_count != 0.0 {
                    "Indexing pedestrian and driving streets"
                } else {
                    "Reading OSM nodes"
                };
                progress_bytes(
                    progress,
                    phase,
                    0.12 + p.fraction() * 0.76,
                    &format!(
                        "{} nodes / {} walk + {} drive edges",
                        grouped(c.node_count),
                        grouped(c.edge_count),
                        grouped(c.drive_edge_count)
                    ),
                    p,
                );
                Ok(())
            },
        )?
    };
    if source_fingerprint != selection_fingerprint || source_fingerprint != relation_fingerprint {
        return Err(Error::new(
            "OSM PBF changed during street compilation; retry against a stable input.",
        ));
    }
    pass.required = &EMPTY_IDS;

    // Admit platform outlines with two distinct mapped walking junctions.
    let areas: Vec<(i64, String)> = {
        let mut statement = db.prepare("SELECT way_id,refs FROM platform_areas")?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (way_id, refs) in &areas {
        let refs: Vec<i64> = serde_json::from_str(refs).map_err(|e| Error::new(e.to_string()))?;
        if rules::platform_area_has_walking_junctions(&refs, |id| pass.walk_nodes.contains(&id)) {
            db.prepare_cached("UPDATE platform_areas SET connected=1 WHERE way_id=?")?
                .execute(params![*way_id as f64])?;
        }
    }
    let connected: Vec<(i64, String, i64, i64)> = {
        let mut statement = db.prepare("SELECT * FROM platform_areas WHERE connected=1")?;
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<rusqlite::Result<_>>()?
    };
    for (way_id, refs, forward, backward) in connected {
        let refs: Vec<i64> = serde_json::from_str(&refs).map_err(|e| Error::new(e.to_string()))?;
        pass.counters.way_count += 1.0;
        for i in 1..refs.len() {
            let (from, to) = (refs[i - 1], refs[i]);
            if pass.blocked_walk.contains(&from) || pass.blocked_walk.contains(&to) {
                continue;
            }
            let (Some(a), Some(b)) = (pass.nodes.get(from), pass.nodes.get(to)) else {
                continue;
            };
            let distance = haversine_m(a, b);
            if !(distance.is_finite() && distance > 0.0) {
                continue;
            }
            let mut insert = db.prepare_cached("INSERT INTO edges VALUES(?,?,?,?)")?;
            if forward != 0 {
                insert.execute(params![from as f64, to as f64, distance, way_id as f64])?;
            }
            if backward != 0 {
                insert.execute(params![to as f64, from as f64, distance, way_id as f64])?;
            }
            drop(insert);
            pass.counters.walk_node_count += pass.insert_walk_node(from, a.0, a.1)?;
            pass.counters.walk_node_count += pass.insert_walk_node(to, b.0, b.1)?;
            pass.counters.edge_count += (forward + backward) as f64;
        }
    }
    if let Some(bike) = pass.bike.as_deref_mut() {
        bike.flush(db)?;
    }
    db.execute_batch("DROP TABLE platform_areas")?;
    let counters = std::mem::replace(
        &mut pass.counters,
        Counters {
            node_count: 0.0,
            walk_node_count: 0.0,
            edge_count: 0.0,
            way_count: 0.0,
            drive_node_count: 0.0,
            drive_edge_count: 0.0,
            drive_way_count: 0.0,
            direction_restricted: 0.0,
            direction_excluded: 0.0,
            uncertain_conveying: 0.0,
            blocked_segments: 0.0,
            transaction_rows: 0,
        },
    );
    let blocked_walk_node_count = pass.blocked_walk.len() as f64;
    drop(pass);
    progress_event(progress, "Preparing local basemap", 0.89, "");
    let local_basemap = basemap.finish(db)?;
    db.execute_batch("COMMIT")?;
    progress_event(
        progress,
        "Building street indexes",
        0.9,
        &format!(
            "{} walk + {} drive edges",
            grouped(counters.edge_count),
            grouped(counters.drive_edge_count)
        ),
    );
    db.execute_batch(
        "
      CREATE TABLE drive_nodes_compact(
        node_id INTEGER PRIMARY KEY,
        lat REAL NOT NULL,
        lon REAL NOT NULL
      );
      INSERT INTO drive_nodes_compact(node_id, lat, lon)
      SELECT drive.node_id, drive.lat, drive.lon
      FROM drive_nodes AS drive
      LEFT JOIN walk_nodes AS walk ON walk.node_id=drive.node_id
      WHERE walk.node_id IS NULL;
      DROP TABLE drive_nodes;
      ALTER TABLE drive_nodes_compact RENAME TO drive_nodes;
    ",
    )?;
    let drive_node_stored_count: i64 =
        db.query_row("SELECT COUNT(*) AS count FROM drive_nodes", [], |row| {
            row.get(0)
        })?;
    let drive_node_count: i64 = db.query_row(
        "
      SELECT COUNT(*) AS count
      FROM (
        SELECT node_id FROM walk_nodes
        UNION
        SELECT node_id FROM drive_nodes
      )
    ",
        [],
        |row| row.get(0),
    )?;
    db.execute_batch(
        "
    CREATE INDEX walk_nodes_lat_lon ON walk_nodes(lat,lon);
    CREATE INDEX edges_from ON edges(from_node);
    ",
    )?;
    if options.build_driving_profile {
        db.execute_batch("CREATE INDEX drive_edges_from ON drive_edges(from_node);")?;
    }
    db.execute_batch("ANALYZE;")?;
    if options.wheelchair && counters.edge_count == 0.0 {
        return Err(Error::new(
            if options.wheelchair_streets == WheelchairStreets::Verified {
                "No streets meet the wheelchair profile in this OSM source (wheelchair=yes and no known barriers required)."
            } else {
                "No streets meet the wheelchair profile in this OSM source."
            },
        ));
    }
    let mut metadata = Js::object().with("schemaVersion", SCHEMA_VERSION);
    if options.wheelchair {
        metadata.set(
            "accessibility",
            rules::wheelchair_description(options.wheelchair_streets),
        );
    }
    metadata.set("sourceModel", "pbf");
    metadata.set("sourceFingerprint", source_fingerprint.as_str());
    metadata.set(
        "sourceFile",
        pbf_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    metadata.set("sourceBytes", source_bytes);
    metadata.set("localBasemap", local_basemap);
    metadata.set("builtAt", iso_now());
    metadata.set("nodeCount", counters.node_count);
    metadata.set("walkNodeCount", counters.walk_node_count);
    metadata.set("edgeCount", counters.edge_count);
    metadata.set("wayCount", counters.way_count);
    metadata.set("driveNodeCount", drive_node_count);
    metadata.set("driveNodeStoredCount", drive_node_stored_count);
    metadata.set("driveEdgeCount", counters.drive_edge_count);
    metadata.set("driveWayCount", counters.drive_way_count);
    let mut modes = vec!["walk"];
    if options.include_driving {
        modes.push("drive");
    }
    if options.include_biking {
        modes.push("bike");
    }
    metadata.set("preparedModes", modes);
    if let Some(bike) = bike {
        for (key, value) in bike.finish(db)? {
            metadata.set(key, value);
        }
    }
    metadata.set(
        "drivingWeightModel",
        if options.include_driving {
            Js::from("osm-maxspeed-or-highway-default-free-flow-seconds-v1")
        } else {
            Js::Null
        },
    );
    metadata.set("roadClassCatalog", rules::road_class_catalog());
    metadata.set("directionRestrictedWayCount", counters.direction_restricted);
    metadata.set("directionExcludedWayCount", counters.direction_excluded);
    metadata.set("uncertainConveyingWayCount", counters.uncertain_conveying);
    metadata.set("blockedWalkNodeCount", blocked_walk_node_count);
    metadata.set("blockedWalkSegmentCount", counters.blocked_segments);
    metadata.set("storageLayout", SOURCE_LAYOUT);
    metadata.set("driveNodeStorage", "walk-shared-plus-drive-only-v1");
    metadata.set(
        "driveIndexState",
        if options.build_driving_profile {
            "ready"
        } else {
            "deferred"
        },
    );
    db.execute_batch("BEGIN IMMEDIATE")?;
    {
        let mut insert = db.prepare("INSERT INTO metadata VALUES(?,?)")?;
        if let Js::Object(members) = &metadata {
            for (key, value) in members {
                insert.execute(params![key, value.stringify()])?;
            }
        }
    }
    db.execute_batch("COMMIT; PRAGMA optimize;")?;
    let free_pages: i64 = db.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
    if free_pages > 0 {
        db.execute_batch("VACUUM")?;
    }
    Ok(metadata)
}

fn admission_error(path: &Path, reason: &'static str, detail: &str) -> Error {
    Error::admission(
        reason,
        format!(
            "Street store admission failed for {}: {detail} Expected the current {SCHEMA_VERSION} SQLite street store with sourceModel=\"pbf\". Rebuild the street index from the source OSM PBF instead of modifying it in place.",
            path.display()
        ),
    )
}

fn json_text(value: Option<&serde_json::Value>) -> String {
    value.map_or("undefined".to_owned(), |value| Js::from(value).stringify())
}

/// `readNationalOsmStoreMetadata`: parsed metadata after the version check.
pub fn read_store_metadata(path: &Path) -> Result<Metadata> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let metadata = accelerator::read_metadata(&db).map_err(|error| {
        admission_error(
            path,
            "metadata_unreadable",
            &format!("SQLite could not read metadata ({error})."),
        )
    })?;
    admit_version(path, &metadata)?;
    Ok(metadata)
}

pub(crate) fn admit_version(path: &Path, metadata: &Metadata) -> Result<()> {
    if metadata
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        != Some(SCHEMA_VERSION)
    {
        return Err(admission_error(
            path,
            "schema_version_mismatch",
            &format!(
                "metadata.schemaVersion is {}.",
                json_text(metadata.get("schemaVersion"))
            ),
        ));
    }
    if metadata
        .get("sourceModel")
        .and_then(serde_json::Value::as_str)
        != Some("pbf")
    {
        return Err(admission_error(
            path,
            "source_model_mismatch",
            &format!(
                "metadata.sourceModel is {}.",
                json_text(metadata.get("sourceModel"))
            ),
        ));
    }
    Ok(())
}

/// Validate the compiler-only source layout (`admitSourceStreetStore`).
pub(crate) fn admit_source(db: &Connection, path: &Path, metadata: &Metadata) -> Result<()> {
    admit_version(path, metadata)?;
    if metadata
        .get("storageLayout")
        .and_then(serde_json::Value::as_str)
        != Some(SOURCE_LAYOUT)
    {
        return Err(admission_error(
            path,
            "storage_layout_mismatch",
            "metadata.storageLayout must be \"walk-drive-role-tables-v2\" before runtime compaction.",
        ));
    }
    let deferred = metadata
        .get("driveIndexState")
        .and_then(serde_json::Value::as_str)
        == Some("deferred");
    let tables = [
        "metadata",
        "walk_nodes",
        "edges",
        "drive_nodes",
        "drive_edges",
    ];
    let mut indexes = vec![
        ("walk_nodes_lat_lon", "walk_nodes"),
        ("edges_from", "edges"),
    ];
    if !deferred {
        indexes.push(("drive_edges_from", "drive_edges"));
    }
    let object = |name: &str| -> Result<Option<(String, String)>> {
        let mut statement =
            db.prepare_cached("SELECT type, tbl_name FROM sqlite_schema WHERE name=?")?;
        let mut rows = statement.query(params![name])?;
        Ok(match rows.next()? {
            Some(row) => Some((row.get(0)?, row.get(1)?)),
            None => None,
        })
    };
    for table in tables {
        if object(table)? != Some(("table".to_owned(), table.to_owned())) {
            return Err(admission_error(
                path,
                "required_table_missing",
                &format!("Required store table \"{table}\" is missing."),
            ));
        }
    }
    for (index, table) in indexes {
        if object(index)? != Some(("index".to_owned(), table.to_owned())) {
            return Err(admission_error(
                path,
                "required_index_missing",
                &format!("Required store index \"{index}\" is missing."),
            ));
        }
    }
    Ok(())
}

/// A read-only store connection configured as `openStreetStoreWithAdmission`
/// does (`VIGO_READONLY_SQLITE_MMAP_BYTES`, `VIGO_READONLY_SQLITE_CACHE_KIB`).
pub(crate) fn open_read_only(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mmap =
        std::env::var("VIGO_READONLY_SQLITE_MMAP_BYTES").map_or(256.0 * 1024.0 * 1024.0, |v| {
            let n = jsrt::string_to_number(&v).floor();
            if n.is_nan() { 0.0 } else { n }
        });
    let mmap = 0f64.max((2.0 * 1024.0 * 1024.0 * 1024.0f64).min(mmap));
    let cache = clamp_kib("VIGO_READONLY_SQLITE_CACHE_KIB", 32.0 * 1024.0);
    db.execute_batch(&format!(
        "PRAGMA mmap_size={mmap}; PRAGMA cache_size=-{cache};"
    ))?;
    Ok(db)
}

/// The pedestrian snapshot of a source store and its preparation result:
/// `ready`, `reason`, `snapshotStatus`, counts and timings. Studio and the
/// checks prepare hand-made or rebuilt source stores with it before sealing.
pub fn walk_profile(path: &Path) -> Result<Js> {
    let started = std::time::Instant::now();
    let metadata = {
        let db = open_read_only(path)?;
        let metadata = accelerator::read_metadata(&db)?;
        admit_source(&db, path, &metadata)?;
        metadata
    };
    let edge_count = metadata
        .get("edgeCount")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    let store_bytes = std::fs::metadata(path)?.len() as f64;
    let ineligible = if edge_count <= 0.0 {
        Some("graph_empty")
    } else if edge_count > walk_maximum_edges() {
        Some("edge_budget")
    } else if store_bytes > walk_maximum_store_bytes() {
        Some("store_size_budget")
    } else {
        None
    };
    let built = match ineligible {
        Some(reason) => Err((reason, String::new())),
        None => build_walk_store(path).map_err(|error| ("build_failed", error.to_string())),
    };
    let mut result = Js::object()
        .with("ready", built.is_ok())
        .with("accelerated", built.is_ok())
        .with(
            "reason",
            built
                .as_ref()
                .map_or_else(|(reason, _)| *reason, |_| "ready"),
        )
        .with("prepareMs", elapsed_ms(started));
    match &built {
        Ok(built) => {
            result
                .set("buildMs", built.build_ms)
                .set("loadMs", 0)
                .set("snapshotWriteMs", built.snapshot_write_ms)
                .set("source", "built")
                .set("snapshotStatus", "written")
                .set("nodeCount", built.node_count)
                .set("edgeCount", built.edge_count);
        }
        Err((_, error)) => {
            result
                .set("buildMs", 0)
                .set("loadMs", 0)
                .set("snapshotWriteMs", 0)
                .set("snapshotStatus", "not_written")
                .set("nodeCount", 0)
                .set("edgeCount", edge_count);
            if !error.is_empty() {
                result.set("error", error.as_str());
            }
        }
    }
    result
        .set(
            "snapshotPath",
            accelerator::walk_snapshot_path(path).display().to_string(),
        )
        .set("storeBytes", store_bytes);
    Ok(result)
}

/// Build and persist the pedestrian snapshot of an admitted source store.
pub fn build_walk_store(path: &Path) -> Result<accelerator::Built> {
    let db = open_read_only(path)?;
    let metadata = accelerator::read_metadata(&db)?;
    admit_source(&db, path, &metadata)?;
    accelerator::build_walk(path, &db, &metadata)
}
