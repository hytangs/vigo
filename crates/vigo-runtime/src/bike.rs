//! Optional bicycle graph. One shared profile graph, loaded only on demand.
//! Preference cost selects the path; physical seconds report its duration.
use crate::bike_time::{BikeClock, TurnWindows};
use crate::drive_attachment::{
    ALTERNATIVE_TOLERANCE_M, BikeAttachment as Attachment, DriveGraph, RoadCandidate, RoadIndex,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap, HashSet},
};
#[path = "bike_arrive.rs"]
mod arrive;
#[path = "bike_arrive_profile.rs"]
mod arrive_profile;
#[path = "bike_many.rs"]
mod many;
#[path = "bike_many_to.rs"]
mod many_to;
#[path = "bike_matrix.rs"]
mod matrix;
#[path = "bike_walk.rs"]
mod walk;

/// OSM node identifiers come from a prepared City and are looked up millions of
/// times while opening it; a multiplicative hash replaces SipHash for just this.
#[derive(Default)]
pub(crate) struct OsmNodeHasher(u64);
impl std::hash::Hasher for OsmNodeHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u64(u64::from(byte));
        }
    }
    fn write_u64(&mut self, value: u64) {
        let mixed = (self.0 ^ value).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.0 = mixed ^ (mixed >> 29);
    }
    fn write_i64(&mut self, value: i64) {
        self.write_u64(value as u64);
    }
}
pub(crate) type OsmNodeIds = HashMap<i64, u32, std::hash::BuildHasherDefault<OsmNodeHasher>>;
// Above every edge's time cost, so the search's lower bounds stay admissible.
const SHORTEST_COST_PER_METER: f64 = 1.;
// Bounded by remaining distance and cost; a search this large rarely finishes.
const MAX_CONSTRAINED_LABELS: usize = 500_000;
// Runtime-only flags in spare attribute bits; never written into City tables.
const TIMED_EDGE: u32 = 1 << 31;
const NODE_TURN: u32 = 1 << 30;
const WAY_TURN: u32 = 1 << 29;
const STRESS_SHIFT: u32 = 23;
const PUSH_ALLOWED: u32 = 1 << 26;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Profile {
    #[default]
    Balanced,
    Fast,
    Quiet,
    // Internal: prefers the fewest metres when a distance limit is too tight to
    // search every trade-off. Requests cannot select it.
    #[serde(skip)]
    Shortest,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BikeOptions {
    #[serde(default)]
    pub profile: Profile,
    #[serde(default = "default_speed")]
    pub speed_kph: f64,
    #[serde(default, deserialize_with = "present_max_lts")]
    pub max_lts: Option<u8>,
}
fn present_max_lts<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u8>, D::Error> {
    u8::deserialize(d).map(Some)
}
fn default_speed() -> f64 {
    18.0
}
impl Default for BikeOptions {
    fn default() -> Self {
        Self {
            profile: Profile::Balanced,
            speed_kph: default_speed(),
            max_lts: None,
        }
    }
}
impl BikeOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !self.speed_kph.is_finite() || !(5.0..=40.0).contains(&self.speed_kph) {
            return Err("bike.speedKph must be between 5 and 40".into());
        }
        if self.max_lts.is_some_and(|level| !(1..=4).contains(&level)) {
            return Err("bike.maxLts must be an integer from 1 to 4".into());
        }
        Ok(())
    }
}

pub(crate) struct BikeKernel {
    walking: Option<walk::WalkNetwork>,
    lons: Vec<f64>,
    lats: Vec<f64>,
    offsets: Vec<u32>,
    targets: Vec<u32>,
    distances: Vec<u32>,
    attributes: Vec<u32>,
    ways: Vec<i64>,
    // Attachment uses geometric distances; request-specific costs are computed
    // only for the sparse search, with no per-profile graph copies.
    turns: HashMap<(u32, i64), Vec<NodeTurn>>,
    windows: TurnWindows,
    edge_windows: HashMap<u32, u32>,
    timed_node_turns: bool,
    timed_way_turns: bool,
    stress_prepared: bool,
    way_turns: Vec<WayTurn>,
    way_starts: HashMap<(u32, i64), Vec<u32>>,
    index: RoadIndex,
    minimum_length_ratio: f64,
    destination_components: Vec<u32>,
    pub unsupported_restrictions: u64,
}

struct WayTurn {
    from: i64,
    via: Vec<i64>,
    to: i64,
    window: u32,
    only: bool,
    independent: bool,
}
struct NodeTurn {
    to: i64,
    window: u32,
    kind: u8,
}
type TurnState = Vec<(u32, u32, u32)>;
// Edge, fraction, start coordinate, end coordinate, waiting seconds.
type BicyclePathPart = (u32, f64, [f64; 2], [f64; 2], f64);
type CertifiedMetrics<T> = Result<(Option<T>, &'static str), String>;

// The usual movement has one result and no allocation. A timed alternative
// completion can produce a different via-way state after waiting; only those
// uncommon movements allocate additional candidates.
#[derive(Default)]
struct Movements {
    first: Option<(f64, TurnState)>,
    later: Vec<(f64, TurnState)>,
}
impl Movements {
    fn insert(&mut self, time: f64, state: TurnState) {
        if self.first.is_none() {
            self.first = Some((time, state));
        } else if self.first.as_ref().is_none_or(|(_, s)| *s != state)
            && self.later.iter().all(|(_, s)| *s != state)
        {
            self.later.push((time, state));
        }
    }
    fn into_iter(self) -> impl Iterator<Item = (f64, TurnState)> {
        self.first.into_iter().chain(self.later)
    }
}

fn same_point(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9
}

// Distance to a box enclosing destination nodes on the unit sphere is no
// greater than their nearest chord, hence no greater than their geodesic.
// This keeps large attachment sets from multiplying A* work by their size.
struct TargetBounds {
    low: [f64; 3],
    high: [f64; 3],
}
fn sphere(point: [f64; 2]) -> [f64; 3] {
    let (s, c) = point[0].to_radians().sin_cos();
    let (z, r) = point[1].to_radians().sin_cos();
    [r * c, r * s, z]
}
impl TargetBounds {
    fn new(points: impl Iterator<Item = [f64; 2]>) -> Self {
        let mut b = Self {
            low: [f64::INFINITY; 3],
            high: [f64::NEG_INFINITY; 3],
        };
        for p in points.map(sphere) {
            for (i, value) in p.into_iter().enumerate() {
                b.low[i] = b.low[i].min(value);
                b.high[i] = b.high[i].max(value);
            }
        }
        b
    }
    fn meters(&self, point: [f64; 2]) -> f64 {
        sphere(point)
            .into_iter()
            .enumerate()
            .map(|(i, value)| {
                (self.low[i] - value)
                    .max(value - self.high[i])
                    .max(0.)
                    .powi(2)
            })
            .sum::<f64>()
            .sqrt()
            * 6_371_008.8
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BikeLeg {
    pub kind: &'static str,
    pub seconds: f64,
    pub meters: f64,
    pub coordinates: Vec<[f64; 2]>,
    pub source: &'static str,
    pub verified: bool,
    #[serde(skip_serializing_if = "zero_seconds")]
    pub wait_before_seconds: f64,
}
fn zero_seconds(seconds: &f64) -> bool {
    *seconds == 0.
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BikeResult {
    pub status: &'static str,
    pub reason: Option<&'static str>,
    pub legs: Vec<BikeLeg>,
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "zero_seconds")]
    pub end_wait_seconds: f64,
    pub settled_labels: usize,
    pub origin_road_meters: Option<f64>,
    pub destination_road_meters: Option<f64>,
    pub unsupported_restrictions: u64,
    pub timing_policy: &'static str,
    #[serde(skip)]
    pub distance_limit_best_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_lts: Option<u8>,
    #[serde(skip)]
    temporal_valid: bool,
    #[serde(skip)]
    continuation: Option<BikeContinuation>,
}

impl BikeResult {
    pub fn elapsed_seconds(&self) -> f64 {
        self.end_wait_seconds
            + self
                .legs
                .iter()
                .map(|l| l.seconds + l.wait_before_seconds)
                .sum::<f64>()
    }
}

#[derive(Debug)]
struct BikeContinuation {
    incoming: Option<u32>,
    state: TurnState,
    road: [f64; 2],
    walk_meters: f64,
}

#[derive(Clone, Copy)]
struct Label {
    node: u32,
    // Valid CSR edges and bounded label ids are strictly below u32::MAX.
    incoming: u32,
    state: u32,
    cost: f64,
    meters: f64,
    parent: u32,
    start: u32,
    active: bool,
}
impl Label {
    fn incoming(&self) -> Option<u32> {
        (self.incoming != u32::MAX).then_some(self.incoming)
    }
}
struct Queue(f64, usize);
#[derive(Clone, Copy)]
enum SearchKind<'a> {
    Normal,
    Relaxed,
    Earliest,
    Frozen,
    Scoped(&'a [Option<bool>]),
    ArriveScoped(&'a [Option<bool>]),
    ArriveConservative,
}
impl SearchKind<'_> {
    fn relaxed(self) -> bool {
        matches!(
            self,
            Self::Relaxed | Self::Scoped(_) | Self::ArriveScoped(_) | Self::ArriveConservative
        )
    }
    fn variable(self, window: u32) -> bool {
        match self {
            Self::Relaxed => window != 0,
            Self::Scoped(scope) | Self::ArriveScoped(scope) => scope[window as usize].is_none(),
            _ => false,
        }
    }
}
#[derive(Clone, Copy)]
struct SearchBounds {
    upper_cost: f64,
    earliest_arrival: f64,
}
impl Default for SearchBounds {
    fn default() -> Self {
        Self {
            upper_cost: f64::INFINITY,
            earliest_arrival: 0.,
        }
    }
}
impl PartialEq for Queue {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0 && self.1 == other.1
    }
}
impl Eq for Queue {}
impl PartialOrd for Queue {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Queue {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .total_cmp(&self.0)
            .then_with(|| other.1.cmp(&self.1))
    }
}

impl BikeKernel {
    pub fn open(path: &str) -> Result<Self, String> {
        Self::read(path).map_err(|e| format!("Cannot open bicycle graph: {e}"))
    }
    fn read(path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        // Only this call reads the connection, so SQLite need not lock every
        // column read of a few million rows.
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let version: String = db.query_row("SELECT value FROM metadata WHERE key='bikeProfileVersion'", [], |r| r.get(0))
            .map_err(|_| "Bike is not prepared in this City; build with --street-modes=walk,bike or walk,drive,bike")?;
        if version != "1" {
            return Err("Unsupported bicycle graph version".into());
        }
        // Exact portable table counts avoid geometric over-allocation and
        // copying the largest arrays while opening a City.
        let node_count = db.query_row("SELECT count(*) FROM bike_nodes", [], |r| {
            r.get::<_, u32>(0)
        })? as usize;
        let mut lons = Vec::with_capacity(node_count);
        let mut lats = Vec::with_capacity(node_count);
        let mut ids = OsmNodeIds::with_capacity_and_hasher(node_count, Default::default());
        for row in db
            .prepare("SELECT node_id,lon_e7,lat_e7 FROM bike_nodes ORDER BY node_id")?
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
        {
            let (id, lon, lat) = row?;
            if !(-1_800_000_000..=1_800_000_000).contains(&lon)
                || !(-900_000_000..=900_000_000).contains(&lat)
            {
                return Err("Invalid bicycle coordinate".into());
            }
            ids.insert(id, u32::try_from(lons.len())?);
            lons.push(lon as f64 / 1e7);
            lats.push(lat as f64 / 1e7);
        }
        let mut offsets = vec![0u32; lons.len() + 1];
        let (mut windows, window_ids) = TurnWindows::load(&db)?;
        let edge_ids = windows.load_edges(&db)?;
        let timed_count = if edge_ids.is_empty() {
            0
        } else {
            db.query_row("SELECT count(*) FROM bike_timed_edges", [], |r| {
                r.get::<_, u32>(0)
            })?
        };
        let edge_count = db
            .query_row("SELECT count(*) FROM bike_edges", [], |r| {
                r.get::<_, u32>(0)
            })?
            .checked_add(timed_count)
            .ok_or("Too many bicycle edges")? as usize;
        let mut targets = vec![0u32; edge_count];
        let mut distances = vec![0u32; edge_count];
        let mut attributes = vec![0u32; edge_count];
        let mut ways = vec![0i64; edge_count];
        let mut edge_windows = HashMap::with_capacity(timed_count as usize);
        let stress_version = match db.query_row(
            "SELECT value FROM metadata WHERE key='bikeStressVersion'",
            [],
            |r| r.get::<_, String>(0),
        ) {
            Ok(version) => Some(version),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(error.into()),
        };
        if stress_version.as_deref().is_some_and(|v| v != "1") {
            return Err("Unsupported bicycle traffic-stress version".into());
        }
        let stress_prepared = stress_version.is_some();
        let stress = if stress_prepared { "stress" } else { "0" };
        // Sorting every edge would spill to temporary files. Rowid scans give
        // the same order within a node: size each node's run, then fill it.
        let mut sources = vec![format!(
            "SELECT from_node,to_node,distance_cm,way_id,attributes,0,{stress} FROM bike_edges ORDER BY rowid"
        )];
        if !edge_ids.is_empty() {
            sources.push(format!(
                "SELECT from_node,to_node,distance_cm,way_id,attributes,window_id,{stress} FROM bike_timed_edges ORDER BY rowid"
            ));
        }
        for sql in &sources {
            for from in db.prepare(sql)?.query_map([], |r| r.get::<_, i64>(0))? {
                let from = *ids.get(&from?).ok_or("Missing bicycle edge source")?;
                offsets[from as usize + 1] = offsets[from as usize + 1]
                    .checked_add(1)
                    .ok_or("Too many bicycle edges")?;
            }
        }
        for i in 1..offsets.len() {
            offsets[i] = offsets[i]
                .checked_add(offsets[i - 1])
                .ok_or("Too many bicycle edges")?;
        }
        if offsets[lons.len()] as usize != edge_count {
            return Err("Inconsistent bicycle edge count".into());
        }
        let mut next = offsets.clone();
        for sql in &sources {
            for row in db.prepare(sql)?.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, u32>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, u32>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, u8>(6)?,
                ))
            })? {
                let (from, to, distance, way, mut attr, window, stress) = row?;
                let (&from, &to) = (
                    ids.get(&from).ok_or("Missing bicycle edge source")?,
                    ids.get(&to).ok_or("Missing bicycle edge target")?,
                );
                if distance == 0 || attr >> 23 != 0 || ((attr >> 8) & 63) > 60 {
                    return Err("Invalid bicycle edge attributes".into());
                }
                if stress_prepared {
                    if stress & !15 != 0 || !(1..=4).contains(&(stress & 7)) {
                        return Err("Invalid bicycle traffic-stress attributes".into());
                    }
                    // Optional prepared data uses spare runtime bits in the existing
                    // edge word. No stress array or per-profile graph is retained.
                    attr |= u32::from(stress) << STRESS_SHIFT;
                }
                let slot = next[from as usize] as usize;
                if slot >= offsets[from as usize + 1] as usize {
                    return Err("Inconsistent bicycle edge count".into());
                }
                next[from as usize] += 1;
                if window != 0 {
                    edge_windows.insert(
                        u32::try_from(slot)?,
                        *edge_ids.get(&window).ok_or("Unknown bicycle edge window")?,
                    );
                    attr |= TIMED_EDGE;
                }
                targets[slot] = to;
                distances[slot] = distance;
                attributes[slot] = attr;
                ways[slot] = way;
            }
        }
        let mut timed_node_turns = false;
        let mut turns: HashMap<(u32, i64), Vec<NodeTurn>> = HashMap::new();
        for row in db
            .prepare("SELECT via_node,from_way,to_way,only_turn,rowid FROM bike_turns")?
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, u8>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
        {
            let (via, from, to, kind, row) = row?;
            if kind & !8 > 5 || (kind & 8 != 0 && kind & 1 == 0) {
                return Err("Invalid bicycle turn restriction".into());
            }
            if let Some(&via) = ids.get(&via) {
                let window = window_ids.get(&(0, row)).copied().unwrap_or(0);
                timed_node_turns |= window != 0;
                turns
                    .entry((via, from))
                    .or_default()
                    .push(NodeTurn { to, kind, window });
            }
        }
        let unsupported_restrictions = db
            .query_row(
                "SELECT value FROM metadata WHERE key='bikeUnsupportedRestrictionCount'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let mut way_turns = Vec::new();
        let mut timed_way_turns = false;
        let mut from_ways = Vec::new();
        if db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='bike_way_turns'",
            [],
            |r| r.get::<_, u32>(0),
        )? > 0
        {
            for row in db
                .prepare("SELECT from_way,via_ways,to_way,only_turn,rowid FROM bike_way_turns")?
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, u8>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })?
            {
                let (from, via, to, only, row) = row?;
                let via: Vec<i64> = serde_json::from_str(&via)?;
                if via.is_empty() || via.len() > 16 || ![0, 1, 3].contains(&only) {
                    return Err("Invalid bicycle via-way restriction".into());
                }
                from_ways.push(from);
                let window = window_ids.get(&(1, row)).copied().unwrap_or(0);
                timed_way_turns |= window != 0;
                way_turns.push(WayTurn {
                    from,
                    via,
                    to,
                    window,
                    only: only & 1 != 0,
                    independent: only & 2 != 0,
                });
            }
        }
        // Index just the ways participating in via-way restrictions, once.
        let first_ways: HashSet<i64> = way_turns.iter().map(|r| r.via[0]).collect();
        let mut first_nodes = HashSet::new();
        let mut incoming_nodes: HashMap<i64, HashSet<u32>> =
            from_ways.iter().map(|&w| (w, HashSet::new())).collect();
        for node in 0..lons.len() {
            for edge in offsets[node] as usize..offsets[node + 1] as usize {
                if first_ways.contains(&ways[edge]) {
                    first_nodes.insert((node as u32, ways[edge]));
                }
                if let Some(nodes) = incoming_nodes.get_mut(&ways[edge]) {
                    nodes.insert(targets[edge]);
                }
            }
        }
        let mut way_starts: HashMap<(u32, i64), Vec<u32>> = HashMap::new();
        for (i, rule) in way_turns.iter().enumerate() {
            for &node in &incoming_nodes[&from_ways[i]] {
                if first_nodes.contains(&(node, rule.via[0])) {
                    way_starts
                        .entry((node, from_ways[i]))
                        .or_default()
                        .push(i as u32);
                }
            }
        }
        // Incoming edges know whether a restriction starts at their target.
        // Most search states need no sparse-map lookup at all. These flags
        // reuse unused bits and do not duplicate per-node or per-edge storage.
        for edge in 0..attributes.len() {
            let key = (targets[edge], ways[edge]);
            if turns.contains_key(&key) {
                attributes[edge] |= NODE_TURN;
            }
            if way_starts.contains_key(&key) {
                attributes[edge] |= WAY_TURN;
            }
        }
        let graph = DriveGraph {
            lons: &lons,
            lats: &lats,
            edge_offsets: &offsets,
            edge_targets: &targets,
            edge_distance_units: &distances,
            edge_time_units: &distances,
            closed_time_units: u32::MAX,
            distance_units_per_meter: 100.,
            time_units_per_second: 100.,
        };
        let index = RoadIndex::build(&graph);
        let mut minimum_length_ratio = 1.0_f64;
        for from in 0..lons.len() {
            for edge in offsets[from] as usize..offsets[from + 1] as usize {
                let to = targets[edge] as usize;
                let geometric =
                    vigo_route::geo::haversine_m([lons[from], lats[from]], [lons[to], lats[to]]);
                if geometric > 0. {
                    minimum_length_ratio =
                        minimum_length_ratio.min(distances[edge] as f64 / 100. / geometric);
                }
            }
        }
        let mut destination_components = Vec::new();
        if attributes.iter().any(|a| a & (1 << 22) != 0) {
            destination_components = (0..lons.len() as u32).collect();
            fn root(parents: &mut [u32], mut node: u32) -> u32 {
                while parents[node as usize] != node {
                    parents[node as usize] = parents[parents[node as usize] as usize];
                    node = parents[node as usize];
                }
                node
            }
            for from in 0..lons.len() {
                for edge in offsets[from] as usize..offsets[from + 1] as usize {
                    if attributes[edge] & (1 << 22) == 0 {
                        continue;
                    }
                    let a = root(&mut destination_components, from as u32);
                    let b = root(&mut destination_components, targets[edge]);
                    destination_components[a as usize] = b;
                }
            }
            for node in 0..lons.len() {
                destination_components[node] = root(&mut destination_components, node as u32);
            }
        }
        let walking = walk::WalkNetwork::load(&db, path, &ids, &lons, &lats)?;
        Ok(Self {
            walking,
            lons,
            lats,
            offsets,
            targets,
            distances,
            attributes,
            ways,
            turns,
            windows,
            edge_windows,
            timed_node_turns,
            timed_way_turns,
            stress_prepared,
            way_turns,
            way_starts,
            index,
            minimum_length_ratio,
            destination_components,
            unsupported_restrictions,
        })
    }

    #[cfg(any(feature = "standalone", test))]
    pub fn heap_bytes(&self) -> usize {
        self.walking
            .as_ref()
            .map_or(0, walk::WalkNetwork::heap_bytes)
            + (self.lons.capacity() + self.lats.capacity() + self.ways.capacity()) * 8
            + (self.offsets.capacity()
                + self.targets.capacity()
                + self.distances.capacity()
                + self.attributes.capacity())
                * 4
            + self.index.byte_length()
            + self.windows.byte_length()
            + self.edge_windows.capacity() * 9
            + self.turns.capacity() * 56
            + self
                .turns
                .values()
                .map(|v| v.capacity() * 16)
                .sum::<usize>()
            + self.way_turns.capacity() * std::mem::size_of::<WayTurn>()
            + self
                .way_turns
                .iter()
                .map(|r| r.via.capacity() * 8)
                .sum::<usize>()
            + self.destination_components.capacity() * 4
            + self.way_starts.capacity() * 56
            + self
                .way_starts
                .values()
                .map(|v| v.capacity() * 4)
                .sum::<usize>()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn attach_bicycle_matching(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        maximum: f64,
        speed: f64,
        origin: bool,
        nearest: bool,
        eligible: &impl Fn(u32) -> bool,
    ) -> Result<Attachment, String> {
        if let Some(walking) = &self.walking {
            walking.attach(self, point, maximum, speed, origin, eligible)
        } else {
            Ok(self
                .index
                .attach_bicycle_matching(graph, point, maximum, speed, origin, nearest, eligible))
        }
    }
    fn attach_bicycle_fallback(
        &self,
        graph: &DriveGraph<'_>,
        point: [f64; 2],
        maximum: f64,
        speed: f64,
        origin: bool,
        eligible: &impl Fn(u32) -> bool,
    ) -> Result<Attachment, String> {
        if let Some(walking) = &self.walking {
            walking.attach(self, point, maximum, speed, origin, eligible)
        } else {
            self.index
                .attach_bicycle_fallback(graph, point, maximum, speed, origin, eligible)
        }
    }

    fn graph(&self) -> DriveGraph<'_> {
        DriveGraph {
            lons: &self.lons,
            lats: &self.lats,
            edge_offsets: &self.offsets,
            edge_targets: &self.targets,
            edge_distance_units: &self.distances,
            edge_time_units: &self.distances,
            closed_time_units: u32::MAX,
            distance_units_per_meter: 100.,
            time_units_per_second: 100.,
        }
    }
    fn source(&self, edge: u32) -> u32 {
        (self.offsets.partition_point(|&v| v <= edge) - 1) as u32
    }
    fn point(&self, node: u32) -> [f64; 2] {
        [self.lons[node as usize], self.lats[node as usize]]
    }
    #[cfg(test)]
    fn allowed_turn(&self, incoming: Option<u32>, node: u32, outgoing: u32) -> bool {
        let turns = incoming
            .and_then(|edge| self.turns.get(&(node, self.ways[edge as usize])))
            .map_or(&[][..], |turns| &turns[..]);
        self.allowed_turns_at(turns, incoming, outgoing, None, 0.)
    }
    fn allowed_turns_at(
        &self,
        turns: &[NodeTurn],
        incoming: Option<u32>,
        outgoing: u32,
        clock: Option<BikeClock>,
        elapsed: f64,
    ) -> bool {
        let Some(incoming) = incoming.filter(|_| !turns.is_empty()) else {
            return true;
        };
        let way = self.ways[outgoing as usize];
        let uturn = self.targets[outgoing as usize] == self.source(incoming);
        let mut only = false;
        let mut matches_only = false;
        for &NodeTurn { to, kind, window } in turns {
            if !self.windows.active(window, clock, elapsed) {
                continue;
            }
            let matches = to == way
                && match kind & 6 {
                    2 => uturn,
                    4 => !uturn,
                    _ => true,
                };
            if kind % 2 == 1 {
                if kind & 8 != 0 {
                    if !matches {
                        return false;
                    }
                    continue;
                }
                only = true;
                matches_only |= matches;
            } else if matches {
                return false;
            }
        }
        !only || matches_only
    }
    fn has_timing(&self) -> bool {
        self.timed_node_turns || self.timed_way_turns || !self.edge_windows.is_empty()
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn movements(
        &self,
        state: &TurnState,
        incoming: Option<u32>,
        node: u32,
        outgoing: u32,
        clock: Option<BikeClock>,
        elapsed: f64,
        kind: SearchKind,
        alternatives: bool,
    ) -> Result<Movements, String> {
        if state.is_empty()
            && incoming
                .is_none_or(|edge| self.attributes[edge as usize] & (NODE_TURN | WAY_TURN) == 0)
            && self.attributes[outgoing as usize] & TIMED_EDGE == 0
        {
            return Ok(Movements {
                first: Some((elapsed, TurnState::new())),
                later: Vec::new(),
            });
        }
        let mut result = Movements::default();
        let turns = incoming
            .filter(|&edge| self.attributes[edge as usize] & NODE_TURN != 0)
            .and_then(|edge| self.turns.get(&(node, self.ways[edge as usize])))
            .map_or(&[][..], |turns| &turns[..]);
        let relaxed = kind.relaxed();
        let frozen = matches!(kind, SearchKind::Frozen);
        let window = (self.attributes[outgoing as usize] & TIMED_EDGE != 0)
            .then(|| self.edge_windows[&outgoing]);
        // Usually the next state is purely geometric. A conditional completion
        // of one only_* alternative can release the other prefixes in its
        // group. Keep the earliest movement for each resulting state, including
        // waiting voluntarily; choosing just the earliest could lose a route.
        let variable_state = alternatives
            && clock.is_some()
            && !relaxed
            && !frozen
            && self.timed_way_turns
            && state.iter().any(|&(id, step, _)| {
                let rule = &self.way_turns[id as usize];
                rule.only
                    && !rule.independent
                    && rule.window != 0
                    && step as usize + 1 == rule.via.len()
                    && self.ways[outgoing as usize] == rule.to
                    && rule.to != rule.via[step as usize]
            });
        let mut time = elapsed;
        // A full ordinary civil week visits every weekly permission state.
        // Start a new cycle at a clock jump: it may have skipped the only
        // permitted interval. Keep the existing event/work bound as well.
        let mut cycle_end = elapsed + 8. * 86400.;
        for _ in 0..4096 {
            let at = if frozen || relaxed { 0. } else { time };
            let edge_open = window.is_none_or(|id| match kind {
                SearchKind::Relaxed => true,
                SearchKind::ArriveConservative => false,
                SearchKind::Scoped(scope) | SearchKind::ArriveScoped(scope) => {
                    scope[id as usize].unwrap_or(true)
                }
                _ => clock.is_some_and(|c| self.windows.active(id, Some(c), at)),
            });
            let turn_open = turns.iter().any(|turn| kind.variable(turn.window))
                || self.allowed_turns_at(
                    turns,
                    incoming,
                    outgoing,
                    if matches!(kind, SearchKind::Relaxed | SearchKind::ArriveConservative) {
                        None
                    } else {
                        clock
                    },
                    at,
                );
            if edge_open
                && turn_open
                && let Some(next) = self.next_turn_state_at(
                    state,
                    incoming,
                    node,
                    outgoing,
                    if matches!(kind, SearchKind::ArriveConservative) {
                        None
                    } else {
                        clock
                    },
                    at,
                    kind,
                )
            {
                result.insert(time, next);
                if !variable_state {
                    return Ok(result);
                }
            }
            if relaxed || frozen {
                return Ok(result);
            }
            let Some(clock) = clock else {
                return Ok(result);
            };
            let next = self.movement_next_change(state, incoming, node, outgoing, clock, time);
            let Some(next) = next.filter(|&next| next <= cycle_end) else {
                return Ok(result);
            };
            if clock.offset_changes_at(next)? {
                cycle_end = next + 8. * 86400.;
            }
            time = next;
        }
        Err("Bicycle movement timing exceeded its change limit".into())
    }
    fn movement_next_change(
        &self,
        state: &TurnState,
        incoming: Option<u32>,
        node: u32,
        outgoing: u32,
        clock: BikeClock,
        time: f64,
    ) -> Option<f64> {
        let turns = incoming
            .filter(|&edge| self.attributes[edge as usize] & NODE_TURN != 0)
            .and_then(|edge| self.turns.get(&(node, self.ways[edge as usize])))
            .map_or(&[][..], |turns| &turns[..]);
        let window = (self.attributes[outgoing as usize] & TIMED_EDGE != 0)
            .then(|| self.edge_windows[&outgoing]);
        let starting = incoming
            .filter(|&edge| self.attributes[edge as usize] & WAY_TURN != 0)
            .and_then(|edge| self.way_starts.get(&(node, self.ways[edge as usize])))
            .map_or(&[][..], |ids| &ids[..]);
        turns
            .iter()
            .filter_map(|turn| self.windows.next_change(turn.window, clock, time))
            .chain(window.and_then(|id| self.windows.next_change(id, clock, time)))
            .chain(
                state
                    .iter()
                    .map(|&(id, _, _)| id)
                    .chain(starting.iter().copied())
                    .filter_map(|id| {
                        self.windows
                            .next_change(self.way_turns[id as usize].window, clock, time)
                    }),
            )
            .min_by(f64::total_cmp)
    }
    #[cfg(test)]
    fn next_turn_state(
        &self,
        state: &TurnState,
        incoming: Option<u32>,
        node: u32,
        outgoing: u32,
    ) -> Option<TurnState> {
        self.next_turn_state_at(
            state,
            incoming,
            node,
            outgoing,
            None,
            0.,
            SearchKind::Normal,
        )
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn next_turn_state_at(
        &self,
        state: &TurnState,
        incoming: Option<u32>,
        node: u32,
        outgoing: u32,
        clock: Option<BikeClock>,
        elapsed: f64,
        kind: SearchKind,
    ) -> Option<TurnState> {
        if state.is_empty()
            && incoming.is_none_or(|edge| self.attributes[edge as usize] & WAY_TURN == 0)
        {
            return Some(Vec::new());
        }
        let way = self.ways[outgoing as usize];
        let mut next = Vec::new();
        // Alternatives at one starting junction are OR; overlapping only_*
        // restrictions entered at different junctions must all be satisfied.
        let mut groups: HashMap<(u32, i64, u32), (bool, bool)> = HashMap::new();
        for &(id, step, start) in state {
            let rule = &self.way_turns[id as usize];
            let variable = kind.variable(rule.window);
            let active = !variable && self.windows.active(rule.window, clock, elapsed);
            let next_step = if way == rule.via[step as usize] {
                Some(step)
            } else if rule.via.get(step as usize + 1) == Some(&way) {
                Some(step + 1)
            } else {
                None
            };
            let complete =
                step as usize + 1 == rule.via.len() && way == rule.to && next_step.is_none();
            if !rule.only && complete && active {
                return None;
            }
            // Relaxation removes conditional obligations but must retain their
            // possible completion as an alternative to an unconditional rule.
            if rule.only && (active || (variable && complete)) {
                let entry = groups
                    .entry((start, rule.from, if rule.independent { id + 1 } else { 0 }))
                    .or_default();
                entry.0 |= next_step.is_some() || complete;
                entry.1 |= complete;
            }
            if let Some(step) = next_step {
                next.push((id, step, start));
            }
        }
        if groups.values().any(|&(allowed, _)| !allowed) {
            return None;
        }
        next.retain(|&(id, _, start)| {
            let rule = &self.way_turns[id as usize];
            !rule.only
                || !groups
                    .get(&(start, rule.from, if rule.independent { id + 1 } else { 0 }))
                    .is_some_and(|&(_, complete)| complete)
        });
        if let Some(ids) = incoming
            .filter(|&edge| self.attributes[edge as usize] & WAY_TURN != 0)
            .and_then(|edge| self.way_starts.get(&(node, self.ways[edge as usize])))
        {
            let mut only = false;
            let mut allowed = false;
            for &id in ids {
                let rule = &self.way_turns[id as usize];
                let variable = kind.variable(rule.window);
                let active = !variable && self.windows.active(rule.window, clock, elapsed);
                if rule.independent && active && rule.via[0] != way {
                    return None;
                }
                only |= rule.only && !rule.independent && active;
                if rule.via[0] == way {
                    next.push((id, 0, node));
                    allowed |= rule.only && !rule.independent && (active || variable);
                }
            }
            if only && !allowed {
                return None;
            }
        }
        next.sort_unstable();
        next.dedup();
        Some(next)
    }
    fn stress_exceeded(&self, edge: u32, opt: BikeOptions) -> bool {
        opt.max_lts.is_some_and(|limit| {
            ((self.attributes[edge as usize] >> STRESS_SHIFT) & 7) > u32::from(limit)
        })
    }
    fn allowed_edge(&self, edge: u32, opt: BikeOptions) -> bool {
        !self.stress_exceeded(edge, opt) || self.attributes[edge as usize] & PUSH_ALLOWED != 0
    }
    fn dismount(&self, edge: u32, opt: BikeOptions) -> bool {
        self.attributes[edge as usize] & 128 != 0 || self.stress_exceeded(edge, opt)
    }

    // Seconds and preference cost for one metre. Preference never alters ETA.
    fn metric(&self, edge: u32, opt: BikeOptions) -> (f64, f64) {
        let a = self.attributes[edge as usize];
        if self.dismount(edge, opt) {
            if matches!(opt.profile, Profile::Shortest) {
                return (3.6 / 4.0, SHORTEST_COST_PER_METER);
            }
            return (
                3.6 / 4.0,
                3.6 / 4.0
                    * if matches!(opt.profile, Profile::Fast) {
                        1.
                    } else {
                        2.5
                    },
            );
        }
        let class = (a & 7) as usize;
        let facility = (a >> 3) & 3;
        let surface = ((a >> 5) & 3) as usize;
        let grade = ((a >> 8) & 63) as f64 - 30.;
        let motor_speed = (a >> 14) & 255;
        let speed = (opt.speed_kph * [1., 0.85, 0.65, 0.35][surface] / (1. + grade.max(0.) * 0.12)
            * (1. + (-grade).clamp(0., 8.) * 0.03))
            .clamp(3., 45.);
        let stress = [0., 0.1, 0.05, 0.2, 0.6, 1.1, 1.8, 0.3][class]
            + (motor_speed as f64 - 30.).max(0.) / 80.;
        let stress = stress
            * match facility {
                2 => 0.1,
                1 => 0.45,
                _ => 1.,
            };
        let factor = match opt.profile {
            Profile::Fast => 1.,
            Profile::Balanced => 0.8 + stress + surface as f64 * 0.08,
            Profile::Quiet => 0.8 + stress * 2.5 + surface as f64 * 0.12,
            Profile::Shortest => return (3.6 / speed, SHORTEST_COST_PER_METER),
        };
        let seconds = 3.6 / speed;
        (seconds, seconds * factor)
    }

    fn start_movements(
        &self,
        a: &RoadCandidate,
        meters: f64,
        continuation: Option<&BikeContinuation>,
        clock: Option<BikeClock>,
        kind: SearchKind,
        alternatives: bool,
    ) -> Result<Movements, String> {
        let mut incoming = None;
        let mut state = TurnState::new();
        if let Some(c) = continuation {
            if same_point(c.road, a.road) {
                incoming = c.incoming;
                state = c.state.clone();
                if let Some(edge) = incoming {
                    let node = self.targets[edge as usize];
                    if same_point(c.road, self.point(node)) {
                        // An overlapping but disconnected road is not a junction.
                        if (meters <= 1e-7 && a.node != node)
                            || (meters > 1e-7 && (self.source(a.edge) != node || a.fraction > 1e-7))
                        {
                            return Ok(Movements::default());
                        }
                    } else if a.edge == edge {
                        // This road was entered before the waypoint. Its entry
                        // window and source-node turns must not be applied twice.
                        return Ok(Movements {
                            first: Some((a.walk_seconds, state)),
                            later: vec![],
                        });
                    } else if self.ways[a.edge as usize] == self.ways[edge as usize]
                        && self.source(a.edge) == self.targets[edge as usize]
                        && self.targets[a.edge as usize] == self.source(edge)
                    {
                        // Reversing within an edge checks the new direction's
                        // permission, while retaining the via-way prefix.
                        let mut movements = self.movements(
                            &TurnState::new(),
                            None,
                            self.source(a.edge),
                            a.edge,
                            clock,
                            a.walk_seconds,
                            kind,
                            false,
                        )?;
                        if let Some((_, next)) = &mut movements.first {
                            *next = state;
                        }
                        return Ok(movements);
                    } else {
                        return Ok(Movements::default());
                    }
                }
            } else if c.walk_meters + a.walk_meters < 1. {
                // Rounding or coincident geometry cannot invent a transfer.
                return Ok(Movements::default());
            }
        }
        if meters <= 1e-7 {
            Ok(Movements {
                first: Some((a.walk_seconds, state)),
                later: vec![],
            })
        } else {
            self.movements(
                &state,
                incoming,
                self.source(a.edge),
                a.edge,
                clock,
                a.walk_seconds,
                kind,
                alternatives,
            )
        }
    }

    #[cfg(test)]
    pub fn route(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
    ) -> Result<BikeResult, String> {
        self.route_at(
            origin,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            None,
        )
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub fn route_at(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
    ) -> Result<BikeResult, String> {
        self.route_from(
            origin,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
            None,
            false,
        )
    }

    /// Ordered bicycle segments retain their actual incoming edge and via-way
    /// history. One shared graph is used; no continuation IDs enter the API.
    pub fn route_through(
        &self,
        points: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        mut clock: Option<BikeClock>,
    ) -> Result<Vec<BikeResult>, String> {
        if !(2..=18).contains(&points.len()) {
            return Err("Bicycle routing requires two endpoints and at most 16 via points".into());
        }
        let mut results: Vec<BikeResult> = Vec::with_capacity(points.len() - 1);
        for (i, pair) in points.windows(2).enumerate() {
            let previous = results.last_mut().and_then(|r| r.continuation.take());
            let result = self.route_from(
                pair[0],
                pair[1],
                opt,
                max_walk,
                walk_speed,
                max_distance,
                clock,
                previous.as_ref(),
                i + 2 < points.len(),
            )?;
            let ready = result.status == "ready";
            if let Some(clock) = &mut clock {
                clock.epoch += result
                    .legs
                    .iter()
                    .map(|l| l.seconds + l.wait_before_seconds)
                    .sum::<f64>();
            }
            results.push(result);
            if !ready {
                break;
            }
        }
        Ok(results)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn validate_request(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
    ) -> Result<(), String> {
        opt.validate()?;
        if opt.max_lts.is_some() && !self.stress_prepared {
            return Err("Bicycle traffic stress is not prepared in this City; rebuild from OSM to use bike.maxLts".into());
        }
        if origin
            .into_iter()
            .chain(destination)
            .any(|n| !n.is_finite())
            || origin[0].abs() > 180.
            || destination[0].abs() > 180.
            || origin[1].abs() > 90.
            || destination[1].abs() > 90.
            || !max_walk.is_finite()
            || max_walk < 0.
            || !walk_speed.is_finite()
            || walk_speed <= 0.
            || !max_distance.is_finite()
            || max_distance <= 0.
            || clock.is_some_and(|c| !c.epoch.is_finite())
        {
            return Err("Invalid bicycle routing coordinates or limits".into());
        }
        Ok(())
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn route_from(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        continuation: Option<&BikeContinuation>,
        retain_continuation: bool,
    ) -> Result<BikeResult, String> {
        self.validate_request(
            origin,
            destination,
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
        )?;
        let graph = self.graph();
        let eligible = |edge: u32| {
            (clock.is_some() || self.attributes[edge as usize] & TIMED_EDGE == 0)
                && self.allowed_edge(edge, opt)
        };
        let starts = self.attach_bicycle_matching(
            &graph,
            origin,
            max_walk,
            walk_speed / 3.6,
            true,
            false,
            &eligible,
        )?;
        let ends = self.attach_bicycle_matching(
            &graph,
            destination,
            max_walk,
            walk_speed / 3.6,
            false,
            false,
            &eligible,
        )?;
        let solve = |starts: &Attachment, ends: &Attachment, kind: SearchKind<'_>, bounds| {
            self.search_with_limit(
                origin,
                destination,
                opt,
                starts,
                ends,
                max_distance,
                clock,
                kind,
                bounds,
                continuation,
                retain_continuation,
            )
        };
        let run = |starts: &Attachment,
                   ends: &Attachment,
                   first: Option<BikeResult>|
         -> Result<BikeResult, String> {
            // A static relaxation is a lower bound on the timed optimum. If
            // its path is legal at every actual arrival time, it already solves
            // the dated query without a temporal frontier or clock array.
            if let Some(query_clock) = clock.filter(|_| self.has_timing()) {
                let mut relaxed = match first {
                    Some(result) => result,
                    None => solve(starts, ends, SearchKind::Relaxed, SearchBounds::default())?,
                };
                if relaxed.temporal_valid {
                    return Ok(relaxed);
                }
                // A feasible route bounds the time of every cheaper route,
                // because all preference costs are at least factor * time.
                // Keep windows which can change in that horizon relaxed, but
                // enforce windows that cannot change. An unrelated short
                // window elsewhere in the City must not force every query into
                // a large cost/time frontier.
                let factor = if matches!(opt.profile, Profile::Fast) {
                    1.
                } else {
                    0.8
                };
                let current_scope = self.windows.scope(query_clock, 0.);
                let snapshot = solve(
                    starts,
                    ends,
                    SearchKind::Scoped(&current_scope),
                    SearchBounds::default(),
                )?;
                let work = relaxed.settled_labels + snapshot.settled_labels;
                if snapshot.status == "ready"
                    && snapshot.cost.unwrap() < relaxed.cost.unwrap_or(f64::INFINITY)
                {
                    relaxed = snapshot;
                }
                relaxed.settled_labels = work;
                if let Some(upper) = relaxed.cost.filter(|_| relaxed.status == "ready") {
                    let scope = self
                        .windows
                        .scope(query_clock, upper / factor * (1. + 1e-12));
                    let mut scoped = solve(
                        starts,
                        ends,
                        SearchKind::Scoped(&scope),
                        SearchBounds::default(),
                    )?;
                    let work = relaxed.settled_labels + scoped.settled_labels;
                    if scoped.status == "ready"
                        && scoped.temporal_valid
                        && scoped.cost.unwrap() <= upper
                    {
                        scoped.settled_labels = work;
                        return Ok(scoped);
                    }
                    if scoped.status == "ready" && scoped.cost.unwrap() < upper {
                        relaxed = scoped;
                    }
                    relaxed.settled_labels = work;
                }
                let mut bounds = SearchBounds::default();
                // Earliest arrival has one best arrival per ordinary state.
                // Its duration is a lower bound for every preference profile,
                // including paths which must wait at an unavoidable turn.
                if !matches!(opt.profile, Profile::Fast) {
                    let mut fastest = self.search(
                        origin,
                        destination,
                        opt,
                        starts,
                        ends,
                        max_distance,
                        false,
                        clock,
                        SearchKind::Earliest,
                        SearchBounds::default(),
                        continuation,
                        retain_continuation,
                    )?;
                    if fastest.status != "ready" {
                        fastest.settled_labels += relaxed.settled_labels;
                        return Ok(fastest);
                    }
                    bounds.earliest_arrival = fastest
                        .legs
                        .iter()
                        .map(|leg| leg.seconds + leg.wait_before_seconds)
                        .sum::<f64>()
                        * (1. - 1e-12);
                    let work = relaxed.settled_labels + fastest.settled_labels;
                    if fastest.cost.unwrap() < relaxed.cost.unwrap_or(f64::INFINITY)
                        && fastest.legs.iter().map(|leg| leg.meters).sum::<f64>() <= max_distance
                    {
                        relaxed = fastest;
                    }
                    relaxed.settled_labels = work;
                }
                if relaxed.status == "ready" {
                    bounds.upper_cost = relaxed.cost.unwrap();
                }
                // Every improving path has elapsed time <= cost / min_factor.
                // If no schedule changes in that horizon, its permissions are
                // fixed. A scalar static search is then exact, without a
                // temporal cost/time frontier or reverse-bound scratch.
                let factor = if matches!(opt.profile, Profile::Fast) {
                    1.
                } else {
                    0.8
                };
                let kind = if self
                    .windows
                    .stable_until(query_clock, bounds.upper_cost / factor)
                {
                    SearchKind::Frozen
                } else {
                    SearchKind::Normal
                };
                let mut timed = solve(starts, ends, kind, bounds)?;
                if timed.status != "ready" && relaxed.status == "ready" {
                    relaxed.settled_labels += timed.settled_labels;
                    return Ok(relaxed);
                }
                timed.settled_labels += relaxed.settled_labels;
                Ok(timed)
            } else {
                solve(starts, ends, SearchKind::Normal, SearchBounds::default())
            }
        };
        let first = if clock.is_some() && self.has_timing() {
            let first = solve(&starts, &ends, SearchKind::Relaxed, SearchBounds::default())?;
            if !first.temporal_valid && self.walking.is_none() {
                // A timed restriction can make the nearest connection wait for
                // hours. Admit all permitted endpoint alternatives before the
                // temporal search, rather than treating that wait as success.
                let wider_starts = self.attach_bicycle_fallback(
                    &graph,
                    origin,
                    max_walk,
                    walk_speed / 3.6,
                    true,
                    &eligible,
                )?;
                let wider_ends = self.attach_bicycle_fallback(
                    &graph,
                    destination,
                    max_walk,
                    walk_speed / 3.6,
                    false,
                    &eligible,
                )?;
                if wider_starts.candidates.len() != starts.candidates.len()
                    || wider_ends.candidates.len() != ends.candidates.len()
                {
                    let mut result = run(&wider_starts, &wider_ends, None)?;
                    result.settled_labels += first.settled_labels;
                    return Ok(result);
                }
            }
            Some(first)
        } else {
            None
        };
        let result = run(&starts, &ends, first)?;
        // Weak connectivity does not detect a one-way dead end or a turn-
        // restricted exit. Try the remaining permitted attachments only after
        // the closer candidates fail, preserving successful nearby matches.
        if result.status == "ready"
            || self.walking.is_some()
            || result.reason == Some("no_bike_attachment")
            || ![result.origin_road_meters, result.destination_road_meters]
                .into_iter()
                .flatten()
                .any(|d| max_walk > d + ALTERNATIVE_TOLERANCE_M)
        {
            return Ok(result);
        }
        let wider_starts = self.attach_bicycle_fallback(
            &graph,
            origin,
            max_walk,
            walk_speed / 3.6,
            true,
            &eligible,
        )?;
        let wider_ends = self.attach_bicycle_fallback(
            &graph,
            destination,
            max_walk,
            walk_speed / 3.6,
            false,
            &eligible,
        )?;
        // The full-radius sets contain every initial candidate. Avoid running
        // the same failed graph search again when neither set gains an edge.
        if wider_starts.candidates.len() == starts.candidates.len()
            && wider_ends.candidates.len() == ends.candidates.len()
        {
            return Ok(result);
        }
        let mut fallback = run(&wider_starts, &wider_ends, None)?;
        fallback.settled_labels += result.settled_labels;
        Ok(fallback)
    }

    // Solve the ordinary preference optimum first; retain cost/distance
    // alternatives only when that optimum exceeds the caller's distance cap.
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn search_with_limit(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        starts: &Attachment,
        ends: &Attachment,
        max_distance: f64,
        clock: Option<BikeClock>,
        kind: SearchKind<'_>,
        bounds: SearchBounds,
        continuation: Option<&BikeContinuation>,
        retain_continuation: bool,
    ) -> Result<BikeResult, String> {
        // A straight line longer than the limit needs no unconstrained search.
        let straight_line_over_limit = starts.candidates.len() <= 16
            && ends.candidates.len() <= 16
            && starts.candidates.iter().all(|a| {
                ends.candidates.iter().all(|b| {
                    let (x, y) = (self.point(a.node), self.point(b.node));
                    a.walk_meters
                        + b.walk_meters
                        + vigo_route::geo::haversine_m([x[0], x[1]], [y[0], y[1]])
                            * self.minimum_length_ratio
                            * (1. - 1e-9)
                        > max_distance
                })
            });
        let r = if straight_line_over_limit {
            None
        } else {
            Some(self.search(
                origin,
                destination,
                opt,
                starts,
                ends,
                max_distance,
                false,
                clock,
                kind,
                bounds,
                continuation,
                retain_continuation,
            )?)
        };
        let first_settled = match r {
            Some(r) if r.legs.iter().map(|leg| leg.meters).sum::<f64>() <= max_distance => {
                return Ok(r);
            }
            Some(r) => r.settled_labels,
            None => 0,
        };
        let mut constrained = match self.search(
            origin,
            destination,
            opt,
            starts,
            ends,
            max_distance,
            true,
            clock,
            kind,
            bounds,
            continuation,
            retain_continuation,
        ) {
            Ok(result) => result,
            // Too many trade-offs to prove the best route: a route within the
            // limit still answers the request, and reports what it is.
            Err(error) if error.contains("work limit") => {
                let mut shortest = self.search(
                    origin,
                    destination,
                    BikeOptions {
                        profile: Profile::Shortest,
                        ..opt
                    },
                    starts,
                    ends,
                    max_distance,
                    false,
                    clock,
                    kind,
                    bounds,
                    continuation,
                    retain_continuation,
                )?;
                if shortest.status != "ready"
                    || shortest.legs.iter().map(|leg| leg.meters).sum::<f64>() > max_distance
                {
                    return Err(error);
                }
                shortest.distance_limit_best_found = true;
                shortest
            }
            Err(error) => return Err(error),
        };
        constrained.settled_labels += first_settled;
        Ok(constrained)
    }

    /// Exact remaining metres to the destination, ignoring turns and access,
    /// which can only lower them. A label beyond this bound cannot finish
    /// within the distance limit.
    fn meters_to(&self, ends: &Attachment, max_distance: f64) -> Vec<f64> {
        let mut head = vec![u32::MAX; self.lons.len()];
        let mut next = vec![u32::MAX; self.targets.len()];
        for (edge, &node) in self.targets.iter().enumerate() {
            next[edge] = head[node as usize];
            head[node as usize] = edge as u32;
        }
        let mut meters = vec![f64::INFINITY; self.lons.len()];
        let mut queue = BinaryHeap::new();
        for i in 0..ends.candidates.len() {
            let b = ends.candidate(&self.graph(), i);
            let value = b.walk_meters + b.drive_meters;
            if value <= max_distance && value < meters[b.node as usize] {
                meters[b.node as usize] = value;
                queue.push(Queue(value, b.node as usize));
            }
        }
        while let Some(Queue(value, node)) = queue.pop() {
            if value > meters[node] {
                continue;
            }
            let mut edge = head[node];
            while edge != u32::MAX {
                let source = self.source(edge) as usize;
                let candidate = value + self.distances[edge as usize] as f64 / 100.;
                if candidate <= max_distance && candidate < meters[source] {
                    meters[source] = candidate;
                    queue.push(Queue(candidate, source));
                }
                edge = next[edge as usize];
            }
        }
        meters
    }

    // A dated search may retain cost/time alternatives. An exact lower bound
    // on remaining static cost keeps those alternatives near a useful route.
    // Ignore turns and destination-only permissions here: relaxing constraints
    // can only lower the bound. The reverse links are temporary, not another
    // resident graph or one graph per bicycle preference.
    fn costs_to(&self, ends: &Attachment, opt: BikeOptions, excess: bool) -> Vec<f64> {
        let wait_factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let edge_cost = |edge, meters| {
            let (seconds, cost) = self.metric(edge, opt);
            meters
                * if excess {
                    (cost - wait_factor * seconds).max(0.)
                } else {
                    cost
                }
        };
        let mut head = vec![u32::MAX; self.lons.len()];
        let mut next = vec![u32::MAX; self.targets.len()];
        for (edge, &node) in self.targets.iter().enumerate() {
            next[edge] = head[node as usize];
            head[node as usize] = edge as u32;
        }
        let mut costs = vec![f64::INFINITY; self.lons.len()];
        let mut queue = BinaryHeap::new();
        for i in 0..ends.candidates.len() {
            let b = ends.candidate(&self.graph(), i);
            let cost = b.walk_seconds * if excess { 1. - wait_factor } else { 1. }
                + edge_cost(b.edge, b.drive_meters);
            if cost < costs[b.node as usize] {
                costs[b.node as usize] = cost;
                queue.push(Queue(cost, b.node as usize));
            }
        }
        while let Some(Queue(cost, node)) = queue.pop() {
            if cost > costs[node] {
                continue;
            }
            let mut edge = head[node];
            while edge != u32::MAX {
                let source = self.source(edge) as usize;
                let candidate = cost + edge_cost(edge, self.distances[edge as usize] as f64 / 100.);
                if candidate < costs[source] {
                    costs[source] = candidate;
                    queue.push(Queue(candidate, source));
                }
                edge = next[edge as usize];
            }
        }
        costs
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    fn search(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        starts: &Attachment,
        ends: &Attachment,
        max_distance: f64,
        constrained: bool,
        clock: Option<BikeClock>,
        kind: SearchKind,
        search_bounds: SearchBounds,
        continuation: Option<&BikeContinuation>,
        retain_continuation: bool,
    ) -> Result<BikeResult, String> {
        let priced_opt = opt;
        let earliest = matches!(kind, SearchKind::Earliest);
        let relaxed = kind.relaxed();
        let frozen = matches!(kind, SearchKind::Frozen);
        let opt = if earliest {
            BikeOptions {
                profile: Profile::Fast,
                ..opt
            }
        } else {
            opt
        };
        let clock = clock.filter(|_| self.has_timing());
        let timed = clock.is_some() && !relaxed && !frozen;
        // Waiting has the same preference cost as the least-penalized cycling
        // second. Circling cannot make waiting cheaper or defeat dominance.
        let wait_factor = if matches!(opt.profile, Profile::Fast) {
            1.
        } else {
            0.8
        };
        let max_distance = if constrained {
            max_distance
        } else {
            f64::INFINITY
        };
        let mut result = BikeResult {
            status: "blocked",
            reason: Some("no_path"),
            legs: vec![],
            cost: None,
            end_wait_seconds: 0.,
            settled_labels: 0,
            origin_road_meters: starts.nearest_meters,
            destination_road_meters: ends.nearest_meters,
            unsupported_restrictions: self.unsupported_restrictions,
            timing_policy: if clock.is_some() {
                if self.edge_windows.is_empty() {
                    if self.timed_way_turns {
                        "dated_turns"
                    } else {
                        "dated_node_turns"
                    }
                } else {
                    "dated_roads_and_turns"
                }
            } else {
                "conservative"
            },
            temporal_valid: true,
            continuation: None,
            max_lts: opt.max_lts,
            distance_limit_best_found: false,
        };
        if starts.candidates.is_empty() || ends.candidates.is_empty() {
            result.reason = Some("no_bike_attachment");
            return Ok(result);
        }
        if !starts.candidates.iter().any(|a| {
            ends.candidates
                .iter()
                .any(|b| self.index.connected_nodes(a.node, b.node))
        }) {
            return Ok(result);
        }
        let destination_access: HashSet<u32> = starts
            .candidates
            .iter()
            .chain(&ends.candidates)
            .filter(|c| self.attributes[c.edge as usize] & (1 << 22) != 0)
            .map(|c| self.destination_components[self.source(c.edge) as usize])
            .collect();
        let mut best = search_bounds.upper_cost;
        let end_ids: Vec<usize> = (0..ends.candidates.len()).collect();
        let by_node = (end_ids.len() > 16).then(|| {
            let mut index = HashMap::<u32, Vec<usize>>::new();
            for &i in &end_ids {
                index.entry(ends.candidates[i].node).or_default().push(i);
            }
            index
        });
        let ending = |node| {
            by_node.as_ref().map_or(&end_ids[..], |index| {
                index.get(&node).map_or(&[][..], Vec::as_slice)
            })
        };
        // (label, start candidate, end candidate); None means a same-edge path.
        let mut winner: Option<(Option<usize>, usize, usize)> = None;
        let mut winner_wait = 0.;
        for i in 0..starts.candidates.len() {
            let a = starts.candidate(&self.graph(), i);
            for &j in ending(self.source(a.edge)) {
                let b = ends.candidate(&self.graph(), j);
                if a.edge == b.edge && b.fraction >= a.fraction {
                    let meters =
                        (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.;
                    let Some((departure, _)) = self
                        .start_movements(&a, meters, continuation, clock, kind, false)?
                        .first
                    else {
                        continue;
                    };
                    let cost = a.walk_seconds
                        + b.walk_seconds
                        + meters * self.metric(a.edge, opt).1
                        + (departure - a.walk_seconds) * wait_factor;
                    if meters + a.walk_meters + b.walk_meters <= max_distance && cost < best {
                        best = cost;
                        winner = Some((None, i, j));
                        winner_wait = departure - a.walk_seconds;
                    }
                }
            }
        }
        // Every graph edge costs at least 0.8 / 45 km/h per physical metre.
        // Account for quantized lengths, and aim at the destination's graph
        // attachment nodes (ignoring its nonnegative final partial edge).
        // Triangle inequality then makes this an admissible A* lower bound.
        let mut end_nodes: Vec<u32> = ends.candidates.iter().map(|b| b.node).collect();
        end_nodes.sort_unstable();
        end_nodes.dedup();
        let bounds = (end_nodes.len() > 16)
            .then(|| TargetBounds::new(end_nodes.iter().map(|&node| self.point(node))));
        // Over the distance limit, cost and distance labels multiply across a
        // City unless both are bounded. If no start can reach the destination
        // within the limit, no route exists and no label search is needed.
        let remaining_meters = constrained.then(|| self.meters_to(ends, max_distance));
        let can_finish = |node: u32, meters: f64| {
            remaining_meters
                .as_ref()
                .is_none_or(|bound| meters + bound[node as usize] * (1. - 1e-12) <= max_distance)
        };
        if winner.is_none()
            && !starts.candidates.iter().enumerate().any(|(i, _)| {
                let a = starts.candidate(&self.graph(), i);
                can_finish(a.node, a.walk_meters + a.drive_meters)
            })
        {
            return Ok(result);
        }
        let remaining_cost = (timed || constrained).then(|| self.costs_to(ends, opt, false));
        let remaining_excess =
            (timed && search_bounds.earliest_arrival > 0.).then(|| self.costs_to(ends, opt, true));
        let heuristic = |node: u32| {
            if let Some(costs) = &remaining_cost {
                return costs[node as usize] * (1. - 1e-12);
            }
            bounds.as_ref().map_or_else(
                || {
                    end_nodes
                        .iter()
                        .map(|&end| {
                            vigo_route::geo::haversine_m(
                                [self.lons[node as usize], self.lats[node as usize]],
                                [self.lons[end as usize], self.lats[end as usize]],
                            )
                        })
                        .fold(f64::INFINITY, f64::min)
                },
                |bounds| bounds.meters(self.point(node)),
            ) * self.minimum_length_ratio
                * (0.8 * 3.6 / (opt.speed_kph * 1.24).clamp(3., 45.))
                * (1. - 1e-12)
        };
        let mut labels = Vec::<Label>::new();
        // Only temporal searches allocate arrival clocks.
        // Ordinary bicycle labels and their retained graph remain unchanged.
        let mut arrivals = Vec::<f64>::new();
        let mut frontier = HashMap::<(u32, Option<u32>, u32), Vec<usize>>::new();
        let mut states = vec![TurnState::new()];
        let mut state_ids = HashMap::from([(TurnState::new(), 0u32)]);
        let mut queue = BinaryHeap::new();
        // Small urban graphs use direct query-local slots for ordinary states.
        // Cap these two scratch arrays at 3 MiB; large graphs stay sparse.
        // No workspace is retained or multiplied by bicycle preference.
        let dense = !constrained && !timed && self.lons.len() <= 262_144;
        let mut direct = vec![u32::MAX; if dense { self.lons.len() } else { 0 }];
        let mut lower_bounds = vec![f64::NAN; direct.len()];
        // Timed labels store excess cost above wait_factor * elapsed, built
        // from nonnegative edge penalties. This makes temporal dominance a
        // direct comparison, without subtracting large nearly equal clocks or
        // preserving cycling loops because of floating-point cancellation.
        // Distance remains a separate resource for constrained searches.
        let mut insert = |label: Label,
                          elapsed: f64,
                          labels: &mut Vec<Label>,
                          arrivals: &mut Vec<f64>,
                          frontier: &mut HashMap<(u32, Option<u32>, u32), Vec<usize>>,
                          queue: &mut BinaryHeap<Queue>| {
            let turn_incoming = label
                .incoming()
                .filter(|&edge| self.attributes[edge as usize] & (NODE_TURN | WAY_TURN) != 0);
            let id = labels.len();
            if dense && turn_incoming.is_none() && label.state == 0 {
                let previous = direct[label.node as usize];
                if previous != u32::MAX {
                    if labels[previous as usize].cost <= label.cost {
                        return;
                    }
                    labels[previous as usize].active = false;
                }
                direct[label.node as usize] = id as u32;
            } else {
                let known = frontier
                    .entry((label.node, turn_incoming, label.state))
                    .or_default();
                if known.iter().any(|&i| {
                    (!timed || arrivals[i] <= elapsed)
                        && labels[i].cost <= label.cost
                        && (!constrained || labels[i].meters <= label.meters)
                }) {
                    return;
                }
                known.retain(|&i| {
                    let keep = !((!timed || elapsed <= arrivals[i])
                        && label.cost <= labels[i].cost
                        && (!constrained || label.meters <= labels[i].meters));
                    if !keep {
                        labels[i].active = false;
                    }
                    keep
                });
                known.push(id);
            }
            let bound = if dense {
                let entry = &mut lower_bounds[label.node as usize];
                if entry.is_nan() {
                    *entry = heuristic(label.node);
                }
                *entry
            } else {
                heuristic(label.node)
            };
            let remaining = if timed {
                (wait_factor * elapsed + bound).max(
                    wait_factor * search_bounds.earliest_arrival
                        + remaining_excess
                            .as_ref()
                            .map_or(0., |costs| costs[label.node as usize] * (1. - 1e-12)),
                )
            } else {
                bound
            };
            queue.push(Queue(label.cost + remaining, id));
            labels.push(label);
            if timed {
                arrivals.push(elapsed);
            }
        };
        for i in 0..starts.candidates.len() {
            let a = starts.candidate(&self.graph(), i);
            let meters = a.walk_meters + a.drive_meters;
            let (seconds_per_meter, cost_per_meter) = self.metric(a.edge, opt);
            for (departure, state) in self
                .start_movements(&a, a.drive_meters, continuation, clock, kind, true)?
                .into_iter()
            {
                let state = if state.is_empty() {
                    0
                } else {
                    *state_ids.entry(state.clone()).or_insert_with(|| {
                        let id = states.len() as u32;
                        states.push(state);
                        id
                    })
                };
                let elapsed = departure + a.drive_meters * seconds_per_meter;
                let cost = if timed {
                    a.walk_seconds * (1. - wait_factor)
                        + a.drive_meters
                            * (cost_per_meter - wait_factor * seconds_per_meter).max(0.)
                } else {
                    a.walk_seconds + a.drive_meters * cost_per_meter
                };
                if meters <= max_distance
                    && can_finish(a.node, meters)
                    && cost + if timed { wait_factor * elapsed } else { 0. } < best
                {
                    insert(
                        Label {
                            node: a.node,
                            incoming: if a.drive_meters > 1e-7 {
                                a.edge
                            } else {
                                continuation
                                    .filter(|c| same_point(c.road, a.road))
                                    .and_then(|c| c.incoming)
                                    .unwrap_or(u32::MAX)
                            },
                            state,
                            cost,
                            meters,
                            parent: u32::MAX,
                            start: i as u32,
                            active: true,
                        },
                        elapsed,
                        &mut labels,
                        &mut arrivals,
                        &mut frontier,
                        &mut queue,
                    );
                }
            }
        }
        while let Some(Queue(cost, id)) = queue.pop() {
            if cost >= best {
                break;
            }
            if !labels[id].active {
                continue;
            }
            result.settled_labels += 1;
            if labels.len()
                > if timed {
                    262_144
                } else if constrained {
                    MAX_CONSTRAINED_LABELS
                } else {
                    2_000_000
                }
            {
                return Err(if timed {
                    "Dated bicycle search exceeded its 262144-label work limit; shorten the route or distance limit"
                } else {
                    "Bicycle search exceeded its two-million-label work limit; shorten the route or distance limit"
                }.into());
            }
            let label = labels[id];
            let elapsed = if timed { arrivals[id] } else { 0. };
            for &j in ending(label.node) {
                let b = ends.candidate(&self.graph(), j);
                if b.node != label.node {
                    continue;
                }
                let departure = if b.drive_meters > 1e-7 {
                    let Some((time, _)) = self
                        .movements(
                            &states[label.state as usize],
                            label.incoming(),
                            label.node,
                            b.edge,
                            clock,
                            elapsed,
                            kind,
                            false,
                        )?
                        .first
                    else {
                        continue;
                    };
                    time
                } else {
                    elapsed
                };
                let cost = label.cost
                    + if timed { wait_factor * departure } else { 0. }
                    + b.walk_seconds
                    + b.drive_meters * self.metric(b.edge, opt).1;
                if label.meters + b.walk_meters + b.drive_meters <= max_distance && cost < best {
                    best = cost;
                    winner = Some((Some(id), label.start as usize, j));
                    winner_wait = departure - elapsed;
                }
            }
            for edge in self.offsets[label.node as usize]..self.offsets[label.node as usize + 1] {
                if !self.allowed_edge(edge, opt) {
                    continue;
                }
                if self.attributes[edge as usize] & (1 << 22) != 0
                    && !destination_access
                        .contains(&self.destination_components[label.node as usize])
                {
                    continue;
                }
                let movements = self.movements(
                    &states[label.state as usize],
                    label.incoming(),
                    label.node,
                    edge,
                    clock,
                    elapsed,
                    kind,
                    true,
                )?;
                for (departure, state) in movements.into_iter() {
                    let state = if state.is_empty() {
                        0
                    } else {
                        *state_ids.entry(state.clone()).or_insert_with(|| {
                            let id = states.len() as u32;
                            states.push(state);
                            id
                        })
                    };
                    let distance = self.distances[edge as usize] as f64 / 100.;
                    let (seconds_per_meter, cost_per_meter) = self.metric(edge, opt);
                    let next_elapsed = departure + distance * seconds_per_meter;
                    let cost = label.cost
                        + distance
                            * if timed {
                                (cost_per_meter - wait_factor * seconds_per_meter).max(0.)
                            } else {
                                cost_per_meter
                            };
                    let meters = label.meters + distance;
                    if cost
                        + if timed {
                            wait_factor * next_elapsed
                        } else {
                            0.
                        }
                        >= best
                        || meters > max_distance
                        || !can_finish(self.targets[edge as usize], meters)
                    {
                        continue;
                    }
                    insert(
                        Label {
                            node: self.targets[edge as usize],
                            incoming: edge,
                            state,
                            cost,
                            meters,
                            parent: id as u32,
                            start: label.start,
                            active: true,
                        },
                        next_elapsed,
                        &mut labels,
                        &mut arrivals,
                        &mut frontier,
                        &mut queue,
                    );
                }
            }
        }
        let Some((label, start, end)) = winner else {
            return Ok(result);
        };
        let a = starts.candidate(&self.graph(), start);
        let b = ends.candidate(&self.graph(), end);
        let mut parts = Vec::new();
        if let Some(mut id) = label {
            let mut middle = Vec::new();
            while labels[id].parent != u32::MAX {
                let parent = labels[id].parent;
                let edge = labels[id].incoming().unwrap();
                let wait = if timed {
                    (arrivals[id]
                        - arrivals[parent as usize]
                        - self.distances[edge as usize] as f64 / 100. * self.metric(edge, opt).0)
                        .max(0.)
                } else {
                    0.
                };
                middle.push((edge, if wait < 1e-7 { 0. } else { wait }));
                id = parent as usize;
            }
            let start_wait = if timed {
                (arrivals[id] - a.walk_seconds - a.drive_meters * self.metric(a.edge, opt).0)
                    .max(0.)
            } else {
                0.
            };
            parts.push((
                a.edge,
                a.drive_meters,
                a.road,
                self.point(a.node),
                if start_wait < 1e-7 { 0. } else { start_wait },
            ));
            for (edge, wait) in middle.into_iter().rev() {
                parts.push((
                    edge,
                    self.distances[edge as usize] as f64 / 100.,
                    self.point(self.source(edge)),
                    self.point(self.targets[edge as usize]),
                    wait,
                ));
            }
            parts.push((
                b.edge,
                b.drive_meters,
                self.point(b.node),
                b.road,
                winner_wait,
            ));
        } else {
            parts.push((
                a.edge,
                (b.fraction - a.fraction) * self.distances[a.edge as usize] as f64 / 100.,
                a.road,
                b.road,
                winner_wait,
            ));
        }
        // An arrival certificate prices the same static relaxation, then checks
        // its full edge/turn history at a departure derived from the deadline.
        // It is a proof only when replay adds no waiting and rejects no move.
        let replay_clock = if matches!(
            kind,
            SearchKind::ArriveScoped(_) | SearchKind::ArriveConservative
        ) {
            clock.map(|c| BikeClock {
                epoch: c.epoch
                    - a.walk_seconds
                    - b.walk_seconds
                    - parts
                        .iter()
                        .map(|&(edge, meters, _, _, _)| meters * self.metric(edge, opt).0)
                        .sum::<f64>(),
                ..c
            })
        } else {
            clock
        };
        if relaxed || retain_continuation {
            let mut elapsed = a.walk_seconds;
            let mut incoming = continuation
                .filter(|c| same_point(c.road, a.road))
                .and_then(|c| c.incoming);
            let mut state = continuation
                .filter(|c| same_point(c.road, a.road))
                .map_or_else(TurnState::new, |c| c.state.clone());
            let mut first = a.drive_meters > 1e-7 || label.is_none();
            for (edge, meters, _, _, wait) in &mut parts {
                if *meters < 1e-7 {
                    continue;
                }
                let movement = if first {
                    let mut start = a;
                    start.walk_seconds += if relaxed { 0. } else { *wait };
                    self.start_movements(
                        &start,
                        *meters,
                        continuation,
                        replay_clock,
                        SearchKind::Normal,
                        false,
                    )?
                    .first
                } else {
                    self.movements(
                        &state,
                        incoming,
                        self.source(*edge),
                        *edge,
                        replay_clock,
                        elapsed + if relaxed { 0. } else { *wait },
                        SearchKind::Normal,
                        false,
                    )?
                    .first
                };
                let Some((departure, next)) = movement else {
                    result.temporal_valid = false;
                    return Ok(result);
                };
                if relaxed {
                    *wait = departure - elapsed;
                    result.temporal_valid &= *wait == 0.;
                    best += *wait * wait_factor;
                }
                elapsed = departure + *meters * self.metric(*edge, opt).0;
                incoming = Some(*edge);
                state = next;
                first = false;
            }
            if retain_continuation {
                result.continuation = Some(BikeContinuation {
                    incoming,
                    state,
                    road: b.road,
                    walk_meters: b.walk_meters,
                });
            }
        }
        if earliest {
            let factor = if matches!(priced_opt.profile, Profile::Fast) {
                1.
            } else {
                0.8
            };
            best = a.walk_seconds
                + b.walk_seconds
                + parts
                    .iter()
                    .map(|&(edge, meters, _, _, wait)| {
                        meters * self.metric(edge, priced_opt).1 + wait * factor
                    })
                    .sum::<f64>();
        }
        let legs = self.path_legs(origin, destination, opt, a, b, parts)?;
        result.status = "ready";
        result.reason = None;
        result.cost = Some(best);
        result.legs = legs;
        Ok(result)
    }
    fn path_legs(
        &self,
        origin: [f64; 2],
        destination: [f64; 2],
        opt: BikeOptions,
        a: RoadCandidate,
        b: RoadCandidate,
        parts: Vec<BicyclePathPart>,
    ) -> Result<Vec<BikeLeg>, String> {
        let mut legs = Vec::new();
        fn gap(legs: &mut Vec<BikeLeg>, candidate: RoadCandidate, from: [f64; 2], to: [f64; 2]) {
            if candidate.walk_meters > 1e-6 {
                legs.push(BikeLeg {
                    kind: "walk",
                    seconds: candidate.walk_seconds,
                    meters: candidate.walk_meters,
                    coordinates: vec![from, to],
                    source: "coordinate-snap",
                    verified: false,
                    wait_before_seconds: 0.,
                });
            }
        }
        if let Some(walk) = self
            .walking
            .as_ref()
            .map(|w| w.legs(self, origin, a, true))
            .transpose()?
            .flatten()
        {
            legs.extend(walk);
        } else {
            gap(&mut legs, a, origin, a.road);
        }
        for (edge, meters, from, to, wait_before_seconds) in parts {
            if meters < 1e-7 {
                continue;
            }
            let kind = if self.dismount(edge, opt) {
                "walk"
            } else {
                "bike"
            };
            let source = if kind == "walk" {
                if self.attributes[edge as usize] & 128 != 0 {
                    "osm-dismount"
                } else {
                    "osm-low-stress"
                }
            } else {
                "osm"
            };
            let seconds = meters * self.metric(edge, opt).0;
            if let Some(last) = legs.last_mut().filter(|leg| {
                leg.source == source
                    && leg.kind == kind
                    && leg.verified
                    && wait_before_seconds == 0.
            }) {
                last.seconds += seconds;
                last.meters += meters;
                last.coordinates.push(to);
            } else {
                legs.push(BikeLeg {
                    kind,
                    seconds,
                    meters,
                    coordinates: vec![from, to],
                    source,
                    verified: true,
                    wait_before_seconds,
                });
            }
        }
        if let Some(walk) = self
            .walking
            .as_ref()
            .map(|w| w.legs(self, destination, b, false))
            .transpose()?
            .flatten()
        {
            legs.extend(walk);
        } else {
            gap(&mut legs, b, b.road, destination);
        }
        if legs.is_empty() {
            legs.push(BikeLeg {
                kind: "bike",
                seconds: 0.,
                meters: 0.,
                wait_before_seconds: 0.,
                coordinates: vec![origin, destination],
                source: "osm",
                verified: true,
            });
        }
        Ok(legs)
    }
}

#[cfg(feature = "node")]
mod node {
    use super::*;
    use napi_derive::napi;
    #[napi(js_name = "BikeKernel")]
    pub struct NativeBikeKernel(BikeKernel);
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Request {
        origin: [f64; 2],
        destination: [f64; 2],
        #[serde(default)]
        via: Vec<[f64; 2]>,
        #[serde(default)]
        bike: BikeOptions,
        max_walk_meters: f64,
        walking_speed_kph: f64,
        max_distance_meters: f64,
        clock: Option<ClockRequest>,
        #[serde(default)]
        arrive_by: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ClockRequest {
        service_date: String,
        time_zone: String,
        seconds: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MatrixRequest {
        origins: Vec<[f64; 2]>,
        destinations: Vec<[f64; 2]>,
        #[serde(default)]
        bike: BikeOptions,
        max_walk_meters: f64,
        walking_speed_kph: f64,
        max_distance_meters: f64,
        clock: Option<ClockRequest>,
        #[serde(default)]
        arrive_by: bool,
    }
    #[napi]
    impl NativeBikeKernel {
        #[napi(constructor)]
        pub fn new(path: String) -> napi::Result<Self> {
            BikeKernel::open(&path)
                .map(Self)
                .map_err(napi::Error::from_reason)
        }
        #[napi]
        pub fn matrix(&self, request: String) -> napi::Result<String> {
            let q: MatrixRequest = serde_json::from_str(&request)
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            let clock = q
                .clock
                .map(|c| BikeClock::service(&c.service_date, &c.time_zone, c.seconds))
                .transpose()
                .map_err(napi::Error::from_reason)?;
            let result = self
                .0
                .matrix(
                    &q.origins,
                    &q.destinations,
                    q.bike,
                    q.max_walk_meters,
                    q.walking_speed_kph,
                    q.max_distance_meters,
                    clock,
                    q.arrive_by,
                    None,
                )
                .map_err(napi::Error::from_reason)?;
            serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
        }
        #[napi]
        pub fn route_through(&self, request: String) -> napi::Result<String> {
            let q: Request = serde_json::from_str(&request)
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            let clock = q
                .clock
                .map(|c| BikeClock::service(&c.service_date, &c.time_zone, c.seconds))
                .transpose()
                .map_err(napi::Error::from_reason)?;
            let points: Vec<_> = std::iter::once(q.origin)
                .chain(q.via)
                .chain([q.destination])
                .collect();
            let r = self
                .0
                .route_through(
                    &points,
                    q.bike,
                    q.max_walk_meters,
                    q.walking_speed_kph,
                    q.max_distance_meters,
                    clock.filter(|_| !q.arrive_by),
                )
                .map_err(napi::Error::from_reason)?;
            serde_json::to_string(&r).map_err(|e| napi::Error::from_reason(e.to_string()))
        }
        #[napi]
        pub fn route(&self, request: String) -> napi::Result<String> {
            let q: Request = serde_json::from_str(&request)
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            if !q.via.is_empty() {
                return Err(napi::Error::from_reason(
                    "Use routeThrough for ordered bicycle points",
                ));
            }
            let clock = q
                .clock
                .map(|c| BikeClock::service(&c.service_date, &c.time_zone, c.seconds))
                .transpose()
                .map_err(napi::Error::from_reason)?;
            let route = if q.arrive_by {
                BikeKernel::route_arrive_at
            } else {
                BikeKernel::route_at
            };
            let r = route(
                &self.0,
                q.origin,
                q.destination,
                q.bike,
                q.max_walk_meters,
                q.walking_speed_kph,
                q.max_distance_meters,
                clock,
            )
            .map_err(napi::Error::from_reason)?;
            serde_json::to_string(&r).map_err(|e| napi::Error::from_reason(e.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    pub(super) fn fixture(
        nodes: &[[f64; 2]],
        edges: &[(u32, u32, u32, i64, u32)],
        turns: &[(u32, i64, i64, u8)],
    ) -> BikeKernel {
        fixture_rules(nodes, edges, turns, &[])
    }
    fn fixture_rules(
        nodes: &[[f64; 2]],
        edges: &[(u32, u32, u32, i64, u32)],
        turns: &[(u32, i64, i64, u8)],
        ways: &[(i64, &str, i64, u8)],
    ) -> BikeKernel {
        fixture_extra(nodes, edges, turns, ways, "")
    }
    fn fixture_extra(
        nodes: &[[f64; 2]],
        edges: &[(u32, u32, u32, i64, u32)],
        turns: &[(u32, i64, i64, u8)],
        ways: &[(i64, &str, i64, u8)],
        extra: &str,
    ) -> BikeKernel {
        let path = std::env::temp_dir().join(format!(
            "vigo-bike-{}-{}.sqlite",
            std::process::id(),
            NEXT.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('bikeProfileVersion','1');
            CREATE TABLE bike_nodes(node_id INTEGER PRIMARY KEY,lon_e7 INTEGER,lat_e7 INTEGER);
            CREATE TABLE bike_edges(from_node INTEGER,to_node INTEGER,distance_cm INTEGER,way_id INTEGER,attributes INTEGER);
            CREATE TABLE bike_turns(via_node INTEGER,from_way INTEGER,to_way INTEGER,only_turn INTEGER);
            CREATE TABLE bike_way_turns(from_way INTEGER,via_ways TEXT,to_way INTEGER,only_turn INTEGER);").unwrap();
        for (i, n) in nodes.iter().enumerate() {
            db.execute(
                "INSERT INTO bike_nodes VALUES(?,?,?)",
                rusqlite::params![
                    i as u32,
                    (n[0] * 1e7).round() as i64,
                    (n[1] * 1e7).round() as i64
                ],
            )
            .unwrap();
        }
        for e in edges {
            db.execute(
                "INSERT INTO bike_edges VALUES(?,?,?,?,?)",
                rusqlite::params![e.0, e.1, e.2, e.3, e.4],
            )
            .unwrap();
        }
        for t in turns {
            db.execute(
                "INSERT INTO bike_turns VALUES(?,?,?,?)",
                rusqlite::params![t.0, t.1, t.2, t.3],
            )
            .unwrap();
        }
        for t in ways {
            db.execute(
                "INSERT INTO bike_way_turns VALUES(?,?,?,?)",
                rusqlite::params![t.0, t.1, t.2, t.3],
            )
            .unwrap();
        }
        db.execute_batch(extra).unwrap();
        drop(db);
        // Remove the store before unwrapping, so fixtures that are meant to
        // be rejected leave nothing behind in the temp directory.
        let kernel = BikeKernel::open(path.to_str().unwrap());
        std::fs::remove_file(path).unwrap();
        kernel.unwrap()
    }
    const CYCLE: u32 = (30 << 8) | (15 << 14) | (2 << 3);
    const MAJOR: u32 = (30 << 8) | (80 << 14) | 6;
    const TIMED_WAY_20: &str = "
        INSERT INTO metadata VALUES('bikeEdgeWindowVersion','1');
        CREATE TABLE bike_timed_edges AS SELECT *,1 AS window_id FROM bike_edges WHERE way_id=20;
        DELETE FROM bike_edges WHERE way_id=20;
        CREATE TABLE bike_edge_windows(window_id INTEGER,start_minute INTEGER,end_minute INTEGER);
        INSERT INTO bike_edge_windows VALUES(1,481,483);";

    const STRESS_COLUMNS: &str = "INSERT INTO metadata VALUES('bikeStressVersion','1');
        ALTER TABLE bike_edges ADD COLUMN stress INTEGER NOT NULL DEFAULT 9;";

    #[test]
    fn requests_cannot_select_the_internal_shortest_profile() {
        for profile in ["fast", "balanced", "quiet"] {
            assert!(serde_json::from_value::<Profile>(serde_json::json!(profile)).is_ok());
        }
        assert!(serde_json::from_value::<Profile>(serde_json::json!("shortest")).is_err());
    }

    #[test]
    fn stress_ceiling_selects_legal_cycling_detours_or_pushing_without_changing_default() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let edges = [
            (0, 1, 10000, 10, CYCLE),
            (1, 2, 10000, 20, CYCLE),
            (0, 3, 25000, 30, CYCLE),
            (3, 2, 25000, 30, CYCLE),
        ];
        for can_push in [false, true] {
            let sql = format!(
                "{STRESS_COLUMNS} UPDATE bike_edges SET stress={} WHERE way_id=20;
                UPDATE bike_edges SET stress=10 WHERE way_id=30;",
                if can_push { 12 } else { 4 }
            );
            let k = fixture_extra(&nodes, &edges, &[], &[], &sql);
            for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
                for (max_lts, expected) in [
                    (None, 40.),
                    (Some(4), 40.),
                    (Some(2), 100.),
                    (Some(1), if can_push { 110. } else { 450. }),
                ] {
                    let opt = BikeOptions {
                        profile,
                        max_lts,
                        ..Default::default()
                    };
                    let r = k.route(nodes[0], nodes[2], opt, 0., 4.8, 1000.).unwrap();
                    assert_eq!(r.status, "ready");
                    assert!(
                        (seconds(&r) - expected).abs() < 1e-7,
                        "limit={max_lts:?} push={can_push} seconds={}",
                        seconds(&r)
                    );
                    assert_eq!(
                        r.legs.iter().any(|l| l.source == "osm-low-stress"),
                        max_lts == Some(1)
                    );
                    let many = k
                        .many_from(
                            nodes[0],
                            &[nodes[1], nodes[2], [0.0015, 0.]],
                            opt,
                            0.,
                            4.8,
                            1000.,
                            None,
                            1000.,
                        )
                        .unwrap();
                    assert!((many.seconds[1] - seconds(&r)).abs() < 1e-7);
                    for (i, target) in [nodes[1], nodes[2], [0.0015, 0.]].into_iter().enumerate() {
                        let point = k.route(nodes[0], target, opt, 0., 4.8, 1000.).unwrap();
                        if point.status == "ready" {
                            assert!((many.seconds[i] - seconds(&point)).abs() < 1e-7);
                        } else {
                            assert!(many.seconds[i].is_infinite());
                        }
                    }
                    let middle = k.route([0.0015, 0.], nodes[2], opt, 0., 4.8, 200.).unwrap();
                    if max_lts == Some(1) || max_lts == Some(2) {
                        if can_push {
                            assert!((seconds(&middle) - 45.).abs() < 1e-7)
                        } else {
                            assert_eq!(middle.status, "blocked")
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn stress_and_required_dismount_legs_retain_their_distinct_reasons() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.]];
        let edges = [(0, 1, 10000, 10, CYCLE | 128), (1, 2, 10000, 20, CYCLE)];
        let sql = format!("{STRESS_COLUMNS} UPDATE bike_edges SET stress=12 WHERE way_id=20;");
        let k = fixture_extra(&nodes, &edges, &[], &[], &sql);
        let opt = BikeOptions {
            max_lts: Some(1),
            ..Default::default()
        };
        let r = k.route(nodes[0], nodes[2], opt, 0., 4.8, 1000.).unwrap();
        assert_eq!(r.status, "ready");
        assert_eq!(
            r.legs.iter().map(|l| l.source).collect::<Vec<_>>(),
            vec!["osm-dismount", "osm-low-stress"]
        );
        assert!((seconds(&r) - 180.).abs() < 1e-7);
    }

    #[test]
    fn stress_data_is_optional_validated_and_never_fabricated_for_old_cities() {
        let nodes = [[0., 0.], [0.001, 0.]];
        let edges = [(0, 1, 10000, 10, CYCLE)];
        let k = fixture(&nodes, &edges, &[]);
        assert_eq!(
            k.route(nodes[0], nodes[1], BikeOptions::default(), 0., 4.8, 1000.)
                .unwrap()
                .status,
            "ready"
        );
        let error = k
            .route(
                nodes[0],
                nodes[1],
                BikeOptions {
                    max_lts: Some(2),
                    ..Default::default()
                },
                0.,
                4.8,
                1000.,
            )
            .unwrap_err();
        assert!(error.contains("rebuild from OSM"));
        for value in ["null", "0", "5", "1.5", "\"2\""] {
            let parsed = serde_json::from_str::<BikeOptions>(&format!("{{\"maxLts\":{value}}}"));
            assert!(parsed.is_err() || parsed.unwrap().validate().is_err());
        }
        for stress in [0, 5, 7, 8, 13, 16, 255] {
            let sql = format!("{STRESS_COLUMNS} UPDATE bike_edges SET stress={stress};");
            assert!(
                std::panic::catch_unwind(|| fixture_extra(&nodes, &edges, &[], &[], &sql)).is_err(),
                "stress={stress}"
            );
        }
    }

    #[test]
    fn stress_pushing_uses_actual_clock_and_preserves_ordered_turn_history() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.003, 0.]];
        let sql=format!("{STRESS_COLUMNS} UPDATE bike_edges SET stress=12 WHERE way_id=20;
            INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
            CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
            INSERT INTO bike_turn_windows VALUES(1,1,480,482);");
        let k = fixture_extra(
            &nodes,
            &[
                (0, 1, 10000, 10, CYCLE),
                (1, 2, 10000, 20, CYCLE),
                (2, 3, 10000, 30, CYCLE),
            ],
            &[],
            &[(10, "[20]", 30, 0)],
            &sql,
        );
        let opt = BikeOptions {
            profile: Profile::Fast,
            max_lts: Some(1),
            ..Default::default()
        };
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap());
        let r = k
            .route_at(nodes[0], nodes[3], opt, 0., 4.8, 1000., clock)
            .unwrap();
        assert!((seconds(&r) - 130.).abs() < 1e-7);
        assert!((r.legs.iter().map(|l| l.wait_before_seconds).sum::<f64>() - 10.).abs() < 1e-7);
        let parts = k
            .route_through(
                &[nodes[0], [0.0015, 0.], nodes[3]],
                opt,
                0.,
                4.8,
                1000.,
                clock,
            )
            .unwrap();
        assert!(parts.iter().all(|r| r.status == "ready"));
        assert!(
            (parts
                .iter()
                .flat_map(|r| &r.legs)
                .map(|l| l.seconds + l.wait_before_seconds)
                .sum::<f64>()
                - 140.)
                .abs()
                < 1e-7
        );
    }

    #[test]
    fn ordered_points_preserve_node_and_via_history_at_junctions_and_mid_edges() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.003, 0.]];
        let edges = [
            (0, 1, 10000, 10, CYCLE),
            (1, 2, 10000, 20, CYCLE),
            (2, 3, 10000, 30, CYCLE),
        ];
        for timed in [false, true] {
            for node_turn in [false, true] {
                let sql = if timed {
                    format!("INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
                    CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
                    INSERT INTO bike_turn_windows VALUES({},1,480,482);", if node_turn {0} else {1})
                } else {
                    String::new()
                };
                let k = fixture_extra(
                    &nodes,
                    &edges,
                    if node_turn { &[(1, 10, 20, 0)] } else { &[] },
                    if node_turn {
                        &[]
                    } else {
                        &[(10, "[20]", 30, 0)]
                    },
                    &sql,
                );
                for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
                    let opt = BikeOptions {
                        profile,
                        ..Default::default()
                    };
                    let clock =
                        Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap());
                    let direct = k
                        .route_at(nodes[0], nodes[3], opt, 0., 4.8, 1000., clock)
                        .unwrap();
                    for via in [
                        vec![nodes[1]],
                        vec![nodes[2]],
                        vec![[0.0005, 0.]],
                        vec![[0.0015, 0.]],
                        vec![[0.0025, 0.]],
                        vec![nodes[1], nodes[1], nodes[2]],
                        vec![[0.0005, 0.], [0.0015, 0.], [0.0025, 0.]],
                    ] {
                        let points: Vec<_> = std::iter::once(nodes[0])
                            .chain(via)
                            .chain([nodes[3]])
                            .collect();
                        let parts = k
                            .route_through(&points, opt, 0., 4.8, 1000., clock)
                            .unwrap();
                        assert_eq!(
                            parts.last().unwrap().status,
                            direct.status,
                            "timed={timed} node={node_turn} points={points:?}"
                        );
                        if timed {
                            assert_eq!(parts.len(), points.len() - 1);
                            let duration = |r: &BikeResult| {
                                r.legs
                                    .iter()
                                    .map(|l| l.seconds + l.wait_before_seconds)
                                    .sum::<f64>()
                            };
                            assert!(
                                (parts.iter().map(duration).sum::<f64>() - duration(&direct)).abs()
                                    < 1e-6,
                                "points={points:?} durations={:?}",
                                parts.iter().map(duration).collect::<Vec<_>>()
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn ordered_only_via_turns_preserve_obligations_after_inactive_entry() {
        let nodes = [
            [0., 0.],
            [0.001, 0.],
            [0.002, 0.],
            [0.003, 0.],
            [0.002, 0.001],
        ];
        let k=fixture_extra(&nodes,&[(0,1,10000,10,CYCLE),(1,2,10000,20,CYCLE),
            (2,3,10000,30,CYCLE),(2,4,10000,40,CYCLE)],&[],&[(10,"[20]",30,3)],
            "INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
             CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
             INSERT INTO bike_turn_windows VALUES(1,1,480,482);");
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        for clock in [
            None,
            Some(BikeClock::service("2026-11-02", "America/New_York", 28770.).unwrap()),
        ] {
            let direct = k
                .route_at(nodes[0], nodes[4], opt, 0., 4.8, 1000., clock)
                .unwrap();
            for waypoint in [nodes[1], nodes[2], [0.0015, 0.]] {
                let parts = k
                    .route_through(&[nodes[0], waypoint, nodes[4]], opt, 0., 4.8, 1000., clock)
                    .unwrap();
                assert_eq!(parts.last().unwrap().status, direct.status);
                if clock.is_some() {
                    let total = |r: &BikeResult| {
                        r.legs
                            .iter()
                            .map(|l| l.seconds + l.wait_before_seconds)
                            .sum::<f64>()
                    };
                    assert!((parts.iter().map(total).sum::<f64>() - total(&direct)).abs() < 1e-7);
                }
            }
        }
    }

    #[test]
    fn ordered_mid_edge_reversal_uses_the_reverse_direction() {
        let nodes = [[0., 0.], [0.001, 0.]];
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        for reverse in [false, true] {
            let mut edges = vec![(0, 1, 10000, 10, CYCLE)];
            if reverse {
                edges.push((1, 0, 10000, 10, CYCLE));
            }
            let k = fixture(&nodes, &edges, &[]);
            let parts = k
                .route_through(
                    &[nodes[0], [0.0005, 0.], nodes[0]],
                    opt,
                    0.,
                    4.8,
                    1000.,
                    None,
                )
                .unwrap();
            assert_eq!(
                parts.last().unwrap().status,
                if reverse { "ready" } else { "blocked" }
            );
            if reverse {
                assert!((parts.iter().map(seconds).sum::<f64>() - 20.).abs() < 1e-7);
            }
        }
    }

    #[test]
    fn ordered_mid_edge_continuation_does_not_reenter_a_closed_road() {
        let nodes = [[0., 0.], [0.001, 0.]];
        let k = fixture_extra(&nodes, &[(0, 1, 60000, 20, CYCLE)], &[], &[], TIMED_WAY_20);
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28970.).unwrap());
        let parts = k
            .route_through(
                &[nodes[0], [0.0005, 0.], [0.0005, 0.], nodes[1]],
                opt,
                0.,
                4.8,
                1000.,
                clock,
            )
            .unwrap();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|r| r.status == "ready"));
        assert!(
            (parts
                .iter()
                .flat_map(|r| &r.legs)
                .map(|l| l.seconds + l.wait_before_seconds)
                .sum::<f64>()
                - 120.)
                .abs()
                < 1e-7
        );
    }

    #[test]
    fn ordered_points_do_not_transfer_between_disconnected_coincident_roads() {
        let nodes = [[0., 0.], [0.001, 0.], [0.001, 0.], [0.002, 0.]];
        let k = fixture(
            &nodes,
            &[(0, 1, 10000, 10, CYCLE), (2, 3, 10000, 20, CYCLE)],
            &[],
        );
        let parts = k
            .route_through(
                &[nodes[0], nodes[1], nodes[3]],
                BikeOptions::default(),
                0.,
                4.8,
                1000.,
                None,
            )
            .unwrap();
        assert_eq!(parts.last().unwrap().status, "blocked");
    }

    #[test]
    fn dated_edges_use_entry_time_at_all_endpoint_positions_and_keep_static_routes() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let k = fixture_extra(
            &nodes,
            &[
                (0, 1, 10000, 10, CYCLE),
                (1, 2, 10000, 20, CYCLE),
                (0, 3, 10000, 30, CYCLE),
                (3, 2, 20000, 30, CYCLE),
            ],
            &[],
            &[],
            TIMED_WAY_20,
        );
        let clock =
            |seconds| Some(BikeClock::service("2026-11-02", "America/New_York", seconds).unwrap());
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        let total = |r: &BikeResult| {
            r.legs
                .iter()
                .map(|l| l.seconds + l.wait_before_seconds)
                .sum::<f64>()
        };
        let undated = k.route(nodes[0], nodes[2], opt, 0., 4.8, 1000.).unwrap();
        assert!((total(&undated) - 60.).abs() < 1e-8);
        let detour = k
            .route_at(nodes[0], nodes[2], opt, 0., 4.8, 1000., clock(28800.))
            .unwrap();
        assert!((total(&detour) - 60.).abs() < 1e-8);
        let wait = k
            .route_at(nodes[0], nodes[2], opt, 0., 4.8, 250., clock(28800.))
            .unwrap();
        assert!((total(&wait) - 80.).abs() < 1e-8);
        assert_eq!(wait.timing_policy, "dated_roads_and_turns");
        let enter = k
            .route_at(nodes[0], nodes[2], opt, 0., 4.8, 1000., clock(28950.))
            .unwrap();
        assert!(
            (total(&enter) - 40.).abs() < 1e-8,
            "An edge entered before closing can be completed"
        );
        let too_late = k
            .route_at(nodes[0], nodes[2], opt, 0., 4.8, 1000., clock(28970.))
            .unwrap();
        assert!((total(&too_late) - 60.).abs() < 1e-8);
        let partial = [0.0015, 0.];
        let same_edge = k
            .route_at(partial, nodes[2], opt, 0., 4.8, 1000., clock(28800.))
            .unwrap();
        assert!((total(&same_edge) - 70.).abs() < 1e-7);
        assert!((same_edge.legs[0].wait_before_seconds - 60.).abs() < 1e-7);
        let finish = k
            .route_at(nodes[0], partial, opt, 0., 4.8, 1000., clock(28800.))
            .unwrap();
        assert!((total(&finish) - 70.).abs() < 1e-7);
        assert_eq!(
            k.route(partial, nodes[2], opt, 0., 4.8, 1000.)
                .unwrap()
                .status,
            "blocked"
        );
    }

    #[test]
    fn turn_and_edge_windows_must_be_open_together() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.]];
        let mut k = fixture_extra(
            &nodes,
            &[(0, 1, 10000, 10, CYCLE), (1, 2, 10000, 20, CYCLE)],
            &[(1, 10, 20, 0)],
            &[],
            TIMED_WAY_20,
        );
        k.windows.schedules.push(vec![(481, 482)]);
        let id = k.windows.schedules.len() as u32;
        k.turns.get_mut(&(1, 10)).unwrap()[0].window = id;
        k.timed_node_turns = true;
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap());
        let r = k
            .route_at(
                nodes[0],
                nodes[2],
                Default::default(),
                0.,
                4.8,
                1000.,
                clock,
            )
            .unwrap();
        assert_eq!(r.status, "ready");
        assert!(
            (r.legs
                .iter()
                .map(|l| l.seconds + l.wait_before_seconds)
                .sum::<f64>()
                - 140.)
                .abs()
                < 1e-8
        );
        k.windows.schedules[id as usize - 1] = vec![(480, 484)];
        assert_eq!(
            k.route_at(
                nodes[0],
                nodes[2],
                Default::default(),
                0.,
                4.8,
                1000.,
                clock
            )
            .unwrap()
            .status,
            "blocked"
        );
    }

    #[test]
    fn conditional_dismount_and_cycling_variants_can_wait_for_the_better_entry() {
        let nodes = [[0., 0.], [0.001, 0.]];
        let extra = format!("{TIMED_WAY_20}
            UPDATE bike_timed_edges SET attributes=attributes | 128;
            DELETE FROM bike_edge_windows;
            INSERT INTO bike_edge_windows VALUES(1,480,540),(2,0,480),(2,540,10080);
            INSERT INTO bike_timed_edges SELECT from_node,to_node,distance_cm,way_id,attributes & ~128,2 FROM bike_timed_edges;");
        let k = fixture_extra(&nodes, &[(0, 1, 10000, 20, CYCLE)], &[], &[], &extra);
        let run = |time| {
            k.route_at(
                nodes[0],
                nodes[1],
                Default::default(),
                0.,
                4.8,
                1000.,
                Some(BikeClock::service("2026-11-02", "America/New_York", time).unwrap()),
            )
            .unwrap()
        };
        let walk = run(28800.);
        assert_eq!(walk.legs[0].kind, "walk");
        assert!((walk.legs[0].seconds - 90.).abs() < 1e-8);
        let bike = run(32399.);
        assert_eq!(bike.legs[0].kind, "bike");
        assert!((bike.legs[0].wait_before_seconds - 1.).abs() < 1e-8);
        assert!((bike.legs[0].seconds - 20.).abs() < 1e-8);
    }
    fn route(
        k: &BikeKernel,
        from: [f64; 2],
        to: [f64; 2],
        profile: Profile,
        limit: f64,
    ) -> BikeResult {
        k.route(
            from,
            to,
            BikeOptions {
                profile,
                ..Default::default()
            },
            0.,
            4.8,
            limit,
        )
        .unwrap()
    }
    fn distance(r: &BikeResult) -> f64 {
        r.legs.iter().map(|l| l.meters).sum()
    }
    fn seconds(r: &BikeResult) -> f64 {
        r.legs.iter().map(|l| l.seconds).sum()
    }
    fn time_turns(k: &mut BikeKernel) {
        k.windows.schedules = vec![vec![(480, 482)]];
        k.timed_node_turns = true;
        for turns in k.turns.values_mut() {
            for turn in turns {
                turn.window = 1;
            }
        }
    }

    #[test]
    fn dated_turns_use_junction_arrival_and_keep_waiting_separate() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let edges = [
            (0, 1, 10000, 10, CYCLE),
            (1, 2, 10000, 20, CYCLE),
            (1, 3, 10000, 30, MAJOR),
            (3, 2, 10000, 30, MAJOR),
        ];
        let mut k = fixture(&nodes, &edges, &[(1, 10, 20, 0)]);
        time_turns(&mut k);
        let fast = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        let clock =
            |seconds| Some(BikeClock::service("2026-11-02", "America/New_York", seconds).unwrap());
        let before = k
            .route_at(nodes[0], nodes[2], fast, 0., 4.8, 1000., clock(28760.))
            .unwrap();
        assert_eq!(before.status, "ready");
        assert!((seconds(&before) - 40.).abs() < 1e-8);
        let detour = k
            .route_at(nodes[0], nodes[2], fast, 0., 4.8, 1000., clock(28790.))
            .unwrap();
        assert!((seconds(&detour) - 60.).abs() < 1e-8);
        assert!(detour.legs[0].coordinates.contains(&nodes[3]));
        let wait = k
            .route_at(nodes[0], nodes[2], fast, 0., 4.8, 250., clock(28790.))
            .unwrap();
        assert_eq!(wait.status, "ready");
        assert!((distance(&wait) - 200.).abs() < 1e-8);
        assert_eq!(wait.legs.len(), 2);
        assert!((wait.legs[1].wait_before_seconds - 110.).abs() < 1e-8);
        assert!((seconds(&wait) - 40.).abs() < 1e-8);
        assert!((wait.cost.unwrap() - 150.).abs() < 1e-8);
        let quiet = k
            .route_at(
                nodes[0],
                nodes[2],
                BikeOptions::default(),
                0.,
                4.8,
                1000.,
                clock(28790.),
            )
            .unwrap();
        assert!((quiet.cost.unwrap() - 120.).abs() < 1e-8);
        assert!(
            (quiet
                .legs
                .iter()
                .map(|l| l.wait_before_seconds)
                .sum::<f64>()
                - 110.)
                .abs()
                < 1e-8
        );
        let boundary = k
            .route_at(nodes[0], nodes[2], fast, 0., 4.8, 1000., clock(28900.))
            .unwrap();
        assert!((seconds(&boundary) - 40.).abs() < 1e-8);
        assert_eq!(
            boundary
                .legs
                .iter()
                .map(|l| l.wait_before_seconds)
                .sum::<f64>(),
            0.
        );
        assert_eq!(std::mem::size_of::<NodeTurn>(), 16);
        assert_eq!(std::mem::size_of::<Label>(), 40);
    }

    #[test]
    fn shared_departures_certify_wider_roads_after_proving_primary_absence() {
        let nodes = [[0., 0.], [0.01, 0.], [0.01, 0.0007], [0.011, 0.0007]];
        let k = fixture(
            &nodes,
            &[
                (0, 1, 111195, 1, CYCLE),
                (2, 3, 11120, 2, CYCLE),
                // Same weak component, but only an outgoing connection.
                (2, 1, 7784, 3, CYCLE),
            ],
            &[],
        );
        let dated = BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap();
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            for clock in [None, Some(dated)] {
                for radius in [50., 100.] {
                    let point = k
                        .route_at(nodes[0], nodes[2], opt, radius, 4.8, 10000., clock)
                        .unwrap();
                    if radius == 100. {
                        assert_eq!(point.status, "ready");
                        assert!((280. ..282.).contains(&point.elapsed_seconds()));
                    } else {
                        assert_ne!(point.status, "ready");
                    }
                    for cutoff in [120., 500.] {
                        let shared = k
                            .many_from(
                                nodes[0],
                                &[nodes[2]],
                                opt,
                                radius,
                                4.8,
                                10000.,
                                clock,
                                cutoff,
                            )
                            .unwrap();
                        let expected =
                            if point.status == "ready" && point.elapsed_seconds() <= cutoff {
                                point.elapsed_seconds()
                            } else {
                                f64::INFINITY
                            };
                        assert!(
                            shared.seconds[0] == expected
                                || (shared.seconds[0] - expected).abs() < 1e-7
                        );
                        assert_eq!(
                            shared.fallback_targets, 0,
                            "A disconnected nearest road must not repeat a point search"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn shared_departure_cutoff_does_not_authorize_a_faster_wider_match() {
        let nodes = [[0., 0.], [0.01, 0.01], [0.02, 0.], [0.02, 0.0005]];
        let k = fixture(
            &nodes,
            &[
                (0, 1, 160000, 1, CYCLE),
                (1, 2, 160000, 2, CYCLE),
                (0, 3, 222400, 3, CYCLE),
            ],
            &[],
        );
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            let point = k.route(nodes[0], nodes[2], opt, 100., 4.8, 10000.).unwrap();
            assert_eq!(point.status, "ready");
            assert!((point.elapsed_seconds() - 640.).abs() < 1e-7);
            // The farther road would fit the cutoff, but a valid primary path
            // keeps the point router on the nearest attachment, even when long.
            let closer_in_time = k.route(nodes[0], nodes[3], opt, 100., 4.8, 10000.).unwrap();
            assert!(closer_in_time.elapsed_seconds() + 42. < 500.);
            for cutoff in [500., 1000.] {
                let shared = k
                    .many_from(nodes[0], &[nodes[2]], opt, 100., 4.8, 10000., None, cutoff)
                    .unwrap();
                assert_eq!(
                    shared.seconds[0],
                    if cutoff < 640. { f64::INFINITY } else { 640. }
                );
                assert_eq!(shared.fallback_targets, 0);
            }
        }
    }

    #[test]
    fn shared_departure_widening_rechecks_destination_access() {
        let nodes = [
            [0., 0.],
            [0.003, 0.],
            [0.007, 0.],
            [0.01, 0.],
            [0.01, 0.0007],
            [0.011, 0.0007],
            [0.005, 0.005],
        ];
        let k = fixture(
            &nodes,
            &[
                (0, 1, 33400, 1, CYCLE),
                (1, 2, 44500, 2, CYCLE | (1 << 22)),
                (2, 3, 33400, 3, CYCLE),
                (0, 6, 79000, 4, CYCLE),
                (6, 3, 79000, 5, CYCLE),
                (4, 5, 11120, 6, CYCLE),
                (4, 3, 7784, 7, CYCLE),
            ],
            &[],
        );
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            let point = k.route(nodes[0], nodes[4], opt, 100., 4.8, 10000.).unwrap();
            assert_eq!(point.status, "ready");
            assert!(point.elapsed_seconds() > 300.);
            assert!(
                point
                    .legs
                    .iter()
                    .any(|leg| leg.coordinates.contains(&nodes[6]))
            );
            let shared = k
                .many_from(nodes[0], &[nodes[4]], opt, 100., 4.8, 10000., None, 500.)
                .unwrap();
            assert!((shared.seconds[0] - point.elapsed_seconds()).abs() < 1e-7);
            assert_eq!(
                shared.fallback_targets, 1,
                "A private shortcut in the relaxed tree must not become a certificate"
            );
        }
    }

    #[test]
    fn bounded_windows_preserve_useful_waits_and_ignore_unrelated_changes() {
        let nodes = [
            [0., 0.],
            [0.001, 0.001],
            [0.002, 0.],
            [1., 1.],
            [1.001, 1.],
            [0.0005, -0.001],
            [0.0015, -0.001],
        ];
        let mut k = fixture(
            &nodes,
            &[
                (0, 2, 10000, 1, CYCLE),
                (0, 1, 100000, 2, CYCLE),
                (1, 2, 100000, 3, CYCLE),
                (3, 4, 10000, 4, CYCLE),
                // This short path is destination-only in the middle. Neither
                // endpoint grants it, including during shared dated searches.
                (0, 5, 10000, 5, CYCLE),
                (5, 6, 10000, 6, CYCLE | (1 << 22)),
                (6, 2, 10000, 7, CYCLE),
            ],
            &[],
        );
        k.windows.schedules = vec![vec![(540, 1440)], vec![(0, 481)]];
        for (way, window) in [(1, 1), (4, 2)] {
            let edge = k.ways.iter().position(|&w| w == way).unwrap();
            k.attributes[edge] |= TIMED_EDGE;
            k.edge_windows.insert(edge as u32, window);
        }
        let clock = BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap();
        assert!(!k.windows.stable_until(clock, 400.));
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let options = BikeOptions {
                profile,
                ..Default::default()
            };
            let route = k
                .route_at(nodes[0], nodes[2], options, 0., 4.8, 10000., Some(clock))
                .unwrap();
            assert_eq!(route.status, "ready");
            assert!((seconds(&route) - 400.).abs() < 1e-7);
            assert_eq!(
                route
                    .legs
                    .iter()
                    .map(|l| l.wait_before_seconds)
                    .sum::<f64>(),
                0.
            );
            assert!(route.legs.iter().any(|l| l.coordinates.contains(&nodes[1])));
            let many = k
                .many_from(
                    nodes[0],
                    &[nodes[2], nodes[1], nodes[2]],
                    options,
                    0.,
                    4.8,
                    10000.,
                    Some(clock),
                    500.,
                )
                .unwrap();
            assert_eq!(many.seconds, vec![400., 200., 400.]);
            assert_eq!(
                many.scoped_trees, 3,
                "An attachment proof, snapshot and window group serve both waiting targets"
            );
            assert_eq!(many.attachment_certificates, 2);
            assert_eq!(many.fallback_targets, 0);
        }
        // Opening within the improving-path horizon must remain available:
        // waiting is now cheaper than the open detour.
        k.windows.schedules[0] = vec![(481, 1440)];
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let route = k
                .route_at(
                    nodes[0],
                    nodes[2],
                    BikeOptions {
                        profile,
                        ..Default::default()
                    },
                    0.,
                    4.8,
                    10000.,
                    Some(clock),
                )
                .unwrap();
            assert_eq!(route.status, "ready");
            assert!((seconds(&route) - 20.).abs() < 1e-7);
            assert!(
                (route
                    .legs
                    .iter()
                    .map(|l| l.wait_before_seconds)
                    .sum::<f64>()
                    - 60.)
                    .abs()
                    < 1e-7
            );
            let many = k
                .many_from(
                    nodes[0],
                    &[nodes[2], nodes[1], nodes[2]],
                    BikeOptions {
                        profile,
                        ..Default::default()
                    },
                    0.,
                    4.8,
                    10000.,
                    Some(clock),
                    500.,
                )
                .unwrap();
            assert_eq!(many.seconds, vec![80., 200., 80.]);
            assert_eq!(
                many.fallback_targets, 2,
                "Useful waits still use the exact temporal search"
            );
        }
        // A legal equal-cost alternative prevents a proof that every original
        // optimum requires waiting. Preserve the point router's tie decision.
        for way in [2, 3] {
            let edge = k.ways.iter().position(|&w| w == way).unwrap();
            k.distances[edge] = 5000;
        }
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let options = BikeOptions {
                profile,
                ..Default::default()
            };
            let route = k
                .route_at(nodes[0], nodes[2], options, 0., 4.8, 10000., Some(clock))
                .unwrap();
            let many = k
                .many_from(
                    nodes[0],
                    &[nodes[2]],
                    options,
                    0.,
                    4.8,
                    10000.,
                    Some(clock),
                    500.,
                )
                .unwrap();
            assert!((seconds(&route) - 20.).abs() < 1e-7);
            assert_eq!(many.seconds, vec![20.]);
            assert!(many.scoped_trees > 0);
            assert_eq!(many.attachment_certificates, 0);
        }
    }

    #[test]
    fn dated_shared_fields_keep_destination_permissions_separate() {
        let nodes = [
            [0., 0.],
            [0.001, 0.001],
            [0.002, 0.],
            [0.0016, -0.0008],
            [0.0019, -0.0008],
            [0.002, 0.002],
        ];
        let mut k = fixture(
            &nodes,
            &[
                (0, 2, 10000, 1, CYCLE),
                (0, 1, 100000, 2, CYCLE),
                (1, 2, 100000, 3, CYCLE),
                (0, 3, 10000, 4, CYCLE),
                (3, 4, 10000, 5, CYCLE | (1 << 22)),
                (4, 2, 10000, 6, CYCLE),
                (2, 5, 10000, 7, CYCLE),
            ],
            &[],
        );
        k.windows.schedules = vec![vec![(540, 1440)]];
        let gate = k.ways.iter().position(|&w| w == 1).unwrap();
        k.attributes[gate] |= TIMED_EDGE;
        k.edge_windows.insert(gate as u32, 1);
        let clock = BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap();
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            // The wider destination can reach the private component; the
            // origin cannot. The other destination grants no such permission.
            let point = k
                .route_at(nodes[0], nodes[2], opt, 120., 4.8, 10000., Some(clock))
                .unwrap();
            assert!((seconds(&point) - 60.).abs() < 1e-7);
            let other = k
                .route_at(nodes[0], nodes[5], opt, 120., 4.8, 10000., Some(clock))
                .unwrap();
            assert!((seconds(&other) - 420.).abs() < 1e-7);
            let many = k
                .many_from(
                    nodes[0],
                    &[nodes[2], nodes[5], nodes[2], nodes[5]],
                    opt,
                    120.,
                    4.8,
                    10000.,
                    Some(clock),
                    500.,
                )
                .unwrap();
            assert_eq!(many.seconds, vec![60., 420., 60., 420.]);
            assert_eq!(many.fallback_targets, 0);
            assert_eq!(many.access_groups, 2);
            assert!(many.access_group_key_bytes <= 512 * 1024);
            // A one-off permission set still uses the exact point path.
            let single = k
                .many_from(
                    nodes[0],
                    &[nodes[2]],
                    opt,
                    120.,
                    4.8,
                    10000.,
                    Some(clock),
                    500.,
                )
                .unwrap();
            assert_eq!(single.seconds, vec![60.]);
            assert_eq!(single.fallback_targets, 1);
            // Shrinking the endpoint radius removes that permission; the
            // group must not retain it from another request or destination.
            let restricted = k
                .many_from(
                    nodes[0],
                    &[nodes[2], nodes[2]],
                    opt,
                    0.,
                    4.8,
                    10000.,
                    Some(clock),
                    500.,
                )
                .unwrap();
            assert_eq!(restricted.seconds, vec![400., 400.]);
        }
    }

    #[test]
    fn shared_arrivals_keep_node_turn_alternatives_and_same_edge_paths() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let k = fixture(
            &nodes,
            &[
                (0, 1, 10000, 1, CYCLE),
                (1, 2, 10000, 2, CYCLE),
                (1, 3, 10000, 3, CYCLE),
                (3, 2, 10000, 4, CYCLE),
            ],
            &[(1, 1, 2, 0)],
        );
        for clock in [
            None,
            Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap()),
        ] {
            let result = k
                .many_to(
                    &[nodes[0], nodes[1], nodes[2]],
                    nodes[2],
                    Default::default(),
                    0.,
                    4.8,
                    1000.,
                    clock,
                    100.,
                    None,
                )
                .unwrap();
            assert_eq!(result.seconds, vec![60., 20., 0.]);
            assert_eq!(result.fallback_targets, 0);
        }
        let k = fixture(&nodes[..2], &[(0, 1, 10000, 1, CYCLE)], &[]);
        let result = k
            .many_to(
                &[[0.00025, 0.], [0.0009, 0.]],
                [0.00075, 0.],
                Default::default(),
                0.,
                4.8,
                1000.,
                None,
                100.,
                None,
            )
            .unwrap();
        assert!((result.seconds[0] - 10.).abs() < 1e-7);
        assert!(result.seconds[1].is_infinite());
        assert_eq!(result.fallback_targets, 0);
    }

    #[test]
    fn shared_arrivals_keep_each_origins_destination_permissions() {
        let nodes = [
            [0., 0.],
            [0.001, 0.],
            [0.002, 0.],
            [0.003, 0.],
            [0.004, 0.],
            [0.005, 0.],
            [0.002, 0.002],
        ];
        let private = CYCLE | (1 << 22);
        let k = fixture(
            &nodes,
            &[
                (0, 1, 10000, 1, CYCLE),
                (1, 2, 10000, 2, private),
                (2, 3, 10000, 3, private),
                (3, 4, 10000, 4, private),
                (4, 5, 10000, 5, CYCLE),
                (0, 6, 50000, 6, CYCLE),
                (6, 5, 50000, 7, CYCLE),
            ],
            &[],
        );
        let before = k.heap_bytes();
        let result = k
            .many_to(
                &[nodes[2], nodes[0], nodes[2], nodes[0]],
                nodes[5],
                Default::default(),
                0.,
                4.8,
                10000.,
                None,
                300.,
                None,
            )
            .unwrap();
        assert_eq!(result.seconds, vec![60., 200., 60., 200.]);
        assert_eq!(result.certified_targets, 2);
        assert_eq!(result.fallback_reasons.get("destination_access"), Some(&2));
        assert_eq!(k.heap_bytes(), before);
    }

    #[test]
    fn shared_arrival_duration_ties_use_the_point_policy() {
        let nodes = [[0., 0.], [0.001, 0.001], [0.001, -0.001], [0.002, 0.]];
        let residential = (30 << 8) | (30 << 14) | 1;
        let k = fixture(
            &nodes,
            &[
                (0, 1, 4500, 1, CYCLE),
                (1, 3, 4500, 2, CYCLE),
                (0, 2, 4000, 3, residential),
                (2, 3, 4000, 4, residential),
            ],
            &[],
        );
        let point = k
            .route_arrive_at(nodes[0], nodes[3], Default::default(), 0., 4.8, 1000., None)
            .unwrap();
        let result = k
            .many_to(
                &[nodes[0]],
                nodes[3],
                Default::default(),
                0.,
                4.8,
                1000.,
                None,
                100.,
                None,
            )
            .unwrap();
        assert_eq!(result.seconds, vec![point.elapsed_seconds()]);
        assert_eq!(result.fallback_reasons.get("duration_tie"), Some(&1));
    }

    #[test]
    fn arrival_certificates_use_actual_node_and_road_entry_times() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.]];
        let edges = [(0, 1, 10000, 1, CYCLE), (1, 2, 10000, 2, CYCLE)];
        let mut k = fixture(&nodes, &edges, &[(1, 1, 2, 0)]);
        time_turns(&mut k);
        k.windows.schedules = vec![vec![(480, 540)]];
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let options = BikeOptions {
                profile,
                ..Default::default()
            };
            for (arrival, ready) in [
                (28819.75, true),
                (28820., false),
                (32419.75, false),
                (32420., true),
                (36000., true),
            ] {
                let clock = BikeClock::service("2026-11-02", "America/New_York", arrival).unwrap();
                let r = k
                    .route_arrive_at(nodes[0], nodes[2], options, 0., 4.8, 1000., Some(clock))
                    .unwrap();
                assert_eq!(r.status, "ready", "{profile:?}, {arrival}");
                {
                    assert_eq!(r.end_wait_seconds == 0., ready);
                    assert_eq!(r.timing_policy, "dated_arrive_by_verified");
                    assert!((seconds(&r) - 40.).abs() < 1e-7);
                    assert!(r.legs.iter().all(|l| l.wait_before_seconds == 0.));
                    let forward = k
                        .route_at(
                            nodes[0],
                            nodes[2],
                            options,
                            0.,
                            4.8,
                            1000.,
                            Some(BikeClock {
                                epoch: clock.epoch - r.elapsed_seconds(),
                                ..clock
                            }),
                        )
                        .unwrap();
                    let factor = if matches!(profile, Profile::Fast) {
                        1.
                    } else {
                        0.8
                    };
                    assert!(
                        (r.cost.unwrap() - forward.cost.unwrap() - factor * r.end_wait_seconds)
                            .abs()
                            < 1e-6
                    );
                }
            }
        }
        let mut road = fixture(&nodes, &edges, &[]);
        road.windows.schedules = vec![vec![(480, 540)]];
        let edge = road.ways.iter().position(|&w| w == 1).unwrap();
        road.attributes[edge] |= TIMED_EDGE;
        road.edge_windows.insert(edge as u32, 1);
        for (arrival, ready) in [(32430., true), (32440., false)] {
            let clock = BikeClock::service("2026-11-02", "America/New_York", arrival).unwrap();
            let r = road
                .route_arrive_at(
                    nodes[0],
                    nodes[2],
                    Default::default(),
                    0.,
                    4.8,
                    1000.,
                    Some(clock),
                )
                .unwrap();
            assert_eq!(r.status, "ready");
            assert_eq!(r.end_wait_seconds == 0., ready);
            assert_eq!(seconds(&r), 40.);
        }
    }

    #[test]
    fn arrival_certificate_replays_conditional_via_history() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.003, 0.], [0.004, 0.]];
        let edges = [
            (0, 1, 10000, 10, CYCLE),
            (1, 2, 10000, 20, CYCLE),
            (2, 3, 10000, 30, CYCLE),
            (3, 4, 10000, 40, CYCLE),
        ];
        for kind in [0, 3] {
            let mut k = fixture_rules(
                &nodes,
                &edges,
                &[],
                &[(10, "[20,30]", if kind == 0 { 40 } else { 99 }, kind)],
            );
            k.timed_way_turns = true;
            k.way_turns[0].window = 1;
            k.windows.schedules = vec![vec![(480, 540)]];
            for (arrival, ready) in [
                (28819.75, true),
                (28820., false),
                (32419.75, false),
                (32420., true),
            ] {
                let clock = BikeClock::service("2026-11-02", "America/New_York", arrival).unwrap();
                let r = k
                    .route_arrive_at(
                        nodes[0],
                        nodes[4],
                        Default::default(),
                        0.,
                        4.8,
                        1000.,
                        Some(clock),
                    )
                    .unwrap();
                assert_eq!(r.status, "ready", "kind={kind} arrival={arrival}");
                assert_eq!(r.end_wait_seconds == 0., ready);
                {
                    assert_eq!(r.timing_policy, "dated_arrive_by_verified");
                    assert_eq!(seconds(&r), 80.);
                }
            }
        }
    }

    #[test]
    fn arrival_profiles_choose_early_arrival_when_cheaper_than_a_detour() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let edges = [
            (0, 1, 10000, 1, CYCLE),
            (1, 2, 10000, 2, CYCLE),
            (0, 3, 50000, 3, CYCLE),
            (3, 2, 50000, 4, CYCLE),
        ];
        let mut k = fixture(&nodes, &edges, &[(1, 1, 2, 0)]);
        time_turns(&mut k);
        for (start, duration) in [(480, 200.), (508, 40.)] {
            k.windows.schedules = vec![vec![(start, 540)]];
            let clock = BikeClock::service("2026-11-02", "America/New_York", 30600.).unwrap();
            let r = k
                .route_arrive_at(
                    nodes[0],
                    nodes[2],
                    Default::default(),
                    0.,
                    4.8,
                    2000.,
                    Some(clock),
                )
                .unwrap();
            assert_eq!(r.status, "ready");
            assert_eq!(r.timing_policy, "dated_arrive_by_verified");
            assert_eq!(seconds(&r), duration);
            let slack = if start == 508 { 100. } else { 0. };
            assert!((r.end_wait_seconds - slack).abs() < 1e-6);
            assert!((r.cost.unwrap() - 0.8 * (duration + slack)).abs() < 1e-6);
        }
    }

    #[test]
    fn arrival_profile_respects_the_available_service_clock() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let mut k = fixture(
            &nodes,
            &[
                (0, 1, 10000, 1, CYCLE),
                (1, 2, 10000, 2, CYCLE),
                (0, 3, 5000, 3, MAJOR),
                (3, 2, 5000, 4, MAJOR),
            ],
            &[(1, 1, 2, 0)],
        );
        time_turns(&mut k);
        k.windows.schedules = vec![vec![(480, 540)]];
        let opt = BikeOptions {
            profile: Profile::Quiet,
            ..Default::default()
        };
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28860.).unwrap());
        let early = k
            .route_arrive_at(nodes[0], nodes[2], opt, 0., 4.8, 1000., clock)
            .unwrap();
        assert!((early.elapsed_seconds() - 80.).abs() < 1e-6);
        let bounded = k
            .route_arrive_limited(nodes[0], nodes[2], opt, 0., 4.8, 1000., clock, Some(30.))
            .unwrap();
        assert_eq!(bounded.status, "ready");
        assert_eq!(bounded.elapsed_seconds(), 20.);
        assert!(bounded.cost.unwrap() > early.cost.unwrap());
        assert_eq!(bounded.timing_policy, "dated_arrive_by_verified");
        let blocked = k
            .route_arrive_limited(nodes[0], nodes[2], opt, 0., 4.8, 1000., clock, Some(10.))
            .unwrap();
        assert_eq!(blocked.status, "blocked");
        assert_eq!(blocked.timing_policy, "dated_arrive_by_verified");
    }

    #[test]
    fn arrival_profile_waits_between_disjoint_entry_windows() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let mut k = fixture(
            &nodes,
            &[
                (0, 1, 10000, 1, CYCLE),
                (1, 2, 10000, 2, CYCLE),
                (1, 3, 250, 3, CYCLE),
                (3, 1, 250, 4, CYCLE),
            ],
            &[],
        );
        k.windows.schedules = vec![vec![(0, 480)], vec![(540, 10080)]];
        for (way, window) in [(1, 1), (2, 2)] {
            let edge = k.ways.iter().position(|&w| w == way).unwrap();
            k.attributes[edge] |= TIMED_EDGE;
            k.edge_windows.insert(edge as u32, window);
        }
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let clock = BikeClock::service("2026-11-02", "America/New_York", 32420.).unwrap();
            let r = k
                .route_arrive_at(
                    nodes[0],
                    nodes[2],
                    BikeOptions {
                        profile,
                        ..Default::default()
                    },
                    0.,
                    4.8,
                    1000.,
                    Some(clock),
                )
                .unwrap();
            assert_eq!(r.status, "ready");
            assert_eq!(r.timing_policy, "dated_arrive_by_verified");
            assert_eq!(r.end_wait_seconds, 0.);
            assert!((seconds(&r) - 40.).abs() < 1e-6);
            assert!((r.elapsed_seconds() - 3620.).abs() < 1e-6);
            let factor = if matches!(profile, Profile::Fast) {
                1.
            } else {
                0.8
            };
            assert!((r.cost.unwrap() - factor * 3620.).abs() < 1e-6);
            assert!((distance(&r) - 200.).abs() < 1e-6);
            assert!(
                r.settled_labels < 200,
                "Cycles should be dominated by waiting"
            );
        }
    }

    #[test]
    fn arrival_fallback_replays_conditional_only_alternatives() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.001, 0.001]];
        let mut k = fixture(
            &nodes,
            &[
                (0, 1, 10000, 1, CYCLE),
                (1, 2, 100000, 2, CYCLE),
                (1, 3, 10000, 3, CYCLE),
                (3, 2, 10000, 4, CYCLE),
            ],
            &[(1, 1, 2, 1), (1, 1, 3, 1)],
        );
        k.windows.schedules = vec![vec![(480, 540)]];
        k.timed_node_turns = true;
        for turn in k.turns.values_mut().flatten() {
            if turn.to == 3 {
                turn.window = 1;
            }
        }
        // All-active OR alternatives admit the short branch, but at 07:00
        // only the unconditional long branch is permitted. A conservative
        // candidate is not automatically a valid dated upper bound.
        let undated = k
            .route(nodes[0], nodes[2], Default::default(), 0., 4.8, 2000.)
            .unwrap();
        assert_eq!(seconds(&undated), 60.);
        let clock = BikeClock::service("2026-11-02", "America/New_York", 25200.).unwrap();
        let arrived = k
            .route_arrive_at(
                nodes[0],
                nodes[2],
                Default::default(),
                0.,
                4.8,
                2000.,
                Some(clock),
            )
            .unwrap();
        assert_eq!(arrived.status, "ready");
        assert_eq!(arrived.timing_policy, "dated_arrive_by_verified");
        assert_eq!(seconds(&arrived), 220.);
        assert!(
            arrived
                .legs
                .iter()
                .all(|leg| !leg.coordinates.contains(&nodes[3]))
        );
        let nodes = [
            [0., 0.],
            [0.001, 0.],
            [0.002, 0.],
            [0.003, 0.],
            [0.002, 0.001],
        ];
        let mut k = fixture_rules(
            &nodes,
            &[
                (0, 1, 10000, 10, CYCLE),
                (1, 2, 10000, 20, CYCLE),
                (2, 3, 100000, 30, CYCLE),
                (2, 4, 10000, 40, CYCLE),
                (4, 3, 10000, 50, CYCLE),
            ],
            &[],
            &[(10, "[20]", 30, 1), (10, "[20]", 40, 1)],
        );
        k.windows.schedules = vec![vec![(480, 540)]];
        k.timed_way_turns = true;
        for rule in &mut k.way_turns {
            if rule.to == 40 {
                rule.window = 1;
            }
        }
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            let undated = k.route(nodes[0], nodes[3], opt, 0., 4.8, 2000.).unwrap();
            assert_eq!(seconds(&undated), 80.);
            let arrived = k
                .route_arrive_at(nodes[0], nodes[3], opt, 0., 4.8, 2000., Some(clock))
                .unwrap();
            assert_eq!(arrived.timing_policy, "dated_arrive_by_verified");
            assert_eq!(seconds(&arrived), 240.);
            assert!(
                arrived
                    .legs
                    .iter()
                    .all(|leg| !leg.coordinates.contains(&nodes[4]))
            );
        }
    }

    #[test]
    fn temporal_dominance_keeps_an_earlier_more_expensive_prefix() {
        let nodes = [
            [0., 0.],
            [0.002, 0.],
            [0.003, 0.],
            [0.001, 0.001],
            [0.004, 0.],
        ];
        let edges = [
            (0, 1, 10000, 1, MAJOR),
            (0, 3, 10000, 2, CYCLE),
            (3, 1, 10000, 2, CYCLE),
            (1, 2, 5000, 10, CYCLE),
            (2, 4, 10000, 20, CYCLE),
        ];
        let mut k = fixture(&nodes, &edges, &[(2, 10, 20, 0)]);
        time_turns(&mut k);
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28760.).unwrap());
        let r = k
            .route_at(
                nodes[0],
                nodes[4],
                BikeOptions::default(),
                0.,
                4.8,
                1000.,
                clock,
            )
            .unwrap();
        assert_eq!(r.status, "ready");
        assert!((r.cost.unwrap() - 88.5).abs() < 1e-8);
        assert!((seconds(&r) - 50.).abs() < 1e-8);
        assert!(!r.legs[0].coordinates.contains(&nodes[3]));
        assert_eq!(
            k.route(nodes[0], nodes[4], Default::default(), 0., 4.8, 1000.)
                .unwrap()
                .status,
            "blocked"
        );
    }

    #[test]
    fn dated_search_matches_exhaustive_paths_waits_preferences_and_caps() {
        let nodes = [
            [0., 0.],
            [0.001, 0.001],
            [0.002, 0.],
            [0.003, 0.001],
            [0.003, -0.001],
            [0.004, 0.],
        ];
        let pairs = [(0, 1), (1, 2), (0, 2), (2, 3), (2, 4), (3, 5), (4, 5)];
        let paths = [
            vec![0, 1, 3, 5],
            vec![0, 1, 4, 6],
            vec![2, 3, 5],
            vec![2, 4, 6],
        ];
        let mut seed = 470193u64;
        let mut arrival_verified = 0;
        let mut shared_arrival_certificates = 0;
        let mut arrival_fallback = 0;
        for _ in 0..24 {
            let mut random = || {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                seed >> 32
            };
            let edges: Vec<_> = pairs
                .iter()
                .enumerate()
                .map(|(i, &(a, b))| {
                    (
                        a,
                        b,
                        10_000 + (random() % 20_000) as u32,
                        (i + 1) as i64,
                        if random() % 2 == 0 { CYCLE } else { MAJOR },
                    )
                })
                .collect();
            // Short closures exercise waiting frontiers; long closures make
            // fixed permissions provable for the improving detour horizon.
            for (restriction, end_minute) in (0..5).flat_map(|r| [482, 540].map(|end| (r, end))) {
                let mut k = match restriction {
                    2 => fixture_rules(&nodes, &edges, &[], &[(1, "[2]", 4, 0)]),
                    3 => fixture_rules(&nodes, &edges, &[], &[(1, "[2]", 4, 3)]),
                    4 => fixture_rules(&nodes, &edges, &[], &[(1, "[2,4]", 6, 0)]),
                    _ => fixture(&nodes, &edges, &[(2, 2, 4, 0), (2, 3, 4, 0)]),
                };
                if restriction < 2 {
                    time_turns(&mut k);
                } else {
                    k.timed_way_turns = true;
                    k.way_turns[0].window = 1;
                }
                k.windows.schedules = vec![vec![(480, end_minute)]];
                if restriction == 1 {
                    k.turns.clear();
                    k.timed_node_turns = false;
                    k.windows.schedules = vec![vec![(0, 480), (end_minute, 10080)]];
                    let edge = k.ways.iter().position(|&way| way == 4).unwrap();
                    k.attributes[edge] |= TIMED_EDGE;
                    k.edge_windows.insert(edge as u32, 1);
                }
                for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
                    for start in [28740., 28790., 28920.] {
                        for limit in [500., 800., 2000.] {
                            let mut expected = f64::INFINITY;
                            for path in &paths {
                                let (mut time, mut cost, mut distance) = (start, 0., 0.);
                                for &id in path {
                                    let edge = edges[id];
                                    let closure_end = end_minute as f64 * 60.;
                                    let prohibited = match restriction {
                                        2 => id == 3 && path.starts_with(&[0, 1]),
                                        3 => id == 4 && path.starts_with(&[0, 1]),
                                        4 => id == 5 && path.starts_with(&[0, 1, 3]),
                                        _ => id == 3,
                                    };
                                    if prohibited && (28800.0..closure_end).contains(&time) {
                                        cost += (closure_end - time)
                                            * if matches!(profile, Profile::Fast) {
                                                1.
                                            } else {
                                                0.8
                                            };
                                        time = closure_end;
                                    }
                                    let meters = edge.2 as f64 / 100.;
                                    let seconds = meters / 5.;
                                    let stress = if edge.4 == MAJOR { 2.425 } else { 0. };
                                    let factor = match profile {
                                        Profile::Fast => 1.,
                                        Profile::Balanced => 0.8 + stress,
                                        Profile::Quiet => 0.8 + 2.5 * stress,
                                        Profile::Shortest => unreachable!(),
                                    };
                                    time += seconds;
                                    cost += seconds * factor;
                                    distance += meters;
                                }
                                if distance <= limit {
                                    expected = expected.min(cost);
                                }
                            }
                            let clock = Some(
                                BikeClock::service("2026-11-02", "America/New_York", start)
                                    .unwrap(),
                            );
                            let r = k
                                .route_at(
                                    nodes[0],
                                    nodes[5],
                                    BikeOptions {
                                        profile,
                                        ..Default::default()
                                    },
                                    0.,
                                    4.8,
                                    limit,
                                    clock,
                                )
                                .unwrap();
                            assert_eq!(
                                r.status,
                                if expected.is_finite() {
                                    "ready"
                                } else {
                                    "blocked"
                                }
                            );
                            if expected.is_finite() {
                                assert!(
                                    (r.cost.unwrap() - expected).abs() < 1e-7,
                                    "{:?}: {:?} != {expected}",
                                    profile,
                                    r.cost
                                );
                                assert!(distance(&r) <= limit + 1e-7);
                            }
                            // Independent backwards oracle on every path in
                            // this acyclic fixture. A closure forces entry to
                            // the last representable instant before its start;
                            // the remaining time to the deadline costs waiting.
                            let arrival = start + 300.;
                            let arrival_clock =
                                BikeClock::service("2026-11-02", "America/New_York", arrival)
                                    .unwrap();
                            let service_epoch = arrival_clock.epoch - arrival;
                            let mut arrival_expected = f64::INFINITY;
                            for path in &paths {
                                let (mut time, mut cost, mut distance) = (arrival, 0., 0.);
                                for &id in path.iter().rev() {
                                    let edge = edges[id];
                                    let meters = edge.2 as f64 / 100.;
                                    let seconds = meters / 5.;
                                    let stress = if edge.4 == MAJOR { 2.425 } else { 0. };
                                    let factor = match profile {
                                        Profile::Fast => 1.,
                                        Profile::Balanced => 0.8 + stress,
                                        Profile::Quiet => 0.8 + 2.5 * stress,
                                        Profile::Shortest => unreachable!(),
                                    };
                                    time -= seconds;
                                    cost += seconds * factor;
                                    distance += meters;
                                    let prohibited = match restriction {
                                        2 => id == 3 && path.starts_with(&[0, 1]),
                                        3 => id == 4 && path.starts_with(&[0, 1]),
                                        4 => id == 5 && path.starts_with(&[0, 1, 3]),
                                        _ => id == 3,
                                    };
                                    if prohibited
                                        && (28800. ..end_minute as f64 * 60.).contains(&time)
                                    {
                                        let earlier =
                                            (service_epoch + 28800.).next_down() - service_epoch;
                                        cost += (time - earlier)
                                            * if matches!(profile, Profile::Fast) {
                                                1.
                                            } else {
                                                0.8
                                            };
                                        time = earlier;
                                    }
                                }
                                if distance <= limit {
                                    arrival_expected = arrival_expected.min(cost);
                                }
                            }
                            let arrived = k
                                .route_arrive_at(
                                    nodes[0],
                                    nodes[5],
                                    BikeOptions {
                                        profile,
                                        ..Default::default()
                                    },
                                    0.,
                                    4.8,
                                    limit,
                                    Some(arrival_clock),
                                )
                                .unwrap();
                            let shared_arrivals = k
                                .many_to(
                                    &[nodes[0], nodes[0]],
                                    nodes[5],
                                    BikeOptions {
                                        profile,
                                        ..Default::default()
                                    },
                                    0.,
                                    4.8,
                                    limit,
                                    Some(arrival_clock),
                                    400.,
                                    None,
                                )
                                .unwrap();
                            shared_arrival_certificates += shared_arrivals.certified_targets;
                            for seconds in shared_arrivals.seconds {
                                if arrived.status == "ready" && arrived.elapsed_seconds() <= 400. {
                                    assert!(
                                        (seconds - arrived.elapsed_seconds()).abs() < 1e-7,
                                        "Shared arrival: {profile:?}, rule={restriction}, end={end_minute}, deadline={arrival}, limit={limit}: {seconds} != {}",
                                        arrived.elapsed_seconds()
                                    );
                                } else {
                                    assert!(seconds.is_infinite());
                                }
                            }
                            if arrived.timing_policy == "dated_arrive_by_verified" {
                                arrival_verified += 1;
                                assert_eq!(arrived.status == "ready", arrival_expected.is_finite());
                                assert!(
                                    !arrival_expected.is_finite()
                                        || (arrived.cost.unwrap() - arrival_expected).abs() < 1e-5,
                                    "False arrival certificate: {profile:?}, rule={restriction}, end={end_minute}, deadline={arrival}, limit={limit}: {:?} != {arrival_expected}",
                                    arrived.cost
                                );
                            } else {
                                arrival_fallback += 1;
                                if let Some(cost) = arrived.cost {
                                    assert!(cost + 1e-5 >= arrival_expected);
                                }
                            }
                            if arrived.status == "ready" {
                                assert!(distance(&arrived) <= limit + 1e-7);
                                assert!(arrived.end_wait_seconds >= 0.);
                            }
                            let many = k
                                .many_from(
                                    nodes[0],
                                    &[nodes[5]],
                                    BikeOptions {
                                        profile,
                                        ..Default::default()
                                    },
                                    0.,
                                    4.8,
                                    limit,
                                    clock,
                                    400.,
                                )
                                .unwrap();
                            let duration: f64 = r
                                .legs
                                .iter()
                                .map(|l| l.seconds + l.wait_before_seconds)
                                .sum();
                            if r.status == "ready" && duration <= 400. {
                                assert!(
                                    (many.seconds[0] - duration).abs() < 1e-7,
                                    "many differs for {profile:?}, restriction={restriction}, start={start}, limit={limit}"
                                );
                            } else {
                                assert!(many.seconds[0].is_infinite());
                            }
                        }
                    }
                }
            }
        }
        assert!(arrival_verified > 1000);
        assert_eq!(arrival_fallback, 0);
        assert!(shared_arrival_certificates > 6000);
        println!(
            "Shared arrival oracle: {shared_arrival_certificates} certified cells out of 12960"
        );
        println!("Arrival oracle: {arrival_verified} verified, {arrival_fallback} fallback cases");
    }

    #[test]
    fn dated_via_turns_use_actual_movements_including_partial_edges() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.003, 0.]];
        let k = fixture_extra(&nodes,
            &[(0,1,10000,10,CYCLE),(1,2,10000,20,CYCLE),(2,3,10000,30,CYCLE)],
            &[], &[(10,"[20]",30,0)],
            "INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
             CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
             INSERT INTO bike_turn_windows VALUES(1,1,480,482);");
        let timed = |start, origin, destination| {
            k.route_at(
                origin,
                destination,
                BikeOptions {
                    profile: Profile::Fast,
                    ..Default::default()
                },
                0.,
                4.8,
                1000.,
                Some(BikeClock::service("2026-11-02", "America/New_York", start).unwrap()),
            )
            .unwrap()
        };
        for (start, expected_wait) in [(28740., 0.), (28770., 110.), (28800., 80.), (28890., 0.)] {
            let r = timed(start, nodes[0], nodes[3]);
            assert_eq!(r.status, "ready");
            assert_eq!(r.timing_policy, "dated_turns");
            assert!((seconds(&r) - 60.).abs() < 1e-7);
            assert!(
                (r.legs.iter().map(|l| l.wait_before_seconds).sum::<f64>() - expected_wait).abs()
                    < 1e-7
            );
        }
        let partial = timed(28800., nodes[0], [0.0025, 0.]);
        assert!((seconds(&partial) - 50.).abs() < 1e-7);
        assert!(
            (partial
                .legs
                .iter()
                .map(|l| l.wait_before_seconds)
                .sum::<f64>()
                - 80.)
                .abs()
                < 1e-7
        );
        let middle = timed(28800., [0.0015, 0.], nodes[3]);
        assert!((seconds(&middle) - 30.).abs() < 1e-7);
        assert_eq!(
            middle
                .legs
                .iter()
                .map(|l| l.wait_before_seconds)
                .sum::<f64>(),
            0.
        );
        assert_eq!(
            route(&k, nodes[0], nodes[3], Profile::Fast, 1000.).status,
            "blocked"
        );
        assert_eq!(std::mem::size_of::<WayTurn>(), 48);
    }

    #[test]
    fn dated_only_via_turns_can_wait_at_entry_or_later_divergence() {
        let nodes = [
            [0., 0.],
            [0.001, 0.],
            [0.002, 0.],
            [0.003, 0.],
            [0.001, 0.001],
            [0.002, 0.001],
        ];
        let k=fixture_extra(&nodes,
            &[(0,1,10000,10,CYCLE),(1,2,10000,20,CYCLE),(2,3,10000,30,CYCLE),
              (1,4,10000,40,CYCLE),(2,5,10000,50,CYCLE)],&[],&[(10,"[20]",30,3)],
            "INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
             CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
             INSERT INTO bike_turn_windows VALUES(1,1,480,482);");
        for (start, end, expected_cycle, expected_wait) in [
            (28800., 4, 40., 100.),
            (28770., 5, 60., 110.),
            (28770., 3, 60., 0.),
        ] {
            let r = k
                .route_at(
                    nodes[0],
                    nodes[end],
                    BikeOptions {
                        profile: Profile::Fast,
                        ..Default::default()
                    },
                    0.,
                    4.8,
                    1000.,
                    Some(BikeClock::service("2026-11-02", "America/New_York", start).unwrap()),
                )
                .unwrap();
            assert_eq!(r.status, "ready");
            assert!((seconds(&r) - expected_cycle).abs() < 1e-7);
            assert!(
                (r.legs.iter().map(|l| l.wait_before_seconds).sum::<f64>() - expected_wait).abs()
                    < 1e-7
            );
        }
    }

    #[test]
    fn via_node_and_road_windows_require_one_jointly_legal_movement() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.], [0.003, 0.]];
        let edges = [
            (0, 1, 10000, 10, CYCLE),
            (1, 2, 10000, 20, CYCLE),
            (2, 3, 10000, 30, CYCLE),
        ];
        let sql=format!("{}
            INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
            CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
            INSERT INTO bike_turn_windows VALUES(1,1,480,482),(0,1,482,483);",
            TIMED_WAY_20.replace("way_id=20","way_id=30"));
        let k = fixture_extra(
            &nodes,
            &edges,
            &[(2, 20, 30, 0)],
            &[(10, "[20]", 30, 0)],
            &sql,
        );
        let r = k
            .route_at(
                nodes[0],
                nodes[3],
                BikeOptions {
                    profile: Profile::Fast,
                    ..Default::default()
                },
                0.,
                4.8,
                1000.,
                Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap()),
            )
            .unwrap();
        assert_eq!(
            r.status, "blocked",
            "Road opens 08:01–08:03, via turn forbids before 08:02 and node turn forbids 08:02–08:03"
        );
    }

    #[test]
    fn conditional_only_alternative_can_enable_a_different_first_via_way() {
        let nodes = [
            [0., 0.],
            [0.0001, 0.],
            [0.0002, 0.0001],
            [0.0002, -0.0001],
            [0.0003, -0.0001],
            [0.0003, 0.0001],
        ];
        let k=fixture_extra(&nodes,&[(0,1,2500,10,CYCLE),(1,2,2500,20,CYCLE),(2,5,2500,50,CYCLE),
            (1,3,2500,30,CYCLE),(3,4,2500,40,CYCLE)],&[],&[(10,"[20]",50,1),(10,"[30]",40,1)],
            "INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
             CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
             INSERT INTO bike_turn_windows VALUES(1,1,481,10080);");
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let r = k
                .route_at(
                    nodes[0],
                    nodes[5],
                    BikeOptions {
                        profile,
                        ..Default::default()
                    },
                    0.,
                    4.8,
                    100.,
                    Some(BikeClock::service("2026-11-02", "America/New_York", 28850.).unwrap()),
                )
                .unwrap();
            assert_eq!(r.status, "ready");
            assert!((seconds(&r) - 15.).abs() < 1e-7);
            assert!((r.legs.iter().map(|l| l.wait_before_seconds).sum::<f64>() - 5.).abs() < 1e-7);
        }
    }

    #[test]
    fn timed_only_alternative_completion_preserves_voluntary_wait_states() {
        let nodes = [
            [0., 0.],
            [0.0001, 0.],
            [0.0002, 0.],
            [0.0003, 0.],
            [0.0004, 0.],
            [0.0003, 0.0001],
        ];
        // Before 08:01 only the longer alternative is active. Waiting at the
        // first alternative's completion permits finishing that alternative
        // and exiting onto way 50; its earlier state must still follow way 40.
        let mut k=fixture_extra(&nodes,
            &[(0,1,2500,10,CYCLE),(1,2,2500,20,CYCLE),(2,3,2500,30,CYCLE),
              (3,4,2500,40,CYCLE),(3,5,2500,50,CYCLE)],&[],
            &[(10,"[20]",30,1),(10,"[20,30]",40,1)],
            "INSERT INTO metadata VALUES('bikeTurnWindowVersion','1');
             CREATE TABLE bike_turn_windows(turn_table INTEGER,turn_row INTEGER,start_minute INTEGER,end_minute INTEGER);
             INSERT INTO bike_turn_windows VALUES(1,1,481,10080);");
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let r = k
                .route_at(
                    nodes[0],
                    nodes[5],
                    BikeOptions {
                        profile,
                        ..Default::default()
                    },
                    0.,
                    4.8,
                    100.,
                    Some(BikeClock::service("2026-11-02", "America/New_York", 28840.).unwrap()),
                )
                .unwrap();
            assert_eq!(r.status, "ready");
            assert!((seconds(&r) - 20.).abs() < 1e-7);
            assert!((r.legs.iter().map(|l| l.wait_before_seconds).sum::<f64>() - 10.).abs() < 1e-7);
        }
        // Arrival profiles must preserve the later completion state too.
        // The first road closes at 08:00, forcing a wait before the 08:01
        // alternative becomes active; the other completion cannot reach node 5.
        k.windows.schedules.push(vec![(0, 480)]);
        let edge = k.ways.iter().position(|&way| way == 10).unwrap();
        k.attributes[edge] |= TIMED_EDGE;
        k.edge_windows.insert(edge as u32, 2);
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let r = k
                .route_arrive_at(
                    nodes[0],
                    nodes[5],
                    BikeOptions {
                        profile,
                        ..Default::default()
                    },
                    0.,
                    4.8,
                    100.,
                    Some(BikeClock::service("2026-11-02", "America/New_York", 28870.).unwrap()),
                )
                .unwrap();
            assert_eq!(r.status, "ready");
            assert_eq!(r.timing_policy, "dated_arrive_by_verified");
            assert!((r.elapsed_seconds() - 70.).abs() < 1e-6);
            assert!((r.legs.iter().map(|l| l.wait_before_seconds).sum::<f64>() - 50.).abs() < 1e-6);
            assert_eq!(r.end_wait_seconds, 0.);
        }
    }

    #[test]
    fn weekly_movements_survive_skipped_permissions_without_opening_conflicts() {
        let nodes = [[0., 0.], [0.001, 0.], [0.002, 0.]];
        for (zone, start, next, day, minute) in [
            ("America/New_York", "2026-03-07", "2026-03-15", 6, 130),
            ("Australia/Lord_Howe", "2026-10-03", "2026-10-11", 6, 130),
            ("Pacific/Apia", "2011-12-24", "2012-01-06", 4, 540),
        ] {
            let clock = BikeClock::service(start, zone, 0.).unwrap();
            let open = BikeClock::service(next, zone, minute as f64 * 60.).unwrap();
            let expected_wait = open.epoch - clock.epoch;
            assert!(expected_wait > 8. * 86400.);
            let a = day * 1440 + minute;
            let b = a + 10;
            for road in [false, true] {
                let mut k = fixture(
                    &nodes,
                    &[(0, 1, 10000, 10, CYCLE), (1, 2, 10000, 20, CYCLE)],
                    if road { &[] } else { &[(1, 10, 20, 0)] },
                );
                if road {
                    k.attributes[1] |= TIMED_EDGE;
                    k.edge_windows.insert(1, 1);
                    k.windows.schedules = vec![vec![(a, b)]];
                } else {
                    time_turns(&mut k);
                    k.windows.schedules = vec![vec![(0, a), (b, 10080)]];
                }
                let heap = k.heap_bytes();
                let r = k
                    .route_at(
                        nodes[0],
                        nodes[2],
                        Default::default(),
                        0.,
                        4.8,
                        1000.,
                        Some(clock),
                    )
                    .unwrap();
                assert_eq!(r.status, "ready", "{zone}, road={road}");
                assert_eq!(
                    r.legs.iter().map(|l| l.wait_before_seconds).sum::<f64>(),
                    expected_wait - 20.
                );
                assert!((r.elapsed_seconds() - expected_wait - 20.).abs() < 1e-6);
                assert_eq!(k.heap_bytes(), heap);
                if !road {
                    // Entry permission and the turn never overlap. A calendar
                    // jump must not invent a legal combination of weekly rules.
                    k.attributes[1] |= TIMED_EDGE;
                    k.edge_windows.insert(1, 1);
                    let blocked = k
                        .route_at(
                            nodes[0],
                            nodes[2],
                            Default::default(),
                            0.,
                            4.8,
                            1000.,
                            Some(clock),
                        )
                        .unwrap();
                    assert_eq!(blocked.status, "blocked", "{zone}");
                }
            }
        }
    }

    #[test]
    fn waiting_dominates_fractional_cost_cycling_loops() {
        let nodes = [[0., 0.], [0.001, 0.], [0.001, 0.001], [0.002, 0.]];
        let mut k = fixture(
            &nodes,
            &[
                (0, 1, 10001, 10, CYCLE),
                (1, 2, 10002, 30, CYCLE),
                (2, 1, 10002, 30, CYCLE),
                (1, 3, 10003, 20, CYCLE),
            ],
            &[(1, 10, 20, 0), (1, 30, 20, 0)],
        );
        time_turns(&mut k);
        k.windows.schedules = vec![vec![(480, 960)]];
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap());
        let r = k
            .route_at(
                nodes[0],
                nodes[3],
                Default::default(),
                0.,
                4.8,
                50000.,
                clock,
            )
            .unwrap();
        assert_eq!(r.status, "ready");
        assert!((r.cost.unwrap() - 0.8 * (28800. + 20.006)).abs() < 1e-7);
        assert!(r.settled_labels < 20, "{}", r.settled_labels);
        assert!(!r.legs.iter().any(|leg| leg.coordinates.contains(&nodes[2])));
    }

    #[test]
    fn direction_and_partial_edge_geometry() {
        let k = fixture(&[[0., 0.], [0.01, 0.]], &[(0, 1, 111_195, 10, CYCLE)], &[]);
        let r = route(&k, [0.002, 0.], [0.008, 0.], Profile::Balanced, 1000.);
        assert_eq!(r.status, "ready");
        assert!((distance(&r) - 667.17).abs() < 0.01);
        assert!((seconds(&r) - 133.434).abs() < 0.01);
        assert!((r.legs[0].coordinates[0][0] - 0.002).abs() < 1e-12);
        assert!((r.legs[0].coordinates[1][0] - 0.008).abs() < 1e-12);
        assert_eq!(
            route(&k, [0.008, 0.], [0.002, 0.], Profile::Balanced, 10000.).status,
            "blocked"
        );
        let nearby = k
            .route(
                [0.008, 0.],
                [0.002, 0.],
                Default::default(),
                0.,
                4.8,
                10000.,
            )
            .unwrap();
        let wider = k
            .route(
                [0.008, 0.],
                [0.002, 0.],
                Default::default(),
                100.,
                4.8,
                10000.,
            )
            .unwrap();
        assert_eq!(wider.status, "blocked");
        assert_eq!(
            wider.settled_labels, nearby.settled_labels,
            "Do not repeat an identical failed search"
        );
    }

    #[test]
    fn quiet_route_preferences_do_not_inflate_eta_and_caps_keep_shorter_path() {
        let k = fixture(
            &[[0., 0.], [0.01, 0.], [0.005, 0.004]],
            &[
                (0, 1, 111_195, 10, MAJOR),
                (0, 2, 71_200, 20, CYCLE),
                (2, 1, 71_200, 20, CYCLE),
            ],
            &[],
        );
        let fast = route(&k, [0., 0.], [0.01, 0.], Profile::Fast, 2000.);
        let quiet = route(&k, [0., 0.], [0.01, 0.], Profile::Quiet, 2000.);
        assert!((distance(&fast) - 1111.95).abs() < 0.01);
        assert!((distance(&quiet) - 1424.).abs() < 0.01);
        assert!((seconds(&quiet) - distance(&quiet) / 5.).abs() < 0.01);
        let capped = route(&k, [0., 0.], [0.01, 0.], Profile::Quiet, 1200.);
        assert!((distance(&capped) - 1111.95).abs() < 0.01);
        assert_eq!(
            route(&k, [0., 0.], [0.01, 0.], Profile::Quiet, 1000.).status,
            "blocked"
        );
    }

    #[test]
    fn restriction_applies_to_partial_destination_and_detour() {
        let nodes = [[0., 0.], [0.01, 0.], [0.02, 0.], [0.01, 0.005]];
        let edges = [
            (0, 1, 111_195, 10, CYCLE),
            (1, 2, 111_195, 20, CYCLE),
            (1, 3, 55_598, 30, CYCLE),
            (3, 1, 55_598, 30, CYCLE),
        ];
        for kind in [0, 1] {
            let to = if kind == 0 { 20 } else { 30 };
            let k = fixture(&nodes, &edges, &[(1, 10, to, kind)]);
            let r = route(&k, [0.005, 0.], [0.015, 0.], Profile::Fast, 5000.);
            assert_eq!(r.status, "ready");
            assert!(r.legs[0].coordinates.contains(&nodes[3]));
            assert!(distance(&r) > 2200.);
        }
        let blocked = fixture(&nodes[..3], &edges[..2], &[(1, 10, 20, 0)]);
        assert_eq!(
            route(&blocked, [0.005, 0.], [0.015, 0.], Profile::Fast, 5000.).status,
            "blocked"
        );
    }

    #[test]
    fn no_u_turn_does_not_block_straight_on_same_way() {
        let k = fixture(
            &[[0., 0.], [0.01, 0.], [0.02, 0.]],
            &[
                (0, 1, 111_195, 10, CYCLE),
                (1, 0, 111_195, 10, CYCLE),
                (1, 2, 111_195, 10, CYCLE),
            ],
            &[(1, 10, 10, 2)],
        );
        assert!(k.allowed_turn(Some(0), 1, 2));
        assert!(!k.allowed_turn(Some(0), 1, 1));
        assert_eq!(
            route(&k, [0.005, 0.], [0.015, 0.], Profile::Fast, 5000.).status,
            "ready"
        );
    }

    #[test]
    fn via_way_restrictions_retain_history_and_do_not_affect_other_entries() {
        let nodes = [[0., 0.], [0.01, 0.], [0.02, 0.], [0.03, 0.], [0.02, 0.005]];
        let edges = [
            (0, 1, 111_195, 10, CYCLE),
            (1, 2, 111_195, 20, CYCLE),
            (2, 3, 111_195, 30, CYCLE),
            (2, 4, 55_598, 40, CYCLE),
            (4, 3, 124_320, 40, CYCLE),
        ];
        let no = fixture_rules(&nodes, &edges, &[], &[(10, "[20]", 30, 0)]);
        let detour = route(&no, [0.005, 0.], nodes[3], Profile::Fast, 10000.);
        assert_eq!(detour.status, "ready");
        assert!(detour.legs[0].coordinates.contains(&nodes[4]));
        let mid = route(&no, [0.015, 0.], nodes[3], Profile::Fast, 10000.);
        assert!(!mid.legs[0].coordinates.contains(&nodes[4]));
        let only = fixture_rules(&nodes, &edges, &[], &[(10, "[20]", 30, 1)]);
        let direct = route(&only, [0.005, 0.], nodes[3], Profile::Fast, 10000.);
        assert_eq!(direct.status, "ready");
        assert!(!direct.legs[0].coordinates.contains(&nodes[4]));
        assert_eq!(
            route(&only, [0.005, 0.], nodes[4], Profile::Fast, 10000.).status,
            "blocked"
        );
    }

    #[test]
    fn overlapping_only_restrictions_must_each_be_satisfied() {
        let k = fixture_rules(
            &[[0., 0.], [0.01, 0.], [0.02, 0.]],
            &[(0, 1, 111_195, 20, CYCLE), (1, 2, 111_195, 30, CYCLE)],
            &[],
            &[(10, "[20]", 30, 1), (11, "[20]", 40, 1)],
        );
        assert!(
            k.next_turn_state(&vec![(0, 0, 0), (1, 0, 0)], Some(0), 1, 1)
                .is_none()
        );
        let alternatives = fixture_rules(
            &[[0., 0.], [0.01, 0.], [0.02, 0.]],
            &[(0, 1, 111_195, 20, CYCLE), (1, 2, 111_195, 30, CYCLE)],
            &[],
            &[(10, "[20]", 30, 1), (10, "[20]", 40, 1)],
        );
        assert!(
            alternatives
                .next_turn_state(&vec![(0, 0, 0), (1, 0, 0)], Some(0), 1, 1)
                .is_some()
        );
    }

    #[test]
    fn conditional_only_turns_are_independent_constraints() {
        let nodes = [[0., 0.], [0.01, 0.], [0.02, 0.], [0.01, 0.01]];
        let edges = [
            (0, 1, 111_195, 10, CYCLE),
            (1, 2, 111_195, 20, CYCLE),
            (1, 3, 111_195, 30, CYCLE),
        ];
        let k = fixture(&nodes, &edges, &[(1, 10, 20, 1), (1, 10, 30, 9)]);
        assert!(!k.allowed_turn(Some(0), 1, 1));
        assert!(!k.allowed_turn(Some(0), 1, 2));
        let k = fixture_rules(
            &nodes,
            &edges,
            &[],
            &[(10, "[20]", 40, 1), (10, "[30]", 50, 3)],
        );
        assert!(k.next_turn_state(&vec![], Some(0), 1, 1).is_none());
        assert!(k.next_turn_state(&vec![], Some(0), 1, 2).is_none());
    }

    #[test]
    fn disconnected_endpoint_can_use_a_bounded_unverified_connector() {
        let nodes = [[0., 0.], [0.01, 0.], [0., 0.0001], [0.001, 0.0001]];
        let k = fixture(
            &nodes,
            &[(0, 1, 111_195, 10, CYCLE), (2, 3, 11_120, 20, CYCLE)],
            &[],
        );
        let from = [0.0005, 0.0001];
        assert_eq!(
            k.route(from, nodes[1], Default::default(), 5., 4.8, 2000.)
                .unwrap()
                .status,
            "blocked"
        );
        let r = k
            .route(from, nodes[1], Default::default(), 15., 4.8, 2000.)
            .unwrap();
        assert_eq!(r.status, "ready");
        assert_eq!(r.legs[0].source, "coordinate-snap");
        assert!(!r.legs[0].verified);
        assert!(r.legs[0].meters <= 15.);
    }

    #[test]
    fn dated_wait_tries_permitted_endpoint_walk_before_accepting_hours_of_delay() {
        let nodes = [
            [-0.001, 0.],
            [0.001, 0.],
            [-0.001, 0.00025],
            [0.001, 0.00025],
            [0.003, 0.00025],
        ];
        let mut k = fixture(
            &nodes,
            &[
                (0, 1, 22_239, 10, CYCLE),
                (1, 3, 2_780, 12, CYCLE),
                (2, 3, 22_239, 20, CYCLE),
                (3, 4, 22_239, 30, CYCLE),
            ],
            &[(1, 10, 12, 0)],
        );
        time_turns(&mut k);
        k.windows.schedules = vec![vec![(480, 960)]];
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap());
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            let narrow = k
                .route_at([0., 0.], nodes[4], opt, 25., 4.8, 1000., clock)
                .unwrap();
            assert_eq!(narrow.status, "ready");
            assert!(
                narrow
                    .legs
                    .iter()
                    .map(|leg| leg.wait_before_seconds)
                    .sum::<f64>()
                    > 27000.
            );
            let wider = k
                .route_at([0., 0.], nodes[4], opt, 30., 4.8, 1000., clock)
                .unwrap();
            assert_eq!(wider.status, "ready");
            assert!(seconds(&wider) < 100.);
            assert!(wider.legs.iter().all(|leg| leg.wait_before_seconds == 0.));
            let walk = &wider.legs[0];
            assert_eq!(walk.source, "coordinate-snap");
            assert!(!walk.verified && walk.meters > 25. && walk.meters <= 30.);
        }
    }

    #[test]
    fn unavoidable_wait_bounds_branching_time_and_preference_tradeoffs() {
        let mut nodes = vec![[0., 0.]];
        let mut edges = Vec::new();
        let mut previous = 0;
        for i in 0..14 {
            let x = (i + 1) as f64 * 0.001;
            let via = nodes.len() as u32;
            nodes.push([x - 0.0005, 0.001]);
            let next = nodes.len() as u32;
            nodes.push([x, 0.]);
            let cm = 10_000 + (1 << i);
            edges.extend([
                (previous, next, cm, i as i64 + 1, MAJOR),
                (previous, via, cm, i as i64 + 101, CYCLE),
                (via, next, cm, i as i64 + 101, CYCLE),
            ]);
            previous = next;
        }
        let junction = nodes.len() as u32;
        nodes.push([0.015, 0.]);
        let end = nodes.len() as u32;
        nodes.push([0.016, 0.]);
        edges.extend([
            (previous, junction, 10000, 999, CYCLE),
            (junction, end, 10000, 1000, CYCLE),
        ]);
        let mut k = fixture(&nodes, &edges, &[(junction, 999, 1000, 0)]);
        time_turns(&mut k);
        k.windows.schedules = vec![vec![(480, 960)]];
        let clock = Some(BikeClock::service("2026-11-02", "America/New_York", 28800.).unwrap());
        let r = k
            .route_at(
                nodes[0],
                nodes[end as usize],
                Default::default(),
                0.,
                4.8,
                50000.,
                clock,
            )
            .unwrap();
        assert_eq!(r.status, "ready");
        assert!((r.cost.unwrap() - 0.8 * (28800. + 20.)).abs() < 1e-7);
        assert!(r.settled_labels < 512, "{} labels", r.settled_labels);
        let arrival = k
            .route_arrive_limited(
                nodes[0],
                nodes[end as usize],
                Default::default(),
                0.,
                4.8,
                50000.,
                Some(BikeClock::service("2026-11-02", "America/New_York", 29100.).unwrap()),
                Some(1000.),
            )
            .unwrap();
        let riding = 40. + 2. * (0..14).map(|i| 10000 + (1 << i)).sum::<u32>() as f64 / 500.;
        assert_eq!(arrival.status, "ready");
        assert_eq!(arrival.timing_policy, "dated_arrive_by_verified");
        assert!((arrival.cost.unwrap() - 0.8 * (riding + 280.)).abs() < 1e-6);
        assert!(
            arrival.settled_labels < 1000,
            "{} arrival labels",
            arrival.settled_labels
        );
    }

    #[test]
    fn directed_dead_ends_retry_only_within_the_callers_connector_limit() {
        let nodes = [
            [-0.001, 0.],
            [0.001, 0.],
            [-0.001, 0.00025],
            [0.001, 0.00025],
            [0.003, 0.00025],
        ];
        let edges = [
            (0, 1, 22_239, 10, CYCLE),
            (2, 0, 2_780, 11, CYCLE),
            (2, 3, 22_239, 20, CYCLE),
            (3, 4, 22_239, 30, CYCLE),
        ];
        for reverse in [false, true] {
            let directed: Vec<_> = edges
                .iter()
                .map(|&(a, b, d, w, t)| {
                    if reverse {
                        (b, a, d, w, t)
                    } else {
                        (a, b, d, w, t)
                    }
                })
                .collect();
            let k = fixture(&nodes, &directed, &[]);
            let (from, to) = if reverse {
                (nodes[4], [0., 0.])
            } else {
                ([0., 0.], nodes[4])
            };
            assert_eq!(
                k.route(from, to, Default::default(), 25., 4.8, 1000.)
                    .unwrap()
                    .status,
                "blocked"
            );
            let r = k
                .route(from, to, Default::default(), 30., 4.8, 1000.)
                .unwrap();
            assert_eq!(r.status, "ready");
            let connector = r
                .legs
                .iter()
                .find(|l| l.source == "coordinate-snap")
                .unwrap();
            assert!(!connector.verified);
            assert!(connector.meters > 25. && connector.meters <= 30.);
            assert_eq!(
                k.route(from, to, Default::default(), 30., 4.8, 100.)
                    .unwrap()
                    .status,
                "blocked"
            );
            // The wider attachment cannot bypass a turn well beyond its radius.
            let turn = if reverse {
                (3, 30, 20, 0)
            } else {
                (3, 20, 30, 0)
            };
            let restricted = fixture(&nodes, &directed, &[turn]);
            assert_eq!(
                restricted
                    .route(from, to, Default::default(), 30., 4.8, 1000.)
                    .unwrap()
                    .status,
                "blocked"
            );
        }
    }

    #[test]
    fn spherical_target_bounds_never_exceed_nearest_geodesic() {
        let mut seed = 972_481u64;
        let mut random = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 11) as f64 / ((1u64 << 53) as f64)
        };
        for center in [
            [0., 0.],
            [179.999, 0.],
            [-179.999, 0.],
            [0., 89.999],
            [0., -89.999],
        ] {
            let points: Vec<_> = (0..32)
                .map(|_| {
                    [
                        (center[0] + random() * 0.1 - 0.05 + 180.).rem_euclid(360.) - 180.,
                        (center[1] + random() * 0.1 - 0.05).clamp(-90., 90.),
                    ]
                })
                .collect();
            let bounds = TargetBounds::new(points.iter().copied());
            for point in points
                .iter()
                .copied()
                .chain((0..100).map(|_| [random() * 360. - 180., random() * 180. - 90.]))
            {
                let nearest = points
                    .iter()
                    .map(|p| vigo_route::geo::haversine_m([point[0], point[1]], [p[0], p[1]]))
                    .fold(f64::INFINITY, f64::min);
                assert!(bounds.meters(point) <= nearest + 1e-7);
            }
        }
    }

    #[test]
    fn many_destination_candidates_match_independent_branch_costs() {
        let mut nodes = vec![[-0.01, 0.]];
        let mut edges = Vec::new();
        let mut best_full = f64::INFINITY;
        let mut best_partial = f64::INFINITY;
        for i in 0..20u32 {
            let y = (i as f64 - 10.) * 0.00001;
            let a = nodes.len() as u32;
            nodes.extend([[0., y], [0.01, y]]);
            let length_cm = 120_000 + (i * 7 % 20) * 1000;
            edges.extend([
                (0, a, 111_195, 100 + i as i64, CYCLE),
                (a, a + 1, length_cm, i as i64, CYCLE),
            ]);
            let walk_seconds = y.abs().to_radians() * 6_371_008.8 / (4.8 / 3.6);
            best_full = best_full.min((1111.95 + length_cm as f64 / 100.) / 5. + walk_seconds);
            best_partial = best_partial.min(length_cm as f64 / 100. * 0.4 / 5. + 2. * walk_seconds);
        }
        let k = fixture(&nodes, &edges, &[]);
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        for (from, to, expected) in [
            (nodes[0], [0.01, 0.], best_full),
            ([0.005, 0.], [0.009, 0.], best_partial),
        ] {
            assert!(
                k.index
                    .attach(&k.graph(), to, 25., 4.8 / 3.6, false, false)
                    .candidates
                    .len()
                    > 16
            );
            let r = k.route(from, to, opt, 25., 4.8, 5000.).unwrap();
            assert_eq!(r.status, "ready");
            assert!(
                (r.cost.unwrap() - expected).abs() < 1e-7,
                "{:?} vs {expected}",
                r.cost
            );
        }
    }

    #[test]
    fn destination_access_is_not_a_through_shortcut() {
        let nodes = [
            [0., 0.],
            [0.01, 0.],
            [0.02, 0.],
            [0.01, 0.005],
            [-0.005, 0.],
            [0.025, 0.],
        ];
        let k = fixture(
            &nodes,
            &[
                (4, 0, 55_598, 1, CYCLE),
                (0, 1, 111_195, 2, CYCLE | (1 << 22)),
                (1, 2, 111_195, 2, CYCLE | (1 << 22)),
                (0, 3, 124_320, 3, CYCLE),
                (3, 2, 124_320, 3, CYCLE),
                (2, 5, 55_598, 4, CYCLE),
            ],
            &[],
        );
        let through = route(&k, nodes[4], nodes[5], Profile::Fast, 10000.);
        assert_eq!(through.status, "ready");
        assert!(through.legs[0].coordinates.contains(&nodes[3]));
        let access = route(&k, nodes[4], [0.015, 0.], Profile::Fast, 10000.);
        assert_eq!(access.status, "ready");
        assert!(!access.legs[0].coordinates.contains(&nodes[3]));
        let many = k
            .many_from(
                nodes[4],
                &[nodes[5], [0.015, 0.]],
                BikeOptions {
                    profile: Profile::Fast,
                    ..Default::default()
                },
                0.,
                4.8,
                10000.,
                None,
                2000.,
            )
            .unwrap();
        assert!((many.seconds[0] - seconds(&through)).abs() < 1e-7);
        assert!((many.seconds[1] - seconds(&access)).abs() < 1e-7);
        assert_eq!(many.certified_targets, 1);
        assert_eq!(many.fallback_targets, 1);
    }

    #[test]
    fn dismount_and_uphill_are_physical_time_not_preference() {
        let k = fixture(
            &[[0., 0.], [0.001, 0.], [0.002, 0.]],
            &[
                (0, 1, 11_120, 10, CYCLE | 128),
                (1, 2, 11_120, 20, CYCLE + (10 << 8)),
            ],
            &[],
        );
        let r = route(&k, [0., 0.], [0.002, 0.], Profile::Balanced, 500.);
        assert_eq!(r.legs.len(), 2);
        assert_eq!(r.legs[0].source, "osm-dismount");
        assert_eq!(r.legs[1].kind, "bike");
        assert!((r.legs[0].seconds - 100.08).abs() < 0.01);
        assert!(r.legs[1].seconds > 40.);
        assert!(
            BikeOptions {
                speed_kph: f64::NAN,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            k.route([181., 0.], [0., 0.], Default::default(), 0., 4.8, 1000.)
                .is_err()
        );
    }
}
